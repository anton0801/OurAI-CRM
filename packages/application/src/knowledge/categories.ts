import { and, asc, count, eq, isNull, ne, sql } from 'drizzle-orm';
import { articleCategories, articles } from '@castlane/database';
import { AppError, forbidden, newId, normalizeKey, notFound } from '@castlane/domain';
import { allowed, requirePermission } from '../core/access';
import { audit, diffFields } from '../core/audit';
import { dbOf, type CommandContext, type QueryContext } from '../core/context';
import { emit } from '../core/events';
import { assertVersion, lockById, stamp, touch } from '../core/rows';
import { articleVisibility } from './access';

type CategoryRow = typeof articleCategories.$inferSelect;

/** Categories are one workspace-wide taxonomy: only workspace-wide knowledge editors manage them. */
const requireCategoryManager = (ctx: QueryContext) => {
  requirePermission(ctx, 'knowledge.write');
  if (!allowed(ctx, 'knowledge.write')) throw forbidden('Only workspace-wide knowledge editors can manage categories.');
};

const toView = (c: CategoryRow, n: number) => ({
  id: c.id,
  name: c.name,
  description: c.description,
  sortOrder: c.sortOrder,
  articleCount: n,
  archivedAt: c.archivedAt?.toISOString() ?? null,
  rowVersion: c.rowVersion,
});

const countsFor = async (ctx: QueryContext) => {
  const rows = await dbOf(ctx)
    .select({ categoryId: articles.categoryId, n: count() })
    .from(articles)
    .where(and(eq(articles.workspaceId, ctx.actor.workspaceId), ne(articles.status, 'archived'), articleVisibility(ctx)))
    .groupBy(articles.categoryId);
  return new Map(rows.map((r) => [r.categoryId, Number(r.n)]));
};

export const listCategories = async (ctx: QueryContext, input: { includeArchived?: boolean }) => {
  requirePermission(ctx, 'knowledge.read');
  const rows = await dbOf(ctx)
    .select()
    .from(articleCategories)
    .where(and(eq(articleCategories.workspaceId, ctx.actor.workspaceId), input.includeArchived ? undefined : isNull(articleCategories.archivedAt)))
    .orderBy(asc(articleCategories.sortOrder), asc(articleCategories.nameKey));
  const counts = await countsFor(ctx);
  return rows.map((c) => toView(c, counts.get(c.id) ?? 0));
};

export const getCategoryView = async (ctx: QueryContext, id: string) => {
  const [c] = await dbOf(ctx).select().from(articleCategories).where(and(eq(articleCategories.workspaceId, ctx.actor.workspaceId), eq(articleCategories.id, id)));
  if (!c) throw notFound('Category');
  return toView(c, (await countsFor(ctx)).get(c.id) ?? 0);
};

const duplicate = () =>
  new AppError('VALIDATION_FAILED', 'A category with this name already exists.', { fieldErrors: [{ field: 'name', code: 'DUPLICATE', message: 'A category with this name already exists.' }] });

const nameTaken = async (ctx: CommandContext, nameKey: string, exceptId?: string) => {
  const [d] = await ctx.tx
    .select({ id: articleCategories.id })
    .from(articleCategories)
    .where(
      and(
        eq(articleCategories.workspaceId, ctx.actor.workspaceId),
        eq(articleCategories.nameKey, nameKey),
        isNull(articleCategories.archivedAt),
        exceptId ? sql`${articleCategories.id} <> ${exceptId}` : undefined,
      ),
    );
  return !!d;
};

export const createCategory = async (ctx: CommandContext, input: { name: string; description?: string | null; sortOrder?: number }) => {
  requireCategoryManager(ctx);
  const name = input.name.trim();
  const nameKey = normalizeKey(name);
  if (await nameTaken(ctx, nameKey)) throw duplicate();
  const id = newId();
  const [row] = await ctx.tx
    .insert(articleCategories)
    .values({ ...stamp(ctx), id, name, nameKey, description: input.description?.trim() || null, sortOrder: input.sortOrder ?? 0 })
    .returning();
  await audit(ctx, { action: 'article_category.created', entityType: 'article_category', entityId: id, diff: diffFields(null, row!, ['name', 'description', 'sortOrder']) });
  await emit(ctx, { type: 'article_category.created', entityType: 'article_category', entityId: id, revision: 1 });
  return id;
};

