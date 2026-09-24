import { and, asc, desc, eq, gt, ilike, inArray, isNull, lt, ne, or, sql, type SQL } from 'drizzle-orm';
import { can, hasAnywhere } from '@castlane/authorization';
import {
  assetDerivatives,
  assetLinks,
  assets,
  assetVersions,
  commitmentConsumptions,
  commitments,
  contentItems,
  financialAllocations,
  financialEntries,
  financialEntryLines,
  fxRates,
  projects,
  revenueAttributions,
  settlementAllocations,
  settlements,
  workspaces,
} from '@castlane/database';
import {
  AppError,
  ENTRY_TRANSITIONS,
  ENTRY_TYPE_CLASSES,
  assertTransition,
  clampPageSize,
  commitmentStateFor,
  computeAllocation,
  controlTotalDifference,
  decodeCursor,
  distributeProportionally,
  documentBalance,
  encodeCursor,
  isValidPercent,
  newId,
  pickRate,
  signedEffect,
  summarizeLedger,
  toBig,
  baseEquivalent,
  unallocatedSpec,
  type AllocatedRow,
  type AllocationSpec,
  type FieldError,
  type LedgerLine,
} from '@castlane/domain';
import { requirePermission, requireRecentAuth } from '../core/access';
import { audit, diffFields } from '../core/audit';
import { dbOf, type CommandContext, type QueryContext } from '../core/context';
import { emit } from '../core/events';
import { isActiveMember, loadMemberRefs, refOrUnknown } from '../core/members';
import { notify } from '../core/notify';
import { assertVersion, findById, lockById, stamp, touch } from '../core/rows';
import { evaluateBudgetAlerts } from './alerts';
import {
  assertPeriodOpen,
  authorizeFinance,
  canAll,
  canAny,
  checkMakerChecker,
  financeScopeSql,
  financeScopes,
  loadCategoryMap,
  loadNames,
  moneyOf,
  moneyOrNull,
  parseAmount,
  refFrom,
  signToken,
  throwIfErrors,
  userMembershipMap,
  verifyToken,
  workspaceFinance,
  type FinanceCategoryRow,
} from './common';

type EntryRow = typeof financialEntries.$inferSelect;
type LineRow = typeof financialEntryLines.$inferSelect;
type AllocRow = typeof financialAllocations.$inferSelect;
type EntryType = EntryRow['type'];

// ——— Input model ———

export interface AllocationSpecInput {
  mode: 'exact' | 'percent' | 'weights';
  rows: { projectId: string | null; campaignId?: string | null; contentItemId?: string | null; value: string }[];
}

export interface EntryLineInputData {
  categoryId: string;
  amount: string;
  currency: string;
  description?: string | null;
  transactionRef?: string | null;
  componentsUnknown?: boolean;
  commitmentId?: string | null;
  fxRateId?: string | null;
  fxEffect?: 'gain' | 'loss' | null;
  allocation?: AllocationSpecInput | null;
}

export interface EntryInput {
  type: EntryType;
  title: string;
  recognitionDate: string;
  counterparty?: string | null;
  sourceNamespace?: string | null;
  sourceExternalId?: string | null;
  accountId?: string | null;
  campaignId?: string | null;
  shiftId?: string | null;
  dealId?: string | null;
  refundOfEntryId?: string | null;
  note?: string | null;
  netOnly?: boolean;
  controlTotal?: { amount: string; currency: string } | null;
  lines: EntryLineInputData[];
  allocation?: AllocationSpecInput | null;
}

interface NormalizedLine {
  categoryId: string;
  accountingClass: FinanceCategoryRow['accountingClass'];
  amountMinor: bigint;
  currency: string;
  description: string | null;
  transactionRef: string | null;
  componentsUnknown: boolean;
  commitmentId: string | null;
  fxRateId: string | null;
  fxEffect: 'gain' | 'loss' | null;
  allocation: AllocatedRow[];
}

interface NormalizedEntry {
  header: {
    type: EntryType;
    title: string;
    recognitionDate: string;
    counterparty: string | null;
    sourceNamespace: string | null;
    sourceExternalId: string | null;
    accountId: string | null;
    campaignId: string | null;
    shiftId: string | null;
    dealId: string | null;
    refundOfEntryId: string | null;
    note: string | null;
    netOnly: boolean;
    controlTotalMinor: bigint | null;
    controlTotalCurrency: string | null;
  };
  lines: NormalizedLine[];
  projectIds: string[];
}

type RefTable = 'projects' | 'campaigns' | 'deals' | 'social_accounts' | 'shifts' | 'content_items';

const exists = async (ctx: CommandContext, table: RefTable, id: string) => {
  const r = await ctx.tx.execute(sql`SELECT 1 FROM ${sql.identifier(table)} WHERE workspace_id = ${ctx.actor.workspaceId} AND id = ${id} LIMIT 1`);
  return r.rows.length > 0;
};

/**
 * Validate and normalise an entry: categories and classes, amounts in minor units, net-only and
 * control-total rules, references inside the workspace, allocations conserving minor units.
 */
export const normalizeEntry = async (ctx: CommandContext, input: EntryInput, opts: { baseCurrency: string; entryId?: string }): Promise<NormalizedEntry> => {
  const errors: FieldError[] = [];
  const cats = await loadCategoryMap(ctx, input.lines.map((l) => l.categoryId));
  const allowed = ENTRY_TYPE_CLASSES[input.type];
  const netOnly = !!input.netOnly;
  const seenRefs = new Set<string>();
  const lines: NormalizedLine[] = [];

  if (input.sourceExternalId && !input.sourceNamespace) input = { ...input, sourceNamespace: 'manual' };
  if (netOnly && input.type !== 'revenue' && input.type !== 'platform_statement')
    errors.push({ field: 'netOnly', code: 'INVALID', message: 'Net Only applies to revenue and platform statements.' });
  if (input.controlTotal && input.type !== 'platform_statement')
    errors.push({ field: 'controlTotal', code: 'INVALID', message: 'A header total applies to platform statements only.' });

  for (const [i, l] of input.lines.entries()) {
    const f = (k: string) => `lines.${i}.${k}`;
    const cat = cats.get(l.categoryId);
    if (!cat) {
      errors.push({ field: f('categoryId'), code: 'NOT_FOUND', message: 'Choose a category.' });
      continue;
    }
    if (cat.archivedAt) errors.push({ field: f('categoryId'), code: 'ARCHIVED', message: 'This category is archived.' });
    if (!allowed.includes(cat.accountingClass))
      errors.push({ field: f('categoryId'), code: 'CLASS', message: `A ${input.type.replace('_', ' ')} cannot contain ${cat.accountingClass.replace('_', ' ')} lines.` });
    if (netOnly && cat.accountingClass !== 'revenue')
      errors.push({ field: f('categoryId'), code: 'NET_ONLY', message: 'A Net Only statement has a single net revenue line; do not invent refunds or fees.' });
    const amountMinor = parseAmount(l.amount, l.currency, f('amount'), errors, { allowZero: false });
    if (cat.accountingClass === 'fx_difference' && !l.fxEffect) errors.push({ field: f('fxEffect'), code: 'REQUIRED', message: 'Choose gain or loss.' });
    const ref = l.transactionRef?.trim() || null;
    if (ref) {
      if (seenRefs.has(ref)) errors.push({ field: f('transactionRef'), code: 'DUPLICATE', message: 'The same transaction appears twice.' });
      seenRefs.add(ref);
    }
    if (l.commitmentId) {
      const [c] = await ctx.tx.select().from(commitments).where(and(eq(commitments.workspaceId, ctx.actor.workspaceId), eq(commitments.id, l.commitmentId)));
      if (!c) errors.push({ field: f('commitmentId'), code: 'NOT_FOUND', message: 'Commitment was not found.' });
      else {
        if (c.state === 'cancelled' || c.state === 'consumed') errors.push({ field: f('commitmentId'), code: 'CLOSED', message: 'This commitment has nothing left to consume.' });
        if (c.currency.trim() !== l.currency) errors.push({ field: f('commitmentId'), code: 'CURRENCY', message: 'The commitment uses another currency.' });
        if (cat.accountingClass !== 'operating_expense' && cat.accountingClass !== 'compensation_expense')
          errors.push({ field: f('commitmentId'), code: 'CLASS', message: 'Only expense lines consume commitments.' });
      }
    }
    if (l.fxRateId) {
      const [r] = await ctx.tx.select().from(fxRates).where(and(eq(fxRates.workspaceId, ctx.actor.workspaceId), eq(fxRates.id, l.fxRateId)));
      if (!r || r.fromCurrency.trim() !== l.currency || r.toCurrency.trim() !== opts.baseCurrency || r.effectiveDate > input.recognitionDate)
        errors.push({ field: f('fxRateId'), code: 'INVALID', message: `Choose a ${l.currency}→${opts.baseCurrency} rate effective on or before the recognition date.` });
    }
    const spec = (l.allocation ?? input.allocation ?? unallocatedSpec()) as AllocationSpec;
    const alloc = amountMinor > 0n ? computeAllocation(amountMinor, l.currency, spec) : { ok: true as const, rows: [] };
    if (!alloc.ok) {
      for (const iss of alloc.issues)
        errors.push({ field: iss.row === null ? (l.allocation ? f('allocation') : 'allocation') : `${l.allocation ? f('allocation') : 'allocation'}.rows.${iss.row}.value`, code: iss.code, message: iss.message });
    }
    lines.push({
      categoryId: l.categoryId,
      accountingClass: cat.accountingClass,
      amountMinor,
      currency: l.currency,
      description: l.description?.trim() || null,
      transactionRef: ref,
      componentsUnknown: netOnly && cat.accountingClass === 'revenue',
      commitmentId: l.commitmentId ?? null,
      fxRateId: l.fxRateId ?? null,
      fxEffect: cat.accountingClass === 'fx_difference' ? (l.fxEffect ?? null) : null,
      allocation: alloc.ok ? alloc.rows : [],
    });
  }
  if (netOnly && input.lines.length !== 1) errors.push({ field: 'lines', code: 'NET_ONLY', message: 'A Net Only statement has exactly one net revenue line.' });

  let controlTotalMinor: bigint | null = null;
  if (input.controlTotal) {
    controlTotalMinor = parseAmount(input.controlTotal.amount, input.controlTotal.currency, 'controlTotal.amount', errors, { allowNegative: true, allowZero: true });
    if (lines.some((l) => l.currency !== input.controlTotal!.currency))
      errors.push({ field: 'controlTotal.currency', code: 'CURRENCY', message: 'The header total must use the same currency as the transaction lines.' });
  }

  // References inside the workspace.
  const refChecks: [string | null | undefined, string, RefTable][] = [
    [input.accountId, 'accountId', 'social_accounts'],
    [input.campaignId, 'campaignId', 'campaigns'],
    [input.dealId, 'dealId', 'deals'],
    [input.shiftId, 'shiftId', 'shifts'],
  ];
  for (const [id, field, table] of refChecks) if (id && !(await exists(ctx, table, id))) errors.push({ field, code: 'NOT_FOUND', message: 'The linked record was not found.' });
  if (input.refundOfEntryId) {
    const [orig] = await ctx.tx.select().from(financialEntries).where(and(eq(financialEntries.workspaceId, ctx.actor.workspaceId), eq(financialEntries.id, input.refundOfEntryId)));
    if (!orig || orig.id === opts.entryId) errors.push({ field: 'refundOfEntryId', code: 'NOT_FOUND', message: 'Choose the original revenue entry.' });
    else if (orig.state !== 'posted') errors.push({ field: 'refundOfEntryId', code: 'NOT_POSTED', message: 'A refund can only relate to a posted entry.' });
    if (!lines.some((l) => l.accountingClass === 'contra_revenue'))
      errors.push({ field: 'refundOfEntryId', code: 'NO_REFUND_LINE', message: 'A refund document needs a refund or chargeback line.' });
  }

  // Allocation targets.
  const projectIds = [...new Set(lines.flatMap((l) => l.allocation.map((a) => a.projectId)).filter((p): p is string => !!p))];
  if (projectIds.length) {
    const found = await ctx.tx.select({ id: projects.id }).from(projects).where(and(eq(projects.workspaceId, ctx.actor.workspaceId), inArray(projects.id, projectIds)));
    const ok = new Set(found.map((p) => p.id));
    for (const p of projectIds) if (!ok.has(p)) errors.push({ field: 'allocation', code: 'NOT_FOUND', message: 'An allocated project was not found.' });
  }
  const campaignIds = [...new Set(lines.flatMap((l) => l.allocation.map((a) => a.campaignId)).filter((p): p is string => !!p))];
  for (const c of campaignIds) if (!(await exists(ctx, 'campaigns', c))) errors.push({ field: 'allocation', code: 'NOT_FOUND', message: 'An allocated campaign was not found.' });
  const contentIds = [...new Set(lines.flatMap((l) => l.allocation.map((a) => a.contentItemId)).filter((p): p is string => !!p))];
  if (contentIds.length) {
    const found = await ctx.tx.select({ id: contentItems.id, projectId: contentItems.projectId }).from(contentItems).where(and(eq(contentItems.workspaceId, ctx.actor.workspaceId), inArray(contentItems.id, contentIds)));
    const byId = new Map(found.map((c) => [c.id, c.projectId]));
    for (const l of lines)
      for (const a of l.allocation)
        if (a.contentItemId && (!byId.has(a.contentItemId) || (a.projectId && byId.get(a.contentItemId) !== a.projectId)))
          errors.push({ field: 'allocation', code: 'CONTENT_PROJECT', message: 'The content item must belong to the allocated project.' });
  }
  throwIfErrors(errors);

  return {
    header: {
      type: input.type,
      title: input.title.trim(),
      recognitionDate: input.recognitionDate,
      counterparty: input.counterparty?.trim() || null,
      // The namespace also scopes line transaction ids, so it is kept without a document-level id.
      sourceNamespace: input.sourceNamespace?.trim() || (input.sourceExternalId ? 'manual' : null),
      sourceExternalId: input.sourceExternalId?.trim() || null,
      accountId: input.accountId ?? null,
      campaignId: input.campaignId ?? null,
      shiftId: input.shiftId ?? null,
      dealId: input.dealId ?? null,
      refundOfEntryId: input.refundOfEntryId ?? null,
      note: input.note ?? null,
      netOnly,
      controlTotalMinor,
      controlTotalCurrency: input.controlTotal?.currency ?? null,
    },
    lines,
    projectIds,
  };
};

