import Big from 'big.js';

/**
 * Decimal helpers backed by big.js. Floats are never used for money, rates or percentages.
 * Rounding mode defaults to half-even ("banker's rounding") as required for FX line conversion.
 */
export const ROUND_DOWN = 0 as const;
export const ROUND_HALF_UP = 1 as const;
export const ROUND_HALF_EVEN = 2 as const;
export const ROUND_UP = 3 as const;
export type RoundingMode = 0 | 1 | 2 | 3;

const DECIMAL_RE = /^-?\d+(\.\d+)?$/;

export const isDecimalString = (value: unknown): value is string =>
  typeof value === 'string' && DECIMAL_RE.test(value.trim());

export const toBig = (value: string | number | bigint | Big): Big => {
  if (value instanceof Big) return value;
  if (typeof value === 'bigint') return new Big(value.toString());
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Non-finite number cannot be converted to decimal');
    return new Big(value);
  }
  const trimmed = value.trim();
  if (!DECIMAL_RE.test(trimmed)) throw new Error(`Invalid decimal: ${value}`);
  return new Big(trimmed);
};

/** Count of digits after the decimal point in a canonical decimal string. */
export const decimalScale = (value: string): number => {
  const idx = value.indexOf('.');
  return idx === -1 ? 0 : value.length - idx - 1;
};

export const roundDecimal = (value: Big | string, dp: number, mode: RoundingMode = ROUND_HALF_EVEN): string =>
  toBig(value).round(dp, mode).toFixed(dp);

/** Percent stored as decimal 0–100 with at most 4 fractional digits. */
export const isValidPercent = (value: string): boolean => {
  if (!isDecimalString(value)) return false;
  if (decimalScale(value) > 4) return false;
  const b = toBig(value);
  return b.gte(0) && b.lte(100);
};

export const compareDecimal = (a: string, b: string): number => toBig(a).cmp(toBig(b));

export const sumDecimals = (values: string[]): string => values.reduce((acc, v) => acc.plus(toBig(v)), new Big(0)).toString();

/** Safe ratio: returns null when the denominator is zero or missing (caller shows "Not Defined"). */
export const ratio = (numerator: Big | string | null | undefined, denominator: Big | string | null | undefined, dp = 4): string | null => {
  if (numerator == null || denominator == null) return null;
  const d = toBig(denominator);
  if (d.eq(0)) return null;
  return toBig(numerator).div(d).round(dp, ROUND_HALF_EVEN).toFixed(dp);
};

export const percentOf = (numerator: Big | string | null | undefined, denominator: Big | string | null | undefined, dp = 2): string | null => {
  if (numerator == null || denominator == null) return null;
  const d = toBig(denominator);
  if (d.eq(0)) return null;
  return toBig(numerator).times(100).div(d).round(dp, ROUND_HALF_EVEN).toFixed(dp);
};

export { Big };
