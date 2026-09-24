import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { can, hasAnywhere } from '@castlane/authorization';
import { financeCategories, financialEntries, financialEntryLines, projects, saleCandidates, socialAccounts } from '@castlane/database';
import { AppError, clampPageSize, decodeCursor, encodeCursor, localDate, type FieldError } from '@castlane/domain';
import { filterToSql, requirePermission } from '../core/access';
import { listFilter } from '@castlane/authorization';
import { audit } from '../core/audit';
import { dbOf, type CommandContext, type QueryContext } from '../core/context';
import { emit } from '../core/events';
import { loadMemberRefs, refOrUnknown } from '../core/members';
import { notify } from '../core/notify';
import { assertVersion, findById, lockById, touch } from '../core/rows';
import { moneyOf, moneyOrNull, userMembershipMap, workspaceFinance } from './common';
import { createEntry, getEntry, setAttributions, type EntryInput } from './entries';

type CandidateRow = typeof saleCandidates.$inferSelect;

const candidateScope = (c: Pick<CandidateRow, 'id' | 'projectId' | 'accountId'>) => ({ objectType: 'sale_candidate', objectId: c.id, projectId: c.projectId, accountId: c.accountId });

/** Existing financial records for the same source transaction (T098). */
const duplicatesFor = async (ctx: QueryContext | CommandContext, rows: CandidateRow[]) => {
  const out = new Map<string, { entryId: string; title: string; state: string }>();
  if (!rows.length) return out;
  const db = dbOf(ctx);
  for (const c of rows) {
    const [byEntry] = await db
      .select({ id: financialEntries.id, title: financialEntries.title, state: financialEntries.state })
      .from(financialEntries)
      .where(
        and(
          eq(financialEntries.workspaceId, ctx.actor.workspaceId),
          eq(financialEntries.sourceNamespace, c.sourceNamespace),
          eq(financialEntries.sourceExternalId, c.sourceTransactionId),
          c.financialEntryId ? sql`${financialEntries.id} <> ${c.financialEntryId}` : undefined,
        ),
      )
      .limit(1);
    if (byEntry) {
      out.set(c.id, { entryId: byEntry.id, title: byEntry.title, state: byEntry.state });
      continue;
    }
    const [byLine] = await db
      .select({ id: financialEntries.id, title: financialEntries.title, state: financialEntries.state })
      .from(financialEntryLines)
      .innerJoin(financialEntries, eq(financialEntries.id, financialEntryLines.entryId))
      .where(
        and(
          eq(financialEntryLines.workspaceId, ctx.actor.workspaceId),
          eq(financialEntryLines.sourceNamespace, c.sourceNamespace),
          eq(financialEntryLines.transactionRef, c.sourceTransactionId),
          eq(financialEntryLines.isReversal, false),
          c.financialEntryId ? sql`${financialEntries.id} <> ${c.financialEntryId}` : undefined,
        ),
      )
      .limit(1);
    if (byLine) out.set(c.id, { entryId: byLine.id, title: byLine.title, state: byLine.state });
  }
  return out;
};

