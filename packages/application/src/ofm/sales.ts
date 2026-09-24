import { and, desc, eq, gte, inArray, lte, ne, sql } from 'drizzle-orm';
import { financialEntries, financialEntryLines, ofmContacts, operations, saleCandidates, shiftAccounts, shifts } from '@castlane/database';
import { AppError, formatMinor, newId, notFound, parseAmountToMinor, summarizeAllocations } from '@castlane/domain';
import { allowed, requireAnyPermission } from '../core/access';
import { audit } from '../core/audit';
import { dbOf, type CommandContext, type QueryContext } from '../core/context';
import { emit } from '../core/events';
import { assertVersion, lockById, stamp, touch } from '../core/rows';
import { assertAccountOpen, assertActiveMember, assertAssetsExist, exprKeyset, fieldErr, fieldErrs, invalid, requireOfmAccount, type Ctx } from './common';
import { canReadContact, canReadSale, canReadShift, saleScope, saleVisibility, saleViews, type SaleRow } from './views';

/**
 * Sale candidates (§13.5): registered per source during shifts. A source transaction is unique per
 * workspace (DB constraint) and is also checked against financial entries already recorded, so revenue
 * is never doubled (T098). Attribution to managers is explicit only — never inferred from the time of a
 * shift (T099). Finance verifies/rejects candidates and posts separately; OFM never writes finance.
 *
 * States for Finance: pending → verified (financial_entry_id set by Finance) | rejected (review_note).
 */

const normNamespace = (v: string) => v.trim().toLowerCase();

export const checkSaleDuplicate = async (ctx: QueryContext | CommandContext, input: { sourceNamespace: string; sourceTransactionId: string }) => {
  requireAnyPermission(ctx, ['sale-candidates.write', 'sale-candidates.review']);
  const db = dbOf(ctx);
  const ns = normNamespace(input.sourceNamespace);
  const tx = input.sourceTransactionId.trim();
  const [cand] = await db
    .select()
    .from(saleCandidates)
    .where(and(eq(saleCandidates.workspaceId, ctx.actor.workspaceId), eq(saleCandidates.sourceNamespace, ns), eq(saleCandidates.sourceTransactionId, tx)));
  const [entry] = await db
    .select({ id: financialEntries.id, state: financialEntries.state })
    .from(financialEntries)
    .where(and(eq(financialEntries.workspaceId, ctx.actor.workspaceId), eq(financialEntries.sourceNamespace, ns), eq(financialEntries.sourceExternalId, tx)));
  const [line] = entry
    ? []
    : await db
        .select({ id: financialEntryLines.entryId })
        .from(financialEntryLines)
        .where(and(eq(financialEntryLines.workspaceId, ctx.actor.workspaceId), eq(financialEntryLines.sourceNamespace, ns), eq(financialEntryLines.transactionRef, tx)))
        .limit(1);
  let finance: { id: string; state: string } | null = entry ?? null;
  if (!finance && line) {
    const [e] = await db.select({ id: financialEntries.id, state: financialEntries.state }).from(financialEntries).where(eq(financialEntries.id, line.id));
    finance = e ?? null;
  }
  return {
    duplicate: !!cand || !!finance,
    /** The fact is safe to reveal (prevents a double count); the entry itself only with finance.read. */
    recordedInFinance: !!finance,
    candidate: cand && canReadSale(ctx, cand) ? { id: cand.id, state: cand.state } : null,
    financialEntry: finance && allowed(ctx, 'finance.read', { projectId: cand?.projectId ?? null }) ? finance : null,
  };
};

export interface ListSalesInput {
  cursor?: string;
  pageSize?: number;
  state?: SaleRow['state'][];
  accountId?: string;
  projectId?: string;
  shiftId?: string;
  contactId?: string;
}

export const listSaleCandidates = async (ctx: QueryContext, input: ListSalesInput) => {
  requireAnyPermission(ctx, ['sale-candidates.write', 'sale-candidates.review', 'finance.read']);
  const k = exprKeyset(saleCandidates.occurredAt, saleCandidates.id, 'timestamp', 'desc', input);
  const rows = await ctx.app.db
    .select()
    .from(saleCandidates)
    .where(
      and(
        eq(saleCandidates.workspaceId, ctx.actor.workspaceId),
        saleVisibility(ctx),
        input.state?.length ? inArray(saleCandidates.state, input.state) : undefined,
        input.accountId ? eq(saleCandidates.accountId, input.accountId) : undefined,
        input.projectId ? eq(saleCandidates.projectId, input.projectId) : undefined,
        input.shiftId ? eq(saleCandidates.shiftId, input.shiftId) : undefined,
        input.contactId ? eq(saleCandidates.contactId, input.contactId) : undefined,
        k.where,
      ),
    )
    .orderBy(...k.orderBy)
    .limit(k.limit);
  const page = k.finish(rows, (r) => r.occurredAt, (r) => r.id);
  return { ...page, items: await saleViews(ctx, page.items) };
};

