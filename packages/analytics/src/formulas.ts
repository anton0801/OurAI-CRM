import Big from 'big.js';
import { ROUND_HALF_EVEN, toBig } from '@castlane/domain';
import { hasValue, known, unavailable, type MetricUnit, type MetricValue } from './value';

type Dec = string | number | bigint | Big;
const isZero = (d: Dec) => toBig(d).eq(0);
const fmt = (b: Big, dp: number) => b.round(dp, ROUND_HALF_EVEN).toFixed(dp);

/** Count as a known value (a real zero count is known — R17 is about unknown inputs, not zero results). */
export const countValue = (n: number, extra: Partial<MetricValue> = {}): MetricValue => known(String(n), 'count', { sampleSize: n, ...extra });

/**
 * numerator / denominator × 100. Missing inputs → no_data; denominator 0 → not_defined. Values may
 * exceed 100 (ER by views can) — never clamped.
 */
export const percentValue = (numerator: Dec | null | undefined, denominator: Dec | null | undefined, dp = 2, extra: Partial<MetricValue> = {}): MetricValue => {
  if (numerator == null || denominator == null) return unavailable('no_data', 'percent', extra);
  if (isZero(denominator)) return unavailable('not_defined', 'percent', extra);
  return known(fmt(toBig(numerator).div(toBig(denominator)).times(100), dp), 'percent', extra);
};

export const ratioValue = (numerator: Dec | null | undefined, denominator: Dec | null | undefined, unit: MetricUnit = 'ratio', dp = 4, extra: Partial<MetricValue> = {}): MetricValue => {
  if (numerator == null || denominator == null) return unavailable('no_data', unit, extra);
  if (isZero(denominator)) return unavailable('not_defined', unit, extra);
  return known(fmt(toBig(numerator).div(toBig(denominator)), dp), unit, extra);
};

/** Aggregate rate (M19): Σ eligible numerators / Σ eligible denominators — never the mean of percentages. */
export const weightedPercent = (
  rows: { numerator: Dec | null | undefined; denominator: Dec | null | undefined }[],
  dp = 2,
): MetricValue => {
  let num = new Big(0);
  let den = new Big(0);
  let eligible = 0;
  let excluded = 0;
  for (const r of rows) {
    if (r.numerator == null || r.denominator == null || isZero(r.denominator)) {
      excluded++;
      continue;
    }
    num = num.plus(toBig(r.numerator));
    den = den.plus(toBig(r.denominator));
    eligible++;
  }
  const extra: Partial<MetricValue> = { sampleSize: eligible, excluded: excluded ? [{ count: excluded, reason: 'Missing or zero denominator' }] : undefined };
  if (eligible === 0) return unavailable(rows.length ? 'not_defined' : 'no_data', 'percent', extra);
  return percentValue(num, den, dp, extra);
};

/** Sum where every input must be known; otherwise partial with the missing keys (M16 Interactions). */
export const sumOfKnown = (parts: Record<string, Dec | null | undefined>, unit: MetricUnit = 'count'): MetricValue => {
  const missing = Object.entries(parts)
    .filter(([, v]) => v == null)
    .map(([k]) => k);
  const present = Object.values(parts).filter((v): v is Dec => v != null);
  if (present.length === 0) return unavailable('no_data', unit, { missing });
  const total = present.reduce<Big>((acc, v) => acc.plus(toBig(v)), new Big(0)).toString();
  return missing.length ? { status: 'partial', value: total, unit, missing, note: 'Partial Interactions' } : known(total, unit);
};

/** Nearest-rank percentile (p in 0–100) of numeric strings/numbers; null for an empty sample. */
export const percentile = (values: Dec[], p: number): string | null => {
  if (values.length === 0) return null;
  const sorted = values.map(toBig).sort((a, b) => a.cmp(b));
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1]!.toString();
};

