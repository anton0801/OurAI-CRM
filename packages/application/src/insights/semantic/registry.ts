import { and, eq, inArray } from 'drizzle-orm';
import { hasAnywhere } from '@castlane/authorization';
import {
  bucketKeyOf,
  fillSeries,
  groupRecords,
  tupleKey,
  type GroupRow,
  type MetricUnit,
  type MetricValue,
  type Period,
  type TimeGrain,
} from '@castlane/analytics';
import { campaigns, directions, financeCategories, projects } from '@castlane/database';
import { AppError, METRIC_DIMENSIONS, forbidden, type EnumValue } from '@castlane/domain';
import { dbOf } from '../../core/context';
import { loadMemberRefs } from '../../core/members';
import { defineMetric, type MetricDimension, type MetricFilters, type MetricQuery, type MetricResult } from '../../core/metric-registry';
import { loadAccounts, loadPublications, projectDirections, type Ctx } from '../common';

export type DimKey = EnumValue<typeof METRIC_DIMENSIONS>;
export type MetricFamily = 'production' | 'accounts' | 'content' | 'ofm' | 'team' | 'finance' | 'coverage';

/** Common record shape: dimension values of one source record (plus metric-specific measures). */
export interface BaseRec {
  projectId?: string | null;
  accountId?: string | null;
  platform?: string | null;
  format?: string | null;
  memberId?: string | null;
  campaignId?: string | null;
  publicationId?: string | null;
  category?: string | null;
  currency?: string | null;
  status?: string | null;
  priority?: string | null;
  stage?: string | null;
  /** Time used for the period dimension (buckets in the member's zone). */
  at?: Date | null;
}

export interface InsightQuery extends MetricQuery {
  filters: MetricFilters;
  /** Checkpoint window used by publication metrics (default pub_24h). */
  checkpointKey?: string;
}

export interface DrillRef {
  entityType: string;
  id: string;
  projectId: string | null;
  accountId: string | null;
  at: Date | null;
  value: string | null;
}

export interface InsightMetric<R extends BaseRec = BaseRec> {
  id: string;
  key: string;
  label: string;
  /** Formula in plain language (tooltip, report formulas summary). */
  description: string;
  unit: MetricUnit;
  rate?: boolean;
  higherIsBetter?: boolean;
  /** Measures a change within the period (followers change, net growth): goals take Absolute targets only. */
  measuresChange?: boolean;
  family: MetricFamily;
  /** Analytics permission; its scope is applied in SQL inside `load`. */
  permission: string;
  /** Additional sensitive permissions the member must hold (finance amounts, compensation). */
  requires?: string[];
  dimensions: DimKey[];
  grains: TimeGrain[];
  definitionVersion?: number;
  /** Counts and sums: group values add up to the total (stacked bars and "Other" are allowed). */
  additive: boolean;
  /** A group or bucket without records is a known zero (record counts) instead of a gap. */
  zeroWhenEmpty?: boolean;
  load(ctx: Ctx, q: InsightQuery): Promise<R[]>;
  reduce(rows: R[], q: InsightQuery): MetricValue;
  /** Source records behind the value (Drill Down); the read permission is checked per record. */
  drill?: { readPermission: string | string[]; ref(r: R): DrillRef | null };
  /** Latest source time for freshness ("source age"). */
  sourceAt?(r: R): Date | null;
}

export const INSIGHT_METRICS = new Map<string, InsightMetric<any>>();

const toCoreDimension = (d: DimKey) => d as MetricDimension;

/** Register a semantic metric (also into the core registry, so goals/overview use the same formula). */
export const defineInsightMetric = <R extends BaseRec>(d: InsightMetric<R>) => {
  INSIGHT_METRICS.set(d.id, d);
  defineMetric({
    id: d.id,
    key: d.key,
    label: d.label,
    description: d.description,
    unit: d.unit,
    rate: d.rate,
    higherIsBetter: d.higherIsBetter,
    measuresChange: d.measuresChange,
    permission: d.permission,
    dimensions: d.dimensions.map(toCoreDimension),
    grains: d.grains,
    definitionVersion: d.definitionVersion ?? 1,
    compute: (ctx, q) => computeInsight(ctx, d, q as InsightQuery),
  });
};