export const updateCategory = async (ctx: CommandContext, id: string, input: { name?: string; description?: string | null; sortOrder?: number }) => {
  requireCategoryManager(ctx);
  const c = await lockById(ctx, articleCategories, id, 'Category');
  assertVersion(ctx, c);
  const patch: Partial<CategoryRow> = {};
  if (input.name !== undefined) {
    patch.name = input.name.trim();
    patch.nameKey = normalizeKey(patch.name);
    if (patch.nameKey !== c.nameKey && !c.archivedAt && (await nameTaken(ctx, patch.nameKey, id))) throw duplicate();
  }
  if (input.description !== undefined) patch.description = input.description?.trim() || null;
  if (input.sortOrder !== undefined) patch.sortOrder = input.sortOrder;
  const [row] = await ctx.tx.update(articleCategories).set({ ...patch, ...touch(ctx, articleCategories) }).where(eq(articleCategories.id, id)).returning();
  await audit(ctx, { action: 'article_category.updated', entityType: 'article_category', entityId: id, diff: diffFields(c, row!, ['name', 'description', 'sortOrder']) });
  await emit(ctx, { type: 'article_category.updated', entityType: 'article_category', entityId: id, revision: row!.rowVersion });
  return id;
};

/** Archive hides the category from pickers; its articles keep it (shown as archived). */
export const archiveCategory = async (ctx: CommandContext, id: string, reason?: string) => {
  requireCategoryManager(ctx);
  const c = await lockById(ctx, articleCategories, id, 'Category');
  assertVersion(ctx, c);
  if (c.archivedAt) return id;
  const [row] = await ctx.tx
    .update(articleCategories)
    .set({ archivedAt: ctx.app.clock.now(), archivedBy: ctx.actor.userId, archiveReason: reason ?? null, ...touch(ctx, articleCategories) })
    .where(eq(articleCategories.id, id))
    .returning();
  await audit(ctx, { action: 'article_category.archived', entityType: 'article_category', entityId: id, reason });
  await emit(ctx, { type: 'article_category.archived', entityType: 'article_category', entityId: id, revision: row!.rowVersion });
  return id;
};

export const restoreCategory = async (ctx: CommandContext, id: string) => {
  requireCategoryManager(ctx);
  const c = await lockById(ctx, articleCategories, id, 'Category');
  assertVersion(ctx, c);
  if (!c.archivedAt) throw new AppError('INVALID_STATE', 'This category is not archived.');
  if (await nameTaken(ctx, c.nameKey, id)) throw new AppError('DUPLICATE', 'An active category with the same name exists. Rename one of them first.');
  const [row] = await ctx.tx.update(articleCategories).set({ archivedAt: null, archivedBy: null, archiveReason: null, ...touch(ctx, articleCategories) }).where(eq(articleCategories.id, id)).returning();
  await audit(ctx, { action: 'article_category.restored', entityType: 'article_category', entityId: id });
  await emit(ctx, { type: 'article_category.restored', entityType: 'article_category', entityId: id, revision: row!.rowVersion });
  return id;
};

/** A category an article may use (exists in the workspace and is active). */
export const assertActiveCategory = async (ctx: CommandContext, categoryId: string) => {
  const [c] = await ctx.tx.select().from(articleCategories).where(and(eq(articleCategories.workspaceId, ctx.actor.workspaceId), eq(articleCategories.id, categoryId)));
  if (!c || c.archivedAt)
    throw new AppError('VALIDATION_FAILED', 'Choose an active category.', { fieldErrors: [{ field: 'categoryId', code: 'INVALID', message: 'Choose an active category.' }] });
  return c;
};
