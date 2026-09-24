import { and, eq, inArray, max, sql } from 'drizzle-orm';
import { hasAnywhere } from '@castlane/authorization';
import { buckets, compareValues, groupRecords, hasValue, type MetricValue, type TimeGrain } from '@castlane/analytics';
import {
  budgets,
  compensationRuns,
  contentItems,
  financialEntries,
  handovers,
  metricCheckpoints,
  metricObservations,
  qualityReviews,
  saleCandidates,
  settlements,
  shifts,
  tasks,
  timeEntries,
} from '@castlane/database';
import { ENTITY_ROUTES, type AnalyticsChart, type AnalyticsDashboard, type AnalyticsKpi, type AnalyticsTable, type DrillDownResult } from '@castlane/api-contracts';
import { ANALYTICS_TABS, AppError, forbidden, type EnumValue, type PERIOD_PRESETS } from '@castlane/domain';
import { allowed, scopePredicate } from '../core/access';
import { dbOf, type QueryContext } from '../core/context';
import { loadMemberRefs } from '../core/members';
import { iso, loadAccounts, loadPublications, periodDto, plainDecimal, projectDirections, resolveInsightPeriod, type Ctx, type InsightFilters, type ResolvedInsightPeriod } from './common';
import { loadCheckpointData, erOne, interactionsOf } from './semantic/content';
import {
  INSIGHT_METRICS,
  canUseMetric,
  computeInsight,
  dimensionLabels,
  dimensionValue,
  emptyValueFor,
  insightMetric,
  type DimKey,
  type InsightMetric,
  type InsightQuery,
} from './semantic/registry';

type Tab = EnumValue<typeof ANALYTICS_TABS>;
type Preset = EnumValue<typeof PERIOD_PRESETS>;

export interface DashboardInput {
  preset: Preset;
  from?: string;
  to?: string;
  compare?: boolean;
  directionId?: string;
  projectIds?: string[];
  accountIds?: string[];
  platforms?: string[];
  formats?: string[];
  memberIds?: string[];
  grain?: TimeGrain;
  chartMetric?: string;
}

export const TAB_PERMISSIONS: Record<Tab, { permission: string; requires?: string[] }> = {
  production: { permission: 'analytics.production.read' },
  accounts: { permission: 'analytics.accounts.read' },
  content: { permission: 'analytics.content.read' },
  ofm: { permission: 'analytics.ofm.read' },
  team: { permission: 'analytics.team.read' },
  finance: { permission: 'analytics.finance.read', requires: ['finance.read'] },
};

export const availableTabs = (ctx: Ctx): Tab[] =>
  ANALYTICS_TABS.filter((t) => hasAnywhere(ctx.actor.access, TAB_PERMISSIONS[t].permission) && (TAB_PERMISSIONS[t].requires ?? []).every((p) => hasAnywhere(ctx.actor.access, p)));

const GRAIN_ORDER: TimeGrain[] = ['day', 'week', 'month', 'quarter'];
const defaultGrain = (r: ResolvedInsightPeriod): TimeGrain => {
  const days = (r.period.end.getTime() - r.period.start.getTime()) / 86_400_000;
  return days <= 31 ? 'day' : days <= 190 ? 'week' : 'month';
};
const grainFor = (d: InsightMetric, g: TimeGrain): TimeGrain | null => {
  if (!d.grains.length) return null;
  if (d.grains.includes(g)) return g;
  return d.grains.find((x) => GRAIN_ORDER.indexOf(x) > GRAIN_ORDER.indexOf(g)) ?? d.grains[d.grains.length - 1]!;
};

export const toMetricFilters = (i: { directionId?: string; projectIds?: string[]; accountIds?: string[]; platforms?: string[]; formats?: string[]; memberIds?: string[]; statuses?: string[] }): InsightFilters => ({
  directionIds: i.directionId ? [i.directionId] : undefined,
  projectIds: i.projectIds?.length ? i.projectIds : undefined,
  accountIds: i.accountIds?.length ? i.accountIds : undefined,
  platforms: i.platforms?.length ? i.platforms : undefined,
  formats: i.formats?.length ? i.formats : undefined,
  memberIds: i.memberIds?.length ? i.memberIds : undefined,
  statuses: i.statuses?.length ? i.statuses : undefined,
});

const metricOk = (ctx: Ctx, id: string) => {
  const d = INSIGHT_METRICS.get(id);
  return d && canUseMetric(ctx, d) ? d : null;
};

const kpiOf = async (ctx: Ctx, id: string, cur: InsightQuery, prev: InsightQuery | null): Promise<AnalyticsKpi | null> => {
  const d = metricOk(ctx, id);
  if (!d) return null;
  const [c, p] = await Promise.all([computeInsight(ctx, d, cur), prev ? computeInsight(ctx, d, prev) : Promise.resolve(null)]);
  return {
    metricId: d.id,
    label: d.label,
    description: d.description,
    unit: d.unit,
    rate: !!d.rate,
    higherIsBetter: d.higherIsBetter ?? null,
    value: c.total,
    previous: p ? p.total : null,
    delta: p ? compareValues(c.total, p.total, { rate: !!d.rate }) : null,
    sourceAsOf: c.sourceAsOf ?? null,
    drillable: !!d.drill,
  };
};

/** Line chart over time; buckets without data stay gaps (no interpolation, §17). */
const timeChart = async (ctx: Ctx, key: string, title: string, description: string, ids: string[], q: InsightQuery, grain: TimeGrain): Promise<AnalyticsChart | null> => {
  const defs = ids.map((id) => metricOk(ctx, id)).filter((d): d is InsightMetric => !!d && d.grains.length > 0);
  if (!defs.length) return null;
  const g = defs.map((d) => grainFor(d, grain)!).reduce((a, b) => (GRAIN_ORDER.indexOf(b) > GRAIN_ORDER.indexOf(a) ? b : a));
  const results = await Promise.all(defs.map((d) => computeInsight(ctx, d, { ...q, grain: g })));
  const xs = buckets(q.period, g).map((b) => b.key);
  return {
    key,
    title,
    description,
    kind: 'line',
    unit: defs[0]!.unit,
    xKind: 'time',
    series: defs.map((d) => ({ key: d.id, label: d.label, metricId: d.id })),
    points: xs.map((x) => ({ x, label: x, values: Object.fromEntries(defs.map((d, i) => [d.id, results[i]!.series?.find((s) => s.bucket === x)?.value ?? emptyValueFor(d)])) })),
    note: g !== grain ? `Shown by ${g}.` : null,
  };
};

