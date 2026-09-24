import { z } from 'zod';
import {
  ANALYTICS_TABS,
  CHECKPOINT_INBOX_TABS,
  CHECKPOINT_STATES,
  CHECKPOINT_TIMING,
  CONTENT_FORMATS,
  LIMITS,
  METRIC_DIMENSIONS,
  METRIC_ENTITY_TYPES,
  METRIC_INPUT_LIMITS,
  METRIC_QUALITY_STATES,
  METRIC_SEGMENTS,
  METRIC_SOURCE_TYPES,
  METRIC_UNITS,
  METRIC_VALUE_STATUSES,
  OBSERVATION_DATASETS,
  OBSERVATION_KINDS,
  PERIOD_PRESETS,
  PLATFORMS,
  REPORT_CADENCES,
  REPORT_CHART_TYPES,
  REPORT_DATASETS,
  REPORT_LIMITS,
  REPORT_SHARING,
  TIME_GRAINS,
  VALUE_AVAILABILITY,
} from '@castlane/domain';
import { endpoint } from './core';
import {
  boolQuery,
  csv,
  currencyCode,
  isoDate,
  isoDateTime,
  memberRef,
  page,
  pageQuery,
  reason,
  shortName,
  timezone,
  uuid,
  wsId,
} from './common';

// ——— Shared value shapes ———

/** A computed metric value with explicit availability (R17: unknown is never shown as zero). */
export const metricValue = z.object({
  status: z.enum(METRIC_VALUE_STATUSES),
  /** Decimal string; null unless status is known or partial. */
  value: z.string().nullable(),
  unit: z.enum(METRIC_UNITS),
  currency: z.string().optional(),
  sampleSize: z.number().int().optional(),
  excluded: z.array(z.object({ count: z.number().int(), reason: z.string() })).optional(),
  missing: z.array(z.string()).optional(),
  coverage: z.object({ usable: z.number().int(), expected: z.number().int() }).optional(),
  note: z.string().optional(),
});
export type MetricValueDto = z.infer<typeof metricValue>;

const fieldIssue = z.object({ field: z.string(), code: z.string(), message: z.string() });

export const metricEntityRef = z.object({
  type: z.enum(METRIC_ENTITY_TYPES),
  id: uuid,
  label: z.string(),
  sublabel: z.string().nullable(),
  accountId: uuid,
  projectId: uuid,
  publicationId: uuid.nullable(),
  platform: z.enum(PLATFORMS).nullable(),
  /** Workspace-relative link to the source entity (Open Source Entity). */
  href: z.string(),
});
export type MetricEntityRef = z.infer<typeof metricEntityRef>;

// ——— Catalogue (metric definitions) ———

export const metricFieldDefinition = z.object({
  id: uuid,
  key: z.string(),
  version: z.number().int(),
  label: z.string(),
  description: z.string(),
  entityType: z.enum(METRIC_ENTITY_TYPES),
  observationKind: z.enum(OBSERVATION_KINDS),
  unit: z.string(),
  valueType: z.enum(['integer', 'decimal', 'money', 'duration_seconds']),
  aggregation: z.enum(['sum_non_overlapping', 'last_snapshot', 'checkpoint_value', 'none']),
  active: z.boolean(),
});
export type MetricFieldDefinition = z.infer<typeof metricFieldDefinition>;

export const METRIC_FAMILIES = ['production', 'accounts', 'content', 'ofm', 'team', 'finance', 'coverage'] as const;

export const semanticMetric = z.object({
  /** Catalogue id (M01–M42) or an additional dashboard figure (X01…). */
  id: z.string(),
  key: z.string(),
  label: z.string(),
  /** Formula in plain language (tooltip). */
  description: z.string(),
  unit: z.enum(METRIC_UNITS),
  rate: z.boolean(),
  family: z.enum(METRIC_FAMILIES),
  dimensions: z.array(z.enum(METRIC_DIMENSIONS)),
  grains: z.array(z.enum(TIME_GRAINS)),
  definitionVersion: z.number().int(),
  additive: z.boolean(),
});
export type SemanticMetric = z.infer<typeof semanticMetric>;

export const observationDataset = z.object({
  key: z.enum(OBSERVATION_DATASETS),
  label: z.string(),
  description: z.string(),
  entityType: z.enum(METRIC_ENTITY_TYPES),
  kind: z.enum(OBSERVATION_KINDS),
  fields: z.array(z.string()),
});

export const metricCatalog = z.object({
  fields: z.array(metricFieldDefinition),
  datasets: z.array(observationDataset),
  definitionSets: z.array(z.object({ version: z.number().int(), label: z.string(), current: z.boolean() })),
  semantic: z.array(semanticMetric),
});
export type MetricCatalog = z.infer<typeof metricCatalog>;

// ——— Observations (S50) ———

export const observationValueInput = z.object({
  metricKey: z.string().min(3).max(80),
  availability: z.enum(VALUE_AVAILABILITY),
  /** Required when availability is known; a 0 is only ever an explicit input. */
  value: z.string().trim().max(40).nullable().optional(),
  currency: currencyCode.nullable().optional(),
});
export type ObservationValueInput = z.infer<typeof observationValueInput>;

export const observationInput = z.object({
  entityType: z.enum(METRIC_ENTITY_TYPES),
  /** Account id (account / ofm_account) or publication id. */
  entityId: uuid,
  kind: z.enum(OBSERVATION_KINDS),
  observedAt: isoDateTime,
  periodStart: isoDateTime.nullable().optional(),
  periodEnd: isoDateTime.nullable().optional(),
  platformTimezone: timezone.nullable().optional(),
  definitionSetVersion: z.number().int().min(1).max(1000).default(1),
  segment: z.enum(METRIC_SEGMENTS).default('unknown'),
  sourceType: z.enum(METRIC_SOURCE_TYPES),
  sourceNamespace: z.string().trim().min(1).max(60).default('manual'),
  sourceNote: z.string().trim().min(3, 'Describe where the numbers come from.').max(LIMITS.noteMax),
  evidenceAssetIds: z.array(uuid).max(METRIC_INPUT_LIMITS.maxEvidence).default([]),
  values: z.array(observationValueInput).min(1).max(40),
  /** Required when the entry has warnings (§15.3). */
  warningNote: z.string().trim().max(LIMITS.reasonMax).nullable().optional(),
  checkpointId: uuid.nullable().optional(),
});
export type ObservationInput = z.input<typeof observationInput>;

export const observationValue = z.object({
  metricKey: z.string(),
  label: z.string(),
  unit: z.string(),
  valueType: z.string(),
  availability: z.enum(VALUE_AVAILABILITY),
  value: z.string().nullable(),
  currency: z.string().nullable(),
});
export type ObservationValue = z.infer<typeof observationValue>;

