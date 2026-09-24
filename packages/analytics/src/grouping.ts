import { DateTime } from 'luxon';
import { buckets, type Period, type TimeGrain } from './periods';
import { known, unavailable, type MetricUnit, type MetricValue } from './value';

/**
 * Grouping engine shared by the semantic layer and the report builder: records are aggregated per
 * fact to the requested grain first, then combined by dimension tuple (T115: joining facts never
 * multiplies rows).
 */
export interface GroupRow {
  /** Stable key of the dimension tuple. */
  key: string;
  dims: Record<string, string | null>;
  value: MetricValue;
}

export const tupleKey = (dims: string[], values: Record<string, string | null>): string => JSON.stringify(dims.map((d) => values[d] ?? null));

/** Local bucket key (YYYY-MM-DD of the bucket start) — the same keys as `buckets()`. */
export const bucketKeyOf = (at: Date, grain: TimeGrain, zone: string): string =>
  DateTime.fromJSDate(at, { zone })
    .startOf(grain === 'week' ? 'week' : grain)
    .toISODate()!;

/**
 * Bucket keys for many instants of one period: a binary search over the period's buckets (exactly
 * the keys of `bucketKeyOf`), with the calendar computation only for instants outside the period.
 * Grouping tens of thousands of records by period no longer builds a calendar date per record.
 */
export const bucketLocator = (period: Period, grain: TimeGrain): ((at: Date) => string) => {
  const bs = buckets(period, grain);
  const starts = bs.map((b) => b.start.getTime());
  const ends = bs.map((b) => b.end.getTime());
  return (at: Date) => {
    const t = at.getTime();
    let lo = 0;
    let hi = starts.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid]! <= t) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return found >= 0 && t < ends[found]! ? bs[found]!.key : bucketKeyOf(at, grain, period.zone);
  };
};

/**
 * Group records by the given dimensions and reduce each group to one metric value. `dimOf`
 * returns the dimension value of a record (null = none); a record may belong to several values of
 * a multi-valued dimension (tags) by returning an array.
 */
export const groupRecords = <R>(
  records: R[],
  dims: string[],
  dimOf: (r: R, dim: string) => string | null | (string | null)[],
  reduce: (rows: R[]) => MetricValue,
): GroupRow[] => {
  const groups = new Map<string, { dims: Record<string, string | null>; rows: R[] }>();
  for (const r of records) {
    let tuples: Record<string, string | null>[] = [{}];
    for (const d of dims) {
      const v = dimOf(r, d);
      const values = Array.isArray(v) ? (v.length ? v : [null]) : [v];
      tuples = tuples.flatMap((t) => values.map((x) => ({ ...t, [d]: x })));
    }
    for (const t of tuples) {
      const key = tupleKey(dims, t);
      const g = groups.get(key) ?? { dims: t, rows: [] };
      g.rows.push(r);
      groups.set(key, g);
    }
  }
  if (dims.length === 0 && groups.size === 0) return [{ key: tupleKey([], {}), dims: {}, value: reduce([]) }];
  return [...groups.entries()].map(([key, g]) => ({ key, dims: g.dims, value: reduce(g.rows) }));
};

/**
 * Fill a period series: buckets without records are a known zero for record counts, and a gap
 * (no data) for observed values — a missing point is never drawn as 0.
 */
export const fillSeries = (
  rows: GroupRow[],
  period: Period,
  grain: TimeGrain,
  empty: { zeroCount: boolean; unit: MetricUnit },
): { bucket: string; value: MetricValue }[] => {
  const byKey = new Map(rows.map((r) => [r.dims.period ?? '', r.value]));
  return buckets(period, grain).map((b) => ({
    bucket: b.key,
    value: byKey.get(b.key) ?? (empty.zeroCount ? known('0', empty.unit, { sampleSize: 0 }) : unavailable('no_data', empty.unit)),
  }));
};
