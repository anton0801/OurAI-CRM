import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { allocateLargestRemainder } from '../money';
import { computeAllocation, distributeProportionally } from './allocation';
import { budgetFigures, commitmentStateFor, newlyCrossedThresholds } from './budget';
import {
  checkRuleStacking,
  deltaKey,
  baseKeyOf,
  entitlementKey,
  fixedPeriodEntitlements,
  hourlyAmounts,
  hourlyPayable,
  mergeIntervals,
  overlapDays,
  recipientTotals,
  revenueShareAmount,
  revenueShareBase,
  type RuleVersionLite,
} from './compensation';
import { baseEquivalent, effectiveSettlementRate, pickRate, proportionalBase, realizedDifference } from './fx';
import { controlTotalDifference, documentBalance, summarizeLedger, type LedgerLine } from './ledger';
import { ENTRY_TRANSITIONS, RUN_TRANSITIONS } from './states';
import { canTransition } from '../state-machine';

const EUR = (major: number) => BigInt(Math.round(major * 100));

describe('ledger arithmetic (§18.2, §18.7)', () => {
  const statement: LedgerLine[] = [
    { accountingClass: 'revenue', amountMinor: EUR(1000) },
    { accountingClass: 'contra_revenue', amountMinor: EUR(100) },
    { accountingClass: 'fee', amountMinor: EUR(180) },
  ];

  it('reproduces the control example: net 720, result 448 (T119)', () => {
    const s = summarizeLedger([
      ...statement,
      { accountingClass: 'operating_expense', amountMinor: EUR(200) },
      { accountingClass: 'compensation_expense', amountMinor: EUR(72) },
    ]);
    expect(s.grossRevenue).toBe(EUR(1000));
    expect(s.netRevenue).toBe(EUR(720));
    expect(s.operatingResult).toBe(EUR(448));
    expect(s.grossIncomplete).toBe(false);
  });

  it('net-only statements keep net valid and mark gross incomplete, fees not invented (T124)', () => {
    const s = summarizeLedger([{ accountingClass: 'revenue', amountMinor: EUR(720), componentsUnknown: true }]);
    expect(s.netRevenue).toBe(EUR(720));
    expect(s.grossRevenue).toBe(0n);
    expect(s.fees).toBe(0n);
    expect(s.grossIncomplete).toBe(true);
  });

  it('a reversal nets the original to zero', () => {
    const rev = statement.map((l) => ({ ...l, isReversal: true }));
    const s = summarizeLedger([...statement, ...rev]);
    expect(s.netRevenue).toBe(0n);
    expect(s.operatingResult).toBe(0n);
  });

  it('the statement header total is a control sum, not revenue (T125)', () => {
    expect(controlTotalDifference(statement, EUR(720))).toBe(0n);
    expect(controlTotalDifference(statement, EUR(750))).toBe(EUR(-30));
  });

  it('document balance: platform statement is a receivable of net, expense a payable', () => {
    expect(documentBalance(statement.map((l) => ({ ...l, currency: 'EUR' }))).get('EUR')).toBe(EUR(720));
    expect(documentBalance([{ accountingClass: 'operating_expense', amountMinor: EUR(200), currency: 'EUR' }]).get('EUR')).toBe(EUR(-200));
  });

  it('fx differences affect the result by direction', () => {
    const s = summarizeLedger([
      { accountingClass: 'fx_difference', amountMinor: 500n, fxEffect: 'gain' },
      { accountingClass: 'fx_difference', amountMinor: 200n, fxEffect: 'loss' },
    ]);
    expect(s.operatingResult).toBe(300n);
  });

  it('property: net revenue = gross − refunds − fees + net-only, for any lines', () => {
    const line = fc.record({
      accountingClass: fc.constantFrom('revenue', 'contra_revenue', 'fee', 'operating_expense', 'compensation_expense') as fc.Arbitrary<LedgerLine['accountingClass']>,
      amountMinor: fc.bigInt({ min: 0n, max: 10n ** 12n }),
      isReversal: fc.boolean(),
      componentsUnknown: fc.boolean(),
    });
    fc.assert(
      fc.property(fc.array(line, { maxLength: 30 }), (lines) => {
        const s = summarizeLedger(lines);
        expect(s.netRevenue).toBe(s.grossRevenue - s.refunds - s.fees + s.netOnlyRevenue);
        expect(s.operatingResult).toBe(s.netRevenue - s.operatingExpenses - s.compensationExpense);
      }),
    );
  });
});