const checkpointBrief = z.object({ id: uuid, key: z.string(), label: z.string(), timing: z.enum(CHECKPOINT_TIMING).nullable(), expectedAt: isoDateTime });

export const observationSummary = z.object({
  id: uuid,
  rootObservationId: uuid,
  revisionNo: z.number().int(),
  entity: metricEntityRef,
  dataset: z.enum(OBSERVATION_DATASETS),
  kind: z.enum(OBSERVATION_KINDS),
  observedAt: isoDateTime,
  periodStart: isoDateTime.nullable(),
  periodEnd: isoDateTime.nullable(),
  platformTimezone: z.string().nullable(),
  definitionSetVersion: z.number().int(),
  segment: z.enum(METRIC_SEGMENTS),
  sourceType: z.enum(METRIC_SOURCE_TYPES),
  sourceNamespace: z.string(),
  sourceNote: z.string(),
  enteredAt: isoDateTime,
  enteredBy: memberRef.nullable(),
  qualityState: z.enum(METRIC_QUALITY_STATES),
  canonical: z.boolean(),
  warnings: z.array(z.string()),
  checkpoint: checkpointBrief.nullable(),
  knownCount: z.number().int(),
  valueCount: z.number().int(),
  /** Headline values for tables (views, followers, …) — null stays null. */
  headline: z.array(z.object({ metricKey: z.string(), label: z.string(), availability: z.enum(VALUE_AVAILABILITY), value: z.string().nullable() })),
  hasPendingCorrection: z.boolean(),
  rowVersion: z.number().int(),
});
export type ObservationSummary = z.infer<typeof observationSummary>;

const valueDiff = z.object({
  metricKey: z.string(),
  label: z.string(),
  from: z.object({ availability: z.enum(VALUE_AVAILABILITY), value: z.string().nullable() }).nullable(),
  to: z.object({ availability: z.enum(VALUE_AVAILABILITY), value: z.string().nullable() }).nullable(),
});

export const observationDetail = observationSummary.extend({
  values: z.array(observationValue),
  warningNote: z.string().nullable(),
  correctionReason: z.string().nullable(),
  supersedesId: uuid.nullable(),
  reviewedBy: memberRef.nullable(),
  reviewedAt: isoDateTime.nullable(),
  completeness: metricValue.nullable(),
  evidence: z.array(z.object({ assetId: uuid, name: z.string(), thumbnailUrl: z.string().nullable(), status: z.string().nullable() })),
  revisions: z.array(
    z.object({
      id: uuid,
      revisionNo: z.number().int(),
      qualityState: z.enum(METRIC_QUALITY_STATES),
      enteredAt: isoDateTime,
      enteredBy: memberRef.nullable(),
      correctionReason: z.string().nullable(),
      reviewedBy: memberRef.nullable(),
      reviewedAt: isoDateTime.nullable(),
      current: z.boolean(),
    }),
  ),
  pendingCorrection: z
    .object({
      id: uuid,
      revisionNo: z.number().int(),
      enteredBy: memberRef.nullable(),
      enteredAt: isoDateTime,
      correctionReason: z.string().nullable(),
      sourceNote: z.string(),
      rowVersion: z.number().int(),
      diff: z.array(valueDiff),
    })
    .nullable(),
  /** Other sources reporting the same key (one canonical selection is used by reports). */
  alternates: z.array(z.object({ id: uuid, sourceNamespace: z.string(), sourceType: z.enum(METRIC_SOURCE_TYPES), canonical: z.boolean(), enteredAt: isoDateTime })),
  /** Overlapping period observations of the same entity/segment (never summed together). */
  conflicts: z.array(z.object({ id: uuid, periodStart: isoDateTime.nullable(), periodEnd: isoDateTime.nullable(), sourceNamespace: z.string(), canonical: z.boolean() })),
  permissions: z.object({ revise: z.boolean(), approve: z.boolean(), markReviewed: z.boolean(), setCanonical: z.boolean() }),
});
export type ObservationDetail = z.infer<typeof observationDetail>;

export const observationValidation = z.object({
  ok: z.boolean(),
  errors: z.array(fieldIssue),
  warnings: z.array(fieldIssue),
  /** Same key already recorded: offer Create Revision (Submit Correction) or Skip — never a silent replacement. */
  duplicate: z.object({ observationId: uuid, qualityState: z.enum(METRIC_QUALITY_STATES), sourceNamespace: z.string() }).nullable(),
  checkpoint: checkpointBrief.nullable(),
  completeness: metricValue.nullable(),
  requiresWarningNote: z.boolean(),
});
export type ObservationValidation = z.infer<typeof observationValidation>;

export const correctionInput = z.object({
  values: z.array(observationValueInput).min(1).max(40),
  reason,
  sourceType: z.enum(METRIC_SOURCE_TYPES).optional(),
  sourceNote: z.string().trim().min(3).max(LIMITS.noteMax).optional(),
  evidenceAssetIds: z.array(uuid).max(METRIC_INPUT_LIMITS.maxEvidence).optional(),
  warningNote: z.string().trim().max(LIMITS.reasonMax).nullable().optional(),
});

// ——— Checkpoints / Metrics Inbox (S49) ———

export const CHECKPOINT_STATUS = ['upcoming', 'due', 'overdue', 'completed', 'missing', 'cancelled'] as const;

export const checkpointRow = z.object({
  id: uuid,
  entity: metricEntityRef,
  checkpointKey: z.string(),
  label: z.string(),
  policyVersion: z.number().int(),
  expectedAt: isoDateTime,
  windowStart: isoDateTime,
  windowEnd: isoDateTime,
  state: z.enum(CHECKPOINT_STATES),
  status: z.enum(CHECKPOINT_STATUS),
  timing: z.enum(CHECKPOINT_TIMING).nullable(),
  observationId: uuid.nullable(),
  observedAt: isoDateTime.nullable(),
  enteredAt: isoDateTime.nullable(),
  reporter: memberRef.nullable(),
  source: z.object({ type: z.enum(METRIC_SOURCE_TYPES), namespace: z.string() }).nullable(),
  completeness: metricValue.nullable(),
  assignee: memberRef.nullable(),
  missingReason: z.string().nullable(),
  requiredMetrics: z.array(z.string()),
  rowVersion: z.number().int(),
  permissions: z.object({ addMetrics: z.boolean(), markMissing: z.boolean() }),
});
export type CheckpointRow = z.infer<typeof checkpointRow>;