/** Median (average of the two middle values for even samples). */
export const median = (values: Dec[]): string | null => {
  if (values.length === 0) return null;
  const sorted = values.map(toBig).sort((a, b) => a.cmp(b));
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]!.toString() : sorted[mid - 1]!.plus(sorted[mid]!).div(2).toString();
};

export interface DurationStats {
  median: MetricValue;
  p90: MetricValue;
  sampleSize: number;
}

/** Median + p90 of durations (M04 lead time, M05 review turnaround). */
export const durationStats = (values: Dec[], unit: MetricUnit = 'hours', dp = 2, missingCount = 0): DurationStats => {
  const extra: Partial<MetricValue> = { sampleSize: values.length, excluded: missingCount ? [{ count: missingCount, reason: 'Missing start event' }] : undefined };
  if (values.length === 0) return { median: unavailable('no_data', unit, extra), p90: unavailable('no_data', unit, extra), sampleSize: 0 };
  return {
    median: known(fmt(toBig(median(values)!), dp), unit, extra),
    p90: known(fmt(toBig(percentile(values, 90)!), dp), unit, extra),
    sampleSize: values.length,
  };
};

/**
 * Delta between two cumulative snapshots of the same definition (M11/M15). A negative delta is a
 * source correction, not negative consumption (T107): returned as known with a note.
 */
export const cumulativeDelta = (first: Dec | null | undefined, last: Dec | null | undefined, unit: MetricUnit = 'count'): MetricValue => {
  if (first == null || last == null) return unavailable('not_enough_data', unit);
  const d = toBig(last).minus(toBig(first));
  return known(d.toString(), unit, d.lt(0) ? { note: 'Source Correction' } : {});
};

/** Growth % from the first snapshot (M12): first = 0 → not_defined (absolute change is shown separately, T111). */
export const growthPercent = (first: Dec | null | undefined, last: Dec | null | undefined, dp = 2): MetricValue => {
  if (first == null || last == null) return unavailable('not_enough_data', 'percent');
  if (isZero(first)) return unavailable('not_defined', 'percent');
  return known(fmt(toBig(last).minus(toBig(first)).div(toBig(first)).times(100), dp), 'percent');
};

/** Sum a known series; any value present → known; nothing → no_data (never 0 for "no records"). */
export const sumValues = (values: (Dec | null | undefined)[], unit: MetricUnit, extra: Partial<MetricValue> = {}): MetricValue => {
  const present = values.filter((v): v is Dec => v != null);
  if (present.length === 0) return unavailable('no_data', unit, extra);
  return known(present.reduce<Big>((a, v) => a.plus(toBig(v)), new Big(0)).toString(), unit, { sampleSize: present.length, ...extra });
};

export type GoalTargetType = 'absolute' | 'increase_by' | 'decrease_to';

/**
 * Goal progress (§17), as a percent value:
 *   absolute:    current / target
 *   increase_by: (current − baseline) / target_delta
 *   decrease_to: (baseline − current) / (baseline − target)
 * Denominator 0 → not_defined; baseline required for relative types; unknown current → no_data.
 */
export const goalProgress = (
  type: GoalTargetType,
  input: { current: Dec | null | undefined; target: Dec; baseline?: Dec | null },
  dp = 2,
): MetricValue => {
  const { current, target, baseline } = input;
  if (current == null) return unavailable('no_data', 'percent');
  if (type === 'absolute') return percentValue(current, target, dp);
  if (baseline == null) return unavailable('not_defined', 'percent', { note: 'Baseline required' });
  if (type === 'increase_by') return percentValue(toBig(current).minus(toBig(baseline)), target, dp);
  return percentValue(toBig(baseline).minus(toBig(current)), toBig(baseline).minus(toBig(target)), dp);
};

/** Pass-through helper for charts: value as number for plotting only (never for arithmetic). */
export const plotNumber = (v: MetricValue): number | null => (hasValue(v) ? Number(v.value) : null);