describe('allocation (§18.3, T127)', () => {
  it('rejects remainders unless explicitly Unallocated', () => {
    const r = computeAllocation(10000n, 'EUR', { mode: 'exact', rows: [{ projectId: 'a', value: '60.00' }] });
    expect(r.ok).toBe(false);
    const ok = computeAllocation(10000n, 'EUR', {
      mode: 'exact',
      rows: [
        { projectId: 'a', value: '60.00' },
        { projectId: null, value: '40.00' },
      ],
    });
    expect(ok.ok && ok.rows.map((x) => x.amountMinor)).toEqual([6000n, 4000n]);
  });

  it('percentages must sum to exactly 100', () => {
    const r = computeAllocation(10000n, 'EUR', { mode: 'percent', rows: [{ projectId: 'a', value: '50' }, { projectId: 'b', value: '49.99' }] });
    expect(r.ok).toBe(false);
  });

  it('splits 100.00 in three equal parts exactly with a deterministic tie', () => {
    const r = computeAllocation(10000n, 'EUR', {
      mode: 'weights',
      rows: [
        { projectId: 'c', value: '1' },
        { projectId: 'a', value: '1' },
        { projectId: 'b', value: '1' },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rows.reduce((a, x) => a + x.amountMinor, 0n)).toBe(10000n);
    // Tie broken by key: 'a' gets the extra cent.
    expect(r.rows.find((x) => x.projectId === 'a')!.amountMinor).toBe(3334n);
  });

  it('rejects duplicate targets and precision beyond the currency', () => {
    expect(computeAllocation(100n, 'EUR', { mode: 'weights', rows: [{ projectId: 'a', value: '1' }, { projectId: 'a', value: '2' }] }).ok).toBe(false);
    expect(computeAllocation(100n, 'EUR', { mode: 'exact', rows: [{ projectId: 'a', value: '1.001' }] }).ok).toBe(false);
    expect(computeAllocation(100n, 'JPY', { mode: 'exact', rows: [{ projectId: 'a', value: '100' }] }).ok).toBe(true);
  });

  it('property: parts always sum exactly to the total (percent and weights)', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 13n }),
        fc.array(fc.integer({ min: 0, max: 10_000 }), { minLength: 1, maxLength: 12 }),
        (total, raw) => {
          const weights: number[] = raw.some((w) => w > 0) ? raw : [1, ...raw.slice(1)];
          const rows = weights.map((w, i) => ({ projectId: `p${i}`, value: String(w) }));
          const r = computeAllocation(total, 'EUR', { mode: 'weights', rows });
          expect(r.ok).toBe(true);
          if (r.ok) {
            expect(r.rows.reduce((a, x) => a + x.amountMinor, 0n)).toBe(total);
            for (const x of r.rows) expect(x.amountMinor >= 0n).toBe(true);
          }
        },
      ),
    );
  });

  it('property: percent allocations conserve minor units', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 10n ** 12n }), fc.integer({ min: 1, max: 9999 }), (total, bp) => {
        const a = (bp / 100).toFixed(2);
        const b = ((10000 - bp) / 100).toFixed(2);
        const r = computeAllocation(total, 'EUR', { mode: 'percent', rows: [{ projectId: 'a', value: a }, { projectId: null, value: b }] });
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.rows[0]!.amountMinor + r.rows[1]!.amountMinor).toBe(total);
      }),
    );
  });

  it('property: base amounts distributed proportionally conserve the base total', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -(10n ** 12n), max: 10n ** 12n }),
        fc.array(fc.bigInt({ min: 0n, max: 10n ** 9n }), { minLength: 1, maxLength: 10 }),
        (total, weights) => {
          const parts = weights.map((w, i) => ({ key: `k${i}`, weightMinor: w }));
          const m = distributeProportionally(total, parts);
          expect([...m.values()].reduce((a, b) => a + b, 0n)).toBe(total);
        },
      ),
    );
  });

  it('allocateLargestRemainder is deterministic for equal remainders', () => {
    const a = allocateLargestRemainder(1n, [{ key: 'b', weight: '1' }, { key: 'a', weight: '1' }]);
    expect(a.get('a')).toBe(1n);
    expect(a.get('b')).toBe(0n);
  });
});

