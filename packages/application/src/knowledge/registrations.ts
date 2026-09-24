import { and, asc, eq, ilike, inArray, isNull, ne, sql } from 'drizzle-orm';
import { articleCategories, articles, articleVersions, readingAssignments } from '@castlane/database';
import { AppError } from '@castlane/domain';
import { requirePermission, whereAll } from '../core/access';
import { defineArchiveHandler } from '../core/archive-registry';
import { audit } from '../core/audit';
import { dbOf } from '../core/context';
import { emit } from '../core/events';
import { defineLookup, likePattern } from '../core/lookup-registry';
import { isActiveMember } from '../core/members';
import { defineResponsibilityProvider } from '../core/responsibility-registry';
import { touch } from '../core/rows';
import { defineLinkAccess } from '../media/link-access';
import { articleVisibility, canSeeArticle } from './access';
import { archiveArticle, articleArchivePreview, articleObjectScope, indexArticle, restoreArticle } from './articles';

// ——— Pickers ———

defineLookup({
  type: 'article',
  async search(ctx, input) {
    requirePermission(ctx, 'knowledge.read');
    const rows = await dbOf(ctx)
      .select({ id: articles.id, title: articles.title, status: articles.status, scopeType: articles.scopeType, scopeId: articles.scopeId, category: articleCategories.name })
      .from(articles)
      .innerJoin(articleCategories, eq(articleCategories.id, articles.categoryId))
      .where(
        whereAll(
          eq(articles.workspaceId, ctx.actor.workspaceId),
          articleVisibility(ctx),
          input.ids?.length ? inArray(articles.id, input.ids) : undefined,
          !input.ids?.length && !input.includeArchived ? ne(articles.status, 'archived') : undefined,
          input.status?.length ? inArray(articles.status, input.status as ('draft' | 'published' | 'archived')[]) : undefined,
          input.projectId ? sql`(${articles.scopeType} = 'workspace' OR (${articles.scopeType} = 'project' AND ${articles.scopeId} = ${input.projectId}))` : undefined,
          input.parentId ? eq(articles.categoryId, input.parentId) : undefined,
          input.q ? ilike(articles.title, likePattern(input.q)) : undefined,
        ),
      )
      .orderBy(asc(articles.title))
      .limit(input.ids?.length ? Math.max(input.ids.length, input.limit) : input.limit);
    return rows.map((r) => ({
      id: r.id,
      label: r.title,
      sublabel: r.category,
      status: r.status,
      projectId: r.scopeType === 'project' ? r.scopeId : null,
      archived: r.status === 'archived',
    }));
  },
});

defineLookup({
  type: 'article_category',
  async search(ctx, input) {
    requirePermission(ctx, 'knowledge.read');
    const rows = await dbOf(ctx)
      .select()
      .from(articleCategories)
      .where(
        whereAll(
          eq(articleCategories.workspaceId, ctx.actor.workspaceId),
          input.ids?.length ? inArray(articleCategories.id, input.ids) : undefined,
          !input.ids?.length && !input.includeArchived ? isNull(articleCategories.archivedAt) : undefined,
          input.q ? ilike(articleCategories.name, likePattern(input.q)) : undefined,
        ),
      )
      .orderBy(asc(articleCategories.sortOrder), asc(articleCategories.nameKey))
      .limit(input.ids?.length ? Math.max(input.ids.length, input.limit) : input.limit);
    return rows.map((r) => ({ id: r.id, label: r.name, sublabel: r.description, status: null, projectId: null, archived: !!r.archivedAt }));
  },
});

// ——— Attachments and embedded files authorise through the article's audience ———

defineLinkAccess('article', {
  permission: 'knowledge.read',
  scope: async (ctx, id) => {
    const [a] = await dbOf(ctx).select().from(articles).where(and(eq(articles.workspaceId, ctx.actor.workspaceId), eq(articles.id, id)));
    return a ? { ...articleObjectScope(a), label: a.title, href: `/w/${a.workspaceId}/knowledge/${a.id}` } : null;
  },
  readable: async (ctx, id) => {
    const [a] = await dbOf(ctx).select().from(articles).where(and(eq(articles.workspaceId, ctx.actor.workspaceId), eq(articles.id, id)));
    return !!a && canSeeArticle(ctx.actor.access, a);
  },
});

// ——— Archive screen ———