export const reviewQueueItem = z.object({
  kind: z.enum(['correction', 'conflict', 'unverified']),
  observation: observationSummary,
  pendingRevisionId: uuid.nullable(),
  pendingRowVersion: z.number().int().nullable(),
  submittedBy: memberRef.nullable(),
  submittedAt: isoDateTime,
  reason: z.string().nullable(),
});
export type ReviewQueueItem = z.infer<typeof reviewQueueItem>;

const metricsScopeQuery = {
  entityType: z.enum(METRIC_ENTITY_TYPES).optional(),
  accountId: uuid.optional(),
  projectId: uuid.optional(),
  publicationId: uuid.optional(),
};

// ——— Analytics (S51) ———

export const periodQuery = z.object({
  preset: z.enum(PERIOD_PRESETS).default('last_30_days'),
  from: isoDate.optional(),
  to: isoDate.optional(),
  compare: boolQuery.optional(),
});

const analyticsFilterShape = {
  directionId: uuid.optional(),
  projectIds: csv(uuid).optional(),
  accountIds: csv(uuid).optional(),
  platforms: csv(z.enum(PLATFORMS)).optional(),
  formats: csv(z.enum(CONTENT_FORMATS)).optional(),
  memberIds: csv(uuid).optional(),
};

export const analyticsFilters = z.object({
  directionId: uuid.optional(),
  projectIds: z.array(uuid).max(200).optional(),
  accountIds: z.array(uuid).max(200).optional(),
  platforms: z.array(z.enum(PLATFORMS)).max(20).optional(),
  formats: z.array(z.enum(CONTENT_FORMATS)).max(20).optional(),
  memberIds: z.array(uuid).max(200).optional(),
  statuses: z.array(z.string().max(40)).max(20).optional(),
});
export type AnalyticsFilters = z.infer<typeof analyticsFilters>;

export const resolvedPeriod = z.object({
  preset: z.enum(PERIOD_PRESETS),
  fromDate: isoDate,
  toDate: isoDate,
  start: isoDateTime,
  end: isoDateTime,
  zone: z.string(),
  /** The period is unfinished: comparisons use the same elapsed window (T117). */
  elapsedOnly: z.boolean(),
});

export const metricDelta = z.object({
  status: z.enum(['known', 'no_comparison']),
  abs: z.string().nullable(),
  pct: z.string().nullable(),
  /** Rates compare in percentage points. */
  unitLabel: z.enum(['pp', 'unit']),
});

export const analyticsKpi = z.object({
  metricId: z.string(),
  label: z.string(),
  description: z.string(),
  unit: z.enum(METRIC_UNITS),
  rate: z.boolean(),
  higherIsBetter: z.boolean().nullable(),
  value: metricValue,
  previous: metricValue.nullable(),
  delta: metricDelta.nullable(),
  sourceAsOf: isoDateTime.nullable(),
  drillable: z.boolean(),
});
export type AnalyticsKpi = z.infer<typeof analyticsKpi>;

export const analyticsChart = z.object({
  key: z.string(),
  title: z.string(),
  description: z.string(),
  kind: z.enum(['line', 'bar', 'stacked_bar']),
  unit: z.enum(METRIC_UNITS),
  xKind: z.enum(['time', 'category']),
  series: z.array(z.object({ key: z.string(), label: z.string(), metricId: z.string() })).max(6),
  points: z.array(z.object({ x: z.string(), label: z.string(), values: z.record(z.string(), metricValue) })),
  note: z.string().nullable(),
});
export type AnalyticsChart = z.infer<typeof analyticsChart>;

export const analyticsCell = z.object({
  text: z.string().nullable().optional(),
  value: metricValue.optional(),
  at: isoDateTime.nullable().optional(),
  href: z.string().nullable().optional(),
  tone: z.enum(['neutral', 'warning', 'danger', 'success', 'info']).optional(),
});

export const analyticsTable = z.object({
  key: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  columns: z.array(z.object({ key: z.string(), label: z.string(), kind: z.enum(['text', 'metric', 'date', 'status']), metricId: z.string().optional() })),
  rows: z.array(z.object({ key: z.string(), href: z.string().nullable(), cells: z.record(z.string(), analyticsCell) })),
  note: z.string().nullable(),
});
export type AnalyticsTable = z.infer<typeof analyticsTable>;

export const analyticsDashboard = z.object({
  tab: z.enum(ANALYTICS_TABS),
  period: resolvedPeriod,
  comparison: z.object({ fromDate: isoDate, toDate: isoDate, start: isoDateTime, end: isoDateTime, elapsedOnly: z.boolean() }).nullable(),
  asOf: isoDateTime,
  grain: z.enum(TIME_GRAINS),
  kpis: z.array(analyticsKpi),
  charts: z.array(analyticsChart),
  tables: z.array(analyticsTable),
  freshness: z.object({ lastObservedAt: isoDateTime.nullable(), lastEnteredAt: isoDateTime.nullable() }).nullable(),
  notes: z.array(z.string()),
  /** No source records at all in scope: show the explanatory empty state, never fake charts (T169). */
  empty: z.boolean(),
  availableTabs: z.array(z.enum(ANALYTICS_TABS)),
  /**
   * Read model the figures were served from (spec §28.3): when they were computed and whether a
   * refresh is pending because source data changed since. `live` = computed for this request.
   */
  snapshot: z
    .object({ computedAt: isoDateTime, ageSeconds: z.number().int(), refreshPending: z.boolean(), live: z.boolean() })
    .nullable()
    .optional(),
});
export type AnalyticsDashboard = z.infer<typeof analyticsDashboard>;

export const analyticsQueryResult = z.object({
  period: resolvedPeriod,
  results: z.array(
    z.object({
      metricId: z.string(),
      label: z.string(),
      description: z.string(),
      unit: z.enum(METRIC_UNITS),
      rate: z.boolean(),
      total: metricValue,
      previous: metricValue.nullable(),
      delta: metricDelta.nullable(),
      series: z.array(z.object({ bucket: z.string(), value: metricValue })).nullable(),
      groups: z.array(z.object({ key: z.string().nullable(), label: z.string(), value: metricValue })).nullable(),
      sourceAsOf: isoDateTime.nullable(),
    }),
  ),
});
export type AnalyticsQueryResult = z.infer<typeof analyticsQueryResult>;

export const drillDownResult = z.object({
  metricId: z.string(),
  label: z.string(),
  description: z.string(),
  items: z.array(
    z.object({
      entityType: z.string(),
      entityId: uuid,
      label: z.string(),
      sublabel: z.string().nullable(),
      at: isoDateTime.nullable(),
      value: z.string().nullable(),
      href: z.string(),
    }),
  ),
  total: z.number().int(),
  /** Records the member cannot open are not listed. */
  hidden: z.number().int(),
  truncated: z.boolean(),
});
export type DrillDownResult = z.infer<typeof drillDownResult>;

