import { Big, ROUND_HALF_EVEN, toBig, type RoundingMode } from './decimal';

/** ISO 4217 minor units. Currencies not listed are rejected rather than guessed. */
export const CURRENCY_MINOR_UNITS: Record<string, 0 | 2 | 3> = {
  AED: 2, ARS: 2, AUD: 2, AZN: 2, BAM: 2, BDT: 2, BGN: 2, BHD: 3, BIF: 0, BRL: 2, BYN: 2, CAD: 2, CHF: 2,
  CLP: 0, CNY: 2, COP: 2, CZK: 2, DJF: 0, DKK: 2, DZD: 2, EGP: 2, EUR: 2, GBP: 2, GEL: 2, GHS: 2, GNF: 0,
  HKD: 2, HUF: 2, IDR: 2, ILS: 2, INR: 2, IQD: 3, ISK: 0, JOD: 3, JPY: 0, KES: 2, KGS: 2, KMF: 0, KRW: 0,
  KWD: 3, KZT: 2, LKR: 2, LYD: 3, MAD: 2, MDL: 2, MXN: 2, MYR: 2, NGN: 2, NOK: 2, NZD: 2, OMR: 3, PEN: 2,
  PHP: 2, PKR: 2, PLN: 2, PYG: 0, QAR: 2, RON: 2, RSD: 2, RUB: 2, RWF: 0, SAR: 2, SEK: 2, SGD: 2, THB: 2,
  TND: 3, TRY: 2, TWD: 2, UAH: 2, UGX: 0, USD: 2, UYU: 2, UZS: 2, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
  ZAR: 2, AMD: 2, MNT: 2, TJS: 2,
};

export const SUPPORTED_CURRENCIES = Object.keys(CURRENCY_MINOR_UNITS).sort();

export const isSupportedCurrency = (code: unknown): code is string =>
  typeof code === 'string' && Object.prototype.hasOwnProperty.call(CURRENCY_MINOR_UNITS, code);

export const minorUnits = (currency: string): number => {
  const units = CURRENCY_MINOR_UNITS[currency];
  if (units === undefined) throw new Error(`Unsupported currency: ${currency}`);
  return units;
};

export interface Money {
  amountMinor: bigint;
  currency: string;
}

/**
 * Parse a user-entered decimal amount into minor units. Rejects extra precision instead of
 * silently rounding: "10.005 EUR" is an input error, not 10.00 or 10.01.
 */
export const parseAmountToMinor = (amount: string, currency: string): bigint => {
  const units = minorUnits(currency);
  const trimmed = amount.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) throw new Error('Amount must be a decimal number');
  const [intPart, frac = ''] = trimmed.replace('-', '').split('.');
  if (frac.length > units) throw new Error(`Amount has more than ${units} decimal places for ${currency}`);
  const negative = trimmed.startsWith('-');
  const minor = BigInt((intPart ?? '0') + frac.padEnd(units, '0'));
  return negative ? -minor : minor;
};

export const tryParseAmountToMinor = (amount: string, currency: string): bigint | null => {
  try {
    return parseAmountToMinor(amount, currency);
  } catch {
    return null;
  }
};

/** Minor units → canonical decimal string (e.g. 123456n EUR → "1234.56"). */
export const formatMinor = (amountMinor: bigint, currency: string): string => {
  const units = minorUnits(currency);
  const negative = amountMinor < 0n;
  const abs = (negative ? -amountMinor : amountMinor).toString().padStart(units + 1, '0');
  const intPart = units === 0 ? abs : abs.slice(0, abs.length - units);
  const frac = units === 0 ? '' : `.${abs.slice(abs.length - units)}`;
  return `${negative ? '-' : ''}${intPart}${frac}`;
};

export const sumMinor = (values: bigint[]): bigint => values.reduce((a, b) => a + b, 0n);

/**
 * Convert an amount between currencies with a frozen rate ("1 unit of from = rate units of to").
 * Rounding happens once, at the target currency's minor unit, half-even.
 */
export const convertMinor = (
  amountMinor: bigint,
  fromCurrency: string,
  toCurrency: string,
  rate: string,
  mode: RoundingMode = ROUND_HALF_EVEN,
): bigint => {
  if (fromCurrency === toCurrency) return amountMinor;
  const fromUnits = minorUnits(fromCurrency);
  const toUnits = minorUnits(toCurrency);
  const major = new Big(amountMinor.toString()).div(new Big(10).pow(fromUnits));
  const converted = major.times(toBig(rate)).times(new Big(10).pow(toUnits)).round(0, mode);
  return BigInt(converted.toFixed(0));
};

export interface AllocationShare<K extends string = string> {
  key: K;
  /** Non-negative decimal weight (percentages, hours, custom weights — any scale). */
  weight: string;
}

/**
 * Split an integer amount of minor units across weighted shares using the largest-remainder
 * method. The result always sums exactly to `total`; ties are broken deterministically by key.
 */
export const allocateLargestRemainder = <K extends string>(
  total: bigint,
  shares: AllocationShare<K>[],
): Map<K, bigint> => {
  if (shares.length === 0) throw new Error('At least one share is required');
  const scale = Math.max(0, ...shares.map((s) => (s.weight.split('.')[1] ?? '').length));
  const factor = 10n ** BigInt(scale);
  const weights = shares.map((s) => {
    const w = toBig(s.weight);
    if (w.lt(0)) throw new Error('Weights must be non-negative');
    return BigInt(w.times(factor.toString()).toFixed(0));
  });
  const weightSum = weights.reduce((a, b) => a + b, 0n);
  if (weightSum === 0n) throw new Error('Weights must not all be zero');

  const negative = total < 0n;
  const absTotal = negative ? -total : total;
  const rows = shares.map((s, i) => {
    const numerator = absTotal * weights[i]!;
    return { key: s.key, floor: numerator / weightSum, remainder: numerator % weightSum };
  });
  let leftover = absTotal - rows.reduce((a, r) => a + r.floor, 0n);
  const order = [...rows].sort((a, b) =>
    a.remainder === b.remainder ? (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) : a.remainder > b.remainder ? -1 : 1,
  );
  const extra = new Map<K, bigint>();
  for (const row of order) {
    if (leftover <= 0n) break;
    extra.set(row.key, 1n);
    leftover -= 1n;
  }
  const result = new Map<K, bigint>();
  for (const row of rows) {
    const value = row.floor + (extra.get(row.key) ?? 0n);
    result.set(row.key, negative ? -value : value);
  }
  return result;
};

/** Apply a percentage (decimal string 0–100) to minor units, half-even. */
export const percentOfMinor = (amountMinor: bigint, percent: string, mode: RoundingMode = ROUND_HALF_EVEN): bigint =>
  BigInt(new Big(amountMinor.toString()).times(toBig(percent)).div(100).round(0, mode).toFixed(0));

/** Multiply minor units by a decimal factor (e.g. hourly rate × hours), half-even. */
export const multiplyMinor = (amountMinor: bigint, factor: string, mode: RoundingMode = ROUND_HALF_EVEN): bigint =>
  BigInt(new Big(amountMinor.toString()).times(toBig(factor)).round(0, mode).toFixed(0));
