import { isDecimalString, isValidPercent, toBig } from '../decimal';
import { allocateLargestRemainder, tryParseAmountToMinor } from '../money';

/**
 * Allocation of one amount to projects / campaigns / content (spec §18.3). Exact amounts or
 * percentages summing to 100, or equal/custom weights; the parts always sum exactly to the
 * source amount in minor units (largest remainder, deterministic tie by row key). A remainder
 * is only allowed as an explicit Unallocated row (projectId = null).
 */
export type AllocationMode = 'exact' | 'percent' | 'weights';

export interface AllocationRowInput {
  projectId: string | null;
  campaignId?: string | null;
  contentItemId?: string | null;
  /** Decimal amount (exact), percent 0–100 (percent) or non-negative weight (weights). */
  value: string;
}

export interface AllocationSpec {
  mode: AllocationMode;
  rows: AllocationRowInput[];
}

export interface AllocatedRow {
  key: string;
  projectId: string | null;
  campaignId: string | null;
  contentItemId: string | null;
  amountMinor: bigint;
  /** Percent share (percent mode) as given; null otherwise. */
  sharePercent: string | null;
}

export interface AllocationIssue {
  row: number | null;
  code: string;
  message: string;
}

export type AllocationResult = { ok: true; rows: AllocatedRow[] } | { ok: false; issues: AllocationIssue[] };

export const allocationRowKey = (r: Pick<AllocationRowInput, 'projectId' | 'campaignId' | 'contentItemId'>): string =>
  `${r.projectId ?? 'unallocated'}|${r.campaignId ?? '-'}|${r.contentItemId ?? '-'}`;

/** Full amount to one explicit Unallocated row (used when no allocation is given). */
export const unallocatedSpec = (): AllocationSpec => ({ mode: 'weights', rows: [{ projectId: null, value: '1' }] });

export const computeAllocation = (totalMinor: bigint, currency: string, spec: AllocationSpec): AllocationResult => {
  const issues: AllocationIssue[] = [];
  if (spec.rows.length === 0) return { ok: false, issues: [{ row: null, code: 'REQUIRED', message: 'Add at least one allocation row.' }] };
  if (spec.rows.length > 200) return { ok: false, issues: [{ row: null, code: 'TOO_MANY', message: 'Use at most 200 allocation rows.' }] };
  const seen = new Set<string>();
  spec.rows.forEach((r, i) => {
    const k = allocationRowKey(r);
    if (seen.has(k)) issues.push({ row: i, code: 'DUPLICATE', message: 'The same target appears twice.' });
    seen.add(k);
    if (!isDecimalString(r.value)) issues.push({ row: i, code: 'INVALID', message: 'Enter a decimal number.' });
  });
  if (issues.length) return { ok: false, issues };

  const base = spec.rows.map((r) => ({
    key: allocationRowKey(r),
    projectId: r.projectId,
    campaignId: r.campaignId ?? null,
    contentItemId: r.contentItemId ?? null,
  }));

  if (totalMinor === 0n) return { ok: true, rows: base.map((b, i) => ({ ...b, amountMinor: 0n, sharePercent: spec.mode === 'percent' ? spec.rows[i]!.value : null })) };

  if (spec.mode === 'exact') {
    const amounts = spec.rows.map((r, i) => {
      const m = tryParseAmountToMinor(r.value, currency);
      if (m === null) issues.push({ row: i, code: 'PRECISION', message: `Use at most the minor units of ${currency}.` });
      else if (m < 0n) issues.push({ row: i, code: 'NEGATIVE', message: 'Amounts cannot be negative.' });
      return m ?? 0n;
    });
    if (issues.length) return { ok: false, issues };
    const sum = amounts.reduce((a, b) => a + b, 0n);
    if (sum !== totalMinor)
      return {
        ok: false,
        issues: [
          {
            row: null,
            code: sum < totalMinor ? 'REMAINDER' : 'EXCEEDS',
            message:
              sum < totalMinor
                ? 'Allocated amounts are below the total. Allocate the rest or add an explicit Unallocated row.'
                : 'Allocated amounts exceed the total.',
          },
        ],
      };
    return { ok: true, rows: base.map((b, i) => ({ ...b, amountMinor: amounts[i]!, sharePercent: null })) };
  }

  if (spec.mode === 'percent') {
    spec.rows.forEach((r, i) => {
      if (!isValidPercent(r.value)) issues.push({ row: i, code: 'INVALID_PERCENT', message: 'Use a percentage between 0 and 100 with at most 4 decimals.' });
    });
    if (issues.length) return { ok: false, issues };
    const sum = spec.rows.reduce((a, r) => a.plus(toBig(r.value)), toBig('0'));
    if (!sum.eq(100))
      return {
        ok: false,
        issues: [{ row: null, code: 'PERCENT_SUM', message: `Percentages must add up to exactly 100 (now ${sum.toString()}). Use an explicit Unallocated row for the rest.` }],
      };
  } else {
    spec.rows.forEach((r, i) => {
      if (toBig(r.value).lt(0)) issues.push({ row: i, code: 'NEGATIVE', message: 'Weights cannot be negative.' });
    });
    if (issues.length) return { ok: false, issues };
    if (spec.rows.every((r) => toBig(r.value).eq(0))) return { ok: false, issues: [{ row: null, code: 'ZERO_WEIGHTS', message: 'At least one weight must be above zero.' }] };
  }

  const parts = allocateLargestRemainder(
    totalMinor,
    base.map((b, i) => ({ key: b.key, weight: spec.rows[i]!.value })),
  );
  return {
    ok: true,
    rows: base.map((b, i) => ({ ...b, amountMinor: parts.get(b.key) ?? 0n, sharePercent: spec.mode === 'percent' ? spec.rows[i]!.value : null })),
  };
};

/**
 * Distribute a total (e.g. the base-currency equivalent of a line) over parts in proportion to
 * their amounts, conserving minor units exactly.
 */
export const distributeProportionally = <K extends string>(total: bigint, parts: { key: K; weightMinor: bigint }[]): Map<K, bigint> => {
  const out = new Map<K, bigint>();
  if (parts.length === 0) return out;
  const positive = parts.filter((p) => p.weightMinor > 0n);
  if (positive.length === 0) {
    // All-zero weights: give everything to the first part (deterministic), the rest zero.
    parts.forEach((p, i) => out.set(p.key, i === 0 ? total : 0n));
    return out;
  }
  const split = allocateLargestRemainder(
    total,
    parts.map((p) => ({ key: p.key, weight: (p.weightMinor < 0n ? 0n : p.weightMinor).toString() })),
  );
  for (const p of parts) out.set(p.key, split.get(p.key) ?? 0n);
  return out;
};
