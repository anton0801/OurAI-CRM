import { Big, ROUND_HALF_EVEN, toBig } from '../decimal';
import { convertMinor, minorUnits } from '../money';

/**
 * FX helpers (spec §18.3). Rates are "1 unit of `from` = rate units of `to`", entered manually
 * or imported with a source note; no automatic API. A used rate is frozen on the line.
 */
export interface FxRateRow {
  id: string;
  fromCurrency: string;
  toCurrency: string;
  rate: string;
  effectiveDate: string;
  source: string;
  createdAt?: Date | string;
}

/** Latest rate for the pair with effective date on or before `date` (ties: most recently entered). */
export const pickRate = <R extends FxRateRow>(rates: R[], from: string, to: string, date: string): R | null => {
  let best: R | null = null;
  for (const r of rates) {
    if (r.fromCurrency !== from || r.toCurrency !== to || r.effectiveDate > date) continue;
    if (
      !best ||
      r.effectiveDate > best.effectiveDate ||
      (r.effectiveDate === best.effectiveDate && String(r.createdAt ?? '') > String(best.createdAt ?? ''))
    )
      best = r;
  }
  return best;
};

/** Base-currency equivalent of a line (rate 1 for the base currency itself). */
export const baseEquivalent = (amountMinor: bigint, currency: string, baseCurrency: string, rate: string | null): bigint | null => {
  if (currency === baseCurrency) return amountMinor;
  if (!rate) return null;
  return convertMinor(amountMinor, currency, baseCurrency, rate, ROUND_HALF_EVEN);
};

/** Effective settlement rate: cash units per one document unit (10 decimals). */
export const effectiveSettlementRate = (cashMinor: bigint, cashCurrency: string, docMinor: bigint, docCurrency: string): string | null => {
  if (docMinor === 0n) return null;
  const cash = new Big(cashMinor.toString()).div(new Big(10).pow(minorUnits(cashCurrency)));
  const doc = new Big(docMinor.toString()).div(new Big(10).pow(minorUnits(docCurrency)));
  return cash.div(doc).round(10, ROUND_HALF_EVEN).toFixed(10);
};

/**
 * Realized FX difference when a document is settled in another currency (spec §18.4): the
 * base value of the cash compared with the frozen base value of the settled document portion.
 * Positive result = gain for the company.
 */
export const realizedDifference = (input: {
  direction: 'in' | 'out';
  /** Base value of the settled document portion at the document's frozen rate. */
  documentBaseMinor: bigint;
  /** Base value of the cash actually received/paid. */
  cashBaseMinor: bigint;
}): bigint => (input.direction === 'in' ? input.cashBaseMinor - input.documentBaseMinor : input.documentBaseMinor - input.cashBaseMinor);

/** Proportional base value of `partMinor` out of a line/document of `totalMinor` with base `totalBaseMinor`. */
export const proportionalBase = (partMinor: bigint, totalMinor: bigint, totalBaseMinor: bigint): bigint => {
  if (totalMinor === 0n) return 0n;
  return BigInt(new Big(totalBaseMinor.toString()).times(partMinor.toString()).div(totalMinor.toString()).round(0, ROUND_HALF_EVEN).toFixed(0));
};

export const isPositiveRate = (rate: string): boolean => {
  try {
    return toBig(rate).gt(0);
  } catch {
    return false;
  }
};
