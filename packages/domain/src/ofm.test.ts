import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import Big from 'big.js';
import {
  DEFAULT_OFM_RUBRIC,
  SHIFT_TRANSITIONS,
  dstInfo,
  handoverCompletionPercent,
  isValidShiftDuration,
  lateMinutes,
  negativeScoresWithoutEvidence,
  qualityScore,
  repeatOccurrences,
  runningNetSeconds,
  shiftNetTime,
  summarizeAllocations,
  validateBreaks,
  validateRepeatPattern,
  validateRubricCriteria,
  validateScores,
} from './ofm';
import { canTransition } from './state-machine';

const d = (iso: string) => new Date(iso);

describe('shift lifecycle', () => {
  it('forbids cancelling an active shift and leaving terminal states', () => {
    expect(canTransition(SHIFT_TRANSITIONS, 'active', 'cancelled')).toBe(false);
    expect(canTransition(SHIFT_TRANSITIONS, 'scheduled', 'cancelled')).toBe(true);
    expect(canTransition(SHIFT_TRANSITIONS, 'paused', 'ended')).toBe(true);
    for (const t of ['ended', 'cancelled', 'missed'] as const) expect(SHIFT_TRANSITIONS[t]).toEqual([]);
  });

  it('validates the 15 min – 16 h duration window', () => {
    expect(isValidShiftDuration(d('2026-10-01T10:00:00Z'), d('2026-10-01T10:14:00Z'))).toBe(false);
    expect(isValidShiftDuration(d('2026-10-01T10:00:00Z'), d('2026-10-01T10:15:00Z'))).toBe(true);
    expect(isValidShiftDuration(d('2026-10-01T20:00:00Z'), d('2026-10-02T12:00:00Z'))).toBe(true);
    expect(isValidShiftDuration(d('2026-10-01T20:00:00Z'), d('2026-10-02T12:01:00Z'))).toBe(false);
  });

  it('records lateness as a signed fact', () => {
    expect(lateMinutes(d('2026-10-01T10:00:00Z'), d('2026-10-01T10:07:00Z'))).toBe(7);
    expect(lateMinutes(d('2026-10-01T10:00:00Z'), d('2026-10-01T09:55:00Z'))).toBe(-5);
    expect(lateMinutes(d('2026-10-01T10:00:00Z'), null)).toBeNull();
  });
});

describe('net hours (M28, T089)', () => {
  it('subtracts closed breaks exactly once', () => {
    const r = shiftNetTime(d('2026-10-01T08:00:00Z'), d('2026-10-01T16:00:00Z'), [
      { startedAt: d('2026-10-01T12:00:00Z'), endedAt: d('2026-10-01T12:30:00Z') },
      { startedAt: d('2026-10-01T14:00:00Z'), endedAt: d('2026-10-01T14:15:00Z') },
    ]);
    expect(r).toEqual({ netSeconds: 8 * 3600 - 45 * 60, grossSeconds: 8 * 3600, breakSeconds: 45 * 60 });
  });

  it('is Pending (null), never 0, without an actual end (T090)', () => {
    expect(shiftNetTime(d('2026-10-01T08:00:00Z'), null, []).netSeconds).toBeNull();
    expect(shiftNetTime(null, null, []).netSeconds).toBeNull();
  });

  it('property: net = gross − disjoint breaks, never negative, running timer agrees at the end', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 15, max: 960 }),
        fc.array(fc.tuple(fc.integer({ min: 0, max: 959 }), fc.integer({ min: 1, max: 120 })), { maxLength: 6 }),
        (minutes, raw) => {
          const start = d('2026-10-01T06:00:00Z');
          const end = new Date(start.getTime() + minutes * 60_000);
          // Build disjoint breaks inside [start, end].
          const breaks: { startedAt: Date; endedAt: Date }[] = [];
          let cursor = 0;
          for (const [offset, len] of raw.sort((a, b) => a[0] - b[0])) {
            const s = Math.max(offset, cursor);
            const e = Math.min(s + len, minutes);
            if (e <= s) continue;
            breaks.push({ startedAt: new Date(start.getTime() + s * 60_000), endedAt: new Date(start.getTime() + e * 60_000) });
            cursor = e;
          }
          expect(validateBreaks(start, end, breaks)).toEqual([]);
          const r = shiftNetTime(start, end, breaks);
          const breakTotal = breaks.reduce((a, b) => a + (b.endedAt.getTime() - b.startedAt.getTime()) / 1000, 0);
          expect(r.netSeconds).toBe(minutes * 60 - breakTotal);
          expect(r.netSeconds!).toBeGreaterThanOrEqual(0);
          expect(runningNetSeconds(start, end, breaks)).toBe(r.netSeconds);
        },
      ),
    );
  });

  it('flags open, overlapping and out-of-range breaks', () => {
    const start = d('2026-10-01T08:00:00Z');
    const end = d('2026-10-01T12:00:00Z');
    const codes = validateBreaks(start, end, [
      { startedAt: d('2026-10-01T07:00:00Z'), endedAt: d('2026-10-01T08:30:00Z') },
      { startedAt: d('2026-10-01T08:20:00Z'), endedAt: d('2026-10-01T08:40:00Z') },
      { startedAt: d('2026-10-01T10:00:00Z'), endedAt: null },
    ]).map((i) => i.code);
    expect(codes).toContain('BREAK_OUTSIDE_SHIFT');
    expect(codes).toContain('BREAK_OVERLAP');
    expect(codes).toContain('BREAK_OPEN');
  });
});

