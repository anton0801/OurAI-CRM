import { and, eq, gt, sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { listFilter } from '@castlane/authorization';
import { tupleKey, type MetricValue } from '@castlane/analytics';
import {
  comments,
  contentItems,
  financialAllocations,
  financialEntries,
  metricCheckpoints,
  metricObservations,
  publications,
  qualityReviews,
  reviews,
  settlements,
  shifts,
  tasks,
  timeEntries,
} from '@castlane/database';
import type { ReportConfig, ReportDatasetInfo, ReportResult } from '@castlane/api-contracts';
import { AppError, REPORT_LIMITS, TASK_STATUSES, forbidden, type EnumValue, type FieldError, type REPORT_DATASETS } from '@castlane/domain';
import { scopePredicate } from '../../core/access';
import { dbOf } from '../../core/context';
import { loadMemberRefs } from '../../core/members';
import { periodDto, resolveInsightPeriod, type Ctx, type ResolvedInsightPeriod } from '../common';
import { toMetricFilters } from '../dashboards';
import { INSIGHT_METRICS, canUseMetric, dimensionLabels, emptyValueFor, groupedInsight, noneLabel, type DimKey, type InsightMetric, type InsightQuery } from '../semantic/registry';

export type ReportDatasetKey = EnumValue<typeof REPORT_DATASETS>;
type FilterKey = ReportDatasetInfo['filters'][number];

interface DatasetSpec {
  key: ReportDatasetKey;
  label: string;
  description: string;
  /** Shared or scheduled reports on restricted datasets need an explicit project filter (§17). */
  restricted: boolean;
  metrics: string[];
  filters: FilterKey[];
  statusOptions: { value: string; label: string }[];
  /** Source tables checked for "Updated source data is available" (with their project column). */
  sources: { table: { workspaceId: PgColumn; updatedAt: PgColumn }; projectId?: PgColumn }[];
  sourcePermission: string;
}

const cap = (s: string) => s.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

/**
 * Datasets of the semantic layer. A dataset only offers its metrics and, per metric, the dimensions
 * the metric supports — the allowed join graph. Every metric is reduced to the requested grain on
 * its own facts before rows are combined by dimension values, so joining never multiplies facts
 * (T115: comments of a task never multiply its time).
 */
export const REPORT_DATASET_SPECS: Record<ReportDatasetKey, DatasetSpec> = {
  tasks: {
    key: 'tasks',
    label: 'Tasks & Time',
    description: 'Task delivery, overdue work, approved time and task comments.',
    restricted: false,
    metrics: ['X02', 'M07', 'M08', 'X03', 'X10', 'X09'],
    filters: ['directionId', 'projectIds', 'accountIds', 'memberIds', 'statuses'],
    statusOptions: TASK_STATUSES.map((s) => ({ value: s, label: cap(s) })),
    sources: [
      { table: tasks, projectId: tasks.projectId },
      { table: timeEntries, projectId: timeEntries.projectId },
      { table: comments },
    ],
    sourcePermission: 'analytics.production.read',
  },
  content: {
    key: 'content',
    label: 'Content Production',
    description: 'Produced content, work in progress, lead time, review turnaround and rework.',
    restricted: false,
    metrics: ['M02', 'M03', 'M04', 'M05', 'M06', 'X04'],
    filters: ['directionId', 'projectIds', 'formats', 'memberIds'],
    statusOptions: [],
    sources: [
      { table: contentItems, projectId: contentItems.projectId },
      { table: reviews, projectId: reviews.projectId },
    ],
    sourcePermission: 'analytics.production.read',
  },
  publications: {
    key: 'publications',
    label: 'Publications & Results',
    description: 'Published placements, plan completion and checkpoint results (views, interactions, ER).',
    restricted: false,
    metrics: ['M01', 'M09', 'M10', 'M14', 'M16', 'M17', 'M18', 'M19', 'M20', 'M21', 'M15', 'M23'],
    filters: ['directionId', 'projectIds', 'accountIds', 'platforms', 'formats', 'memberIds'],
    statusOptions: [],
    sources: [
      { table: publications, projectId: publications.projectId },
      { table: metricObservations, projectId: metricObservations.projectId },
    ],
    sourcePermission: 'analytics.content.read',
  },
  account_metrics: {
    key: 'account_metrics',
    label: 'Account Metrics',
    description: 'Follower snapshots, account period results, CTR, cadence and data coverage.',
    restricted: false,
    metrics: ['X01', 'M11', 'M12', 'M13', 'M22', 'X05', 'M40'],
    filters: ['directionId', 'projectIds', 'accountIds', 'platforms'],
    statusOptions: [],
    sources: [
      { table: metricObservations, projectId: metricObservations.projectId },
      { table: metricCheckpoints, projectId: metricCheckpoints.projectId },
    ],
    sourcePermission: 'analytics.accounts.read',
  },
  ofm: {
    key: 'ofm',
    label: 'OFM Operations',
    description: 'Shifts, reports, handovers, quality and subscription results of OFM accounts.',
    restricted: true,
    metrics: ['X07', 'X06', 'M28', 'M24', 'M25', 'M26', 'M30', 'M31', 'M27', 'M29'],
    filters: ['directionId', 'projectIds', 'accountIds', 'platforms', 'memberIds'],
    statusOptions: [],
    sources: [
      { table: shifts, projectId: shifts.projectId },
      { table: qualityReviews, projectId: qualityReviews.projectId },
      { table: metricObservations, projectId: metricObservations.projectId },
    ],
    sourcePermission: 'analytics.ofm.read',
  },
  finance: {
    key: 'finance',
    label: 'Finance',
    description: 'Posted revenue, costs, margin, cash movement, budgets and compensation (management accounting).',
    restricted: true,
    metrics: ['M33', 'M34', 'M35', 'M36', 'X08', 'M37', 'M38', 'M39', 'M41', 'M42'],
    filters: ['directionId', 'projectIds', 'accountIds'],
    statusOptions: [],
    sources: [
      { table: financialAllocations, projectId: financialAllocations.projectId },
      { table: financialEntries },
      { table: settlements },
    ],
    sourcePermission: 'analytics.finance.read',
  },
};

const datasetMetrics = (ctx: Ctx, spec: DatasetSpec) => spec.metrics.map((id) => INSIGHT_METRICS.get(id)).filter((d): d is InsightMetric => !!d && canUseMetric(ctx, d));

export const DIMENSION_LABELS: Record<DimKey, string> = {
  period: 'Period',
  project: 'Project',
  direction: 'Direction',
  account: 'Account',
  platform: 'Platform',
  format: 'Content Type',
  member: 'Member',
  campaign: 'Campaign',
  publication: 'Publication',
  category: 'Category',
  currency: 'Currency',
  status: 'Status',
  priority: 'Priority',
  stage: 'Stage',
};

/** Datasets the member may build reports on (at least one permitted metric). */
export const listReportDatasets = (ctx: Ctx): ReportDatasetInfo[] =>
  Object.values(REPORT_DATASET_SPECS)
    .map((spec) => {
      const metrics = datasetMetrics(ctx, spec);
      if (!metrics.length) return null;
      const dims = [...new Set(metrics.flatMap((m) => m.dimensions))];
      return {
        key: spec.key,
        label: spec.label,
        description: spec.description,
        restricted: spec.restricted,
        dimensions: dims.map((d) => ({ key: d, label: DIMENSION_LABELS[d] })),
        metrics: metrics.map((m) => ({ key: m.id, label: m.label, description: m.description, unit: m.unit, rate: !!m.rate, additive: m.additive, dimensions: m.dimensions, timeSeries: m.grains.length > 0 })),
        filters: spec.filters,
        statusOptions: spec.statusOptions,
      };
    })
    .filter((x): x is ReportDatasetInfo => !!x);

/** Validate a configuration against the semantic layer: only permitted combinations, no arbitrary SQL. */
export const validateReportConfig = (ctx: Ctx, config: ReportConfig, opts: { shared?: boolean } = {}) => {
  const spec = REPORT_DATASET_SPECS[config.dataset];
  const errors: FieldError[] = [];
  if (!spec) throw new AppError('VALIDATION_FAILED', 'Choose a dataset.', { fieldErrors: [{ field: 'config.dataset', code: 'UNKNOWN', message: 'Choose a dataset.' }] });
  const permitted = datasetMetrics(ctx, spec);
  if (!permitted.length) throw forbidden('You do not have access to this dataset.');
  if (config.metrics.length > REPORT_LIMITS.maxMetrics) errors.push({ field: 'config.metrics', code: 'TOO_MANY', message: `Choose at most ${REPORT_LIMITS.maxMetrics} metrics.` });
  if (config.dimensions.length > REPORT_LIMITS.maxDimensions) errors.push({ field: 'config.dimensions', code: 'TOO_MANY', message: `Choose at most ${REPORT_LIMITS.maxDimensions} dimensions.` });
  if (new Set(config.dimensions).size !== config.dimensions.length) errors.push({ field: 'config.dimensions', code: 'DUPLICATE', message: 'A dimension is listed twice.' });
  const defs: InsightMetric[] = [];
  config.metrics.forEach((id, i) => {
    if (!spec.metrics.includes(id)) {
      errors.push({ field: `config.metrics.${i}`, code: 'NOT_IN_DATASET', message: `${id} is not part of the ${spec.label} dataset.` });
      return;
    }
    const d = permitted.find((m) => m.id === id);
    if (!d) {
      errors.push({ field: `config.metrics.${i}`, code: 'NO_ACCESS', message: `You do not have access to ${INSIGHT_METRICS.get(id)?.label ?? id}.` });
      return;
    }
    if (defs.includes(d)) {
      errors.push({ field: `config.metrics.${i}`, code: 'DUPLICATE', message: `${d.label} is listed twice.` });
      return;
    }
    defs.push(d);
    for (const dim of config.dimensions) {
      if (!d.dimensions.includes(dim)) errors.push({ field: 'config.dimensions', code: 'NOT_ALLOWED', message: `${d.label} cannot be broken down by ${DIMENSION_LABELS[dim].toLowerCase()}.` });
      else if (dim === 'period' && !d.grains.includes(config.timeGrain)) errors.push({ field: 'config.timeGrain', code: 'NOT_ALLOWED', message: `${d.label} has no ${config.timeGrain} series.` });
    }
  });
  for (const [k, v] of Object.entries(config.filters ?? {})) {
    const active = Array.isArray(v) ? v.length > 0 : !!v;
    if (active && !spec.filters.includes(k as FilterKey)) errors.push({ field: `config.filters.${k}`, code: 'NOT_ALLOWED', message: `The ${spec.label} dataset cannot be filtered by ${k}.` });
  }
  const stack = config.chart === 'stacked_bar' && defs.some((d) => !d.additive);
  if (stack) errors.push({ field: 'config.chart', code: 'NOT_ADDITIVE', message: 'A stacked chart needs metrics that add up (counts or sums).' });
  if (config.chart === 'line' && !config.dimensions.includes('period'))
    errors.push({ field: 'config.chart', code: 'NEEDS_PERIOD', message: 'A line chart needs the Period dimension.' });
  if (opts.shared && spec.restricted && !config.filters?.projectIds?.length)
    errors.push({ field: 'config.filters.projectIds', code: 'PROJECT_FILTER_REQUIRED', message: `Shared ${spec.label} reports must be limited to specific projects.` });
  if (config.datePolicy.kind === 'fixed' && config.datePolicy.to < config.datePolicy.from)
    errors.push({ field: 'config.datePolicy.to', code: 'BEFORE_START', message: 'The period must end on or after its start.' });
  if (errors.length) throw new AppError('VALIDATION_FAILED', errors[0]!.message, { fieldErrors: errors });
  return { spec, defs };
};

const resolveReportPeriod = (ctx: Ctx, config: ReportConfig) =>
  config.datePolicy.kind === 'fixed' ? resolveInsightPeriod(ctx, { preset: 'custom', from: config.datePolicy.from, to: config.datePolicy.to }) : resolveInsightPeriod(ctx, { preset: config.datePolicy.preset });

const numeric = (v: MetricValue | undefined) => (v && v.value !== null ? Number(v.value) : Number.NEGATIVE_INFINITY);

/** Human description of the data scope the result was computed in (never broader than the member's). */
export const scopeSummaryOf = (ctx: Ctx, config: ReportConfig, spec: DatasetSpec, labels: { projects: string[] }) => {
  const f = listFilter(ctx.actor.access, spec.sourcePermission);
  const scope =
    f.kind === 'all'
      ? 'all projects and accounts in the workspace'
      : f.kind === 'none'
        ? 'no data'
        : [f.projectIds.length ? `${f.projectIds.length} project(s)` : null, f.accountIds.length ? `${f.accountIds.length} account(s)` : null, f.assignedToMembershipId ? 'records assigned to them' : null].filter(Boolean).join(', ') || 'no data';
  const filters = [
    labels.projects.length ? `projects: ${labels.projects.join(', ')}` : null,
    config.filters.platforms?.length ? `platforms: ${config.filters.platforms.join(', ')}` : null,
    config.filters.formats?.length ? `content types: ${config.filters.formats.join(', ')}` : null,
    config.filters.accountIds?.length ? `${config.filters.accountIds.length} account(s)` : null,
    config.filters.memberIds?.length ? `${config.filters.memberIds.length} member(s)` : null,
    config.filters.statuses?.length ? `statuses: ${config.filters.statuses.join(', ')}` : null,
  ].filter(Boolean);
  return `Data visible to ${ctx.actor.displayName}: ${scope}.${filters.length ? ` Filters — ${filters.join('; ')}.` : ''}`;
};

export interface RunOptions {
  limit?: number;
  datePolicy?: ReportConfig['datePolicy'];
  filters?: ReportConfig['filters'];
}

/**
 * Run a report for the member (their scope only): each metric is grouped on its own facts, rows are
 * combined by dimension tuple, labelled, sorted by numeric values and limited.
 */
export const runReport = async (ctx: Ctx, rawConfig: ReportConfig, opts: RunOptions = {}): Promise<ReportResult & { period$: ResolvedInsightPeriod }> => {
  const config: ReportConfig = { ...rawConfig, datePolicy: opts.datePolicy ?? rawConfig.datePolicy, filters: opts.filters ?? rawConfig.filters ?? {} };
  const { spec, defs } = validateReportConfig(ctx, config);
  const rp = await resolveReportPeriod(ctx, config);
  const dims = config.dimensions as DimKey[];
  const q: InsightQuery = { period: rp.current, asOf: ctx.app.clock.now(), filters: toMetricFilters(config.filters), grain: config.timeGrain };
  const results = await Promise.all(defs.map((d) => groupedInsight(ctx, d.id, q, dims)));
  const rows = new Map<string, { dims: Record<string, string | null>; values: Record<string, MetricValue> }>();
  results.forEach((r, i) => {
    for (const g of r.groups) {
      const key = tupleKey(dims, g.dims);
      const row = rows.get(key) ?? { dims: g.dims, values: {} };
      row.values[defs[i]!.id] = g.value;
      rows.set(key, row);
    }
  });
  // Resolve labels per dimension.
  const labels = new Map<DimKey, Map<string, string>>();
  for (const dim of dims) labels.set(dim, await dimensionLabels(ctx, dim, [...rows.values()].map((r) => r.dims[dim] ?? null)));
  let list = [...rows.entries()].map(([key, r]) => ({
    key,
    dims: Object.fromEntries(dims.map((dim) => [dim, { id: r.dims[dim] ?? null, label: r.dims[dim] ? (labels.get(dim)?.get(r.dims[dim]!) ?? r.dims[dim]!) : noneLabel(dim) }])),
    values: Object.fromEntries(defs.map((d) => [d.id, r.values[d.id] ?? emptyValueFor(d)])),
  }));
  const sort = config.sort.length ? config.sort : dims.includes('period') ? [{ key: 'period', direction: 'asc' as const }] : defs.length ? [{ key: defs[0]!.id, direction: 'desc' as const }] : [];
  list.sort((a, b) => {
    for (const s of sort) {
      const dir = s.direction === 'asc' ? 1 : -1;
      let c = 0;
      if ((dims as string[]).includes(s.key)) c = s.key === 'period' ? String(a.dims[s.key]?.id ?? '').localeCompare(String(b.dims[s.key]?.id ?? '')) : (a.dims[s.key]?.label ?? '').localeCompare(b.dims[s.key]?.label ?? '');
      else c = numeric(a.values[s.key]) - numeric(b.values[s.key]);
      if (c !== 0 && Number.isFinite(c)) return c * dir;
      if (c !== 0) return c > 0 ? dir : -dir;
    }
    return a.key.localeCompare(b.key);
  });
  const limit = Math.min(opts.limit ?? REPORT_LIMITS.maxRows, REPORT_LIMITS.maxRows);
  const truncated = list.length > limit;
  const rowCount = list.length;
  list = list.slice(0, limit);
  const projectLabels = config.filters.projectIds?.length ? [...(await dimensionLabels(ctx, 'project', config.filters.projectIds)).values()] : [];
  const notes: string[] = [];
  if (defs.some((d) => !d.additive) && dims.length) notes.push('Rates, medians and averages are computed per row from their own records; rows of such metrics do not add up to the total.');
  if (rp.elapsedOnly) notes.push('The period is not finished yet: values cover the elapsed part only.');
  return {
    columns: [
      ...dims.map((d) => ({ key: d, label: DIMENSION_LABELS[d], kind: 'dimension' as const })),
      ...defs.map((d) => ({ key: d.id, label: d.label, kind: 'metric' as const, unit: d.unit, description: d.description, additive: d.additive })),
    ],
    rows: list,
    totals: Object.fromEntries(defs.map((d, i) => [d.id, results[i]!.total])),
    rowCount,
    truncated,
    period: periodDto(rp),
    asOf: ctx.app.clock.now().toISOString(),
    scopeSummary: scopeSummaryOf(ctx, config, spec, { projects: projectLabels }),
    formulas: defs.map((d) => ({ key: d.id, label: d.label, description: d.description })),
    notes,
    period$: rp,
  };
};

/** "Updated source data is available": source rows in the member's scope changed after the as-of time. */
export const reportSourceChangedSince = async (ctx: Ctx, dataset: ReportDatasetKey, asOf: Date): Promise<boolean> => {
  const spec = REPORT_DATASET_SPECS[dataset];
  if (!spec) return false;
  const wide = listFilter(ctx.actor.access, spec.sourcePermission).kind === 'all';
  for (const s of spec.sources) {
    if (!s.projectId && !wide) continue;
    const scope: SQL | undefined = s.projectId ? scopePredicate(ctx, spec.sourcePermission, { projectId: s.projectId }) : undefined;
    const [r] = await dbOf(ctx)
      .select({ one: sql<number>`1` })
      .from(s.table as never)
      .where(and(eq(s.table.workspaceId, ctx.actor.workspaceId), gt(s.table.updatedAt, asOf), scope))
      .limit(1);
    if (r) return true;
  }
  return false;
};

export const memberNames = async (ctx: Ctx, ids: string[]) => loadMemberRefs(dbOf(ctx), ctx.actor.workspaceId, ids);