const numeric = (v: MetricValue) => (hasValue(v) ? Number(v.value) : Number.NEGATIVE_INFINITY);

/** Category bar chart of one metric by a dimension; the tail folds into Other only for additive metrics. */
const categoryChart = async (ctx: Ctx, key: string, title: string, description: string, id: string, dim: DimKey, q: InsightQuery, top = 10): Promise<AnalyticsChart | null> => {
  const d = metricOk(ctx, id);
  if (!d || !d.dimensions.includes(dim)) return null;
  const r = await computeInsight(ctx, d, { ...q, groupBy: dim });
  const groups = [...(r.groups ?? [])].sort((a, b) => numeric(b.value) - numeric(a.value));
  let shown = groups.slice(0, top);
  const rest = groups.slice(top);
  let note: string | null = null;
  if (rest.length) {
    if (d.additive) {
      const sum = rest.filter((x) => hasValue(x.value)).reduce((a, x) => a + Number(x.value.value), 0);
      shown = [...shown, { key: '__other', label: `Other (${rest.length})`, value: { status: 'known', value: String(sum), unit: d.unit } }];
    } else note = `Showing the top ${top} of ${groups.length}; ${d.label} cannot be added up, so the rest is listed in the table only.`;
  }
  return {
    key,
    title,
    description,
    kind: 'bar',
    unit: d.unit,
    xKind: 'category',
    series: [{ key: d.id, label: d.label, metricId: d.id }],
    points: shown.map((g) => ({ x: g.key || '__none', label: g.label, values: { [d.id]: g.value } })),
    note,
  };
};

const DIM_HREF: Partial<Record<DimKey, (id: string) => string>> = {
  project: (id) => `/projects/${id}`,
  account: (id) => `/accounts/${id}`,
  member: (id) => `/team/${id}`,
  publication: (id) => `/publications/${id}`,
  campaign: (id) => `/campaigns/${id}`,
};

/** Breakdown table: one row per dimension value, one column per metric (facts reduced per metric first). */
const breakdownTable = async (ctx: Ctx, key: string, title: string, description: string | null, dim: DimKey, ids: string[], q: InsightQuery, nameLabel: string, limit = 50): Promise<AnalyticsTable | null> => {
  const defs = ids.map((id) => metricOk(ctx, id)).filter((d): d is InsightMetric => !!d && d.dimensions.includes(dim));
  if (!defs.length) return null;
  const results = await Promise.all(defs.map((d) => computeInsight(ctx, d, { ...q, groupBy: dim })));
  const rows = new Map<string, { label: string; values: Record<string, MetricValue> }>();
  results.forEach((r, i) => {
    for (const g of r.groups ?? []) {
      const row = rows.get(g.key) ?? { label: g.label, values: {} };
      row.values[defs[i]!.id] = g.value;
      rows.set(g.key, row);
    }
  });
  const sorted = [...rows.entries()].sort((a, b) => numeric(b[1].values[defs[0]!.id] ?? emptyValueFor(defs[0]!)) - numeric(a[1].values[defs[0]!.id] ?? emptyValueFor(defs[0]!)));
  return {
    key,
    title,
    description,
    columns: [{ key: 'name', label: nameLabel, kind: 'text' }, ...defs.map((d) => ({ key: d.id, label: d.label, kind: 'metric' as const, metricId: d.id }))],
    rows: sorted.slice(0, limit).map(([k, r]) => ({
      key: k || '__none',
      href: k && DIM_HREF[dim] ? DIM_HREF[dim]!(k) : null,
      cells: { name: { text: r.label }, ...Object.fromEntries(defs.map((d) => [d.id, { value: r.values[d.id] ?? emptyValueFor(d) }])) },
    })),
    note: sorted.length > limit ? `Showing ${limit} of ${sorted.length}.` : null,
  };
};

// ——— Tab-specific tables ———

const stageAgingTable = async (ctx: Ctx, q: InsightQuery): Promise<AnalyticsTable | null> => {
  if (!metricOk(ctx, 'M03')) return null;
  const c = contentItems;
  const rows = await dbOf(ctx).execute<{ stage: string; n: string; median_days: string | null; oldest_days: string | null; blocked: string }>(sql`
    SELECT c.stage, count(*)::text AS n,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (${ctx.app.clock.now()}::timestamptz - coalesce(ev.entered, c.updated_at))) / 86400)::numeric(10,1)::text AS median_days,
      max(extract(epoch FROM (${ctx.app.clock.now()}::timestamptz - coalesce(ev.entered, c.updated_at))) / 86400)::numeric(10,1)::text AS oldest_days,
      count(*) FILTER (WHERE c.blocked_at IS NOT NULL)::text AS blocked
    FROM content_items c
    LEFT JOIN LATERAL (SELECT max(e.occurred_at) AS entered FROM content_stage_events e WHERE e.workspace_id = c.workspace_id AND e.content_item_id = c.id AND e.to_stage = c.stage) ev ON true
    WHERE c.workspace_id = ${ctx.actor.workspaceId} AND c.deleted_at IS NULL AND c.archived_at IS NULL AND c.stage IN ('ready', 'production', 'review', 'changes_requested')
      ${(() => {
        const s = scopePredicate(ctx, 'analytics.production.read', { projectId: c.projectId });
        return s ? sql`AND ${s}` : sql``;
      })()}
      ${q.filters.projectIds?.length ? sql`AND c.project_id IN (${sql.join(q.filters.projectIds.map((x) => sql`${x}::uuid`), sql`, `)})` : sql``}
      ${q.filters.formats?.length ? sql`AND c.format IN (${sql.join(q.filters.formats.map((x) => sql`${x}`), sql`, `)})` : sql``}
      ${q.filters.directionIds?.length ? sql`AND c.project_id IN (SELECT p.id FROM projects p WHERE p.workspace_id = c.workspace_id AND p.direction_id IN (${sql.join(q.filters.directionIds.map((x) => sql`${x}::uuid`), sql`, `)}))` : sql``}
    GROUP BY c.stage`);
  const order = ['ready', 'production', 'review', 'changes_requested'];
  const label: Record<string, string> = { ready: 'Ready', production: 'Production', review: 'Review', changes_requested: 'Changes Requested' };
  return {
    key: 'stage_aging',
    title: 'Stage Aging',
    description: 'Content currently in work, by stage: how long items have been in their current stage.',
    columns: [
      { key: 'stage', label: 'Stage', kind: 'text' },
      { key: 'count', label: 'Items', kind: 'metric' },
      { key: 'median', label: 'Median days in stage', kind: 'metric' },
      { key: 'oldest', label: 'Oldest (days)', kind: 'metric' },
      { key: 'blocked', label: 'Blocked', kind: 'metric' },
    ],
    rows: rows.rows
      .sort((a, b) => order.indexOf(a.stage) - order.indexOf(b.stage))
      .map((r) => ({
        key: r.stage,
        href: `/content?stage=${r.stage}`,
        cells: {
          stage: { text: label[r.stage] ?? r.stage },
          count: { value: { status: 'known', value: r.n, unit: 'count' } },
          median: { value: r.median_days === null ? { status: 'no_data', value: null, unit: 'number' } : { status: 'known', value: r.median_days, unit: 'number' } },
          oldest: { value: r.oldest_days === null ? { status: 'no_data', value: null, unit: 'number' } : { status: 'known', value: r.oldest_days, unit: 'number' } },
          blocked: { value: { status: 'known', value: r.blocked, unit: 'count' } },
        },
      })),
    note: null,
  };
};