describe('fx (§18.3–18.4)', () => {
  const rates = [
    { id: '1', fromCurrency: 'USD', toCurrency: 'EUR', rate: '0.9000000000', effectiveDate: '2026-09-01', source: 'bank' },
    { id: '2', fromCurrency: 'USD', toCurrency: 'EUR', rate: '0.9200000000', effectiveDate: '2026-09-15', source: 'bank' },
  ];
  it('picks the latest rate on or before the date, none before the first', () => {
    expect(pickRate(rates, 'USD', 'EUR', '2026-09-20')?.id).toBe('2');
    expect(pickRate(rates, 'USD', 'EUR', '2026-09-10')?.id).toBe('1');
    expect(pickRate(rates, 'USD', 'EUR', '2026-08-31')).toBeNull();
  });
  it('converts with half-even and returns null when the rate is missing', () => {
    expect(baseEquivalent(10001n, 'USD', 'EUR', '0.5')).toBe(5000n); // 50.005 → 50.00 (half-even)
    expect(baseEquivalent(100n, 'USD', 'EUR', null)).toBeNull();
    expect(baseEquivalent(100n, 'EUR', 'EUR', null)).toBe(100n);
  });
  it('realized difference and effective rate', () => {
    expect(realizedDifference({ direction: 'in', documentBaseMinor: 9000n, cashBaseMinor: 9200n })).toBe(200n);
    expect(realizedDifference({ direction: 'out', documentBaseMinor: 9000n, cashBaseMinor: 9200n })).toBe(-200n);
    expect(effectiveSettlementRate(9200n, 'EUR', 10000n, 'USD')).toBe('0.9200000000');
    expect(proportionalBase(5000n, 10000n, 9001n)).toBe(4500n);
  });
});