defineArchiveHandler({
  entityType: 'article',
  label: 'Knowledge article',
  preview: articleArchivePreview,
  archive: async (ctx, id, input) => {
    await archiveArticle(ctx, id, { reason: input.reason }, { skipVersion: true });
  },
  restorePreview: async (ctx, id) => {
    const p = await articleArchivePreview(ctx, id);
    return { title: p.title, items: [] };
  },
  restore: async (ctx, id) => {
    await restoreArticle(ctx, id, { skipVersion: true });
  },
});

// ——— Member deactivation (F12): article ownership and open reading requests ———

defineResponsibilityProvider({
  kind: 'knowledge.article_owner',
  label: 'Knowledge articles owned',
  unassignedBehaviour: 'Every article needs an owner: choose a successor.',
  async list(ctx, membershipId) {
    const rows = await dbOf(ctx)
      .select({ id: articles.id, title: articles.title, scopeType: articles.scopeType, scopeId: articles.scopeId })
      .from(articles)
      .where(and(eq(articles.workspaceId, ctx.actor.workspaceId), eq(articles.ownerMembershipId, membershipId), ne(articles.status, 'archived')))
      .orderBy(asc(articles.title));
    return rows.map((r) => ({
      kind: 'knowledge.article_owner',
      entityType: 'article',
      entityId: r.id,
      title: r.title,
      projectId: r.scopeType === 'project' ? r.scopeId : null,
      dueAt: null,
      requiresSuccessor: true,
    }));
  },
  async transfer(ctx, fromMembershipId, resolutions) {
    for (const r of resolutions) {
      if (!r.successorMembershipId) throw new AppError('VALIDATION_FAILED', 'Choose a new owner for every knowledge article.');
      if (!(await isActiveMember(ctx.tx, ctx.actor.workspaceId, r.successorMembershipId))) throw new AppError('VALIDATION_FAILED', 'The new article owner must be an active member.');
      const [row] = await ctx.tx
        .update(articles)
        .set({ ownerMembershipId: r.successorMembershipId, ...touch(ctx, articles) })
        .where(and(eq(articles.workspaceId, ctx.actor.workspaceId), eq(articles.id, r.entityId), eq(articles.ownerMembershipId, fromMembershipId)))
        .returning();
      if (!row) continue;
      await audit(ctx, { action: 'article.owner_transferred', entityType: 'article', entityId: row.id, diff: { ownerMembershipId: { from: fromMembershipId, to: r.successorMembershipId } } });
      await emit(ctx, { type: 'article.updated', entityType: 'article', entityId: row.id, revision: row.rowVersion });
      const [pub] = row.publishedVersionId
        ? await ctx.tx.select({ title: articleVersions.title, bodyText: articleVersions.bodyText }).from(articleVersions).where(eq(articleVersions.id, row.publishedVersionId))
        : [];
      await indexArticle(ctx.tx, row, pub ?? null, ctx.app.clock.now());
    }
  },
});

defineResponsibilityProvider({
  kind: 'knowledge.reading',
  label: 'Open required reading',
  unassignedBehaviour: 'Open reading requests are withdrawn; acknowledgements already given stay in the history.',
  async list(ctx, membershipId) {
    const rows = await dbOf(ctx)
      .select({ id: readingAssignments.id, dueAt: readingAssignments.dueAt, title: articles.title, scopeType: articles.scopeType, scopeId: articles.scopeId })
      .from(readingAssignments)
      .innerJoin(articles, eq(articles.id, readingAssignments.articleId))
      .where(and(eq(readingAssignments.workspaceId, ctx.actor.workspaceId), eq(readingAssignments.membershipId, membershipId), eq(readingAssignments.status, 'open')));
    return rows.map((r) => ({
      kind: 'knowledge.reading',
      entityType: 'reading_assignment',
      entityId: r.id,
      title: `Read: ${r.title}`,
      projectId: r.scopeType === 'project' ? r.scopeId : null,
      dueAt: r.dueAt?.toISOString() ?? null,
      requiresSuccessor: false,
    }));
  },
  async transfer(ctx, fromMembershipId, resolutions) {
    const ids = resolutions.map((r) => r.entityId);
    if (!ids.length) return;
    await ctx.tx
      .update(readingAssignments)
      .set({ status: 'cancelled', closedAt: ctx.app.clock.now(), closeReason: 'Member deactivated', ...touch(ctx, readingAssignments) })
      .where(and(eq(readingAssignments.workspaceId, ctx.actor.workspaceId), eq(readingAssignments.membershipId, fromMembershipId), eq(readingAssignments.status, 'open'), inArray(readingAssignments.id, ids)));
  },
});
