import { and, asc, count, desc, eq, gt, ilike, inArray, isNull, lte, ne, or, sql } from 'drizzle-orm';
import {
  assetLinks,
  comments,
  contentCharacters,
  contentFlagIntervals,
  contentItems,
  contentStageEvents,
  contentVersions,
  projects,
  publications,
  referenceLinks,
  reviews,
  socialAccounts,
  tasks,
} from '@castlane/database';
import { AppError, CONTENT_FORMATS, CONTENT_STAGES, notFound } from '@castlane/domain';
import { defineSavedViewModule } from '../platform/saved-views';
import { allowed, requirePermission } from '../core/access';
import { defineArchiveHandler, tableArchiveList } from '../core/archive-registry';
import { audit } from '../core/audit';
import { dbOf, type CommandContext, type QueryContext } from '../core/context';
import { emit } from '../core/events';
import { defineExportDataset } from '../core/export-registry';
import { defineLookup, likePattern } from '../core/lookup-registry';
import { loadMemberRefs } from '../core/members';
import { notify } from '../core/notify';
import { defineResponsibilityProvider } from '../core/responsibility-registry';
import { touch } from '../core/rows';
import { defineLinkAccess } from '../media/link-access';
import { defineCommentParent, type CommentCreateInput, type CommentParentScope } from '../work/comments';
import { memberCan } from '../work/shared';
import { indexContent, recordStageEvent } from './content';
import { loadVersionFiles } from './files';
import { annotationErrors, mediaKindOf, stageLabel, type ContentStage } from './rules';
import { authorizeContentAction, canReadContent, contentScope, contentVisibility, lockContent, type ContentRow } from './scope';
import { openContentTaskIds } from './templates';

// ——— Saved views of the pipeline (S22 personal/shared views) ———

defineSavedViewModule('content', {
  permission: 'content.read',
  fields: {
    q: { kind: 'text' },
    projectId: { kind: 'id' },
    format: { kind: 'enum', values: CONTENT_FORMATS },
    stage: { kind: 'enum', values: CONTENT_STAGES },
    ownerMembershipId: { kind: 'id' },
    reviewerMembershipId: { kind: 'id' },
    mine: { kind: 'boolean' },
    overdue: { kind: 'boolean' },
    blocked: { kind: 'boolean' },
    archived: { kind: 'boolean' },
  },
  sortKeys: ['updatedAt', 'createdAt', 'dueAt', 'title', 'stage'],
});

// ——— Picker ———

defineLookup({
  type: 'content_item',
  async search(ctx, input) {
    requirePermission(ctx, 'content.read');
    const rows = await dbOf(ctx)
      .select({ c: contentItems, projectName: projects.name })
      .from(contentItems)
      .innerJoin(projects, eq(projects.id, contentItems.projectId))
      .where(
        and(
          eq(contentItems.workspaceId, ctx.actor.workspaceId),
          isNull(contentItems.deletedAt),
          contentVisibility(ctx),
          input.ids?.length ? inArray(contentItems.id, input.ids) : undefined,
          !input.ids?.length && !input.includeArchived ? isNull(contentItems.archivedAt) : undefined,
          input.status?.length ? inArray(contentItems.stage, input.status as ContentStage[]) : undefined,
          input.projectId ? eq(contentItems.projectId, input.projectId) : undefined,
          input.accountId
            ? or(eq(contentItems.accountId, input.accountId), sql`EXISTS (SELECT 1 FROM publications p WHERE p.content_item_id = ${contentItems.id} AND p.account_id = ${input.accountId}::uuid)`, and(isNull(contentItems.accountId), sql`${contentItems.projectId} = (SELECT sa.project_id FROM social_accounts sa WHERE sa.id = ${input.accountId}::uuid)`))
            : undefined,
          input.parentId ? eq(contentItems.episodeId, input.parentId) : undefined,
          input.q ? ilike(contentItems.title, likePattern(input.q)) : undefined,
        ),
      )
      .orderBy(asc(contentItems.title))
      .limit(input.ids?.length ? Math.max(input.ids.length, input.limit) : input.limit);
    return rows.map(({ c, projectName }) => ({
      id: c.id,
      label: c.title,
      sublabel: `${projectName} · ${stageLabel(c.stage)}`,
      status: c.stage,
      projectId: c.projectId,
      archived: !!c.archivedAt,
    }));
  },
});

// ——— File access through content (brief attachments and version files) ———

const contentById = async (ctx: QueryContext | CommandContext, id: string) => {
  const [c] = await dbOf(ctx).select().from(contentItems).where(and(eq(contentItems.workspaceId, ctx.actor.workspaceId), eq(contentItems.id, id)));
  return c && !c.deletedAt ? c : null;
};