const overdueReasonsTable = async (ctx: Ctx, q: InsightQuery): Promise<AnalyticsTable | null> => {
  const d = metricOk(ctx, 'M08');
  if (!d) return null;
  const recs = (await d.load(ctx, q)) as { blocked?: boolean; priority?: string | null; at?: Date | null }[];
  const groups = groupRecords(recs, ['reason', 'priority'], (r, dim) => (dim === 'reason' ? (r.blocked ? 'blocked' : 'not_blocked') : (r.priority ?? null)), (rs) => ({ status: 'known', value: String(rs.length), unit: 'count' }));
  const P = ['urgent', 'high', 'normal', 'low'];
  return {
    key: 'overdue_reasons',
    title: 'Overdue Reasons',
    description: 'Overdue open tasks by blocker state and priority.',
    columns: [
      { key: 'reason', label: 'Reason', kind: 'text' },
      { key: 'priority', label: 'Priority', kind: 'text' },
      { key: 'count', label: 'Tasks', kind: 'metric', metricId: 'M08' },
    ],
    rows: groups
      .sort((a, b) => (a.dims.reason === b.dims.reason ? P.indexOf(a.dims.priority ?? '') - P.indexOf(b.dims.priority ?? '') : a.dims.reason === 'blocked' ? -1 : 1))
      .map((g) => ({
        key: g.key,
        href: `/tasks?overdue=1${g.dims.priority ? `&priority=${g.dims.priority}` : ''}${g.dims.reason === 'blocked' ? '&blocked=1' : ''}`,
        cells: { reason: { text: g.dims.reason === 'blocked' ? 'Blocked' : 'Not blocked' }, priority: { text: (g.dims.priority ?? '').replace(/^./, (c) => c.toUpperCase()) }, count: { value: g.value } },
      })),
    note: null,
  };
};

const accountFreshnessTable = async (ctx: Ctx, q: InsightQuery): Promise<AnalyticsTable | null> => {
  const base = await breakdownTable(ctx, 'accounts', 'Accounts', 'Followers are the latest usable snapshot in the period; views and CTR come from non-overlapping period observations.', 'account', ['X01', 'M11', 'M12', 'M13', 'M22', 'X05'], q, 'Account', 100);
  if (!base) return null;
  const ids = base.rows.map((r) => r.key).filter((k) => k !== '__none');
  if (!ids.length) return base;
  const db = dbOf(ctx);
  const ws = ctx.actor.workspaceId;
  const o = metricObservations;
  const [fresh, overdue] = await Promise.all([
    db
      .select({ accountId: o.accountId, observed: max(o.observedAt), entered: max(o.enteredAt) })
      .from(o)
      .where(and(eq(o.workspaceId, ws), inArray(o.accountId, ids), sql`${o.qualityState} IN ('unverified', 'reviewed')`, sql`${o.entityType} <> 'publication'`))
      .groupBy(o.accountId),
    db
      .select({ accountId: metricCheckpoints.accountId, n: sql<number>`count(*)::int` })
      .from(metricCheckpoints)
      .where(and(eq(metricCheckpoints.workspaceId, ws), inArray(metricCheckpoints.accountId, ids), eq(metricCheckpoints.entityType, 'account'), eq(metricCheckpoints.state, 'pending'), sql`${metricCheckpoints.windowEnd} < ${ctx.app.clock.now()}`))
      .groupBy(metricCheckpoints.accountId),
  ]);
  base.columns.push({ key: 'observed', label: 'Last Observed At', kind: 'date' }, { key: 'entered', label: 'Last Entered At', kind: 'date' }, { key: 'freshness', label: 'Freshness', kind: 'status' });
  for (const r of base.rows) {
    const f = fresh.find((x) => x.accountId === r.key);
    const od = overdue.find((x) => x.accountId === r.key)?.n ?? 0;
    r.cells.observed = { at: iso(f?.observed) };
    r.cells.entered = { at: iso(f?.entered) };
    r.cells.freshness = od ? { text: `Overdue (${od})`, tone: 'warning', href: `/metrics?tab=overdue&accountId=${r.key}` } : f?.observed ? { text: 'Up to date', tone: 'success' } : { text: 'No data yet', tone: 'neutral' };
  }
  return base;
};