/** Duplicate source / transaction guard with a helpful message (the unique indexes enforce it anyway). */
const assertUniqueSource = async (ctx: CommandContext, n: NormalizedEntry, entryId?: string) => {
  if (n.header.sourceExternalId) {
    const [dup] = await ctx.tx
      .select({ id: financialEntries.id, title: financialEntries.title, state: financialEntries.state })
      .from(financialEntries)
      .where(
        and(
          eq(financialEntries.workspaceId, ctx.actor.workspaceId),
          eq(financialEntries.sourceNamespace, n.header.sourceNamespace!),
          eq(financialEntries.sourceExternalId, n.header.sourceExternalId),
          entryId ? ne(financialEntries.id, entryId) : undefined,
        ),
      );
    if (dup)
      throw new AppError('DUPLICATE', 'An entry for this source transaction already exists. Posting it again would double the revenue.', {
        details: { reason: 'duplicate_source', entryId: dup.id, title: dup.title, state: dup.state },
      });
  }
  const refs = n.lines.map((l) => l.transactionRef).filter((r): r is string => !!r);
  if (refs.length) {
    const ns = n.header.sourceNamespace ?? 'manual';
    const [dup] = await ctx.tx
      .select({ entryId: financialEntryLines.entryId, ref: financialEntryLines.transactionRef })
      .from(financialEntryLines)
      .where(
        and(
          eq(financialEntryLines.workspaceId, ctx.actor.workspaceId),
          eq(financialEntryLines.sourceNamespace, ns),
          inArray(financialEntryLines.transactionRef, refs),
          eq(financialEntryLines.isReversal, false),
          entryId ? ne(financialEntryLines.entryId, entryId) : undefined,
        ),
      )
      .limit(1);
    if (dup)
      throw new AppError('DUPLICATE', `Transaction ${dup.ref} is already recorded in another entry.`, { details: { reason: 'duplicate_transaction', entryId: dup.entryId, transactionRef: dup.ref } });
  }
};

// ——— FX ———

const ratesFor = async (db: CommandContext['tx'] | QueryContext['app']['db'], workspaceId: string, currencies: string[], baseCurrency: string, date: string) => {
  const cs = [...new Set(currencies.filter((c) => c !== baseCurrency))];
  if (!cs.length) return [];
  return db
    .select()
    .from(fxRates)
    .where(and(eq(fxRates.workspaceId, workspaceId), inArray(fxRates.fromCurrency, cs), eq(fxRates.toCurrency, baseCurrency), sql`${fxRates.effectiveDate} <= ${date}`));
};

const resolveRate = (rates: (typeof fxRates.$inferSelect)[], line: { currency: string; fxRateId: string | null }, baseCurrency: string, date: string) => {
  if (line.currency === baseCurrency) return null;
  if (line.fxRateId) return rates.find((r) => r.id === line.fxRateId) ?? null;
  return pickRate(
    rates.map((r) => ({ ...r, fromCurrency: r.fromCurrency.trim(), toCurrency: r.toCurrency.trim(), createdAt: r.createdAt.toISOString() })),
    line.currency,
    baseCurrency,
    date,
  );
};

// ——— Writes ———

const insertLines = async (ctx: CommandContext, entryId: string, n: NormalizedEntry, baseCurrency: string) => {
  const rates = await ratesFor(ctx.tx, ctx.actor.workspaceId, n.lines.map((l) => l.currency), baseCurrency, n.header.recognitionDate);
  let lineNo = 1;
  for (const l of n.lines) {
    const rate = resolveRate(rates, l, baseCurrency, n.header.recognitionDate);
    const base = baseEquivalent(l.amountMinor, l.currency, baseCurrency, rate?.rate ?? null);
    const lineId = newId();
    await ctx.tx.insert(financialEntryLines).values({
      ...stamp(ctx),
      id: lineId,
      entryId,
      lineNo: lineNo++,
      categoryId: l.categoryId,
      accountingClass: l.accountingClass,
      amountMinor: l.amountMinor,
      currency: l.currency,
      // Draft preview only: the rate is frozen at posting.
      fxRate: l.currency === baseCurrency ? '1' : (rate?.rate ?? null),
      fxRateId: l.fxRateId,
      baseAmountMinor: base,
      baseCurrency,
      description: l.description,
      sourceNamespace: n.header.sourceNamespace ?? 'manual',
      transactionRef: l.transactionRef,
      componentsUnknown: l.componentsUnknown,
      fxEffect: l.fxEffect,
      commitmentId: l.commitmentId,
    });
    const bases = base === null ? null : distributeProportionally(base, l.allocation.map((a) => ({ key: a.key, weightMinor: a.amountMinor })));
    for (const a of l.allocation) {
      await ctx.tx.insert(financialAllocations).values({
        ...stamp(ctx),
        id: newId(),
        lineId,
        entryId,
        projectId: a.projectId,
        campaignId: a.campaignId,
        contentItemId: a.contentItemId,
        amountMinor: a.amountMinor,
        baseAmountMinor: bases ? (bases.get(a.key) ?? 0n) : null,
        sharePercent: a.sharePercent,
        ruleSnapshot: { mode: a.sharePercent ? 'percent' : 'computed' },
        effectiveDate: n.header.recognitionDate,
      });
    }
  }
};

const deleteDraftLines = async (ctx: CommandContext, entryId: string) => {
  await ctx.tx.delete(financialAllocations).where(and(eq(financialAllocations.workspaceId, ctx.actor.workspaceId), eq(financialAllocations.entryId, entryId)));
  await ctx.tx.delete(financialEntryLines).where(and(eq(financialEntryLines.workspaceId, ctx.actor.workspaceId), eq(financialEntryLines.entryId, entryId)));
};

/** Actor must be allowed to record finance for every allocated project (or the workspace when unallocated). */
const assertCreateScope = (ctx: CommandContext, n: NormalizedEntry, permission = 'finance.create') => {
  const withUnallocated = n.lines.some((l) => l.allocation.some((a) => !a.projectId));
  const ok =
    n.projectIds.every((p) => can(ctx.actor.access, permission, { projectId: p })) &&
    (!withUnallocated || can(ctx.actor.access, permission, n.header.accountId ? { accountId: n.header.accountId } : undefined));
  if (!ok) throw new AppError('FORBIDDEN', 'You cannot record finance for one of the allocated projects (or unallocated amounts).');
};

export interface CreateEntryOptions {
  via?: 'ui' | 'import' | 'sale_candidate' | 'commitment' | 'replacement' | 'compensation_run' | 'settlement';
  saleCandidateId?: string | null;
  compensationRunId?: string | null;
  replacementOfEntryId?: string | null;
  evidenceAssetIds?: string[];
  /** Internal documents (compensation run expense, realized FX) are authorised by the calling command. */
  internal?: boolean;
}