const versionWithContent = async (ctx: QueryContext | CommandContext, versionId: string) => {
  const [v] = await dbOf(ctx).select().from(contentVersions).where(and(eq(contentVersions.workspaceId, ctx.actor.workspaceId), eq(contentVersions.id, versionId)));
  if (!v) return null;
  const c = await contentById(ctx, v.contentItemId);
  return c ? { v, c } : null;
};

defineLinkAccess('content_item', {
  permission: 'content.read',
  scope: async (ctx, id) => {
    const c = await contentById(ctx, id);
    return c ? { ...contentScope(c), label: c.title, href: `/w/${c.workspaceId}/content/${c.id}` } : null;
  },
  readable: async (ctx, id) => {
    const c = await contentById(ctx, id);
    return !!c && (await canReadContent(ctx, c));
  },
});

defineLinkAccess('content_version', {
  permission: 'content.read',
  scope: async (ctx, id) => {
    const x = await versionWithContent(ctx, id);
    return x ? { ...contentScope(x.c), label: `${x.c.title} v${x.v.versionNo}`, href: `/w/${x.c.workspaceId}/content/${x.c.id}?tab=versions&version=${x.v.id}` } : null;
  },
  readable: async (ctx, id) => {
    const x = await versionWithContent(ctx, id);
    return !!x && (await canReadContent(ctx, x.c));
  },
});

// ——— Comments: content discussion, version review comments (annotations), review threads ———

type ReviewScope = CommentParentScope & { resolverMembershipIds: string[] };

defineCommentParent('content_item', {
  readPermission: 'content.read',
  commentPermission: 'content.read',
  moderatePermission: 'content.edit',
  scope: async (ctx, id) => {
    const c = await contentById(ctx, id);
    return c ? { ...contentScope(c), title: c.title, projectId: c.projectId, watcherMembershipIds: [c.ownerMembershipId, c.reviewerMembershipId] } : null;
  },
});

/** Validate an annotation against the exact version it belongs to (T045 timecodes, T046 points). */
const validateAnnotation = async (ctx: CommandContext, versionId: string, input: CommentCreateInput) => {
  if (input.targetVersionId && input.targetVersionId !== versionId)
    throw new AppError('VALIDATION_FAILED', 'Comments belong to the version they were written on.', { fieldErrors: [{ field: 'targetVersionId', code: 'OTHER_VERSION', message: 'Comments belong to the version they were written on.' }] });
  input.targetVersionId = versionId;
  let target: { kind: string; durationMs: number | null } | null = null;
  if (input.assetVersionId) {
    const files = await loadVersionFiles(ctx.tx, ctx.actor.workspaceId, [versionId]);
    const f = files.find((x) => x.assetVersionId === input.assetVersionId);
    if (!f) throw new AppError('VALIDATION_FAILED', 'Choose a file of this version.', { fieldErrors: [{ field: 'assetVersionId', code: 'NOT_IN_VERSION', message: 'Choose a file of this version.' }] });
    target = { kind: mediaKindOf(f.mime), durationMs: f.durationMs };
  }
  const errs = annotationErrors(target, { timecodeMs: input.timecodeMs, pointX: input.pointX, pointY: input.pointY });
  if (errs.length) throw new AppError('VALIDATION_FAILED', errs[0]!.message, { fieldErrors: errs });
};

const versionCommentScope = (c: ContentRow, v: typeof contentVersions.$inferSelect): ReviewScope => ({
  ...contentScope(c),
  title: `${c.title} v${v.versionNo}`,
  projectId: c.projectId,
  watcherMembershipIds: [c.ownerMembershipId, c.reviewerMembershipId, v.submittedBy],
  resolverMembershipIds: [c.ownerMembershipId, v.submittedBy].filter((x): x is string => !!x),
});

/** Resolve = the assignee claims it fixed (author, owner, submitter) or a reviewer; reopen = reviewers or the author. */
const reviewResolveRules = {
  canResolve: (ctx: QueryContext, comment: { authorMembershipId: string }, scope: CommentParentScope) =>
    comment.authorMembershipId === ctx.actor.membershipId || (scope as ReviewScope).resolverMembershipIds.includes(ctx.actor.membershipId ?? '') || allowed(ctx, 'content.approve', scope),
  canReopen: (ctx: QueryContext, comment: { authorMembershipId: string }, scope: CommentParentScope) =>
    comment.authorMembershipId === ctx.actor.membershipId || allowed(ctx, 'content.approve', scope),
};