export const getSaleCandidate = async (ctx: QueryContext | CommandContext, id: string) => {
  const [s] = await dbOf(ctx).select().from(saleCandidates).where(and(eq(saleCandidates.workspaceId, ctx.actor.workspaceId), eq(saleCandidates.id, id)));
  if (!s || !canReadSale(ctx, s)) throw notFound('Sale candidate');
  return (await saleViews(ctx, [s]))[0]!;
};

interface MoneyInput {
  gross?: string | null;
  refund?: string | null;
  fee?: string | null;
  net?: string | null;
}

const parseMoney = (input: MoneyInput, currency: string) => {
  const out: Record<'grossMinor' | 'refundMinor' | 'feeMinor' | 'netMinor', bigint | null> = { grossMinor: null, refundMinor: null, feeMinor: null, netMinor: null };
  const errors: { field: string; code: string; message: string }[] = [];
  for (const [k, col] of [
    ['gross', 'grossMinor'],
    ['refund', 'refundMinor'],
    ['fee', 'feeMinor'],
    ['net', 'netMinor'],
  ] as const) {
    const v = input[k];
    if (v === undefined || v === null || v === '') continue;
    try {
      const m = parseAmountToMinor(v, currency);
      if (m < 0n) errors.push({ field: k, code: 'NEGATIVE', message: 'Enter a positive amount; refunds and fees have their own fields.' });
      out[col] = m;
    } catch (e) {
      errors.push({ field: k, code: 'INVALID_AMOUNT', message: (e as Error).message });
    }
  }
  if (out.grossMinor === null && out.netMinor === null) errors.push({ field: 'gross', code: 'REQUIRED', message: 'Enter the gross or the net amount reported by the source.' });
  if (errors.length) throw fieldErrs(errors, 'Check the amounts.');
  return out;
};

const validateAllocations = async (ctx: CommandContext, shares: { membershipId: string; sharePercent: string }[]) => {
  const s = summarizeAllocations(shares);
  if (s.issues.length) throw fieldErrs(s.issues);
  for (const [i, a] of shares.entries()) await assertActiveMember(ctx, a.membershipId, `claimedAllocations.${i}.membershipId`);
};

const assertLinks = async (ctx: CommandContext, accountId: string, input: { contactId?: string | null; shiftId?: string | null; operationId?: string | null }) => {
  if (input.contactId) {
    const [c] = await ctx.tx.select().from(ofmContacts).where(and(eq(ofmContacts.workspaceId, ctx.actor.workspaceId), eq(ofmContacts.id, input.contactId)));
    if (!c || !canReadContact(ctx, c) || c.accountId !== accountId) throw fieldErr('contactId', 'NOT_FOUND', 'Choose a contact of this account.');
  }
  if (input.shiftId) {
    // Explicit link only: a shift is never picked automatically by matching the sale time.
    const [s] = await ctx.tx.select().from(shifts).where(and(eq(shifts.workspaceId, ctx.actor.workspaceId), eq(shifts.id, input.shiftId)));
    const [link] = s ? await ctx.tx.select({ id: shiftAccounts.id }).from(shiftAccounts).where(and(eq(shiftAccounts.shiftId, s.id), eq(shiftAccounts.accountId, accountId))) : [];
    if (!s || !canReadShift(ctx, s) || !link) throw fieldErr('shiftId', 'NOT_FOUND', 'Choose a shift that covers this account.');
  }
  if (input.operationId) {
    const [o] = await ctx.tx.select({ id: operations.id, accountId: operations.accountId }).from(operations).where(and(eq(operations.workspaceId, ctx.actor.workspaceId), eq(operations.id, input.operationId)));
    if (!o || o.accountId !== accountId) throw fieldErr('operationId', 'NOT_FOUND', 'Choose an operation of this account.');
  }
};