const candidateViews = async (ctx: QueryContext | CommandContext, rows: CandidateRow[]) => {
  if (!rows.length) return [];
  const db = dbOf(ctx);
  const ws = ctx.actor.workspaceId;
  const accounts = await db.select({ id: socialAccounts.id, handle: socialAccounts.handle, url: socialAccounts.canonicalUrl }).from(socialAccounts).where(and(eq(socialAccounts.workspaceId, ws), inArray(socialAccounts.id, rows.map((r) => r.accountId))));
  const ps = await db.select({ id: projects.id, name: projects.name }).from(projects).where(and(eq(projects.workspaceId, ws), inArray(projects.id, rows.map((r) => r.projectId))));
  const u2m = await userMembershipMap(db, ws, rows.map((r) => r.reviewedBy));
  const refs = await loadMemberRefs(db, ws, [...rows.flatMap((r) => r.claimedAllocations.map((a) => a.membershipId)), ...u2m.values()]);
  const dups = await duplicatesFor(ctx, rows);
  return rows.map((c) => {
    const cur = c.currency.trim();
    const a = accounts.find((x) => x.id === c.accountId);
    return {
      id: c.id,
      state: c.state,
      account: a ? { id: a.id, name: a.handle ? `@${a.handle}` : a.url } : null,
      project: { id: c.projectId, name: ps.find((p) => p.id === c.projectId)?.name ?? 'Unavailable project' },
      sourceNamespace: c.sourceNamespace,
      sourceTransactionId: c.sourceTransactionId,
      manualReference: c.manualReference,
      occurredAt: c.occurredAt.toISOString(),
      gross: moneyOrNull(c.grossMinor, cur),
      refund: moneyOrNull(c.refundMinor, cur),
      fee: moneyOrNull(c.feeMinor, cur),
      net: moneyOrNull(c.netMinor, cur),
      currency: cur,
      sourceNote: c.sourceNote,
      claimedAllocations: c.claimedAllocations.map((x) => ({ member: refOrUnknown(refs, x.membershipId)!, sharePercent: x.sharePercent })),
      shiftId: c.shiftId,
      duplicate: dups.get(c.id) ?? null,
      reviewNote: c.reviewNote,
      reviewedAt: c.reviewedAt?.toISOString() ?? null,
      reviewedBy: c.reviewedBy && u2m.get(c.reviewedBy) ? refOrUnknown(refs, u2m.get(c.reviewedBy)) : null,
      financialEntryId: c.financialEntryId,
      createdAt: c.createdAt.toISOString(),
      rowVersion: c.rowVersion,
    };
  });
};

export const listSaleCandidates = async (ctx: QueryContext, input: { cursor?: string; pageSize?: number; state?: CandidateRow['state'][]; projectId?: string; accountId?: string }) => {
  requirePermission(ctx, 'sale-candidates.review');
  const size = clampPageSize(input.pageSize);
  const c = input.cursor ? decodeCursor(input.cursor) : null;
  const rows = await dbOf(ctx)
    .select()
    .from(saleCandidates)
    .where(
      and(
        eq(saleCandidates.workspaceId, ctx.actor.workspaceId),
        filterToSql(listFilter(ctx.actor.access, 'sale-candidates.review'), { projectId: saleCandidates.projectId, accountId: saleCandidates.accountId }),
        input.state?.length ? inArray(saleCandidates.state, input.state) : undefined,
        input.projectId ? eq(saleCandidates.projectId, input.projectId) : undefined,
        input.accountId ? eq(saleCandidates.accountId, input.accountId) : undefined,
        c ? or(lt(saleCandidates.occurredAt, new Date(String(c.v[0]))), and(eq(saleCandidates.occurredAt, new Date(String(c.v[0]))), lt(saleCandidates.id, c.id))) : undefined,
      ),
    )
    .orderBy(desc(saleCandidates.occurredAt), desc(saleCandidates.id))
    .limit(size + 1);
  const hasMore = rows.length > size;
  const pageRows = hasMore ? rows.slice(0, size) : rows;
  const last = pageRows[pageRows.length - 1];
  return { items: await candidateViews(ctx, pageRows), hasMore, nextCursor: hasMore && last ? encodeCursor({ v: [last.occurredAt.toISOString()], id: last.id }) : null };
};

export const getSaleCandidate = async (ctx: QueryContext | CommandContext, id: string) => {
  const c = await findById(ctx, saleCandidates, id, 'Sale candidate');
  if (!can(ctx.actor.access, 'sale-candidates.review', candidateScope(c))) throw new AppError('NOT_FOUND', 'Sale candidate was not found.');
  return (await candidateViews(ctx, [c]))[0]!;
};