// ——— Report builder (S52) ———

export const reportDatePolicy = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('relative'), preset: z.enum(PERIOD_PRESETS).exclude(['custom']) }),
  z.object({ kind: z.literal('fixed'), from: isoDate, to: isoDate }),
]);

export const reportConfig = z.object({
  dataset: z.enum(REPORT_DATASETS),
  dimensions: z.array(z.enum(METRIC_DIMENSIONS)).max(REPORT_LIMITS.maxDimensions).default([]),
  metrics: z.array(z.string().min(1).max(60)).min(1, 'Choose at least one metric.').max(REPORT_LIMITS.maxMetrics),
  filters: analyticsFilters.default({}),
  timeGrain: z.enum(TIME_GRAINS).default('week'),
  sort: z.array(z.object({ key: z.string().max(60), direction: z.enum(['asc', 'desc']) })).max(3).default([]),
  chart: z.enum(REPORT_CHART_TYPES).default('table'),
  datePolicy: reportDatePolicy.default({ kind: 'relative', preset: 'last_30_days' }),
});
export type ReportConfig = z.infer<typeof reportConfig>;
export type ReportConfigInput = z.input<typeof reportConfig>;

export const reportDatasetInfo = z.object({
  key: z.enum(REPORT_DATASETS),
  label: z.string(),
  description: z.string(),
  /** Sharing a restricted dataset requires a project filter (§17). */
  restricted: z.boolean(),
  dimensions: z.array(z.object({ key: z.enum(METRIC_DIMENSIONS), label: z.string() })),
  /** Each metric lists the dimensions it can be broken down by (the allowed join graph). */
  metrics: z.array(z.object({ key: z.string(), label: z.string(), description: z.string(), unit: z.enum(METRIC_UNITS), rate: z.boolean(), additive: z.boolean(), dimensions: z.array(z.enum(METRIC_DIMENSIONS)), timeSeries: z.boolean() })),
  filters: z.array(z.enum(['directionId', 'projectIds', 'accountIds', 'platforms', 'formats', 'memberIds', 'statuses'])),
  statusOptions: z.array(z.object({ value: z.string(), label: z.string() })),
});
export type ReportDatasetInfo = z.infer<typeof reportDatasetInfo>;

export const reportResult = z.object({
  columns: z.array(
    z.object({ key: z.string(), label: z.string(), kind: z.enum(['dimension', 'metric']), unit: z.enum(METRIC_UNITS).optional(), description: z.string().optional(), additive: z.boolean().optional() }),
  ),
  rows: z.array(
    z.object({
      key: z.string(),
      dims: z.record(z.string(), z.object({ id: z.string().nullable(), label: z.string() })),
      values: z.record(z.string(), metricValue),
    }),
  ),
  totals: z.record(z.string(), metricValue),
  rowCount: z.number().int(),
  truncated: z.boolean(),
  period: resolvedPeriod,
  asOf: isoDateTime,
  scopeSummary: z.string(),
  formulas: z.array(z.object({ key: z.string(), label: z.string(), description: z.string() })),
  notes: z.array(z.string()),
});
export type ReportResult = z.infer<typeof reportResult>;

export const reportScheduleRow = z.object({
  id: uuid,
  reportId: uuid,
  reportName: z.string(),
  cadence: z.enum(REPORT_CADENCES),
  recipients: z.array(memberRef),
  owner: memberRef,
  localTime: z.string(),
  timezone: z.string(),
  nextRunAt: isoDateTime,
  lastRunAt: isoDateTime.nullable(),
  status: z.enum(['active', 'paused', 'paused_needs_owner']),
  pausedReason: z.string().nullable(),
  emailNotify: z.boolean(),
  lastRunResult: z.object({ delivered: z.number().int(), skipped: z.array(z.object({ membershipId: uuid, reason: z.string() })), at: isoDateTime }).nullable(),
  rowVersion: z.number().int(),
  permissions: z.object({ edit: z.boolean() }),
});
export type ReportScheduleRow = z.infer<typeof reportScheduleRow>;

export const reportSummary = z.object({
  id: uuid,
  name: z.string(),
  dataset: z.enum(REPORT_DATASETS),
  owner: memberRef,
  own: z.boolean(),
  sharing: z.enum(REPORT_SHARING),
  configVersion: z.number().int(),
  scheduled: z.boolean(),
  lastSnapshotAt: isoDateTime.nullable(),
  archivedAt: isoDateTime.nullable(),
  updatedAt: isoDateTime,
  rowVersion: z.number().int(),
});
export type ReportSummary = z.infer<typeof reportSummary>;

export const reportDetail = reportSummary.extend({
  config: reportConfig,
  sharedWith: z.array(memberRef),
  duplicatedFromId: uuid.nullable(),
  schedules: z.array(reportScheduleRow),
  /** The dataset is no longer available to the member (permissions changed). */
  datasetAvailable: z.boolean(),
  permissions: z.object({ edit: z.boolean(), share: z.boolean(), schedule: z.boolean(), archive: z.boolean(), duplicate: z.boolean(), snapshot: z.boolean(), export: z.boolean() }),
});
export type ReportDetail = z.infer<typeof reportDetail>;

export const reportSnapshotSummary = z.object({
  id: uuid,
  reportId: uuid,
  reportName: z.string(),
  configVersion: z.number().int(),
  asOf: isoDateTime,
  fromDate: isoDate,
  toDate: isoDate,
  rowCount: z.number().int(),
  scheduled: z.boolean(),
  sourceRevised: z.boolean(),
  createdAt: isoDateTime,
});
export type ReportSnapshotSummary = z.infer<typeof reportSnapshotSummary>;

export const reportSnapshotDetail = reportSnapshotSummary.extend({
  config: reportConfig,
  generatedFor: memberRef,
  result: reportResult,
  /** Source data changed after the as-of time ("Updated source data is available. Refresh this report."). */
  stale: z.boolean(),
});
export type ReportSnapshotDetail = z.infer<typeof reportSnapshotDetail>;

const runOverrides = z.object({
  datePolicy: reportDatePolicy.optional(),
  filters: analyticsFilters.optional(),
});

const localTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use the HH:MM format.');

// ——— Endpoints ———

const W = { auth: 'workspace' as const };

