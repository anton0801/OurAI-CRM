import { and, desc, eq, gte, ilike, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import { can, listFilter, type ObjectScope } from '@castlane/authorization';
import { automationRules, automationRuleVersions, automationRuns, memberships, templates, templateVersions, users, workspaces, type DbOrTx } from '@castlane/database';
import {
  AppError,
  AUTOMATION_TRIGGER_KIND,
  assertTransition,
  clampPageSize,
  decodeCursor,
  encodeCursor,
  newId,
  nextAutomationSlot,
  unknownAutomationPlaceholders,
  validateAutomationConditions,
  validateAutomationSchedule,
  type FieldError,
  type TransitionTable,
} from '@castlane/domain';
import type { AutomationActionInput, AutomationRuleConfig, AutomationRuleDetail, AutomationRuleRow } from '@castlane/api-contracts';
import { allowed, loadAccessSnapshot, requirePermission } from '../core/access';
import { audit, diffFields } from '../core/audit';
import { all, dbOf, type CommandContext, type QueryContext } from '../core/context';
import { emit } from '../core/events';
import { isActiveMember, loadMemberRefs, refOrUnknown } from '../core/members';
import { notify } from '../core/notify';
import { assertVersion, findById, lockById, stamp, touch } from '../core/rows';
import { triggerDef } from './catalog';
import { authorityGaps, describeGaps, fixedProjectIds } from './principal';
import { scopeContainsProject } from './principal';
import { scopeLabelOf, scopeLabels, scopeTargetExists, type RuleScopeLike } from './records';

export type AutomationRuleRowDb = typeof automationRules.$inferSelect;
type VersionRow = typeof automationRuleVersions.$inferSelect;
type RuleState = AutomationRuleRowDb['state'];

export const AUTOMATION_RULE_TRANSITIONS: TransitionTable<RuleState> = {
  draft: ['enabled', 'disabled', 'paused_needs_owner'],
  enabled: ['disabled', 'paused_needs_owner', 'paused_requires_attention'],
  disabled: ['enabled', 'paused_needs_owner'],
  paused_needs_owner: ['enabled', 'disabled'],
  paused_requires_attention: ['enabled', 'disabled', 'paused_needs_owner'],
};

const fe = (field: string, code: string, message: string): FieldError => ({ field, code, message });

export const configOfVersion = (v: VersionRow): AutomationRuleConfig => ({
  trigger: v.trigger as AutomationRuleConfig['trigger'],
  conditions: v.conditions as AutomationRuleConfig['conditions'],
  actions: v.actions as AutomationActionInput[],
  quietHoursPolicy: v.quietHoursPolicy,
});

/** Scope of a rule as an authorization object (automations.* permissions). */
export const ruleAuthScope = (r: Pick<AutomationRuleRowDb, 'id' | 'scopeType' | 'scopeId' | 'ownerMembershipId'>): ObjectScope => ({
  objectType: 'automation_rule',
  objectId: r.id,
  projectId: r.scopeType === 'project' ? r.scopeId : null,
  accountId: r.scopeType === 'account' ? r.scopeId : null,
  directionId: r.scopeType === 'direction' ? r.scopeId : null,
  ownerMembershipId: r.ownerMembershipId,
});

/** Rules visible to the member for a permission, in SQL (before pagination). */
export const ruleVisibilitySql = (ctx: QueryContext, permission = 'automations.read'): SQL | undefined => {
  const f = listFilter(ctx.actor.access, permission);
  if (f.kind === 'all') return undefined;
  if (f.kind === 'none') return sql`false`;
  const parts: SQL[] = [];
  const list = (ids: string[]) => sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `);
  if (f.projectIds.length) {
    parts.push(sql`(${automationRules.scopeType} = 'project' AND ${automationRules.scopeId} IN (${list(f.projectIds)}))`);
    parts.push(sql`(${automationRules.scopeType} = 'account' AND ${automationRules.scopeId} IN (SELECT a.id FROM social_accounts a WHERE a.project_id IN (${list(f.projectIds)})))`);
  }
  if (f.accountIds.length) parts.push(sql`(${automationRules.scopeType} = 'account' AND ${automationRules.scopeId} IN (${list(f.accountIds)}))`);
  const dirGrants = ctx.actor.access.grants.filter((g) => g.permissions.has(permission) && g.scopeType === 'direction' && g.scopeId).map((g) => g.scopeId!);
  if (dirGrants.length) parts.push(sql`(${automationRules.scopeType} = 'direction' AND ${automationRules.scopeId} IN (${list(dirGrants)}))`);
  if (f.ownRecordsMembershipId || f.assignedToMembershipId) parts.push(eq(automationRules.ownerMembershipId, (f.ownRecordsMembershipId ?? f.assignedToMembershipId)!));
  return parts.length ? sql`(${sql.join(parts, sql` OR `)})` : sql`false`;
};

const readRule = async (ctx: QueryContext | CommandContext, id: string) => {
  const r = await findById(ctx, automationRules, id, 'Automation rule');
  if (!can(ctx.actor.access, 'automations.read', ruleAuthScope(r))) throw new AppError('NOT_FOUND', 'Automation rule was not found.');
  return r;
};

const lockRule = async (ctx: CommandContext, id: string, action: string) => {
  const r = await lockById(ctx, automationRules, id, 'Automation rule');
  const s = ruleAuthScope(r);
  if (!can(ctx.actor.access, action, s)) {
    if (can(ctx.actor.access, 'automations.read', s)) throw new AppError('FORBIDDEN', 'You do not have permission to change this rule.');
    throw new AppError('NOT_FOUND', 'Automation rule was not found.');
  }
  return r;
};

// ——— Read models ———

export const ownerStatuses = async (db: DbOrTx, ws: string, ids: (string | null)[]) => {
  const list = [...new Set(ids.filter((x): x is string => !!x))];
  if (!list.length) return new Map<string, string>();
  const rows = await db.select({ id: memberships.id, status: memberships.status }).from(memberships).where(and(eq(memberships.workspaceId, ws), inArray(memberships.id, list)));
  return new Map(rows.map((r) => [r.id, r.status]));
};

export const toAutomationRuleRows = async (ctx: QueryContext | CommandContext, rows: AutomationRuleRowDb[]): Promise<AutomationRuleRow[]> => {
  if (!rows.length) return [];
  const db = dbOf(ctx);
  const ws = ctx.actor.workspaceId;
  const ids = rows.map((r) => r.id);
  const weekAgo = new Date(ctx.app.clock.now().getTime() - 7 * 86_400_000);
  const [versions, lastRuns, failures, labels, refs, statuses] = await all(ctx, [
    () =>
      db
        .select({ id: automationRuleVersions.id, versionNo: automationRuleVersions.versionNo, trigger: automationRuleVersions.trigger })
        .from(automationRuleVersions)
        .where(and(eq(automationRuleVersions.workspaceId, ws), inArray(automationRuleVersions.ruleId, ids))),
    () =>
      db
        .selectDistinctOn([automationRuns.ruleId], { ruleId: automationRuns.ruleId, state: automationRuns.state })
        .from(automationRuns)
        .where(and(eq(automationRuns.workspaceId, ws), inArray(automationRuns.ruleId, ids), inArray(automationRuns.state, ['succeeded', 'failed', 'dead'])))
        .orderBy(automationRuns.ruleId, desc(automationRuns.finishedAt)),
    () =>
      db
        .select({ ruleId: automationRuns.ruleId, n: sql<number>`count(*)::int` })
        .from(automationRuns)
        .where(and(eq(automationRuns.workspaceId, ws), inArray(automationRuns.ruleId, ids), inArray(automationRuns.state, ['failed', 'dead']), gte(automationRuns.createdAt, weekAgo)))
        .groupBy(automationRuns.ruleId),
    () => scopeLabels(db, ws, rows),
    () => loadMemberRefs(db, ws, rows.map((r) => r.ownerMembershipId)),
    () => ownerStatuses(db, ws, rows.map((r) => r.ownerMembershipId)),
  ] as const);
  const vById = new Map(versions.map((v) => [v.id, v]));
  return rows.map((r) => {
    const current = r.currentVersionId ? vById.get(r.currentVersionId) : undefined;
    const enabled = r.enabledVersionId ? vById.get(r.enabledVersionId) : undefined;
    const event = ((enabled ?? current)?.trigger.event ?? 'schedule.daily') as AutomationRuleRow['trigger']['event'];
    const def = triggerDef(event);
    return {
      id: r.id,
      name: r.name,
      state: r.state,
      trigger: { event, label: def?.label ?? event, kind: AUTOMATION_TRIGGER_KIND[event] },
      scope: { type: r.scopeType, id: r.scopeId, label: scopeLabelOf(r, labels) },
      owner: refOrUnknown(refs, r.ownerMembershipId),
      needsOwner: !r.ownerMembershipId || statuses.get(r.ownerMembershipId) !== 'active',
      currentVersionNo: current?.versionNo ?? null,
      enabledVersionNo: enabled?.versionNo ?? null,
      hasUnpublishedChanges: !!r.enabledVersionId && r.enabledVersionId !== r.currentVersionId,
      lastRunAt: r.lastRunAt?.toISOString() ?? null,
      lastRunState: lastRuns.find((l) => l.ruleId === r.id)?.state ?? null,
      failureCount: Number(failures.find((f) => f.ruleId === r.id)?.n ?? 0),
      pausedReason: r.pausedReason,
      nextScheduledAt: r.nextScheduledAt?.toISOString() ?? null,
      archivedAt: r.archivedAt?.toISOString() ?? null,
      updatedAt: r.updatedAt.toISOString(),
      rowVersion: r.rowVersion,
    };
  });
};

export const listAutomationRules = async (
  ctx: QueryContext,
  input: { cursor?: string; pageSize?: number; q?: string; state?: RuleState[]; trigger?: string; ownerMembershipId?: string; needsAttention?: boolean; includeArchived?: boolean },
) => {
  requirePermission(ctx, 'automations.read');
  const size = clampPageSize(input.pageSize);
  const c = input.cursor ? decodeCursor(input.cursor) : null;
  const q = input.q?.trim();
  const rows = await dbOf(ctx)
    .select()
    .from(automationRules)
    .where(
      and(
        eq(automationRules.workspaceId, ctx.actor.workspaceId),
        ruleVisibilitySql(ctx),
        input.includeArchived ? undefined : isNull(automationRules.archivedAt),
        input.state?.length ? inArray(automationRules.state, input.state) : undefined,
        input.ownerMembershipId ? eq(automationRules.ownerMembershipId, input.ownerMembershipId) : undefined,
        input.needsAttention ? or(inArray(automationRules.state, ['paused_needs_owner', 'paused_requires_attention']), isNull(automationRules.ownerMembershipId)) : undefined,
        input.trigger
          ? sql`EXISTS (SELECT 1 FROM automation_rule_versions v WHERE v.id = coalesce(${automationRules.enabledVersionId}, ${automationRules.currentVersionId}) AND v.trigger->>'event' = ${input.trigger})`
          : undefined,
        q ? ilike(automationRules.name, `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`) : undefined,
        c ? or(lt(automationRules.updatedAt, new Date(String(c.v[0]))), and(eq(automationRules.updatedAt, new Date(String(c.v[0]))), lt(automationRules.id, c.id))) : undefined,
      ),
    )
    .orderBy(desc(automationRules.updatedAt), desc(automationRules.id))
    .limit(size + 1);
  const hasMore = rows.length > size;
  const page = hasMore ? rows.slice(0, size) : rows;
  const last = page[page.length - 1];
  return { items: await toAutomationRuleRows(ctx, page), hasMore, nextCursor: hasMore && last ? encodeCursor({ v: [last.updatedAt.toISOString()], id: last.id }) : null };
};

const versionView = (v: VersionRow, refs: Map<string, { membershipId: string; displayName: string; avatarUrl: string | null }>, userMember: Map<string, string>) => ({
  ...configOfVersion(v),
  id: v.id,
  versionNo: v.versionNo,
  createdAt: v.createdAt.toISOString(),
  createdBy: v.createdBy && userMember.get(v.createdBy) ? refOrUnknown(refs, userMember.get(v.createdBy)) : null,
});

export const getAutomationRule = async (ctx: QueryContext | CommandContext, id: string): Promise<AutomationRuleDetail> => {
  const r = await readRule(ctx, id);
  const db = dbOf(ctx);
  const ws = ctx.actor.workspaceId;
  const [row] = await toAutomationRuleRows(ctx, [r]);
  const [versions, counts] = await all(ctx, [
    () => db.select().from(automationRuleVersions).where(and(eq(automationRuleVersions.workspaceId, ws), eq(automationRuleVersions.ruleId, id))).orderBy(desc(automationRuleVersions.versionNo)),
    () =>
      db
        .select({ state: automationRuns.state, n: sql<number>`count(*)::int` })
        .from(automationRuns)
        .where(and(eq(automationRuns.workspaceId, ws), eq(automationRuns.ruleId, id)))
        .groupBy(automationRuns.state),
  ] as const);
  const creators = [...new Set(versions.map((v) => v.createdBy).filter((x): x is string => !!x))];
  const um = creators.length
    ? await db.select({ userId: memberships.userId, id: memberships.id }).from(memberships).where(and(eq(memberships.workspaceId, ws), inArray(memberships.userId, creators)))
    : [];
  const userMember = new Map(um.map((m) => [m.userId, m.id]));
  const refs = await loadMemberRefs(db, ws, [...userMember.values()]);
  const current = versions.find((v) => v.id === r.currentVersionId) ?? null;
  const n = (s: string[]) => counts.filter((c) => s.includes(c.state)).reduce((a, c) => a + Number(c.n), 0);
  const scope = ruleAuthScope(r);
  const archived = !!r.archivedAt;
  return {
    ...row!,
    currentVersion: current ? versionView(current, refs, userMember) : null,
    enabledVersionId: r.enabledVersionId,
    versions: versions.map((v) => ({ id: v.id, versionNo: v.versionNo, createdAt: v.createdAt.toISOString(), createdBy: v.createdBy && userMember.get(v.createdBy) ? refOrUnknown(refs, userMember.get(v.createdBy)) : null, enabled: v.id === r.enabledVersionId })),
    runCounts: { succeeded: n(['succeeded']), failed: n(['failed', 'dead']), skipped: n(['skipped']), pending: n(['pending', 'running', 'throttled']) },
    permissions: {
      edit: !archived && allowed(ctx, 'automations.edit', scope),
      enable: !archived && allowed(ctx, 'automations.enable', scope),
      disable: !archived && allowed(ctx, 'automations.enable', scope) && r.state !== 'disabled' && r.state !== 'draft',
      duplicate: allowed(ctx, 'automations.create', scope),
      archive: allowed(ctx, 'automations.edit', scope),
      retry: !archived && allowed(ctx, 'automations.edit', scope),
      dryRun: allowed(ctx, 'automations.read', scope),
    },
  };
};

// ——— Validation ———

export interface RuleDraft {
  name?: string;
  ownerMembershipId: string | null;
  scopeType: RuleScopeLike['scopeType'];
  scopeId: string | null;
  config: AutomationRuleConfig;
}

const TEXT_FIELDS: Record<string, string[]> = {
  create_task: ['title', 'description'],
  notify: ['title', 'message'],
  request_internal_approval: ['title', 'note'],
  create_incident: ['title', 'description'],
};

/** Checks that need no database: trigger shape, conditions, action/trigger compatibility, placeholders. */
export const staticRuleErrors = (config: AutomationRuleConfig): { errors: FieldError[]; warnings: string[] } => {
  const errors: FieldError[] = [];
  const warnings: string[] = [];
  const t = triggerDef(config.trigger.event);
  if (!t) return { errors: [fe('config.trigger.event', 'UNKNOWN', 'Choose an allowed trigger.')], warnings };
  if (t.kind === 'schedule') {
    errors.push(...validateAutomationSchedule(config.trigger.schedule));
    const cadence = config.trigger.event.split('.')[1];
    if (config.trigger.schedule && config.trigger.schedule.cadence !== cadence) errors.push(fe('config.trigger.schedule.cadence', 'MISMATCH', `Use the ${cadence} cadence for this trigger.`));
    if (config.conditions.length) errors.push(fe('config.conditions', 'NOT_APPLICABLE', 'Scheduled rules have no triggering record to test conditions on.'));
  } else if (config.trigger.schedule) errors.push(fe('config.trigger.schedule', 'NOT_APPLICABLE', 'Only scheduled triggers have a schedule.'));
  if (t.kind !== 'deadline' && config.trigger.thresholdHours !== undefined) errors.push(fe('config.trigger.thresholdHours', 'NOT_APPLICABLE', 'Only deadline triggers have a threshold.'));
  errors.push(...validateAutomationConditions(config.conditions, t.fields));
  config.actions.forEach((a, i) => {
    const at = `config.actions.${i}`;
    if (!t.actions.includes(a.type)) {
      errors.push(fe(`${at}.type`, 'NOT_ALLOWED', 'This action is not available for the chosen trigger.'));
      return;
    }
    const people: { ref: { kind: string; membershipId?: string | null } | undefined; field: string }[] = [];
    if (a.type === 'create_task') people.push({ ref: a.params.assignee, field: `${at}.params.assignee` });
    if (a.type === 'assign_member') people.push({ ref: a.params.assignee, field: `${at}.params.assignee` });
    if (a.type === 'request_internal_approval') people.push({ ref: a.params.approver, field: `${at}.params.approver` });
    if (a.type === 'notify') a.params.recipients.forEach((ref, k) => people.push({ ref, field: `${at}.params.recipients.${k}` }));
    for (const p of people) {
      if (!p.ref) continue;
      if (p.ref.kind === 'member' && !p.ref.membershipId) errors.push(fe(`${p.field}.membershipId`, 'REQUIRED', 'Choose a member.'));
      if ((p.ref.kind === 'entity_assignee' || p.ref.kind === 'entity_owner') && !t.entityType) errors.push(fe(`${p.field}.kind`, 'NOT_APPLICABLE', 'Scheduled rules have no triggering record.'));
      if (a.type === 'assign_member' && p.ref.kind === 'entity_assignee') errors.push(fe(`${p.field}.kind`, 'NOT_APPLICABLE', 'Choose who should become the assignee.'));
    }
    if ((a.type === 'create_task' || a.type === 'create_task_from_template') && !t.entityType && !a.params.projectId)
      errors.push(fe(`${at}.params.projectId`, 'REQUIRED', 'Scheduled rules need a project for created tasks.'));
    if (a.type === 'request_internal_approval' && !t.entityType) errors.push(fe(`${at}.type`, 'NOT_ALLOWED', 'Approval requests need a triggering record.'));
    for (const f of TEXT_FIELDS[a.type] ?? []) {
      const v = (a.params as Record<string, unknown>)[f];
      if (typeof v !== 'string') continue;
      const unknown = unknownAutomationPlaceholders(v);
      if (unknown.length) errors.push(fe(`${at}.params.${f}`, 'UNKNOWN_PLACEHOLDER', `Unknown placeholder: ${unknown.join(', ')}.`));
      if (!t.entityType && /\{\{\s*(entity|project|account)\./.test(v)) warnings.push(`Action ${i + 1}: scheduled rules have no record, so {{entity…}}, {{project…}} and {{account…}} stay empty.`);
    }
  });
  if (t.key === 'budget.threshold_crossed' && config.actions.some((a) => a.type === 'create_task' && !a.params.projectId))
    warnings.push('Workspace or direction budgets have no project: choose a project for created tasks, or they fail for those budgets.');
  return { errors, warnings };
};

const memberIdsOf = (config: AutomationRuleConfig) => {
  const out: { id: string; field: string }[] = [];
  config.actions.forEach((a, i) => {
    const at = `config.actions.${i}.params`;
    const add = (ref: { kind: string; membershipId?: string | null } | undefined, field: string) => {
      if (ref?.kind === 'member' && ref.membershipId) out.push({ id: ref.membershipId, field: `${at}.${field}.membershipId` });
    };
    if (a.type === 'create_task') add(a.params.assignee, 'assignee');
    if (a.type === 'assign_member') add(a.params.assignee, 'assignee');
    if (a.type === 'request_internal_approval') add(a.params.approver, 'approver');
    if (a.type === 'notify') a.params.recipients.forEach((r, k) => add(r, `recipients.${k}`));
  });
  return out;
};

/**
 * Full validation: static checks plus references (scope target, members, projects inside the
 * scope, published templates) and authority: the owner must hold every needed permission over the
 * whole rule scope (execution principal = owner ∩ scope). With `forEnable` missing authority and a
 * missing owner are errors; otherwise warnings (the rule is saved disabled).
 */
export const validateRuleDraft = async (ctx: QueryContext | CommandContext, d: RuleDraft, opts: { forEnable?: boolean } = {}) => {
  const db = dbOf(ctx);
  const ws = ctx.actor.workspaceId;
  const { errors, warnings } = staticRuleErrors(d.config);
  const scope: RuleScopeLike = { scopeType: d.scopeType, scopeId: d.scopeType === 'workspace' ? null : d.scopeId };
  if (d.scopeType !== 'workspace' && !d.scopeId) errors.push(fe('scopeId', 'REQUIRED', 'Choose the scope record.'));
  else if (!(await scopeTargetExists(db, ws, scope))) errors.push(fe('scopeId', 'NOT_FOUND', 'The scope record was not found.'));
  for (const m of memberIdsOf(d.config)) if (!(await isActiveMember(db, ws, m.id))) errors.push(fe(m.field, 'INACTIVE', 'Choose an active member.'));
  for (const projectId of fixedProjectIds(d.config))
    if (!(await scopeContainsProject(db, ws, scope, projectId)))
      errors.push(
        fe(
          `config.actions.${d.config.actions.findIndex((a) => (a.type === 'create_task' || a.type === 'create_task_from_template') && a.params.projectId === projectId)}.params.projectId`,
          'OUT_OF_SCOPE',
          'The project must be inside the rule scope.',
        ),
      );
  for (const [i, a] of d.config.actions.entries()) {
    if (a.type !== 'create_task_from_template') continue;
    const [v] = await db
      .select({ state: templateVersions.state, disabledAt: templates.disabledAt, archivedAt: templates.archivedAt })
      .from(templateVersions)
      .innerJoin(templates, eq(templates.id, templateVersions.templateId))
      .where(and(eq(templateVersions.workspaceId, ws), eq(templateVersions.id, a.params.templateVersionId)));
    if (!v || v.state !== 'published' || v.disabledAt || v.archivedAt) errors.push(fe(`config.actions.${i}.params.templateVersionId`, 'NOT_PUBLISHED', 'Choose a published, enabled template version.'));
  }
  // Owner (execution principal).
  let ownerOk = false;
  if (!d.ownerMembershipId) {
    if (opts.forEnable) errors.push(fe('ownerMembershipId', 'REQUIRED', 'Assign an owner before enabling the rule.'));
    else warnings.push('Needs Owner: the rule cannot run until an owner is assigned.');
  } else {
    const [m] = await db.select({ userId: memberships.userId, status: memberships.status }).from(memberships).where(and(eq(memberships.workspaceId, ws), eq(memberships.id, d.ownerMembershipId)));
    if (!m || m.status !== 'active') errors.push(fe('ownerMembershipId', 'INACTIVE', 'The owner must be an active member.'));
    else if (!errors.some((e) => e.field === 'scopeId')) {
      const access = await loadAccessSnapshot(ctx.app.db, ws, m.userId, ctx.app.clock.now());
      const gaps = access ? await authorityGaps(db, ws, scope, d.config, access) : [];
      if (gaps.length) {
        const msg = `The owner lacks ${describeGaps(gaps)} in the rule scope. A rule acts only with its owner’s rights inside its scope.`;
        if (opts.forEnable) errors.push(fe('ownerMembershipId', 'OWNER_ACCESS', msg));
        else warnings.push(msg);
      } else ownerOk = true;
    }
  }
  // The member enabling a rule cannot hand out more than they hold themselves.
  if (opts.forEnable && ctx.actor.kind === 'user' && !errors.some((e) => e.field === 'scopeId')) {
    const gaps = await authorityGaps(db, ws, scope, d.config, ctx.actor.access);
    if (gaps.length) errors.push(fe('scopeId', 'ACTOR_ACCESS', `You lack ${describeGaps(gaps)} in this scope, so you cannot enable a rule that uses it.`));
  }
  return { ok: errors.length === 0, errors, warnings, ownerOk };
};

const failIf = (r: { errors: FieldError[] }, message = 'The rule needs changes before it can be saved.') => {
  if (r.errors.length) throw new AppError('VALIDATION_FAILED', message, { fieldErrors: r.errors });
};

// ——— Commands ———

const sameConfig = (a: AutomationRuleConfig, b: AutomationRuleConfig) => JSON.stringify(a) === JSON.stringify(b);

const insertVersion = async (ctx: CommandContext, ruleId: string, versionNo: number, config: AutomationRuleConfig) => {
  const id = newId();
  await ctx.tx.insert(automationRuleVersions).values({
    ...stamp(ctx),
    id,
    ruleId,
    versionNo,
    trigger: config.trigger,
    conditions: config.conditions,
    actions: config.actions as never,
    quietHoursPolicy: config.quietHoursPolicy,
  });
  return id;
};

const notifyNewOwner = async (ctx: CommandContext, r: AutomationRuleRowDb) => {
  if (!r.ownerMembershipId) return;
  await notify(ctx.tx, {
    workspaceId: ctx.actor.workspaceId,
    recipientMembershipIds: [r.ownerMembershipId],
    eventType: 'automation.owner_assigned',
    eventKey: `automation.owner_assigned:${r.id}:${r.ownerMembershipId}:${r.rowVersion}`,
    kind: 'assignment',
    title: `You own the automation rule “${r.name}”`,
    excerpt: 'The rule acts with your rights inside its scope. It pauses if your access no longer covers it.',
    entityType: 'automation_rule',
    entityId: r.id,
    actorMembershipId: ctx.actor.membershipId,
    at: ctx.app.clock.now(),
  });
};

export const createAutomationRule = async (ctx: CommandContext, input: RuleDraft & { name: string }, opts: { state?: 'draft' | 'disabled'; duplicatedFrom?: string } = {}) => {
  requirePermission(ctx, 'automations.create');
  const scope: RuleScopeLike = { scopeType: input.scopeType, scopeId: input.scopeType === 'workspace' ? null : (input.scopeId ?? null) };
  if (!allowed(ctx, 'automations.create', ruleAuthScope({ id: '', ...scope, ownerMembershipId: input.ownerMembershipId }))) throw new AppError('FORBIDDEN', 'You cannot create rules in this scope.');
  failIf(await validateRuleDraft(ctx, { ...input, ...scope }));
  const id = newId();
  const [row] = await ctx.tx
    .insert(automationRules)
    .values({ ...stamp(ctx), id, name: input.name.trim(), ownerMembershipId: input.ownerMembershipId, state: opts.state ?? 'draft', scopeType: scope.scopeType, scopeId: scope.scopeId })
    .returning();
  const versionId = await insertVersion(ctx, id, 1, input.config);
  const [updated] = await ctx.tx.update(automationRules).set({ currentVersionId: versionId }).where(eq(automationRules.id, id)).returning();
  await audit(ctx, {
    action: opts.duplicatedFrom ? 'automation.duplicated' : 'automation.created',
    entityType: 'automation_rule',
    entityId: id,
    projectId: scope.scopeType === 'project' ? scope.scopeId : null,
    diff: diffFields(null, row!, ['name', 'ownerMembershipId', 'state', 'scopeType', 'scopeId']),
    metadata: { versionNo: 1, trigger: input.config.trigger.event, actions: input.config.actions.map((a) => a.type), duplicatedFrom: opts.duplicatedFrom ?? null },
  });
  await emit(ctx, { type: 'automation_rule.created', entityType: 'automation_rule', entityId: id, revision: updated!.rowVersion });
  if (input.ownerMembershipId !== ctx.actor.membershipId) await notifyNewOwner(ctx, updated!);
  return id;
};

export const updateAutomationRule = async (ctx: CommandContext, id: string, input: Partial<RuleDraft> & { name?: string }) => {
  const r = await lockRule(ctx, id, 'automations.edit');
  assertVersion(ctx, r);
  if (r.archivedAt) throw new AppError('INVALID_STATE', 'Archived rules are read-only. Restore the rule first.');
  const [current] = r.currentVersionId ? await ctx.tx.select().from(automationRuleVersions).where(eq(automationRuleVersions.id, r.currentVersionId)) : [];
  const config = input.config ?? (current ? configOfVersion(current) : undefined);
  if (!config) throw new AppError('INVALID_STATE', 'The rule has no saved version.');
  const scopeType = input.scopeType ?? r.scopeType;
  const scopeId = scopeType === 'workspace' ? null : input.scopeId !== undefined ? input.scopeId : r.scopeId;
  const ownerMembershipId = input.ownerMembershipId !== undefined ? input.ownerMembershipId : r.ownerMembershipId;
  if (!allowed(ctx, 'automations.edit', ruleAuthScope({ id, scopeType, scopeId, ownerMembershipId }))) throw new AppError('FORBIDDEN', 'You cannot move rules into this scope.');
  const enabled = r.state === 'enabled';
  const v = await validateRuleDraft(ctx, { ownerMembershipId, scopeType, scopeId, config }, { forEnable: false });
  failIf(v);
  // An enabled rule must stay executable: owner/scope changes are checked against its enabled version.
  if (enabled && (input.ownerMembershipId !== undefined || input.scopeType !== undefined || input.scopeId !== undefined) && ownerMembershipId) {
    const [ev] = await ctx.tx.select().from(automationRuleVersions).where(eq(automationRuleVersions.id, r.enabledVersionId!));
    const check = await validateRuleDraft(ctx, { ownerMembershipId, scopeType, scopeId, config: configOfVersion(ev!) }, { forEnable: true });
    failIf(check, 'The enabled rule would lose its owner’s authority. Disable it first or choose another owner or scope.');
  }
  let currentVersionId = r.currentVersionId;
  let newVersionNo: number | null = null;
  if (input.config && (!current || !sameConfig(configOfVersion(current), input.config))) {
    const [mx] = await ctx.tx.select({ n: sql<number>`coalesce(max(${automationRuleVersions.versionNo}), 0)::int` }).from(automationRuleVersions).where(eq(automationRuleVersions.ruleId, id));
    newVersionNo = Number(mx?.n ?? 0) + 1;
    currentVersionId = await insertVersion(ctx, id, newVersionNo, input.config);
  }
  let state = r.state;
  if (!ownerMembershipId && enabled) state = 'paused_needs_owner';
  const [row] = await ctx.tx
    .update(automationRules)
    .set({
      name: input.name?.trim() ?? r.name,
      ownerMembershipId,
      scopeType,
      scopeId,
      currentVersionId,
      state,
      pausedReason: state === 'paused_needs_owner' && r.state !== state ? 'Needs Owner: assign an owner to resume the rule.' : r.pausedReason,
      ...touch(ctx, automationRules),
    })
    .where(eq(automationRules.id, id))
    .returning();
  await audit(ctx, {
    action: 'automation.updated',
    entityType: 'automation_rule',
    entityId: id,
    projectId: scopeType === 'project' ? scopeId : null,
    diff: diffFields(r, row!, ['name', 'ownerMembershipId', 'scopeType', 'scopeId', 'state']),
    metadata: newVersionNo ? { newVersionNo } : undefined,
  });
  await emit(ctx, { type: 'automation_rule.updated', entityType: 'automation_rule', entityId: id, revision: row!.rowVersion });
  if (row!.ownerMembershipId && row!.ownerMembershipId !== r.ownerMembershipId && row!.ownerMembershipId !== ctx.actor.membershipId) await notifyNewOwner(ctx, row!);
  return id;
};

const workspaceZone = async (db: DbOrTx, ws: string) => (await db.select({ tz: workspaces.timezone }).from(workspaces).where(eq(workspaces.id, ws)))[0]?.tz ?? 'UTC';

export const enableAutomationRule = async (ctx: CommandContext, id: string, input: { versionId: string }) => {
  const r = await lockRule(ctx, id, 'automations.enable');
  assertVersion(ctx, r);
  if (r.archivedAt) throw new AppError('INVALID_STATE', 'Restore the rule before enabling it.');
  const [v] = await ctx.tx.select().from(automationRuleVersions).where(and(eq(automationRuleVersions.workspaceId, ctx.actor.workspaceId), eq(automationRuleVersions.id, input.versionId), eq(automationRuleVersions.ruleId, id)));
  if (!v) throw new AppError('VALIDATION_FAILED', 'Choose a version of this rule.', { fieldErrors: [fe('versionId', 'NOT_FOUND', 'Choose a version of this rule.')] });
  if (r.state === 'enabled' && r.enabledVersionId === v.id) return id;
  if (r.state !== 'enabled') assertTransition(AUTOMATION_RULE_TRANSITIONS, r.state, 'enabled', 'automation rule');
  const config = configOfVersion(v);
  failIf(await validateRuleDraft(ctx, { ownerMembershipId: r.ownerMembershipId, scopeType: r.scopeType, scopeId: r.scopeId, config }, { forEnable: true }), 'The rule cannot be enabled yet.');
  const now = ctx.app.clock.now();
  const next = config.trigger.schedule ? nextAutomationSlot(config.trigger.schedule, await workspaceZone(ctx.tx, ctx.actor.workspaceId), now) : null;
  const [row] = await ctx.tx
    .update(automationRules)
    .set({ state: 'enabled', enabledVersionId: v.id, pausedReason: null, failureCount: 0, nextScheduledAt: next, ...touch(ctx, automationRules) })
    .where(eq(automationRules.id, id))
    .returning();
  await audit(ctx, { action: 'automation.enabled', entityType: 'automation_rule', entityId: id, diff: { state: { from: r.state, to: 'enabled' } }, metadata: { versionNo: v.versionNo } });
  await emit(ctx, { type: 'automation_rule.enabled', entityType: 'automation_rule', entityId: id, revision: row!.rowVersion });
  return id;
};

/** Cancel runs that have not started (Disable/Archive/Pause). Completed actions stay untouched. */
export const cancelPendingRuns = async (ctx: CommandContext, ruleId: string, code: string, message: string) => {
  const rows = await ctx.tx
    .update(automationRuns)
    .set({ state: 'skipped', errorCode: code, errorMessage: message, finishedAt: ctx.app.clock.now(), notBefore: null, ...touch(ctx, automationRuns) })
    .where(and(eq(automationRuns.workspaceId, ctx.actor.workspaceId), eq(automationRuns.ruleId, ruleId), inArray(automationRuns.state, ['pending', 'throttled'])))
    .returning({ id: automationRuns.id });
  return rows.length;
};

export const disableAutomationRule = async (ctx: CommandContext, id: string, input: { reason?: string }, opts: { skipVersion?: boolean } = {}) => {
  const r = await lockRule(ctx, id, 'automations.enable');
  if (!opts.skipVersion) assertVersion(ctx, r);
  if (r.state === 'disabled' || r.state === 'draft') return id;
  assertTransition(AUTOMATION_RULE_TRANSITIONS, r.state, 'disabled', 'automation rule');
  const cancelled = await cancelPendingRuns(ctx, id, 'RULE_DISABLED', 'The rule was disabled before this run started.');
  const [row] = await ctx.tx
    .update(automationRules)
    .set({ state: 'disabled', pausedReason: null, nextScheduledAt: null, ...touch(ctx, automationRules) })
    .where(eq(automationRules.id, id))
    .returning();
  await audit(ctx, { action: 'automation.disabled', entityType: 'automation_rule', entityId: id, reason: input.reason ?? null, diff: { state: { from: r.state, to: 'disabled' } }, metadata: { cancelledRuns: cancelled } });
  await emit(ctx, { type: 'automation_rule.disabled', entityType: 'automation_rule', entityId: id, revision: row!.rowVersion });
  return id;
};

export const duplicateAutomationRule = async (ctx: CommandContext, id: string, input: { name?: string }) => {
  const r = await readRule(ctx, id);
  const [v] = r.currentVersionId ? await ctx.tx.select().from(automationRuleVersions).where(eq(automationRuleVersions.id, r.currentVersionId)) : [];
  if (!v) throw new AppError('INVALID_STATE', 'The rule has no saved version to copy.');
  const name = (input.name?.trim() || `Copy of ${r.name}`).slice(0, 120);
  return createAutomationRule(ctx, { name, ownerMembershipId: r.ownerMembershipId, scopeType: r.scopeType, scopeId: r.scopeId, config: configOfVersion(v) }, { state: 'disabled', duplicatedFrom: id });
};

export const archiveAutomationRule = async (ctx: CommandContext, id: string, input: { restore?: boolean; reason?: string }, opts: { skipVersion?: boolean } = {}) => {
  const r = await lockRule(ctx, id, 'automations.edit');
  if (!opts.skipVersion) assertVersion(ctx, r);
  const at = ctx.app.clock.now();
  if (input.restore) {
    if (!r.archivedAt) return id;
    const [row] = await ctx.tx
      .update(automationRules)
      .set({ archivedAt: null, archivedBy: null, archiveReason: null, state: 'disabled', ...touch(ctx, automationRules) })
      .where(eq(automationRules.id, id))
      .returning();
    await audit(ctx, { action: 'automation.restored', entityType: 'automation_rule', entityId: id });
    await emit(ctx, { type: 'automation_rule.restored', entityType: 'automation_rule', entityId: id, revision: row!.rowVersion });
    return id;
  }
  if (r.archivedAt) return id;
  const cancelled = await cancelPendingRuns(ctx, id, 'RULE_ARCHIVED', 'The rule was archived before this run started.');
  const [row] = await ctx.tx
    .update(automationRules)
    .set({ archivedAt: at, archivedBy: ctx.actor.userId, archiveReason: input.reason ?? null, state: r.state === 'draft' ? 'draft' : 'disabled', nextScheduledAt: null, ...touch(ctx, automationRules) })
    .where(eq(automationRules.id, id))
    .returning();
  await audit(ctx, { action: 'automation.archived', entityType: 'automation_rule', entityId: id, reason: input.reason ?? null, metadata: { cancelledRuns: cancelled } });
  await emit(ctx, { type: 'automation_rule.archived', entityType: 'automation_rule', entityId: id, revision: row!.rowVersion });
  return id;
};

/**
 * Pause a rule that can no longer run safely (owner missing/inactive or lacking rights). Runs
 * that have not started are cancelled; the owner (or, without one, the last editor) is notified.
 */
export const pauseAutomationRule = async (ctx: CommandContext, ruleId: string, state: 'paused_needs_owner' | 'paused_requires_attention', reason: string) => {
  const [r] = await ctx.tx.select().from(automationRules).where(and(eq(automationRules.workspaceId, ctx.actor.workspaceId), eq(automationRules.id, ruleId))).for('update');
  if (!r || r.state === state || r.state === 'disabled' || r.state === 'draft' || r.archivedAt) return false;
  await cancelPendingRuns(ctx, ruleId, state === 'paused_needs_owner' ? 'NEEDS_OWNER' : 'OWNER_ACCESS', reason);
  const [row] = await ctx.tx.update(automationRules).set({ state, pausedReason: reason, ...touch(ctx, automationRules) }).where(eq(automationRules.id, ruleId)).returning();
  await audit(ctx, { action: 'automation.paused', entityType: 'automation_rule', entityId: ruleId, reason, diff: { state: { from: r.state, to: state } } });
  await emit(ctx, { type: 'automation_rule.paused', entityType: 'automation_rule', entityId: ruleId, revision: row!.rowVersion, payload: { state } });
  const [editor] = r.updatedBy
    ? await ctx.tx.select({ id: memberships.id }).from(memberships).innerJoin(users, eq(users.id, memberships.userId)).where(and(eq(memberships.workspaceId, r.workspaceId), eq(memberships.userId, r.updatedBy)))
    : [];
  const recipients = [r.ownerMembershipId, editor?.id].filter((x): x is string => !!x);
  await notify(ctx.tx, {
    workspaceId: r.workspaceId,
    recipientMembershipIds: recipients,
    eventType: 'automation.paused',
    eventKey: `automation.paused:${ruleId}:${row!.rowVersion}`,
    kind: 'general',
    title: state === 'paused_needs_owner' ? `Automation “${r.name}” needs an owner` : `Automation “${r.name}” was paused — requires attention`,
    excerpt: reason,
    entityType: 'automation_rule',
    entityId: ruleId,
    excludeActor: false,
    at: ctx.app.clock.now(),
  });
  return true;
};


/** Owner handover during member deactivation (F12): audited and notified; runs inside that transaction. */
export const reassignAutomationOwner = async (ctx: CommandContext, ruleId: string, from: string, to: string | null) => {
  const [row] = await ctx.tx
    .update(automationRules)
    .set({ ownerMembershipId: to, ...touch(ctx, automationRules) })
    .where(and(eq(automationRules.workspaceId, ctx.actor.workspaceId), eq(automationRules.id, ruleId)))
    .returning();
  if (!row) return;
  await audit(ctx, { action: 'automation.owner_changed', entityType: 'automation_rule', entityId: ruleId, diff: { ownerMembershipId: { from, to } }, metadata: { handover: true } });
  await emit(ctx, { type: 'automation_rule.updated', entityType: 'automation_rule', entityId: ruleId, revision: row.rowVersion });
  if (to) await notifyNewOwner(ctx, row);
};