describe('repeat schedule with DST preview', () => {
  it('expands weekdays over the horizon and handles overnight shifts', () => {
    const occ = repeatOccurrences({ startDate: '2026-09-28', weeks: 2, weekdays: [1, 3], startTime: '22:00', endTime: '06:00', timezone: 'Europe/Berlin' });
    expect(occ.map((o) => o.date)).toEqual(['2026-09-28', '2026-09-30', '2026-10-05', '2026-10-07']);
    expect(occ.every((o) => o.durationMinutes === 480)).toBe(true);
  });

  it('marks the occurrence crossing the autumn DST change (wall 8 h = 9 h elapsed)', () => {
    const occ = repeatOccurrences({ startDate: '2026-10-24', weeks: 1, weekdays: [6], startTime: '22:00', endTime: '06:00', timezone: 'Europe/Berlin' });
    expect(occ).toHaveLength(1);
    expect(occ[0]!.offsetChanges).toBe(true);
    expect(occ[0]!.durationMinutes).toBe(9 * 60);
    const info = dstInfo(occ[0]!.start, occ[0]!.end, 'Europe/Berlin');
    expect(info.wallClockMinutes).toBe(8 * 60);
  });

  it('flags non-existent wall times in the spring gap', () => {
    const occ = repeatOccurrences({ startDate: '2027-03-28', weeks: 1, weekdays: [7], startTime: '02:30', endTime: '08:00', timezone: 'Europe/Berlin' });
    expect(occ[0]!.dstShifted).toBe(true);
  });

  it('rejects horizons over 8 weeks and invalid input', () => {
    expect(validateRepeatPattern({ startDate: '2026-09-28', weeks: 9, weekdays: [1], startTime: '10:00', endTime: '18:00', timezone: 'UTC' })).toContain('weeks');
    expect(validateRepeatPattern({ startDate: 'x', weeks: 1, weekdays: [8], startTime: '25:00', endTime: '18:00', timezone: 'Mars/Base' })).toEqual([
      'startDate',
      'weekdays',
      'startTime',
      'timezone',
    ]);
  });
});