describe('compensation (§18.6)', () => {
  it('entitlement keys and deltas', () => {
    const k = entitlementKey({ recipientMembershipId: 'm', ruleVersionId: 'v', sourceType: 'fixed_month', sourceId: '2026-09', component: 'base' });
    expect(k).toBe('m:v:fixed_month:2026-09:base');
    expect(baseKeyOf(deltaKey(k, 2))).toBe(k);
  });

  it('fixed mid-month proration: Calendar Days vs None are reproducible (T132)', () => {
    const base = { monthlyAmountMinor: 300000n, ruleFrom: '2026-09-16', ruleTo: null, periodStart: '2026-09-01', periodEnd: '2026-09-30' };
    const cd = fixedPeriodEntitlements({ ...base, proration: 'calendar_days' });
    expect(cd).toEqual([{ month: '2026-09', monthStart: '2026-09-01', monthEnd: '2026-09-30', eligibleDays: 15, daysInMonth: 30, amountMinor: 150000n }]);
    const none = fixedPeriodEntitlements({ ...base, proration: 'none' });
    expect(none[0]!.amountMinor).toBe(300000n);
    // February 2028 has 29 days: 10 days → 1/2.9 of the amount, rounded half-even once.
    const feb = fixedPeriodEntitlements({ ...base, ruleFrom: '2028-02-01', ruleTo: '2028-02-11', periodStart: '2028-02-01', periodEnd: '2028-02-29', proration: 'calendar_days' });
    expect(feb[0]!.eligibleDays).toBe(10);
    expect(feb[0]!.amountMinor).toBe(103448n);
    expect(overlapDays('2026-01-01', null, '2026-09-01', '2026-09-30')).toBe(30);
  });

  it('hourly: TimeEntry and Shift of the same period are paid once (T133)', () => {
    const h = (iso: string) => new Date(iso).getTime();
    const r = hourlyPayable([
      { key: 'te', sourceType: 'time_entry', sourceId: 't1', intervals: [{ start: h('2026-09-10T10:00:00Z'), end: h('2026-09-10T12:00:00Z') }], seconds: 7200, date: '2026-09-10' },
      { key: 'sh', sourceType: 'shift', sourceId: 's1', intervals: [{ start: h('2026-09-10T11:00:00Z'), end: h('2026-09-10T13:00:00Z') }], seconds: 7200, date: '2026-09-10' },
    ]);
    expect(r[0]!.payableSeconds).toBe(7200);
    expect(r[1]!.payableSeconds).toBe(3600);
    expect(r[1]!.overlapSeconds).toBe(3600);
  });

  it('hourly: duration-only entries on a shift day cannot prove no overlap and are excluded', () => {
    const h = (iso: string) => new Date(iso).getTime();
    const r = hourlyPayable([
      { key: 'sh', sourceType: 'shift', sourceId: 's1', intervals: [{ start: h('2026-09-10T09:00:00Z'), end: h('2026-09-10T17:00:00Z') }], seconds: 28800, date: '2026-09-10' },
      { key: 'te', sourceType: 'time_entry', sourceId: 't1', intervals: [], seconds: 3600, date: '2026-09-10' },
      { key: 'te2', sourceType: 'time_entry', sourceId: 't2', intervals: [], seconds: 3600, date: '2026-09-11' },
    ]);
    expect(r[1]!.excludedReason).toBe('no_interval_on_shift_day');
    expect(r[2]!.payableSeconds).toBe(3600);
  });

  it('hourly rounding happens once on the total and parts conserve it', () => {
    const { totalMinor, perItem } = hourlyAmounts(1999n, [
      { key: 'a', payableSeconds: 1000 },
      { key: 'b', payableSeconds: 1000 },
      { key: 'c', payableSeconds: 1000 },
    ]);
    // 19.99 × 3000/3600 = 16.6583… → 16.66
    expect(totalMinor).toBe(1666n);
    expect([...perItem.values()].reduce((a, b) => a + b, 0n)).toBe(1666n);
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 10n ** 7n }), fc.array(fc.integer({ min: 0, max: 86400 }), { minLength: 1, maxLength: 20 }), (rate, secs) => {
        const res = hourlyAmounts(rate, secs.map((s, i) => ({ key: `i${i}`, payableSeconds: s })));
        expect([...res.perItem.values()].reduce((a, b) => a + b, 0n)).toBe(res.totalMinor);
      }),
    );
  });

  it('mergeIntervals merges overlaps', () => {
    expect(mergeIntervals([{ start: 5, end: 10 }, { start: 0, end: 6 }, { start: 20, end: 30 }])).toEqual([{ start: 0, end: 10 }, { start: 20, end: 30 }]);
  });

  it('revenue share: 10 % of net 720 = 72; gross of a net-only document is unknown', () => {
    const lines: LedgerLine[] = [
      { accountingClass: 'revenue', amountMinor: EUR(1000) },
      { accountingClass: 'contra_revenue', amountMinor: EUR(100) },
      { accountingClass: 'fee', amountMinor: EUR(180) },
    ];
    const b = revenueShareBase(lines, 'net_after_refunds_and_fees');
    expect(b.ok && b.baseMinor).toBe(EUR(720));
    expect(revenueShareAmount(EUR(720), '100', '10')).toBe(EUR(72));
    expect(revenueShareAmount(EUR(720), '60', '10')).toBe(4320n);
    expect(revenueShareBase([{ accountingClass: 'revenue', amountMinor: 1n, componentsUnknown: true }], 'gross').ok).toBe(false);
  });

  it('overlapping rules: same component blocked, others need a stack group, stacked shares ≤ 100 % (T134)', () => {
    const base: RuleVersionLite = {
      id: 'v1',
      ruleId: 'r1',
      recipientKey: 'member:m',
      componentKey: 'revenue_share',
      stackGroup: null,
      type: 'revenue_share',
      effectiveFrom: '2026-01-01',
      effectiveTo: null,
      ratePercent: '60',
      revenueBasis: 'net_after_refunds_and_fees',
      eligibleProjectIds: [],
    };
    const other = { ...base, id: 'v2', ruleId: 'r2' };
    expect(checkRuleStacking(base, [other]).conflicts[0]!.code).toBe('SAME_COMPONENT');
    expect(checkRuleStacking({ ...base, componentKey: 'bonus' }, [other]).conflicts[0]!.code).toBe('NEEDS_STACK_GROUP');
    const stacked = checkRuleStacking({ ...base, componentKey: 'bonus', stackGroup: 'g' }, [{ ...other, stackGroup: 'g' }]);
    expect(stacked.conflicts.map((c) => c.code)).toEqual(['STACK_OVER_100']);
    expect(stacked.revenueSharePercent).toBe('120');
    const fine = checkRuleStacking({ ...base, componentKey: 'bonus', stackGroup: 'g', ratePercent: '10' }, [{ ...other, stackGroup: 'g' }]);
    expect(fine.conflicts).toEqual([]);
    expect(fine.revenueSharePercent).toBe('70');
    // Non-overlapping intervals never conflict.
    expect(checkRuleStacking({ ...base, effectiveFrom: '2027-01-01' }, [{ ...other, effectiveTo: '2027-01-01' }]).conflicts).toEqual([]);
  });

  it('negative recipient totals are carried forward, never collected (T135)', () => {
    const t = recipientTotals([
      { recipientMembershipId: 'm', currency: 'EUR', amountMinor: 10000n, excluded: false },
      { recipientMembershipId: 'm', currency: 'EUR', amountMinor: -15000n, excluded: false },
      { recipientMembershipId: 'm', currency: 'EUR', amountMinor: 99999n, excluded: true },
    ]);
    expect(t).toEqual([{ recipientMembershipId: 'm', currency: 'EUR', totalMinor: -5000n, payableMinor: 0n, carryForwardMinor: -5000n }]);
  });
});