const checkpointComparisonTable = async (ctx: Ctx, q: InsightQuery): Promise<AnalyticsTable | null> => {
  if (!metricOk(ctx, 'M14')) return null;
  const [day, week] = await Promise.all([loadCheckpointData(ctx, { ...q, checkpointKey: 'pub_24h' }), loadCheckpointData(ctx, { ...q, checkpointKey: 'pub_7d' })]);
  const recent = [...day].sort((a, b) => (b.at?.getTime() ?? 0) - (a.at?.getTime() ?? 0)).slice(0, 50);
  const pubs = await loadPublications(dbOf(ctx), ctx.actor.workspaceId, recent.map((r) => r.id));
  const accs = await loadAccounts(dbOf(ctx), ctx.actor.workspaceId, recent.map((r) => r.accountId));
  const views = (x: (typeof day)[number] | undefined): MetricValue => {
    if (!x?.obs) return { status: 'no_data', value: null, unit: 'count', note: x?.outOfWindow ? 'Recorded outside the target window' : undefined };
    const v = x.obs.values['publication.views'];
    return v == null ? { status: 'no_data', value: null, unit: 'count', note: 'Views not provided' } : { status: 'known', value: v, unit: 'count' };
  };
  return {
    key: 'checkpoint_comparison',
    title: 'Checkpoint Comparison',
    description: 'Values inside the 24 h and 7 d target windows only; observations outside a window are excluded from this comparison (the real observed time is kept on the record).',
    columns: [
      { key: 'publication', label: 'Publication', kind: 'text' },
      { key: 'account', label: 'Account', kind: 'text' },
      { key: 'publishedAt', label: 'Published', kind: 'date' },
      { key: 'views24', label: 'Views 24 h', kind: 'metric', metricId: 'M14' },
      { key: 'views7', label: 'Views 7 d', kind: 'metric', metricId: 'M14' },
      { key: 'interactions', label: 'Interactions 24 h', kind: 'metric', metricId: 'M16' },
      { key: 'er', label: 'ER by Views 24 h', kind: 'metric', metricId: 'M17' },
    ],
    rows: recent.map((r) => {
      const w = week.find((x) => x.id === r.id);
      return {
        key: r.id,
        href: `/publications/${r.id}`,
        cells: {
          publication: { text: pubs.get(r.id)?.title ?? 'Publication' },
          account: { text: accs.get(r.accountId ?? '')?.label ?? '—' },
          publishedAt: { at: iso(r.at) },
          views24: { value: views(r) },
          views7: { value: views(w) },
          interactions: { value: r.obs ? interactionsOf(r) : { status: 'no_data', value: null, unit: 'count' } },
          er: { value: erOne(r, 'views') },
        },
      };
    }),
    note: day.length > 50 ? `Showing the 50 most recent of ${day.length} publications.` : null,
  };
};

const tagTable = async (ctx: Ctx, q: InsightQuery): Promise<AnalyticsTable | null> => {
  const d = metricOk(ctx, 'M19');
  const views = metricOk(ctx, 'M14');
  if (!d || !views) return null;
  const recs = await loadCheckpointData(ctx, q);
  if (!recs.length) return null;
  const pubs = await loadPublications(dbOf(ctx), ctx.actor.workspaceId, recs.map((r) => r.id));
  const contentIds = [...new Set([...pubs.values()].map((p) => p.contentItemId))];
  const tagRows = contentIds.length ? await dbOf(ctx).select({ id: contentItems.id, tags: contentItems.tags }).from(contentItems).where(and(eq(contentItems.workspaceId, ctx.actor.workspaceId), inArray(contentItems.id, contentIds))) : [];
  const tagsOf = new Map(tagRows.map((t) => [t.id, t.tags]));
  const groups = groupRecords(recs, ['tag'], (r) => tagsOf.get(pubs.get(r.id)?.contentItemId ?? '') ?? [], (rs) => d.reduce(rs, q));
  const viewGroups = groupRecords(recs, ['tag'], (r) => tagsOf.get(pubs.get(r.id)?.contentItemId ?? '') ?? [], (rs) => views.reduce(rs, q));
  return {
    key: 'by_tag',
    title: 'By Content Tag',
    description: 'A publication with several tags appears under each of them, so rows do not add up to the total.',
    columns: [
      { key: 'tag', label: 'Tag', kind: 'text' },
      { key: 'M14', label: 'Views at 24 h', kind: 'metric', metricId: 'M14' },
      { key: 'M19', label: 'Aggregate ER', kind: 'metric', metricId: 'M19' },
    ],
    rows: groups
      .sort((a, b) => numeric(b.value) - numeric(a.value))
      .slice(0, 30)
      .map((g) => ({
        key: g.key,
        href: g.dims.tag ? `/content?tag=${encodeURIComponent(g.dims.tag)}` : null,
        cells: { tag: { text: g.dims.tag ?? 'No tag' }, M14: { value: viewGroups.find((v) => v.key === g.key)?.value ?? emptyValueFor(views) }, M19: { value: g.value } },
      })),
    note: null,
  };
};

const sourcesTable = async (ctx: Ctx, q: InsightQuery): Promise<AnalyticsTable | null> => {
  if (!hasAnywhere(ctx.actor.access, 'sale-candidates.review') && !hasAnywhere(ctx.actor.access, 'finance.read') && !hasAnywhere(ctx.actor.access, 'sale-candidates.write')) return null;
  const s = saleCandidates;
  const scope = scopePredicate(ctx, 'analytics.ofm.read', { projectId: s.projectId, accountId: s.accountId });
  const rows = await dbOf(ctx)
    .select({ state: s.state, n: sql<number>`count(*)::int` })
    .from(s)
    .where(and(eq(s.workspaceId, ctx.actor.workspaceId), sql`${s.occurredAt} >= ${q.period.start} AND ${s.occurredAt} < ${q.period.end}`, scope, q.filters.projectIds?.length ? inArray(s.projectId, q.filters.projectIds) : undefined, q.filters.accountIds?.length ? inArray(s.accountId, q.filters.accountIds) : undefined))
    .groupBy(s.state);
  const label: Record<string, string> = { verified: 'Verified', pending: 'Pending Verification', rejected: 'Rejected' };
  return {
    key: 'sources',
    title: 'Verified vs Pending Sources',
    description: 'Sale candidates reported in the period. Only verified and posted sales reach finance; counts only, no amounts.',
    columns: [
      { key: 'state', label: 'Source state', kind: 'text' },
      { key: 'count', label: 'Sale candidates', kind: 'metric' },
    ],
    rows: ['verified', 'pending', 'rejected'].map((k) => {
      // The count is its own sample: zero candidates is an empty sample, not recorded data (T169).
      const n = rows.find((r) => r.state === k)?.n ?? 0;
      return {
        key: k,
        href: `/ofm/operations?tab=sales&state=${k}`,
        cells: { state: { text: label[k]! }, count: { value: { status: 'known', value: String(n), unit: 'count', sampleSize: n } } },
      };
    }),
    note: null,
  };
};