describe('quality score (M31, T100, T101)', () => {
  it('all Not Applicable → No Score, never 0 or 100', () => {
    const r = qualityScore(DEFAULT_OFM_RUBRIC, DEFAULT_OFM_RUBRIC.map((c) => ({ key: c.key, score: null })));
    expect(r.total).toBeNull();
    expect(r.applicableCriteria).toBe(0);
  });

  it('uses only applicable weights in the denominator', () => {
    const r = qualityScore(DEFAULT_OFM_RUBRIC, [
      { key: 'handover_completeness', score: 4 },
      { key: 'task_follow_through', score: 2 },
      { key: 'data_accuracy', score: null },
      { key: 'response_process_compliance', score: null },
    ]);
    expect(r.total).toBe('75.00');
    expect(r.applicableWeight).toBe('50');
  });

  it('property: total lies in [0, 100] and equals the manual formula', () => {
    fc.assert(
      fc.property(fc.array(fc.option(fc.integer({ min: 0, max: 4 }), { nil: null }), { minLength: 4, maxLength: 4 }), (vals) => {
        const scores = DEFAULT_OFM_RUBRIC.map((c, i) => ({ key: c.key, score: vals[i] ?? null }));
        const r = qualityScore(DEFAULT_OFM_RUBRIC, scores);
        const applicable = vals.filter((v): v is number => v !== null);
        if (applicable.length === 0) return expect(r.total).toBeNull();
        const expected = new Big(applicable.reduce((a, b) => a + b, 0)).div(4 * applicable.length).times(100).round(2, 2).toFixed(2);
        expect(r.total).toBe(expected);
        expect(Number(r.total)).toBeGreaterThanOrEqual(0);
        expect(Number(r.total)).toBeLessThanOrEqual(100);
      }),
    );
  });

  it('negative scores need evidence', () => {
    expect(negativeScoresWithoutEvidence([{ key: 'a', score: 0 }, { key: 'b', score: 1, evidenceAssetIds: ['x'] }, { key: 'c', score: 2 }, { key: 'd', score: null }])).toEqual(['a']);
  });

  it('validates rubric weights and score coverage', () => {
    expect(validateRubricCriteria(DEFAULT_OFM_RUBRIC)).toEqual([]);
    expect(validateRubricCriteria([{ key: 'a_b', label: 'A', weight: '60' }, { key: 'a_b', label: 'B', weight: '30' }]).map((i) => i.code)).toEqual(['DUPLICATE', 'WEIGHTS_NOT_100']);
    const issues = validateScores(DEFAULT_OFM_RUBRIC, [{ key: 'handover_completeness', score: 5 }, { key: 'nope', score: 1 }], { requireAll: true });
    expect(issues.map((i) => i.code)).toEqual(expect.arrayContaining(['OUT_OF_RANGE', 'UNKNOWN_CRITERION', 'REQUIRED']));
  });
});

describe('sale attribution (T099)', () => {
  it('no shares → Unassigned 100 %', () => {
    expect(summarizeAllocations([])).toMatchObject({ status: 'unassigned', unassignedPercent: '100' });
  });

  it('60/40 is full; shares above 100 % are rejected', () => {
    expect(summarizeAllocations([{ membershipId: 'a', sharePercent: '60' }, { membershipId: 'b', sharePercent: '40' }]).status).toBe('full');
    expect(summarizeAllocations([{ membershipId: 'a', sharePercent: '70' }, { membershipId: 'b', sharePercent: '40' }]).issues[0]!.code).toBe('OVER_100');
  });

  it('property: unassigned = 100 − Σ shares whenever valid', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 1, max: 100_0000 }), { maxLength: 5 }), (raw) => {
        const shares = raw.map((v, i) => ({ membershipId: `m${i}`, sharePercent: new Big(v).div(10_000).toString() }));
        const s = summarizeAllocations(shares);
        const total = shares.reduce((a, x) => a.plus(x.sharePercent), new Big(0));
        if (total.gt(100)) expect(s.issues.some((i) => i.code === 'OVER_100')).toBe(true);
        else expect(new Big(s.unassignedPercent).plus(total).eq(100)).toBe(true);
      }),
    );
  });
});

describe('handover completion (M30)', () => {
  it('is Not Applicable without required handovers', () => {
    expect(handoverCompletionPercent(0, 0)).toBeNull();
    expect(handoverCompletionPercent(3, 4)).toBe('75.00');
  });
});
