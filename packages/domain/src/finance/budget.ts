import { Big, ROUND_HALF_EVEN } from '../decimal';

/**
 * Budget figures (spec §18.5, M38). Committed amounts are only the remaining (unconsumed) part of
 * open commitments, so a commitment converted to an actual expense is never counted twice.
 */
export interface BudgetFigures {
  plannedMinor: bigint;
  actualMinor: bigint;
  committedMinor: bigint;
  /** Planned − Actual − Outstanding Commitments; negative = overspend. */
  remainingMinor: bigint;
  /** (Actual + Committed) / Planned × 100 with 2 decimals; null when nothing is planned. */
  consumedPercent: string | null;
}

export const budgetFigures = (plannedMinor: bigint, actualMinor: bigint, committedMinor: bigint): BudgetFigures => ({
  plannedMinor,
  actualMinor,
  committedMinor,
  remainingMinor: plannedMinor - actualMinor - committedMinor,
  consumedPercent:
    plannedMinor === 0n
      ? null
      : new Big((actualMinor + committedMinor).toString()).times(100).div(plannedMinor.toString()).round(2, ROUND_HALF_EVEN).toFixed(2),
});

/**
 * Thresholds (percent) newly crossed: at or above the threshold and not already alerted for this
 * budget version (each crossing notifies once until an explicit reset).
 */
export const newlyCrossedThresholds = (consumedPercent: string | null, thresholds: number[], alreadyAlerted: Iterable<number>): number[] => {
  if (consumedPercent === null) return [];
  const done = new Set(alreadyAlerted);
  const c = new Big(consumedPercent);
  return [...new Set(thresholds)].sort((a, b) => a - b).filter((t) => c.gte(t) && !done.has(t));
};

/** Commitment state after consumption. */
export const commitmentStateFor = (amountMinor: bigint, consumedMinor: bigint): 'open' | 'partially_consumed' | 'consumed' =>
  consumedMinor <= 0n ? 'open' : consumedMinor >= amountMinor ? 'consumed' : 'partially_consumed';