defineCommentParent('content_version', {
  readPermission: 'content.read',
  commentPermission: 'content.read',
  moderatePermission: 'content.approve',
  allowSeverity: true,
  allowAnnotations: true,
  scope: async (ctx, id) => {
    const x = await versionWithContent(ctx, id);
    return x ? versionCommentScope(x.c, x.v) : null;
  },
  validate: (ctx, parentId, input) => validateAnnotation(ctx, parentId, input),
  ...reviewResolveRules,
});

defineCommentParent('review', {
  readPermission: 'content.read',
  commentPermission: 'content.read',
  moderatePermission: 'content.approve',
  allowSeverity: true,
  allowAnnotations: true,
  scope: async (ctx, id) => {
    const [r] = await dbOf(ctx).select().from(reviews).where(and(eq(reviews.workspaceId, ctx.actor.workspaceId), eq(reviews.id, id)));
    if (!r || r.targetType !== 'content_version') return null;
    const x = await versionWithContent(ctx, r.targetId);
    return x ? versionCommentScope(x.c, x.v) : null;
  },
  validate: async (ctx, parentId, input) => {
    const [r] = await ctx.tx.select().from(reviews).where(eq(reviews.id, parentId));
    if (!r) throw notFound('Review');
    await validateAnnotation(ctx, r.targetId, input);
  },
  ...reviewResolveRules,
});

// ——— Archive / trash ———

const obligations = async (ctx: QueryContext | CommandContext, c: ContentRow) => {
  const db = dbOf(ctx);
  const ws = ctx.actor.workspaceId;
  const [[pending], [scheduled], openTasks, [draft]] = [
    await db.select({ n: count() }).from(reviews).where(and(eq(reviews.workspaceId, ws), eq(reviews.subjectId, c.id), eq(reviews.targetType, 'content_version'), eq(reviews.status, 'pending'))),
    await db.select({ n: count() }).from(publications).where(and(eq(publications.workspaceId, ws), eq(publications.contentItemId, c.id), eq(publications.status, 'scheduled'), isNull(publications.deletedAt))),
    await openContentTaskIds(ctx, c.id),
    await db.select({ n: count() }).from(contentVersions).where(and(eq(contentVersions.contentItemId, c.id), isNull(contentVersions.submittedAt))),
  ];
  return [
    { kind: 'scheduled_publications', label: 'Scheduled placements', count: Number(scheduled?.n ?? 0), blocking: true, resolution: 'Cancel or move the scheduled placements first.' },
    { kind: 'pending_reviews', label: 'Pending reviews (cancelled when archived)', count: Number(pending?.n ?? 0), blocking: false, resolution: 'The review is cancelled; its history stays.' },
    { kind: 'open_tasks', label: 'Open tasks (kept)', count: openTasks.length, blocking: false, resolution: 'Tasks keep their status; cancel them separately if they are no longer needed.' },
    { kind: 'draft_version', label: 'Draft version (kept)', count: Number(draft?.n ?? 0), blocking: false },
  ].filter((i) => i.count > 0);
};

const trashDependents = async (ctx: QueryContext | CommandContext, c: ContentRow) => {
  const db = dbOf(ctx);
  const [[v], [t], [p], [cm]] = [
    await db.select({ n: count() }).from(contentVersions).where(eq(contentVersions.contentItemId, c.id)),
    await db.select({ n: count() }).from(tasks).where(and(eq(tasks.contentItemId, c.id), isNull(tasks.deletedAt))),
    await db.select({ n: count() }).from(publications).where(eq(publications.contentItemId, c.id)),
    await db.select({ n: count() }).from(comments).where(and(eq(comments.parentType, 'content_item'), eq(comments.parentId, c.id), isNull(comments.deletedAt))),
  ];
  return { versions: Number(v?.n ?? 0), tasks: Number(t?.n ?? 0), publications: Number(p?.n ?? 0), comments: Number(cm?.n ?? 0) };
};

const loadForArchive = async (ctx: QueryContext | CommandContext, id: string, includeTrashed = false) => {
  const [c] = await dbOf(ctx).select().from(contentItems).where(and(eq(contentItems.workspaceId, ctx.actor.workspaceId), eq(contentItems.id, id)));
  if (!c || (c.deletedAt && !includeTrashed)) throw notFound('Content');
  return c;
};