const teamTable = async (ctx: Ctx, q: InsightQuery) => {
  const t = await breakdownTable(ctx, 'members', 'Members', 'Delivery, reviews, approved time and utilization side by side — never combined into one score across professions.', 'member', ['X02', 'X04', 'X03', 'M32', 'X09'], q, 'Member', 200);
  return t;
};

const budgetTable = async (ctx: Ctx, q: InsightQuery): Promise<AnalyticsTable | null> => {
  const d = metricOk(ctx, 'M38');
  if (!d) return null;
  const recs = (await d.load(ctx, q)) as { id: string; remainingMinor: bigint; currency?: string | null; projectId?: string | null }[];
  if (!recs.length) return null;
  const rows = await dbOf(ctx).select({ id: budgets.id, name: budgets.name }).from(budgets).where(and(eq(budgets.workspaceId, ctx.actor.workspaceId), inArray(budgets.id, recs.map((r) => r.id))));
  return {
    key: 'budgets',
    title: 'Budget Remaining',
    description: 'Approved budget − actual − outstanding commitments, per budget in its own currency. Negative values are overspend.',
    columns: [
      { key: 'budget', label: 'Budget', kind: 'text' },
      { key: 'remaining', label: 'Remaining', kind: 'metric', metricId: 'M38' },
    ],
    rows: recs.map((r) => ({
      key: r.id,
      href: `/finance/budgets?open=${r.id}`,
      cells: { budget: { text: rows.find((x) => x.id === r.id)?.name ?? 'Budget' }, remaining: { value: d.reduce([r as never], q), tone: r.remainingMinor < 0n ? 'danger' : undefined } },
    })),
    note: null,
  };
};

// ——— Dashboard ———

interface TabSpec {
  kpis: string[];
  charts: (ctx: Ctx, q: InsightQuery, grain: TimeGrain, input: DashboardInput) => Promise<(AnalyticsChart | null)[]>;
  tables: (ctx: Ctx, q: InsightQuery) => Promise<(AnalyticsTable | null)[]>;
  notes: string[];
  freshness: boolean;
}

const TABS: Record<Tab, TabSpec> = {
  production: {
    kpis: ['M01', 'M02', 'M03', 'M08', 'M07', 'M09', 'M10', 'M04', 'M05', 'M06'],
    charts: (ctx, q, g) =>
      Promise.all([
        timeChart(ctx, 'production_trend', 'Production Trend', 'Published placements and newly approved content per period.', ['M01', 'M02'], q, g),
        categoryChart(ctx, 'wip_by_project', 'Current WIP by Project', 'Content in work at the as-of time.', 'M03', 'project', q),
        categoryChart(ctx, 'produced_by_format', 'Produced by Content Type', 'First approvals in the period by format.', 'M02', 'format', q),
      ]),
    tables: (ctx, q) =>
      Promise.all([
        breakdownTable(ctx, 'by_project', 'By Project', null, 'project', ['M01', 'M02', 'M03', 'M08', 'M07'], q, 'Project'),
        breakdownTable(ctx, 'by_assignee', 'By Assignee', 'Owners of produced content and assignees of tasks.', 'member', ['M02', 'M08', 'M07'], q, 'Member'),
        stageAgingTable(ctx, q),
        overdueReasonsTable(ctx, q),
      ]),
    notes: ['Plan completion against the frozen weekly baseline (M09) and the current plan (M10) are shown separately.'],
    freshness: false,
  },
  accounts: {
    kpis: ['X01', 'M11', 'M12', 'M13', 'M22', 'X05', 'M40'],
    charts: async (ctx, q, g) => [await followersChart(ctx, q, g), await timeChart(ctx, 'views_trend', 'Account Views', 'Non-overlapping period observations inside each bucket; periods crossing a bucket boundary are not split.', ['M13'], q, g)],
    tables: (ctx, q) => Promise.all([accountFreshnessTable(ctx, q)]),
    notes: ['Sum of Account Followers adds up accounts; it is not a count of unique people. Account links do not import statistics or publish content.'],
    freshness: true,
  },
  content: {
    kpis: ['M14', 'M16', 'M19', 'M20', 'M21', 'M15', 'M23', 'M40'],
    charts: (ctx, q) =>
      Promise.all([
        categoryChart(ctx, 'er_by_format', 'Aggregate ER by Content Type', 'Weighted interactions ÷ views at the 24 h checkpoint.', 'M19', 'format', q),
        categoryChart(ctx, 'views_by_platform', 'Views at 24 h by Platform', 'Sum of Reported Views; platform definitions differ.', 'M14', 'platform', q),
      ]),
    tables: (ctx, q) => Promise.all([checkpointComparisonTable(ctx, q), breakdownTable(ctx, 'by_format', 'By Content Type', null, 'format', ['M14', 'M16', 'M19', 'M20'], q, 'Format'), tagTable(ctx, q)]),
    notes: ['Comparisons use the same checkpoint window; late or early observations are excluded by default. Paid and organic results are never mixed with combined totals.'],
    freshness: true,
  },
  ofm: {
    kpis: ['X07', 'X06', 'M28', 'M24', 'M25', 'M26', 'M27', 'M29', 'M30', 'M31'],
    charts: (ctx, q, g) =>
      Promise.all([
        timeChart(ctx, 'net_hours', 'Shift Net Hours', 'Net hours of shifts started in each period; shifts without an actual end are pending.', ['M28'], q, g),
        categoryChart(ctx, 'hours_by_account', 'Net Hours by Primary Account', 'One shift time is never multiplied by its additional accounts.', 'M28', 'account', q),
      ]),
    tables: (ctx, q) => Promise.all([breakdownTable(ctx, 'by_account', 'By Account', null, 'account', ['X07', 'X06', 'M28', 'M24', 'M30'], q, 'Account'), sourcesTable(ctx, q)]),
    notes: ['Revenue metrics use posted finance records only; pending sale candidates are shown separately as Pending Verification.'],
    freshness: false,
  },
  team: {
    kpis: ['X02', 'X09', 'X04', 'X03', 'M32'],
    charts: (ctx, q, g) => Promise.all([timeChart(ctx, 'approved_time', 'Approved Hours', 'Approved time entries by work date.', ['X03'], q, g), categoryChart(ctx, 'completed_by_member', 'Tasks Completed by Member', 'Unique tasks with their last Done in the period.', 'X02', 'member', q)]),
    tables: (ctx, q) => Promise.all([teamTable(ctx, q)]),
    notes: ['Utilization compares approved tracked time with confirmed capacity; it is not a productivity rating.'],
    freshness: false,
  },
  finance: {
    kpis: ['M33', 'M34', 'M35', 'M36', 'M41', 'M39', 'M38', 'M42', 'M37', 'X08'],
    charts: (ctx, q, g) =>
      Promise.all([timeChart(ctx, 'accrual_trend', 'Accrual Results', 'Net revenue and operating result by recognition date (frozen base-currency equivalents).', ['M34', 'M35'], q, g.length ? (g === 'day' ? 'week' : g) : 'month')]),
    tables: (ctx, q) => Promise.all([breakdownTable(ctx, 'by_project', 'By Project', 'Allocated posted amounts; costs without a project stay on an explicit Unallocated row.', 'project', ['M34', 'M35', 'M33'], q, 'Project'), budgetTable(ctx, q)]),
    notes: ['Accrual (recognition date) and cash (payment date) are separate views and are never added together. Drafts never enter totals.'],
    freshness: false,
  },
};

