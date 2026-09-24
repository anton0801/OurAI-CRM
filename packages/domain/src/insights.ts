import { defineEnum } from './enums';

/**
 * Insights vocabularies (metrics collection, semantic layer, analytics, report builder — spec
 * §15–§17). The API contracts and UI labels derive from these arrays.
 */

/** Availability of a computed metric value (R17: unknown is never shown as zero). */
export const METRIC_VALUE_STATUSES = defineEnum([
  'known',
  'partial',
  'no_data',
  'not_defined',
  'not_enough_data',
  'not_measured',
  'not_attributable',
  'pending',
  'not_applicable',
  'not_comparable',
] as const);

export const METRIC_UNITS = defineEnum(['count', 'percent', 'hours', 'seconds', 'money', 'ratio', 'score', 'number'] as const);

export const ANALYTICS_TABS = defineEnum(['production', 'accounts', 'content', 'ofm', 'team', 'finance'] as const);

export const PERIOD_PRESETS = defineEnum([
  'today',
  'last_7_days',
  'last_30_days',
  'last_90_days',
  'this_week',
  'last_week',
  'this_month',
  'last_month',
  'this_quarter',
  'last_quarter',
  'this_year',
  'custom',
] as const);

export const TIME_GRAINS = defineEnum(['day', 'week', 'month', 'quarter'] as const);

/** Breakdown dimensions offered by the semantic layer (reports allow up to three). */
export const METRIC_DIMENSIONS = defineEnum([
  'period',
  'project',
  'direction',
  'account',
  'platform',
  'format',
  'member',
  'campaign',
  'publication',
  'category',
  'currency',
  'status',
  'priority',
  'stage',
] as const);

export const REPORT_DATASETS = defineEnum(['tasks', 'content', 'publications', 'account_metrics', 'ofm', 'finance'] as const);
export const REPORT_CHART_TYPES = defineEnum(['table', 'line', 'bar', 'stacked_bar'] as const);
export const REPORT_SHARING = defineEnum(['private', 'shared'] as const);

/** Metrics Inbox tabs (S49). */
export const CHECKPOINT_INBOX_TABS = defineEnum(['due', 'overdue', 'upcoming', 'submitted', 'missing', 'all'] as const);

/** Observation datasets (§15.2): entity type + time semantics decide the permitted fields. */
export const OBSERVATION_DATASETS = defineEnum(['account_snapshot', 'account_period', 'publication_cumulative', 'ofm_period'] as const);

/** Per-row conflict choice for the metric observations import (F09): Skip or Create Revision. */
export const METRIC_IMPORT_CONFLICT_ACTIONS = defineEnum(['skip', 'create_revision'] as const);

/** Limits of the report builder (§17). */
export const REPORT_LIMITS = { maxDimensions: 3, maxMetrics: 8, maxRows: 500, previewRows: 50, maxRecipients: 50 } as const;

/** Inputs of the metric entry form (§15.3). */
export const METRIC_INPUT_LIMITS = {
  /** Counters are integers 0 … 9×10^15. */
  counterMax: '9000000000000000',
  /** Observed At may run ahead of the server clock by at most 5 minutes. */
  futureToleranceMinutes: 5,
  maxEvidence: 10,
  bulkRows: 100,
} as const;
