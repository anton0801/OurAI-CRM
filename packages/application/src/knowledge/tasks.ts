import { and, eq } from 'drizzle-orm';
import { can } from '@castlane/authorization';
import { articleVersions, projects, taskChecklistItems, tasks, taskStatusEvents } from '@castlane/database';
import { AppError, newId, notFound } from '@castlane/domain';
import type { RichTextDocument } from '@castlane/api-contracts';
import { allowed, authorizeObject, requirePermission } from '../core/access';
import { audit } from '../core/audit';
import type { CommandContext } from '../core/context';
import { emit } from '../core/events';
import { isActiveMember } from '../core/members';
import { notify } from '../core/notify';
import { stamp } from '../core/rows';
import { indexSearchDocument } from '../core/search';
import { canReadPublished, memberSnapshots } from './access';
import { loadArticleRow } from './articles';
import { checklistsOf } from './rich-text';

/**
 * Create Task from Checklist (S39): a project task whose checklist is copied from a checklist of
 * a published (frozen) article version. The task links back to the article (tasks.article_id).
 * Writes the tasks tables because the action belongs to the article screen; the task then lives
 * entirely in the Tasks module (status changes, assignment, time).
 */
export const createTaskFromChecklist = async (
  ctx: CommandContext,
  articleId: string,
  input: { versionId: string; blockIndex: number; projectId: string; title: string; assigneeMembershipId?: string | null; dueAt?: string | null },
) => {
  requirePermission(ctx, 'tasks.create');
  const a = await loadArticleRow(ctx, articleId);
  if (!a.publishedVersionId || !canReadPublished(ctx.actor.access, a)) throw notFound('Article');
  const [v] = await ctx.tx.select().from(articleVersions).where(and(eq(articleVersions.articleId, a.id), eq(articleVersions.id, input.versionId)));
  if (!v || v.state === 'draft') throw notFound('Version');
  const list = checklistsOf(v.body as RichTextDocument).find((c) => c.blockIndex === input.blockIndex);
  if (!list || !list.items.length)
    throw new AppError('VALIDATION_FAILED', 'Choose a checklist of this version.', { fieldErrors: [{ field: 'blockIndex', code: 'NOT_A_CHECKLIST', message: 'Choose a checklist of this version.' }] });

  const [p] = await ctx.tx.select().from(projects).where(and(eq(projects.workspaceId, ctx.actor.workspaceId), eq(projects.id, input.projectId)));
  if (!p) throw new AppError('VALIDATION_FAILED', 'Choose a project.', { fieldErrors: [{ field: 'projectId', code: 'NOT_FOUND', message: 'Choose a project.' }] });
  authorizeObject(ctx, 'tasks.create', { objectType: 'project', objectId: p.id, projectId: p.id, directionId: p.directionId }, ['projects.read', 'tasks.read']);
  if (p.status === 'archived' || p.status === 'completed') throw new AppError('INVALID_STATE', 'Tasks cannot be added to a completed or archived project.');

  const assignee = input.assigneeMembershipId ?? null;
  if (assignee) {
    if (!(await isActiveMember(ctx.tx, ctx.actor.workspaceId, assignee)))
      throw new AppError('VALIDATION_FAILED', 'The assignee must be an active member.', { fieldErrors: [{ field: 'assigneeMembershipId', code: 'INACTIVE', message: 'The assignee must be an active member.' }] });
    if (!allowed(ctx, 'tasks.assign', { projectId: p.id }) && assignee !== ctx.actor.membershipId)
      throw new AppError('FORBIDDEN', 'You cannot assign tasks to other members in this project.');
    const snap = await memberSnapshots(ctx.app, ctx.actor.workspaceId)(assignee);
    if (!snap || !can(snap, 'tasks.read', { projectId: p.id, assignedMembershipIds: [assignee] }))
      throw new AppError('VALIDATION_FAILED', 'This member cannot access the project.', { fieldErrors: [{ field: 'assigneeMembershipId', code: 'NO_ACCESS', message: 'This member cannot access the project.' }] });
  }
  const dueAt = input.dueAt ? new Date(input.dueAt) : null;
  if (dueAt && dueAt <= ctx.app.clock.now())
    throw new AppError('VALIDATION_FAILED', 'Choose a future date and time.', { fieldErrors: [{ field: 'dueAt', code: 'MUST_BE_FUTURE', message: 'Choose a future date and time.' }] });

  const at = ctx.app.clock.now();
  const id = newId();
  const title = input.title.trim();
  const description = `Created from the checklist in the knowledge article “${v.title}” (version ${v.versionNo}).`;
  await ctx.tx.insert(tasks).values({
    ...stamp(ctx),
    id,
    projectId: p.id,
    title,
    description,
    status: 'backlog',
    priority: 'normal',
    assigneeMembershipId: assignee,
    dueAt,
    baselineDueAt: dueAt,
    dueTimezone: dueAt ? ctx.actor.timezone : null,
    articleId: a.id,
    source: 'manual',
  });
  let position = 0;
  for (const label of list.items)
    await ctx.tx.insert(taskChecklistItems).values({ ...stamp(ctx), id: newId(), taskId: id, label, position: position++ });
  await ctx.tx.insert(taskStatusEvents).values({ ...stamp(ctx), id: newId(), taskId: id, fromStatus: null, toStatus: 'backlog', occurredAt: at, actorMembershipId: ctx.actor.membershipId });
  await audit(ctx, { action: 'task.created', entityType: 'task', entityId: id, projectId: p.id, metadata: { source: 'article_checklist', articleId: a.id, versionNo: v.versionNo, checklistItems: list.items.length } });
  await emit(ctx, { type: 'task.created', entityType: 'task', entityId: id, revision: 1, payload: { projectId: p.id } });
  await indexSearchDocument(ctx.tx, {
    workspaceId: ctx.actor.workspaceId,
    entityType: 'task',
    entityId: id,
    title,
    body: description,
    projectId: p.id,
    directionId: p.directionId,
    permission: 'tasks.read',
    assigneeMembershipIds: assignee ? [assignee] : [],
    ownerMembershipId: assignee,
    status: 'backlog',
    at,
  });
  if (assignee)
    await notify(ctx.tx, {
      workspaceId: ctx.actor.workspaceId,
      recipientMembershipIds: [assignee],
      eventType: 'task.assigned',
      eventKey: `task.assigned:${id}:${assignee}`,
      kind: 'assignment',
      title: `New task: ${title}`,
      excerpt: p.name,
      entityType: 'task',
      entityId: id,
      projectId: p.id,
      actorMembershipId: ctx.actor.membershipId,
      at,
    });
  return { taskId: id, checklistItems: list.items.length };
};
