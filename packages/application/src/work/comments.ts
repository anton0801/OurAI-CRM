import { and, asc, eq, inArray } from 'drizzle-orm';
import type { ObjectScope } from '@castlane/authorization';
import { commentRevisions, comments } from '@castlane/database';
import type { CommentView } from '@castlane/api-contracts';
import { AppError, newId, notFound } from '@castlane/domain';
import { allowed, authorizeObject, authorizeRead } from '../core/access';
import { audit } from '../core/audit';
import { dbOf, type CommandContext, type QueryContext } from '../core/context';
import { emit } from '../core/events';
import { loadMemberRefs, refOrUnknown, type MemberRef } from '../core/members';
import { notify } from '../core/notify';
import { assertVersion, stamp, touch } from '../core/rows';
import { fieldFail, memberCan } from './shared';

type CommentRow = typeof comments.$inferSelect;

export interface CommentParentScope extends ObjectScope {
  /** Safe title for notifications ("mentioned you on …"). */
  title?: string | null;
  projectId?: string | null;
  /** Members notified about every new comment (e.g. task assignee, reviewer, followers). */
  watcherMembershipIds?: (string | null | undefined)[];
  /** Drop excerpts from notifications (restricted or sensitive parents). */
  sensitive?: boolean;
}

export interface CommentCreateInput {
  parentType: string;
  parentId: string;
  body: string;
  replyToId?: string;
  severity?: 'note' | 'blocking';
  mentions?: string[];
  targetVersionId?: string;
  assetVersionId?: string;
  timecodeMs?: number;
  pointX?: string;
  pointY?: string;
}

/**
 * A record type other modules let people comment on. `scope` resolves the parent inside the
 * workspace (null = not found); reading needs `readPermission`, writing `commentPermission`.
 */
export interface CommentParentDefinition {
  readPermission: string | string[];
  commentPermission: string;
  /** May remove others' comments (moderation); authors may always remove their own. */
  moderatePermission?: string;
  scope(ctx: QueryContext | CommandContext, parentId: string): Promise<CommentParentScope | null>;
  /** Blocking severity (review comments). Default false: all comments are notes. */
  allowSeverity?: boolean;
  /** Version / asset / timecode / point annotations (review studio). Default false. */
  allowAnnotations?: boolean;
  /** Extra validation (e.g. the version belongs to the parent, timecode within duration). */
  validate?(ctx: CommandContext, parentId: string, input: CommentCreateInput): Promise<void>;
  /** Who may resolve a thread; default: the author or anyone who may comment. */
  canResolve?(ctx: QueryContext, comment: CommentRow, scope: CommentParentScope): boolean;
  /** Who may reopen a thread; default: anyone who may comment. */
  canReopen?(ctx: QueryContext, comment: CommentRow, scope: CommentParentScope): boolean;
  /** Hook after create/resolve/reopen/remove (e.g. review blockers). Runs in the same transaction. */
  onChange?(ctx: CommandContext, comment: CommentRow, change: 'created' | 'edited' | 'resolved' | 'reopened' | 'removed'): Promise<void>;
}

export const COMMENT_PARENTS = new Map<string, CommentParentDefinition>();

/** Register a commentable record type (tasks here; content/reviews, articles… in their modules). */
export const defineCommentParent = (parentType: string, def: CommentParentDefinition) => {
  COMMENT_PARENTS.set(parentType, def);
};

const parentDef = (parentType: string) => {
  const d = COMMENT_PARENTS.get(parentType);
  if (!d) throw new AppError('VALIDATION_FAILED', `Comments are not available on ${parentType}.`, { fieldErrors: [{ field: 'parentType', code: 'UNSUPPORTED', message: 'Comments are not available here.' }] });
  return d;
};

const resolveParent = async (ctx: QueryContext | CommandContext, parentType: string, parentId: string) => {
  const def = parentDef(parentType);
  const scope = await def.scope(ctx, parentId);
  if (!scope) throw notFound('Record');
  authorizeRead(ctx, def.readPermission, scope);
  return { def, scope };
};

