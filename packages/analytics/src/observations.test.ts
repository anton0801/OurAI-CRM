import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  checkpointCoverage,
  checkpointTiming,
  counterIssue,
  nonOverlappingSet,
  periodWithin,
  periodsOverlap,
  pickCheckpointObservation,
  snapshotChange,
  valueCompleteness,
} from './observations';
import { bucketKeyOf, fillSeries, groupRecords } from './grouping';
import { resolvePeriod } from './periods';
import { countValue, sumValues } from './formulas';

const d = (iso: string) => new Date(iso);
const H = 3_600_000;

describe('checkpoint timing and selection', () => {
  const published = d('2026-09-01T10:00:00Z');
  const expected = new Date(published.getTime() + 24 * H);
  const window = { start: new Date(expected.getTime() - 2 * H), end: new Date(expected.getTime() + 2 * H) };
  const obs = (id: string, at: string, extra: Partial<{ reviewed: boolean; revisionNo: number; value: string | null; enteredAt: string }> = {}) => ({
    id,
    observedAt: d(at),
    enteredAt: d(extra.enteredAt ?? at),
    reviewed: extra.reviewed ?? false,
    revisionNo: extra.revisionNo ?? 1,
    value: extra.value === undefined ? '100' : extra.value,
  });

  it('labels late observations with their real time and keeps them out of the comparable set (T068)', () => {
    const late = obs('late', '2026-09-02T15:30:00Z');
    expect(checkpointTiming(late.observedAt, window.start, window.end)).toBe('late');
    const r = pickCheckpointObservation([late], expected, window);
    expect(r.chosen).toBeNull();
    expect(r.outOfWindow.map((o) => o.id)).toEqual(['late']);
    const withLate = pickCheckpointObservation([late], expected, window, { includeOutOfWindow: true });
    expect(withLate).toMatchObject({ timing: 'late' });
    expect(withLate.chosen?.observedAt.toISOString()).toBe('2026-09-02T15:30:00.000Z');
  });

  it('picks the observation closest to the expected time; ties go to the reviewed record', () => {
    const a = obs('a', '2026-09-02T09:00:00Z');
    const b = obs('b', '2026-09-02T11:00:00Z', { reviewed: true });
    const c = obs('c', '2026-09-02T10:30:00Z');
    expect(pickCheckpointObservation([a, b, c], expected, window).chosen?.id).toBe('c');
    expect(pickCheckpointObservation([a, b], expected, window).chosen?.id).toBe('b');
    expect(checkpointTiming(d('2026-09-02T07:00:00Z'), window.start, window.end)).toBe('early');
  });

  it('ignores observations without a known value', () => {
    expect(pickCheckpointObservation([obs('x', '2026-09-02T10:00:00Z', { value: null })], expected, window).chosen).toBeNull();
  });
});

describe('non-overlapping period selection (T105)', () => {
  const p = (id: string, s: string, e: string) => ({ id, start: d(s), end: d(e) });

  it('never sums overlapping periods; adjacent periods are fine', () => {
    const week1 = p('w1', '2026-09-07T00:00:00Z', '2026-09-14T00:00:00Z');
    const week2 = p('w2', '2026-09-14T00:00:00Z', '2026-09-21T00:00:00Z');
    const overlap = p('o', '2026-09-10T00:00:00Z', '2026-09-17T00:00:00Z');
    expect(nonOverlappingSet([week1, week2]).included.map((r) => r.id).sort()).toEqual(['w1', 'w2']);
    const r = nonOverlappingSet([week1, week2, overlap]);
    expect(r.included).toEqual([]);
    expect(r.conflicting.map((x) => x.id).sort()).toEqual(['o', 'w1', 'w2']);
  });

  it('exact duplicates are conflicts as well', () => {
    const a = p('a', '2026-09-01T00:00:00Z', '2026-09-02T00:00:00Z');
    const b = p('b', '2026-09-01T00:00:00Z', '2026-09-02T00:00:00Z');
    expect(nonOverlappingSet([a, b]).included).toHaveLength(0);
  });

  it('included periods never overlap each other (property)', () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(fc.integer({ min: 0, max: 100 }), fc.integer({ min: 1, max: 20 })), { maxLength: 25 }), (spans) => {
        const rows = spans.map(([s, len], i) => ({ id: String(i), start: new Date(s * H), end: new Date((s + len) * H) }));
        const { included, conflicting } = nonOverlappingSet(rows);
        expect(included.length + conflicting.length).toBe(rows.length);
        for (let i = 0; i < included.length; i++) for (let j = i + 1; j < included.length; j++) expect(periodsOverlap(included[i]!, included[j]!)).toBe(false);
        for (const c of conflicting) expect(rows.some((o) => o.id !== c.id && periodsOverlap(o, c))).toBe(true);
      }),
    );
  });

  it('periods partly outside the range are never split', () => {
    expect(periodWithin({ start: d('2026-09-01T00:00:00Z'), end: d('2026-09-08T00:00:00Z') }, d('2026-09-03T00:00:00Z'), d('2026-10-01T00:00:00Z'))).toBe(false);
    expect(periodWithin({ start: d('2026-09-03T00:00:00Z'), end: d('2026-09-10T00:00:00Z') }, d('2026-09-03T00:00:00Z'), d('2026-10-01T00:00:00Z'))).toBe(true);
  });
});

