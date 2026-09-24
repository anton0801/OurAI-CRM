import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { CAMPAIGN_STATUSES, EXPERIMENT_STATUSES, PUBLICATION_STATUSES, canTransition } from '@castlane/domain';
import {
  CAMPAIGN_TRANSITIONS,
  EXPERIMENT_TRANSITIONS,
  PUBLICATION_TRANSITIONS,
  checkpointLabel,
  checkpointTiming,
  checkpointWindows,
  classifyComparable,
  comparisonTolerance,
  onTimeAgainstBaseline,
  planWeekBounds,
  planWeekOf,
  sampleStats,
  sharePercent,
  splitCostMinor,
  summarizeComparable,
  summarizeSources,
  withinConflictWindow,
} from './logic';

const h = (n: number) => n * 3_600_000;

describe('state tables', () => {
  it('never lets a publication return from Published or Cancelled, and only confirms from Scheduled', () => {
    for (const to of PUBLICATION_STATUSES) {
      expect(canTransition(PUBLICATION_TRANSITIONS, 'published', to)).toBe(false);
      expect(canTransition(PUBLICATION_TRANSITIONS, 'cancelled', to)).toBe(false);
    }
    const intoPublished = PUBLICATION_STATUSES.filter((s) => canTransition(PUBLICATION_TRANSITIONS, s, 'published'));
    expect(intoPublished).toEqual(['scheduled']);
    expect(canTransition(PUBLICATION_TRANSITIONS, 'failed', 'scheduled')).toBe(true);
    expect(canTransition(PUBLICATION_TRANSITIONS, 'draft', 'published')).toBe(false);
  });

  it('covers every status in the campaign and experiment tables', () => {
    for (const s of CAMPAIGN_STATUSES) expect(CAMPAIGN_TRANSITIONS[s]).toBeDefined();
    for (const s of EXPERIMENT_STATUSES) expect(EXPERIMENT_TRANSITIONS[s]).toBeDefined();
    expect(canTransition(EXPERIMENT_TRANSITIONS, 'concluded', 'running')).toBe(false);
    expect(canTransition(CAMPAIGN_TRANSITIONS, 'active', 'archived')).toBe(false);
  });
});

describe('checkpoints and plan weeks', () => {
  it('computes 24h ±2h and 7d ±12h windows from the actual publication time', () => {
    const t = new Date('2030-06-03T10:00:00Z');
    const [d1, d7] = checkpointWindows(t, [
      { key: 'pub_24h', offsetHours: 24, toleranceHours: 2 },
      { key: 'pub_7d', offsetHours: 168, toleranceHours: 12 },
    ]);
    expect(d1).toMatchObject({ label: '24h', expectedAt: new Date('2030-06-04T10:00:00Z'), windowStart: new Date('2030-06-04T08:00:00Z'), windowEnd: new Date('2030-06-04T12:00:00Z') });
    expect(d7!.label).toBe('7d');
    expect(d7!.windowEnd.getTime() - d7!.windowStart.getTime()).toBe(h(24));
    expect(checkpointLabel(12)).toBe('12h');
    expect(checkpointLabel(48)).toBe('2d');
  });

  it('labels observations outside the window Early/Late, never on time', () => {
    fc.assert(
      fc.property(fc.integer({ min: -h(48), max: h(48) }), (offset) => {
        const start = new Date('2030-06-04T08:00:00Z');
        const end = new Date('2030-06-04T12:00:00Z');
        const obs = new Date(start.getTime() + offset);
        const t = checkpointTiming(obs, start, end);
        if (obs < start) expect(t).toBe('early');
        else if (obs > end) expect(t).toBe('late');
        else expect(t).toBe('on_time');
      }),
    );
  });

  it('finds the plan week in the workspace zone across DST changes (7 local days)', () => {
    // Sunday 23:30 Berlin (UTC+2) still belongs to the week that started Monday.
    expect(planWeekOf(new Date('2030-06-09T21:30:00Z'), 'Europe/Berlin').weekStart).toBe('2030-06-03');
    expect(planWeekOf(new Date('2030-06-09T22:30:00Z'), 'Europe/Berlin').weekStart).toBe('2030-06-10');
    // The week containing the spring-forward change (Sunday 31 March 2030 in the EU) is 167 hours long.
    const dst = planWeekBounds('2030-03-25', 'Europe/Berlin');
    expect(dst.end.getTime() - dst.start.getTime()).toBe(h(167));
    const regular = planWeekBounds('2030-06-03', 'Europe/Berlin');
    expect(regular.end.getTime() - regular.start.getTime()).toBe(h(168));
    const spring = planWeekBounds('2030-03-25', 'America/New_York');
    expect(spring.weekEnd).toBe('2030-03-31');
    const withChange = planWeekBounds('2030-03-25', 'Europe/London');
    expect(withChange.end.getTime() - withChange.start.getTime()).toBe(h(167));
    expect(planWeekOf(new Date('2030-06-05T12:00:00Z'), 'UTC', 'sunday').weekStart).toBe('2030-06-02');
  });

  it('measures on-time against the frozen baseline plus grace', () => {
    const base = new Date('2030-06-05T10:00:00Z');
    expect(onTimeAgainstBaseline(base, new Date('2030-06-05T10:15:00Z'), 15)).toBe(true);
    expect(onTimeAgainstBaseline(base, new Date('2030-06-05T10:15:01Z'), 15)).toBe(false);
    expect(onTimeAgainstBaseline(base, null, 15)).toBeNull();
  });

  it('flags two placements closer than 15 minutes', () => {
    const a = new Date('2030-06-05T10:00:00Z');
    expect(withinConflictWindow(a, new Date('2030-06-05T10:14:59Z'))).toBe(true);
    expect(withinConflictWindow(a, new Date('2030-06-05T10:15:00Z'))).toBe(false);
  });
});