export const createEntry = async (ctx: CommandContext, input: EntryInput, opts: CreateEntryOptions = {}): Promise<string> => {
  if (!opts.internal) requirePermission(ctx, 'finance.create');
  const { baseCurrency } = await workspaceFinance(ctx);
  const n = await normalizeEntry(ctx, input, { baseCurrency });
  if (!opts.internal) assertCreateScope(ctx, n);
  await assertUniqueSource(ctx, n);
  const id = newId();
  const [row] = await ctx.tx
    .insert(financialEntries)
    .values({
      ...stamp(ctx),
      id,
      ...n.header,
      state: 'draft',
      saleCandidateId: opts.saleCandidateId ?? null,
      compensationRunId: opts.compensationRunId ?? null,
      replacementOfEntryId: opts.replacementOfEntryId ?? null,
      evidenceAssetIds: opts.evidenceAssetIds ?? [],
    })
    .returning();
  await insertLines(ctx, id, n, baseCurrency);
  await audit(ctx, {
    action: 'financial_entry.created',
    entityType: 'financial_entry',
    entityId: id,
    projectId: n.projectIds[0] ?? null,
    sensitivity: 'finance',
    diff: diffFields(null, row!, ['type', 'title', 'recognitionDate', 'sourceNamespace', 'sourceExternalId', 'netOnly']),
    metadata: { lines: n.lines.length, via: opts.via ?? 'ui' },
  });
  await emit(ctx, { type: 'financial_entry.created', entityType: 'financial_entry', entityId: id, revision: 1, payload: { state: 'draft' } });
  return id;
};

/** Convert stored lines back into input (allocations as weights so proportions survive amount edits). */
const formatLine = (l: LineRow) => moneyOf(l.amountMinor, l.currency.trim()).amount;

const linesToInput = (lines: LineRow[], allocs: AllocRow[]): EntryLineInputData[] =>
  lines.map((l) => {
    const rows = allocs.filter((a) => a.lineId === l.id);
    return {
      categoryId: l.categoryId,
      amount: formatLine(l),
      currency: l.currency.trim(),
      description: l.description,
      transactionRef: l.transactionRef,
      commitmentId: l.commitmentId,
      fxRateId: l.fxRateId,
      fxEffect: l.fxEffect,
      allocation: rows.length
        ? { mode: 'weights' as const, rows: rows.map((a) => ({ projectId: a.projectId, campaignId: a.campaignId, contentItemId: a.contentItemId, value: (a.amountMinor < 0n ? 0n : a.amountMinor).toString() })) }
        : null,
    };
  });

const loadEntryParts = async (ctx: QueryContext | CommandContext, entryId: string) => {
  const db = dbOf(ctx);
  const ws = ctx.actor.workspaceId;
  const lines = await db.select().from(financialEntryLines).where(and(eq(financialEntryLines.workspaceId, ws), eq(financialEntryLines.entryId, entryId))).orderBy(asc(financialEntryLines.lineNo));
  const allocs = await db.select().from(financialAllocations).where(and(eq(financialAllocations.workspaceId, ws), eq(financialAllocations.entryId, entryId))).orderBy(asc(financialAllocations.createdAt));
  return { lines, allocs };
};

const entryScopesOf = (e: EntryRow, allocs: AllocRow[]) =>
  financeScopes('financial_entry', e.id, allocs.map((a) => a.projectId), e.accountId);

const isOwnRecord = (ctx: QueryContext, e: EntryRow) => !!ctx.actor.userId && e.createdBy === ctx.actor.userId && hasAnywhere(ctx.actor.access, 'finance.create');

export const updateEntry = async (ctx: CommandContext, id: string, patch: Partial<EntryInput>) => {
  const e = await lockById(ctx, financialEntries, id, 'Entry');
  const parts = await loadEntryParts(ctx, id);
  authorizeFinance(ctx, 'finance.create', entryScopesOf(e, parts.allocs), ['finance.read'], { ownRecord: isOwnRecord(ctx, e) });
  assertVersion(ctx, e);
  if (e.state === 'posted')
    throw new AppError('INVALID_STATE', 'Posted entries are immutable. Reverse the entry, or reverse it and create a replacement.', {
      details: { reason: 'posted_immutable', actions: ['reverse', 'reverse_and_replace'] },
    });
  if (e.state === 'submitted') throw new AppError('INVALID_STATE', 'This entry is waiting for review. It can be edited after it is rejected.', { details: { reason: 'submitted_locked' } });
  const { baseCurrency } = await workspaceFinance(ctx);
  const current: EntryInput = {
    type: e.type,
    title: e.title,
    recognitionDate: e.recognitionDate,
    counterparty: e.counterparty,
    sourceNamespace: e.sourceNamespace,
    sourceExternalId: e.sourceExternalId,
    accountId: e.accountId,
    campaignId: e.campaignId,
    shiftId: e.shiftId,
    dealId: e.dealId,
    refundOfEntryId: e.refundOfEntryId,
    note: e.note,
    netOnly: e.netOnly,
    controlTotal: e.controlTotalMinor !== null && e.controlTotalCurrency ? moneyOf(e.controlTotalMinor, e.controlTotalCurrency.trim()) : null,
    lines: linesToInput(parts.lines, parts.allocs),
  };
  const merged: EntryInput = { ...current, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) } as EntryInput;
  if (patch.allocation && !patch.lines) merged.lines = merged.lines.map((l) => ({ ...l, allocation: null }));
  const n = await normalizeEntry(ctx, merged, { baseCurrency, entryId: id });
  assertCreateScope(ctx, n);
  await assertUniqueSource(ctx, n, id);
  await deleteDraftLines(ctx, id);
  const [row] = await ctx.tx
    .update(financialEntries)
    .set({ ...n.header, state: 'draft', rejectedAt: e.state === 'rejected' ? e.rejectedAt : null, ...touch(ctx, financialEntries) })
    .where(eq(financialEntries.id, id))
    .returning();
  await insertLines(ctx, id, n, baseCurrency);
  await audit(ctx, {
    action: 'financial_entry.updated',
    entityType: 'financial_entry',
    entityId: id,
    projectId: n.projectIds[0] ?? null,
    sensitivity: 'finance',
    diff: diffFields(e, row!, ['type', 'title', 'recognitionDate', 'counterparty', 'sourceNamespace', 'sourceExternalId', 'accountId', 'campaignId', 'dealId', 'netOnly', 'state']),
    metadata: { linesReplaced: !!patch.lines || !!patch.allocation },
  });
  await emit(ctx, { type: 'financial_entry.updated', entityType: 'financial_entry', entityId: id, revision: row!.rowVersion });
  return id;
};

const controlCheck = (e: EntryRow, lines: LineRow[]) => {
  if (e.controlTotalMinor === null || !e.controlTotalCurrency) return { status: 'not_applicable' as const, difference: null as bigint | null };
  const diff = controlTotalDifference(lines.filter((l) => !l.isReversal).map(toLedgerLine), e.controlTotalMinor);
  return { status: diff === 0n ? ('match' as const) : ('mismatch' as const), difference: diff };
};

const toLedgerLine = (l: LineRow): LedgerLine => ({
  accountingClass: l.accountingClass,
  amountMinor: l.amountMinor,
  isReversal: l.isReversal,
  componentsUnknown: l.componentsUnknown,
  fxEffect: l.fxEffect,
});

const assertComplete = async (ctx: CommandContext, e: EntryRow, lines: LineRow[], allocs: AllocRow[]) => {
  if (lines.length === 0) throw new AppError('INVALID_STATE', 'Add at least one line.', { details: { reason: 'no_lines' } });
  const cats = await loadCategoryMap(ctx, lines.map((l) => l.categoryId));
  const archived = lines.filter((l) => cats.get(l.categoryId)?.archivedAt);
  if (archived.length) throw new AppError('INVALID_STATE', 'A line uses an archived category. Choose an active category.', { details: { reason: 'archived_category' } });
  for (const l of lines) {
    const sum = allocs.filter((a) => a.lineId === l.id).reduce((a, x) => a + x.amountMinor, 0n);
    if (sum !== l.amountMinor) throw new AppError('INVALID_STATE', `Line ${l.lineNo} is not fully allocated.`, { details: { reason: 'allocation_unbalanced', lineNo: l.lineNo } });
  }
  const cc = controlCheck(e, lines);
  if (cc.status === 'mismatch')
    throw new AppError('INVALID_STATE', `The transaction lines differ from the statement total by ${moneyOf(cc.difference!, e.controlTotalCurrency!.trim()).amount} ${e.controlTotalCurrency}. Resolve the difference before continuing.`, {
      details: { reason: 'control_total_mismatch', difference: moneyOf(cc.difference!, e.controlTotalCurrency!.trim()) },
    });
};

export const submitEntry = async (ctx: CommandContext, id: string, input: { note?: string }) => {
  const e = await lockById(ctx, financialEntries, id, 'Entry');
  const { lines, allocs } = await loadEntryParts(ctx, id);
  authorizeFinance(ctx, 'finance.submit', entryScopesOf(e, allocs), ['finance.read'], { ownRecord: isOwnRecord(ctx, e) });
  assertVersion(ctx, e);
  assertTransition(ENTRY_TRANSITIONS, e.state, 'submitted', 'entry');
  await assertComplete(ctx, e, lines, allocs);
  const at = ctx.app.clock.now();
  const [row] = await ctx.tx
    .update(financialEntries)
    .set({ state: 'submitted', submittedAt: at, submittedBy: ctx.actor.userId, rejectedAt: null, rejectedReason: null, ...touch(ctx, financialEntries) })
    .where(eq(financialEntries.id, id))
    .returning();
  await audit(ctx, { action: 'financial_entry.submitted', entityType: 'financial_entry', entityId: id, sensitivity: 'finance', reason: input.note ?? null, diff: { state: { from: e.state, to: 'submitted' } } });
  await emit(ctx, { type: 'financial_entry.submitted', entityType: 'financial_entry', entityId: id, revision: row!.rowVersion, payload: { state: 'submitted' } });
  return id;
};

/**
 * Freeze FX and post atomically. Shared by the Post command and internal documents (run expense,
 * realized FX difference). The caller has already authorised and locked the entry.
 */
