import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { financeCategories, fxRates } from '@castlane/database';
import { AppError, isPositiveRate, newId, normalizeKey } from '@castlane/domain';
import { requireAnyPermission, requirePermission } from '../core/access';
import { audit, diffFields } from '../core/audit';
import { dbOf, type CommandContext, type QueryContext } from '../core/context';
import { emit } from '../core/events';
import { loadMemberRefs } from '../core/members';
import { assertVersion, findById, lockById, stamp, touch } from '../core/rows';
import { clampPageSize, decodeCursor, encodeCursor } from '@castlane/domain';
import { userMembershipMap } from './common';

/** Anyone who works with finance records needs the category catalogue. */
export const FINANCE_READERS = ['finance.read', 'finance.create', 'budgets.read', 'budgets.write', 'compensation.rules.read', 'sale-candidates.review'];

type CategoryRow = typeof financeCategories.$inferSelect;

export const categoryView = (c: CategoryRow) => ({
  id: c.id,
  key: c.key,
  name: c.name,
  accountingClass: c.accountingClass,
  isSystem: c.isSystem,
  sortOrder: c.sortOrder,
  archivedAt: c.archivedAt?.toISOString() ?? null,
  rowVersion: c.rowVersion,
});

export const listCategories = async (ctx: QueryContext, input: { includeArchived?: boolean }) => {
  requireAnyPermission(ctx, FINANCE_READERS);
  const rows = await dbOf(ctx)
    .select()
    .from(financeCategories)
    .where(and(eq(financeCategories.workspaceId, ctx.actor.workspaceId), input.includeArchived ? undefined : isNull(financeCategories.archivedAt)))
    .orderBy(asc(financeCategories.sortOrder), asc(financeCategories.name));
  return rows.map(categoryView);
};

export const getCategory = async (ctx: QueryContext | CommandContext, id: string) => {
  requireAnyPermission(ctx, FINANCE_READERS);
  return categoryView(await findById(ctx, financeCategories, id, 'Category'));
};

export const createCategory = async (ctx: CommandContext, input: { name: string; accountingClass: CategoryRow['accountingClass'] }) => {
  requirePermission(ctx, 'finance.post');
  const base = normalizeKey(input.name).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 50) || 'category';
  let key = base;
  for (let i = 2; ; i++) {
    const [exists] = await ctx.tx.select({ id: financeCategories.id }).from(financeCategories).where(and(eq(financeCategories.workspaceId, ctx.actor.workspaceId), eq(financeCategories.key, key)));
    if (!exists) break;
    key = `${base}_${i}`;
  }
  const [dupName] = await ctx.tx
    .select({ id: financeCategories.id })
    .from(financeCategories)
    .where(and(eq(financeCategories.workspaceId, ctx.actor.workspaceId), sql`lower(${financeCategories.name}) = lower(${input.name.trim()})`, isNull(financeCategories.archivedAt)));
  if (dupName) throw new AppError('DUPLICATE', 'A category with this name already exists.', { details: { field: 'name' } });
  const [{ max } = { max: 0 }] = await ctx.tx
    .select({ max: sql<number>`coalesce(max(${financeCategories.sortOrder}), 0)` })
    .from(financeCategories)
    .where(eq(financeCategories.workspaceId, ctx.actor.workspaceId));
  const id = newId();
  const [row] = await ctx.tx
    .insert(financeCategories)
    .values({ ...stamp(ctx), id, key, name: input.name.trim(), accountingClass: input.accountingClass, isSystem: false, sortOrder: Number(max) + 1 })
    .returning();
  await audit(ctx, { action: 'finance_category.created', entityType: 'finance_category', entityId: id, sensitivity: 'finance', diff: diffFields(null, row!, ['name', 'accountingClass']) });
  await emit(ctx, { type: 'finance_category.created', entityType: 'finance_category', entityId: id, revision: 1 });
  return categoryView(row!);
};