describe('campaign cost split (T071)', () => {
  it('always sums exactly to the source amount (property)', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 13n }),
        fc.array(fc.integer({ min: 0, max: 10_000 }), { minLength: 1, maxLength: 12 }).filter((ws) => ws.some((w) => w > 0)),
        (total, weights) => {
          const shares = weights.map((w, i) => ({ projectId: `p${i}`, weight: String(w) }));
          const r = splitCostMinor(total, 'EUR', 'weights', shares);
          expect(r.ok).toBe(true);
          if (!r.ok) return;
          expect([...r.parts.values()].reduce((a, b) => a + b, 0n)).toBe(total);
          for (const v of r.parts.values()) expect(v >= 0n).toBe(true);
        },
      ),
    );
  });

  it('splits equally with deterministic remainders and validates exact amounts', () => {
    const eq = splitCostMinor(10001n, 'EUR', 'equal', [{ projectId: 'a' }, { projectId: 'b' }, { projectId: 'c' }]);
    expect(eq.ok && [...eq.parts.values()].sort()).toEqual([3333n, 3334n, 3334n]);
    expect(splitCostMinor(1000n, 'EUR', 'amounts', [{ projectId: 'a', amount: '4.00' }, { projectId: 'b', amount: '6.00' }]).ok).toBe(true);
    expect(splitCostMinor(1000n, 'EUR', 'amounts', [{ projectId: 'a', amount: '4.00' }, { projectId: 'b', amount: '5.99' }]).ok).toBe(false);
    expect(splitCostMinor(1000n, 'JPY', 'amounts', [{ projectId: 'a', amount: '10.5' }]).ok).toBe(false);
    expect(splitCostMinor(1000n, 'EUR', 'weights', [{ projectId: 'a', weight: '0' }]).ok).toBe(false);
    expect(splitCostMinor(1000n, 'EUR', 'equal', [{ projectId: 'a' }, { projectId: 'a' }]).ok).toBe(false);
    expect(sharePercent(3333n, 10001n)).toBe('33.3267');
    expect(sharePercent(0n, 0n)).toBeNull();
  });
});

