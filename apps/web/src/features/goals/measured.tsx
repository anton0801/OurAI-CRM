'use client';
import type { GoalMeasuredValue } from '@castlane/api-contracts';
import { formatNumber } from '@castlane/ui';

/**
 * Metric values with explicit availability (R17): unavailable states are words, never 0.
 * Microcopy from spec §31.2 where it exists.
 */
export const UNAVAILABLE_TEXT: Record<GoalMeasuredValue['status'], string> = {
  known: '',
  partial: 'Partial',
  no_data: 'No data recorded for this period.',
  not_defined: 'This rate cannot be calculated from the available data.',
  not_enough_data: 'Not Enough Data',
  not_measured: 'Not Measured',
  not_attributable: 'Not Attributable',
  pending: 'Pending',
  not_applicable: 'Not Applicable',
  not_comparable: 'Not Comparable',
};

export const SHORT_UNAVAILABLE: Record<GoalMeasuredValue['status'], string> = {
  ...UNAVAILABLE_TEXT,
  no_data: 'No Data',
  not_defined: 'Not Defined',
};

const UNIT_SUFFIX: Record<string, string> = { hours: 'h', seconds: 's', percent: '%' };

export const hasMeasuredValue = (v: GoalMeasuredValue) => (v.status === 'known' || v.status === 'partial') && v.value !== null;

/** Format a measured value for display; `short` uses compact labels for unavailable states. */
export const formatMeasured = (v: GoalMeasuredValue, opts: { short?: boolean; unit?: boolean } = {}) => {
  if (!hasMeasuredValue(v)) return opts.short ? SHORT_UNAVAILABLE[v.status] : UNAVAILABLE_TEXT[v.status];
  const n = formatNumber(v.value, { maximumFractionDigits: v.unit === 'count' ? 0 : 2 });
  if (v.unit === 'money' && v.currency) return `${n} ${v.currency}`;
  if (opts.unit === false) return n;
  if (v.unit === 'percent') return `${n}%`;
  const suffix = UNIT_SUFFIX[v.unit];
  return suffix ? `${n} ${suffix}` : n;
};

/** Compact rendering: value or a muted availability word. */
export const MeasuredValue = ({ value, className }: { value: GoalMeasuredValue; className?: string }) =>
  hasMeasuredValue(value) ? (
    <span className={className}>{formatMeasured(value)}</span>
  ) : (
    <span className={`${className ?? ''} text-fg-muted`} title={UNAVAILABLE_TEXT[value.status]}>
      {SHORT_UNAVAILABLE[value.status]}
    </span>
  );
