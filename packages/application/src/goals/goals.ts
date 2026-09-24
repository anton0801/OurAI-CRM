import { and, desc, eq, ilike, inArray, lt, or, sql, type SQL } from 'drizzle-orm';
import { can, hasAnywhere, listFilter, type ObjectScope } from '@castlane/authorization';
import { resolvePeriod, type GoalTargetType, type MetricValue } from '@castlane/analytics';
import { campaignProjects, campaigns, directions, goalCheckIns, goalRevisions, goals, memberships, projects, socialAccounts, workspaces, type DbOrTx } from '@castlane/database';
import { AppError, clampPageSize, decodeCursor, encodeCursor, isDecimalString, localDate, newId, toBig, type FieldError } from '@castlane/domain';
import type { GoalDetail, GoalRow } from '@castlane/api-contracts';
import { requirePermission } from '../core/access';
import { audit, diffFields } from '../core/audit';
import { all, dbOf, type CommandContext, type QueryContext } from '../core/context';
import { emit } from '../core/events';
import { isActiveMember, loadMemberRefs, refOrUnknown } from '../core/members';
import { METRIC_DEFINITIONS, canUseMetricDefinition, evaluateMetric, type MetricDefinition, type MetricFilters } from '../core/metric-registry';
import { notify } from '../core/notify';
import { assertVersion, findById, lockById, stamp, touch } from '../core/rows';
import { accountLabelOf } from '../automation/records';
import { goalCompleteness, goalCurrentValue, goalProgressOf, type GoalCurrent } from './progress';

/**
 * Goals S53 (§17): a target on a canonical metric (unit fixed by the metric) for a scope and
 * period. Current values come from the semantic layer (`evaluateMetric`) inside the viewer's scope;
 * manual check-ins are labelled Manual. Target/baseline changes append revisions (T118); closing
 * stores the achieved value and completeness without touching metrics.
 */

type GoalRowDb = typeof goals.$inferSelect;
type ScopeType = GoalRowDb['scopeType'];

const fe = (field: string, code: string, message: string): FieldError => ({ field, code, message });
/** numeric columns come back padded ("12.000000"): present canonical decimal strings. */
const decimalOrNull = (v: string | null | undefined) => (v === null || v === undefined ? null : toBig(v).toString());
const invalid = (errors: FieldError[], message = 'Some fields need attention.') => new AppError('VALIDATION_FAILED', message, { fieldErrors: errors });

export const goalMetricDefinition = (metricId: string): MetricDefinition | undefined =>
  METRIC_DEFINITIONS.get(metricId) ?? [...METRIC_DEFINITIONS.values()].find((d) => d.key === metricId);

// ——— Scope ———

const campaignProjectsOf = async (db: DbOrTx, ws: string, campaignIds: string[]) => {
  if (!campaignIds.length) return new Map<string, string[]>();
  const rows = await db.select({ c: campaignProjects.campaignId, p: campaignProjects.projectId }).from(campaignProjects).where(and(eq(campaignProjects.workspaceId, ws), inArray(campaignProjects.campaignId, campaignIds)));
  const out = new Map<string, string[]>();
  for (const r of rows) out.set(r.c, [...(out.get(r.c) ?? []), r.p]);
  return out;
};

/** Authorization objects of a goal (a campaign goal is reachable through any campaign project). */
export const goalScopes = (g: Pick<GoalRowDb, 'id' | 'scopeType' | 'scopeId' | 'ownerMembershipId'>, campaignProjectIds: string[] = []): ObjectScope[] => {
  const base = { objectType: 'goal', objectId: g.id, ownerMembershipId: g.ownerMembershipId, assignedMembershipIds: [g.ownerMembershipId] };
  switch (g.scopeType) {
    case 'workspace':
      return [base];
    case 'direction':
      return [{ ...base, directionId: g.scopeId }];
    case 'project':
      return [{ ...base, projectId: g.scopeId }];
    case 'account':
      return [{ ...base, accountId: g.scopeId }];
    case 'campaign':
      return campaignProjectIds.length ? campaignProjectIds.map((projectId) => ({ ...base, projectId })) : [base];
  }
};

const canGoal = (ctx: QueryContext, permission: string, scopes: ObjectScope[]) => scopes.some((s) => can(ctx.actor.access, permission, s));

