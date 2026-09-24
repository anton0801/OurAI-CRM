import { DateTime } from 'luxon';
import { Big, ROUND_HALF_EVEN, toBig } from '../decimal';
import { allocateLargestRemainder } from '../money';
import { signedEffect, type LedgerLine } from './ledger';

/**
 * Compensation arithmetic (spec §18.6). Everything is reproducible from inputs: the run stores
 * the inputs (snapshot) and these functions recompute the same lines.
 */

// ——— Entitlement keys ———

export interface EntitlementParts {
  recipientMembershipId: string;
  ruleVersionId: string;
  sourceType: string;
  sourceId: string;
  component: string;
}

/** recipient + rule version + source type + source id + component (spec §18.6). */
export const entitlementKey = (p: EntitlementParts): string =>
  [p.recipientMembershipId, p.ruleVersionId, p.sourceType, p.sourceId, p.component].join(':');

/** Correction of an already claimed entitlement: a separate key, never a rewrite. */
export const deltaKey = (baseKey: string, n: number): string => `${baseKey}|delta|${n}`;
export const baseKeyOf = (key: string): string => key.split('|delta|')[0]!;

// ——— Date intervals [from, to) ———

export const dateRangesOverlap = (aFrom: string, aTo: string | null, bFrom: string, bTo: string | null): boolean =>
  (bTo === null || aFrom < bTo) && (aTo === null || bFrom < aTo);

const d = (iso: string) => DateTime.fromISO(iso, { zone: 'UTC' });

/** Number of calendar days of [from, toExclusive) inside [start, endInclusive]. */
export const overlapDays = (from: string, toExclusive: string | null, start: string, endInclusive: string): number => {
  const s = d(from > start ? from : start);
  const endEx = d(endInclusive).plus({ days: 1 });
  const e = toExclusive && d(toExclusive) < endEx ? d(toExclusive) : endEx;
  const n = Math.round(e.diff(s, 'days').days);
  return Math.max(0, n);
};

// ——— Fixed Period Amount ———

export interface FixedEntitlement {
  /** YYYY-MM — part of the entitlement key. */
  month: string;
  monthStart: string;
  monthEnd: string;
  eligibleDays: number;
  daysInMonth: number;
  amountMinor: bigint;
}

/**
 * Monthly entitlements for the calendar months that overlap the run period. Proration "none"
 * pays the full monthly amount for any month the rule covers; "calendar_days" pays
 * amount × eligible calendar days / days in month (half-even, once per month). There is no hidden
 * "30-day working month".
 */
export const fixedPeriodEntitlements = (input: {
  monthlyAmountMinor: bigint;
  proration: 'none' | 'calendar_days';
  ruleFrom: string;
  ruleTo: string | null;
  periodStart: string;
  periodEnd: string;
}): FixedEntitlement[] => {
  const out: FixedEntitlement[] = [];
  let m = d(input.periodStart).startOf('month');
  const last = d(input.periodEnd).startOf('month');
  while (m <= last) {
    const monthStart = m.toISODate()!;
    const monthEnd = m.endOf('month').toISODate()!;
    const dim = m.daysInMonth!;
    const eligible = overlapDays(input.ruleFrom, input.ruleTo, monthStart, monthEnd);
    if (eligible > 0) {
      const amount =
        input.proration === 'calendar_days'
          ? BigInt(new Big(input.monthlyAmountMinor.toString()).times(eligible).div(dim).round(0, ROUND_HALF_EVEN).toFixed(0))
          : input.monthlyAmountMinor;
      out.push({ month: monthStart.slice(0, 7), monthStart, monthEnd, eligibleDays: eligible, daysInMonth: dim, amountMinor: amount });
    }
    m = m.plus({ months: 1 });
  }
  return out;
};

// ——— Hourly ———

export interface TimeInterval {
  start: number;
  end: number;
}

export interface HourlyItem {
  key: string;
  sourceType: 'time_entry' | 'shift';
  sourceId: string;
  /** Worked intervals (shift: actual interval minus breaks). Empty when only a duration is known. */
  intervals: TimeInterval[];
  seconds: number;
  /** Calendar date of the work (for items without intervals). */
  date: string;
}

export interface HourlyItemResult {
  key: string;
  payableSeconds: number;
  overlapSeconds: number;
  excludedReason: string | null;
}

const clip = (a: TimeInterval, b: TimeInterval): number => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));

/** Merge overlapping intervals (sorted, disjoint result). */
export const mergeIntervals = (list: TimeInterval[]): TimeInterval[] => {
  const sorted = [...list].filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
  const out: TimeInterval[] = [];
  for (const i of sorted) {
    const lastI = out[out.length - 1];
    if (lastI && i.start <= lastI.end) lastI.end = Math.max(lastI.end, i.end);
    else out.push({ ...i });
  }
  return out;
};

