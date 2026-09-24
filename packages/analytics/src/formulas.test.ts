import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { cumulativeDelta, durationStats, goalProgress, growthPercent, median, percentValue, percentile, sumOfKnown, sumValues, weightedPercent } from './formulas';
import { comparisonPeriod, compareValues, resolvePeriod } from './periods';
import { known } from './value';

describe('metric formulas', () => {
  it('distinguishes empty from zero (T103)', () => {
    expect(sumValues([], 'count').status).toBe('no_data');
    expect(sumValues([0], 'count')).toMatchObject({ status: 'known', value: '0' });
    expect(sumValues([null, undefined], 'count').status).toBe('no_data');
  });

  it('cumulative snapshots give deltas, not sums (T104) and flag negative deltas (T107)', () => {
    expect(cumulativeDelta('100', '160')).toMatchObject({ status: 'known', value: '60' });
    expect(cumulativeDelta('160', '100')).toMatchObject({ status: 'known', value: '-60', note: 'Source Correction' });
    expect(cumulativeDelta(null, '100').status).toBe('not_enough_data');
  });

  it('ER with zero views is not defined (T108); ER may exceed 100', () => {
    expect(percentValue(5, 0).status).toBe('not_defined');
    expect(percentValue(150, 100)).toMatchObject({ status: 'known', value: '150.00' });
  });

  it('partial interactions list missing fields (T109)', () => {
    const v = sumOfKnown({ likes: 10, comments: 2, shares: null, saves: undefined });
    expect(v).toMatchObject({ status: 'partial', value: '12', missing: ['shares', 'saves'] });
  });

  it('aggregate ER is a weighted ratio, not an average of percentages (T110)', () => {
    const v = weightedPercent([
      { numerator: 10, denominator: 100 },
      { numerator: 90, denominator: 900 },
      { numerator: 5, denominator: 0 },
    ]);
    expect(v).toMatchObject({ status: 'known', value: '10.00', sampleSize: 2 });
    expect(v.excluded?.[0]?.count).toBe(1);
    const w = weightedPercent([
      { numerator: 1, denominator: 10 },
      { numerator: 1, denominator: 1000 },
    ]);
    expect(w.value).toBe('0.20'); // mean of percentages would be 5.05
  });

  it('growth from a zero first snapshot is not defined (T111)', () => {
    expect(growthPercent('0', '50').status).toBe('not_defined');
    expect(growthPercent('200', '250')).toMatchObject({ value: '25.00' });
  });

  it('median and p90 use nearest rank', () => {
    expect(median([5, 1, 3])).toBe('3');
    expect(median([4, 1, 3, 2])).toBe('2.5');
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe('9');
    expect(durationStats([]).median.status).toBe('no_data');
  });

  it('goal progress per target type, denominator zero not defined', () => {
    expect(goalProgress('absolute', { current: 50, target: 200 }).value).toBe('25.00');
    expect(goalProgress('increase_by', { current: 150, target: 100, baseline: 100 }).value).toBe('50.00');
    expect(goalProgress('decrease_to', { current: 80, target: 60, baseline: 100 }).value).toBe('50.00');
    expect(goalProgress('decrease_to', { current: 80, target: 100, baseline: 100 }).status).toBe('not_defined');
    expect(goalProgress('increase_by', { current: 80, target: 10 }).status).toBe('not_defined');
    expect(goalProgress('absolute', { current: null, target: 10 }).status).toBe('no_data');
  });

  it('weighted percent always lies between min and max row rates (property)', () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(fc.integer({ min: 0, max: 10_000 }), fc.integer({ min: 1, max: 10_000 })), { minLength: 1, maxLength: 30 }), (rows) => {
        const v = weightedPercent(rows.map(([n, d]) => ({ numerator: n, denominator: d })), 6);
        const rates = rows.map(([n, d]) => (n / d) * 100);
        const x = Number(v.value);
        return x >= Math.min(...rates) - 1e-6 && x <= Math.max(...rates) + 1e-6;
      }),
    );
  });
});

describe('periods and comparison', () => {
  it('compares an unfinished month with the same elapsed window (T117)', () => {
    const p = resolvePeriod('this_month', new Date('2026-09-15T12:00:00Z'), 'UTC');
    const c = comparisonPeriod(p, new Date('2026-09-15T12:00:00Z'));
    expect(c.elapsedOnly).toBe(true);
    expect(c.previous.start.toISOString()).toBe('2026-08-02T00:00:00.000Z');
    expect(c.previous.end.getTime() - c.previous.start.getTime()).toBe(c.current.end.getTime() - c.current.start.getTime());
  });

  it('rate deltas are in percentage points; unknown previous → no comparison', () => {
    expect(compareValues(known('12.5', 'percent'), known('10', 'percent'))).toMatchObject({ abs: '2.5', pct: null, unitLabel: 'pp' });
    expect(compareValues(known('150', 'count'), known('100', 'count'))).toMatchObject({ abs: '50', pct: '50.00' });
    expect(compareValues(known('1', 'count'), { status: 'no_data', value: null, unit: 'count' }).status).toBe('no_comparison');
  });

  it('resolves periods in the member timezone', () => {
    const p = resolvePeriod('today', new Date('2026-09-24T22:30:00Z'), 'Europe/Moscow');
    expect(p.fromDate).toBe('2026-09-25');
    expect(p.start.toISOString()).toBe('2026-09-24T21:00:00.000Z');
  });
});
