import { and, asc, desc, eq, ilike, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { can, hasAnywhere } from '@castlane/authorization';
import {
  compensationRuns,
  financeCategories,
  financialAllocations,
  financialEntries,
  financialEntryLines,
  fxRates,
  settlementAllocations,
  settlements,
} from '@castlane/database';
import {
  AppError,
  SETTLEMENT_TRANSITIONS,
  assertTransition,
  baseEquivalent,
  clampPageSize,
  decodeCursor,
  effectiveSettlementRate,
  encodeCursor,
  localDate,
  newId,
  pickRate,
  proportionalBase,
  realizedDifference,
  signedEffect,
  type FieldError,
} from '@castlane/domain';
import { requirePermission } from '../core/access';
import { audit, diffFields } from '../core/audit';
import { dbOf, type CommandContext, type QueryContext } from '../core/context';
import { emit } from '../core/events';
import { loadMemberRefs, refOrUnknown } from '../core/members';
import { notify } from '../core/notify';
import { assertVersion, findById, lockById, stamp, touch } from '../core/rows';
import { assertPeriodOpen, canAny, financeScopes, financeScopeSql, moneyOf, parseAmount, throwIfErrors, userMembershipMap, workspaceFinance } from './common';
import { createEntry, entryVisibilitySql, evidenceRows, postEntryCore, reverseEntry } from './entries';
import { documentOutstanding, runPayables } from './payables';

type SettlementRow = typeof settlements.$inferSelect;
type AllocationRow = typeof settlementAllocations.$inferSelect;

export const PAYMENT_EXPLANATION = 'This records a payment already made. It does not transfer money.';

// ——— Views ———

const settlementRowView = (s: SettlementRow, allocated: bigint) => {
  const cur = s.currency.trim();
  return {
    id: s.id,
    direction: s.direction,
    state: s.state,
    amount: moneyOf(s.amountMinor, cur),
    allocated: moneyOf(allocated, cur),
    unallocated: moneyOf(s.state === 'draft' ? s.amountMinor : s.unallocatedMinor, cur),
    remainderPolicy: s.remainderPolicy,
    paidAt: s.paidAt.toISOString(),
    paymentReference: s.paymentReference,
    paymentSourceNamespace: s.paymentSourceNamespace,
    manualReference: s.manualReference,
    counterparty: s.counterparty,
    compensationRunId: s.compensationRunId,
    createdAt: s.createdAt.toISOString(),
    rowVersion: s.rowVersion,
  };
};

const activeAllocated = (allocs: AllocationRow[]) => allocs.filter((a) => !a.reversedAt).reduce((x, a) => x + a.amountMinor, 0n);

/** A settlement is visible with workspace finance.read, or when it settles a document the member may read. */
const settlementVisibilitySql = (ctx: QueryContext) => {
  const direct = financeScopeSql(ctx, 'finance.read', {});
  if (direct === undefined) return undefined;
  const entryScope = entryVisibilitySql(ctx);
  return sql`EXISTS (SELECT 1 FROM settlement_allocations sa JOIN financial_entries ON financial_entries.id = sa.target_entry_id WHERE sa.settlement_id = ${settlements.id} AND sa.workspace_id = ${settlements.workspaceId} ${entryScope ? sql`AND ${entryScope}` : sql``})`;
};

const canReadSettlement = async (ctx: QueryContext | CommandContext, s: SettlementRow) => {
  if (can(ctx.actor.access, 'finance.read')) return true;
  const visible = settlementVisibilitySql(ctx);
  if (!visible) return true;
  const [r] = await dbOf(ctx).select({ id: settlements.id }).from(settlements).where(and(eq(settlements.id, s.id), visible));
  return !!r;
};

export const getSettlement = async (ctx: QueryContext | CommandContext, id: string) => {
  const s = await findById(ctx, settlements, id, 'Settlement');
  if (!hasAnywhere(ctx.actor.access, 'finance.read') || !(await canReadSettlement(ctx, s))) throw new AppError('NOT_FOUND', 'Settlement was not found.');
  const db = dbOf(ctx);
  const ws = ctx.actor.workspaceId;
  const allocs = await db.select().from(settlementAllocations).where(and(eq(settlementAllocations.workspaceId, ws), eq(settlementAllocations.settlementId, id))).orderBy(asc(settlementAllocations.createdAt));
  const entryIds = allocs.map((a) => a.targetEntryId).filter((x): x is string => !!x);
  const runIds = allocs.map((a) => a.targetRunId).filter((x): x is string => !!x);
  const entries = entryIds.length ? await db.select({ id: financialEntries.id, title: financialEntries.title, recognitionDate: financialEntries.recognitionDate }).from(financialEntries).where(inArray(financialEntries.id, entryIds)) : [];
  const runs = runIds.length ? await db.select({ id: compensationRuns.id, periodStart: compensationRuns.periodStart, periodEnd: compensationRuns.periodEnd }).from(compensationRuns).where(inArray(compensationRuns.id, runIds)) : [];
  const u2m = await userMembershipMap(db, ws, [s.createdBy, s.confirmedBy]);
  const refs = await loadMemberRefs(db, ws, [...u2m.values(), ...allocs.map((a) => a.recipientMembershipId)]);
  const workspaceLevel = can(ctx.actor.access, 'finance.read');
  const viewEvidence = can(ctx.actor.access, 'finance.documents.read');
  const confirmAllowed = hasAnywhere(ctx.actor.access, 'settlements.confirm');
  return {
    ...settlementRowView(s, activeAllocated(allocs)),
    note: s.note,
    duplicateAckReason: s.duplicateAckReason,
    confirmedAt: s.confirmedAt?.toISOString() ?? null,
    confirmedBy: s.confirmedBy && u2m.get(s.confirmedBy) ? refOrUnknown(refs, u2m.get(s.confirmedBy)) : null,
    reversedAt: s.reversedAt?.toISOString() ?? null,
    reversalReason: s.reversalReason,
    reversalEffectiveDate: s.reversalEffectiveDate,
    allocations: allocs.map((a) => {
      const e = entries.find((x) => x.id === a.targetEntryId);
      const r = runs.find((x) => x.id === a.targetRunId);
      return {
        id: a.id,
        targetType: a.targetType,
        entry: e ? { id: e.id, title: e.title, recognitionDate: e.recognitionDate } : null,
        run: r ? { id: r.id, periodStart: r.periodStart, periodEnd: r.periodEnd } : null,
        recipient: a.recipientMembershipId ? refOrUnknown(refs, a.recipientMembershipId) : null,
        amount: moneyOf(a.amountMinor, s.currency.trim()),
        documentAmount: moneyOf(a.documentAmountMinor, a.documentCurrency.trim()),
        effectiveFxRate: a.effectiveFxRate,
        realizedDifferenceEntryId: a.realizedDifferenceEntryId,
        reversedAt: a.reversedAt?.toISOString() ?? null,
        reversalReason: a.reversalReason,
      };
    }),
    ...(viewEvidence ? { evidence: await evidenceRows(ctx, { id: s.id, evidenceAssetIds: s.evidenceAssetIds }, 'settlement') } : {}),
    createdBy: s.createdBy && u2m.get(s.createdBy) ? refOrUnknown(refs, u2m.get(s.createdBy)) : null,
    permissions: {
      update: s.state === 'draft' && hasAnywhere(ctx.actor.access, 'settlements.create'),
      confirm: s.state === 'draft' && confirmAllowed,
      match: s.state === 'confirmed' && s.unallocatedMinor > 0n && confirmAllowed,
      reverse: s.state === 'confirmed' && hasAnywhere(ctx.actor.access, 'settlements.reverse') && workspaceLevel,
      attachEvidence: viewEvidence && hasAnywhere(ctx.actor.access, 'assets.upload') && s.state !== 'reversed',
    },
  };
};

export const listSettlements = async (
  ctx: QueryContext,
  input: { cursor?: string; pageSize?: number; direction?: 'in' | 'out'; state?: SettlementRow['state'][]; from?: string; to?: string; unmatched?: boolean; q?: string; entryId?: string; runId?: string },
) => {
  requirePermission(ctx, 'finance.read');
  const size = clampPageSize(input.pageSize);
  const c = input.cursor ? decodeCursor(input.cursor) : null;
  const q = input.q?.trim();
  const rows = await dbOf(ctx)
    .select()
    .from(settlements)
    .where(
      and(
        eq(settlements.workspaceId, ctx.actor.workspaceId),
        settlementVisibilitySql(ctx),
        input.direction ? eq(settlements.direction, input.direction) : undefined,
        input.state?.length ? inArray(settlements.state, input.state) : undefined,
        input.from ? sql`${settlements.paidAt} >= ${input.from}::date` : undefined,
        input.to ? sql`${settlements.paidAt} < (${input.to}::date + 1)` : undefined,
        input.unmatched ? or(eq(settlements.state, 'draft'), and(eq(settlements.state, 'confirmed'), sql`${settlements.unallocatedMinor} > 0`)) : undefined,
        input.entryId ? sql`EXISTS (SELECT 1 FROM settlement_allocations sa WHERE sa.settlement_id = ${settlements.id} AND sa.target_entry_id = ${input.entryId})` : undefined,
        input.runId ? sql`EXISTS (SELECT 1 FROM settlement_allocations sa WHERE sa.settlement_id = ${settlements.id} AND sa.target_run_id = ${input.runId})` : undefined,
        q
          ? or(
              ilike(settlements.counterparty, `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`),
              ilike(settlements.paymentReference, `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`),
              ilike(settlements.note, `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`),
            )
          : undefined,
        c ? or(lt(settlements.paidAt, new Date(String(c.v[0]))), and(eq(settlements.paidAt, new Date(String(c.v[0]))), lt(settlements.id, c.id))) : undefined,
      ),
    )
    .orderBy(desc(settlements.paidAt), desc(settlements.id))
    .limit(size + 1);
  const hasMore = rows.length > size;
  const pageRows = hasMore ? rows.slice(0, size) : rows;
  const allocs = pageRows.length
    ? await dbOf(ctx).select().from(settlementAllocations).where(and(eq(settlementAllocations.workspaceId, ctx.actor.workspaceId), inArray(settlementAllocations.settlementId, pageRows.map((r) => r.id))))
    : [];
  const last = pageRows[pageRows.length - 1];
  return {
    items: pageRows.map((s) => settlementRowView(s, activeAllocated(allocs.filter((a) => a.settlementId === s.id)))),
    hasMore,
    nextCursor: hasMore && last ? encodeCursor({ v: [last.paidAt.toISOString()], id: last.id }) : null,
  };
};

// ——— Commands ———

export interface SettlementInput {
  direction: 'in' | 'out';
  amount: string;
  currency: string;
  paidAt: string;
  paymentSourceNamespace?: string;
  paymentReference?: string | null;
  counterparty?: string | null;
  note?: string | null;
  duplicateAckReason?: string | null;
}

const validateSettlement = async (ctx: CommandContext, input: SettlementInput, existingId?: string) => {
  const errors: FieldError[] = [];
  const amountMinor = parseAmount(input.amount, input.currency, 'amount', errors);
  const paidAt = new Date(input.paidAt);
  if (paidAt.getTime() > ctx.app.clock.now().getTime() + 5 * 60_000)
    errors.push({ field: 'paidAt', code: 'FUTURE', message: 'Record payments that already happened; the date cannot be in the future.' });
  throwIfErrors(errors);
  const ns = input.paymentSourceNamespace?.trim() || 'manual';
  const ref = input.paymentReference?.trim() || null;
  if (ref) {
    const [dup] = await ctx.tx
      .select({ id: settlements.id })
      .from(settlements)
      .where(and(eq(settlements.workspaceId, ctx.actor.workspaceId), eq(settlements.paymentSourceNamespace, ns), eq(settlements.paymentReference, ref), existingId ? ne(settlements.id, existingId) : undefined));
    if (dup) throw new AppError('DUPLICATE', 'This payment reference is already recorded for this payment source.', { details: { reason: 'duplicate_reference', settlementId: dup.id } });
  }
  return { amountMinor, paidAt, ns, ref };
};

/** Heuristic warning only (spec §18.4): same counterparty, amount, currency and calendar day. */
const similarSettlements = async (ctx: CommandContext, input: SettlementInput, amountMinor: bigint, paidAt: Date, timezone: string, existingId?: string) => {
  const day = localDate(paidAt, timezone);
  const rows = await ctx.tx
    .select({ id: settlements.id, paidAt: settlements.paidAt, reference: settlements.paymentReference, state: settlements.state })
    .from(settlements)
    .where(
      and(
        eq(settlements.workspaceId, ctx.actor.workspaceId),
        eq(settlements.amountMinor, amountMinor),
        eq(settlements.currency, input.currency),
        eq(settlements.direction, input.direction),
        ne(settlements.state, 'reversed'),
        input.counterparty?.trim() ? sql`lower(${settlements.counterparty}) = lower(${input.counterparty.trim()})` : isNull(settlements.counterparty),
        existingId ? ne(settlements.id, existingId) : undefined,
      ),
    );
  return rows.filter((r) => localDate(r.paidAt, timezone) === day);
};

export const createSettlement = async (ctx: CommandContext, input: SettlementInput, opts: { compensationRunId?: string; internal?: boolean } = {}) => {
  if (!opts.internal) requirePermission(ctx, 'settlements.create');
  const { timezone } = await workspaceFinance(ctx);
  const v = await validateSettlement(ctx, input);
  let manual = false;
  let reference = v.ref;
  if (!reference) {
    const similar = await similarSettlements(ctx, input, v.amountMinor, v.paidAt, timezone);
    if (similar.length && !input.duplicateAckReason?.trim())
      throw new AppError('CONFLICT', 'A similar payment (same counterparty, amount, currency and date) is already recorded. Confirm that this is a different payment and give a reason.', {
        details: { reason: 'possible_duplicate', matches: similar.map((s) => ({ id: s.id, paidAt: s.paidAt.toISOString(), reference: s.reference, state: s.state })) },
        fieldErrors: [{ field: 'duplicateAckReason', code: 'REQUIRED', message: 'Explain why this is a different payment.' }],
      });
    manual = true;
    reference = `MAN-${localDate(v.paidAt, timezone).replace(/-/g, '')}-${newId().slice(0, 8).toUpperCase()}`;
  }
  const id = newId();
  const [row] = await ctx.tx
    .insert(settlements)
    .values({
      ...stamp(ctx),
      id,
      direction: input.direction,
      state: 'draft',
      amountMinor: v.amountMinor,
      currency: input.currency,
      paidAt: v.paidAt,
      paymentSourceNamespace: v.ns,
      paymentReference: reference,
      manualReference: manual,
      duplicateAckReason: input.duplicateAckReason?.trim() || null,
      counterparty: input.counterparty?.trim() || null,
      note: input.note ?? null,
      compensationRunId: opts.compensationRunId ?? null,
    })
    .returning();
  await audit(ctx, {
    action: 'settlement.created',
    entityType: 'settlement',
    entityId: id,
    sensitivity: 'finance',
    diff: diffFields(null, row!, ['direction', 'paidAt', 'paymentReference', 'counterparty']),
    reason: input.duplicateAckReason ?? null,
  });
  await emit(ctx, { type: 'settlement.created', entityType: 'settlement', entityId: id, revision: 1, payload: { state: 'draft' } });
  return id;
};

export const updateSettlement = async (ctx: CommandContext, id: string, patch: Partial<SettlementInput>) => {
  requirePermission(ctx, 'settlements.create');
  const s = await lockById(ctx, settlements, id, 'Settlement');
  if (!(await canReadSettlement(ctx, s))) throw new AppError('NOT_FOUND', 'Settlement was not found.');
  assertVersion(ctx, s);
  if (s.state !== 'draft') throw new AppError('INVALID_STATE', 'Only draft settlements can be edited. Reverse a confirmed settlement instead.', { details: { reason: 'not_draft' } });
  const cur = s.currency.trim();
  const merged: SettlementInput = {
    direction: patch.direction ?? s.direction,
    amount: patch.amount ?? moneyOf(s.amountMinor, cur).amount,
    currency: patch.currency ?? cur,
    paidAt: patch.paidAt ?? s.paidAt.toISOString(),
    paymentSourceNamespace: patch.paymentSourceNamespace ?? s.paymentSourceNamespace,
    paymentReference: patch.paymentReference !== undefined ? patch.paymentReference : s.manualReference ? null : s.paymentReference,
    counterparty: patch.counterparty !== undefined ? patch.counterparty : s.counterparty,
    note: patch.note !== undefined ? patch.note : s.note,
    duplicateAckReason: patch.duplicateAckReason ?? s.duplicateAckReason,
  };
  const v = await validateSettlement(ctx, merged, id);
  const [row] = await ctx.tx
    .update(settlements)
    .set({
      direction: merged.direction,
      amountMinor: v.amountMinor,
      currency: merged.currency,
      paidAt: v.paidAt,
      paymentSourceNamespace: v.ns,
      paymentReference: v.ref ?? (s.manualReference ? s.paymentReference : null),
      manualReference: v.ref ? false : s.manualReference,
      counterparty: merged.counterparty?.trim() || null,
      note: merged.note ?? null,
      duplicateAckReason: merged.duplicateAckReason ?? null,
      ...touch(ctx, settlements),
    })
    .where(eq(settlements.id, id))
    .returning();
  await audit(ctx, { action: 'settlement.updated', entityType: 'settlement', entityId: id, sensitivity: 'finance', diff: diffFields(s, row!, ['direction', 'amountMinor', 'currency', 'paidAt', 'paymentReference', 'counterparty', 'note']) });
  await emit(ctx, { type: 'settlement.updated', entityType: 'settlement', entityId: id, revision: row!.rowVersion });
  return id;
};

export interface AllocationLineInput {
  targetType: 'entry' | 'compensation_run';
  targetEntryId?: string;
  targetRunId?: string;
  recipientMembershipId?: string;
  amount: string;
  documentAmount?: string;
  documentCurrency?: string;
}

const fxCategoryId = async (ctx: CommandContext) => {
  const [c] = await ctx.tx
    .select({ id: financeCategories.id })
    .from(financeCategories)
    .where(and(eq(financeCategories.workspaceId, ctx.actor.workspaceId), eq(financeCategories.accountingClass, 'fx_difference'), isNull(financeCategories.archivedAt)))
    .orderBy(asc(financeCategories.sortOrder))
    .limit(1);
  if (!c) throw new AppError('INVALID_STATE', 'Add an active category with the FX difference class to record realized FX differences.', { details: { reason: 'no_fx_category' } });
  return c.id;
};

/** Allocate settlement money to documents / compensation recipients; returns the total allocated. */
const applyAllocations = async (ctx: CommandContext, s: SettlementRow, lines: AllocationLineInput[], available: bigint): Promise<{ total: bigint; runIds: string[] }> => {
  const errors: FieldError[] = [];
  const sCur = s.currency.trim();
  const { baseCurrency } = await workspaceFinance(ctx);
  const paidDate = s.paidAt.toISOString().slice(0, 10);
  let total = 0n;
  const touchedRuns = new Set<string>();
  const perTarget = new Map<string, bigint>();
  for (const [i, l] of lines.entries()) {
    const f = (k: string) => `allocationLines.${i}.${k}`;
    const amount = parseAmount(l.amount, sCur, f('amount'), errors);
    if (errors.length) continue;
    total += amount;
    if (l.targetType === 'compensation_run') {
      if (s.direction !== 'out') {
        errors.push({ field: f('targetType'), code: 'DIRECTION', message: 'Compensation is settled by outgoing payments.' });
        continue;
      }
      if (!can(ctx.actor.access, 'payments.record') && !can(ctx.actor.access, 'compensation.runs.approve')) throw new AppError('FORBIDDEN', 'Recording compensation payouts needs the payments permission.');
      const [run] = await ctx.tx.select().from(compensationRuns).where(and(eq(compensationRuns.workspaceId, ctx.actor.workspaceId), eq(compensationRuns.id, l.targetRunId!))).for('update');
      if (!run) {
        errors.push({ field: f('targetRunId'), code: 'NOT_FOUND', message: 'Run was not found.' });
        continue;
      }
      if (!['approved', 'partially_paid', 'paid'].includes(run.state)) {
        errors.push({ field: f('targetRunId'), code: 'NOT_APPROVED', message: 'Only approved runs can be paid.' });
        continue;
      }
      const payables = await runPayables(ctx, [run.id]);
      const p = payables.find((x) => x.recipientMembershipId === l.recipientMembershipId && x.currency === (l.documentCurrency ?? sCur));
      if (!p) {
        errors.push({ field: f('recipientMembershipId'), code: 'NOT_IN_RUN', message: 'This member has no approved amount in this currency in the run.' });
        continue;
      }
      if (sCur !== p.currency) {
        errors.push({ field: f('amount'), code: 'CURRENCY', message: `Record the payout in ${p.currency}.` });
        continue;
      }
      const key = `run:${run.id}:${p.recipientMembershipId}`;
      const already = perTarget.get(key) ?? 0n;
      if (amount + already > p.outstandingMinor) {
        errors.push({ field: f('amount'), code: 'EXCEEDS_OUTSTANDING', message: `The payout exceeds the outstanding compensation (${moneyOf(p.outstandingMinor, p.currency).amount} ${p.currency}).` });
        continue;
      }
      perTarget.set(key, already + amount);
      await ctx.tx.insert(settlementAllocations).values({
        ...stamp(ctx),
        id: newId(),
        settlementId: s.id,
        targetType: 'compensation_run',
        targetRunId: run.id,
        recipientMembershipId: p.recipientMembershipId,
        amountMinor: amount,
        documentAmountMinor: amount,
        documentCurrency: sCur,
      });
      touchedRuns.add(run.id);
      continue;
    }

    // Document allocation.
    const [e] = await ctx.tx.select().from(financialEntries).where(and(eq(financialEntries.workspaceId, ctx.actor.workspaceId), eq(financialEntries.id, l.targetEntryId!))).for('update');
    if (!e) {
      errors.push({ field: f('targetEntryId'), code: 'NOT_FOUND', message: 'Entry was not found.' });
      continue;
    }
    const allocRows = await ctx.tx.select({ projectId: financialAllocations.projectId }).from(financialAllocations).where(eq(financialAllocations.entryId, e.id));
    const scopes = financeScopes('financial_entry', e.id, allocRows.map((a) => a.projectId), e.accountId);
    if (!canAny(ctx, 'finance.read', scopes)) {
      errors.push({ field: f('targetEntryId'), code: 'NOT_FOUND', message: 'Entry was not found.' });
      continue;
    }
    if (e.state !== 'posted' || e.reversedByEntryId || e.reversesEntryId) {
      errors.push({ field: f('targetEntryId'), code: 'NOT_POSTED', message: 'Only posted, non-reversed entries can be settled.' });
      continue;
    }
    const os = await documentOutstanding(ctx, { entryIds: [e.id] });
    const currencies = [...new Set(os.map((o) => o.currency))];
    const docCur = l.documentCurrency ?? (currencies.length === 1 ? currencies[0]! : sCur);
    const o = os.find((x) => x.currency === docCur);
    if (!o) {
      errors.push({ field: f('documentCurrency'), code: 'NOTHING_OUTSTANDING', message: `Nothing is outstanding on this entry in ${docCur}.` });
      continue;
    }
    if ((s.direction === 'in' && o.balanceMinor < 0n) || (s.direction === 'out' && o.balanceMinor > 0n)) {
      errors.push({ field: f('targetEntryId'), code: 'DIRECTION', message: s.direction === 'in' ? 'Incoming money settles receivables, not payables.' : 'Outgoing money settles payables, not receivables.' });
      continue;
    }
    let docAmount: bigint;
    if (docCur === sCur) {
      docAmount = l.documentAmount ? parseAmount(l.documentAmount, docCur, f('documentAmount'), errors) : amount;
      if (docAmount !== amount) errors.push({ field: f('documentAmount'), code: 'MISMATCH', message: 'In the same currency the document amount equals the cash amount.' });
    } else {
      if (!l.documentAmount) {
        errors.push({ field: f('documentAmount'), code: 'REQUIRED', message: `Enter the amount settled in ${docCur}; both amounts are required when currencies differ.` });
        continue;
      }
      docAmount = parseAmount(l.documentAmount, docCur, f('documentAmount'), errors);
    }
    if (errors.length) continue;
    const key = `entry:${e.id}:${docCur}`;
    const already = perTarget.get(key) ?? 0n;
    if (docAmount + already > o.outstandingMinor) {
      errors.push({
        field: f('amount'),
        code: 'EXCEEDS_OUTSTANDING',
        message: `More than the outstanding ${moneyOf(o.outstandingMinor, docCur).amount} ${docCur}. Record the excess as an advance or unallocated remainder.`,
      });
      continue;
    }
    perTarget.set(key, already + docAmount);
    const allocationId = newId();
    let realizedId: string | null = null;
    let rate: string | null = null;
    if (docCur !== sCur) {
      rate = effectiveSettlementRate(amount, sCur, docAmount, docCur);
      // Realized FX difference: cash base vs the frozen base of the settled document portion.
      const lines = await ctx.tx.select().from(financialEntryLines).where(eq(financialEntryLines.entryId, e.id));
      const docLines = lines.filter((x) => x.currency.trim() === docCur);
      const docBal = docLines.reduce((a, x) => a + signedEffect({ accountingClass: x.accountingClass, amountMinor: x.amountMinor, isReversal: x.isReversal, fxEffect: x.fxEffect }), 0n);
      const docBaseBal = docLines.reduce((a, x) => a + signedEffect({ accountingClass: x.accountingClass, amountMinor: x.baseAmountMinor ?? 0n, isReversal: x.isReversal, fxEffect: x.fxEffect }), 0n);
      const abs = (v: bigint) => (v < 0n ? -v : v);
      const docBase = proportionalBase(docAmount, abs(docBal), abs(docBaseBal));
      let cashBase: bigint | null = sCur === baseCurrency ? amount : null;
      if (cashBase === null) {
        const rates = await ctx.tx.select().from(fxRates).where(and(eq(fxRates.workspaceId, ctx.actor.workspaceId), eq(fxRates.fromCurrency, sCur), eq(fxRates.toCurrency, baseCurrency)));
        const r = pickRate(rates.map((x) => ({ ...x, fromCurrency: x.fromCurrency.trim(), toCurrency: x.toCurrency.trim(), createdAt: x.createdAt.toISOString() })), sCur, baseCurrency, paidDate);
        if (!r) {
          errors.push({ field: f('amount'), code: 'FX_MISSING', message: `Add an FX rate ${sCur}→${baseCurrency} effective on or before ${paidDate} to value the cash.` });
          continue;
        }
        cashBase = baseEquivalent(amount, sCur, baseCurrency, r.rate);
        await ctx.tx.update(fxRates).set({ firstUsedAt: ctx.app.clock.now() }).where(and(eq(fxRates.id, r.id), isNull(fxRates.firstUsedAt)));
      }
      const diff = realizedDifference({ direction: s.direction, documentBaseMinor: docBase, cashBaseMinor: cashBase! });
      if (diff !== 0n) {
        const catId = await fxCategoryId(ctx);
        const projectRows = await ctx.tx
          .select({ projectId: financialAllocations.projectId, base: sql<string>`sum(${financialAllocations.baseAmountMinor})::text` })
          .from(financialAllocations)
          .where(eq(financialAllocations.entryId, e.id))
          .groupBy(financialAllocations.projectId);
        const weights = projectRows.filter((p) => BigInt(p.base ?? '0') !== 0n);
        realizedId = await createEntry(
          ctx,
          {
            type: 'adjustment',
            title: `Realized FX difference: ${e.title}`.slice(0, 120),
            recognitionDate: paidDate,
            note: `Settlement ${s.paymentReference ?? s.id}: ${moneyOf(amount, sCur).amount} ${sCur} for ${moneyOf(docAmount, docCur).amount} ${docCur}.`,
            lines: [
              {
                categoryId: catId,
                amount: moneyOf(diff < 0n ? -diff : diff, baseCurrency).amount,
                currency: baseCurrency,
                fxEffect: diff > 0n ? 'gain' : 'loss',
                allocation: weights.length
                  ? { mode: 'weights', rows: weights.map((w) => ({ projectId: w.projectId, value: (BigInt(w.base) < 0n ? -BigInt(w.base) : BigInt(w.base)).toString() })) }
                  : null,
              },
            ],
          },
          { internal: true, via: 'settlement' },
        );
        const [re] = await ctx.tx.select().from(financialEntries).where(eq(financialEntries.id, realizedId)).for('update');
        await ctx.tx.update(financialEntries).set({ state: 'submitted', submittedAt: ctx.app.clock.now(), submittedBy: ctx.actor.userId }).where(eq(financialEntries.id, realizedId));
        await postEntryCore(ctx, { ...re!, state: 'submitted' }, { approverNote: 'Realized FX difference from a confirmed settlement', notifyAuthor: false });
      }
    }
    await ctx.tx.insert(settlementAllocations).values({
      ...stamp(ctx),
      id: allocationId,
      settlementId: s.id,
      targetType: 'entry',
      targetEntryId: e.id,
      amountMinor: amount,
      documentAmountMinor: docAmount,
      documentCurrency: docCur,
      effectiveFxRate: rate,
      realizedDifferenceEntryId: realizedId,
    });
    await emit(ctx, { type: 'financial_entry.settled', entityType: 'financial_entry', entityId: e.id });
  }
  throwIfErrors(errors);
  if (total > available)
    throw new AppError('VALIDATION_FAILED', `Allocated ${moneyOf(total, sCur).amount} ${sCur} exceeds the available ${moneyOf(available, sCur).amount} ${sCur}.`, {
      fieldErrors: [{ field: 'allocationLines', code: 'EXCEEDS', message: 'The allocation exceeds the settlement amount.' }],
    });
  return { total, runIds: [...touchedRuns] };
};

/** Approved → Partially Paid → Paid follows recorded payouts (never a bank transfer). */
export const refreshRunPaymentState = async (ctx: CommandContext, runId: string) => {
  const [run] = await ctx.tx.select().from(compensationRuns).where(eq(compensationRuns.id, runId)).for('update');
  if (!run || !['approved', 'partially_paid', 'paid'].includes(run.state)) return;
  const p = await runPayables(ctx, [runId]);
  const payable = p.reduce((a, x) => a + x.payableMinor, 0n);
  const paid = p.reduce((a, x) => a + x.paidMinor, 0n);
  const outstanding = p.reduce((a, x) => a + x.outstandingMinor, 0n);
  const next = paid === 0n ? 'approved' : outstanding <= 0n && payable > 0n ? 'paid' : 'partially_paid';
  const totals = [...new Set(p.map((x) => x.currency))].map((c) => ({
    currency: c,
    amountMinor: p.filter((x) => x.currency === c).reduce((a, x) => a + x.totalMinor, 0n).toString(),
    paidMinor: p.filter((x) => x.currency === c).reduce((a, x) => a + x.paidMinor, 0n).toString(),
  }));
  if (next !== run.state || JSON.stringify(totals) !== JSON.stringify(run.totals)) {
    const [row] = await ctx.tx.update(compensationRuns).set({ state: next, totals, ...touch(ctx, compensationRuns) }).where(eq(compensationRuns.id, runId)).returning();
    await emit(ctx, { type: 'compensation_run.payment_state', entityType: 'compensation_run', entityId: runId, revision: row!.rowVersion, payload: { state: next } });
  }
};

export const confirmSettlement = async (
  ctx: CommandContext,
  id: string,
  input: { allocationLines: AllocationLineInput[]; remainderPolicy: 'none' | 'advance' | 'unallocated'; remainderNote?: string },
  opts: { internal?: boolean; expectedVersion?: number } = {},
) => {
  if (!opts.internal) requirePermission(ctx, 'settlements.confirm');
  const s = await lockById(ctx, settlements, id, 'Settlement');
  if (!opts.internal) {
    if (!(await canReadSettlement(ctx, s))) throw new AppError('NOT_FOUND', 'Settlement was not found.');
    assertVersion(ctx, s);
  } else if (opts.expectedVersion !== undefined && opts.expectedVersion !== s.rowVersion) throw new AppError('VERSION_CONFLICT', 'The settlement changed.', { currentVersion: s.rowVersion });
  assertTransition(SETTLEMENT_TRANSITIONS, s.state, 'confirmed', 'settlement');
  await assertPeriodOpen(ctx, s.paidAt.toISOString().slice(0, 10), 'settle');
  const { total: allocated, runIds } = await applyAllocations(ctx, s, input.allocationLines, s.amountMinor);
  const remainder = s.amountMinor - allocated;
  if (remainder > 0n && input.remainderPolicy === 'none')
    throw new AppError('VALIDATION_FAILED', `${moneyOf(remainder, s.currency.trim()).amount} ${s.currency} is not allocated. Record it explicitly as an advance or an unallocated balance.`, {
      fieldErrors: [{ field: 'remainderPolicy', code: 'REQUIRED', message: 'Choose Advance or Unallocated for the remainder.' }],
      details: { reason: 'remainder_policy_required', remainder: moneyOf(remainder, s.currency.trim()) },
    });
  const at = ctx.app.clock.now();
  const note = input.remainderNote?.trim() ? [s.note, `Remainder: ${input.remainderNote.trim()}`].filter(Boolean).join('\n') : s.note;
  const [row] = await ctx.tx
    .update(settlements)
    .set({
      state: 'confirmed',
      confirmedAt: at,
      confirmedBy: ctx.actor.userId,
      unallocatedMinor: remainder,
      remainderPolicy: remainder > 0n ? input.remainderPolicy : 'none',
      note,
      ...touch(ctx, settlements),
    })
    .where(eq(settlements.id, id))
    .returning();
  await audit(ctx, {
    action: 'settlement.confirmed',
    entityType: 'settlement',
    entityId: id,
    sensitivity: 'finance',
    metadata: { allocations: input.allocationLines.length, remainderPolicy: row!.remainderPolicy, unallocated: remainder.toString() },
  });
  await emit(ctx, { type: 'settlement.confirmed', entityType: 'settlement', entityId: id, revision: row!.rowVersion, payload: { state: 'confirmed' } });
  for (const runId of runIds) await refreshRunPaymentState(ctx, runId);
  await notifyPayouts(ctx, id);
  return id;
};

const notifyPayouts = async (ctx: CommandContext, settlementId: string) => {
  const rows = await ctx.tx.select().from(settlementAllocations).where(and(eq(settlementAllocations.settlementId, settlementId), eq(settlementAllocations.targetType, 'compensation_run')));
  for (const r of rows)
    await notify(ctx.tx, {
      workspaceId: ctx.actor.workspaceId,
      recipientMembershipIds: r.recipientMembershipId ? [r.recipientMembershipId] : [],
      eventType: 'finance.payment_recorded',
      eventKey: `finance.payment_recorded:${r.id}`,
      kind: 'general',
      title: 'Payment recorded',
      excerpt: PAYMENT_EXPLANATION,
      sensitive: true,
      entityType: 'compensation_run',
      entityId: r.targetRunId ?? undefined,
      actorMembershipId: ctx.actor.membershipId,
      at: ctx.app.clock.now(),
    });
};

export const matchSettlement = async (ctx: CommandContext, id: string, input: { allocationLines: AllocationLineInput[] }) => {
  requirePermission(ctx, 'settlements.confirm');
  const s = await lockById(ctx, settlements, id, 'Settlement');
  if (!(await canReadSettlement(ctx, s))) throw new AppError('NOT_FOUND', 'Settlement was not found.');
  assertVersion(ctx, s);
  if (s.state !== 'confirmed') throw new AppError('INVALID_STATE', 'Only confirmed settlements have an unmatched balance to allocate.');
  if (s.unallocatedMinor <= 0n) throw new AppError('INVALID_STATE', 'Nothing is left to match on this settlement.');
  const { total: allocated, runIds } = await applyAllocations(ctx, s, input.allocationLines, s.unallocatedMinor);
  const [row] = await ctx.tx.update(settlements).set({ unallocatedMinor: s.unallocatedMinor - allocated, ...touch(ctx, settlements) }).where(eq(settlements.id, id)).returning();
  for (const runId of runIds) await refreshRunPaymentState(ctx, runId);
  await audit(ctx, { action: 'settlement.matched', entityType: 'settlement', entityId: id, sensitivity: 'finance', metadata: { allocated: allocated.toString() } });
  await emit(ctx, { type: 'settlement.matched', entityType: 'settlement', entityId: id, revision: row!.rowVersion });
  await notifyPayouts(ctx, id);
  return id;
};

const reverseOneAllocation = async (ctx: CommandContext, a: AllocationRow, reason: string, date: string) => {
  await ctx.tx.update(settlementAllocations).set({ reversedAt: ctx.app.clock.now(), reversalReason: reason, ...touch(ctx, settlementAllocations) }).where(eq(settlementAllocations.id, a.id));
  if (a.realizedDifferenceEntryId) await reverseEntry(ctx, a.realizedDifferenceEntryId, { reason: `Settlement allocation reversed: ${reason}`, effectiveDate: date }, { internal: true });
  if (a.targetRunId) await refreshRunPaymentState(ctx, a.targetRunId);
  if (a.targetEntryId) await emit(ctx, { type: 'financial_entry.settled', entityType: 'financial_entry', entityId: a.targetEntryId });
};

export const reverseSettlementAllocation = async (ctx: CommandContext, id: string, allocationId: string, input: { reason: string }) => {
  requirePermission(ctx, 'settlements.reverse');
  const s = await lockById(ctx, settlements, id, 'Settlement');
  if (!(await canReadSettlement(ctx, s))) throw new AppError('NOT_FOUND', 'Settlement was not found.');
  assertVersion(ctx, s);
  if (s.state !== 'confirmed') throw new AppError('INVALID_STATE', 'Only allocations of confirmed settlements can be reversed.');
  const [a] = await ctx.tx.select().from(settlementAllocations).where(and(eq(settlementAllocations.id, allocationId), eq(settlementAllocations.settlementId, id))).for('update');
  if (!a) throw new AppError('NOT_FOUND', 'Allocation was not found.');
  if (a.reversedAt) throw new AppError('INVALID_STATE', 'This allocation is already reversed.');
  const today = ctx.app.clock.now().toISOString().slice(0, 10);
  await assertPeriodOpen(ctx, today, 'reverse');
  await reverseOneAllocation(ctx, a, input.reason, today);
  const [row] = await ctx.tx
    .update(settlements)
    .set({ unallocatedMinor: s.unallocatedMinor + a.amountMinor, remainderPolicy: s.remainderPolicy === 'none' ? 'unallocated' : s.remainderPolicy, ...touch(ctx, settlements) })
    .where(eq(settlements.id, id))
    .returning();
  await audit(ctx, { action: 'settlement.allocation_reversed', entityType: 'settlement', entityId: id, sensitivity: 'finance', reason: input.reason, metadata: { allocationId } });
  await emit(ctx, { type: 'settlement.updated', entityType: 'settlement', entityId: id, revision: row!.rowVersion });
  return id;
};

export const reverseSettlement = async (ctx: CommandContext, id: string, input: { reason: string; effectiveDate: string }) => {
  requirePermission(ctx, 'settlements.reverse');
  const s = await lockById(ctx, settlements, id, 'Settlement');
  if (!(await canReadSettlement(ctx, s))) throw new AppError('NOT_FOUND', 'Settlement was not found.');
  assertVersion(ctx, s);
  assertTransition(SETTLEMENT_TRANSITIONS, s.state, 'reversed', 'settlement');
  await assertPeriodOpen(ctx, input.effectiveDate, 'reverse');
  const allocs = await ctx.tx.select().from(settlementAllocations).where(and(eq(settlementAllocations.settlementId, id), isNull(settlementAllocations.reversedAt))).for('update');
  for (const a of allocs) await reverseOneAllocation(ctx, a, input.reason, input.effectiveDate);
  const at = ctx.app.clock.now();
  const [row] = await ctx.tx
    .update(settlements)
    .set({ state: 'reversed', reversedAt: at, reversalReason: input.reason, reversalEffectiveDate: input.effectiveDate, ...touch(ctx, settlements) })
    .where(eq(settlements.id, id))
    .returning();
  await audit(ctx, { action: 'settlement.reversed', entityType: 'settlement', entityId: id, sensitivity: 'finance', reason: input.reason, metadata: { effectiveDate: input.effectiveDate } });
  await emit(ctx, { type: 'settlement.reversed', entityType: 'settlement', entityId: id, revision: row!.rowVersion, payload: { state: 'reversed' } });
  return id;
};

export const listOpenItems = async (ctx: QueryContext, input: { direction: 'in' | 'out'; currency?: string; q?: string; limit: number }) => {
  requirePermission(ctx, 'finance.read');
  const scope = entryVisibilitySql(ctx);
  const docs = await documentOutstanding(ctx, { direction: input.direction, scope, q: input.q, limit: input.limit });
  const items: {
    targetType: 'entry' | 'compensation_run';
    entryId: string | null;
    runId: string | null;
    recipient: { membershipId: string; displayName: string; avatarUrl: string | null } | null;
    title: string;
    date: string;
    outstanding: { amount: string; currency: string };
  }[] = docs
    .filter((d) => !input.currency || d.currency === input.currency)
    .map((d) => ({ targetType: 'entry', entryId: d.entryId, runId: null, recipient: null, title: d.title, date: d.recognitionDate, outstanding: moneyOf(d.outstandingMinor, d.currency) }));
  if (input.direction === 'out' && can(ctx.actor.access, 'compensation.runs.read')) {
    const runs = await dbOf(ctx)
      .select()
      .from(compensationRuns)
      .where(and(eq(compensationRuns.workspaceId, ctx.actor.workspaceId), inArray(compensationRuns.state, ['approved', 'partially_paid'])))
      .orderBy(desc(compensationRuns.periodEnd))
      .limit(50);
    const payables = await runPayables(ctx, runs.map((r) => r.id));
    const refs = await loadMemberRefs(dbOf(ctx), ctx.actor.workspaceId, payables.map((p) => p.recipientMembershipId));
    for (const p of payables) {
      if (p.outstandingMinor <= 0n || (input.currency && p.currency !== input.currency)) continue;
      const run = runs.find((r) => r.id === p.runId)!;
      items.push({
        targetType: 'compensation_run',
        entryId: null,
        runId: p.runId,
        recipient: refOrUnknown(refs, p.recipientMembershipId) as never,
        title: `Compensation ${run.periodStart} – ${run.periodEnd}`,
        date: run.periodEnd,
        outstanding: moneyOf(p.outstandingMinor, p.currency),
      });
    }
  }
  return items.slice(0, input.limit);
};