export const updateCategory = async (ctx: CommandContext, id: string, input: { name?: string; sortOrder?: number }) => {
  requirePermission(ctx, 'finance.post');
  const c = await lockById(ctx, financeCategories, id, 'Category');
  assertVersion(ctx, c);
  const [row] = await ctx.tx
    .update(financeCategories)
    .set({ ...(input.name ? { name: input.name.trim() } : {}), ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}), ...touch(ctx, financeCategories) })
    .where(eq(financeCategories.id, id))
    .returning();
  await audit(ctx, { action: 'finance_category.updated', entityType: 'finance_category', entityId: id, sensitivity: 'finance', diff: diffFields(c, row!, ['name', 'sortOrder']) });
  await emit(ctx, { type: 'finance_category.updated', entityType: 'finance_category', entityId: id, revision: row!.rowVersion });
  return categoryView(row!);
};

export const archiveCategory = async (ctx: CommandContext, id: string, input: { reason?: string; restore?: boolean }, opts: { skipVersion?: boolean } = {}) => {
  requirePermission(ctx, 'finance.post');
  const c = await lockById(ctx, financeCategories, id, 'Category');
  if (!opts.skipVersion) assertVersion(ctx, c);
  const at = ctx.app.clock.now();
  const [row] = await ctx.tx
    .update(financeCategories)
    .set(input.restore ? { archivedAt: null, archivedBy: null, archiveReason: null, ...touch(ctx, financeCategories) } : { archivedAt: at, archivedBy: ctx.actor.userId, archiveReason: input.reason ?? null, ...touch(ctx, financeCategories) })
    .where(eq(financeCategories.id, id))
    .returning();
  await audit(ctx, { action: input.restore ? 'finance_category.restored' : 'finance_category.archived', entityType: 'finance_category', entityId: id, reason: input.reason, sensitivity: 'finance' });
  await emit(ctx, { type: 'finance_category.updated', entityType: 'finance_category', entityId: id, revision: row!.rowVersion });
  return categoryView(row!);
};

// ——— FX rates ———

type RateRow = typeof fxRates.$inferSelect;

const rateView = (r: RateRow, members: Map<string, { membershipId: string; displayName: string; avatarUrl: string | null }>, userToMember: Map<string, string>) => {
  const mid = r.createdBy ? userToMember.get(r.createdBy) : undefined;
  return {
    id: r.id,
    fromCurrency: r.fromCurrency.trim(),
    toCurrency: r.toCurrency.trim(),
    rate: r.rate,
    effectiveDate: r.effectiveDate,
    source: r.source,
    firstUsedAt: r.firstUsedAt?.toISOString() ?? null,
    locked: !!r.firstUsedAt,
    createdAt: r.createdAt.toISOString(),
    createdBy: mid ? (members.get(mid) ?? null) : null,
    rowVersion: r.rowVersion,
  };
};

const rateViews = async (ctx: QueryContext | CommandContext, rows: RateRow[]) => {
  const db = dbOf(ctx);
  const u2m = await userMembershipMap(db, ctx.actor.workspaceId, rows.map((r) => r.createdBy));
  const refs = await loadMemberRefs(db, ctx.actor.workspaceId, [...u2m.values()]);
  return rows.map((r) => rateView(r, refs as never, u2m));
};

export const listFxRates = async (ctx: QueryContext, input: { cursor?: string; pageSize?: number; fromCurrency?: string; toCurrency?: string }) => {
  requireAnyPermission(ctx, ['finance.read', 'finance.create', 'finance.post']);
  const size = clampPageSize(input.pageSize);
  const c = input.cursor ? decodeCursor(input.cursor) : null;
  const rows = await dbOf(ctx)
    .select()
    .from(fxRates)
    .where(
      and(
        eq(fxRates.workspaceId, ctx.actor.workspaceId),
        input.fromCurrency ? eq(fxRates.fromCurrency, input.fromCurrency) : undefined,
        input.toCurrency ? eq(fxRates.toCurrency, input.toCurrency) : undefined,
        c ? sql`(${fxRates.effectiveDate}, ${fxRates.id}) < (${String(c.v[0])}::date, ${c.id}::uuid)` : undefined,
      ),
    )
    .orderBy(sql`${fxRates.effectiveDate} DESC`, sql`${fxRates.id} DESC`)
    .limit(size + 1);
  const hasMore = rows.length > size;
  const pageRows = hasMore ? rows.slice(0, size) : rows;
  const last = pageRows[pageRows.length - 1];
  return { items: await rateViews(ctx, pageRows), hasMore, nextCursor: hasMore && last ? encodeCursor({ v: [last.effectiveDate], id: last.id }) : null };
};