export const metricsEndpoints = {
  catalog: endpoint({
    id: 'metrics.catalog',
    method: 'GET',
    path: '/workspaces/{workspaceId}/metric-definitions',
    summary: 'Metric catalogue: observation fields per dataset (versioned) and the semantic metrics M01–M42 the member may use.',
    tags: ['Metrics'],
    ...W,
    permission: 'metrics.read',
    params: wsId({}),
    response: metricCatalog,
  }),
  definition: endpoint({
    id: 'metrics.definition',
    method: 'GET',
    path: '/workspaces/{workspaceId}/metric-definitions/{definitionId}',
    summary: 'One observation field definition (key, unit, aggregation, time semantics, version).',
    tags: ['Metrics'],
    ...W,
    permission: 'metrics.read',
    params: wsId({ definitionId: uuid }),
    response: metricFieldDefinition,
  }),
  observations: endpoint({
    id: 'metrics.observations',
    method: 'GET',
    path: '/workspaces/{workspaceId}/metric-observations',
    summary: 'Observations in scope (current revisions by default), newest observation first.',
    tags: ['Metrics'],
    ...W,
    permission: 'metrics.read',
    params: wsId({}),
    query: pageQuery.extend({
      ...metricsScopeQuery,
      kind: z.enum(OBSERVATION_KINDS).optional(),
      quality: csv(z.enum(METRIC_QUALITY_STATES)).optional(),
      sourceType: z.enum(METRIC_SOURCE_TYPES).optional(),
      from: isoDateTime.optional(),
      to: isoDateTime.optional(),
      includeHistory: boolQuery.optional(),
    }),
    response: page(observationSummary),
  }),
  validate: endpoint({
    id: 'metrics.validate',
    method: 'POST',
    path: '/workspaces/{workspaceId}/metric-observations/validate',
    summary: 'Preflight check of an entry: errors, warnings needing a note, duplicate key, checkpoint timing. Changes nothing.',
    tags: ['Metrics'],
    ...W,
    permission: 'metrics.write',
    params: wsId({}),
    body: observationInput,
    response: observationValidation,
  }),
  create: endpoint({
    id: 'metrics.create',
    method: 'POST',
    path: '/workspaces/{workspaceId}/metric-observations',
    summary: 'Save one observation (values, source, evidence). Completes the matching checkpoint with the real observed time.',
    tags: ['Metrics'],
    ...W,
    permission: 'metrics.write',
    idempotent: true,
    params: wsId({}),
    body: observationInput,
    response: observationDetail,
    successStatus: 201,
  }),
  bulk: endpoint({
    id: 'metrics.bulk',
    method: 'POST',
    path: '/workspaces/{workspaceId}/metric-observations/bulk',
    summary: 'Bulk entry grid: each row is saved or rejected on its own (per-row result); duplicates are reported, never replaced.',
    tags: ['Metrics'],
    ...W,
    permission: 'metrics.write',
    idempotent: true,
    params: wsId({}),
    body: z.object({ rows: z.array(observationInput).min(1).max(METRIC_INPUT_LIMITS.bulkRows) }),
    response: z.object({
      created: z.number().int(),
      failed: z.number().int(),
      results: z.array(z.object({ index: z.number().int(), ok: z.boolean(), observationId: uuid.nullable(), errors: z.array(fieldIssue), duplicateOf: uuid.nullable() })),
    }),
  }),
  get: endpoint({
    id: 'metrics.get',
    method: 'GET',
    path: '/workspaces/{workspaceId}/metric-observations/{observationId}',
    summary: 'Observation with values, provenance, evidence, revision history and a pending correction diff.',
    tags: ['Metrics'],
    ...W,
    permission: 'metrics.read',
    params: wsId({ observationId: uuid }),
    response: observationDetail,
  }),
  revise: endpoint({
    id: 'metrics.revise',
    method: 'POST',
    path: '/workspaces/{workspaceId}/metric-observations/{observationId}/revisions',
    summary: 'Submit Correction: a new revision awaiting review; the current values stay in use until it is approved.',
    tags: ['Metrics'],
    ...W,
    permission: 'metrics.revise',
    idempotent: true,
    ifMatch: true,
    params: wsId({ observationId: uuid }),
    body: correctionInput,
    response: observationDetail,
    successStatus: 201,
  }),
  approveRevision: endpoint({
    id: 'metrics.approveRevision',
    method: 'POST',
    path: '/workspaces/{workspaceId}/metric-revisions/{revisionId}/approve',
    summary: 'Approve Correction: the revision becomes canonical, the previous one Superseded (never summed).',
    tags: ['Metrics'],
    ...W,
    permission: 'metrics.approve',
    idempotent: true,
    ifMatch: true,
    params: wsId({ revisionId: uuid }),
    body: z.object({ decisionNote: z.string().trim().max(LIMITS.reasonMax).optional() }),
    response: observationDetail,
  }),
  rejectRevision: endpoint({
    id: 'metrics.rejectRevision',
    method: 'POST',
    path: '/workspaces/{workspaceId}/metric-revisions/{revisionId}/reject',
    summary: 'Reject a correction with a reason; the current values stay unchanged.',
    tags: ['Metrics'],
    ...W,
    permission: 'metrics.approve',
    idempotent: true,
    ifMatch: true,
    params: wsId({ revisionId: uuid }),
    body: z.object({ reason }),
    response: observationDetail,
  }),
  markReviewed: endpoint({
    id: 'metrics.markReviewed',
    method: 'POST',
    path: '/workspaces/{workspaceId}/metric-observations/{observationId}/mark-reviewed',
    summary: 'Mark an unverified observation as a reviewed source record.',
    tags: ['Metrics'],
    ...W,
    permission: 'metrics.approve',
    idempotent: true,
    ifMatch: true,
    params: wsId({ observationId: uuid }),
    body: z.object({ note: z.string().trim().max(LIMITS.reasonMax).optional() }),
    response: observationDetail,
  }),
  setCanonical: endpoint({
    id: 'metrics.setCanonical',
    method: 'POST',
    path: '/workspaces/{workspaceId}/metric-observations/{observationId}/canonical',
    summary: 'Choose which source is used by reports (Use in Reports / Exclude from Reports), e.g. to resolve overlapping periods.',
    tags: ['Metrics'],
    ...W,
    permission: 'metrics.revise',
    idempotent: true,
    ifMatch: true,
    params: wsId({ observationId: uuid }),
    body: z.object({ canonical: z.boolean(), reason }),
    response: observationDetail,
  }),
  checkpoints: endpoint({
    id: 'metrics.checkpoints',
    method: 'GET',
    path: '/workspaces/{workspaceId}/metric-checkpoints',
    summary: 'Metrics Inbox: expected checkpoints by tab (Due, Overdue, Upcoming, Submitted, Missing).',
    tags: ['Metrics'],
    ...W,
    permission: 'metrics.read',
    params: wsId({}),
    query: pageQuery.extend({ tab: z.enum(CHECKPOINT_INBOX_TABS).default('due'), ...metricsScopeQuery, mine: boolQuery.optional() }),
    response: page(checkpointRow),
  }),
  checkpoint: endpoint({
    id: 'metrics.checkpoint',
    method: 'GET',
    path: '/workspaces/{workspaceId}/metric-checkpoints/{checkpointId}',
    summary: 'One checkpoint with its window, state and observation.',
    tags: ['Metrics'],
    ...W,
    permission: 'metrics.read',
    params: wsId({ checkpointId: uuid }),
    response: checkpointRow,
  }),
  markMissing: endpoint({
    id: 'metrics.markMissing',
    method: 'POST',
    path: '/workspaces/{workspaceId}/metric-checkpoints/{checkpointId}/mark-missing',
    summary: 'Mark Unavailable: closes the request as Missing with a reason; no zero values are created.',
    tags: ['Metrics'],
    ...W,
    permission: 'metrics.write',
    idempotent: true,
    ifMatch: true,
    params: wsId({ checkpointId: uuid }),
    body: z.object({ reason }),
    response: checkpointRow,
  }),
  inboxSummary: endpoint({
    id: 'metrics.inboxSummary',
    method: 'GET',
    path: '/workspaces/{workspaceId}/metrics/inbox-summary',
    summary: 'Counts per Metrics Inbox tab, scoped to the member.',
    tags: ['Metrics'],
    ...W,
    permission: 'metrics.read',
    params: wsId({}),
    query: z.object({ mine: boolQuery.optional() }),
    response: z.object({ due: z.number().int(), overdue: z.number().int(), upcoming: z.number().int(), submitted: z.number().int(), missing: z.number().int(), needsReview: z.number().int() }),
  }),
  reviewQueue: endpoint({
    id: 'metrics.reviewQueue',
    method: 'GET',
    path: '/workspaces/{workspaceId}/metrics/review-queue',
    summary: 'Needs Review: corrections awaiting approval, overlapping period conflicts and unverified entries saved with warnings.',
    tags: ['Metrics'],
    ...W,
    permission: 'metrics.read',
    params: wsId({}),
    query: z.object({ ...metricsScopeQuery, limit: z.coerce.number().int().min(1).max(200).default(100) }),
    response: z.array(reviewQueueItem),
  }),
  myCheckpoints: endpoint({
    id: 'metrics.myCheckpoints',
    method: 'GET',
    path: '/workspaces/{workspaceId}/metrics/my-checkpoints',
    summary: 'My Work → Metric Checkpoints: checkpoints assigned to me (overdue, due, upcoming 7 days).',
    tags: ['Metrics'],
    ...W,
    params: wsId({}),
    response: z.object({ overdue: z.array(checkpointRow), due: z.array(checkpointRow), upcoming: z.array(checkpointRow), canRead: z.boolean() }),
  }),
  accountMetrics: endpoint({
    id: 'metrics.accountMetrics',
    method: 'GET',
    path: '/workspaces/{workspaceId}/accounts/{accountId}/metrics',
    summary: 'Account Detail → Metrics: follower snapshots (chart + table), period observations, freshness and open checkpoints.',
    tags: ['Metrics'],
    ...W,
    permission: 'metrics.read',
    params: wsId({ accountId: uuid }),
    query: z.object({ from: isoDate.optional(), to: isoDate.optional() }),
    response: z.object({
      account: z.object({ id: uuid, label: z.string(), platform: z.enum(PLATFORMS), projectId: uuid, metricsCadence: z.string(), ofm: z.boolean() }),
      fromDate: isoDate,
      toDate: isoDate,
      followers: z.object({
        points: z.array(z.object({ observationId: uuid, observedAt: isoDateTime, availability: z.enum(VALUE_AVAILABILITY), value: z.string().nullable(), segment: z.enum(METRIC_SEGMENTS), sourceNamespace: z.string() })),
        change: metricValue,
        growth: metricValue,
        first: z.object({ observedAt: isoDateTime, value: z.string() }).nullable(),
        last: z.object({ observedAt: isoDateTime, value: z.string() }).nullable(),
      }),
      snapshots: z.array(observationSummary),
      periodObservations: z.array(observationSummary),
      freshness: z.object({ lastObservedAt: isoDateTime.nullable(), lastEnteredAt: isoDateTime.nullable(), nextExpectedAt: isoDateTime.nullable(), overdue: z.boolean() }),
      checkpoints: z.array(checkpointRow),
      permissions: z.object({ addMetrics: z.boolean() }),
    }),
  }),
  publicationMetrics: endpoint({
    id: 'metrics.publicationMetrics',
    method: 'GET',
    path: '/workspaces/{workspaceId}/publications/{publicationId}/metrics',
    summary: 'Checkpoints and cumulative observations of one publication.',
    tags: ['Metrics'],
    ...W,
    permission: 'metrics.read',
    params: wsId({ publicationId: uuid }),
    response: z.object({ checkpoints: z.array(checkpointRow), observations: z.array(observationSummary), permissions: z.object({ addMetrics: z.boolean() }) }),
  }),
  contentResults: endpoint({
    id: 'metrics.contentResults',
    method: 'GET',
    path: '/workspaces/{workspaceId}/metrics/content/{contentItemId}',
    summary: 'Results of every published placement of a content item: checkpoints and the latest cumulative values (Content Detail → Results).',
    tags: ['Metrics'],
    ...W,
    permission: 'metrics.read',
    params: wsId({ contentItemId: uuid }),
    response: z.object({
      placements: z.array(
        z.object({
          publication: metricEntityRef,
          publishedAt: isoDateTime.nullable(),
          checkpoints: z.array(checkpointRow),
          latest: observationSummary.nullable(),
          addMetrics: z.boolean(),
        }),
      ),
      /** Placements on accounts outside the member's metrics scope (not listed). */
      hidden: z.number().int(),
    }),
  }),
};

