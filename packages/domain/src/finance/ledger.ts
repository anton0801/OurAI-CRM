import type { ACCOUNTING_CLASSES, EnumValue } from '../enums';

/**
 * Management-accounting arithmetic (spec §18.2, §16 M33–M35). Pure functions over minor units;
 * every line amount is non-negative and the accounting class decides its effect. Reversal lines
 * negate the line they reverse, so an original + its reversal always net to zero.
 */
export type AccountingClass = EnumValue<typeof ACCOUNTING_CLASSES>;

export interface LedgerLine {
  accountingClass: AccountingClass;
  amountMinor: bigint;
  isReversal?: boolean;
  /** Net-only statement line: gross/refund/fee components are unknown (never invented). */
  componentsUnknown?: boolean;
  /** Realized FX difference direction (fx_difference class only). */
  fxEffect?: 'gain' | 'loss' | null;
}

export interface LedgerSummary {
  /** Gross revenue from lines whose components are known (M33). Net-only lines are excluded. */
  grossRevenue: bigint;
  /** Revenue recorded only as a verified net amount (components unknown). */
  netOnlyRevenue: bigint;
  refunds: bigint;
  fees: bigint;
  /** M34: gross − refunds − fees + net-only revenue. Fees are subtracted exactly once. */
  netRevenue: bigint;
  operatingExpenses: bigint;
  compensationExpense: bigint;
  fxGain: bigint;
  fxLoss: bigint;
  /** M35: net revenue − operating expenses − compensation expense ± realized FX difference. */
  operatingResult: bigint;
  /** True when some revenue is known only as net, so the gross figure is incomplete. */
  grossIncomplete: boolean;
}

const signOf = (l: LedgerLine): bigint => (l.isReversal ? -1n : 1n);

export const summarizeLedger = (lines: LedgerLine[]): LedgerSummary => {
  let gross = 0n;
  let netOnly = 0n;
  let refunds = 0n;
  let fees = 0n;
  let opex = 0n;
  let comp = 0n;
  let gain = 0n;
  let loss = 0n;
  let netOnlyLines = 0;
  for (const l of lines) {
    const v = l.amountMinor * signOf(l);
    switch (l.accountingClass) {
      case 'revenue':
        if (l.componentsUnknown) {
          netOnly += v;
          if (v !== 0n) netOnlyLines += 1;
        } else gross += v;
        break;
      case 'contra_revenue':
        refunds += v;
        break;
      case 'fee':
        fees += v;
        break;
      case 'operating_expense':
        opex += v;
        break;
      case 'compensation_expense':
        comp += v;
        break;
      case 'fx_difference':
        if (l.fxEffect === 'gain') gain += v;
        else loss += v;
        break;
    }
  }
  const netRevenue = gross - refunds - fees + netOnly;
  return {
    grossRevenue: gross,
    netOnlyRevenue: netOnly,
    refunds,
    fees,
    netRevenue,
    operatingExpenses: opex,
    compensationExpense: comp,
    fxGain: gain,
    fxLoss: loss,
    operatingResult: netRevenue - opex - comp + gain - loss,
    grossIncomplete: netOnlyLines > 0 || netOnly !== 0n,
  };
};

/**
 * Signed economic effect of a line on the result: revenue and FX gains are positive; refunds,
 * fees, expenses and FX losses negative.
 */
export const signedEffect = (l: LedgerLine): bigint => {
  const v = l.amountMinor * signOf(l);
  switch (l.accountingClass) {
    case 'revenue':
      return v;
    case 'fx_difference':
      return l.fxEffect === 'gain' ? v : -v;
    default:
      return -v;
  }
};

/**
 * Document balance per currency: positive = receivable (settled by incoming money), negative =
 * payable (settled by outgoing money). A platform statement 1000 − 100 − 180 is a receivable of
 * 720 — the fee is never a second payable.
 */
export const documentBalance = (lines: (LedgerLine & { currency: string })[]): Map<string, bigint> => {
  const out = new Map<string, bigint>();
  for (const l of lines) out.set(l.currency, (out.get(l.currency) ?? 0n) + signedEffect(l));
  return out;
};

/** Which line classes a document type may contain. */
export const ENTRY_TYPE_CLASSES: Record<'revenue' | 'expense' | 'adjustment' | 'platform_statement', readonly AccountingClass[]> = {
  revenue: ['revenue', 'contra_revenue', 'fee'],
  platform_statement: ['revenue', 'contra_revenue', 'fee'],
  expense: ['operating_expense', 'compensation_expense'],
  adjustment: ['revenue', 'contra_revenue', 'fee', 'operating_expense', 'compensation_expense', 'fx_difference'],
};

/** Statement header total is a control sum: it must equal the net of the transaction lines. */
export const controlTotalDifference = (lines: LedgerLine[], controlTotalMinor: bigint): bigint =>
  lines.reduce((a, l) => a + signedEffect(l), 0n) - controlTotalMinor;