defineArchiveHandler({
  entityType: 'content_item',
  label: 'Content',
  async preview(ctx, id) {
    const c = await loadForArchive(ctx, id);
    await authorizeContentAction(ctx, c, 'content.archive');
    return { title: c.title, rowVersion: c.rowVersion, items: c.archivedAt ? [{ kind: 'already_archived', label: 'Already archived', count: 1, blocking: true }] : await obligations(ctx, c) };
  },
  async archive(ctx, id, input) {
    const c = await lockContent(ctx, id);
    await authorizeContentAction(ctx, c, 'content.archive');
    if (c.archivedAt) return;
    if ((await obligations(ctx, c)).some((i) => i.blocking)) throw new AppError('INVALID_STATE', 'Cancel or move the scheduled placements before archiving.');
    const at = ctx.app.clock.now();
    await ctx.tx
      .update(reviews)
      .set({ status: 'cancelled', decidedAt: at, ...touch(ctx, reviews) })
      .where(and(eq(reviews.workspaceId, ctx.actor.workspaceId), eq(reviews.subjectId, c.id), eq(reviews.targetType, 'content_version'), eq(reviews.status, 'pending')));
    const [row] = await ctx.tx
      .update(contentItems)
      .set({ stage: 'archived', archivedAt: at, archivedBy: ctx.actor.userId, archiveReason: input.reason ?? null, ...touch(ctx, contentItems) })
      .where(eq(contentItems.id, c.id))
      .returning();
    await recordStageEvent(ctx, c.id, c.stage, 'archived', input.reason ?? null);
    await audit(ctx, { action: 'content.archived', entityType: 'content_item', entityId: c.id, projectId: c.projectId, reason: input.reason ?? null, diff: { stage: { from: c.stage, to: 'archived' } } });
    await emit(ctx, { type: 'content_item.archived', entityType: 'content_item', entityId: c.id, revision: row!.rowVersion });
    await indexContent(ctx, row!);
  },
  async restorePreview(ctx, id) {
    const c = await loadForArchive(ctx, id);
    await authorizeContentAction(ctx, c, 'content.archive');
    const [p] = await dbOf(ctx).select({ status: projects.status }).from(projects).where(eq(projects.id, c.projectId));
    return { title: c.title, items: p?.status === 'archived' ? [{ kind: 'archived_project', label: 'The project is archived', count: 1, blocking: true, resolution: 'Restore the project first.' }] : [] };
  },
  async restore(ctx, id) {
    const c = await lockContent(ctx, id);
    await authorizeContentAction(ctx, c, 'content.archive');
    if (!c.archivedAt) return;
    const [p] = await ctx.tx.select({ status: projects.status }).from(projects).where(eq(projects.id, c.projectId));
    if (p?.status === 'archived') throw new AppError('INVALID_STATE', 'Restore the project first.');
    const [last] = await ctx.tx
      .select()
      .from(contentStageEvents)
      .where(and(eq(contentStageEvents.contentItemId, c.id), eq(contentStageEvents.toStage, 'archived')))
      .orderBy(desc(contentStageEvents.occurredAt))
      .limit(1);
    // A review cancelled by archiving cannot resume: such content returns to Production.
    const previous = (last?.fromStage ?? 'idea') as ContentStage;
    const back: ContentStage = previous === 'review' ? 'production' : previous === 'archived' ? 'idea' : previous;
    const [row] = await ctx.tx
      .update(contentItems)
      .set({ stage: back, archivedAt: null, archivedBy: null, archiveReason: null, ...touch(ctx, contentItems) })
      .where(eq(contentItems.id, c.id))
      .returning();
    await recordStageEvent(ctx, c.id, 'archived', back, 'Restored from archive');
    await audit(ctx, { action: 'content.restored', entityType: 'content_item', entityId: c.id, projectId: c.projectId, diff: { stage: { from: 'archived', to: back } } });
    await emit(ctx, { type: 'content_item.restored', entityType: 'content_item', entityId: c.id, revision: row!.rowVersion });
    await indexContent(ctx, row!);
  },
  /** Only Idea/Brief drafts without versions, tasks, placements or comments may go to the trash. */
  async trash(ctx, id, reason) {
    const c = await lockContent(ctx, id);
    const scope = contentScope(c);
    if (!(await canReadContent(ctx, c))) throw notFound('Content');
    if (!allowed(ctx, 'content.archive', scope) && c.createdBy !== ctx.actor.userId) throw new AppError('FORBIDDEN', 'Only a lead or the creator can move this draft to the trash.');
    if (c.stage !== 'idea' && c.stage !== 'brief') throw new AppError('INVALID_STATE', 'Only Idea and Brief drafts can be moved to the trash. Archive other content.');
    const d = await trashDependents(ctx, c);
    if (d.versions || d.tasks || d.publications || d.comments) throw new AppError('INVALID_STATE', 'This draft already has versions, tasks, placements or comments. Archive it instead.', { details: d });
    const at = ctx.app.clock.now();
    const [row] = await ctx.tx
      .update(contentItems)
      .set({ deletedAt: at, deletedBy: ctx.actor.userId, purgeAfter: new Date(at.getTime() + 30 * 86_400_000), ...touch(ctx, contentItems) })
      .where(eq(contentItems.id, c.id))
      .returning();
    await audit(ctx, { action: 'content.trashed', entityType: 'content_item', entityId: c.id, projectId: c.projectId, reason });
    await emit(ctx, { type: 'content_item.trashed', entityType: 'content_item', entityId: c.id, revision: row!.rowVersion });
    await indexContent(ctx, row!);
  },
  async untrashPreview(ctx, id) {
    const c = await loadForArchive(ctx, id, true);
    if (!(await canReadContent(ctx, c))) throw notFound('Content');
    const [p] = await dbOf(ctx).select({ status: projects.status }).from(projects).where(eq(projects.id, c.projectId));
    return { title: c.title, items: p?.status === 'archived' ? [{ kind: 'archived_project', label: 'The project is archived', count: 1, blocking: true, resolution: 'Restore the project first.' }] : [] };
  },
  async untrash(ctx, id) {
    const c = await lockContent(ctx, id, { includeTrashed: true });
    if (!(await canReadContent(ctx, c))) throw notFound('Content');
    if (!allowed(ctx, 'content.archive', contentScope(c)) && c.createdBy !== ctx.actor.userId) throw new AppError('FORBIDDEN', 'Only a lead or the creator can restore this draft.');
    if (!c.deletedAt) return;
    const [row] = await ctx.tx.update(contentItems).set({ deletedAt: null, deletedBy: null, purgeAfter: null, ...touch(ctx, contentItems) }).where(eq(contentItems.id, c.id)).returning();
    await audit(ctx, { action: 'content.untrashed', entityType: 'content_item', entityId: c.id, projectId: c.projectId });
    await emit(ctx, { type: 'content_item.restored', entityType: 'content_item', entityId: c.id, revision: row!.rowVersion });
    await indexContent(ctx, row!);
  },
  async purge(ctx, id) {
    const c = await lockContent(ctx, id, { includeTrashed: true });
    if (!c.deletedAt || (c.stage !== 'idea' && c.stage !== 'brief')) throw new AppError('INVALID_STATE', 'Only trashed drafts can be purged.');
    const d = await trashDependents(ctx, c);
    if (d.versions || d.tasks || d.publications) throw new AppError('INVALID_STATE', 'This draft has dependent records and cannot be purged.');
    const idea = await ctx.tx.select({ id: referenceLinks.id }).from(referenceLinks).where(and(eq(referenceLinks.targetType, 'content_item'), eq(referenceLinks.targetId, c.id), eq(referenceLinks.kind, 'idea')));
    if (idea.length) throw new AppError('INVALID_STATE', 'This draft was created from a reference and stays linked to it. It cannot be purged.');
    await ctx.tx.delete(contentCharacters).where(eq(contentCharacters.contentItemId, c.id));
    await ctx.tx.delete(contentStageEvents).where(eq(contentStageEvents.contentItemId, c.id));
    await ctx.tx.delete(contentFlagIntervals).where(eq(contentFlagIntervals.contentItemId, c.id));
    await ctx.tx.delete(referenceLinks).where(and(eq(referenceLinks.targetType, 'content_item'), eq(referenceLinks.targetId, c.id)));
    await ctx.tx.update(assetLinks).set({ removedAt: ctx.app.clock.now() }).where(and(eq(assetLinks.entityType, 'content_item'), eq(assetLinks.entityId, c.id), isNull(assetLinks.removedAt)));
    await ctx.tx.delete(contentItems).where(eq(contentItems.id, c.id));
    await audit(ctx, { action: 'content.purged', entityType: 'content_item', entityId: c.id, projectId: c.projectId });
  },
  list: (ctx, input) =>
    tableArchiveList(ctx, input, {
      table: contentItems,
      title: contentItems.title,
      projectId: contentItems.projectId,
      scope: contentVisibility(ctx),
      archivedWhere: eq(contentItems.stage, 'archived'),
    }),
});

