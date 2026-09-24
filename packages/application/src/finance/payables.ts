import { and, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { compensationLines, compensationRuns, settlementAllocations, settlements } from '@castlane/database';
import { recipientTotals } from '@castlane/domain';
import { dbOf, type CommandContext, type QueryContext } from '../core/context';

/** Signed economic effect of a line in SQL (revenue +, FX gain +, everything else −). */
export const LINE_EFFECT_SQL = (alias = 'l', amountCol = 'amount_minor') =>
  sql.raw(
    `(CASE WHEN ${alias}.is_reversal THEN -1 ELSE 1 END) * (CASE ${alias}.accounting_class WHEN 'revenue' THEN ${alias}.${amountCol} WHEN 'fx_difference' THEN (CASE WHEN ${alias}.fx_effect = 'gain' THEN ${alias}.${amountCol} ELSE -${alias}.${amountCol} END) ELSE -${alias}.${amountCol} END)`,
  );

export interface DocumentOutstanding {
  entryId: string;
  title: string;
  recognitionDate: string;
  currency: string;
  /** Signed document balance: positive receivable, negative payable. */
  balanceMinor: bigint;
  settledMinor: bigint;
  outstandingMinor: bigint;
}

/**
 * Receivables / payables of posted, non-reversed documents per currency, net of confirmed and
 * non-reversed settlement allocations (optionally as of a date). `scope` may reference the
 * unaliased financial_entries table.
 */
export const documentOutstanding = async (
  ctx: QueryContext | CommandContext,
  opts: { direction?: 'in' | 'out'; asOf?: string; scope?: SQL; q?: string; limit?: number; entryIds?: string[] } = {},
): Promise<DocumentOutstanding[]> => {
  const ws = ctx.actor.workspaceId;
  const rows = await dbOf(ctx).execute<{ id: string; title: string; recognition_date: string; currency: string; balance: string; settled: string }>(sql`
    WITH bal AS (
      SELECT financial_entries.id, financial_entries.title, financial_entries.recognition_date::text AS recognition_date, l.currency, sum(${LINE_EFFECT_SQL('l')})::bigint AS balance
      FROM financial_entries
      JOIN financial_entry_lines l ON l.entry_id = financial_entries.id AND l.workspace_id = financial_entries.workspace_id
      WHERE financial_entries.workspace_id = ${ws} AND financial_entries.state = 'posted' AND financial_entries.reversed_by_entry_id IS NULL AND financial_entries.reverses_entry_id IS NULL
        -- Run expense documents are paid through the run (outstanding compensation, M39).
        AND financial_entries.compensation_run_id IS NULL
        ${opts.asOf ? sql`AND financial_entries.recognition_date <= ${opts.asOf}` : sql``}
        ${opts.scope ? sql`AND ${opts.scope}` : sql``}
        ${opts.q ? sql`AND financial_entries.title ILIKE ${`%${opts.q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`}` : sql``}
        ${opts.entryIds?.length ? sql`AND financial_entries.id IN (${sql.join(opts.entryIds.map((i) => sql`${i}::uuid`), sql`, `)})` : sql``}
      GROUP BY financial_entries.id, financial_entries.title, financial_entries.recognition_date, l.currency
    ), paid AS (
      SELECT sa.target_entry_id AS id, sa.document_currency AS currency, sum(sa.document_amount_minor)::bigint AS settled
      FROM settlement_allocations sa JOIN settlements s ON s.id = sa.settlement_id AND s.workspace_id = sa.workspace_id
      WHERE sa.workspace_id = ${ws} AND sa.reversed_at IS NULL AND s.state = 'confirmed' AND sa.target_entry_id IS NOT NULL
        ${opts.asOf ? sql`AND s.paid_at < (${opts.asOf}::date + 1)` : sql``}
      GROUP BY 1, 2
    )
    SELECT bal.id, bal.title, bal.recognition_date, bal.currency, bal.balance::text AS balance, coalesce(paid.settled, 0)::text AS settled
    FROM bal LEFT JOIN paid ON paid.id = bal.id AND paid.currency = bal.currency
    WHERE bal.balance <> 0 AND abs(bal.balance) - coalesce(paid.settled, 0) <> 0
      ${opts.direction === 'in' ? sql`AND bal.balance > 0` : opts.direction === 'out' ? sql`AND bal.balance < 0` : sql``}
    ORDER BY bal.recognition_date DESC, bal.id
    ${opts.limit ? sql`LIMIT ${opts.limit}` : sql``}`);
  return rows.rows.map((r) => {
    const balance = BigInt(r.balance);
    const settled = BigInt(r.settled);
    const abs = balance < 0n ? -balance : balance;
    return { entryId: r.id, title: r.title, recognitionDate: r.recognition_date, currency: r.currency.trim(), balanceMinor: balance, settledMinor: settled, outstandingMinor: abs - settled };
  });
};

export interface RecipientPayable {
  runId: string;
  recipientMembershipId: string;
  currency: string;
  totalMinor: bigint;
  payableMinor: bigint;
  carryForwardMinor: bigint;
  paidMinor: bigint;
  outstandingMinor: bigint;
}

/** Approved compensation per recipient and currency, net of recorded payouts (M39). */
export const runPayables = async (ctx: QueryContext | CommandContext, runIds: string[], opts: { asOf?: string } = {}): Promise<RecipientPayable[]> => {
  if (!runIds.length) return [];
  const db = dbOf(ctx);
  const ws = ctx.actor.workspaceId;
  const runs = await db.select().from(compensationRuns).where(and(eq(compensationRuns.workspaceId, ws), inArray(compensationRuns.id, runIds)));
  const lines = await db
    .select()
    .from(compensationLines)
    .where(and(eq(compensationLines.workspaceId, ws), inArray(compensationLines.runId, runIds)));
  const paid = await db
    .select({ runId: settlementAllocations.targetRunId, recipient: settlementAllocations.recipientMembershipId, currency: settlementAllocations.documentCurrency, amount: settlementAllocations.documentAmountMinor, paidAt: settlements.paidAt })
    .from(settlementAllocations)
    .innerJoin(settlements, eq(settlements.id, settlementAllocations.settlementId))
    .where(and(eq(settlementAllocations.workspaceId, ws), inArray(settlementAllocations.targetRunId, runIds), isNull(settlementAllocations.reversedAt), eq(settlements.state, 'confirmed')));
  const out: RecipientPayable[] = [];
  for (const r of runs) {
    const current = lines.filter((l) => l.runId === r.id && l.calculationVersion === r.calculationVersion);
    for (const t of recipientTotals(current.map((l) => ({ recipientMembershipId: l.recipientMembershipId, currency: l.currency.trim(), amountMinor: l.amountMinor, excluded: l.excluded })))) {
      const p = paid
        .filter((x) => x.runId === r.id && x.recipient === t.recipientMembershipId && x.currency.trim() === t.currency && (!opts.asOf || x.paidAt.toISOString().slice(0, 10) <= opts.asOf))
        .reduce((a, x) => a + x.amount, 0n);
      out.push({ runId: r.id, ...t, paidMinor: p, outstandingMinor: t.payableMinor - p });
    }
  }
  return out;
};