/** Soft duplicate hints for the reviewer: same account, same amount, within 10 minutes, other source id. */
const duplicateHints = async (ctx: CommandContext, accountId: string, occurredAt: Date, money: { grossMinor: bigint | null; netMinor: bigint | null }, currency: string, excludeId?: string) => {
  const near = await ctx.tx
    .select({ id: saleCandidates.id })
    .from(saleCandidates)
    .where(
      and(
        eq(saleCandidates.workspaceId, ctx.actor.workspaceId),
        eq(saleCandidates.accountId, accountId),
        eq(saleCandidates.currency, currency),
        ne(saleCandidates.state, 'rejected'),
        excludeId ? ne(saleCandidates.id, excludeId) : undefined,
        gte(saleCandidates.occurredAt, new Date(occurredAt.getTime() - 10 * 60_000)),
        lte(saleCandidates.occurredAt, new Date(occurredAt.getTime() + 10 * 60_000)),
        money.grossMinor !== null ? eq(saleCandidates.grossMinor, money.grossMinor) : eq(saleCandidates.netMinor, money.netMinor!),
      ),
    )
    .orderBy(desc(saleCandidates.occurredAt))
    .limit(5);
  return near.length ? { possibleDuplicates: near.map((n) => n.id), rule: 'same account, amount and currency within 10 minutes' } : null;
};

export interface CreateSaleInput extends MoneyInput {
  accountId: string;
  sourceNamespace: string;
  sourceTransactionId?: string;
  manualReference: boolean;
  occurredAt: string;
  currency: string;
  contactId?: string | null;
  shiftId?: string | null;
  operationId?: string | null;
  sourceNote?: string | null;
  evidenceAssetIds: string[];
  claimedAllocations: { membershipId: string; sharePercent: string }[];
}

export const createSaleCandidate = async (ctx: CommandContext, input: CreateSaleInput) => {
  const { account, project } = await requireOfmAccount(ctx, input.accountId);
  const scope = { projectId: project.id, accountId: account.id };
  if (!allowed(ctx, 'sale-candidates.write', scope)) {
    if (allowed(ctx, 'ofm.overview.read', scope) || allowed(ctx, 'operations.read', scope)) throw new AppError('FORBIDDEN', 'You cannot register sales for this account.');
    throw notFound('Account');
  }
  assertAccountOpen(account);
  const ns = normNamespace(input.sourceNamespace);
  if (!input.manualReference && !input.sourceTransactionId) throw fieldErr('sourceTransactionId', 'REQUIRED', 'Enter the source transaction ID, or register a manual reference with evidence.');
  const evidence = await assertAssetsExist(ctx, input.evidenceAssetIds, 'evidenceAssetIds');
  if (input.manualReference && !evidence.length) throw fieldErr('evidenceAssetIds', 'REQUIRED', 'A manual reference needs evidence.');
  const occurredAt = new Date(input.occurredAt);
  if (occurredAt.getTime() > ctx.app.clock.now().getTime() + 5 * 60_000) throw fieldErr('occurredAt', 'IN_FUTURE', 'A sale cannot happen in the future.');
  const money = parseMoney(input, input.currency);
  await validateAllocations(ctx, input.claimedAllocations);
  await assertLinks(ctx, account.id, input);
  const sourceTransactionId = input.manualReference ? `manual-${newId()}` : input.sourceTransactionId!.trim();
  if (!input.manualReference) {
    const dup = await checkSaleDuplicate(ctx, { sourceNamespace: ns, sourceTransactionId });
    if (dup.duplicate)
      throw new AppError('DUPLICATE', dup.recordedInFinance ? 'This source transaction is already recorded in finance.' : 'This source transaction is already registered as a sale candidate.', {
        fieldErrors: [{ field: 'sourceTransactionId', code: 'DUPLICATE', message: 'Duplicate source transaction — revenue is never counted twice.' }],
        details: { candidate: dup.candidate, financialEntry: dup.financialEntry, alreadyInFinance: dup.recordedInFinance },
      });
  }
  const id = newId();
  await ctx.tx.insert(saleCandidates).values({
    ...stamp(ctx),
    id,
    accountId: account.id,
    projectId: project.id,
    sourceNamespace: ns,
    sourceTransactionId,
    manualReference: input.manualReference,
    contactId: input.contactId ?? null,
    shiftId: input.shiftId ?? null,
    operationId: input.operationId ?? null,
    occurredAt,
    ...money,
    currency: input.currency,
    sourceNote: input.sourceNote ?? null,
    evidenceAssetIds: evidence,
    claimedAllocations: input.claimedAllocations,
    duplicateWarning: await duplicateHints(ctx, account.id, occurredAt, money, input.currency),
  });
  // Amounts are finance-sensitive: not in the audit diff or the event payload.
  await audit(ctx, {
    action: 'sale_candidate.registered',
    entityType: 'sale_candidate',
    entityId: id,
    projectId: project.id,
    metadata: { sourceNamespace: ns, manualReference: input.manualReference, shiftId: input.shiftId ?? null, attribution: summarizeAllocations(input.claimedAllocations).status },
    sensitivity: 'finance',
  });
  await emit(ctx, { type: 'sale_candidate.registered', entityType: 'sale_candidate', entityId: id, revision: 1, payload: { state: 'pending' } });
  return id;
};