// ——— Responsibilities (F12) ———

const canWorkOn = async (ctx: CommandContext, c: ContentRow, membershipId: string, permission: string) =>
  (await memberCan(ctx.app.db, ctx.actor.workspaceId, membershipId, permission, { ...contentScope(c), assignedMembershipIds: [membershipId], ownerMembershipId: membershipId }, ctx.app.clock.now())).ok;

defineResponsibilityProvider({
  kind: 'content.owner',
  label: 'Content owned',
  unassignedBehaviour: 'The project owner becomes the content owner (or the owner is cleared when they cannot take it).',
  async list(ctx, membershipId) {
    const rows = await dbOf(ctx)
      .select()
      .from(contentItems)
      .where(and(eq(contentItems.workspaceId, ctx.actor.workspaceId), eq(contentItems.ownerMembershipId, membershipId), isNull(contentItems.archivedAt), isNull(contentItems.deletedAt)))
      .orderBy(asc(contentItems.dueAt));
    return rows.map((c) => ({ kind: 'content.owner', entityType: 'content_item', entityId: c.id, title: c.title, projectId: c.projectId, dueAt: c.dueAt?.toISOString() ?? null, requiresSuccessor: false }));
  },
  async transfer(ctx, from, resolutions) {
    for (const r of resolutions) {
      const c = await lockContent(ctx, r.entityId).catch(() => null);
      if (!c || c.ownerMembershipId !== from) continue;
      let next = r.successorMembershipId;
      if (next && !(await canWorkOn(ctx, c, next, 'content.read')))
        throw new AppError('VALIDATION_FAILED', `The successor cannot access “${c.title}”. Choose someone on the project.`, { fieldErrors: [{ field: 'successorMembershipId', code: 'NO_ACCESS', message: `The successor cannot access “${c.title}”.` }] });
      if (!next) {
        const [p] = await ctx.tx.select({ owner: projects.ownerMembershipId }).from(projects).where(eq(projects.id, c.projectId));
        next = p && p.owner !== from && (await canWorkOn(ctx, c, p.owner, 'content.read')) ? p.owner : null;
      }
      const [row] = await ctx.tx.update(contentItems).set({ ownerMembershipId: next, ...touch(ctx, contentItems) }).where(eq(contentItems.id, c.id)).returning();
      await audit(ctx, { action: 'content.owner_transferred', entityType: 'content_item', entityId: c.id, projectId: c.projectId, diff: { ownerMembershipId: { from, to: next } } });
      await emit(ctx, { type: 'content_item.updated', entityType: 'content_item', entityId: c.id, revision: row!.rowVersion });
      await indexContent(ctx, row!);
      if (next)
        await notify(ctx.tx, { workspaceId: c.workspaceId, recipientMembershipIds: [next], eventType: 'content.assigned', eventKey: `content.owner:${c.id}:${next}:v${row!.rowVersion}`, kind: 'assignment', title: `You own “${c.title}”`, entityType: 'content_item', entityId: c.id, projectId: c.projectId, actorMembershipId: ctx.actor.membershipId, at: ctx.app.clock.now() });
    }
  },
});