describe('snapshot change (M11/M12)', () => {
  it('uses first and last usable snapshots and keeps absolute growth when first = 0 (T111)', () => {
    const r = snapshotChange([
      { observedAt: d('2026-09-20T00:00:00Z'), value: '50' },
      { observedAt: d('2026-09-01T00:00:00Z'), value: '0' },
    ]);
    expect(r.change).toMatchObject({ status: 'known', value: '50' });
    expect(r.growth.status).toBe('not_defined');
    expect(r.first?.observedAt.toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });

  it('one snapshot is not enough data', () => {
    const r = snapshotChange([{ observedAt: d('2026-09-01T00:00:00Z'), value: '10' }]);
    expect(r.change.status).toBe('not_enough_data');
    expect(r.growth.status).toBe('not_enough_data');
  });

  it('a decline is a real change, not a source correction', () => {
    const r = snapshotChange([
      { observedAt: d('2026-09-01T00:00:00Z'), value: '200' },
      { observedAt: d('2026-09-10T00:00:00Z'), value: '180' },
    ]);
    expect(r.change).toMatchObject({ value: '-20' });
    expect(r.change.note).toBeUndefined();
    expect(r.growth.value).toBe('-10.00');
  });
});

describe('completeness and coverage', () => {
  it('counts known required fields over applicable ones', () => {
    const c = valueCompleteness(
      [
        { metricKey: 'publication.views', availability: 'known' },
        { metricKey: 'publication.likes', availability: 'not_provided' },
        { metricKey: 'publication.saves', availability: 'not_applicable' },
      ],
      ['publication.views', 'publication.likes', 'publication.saves', 'publication.comments'],
    );
    expect(c).toMatchObject({ status: 'known', value: '33', coverage: { usable: 1, expected: 3 } });
    expect(valueCompleteness([{ metricKey: 'a', availability: 'not_applicable' }], ['a']).status).toBe('not_applicable');
  });

  it('missing checkpoints are expected but never usable (T114)', () => {
    const c = checkpointCoverage([
      { state: 'completed', usable: true },
      { state: 'completed', usable: true },
      { state: 'missing', usable: false },
      { state: 'cancelled', usable: false },
    ]);
    expect(c).toMatchObject({ value: '66.67', coverage: { usable: 2, expected: 3 } });
    expect(c.excluded).toEqual([{ count: 1, reason: 'Closed as Missing' }]);
    expect(checkpointCoverage([]).status).toBe('not_applicable');
  });

  it('checks counters', () => {
    expect(counterIssue('10')).toBeNull();
    expect(counterIssue('0')).toBeNull();
    expect(counterIssue('1.5')).toMatch(/whole/);
    expect(counterIssue('-1')).toMatch(/negative/);
    expect(counterIssue('9000000000000001')).toMatch(/too large/);
  });
});

describe('grouping', () => {
  const recs = [
    { project: 'a', tags: ['x', 'y'], at: d('2026-09-01T10:00:00Z'), n: 1 },
    { project: 'a', tags: ['x'], at: d('2026-09-02T10:00:00Z'), n: 1 },
    { project: 'b', tags: [], at: d('2026-09-09T10:00:00Z'), n: 1 },
  ];
  const dimOf = (r: (typeof recs)[number], dim: string) => (dim === 'project' ? r.project : dim === 'tag' ? r.tags : bucketKeyOf(r.at, 'week', 'UTC'));

  it('groups by several dimensions and keeps totals single-row', () => {
    const total = groupRecords(recs, [], dimOf, (rs) => countValue(rs.length));
    expect(total).toHaveLength(1);
    expect(total[0]!.value.value).toBe('3');
    const byProjectWeek = groupRecords(recs, ['project', 'period'], dimOf, (rs) => countValue(rs.length));
    expect(byProjectWeek.map((g) => [g.dims.project, g.dims.period, g.value.value])).toEqual([
      ['a', '2026-08-31', '2'],
      ['b', '2026-09-07', '1'],
    ]);
    const byTag = groupRecords(recs, ['tag'], dimOf, (rs) => countValue(rs.length));
    expect(Object.fromEntries(byTag.map((g) => [g.dims.tag ?? 'none', g.value.value]))).toEqual({ x: '2', y: '1', none: '1' });
    expect(groupRecords([], [], dimOf, (rs) => countValue(rs.length))[0]!.value.value).toBe('0');
  });

  it('fills series: counts are known zero, observed values are gaps (T103)', () => {
    const period = resolvePeriod('custom', d('2026-09-30T00:00:00Z'), 'UTC', { fromDate: '2026-09-01', toDate: '2026-09-14' });
    const rows = groupRecords(recs.slice(0, 2), ['period'], dimOf, (rs) => countValue(rs.length));
    const counts = fillSeries(rows, period, 'week', { zeroCount: true, unit: 'count' });
    expect(counts.map((p) => p.value.value)).toEqual(['2', '0', '0']);
    const views = fillSeries(
      groupRecords(recs.slice(0, 2), ['period'], dimOf, () => sumValues(['5'], 'count')),
      period,
      'week',
      { zeroCount: false, unit: 'count' },
    );
    expect(views.map((p) => p.value.status)).toEqual(['known', 'no_data', 'no_data']);
  });
});