const lockCandidate = async (ctx: CommandContext, id: string) => {
  const c = await lockById(ctx, saleCandidates, id, 'Sale candidate');
  if (!can(ctx.actor.access, 'sale-candidates.review', candidateScope(c))) throw new AppError('NOT_FOUND', 'Sale candidate was not found.');
  assertVersion(ctx, c);
  if (c.state === 'verified') throw new AppError('INVALID_STATE', 'This candidate is already verified.', { details: { reason: 'already_verified', entryId: c.financialEntryId } });
  if (c.state === 'rejected') throw new AppError('INVALID_STATE', 'This candidate was rejected.', { details: { reason: 'rejected' } });
  return c;
};

const categoryByClass = async (ctx: CommandContext, cls: 'contra_revenue' | 'fee', preferredKey: string) => {
  const rows = await ctx.tx
    .select()
    .from(financeCategories)
    .where(and(eq(financeCategories.workspaceId, ctx.actor.workspaceId), eq(financeCategories.accountingClass, cls), isNull(financeCategories.archivedAt)))
    .orderBy(asc(financeCategories.sortOrder));
  return rows.find((r) => r.key === preferredKey) ?? rows[0] ?? null;
};

/**
 * Verify a sale candidate into a Draft revenue entry (never posted here). The source key is
 * carried over, so a transaction that is already recorded is rejected as a duplicate and revenue
 * is never doubled (T098). Manager attribution is set explicitly by the reviewer.
 */
export const confirmSaleCandidate = async (
  ctx: CommandContext,
  id: string,
  input: { categoryId: string; recognitionDate?: string; attributions: { membershipId: string; sharePercent: string }[]; note?: string },
) => {
  requirePermission(ctx, 'sale-candidates.review');
  if (!hasAnywhere(ctx.actor.access, 'finance.create')) throw new AppError('FORBIDDEN', 'Creating the draft entry needs the finance create permission.');
  const c = await lockCandidate(ctx, id);
  const dup = (await duplicatesFor(ctx, [c])).get(c.id);
  if (dup)
    throw new AppError('DUPLICATE', 'This source transaction is already recorded. Confirming it again would double the revenue; reject the candidate as a duplicate instead.', {
      details: { reason: 'duplicate_source', ...dup },
    });
  const [cat] = await ctx.tx.select().from(financeCategories).where(and(eq(financeCategories.workspaceId, ctx.actor.workspaceId), eq(financeCategories.id, input.categoryId)));
  if (!cat || cat.accountingClass !== 'revenue' || cat.archivedAt)
    throw new AppError('VALIDATION_FAILED', 'Choose an active revenue category.', { fieldErrors: [{ field: 'categoryId', code: 'CLASS', message: 'Choose an active revenue category.' }] });
  const cur = c.currency.trim();
  const { timezone } = await workspaceFinance(ctx);
  const lines: EntryInput['lines'] = [];
  let netOnly = false;
  const errors: FieldError[] = [];
  if (c.grossMinor !== null) {
    lines.push({ categoryId: cat.id, amount: moneyOf(c.grossMinor, cur).amount, currency: cur, transactionRef: null, description: 'Gross' });
    if (c.refundMinor && c.refundMinor > 0n) {
      const rc = await categoryByClass(ctx, 'contra_revenue', 'refund');
      if (!rc) errors.push({ field: 'categoryId', code: 'NO_REFUND_CATEGORY', message: 'Add an active refund category first.' });
      else lines.push({ categoryId: rc.id, amount: moneyOf(c.refundMinor, cur).amount, currency: cur, description: 'Refund' });
    }
    if (c.feeMinor && c.feeMinor > 0n) {
      const fc = await categoryByClass(ctx, 'fee', 'platform_fee');
      if (!fc) errors.push({ field: 'categoryId', code: 'NO_FEE_CATEGORY', message: 'Add an active fee category first.' });
      else lines.push({ categoryId: fc.id, amount: moneyOf(c.feeMinor, cur).amount, currency: cur, description: 'Platform fee' });
    }
    if (c.netMinor !== null && c.grossMinor - (c.refundMinor ?? 0n) - (c.feeMinor ?? 0n) !== c.netMinor)
      errors.push({ field: 'net', code: 'COMPONENTS', message: 'Gross − refund − fee does not equal the reported net. Correct the candidate first.' });
  } else if (c.netMinor !== null) {
    netOnly = true;
    lines.push({ categoryId: cat.id, amount: moneyOf(c.netMinor, cur).amount, currency: cur, description: 'Net (components not provided)' });
  } else errors.push({ field: 'net', code: 'NO_AMOUNT', message: 'The candidate has neither a gross nor a net amount.' });
  if (errors.length) throw new AppError('VALIDATION_FAILED', errors[0]!.message, { fieldErrors: errors });

  const entryId = await createEntry(
    ctx,
    {
      type: 'revenue',
      title: `Sale ${c.sourceTransactionId}`.slice(0, 120),
      recognitionDate: input.recognitionDate ?? localDate(c.occurredAt, timezone),
      sourceNamespace: c.sourceNamespace,
      sourceExternalId: c.sourceTransactionId,
      accountId: c.accountId,
      shiftId: c.shiftId,
      note: [c.sourceNote, input.note].filter(Boolean).join('\n') || null,
      netOnly,
      lines,
      allocation: { mode: 'weights', rows: [{ projectId: c.projectId, value: '1' }] },
    },
    { via: 'sale_candidate', saleCandidateId: c.id, evidenceAssetIds: c.evidenceAssetIds },
  );
  if (input.attributions.length) await setAttributions(ctx, entryId, { attributions: input.attributions, reason: 'Sale candidate verification' }, { basis: 'manual', saleCandidateId: c.id, skipAuth: true });
  const at = ctx.app.clock.now();
  await ctx.tx
    .update(saleCandidates)
    .set({ state: 'verified', reviewedBy: ctx.actor.userId, reviewedAt: at, reviewNote: input.note ?? null, financialEntryId: entryId, ...touch(ctx, saleCandidates) })
    .where(eq(saleCandidates.id, id));
  await audit(ctx, { action: 'sale_candidate.verified', entityType: 'sale_candidate', entityId: id, projectId: c.projectId, sensitivity: 'finance', metadata: { entryId } });
  await emit(ctx, { type: 'sale_candidate.verified', entityType: 'sale_candidate', entityId: id, payload: { state: 'verified', entryId } });
  return { candidate: await getSaleCandidate(ctx, id), entry: await getEntry(ctx, entryId) };
};