export const postEntryCore = async (
  ctx: CommandContext,
  e: EntryRow,
  opts: { selfApprovalReason?: string | null; approverNote?: string | null; notifyAuthor?: boolean } = {},
) => {
  await assertPeriodOpen(ctx, e.recognitionDate, 'post');
  const { lines, allocs } = await loadEntryParts(ctx, e.id);
  await assertComplete(ctx, e, lines, allocs);
  const [ws] = await ctx.tx.select().from(workspaces).where(eq(workspaces.id, ctx.actor.workspaceId)).for('update');
  const baseCurrency = ws!.baseCurrency.trim();

  // Attachment policy: evidence files must have passed checks.
  const evidence = await evidenceRows(ctx, e);
  const pending = evidence.filter((x) => x.status && x.status !== 'available');
  if (pending.length)
    throw new AppError('INVALID_STATE', 'Some evidence files are still being checked or were rejected. Wait for the check or remove them.', {
      details: { reason: 'evidence_pending', files: pending.map((p) => ({ assetId: p.assetId, status: p.status })) },
    });

  // FX: cross-currency posting needs a rate on or before the recognition date (T126).
  const rates = await ratesFor(ctx.tx, ctx.actor.workspaceId, lines.map((l) => l.currency.trim()), baseCurrency, e.recognitionDate);
  const missing: { currency: string; date: string }[] = [];
  const resolved = lines.map((l) => {
    const cur = l.currency.trim();
    const rate = resolveRate(rates, { currency: cur, fxRateId: l.fxRateId }, baseCurrency, e.recognitionDate);
    if (cur !== baseCurrency && !rate) missing.push({ currency: cur, date: e.recognitionDate });
    return { line: l, rate };
  });
  if (missing.length)
    throw new AppError('INVALID_STATE', `Add an FX rate to ${baseCurrency} for ${[...new Set(missing.map((m) => m.currency))].join(', ')} effective on or before ${e.recognitionDate}. The draft is kept.`, {
      details: { reason: 'fx_missing', missingFx: missing },
    });

  const usedRateIds = new Set<string>();
  for (const { line: l, rate } of resolved) {
    const cur = l.currency.trim();
    const base = baseEquivalent(l.amountMinor, cur, baseCurrency, rate?.rate ?? null)!;
    await ctx.tx
      .update(financialEntryLines)
      .set({ fxRate: cur === baseCurrency ? '1' : rate!.rate, fxRateId: cur === baseCurrency ? null : rate!.id, baseAmountMinor: base, baseCurrency, ...touch(ctx, financialEntryLines) })
      .where(eq(financialEntryLines.id, l.id));
    if (rate) usedRateIds.add(rate.id);
    const rows = allocs.filter((a) => a.lineId === l.id);
    const split = distributeProportionally(base, rows.map((a) => ({ key: a.id, weightMinor: a.amountMinor })));
    for (const a of rows) await ctx.tx.update(financialAllocations).set({ baseAmountMinor: split.get(a.id) ?? 0n, effectiveDate: e.recognitionDate }).where(eq(financialAllocations.id, a.id));
  }
  if (usedRateIds.size)
    await ctx.tx.update(fxRates).set({ firstUsedAt: ctx.app.clock.now() }).where(and(inArray(fxRates.id, [...usedRateIds]), isNull(fxRates.firstUsedAt)));
  if (!ws!.baseCurrencyLockedAt) await ctx.tx.update(workspaces).set({ baseCurrencyLockedAt: ctx.app.clock.now() }).where(eq(workspaces.id, ctx.actor.workspaceId));

  // Commitments convert to actuals: remaining decreases, nothing is counted twice (T129).
  for (const l of lines) {
    if (!l.commitmentId || l.isReversal) continue;
    const [c] = await ctx.tx.select().from(commitments).where(and(eq(commitments.workspaceId, ctx.actor.workspaceId), eq(commitments.id, l.commitmentId))).for('update');
    if (!c || c.state === 'cancelled') continue;
    const remaining = c.amountMinor - c.consumedMinor;
    const take = l.amountMinor < remaining ? l.amountMinor : remaining;
    if (take <= 0n) continue;
    await ctx.tx.insert(commitmentConsumptions).values({ ...stamp(ctx), id: newId(), commitmentId: c.id, entryLineId: l.id, amountMinor: take });
    const consumed = c.consumedMinor + take;
    await ctx.tx.update(commitments).set({ consumedMinor: consumed, state: commitmentStateFor(c.amountMinor, consumed), ...touch(ctx, commitments) }).where(eq(commitments.id, c.id));
    await emit(ctx, { type: 'commitment.consumed', entityType: 'commitment', entityId: c.id });
  }

  const at = ctx.app.clock.now();
  const [row] = await ctx.tx
    .update(financialEntries)
    .set({ state: 'posted', postedAt: at, postedBy: ctx.actor.userId, selfApprovalReason: opts.selfApprovalReason ?? null, ...touch(ctx, financialEntries) })
    .where(eq(financialEntries.id, e.id))
    .returning();
  // Evidence of a posted document can no longer be unlinked.
  await ctx.tx
    .update(assetLinks)
    .set({ holding: true })
    .where(and(eq(assetLinks.workspaceId, ctx.actor.workspaceId), eq(assetLinks.entityType, 'financial_entry'), eq(assetLinks.entityId, e.id), isNull(assetLinks.removedAt)));

  const projectIds = [...new Set(allocs.map((a) => a.projectId).filter((p): p is string => !!p))];
  await audit(ctx, {
    action: 'financial_entry.posted',
    entityType: 'financial_entry',
    entityId: e.id,
    projectId: projectIds[0] ?? null,
    sensitivity: 'finance',
    reason: opts.selfApprovalReason ?? opts.approverNote ?? null,
    diff: { state: { from: e.state, to: 'posted' } },
    metadata: { selfApproval: !!opts.selfApprovalReason, fxRates: [...usedRateIds] },
  });
  await emit(ctx, { type: 'financial_entry.posted', entityType: 'financial_entry', entityId: e.id, revision: row!.rowVersion, payload: { state: 'posted', type: e.type } });
  await evaluateBudgetAlerts(ctx, { projectIds, campaignIds: allocs.map((a) => a.campaignId).filter((c): c is string => !!c), date: e.recognitionDate });
  if (opts.notifyAuthor !== false) {
    const map = await userMembershipMap(ctx.tx, ctx.actor.workspaceId, [e.createdBy, e.submittedBy]);
    await notify(ctx.tx, {
      workspaceId: ctx.actor.workspaceId,
      recipientMembershipIds: [...map.values()],
      eventType: 'finance.entry_posted',
      eventKey: `finance.entry_posted:${e.id}`,
      kind: 'general',
      title: `Entry posted: ${e.title}`,
      sensitive: true,
      entityType: 'financial_entry',
      entityId: e.id,
      actorMembershipId: ctx.actor.membershipId,
      at,
    });
  }
  return row!;
};

export const postEntry = async (ctx: CommandContext, id: string, input: { approverNote?: string; exceptionReason?: string }) => {
  requirePermission(ctx, 'finance.post');
  const e = await lockById(ctx, financialEntries, id, 'Entry');
  const { allocs } = await loadEntryParts(ctx, id);
  authorizeFinance(ctx, 'finance.post', entryScopesOf(e, allocs), ['finance.read']);
  assertVersion(ctx, e);
  if (e.state === 'posted') throw new AppError('INVALID_STATE', 'This entry is already posted.', { details: { reason: 'already_posted' } });
  assertTransition(ENTRY_TRANSITIONS, e.state, 'posted', 'entry');
  requireRecentAuth(ctx);
  const self = await checkMakerChecker(ctx, e.submittedBy, 'finance.post', input.exceptionReason, 'entry');
  await postEntryCore(ctx, e, { selfApprovalReason: self, approverNote: input.approverNote ?? null });
  return id;
};

export const rejectEntry = async (ctx: CommandContext, id: string, input: { reason: string }) => {
  const e = await lockById(ctx, financialEntries, id, 'Entry');
  const { allocs } = await loadEntryParts(ctx, id);
  authorizeFinance(ctx, 'finance.post', entryScopesOf(e, allocs), ['finance.read']);
  assertVersion(ctx, e);
  assertTransition(ENTRY_TRANSITIONS, e.state, 'rejected', 'entry');
  const at = ctx.app.clock.now();
  const [row] = await ctx.tx
    .update(financialEntries)
    .set({ state: 'rejected', rejectedAt: at, rejectedReason: input.reason, ...touch(ctx, financialEntries) })
    .where(eq(financialEntries.id, id))
    .returning();
  await audit(ctx, { action: 'financial_entry.rejected', entityType: 'financial_entry', entityId: id, sensitivity: 'finance', reason: input.reason, diff: { state: { from: e.state, to: 'rejected' } } });
  await emit(ctx, { type: 'financial_entry.rejected', entityType: 'financial_entry', entityId: id, revision: row!.rowVersion, payload: { state: 'rejected' } });
  const map = await userMembershipMap(ctx.tx, ctx.actor.workspaceId, [e.createdBy, e.submittedBy]);
  await notify(ctx.tx, {
    workspaceId: ctx.actor.workspaceId,
    recipientMembershipIds: [...map.values()],
    eventType: 'finance.entry_rejected',
    eventKey: `finance.entry_rejected:${id}:${row!.rowVersion}`,
    kind: 'general',
    title: `Entry returned: ${e.title}`,
    excerpt: input.reason.slice(0, 200),
    entityType: 'financial_entry',
    entityId: id,
    actorMembershipId: ctx.actor.membershipId,
    at,
  });
  return id;
};

/**
 * Reverse a posted entry with a linked reversing document (T123). The original stays posted and
 * immutable; its economic effect is cancelled from the effective date. Optionally a replacement
 * draft is created for the corrected values.
 */
