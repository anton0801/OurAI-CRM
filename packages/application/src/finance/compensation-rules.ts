import { and, asc, desc, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import { can, hasAnywhere } from '@castlane/authorization';
import { compensationLines, compensationRuleVersions, compensationRules, compensationRuns, projects, roles } from '@castlane/database';
import {
  AppError,
  RESPONSIBILITIES,
  RULE_VERSION_TRANSITIONS,
  assertTransition,
  checkRuleStacking,
  clampPageSize,
  decodeCursor,
  encodeCursor,
  newId,
  type FieldError,
} from '@castlane/domain';
import { requireRecentAuth } from '../core/access';
import { audit } from '../core/audit';
import { dbOf, type CommandContext, type QueryContext } from '../core/context';
import { emit } from '../core/events';
import { isActiveMember, loadMemberRefs, refOrUnknown } from '../core/members';
import { assertVersion, findById, lockById, stamp, touch } from '../core/rows';
import { moneyOf, parseAmount, throwIfErrors, userMembershipMap } from './common';
import { calculateCompensation, liteOf, loadRuleVersions } from './compensation-calc';

type RuleRow = typeof compensationRules.$inferSelect;
type VersionRow = typeof compensationRuleVersions.$inferSelect;

export interface RuleVersionInputData {
  type: VersionRow['type'];
  effectiveFrom: string;
  effectiveTo?: string | null;
  rate?: string | null;
  ratePercent?: string | null;
  currency: string;
  revenueBasis?: VersionRow['revenueBasis'];
  hourlySource?: VersionRow['hourlySource'];
  proration?: VersionRow['proration'];
  eligibleProjectIds?: string[];
  contributorResponsibility?: string | null;
}

/** Compensation is workspace-level: rules and runs need the permission at workspace scope. */
export const requireWorkspacePermission = (ctx: QueryContext, permission: string) => {
  if (!can(ctx.actor.access, permission)) throw new AppError('FORBIDDEN', 'You do not have permission to perform this action.');
};

const validateVersion = async (ctx: CommandContext, v: RuleVersionInputData, prefix = 'version.') => {
  const errors: FieldError[] = [];
  const f = (k: string) => `${prefix}${k}`;
  let rateMinor: bigint | null = null;
  if (v.effectiveTo && v.effectiveTo <= v.effectiveFrom) errors.push({ field: f('effectiveTo'), code: 'BEFORE_START', message: 'The end must be after the start (the end date is exclusive).' });
  if (v.type === 'revenue_share') {
    if (!v.ratePercent) errors.push({ field: f('ratePercent'), code: 'REQUIRED', message: 'Enter the share percentage.' });
    else if (Number(v.ratePercent) <= 0) errors.push({ field: f('ratePercent'), code: 'INVALID', message: 'The share must be above 0.' });
    if (!v.revenueBasis) errors.push({ field: f('revenueBasis'), code: 'REQUIRED', message: 'A percentage needs a base: Gross or Net After Refunds and Fees.' });
    if (v.rate) errors.push({ field: f('rate'), code: 'NOT_APPLICABLE', message: 'Revenue share uses a percentage, not an amount.' });
  } else {
    if (!v.rate) errors.push({ field: f('rate'), code: 'REQUIRED', message: v.type === 'fixed_period' ? 'Enter the monthly amount.' : v.type === 'hourly' ? 'Enter the hourly rate.' : 'Enter the amount per approved unit.' });
    else rateMinor = parseAmount(v.rate, v.currency, f('rate'), errors);
    if (v.ratePercent) errors.push({ field: f('ratePercent'), code: 'NOT_APPLICABLE', message: 'Only revenue share rules use a percentage.' });
  }
  if (v.type === 'hourly' && !v.hourlySource) errors.push({ field: f('hourlySource'), code: 'REQUIRED', message: 'Choose exactly one source: approved time entries or approved shift hours.' });
  if (v.contributorResponsibility && !(RESPONSIBILITIES as readonly string[]).includes(v.contributorResponsibility))
    errors.push({ field: f('contributorResponsibility'), code: 'INVALID', message: 'Choose a responsibility.' });
  if (v.eligibleProjectIds?.length) {
    const found = await ctx.tx.select({ id: projects.id }).from(projects).where(and(eq(projects.workspaceId, ctx.actor.workspaceId), inArray(projects.id, v.eligibleProjectIds)));
    if (found.length !== new Set(v.eligibleProjectIds).size) errors.push({ field: f('eligibleProjectIds'), code: 'NOT_FOUND', message: 'An eligible project was not found.' });
  }
  throwIfErrors(errors);
  return {
    type: v.type,
    effectiveFrom: v.effectiveFrom,
    effectiveTo: v.effectiveTo ?? null,
    rateMinor,
    ratePercent: v.type === 'revenue_share' ? (v.ratePercent ?? null) : null,
    currency: v.currency,
    revenueBasis: v.type === 'revenue_share' ? (v.revenueBasis ?? null) : null,
    hourlySource: v.type === 'hourly' ? (v.hourlySource ?? null) : null,
    proration: (v.type === 'fixed_period' ? (v.proration ?? 'none') : 'none') as VersionRow['proration'],
    eligibleProjectIds: [...new Set(v.eligibleProjectIds ?? [])],
    contributorResponsibility: v.type === 'per_approved_unit' ? (v.contributorResponsibility ?? null) : null,
  };
};

// ——— Views ———

const versionViews = async (ctx: QueryContext | CommandContext, versions: VersionRow[]) => {
  const db = dbOf(ctx);
  const ws = ctx.actor.workspaceId;
  const pids = [...new Set(versions.flatMap((v) => v.eligibleProjectIds))];
  const ps = pids.length ? await db.select({ id: projects.id, name: projects.name }).from(projects).where(and(eq(projects.workspaceId, ws), inArray(projects.id, pids))) : [];
  const u2m = await userMembershipMap(db, ws, versions.flatMap((v) => [v.approvedBy, v.createdBy]));
  const refs = await loadMemberRefs(db, ws, [...u2m.values()]);
  const m = (u: string | null) => (u && u2m.get(u) ? refOrUnknown(refs, u2m.get(u)) : null);
  return versions.map((v) => ({
    id: v.id,
    versionNo: v.versionNo,
    state: v.state,
    type: v.type,
    effectiveFrom: v.effectiveFrom,
    effectiveTo: v.effectiveTo,
    rate: v.rateMinor !== null ? moneyOf(v.rateMinor, v.currency.trim()) : null,
    ratePercent: v.ratePercent,
    currency: v.currency.trim(),
    revenueBasis: v.revenueBasis,
    hourlySource: v.hourlySource,
    proration: v.proration,
    eligibleProjects: v.eligibleProjectIds.map((p) => ({ id: p, name: ps.find((x) => x.id === p)?.name ?? 'Unavailable project' })),
    contributorResponsibility: v.contributorResponsibility,
    refundPolicy: v.refundPolicy,
    approvedAt: v.approvedAt?.toISOString() ?? null,
    approvedBy: m(v.approvedBy),
    endedAt: v.endedAt?.toISOString() ?? null,
    createdAt: v.createdAt.toISOString(),
    createdBy: m(v.createdBy),
  }));
};

export const ruleRows = async (ctx: QueryContext | CommandContext, rules: RuleRow[]) => {
  if (!rules.length) return [];
  const db = dbOf(ctx);
  const ws = ctx.actor.workspaceId;
  const versions = await db.select().from(compensationRuleVersions).where(and(eq(compensationRuleVersions.workspaceId, ws), inArray(compensationRuleVersions.ruleId, rules.map((r) => r.id))));
  const views = await versionViews(ctx, versions);
  const refs = await loadMemberRefs(db, ws, rules.map((r) => r.recipientMembershipId));
  const roleIds = rules.map((r) => r.recipientRoleId).filter((x): x is string => !!x);
  const rs = roleIds.length ? await db.select({ id: roles.id, name: roles.name }).from(roles).where(and(eq(roles.workspaceId, ws), inArray(roles.id, roleIds))) : [];
  return rules.map((r) => {
    const mine = versions.filter((v) => v.ruleId === r.id).sort((a, b) => b.versionNo - a.versionNo);
    const current = mine.find((v) => v.id === r.currentVersionId) ?? null;
    const draft = mine.find((v) => v.state === 'draft') ?? null;
    return {
      id: r.id,
      name: r.name,
      recipientScopeType: r.recipientScopeType,
      recipient: r.recipientMembershipId ? refOrUnknown(refs, r.recipientMembershipId) : null,
      role: r.recipientRoleId ? { id: r.recipientRoleId, name: rs.find((x) => x.id === r.recipientRoleId)?.name ?? 'Role' } : null,
      componentKey: r.componentKey,
      stackGroup: r.stackGroup,
      currentVersion: current ? views.find((v) => v.id === current.id)! : null,
      draftVersion: draft ? views.find((v) => v.id === draft.id)! : null,
      archivedAt: r.archivedAt?.toISOString() ?? null,
      rowVersion: r.rowVersion,
    };
  });
};

/** Rules a member may see: all with compensation.rules.read, otherwise only rules paying themselves. */
const canReadRule = (ctx: QueryContext, r: RuleRow) => can(ctx.actor.access, 'compensation.rules.read') || (!!ctx.actor.membershipId && r.recipientMembershipId === ctx.actor.membershipId && hasAnywhere(ctx.actor.access, 'compensation.own.read'));

export const getRule = async (ctx: QueryContext | CommandContext, id: string) => {
  const r = await findById(ctx, compensationRules, id, 'Rule');
  if (!canReadRule(ctx, r)) throw new AppError('NOT_FOUND', 'Rule was not found.');
  const db = dbOf(ctx);
  const [row] = await ruleRows(ctx, [r]);
  const versions = await db.select().from(compensationRuleVersions).where(and(eq(compensationRuleVersions.workspaceId, ctx.actor.workspaceId), eq(compensationRuleVersions.ruleId, id))).orderBy(desc(compensationRuleVersions.versionNo));
  const vids = versions.map((v) => v.id);
  const runs = vids.length
    ? await db
        .selectDistinct({ id: compensationRuns.id, periodStart: compensationRuns.periodStart, periodEnd: compensationRuns.periodEnd, state: compensationRuns.state })
        .from(compensationLines)
        .innerJoin(compensationRuns, and(eq(compensationRuns.id, compensationLines.runId), eq(compensationRuns.calculationVersion, compensationLines.calculationVersion)))
        .where(and(eq(compensationLines.workspaceId, ctx.actor.workspaceId), inArray(compensationLines.ruleVersionId, vids)))
    : [];
  const manage = can(ctx.actor.access, 'compensation.rules.write');
  const approve = can(ctx.actor.access, 'compensation.rules.approve');
  return {
    ...row!,
    versions: await versionViews(ctx, versions),
    affectedRuns: runs.sort((a, b) => b.periodStart.localeCompare(a.periodStart)),
    permissions: {
      createVersion: manage && !r.archivedAt,
      approve: approve && !r.archivedAt && versions.some((v) => v.state === 'draft'),
      end: approve && versions.some((v) => v.state === 'approved'),
      simulate: can(ctx.actor.access, 'compensation.rules.read'),
      archive: manage && !r.archivedAt,
    },
  };
};

export const listRules = async (ctx: QueryContext, input: { cursor?: string; pageSize?: number; q?: string; recipientMembershipId?: string; type?: VersionRow['type'][]; includeArchived?: boolean }) => {
  const all = can(ctx.actor.access, 'compensation.rules.read');
  if (!all && !hasAnywhere(ctx.actor.access, 'compensation.own.read')) throw new AppError('FORBIDDEN', 'You do not have permission to perform this action.');
  const size = clampPageSize(input.pageSize);
  const c = input.cursor ? decodeCursor(input.cursor) : null;
  const q = input.q?.trim();
  const rows = await dbOf(ctx)
    .select()
    .from(compensationRules)
    .where(
      and(
        eq(compensationRules.workspaceId, ctx.actor.workspaceId),
        all ? undefined : eq(compensationRules.recipientMembershipId, ctx.actor.membershipId ?? '00000000-0000-0000-0000-000000000000'),
        input.includeArchived ? undefined : isNull(compensationRules.archivedAt),
        input.recipientMembershipId ? eq(compensationRules.recipientMembershipId, input.recipientMembershipId) : undefined,
        input.type?.length
          ? sql`EXISTS (SELECT 1 FROM compensation_rule_versions v WHERE v.rule_id = ${compensationRules.id} AND v.type IN (${sql.join(input.type.map((t) => sql`${t}`), sql`, `)}))`
          : undefined,
        q ? ilike(compensationRules.name, `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`) : undefined,
        c ? or(sql`${compensationRules.name} > ${String(c.v[0])}`, and(eq(compensationRules.name, String(c.v[0])), sql`${compensationRules.id} > ${c.id}`)) : undefined,
      ),
    )
    .orderBy(asc(compensationRules.name), asc(compensationRules.id))
    .limit(size + 1);
  const hasMore = rows.length > size;
  const pageRows = hasMore ? rows.slice(0, size) : rows;
  const last = pageRows[pageRows.length - 1];
  return { items: await ruleRows(ctx, pageRows), hasMore, nextCursor: hasMore && last ? encodeCursor({ v: [last.name], id: last.id }) : null };
};

// ——— Commands ———

export const createRule = async (
  ctx: CommandContext,
  input: { name: string; recipientScopeType: 'member' | 'role'; recipientMembershipId?: string | null; recipientRoleId?: string | null; componentKey: string; stackGroup?: string | null; version: RuleVersionInputData },
) => {
  requireWorkspacePermission(ctx, 'compensation.rules.write');
  const errors: FieldError[] = [];
  if (input.recipientScopeType === 'member') {
    if (!input.recipientMembershipId || !(await isActiveMember(ctx.tx, ctx.actor.workspaceId, input.recipientMembershipId)))
      errors.push({ field: 'recipientMembershipId', code: 'REQUIRED', message: 'Choose an active member.' });
  } else {
    const [role] = input.recipientRoleId ? await ctx.tx.select({ id: roles.id }).from(roles).where(and(eq(roles.workspaceId, ctx.actor.workspaceId), eq(roles.id, input.recipientRoleId))) : [];
    if (!role) errors.push({ field: 'recipientRoleId', code: 'REQUIRED', message: 'Choose a role.' });
  }
  throwIfErrors(errors);
  const v = await validateVersion(ctx, input.version);
  const id = newId();
  await ctx.tx.insert(compensationRules).values({
    ...stamp(ctx),
    id,
    name: input.name.trim(),
    recipientScopeType: input.recipientScopeType,
    recipientMembershipId: input.recipientScopeType === 'member' ? input.recipientMembershipId! : null,
    recipientRoleId: input.recipientScopeType === 'role' ? input.recipientRoleId! : null,
    componentKey: input.componentKey,
    stackGroup: input.stackGroup?.trim() || null,
  });
  const vid = newId();
  await ctx.tx.insert(compensationRuleVersions).values({ ...stamp(ctx), id: vid, ruleId: id, versionNo: 1, state: 'draft', ...v });
  await audit(ctx, { action: 'compensation_rule.created', entityType: 'compensation_rule', entityId: id, sensitivity: 'finance', metadata: { name: input.name, type: v.type, versionId: vid } });
  await emit(ctx, { type: 'compensation_rule.created', entityType: 'compensation_rule', entityId: id, revision: 1 });
  return id;
};

export const createRuleVersion = async (ctx: CommandContext, id: string, input: { version: RuleVersionInputData; stackGroup?: string | null; name?: string }) => {
  requireWorkspacePermission(ctx, 'compensation.rules.write');
  const r = await lockById(ctx, compensationRules, id, 'Rule');
  assertVersion(ctx, r);
  if (r.archivedAt) throw new AppError('INVALID_STATE', 'Archived rules cannot get new versions.');
  const v = await validateVersion(ctx, input.version);
  const [{ max } = { max: 0 }] = await ctx.tx.select({ max: sql<number>`coalesce(max(${compensationRuleVersions.versionNo}), 0)` }).from(compensationRuleVersions).where(eq(compensationRuleVersions.ruleId, id));
  const vid = newId();
  await ctx.tx.insert(compensationRuleVersions).values({ ...stamp(ctx), id: vid, ruleId: id, versionNo: Number(max) + 1, state: 'draft', ...v });
  const [row] = await ctx.tx
    .update(compensationRules)
    .set({ ...(input.name ? { name: input.name.trim() } : {}), ...(input.stackGroup !== undefined ? { stackGroup: input.stackGroup?.trim() || null } : {}), ...touch(ctx, compensationRules) })
    .where(eq(compensationRules.id, id))
    .returning();
  await audit(ctx, { action: 'compensation_rule.version_created', entityType: 'compensation_rule', entityId: id, sensitivity: 'finance', metadata: { versionId: vid, versionNo: Number(max) + 1 } });
  await emit(ctx, { type: 'compensation_rule.updated', entityType: 'compensation_rule', entityId: id, revision: row!.rowVersion });
  return id;
};

/** Stacking check for a version against every other approved version (T134). */
export const stackingFor = async (ctx: QueryContext | CommandContext, rule: RuleRow, version: VersionRow) => {
  const all = await loadRuleVersions(ctx, '9999-12-31');
  const candidate = liteOf({ v: version, rule });
  return checkRuleStacking(
    candidate,
    all.filter((x) => x.v.id !== version.id && x.rule.id !== rule.id).map((x) => liteOf(x)),
  );
};

export const approveRule = async (ctx: CommandContext, id: string, input: { versionId: string }) => {
  requireWorkspacePermission(ctx, 'compensation.rules.approve');
  const r = await lockById(ctx, compensationRules, id, 'Rule');
  assertVersion(ctx, r);
  requireRecentAuth(ctx);
  const [v] = await ctx.tx.select().from(compensationRuleVersions).where(and(eq(compensationRuleVersions.ruleId, id), eq(compensationRuleVersions.id, input.versionId))).for('update');
  if (!v) throw new AppError('NOT_FOUND', 'Rule version was not found.');
  assertTransition(RULE_VERSION_TRANSITIONS, v.state, 'approved', 'rule version');
  const stack = await stackingFor(ctx, r, v);
  if (stack.conflicts.length)
    throw new AppError('INVALID_STATE', 'Overlapping incompatible rules exist. Use a different component, an explicit stack group, or end the other rule first.', {
      details: { reason: 'rule_conflict', conflicts: stack.conflicts, stack: { revenueSharePercent: stack.revenueSharePercent, rules: stack.stack } },
    });
  // Earlier approved versions of the same rule end where the new one starts.
  const previous = await ctx.tx.select().from(compensationRuleVersions).where(and(eq(compensationRuleVersions.ruleId, id), eq(compensationRuleVersions.state, 'approved'))).for('update');
  for (const p of previous) {
    if (p.effectiveFrom >= v.effectiveFrom)
      throw new AppError('INVALID_STATE', `Version ${p.versionNo} starts on or after this version. Approved versions are not rewritten; choose a later start date.`, { details: { reason: 'overlaps_previous', versionId: p.id } });
    if (p.effectiveTo === null || p.effectiveTo > v.effectiveFrom)
      await ctx.tx.update(compensationRuleVersions).set({ effectiveTo: v.effectiveFrom, ...touch(ctx, compensationRuleVersions) }).where(eq(compensationRuleVersions.id, p.id));
  }
  const at = ctx.app.clock.now();
  await ctx.tx.update(compensationRuleVersions).set({ state: 'approved', approvedAt: at, approvedBy: ctx.actor.userId, ...touch(ctx, compensationRuleVersions) }).where(eq(compensationRuleVersions.id, v.id));
  const [row] = await ctx.tx.update(compensationRules).set({ currentVersionId: v.id, ...touch(ctx, compensationRules) }).where(eq(compensationRules.id, id)).returning();
  await audit(ctx, { action: 'compensation_rule.approved', entityType: 'compensation_rule', entityId: id, sensitivity: 'finance', metadata: { versionId: v.id, versionNo: v.versionNo, stack: stack.stack } });
  await emit(ctx, { type: 'compensation_rule.approved', entityType: 'compensation_rule', entityId: id, revision: row!.rowVersion });
  return id;
};

export const endRule = async (ctx: CommandContext, id: string, input: { versionId: string; effectiveTo: string; reason: string }) => {
  requireWorkspacePermission(ctx, 'compensation.rules.approve');
  const r = await lockById(ctx, compensationRules, id, 'Rule');
  assertVersion(ctx, r);
  const [v] = await ctx.tx.select().from(compensationRuleVersions).where(and(eq(compensationRuleVersions.ruleId, id), eq(compensationRuleVersions.id, input.versionId))).for('update');
  if (!v) throw new AppError('NOT_FOUND', 'Rule version was not found.');
  assertTransition(RULE_VERSION_TRANSITIONS, v.state, 'ended', 'rule version');
  if (input.effectiveTo <= v.effectiveFrom)
    throw new AppError('VALIDATION_FAILED', 'The end must be after the start.', { fieldErrors: [{ field: 'effectiveTo', code: 'BEFORE_START', message: 'The end must be after the start.' }] });
  if (v.effectiveTo && input.effectiveTo > v.effectiveTo)
    throw new AppError('VALIDATION_FAILED', 'Ending cannot extend a version.', { fieldErrors: [{ field: 'effectiveTo', code: 'EXTENDS', message: `The version already ends on ${v.effectiveTo}.` }] });
  await ctx.tx.update(compensationRuleVersions).set({ state: 'ended', effectiveTo: input.effectiveTo, endedAt: ctx.app.clock.now(), ...touch(ctx, compensationRuleVersions) }).where(eq(compensationRuleVersions.id, v.id));
  const [row] = await ctx.tx.update(compensationRules).set({ ...touch(ctx, compensationRules) }).where(eq(compensationRules.id, id)).returning();
  await audit(ctx, { action: 'compensation_rule.ended', entityType: 'compensation_rule', entityId: id, sensitivity: 'finance', reason: input.reason, metadata: { versionId: v.id, effectiveTo: input.effectiveTo } });
  await emit(ctx, { type: 'compensation_rule.updated', entityType: 'compensation_rule', entityId: id, revision: row!.rowVersion });
  return id;
};

export const archiveRule = async (ctx: CommandContext, id: string, input: { reason?: string; restore?: boolean }) => {
  requireWorkspacePermission(ctx, 'compensation.rules.write');
  const r = await lockById(ctx, compensationRules, id, 'Rule');
  const [open] = await ctx.tx.select({ id: compensationRuleVersions.id }).from(compensationRuleVersions).where(and(eq(compensationRuleVersions.ruleId, id), eq(compensationRuleVersions.state, 'approved'), isNull(compensationRuleVersions.effectiveTo)));
  if (!input.restore && open) throw new AppError('INVALID_STATE', 'End the approved version before archiving the rule.', { details: { reason: 'open_version', versionId: open.id } });
  const at = ctx.app.clock.now();
  await ctx.tx
    .update(compensationRules)
    .set(input.restore ? { archivedAt: null, archivedBy: null, archiveReason: null, ...touch(ctx, compensationRules) } : { archivedAt: at, archivedBy: ctx.actor.userId, archiveReason: input.reason ?? null, ...touch(ctx, compensationRules) })
    .where(eq(compensationRules.id, id));
  await audit(ctx, { action: input.restore ? 'compensation_rule.restored' : 'compensation_rule.archived', entityType: 'compensation_rule', entityId: id, sensitivity: 'finance', reason: input.reason ?? null });
  await emit(ctx, { type: 'compensation_rule.updated', entityType: 'compensation_rule', entityId: id });
  void r;
  return id;
};

/** Simulate on Period: the same calculation as a run, for this version only. Nothing is accrued. */
export const simulateRule = async (ctx: QueryContext, id: string, input: { versionId: string; periodStart: string; periodEnd: string }) => {
  requireWorkspacePermission(ctx, 'compensation.rules.read');
  const r = await findById(ctx, compensationRules, id, 'Rule');
  const [v] = await dbOf(ctx).select().from(compensationRuleVersions).where(and(eq(compensationRuleVersions.ruleId, id), eq(compensationRuleVersions.id, input.versionId)));
  if (!v) throw new AppError('NOT_FOUND', 'Rule version was not found.');
  if (input.periodEnd < input.periodStart) throw new AppError('VALIDATION_FAILED', 'The period ends before it starts.', { fieldErrors: [{ field: 'periodEnd', code: 'BEFORE_START', message: 'Choose an end on or after the start.' }] });
  let participants: string[] = [];
  if (r.recipientScopeType === 'member' && r.recipientMembershipId) participants = [r.recipientMembershipId];
  else if (r.recipientRoleId) {
    const rows = await dbOf(ctx).execute<{ membership_id: string }>(
      sql`SELECT DISTINCT membership_id FROM role_assignments WHERE workspace_id = ${ctx.actor.workspaceId} AND role_id = ${r.recipientRoleId} AND revoked_at IS NULL`,
    );
    participants = rows.rows.map((x) => x.membership_id);
  }
  const calc = await calculateCompensation(ctx, { runId: null, periodStart: input.periodStart, periodEnd: input.periodEnd, participants, onlyVersionIds: [v.id] });
  const refs = await loadMemberRefs(dbOf(ctx), ctx.actor.workspaceId, participants);
  const stack = await stackingFor(ctx, r, v);
  const totals = new Map<string, bigint>();
  for (const l of calc.lines.filter((x) => !x.excluded)) totals.set(`${l.recipientMembershipId}|${l.currency}`, (totals.get(`${l.recipientMembershipId}|${l.currency}`) ?? 0n) + l.amountMinor);
  return {
    lines: calc.lines.map((l, i) => ({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      recipient: refOrUnknown(refs, l.recipientMembershipId)!,
      ruleVersionId: l.ruleVersionId,
      ruleName: r.name,
      adjustmentId: l.adjustmentId,
      sourceType: l.sourceType,
      sourceId: l.sourceId,
      sourceLabel: l.sourceLabel,
      component: l.component,
      entitlementKey: l.entitlementKey,
      quantity: l.quantity,
      rate: l.rate,
      amount: moneyOf(l.amountMinor, l.currency),
      excluded: l.excluded,
      exclusionReason: l.exclusionReason,
      explanation: l.explanation,
    })),
    totals: [...totals.entries()].map(([k, v2]) => {
      const [m, c] = k.split('|');
      return { recipient: refOrUnknown(refs, m)!, currency: c!, total: moneyOf(v2, c!) };
    }),
    conflicts: stack.conflicts,
    stack: { revenueSharePercent: stack.revenueSharePercent, rules: stack.stack },
  };
};
