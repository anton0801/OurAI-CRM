import { and, asc, desc, eq, ilike, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import { can, listFilter, type ObjectScope } from '@castlane/authorization';
import {
  budgetAlerts,
  budgetLines,
  budgetVersions,
  budgets,
  campaigns,
  commitmentConsumptions,
  commitments,
  directions,
  financeCategories,
  financialEntries,
  financialEntryLines,
  projects,
} from '@castlane/database';
import {
  AppError,
  BUDGET_VERSION_TRANSITIONS,
  assertTransition,
  clampPageSize,
  decodeCursor,
  encodeCursor,
  newId,
  type BudgetFigures,
  type FieldError,
} from '@castlane/domain';
import { requirePermission } from '../core/access';
import { audit, diffFields } from '../core/audit';
import { dbOf, type CommandContext, type QueryContext } from '../core/context';
import { emit } from '../core/events';
import { isActiveMember, loadMemberRefs, refOrUnknown } from '../core/members';
import { assertVersion, findById, lockById, stamp, touch } from '../core/rows';
import { evaluateBudgetAlerts, evaluateBudgetAlertsFor } from './alerts';
import { computeBudget } from './budget-figures';
import { moneyOf, parseAmount, throwIfErrors, userMembershipMap, workspaceFinance } from './common';
import { createEntry, getEntry } from './entries';

type BudgetRow = typeof budgets.$inferSelect;
type VersionRow = typeof budgetVersions.$inferSelect;
type CommitmentRow = typeof commitments.$inferSelect;

const BUDGET_CLASSES = ['operating_expense', 'compensation_expense', 'fee'] as const;

// ——— Scope ———

export const budgetScope = (b: Pick<BudgetRow, 'id' | 'scopeType' | 'scopeId' | 'ownerMembershipId'>): ObjectScope => ({
  objectType: 'budget',
  objectId: b.id,
  projectId: b.scopeType === 'project' ? b.scopeId : null,
  directionId: b.scopeType === 'direction' ? b.scopeId : null,
  ownerMembershipId: b.ownerMembershipId,
});

const authorizeBudget = (ctx: QueryContext, action: string, b: BudgetRow) => {
  const s = budgetScope(b);
  if (can(ctx.actor.access, action, s)) return;
  if (can(ctx.actor.access, 'budgets.read', s)) throw new AppError('FORBIDDEN', 'You do not have permission to perform this action.');
  throw new AppError('NOT_FOUND', 'Budget was not found.');
};

const budgetVisibilitySql = (ctx: QueryContext): SQL | undefined => {
  const f = listFilter(ctx.actor.access, 'budgets.read');
  if (f.kind === 'all') return undefined;
  if (f.kind === 'none') return sql`false`;
  const parts: SQL[] = [];
  if (f.projectIds.length) {
    const ids = sql.join(f.projectIds.map((p) => sql`${p}::uuid`), sql`, `);
    parts.push(sql`(${budgets.scopeType} = 'project' AND ${budgets.scopeId} IN (${ids}))`);
  }
  // Direction budgets are visible to direction-scoped grants only (all of the direction's projects).
  const dirGrants = ctx.actor.access.grants.filter((g) => g.permissions.has('budgets.read') && g.scopeType === 'direction' && g.scopeId).map((g) => g.scopeId!);
  if (dirGrants.length) parts.push(sql`(${budgets.scopeType} = 'direction' AND ${budgets.scopeId} IN (${sql.join(dirGrants.map((d) => sql`${d}::uuid`), sql`, `)}))`);
  if (f.ownRecordsMembershipId || f.assignedToMembershipId) parts.push(eq(budgets.ownerMembershipId, (f.ownRecordsMembershipId ?? f.assignedToMembershipId)!));
  return parts.length ? sql`(${sql.join(parts, sql` OR `)})` : sql`false`;
};

// ——— Views ———

const figuresView = (f: BudgetFigures, currency: string) => ({
  planned: moneyOf(f.plannedMinor, currency),
  actual: moneyOf(f.actualMinor, currency),
  committed: moneyOf(f.committedMinor, currency),
  remaining: moneyOf(f.remainingMinor, currency),
  consumedPercent: f.consumedPercent,
});

const scopeNames = async (ctx: QueryContext | CommandContext, rows: BudgetRow[]) => {
  const db = dbOf(ctx);
  const ws = ctx.actor.workspaceId;
  const ids = (t: BudgetRow['scopeType']) => [...new Set(rows.filter((r) => r.scopeType === t && r.scopeId).map((r) => r.scopeId!))];
  const m = new Map<string, string>();
  const p = ids('project');
  const d = ids('direction');
  const c = ids('campaign');
  if (p.length) for (const r of await db.select({ id: projects.id, name: projects.name }).from(projects).where(and(eq(projects.workspaceId, ws), inArray(projects.id, p)))) m.set(r.id, r.name);
  if (d.length) for (const r of await db.select({ id: directions.id, name: directions.name }).from(directions).where(and(eq(directions.workspaceId, ws), inArray(directions.id, d)))) m.set(r.id, r.name);
  if (c.length) for (const r of await db.select({ id: campaigns.id, name: campaigns.name }).from(campaigns).where(and(eq(campaigns.workspaceId, ws), inArray(campaigns.id, c)))) m.set(r.id, r.name);
  return m;
};

export const budgetRows = async (ctx: QueryContext | CommandContext, rows: BudgetRow[]) => {
  if (!rows.length) return [];
  const db = dbOf(ctx);
  const { baseCurrency } = await workspaceFinance(ctx);
  const names = await scopeNames(ctx, rows);
  const refs = await loadMemberRefs(db, ctx.actor.workspaceId, rows.map((r) => r.ownerMembershipId));
  const versions = await db.select().from(budgetVersions).where(and(eq(budgetVersions.workspaceId, ctx.actor.workspaceId), inArray(budgetVersions.budgetId, rows.map((r) => r.id))));
  const out = [];
  for (const b of rows) {
    const comp = await computeBudget(ctx, b, baseCurrency);
    const vs = versions.filter((v) => v.budgetId === b.id);
    out.push({
      id: b.id,
      name: b.name,
      scopeType: b.scopeType,
      scope: b.scopeId ? { id: b.scopeId, name: names.get(b.scopeId) ?? 'Unavailable record' } : null,
      periodStart: b.periodStart,
      periodEnd: b.periodEnd,
      currency: b.currency.trim(),
      owner: refOrUnknown(refs, b.ownerMembershipId)!,
      approvedVersionNo: vs.find((v) => v.id === b.approvedVersionId)?.versionNo ?? null,
      draftVersionNo: vs.filter((v) => v.state === 'draft' || v.state === 'submitted').sort((a, c) => c.versionNo - a.versionNo)[0]?.versionNo ?? null,
      figures: comp ? figuresView(comp.total, b.currency.trim()) : null,
      archivedAt: b.archivedAt?.toISOString() ?? null,
      rowVersion: b.rowVersion,
    });
  }
  return out;
};

export const getBudget = async (ctx: QueryContext | CommandContext, id: string) => {
  const b = await findById(ctx, budgets, id, 'Budget');
  if (!can(ctx.actor.access, 'budgets.read', budgetScope(b))) throw new AppError('NOT_FOUND', 'Budget was not found.');
  const db = dbOf(ctx);
  const ws = ctx.actor.workspaceId;
  const { baseCurrency } = await workspaceFinance(ctx);
  const [row] = await budgetRows(ctx, [b]);
  const versions = await db.select().from(budgetVersions).where(and(eq(budgetVersions.workspaceId, ws), eq(budgetVersions.budgetId, id))).orderBy(desc(budgetVersions.versionNo));
  const lines = versions.length ? await db.select().from(budgetLines).where(and(eq(budgetLines.workspaceId, ws), inArray(budgetLines.budgetVersionId, versions.map((v) => v.id)))) : [];
  const cats = await db.select().from(financeCategories).where(eq(financeCategories.workspaceId, ws));
  const catRef = (cid: string) => {
    const c = cats.find((x) => x.id === cid);
    return { id: cid, name: c?.name ?? 'Unknown category', accountingClass: c?.accountingClass ?? 'operating_expense' };
  };
  const u2m = await userMembershipMap(db, ws, versions.map((v) => v.approvedBy));
  const refs = await loadMemberRefs(db, ws, [...u2m.values()]);
  const comp = await computeBudget(ctx, b, baseCurrency);
  const alerts = versions.length ? await db.select().from(budgetAlerts).where(and(eq(budgetAlerts.workspaceId, ws), inArray(budgetAlerts.budgetVersionId, versions.map((v) => v.id)))).orderBy(desc(budgetAlerts.crossedAt)) : [];
  const cur = b.currency.trim();
  const s = budgetScope(b);
  const hasDraft = versions.some((v) => v.state === 'draft' || v.state === 'submitted');
  return {
    ...row!,
    alertThresholds: b.alertThresholds,
    copiedFromId: b.copiedFromId,
    versions: versions.map((v) => {
      const vl = lines.filter((l) => l.budgetVersionId === v.id);
      return {
        id: v.id,
        versionNo: v.versionNo,
        state: v.state,
        reason: v.reason,
        submittedAt: v.submittedAt?.toISOString() ?? null,
        approvedAt: v.approvedAt?.toISOString() ?? null,
        approvedBy: v.approvedBy && u2m.get(v.approvedBy) ? refOrUnknown(refs, u2m.get(v.approvedBy)) : null,
        createdAt: v.createdAt.toISOString(),
        lines: vl.map((l) => ({ id: l.id, category: catRef(l.categoryId), planned: moneyOf(l.plannedMinor, cur), note: l.note })),
        total: moneyOf(vl.reduce((a, l) => a + l.plannedMinor, 0n), cur),
      };
    }),
    lineFigures: comp ? [...comp.byCategory.entries()].map(([cid, f]) => ({ category: catRef(cid), figures: figuresView(f, cur) })) : [],
    alerts: alerts.map((a) => ({ id: a.id, versionId: a.budgetVersionId, threshold: a.threshold, crossedAt: a.crossedAt.toISOString(), resetAt: a.resetAt?.toISOString() ?? null })),
    excludedCurrencies: comp ? [...comp.excluded.entries()].map(([c, v]) => moneyOf(v, c)) : [],
    permissions: {
      update: !b.archivedAt && can(ctx.actor.access, 'budgets.write', s),
      submit: !b.archivedAt && versions.some((v) => v.state === 'draft') && can(ctx.actor.access, 'budgets.write', s),
      approve: !b.archivedAt && hasDraft && can(ctx.actor.access, 'budgets.approve', s),
      revise: !b.archivedAt && !hasDraft && can(ctx.actor.access, 'budgets.write', s),
      archive: !b.archivedAt && can(ctx.actor.access, 'budgets.write', s),
    },
  };
};

export const listBudgets = async (
  ctx: QueryContext,
  input: { cursor?: string; pageSize?: number; q?: string; scopeType?: BudgetRow['scopeType']; projectId?: string; campaignId?: string; activeOn?: string; includeArchived?: boolean },
) => {
  requirePermission(ctx, 'budgets.read');
  const size = clampPageSize(input.pageSize);
  const c = input.cursor ? decodeCursor(input.cursor) : null;
  const q = input.q?.trim();
  const rows = await dbOf(ctx)
    .select()
    .from(budgets)
    .where(
      and(
        eq(budgets.workspaceId, ctx.actor.workspaceId),
        budgetVisibilitySql(ctx),
        input.includeArchived ? undefined : isNull(budgets.archivedAt),
        input.scopeType ? eq(budgets.scopeType, input.scopeType) : undefined,
        input.projectId ? and(eq(budgets.scopeType, 'project'), eq(budgets.scopeId, input.projectId)) : undefined,
        input.campaignId ? and(eq(budgets.scopeType, 'campaign'), eq(budgets.scopeId, input.campaignId)) : undefined,
        input.activeOn ? sql`${budgets.periodStart} <= ${input.activeOn} AND ${budgets.periodEnd} >= ${input.activeOn}` : undefined,
        q ? ilike(budgets.name, `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`) : undefined,
        c ? or(lt(budgets.periodStart, String(c.v[0])), and(eq(budgets.periodStart, String(c.v[0])), lt(budgets.id, c.id))) : undefined,
      ),
    )
    .orderBy(desc(budgets.periodStart), desc(budgets.id))
    .limit(size + 1);
  const hasMore = rows.length > size;
  const pageRows = hasMore ? rows.slice(0, size) : rows;
  const last = pageRows[pageRows.length - 1];
  return { items: await budgetRows(ctx, pageRows), hasMore, nextCursor: hasMore && last ? encodeCursor({ v: [last.periodStart], id: last.id }) : null };
};

// ——— Commands ———

interface LineInput {
  categoryId: string;
  planned: string;
  note?: string | null;
}

const normalizeLines = async (ctx: CommandContext, currency: string, lines: LineInput[]) => {
  const errors: FieldError[] = [];
  const cats = lines.length
    ? await ctx.tx.select().from(financeCategories).where(and(eq(financeCategories.workspaceId, ctx.actor.workspaceId), inArray(financeCategories.id, lines.map((l) => l.categoryId))))
    : [];
  const seen = new Set<string>();
  const out = lines.map((l, i) => {
    const c = cats.find((x) => x.id === l.categoryId);
    if (!c) errors.push({ field: `lines.${i}.categoryId`, code: 'NOT_FOUND', message: 'Choose a category.' });
    else if (!(BUDGET_CLASSES as readonly string[]).includes(c.accountingClass))
      errors.push({ field: `lines.${i}.categoryId`, code: 'CLASS', message: 'Budgets plan costs: choose an expense or fee category.' });
    if (seen.has(l.categoryId)) errors.push({ field: `lines.${i}.categoryId`, code: 'DUPLICATE', message: 'Each category appears once per version.' });
    seen.add(l.categoryId);
    return { categoryId: l.categoryId, plannedMinor: parseAmount(l.planned, currency, `lines.${i}.planned`, errors, { allowZero: true }), note: l.note ?? null };
  });
  throwIfErrors(errors);
  return out;
};

const insertVersion = async (ctx: CommandContext, budgetId: string, versionNo: number, lines: Awaited<ReturnType<typeof normalizeLines>>, reason: string | null) => {
  const vid = newId();
  await ctx.tx.insert(budgetVersions).values({ ...stamp(ctx), id: vid, budgetId, versionNo, state: 'draft', reason });
  for (const l of lines) await ctx.tx.insert(budgetLines).values({ ...stamp(ctx), id: newId(), budgetVersionId: vid, categoryId: l.categoryId, plannedMinor: l.plannedMinor, note: l.note });
  return vid;
};

const validateScope = async (ctx: CommandContext, scopeType: BudgetRow['scopeType'], scopeId: string | null | undefined) => {
  if (scopeType === 'workspace') {
    if (scopeId) throw new AppError('VALIDATION_FAILED', 'A workspace budget has no scope record.', { fieldErrors: [{ field: 'scopeId', code: 'INVALID', message: 'Leave the scope empty for a workspace budget.' }] });
    return;
  }
  if (!scopeId) throw new AppError('VALIDATION_FAILED', 'Choose the scope record.', { fieldErrors: [{ field: 'scopeId', code: 'REQUIRED', message: 'Choose the scope record.' }] });
  const table = scopeType === 'project' ? 'projects' : scopeType === 'direction' ? 'directions' : 'campaigns';
  const r = await ctx.tx.execute(sql`SELECT 1 FROM ${sql.identifier(table)} WHERE workspace_id = ${ctx.actor.workspaceId} AND id = ${scopeId}`);
  if (!r.rows.length) throw new AppError('VALIDATION_FAILED', 'The scope record was not found.', { fieldErrors: [{ field: 'scopeId', code: 'NOT_FOUND', message: 'The scope record was not found.' }] });
};

const validateThresholds = (t?: number[]) => {
  if (!t) return;
  if (new Set(t).size !== t.length) throw new AppError('VALIDATION_FAILED', 'Use each alert threshold once.', { fieldErrors: [{ field: 'alertThresholds', code: 'DUPLICATE', message: 'Use each threshold once.' }] });
};

export const createBudget = async (
  ctx: CommandContext,
  input: {
    name: string;
    scopeType: BudgetRow['scopeType'];
    scopeId?: string | null;
    periodStart: string;
    periodEnd: string;
    currency: string;
    ownerMembershipId: string;
    alertThresholds?: number[];
    lines: LineInput[];
  },
  opts: { copiedFromId?: string } = {},
) => {
  requirePermission(ctx, 'budgets.write');
  await validateScope(ctx, input.scopeType, input.scopeId);
  const scope = budgetScope({ id: 'new', scopeType: input.scopeType, scopeId: input.scopeId ?? null, ownerMembershipId: input.ownerMembershipId });
  if (!can(ctx.actor.access, 'budgets.write', { ...scope, ownerMembershipId: null })) throw new AppError('FORBIDDEN', 'You cannot create budgets for this scope.');
  if (input.periodEnd < input.periodStart) throw new AppError('VALIDATION_FAILED', 'The period ends before it starts.', { fieldErrors: [{ field: 'periodEnd', code: 'BEFORE_START', message: 'Choose an end on or after the start.' }] });
  if (!(await isActiveMember(ctx.tx, ctx.actor.workspaceId, input.ownerMembershipId))) throw new AppError('VALIDATION_FAILED', 'The owner must be an active member.', { fieldErrors: [{ field: 'ownerMembershipId', code: 'INACTIVE', message: 'Choose an active member.' }] });
  validateThresholds(input.alertThresholds);
  const lines = await normalizeLines(ctx, input.currency, input.lines);
  const id = newId();
  const [row] = await ctx.tx
    .insert(budgets)
    .values({
      ...stamp(ctx),
      id,
      name: input.name.trim(),
      scopeType: input.scopeType,
      scopeId: input.scopeId ?? null,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      currency: input.currency,
      ownerMembershipId: input.ownerMembershipId,
      alertThresholds: input.alertThresholds ?? [80, 100, 120],
      copiedFromId: opts.copiedFromId ?? null,
    })
    .returning();
  await insertVersion(ctx, id, 1, lines, null);
  await audit(ctx, { action: 'budget.created', entityType: 'budget', entityId: id, projectId: input.scopeType === 'project' ? input.scopeId : null, sensitivity: 'finance', diff: diffFields(null, row!, ['name', 'scopeType', 'scopeId', 'periodStart', 'periodEnd', 'currency']) });
  await emit(ctx, { type: 'budget.created', entityType: 'budget', entityId: id, revision: 1 });
  return id;
};

const draftVersion = async (ctx: CommandContext, budgetId: string) => {
  const [v] = await ctx.tx
    .select()
    .from(budgetVersions)
    .where(and(eq(budgetVersions.budgetId, budgetId), inArray(budgetVersions.state, ['draft', 'submitted'])))
    .orderBy(desc(budgetVersions.versionNo))
    .limit(1)
    .for('update');
  return v ?? null;
};

export const updateBudget = async (ctx: CommandContext, id: string, input: { name?: string; ownerMembershipId?: string; alertThresholds?: number[]; lines?: LineInput[] }) => {
  const b = await lockById(ctx, budgets, id, 'Budget');
  authorizeBudget(ctx, 'budgets.write', b);
  assertVersion(ctx, b);
  if (b.archivedAt) throw new AppError('INVALID_STATE', 'Archived budgets are read-only.');
  if (input.ownerMembershipId && !(await isActiveMember(ctx.tx, ctx.actor.workspaceId, input.ownerMembershipId)))
    throw new AppError('VALIDATION_FAILED', 'The owner must be an active member.', { fieldErrors: [{ field: 'ownerMembershipId', code: 'INACTIVE', message: 'Choose an active member.' }] });
  validateThresholds(input.alertThresholds);
  if (input.lines) {
    const v = await draftVersion(ctx, id);
    if (!v || v.state !== 'draft') throw new AppError('INVALID_STATE', 'Approved versions are immutable. Use Revise to create a new draft version.', { details: { reason: 'no_draft_version' } });
    const lines = await normalizeLines(ctx, b.currency.trim(), input.lines);
    await ctx.tx.delete(budgetLines).where(eq(budgetLines.budgetVersionId, v.id));
    for (const l of lines) await ctx.tx.insert(budgetLines).values({ ...stamp(ctx), id: newId(), budgetVersionId: v.id, categoryId: l.categoryId, plannedMinor: l.plannedMinor, note: l.note });
  }
  const [row] = await ctx.tx
    .update(budgets)
    .set({
      ...(input.name ? { name: input.name.trim() } : {}),
      ...(input.ownerMembershipId ? { ownerMembershipId: input.ownerMembershipId } : {}),
      ...(input.alertThresholds ? { alertThresholds: input.alertThresholds } : {}),
      ...touch(ctx, budgets),
    })
    .where(eq(budgets.id, id))
    .returning();
  await audit(ctx, { action: 'budget.updated', entityType: 'budget', entityId: id, sensitivity: 'finance', diff: diffFields(b, row!, ['name', 'ownerMembershipId', 'alertThresholds']), metadata: { linesChanged: !!input.lines } });
  await emit(ctx, { type: 'budget.updated', entityType: 'budget', entityId: id, revision: row!.rowVersion });
  if (input.alertThresholds) await evaluateBudgetAlertsFor(ctx, [row!]);
  return id;
};

const versionOf = async (ctx: CommandContext, budgetId: string, versionId: string): Promise<VersionRow> => {
  const [v] = await ctx.tx.select().from(budgetVersions).where(and(eq(budgetVersions.workspaceId, ctx.actor.workspaceId), eq(budgetVersions.budgetId, budgetId), eq(budgetVersions.id, versionId))).for('update');
  if (!v) throw new AppError('NOT_FOUND', 'Budget version was not found.');
  return v;
};

export const submitBudget = async (ctx: CommandContext, id: string, input: { versionId: string }) => {
  const b = await lockById(ctx, budgets, id, 'Budget');
  authorizeBudget(ctx, 'budgets.write', b);
  assertVersion(ctx, b);
  const v = await versionOf(ctx, id, input.versionId);
  assertTransition(BUDGET_VERSION_TRANSITIONS, v.state, 'submitted', 'budget version');
  await ctx.tx.update(budgetVersions).set({ state: 'submitted', submittedAt: ctx.app.clock.now(), ...touch(ctx, budgetVersions) }).where(eq(budgetVersions.id, v.id));
  const [row] = await ctx.tx.update(budgets).set({ ...touch(ctx, budgets) }).where(eq(budgets.id, id)).returning();
  await audit(ctx, { action: 'budget.version_submitted', entityType: 'budget', entityId: id, sensitivity: 'finance', metadata: { versionNo: v.versionNo } });
  await emit(ctx, { type: 'budget.updated', entityType: 'budget', entityId: id, revision: row!.rowVersion });
  return id;
};

/** Approve Version: it becomes the current budget; the previous approved version is superseded. */
export const approveBudget = async (ctx: CommandContext, id: string, input: { versionId: string }) => {
  const b = await lockById(ctx, budgets, id, 'Budget');
  authorizeBudget(ctx, 'budgets.approve', b);
  assertVersion(ctx, b);
  if (b.archivedAt) throw new AppError('INVALID_STATE', 'Archived budgets cannot be approved.');
  const v = await versionOf(ctx, id, input.versionId);
  assertTransition(BUDGET_VERSION_TRANSITIONS, v.state, 'approved', 'budget version');
  const at = ctx.app.clock.now();
  if (b.approvedVersionId) await ctx.tx.update(budgetVersions).set({ state: 'superseded', ...touch(ctx, budgetVersions) }).where(eq(budgetVersions.id, b.approvedVersionId));
  await ctx.tx.update(budgetVersions).set({ state: 'approved', approvedAt: at, approvedBy: ctx.actor.userId, ...touch(ctx, budgetVersions) }).where(eq(budgetVersions.id, v.id));
  const [row] = await ctx.tx.update(budgets).set({ approvedVersionId: v.id, ...touch(ctx, budgets) }).where(eq(budgets.id, id)).returning();
  await audit(ctx, { action: 'budget.version_approved', entityType: 'budget', entityId: id, projectId: b.scopeType === 'project' ? b.scopeId : null, sensitivity: 'finance', metadata: { versionNo: v.versionNo, supersededVersionId: b.approvedVersionId } });
  await emit(ctx, { type: 'budget.approved', entityType: 'budget', entityId: id, revision: row!.rowVersion, payload: { versionNo: v.versionNo } });
  await evaluateBudgetAlertsFor(ctx, [row!]);
  return id;
};

export const reviseBudget = async (ctx: CommandContext, id: string, input: { lines: LineInput[]; reason: string }) => {
  const b = await lockById(ctx, budgets, id, 'Budget');
  authorizeBudget(ctx, 'budgets.write', b);
  assertVersion(ctx, b);
  if (b.archivedAt) throw new AppError('INVALID_STATE', 'Archived budgets are read-only.');
  const open = await draftVersion(ctx, id);
  if (open) throw new AppError('INVALID_STATE', 'A draft version already exists. Edit or approve it first.', { details: { reason: 'draft_exists', versionId: open.id } });
  const lines = await normalizeLines(ctx, b.currency.trim(), input.lines);
  const [{ max } = { max: 0 }] = await ctx.tx.select({ max: sql<number>`coalesce(max(${budgetVersions.versionNo}), 0)` }).from(budgetVersions).where(eq(budgetVersions.budgetId, id));
  await insertVersion(ctx, id, Number(max) + 1, lines, input.reason);
  const [row] = await ctx.tx.update(budgets).set({ ...touch(ctx, budgets) }).where(eq(budgets.id, id)).returning();
  await audit(ctx, { action: 'budget.revised', entityType: 'budget', entityId: id, sensitivity: 'finance', reason: input.reason, metadata: { versionNo: Number(max) + 1 } });
  await emit(ctx, { type: 'budget.updated', entityType: 'budget', entityId: id, revision: row!.rowVersion });
  return id;
};

/** Copy Budget: the next period's draft; unused budget carries over only when explicitly chosen. */
export const copyBudget = async (ctx: CommandContext, id: string, input: { name: string; periodStart: string; periodEnd: string; carryOver: 'planned' | 'add_unused_remaining' | 'empty' }) => {
  const b = await findById(ctx, budgets, id, 'Budget');
  authorizeBudget(ctx, 'budgets.write', b);
  const { baseCurrency } = await workspaceFinance(ctx);
  const source = b.approvedVersionId ?? (await draftVersion(ctx, id))?.id ?? null;
  const lines = source ? await ctx.tx.select().from(budgetLines).where(eq(budgetLines.budgetVersionId, source)) : [];
  const comp = input.carryOver === 'add_unused_remaining' ? await computeBudget(ctx, b, baseCurrency) : null;
  const cur = b.currency.trim();
  return createBudget(
    ctx,
    {
      name: input.name,
      scopeType: b.scopeType,
      scopeId: b.scopeId,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      currency: cur,
      ownerMembershipId: b.ownerMembershipId,
      alertThresholds: b.alertThresholds,
      lines: lines.map((l) => {
        let planned = input.carryOver === 'empty' ? 0n : l.plannedMinor;
        const rem = comp?.byCategory.get(l.categoryId)?.remainingMinor ?? 0n;
        if (input.carryOver === 'add_unused_remaining' && rem > 0n) planned += rem;
        return { categoryId: l.categoryId, planned: moneyOf(planned, cur).amount, note: l.note };
      }),
    },
    { copiedFromId: id },
  );
};

export const resetBudgetAlert = async (ctx: CommandContext, id: string, alertId: string, input: { reason: string }) => {
  const b = await lockById(ctx, budgets, id, 'Budget');
  authorizeBudget(ctx, 'budgets.write', b);
  const [a] = await ctx.tx.select().from(budgetAlerts).where(and(eq(budgetAlerts.workspaceId, ctx.actor.workspaceId), eq(budgetAlerts.id, alertId))).for('update');
  if (!a || a.budgetVersionId !== b.approvedVersionId) throw new AppError('NOT_FOUND', 'Alert was not found.');
  if (a.resetAt) throw new AppError('INVALID_STATE', 'This alert was already reset.');
  const { baseCurrency } = await workspaceFinance(ctx);
  const comp = await computeBudget(ctx, b, baseCurrency);
  const pct = comp?.total.consumedPercent;
  if (pct !== null && pct !== undefined && Number(pct) >= a.threshold)
    throw new AppError('INVALID_STATE', `Spending is still at ${pct}% (threshold ${a.threshold}%). An alert can be reset only below its threshold.`, { details: { reason: 'still_above', consumedPercent: pct } });
  await ctx.tx.update(budgetAlerts).set({ resetAt: ctx.app.clock.now(), ...touch(ctx, budgetAlerts) }).where(eq(budgetAlerts.id, alertId));
  const [row] = await ctx.tx.update(budgets).set({ ...touch(ctx, budgets) }).where(eq(budgets.id, id)).returning();
  await audit(ctx, { action: 'budget.alert_reset', entityType: 'budget', entityId: id, sensitivity: 'finance', reason: input.reason, metadata: { threshold: a.threshold } });
  await emit(ctx, { type: 'budget.updated', entityType: 'budget', entityId: id, revision: row!.rowVersion });
  return id;
};

export const archiveBudget = async (ctx: CommandContext, id: string, input: { reason?: string; restore?: boolean }) => {
  const b = await lockById(ctx, budgets, id, 'Budget');
  authorizeBudget(ctx, 'budgets.write', b);
  const at = ctx.app.clock.now();
  const [row] = await ctx.tx
    .update(budgets)
    .set(input.restore ? { archivedAt: null, archivedBy: null, archiveReason: null, ...touch(ctx, budgets) } : { archivedAt: at, archivedBy: ctx.actor.userId, archiveReason: input.reason ?? null, ...touch(ctx, budgets) })
    .where(eq(budgets.id, id))
    .returning();
  await audit(ctx, { action: input.restore ? 'budget.restored' : 'budget.archived', entityType: 'budget', entityId: id, sensitivity: 'finance', reason: input.reason ?? null });
  await emit(ctx, { type: 'budget.updated', entityType: 'budget', entityId: id, revision: row!.rowVersion });
  return id;
};

// ——— Commitments ———

const commitmentScope = (c: Pick<CommitmentRow, 'id' | 'projectId'>): ObjectScope => ({ objectType: 'commitment', objectId: c.id, projectId: c.projectId });

export const commitmentViews = async (ctx: QueryContext | CommandContext, rows: CommitmentRow[]) => {
  if (!rows.length) return [];
  const db = dbOf(ctx);
  const ws = ctx.actor.workspaceId;
  const pids = [...new Set(rows.map((r) => r.projectId))];
  const bids = [...new Set(rows.map((r) => r.budgetId).filter((x): x is string => !!x))];
  const cids = [...new Set(rows.map((r) => r.categoryId))];
  const ps = await db.select({ id: projects.id, name: projects.name }).from(projects).where(and(eq(projects.workspaceId, ws), inArray(projects.id, pids)));
  const bs = bids.length ? await db.select({ id: budgets.id, name: budgets.name }).from(budgets).where(and(eq(budgets.workspaceId, ws), inArray(budgets.id, bids))) : [];
  const cs = await db.select({ id: financeCategories.id, name: financeCategories.name }).from(financeCategories).where(and(eq(financeCategories.workspaceId, ws), inArray(financeCategories.id, cids)));
  const cons = await db
    .select({ id: commitmentConsumptions.id, commitmentId: commitmentConsumptions.commitmentId, amount: commitmentConsumptions.amountMinor, reversedAt: commitmentConsumptions.reversedAt, createdAt: commitmentConsumptions.createdAt, entryId: financialEntries.id, title: financialEntries.title })
    .from(commitmentConsumptions)
    .innerJoin(financialEntryLines, eq(financialEntryLines.id, commitmentConsumptions.entryLineId))
    .innerJoin(financialEntries, eq(financialEntries.id, financialEntryLines.entryId))
    .where(and(eq(commitmentConsumptions.workspaceId, ws), inArray(commitmentConsumptions.commitmentId, rows.map((r) => r.id))))
    .orderBy(asc(commitmentConsumptions.createdAt));
  return rows.map((c) => {
    const cur = c.currency.trim();
    return {
      id: c.id,
      project: { id: c.projectId, name: ps.find((p) => p.id === c.projectId)?.name ?? 'Unavailable project' },
      budget: c.budgetId ? { id: c.budgetId, name: bs.find((b) => b.id === c.budgetId)?.name ?? 'Budget' } : null,
      category: { id: c.categoryId, name: cs.find((x) => x.id === c.categoryId)?.name ?? 'Category' },
      amount: moneyOf(c.amountMinor, cur),
      consumed: moneyOf(c.consumedMinor, cur),
      remaining: moneyOf(c.state === 'cancelled' ? 0n : c.amountMinor - c.consumedMinor, cur),
      dueDate: c.dueDate,
      counterparty: c.counterparty,
      description: c.description,
      state: c.state,
      cancelReason: c.cancelReason,
      consumptions: cons
        .filter((x) => x.commitmentId === c.id)
        .map((x) => ({ id: x.id, entryId: x.entryId, entryTitle: x.title, amount: moneyOf(x.amount, cur), reversedAt: x.reversedAt?.toISOString() ?? null, createdAt: x.createdAt.toISOString() })),
      createdAt: c.createdAt.toISOString(),
      rowVersion: c.rowVersion,
    };
  });
};

export const listCommitments = async (ctx: QueryContext, input: { cursor?: string; pageSize?: number; projectId?: string; budgetId?: string; state?: CommitmentRow['state'][] }) => {
  requirePermission(ctx, 'budgets.read');
  const size = clampPageSize(input.pageSize);
  const c = input.cursor ? decodeCursor(input.cursor) : null;
  const f = listFilter(ctx.actor.access, 'budgets.read');
  const scope = f.kind === 'all' ? undefined : f.kind === 'scoped' && f.projectIds.length ? inArray(commitments.projectId, f.projectIds) : sql`false`;
  const rows = await dbOf(ctx)
    .select()
    .from(commitments)
    .where(
      and(
        eq(commitments.workspaceId, ctx.actor.workspaceId),
        scope,
        input.projectId ? eq(commitments.projectId, input.projectId) : undefined,
        input.budgetId ? eq(commitments.budgetId, input.budgetId) : undefined,
        input.state?.length ? inArray(commitments.state, input.state) : undefined,
        c ? or(lt(commitments.createdAt, new Date(String(c.v[0]))), and(eq(commitments.createdAt, new Date(String(c.v[0]))), lt(commitments.id, c.id))) : undefined,
      ),
    )
    .orderBy(desc(commitments.createdAt), desc(commitments.id))
    .limit(size + 1);
  const hasMore = rows.length > size;
  const pageRows = hasMore ? rows.slice(0, size) : rows;
  const last = pageRows[pageRows.length - 1];
  return { items: await commitmentViews(ctx, pageRows), hasMore, nextCursor: hasMore && last ? encodeCursor({ v: [last.createdAt.toISOString()], id: last.id }) : null };
};

export const getCommitment = async (ctx: QueryContext | CommandContext, id: string) => {
  const c = await findById(ctx, commitments, id, 'Commitment');
  if (!can(ctx.actor.access, 'budgets.read', commitmentScope(c))) throw new AppError('NOT_FOUND', 'Commitment was not found.');
  return (await commitmentViews(ctx, [c]))[0]!;
};

interface CommitmentInput {
  projectId: string;
  budgetId?: string | null;
  categoryId: string;
  amount: string;
  currency: string;
  dueDate?: string | null;
  counterparty?: string | null;
  description: string;
}

const validateCommitment = async (ctx: CommandContext, input: CommitmentInput) => {
  const errors: FieldError[] = [];
  const amountMinor = parseAmount(input.amount, input.currency, 'amount', errors);
  const [p] = await ctx.tx.select({ id: projects.id }).from(projects).where(and(eq(projects.workspaceId, ctx.actor.workspaceId), eq(projects.id, input.projectId)));
  if (!p) errors.push({ field: 'projectId', code: 'NOT_FOUND', message: 'Choose a project.' });
  const [cat] = await ctx.tx.select().from(financeCategories).where(and(eq(financeCategories.workspaceId, ctx.actor.workspaceId), eq(financeCategories.id, input.categoryId)));
  if (!cat || !(BUDGET_CLASSES as readonly string[]).includes(cat.accountingClass)) errors.push({ field: 'categoryId', code: 'CLASS', message: 'Choose an expense category.' });
  if (input.budgetId) {
    const [b] = await ctx.tx.select().from(budgets).where(and(eq(budgets.workspaceId, ctx.actor.workspaceId), eq(budgets.id, input.budgetId)));
    if (!b) errors.push({ field: 'budgetId', code: 'NOT_FOUND', message: 'Budget was not found.' });
    else if (b.currency.trim() !== input.currency) errors.push({ field: 'currency', code: 'CURRENCY', message: 'Use the budget currency.' });
  }
  throwIfErrors(errors);
  return amountMinor;
};

export const createCommitment = async (ctx: CommandContext, input: CommitmentInput) => {
  requirePermission(ctx, 'budgets.write');
  if (!can(ctx.actor.access, 'budgets.write', { projectId: input.projectId })) throw new AppError('FORBIDDEN', 'You cannot record commitments for this project.');
  const amountMinor = await validateCommitment(ctx, input);
  const id = newId();
  const [row] = await ctx.tx
    .insert(commitments)
    .values({
      ...stamp(ctx),
      id,
      projectId: input.projectId,
      budgetId: input.budgetId ?? null,
      categoryId: input.categoryId,
      amountMinor,
      currency: input.currency,
      dueDate: input.dueDate ?? null,
      counterparty: input.counterparty?.trim() || null,
      description: input.description.trim(),
    })
    .returning();
  await audit(ctx, { action: 'commitment.created', entityType: 'commitment', entityId: id, projectId: input.projectId, sensitivity: 'finance', diff: diffFields(null, row!, ['projectId', 'categoryId', 'currency', 'dueDate', 'description']) });
  await emit(ctx, { type: 'commitment.created', entityType: 'commitment', entityId: id, revision: 1 });
  await evaluateBudgetAlerts(ctx, { projectIds: [input.projectId], campaignIds: [], date: input.dueDate ?? ctx.app.clock.now().toISOString().slice(0, 10) });
  return id;
};

export const updateCommitment = async (ctx: CommandContext, id: string, patch: Partial<CommitmentInput>) => {
  const c = await lockById(ctx, commitments, id, 'Commitment');
  if (!can(ctx.actor.access, 'budgets.write', commitmentScope(c))) {
    if (can(ctx.actor.access, 'budgets.read', commitmentScope(c))) throw new AppError('FORBIDDEN', 'You do not have permission to perform this action.');
    throw new AppError('NOT_FOUND', 'Commitment was not found.');
  }
  assertVersion(ctx, c);
  if (c.state === 'cancelled' || c.state === 'consumed') throw new AppError('INVALID_STATE', 'Closed commitments cannot be edited.');
  const cur = c.currency.trim();
  const merged: CommitmentInput = {
    projectId: patch.projectId ?? c.projectId,
    budgetId: patch.budgetId !== undefined ? patch.budgetId : c.budgetId,
    categoryId: patch.categoryId ?? c.categoryId,
    amount: patch.amount ?? moneyOf(c.amountMinor, cur).amount,
    currency: patch.currency ?? cur,
    dueDate: patch.dueDate !== undefined ? patch.dueDate : c.dueDate,
    counterparty: patch.counterparty !== undefined ? patch.counterparty : c.counterparty,
    description: patch.description ?? c.description,
  };
  if (c.consumedMinor > 0n && (merged.currency !== cur || merged.projectId !== c.projectId || merged.categoryId !== c.categoryId))
    throw new AppError('INVALID_STATE', 'A partly consumed commitment keeps its project, category and currency.');
  if (merged.projectId !== c.projectId && !can(ctx.actor.access, 'budgets.write', { projectId: merged.projectId })) throw new AppError('FORBIDDEN', 'You cannot move commitments to this project.');
  const amountMinor = await validateCommitment(ctx, merged);
  if (amountMinor < c.consumedMinor)
    throw new AppError('VALIDATION_FAILED', 'The amount cannot be below the part already converted to actual costs.', { fieldErrors: [{ field: 'amount', code: 'BELOW_CONSUMED', message: `At least ${moneyOf(c.consumedMinor, cur).amount} ${cur} is already consumed.` }] });
  const [row] = await ctx.tx
    .update(commitments)
    .set({
      projectId: merged.projectId,
      budgetId: merged.budgetId ?? null,
      categoryId: merged.categoryId,
      amountMinor,
      currency: merged.currency,
      dueDate: merged.dueDate ?? null,
      counterparty: merged.counterparty?.trim() || null,
      description: merged.description.trim(),
      state: c.consumedMinor >= amountMinor ? 'consumed' : c.consumedMinor > 0n ? 'partially_consumed' : 'open',
      ...touch(ctx, commitments),
    })
    .where(eq(commitments.id, id))
    .returning();
  await audit(ctx, { action: 'commitment.updated', entityType: 'commitment', entityId: id, projectId: row!.projectId, sensitivity: 'finance', diff: diffFields(c, row!, ['projectId', 'budgetId', 'categoryId', 'amountMinor', 'currency', 'dueDate', 'counterparty', 'description']) });
  await emit(ctx, { type: 'commitment.updated', entityType: 'commitment', entityId: id, revision: row!.rowVersion });
  return id;
};

export const cancelCommitment = async (ctx: CommandContext, id: string, input: { reason: string }) => {
  const c = await lockById(ctx, commitments, id, 'Commitment');
  if (!can(ctx.actor.access, 'budgets.write', commitmentScope(c))) {
    if (can(ctx.actor.access, 'budgets.read', commitmentScope(c))) throw new AppError('FORBIDDEN', 'You do not have permission to perform this action.');
    throw new AppError('NOT_FOUND', 'Commitment was not found.');
  }
  assertVersion(ctx, c);
  if (c.state === 'cancelled' || c.state === 'consumed') throw new AppError('INVALID_STATE', 'This commitment is already closed.');
  const [row] = await ctx.tx.update(commitments).set({ state: 'cancelled', cancelReason: input.reason, ...touch(ctx, commitments) }).where(eq(commitments.id, id)).returning();
  await audit(ctx, { action: 'commitment.cancelled', entityType: 'commitment', entityId: id, projectId: c.projectId, sensitivity: 'finance', reason: input.reason });
  await emit(ctx, { type: 'commitment.updated', entityType: 'commitment', entityId: id, revision: row!.rowVersion });
  return id;
};

/** Convert to actual: a draft expense linked to the commitment; posting it consumes the commitment. */
export const convertCommitment = async (ctx: CommandContext, id: string, input: { amount?: string; recognitionDate: string; title?: string }) => {
  requirePermission(ctx, 'finance.create');
  const c = await lockById(ctx, commitments, id, 'Commitment');
  if (!can(ctx.actor.access, 'budgets.read', commitmentScope(c)) && !can(ctx.actor.access, 'finance.create', commitmentScope(c))) throw new AppError('NOT_FOUND', 'Commitment was not found.');
  if (c.state === 'cancelled' || c.state === 'consumed') throw new AppError('INVALID_STATE', 'Nothing remains to convert on this commitment.');
  const cur = c.currency.trim();
  const remaining = c.amountMinor - c.consumedMinor;
  const entryId = await createEntry(
    ctx,
    {
      type: 'expense',
      title: (input.title ?? c.description).slice(0, 120),
      recognitionDate: input.recognitionDate,
      counterparty: c.counterparty,
      lines: [
        {
          categoryId: c.categoryId,
          amount: input.amount ?? moneyOf(remaining, cur).amount,
          currency: cur,
          description: `Commitment: ${c.description}`.slice(0, 500),
          commitmentId: c.id,
          allocation: { mode: 'weights', rows: [{ projectId: c.projectId, value: '1' }] },
        },
      ],
    },
    { via: 'commitment' },
  );
  await audit(ctx, { action: 'commitment.converted_to_draft', entityType: 'commitment', entityId: id, projectId: c.projectId, sensitivity: 'finance', metadata: { entryId } });
  return getEntry(ctx, entryId);
};