export const reverseEntry = async (
  ctx: CommandContext,
  id: string,
  input: { reason: string; effectiveDate: string; createReplacement?: boolean },
  opts: { internal?: boolean } = {},
) => {
  const e = await lockById(ctx, financialEntries, id, 'Entry');
  const { lines, allocs } = await loadEntryParts(ctx, id);
  if (!opts.internal) {
    authorizeFinance(ctx, 'finance.reverse', entryScopesOf(e, allocs), ['finance.read']);
    assertVersion(ctx, e);
  }
  if (e.state !== 'posted') throw new AppError('INVALID_STATE', 'Only posted entries are reversed. Edit or reject the draft instead.', { details: { reason: 'not_posted' } });
  if (e.reversedByEntryId) throw new AppError('INVALID_STATE', 'This entry has already been reversed.', { details: { reason: 'already_reversed', reversalId: e.reversedByEntryId } });
  if (e.reversesEntryId) throw new AppError('INVALID_STATE', 'A reversal cannot be reversed. Record a new entry instead.', { details: { reason: 'is_reversal' } });
  if (input.effectiveDate < e.recognitionDate)
    throw new AppError('VALIDATION_FAILED', 'The reversal cannot be dated before the original entry.', { fieldErrors: [{ field: 'effectiveDate', code: 'TOO_EARLY', message: 'Use a date on or after the original recognition date.' }] });
  if (!opts.internal) requireRecentAuth(ctx);
  await assertPeriodOpen(ctx, input.effectiveDate, 'reverse');
  const settled = await ctx.tx
    .select({ id: settlementAllocations.id, settlementId: settlementAllocations.settlementId })
    .from(settlementAllocations)
    .innerJoin(settlements, eq(settlements.id, settlementAllocations.settlementId))
    .where(and(eq(settlementAllocations.workspaceId, ctx.actor.workspaceId), eq(settlementAllocations.targetEntryId, id), isNull(settlementAllocations.reversedAt), eq(settlements.state, 'confirmed')));
  if (settled.length)
    throw new AppError('INVALID_STATE', 'Money was already settled against this entry. Reverse the settlement allocation first so the cash is not lost.', {
      details: { reason: 'settled', settlementIds: [...new Set(settled.map((s) => s.settlementId))] },
    });

  const revId = newId();
  const at = ctx.app.clock.now();
  await ctx.tx.insert(financialEntries).values({
    ...stamp(ctx),
    id: revId,
    type: e.type,
    state: 'draft',
    recognitionDate: input.effectiveDate,
    title: `Reversal: ${e.title}`.slice(0, 120),
    counterparty: e.counterparty,
    accountId: e.accountId,
    campaignId: e.campaignId,
    shiftId: e.shiftId,
    dealId: e.dealId,
    netOnly: e.netOnly,
    note: input.reason,
    reversesEntryId: e.id,
    reversalReason: input.reason,
    compensationRunId: e.compensationRunId,
  });
  for (const l of lines) {
    const lid = newId();
    await ctx.tx.insert(financialEntryLines).values({
      ...stamp(ctx),
      id: lid,
      entryId: revId,
      lineNo: l.lineNo,
      categoryId: l.categoryId,
      accountingClass: l.accountingClass,
      amountMinor: l.amountMinor,
      currency: l.currency,
      fxRate: l.fxRate,
      fxRateId: l.fxRateId,
      baseAmountMinor: l.baseAmountMinor,
      baseCurrency: l.baseCurrency,
      description: l.description,
      sourceNamespace: l.sourceNamespace,
      transactionRef: l.transactionRef,
      componentsUnknown: l.componentsUnknown,
      fxEffect: l.fxEffect,
      reversesLineId: l.id,
      isReversal: true,
    });
    // Net allocation per target (original rows plus earlier adjustments) is reversed at the effective date.
    const net = new Map<string, { a: AllocRow; amount: bigint; base: bigint }>();
    for (const a of allocs.filter((x) => x.lineId === l.id)) {
      const k = `${a.projectId}|${a.campaignId}|${a.contentItemId}`;
      const cur = net.get(k) ?? { a, amount: 0n, base: 0n };
      cur.amount += a.amountMinor;
      cur.base += a.baseAmountMinor ?? 0n;
      net.set(k, cur);
    }
    for (const { a, amount, base } of net.values()) {
      if (amount === 0n && base === 0n) continue;
      await ctx.tx.insert(financialAllocations).values({
        ...stamp(ctx),
        id: newId(),
        lineId: lid,
        entryId: revId,
        projectId: a.projectId,
        campaignId: a.campaignId,
        contentItemId: a.contentItemId,
        amountMinor: amount,
        baseAmountMinor: base,
        sharePercent: a.sharePercent,
        ruleSnapshot: { reversalOf: a.id },
        effectiveDate: input.effectiveDate,
      });
    }
  }
  await ctx.tx.update(financialEntries).set({ state: 'posted', postedAt: at, postedBy: ctx.actor.userId }).where(eq(financialEntries.id, revId));
  const [orig] = await ctx.tx
    .update(financialEntries)
    .set({ reversedByEntryId: revId, reversalReason: input.reason, ...touch(ctx, financialEntries) })
    .where(eq(financialEntries.id, e.id))
    .returning();

  // Commitment consumptions of the original are released.
  const cons = await ctx.tx
    .select()
    .from(commitmentConsumptions)
    .where(and(eq(commitmentConsumptions.workspaceId, ctx.actor.workspaceId), inArray(commitmentConsumptions.entryLineId, lines.length ? lines.map((l) => l.id) : [newId()]), isNull(commitmentConsumptions.reversedAt)));
  for (const cc of cons) {
    await ctx.tx.update(commitmentConsumptions).set({ reversedAt: at, ...touch(ctx, commitmentConsumptions) }).where(eq(commitmentConsumptions.id, cc.id));
    const [c] = await ctx.tx.select().from(commitments).where(eq(commitments.id, cc.commitmentId)).for('update');
    if (c) {
      const consumed = c.consumedMinor - cc.amountMinor < 0n ? 0n : c.consumedMinor - cc.amountMinor;
      await ctx.tx.update(commitments).set({ consumedMinor: consumed, state: c.state === 'cancelled' ? 'cancelled' : commitmentStateFor(c.amountMinor, consumed), ...touch(ctx, commitments) }).where(eq(commitments.id, c.id));
    }
  }

  let replacementId: string | null = null;
  if (input.createReplacement) {
    replacementId = newId();
    await ctx.tx.insert(financialEntries).values({
      ...stamp(ctx),
      id: replacementId,
      type: e.type,
      state: 'draft',
      recognitionDate: input.effectiveDate,
      title: e.title,
      counterparty: e.counterparty,
      accountId: e.accountId,
      campaignId: e.campaignId,
      shiftId: e.shiftId,
      dealId: e.dealId,
      refundOfEntryId: e.refundOfEntryId,
      netOnly: e.netOnly,
      controlTotalMinor: e.controlTotalMinor,
      controlTotalCurrency: e.controlTotalCurrency,
      note: e.note,
      replacementOfEntryId: e.id,
    });
    const { baseCurrency } = await workspaceFinance(ctx);
    const n = await normalizeEntry(
      ctx,
      {
        type: e.type,
        title: e.title,
        recognitionDate: input.effectiveDate,
        netOnly: e.netOnly,
        lines: linesToInput(lines, allocs).map((l) => ({
          ...l,
          // Source transaction ids stay with the original (they are unique forever).
          transactionRef: null,
          description: [l.description, l.transactionRef ? `Original transaction ${l.transactionRef}` : null].filter(Boolean).join(' · ') || null,
          commitmentId: null,
        })),
      },
      { baseCurrency },
    );
    await insertLines(ctx, replacementId, n, baseCurrency);
    await emit(ctx, { type: 'financial_entry.created', entityType: 'financial_entry', entityId: replacementId, revision: 1, payload: { state: 'draft' } });
  }

  const projectIds = [...new Set(allocs.map((a) => a.projectId).filter((p): p is string => !!p))];
  await audit(ctx, {
    action: 'financial_entry.reversed',
    entityType: 'financial_entry',
    entityId: e.id,
    projectId: projectIds[0] ?? null,
    sensitivity: 'finance',
    reason: input.reason,
    metadata: { reversalId: revId, effectiveDate: input.effectiveDate, replacementId },
  });
  await emit(ctx, { type: 'financial_entry.reversed', entityType: 'financial_entry', entityId: e.id, revision: orig!.rowVersion, payload: { reversalId: revId } });
  await emit(ctx, { type: 'financial_entry.posted', entityType: 'financial_entry', entityId: revId, revision: 2, payload: { state: 'posted', reversal: true } });
  return { originalId: e.id, reversalId: revId, replacementId };
};

// ——— Allocation preview / apply ———

const allocationPlan = async (ctx: QueryContext | CommandContext, e: EntryRow, lines: LineRow[], allocs: AllocRow[], input: { allocation: AllocationSpecInput; lineIds?: string[] }) => {
  const targetLines = lines.filter((l) => !l.isReversal && (!input.lineIds?.length || input.lineIds.includes(l.id)));
  if (!targetLines.length) throw new AppError('VALIDATION_FAILED', 'Choose at least one line.', { fieldErrors: [{ field: 'lineIds', code: 'REQUIRED', message: 'Choose at least one line.' }] });
  const errors: FieldError[] = [];
  const plan = targetLines.map((l) => {
    const r = computeAllocation(l.amountMinor, l.currency.trim(), input.allocation as AllocationSpec);
    if (!r.ok) for (const iss of r.issues) errors.push({ field: iss.row === null ? 'allocation' : `allocation.rows.${iss.row}.value`, code: iss.code, message: iss.message });
    const rows = r.ok ? r.rows : [];
    const lineBase = l.baseAmountMinor;
    const bases = lineBase === null ? null : distributeProportionally(lineBase, rows.map((x) => ({ key: x.key, weightMinor: x.amountMinor })));
    return { line: l, rows: rows.map((x) => ({ ...x, baseAmountMinor: bases ? (bases.get(x.key) ?? 0n) : null })) };
  });
  throwIfErrors(errors);
  const projectIds = [...new Set(plan.flatMap((p) => p.rows.map((r) => r.projectId)).filter((p): p is string => !!p))];
  if (projectIds.length) {
    const found = await dbOf(ctx).select({ id: projects.id }).from(projects).where(and(eq(projects.workspaceId, ctx.actor.workspaceId), inArray(projects.id, projectIds)));
    if (found.length !== projectIds.length) throw new AppError('VALIDATION_FAILED', 'An allocated project was not found.', { fieldErrors: [{ field: 'allocation', code: 'NOT_FOUND', message: 'An allocated project was not found.' }] });
  }
  void allocs;
  void e;
  return { plan, projectIds };
};

export const allocationPreview = async (ctx: QueryContext, id: string, input: { allocation: AllocationSpecInput; lineIds?: string[]; effectiveDate?: string }) => {
  const e = await findById(ctx, financialEntries, id, 'Entry');
  const { lines, allocs } = await loadEntryParts(ctx, id);
  const scopes = entryScopesOf(e, allocs);
  const action = e.state === 'posted' ? 'finance.allocate' : 'finance.create';
  authorizeFinance(ctx, action, scopes, ['finance.read'], { ownRecord: isOwnRecord(ctx, e) });
  if (e.state === 'submitted') throw new AppError('INVALID_STATE', 'This entry is waiting for review. Reject it to change the allocation.');
  if (e.reversesEntryId || e.reversedByEntryId) throw new AppError('INVALID_STATE', 'Reversed entries and reversals keep their allocation.');
  const { plan, projectIds } = await allocationPlan(ctx, e, lines, allocs, input);
  if (!projectIds.every((p) => can(ctx.actor.access, action, { projectId: p }))) throw new AppError('FORBIDDEN', 'You cannot allocate to one of these projects.');
  const effectiveDate = input.effectiveDate ?? ctx.app.clock.now().toISOString().slice(0, 10);
  const { token, expiresAt } = signToken(ctx, 'finance.allocate', { entryId: id, rowVersion: e.rowVersion, allocation: input.allocation, lineIds: input.lineIds ?? [], effectiveDate });
  const names = await loadNames(ctx, { projects: projectIds, campaigns: plan.flatMap((p) => p.rows.map((r) => r.campaignId)) });
  return {
    previewToken: token,
    expiresAt: expiresAt.toISOString(),
    mode: e.state === 'posted' ? ('posted_adjustment' as const) : ('draft_edit' as const),
    lines: plan.map((p) => ({
      lineId: p.line.id,
      amount: moneyOf(p.line.amountMinor, p.line.currency.trim()),
      rows: p.rows.map((r) => ({
        project: refFrom(names.projects, r.projectId),
        campaign: refFrom(names.campaigns, r.campaignId),
        amount: moneyOf(r.amountMinor, p.line.currency.trim()),
        baseAmount: moneyOrNull(r.baseAmountMinor, p.line.baseCurrency.trim()),
      })),
    })),
  };
};