const toViews = async (ctx: QueryContext | CommandContext, rows: CommentRow[], def: CommentParentDefinition, scope: CommentParentScope): Promise<CommentView[]> => {
  const refs = await loadMemberRefs(dbOf(ctx), ctx.actor.workspaceId, rows.flatMap((r) => [r.authorMembershipId, r.resolvedBy, ...r.mentions]));
  const me = ctx.actor.membershipId;
  const canComment = allowed(ctx, def.commentPermission, scope);
  const moderate = !!def.moderatePermission && allowed(ctx, def.moderatePermission, scope);
  return rows.map((r) => {
    const removed = !!r.deletedAt;
    const own = r.authorMembershipId === me;
    const isRoot = !r.replyToId;
    const canResolve = def.canResolve ? def.canResolve(ctx, r, scope) : own || canComment;
    const canReopen = def.canReopen ? def.canReopen(ctx, r, scope) : canComment;
    return {
      id: r.id,
      parentType: r.parentType,
      parentId: r.parentId,
      threadRootId: r.threadRootId,
      replyToId: r.replyToId,
      depth: r.depth,
      author: refOrUnknown(refs, r.authorMembershipId)!,
      body: removed ? null : r.body,
      removed,
      severity: r.severity,
      state: r.state,
      targetVersionId: r.targetVersionId,
      assetVersionId: r.assetVersionId,
      timecodeMs: r.timecodeMs,
      pointX: r.pointX,
      pointY: r.pointY,
      resolvedAt: r.resolvedAt?.toISOString() ?? null,
      resolvedBy: refOrUnknown(refs, r.resolvedBy),
      resolutionNote: r.resolutionNote,
      editedAt: r.editedAt?.toISOString() ?? null,
      mentions: r.mentions.map((m) => refOrUnknown(refs, m)).filter((x): x is MemberRef => !!x),
      createdAt: r.createdAt.toISOString(),
      rowVersion: r.rowVersion,
      permissions: {
        edit: own && !removed && canComment,
        remove: !removed && (own || moderate),
        resolve: !removed && isRoot && r.state !== 'resolved' && canResolve,
        reopen: !removed && isRoot && r.state === 'resolved' && canReopen,
        reply: !removed && canComment && r.depth < 2,
      },
    };
  });
};

export const listComments = async (ctx: QueryContext, q: { parentType: string; parentId: string; targetVersionId?: string; includeResolved?: boolean }) => {
  const { def, scope } = await resolveParent(ctx, q.parentType, q.parentId);
  const rows = await dbOf(ctx)
    .select()
    .from(comments)
    .where(
      and(
        eq(comments.workspaceId, ctx.actor.workspaceId),
        eq(comments.parentType, q.parentType),
        eq(comments.parentId, q.parentId),
        q.targetVersionId ? eq(comments.targetVersionId, q.targetVersionId) : undefined,
      ),
    )
    .orderBy(asc(comments.createdAt), asc(comments.id))
    .limit(2000);
  const views = await toViews(ctx, rows, def, scope);
  const roots = views.filter((v) => !v.replyToId && (q.includeResolved !== false || v.state !== 'resolved'));
  const threads = roots.map((r) => ({ ...r, replies: views.filter((v) => v.threadRootId === r.id) }));
  return {
    threads,
    total: views.filter((v) => !v.removed).length,
    openBlocking: rows.filter((r) => !r.deletedAt && r.severity === 'blocking' && r.state !== 'resolved' && !r.replyToId).length,
    canComment: allowed(ctx, def.commentPermission, scope),
    mentionPermission: Array.isArray(def.readPermission) ? (def.readPermission[0] ?? null) : def.readPermission,
    projectId: scope.projectId ?? null,
  };
};

const loadComment = async (ctx: QueryContext | CommandContext, id: string, lock = false) => {
  const q = dbOf(ctx).select().from(comments).where(and(eq(comments.workspaceId, ctx.actor.workspaceId), eq(comments.id, id)));
  const [c] = lock && 'tx' in ctx ? await q.for('update') : await q;
  if (!c) throw notFound('Comment');
  const { def, scope } = await resolveParent(ctx, c.parentType, c.parentId);
  return { c, def, scope };
};

export const getComment = async (ctx: QueryContext, id: string) => {
  const { c, def, scope } = await loadComment(ctx, id);
  return (await toViews(ctx, [c], def, scope))[0]!;
};

