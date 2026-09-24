/**
 * Metric values with explicit availability (R17: missing data is never zero). Every number shown
 * on a dashboard, report or goal is one of these. `value` is a decimal string (never a float) and
 * is present only when `status` is 'known' or 'partial'.
 */
export const METRIC_STATUSES = [
  'known',
  /** Some inputs missing: value shown with the list of missing inputs (e.g. Partial Interactions). */
  'partial',
  /** No observation/record exists for the period ("No data recorded for this period."). */
  'no_data',
  /** Formula undefined, e.g. denominator 0 (ER with 0 views, growth from 0). */
  'not_defined',
  /** Fewer usable points than the formula needs (e.g. one follower snapshot). */
  'not_enough_data',
  /** The source does not provide the needed field/denominator (e.g. churn cohort). */
  'not_measured',
  /** No attribution link (e.g. revenue per shift hour without attributed sales). */
  'not_attributable',
  /** Waiting for an event (e.g. shift without end). */
  'pending',
  /** The metric does not apply (e.g. no required handovers). */
  'not_applicable',
  /** Not comparable windows/definitions (experiments with unequal post ages). */
  'not_comparable',
] as const;
export type MetricStatus = (typeof METRIC_STATUSES)[number];

export const METRIC_UNITS = ['count', 'percent', 'hours', 'seconds', 'money', 'ratio', 'score', 'number'] as const;
export type MetricUnit = (typeof METRIC_UNITS)[number];

export interface MetricValue {
  status: MetricStatus;
  /** Decimal string; null unless status is 'known' or 'partial'. */
  value: string | null;
  unit: MetricUnit;
  /** ISO currency for money values (one value per currency — never silently mixed). */
  currency?: string;
  /** Number of records/observations the value is built from. */
  sampleSize?: number;
  /** Records excluded (and why) — e.g. ineligible for aggregate ER, missing Ready event. */
  excluded?: { count: number; reason: string }[];
  /** Missing inputs for partial values (e.g. ['shares', 'saves']). */
  missing?: string[];
  /** Coverage of expected inputs, e.g. 8 of 10 accounts reported. */
  coverage?: { usable: number; expected: number };
  /** Human-readable qualifier shown next to the value (e.g. "Sum of Account Followers", "Late"). */
  note?: string;
}

export const known = (value: string, unit: MetricUnit, extra: Partial<MetricValue> = {}): MetricValue => ({ status: 'known', value, unit, ...extra });

export const unavailable = (status: Exclude<MetricStatus, 'known' | 'partial'>, unit: MetricUnit, extra: Partial<MetricValue> = {}): MetricValue => ({
  status,
  value: null,
  unit,
  ...extra,
});

export const hasValue = (v: MetricValue): v is MetricValue & { value: string } => (v.status === 'known' || v.status === 'partial') && v.value !== null;

/** Labels used in the UI for unavailable states (spec §31.2 microcopy where it exists). */
export const STATUS_LABELS: Record<MetricStatus, string> = {
  known: '',
  partial: 'Partial',
  no_data: 'No data recorded for this period.',
  not_defined: 'Not Defined',
  not_enough_data: 'Not Enough Data',
  not_measured: 'Not Measured',
  not_attributable: 'Not Attributable',
  pending: 'Pending',
  not_applicable: 'Not Applicable',
  not_comparable: 'Not Comparable',
};