export const insightMetric = (id: string): InsightMetric => {
  const d = INSIGHT_METRICS.get(id);
  if (!d) throw new AppError('NOT_FOUND', `Unknown metric ${id}.`);
  return d;
};

/** May the member use the metric at all (module permission + sensitive requirements)? */
export const canUseMetric = (ctx: Ctx, d: InsightMetric) => hasAnywhere(ctx.actor.access, d.permission) && (d.requires ?? []).every((p) => hasAnywhere(ctx.actor.access, p));

export const assertMetricAccess = (ctx: Ctx, d: InsightMetric) => {
  if (!canUseMetric(ctx, d)) throw forbidden('You do not have access to this metric.');
};

export const availableInsightMetrics = (ctx: Ctx) => [...INSIGHT_METRICS.values()].filter((d) => canUseMetric(ctx, d)).sort((a, b) => a.id.localeCompare(b.id));

const FIELD_OF: Partial<Record<DimKey, keyof BaseRec>> = {
  project: 'projectId',
  account: 'accountId',
  platform: 'platform',
  format: 'format',
  member: 'memberId',
  campaign: 'campaignId',
  publication: 'publicationId',
  category: 'category',
  currency: 'currency',
  status: 'status',
  priority: 'priority',
  stage: 'stage',
};

export const dimensionValue = (r: BaseRec, dim: DimKey, grain: TimeGrain, zone: string, dirs: ReadonlyMap<string, string>): string | null => {
  if (dim === 'period') return r.at ? bucketKeyOf(r.at, grain, zone) : null;
  if (dim === 'direction') return r.projectId ? (dirs.get(r.projectId) ?? null) : null;
  const f = FIELD_OF[dim];
  const v = f ? r[f] : null;
  return typeof v === 'string' ? v : null;
};

/** Group records of a metric by dimensions (facts reduced per group; never multiplied by joins). */
export const groupInsight = async <R extends BaseRec>(ctx: Ctx, d: InsightMetric<R>, q: InsightQuery, rows: R[], dims: DimKey[]): Promise<GroupRow[]> => {
  const dirs = dims.includes('direction') ? await projectDirections(ctx) : new Map<string, string>();
  const grain = q.grain ?? 'week';
  const groups = groupRecords(rows, dims, (r, dim) => dimensionValue(r, dim as DimKey, grain, q.period.zone, dirs), (rs) => d.reduce(rs, q));
  if (d.zeroWhenEmpty || dims.length === 0) return groups;
  return groups;
};

const maxAt = <R extends BaseRec>(d: InsightMetric<R>, rows: R[]) => {
  if (!d.sourceAt) return null;
  let best: Date | null = null;
  for (const r of rows) {
    const t = d.sourceAt(r);
    if (t && (!best || t > best)) best = t;
  }
  return best;
};

export interface InsightResult extends MetricResult {
  groups?: { key: string; label: string; value: MetricValue }[];
}

/** Evaluate a metric: total, optional series (gaps for missing buckets) and one breakdown. */
export const computeInsight = async <R extends BaseRec>(ctx: Ctx, d: InsightMetric<R>, q: InsightQuery): Promise<InsightResult> => {
  assertMetricAccess(ctx, d);
  if (q.groupBy && !d.dimensions.includes(q.groupBy as DimKey)) throw new AppError('VALIDATION_FAILED', `${d.label} cannot be broken down by ${q.groupBy}.`);
  if (q.grain && !d.grains.includes(q.grain)) throw new AppError('VALIDATION_FAILED', `${d.label} has no ${q.grain} series.`);
  const rows = await d.load(ctx, q);
  const total = d.reduce(rows, q);
  const out: InsightResult = { total, sourceAsOf: maxAt(d, rows)?.toISOString() ?? null };
  if (q.grain) {
    const g = await groupInsight(ctx, d, { ...q, grain: q.grain }, rows, ['period']);
    out.series = fillSeries(g, q.period, q.grain, { zeroCount: !!d.zeroWhenEmpty, unit: d.unit });
  }
  if (q.groupBy) {
    const g = await groupInsight(ctx, d, q, rows, [q.groupBy as DimKey]);
    const labels = await dimensionLabels(ctx, q.groupBy as DimKey, g.map((x) => x.dims[q.groupBy!] ?? null));
    out.groups = g.map((x) => {
      const k = x.dims[q.groupBy!] ?? null;
      return { key: k ?? '', label: k === null ? noneLabel(q.groupBy as DimKey) : (labels.get(k) ?? k), value: x.value };
    });
  }
  return out;
};