defineResponsibilityProvider({
  kind: 'content.reviewer',
  label: 'Reviews and content to review',
  unassignedBehaviour: 'Pending reviews become unassigned in the Review Queue (any eligible reviewer can decide); the content reviewer is cleared.',
  async list(ctx, membershipId) {
    const db = dbOf(ctx);
    const pending = await db
      .select({ r: reviews, title: contentItems.title })
      .from(reviews)
      .innerJoin(contentItems, eq(contentItems.id, reviews.subjectId))
      .where(and(eq(reviews.workspaceId, ctx.actor.workspaceId), eq(reviews.targetType, 'content_version'), eq(reviews.status, 'pending'), eq(reviews.reviewerMembershipId, membershipId)));
    const items = await db
      .select()
      .from(contentItems)
      .where(and(eq(contentItems.workspaceId, ctx.actor.workspaceId), eq(contentItems.reviewerMembershipId, membershipId), isNull(contentItems.archivedAt), isNull(contentItems.deletedAt)));
    return [
      ...pending.map(({ r, title }) => ({ kind: 'content.reviewer', entityType: 'review', entityId: r.id, title: `Pending review: ${title}`, projectId: r.projectId, dueAt: r.dueAt?.toISOString() ?? null, requiresSuccessor: true })),
      ...items.map((c) => ({ kind: 'content.reviewer', entityType: 'content_item', entityId: c.id, title: `Reviewer of ${c.title}`, projectId: c.projectId, dueAt: c.dueAt?.toISOString() ?? null, requiresSuccessor: false })),
    ];
  },
  async transfer(ctx, from, resolutions) {
    for (const res of resolutions) {
      const [r] = await ctx.tx.select().from(reviews).where(and(eq(reviews.workspaceId, ctx.actor.workspaceId), eq(reviews.id, res.entityId))).for('update');
      if (r) {
        if (r.reviewerMembershipId !== from || r.status !== 'pending') continue;
        const [c] = await ctx.tx.select().from(contentItems).where(eq(contentItems.id, r.subjectId));
        const next = res.successorMembershipId;
        if (next && (!c || !(await canWorkOn(ctx, c, next, 'content.approve')) || next === r.authorMembershipId))
          throw new AppError('VALIDATION_FAILED', 'The successor must be able to approve this content and must not be its author.', { fieldErrors: [{ field: 'successorMembershipId', code: 'NOT_ELIGIBLE', message: 'The successor cannot review this content.' }] });
        await ctx.tx.update(reviews).set({ reviewerMembershipId: next, ...touch(ctx, reviews) }).where(eq(reviews.id, r.id));
        await audit(ctx, { action: 'review.reviewer_transferred', entityType: 'content_item', entityId: r.subjectId, projectId: r.projectId, metadata: { reviewId: r.id, from, to: next } });
        await emit(ctx, { type: 'review.assigned', entityType: 'review', entityId: r.id });
        if (next && c)
          await notify(ctx.tx, { workspaceId: c.workspaceId, recipientMembershipIds: [next], eventType: 'review.requested', eventKey: `review.requested:${r.id}:${next}`, kind: 'review_request', title: `Review requested: ${c.title}`, entityType: 'review', entityId: r.id, projectId: c.projectId, actorMembershipId: ctx.actor.membershipId, at: ctx.app.clock.now() });
        continue;
      }
      const c = await lockContent(ctx, res.entityId).catch(() => null);
      if (!c || c.reviewerMembershipId !== from) continue;
      const next = res.successorMembershipId && (await canWorkOn(ctx, c, res.successorMembershipId, 'content.approve')) ? res.successorMembershipId : null;
      if (res.successorMembershipId && !next)
        throw new AppError('VALIDATION_FAILED', `The successor cannot approve “${c.title}”.`, { fieldErrors: [{ field: 'successorMembershipId', code: 'NOT_ELIGIBLE', message: `The successor cannot approve “${c.title}”.` }] });
      const [row] = await ctx.tx.update(contentItems).set({ reviewerMembershipId: next, ...touch(ctx, contentItems) }).where(eq(contentItems.id, c.id)).returning();
      await audit(ctx, { action: 'content.reviewer_transferred', entityType: 'content_item', entityId: c.id, projectId: c.projectId, diff: { reviewerMembershipId: { from, to: next } } });
      await emit(ctx, { type: 'content_item.updated', entityType: 'content_item', entityId: c.id, revision: row!.rowVersion });
      await indexContent(ctx, row!);
    }
  },
});