/** Followers per account (max five accounts, lines are not additive so there is no "Other"). */
const followersChart = async (ctx: Ctx, q: InsightQuery, grain: TimeGrain): Promise<AnalyticsChart | null> => {
  const d = metricOk(ctx, 'X01');
  if (!d) return null;
  const g = grainFor(d, grain)!;
  const rows = await d.load(ctx, { ...q, grain: g });
  const dirs = await projectDirections(ctx);
  const perAccount = groupRecords(rows, ['account', 'period'], (r, dim) => dimensionValue(r, dim as DimKey, g, q.period.zone, dirs), (rs) => d.reduce(rs, q));
  const latest = new Map<string, number>();
  for (const x of perAccount) if (x.dims.account && x.dims.period && hasValue(x.value)) latest.set(x.dims.account, Math.max(latest.get(x.dims.account) ?? 0, Number(x.value.value)));
  const top = [...latest.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k]) => k);
  if (!top.length) return { key: 'followers', title: 'Followers by Account', description: 'Latest usable snapshot per account in each period.', kind: 'line', unit: 'count', xKind: 'time', series: [], points: [], note: null };
  const labels = await dimensionLabels(ctx, 'account', top);
  const xs = buckets(q.period, g).map((b) => b.key);
  return {
    key: 'followers',
    title: 'Followers by Account',
    description: 'Latest usable snapshot per account in each period; missing snapshots are gaps, never zero.',
    kind: 'line',
    unit: 'count',
    xKind: 'time',
    series: top.map((a) => ({ key: a, label: labels.get(a) ?? 'Account', metricId: 'X01' })),
    points: xs.map((x) => ({ x, label: x, values: Object.fromEntries(top.map((a) => [a, perAccount.find((p) => p.dims.account === a && p.dims.period === x)?.value ?? { status: 'no_data', value: null, unit: 'count' }])) })),
    note: latest.size > 5 ? `Showing the 5 largest of ${latest.size} accounts; the table lists all.` : null,
  };
};

const freshnessOf = async (ctx: Ctx, q: InsightQuery) => {
  const o = metricObservations;
  const scope = scopePredicate(ctx, 'metrics.read', { projectId: o.projectId, accountId: o.accountId });
  const [r] = await dbOf(ctx)
    .select({ observed: max(o.observedAt), entered: max(o.enteredAt) })
    .from(o)
    .where(and(eq(o.workspaceId, ctx.actor.workspaceId), sql`${o.qualityState} IN ('unverified', 'reviewed')`, scope, q.filters.projectIds?.length ? inArray(o.projectId, q.filters.projectIds) : undefined, q.filters.accountIds?.length ? inArray(o.accountId, q.filters.accountIds) : undefined));
  return { lastObservedAt: iso(r?.observed), lastEnteredAt: iso(r?.entered) };
};

/** No source record behind the value: unknown, or a zero count/sum over an empty sample. */
const isEmptyValue = (v: MetricValue) => v.value === null || ((v.sampleSize ?? 1) === 0 && Number(v.value) === 0);

/** S51 Analytics dashboard tab: KPIs with equal-window comparison, charts, tables, freshness. */
export const analyticsDashboard = async (ctx: QueryContext, tab: Tab, input: DashboardInput): Promise<AnalyticsDashboard> => {
  const tabs = availableTabs(ctx);
  if (!tabs.includes(tab)) throw forbidden(tabs.length ? 'You do not have access to this dashboard.' : 'You do not have access to analytics.');
  const rp = await resolveInsightPeriod(ctx, { preset: input.preset, from: input.from, to: input.to });
  const filters = toMetricFilters(input);
  const now = ctx.app.clock.now();
  const cur: InsightQuery = { period: rp.current, asOf: now, filters };
  const prev: InsightQuery | null = input.compare === false ? null : { period: rp.previous, asOf: rp.previous.end, filters };
  const grain = input.grain ?? defaultGrain(rp);
  const spec = TABS[tab];
  const [kpis, charts, tables, freshness] = await Promise.all([
    Promise.all(spec.kpis.map((id) => kpiOf(ctx, id, cur, prev))),
    spec.charts(ctx, cur, grain, input),
    spec.tables(ctx, cur),
    spec.freshness ? freshnessOf(ctx, cur) : Promise.resolve(null),
  ]);
  const k = kpis.filter((x): x is AnalyticsKpi => !!x);
  const t = tables.filter((x): x is AnalyticsTable => !!x);
  const empty = k.every((x) => isEmptyValue(x.value)) && t.every((x) => x.rows.every((r) => Object.values(r.cells).every((c) => !c.value || isEmptyValue(c.value))));
  return {
    tab,
    period: periodDto(rp),
    comparison: prev
      ? { fromDate: rp.previous.fromDate, toDate: rp.previous.toDate, start: rp.previous.start.toISOString(), end: rp.previous.end.toISOString(), elapsedOnly: rp.elapsedOnly }
      : null,
    asOf: now.toISOString(),
    grain,
    kpis: k,
    charts: charts.filter((x): x is AnalyticsChart => !!x),
    tables: t,
    freshness,
    notes: [...spec.notes, ...(rp.elapsedOnly && prev ? [`The period is not finished: it is compared with the same elapsed part of the previous period (${rp.previous.fromDate} – ${rp.previous.toDate}).`] : [])],
    empty,
    availableTabs: tabs,
  };
};

