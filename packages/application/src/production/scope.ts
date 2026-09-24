import { and, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { listFilter, type ObjectScope } from '@castlane/authorization';
import { contentItems, projects, publications, type DbOrTx } from '@castlane/database';
import { AppError, forbidden, notFound } from '@castlane/domain';
import { allowed, filterToSql } from '../core/access';
import { dbOf, type CommandContext, type QueryContext } from '../core/context';

export type ContentRow = typeof contentItems.$inferSelect;
export type ContentScopeFields = Pick<ContentRow, 'id' | 'projectId' | 'accountId' | 'ownerMembershipId' | 'reviewerMembershipId' | 'createdBy'>;

/**
 * Object scope of a content item: its project (and planned account), the owner and reviewer
 * (assigned-object roles) and its author (own records). The same shape is used by the tasks and
 * references modules when they check content links.
 */
export const contentScope = (c: ContentScopeFields): ObjectScope => ({
  objectType: 'content_item',
  objectId: c.id,
  projectId: c.projectId,
  accountId: c.accountId,
  assignedMembershipIds: [c.ownerMembershipId, c.reviewerMembershipId],
  ownerMembershipId: c.ownerMembershipId,
  createdByUserId: c.createdBy,
});

const accountsOfPlacements = async (db: DbOrTx, workspaceId: string, contentId: string) => {
  const rows = await db
    .selectDistinct({ accountId: publications.accountId })
    .from(publications)
    .where(and(eq(publications.workspaceId, workspaceId), eq(publications.contentItemId, contentId)));
  return rows.map((r) => r.accountId);
};

/**
 * Can the actor use `permission` on this content? Account-scoped members (e.g. publishers) also
 * reach content through its placements on their accounts (approved files for publishing).
 */
export const canOnContent = async (ctx: QueryContext | CommandContext, permission: string, c: ContentScopeFields): Promise<boolean> => {
  if (allowed(ctx, permission, contentScope(c))) return true;
  const f = listFilter(ctx.actor.access, permission);
  if (f.kind !== 'scoped' || f.accountIds.length === 0) return false;
  const accounts = await accountsOfPlacements(dbOf(ctx), ctx.actor.workspaceId, c.id);
  return accounts.some((a) => allowed(ctx, permission, { ...contentScope(c), accountId: a, projectId: null }));
};

export const canReadContent = (ctx: QueryContext | CommandContext, c: ContentScopeFields) => canOnContent(ctx, 'content.read', c);

/** 404 when the content is out of the actor's read scope (existence is never revealed). */
export const authorizeContentRead = async (ctx: QueryContext | CommandContext, c: ContentScopeFields) => {
  if (!(await canReadContent(ctx, c))) throw notFound('Content');
};

/** 404 when unreadable, 403 when readable but the action is not allowed. */
export const authorizeContentAction = async (ctx: QueryContext | CommandContext, c: ContentScopeFields, action: string) => {
  if (allowed(ctx, action, contentScope(c))) return;
  if (await canReadContent(ctx, c)) throw forbidden();
  throw notFound('Content');
};

/**
 * SQL visibility of content for a permission (applied before pagination and aggregation):
 * project / account / assigned-object / own-record scopes plus placements on readable accounts.
 */
export const contentVisibility = (ctx: QueryContext, permission = 'content.read'): SQL | undefined => {
  const f = listFilter(ctx.actor.access, permission);
  const base = filterToSql(f, {
    projectId: contentItems.projectId,
    accountId: contentItems.accountId,
    assigned: [contentItems.ownerMembershipId, contentItems.reviewerMembershipId],
    ownerMembership: contentItems.ownerMembershipId,
    createdByUser: contentItems.createdBy,
  });
  if (f.kind === 'scoped' && f.accountIds.length)
    return or(
      base,
      sql`EXISTS (SELECT 1 FROM publications p WHERE p.workspace_id = ${contentItems.workspaceId} AND p.content_item_id = ${contentItems.id} AND p.account_id IN (${sql.join(
        f.accountIds.map((a) => sql`${a}::uuid`),
        sql`, `,
      )}))`,
    );
  return base;
};

export const loadContent = async (ctx: QueryContext | CommandContext, id: string, opts: { includeTrashed?: boolean } = {}): Promise<ContentRow> => {
  const [c] = await dbOf(ctx)
    .select()
    .from(contentItems)
    .where(and(eq(contentItems.workspaceId, ctx.actor.workspaceId), eq(contentItems.id, id)))
    .limit(1);
  if (!c || (c.deletedAt && !opts.includeTrashed)) throw notFound('Content');
  return c;
};

export const lockContent = async (ctx: CommandContext, id: string, opts: { includeTrashed?: boolean } = {}): Promise<ContentRow> => {
  const [c] = await ctx.tx
    .select()
    .from(contentItems)
    .where(and(eq(contentItems.workspaceId, ctx.actor.workspaceId), eq(contentItems.id, id)))
    .for('update')
    .limit(1);
  if (!c || (c.deletedAt && !opts.includeTrashed)) throw notFound('Content');
  return c;
};

/** Load a readable content item or 404. */
export const readableContent = async (ctx: QueryContext | CommandContext, id: string) => {
  const c = await loadContent(ctx, id);
  await authorizeContentRead(ctx, c);
  return c;
};

export const loadProjectOf = async (ctx: QueryContext | CommandContext, projectId: string) => {
  const [p] = await dbOf(ctx).select().from(projects).where(and(eq(projects.workspaceId, ctx.actor.workspaceId), eq(projects.id, projectId)));
  if (!p) throw notFound('Project');
  return p;
};

export const assertContentWritable = (c: ContentRow) => {
  if (c.archivedAt || c.stage === 'archived') throw new AppError('INVALID_STATE', 'Archived content is read-only. Restore it first.');
};

export const fieldError = (field: string, code: string, message: string) => new AppError('VALIDATION_FAILED', message, { fieldErrors: [{ field, code, message }] });

/** Content items readable by the actor among `ids` (for links shown on other records). */
export const readableContentIds = async (ctx: QueryContext | CommandContext, ids: string[]) => {
  if (!ids.length) return new Set<string>();
  const rows = await dbOf(ctx)
    .select({ id: contentItems.id })
    .from(contentItems)
    .where(and(eq(contentItems.workspaceId, ctx.actor.workspaceId), inArray(contentItems.id, ids), isNull(contentItems.deletedAt), contentVisibility(ctx)));
  return new Set(rows.map((r) => r.id));
};