/**
 * Apply a previewed allocation. Drafts are edited in place; for posted entries the change is an
 * append-only adjustment (negation of the current split + the new split at the effective date),
 * so the expense is never copied and closed periods keep their numbers.
 */
export const allocateEntry = async (ctx: CommandContext, id: string, input: { previewToken: string }) => {
  const data = verifyToken<{ entryId: string; rowVersion: number; allocation: AllocationSpecInput; lineIds: string[]; effectiveDate: string }>(ctx, 'finance.allocate', input.previewToken);
  if (data.entryId !== id) throw new AppError('VALIDATION_FAILED', 'The preview belongs to another entry.');
  const e = await lockById(ctx, financialEntries, id, 'Entry');
  const { lines, allocs } = await loadEntryParts(ctx, id);
  const action = e.state === 'posted' ? 'finance.allocate' : 'finance.create';
  authorizeFinance(ctx, action, entryScopesOf(e, allocs), ['finance.read'], { ownRecord: isOwnRecord(ctx, e) });
  assertVersion(ctx, e);
  if (e.rowVersion !== data.rowVersion) throw new AppError('VERSION_CONFLICT', 'The entry changed after the preview. Preview again.', { currentVersion: e.rowVersion });
  if (e.state === 'submitted') throw new AppError('INVALID_STATE', 'This entry is waiting for review.');
  const { plan, projectIds } = await allocationPlan(ctx, e, lines, allocs, { allocation: data.allocation, lineIds: data.lineIds });
  if (!projectIds.every((p) => can(ctx.actor.access, action, { projectId: p }))) throw new AppError('FORBIDDEN', 'You cannot allocate to one of these projects.');
  if (e.state === 'posted') {
    await assertPeriodOpen(ctx, data.effectiveDate, 'allocate');
    for (const p of plan) {
      const net = new Map<string, { a: AllocRow; amount: bigint; base: bigint }>();
      for (const a of allocs.filter((x) => x.lineId === p.line.id)) {
        const k = `${a.projectId}|${a.campaignId}|${a.contentItemId}`;
        const cur = net.get(k) ?? { a, amount: 0n, base: 0n };
        cur.amount += a.amountMinor;
        cur.base += a.baseAmountMinor ?? 0n;
        net.set(k, cur);
      }
      for (const { a, amount, base } of net.values()) {
        if (amount === 0n && base === 0n) continue;
        await ctx.tx.insert(financialAllocations).values({
          ...stamp(ctx),
          id: newId(),
          lineId: p.line.id,
          entryId: id,
          projectId: a.projectId,
          campaignId: a.campaignId,
          contentItemId: a.contentItemId,
          amountMinor: -amount,
          baseAmountMinor: -base,
          ruleSnapshot: { adjustment: 'transfer_out' },
          effectiveDate: data.effectiveDate,
          adjustmentOfId: a.id,
        });
      }
      for (const r of p.rows)
        await ctx.tx.insert(financialAllocations).values({
          ...stamp(ctx),
          id: newId(),
          lineId: p.line.id,
          entryId: id,
          projectId: r.projectId,
          campaignId: r.campaignId,
          contentItemId: r.contentItemId,
          amountMinor: r.amountMinor,
          baseAmountMinor: r.baseAmountMinor,
          sharePercent: r.sharePercent,
          ruleSnapshot: { adjustment: 'transfer_in', mode: data.allocation.mode },
          effectiveDate: data.effectiveDate,
          adjustmentOfId: allocs.find((x) => x.lineId === p.line.id)?.id ?? null,
        });
    }
  } else {
    for (const p of plan) {
      await ctx.tx.delete(financialAllocations).where(and(eq(financialAllocations.workspaceId, ctx.actor.workspaceId), eq(financialAllocations.lineId, p.line.id)));
      for (const r of p.rows)
        await ctx.tx.insert(financialAllocations).values({
          ...stamp(ctx),
          id: newId(),
          lineId: p.line.id,
          entryId: id,
          projectId: r.projectId,
          campaignId: r.campaignId,
          contentItemId: r.contentItemId,
          amountMinor: r.amountMinor,
          baseAmountMinor: r.baseAmountMinor,
          sharePercent: r.sharePercent,
          ruleSnapshot: { mode: data.allocation.mode },
          effectiveDate: e.recognitionDate,
        });
    }
  }
  const [row] = await ctx.tx.update(financialEntries).set({ ...touch(ctx, financialEntries) }).where(eq(financialEntries.id, id)).returning();
  await audit(ctx, {
    action: e.state === 'posted' ? 'financial_entry.allocation_adjusted' : 'financial_entry.allocation_changed',
    entityType: 'financial_entry',
    entityId: id,
    projectId: projectIds[0] ?? null,
    sensitivity: 'finance',
    metadata: { effectiveDate: data.effectiveDate, lines: plan.length, mode: data.allocation.mode },
  });
  await emit(ctx, { type: 'financial_entry.allocated', entityType: 'financial_entry', entityId: id, revision: row!.rowVersion });
  if (e.state === 'posted') await evaluateBudgetAlerts(ctx, { projectIds, campaignIds: [], date: data.effectiveDate });
  return id;
};

// ——— Revenue attribution ———

/**
 * Manager attribution (spec §13.5): explicit shares ≤ 100 %, remainder Unassigned. Replaces the
 * current set (history kept via superseded rows); changes after an approved compensation run are
 * picked up as adjustments in the next run.
 */
export const setAttributions = async (
  ctx: CommandContext,
  id: string,
  input: { attributions: { membershipId: string; sharePercent: string }[]; reason?: string },
  opts: { basis?: 'manual' | 'source_assignment'; saleCandidateId?: string | null; skipAuth?: boolean } = {},
) => {
  const e = await lockById(ctx, financialEntries, id, 'Entry');
  const { lines, allocs } = await loadEntryParts(ctx, id);
  if (!opts.skipAuth) {
    authorizeFinance(ctx, 'finance.allocate', entryScopesOf(e, allocs), ['finance.read']);
    assertVersion(ctx, e);
  }
  if (!lines.some((l) => l.accountingClass === 'revenue')) throw new AppError('INVALID_STATE', 'Only revenue documents can be attributed to managers.', { details: { reason: 'no_revenue' } });
  const errors: FieldError[] = [];
  const seen = new Set<string>();
  let total = toBig('0');
  for (const [i, a] of input.attributions.entries()) {
    if (!isValidPercent(a.sharePercent) || toBig(a.sharePercent).lte(0)) errors.push({ field: `attributions.${i}.sharePercent`, code: 'INVALID', message: 'Use a share above 0 and at most 100.' });
    else total = total.plus(toBig(a.sharePercent));
    if (seen.has(a.membershipId)) errors.push({ field: `attributions.${i}.membershipId`, code: 'DUPLICATE', message: 'This member appears twice.' });
    seen.add(a.membershipId);
    if (!(await isActiveMember(ctx.tx, ctx.actor.workspaceId, a.membershipId))) errors.push({ field: `attributions.${i}.membershipId`, code: 'INACTIVE', message: 'Choose an active member.' });
  }
  if (total.gt(100)) errors.push({ field: 'attributions', code: 'OVER_100', message: `Shares add up to ${total.toString()}%. The total may not exceed 100%; the rest stays Unassigned.` });
  throwIfErrors(errors);
  const at = ctx.app.clock.now();
  await ctx.tx
    .update(revenueAttributions)
    .set({ supersededAt: at, ...touch(ctx, revenueAttributions) })
    .where(and(eq(revenueAttributions.workspaceId, ctx.actor.workspaceId), eq(revenueAttributions.entryId, id), isNull(revenueAttributions.supersededAt)));
  for (const a of input.attributions)
    await ctx.tx.insert(revenueAttributions).values({
      ...stamp(ctx),
      id: newId(),
      entryId: id,
      membershipId: a.membershipId,
      sharePercent: a.sharePercent,
      basis: opts.basis ?? 'manual',
      reason: input.reason ?? null,
      saleCandidateId: opts.saleCandidateId ?? null,
    });
  const [row] = await ctx.tx.update(financialEntries).set({ ...touch(ctx, financialEntries) }).where(eq(financialEntries.id, id)).returning();
  await audit(ctx, {
    action: 'financial_entry.attribution_set',
    entityType: 'financial_entry',
    entityId: id,
    sensitivity: 'finance',
    reason: input.reason ?? null,
    metadata: { attributions: input.attributions, basis: opts.basis ?? 'manual' },
  });
  await emit(ctx, { type: 'financial_entry.attributed', entityType: 'financial_entry', entityId: id, revision: row!.rowVersion });
  return id;
};

// ——— Reads ———

export const evidenceRows = async (ctx: QueryContext | CommandContext, e: Pick<EntryRow, 'id' | 'evidenceAssetIds'>, entityType = 'financial_entry') => {
  const db = dbOf(ctx);
  const links = await db
    .select({ linkId: assetLinks.id, assetId: assetLinks.assetId })
    .from(assetLinks)
    .where(and(eq(assetLinks.workspaceId, ctx.actor.workspaceId), eq(assetLinks.entityType, entityType), eq(assetLinks.entityId, e.id), isNull(assetLinks.removedAt)));
  const ids = [...new Set([...links.map((l) => l.assetId), ...e.evidenceAssetIds])];
  if (!ids.length) return [];
  const rows = await db
    .select({ id: assets.id, name: assets.name, versionId: assets.currentVersionId, status: assetVersions.status, mime: assetVersions.detectedMime, declared: assetVersions.declaredMime })
    .from(assets)
    .leftJoin(assetVersions, eq(assetVersions.id, assets.currentVersionId))
    .where(and(eq(assets.workspaceId, ctx.actor.workspaceId), inArray(assets.id, ids)));
  const versionIds = rows.map((r) => r.versionId).filter((v): v is string => !!v);
  const derivs = versionIds.length ? await db.select({ v: assetDerivatives.assetVersionId }).from(assetDerivatives).where(inArray(assetDerivatives.assetVersionId, versionIds)) : [];
  const hasThumb = new Set(derivs.map((d) => d.v));
  return rows.map((r) => ({
    assetId: r.id,
    linkId: links.find((l) => l.assetId === r.id)?.linkId ?? null,
    name: r.name,
    mime: r.mime ?? r.declared ?? null,
    status: r.status ?? null,
    thumbnailUrl: r.versionId && hasThumb.has(r.versionId) ? `/api/v1/workspaces/${ctx.actor.workspaceId}/assets/${r.id}/thumbnail?size=256` : null,
  }));
};