/** POST /analytics/query: typed semantic-layer query (read-only). */
export const analyticsQuery = async (
  ctx: QueryContext,
  input: { metrics: string[]; period: { preset: Preset; from?: string; to?: string }; compare: boolean; filters: Parameters<typeof toMetricFilters>[0]; groupBy?: DimKey; grain?: TimeGrain },
) => {
  const rp = await resolveInsightPeriod(ctx, input.period);
  const filters = toMetricFilters(input.filters);
  const now = ctx.app.clock.now();
  const results = [];
  for (const id of [...new Set(input.metrics)]) {
    const d = insightMetric(id);
    if (!canUseMetric(ctx, d)) throw forbidden(`You do not have access to ${d.label}.`);
    const cur: InsightQuery = { period: rp.current, asOf: now, filters, grain: input.grain && d.grains.includes(input.grain) ? input.grain : undefined, groupBy: input.groupBy && d.dimensions.includes(input.groupBy) ? input.groupBy : undefined };
    if (input.groupBy && !d.dimensions.includes(input.groupBy)) throw new AppError('VALIDATION_FAILED', `${d.label} cannot be broken down by ${input.groupBy}.`, { fieldErrors: [{ field: 'groupBy', code: 'NOT_ALLOWED', message: `${d.label} cannot be broken down by ${input.groupBy}.` }] });
    const [c, p] = await Promise.all([computeInsight(ctx, d, cur), input.compare ? computeInsight(ctx, d, { period: rp.previous, asOf: rp.previous.end, filters }) : Promise.resolve(null)]);
    results.push({
      metricId: d.id,
      label: d.label,
      description: d.description,
      unit: d.unit,
      rate: !!d.rate,
      total: c.total,
      previous: p?.total ?? null,
      delta: p ? compareValues(c.total, p.total, { rate: !!d.rate }) : null,
      series: c.series ?? null,
      groups: c.groups?.map((g) => ({ key: g.key || null, label: g.label, value: g.value })) ?? null,
      sourceAsOf: c.sourceAsOf ?? null,
    });
  }
  return { period: periodDto(rp), results };
};

// ——— Drill-down ———

const DRILL_LIMIT = 200;

/** Labels of source records (titles are read in the workspace; records the member cannot open are removed before). */
const recordLabels = async (ctx: Ctx, type: string, ids: string[]): Promise<Map<string, { label: string; sublabel: string | null }>> => {
  const db = dbOf(ctx);
  const ws = ctx.actor.workspaceId;
  const out = new Map<string, { label: string; sublabel: string | null }>();
  if (!ids.length) return out;
  switch (type) {
    case 'publication': {
      const pubs = await loadPublications(db, ws, ids);
      const accs = await loadAccounts(db, ws, [...pubs.values()].map((p) => p.accountId));
      for (const [id, p] of pubs) out.set(id, { label: p.title, sublabel: accs.get(p.accountId)?.label ?? null });
      break;
    }
    case 'content_item': {
      const rows = await db.select({ id: contentItems.id, title: contentItems.title, stage: contentItems.stage }).from(contentItems).where(and(eq(contentItems.workspaceId, ws), inArray(contentItems.id, ids)));
      for (const r of rows) out.set(r.id, { label: r.title, sublabel: r.stage.replace(/_/g, ' ') });
      break;
    }
    case 'task': {
      const rows = await db.select({ id: tasks.id, title: tasks.title, assignee: tasks.assigneeMembershipId }).from(tasks).where(and(eq(tasks.workspaceId, ws), inArray(tasks.id, ids)));
      const refs = await loadMemberRefs(db, ws, rows.map((r) => r.assignee));
      for (const r of rows) out.set(r.id, { label: r.title, sublabel: r.assignee ? (refs.get(r.assignee)?.displayName ?? null) : 'Unassigned' });
      break;
    }
    case 'metric_observation': {
      const rows = await db.select({ id: metricObservations.id, accountId: metricObservations.accountId, kind: metricObservations.kind, observedAt: metricObservations.observedAt }).from(metricObservations).where(and(eq(metricObservations.workspaceId, ws), inArray(metricObservations.id, ids)));
      const accs = await loadAccounts(db, ws, rows.map((r) => r.accountId));
      for (const r of rows) out.set(r.id, { label: accs.get(r.accountId)?.label ?? 'Observation', sublabel: `${r.kind} observation` });
      break;
    }
    case 'metric_checkpoint': {
      const rows = await db.select({ id: metricCheckpoints.id, accountId: metricCheckpoints.accountId, key: metricCheckpoints.checkpointKey }).from(metricCheckpoints).where(and(eq(metricCheckpoints.workspaceId, ws), inArray(metricCheckpoints.id, ids)));
      const accs = await loadAccounts(db, ws, rows.map((r) => r.accountId));
      for (const r of rows) out.set(r.id, { label: accs.get(r.accountId)?.label ?? 'Checkpoint', sublabel: r.key === 'account_snapshot' ? 'Account snapshot' : r.key.replace('pub_', 'Publication ') });
      break;
    }
    case 'shift': {
      const rows = await db.select({ id: shifts.id, member: shifts.membershipId, accountId: shifts.primaryAccountId }).from(shifts).where(and(eq(shifts.workspaceId, ws), inArray(shifts.id, ids)));
      const [refs, accs] = await Promise.all([loadMemberRefs(db, ws, rows.map((r) => r.member)), loadAccounts(db, ws, rows.map((r) => r.accountId))]);
      for (const r of rows) out.set(r.id, { label: `Shift · ${refs.get(r.member)?.displayName ?? 'member'}`, sublabel: accs.get(r.accountId)?.label ?? null });
      break;
    }
    case 'handover': {
      const rows = await db.select({ id: handovers.id, accountId: handovers.accountId }).from(handovers).where(and(eq(handovers.workspaceId, ws), inArray(handovers.id, ids)));
      const accs = await loadAccounts(db, ws, rows.map((r) => r.accountId));
      for (const r of rows) out.set(r.id, { label: 'Handover', sublabel: accs.get(r.accountId)?.label ?? null });
      break;
    }
    case 'quality_review': {
      const rows = await db.select({ id: qualityReviews.id }).from(qualityReviews).where(and(eq(qualityReviews.workspaceId, ws), inArray(qualityReviews.id, ids)));
      for (const r of rows) out.set(r.id, { label: 'Quality review', sublabel: null });
      break;
    }
    case 'financial_entry': {
      const rows = await db.select({ id: financialEntries.id, title: financialEntries.title, date: financialEntries.recognitionDate }).from(financialEntries).where(and(eq(financialEntries.workspaceId, ws), inArray(financialEntries.id, ids)));
      for (const r of rows) out.set(r.id, { label: r.title, sublabel: r.date });
      break;
    }
    case 'settlement': {
      const rows = await db.select({ id: settlements.id, counterparty: settlements.counterparty, direction: settlements.direction }).from(settlements).where(and(eq(settlements.workspaceId, ws), inArray(settlements.id, ids)));
      for (const r of rows) out.set(r.id, { label: r.counterparty ?? (r.direction === 'in' ? 'Incoming payment' : 'Outgoing payment'), sublabel: r.direction === 'in' ? 'Inflow' : 'Outflow' });
      break;
    }
    case 'budget': {
      const rows = await db.select({ id: budgets.id, name: budgets.name }).from(budgets).where(and(eq(budgets.workspaceId, ws), inArray(budgets.id, ids)));
      for (const r of rows) out.set(r.id, { label: r.name, sublabel: null });
      break;
    }
    case 'compensation_run': {
      const rows = await db.select({ id: compensationRuns.id, from: compensationRuns.periodStart, to: compensationRuns.periodEnd }).from(compensationRuns).where(and(eq(compensationRuns.workspaceId, ws), inArray(compensationRuns.id, ids)));
      for (const r of rows) out.set(r.id, { label: `Compensation run ${r.from} – ${r.to}`, sublabel: null });
      break;
    }
    case 'sale_candidate': {
      const rows = await db.select({ id: saleCandidates.id, ns: saleCandidates.sourceNamespace }).from(saleCandidates).where(and(eq(saleCandidates.workspaceId, ws), inArray(saleCandidates.id, ids)));
      for (const r of rows) out.set(r.id, { label: `Sale candidate (${r.ns})`, sublabel: null });
      break;
    }
    case 'time_entry': {
      const rows = await db.select({ id: timeEntries.id, member: timeEntries.membershipId, date: timeEntries.workDate }).from(timeEntries).where(and(eq(timeEntries.workspaceId, ws), inArray(timeEntries.id, ids)));
      const refs = await loadMemberRefs(db, ws, rows.map((r) => r.member));
      for (const r of rows) out.set(r.id, { label: refs.get(r.member)?.displayName ?? 'Time entry', sublabel: r.date });
      break;
    }
    default:
      for (const id of ids) out.set(id, { label: type.replace(/_/g, ' '), sublabel: null });
  }
  return out;
};

