import Big from 'big.js';
import { toBig } from '@castlane/domain';
import { cumulativeDelta, growthPercent, percentValue } from './formulas';
import { known, unavailable, type MetricValue } from './value';

/**
 * Pure selection rules for metric observations (spec §15, §16). Application code loads rows,
 * these functions decide which rows count — so the rules are unit-tested once.
 */

export type CheckpointTiming = 'on_time' | 'early' | 'late';

/** Timing of an observation against a checkpoint window (T068: the real observed_at is kept). */
export const checkpointTiming = (observedAt: Date, windowStart: Date, windowEnd: Date): CheckpointTiming =>
  observedAt.getTime() < windowStart.getTime() ? 'early' : observedAt.getTime() > windowEnd.getTime() ? 'late' : 'on_time';

export interface PointObservation {
  id: string;
  observedAt: Date;
  enteredAt: Date;
  reviewed: boolean;
  revisionNo: number;
  /** Known value of the metric being selected; null = not known in this observation. */
  value: string | null;
}

/**
 * M14 canonical checkpoint observation: among observations with a known value, the one closest to
 * the expected time; ties go to the reviewed record, then the latest revision / entry. Outside the
 * window observations are Early/Late and excluded from the standard comparable set unless asked.
 */
export const pickCheckpointObservation = <T extends PointObservation>(
  observations: T[],
  expectedAt: Date,
  window: { start: Date; end: Date },
  opts: { includeOutOfWindow?: boolean } = {},
): { chosen: T | null; timing: CheckpointTiming | null; outOfWindow: T[] } => {
  const withValue = observations.filter((o) => o.value !== null);
  const outOfWindow = withValue.filter((o) => checkpointTiming(o.observedAt, window.start, window.end) !== 'on_time');
  const candidates = opts.includeOutOfWindow ? withValue : withValue.filter((o) => checkpointTiming(o.observedAt, window.start, window.end) === 'on_time');
  if (candidates.length === 0) return { chosen: null, timing: null, outOfWindow };
  const dist = (o: T) => Math.abs(o.observedAt.getTime() - expectedAt.getTime());
  const sorted = [...candidates].sort(
    (a, b) =>
      dist(a) - dist(b) ||
      Number(b.reviewed) - Number(a.reviewed) ||
      b.revisionNo - a.revisionNo ||
      b.enteredAt.getTime() - a.enteredAt.getTime() ||
      a.id.localeCompare(b.id),
  );
  const chosen = sorted[0]!;
  return { chosen, timing: checkpointTiming(chosen.observedAt, window.start, window.end), outOfWindow };
};

export interface PeriodRow {
  id: string;
  start: Date;
  end: Date;
}

/**
 * Non-overlapping selection (M13, M24): exact duplicates and partial overlaps of the same
 * metric/entity/segment are never summed. Every observation of an overlapping cluster is set aside
 * as a conflict until the member marks a consistent (canonical) set; the rest is summed.
 */
export const nonOverlappingSet = <T extends PeriodRow>(rows: T[]): { included: T[]; conflicting: T[] } => {
  const sorted = [...rows].sort((a, b) => a.start.getTime() - b.start.getTime() || a.end.getTime() - b.end.getTime() || a.id.localeCompare(b.id));
  const included: T[] = [];
  const conflicting: T[] = [];
  let cluster: T[] = [];
  let clusterEnd = -Infinity;
  const flush = () => {
    if (cluster.length === 1) included.push(cluster[0]!);
    else conflicting.push(...cluster);
    cluster = [];
  };
  for (const r of sorted) {
    if (cluster.length && r.start.getTime() < clusterEnd) {
      cluster.push(r);
      clusterEnd = Math.max(clusterEnd, r.end.getTime());
    } else {
      if (cluster.length) flush();
      cluster = [r];
      clusterEnd = r.end.getTime();
    }
  }
  if (cluster.length) flush();
  return { included, conflicting };
};

/** Does the half-open period [start, end) lie completely inside [from, to)? Periods are never split. */
export const periodWithin = (p: { start: Date; end: Date }, from: Date, to: Date): boolean => p.start.getTime() >= from.getTime() && p.end.getTime() <= to.getTime();