export const analyticsEndpoints = {
  dashboard: endpoint({
    id: 'analytics.dashboard',
    method: 'GET',
    path: '/workspaces/{workspaceId}/analytics/dashboards/{tab}',
    summary: 'Dashboard tab (Production, Accounts, Content, OFM, Team, Finance): KPIs with comparison, charts and source tables in scope.',
    tags: ['Analytics'],
    ...W,
    params: wsId({ tab: z.enum(ANALYTICS_TABS) }),
    query: periodQuery.extend({
      ...analyticsFilterShape,
      grain: z.enum(TIME_GRAINS).optional(),
      chartMetric: z.string().max(10).optional(),
      /** Compute from the source records now (and update the read model) instead of serving the stored figures. */
      refresh: boolQuery.optional(),
    }),
    response: analyticsDashboard,
    rateLimit: 'expensive',
  }),
  query: endpoint({
    id: 'analytics.query',
    method: 'POST',
    path: '/workspaces/{workspaceId}/analytics/query',
    summary: 'Typed semantic-layer query (read-only): metric totals, comparison, series and one breakdown.',
    tags: ['Analytics'],
    ...W,
    params: wsId({}),
    body: z.object({
      metrics: z.array(z.string().min(2).max(10)).min(1).max(REPORT_LIMITS.maxMetrics),
      period: z.object({ preset: z.enum(PERIOD_PRESETS), from: isoDate.optional(), to: isoDate.optional() }),
      compare: z.boolean().default(false),
      filters: analyticsFilters.default({}),
      groupBy: z.enum(METRIC_DIMENSIONS).optional(),
      grain: z.enum(TIME_GRAINS).optional(),
    }),
    response: analyticsQueryResult,
    rateLimit: 'expensive',
  }),
  drillDown: endpoint({
    id: 'analytics.drillDown',
    method: 'GET',
    path: '/workspaces/{workspaceId}/analytics/drill-down',
    summary: 'Source records behind a metric value (Drill Down), limited to records the member may open.',
    tags: ['Analytics'],
    ...W,
    params: wsId({}),
    query: periodQuery.extend({ metric: z.string().min(2).max(10), ...analyticsFilterShape, groupDimension: z.enum(METRIC_DIMENSIONS).optional(), groupKey: z.string().max(80).optional() }),
    response: drillDownResult,
  }),
};