/** Drill Down: exact source records of a metric value, limited to records the member may open. */
export const analyticsDrillDown = async (ctx: QueryContext, input: DashboardInput & { metric: string; groupDimension?: DimKey; groupKey?: string }): Promise<DrillDownResult> => {
  const d = insightMetric(input.metric);
  if (!canUseMetric(ctx, d)) throw forbidden('You do not have access to this metric.');
  if (!d.drill) throw new AppError('INVALID_STATE', `${d.label} has no drill-down to individual records.`);
  const rp = await resolveInsightPeriod(ctx, { preset: input.preset, from: input.from, to: input.to });
  const q: InsightQuery = { period: rp.current, asOf: ctx.app.clock.now(), filters: toMetricFilters(input), grain: input.grain };
  let recs = await d.load(ctx, q);
  if (input.groupDimension) {
    if (!d.dimensions.includes(input.groupDimension)) throw new AppError('VALIDATION_FAILED', `${d.label} cannot be broken down by ${input.groupDimension}.`);
    const dirs = await projectDirections(ctx);
    const key = input.groupKey && input.groupKey !== '__none' ? input.groupKey : null;
    recs = recs.filter((r) => dimensionValue(r, input.groupDimension!, q.grain ?? 'week', q.period.zone, dirs) === key);
  }
  const refs = recs.map((r) => d.drill!.ref(r)).filter((x): x is NonNullable<typeof x> => !!x);
  const unique = [...new Map(refs.map((r) => [`${r.entityType}:${r.id}`, r])).values()];
  const perms = Array.isArray(d.drill.readPermission) ? d.drill.readPermission : [d.drill.readPermission];
  const visible = unique.filter((r) => perms.some((p) => allowed(ctx, p, { projectId: r.projectId, accountId: r.accountId, objectType: r.entityType, objectId: r.id })));
  visible.sort((a, b) => (b.at?.getTime() ?? 0) - (a.at?.getTime() ?? 0));
  const page = visible.slice(0, DRILL_LIMIT);
  const byType = new Map<string, string[]>();
  for (const r of page) byType.set(r.entityType, [...(byType.get(r.entityType) ?? []), r.id]);
  const labels = new Map<string, { label: string; sublabel: string | null }>();
  for (const [type, ids] of byType) for (const [id, l] of await recordLabels(ctx, type, ids)) labels.set(`${type}:${id}`, l);
  return {
    metricId: d.id,
    label: d.label,
    description: d.description,
    items: page.map((r) => {
      const l = labels.get(`${r.entityType}:${r.id}`);
      const route = ENTITY_ROUTES[r.entityType];
      return { entityType: r.entityType, entityId: r.id, label: l?.label ?? 'Record', sublabel: l?.sublabel ?? null, at: iso(r.at), value: plainDecimal(r.value), href: `/w/${ctx.actor.workspaceId}${route ? route(r.id, { projectId: r.projectId }) : '/overview'}` };
    }),
    total: visible.length,
    hidden: unique.length - visible.length,
    truncated: visible.length > DRILL_LIMIT,
  };
};