/** Mentions: only active members who can read the parent (never a way to leak the record). */
const validateMentions = async (ctx: CommandContext, def: CommentParentDefinition, scope: CommentParentScope, ids: string[]) => {
  const unique = [...new Set(ids)];
  const denied: string[] = [];
  for (const m of unique) {
    const r = await memberCan(ctx.app.db, ctx.actor.workspaceId, m, def.readPermission, scope, ctx.app.clock.now());
    if (!r.ok) denied.push(r.name ?? 'A member');
  }
  if (denied.length) throw fieldFail('mentions', 'NO_ACCESS', `${denied.join(', ')} cannot see this record and cannot be mentioned.`);
  return unique;
};

const notifyComment = async (ctx: CommandContext, c: CommentRow, scope: CommentParentScope, mentions: string[], keySuffix = '') => {
  const at = ctx.app.clock.now();
  const where = scope.title ? ` on ${scope.title}` : '';
  const excerpt = scope.sensitive ? null : c.body.slice(0, 160);
  const base = { workspaceId: c.workspaceId, entityType: c.parentType, entityId: c.parentId, projectId: scope.projectId ?? null, actorMembershipId: ctx.actor.membershipId, at, excerpt, sensitive: scope.sensitive };
  if (mentions.length)
    await notify(ctx.tx, { ...base, recipientMembershipIds: mentions, eventType: 'comment.mention', eventKey: `comment.mention:${c.id}${keySuffix}`, kind: 'mention', title: `${ctx.actor.displayName} mentioned you${where}` });
  if (keySuffix) return;
  const replyTo = c.replyToId ? (await ctx.tx.select({ author: comments.authorMembershipId }).from(comments).where(eq(comments.id, c.replyToId)))[0]?.author : null;
  if (replyTo && !mentions.includes(replyTo))
    await notify(ctx.tx, { ...base, recipientMembershipIds: [replyTo], eventType: 'comment.reply', eventKey: `comment.reply:${c.id}`, kind: 'general', title: `${ctx.actor.displayName} replied to your comment${where}` });
  const watchers = (scope.watcherMembershipIds ?? []).filter((w): w is string => !!w && !mentions.includes(w) && w !== replyTo);
  const readable: string[] = [];
  for (const w of new Set(watchers)) if ((await memberCan(ctx.app.db, ctx.actor.workspaceId, w, parentDef(c.parentType).readPermission, scope, at)).ok) readable.push(w);
  if (readable.length)
    await notify(ctx.tx, { ...base, recipientMembershipIds: readable, eventType: 'comment.created', eventKey: `comment.new:${c.id}`, kind: 'general', title: `New comment${where}` });
};

export const createComment = async (ctx: CommandContext, input: CommentCreateInput) => {
  const def = parentDef(input.parentType);
  const scope = await def.scope(ctx, input.parentId);
  if (!scope) throw notFound('Record');
  authorizeObject(ctx, def.commentPermission, scope, def.readPermission);
  const me = ctx.actor.membershipId;
  if (!me) throw new AppError('FORBIDDEN', 'Only members can comment.');
  if (input.severity === 'blocking' && !def.allowSeverity) throw fieldFail('severity', 'UNSUPPORTED', 'Blocking comments are not available here.');
  const annotated = input.targetVersionId || input.assetVersionId || input.timecodeMs !== undefined || input.pointX !== undefined || input.pointY !== undefined;
  if (annotated && !def.allowAnnotations) throw fieldFail('targetVersionId', 'UNSUPPORTED', 'Version annotations are not available here.');
  if ((input.pointX === undefined) !== (input.pointY === undefined)) throw fieldFail('pointX', 'INCOMPLETE', 'An image point needs both coordinates.');
  let depth = 0;
  let threadRootId: string | null = null;
  if (input.replyToId) {
    const [parent] = await ctx.tx.select().from(comments).where(and(eq(comments.workspaceId, ctx.actor.workspaceId), eq(comments.id, input.replyToId)));
    if (!parent || parent.parentType !== input.parentType || parent.parentId !== input.parentId) throw fieldFail('replyToId', 'NOT_FOUND', 'The comment you reply to was not found.');
    if (parent.deletedAt) throw new AppError('INVALID_STATE', 'You cannot reply to a removed comment.');
    depth = parent.depth + 1;
    if (depth > 2) throw fieldFail('replyToId', 'TOO_DEEP', 'Replies can be nested at most two levels.');
    threadRootId = parent.threadRootId ?? parent.id;
  }
  await def.validate?.(ctx, input.parentId, input);
  const mentions = await validateMentions(ctx, def, scope, input.mentions ?? []);
  const id = newId();
  const [row] = await ctx.tx
    .insert(comments)
    .values({
      ...stamp(ctx),
      id,
      parentType: input.parentType,
      parentId: input.parentId,
      projectId: scope.projectId ?? null,
      threadRootId,
      replyToId: input.replyToId ?? null,
      depth,
      authorMembershipId: me,
      body: input.body.trim(),
      severity: input.severity ?? 'note',
      targetVersionId: input.targetVersionId ?? null,
      assetVersionId: input.assetVersionId ?? null,
      timecodeMs: input.timecodeMs ?? null,
      pointX: input.pointX ?? null,
      pointY: input.pointY ?? null,
      mentions,
    })
    .returning();
  // The audit keeps the fact, never the text.
  await audit(ctx, { action: 'comment.created', entityType: input.parentType, entityId: input.parentId, projectId: scope.projectId ?? null, metadata: { commentId: id, reply: !!input.replyToId, mentions: mentions.length } });
  await emit(ctx, { type: 'comment.created', entityType: 'comment', entityId: id, revision: 1, payload: { parentType: input.parentType, parentId: input.parentId } });
  await def.onChange?.(ctx, row!, 'created');
  await notifyComment(ctx, row!, scope, mentions);
  return (await toViews(ctx, [row!], def, scope))[0]!;
};