const coveredMs = (item: TimeInterval[], claimed: TimeInterval[]): number => {
  let n = 0;
  for (const a of mergeIntervals(item)) for (const c of claimed) n += clip(a, c);
  return n;
};

/**
 * Pay every worked second at most once per recipient: items are processed in the given order
 * (rule order, then time); time already covered by an earlier item — from the same or another
 * source (TimeEntry vs Shift) — is excluded with the overlap reported. A duration-only time entry
 * on a day with paid shift time is excluded because an overlap cannot be ruled out.
 */
export const hourlyPayable = (items: HourlyItem[]): HourlyItemResult[] => {
  let claimed: TimeInterval[] = [];
  const shiftDates = new Set(items.filter((i) => i.sourceType === 'shift' && i.intervals.length).map((i) => i.date));
  return items.map((it) => {
    if (it.intervals.length === 0) {
      if (it.sourceType === 'time_entry' && shiftDates.has(it.date))
        return { key: it.key, payableSeconds: 0, overlapSeconds: it.seconds, excludedReason: 'no_interval_on_shift_day' };
      return { key: it.key, payableSeconds: Math.max(0, it.seconds), overlapSeconds: 0, excludedReason: null };
    }
    const merged = mergeIntervals(it.intervals);
    const workedMs = merged.reduce((a, i) => a + (i.end - i.start), 0);
    const overlapMs = coveredMs(merged, claimed);
    claimed = mergeIntervals([...claimed, ...merged]);
    // Seconds may be below the interval length (e.g. declared duration shorter than the span).
    const declared = Math.min(it.seconds, Math.round(workedMs / 1000));
    const overlapSeconds = Math.round(overlapMs / 1000);
    const payable = Math.max(0, declared - overlapSeconds);
    return { key: it.key, payableSeconds: payable, overlapSeconds, excludedReason: payable === 0 && overlapSeconds > 0 ? 'overlap' : null };
  });
};

/** Rate × decimal hours, rounded once (half-even) on the total, then split exactly per item. */
export const hourlyAmounts = (rateMinor: bigint, items: { key: string; payableSeconds: number }[]): { totalMinor: bigint; perItem: Map<string, bigint> } => {
  const seconds = items.reduce((a, i) => a + i.payableSeconds, 0);
  const totalMinor = BigInt(new Big(rateMinor.toString()).times(seconds).div(3600).round(0, ROUND_HALF_EVEN).toFixed(0));
  const positive = items.filter((i) => i.payableSeconds > 0);
  const perItem = new Map<string, bigint>();
  for (const i of items) perItem.set(i.key, 0n);
  if (positive.length && totalMinor !== 0n) {
    const split = allocateLargestRemainder(
      totalMinor,
      positive.map((i) => ({ key: i.key, weight: String(i.payableSeconds) })),
    );
    for (const [k, v] of split) perItem.set(k, v);
  }
  return { totalMinor, perItem };
};

export const secondsToHours = (seconds: number): string => new Big(seconds).div(3600).round(4, ROUND_HALF_EVEN).toFixed(4);

// ——— Revenue share ———

export type RevenueBasis = 'gross' | 'net_after_refunds_and_fees';

/**
 * Base of one posted revenue document for a revenue-share rule. A percentage of an unknown gross
 * is never computed: a net-only document has no gross base.
 */
export const revenueShareBase = (lines: LedgerLine[], basis: RevenueBasis): { ok: true; baseMinor: bigint } | { ok: false; reason: 'gross_unknown' } => {
  if (basis === 'gross') {
    if (lines.some((l) => l.accountingClass === 'revenue' && l.componentsUnknown)) return { ok: false, reason: 'gross_unknown' };
    return { ok: true, baseMinor: lines.filter((l) => l.accountingClass === 'revenue').reduce((a, l) => a + signedEffect(l), 0n) };
  }
  return {
    ok: true,
    baseMinor: lines
      .filter((l) => l.accountingClass === 'revenue' || l.accountingClass === 'contra_revenue' || l.accountingClass === 'fee')
      .reduce((a, l) => a + signedEffect(l), 0n),
  };
};

/** base × attribution % × rule % (both 0–100), rounded once half-even. */
export const revenueShareAmount = (baseMinor: bigint, attributionPercent: string, ratePercent: string): bigint =>
  BigInt(new Big(baseMinor.toString()).times(toBig(attributionPercent)).times(toBig(ratePercent)).div(10000).round(0, ROUND_HALF_EVEN).toFixed(0));

// ——— Rule stacking ———