/** Do two half-open periods overlap? */
export const periodsOverlap = (a: { start: Date; end: Date }, b: { start: Date; end: Date }): boolean =>
  a.start.getTime() < b.end.getTime() && b.start.getTime() < a.end.getTime();

export interface SnapshotPoint {
  observedAt: Date;
  value: string;
}

export interface SnapshotChange {
  first: SnapshotPoint | null;
  last: SnapshotPoint | null;
  /** M11: last − first (Not Enough Data with fewer than two usable snapshots). */
  change: MetricValue;
  /** M12: (last − first) / first × 100; first = 0 → Not Defined (T111). */
  growth: MetricValue;
}

/** Followers change and growth from the first and last usable snapshots inside the bounds. */
export const snapshotChange = (points: SnapshotPoint[]): SnapshotChange => {
  const sorted = [...points].sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime());
  if (sorted.length < 2) {
    return {
      first: sorted[0] ?? null,
      last: sorted[0] ?? null,
      change: unavailable('not_enough_data', 'count', { sampleSize: sorted.length }),
      growth: unavailable('not_enough_data', 'percent', { sampleSize: sorted.length }),
    };
  }
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  const change = cumulativeDelta(first.value, last.value, 'count');
  return { first, last, change: { ...change, sampleSize: sorted.length, note: undefined }, growth: { ...growthPercent(first.value, last.value), sampleSize: sorted.length } };
};

export type ValueAvailability = 'known' | 'unknown' | 'not_provided' | 'not_applicable';

/**
 * Completeness of one observation (§15.4): Known required fields / applicable required fields;
 * a field absent from the observation is Unknown (applicable). No applicable field → Not Applicable.
 */
export const valueCompleteness = (values: { metricKey: string; availability: ValueAvailability }[], required: string[]): MetricValue => {
  const byKey = new Map(values.map((v) => [v.metricKey, v.availability]));
  const applicable = required.filter((k) => byKey.get(k) !== 'not_applicable');
  if (applicable.length === 0) return unavailable('not_applicable', 'percent');
  const knownCount = applicable.filter((k) => byKey.get(k) === 'known').length;
  return { ...percentValue(knownCount, applicable.length, 0), coverage: { usable: knownCount, expected: applicable.length } };
};

/**
 * Data coverage M40 (T114): usable required checkpoints / expected required checkpoints × 100.
 * A checkpoint closed as Missing is expected but never usable; a closed request is not data.
 */
export const checkpointCoverage = (items: { state: 'pending' | 'completed' | 'missing' | 'cancelled'; usable: boolean }[]): MetricValue => {
  const expected = items.filter((i) => i.state !== 'cancelled');
  if (expected.length === 0) return unavailable('not_applicable', 'percent', { coverage: { usable: 0, expected: 0 } });
  const usable = expected.filter((i) => i.state === 'completed' && i.usable).length;
  const missing = expected.filter((i) => i.state === 'missing').length;
  const pending = expected.filter((i) => i.state === 'pending').length;
  const excluded = [
    ...(missing ? [{ count: missing, reason: 'Closed as Missing' }] : []),
    ...(pending ? [{ count: pending, reason: 'Still pending' }] : []),
  ];
  return { ...percentValue(usable, expected.length, 2), coverage: { usable, expected: expected.length }, sampleSize: expected.length, excluded: excluded.length ? excluded : undefined };
};

/**
 * Integer counter check (§15.3): 0 … 9×10^15, no fraction. Returns an error message or null.
 */
export const counterIssue = (value: string, max = '9000000000000000'): string | null => {
  let b: Big;
  try {
    b = toBig(value);
  } catch {
    return 'Enter a whole number.';
  }
  if (!b.round(0).eq(b)) return 'Enter a whole number.';
  if (b.lt(0)) return 'Counts cannot be negative.';
  if (b.gt(toBig(max))) return 'The number is too large.';
  return null;
};

/** Sum of known decimal strings (null when none). */
export const sumKnown = (values: (string | null | undefined)[]): string | null => {
  const present = values.filter((v): v is string => v !== null && v !== undefined);
  if (present.length === 0) return null;
  return present.reduce((a, v) => a.plus(toBig(v)), new Big(0)).toString();
};

/** A known value helper for counts built from records (a real zero count is known). */
export const countOf = (n: number, extra: Partial<MetricValue> = {}): MetricValue => known(String(n), 'count', { sampleSize: n, ...extra });