/** Edit your own text: the previous body is kept as an append-only revision; the comment shows Edited. */
export const updateComment = async (ctx: CommandContext, id: string, input: { body: string; mentions?: string[] }) => {
  const { c, def, scope } = await loadComment(ctx, id, true);
  if (c.authorMembershipId !== ctx.actor.membershipId) throw new AppError('FORBIDDEN', 'You can only edit your own comments.');
  if (!allowed(ctx, def.commentPermission, scope)) throw new AppError('FORBIDDEN', 'You can no longer comment here.');
  assertVersion(ctx, c);
  if (c.deletedAt) throw new AppError('INVALID_STATE', 'Removed comments cannot be edited.');
  const body = input.body.trim();
  if (body === c.body && input.mentions === undefined) return (await toViews(ctx, [c], def, scope))[0]!;
  const mentions = input.mentions !== undefined ? await validateMentions(ctx, def, scope, input.mentions) : c.mentions;
  await ctx.tx.insert(commentRevisions).values({ ...stamp(ctx), id: newId(), commentId: id, previousBody: c.body });
  const [row] = await ctx.tx.update(comments).set({ body, mentions, editedAt: ctx.app.clock.now(), ...touch(ctx, comments) }).where(eq(comments.id, id)).returning();
  await audit(ctx, { action: 'comment.edited', entityType: c.parentType, entityId: c.parentId, projectId: c.projectId, metadata: { commentId: id } });
  await emit(ctx, { type: 'comment.edited', entityType: 'comment', entityId: id, revision: row!.rowVersion });
  await def.onChange?.(ctx, row!, 'edited');
  const added = mentions.filter((m) => !c.mentions.includes(m));
  if (added.length) await notifyComment(ctx, row!, scope, added, `:v${row!.rowVersion}`);
  return (await toViews(ctx, [row!], def, scope))[0]!;
};

export const resolveComment = async (ctx: CommandContext, id: string, input: { resolutionNote?: string }) => {
  const { c, def, scope } = await loadComment(ctx, id, true);
  assertVersion(ctx, c);
  const [view] = await toViews(ctx, [c], def, scope);
  if (c.replyToId) throw new AppError('INVALID_STATE', 'Resolve the thread from its first comment.');
  if (c.deletedAt || c.state === 'resolved') throw new AppError('INVALID_STATE', 'This thread cannot be resolved now.');
  if (!view!.permissions.resolve) throw new AppError('FORBIDDEN', 'You cannot resolve this thread.');
  const [row] = await ctx.tx
    .update(comments)
    .set({ state: 'resolved', resolvedAt: ctx.app.clock.now(), resolvedBy: ctx.actor.membershipId, resolutionNote: input.resolutionNote?.trim() || null, ...touch(ctx, comments) })
    .where(eq(comments.id, id))
    .returning();
  await audit(ctx, { action: 'comment.resolved', entityType: c.parentType, entityId: c.parentId, projectId: c.projectId, metadata: { commentId: id } });
  await emit(ctx, { type: 'comment.resolved', entityType: 'comment', entityId: id, revision: row!.rowVersion });
  await def.onChange?.(ctx, row!, 'resolved');
  return (await toViews(ctx, [row!], def, scope))[0]!;
};

