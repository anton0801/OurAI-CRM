import type { MetricUnit, MetricValue, Period, TimeGrain } from '@castlane/analytics';
import { AppError } from '@castlane/domain';
import { hasAnywhere } from '@castlane/authorization';
import type { QueryContext } from './context';

/**
 * Semantic layer (§16): every dashboard, report, goal and Overview KPI reads metrics through this
 * registry, so formulas, null policy and permission scope are defined exactly once.
 * Definitions live with the insights module (M01–M42); the scope of the requesting member is applied
 * inside `compute` in SQL before aggregation (`scopePredicate`).
 */
export type MetricDimension =
  | 'project'
  | 'direction'
  | 'account'
  | 'platform'
  | 'format'
  | 'member'
  | 'campaign'
  | 'category'
  | 'currency'
  | 'shift_account'
  | 'period'
  | 'publication'
  | 'status'
  | 'priority'
  | 'stage';

export interface MetricFilters {
  directionIds?: string[];
  projectIds?: string[];
  accountIds?: string[];
  campaignIds?: string[];
  memberIds?: string[];
  platforms?: string[];
  formats?: string[];
  currency?: string;
  /** Record statuses (task status, stage…) where the metric supports it. */
  statuses?: string[];
}

export interface MetricQuery {
  period: Period;
  asOf: Date;
  filters: MetricFilters;
  /** Time series buckets (charts). */
  grain?: TimeGrain;
  /** One breakdown dimension (tables, stacked bars). */
  groupBy?: MetricDimension;
}

export interface MetricResult {
  total: MetricValue;
  series?: { bucket: string; value: MetricValue }[];
  groups?: { key: string; label: string; value: MetricValue }[];
  /** Where the underlying records can be opened (KPI → filtered source records). */
  drillDown?: { href: string; label: string };
  /** Source freshness: latest observation/record time used. */
  sourceAsOf?: string | null;
}

export interface MetricDefinition {
  /** Catalogue id, e.g. 'M01'. */
  id: string;
  key: string;
  label: string;
  /** Formula in plain language (tooltip). */
  description: string;
  unit: MetricUnit;
  /** Rates compare in percentage points. */
  rate?: boolean;
  /** The metric already measures a change within the period (e.g. followers change): goals may only use an Absolute target. */
  measuresChange?: boolean;
  higherIsBetter?: boolean;
  /** Member needs this permission somewhere; scope is applied inside compute. */
  permission: string;
  /** Extra sensitive permissions the member also needs somewhere (e.g. finance.read for revenue metrics, T016). */
  requires?: string[];
  dimensions: MetricDimension[];
  grains: TimeGrain[];
  definitionVersion: number;
  compute(ctx: QueryContext, q: MetricQuery): Promise<MetricResult>;
}

export const METRIC_DEFINITIONS = new Map<string, MetricDefinition>();

export const defineMetric = (d: MetricDefinition) => {
  METRIC_DEFINITIONS.set(d.id, d);
};

/** May the member use the metric at all: its module permission plus every sensitive requirement. */
export const canUseMetricDefinition = (ctx: QueryContext, d: Pick<MetricDefinition, 'permission' | 'requires'>) =>
  hasAnywhere(ctx.actor.access, d.permission) && (d.requires ?? []).every((p) => hasAnywhere(ctx.actor.access, p));

/** Metrics the member may see at all (catalogue lists, report builder). */
export const availableMetrics = (ctx: QueryContext) => [...METRIC_DEFINITIONS.values()].filter((d) => canUseMetricDefinition(ctx, d));

export const evaluateMetric = async (ctx: QueryContext, id: string, q: MetricQuery): Promise<MetricResult> => {
  const d = METRIC_DEFINITIONS.get(id);
  if (!d) throw new AppError('NOT_FOUND', `Unknown metric ${id}.`);
  if (!canUseMetricDefinition(ctx, d)) throw new AppError('FORBIDDEN', 'You do not have access to this metric.');
  if (q.groupBy && !d.dimensions.includes(q.groupBy)) throw new AppError('VALIDATION_FAILED', `${d.label} cannot be broken down by ${q.groupBy}.`);
  if (q.grain && !d.grains.includes(q.grain)) throw new AppError('VALIDATION_FAILED', `${d.label} has no ${q.grain} series.`);
  return d.compute(ctx, q);
};