export const getFxRate = async (ctx: QueryContext | CommandContext, id: string) => {
  requireAnyPermission(ctx, ['finance.read', 'finance.create', 'finance.post']);
  const r = await findById(ctx, fxRates, id, 'FX rate');
  return (await rateViews(ctx, [r]))[0]!;
};

const rateErrors = (from: string, to: string, rate: string) => {
  if (from === to) throw new AppError('VALIDATION_FAILED', 'Choose two different currencies.', { fieldErrors: [{ field: 'toCurrency', code: 'SAME', message: 'Choose two different currencies.' }] });
  if (!isPositiveRate(rate)) throw new AppError('VALIDATION_FAILED', 'Enter a positive rate.', { fieldErrors: [{ field: 'rate', code: 'INVALID', message: 'Enter a positive rate.' }] });
};

export const createFxRate = async (
  ctx: CommandContext,
  input: { fromCurrency: string; toCurrency: string; rate: string; effectiveDate: string; source: string },
  opts: { source?: 'import' } = {},
) => {
  requirePermission(ctx, 'finance.post');
  rateErrors(input.fromCurrency, input.toCurrency, input.rate);
  const id = newId();
  await ctx.tx
    .insert(fxRates)
    .values({ ...stamp(ctx), id, fromCurrency: input.fromCurrency, toCurrency: input.toCurrency, rate: input.rate.trim(), effectiveDate: input.effectiveDate, source: input.source.trim() });
  await audit(ctx, {
    action: 'fx_rate.created',
    entityType: 'fx_rate',
    entityId: id,
    sensitivity: 'finance',
    metadata: { pair: `${input.fromCurrency}/${input.toCurrency}`, effectiveDate: input.effectiveDate, rate: input.rate, source: input.source, via: opts.source ?? 'ui' },
  });
  await emit(ctx, { type: 'fx_rate.created', entityType: 'fx_rate', entityId: id, revision: 1 });
  return id;
};

/** Unused rates can be corrected; a rate used by a posted record is frozen (T128). */
export const updateFxRate = async (ctx: CommandContext, id: string, input: { rate?: string; source?: string }) => {
  requirePermission(ctx, 'finance.post');
  const r = await lockById(ctx, fxRates, id, 'FX rate');
  assertVersion(ctx, r);
  if (r.firstUsedAt)
    throw new AppError('INVALID_STATE', 'This rate was used by posted records and is frozen. Enter a new rate instead; historical base amounts never change.', {
      details: { reason: 'rate_used', firstUsedAt: r.firstUsedAt.toISOString() },
    });
  if (input.rate) rateErrors(r.fromCurrency, r.toCurrency, input.rate);
  const [row] = await ctx.tx
    .update(fxRates)
    .set({ ...(input.rate ? { rate: input.rate.trim() } : {}), ...(input.source ? { source: input.source.trim() } : {}), ...touch(ctx, fxRates) })
    .where(eq(fxRates.id, id))
    .returning();
  await audit(ctx, { action: 'fx_rate.updated', entityType: 'fx_rate', entityId: id, sensitivity: 'finance', diff: diffFields(r, row!, ['rate', 'source']) });
  await emit(ctx, { type: 'fx_rate.updated', entityType: 'fx_rate', entityId: id, revision: row!.rowVersion });
  return id;
};
