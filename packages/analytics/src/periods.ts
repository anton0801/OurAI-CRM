import { DateTime } from 'luxon';
import { hasValue, unavailable, type MetricValue } from './value';
import { ROUND_HALF_EVEN, toBig } from '@castlane/domain';

export type PeriodPreset = 'today' | 'last_7_days' | 'last_30_days' | 'last_90_days' | 'this_week' | 'last_week' | 'this_month' | 'last_month' | 'this_quarter' | 'last_quarter' | 'this_year' | 'custom';
export type TimeGrain = 'day' | 'week' | 'month' | 'quarter';

/** A half-open UTC interval [start, end) plus the local calendar dates it represents. */
export interface Period {
  start: Date;
  end: Date;
  fromDate: string;
  /** Inclusive last local date. */
  toDate: string;
  zone: string;
}

const toPeriod = (from: DateTime, toExclusive: DateTime, zone: string): Period => ({
  start: from.toUTC().toJSDate(),
  end: toExclusive.toUTC().toJSDate(),
  fromDate: from.toISODate()!,
  toDate: toExclusive.minus({ days: 1 }).toISODate()!,
  zone,
});

/** Resolve a preset in the member's timezone (weeks start Monday unless configured otherwise). */
export const resolvePeriod = (
  preset: PeriodPreset,
  now: Date,
  zone: string,
  custom?: { fromDate: string; toDate: string },
  weekStartsOn: 'monday' | 'sunday' = 'monday',
): Period => {
  const local = DateTime.fromJSDate(now, { zone });
  const day = local.startOf('day');
  const weekStart = weekStartsOn === 'monday' ? day.minus({ days: day.weekday - 1 }) : day.minus({ days: day.weekday % 7 });
  switch (preset) {
    case 'today':
      return toPeriod(day, day.plus({ days: 1 }), zone);
    case 'last_7_days':
      return toPeriod(day.minus({ days: 6 }), day.plus({ days: 1 }), zone);
    case 'last_30_days':
      return toPeriod(day.minus({ days: 29 }), day.plus({ days: 1 }), zone);
    case 'last_90_days':
      return toPeriod(day.minus({ days: 89 }), day.plus({ days: 1 }), zone);
    case 'this_week':
      return toPeriod(weekStart, weekStart.plus({ weeks: 1 }), zone);
    case 'last_week':
      return toPeriod(weekStart.minus({ weeks: 1 }), weekStart, zone);
    case 'this_month':
      return toPeriod(day.startOf('month'), day.startOf('month').plus({ months: 1 }), zone);
    case 'last_month':
      return toPeriod(day.startOf('month').minus({ months: 1 }), day.startOf('month'), zone);
    case 'this_quarter':
      return toPeriod(day.startOf('quarter'), day.startOf('quarter').plus({ quarters: 1 }), zone);
    case 'last_quarter':
      return toPeriod(day.startOf('quarter').minus({ quarters: 1 }), day.startOf('quarter'), zone);
    case 'this_year':
      return toPeriod(day.startOf('year'), day.startOf('year').plus({ years: 1 }), zone);
    case 'custom': {
      if (!custom) throw new Error('Custom period needs fromDate and toDate');
      const from = DateTime.fromISO(custom.fromDate, { zone }).startOf('day');
      const to = DateTime.fromISO(custom.toDate, { zone }).startOf('day').plus({ days: 1 });
      if (!from.isValid || !to.isValid || to <= from) throw new Error('Invalid custom period');
      return toPeriod(from, to, zone);
    }
  }
};

/**
 * Comparison window (§16): a finished period is compared with the previous period of the same
 * length; an unfinished period (asOf before its end) with the same elapsed interval of the
 * previous period.
 */
export const comparisonPeriod = (p: Period, asOf: Date): { current: Period; previous: Period; elapsedOnly: boolean } => {
  const lengthMs = p.end.getTime() - p.start.getTime();
  const unfinished = asOf.getTime() < p.end.getTime();
  const currentEnd = unfinished ? new Date(Math.max(asOf.getTime(), p.start.getTime())) : p.end;
  const elapsed = currentEnd.getTime() - p.start.getTime();
  const prevStart = new Date(p.start.getTime() - lengthMs);
  const prevEnd = new Date(prevStart.getTime() + (unfinished ? elapsed : lengthMs));
  const z = p.zone;
  const d = (x: Date) => DateTime.fromJSDate(x, { zone: z });
  return {
    current: { ...p, end: currentEnd },
    previous: { start: prevStart, end: prevEnd, fromDate: d(prevStart).toISODate()!, toDate: d(new Date(prevEnd.getTime() - 1)).toISODate()!, zone: z },
    elapsedOnly: unfinished,
  };
};

export interface Delta {
  status: 'known' | 'no_comparison';
  /** current − previous (same unit as the metric; percentage points for rates). */
  abs: string | null;
  /** Relative change %, only for non-rate metrics with previous ≠ 0. */
  pct: string | null;
  unitLabel: 'pp' | 'unit';
}

/** Delta between two values; rates are compared in percentage points by default; unknown previous → No Comparison. */
export const compareValues = (current: MetricValue, previous: MetricValue, opts: { rate?: boolean } = {}): Delta => {
  const rate = opts.rate ?? current.unit === 'percent';
  if (!hasValue(current) || !hasValue(previous) || current.status === 'partial' || previous.status === 'partial')
    return { status: 'no_comparison', abs: null, pct: null, unitLabel: rate ? 'pp' : 'unit' };
  const abs = toBig(current.value).minus(toBig(previous.value));
  const prev = toBig(previous.value);
  return {
    status: 'known',
    abs: abs.round(4, ROUND_HALF_EVEN).toString(),
    pct: rate || prev.eq(0) ? null : abs.div(prev.abs()).times(100).round(2, ROUND_HALF_EVEN).toFixed(2),
    unitLabel: rate ? 'pp' : 'unit',
  };
};

/** Bucket boundaries for a time series in the member's zone (charts show gaps for missing buckets). */
export const buckets = (p: Period, grain: TimeGrain): { key: string; start: Date; end: Date }[] => {
  const out: { key: string; start: Date; end: Date }[] = [];
  let cursor = DateTime.fromJSDate(p.start, { zone: p.zone }).startOf(grain === 'week' ? 'week' : grain);
  const end = DateTime.fromJSDate(p.end, { zone: p.zone });
  let guard = 0;
  while (cursor < end && guard++ < 1000) {
    const next = cursor.plus({ [`${grain}s`]: 1 });
    out.push({ key: cursor.toISODate()!, start: new Date(Math.max(cursor.toMillis(), p.start.getTime())), end: new Date(Math.min(next.toMillis(), p.end.getTime())) });
    cursor = next;
  }
  return out;
};

export const noComparison = (v: MetricValue) => unavailable('not_comparable', v.unit);