export const reopenComment = async (ctx: CommandContext, id: string, input: { reason: string }) => {
  const { c, def, scope } = await loadComment(ctx, id, true);
  assertVersion(ctx, c);
  const [view] = await toViews(ctx, [c], def, scope);
  if (c.state !== 'resolved' || c.deletedAt) throw new AppError('INVALID_STATE', 'Only resolved threads can be reopened.');
  if (!view!.permissions.reopen) throw new AppError('FORBIDDEN', 'You cannot reopen this thread.');
  const [row] = await ctx.tx.update(comments).set({ state: 'reopened', resolvedAt: null, resolvedBy: null, ...touch(ctx, comments) }).where(eq(comments.id, id)).returning();
  await audit(ctx, { action: 'comment.reopened', entityType: c.parentType, entityId: c.parentId, projectId: c.projectId, reason: input.reason, metadata: { commentId: id } });
  await emit(ctx, { type: 'comment.reopened', entityType: 'comment', entityId: id, revision: row!.rowVersion });
  await def.onChange?.(ctx, row!, 'reopened');
  if (c.resolvedBy && c.resolvedBy !== ctx.actor.membershipId)
    await notify(ctx.tx, {
      workspaceId: c.workspaceId,
      recipientMembershipIds: [c.resolvedBy],
      eventType: 'comment.reopened',
      eventKey: `comment.reopened:${id}:${row!.rowVersion}`,
      kind: 'general',
      title: `A thread you resolved was reopened${scope.title ? ` on ${scope.title}` : ''}`,
      excerpt: scope.sensitive ? null : input.reason,
      entityType: c.parentType,
      entityId: c.parentId,
      projectId: c.projectId,
      actorMembershipId: ctx.actor.membershipId,
      at: ctx.app.clock.now(),
    });
  return (await toViews(ctx, [row!], def, scope))[0]!;
};

/** Soft delete: the text is hidden, the fact, author and revisions stay in history. */
export const removeComment = async (ctx: CommandContext, id: string, input: { reason?: string }) => {
  const { c, def, scope } = await loadComment(ctx, id, true);
  assertVersion(ctx, c);
  const own = c.authorMembershipId === ctx.actor.membershipId;
  const moderate = !!def.moderatePermission && allowed(ctx, def.moderatePermission, scope);
  if (!own && !moderate) throw new AppError('FORBIDDEN', 'You can only remove your own comments.');
  if (c.deletedAt) return (await toViews(ctx, [c], def, scope))[0]!;
  const [row] = await ctx.tx.update(comments).set({ deletedAt: ctx.app.clock.now(), ...touch(ctx, comments) }).where(eq(comments.id, id)).returning();
  await audit(ctx, { action: 'comment.removed', entityType: c.parentType, entityId: c.parentId, projectId: c.projectId, reason: input.reason ?? null, metadata: { commentId: id, byModerator: !own } });
  await emit(ctx, { type: 'comment.removed', entityType: 'comment', entityId: id, revision: row!.rowVersion });
  await def.onChange?.(ctx, row!, 'removed');
  return (await toViews(ctx, [row!], def, scope))[0]!;
};

export const commentHistory = async (ctx: QueryContext, id: string) => {
  const { c } = await loadComment(ctx, id);
  // Removed comments keep their history for audit, but their texts are not shown again.
  if (c.deletedAt) return [];
  const rows = await dbOf(ctx).select().from(commentRevisions).where(and(eq(commentRevisions.workspaceId, ctx.actor.workspaceId), eq(commentRevisions.commentId, id))).orderBy(asc(commentRevisions.createdAt));
  const users = rows.map((r) => r.createdBy).filter((x): x is string => !!x);
  const authorRef = await loadMemberRefs(dbOf(ctx), ctx.actor.workspaceId, [c.authorMembershipId]);
  return rows.map((r) => ({
    id: r.id,
    previousBody: r.previousBody,
    replacedAt: r.createdAt.toISOString(),
    // Only the author edits comments, so the editor is the author.
    replacedBy: users.length ? refOrUnknown(authorRef, c.authorMembershipId) : null,
  }));
};