describe('budgets (§18.5, M38)', () => {
  it('remaining = planned − actual − committed; thresholds notify once', () => {
    const f = budgetFigures(100000n, 70000n, 15000n);
    expect(f.remainingMinor).toBe(15000n);
    expect(f.consumedPercent).toBe('85.00');
    expect(newlyCrossedThresholds(f.consumedPercent, [80, 100, 120], [])).toEqual([80]);
    expect(newlyCrossedThresholds(f.consumedPercent, [80, 100, 120], [80])).toEqual([]);
    expect(budgetFigures(0n, 10n, 0n).consumedPercent).toBeNull();
    expect(budgetFigures(100n, 150n, 0n).remainingMinor).toBe(-50n);
  });
  it('commitment state follows consumption', () => {
    expect(commitmentStateFor(100n, 0n)).toBe('open');
    expect(commitmentStateFor(100n, 40n)).toBe('partially_consumed');
    expect(commitmentStateFor(100n, 100n)).toBe('consumed');
  });
});

describe('state tables', () => {
  it('posted entries have no outgoing transition; runs cannot be cancelled after approval', () => {
    expect(ENTRY_TRANSITIONS.posted).toEqual([]);
    expect(canTransition(ENTRY_TRANSITIONS, 'submitted', 'posted')).toBe(true);
    expect(canTransition(RUN_TRANSITIONS, 'approved', 'cancelled')).toBe(false);
    expect(canTransition(RUN_TRANSITIONS, 'submitted', 'cancelled')).toBe(true);
  });
});