export const entryDisplayState = (e: Pick<EntryRow, 'state' | 'reversedByEntryId'>) => (e.state === 'posted' && e.reversedByEntryId ? ('reversed' as const) : e.state);

type NameMaps = Awaited<ReturnType<typeof loadNames>>;

const rowView = (e: EntryRow, lines: LineRow[], allocs: AllocRow[], names: NameMaps, baseCurrency: string, showAmounts: boolean) => {
  const baseKnown = lines.every((l) => l.baseAmountMinor !== null);
  const netBase = baseKnown ? lines.reduce((a, l) => a + signedEffect({ ...toLedgerLine(l), amountMinor: l.baseAmountMinor! }), 0n) : null;
  const balances = documentBalance(lines.map((l) => ({ ...toLedgerLine(l), currency: l.currency.trim() })));
  const projectIds = [...new Set(allocs.map((a) => a.projectId).filter((p): p is string => !!p))];
  // Current allocation per target (adjustments net out); unallocated when a net Unallocated amount remains.
  const unallocatedNet = allocs.filter((a) => !a.projectId).reduce((s, a) => s + a.amountMinor, 0n);
  return {
    id: e.id,
    type: e.type,
    state: e.state,
    displayState: entryDisplayState(e),
    recognitionDate: e.recognitionDate,
    title: e.title,
    counterparty: e.counterparty,
    source: e.sourceNamespace && e.sourceExternalId ? { namespace: e.sourceNamespace, externalId: e.sourceExternalId } : null,
    ...(showAmounts
      ? {
          netBase: moneyOrNull(netBase, baseCurrency),
          balances: [...balances.entries()].map(([c, v]) => moneyOf(v, c)),
        }
      : {}),
    projects: projectIds.map((p) => ({ id: p, name: names.projects.get(p) ?? 'Unavailable project' })),
    unallocated: unallocatedNet !== 0n,
    netOnly: e.netOnly,
    isReversal: !!e.reversesEntryId,
    lineCount: lines.length,
    createdAt: e.createdAt.toISOString(),
    updatedAt: e.updatedAt.toISOString(),
    rowVersion: e.rowVersion,
  };
};

export const settledByEntry = async (ctx: QueryContext | CommandContext, entryIds: string[]) => {
  if (!entryIds.length) return [];
  return dbOf(ctx)
    .select({
      allocationId: settlementAllocations.id,
      entryId: settlementAllocations.targetEntryId,
      settlementId: settlements.id,
      direction: settlements.direction,
      paidAt: settlements.paidAt,
      state: settlements.state,
      amountMinor: settlementAllocations.amountMinor,
      currency: settlements.currency,
      documentAmountMinor: settlementAllocations.documentAmountMinor,
      documentCurrency: settlementAllocations.documentCurrency,
      reversedAt: settlementAllocations.reversedAt,
    })
    .from(settlementAllocations)
    .innerJoin(settlements, eq(settlements.id, settlementAllocations.settlementId))
    .where(and(eq(settlementAllocations.workspaceId, ctx.actor.workspaceId), inArray(settlementAllocations.targetEntryId, entryIds), ne(settlements.state, 'draft')));
};

/** Outstanding per currency: document balance minus active settled amounts (sign kept). */
export const outstandingOf = (e: Pick<EntryRow, 'state' | 'reversedByEntryId' | 'reversesEntryId' | 'compensationRunId'>, lines: LineRow[], settled: Awaited<ReturnType<typeof settledByEntry>>) => {
  // Run expense documents are settled through the run's recipients, not directly.
  if (e.state !== 'posted' || e.reversedByEntryId || e.reversesEntryId || e.compensationRunId) return new Map<string, bigint>();
  const bal = documentBalance(lines.map((l) => ({ ...toLedgerLine(l), currency: l.currency.trim() })));
  for (const s of settled) {
    if (s.reversedAt || s.state !== 'confirmed') continue;
    const c = s.documentCurrency.trim();
    const cur = bal.get(c) ?? 0n;
    bal.set(c, cur > 0n ? cur - s.documentAmountMinor : cur + s.documentAmountMinor);
  }
  return bal;
};

export const canReadEntry = (ctx: QueryContext, e: EntryRow, allocs: AllocRow[]) => canAny(ctx, 'finance.read', entryScopesOf(e, allocs)) || isOwnRecord(ctx, e);

export const getEntry = async (ctx: QueryContext | CommandContext, id: string) => {
  const e = await findById(ctx, financialEntries, id, 'Entry');
  const { lines, allocs } = await loadEntryParts(ctx, id);
  if (!canReadEntry(ctx, e, allocs)) throw new AppError('NOT_FOUND', 'Entry was not found.');
  const db = dbOf(ctx);
  const ws = ctx.actor.workspaceId;
  const { baseCurrency } = await workspaceFinance(ctx);
  const scopes = entryScopesOf(e, allocs);
  const cats = await loadCategoryMap(ctx, lines.map((l) => l.categoryId));
  const names = await loadNames(ctx, {
    projects: allocs.map((a) => a.projectId),
    campaigns: [...allocs.map((a) => a.campaignId), e.campaignId],
    contentItems: allocs.map((a) => a.contentItemId),
    accounts: [e.accountId],
    deals: [e.dealId],
  });
  const rateIds = lines.map((l) => l.fxRateId).filter((x): x is string => !!x);
  const rateRows = rateIds.length ? await db.select().from(fxRates).where(and(eq(fxRates.workspaceId, ws), inArray(fxRates.id, rateIds))) : [];
  const commitmentIds = lines.map((l) => l.commitmentId).filter((x): x is string => !!x);
  const commitmentRows = commitmentIds.length ? await db.select({ id: commitments.id, name: commitments.description }).from(commitments).where(and(eq(commitments.workspaceId, ws), inArray(commitments.id, commitmentIds))) : [];
  const attributions = await db
    .select()
    .from(revenueAttributions)
    .where(and(eq(revenueAttributions.workspaceId, ws), eq(revenueAttributions.entryId, id), isNull(revenueAttributions.supersededAt)))
    .orderBy(asc(revenueAttributions.createdAt));
  const settled = await settledByEntry(ctx, [id]);
  const userMap = await userMembershipMap(db, ws, [e.createdBy, e.submittedBy, e.postedBy]);
  const refs = await loadMemberRefs(db, ws, [...userMap.values(), ...attributions.map((a) => a.membershipId)]);
  const viewEvidence = canAny(ctx, 'finance.documents.read', scopes);

  // Missing FX (drafts): the rate that would be used at posting is not available yet.
  const missingFx =
    e.state === 'posted'
      ? []
      : [...new Set(lines.filter((l) => l.currency.trim() !== baseCurrency && l.baseAmountMinor === null).map((l) => l.currency.trim()))].map((c) => ({ currency: c, date: e.recognitionDate }));
  const baseKnown = lines.length > 0 && lines.every((l) => l.baseAmountMinor !== null);
  const summary = baseKnown ? summarizeLedger(lines.map((l) => ({ ...toLedgerLine(l), amountMinor: l.baseAmountMinor! }))) : null;
  const cc = controlCheck(e, lines);
  const outstanding = outstandingOf(e, lines, settled);
  const member = (userId: string | null) => (userId && userMap.get(userId) ? refOrUnknown(refs, userMap.get(userId)) : null);
  const editable = e.state === 'draft' || e.state === 'rejected';
  const own = isOwnRecord(ctx, e);
  const revenueDoc = lines.some((l) => l.accountingClass === 'revenue');

  return {
    ...rowView(e, lines, allocs, names, baseCurrency, true),
    baseCurrency,
    account: refFrom(names.accounts, e.accountId),
    campaign: refFrom(names.campaigns, e.campaignId),
    deal: refFrom(names.deals, e.dealId),
    shiftId: e.shiftId,
    saleCandidateId: e.saleCandidateId,
    compensationRunId: e.compensationRunId,
    note: e.note,
    controlTotal: e.controlTotalMinor !== null && e.controlTotalCurrency ? moneyOf(e.controlTotalMinor, e.controlTotalCurrency.trim()) : null,
    controlCheck: { status: cc.status, difference: cc.difference !== null ? moneyOf(cc.difference, e.controlTotalCurrency!.trim()) : null },
    lines: lines.map((l) => {
      const cat = cats.get(l.categoryId);
      const rate = rateRows.find((r) => r.id === l.fxRateId);
      const cur = l.currency.trim();
      return {
        id: l.id,
        lineNo: l.lineNo,
        category: { id: l.categoryId, key: cat?.key ?? '', name: cat?.name ?? 'Unknown category', accountingClass: cat?.accountingClass ?? l.accountingClass },
        accountingClass: l.accountingClass,
        amount: moneyOf(l.amountMinor, cur),
        fx: l.fxRate ? { rate: l.fxRate, rateId: l.fxRateId, source: cur === l.baseCurrency.trim() ? 'Base currency' : (rate?.source ?? null), effectiveDate: rate?.effectiveDate ?? null } : null,
        baseAmount: moneyOrNull(l.baseAmountMinor, l.baseCurrency.trim()),
        description: l.description,
        transactionRef: l.transactionRef,
        componentsUnknown: l.componentsUnknown,
        isReversal: l.isReversal,
        fxEffect: l.fxEffect,
        commitment: l.commitmentId ? { id: l.commitmentId, name: commitmentRows.find((c) => c.id === l.commitmentId)?.name ?? 'Commitment' } : null,
        allocations: allocs
          .filter((a) => a.lineId === l.id)
          .map((a) => ({
            id: a.id,
            project: refFrom(names.projects, a.projectId),
            campaign: refFrom(names.campaigns, a.campaignId),
            contentItem: refFrom(names.contentItems, a.contentItemId),
            amount: moneyOf(a.amountMinor, cur),
            baseAmount: moneyOrNull(a.baseAmountMinor, l.baseCurrency.trim()),
            sharePercent: a.sharePercent,
            effectiveDate: a.effectiveDate,
            adjustmentOfId: a.adjustmentOfId,
          })),
      };
    }),
    summary: summary
      ? {
          grossRevenue: moneyOf(summary.grossRevenue, baseCurrency),
          refunds: moneyOf(summary.refunds, baseCurrency),
          fees: moneyOf(summary.fees, baseCurrency),
          netRevenue: moneyOf(summary.netRevenue, baseCurrency),
          operatingExpenses: moneyOf(summary.operatingExpenses, baseCurrency),
          compensationExpense: moneyOf(summary.compensationExpense, baseCurrency),
          result: moneyOf(summary.operatingResult, baseCurrency),
          grossIncomplete: summary.grossIncomplete,
        }
      : null,
    missingFx,
    ...(viewEvidence ? { evidence: await evidenceRows(ctx, e) } : {}),
    attributions: attributions.map((a) => ({
      id: a.id,
      member: refOrUnknown(refs, a.membershipId)!,
      sharePercent: a.sharePercent,
      basis: a.basis,
      reason: a.reason,
      createdAt: a.createdAt.toISOString(),
    })),
    settlements: settled.map((s) => ({
      allocationId: s.allocationId,
      settlementId: s.settlementId,
      direction: s.direction,
      paidAt: s.paidAt.toISOString(),
      documentAmount: moneyOf(s.documentAmountMinor, s.documentCurrency.trim()),
      cashAmount: moneyOf(s.amountMinor, s.currency.trim()),
      reversed: !!s.reversedAt || s.state === 'reversed',
    })),
    outstanding: [...outstanding.entries()].filter(([, v]) => v !== 0n).map(([c, v]) => moneyOf(v, c)),
    submittedAt: e.submittedAt?.toISOString() ?? null,
    submittedBy: member(e.submittedBy),
    postedAt: e.postedAt?.toISOString() ?? null,
    postedBy: member(e.postedBy),
    selfApprovalReason: e.selfApprovalReason,
    rejectedAt: e.rejectedAt?.toISOString() ?? null,
    rejectedReason: e.rejectedReason,
    reversesEntryId: e.reversesEntryId,
    reversedByEntryId: e.reversedByEntryId,
    replacementOfEntryId: e.replacementOfEntryId,
    refundOfEntryId: e.refundOfEntryId,
    reversalReason: e.reversalReason,
    createdBy: member(e.createdBy),
    permissions: {
      update: editable && (canAll(ctx, 'finance.create', scopes) || own),
      submit: e.state === 'draft' && (canAll(ctx, 'finance.submit', scopes) || (own && hasAnywhere(ctx.actor.access, 'finance.submit'))),
      post: e.state === 'submitted' && canAll(ctx, 'finance.post', scopes),
      reject: e.state === 'submitted' && canAll(ctx, 'finance.post', scopes),
      reverse: e.state === 'posted' && !e.reversedByEntryId && !e.reversesEntryId && canAll(ctx, 'finance.reverse', scopes),
      allocate: !e.reversesEntryId && !e.reversedByEntryId && e.state !== 'submitted' && canAll(ctx, e.state === 'posted' ? 'finance.allocate' : 'finance.create', scopes),
      attribute: revenueDoc && !e.reversesEntryId && canAll(ctx, 'finance.allocate', scopes),
      addSettlement: e.state === 'posted' && !e.reversedByEntryId && !e.reversesEntryId && [...outstanding.values()].some((v) => v !== 0n) && hasAnywhere(ctx.actor.access, 'settlements.create'),
      selfApprovalRequired: e.state === 'submitted' && !!e.submittedBy && e.submittedBy === ctx.actor.userId,
      viewEvidence,
      attachEvidence: viewEvidence && hasAnywhere(ctx.actor.access, 'assets.upload') && (e.state !== 'posted' || canAll(ctx, 'finance.post', scopes)),
    },
  };
};