export const rejectSaleCandidate = async (ctx: CommandContext, id: string, input: { reason: string }) => {
  requirePermission(ctx, 'sale-candidates.review');
  const c = await lockCandidate(ctx, id);
  const at = ctx.app.clock.now();
  await ctx.tx.update(saleCandidates).set({ state: 'rejected', reviewedBy: ctx.actor.userId, reviewedAt: at, reviewNote: input.reason, ...touch(ctx, saleCandidates) }).where(eq(saleCandidates.id, id));
  await audit(ctx, { action: 'sale_candidate.rejected', entityType: 'sale_candidate', entityId: id, projectId: c.projectId, sensitivity: 'finance', reason: input.reason });
  await emit(ctx, { type: 'sale_candidate.rejected', entityType: 'sale_candidate', entityId: id, payload: { state: 'rejected' } });
  const map = await userMembershipMap(ctx.tx, ctx.actor.workspaceId, [c.createdBy]);
  await notify(ctx.tx, {
    workspaceId: ctx.actor.workspaceId,
    recipientMembershipIds: [...map.values()],
    eventType: 'finance.sale_candidate_rejected',
    eventKey: `finance.sale_candidate_rejected:${id}`,
    kind: 'general',
    title: 'Sale candidate rejected',
    excerpt: input.reason.slice(0, 200),
    entityType: 'sale_candidate',
    entityId: id,
    projectId: c.projectId,
    actorMembershipId: ctx.actor.membershipId,
    at,
  });
  return getSaleCandidate(ctx, id);
};