export const updateSaleCandidate = async (
  ctx: CommandContext,
  id: string,
  input: MoneyInput & { occurredAt?: string; contactId?: string | null; shiftId?: string | null; sourceNote?: string | null; evidenceAssetIds?: string[]; claimedAllocations?: { membershipId: string; sharePercent: string }[] },
) => {
  const s = await lockById(ctx, saleCandidates, id, 'Sale candidate');
  if (!canReadSale(ctx, s)) throw notFound('Sale candidate');
  const scope = saleScope(s);
  if (!(allowed(ctx, 'sale-candidates.review', scope) || (allowed(ctx, 'sale-candidates.write', scope) && s.createdBy === ctx.actor.userId)))
    throw new AppError('FORBIDDEN', 'Only the registering member or a reviewer can edit this candidate.');
  assertVersion(ctx, s);
  if (s.state !== 'pending') throw invalid('Only pending candidates can be edited.');
  const touched = ['gross', 'refund', 'fee', 'net'].some((k) => (input as Record<string, unknown>)[k] !== undefined);
  const cur = (v: bigint | null) => (v === null ? null : formatMinor(v, s.currency));
  const money = touched
    ? parseMoney(
        {
          gross: input.gross !== undefined ? input.gross : cur(s.grossMinor),
          refund: input.refund !== undefined ? input.refund : cur(s.refundMinor),
          fee: input.fee !== undefined ? input.fee : cur(s.feeMinor),
          net: input.net !== undefined ? input.net : cur(s.netMinor),
        },
        s.currency,
      )
    : null;
  if (input.claimedAllocations) await validateAllocations(ctx, input.claimedAllocations);
  await assertLinks(ctx, s.accountId, input);
  const evidence = input.evidenceAssetIds ? await assertAssetsExist(ctx, input.evidenceAssetIds, 'evidenceAssetIds') : s.evidenceAssetIds;
  if (s.manualReference && !evidence.length) throw fieldErr('evidenceAssetIds', 'REQUIRED', 'A manual reference needs evidence.');
  const occurredAt = input.occurredAt ? new Date(input.occurredAt) : s.occurredAt;
  await ctx.tx
    .update(saleCandidates)
    .set({
      occurredAt,
      ...(money ?? {}),
      contactId: input.contactId !== undefined ? input.contactId : s.contactId,
      shiftId: input.shiftId !== undefined ? input.shiftId : s.shiftId,
      sourceNote: input.sourceNote !== undefined ? input.sourceNote : s.sourceNote,
      evidenceAssetIds: evidence,
      claimedAllocations: input.claimedAllocations ?? s.claimedAllocations,
      duplicateWarning: await duplicateHints(ctx, s.accountId, occurredAt, money ?? { grossMinor: s.grossMinor, netMinor: s.netMinor }, s.currency, s.id),
      ...touch(ctx, saleCandidates),
    })
    .where(eq(saleCandidates.id, id));
  await audit(ctx, { action: 'sale_candidate.updated', entityType: 'sale_candidate', entityId: id, projectId: s.projectId, metadata: { fields: Object.keys(input) }, sensitivity: 'finance' });
  await emit(ctx, { type: 'sale_candidate.updated', entityType: 'sale_candidate', entityId: id });
  return id;
};

export const saleCandidateCount = async (ctx: Ctx, cond = sql`true`) =>
  dbOf(ctx)
    .select({ n: sql<string>`count(*)::text` })
    .from(saleCandidates)
    .where(and(eq(saleCandidates.workspaceId, ctx.actor.workspaceId), cond))
    .then((r) => Number(r[0]?.n ?? 0));