/** Visibility in SQL (before pagination): scope grants plus goals the member owns. */
const goalVisibilitySql = (ctx: QueryContext, permission = 'goals.read'): SQL | undefined => {
  const f = listFilter(ctx.actor.access, permission);
  if (f.kind === 'all') return undefined;
  if (f.kind === 'none') return sql`false`;
  const list = (ids: string[]) => sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `);
  const parts: SQL[] = [];
  if (f.projectIds.length) {
    parts.push(sql`(${goals.scopeType} = 'project' AND ${goals.scopeId} IN (${list(f.projectIds)}))`);
    parts.push(sql`(${goals.scopeType} = 'account' AND ${goals.scopeId} IN (SELECT a.id FROM social_accounts a WHERE a.project_id IN (${list(f.projectIds)})))`);
    parts.push(sql`(${goals.scopeType} = 'campaign' AND ${goals.scopeId} IN (SELECT cp.campaign_id FROM campaign_projects cp WHERE cp.project_id IN (${list(f.projectIds)})))`);
  }
  if (f.accountIds.length) parts.push(sql`(${goals.scopeType} = 'account' AND ${goals.scopeId} IN (${list(f.accountIds)}))`);
  const dirGrants = ctx.actor.access.grants.filter((g) => g.permissions.has(permission) && g.scopeType === 'direction' && g.scopeId).map((g) => g.scopeId!);
  if (dirGrants.length) parts.push(sql`(${goals.scopeType} = 'direction' AND ${goals.scopeId} IN (${list(dirGrants)}))`);
  parts.push(eq(goals.ownerMembershipId, ctx.actor.membershipId ?? '00000000-0000-4000-8000-000000000000'));
  return sql`(${sql.join(parts, sql` OR `)})`;
};

const metricFilters = (g: Pick<GoalRowDb, 'scopeType' | 'scopeId'>): MetricFilters => {
  if (!g.scopeId) return {};
  switch (g.scopeType) {
    case 'direction':
      return { directionIds: [g.scopeId] };
    case 'project':
      return { projectIds: [g.scopeId] };
    case 'account':
      return { accountIds: [g.scopeId] };
    case 'campaign':
      return { campaignIds: [g.scopeId] };
    default:
      return {};
  }
};

const workspaceZone = async (db: DbOrTx, ws: string) => (await db.select({ tz: workspaces.timezone }).from(workspaces).where(eq(workspaces.id, ws)))[0]?.tz ?? 'UTC';

// ——— Measurement ———

interface Measurement {
  current: GoalCurrent;
  progress: MetricValue;
  overTarget: boolean;
  completeness: string | null;
  drillDown: { href: string; label: string } | null;
  asOf: Date;
}

const latestManual = async (db: DbOrTx, ws: string, goalIds: string[]) => {
  if (!goalIds.length) return new Map<string, { value: string; source: string | null }>();
  const rows = await db
    .selectDistinctOn([goalCheckIns.goalId], { goalId: goalCheckIns.goalId, value: goalCheckIns.manualValue, source: goalCheckIns.manualSource })
    .from(goalCheckIns)
    .where(and(eq(goalCheckIns.workspaceId, ws), inArray(goalCheckIns.goalId, goalIds), sql`${goalCheckIns.manualValue} IS NOT NULL`))
    .orderBy(goalCheckIns.goalId, desc(goalCheckIns.createdAt));
  return new Map(rows.map((r) => [r.goalId, { value: decimalOrNull(r.value)!, source: r.source }]));
};

/** Evaluate a goal's canonical metric for its period in the viewer's scope (never coerces unknown to 0). */
export const measureGoal = async (ctx: QueryContext, g: GoalRowDb, zone: string, manual: { value: string; source: string | null } | null, asOf?: Date): Promise<Measurement> => {
  const at = asOf ?? (g.closedAt && g.status !== 'active' ? g.closedAt : ctx.app.clock.now());
  const def = goalMetricDefinition(g.metricKey);
  let metric: MetricValue | null = null;
  let drillDown: Measurement['drillDown'] = null;
  if (def && canUseMetricDefinition(ctx, def)) {
    try {
      const period = resolvePeriod('custom', at, zone, { fromDate: g.periodStart, toDate: g.periodEnd });
      const r = await evaluateMetric(ctx, def.id, { period, asOf: at, filters: metricFilters(g) });
      metric = r.total;
      drillDown = r.drillDown ?? null;
    } catch (e) {
      if (!(e instanceof AppError)) throw e;
    }
  }
  const current = goalCurrentValue(metric, manual, g.unit);
  const { progress, overTarget } = goalProgressOf(g.targetType as GoalTargetType, current, g.targetValue, g.baselineValue);
  return { current, progress, overTarget, completeness: goalCompleteness(current.value, current.source), drillDown, asOf: at };
};

// ——— Read models ———

const scopeLabels = async (db: DbOrTx, ws: string, rows: GoalRowDb[]) => {
  const out = new Map<string, string>();
  const ids = (t: ScopeType) => [...new Set(rows.filter((r) => r.scopeType === t && r.scopeId).map((r) => r.scopeId!))];
  const d = ids('direction');
  const p = ids('project');
  const a = ids('account');
  const c = [...new Set([...ids('campaign'), ...rows.flatMap((r) => r.linkedCampaignIds)])];
  if (d.length) for (const r of await db.select({ id: directions.id, name: directions.name }).from(directions).where(and(eq(directions.workspaceId, ws), inArray(directions.id, d)))) out.set(r.id, r.name);
  if (p.length) for (const r of await db.select({ id: projects.id, name: projects.name }).from(projects).where(and(eq(projects.workspaceId, ws), inArray(projects.id, p)))) out.set(r.id, r.name);
  if (a.length)
    for (const r of await db
      .select({ id: socialAccounts.id, handle: socialAccounts.handle, displayName: socialAccounts.displayName, platform: socialAccounts.platform })
      .from(socialAccounts)
      .where(and(eq(socialAccounts.workspaceId, ws), inArray(socialAccounts.id, a))))
      out.set(r.id, accountLabelOf(r));
  if (c.length) for (const r of await db.select({ id: campaigns.id, name: campaigns.name }).from(campaigns).where(and(eq(campaigns.workspaceId, ws), inArray(campaigns.id, c)))) out.set(r.id, r.name);
  return out;
};

export const toGoalRows = async (ctx: QueryContext | CommandContext, rows: GoalRowDb[]): Promise<{ row: GoalRow; measurement: Measurement }[]> => {
  if (!rows.length) return [];
  const db = dbOf(ctx);
  const ws = ctx.actor.workspaceId;
  const [refs, labels, manual, zone] = await all(ctx, [
    () => loadMemberRefs(db, ws, rows.map((r) => r.ownerMembershipId)),
    () => scopeLabels(db, ws, rows),
    () => latestManual(db, ws, rows.map((r) => r.id)),
    () => workspaceZone(db, ws),
  ] as const);
  const out: { row: GoalRow; measurement: Measurement }[] = [];
  for (const g of rows) {
    const m = await measureGoal(ctx, g, zone, manual.get(g.id) ?? null);
    const def = goalMetricDefinition(g.metricKey);
    out.push({
      measurement: m,
      row: {
        id: g.id,
        name: g.name,
        owner: refOrUnknown(refs, g.ownerMembershipId)!,
        scope: { type: g.scopeType, id: g.scopeId, label: g.scopeType === 'workspace' ? 'Whole workspace' : (labels.get(g.scopeId ?? '') ?? 'Unavailable record') },
        metric: { id: g.metricKey, label: def?.label ?? g.metricKey, unit: def?.unit ?? g.unit, available: !!def && canUseMetricDefinition(ctx, def), rate: !!def?.rate },
        targetType: g.targetType,
        targetValue: decimalOrNull(g.targetValue)!,
        unit: g.unit,
        periodStart: g.periodStart,
        periodEnd: g.periodEnd,
        baselineValue: decimalOrNull(g.baselineValue),
        direction: g.direction,
        status: g.status,
        revisionNo: g.revisionNo,
        current: { value: m.current.value, source: m.current.source, asOf: m.asOf.toISOString(), manualSource: m.current.manualSource },
        progress: m.progress,
        overTarget: m.overTarget,
        completeness: g.status === 'closed' || (g.status === 'archived' && g.closedAt) ? g.completeness : m.completeness,
        closedAt: g.closedAt?.toISOString() ?? null,
        achievedValue: decimalOrNull(g.achievedValue),
        assessment: g.assessment,
        linkedCampaigns: g.linkedCampaignIds.map((id) => ({ id, name: labels.get(id) ?? 'Unavailable campaign' })),
        archivedAt: g.archivedAt?.toISOString() ?? null,
        updatedAt: g.updatedAt.toISOString(),
        rowVersion: g.rowVersion,
      },
    });
  }
  return out;
};

const readGoal = async (ctx: QueryContext | CommandContext, id: string) => {
  const g = await findById(ctx, goals, id, 'Goal');
  const cp = g.scopeType === 'campaign' && g.scopeId ? ((await campaignProjectsOf(dbOf(ctx), ctx.actor.workspaceId, [g.scopeId])).get(g.scopeId) ?? []) : [];
  const scopes = goalScopes(g, cp);
  if (!canGoal(ctx, 'goals.read', scopes) && !(g.ownerMembershipId === ctx.actor.membershipId && hasAnywhere(ctx.actor.access, 'goals.read'))) throw new AppError('NOT_FOUND', 'Goal was not found.');
  return { g, scopes };
};

const canWriteGoal = (ctx: QueryContext, g: GoalRowDb, scopes: ObjectScope[]) =>
  canGoal(ctx, 'goals.write', scopes) || (g.ownerMembershipId === ctx.actor.membershipId && hasAnywhere(ctx.actor.access, 'goals.write'));

export const listGoals = async (
  ctx: QueryContext,
  input: { cursor?: string; pageSize?: number; q?: string; status?: GoalRowDb['status'][]; ownerMembershipId?: string; projectId?: string; scopeType?: ScopeType; metricId?: string; includeArchived?: boolean },
) => {
  requirePermission(ctx, 'goals.read');
  const size = clampPageSize(input.pageSize ?? 25);
  const c = input.cursor ? decodeCursor(input.cursor) : null;
  const q = input.q?.trim();
  const statuses = input.status?.length ? input.status : input.includeArchived ? undefined : (['active', 'closed'] as GoalRowDb['status'][]);
  const rows = await dbOf(ctx)
    .select()
    .from(goals)
    .where(
      and(
        eq(goals.workspaceId, ctx.actor.workspaceId),
        goalVisibilitySql(ctx),
        statuses ? inArray(goals.status, statuses) : undefined,
        input.ownerMembershipId ? eq(goals.ownerMembershipId, input.ownerMembershipId) : undefined,
        input.scopeType ? eq(goals.scopeType, input.scopeType) : undefined,
        input.metricId ? eq(goals.metricKey, input.metricId) : undefined,
        input.projectId
          ? or(
              and(eq(goals.scopeType, 'project'), eq(goals.scopeId, input.projectId)),
              sql`(${goals.scopeType} = 'account' AND ${goals.scopeId} IN (SELECT a.id FROM social_accounts a WHERE a.project_id = ${input.projectId}))`,
              sql`(${goals.scopeType} = 'campaign' AND ${goals.scopeId} IN (SELECT cp.campaign_id FROM campaign_projects cp WHERE cp.project_id = ${input.projectId}))`,
            )
          : undefined,
        q ? ilike(goals.name, `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`) : undefined,
        c ? or(lt(goals.updatedAt, new Date(String(c.v[0]))), and(eq(goals.updatedAt, new Date(String(c.v[0]))), lt(goals.id, c.id))) : undefined,
      ),
    )
    .orderBy(desc(goals.updatedAt), desc(goals.id))
    .limit(size + 1);
  const hasMore = rows.length > size;
  const page = hasMore ? rows.slice(0, size) : rows;
  const last = page[page.length - 1];
  return { items: (await toGoalRows(ctx, page)).map((x) => x.row), hasMore, nextCursor: hasMore && last ? encodeCursor({ v: [last.updatedAt.toISOString()], id: last.id }) : null };
};

interface RevisionSnapshot {
  targetType: GoalRowDb['targetType'];
  targetValue: string;
  baselineValue: string | null;
  periodStart: string;
  periodEnd: string;
  unit: string;
  metricId: string;
  direction: GoalRowDb['direction'];
  effectiveFrom: string;
}

export const getGoal = async (ctx: QueryContext | CommandContext, id: string): Promise<GoalDetail> => {
  const { g, scopes } = await readGoal(ctx, id);
  const db = dbOf(ctx);
  const ws = ctx.actor.workspaceId;
  const [{ row, measurement }] = (await toGoalRows(ctx, [g])) as [{ row: GoalRow; measurement: Measurement }];
  const [revs, checkIns, zone] = await all(ctx, [
    () => db.select().from(goalRevisions).where(and(eq(goalRevisions.workspaceId, ws), eq(goalRevisions.goalId, id))).orderBy(desc(goalRevisions.revisionNo)),
    () => db.select().from(goalCheckIns).where(and(eq(goalCheckIns.workspaceId, ws), eq(goalCheckIns.goalId, id))).orderBy(desc(goalCheckIns.createdAt)).limit(100),
    () => workspaceZone(db, ws),
  ] as const);
  const creators = [...new Set(revs.map((r) => r.createdBy).filter((x): x is string => !!x))];
  const um = creators.length ? await db.select({ userId: memberships.userId, id: memberships.id }).from(memberships).where(and(eq(memberships.workspaceId, ws), inArray(memberships.userId, creators))) : [];
  const userMember = new Map(um.map((m) => [m.userId, m.id]));
  const refs = await loadMemberRefs(db, ws, [...userMember.values(), ...checkIns.map((c) => c.membershipId)]);
  const writable = canWriteGoal(ctx, g, scopes);
  const active = g.status === 'active';
  return {
    ...row,
    revisions: revs.map((r) => {
      const s = r.snapshot as unknown as RevisionSnapshot;
      return {
        revisionNo: r.revisionNo,
        targetType: s.targetType,
        targetValue: decimalOrNull(s.targetValue)!,
        baselineValue: decimalOrNull(s.baselineValue),
        periodStart: s.periodStart,
        periodEnd: s.periodEnd,
        effectiveFrom: s.effectiveFrom,
        reason: r.reason,
        createdAt: r.createdAt.toISOString(),
        createdBy: r.createdBy && userMember.get(r.createdBy) ? refOrUnknown(refs, userMember.get(r.createdBy)) : null,
      };
    }),
    checkIns: checkIns.map((c) => ({
      id: c.id,
      member: refOrUnknown(refs, c.membershipId)!,
      note: c.note,
      manualValue: decimalOrNull(c.manualValue),
      manualSource: c.manualSource,
      measuredValue: decimalOrNull(c.measuredValue),
      createdAt: c.createdAt.toISOString(),
    })),
    sources: measurement.drillDown,
    periodStarted: localDate(ctx.app.clock.now(), zone) >= g.periodStart,
    permissions: { edit: writable && active && !g.archivedAt, checkIn: writable && active && !g.archivedAt, close: writable && active && !g.archivedAt, archive: writable },
  };
};

export const goalMetricOptions = (ctx: QueryContext) => {
  requirePermission(ctx, 'goals.read');
  return [...METRIC_DEFINITIONS.values()]
    .filter((d) => canUseMetricDefinition(ctx, d))
    .sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }))
    .map((d) => ({ id: d.id, label: d.label, description: d.description, unit: d.unit, rate: !!d.rate, higherIsBetter: d.higherIsBetter ?? null, measuresChange: !!d.measuresChange }));
};

// ——— Commands ———

export interface GoalInput {
  name?: string;
  ownerMembershipId?: string;
  scopeType?: ScopeType;
  scopeId?: string | null;
  metricId?: string;
  targetType?: GoalRowDb['targetType'];
  targetValue?: string;
  baselineValue?: string | null;
  periodStart?: string;
  periodEnd?: string;
  direction?: GoalRowDb['direction'];
  linkedCampaignIds?: string[];
  reason?: string;
}

const scopeExists = async (db: DbOrTx, ws: string, t: ScopeType, id: string | null): Promise<boolean> => {
  if (t === 'workspace') return !id;
  if (!id) return false;
  const table = t === 'direction' ? directions : t === 'project' ? projects : t === 'account' ? socialAccounts : campaigns;
  const [r] = await db.select({ id: table.id }).from(table).where(and(eq(table.workspaceId, ws), eq(table.id, id)));
  return !!r;
};

/** Business rules of a goal draft (shared by create and edit). */
const validateGoal = async (ctx: CommandContext, v: Required<Omit<GoalInput, 'reason' | 'name' | 'linkedCampaignIds' | 'direction' | 'baselineValue' | 'scopeId'>> & Pick<GoalInput, 'baselineValue' | 'scopeId' | 'linkedCampaignIds'>) => {
  const errors: FieldError[] = [];
  const def = goalMetricDefinition(v.metricId);
  if (!def || !canUseMetricDefinition(ctx, def)) errors.push(fe('metricId', 'UNAVAILABLE', 'Choose a metric you can measure.'));
  if (!isDecimalString(v.targetValue)) errors.push(fe('targetValue', 'INVALID', 'Enter a number.'));
  // A change metric already subtracts the start of the period; a baseline would subtract it twice.
  if (def?.measuresChange && v.targetType !== 'absolute')
    errors.push(fe('targetType', 'CHANGE_METRIC', `${def.label} already measures a change within the period. Use an Absolute target (e.g. 3,000 for “+3,000”).`));
  if ((v.targetType === 'increase_by' || v.targetType === 'decrease_to') && (v.baselineValue === null || v.baselineValue === undefined))
    errors.push(fe('baselineValue', 'REQUIRED', 'A baseline is required for Increase By and Decrease To.'));
  if (v.periodEnd < v.periodStart) errors.push(fe('periodEnd', 'BEFORE_START', 'Choose an end on or after the start.'));
  if (v.scopeType !== 'workspace' && !v.scopeId) errors.push(fe('scopeId', 'REQUIRED', 'Choose the scope record.'));
  else if (!(await scopeExists(ctx.tx, ctx.actor.workspaceId, v.scopeType, v.scopeType === 'workspace' ? null : (v.scopeId ?? null)))) errors.push(fe('scopeId', 'NOT_FOUND', 'The scope record was not found.'));
  if (!(await isActiveMember(ctx.tx, ctx.actor.workspaceId, v.ownerMembershipId))) errors.push(fe('ownerMembershipId', 'INACTIVE', 'The owner must be an active member.'));
  const linked = [...new Set(v.linkedCampaignIds ?? [])];
  if (linked.length) {
    const found = await ctx.tx.select({ id: campaigns.id }).from(campaigns).where(and(eq(campaigns.workspaceId, ctx.actor.workspaceId), inArray(campaigns.id, linked)));
    if (found.length !== linked.length) errors.push(fe('linkedCampaignIds', 'NOT_FOUND', 'A linked campaign was not found.'));
  }
  if (errors.length) throw invalid(errors);
  return def!;
};

const snapshotOf = (g: Pick<GoalRowDb, 'targetType' | 'targetValue' | 'baselineValue' | 'periodStart' | 'periodEnd' | 'unit' | 'metricKey' | 'direction'>, effectiveFrom: string): RevisionSnapshot => ({
  targetType: g.targetType,
  targetValue: decimalOrNull(g.targetValue)!,
  baselineValue: decimalOrNull(g.baselineValue),
  periodStart: g.periodStart,
  periodEnd: g.periodEnd,
  unit: g.unit,
  metricId: g.metricKey,
  direction: g.direction,
  effectiveFrom,
});

const directionFor = (t: GoalRowDb['targetType'], requested?: GoalRowDb['direction']): GoalRowDb['direction'] => (t === 'decrease_to' ? 'decrease' : t === 'increase_by' ? 'increase' : (requested ?? 'increase'));



export const createGoal = async (ctx: CommandContext, input: GoalInput & { name: string; ownerMembershipId: string; scopeType: ScopeType; metricId: string; targetType: GoalRowDb['targetType']; targetValue: string; periodStart: string; periodEnd: string }) => {
  requirePermission(ctx, 'goals.write');
  const id = newId();
  const scopeId = input.scopeType === 'workspace' ? null : (input.scopeId ?? null);
  const cp = input.scopeType === 'campaign' && scopeId ? ((await campaignProjectsOf(ctx.tx, ctx.actor.workspaceId, [scopeId])).get(scopeId) ?? []) : [];
  if (!canGoal(ctx, 'goals.write', goalScopes({ id, scopeType: input.scopeType, scopeId, ownerMembershipId: input.ownerMembershipId }, cp)))
    throw new AppError('FORBIDDEN', 'You cannot create goals in this scope.');
  const def = await validateGoal(ctx, { ...input, scopeId });
  const zone = await workspaceZone(ctx.tx, ctx.actor.workspaceId);
  const [row] = await ctx.tx
    .insert(goals)
    .values({
      ...stamp(ctx),
      id,
      name: input.name.trim(),
      ownerMembershipId: input.ownerMembershipId,
      scopeType: input.scopeType,
      scopeId,
      metricKey: def.id,
      targetType: input.targetType,
      targetValue: toBig(input.targetValue).toString(),
      // The unit is fixed by the metric definition, never chosen freely.
      unit: def.unit,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      baselineValue: decimalOrNull(input.baselineValue),
      direction: directionFor(input.targetType, input.direction),
      linkedCampaignIds: [...new Set(input.linkedCampaignIds ?? [])],
      status: 'active',
      revisionNo: 1,
    })
    .returning();
  const today = localDate(ctx.app.clock.now(), zone);
  await ctx.tx.insert(goalRevisions).values({ ...stamp(ctx), id: newId(), goalId: id, revisionNo: 1, snapshot: snapshotOf(row!, today > input.periodStart ? today : input.periodStart) as never, reason: null });
  await audit(ctx, {
    action: 'goal.created',
    entityType: 'goal',
    entityId: id,
    projectId: input.scopeType === 'project' ? scopeId : null,
    diff: diffFields(null, row!, ['name', 'ownerMembershipId', 'scopeType', 'scopeId', 'metricKey', 'targetType', 'targetValue', 'unit', 'periodStart', 'periodEnd', 'baselineValue']),
  });
  await emit(ctx, { type: 'goal.created', entityType: 'goal', entityId: id, revision: 1 });
  if (row!.ownerMembershipId !== ctx.actor.membershipId)
    await notify(ctx.tx, {
      workspaceId: ctx.actor.workspaceId,
      recipientMembershipIds: [row!.ownerMembershipId],
      eventType: 'goal.owner_assigned',
      eventKey: `goal.owner_assigned:${id}:${row!.ownerMembershipId}:1`,
      kind: 'assignment',
      title: `You own the goal “${row!.name}”`,
      entityType: 'goal',
      entityId: id,
      projectId: input.scopeType === 'project' ? scopeId : null,
      actorMembershipId: ctx.actor.membershipId,
      at: ctx.app.clock.now(),
    });
  return id;
};

const lockGoalForWrite = async (ctx: CommandContext, id: string) => {
  const g = await lockById(ctx, goals, id, 'Goal');
  const cp = g.scopeType === 'campaign' && g.scopeId ? ((await campaignProjectsOf(ctx.tx, ctx.actor.workspaceId, [g.scopeId])).get(g.scopeId) ?? []) : [];
  const scopes = goalScopes(g, cp);
  if (!canWriteGoal(ctx, g, scopes)) {
    if (canGoal(ctx, 'goals.read', scopes) || g.ownerMembershipId === ctx.actor.membershipId) throw new AppError('FORBIDDEN', 'You cannot change this goal.');
    throw new AppError('NOT_FOUND', 'Goal was not found.');
  }
  return g;
};

const TARGET_FIELDS = ['targetType', 'targetValue', 'baselineValue', 'periodStart', 'periodEnd'] as const;

/**
 * Edit a goal. Target, baseline, type or period changes append a revision with the date they take
 * effect: after the period started the change needs a reason and applies from today (T118);
 * before, it applies from the period start. The metric (and its unit) is fixed once the period started.
 */
export const updateGoal = async (ctx: CommandContext, id: string, input: GoalInput) => {
  const g = await lockGoalForWrite(ctx, id);
  assertVersion(ctx, g);
  if (g.status !== 'active' || g.archivedAt) throw new AppError('INVALID_STATE', 'Only active goals can be edited.');
  const zone = await workspaceZone(ctx.tx, ctx.actor.workspaceId);
  const today = localDate(ctx.app.clock.now(), zone);
  const started = today >= g.periodStart;
  const scopeType = input.scopeType ?? g.scopeType;
  const scopeId = scopeType === 'workspace' ? null : input.scopeId !== undefined ? input.scopeId : g.scopeId;
  const next = {
    ownerMembershipId: input.ownerMembershipId ?? g.ownerMembershipId,
    scopeType,
    scopeId,
    metricId: input.metricId ?? g.metricKey,
    targetType: input.targetType ?? g.targetType,
    targetValue: input.targetValue ?? g.targetValue,
    baselineValue: input.baselineValue !== undefined ? input.baselineValue : g.baselineValue,
    periodStart: input.periodStart ?? g.periodStart,
    periodEnd: input.periodEnd ?? g.periodEnd,
    linkedCampaignIds: input.linkedCampaignIds ?? g.linkedCampaignIds,
  };
  if (started && next.metricId !== g.metricKey) throw invalid([fe('metricId', 'LOCKED', 'The metric cannot change after the period started. Close this goal and create a new one.')]);
  if (scopeType !== g.scopeType || scopeId !== g.scopeId) {
    const cp = scopeType === 'campaign' && scopeId ? ((await campaignProjectsOf(ctx.tx, ctx.actor.workspaceId, [scopeId])).get(scopeId) ?? []) : [];
    if (!canGoal(ctx, 'goals.write', goalScopes({ id, scopeType, scopeId, ownerMembershipId: next.ownerMembershipId }, cp))) throw new AppError('FORBIDDEN', 'You cannot move goals into this scope.');
  }
  const def = await validateGoal(ctx, next);
  const normalized = { targetType: next.targetType, targetValue: toBig(next.targetValue).toString(), baselineValue: decimalOrNull(next.baselineValue), periodStart: next.periodStart, periodEnd: next.periodEnd };
  const targetChanged = TARGET_FIELDS.some((k) => {
    const a = g[k];
    const b = normalized[k];
    if (k === 'targetValue' || k === 'baselineValue') return a === null || b === null ? a !== b : toBig(a as string).cmp(toBig(b as string)) !== 0;
    return a !== b;
  });
  if (targetChanged && started && !input.reason?.trim()) throw invalid([fe('reason', 'REQUIRED', 'The period already started: explain why the target changes. The previous target stays in the history.')]);
  if (targetChanged && started && (input.reason?.trim().length ?? 0) < 3) throw invalid([fe('reason', 'TOO_SHORT', 'Use at least 3 characters.')]);
  const patch: Partial<GoalRowDb> = {
    name: input.name?.trim() ?? g.name,
    ownerMembershipId: next.ownerMembershipId,
    scopeType,
    scopeId,
    metricKey: def.id,
    unit: def.unit,
    ...normalized,
    direction: directionFor(next.targetType, input.direction ?? g.direction),
    linkedCampaignIds: [...new Set(next.linkedCampaignIds)],
  };
  if (targetChanged) patch.revisionNo = g.revisionNo + 1;
  const [row] = await ctx.tx.update(goals).set({ ...patch, ...touch(ctx, goals) }).where(eq(goals.id, id)).returning();
  if (targetChanged)
    await ctx.tx.insert(goalRevisions).values({
      ...stamp(ctx),
      id: newId(),
      goalId: id,
      revisionNo: row!.revisionNo,
      snapshot: snapshotOf(row!, started ? (today > row!.periodStart ? today : row!.periodStart) : row!.periodStart) as never,
      reason: input.reason?.trim() || null,
    });
  await audit(ctx, {
    action: targetChanged ? 'goal.target_revised' : 'goal.updated',
    entityType: 'goal',
    entityId: id,
    projectId: scopeType === 'project' ? scopeId : null,
    reason: input.reason?.trim() || null,
    diff: diffFields(g, row!, ['name', 'ownerMembershipId', 'scopeType', 'scopeId', 'metricKey', 'targetType', 'targetValue', 'baselineValue', 'periodStart', 'periodEnd', 'linkedCampaignIds']),
  });
  await emit(ctx, { type: targetChanged ? 'goal.target_revised' : 'goal.updated', entityType: 'goal', entityId: id, revision: row!.rowVersion });
  return id;
};

/** Append-only check-in: a note plus an optional manual value with its source (labelled Manual). */
export const checkInGoal = async (ctx: CommandContext, id: string, input: { note: string; manualValue?: string | null; manualSource?: string | null }) => {
  const g = await lockGoalForWrite(ctx, id);
  if (g.status !== 'active' || g.archivedAt) throw new AppError('INVALID_STATE', 'Check-ins are recorded on active goals only.');
  if (input.manualValue != null && !input.manualSource?.trim()) throw invalid([fe('manualSource', 'REQUIRED', 'Describe the source of the manual value.')]);
  const zone = await workspaceZone(ctx.tx, ctx.actor.workspaceId);
  const m = await measureGoal(ctx, g, zone, null);
  const measured = m.current.source === 'metric' ? m.current.value.value : null;
  await ctx.tx.insert(goalCheckIns).values({
    ...stamp(ctx),
    id: newId(),
    goalId: id,
    membershipId: ctx.actor.membershipId!,
    note: input.note.trim(),
    manualValue: input.manualValue == null ? null : toBig(input.manualValue).toString(),
    manualSource: input.manualValue == null ? null : input.manualSource!.trim(),
    measuredValue: measured,
  });
  await ctx.tx.update(goals).set({ ...touch(ctx, goals) }).where(eq(goals.id, id));
  await audit(ctx, { action: 'goal.checked_in', entityType: 'goal', entityId: id, projectId: g.scopeType === 'project' ? g.scopeId : null, metadata: { manual: input.manualValue != null } });
  await emit(ctx, { type: 'goal.checked_in', entityType: 'goal', entityId: id });
  return id;
};

/** Close with an assessment: achieved value and completeness are stored; metrics are not changed. */
export const closeGoal = async (ctx: CommandContext, id: string, input: { assessment: string; effectiveAt?: string }) => {
  const g = await lockGoalForWrite(ctx, id);
  assertVersion(ctx, g);
  if (g.status !== 'active' || g.archivedAt) throw new AppError('INVALID_STATE', 'Only active goals can be closed.');
  const now = ctx.app.clock.now();
  const at = input.effectiveAt ? new Date(input.effectiveAt) : now;
  const zone = await workspaceZone(ctx.tx, ctx.actor.workspaceId);
  if (at.getTime() > now.getTime()) throw invalid([fe('effectiveAt', 'FUTURE', 'Choose a moment that is not in the future.')]);
  if (localDate(at, zone) < g.periodStart) throw invalid([fe('effectiveAt', 'BEFORE_PERIOD', 'Choose a moment inside or after the goal period.')]);
  const manual = (await latestManual(ctx.tx, ctx.actor.workspaceId, [id])).get(id) ?? null;
  const m = await measureGoal(ctx, g, zone, manual, at);
  const [row] = await ctx.tx
    .update(goals)
    .set({ status: 'closed', closedAt: at, achievedValue: m.current.value.value, completeness: m.completeness, assessment: input.assessment.trim(), ...touch(ctx, goals) })
    .where(eq(goals.id, id))
    .returning();
  await audit(ctx, {
    action: 'goal.closed',
    entityType: 'goal',
    entityId: id,
    projectId: g.scopeType === 'project' ? g.scopeId : null,
    reason: input.assessment.trim(),
    metadata: { achievedValue: row!.achievedValue, source: m.current.source, completeness: row!.completeness, progress: m.progress.value, progressStatus: m.progress.status },
  });
  await emit(ctx, { type: 'goal.closed', entityType: 'goal', entityId: id, revision: row!.rowVersion });
  return id;
};

export const archiveGoal = async (ctx: CommandContext, id: string, input: { restore?: boolean; reason?: string }, opts: { skipVersion?: boolean } = {}) => {
  const g = await lockGoalForWrite(ctx, id);
  if (!opts.skipVersion) assertVersion(ctx, g);
  if (input.restore) {
    if (!g.archivedAt) return id;
    const [row] = await ctx.tx
      .update(goals)
      .set({ archivedAt: null, archivedBy: null, archiveReason: null, status: g.closedAt ? 'closed' : 'active', ...touch(ctx, goals) })
      .where(eq(goals.id, id))
      .returning();
    await audit(ctx, { action: 'goal.restored', entityType: 'goal', entityId: id, projectId: g.scopeType === 'project' ? g.scopeId : null });
    await emit(ctx, { type: 'goal.restored', entityType: 'goal', entityId: id, revision: row!.rowVersion });
    return id;
  }
  if (g.archivedAt) return id;
  const [row] = await ctx.tx
    .update(goals)
    .set({ archivedAt: ctx.app.clock.now(), archivedBy: ctx.actor.userId, archiveReason: input.reason ?? null, status: 'archived', ...touch(ctx, goals) })
    .where(eq(goals.id, id))
    .returning();
  await audit(ctx, { action: 'goal.archived', entityType: 'goal', entityId: id, projectId: g.scopeType === 'project' ? g.scopeId : null, reason: input.reason ?? null });
  await emit(ctx, { type: 'goal.archived', entityType: 'goal', entityId: id, revision: row!.rowVersion });
  return id;
};

export { goalVisibilitySql, canGoal, campaignProjectsOf as goalCampaignProjects };