export const reportEndpoints = {
  datasets: endpoint({
    id: 'reports.datasets',
    method: 'GET',
    path: '/workspaces/{workspaceId}/report-datasets',
    summary: 'Datasets of the semantic layer with their allowed dimensions, metrics and filters (only permitted combinations).',
    tags: ['Reports'],
    ...W,
    permission: 'reports.read',
    params: wsId({}),
    response: z.array(reportDatasetInfo),
  }),
  preview: endpoint({
    id: 'reports.preview',
    method: 'POST',
    path: '/workspaces/{workspaceId}/reports/preview',
    summary: 'Live preview of an unsaved configuration (first rows only). Read-only.',
    tags: ['Reports'],
    ...W,
    permission: 'reports.create',
    params: wsId({}),
    body: z.object({ config: reportConfig }),
    response: reportResult,
    rateLimit: 'expensive',
  }),
  list: endpoint({
    id: 'reports.list',
    method: 'GET',
    path: '/workspaces/{workspaceId}/reports',
    summary: 'Saved reports the member owns or that are shared with them.',
    tags: ['Reports'],
    ...W,
    permission: 'reports.read',
    params: wsId({}),
    query: pageQuery.extend({ q: z.string().max(100).optional(), scope: z.enum(['all', 'mine', 'shared']).default('all'), includeArchived: boolQuery.optional() }),
    response: page(reportSummary),
  }),
  create: endpoint({
    id: 'reports.create',
    method: 'POST',
    path: '/workspaces/{workspaceId}/reports',
    summary: 'Save a report configuration (version 1).',
    tags: ['Reports'],
    ...W,
    permission: 'reports.create',
    idempotent: true,
    params: wsId({}),
    body: z.object({ name: shortName, config: reportConfig }),
    response: reportDetail,
    successStatus: 201,
  }),
  get: endpoint({
    id: 'reports.get',
    method: 'GET',
    path: '/workspaces/{workspaceId}/reports/{reportId}',
    summary: 'Saved report configuration, sharing and schedules.',
    tags: ['Reports'],
    ...W,
    permission: 'reports.read',
    params: wsId({ reportId: uuid }),
    response: reportDetail,
  }),
  update: endpoint({
    id: 'reports.update',
    method: 'PATCH',
    path: '/workspaces/{workspaceId}/reports/{reportId}',
    summary: 'Change name or configuration; each change is a new configuration version.',
    tags: ['Reports'],
    ...W,
    permission: 'reports.create',
    ifMatch: true,
    params: wsId({ reportId: uuid }),
    body: z.object({ name: shortName.optional(), config: reportConfig.optional(), changeNote: z.string().trim().max(500).optional() }),
    response: reportDetail,
  }),
  versions: endpoint({
    id: 'reports.versions',
    method: 'GET',
    path: '/workspaces/{workspaceId}/reports/{reportId}/versions',
    summary: 'Configuration history of a saved report.',
    tags: ['Reports'],
    ...W,
    permission: 'reports.read',
    params: wsId({ reportId: uuid }),
    response: z.array(z.object({ versionNo: z.number().int(), name: z.string(), config: reportConfig, changeNote: z.string().nullable(), createdAt: isoDateTime, createdBy: memberRef.nullable() })),
  }),
  duplicate: endpoint({
    id: 'reports.duplicate',
    method: 'POST',
    path: '/workspaces/{workspaceId}/reports/{reportId}/duplicate',
    summary: 'Duplicate a report as a new private report owned by the member.',
    tags: ['Reports'],
    ...W,
    permission: 'reports.create',
    idempotent: true,
    params: wsId({ reportId: uuid }),
    body: z.object({ name: shortName.optional() }),
    response: reportDetail,
    successStatus: 201,
  }),
  share: endpoint({
    id: 'reports.share',
    method: 'POST',
    path: '/workspaces/{workspaceId}/reports/{reportId}/share',
    summary: 'Share Internally with members. Sharing never grants access to source data: each viewer sees their own permitted result.',
    tags: ['Reports'],
    ...W,
    permission: 'reports.share',
    idempotent: true,
    ifMatch: true,
    params: wsId({ reportId: uuid }),
    body: z.object({ sharing: z.enum(REPORT_SHARING), memberIds: z.array(uuid).max(200).default([]) }),
    response: reportDetail,
  }),
  archive: endpoint({
    id: 'reports.archive',
    method: 'POST',
    path: '/workspaces/{workspaceId}/reports/{reportId}/archive',
    summary: 'Archive a saved report; its schedules pause and snapshots stay available.',
    tags: ['Reports'],
    ...W,
    permission: 'reports.create',
    idempotent: true,
    ifMatch: true,
    params: wsId({ reportId: uuid }),
    body: z.object({ reason: reason.optional() }),
    response: reportDetail,
  }),
  restore: endpoint({
    id: 'reports.restore',
    method: 'POST',
    path: '/workspaces/{workspaceId}/reports/{reportId}/restore',
    summary: 'Restore an archived report (schedules stay paused until resumed).',
    tags: ['Reports'],
    ...W,
    permission: 'reports.create',
    idempotent: true,
    ifMatch: true,
    params: wsId({ reportId: uuid }),
    response: reportDetail,
  }),
  run: endpoint({
    id: 'reports.run',
    method: 'POST',
    path: '/workspaces/{workspaceId}/reports/{reportId}/run',
    summary: 'Run the saved report for the member (their own scope), optionally for another period. Read-only.',
    tags: ['Reports'],
    ...W,
    permission: 'reports.read',
    params: wsId({ reportId: uuid }),
    body: runOverrides,
    response: reportResult,
    rateLimit: 'expensive',
  }),
  snapshot: endpoint({
    id: 'reports.snapshot',
    method: 'POST',
    path: '/workspaces/{workspaceId}/reports/{reportId}/snapshots',
    summary: 'Save an immutable snapshot of the member’s result with as-of time and source bounds.',
    tags: ['Reports'],
    ...W,
    permission: 'reports.read',
    idempotent: true,
    params: wsId({ reportId: uuid }),
    body: runOverrides,
    response: reportSnapshotDetail,
    successStatus: 201,
  }),
  reportSnapshots: endpoint({
    id: 'reports.reportSnapshots',
    method: 'GET',
    path: '/workspaces/{workspaceId}/reports/{reportId}/snapshots',
    summary: 'My snapshots of one report (manual and scheduled).',
    tags: ['Reports'],
    ...W,
    permission: 'reports.read',
    params: wsId({ reportId: uuid }),
    response: z.array(reportSnapshotSummary),
  }),
  snapshots: endpoint({
    id: 'reports.snapshots',
    method: 'GET',
    path: '/workspaces/{workspaceId}/report-snapshots',
    summary: 'All snapshots generated for me (including scheduled Inbox deliveries).',
    tags: ['Reports'],
    ...W,
    permission: 'reports.read',
    params: wsId({}),
    query: pageQuery,
    response: page(reportSnapshotSummary),
  }),
  snapshotGet: endpoint({
    id: 'reports.snapshotGet',
    method: 'GET',
    path: '/workspaces/{workspaceId}/report-snapshots/{snapshotId}',
    summary: 'One immutable snapshot (only the member it was generated for can open it).',
    tags: ['Reports'],
    ...W,
    permission: 'reports.read',
    params: wsId({ snapshotId: uuid }),
    response: reportSnapshotDetail,
  }),
  snapshotPdf: endpoint({
    id: 'reports.snapshotPdf',
    method: 'GET',
    path: '/workspaces/{workspaceId}/report-snapshots/{snapshotId}/pdf',
    summary: 'PDF of a snapshot: title, period, scope, as-of, formulas summary, coverage and page numbers.',
    tags: ['Reports'],
    ...W,
    permission: 'exports.download',
    params: wsId({ snapshotId: uuid }),
    /** Raw application/pdf stream. */
    response: z.any(),
    rateLimit: 'download',
  }),
  schedules: endpoint({
    id: 'reports.schedules',
    method: 'GET',
    path: '/workspaces/{workspaceId}/report-schedules',
    summary: 'Scheduled Inbox snapshots the member owns (or of one report).',
    tags: ['Reports'],
    ...W,
    permission: 'reports.schedule',
    params: wsId({}),
    query: z.object({ reportId: uuid.optional() }),
    response: z.array(reportScheduleRow),
  }),
  scheduleCreate: endpoint({
    id: 'reports.scheduleCreate',
    method: 'POST',
    path: '/workspaces/{workspaceId}/report-schedules',
    summary: 'Schedule Inbox Snapshot (daily/weekly/monthly). Each recipient receives their own permission-filtered result.',
    tags: ['Reports'],
    ...W,
    permission: 'reports.schedule',
    idempotent: true,
    params: wsId({}),
    body: z.object({
      reportId: uuid,
      cadence: z.enum(REPORT_CADENCES),
      recipientMembershipIds: z.array(uuid).min(1, 'Choose at least one recipient.').max(REPORT_LIMITS.maxRecipients),
      localTime: localTime.default('08:00'),
      timezone,
      emailNotify: z.boolean().default(false),
    }),
    response: reportScheduleRow,
    successStatus: 201,
  }),
  scheduleGet: endpoint({
    id: 'reports.scheduleGet',
    method: 'GET',
    path: '/workspaces/{workspaceId}/report-schedules/{scheduleId}',
    summary: 'One report schedule.',
    tags: ['Reports'],
    ...W,
    permission: 'reports.schedule',
    params: wsId({ scheduleId: uuid }),
    response: reportScheduleRow,
  }),
  scheduleUpdate: endpoint({
    id: 'reports.scheduleUpdate',
    method: 'PATCH',
    path: '/workspaces/{workspaceId}/report-schedules/{scheduleId}',
    summary: 'Change cadence, time, recipients or e-mail notice (recipients are re-checked).',
    tags: ['Reports'],
    ...W,
    permission: 'reports.schedule',
    ifMatch: true,
    params: wsId({ scheduleId: uuid }),
    body: z.object({
      cadence: z.enum(REPORT_CADENCES).optional(),
      recipientMembershipIds: z.array(uuid).min(1).max(REPORT_LIMITS.maxRecipients).optional(),
      localTime: localTime.optional(),
      timezone: timezone.optional(),
      emailNotify: z.boolean().optional(),
    }),
    response: reportScheduleRow,
  }),
  schedulePause: endpoint({
    id: 'reports.schedulePause',
    method: 'POST',
    path: '/workspaces/{workspaceId}/report-schedules/{scheduleId}/pause',
    summary: 'Pause a schedule.',
    tags: ['Reports'],
    ...W,
    permission: 'reports.schedule',
    idempotent: true,
    ifMatch: true,
    params: wsId({ scheduleId: uuid }),
    response: reportScheduleRow,
  }),
  scheduleResume: endpoint({
    id: 'reports.scheduleResume',
    method: 'POST',
    path: '/workspaces/{workspaceId}/report-schedules/{scheduleId}/resume',
    summary: 'Resume a paused schedule (the current owner takes over a schedule that needed an owner).',
    tags: ['Reports'],
    ...W,
    permission: 'reports.schedule',
    idempotent: true,
    ifMatch: true,
    params: wsId({ scheduleId: uuid }),
    response: reportScheduleRow,
  }),
};