export interface RuleVersionLite {
  id: string;
  ruleId: string;
  /** member:<membershipId> or role:<roleId> */
  recipientKey: string;
  componentKey: string;
  stackGroup: string | null;
  type: 'fixed_period' | 'hourly' | 'per_approved_unit' | 'revenue_share';
  effectiveFrom: string;
  effectiveTo: string | null;
  ratePercent: string | null;
  revenueBasis: RevenueBasis | null;
  eligibleProjectIds: string[];
  name?: string;
}

export interface RuleConflict {
  versionId: string;
  ruleId: string;
  code: 'SAME_COMPONENT' | 'NEEDS_STACK_GROUP' | 'STACK_OVER_100';
  message: string;
}

const projectsOverlap = (a: string[], b: string[]) => a.length === 0 || b.length === 0 || a.some((p) => b.includes(p));

/**
 * Overlapping rules for the same recipient (spec §18.6, T134): the same component may never
 * overlap; different components only combine through the same explicit stack group; stacked
 * revenue shares of one basis may distribute at most 100 % of the base. Returns conflicts and
 * the stack preview (total percent of stacked revenue shares).
 */
export const checkRuleStacking = (
  candidate: RuleVersionLite,
  others: RuleVersionLite[],
): { conflicts: RuleConflict[]; stack: { versionId: string; ruleId: string; ratePercent: string | null; type: string; name?: string }[]; revenueSharePercent: string } => {
  const conflicts: RuleConflict[] = [];
  const stack: { versionId: string; ruleId: string; ratePercent: string | null; type: string; name?: string }[] = [];
  let percent = candidate.type === 'revenue_share' && candidate.ratePercent ? toBig(candidate.ratePercent) : toBig('0');
  for (const o of others) {
    if (o.id === candidate.id || o.ruleId === candidate.ruleId) continue;
    if (o.recipientKey !== candidate.recipientKey) continue;
    if (!dateRangesOverlap(candidate.effectiveFrom, candidate.effectiveTo, o.effectiveFrom, o.effectiveTo)) continue;
    if (o.componentKey === candidate.componentKey) {
      conflicts.push({ versionId: o.id, ruleId: o.ruleId, code: 'SAME_COMPONENT', message: 'Another rule pays the same component to this recipient in an overlapping period.' });
      continue;
    }
    if (!candidate.stackGroup || candidate.stackGroup !== o.stackGroup) {
      conflicts.push({ versionId: o.id, ruleId: o.ruleId, code: 'NEEDS_STACK_GROUP', message: 'Overlapping rules for the same recipient must share an explicit stack group.' });
      continue;
    }
    stack.push({ versionId: o.id, ruleId: o.ruleId, ratePercent: o.ratePercent, type: o.type, name: o.name });
    if (
      candidate.type === 'revenue_share' &&
      o.type === 'revenue_share' &&
      o.revenueBasis === candidate.revenueBasis &&
      o.ratePercent &&
      projectsOverlap(candidate.eligibleProjectIds, o.eligibleProjectIds)
    )
      percent = percent.plus(toBig(o.ratePercent));
  }
  if (percent.gt(100))
    conflicts.push({ versionId: candidate.id, ruleId: candidate.ruleId, code: 'STACK_OVER_100', message: `Stacked revenue shares would distribute ${percent.toString()}% of the same base (maximum 100%).` });
  return { conflicts, stack, revenueSharePercent: percent.toString() };
};

// ——— Run totals & carry-forward ———

export interface RunLineLite {
  recipientMembershipId: string;
  currency: string;
  amountMinor: bigint;
  excluded: boolean;
}

/**
 * Totals per recipient and currency. A negative total is never collected from the member: the
 * payable becomes zero and the balance is carried forward to the next open run (spec §18.6, T135).
 */
export const recipientTotals = (lines: RunLineLite[]): { recipientMembershipId: string; currency: string; totalMinor: bigint; payableMinor: bigint; carryForwardMinor: bigint }[] => {
  const map = new Map<string, { recipientMembershipId: string; currency: string; totalMinor: bigint }>();
  for (const l of lines) {
    if (l.excluded) continue;
    const k = `${l.recipientMembershipId}|${l.currency}`;
    const cur = map.get(k) ?? { recipientMembershipId: l.recipientMembershipId, currency: l.currency, totalMinor: 0n };
    cur.totalMinor += l.amountMinor;
    map.set(k, cur);
  }
  return [...map.values()]
    .sort((a, b) => (a.recipientMembershipId + a.currency).localeCompare(b.recipientMembershipId + b.currency))
    .map((t) => ({ ...t, payableMinor: t.totalMinor > 0n ? t.totalMinor : 0n, carryForwardMinor: t.totalMinor < 0n ? t.totalMinor : 0n }));
};