export interface ListEntriesInput {
  cursor?: string;
  pageSize?: number;
  q?: string;
  state?: ('draft' | 'submitted' | 'posted' | 'rejected' | 'reversed')[];
  type?: EntryType[];
  from?: string;
  to?: string;
  projectId?: string;
  unallocated?: boolean;
  categoryId?: string;
  accountId?: string;
  campaignId?: string;
  dealId?: string;
  sourceNamespace?: string;
  sort: 'recognitionDate' | 'updatedAt' | 'title';
  direction: 'asc' | 'desc';
}

const SORT = { recognitionDate: financialEntries.recognitionDate, updatedAt: financialEntries.updatedAt, title: financialEntries.title } as const;

export const entryVisibilitySql = (ctx: QueryContext, permission = 'finance.read') =>
  financeScopeSql(ctx, permission, {
    projectExists: (ids) =>
      sql`EXISTS (SELECT 1 FROM financial_allocations fa WHERE fa.workspace_id = ${financialEntries.workspaceId} AND fa.entry_id = ${financialEntries.id} AND fa.project_id IN (${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)}))`,
    accountId: financialEntries.accountId,
    createdBy: financialEntries.createdBy,
  });

export const listEntries = async (ctx: QueryContext, input: ListEntriesInput) => {
  if (!hasAnywhere(ctx.actor.access, 'finance.read') && !hasAnywhere(ctx.actor.access, 'finance.create')) throw new AppError('FORBIDDEN', 'You do not have permission to perform this action.');
  const size = clampPageSize(input.pageSize);
  const sortCol = SORT[input.sort];
  const cmp = input.direction === 'asc' ? gt : lt;
  const c = input.cursor ? decodeCursor(input.cursor) : null;
  let cursorCond: SQL | undefined;
  if (c) {
    const v = input.sort === 'updatedAt' ? new Date(String(c.v[0])) : c.v[0];
    cursorCond = or(cmp(sortCol, v as never), and(eq(sortCol, v as never), cmp(financialEntries.id, c.id)));
  }
  const states = input.state ?? [];
  const stateConds: SQL[] = [];
  for (const s of states) {
    if (s === 'reversed') stateConds.push(sql`(${financialEntries.state} = 'posted' AND ${financialEntries.reversedByEntryId} IS NOT NULL)`);
    else if (s === 'posted') stateConds.push(sql`(${financialEntries.state} = 'posted' AND ${financialEntries.reversedByEntryId} IS NULL)`);
    else stateConds.push(eq(financialEntries.state, s));
  }
  const q = input.q?.trim();
  const where = and(
    eq(financialEntries.workspaceId, ctx.actor.workspaceId),
    entryVisibilitySql(ctx),
    stateConds.length ? or(...stateConds) : undefined,
    input.type?.length ? inArray(financialEntries.type, input.type) : undefined,
    input.from ? sql`${financialEntries.recognitionDate} >= ${input.from}` : undefined,
    input.to ? sql`${financialEntries.recognitionDate} <= ${input.to}` : undefined,
    input.projectId ? sql`EXISTS (SELECT 1 FROM financial_allocations fa WHERE fa.workspace_id = ${financialEntries.workspaceId} AND fa.entry_id = ${financialEntries.id} AND fa.project_id = ${input.projectId})` : undefined,
    input.unallocated
      ? sql`EXISTS (SELECT 1 FROM financial_allocations fa WHERE fa.workspace_id = ${financialEntries.workspaceId} AND fa.entry_id = ${financialEntries.id} AND fa.project_id IS NULL GROUP BY fa.line_id HAVING sum(fa.amount_minor) <> 0)`
      : undefined,
    input.categoryId ? sql`EXISTS (SELECT 1 FROM financial_entry_lines l WHERE l.workspace_id = ${financialEntries.workspaceId} AND l.entry_id = ${financialEntries.id} AND l.category_id = ${input.categoryId})` : undefined,
    input.accountId ? eq(financialEntries.accountId, input.accountId) : undefined,
    input.campaignId
      ? or(eq(financialEntries.campaignId, input.campaignId), sql`EXISTS (SELECT 1 FROM financial_allocations fa WHERE fa.workspace_id = ${financialEntries.workspaceId} AND fa.entry_id = ${financialEntries.id} AND fa.campaign_id = ${input.campaignId})`)
      : undefined,
    input.dealId ? eq(financialEntries.dealId, input.dealId) : undefined,
    input.sourceNamespace ? eq(financialEntries.sourceNamespace, input.sourceNamespace) : undefined,
    q ? or(ilike(financialEntries.title, `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`), ilike(financialEntries.counterparty, `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`), eq(financialEntries.sourceExternalId, q)) : undefined,
    cursorCond,
  );
  const rows = await dbOf(ctx)
    .select()
    .from(financialEntries)
    .where(where)
    .orderBy(input.direction === 'asc' ? asc(sortCol) : desc(sortCol), input.direction === 'asc' ? asc(financialEntries.id) : desc(financialEntries.id))
    .limit(size + 1);
  const hasMore = rows.length > size;
  const pageRows = hasMore ? rows.slice(0, size) : rows;
  const items = await entryRows(ctx, pageRows);
  const last = pageRows[pageRows.length - 1];
  const lastValue = last ? (input.sort === 'updatedAt' ? last.updatedAt.toISOString() : input.sort === 'title' ? last.title : last.recognitionDate) : null;
  return { items, hasMore, nextCursor: hasMore && last ? encodeCursor({ v: [lastValue], id: last.id }) : null };
};

/** Row views for a set of entries (amounts only where finance.read covers the entry). */
export const entryRows = async (ctx: QueryContext | CommandContext, rows: EntryRow[], opts: { forceHideAmounts?: boolean } = {}) => {
  if (!rows.length) return [];
  const db = dbOf(ctx);
  const ids = rows.map((r) => r.id);
  const lines = await db.select().from(financialEntryLines).where(and(eq(financialEntryLines.workspaceId, ctx.actor.workspaceId), inArray(financialEntryLines.entryId, ids)));
  const allocs = await db.select().from(financialAllocations).where(and(eq(financialAllocations.workspaceId, ctx.actor.workspaceId), inArray(financialAllocations.entryId, ids)));
  const names = await loadNames(ctx, { projects: allocs.map((a) => a.projectId) });
  const { baseCurrency } = await workspaceFinance(ctx);
  return rows.map((r) => {
    const ea = allocs.filter((a) => a.entryId === r.id);
    const show = !opts.forceHideAmounts && (canAny(ctx, 'finance.read', entryScopesOf(r, ea)) || isOwnRecord(ctx, r));
    return rowView(r, lines.filter((l) => l.entryId === r.id).sort((a, b) => a.lineNo - b.lineNo), ea, names, baseCurrency, show);
  });
};
