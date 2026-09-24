import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { bucketKeyOf, bucketLocator } from './grouping';
import { resolvePeriod, type TimeGrain } from './periods';

describe('bucketLocator', () => {
  it('returns exactly the keys of bucketKeyOf, inside and outside the period, across DST and odd offsets', () => {
    const zones = ['UTC', 'Europe/Berlin', 'America/New_York', 'Asia/Kolkata', 'Asia/Kathmandu', 'Australia/Lord_Howe'];
    const grains: TimeGrain[] = ['day', 'week', 'month', 'quarter'];
    fc.assert(
      fc.property(
        fc.constantFrom(...zones),
        fc.constantFrom(...grains),
        fc.integer({ min: Date.UTC(2023, 0, 1), max: Date.UTC(2027, 0, 1) }),
        fc.array(fc.integer({ min: -30 * 86_400_000, max: 120 * 86_400_000 }), { minLength: 1, maxLength: 40 }),
        (zone, grain, now, offsets) => {
          const period = resolvePeriod('last_90_days', new Date(now), zone);
          const locate = bucketLocator(period, grain);
          for (const off of offsets) {
            const at = new Date(period.start.getTime() + off);
            expect(locate(at)).toBe(bucketKeyOf(at, grain, zone));
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