// ——— Export Center dataset ———

const PAGE = 500;

defineExportDataset({
  key: 'content_items',
  label: 'Content',
  permission: 'content.read',
  classification: 'normal',
  columns: [
    { key: 'id', label: 'ID', type: 'id' },
    { key: 'title', label: 'Title', type: 'text', default: true },
    { key: 'project', label: 'Project', type: 'text', default: true },
    { key: 'format', label: 'Format', type: 'text', default: true },
    { key: 'stage', label: 'Stage', type: 'text', default: true },
    { key: 'owner', label: 'Owner', type: 'text', default: true },
    { key: 'reviewer', label: 'Reviewer', type: 'text' },
    { key: 'due_at', label: 'Due At (UTC)', type: 'datetime', default: true },
    { key: 'no_deadline', label: 'No Deadline', type: 'boolean' },
    { key: 'overdue', label: 'Overdue', type: 'boolean' },
    { key: 'language', label: 'Language', type: 'text' },
    { key: 'tags', label: 'Tags', type: 'text' },
    { key: 'account', label: 'Planned Account', type: 'text' },
    { key: 'latest_version', label: 'Latest Version', type: 'integer' },
    { key: 'approved_version', label: 'Approved Version', type: 'integer', default: true },
    { key: 'publication_count', label: 'Publication Count', type: 'integer', default: true },
    { key: 'blocked', label: 'Blocked', type: 'boolean' },
    { key: 'paused', label: 'Paused', type: 'boolean' },
    { key: 'created_at', label: 'Created At (UTC)', type: 'datetime' },
    { key: 'updated_at', label: 'Updated At (UTC)', type: 'datetime' },
    { key: 'archived_at', label: 'Archived At (UTC)', type: 'datetime' },
  ],
  filters: [
    { key: 'projectId', label: 'Project', type: 'reference', lookup: 'project' },
    { key: 'stage', label: 'Stage', type: 'enum', enumValues: ['idea', 'brief', 'ready', 'production', 'review', 'changes_requested', 'approved', 'archived'] },
    { key: 'format', label: 'Format', type: 'enum', enumValues: ['short_video', 'episode', 'trailer', 'image', 'carousel', 'photo_set', 'story', 'audio', 'text_post', 'other'] },
  ],
  async *rows(ctx, { filters, boundAt }) {
    requirePermission(ctx, 'content.read');
    const db = ctx.app.db;
    const now = ctx.app.clock.now();
    let after: { at: Date; id: string } | null = null;
    const stage = typeof filters.stage === 'string' ? [filters.stage] : Array.isArray(filters.stage) ? (filters.stage as string[]) : [];
    const format = typeof filters.format === 'string' ? [filters.format] : Array.isArray(filters.format) ? (filters.format as string[]) : [];
    for (;;) {
      const rows: ContentRow[] = await db
        .select()
        .from(contentItems)
        .where(
          and(
            eq(contentItems.workspaceId, ctx.actor.workspaceId),
            isNull(contentItems.deletedAt),
            contentVisibility(ctx),
            lte(contentItems.createdAt, boundAt),
            filters.includeArchived ? undefined : stage.includes('archived') ? undefined : isNull(contentItems.archivedAt),
            typeof filters.projectId === 'string' ? eq(contentItems.projectId, filters.projectId) : undefined,
            stage.length ? inArray(contentItems.stage, stage as ContentStage[]) : undefined,
            format.length ? inArray(contentItems.format, format as ContentRow['format'][]) : undefined,
            typeof filters.q === 'string' ? ilike(contentItems.title, likePattern(filters.q)) : undefined,
            after ? or(gt(contentItems.createdAt, after.at), and(eq(contentItems.createdAt, after.at), gt(contentItems.id, after.id))) : undefined,
          ),
        )
        .orderBy(asc(contentItems.createdAt), asc(contentItems.id))
        .limit(PAGE);
      if (!rows.length) return;
      const pids = [...new Set(rows.map((r) => r.projectId))];
      const ps = await db.select({ id: projects.id, name: projects.name }).from(projects).where(inArray(projects.id, pids));
      const pn = new Map(ps.map((p) => [p.id, p.name]));
      const refs = await loadMemberRefs(db, ctx.actor.workspaceId, rows.flatMap((r) => [r.ownerMembershipId, r.reviewerMembershipId]));
      const vids = [...new Set(rows.flatMap((r) => [r.currentVersionId, r.approvedVersionId]).filter((x): x is string => !!x))];
      const vs = vids.length ? await db.select({ id: contentVersions.id, n: contentVersions.versionNo }).from(contentVersions).where(inArray(contentVersions.id, vids)) : [];
      const vn = new Map(vs.map((v) => [v.id, v.n]));
      const accIds = [...new Set(rows.map((r) => r.accountId).filter((x): x is string => !!x))];
      const accs = accIds.length ? await db.select().from(socialAccounts).where(inArray(socialAccounts.id, accIds)) : [];
      const an = new Map(accs.map((a) => [a.id, allowed(ctx, 'accounts.read', { accountId: a.id, projectId: a.projectId }) ? (a.handle ? `@${a.handle}` : a.canonicalUrl) : null]));
      const pubs = await db
        .select({ id: publications.contentItemId, n: count() })
        .from(publications)
        .where(and(inArray(publications.contentItemId, rows.map((r) => r.id)), isNull(publications.deletedAt), ne(publications.status, 'cancelled'), lte(publications.createdAt, boundAt)))
        .groupBy(publications.contentItemId);
      const pc = new Map(pubs.map((p) => [p.id, Number(p.n)]));
      for (const r of rows)
        yield {
          id: r.id,
          title: r.title,
          project: pn.get(r.projectId) ?? null,
          format: r.format,
          stage: r.stage,
          owner: r.ownerMembershipId ? (refs.get(r.ownerMembershipId)?.displayName ?? null) : null,
          reviewer: r.reviewerMembershipId ? (refs.get(r.reviewerMembershipId)?.displayName ?? null) : null,
          due_at: r.dueAt?.toISOString() ?? null,
          no_deadline: r.noDeadline,
          overdue: !!r.dueAt && r.dueAt < now && r.stage !== 'approved' && r.stage !== 'archived',
          language: r.language,
          tags: r.tags.join(', ') || null,
          account: r.accountId ? (an.get(r.accountId) ?? null) : null,
          latest_version: r.currentVersionId ? (vn.get(r.currentVersionId) ?? null) : null,
          approved_version: r.approvedVersionId ? (vn.get(r.approvedVersionId) ?? null) : null,
          publication_count: pc.get(r.id) ?? 0,
          blocked: !!r.blockedAt,
          paused: !!r.pausedAt,
          created_at: r.createdAt.toISOString(),
          updated_at: r.updatedAt.toISOString(),
          archived_at: r.archivedAt?.toISOString() ?? null,
        };
      const last = rows[rows.length - 1]!;
      after = { at: last.createdAt, id: last.id };
      if (rows.length < PAGE) return;
    }
  },
});