describe('comparable results (T072)', () => {
  const now = new Date('2030-06-10T12:00:00Z');
  const pub = (hoursAgo: number) => new Date(now.getTime() - h(hoursAgo));

  it('compares only values observed at the same post age', () => {
    const tol = comparisonTolerance(24, [{ key: 'pub_24h', offsetHours: 24, toleranceHours: 2 }]);
    expect(tol).toBe(2);
    expect(comparisonTolerance(72, [])).toBe(6);
    const base = { variantId: 'v', segment: 'organic' as const, removed: false };
    const ok = classifyComparable({ ...base, publicationId: 'a', publishedAt: pub(100), observations: [{ observedAt: pub(75), value: '10' }, { observedAt: pub(50), value: '20' }] }, now, 24, tol);
    expect(ok).toMatchObject({ state: 'comparable', value: '10', observedAgeHours: 25 });
    expect(classifyComparable({ ...base, publicationId: 'b', publishedAt: pub(5), observations: [] }, now, 24, tol).state).toBe('too_young');
    expect(classifyComparable({ ...base, publicationId: 'c', publishedAt: pub(100), observations: [{ observedAt: pub(10), value: '99' }] }, now, 24, tol).state).toBe('no_observation_in_window');
    expect(classifyComparable({ ...base, publicationId: 'd', publishedAt: pub(100), observations: [{ observedAt: pub(76), value: null }] }, now, 24, tol)).toMatchObject({ state: 'unknown_value', value: null });
    expect(classifyComparable({ ...base, publicationId: 'e', publishedAt: null, observations: [] }, now, 24, tol).state).toBe('not_published');
  });

  it('never produces a comparable status when a variant has no comparable value', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom('comparable', 'too_young', 'no_observation_in_window', 'unknown_value') as fc.Arbitrary<'comparable'>, { minLength: 1, maxLength: 10 }), (states) => {
        const items = states.map((s, i) => ({ publicationId: `p${i}`, variantId: i % 2 ? 'b' : 'a', segment: 'organic' as const, state: s, ageHours: 30, value: s === 'comparable' ? '5' : null, observedAt: null, observedAgeHours: null }));
        const r = summarizeComparable(items, ['a', 'b'], 1);
        const counts = ['a', 'b'].map((v) => items.filter((i) => i.variantId === v && i.state === 'comparable').length);
        if (counts.some((c) => c === 0)) expect(r.status).not.toBe('comparable');
        else expect(r.status).toBe('comparable');
        expect(JSON.stringify(r)).not.toMatch(/winner|significan/i);
      }),
    );
  });

  it('reports median/mean and Tukey outliers', () => {
    const s = sampleStats(['10', '11', '12', '13', '1000'].map((v, i) => ({ key: `k${i}`, value: v })));
    expect(s).toMatchObject({ sampleSize: 5, median: '12', mean: '209.2', min: '10', max: '1000' });
    expect(s.outliers.map((o) => o.value)).toEqual(['1000']);
    expect(sampleStats([]).median).toBeNull();
  });
});

describe('source report totals', () => {
  it('keeps unknown values unknown and refuses to sum overlapping periods of one source', () => {
    const d = (x: string) => new Date(`2030-06-${x}T00:00:00Z`);
    const r = summarizeSources([
      { id: '1', sourceName: 'Shop', attributionLabel: 'source_reported', periodStart: d('01'), periodEnd: d('03'), clicks: 10, conversions: null },
      { id: '2', sourceName: 'shop ', attributionLabel: 'source_reported', periodStart: d('03'), periodEnd: d('05'), clicks: 5, conversions: null },
      { id: '3', sourceName: 'Ads', attributionLabel: 'source_reported', periodStart: d('01'), periodEnd: d('05'), clicks: 20, conversions: 2 },
      { id: '4', sourceName: 'Ads', attributionLabel: 'source_reported', periodStart: d('04'), periodEnd: d('06'), clicks: 7, conversions: 1 },
    ]);
    const shop = r.sources.find((s) => s.sourceName === 'Shop')!;
    expect(shop.clicks.value).toBe('15');
    expect(shop.conversions.value).toBeNull();
    expect(shop.conversionRate.value).toBeNull();
    const ads = r.sources.find((s) => s.sourceName === 'Ads')!;
    expect(ads.overlapping).toBe(true);
    expect(ads.clicks.value).toBeNull();
    expect(r.totals.clicks.value).toBe('15');
    expect(summarizeSources([]).totals.clicks).toEqual({ value: null, note: 'No data recorded for this period.' });
  });
});