/** Rows of a metric grouped by up to three dimensions (report builder). */
export const groupedInsight = async (ctx: Ctx, id: string, q: InsightQuery, dims: DimKey[]) => {
  const d = insightMetric(id);
  assertMetricAccess(ctx, d);
  const rows = await d.load(ctx, q);
  const groups = await groupInsight(ctx, d, q, rows, dims);
  return { metric: d, groups, total: d.reduce(rows, q), rows, sourceAsOf: maxAt(d, rows) };
};

export const emptyValueFor = (d: InsightMetric): MetricValue =>
  d.zeroWhenEmpty ? { status: 'known', value: '0', unit: d.unit, sampleSize: 0 } : { status: 'no_data', value: null, unit: d.unit };

export const noneLabel = (dim: DimKey) =>
  dim === 'project' ? 'No project' : dim === 'account' ? 'No account' : dim === 'member' ? 'Unassigned' : dim === 'campaign' ? 'No campaign' : dim === 'category' ? 'Uncategorised' : dim === 'direction' ? 'No direction' : 'Not set';

const ENUM_LABELS: Record<string, Record<string, string>> = {
  platform: { instagram: 'Instagram', tiktok: 'TikTok', youtube: 'YouTube', x: 'X', onlyfans: 'OnlyFans', fansly: 'Fansly', other: 'Custom' },
};

const humanize = (k: string) => k.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

/** Human labels for dimension keys (names are read inside the workspace; ids never leak other tenants). */
export const dimensionLabels = async (ctx: Ctx, dim: DimKey, keys: (string | null)[]): Promise<Map<string, string>> => {
  const ids = [...new Set(keys.filter((k): k is string => !!k))];
  const out = new Map<string, string>();
  if (!ids.length) return out;
  const db = dbOf(ctx);
  const ws = ctx.actor.workspaceId;
  switch (dim) {
    case 'project': {
      const rows = await db.select({ id: projects.id, name: projects.name }).from(projects).where(and(eq(projects.workspaceId, ws), inArray(projects.id, ids)));
      for (const r of rows) out.set(r.id, r.name);
      break;
    }
    case 'direction': {
      const rows = await db.select({ id: directions.id, name: directions.name }).from(directions).where(and(eq(directions.workspaceId, ws), inArray(directions.id, ids)));
      for (const r of rows) out.set(r.id, r.name);
      break;
    }
    case 'account': {
      for (const [id, a] of await loadAccounts(db, ws, ids)) out.set(id, a.label);
      break;
    }
    case 'member': {
      for (const [id, m] of await loadMemberRefs(db, ws, ids)) out.set(id, m.displayName);
      break;
    }
    case 'campaign': {
      const rows = await db.select({ id: campaigns.id, name: campaigns.name }).from(campaigns).where(and(eq(campaigns.workspaceId, ws), inArray(campaigns.id, ids)));
      for (const r of rows) out.set(r.id, r.name);
      break;
    }
    case 'publication': {
      const pubs = await loadPublications(db, ws, ids);
      const accs = await loadAccounts(db, ws, [...pubs.values()].map((p) => p.accountId));
      for (const [id, p] of pubs) out.set(id, `${p.title} · ${accs.get(p.accountId)?.label ?? 'account'}`);
      break;
    }
    case 'category': {
      const rows = await db.select({ id: financeCategories.id, name: financeCategories.name }).from(financeCategories).where(and(eq(financeCategories.workspaceId, ws), inArray(financeCategories.id, ids)));
      for (const r of rows) out.set(r.id, r.name);
      break;
    }
    case 'period':
    case 'currency':
      for (const k of ids) out.set(k, k);
      break;
    default:
      for (const k of ids) out.set(k, ENUM_LABELS[dim]?.[k] ?? humanize(k));
  }
  return out;
};

export { tupleKey };
export type { GroupRow, Period };
