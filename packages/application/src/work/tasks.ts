import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { assetLinks, memberships, projects, taskBlockIntervals, taskChecklistItems, taskDueRevisions, tasks, taskStatusEvents } from '@castlane/database';
import type { DueInputBody, TaskCreateBody, TaskUpdateBody } from '@castlane/api-contracts';
import { AppError, newId, type FieldError } from '@castlane/domain';
import { allowed, authorizeObject, authorizeRead, requirePermission } from '../core/access';
import { linkAsset } from '../media/assets';
import { audit, diffFields } from '../core/audit';
import type { CommandContext } from '../core/context';
import { emit } from '../core/events';
import { notify } from '../core/notify';
import { assertVersion, stamp, touch } from '../core/rows';
import { resolveTags } from '../core/tags';
import { resolveDue, type ResolvedDue } from './rules/due';
import { baselineAfter } from './rules/task-status';
import { dismissStaleDueReminders } from './reminders';
import { fieldFail, fieldsFail, indexTask, LINK_COLUMNS, loadLinkedInfo, lockTask, memberCan, taskScope, type TaskRowDb } from './shared';

type TaskSource = TaskRowDb['source'];

export const resolveDueInput = (due: DueInputBody | null | undefined, field = 'due'): ResolvedDue | null => {
  if (!due) return null;
  try {
    return resolveDue(due);
  } catch {
    throw fieldFail(field, 'INVALID', 'Enter a valid deadline and time zone.');
  }
};

const projectForTask = async (ctx: CommandContext, projectId: string, action: 'tasks.create' | 'tasks.edit') => {
  const [p] = await ctx.tx.select().from(projects).where(and(eq(projects.workspaceId, ctx.actor.workspaceId), eq(projects.id, projectId)));
  if (!p || p.deletedAt) throw fieldFail('projectId', 'NOT_FOUND', 'Choose a project you can access.');
  const scope = { objectType: 'project', objectId: p.id, projectId: p.id, directionId: p.directionId, ownerMembershipId: p.ownerMembershipId };
  if (!allowed(ctx, action, scope)) {
    if (allowed(ctx, 'projects.read', scope) || allowed(ctx, 'tasks.read', scope)) throw new AppError('FORBIDDEN', 'You cannot create tasks in this project.');
    throw fieldFail('projectId', 'NOT_FOUND', 'Choose a project you can access.');
  }
  if (p.status === 'archived') throw new AppError('INVALID_STATE', 'Archived projects accept no new tasks. Restore the project first.');
  return p;
};

/** An assignee/reviewer must be an active member who can access the task (project team or the assignment itself). */
const assertAssignable = async (ctx: CommandContext, membershipId: string, scope: ReturnType<typeof taskScope>, field: string) => {
  const r = await memberCan(ctx.tx, ctx.actor.workspaceId, membershipId, 'tasks.read', { ...scope, assignedMembershipIds: [membershipId] }, ctx.app.clock.now());
  if (!r.active) throw fieldFail(field, 'INACTIVE', 'Choose an active member.');
  if (!r.ok) throw fieldFail(field, 'NO_ACCESS', `${r.name ?? 'This member'} cannot access this project. Add them to the project team first.`);
};

type LinkPatch = Partial<Pick<TaskRowDb, 'accountId' | 'contentItemId' | 'publicationId' | 'shiftId' | 'operationId' | 'dealId' | 'deliverableId' | 'articleId'>>;

const PROJECT_BOUND = new Set(['account', 'content_item', 'publication', 'shift', 'operation']);

/** Linked records must exist in the workspace, be readable by the actor and (where they have one) belong to the task's project. */
export const validateLinks = async (ctx: CommandContext, projectId: string, links: LinkPatch) => {
  const refs = LINK_COLUMNS.filter((l) => (links as Record<string, unknown>)[l.column]).map((l) => ({ type: l.type, id: (links as Record<string, string>)[l.column]!, column: l.column }));
  if (refs.length === 0) return;
  const info = await loadLinkedInfo(ctx, refs);
  const errors: FieldError[] = [];
  for (const r of refs) {
    const i = info.get(`${r.type}:${r.id}`);
    if (!i || !i.readable) errors.push({ field: r.column, code: 'NOT_FOUND', message: 'The linked record was not found.' });
    else if (PROJECT_BOUND.has(r.type) && i.projectId && i.projectId !== projectId)
      errors.push({ field: r.column, code: 'OTHER_PROJECT', message: 'Link a record from the same project.' });
  }
  if (errors.length) throw fieldsFail(errors);
};

const pickLinks = (input: Record<string, unknown>): LinkPatch => {
  const out: Record<string, unknown> = {};
  for (const l of LINK_COLUMNS) if (input[l.column] !== undefined) out[l.column] = input[l.column];
  return out as LinkPatch;
};

const nextDeadlineRevision = async (ctx: CommandContext, taskId: string) => {
  const [r] = await ctx.tx
    .select({ rev: sql<number>`coalesce(max(${taskDueRevisions.deadlineRevision}), 0)` })
    .from(taskDueRevisions)
    .where(eq(taskDueRevisions.taskId, taskId));
  return Number(r?.rev ?? 0) + 1;
};

/** Record a deadline change as a new revision; stale due reminders of older revisions stop (T143). */
export const recordDueChange = async (ctx: CommandContext, t: Pick<TaskRowDb, 'id' | 'dueAt'>, to: Date | null, reason: string | null) => {
  const revision = await nextDeadlineRevision(ctx, t.id);
  await ctx.tx.insert(taskDueRevisions).values({ ...stamp(ctx), id: newId(), taskId: t.id, fromDueAt: t.dueAt, toDueAt: to, reason, deadlineRevision: revision });
  await dismissStaleDueReminders(ctx, t.id, revision);
  return revision;
};

const notifyAssignment = async (ctx: CommandContext, t: TaskRowDb, recipients: { assignee?: string | null; reviewer?: string | null }) => {
  const at = ctx.app.clock.now();
  if (recipients.assignee)
    await notify(ctx.tx, {
      workspaceId: t.workspaceId,
      recipientMembershipIds: [recipients.assignee],
      eventType: 'task.assigned',
      eventKey: `task.assigned:${t.id}:${recipients.assignee}:${t.rowVersion}`,
      kind: 'assignment',
      title: `Assigned to you: ${t.title}`,
      entityType: 'task',
      entityId: t.id,
      projectId: t.projectId,
      actorMembershipId: ctx.actor.membershipId,
      at,
    });
  if (recipients.reviewer)
    await notify(ctx.tx, {
      workspaceId: t.workspaceId,
      recipientMembershipIds: [recipients.reviewer],
      eventType: 'task.reviewer_assigned',
      eventKey: `task.reviewer_assigned:${t.id}:${recipients.reviewer}:${t.rowVersion}`,
      kind: 'assignment',
      title: `You review: ${t.title}`,
      entityType: 'task',
      entityId: t.id,
      projectId: t.projectId,
      actorMembershipId: ctx.actor.membershipId,
      at,
    });
};

export interface CreateTaskOptions {
  source?: TaskSource;
  templateApplicationId?: string | null;
  recurrenceOccurrenceId?: string | null;
}

/**
 * Create a task. Draft may be unassigned; assigning someone else needs tasks.assign; the assignee
 * and reviewer must be able to access the task; linked records must be readable and in the project.
 */
export const createTask = async (ctx: CommandContext, input: TaskCreateBody, opts: CreateTaskOptions = {}): Promise<string> => {
  requirePermission(ctx, 'tasks.create');
  const p = await projectForTask(ctx, input.projectId, 'tasks.create');
  const id = newId();
  const me = ctx.actor.membershipId;
  const scope = taskScope({ id, projectId: p.id, accountId: input.accountId ?? null, assigneeMembershipId: input.assigneeMembershipId ?? null, reviewerMembershipId: input.reviewerMembershipId ?? null, createdBy: ctx.actor.userId });
  const assignsOthers = (input.assigneeMembershipId && input.assigneeMembershipId !== me) || (input.reviewerMembershipId && input.reviewerMembershipId !== me);
  if (assignsOthers && !allowed(ctx, 'tasks.assign', { projectId: p.id })) throw new AppError('FORBIDDEN', 'You cannot assign tasks to other members in this project.');
  if (input.assigneeMembershipId && input.assigneeMembershipId === input.reviewerMembershipId)
    throw fieldFail('reviewerMembershipId', 'SAME_AS_ASSIGNEE', 'The reviewer must be someone other than the assignee.');
  if (input.assigneeMembershipId) await assertAssignable(ctx, input.assigneeMembershipId, scope, 'assigneeMembershipId');
  if (input.reviewerMembershipId) await assertAssignable(ctx, input.reviewerMembershipId, scope, 'reviewerMembershipId');
  const links = pickLinks(input as unknown as Record<string, unknown>);
  await validateLinks(ctx, p.id, links);
  const due = resolveDueInput(input.due);
  const startAt = input.startAt ? new Date(input.startAt) : null;
  if (startAt && due && startAt.getTime() > due.dueAt.getTime()) throw fieldFail('startAt', 'AFTER_DUE', 'The start must be on or before the deadline.');
  let parent: TaskRowDb | null = null;
  if (input.parentTaskId) {
    parent = await lockTask(ctx, input.parentTaskId);
    if (!allowed(ctx, 'tasks.read', taskScope(parent))) throw fieldFail('parentTaskId', 'NOT_FOUND', 'The parent task was not found.');
    if (parent.projectId !== p.id) throw fieldFail('parentTaskId', 'OTHER_PROJECT', 'A subtask belongs to its parent’s project.');
    if (parent.status === 'done' || parent.status === 'cancelled') throw new AppError('INVALID_STATE', 'Reopen the parent task before adding subtasks.');
  }
  const followers = [...new Set(input.followerMembershipIds ?? [])];
  if (followers.length) {
    const rows = await ctx.tx
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.workspaceId, ctx.actor.workspaceId), eq(memberships.status, 'active'), inArray(memberships.id, followers)));
    if (rows.length !== followers.length) throw fieldFail('followerMembershipIds', 'INVALID', 'Followers must be active members.');
  }
  const status = input.status ?? 'backlog';
  const at = ctx.app.clock.now();
  const [row] = await ctx.tx
    .insert(tasks)
    .values({
      ...stamp(ctx),
      id,
      projectId: p.id,
      title: input.title.trim(),
      description: input.description?.trim() || null,
      status,
      priority: input.priority ?? 'normal',
      assigneeMembershipId: input.assigneeMembershipId ?? null,
      reviewerMembershipId: input.reviewerMembershipId ?? null,
      startAt,
      dueAt: due?.dueAt ?? null,
      dueDate: due?.dueDate ?? null,
      dueTimezone: due?.dueTimezone ?? null,
      baselineDueAt: baselineAfter({ baseline: null, status, dueAt: due?.dueAt ?? null }),
      estimateMinutes: input.estimateMinutes ?? null,
      parentTaskId: parent?.id ?? null,
      requiredForParent: input.requiredForParent ?? true,
      tags: await resolveTags(ctx, input.tags),
      followerMembershipIds: followers,
      source: opts.source ?? 'manual',
      templateApplicationId: opts.templateApplicationId ?? null,
      recurrenceOccurrenceId: opts.recurrenceOccurrenceId ?? null,
      ...links,
    })
    .returning();
  await ctx.tx.insert(taskStatusEvents).values({ ...stamp(ctx), id: newId(), taskId: id, fromStatus: null, toStatus: status, occurredAt: at, actorMembershipId: me, cycle: 1 });
  if (due) await recordDueChange(ctx, { id, dueAt: null }, due.dueAt, null);
  if (input.checklist?.length)
    await ctx.tx.insert(taskChecklistItems).values(
      input.checklist.map((c, i) => ({ ...stamp(ctx), id: newId(), taskId: id, label: c.label.trim(), mandatory: !!c.mandatory, position: i })),
    );
  await audit(ctx, {
    action: 'task.created',
    entityType: 'task',
    entityId: id,
    projectId: p.id,
    diff: diffFields(null, row!, ['title', 'status', 'priority', 'assigneeMembershipId', 'reviewerMembershipId', 'dueAt', 'estimateMinutes', 'parentTaskId', 'source']),
  });
  await emit(ctx, { type: 'task.created', entityType: 'task', entityId: id, revision: 1, payload: { projectId: p.id, status, source: row!.source } });
  await indexTask(ctx, row!);
  await notifyAssignment(ctx, row!, { assignee: row!.assigneeMembershipId, reviewer: row!.reviewerMembershipId });
  return id;
};

const CLOSED_EDITABLE = new Set(['tags', 'followerMembershipIds']);

/** Edit task fields (never the status). Deadline changes create a revision; the baseline never moves with them. */
export const updateTask = async (ctx: CommandContext, id: string, input: TaskUpdateBody) => {
  const t = await lockTask(ctx, id);
  const scope = taskScope(t);
  authorizeObject(ctx, 'tasks.edit', scope, 'tasks.read');
  assertVersion(ctx, t);
  if (t.archivedAt) throw new AppError('INVALID_STATE', 'Archived tasks are read-only. Restore the task first.');
  const keys = Object.keys(input).filter((k) => (input as Record<string, unknown>)[k] !== undefined);
  if ((t.status === 'done' || t.status === 'cancelled') && keys.some((k) => !CLOSED_EDITABLE.has(k)))
    throw new AppError('INVALID_STATE', 'Closed tasks can only change tags and followers. Reopen the task to edit it.');
  const me = ctx.actor.membershipId;
  const patch: Partial<TaskRowDb> = {};
  if (input.title !== undefined) patch.title = input.title.trim();
  if (input.description !== undefined) patch.description = input.description?.trim() || null;
  if (input.priority !== undefined) patch.priority = input.priority;
  if (input.estimateMinutes !== undefined) patch.estimateMinutes = input.estimateMinutes;
  if (input.requiredForParent !== undefined) patch.requiredForParent = input.requiredForParent;
  if (input.tags !== undefined) patch.tags = await resolveTags(ctx, input.tags);

  // People
  const nextAssignee = input.assigneeMembershipId !== undefined ? input.assigneeMembershipId : t.assigneeMembershipId;
  const nextReviewer = input.reviewerMembershipId !== undefined ? input.reviewerMembershipId : t.reviewerMembershipId;
  const assigneeChanged = nextAssignee !== t.assigneeMembershipId;
  const reviewerChanged = nextReviewer !== t.reviewerMembershipId;
  if (assigneeChanged || reviewerChanged) {
    // Taking an unassigned task yourself needs only tasks.edit; every other assignment needs tasks.assign.
    const selfTake = assigneeChanged && !reviewerChanged && !t.assigneeMembershipId && nextAssignee === me;
    if (!selfTake && !allowed(ctx, 'tasks.assign', scope)) throw new AppError('FORBIDDEN', 'You cannot change who works on or reviews this task.');
    if (nextAssignee && nextAssignee === nextReviewer) throw fieldFail('reviewerMembershipId', 'SAME_AS_ASSIGNEE', 'The reviewer must be someone other than the assignee.');
    if (assigneeChanged && !nextAssignee && (t.status === 'in_progress' || t.status === 'in_review'))
      throw fieldFail('assigneeMembershipId', 'REQUIRED', 'Work in progress needs an assignee. Stop work first or choose another member.');
    if (reviewerChanged && !nextReviewer && t.status === 'in_review')
      throw fieldFail('reviewerMembershipId', 'REQUIRED', 'A task in review needs a reviewer. Return it to In Progress first or choose another reviewer.');
    const probe = { ...scope, assignedMembershipIds: [nextAssignee, nextReviewer] };
    if (assigneeChanged && nextAssignee) await assertAssignable(ctx, nextAssignee, probe, 'assigneeMembershipId');
    if (reviewerChanged && nextReviewer) await assertAssignable(ctx, nextReviewer, probe, 'reviewerMembershipId');
    patch.assigneeMembershipId = nextAssignee;
    patch.reviewerMembershipId = nextReviewer;
  }

  // Followers never grant access; they must be active members.
  if (input.followerMembershipIds !== undefined) {
    const followers = [...new Set(input.followerMembershipIds)];
    const added = followers.filter((f) => !t.followerMembershipIds.includes(f));
    if (added.some((f) => f !== me) && !allowed(ctx, 'tasks.assign', scope)) throw new AppError('FORBIDDEN', 'You can only add yourself as a follower.');
    if (added.length) {
      const rows = await ctx.tx
        .select({ id: memberships.id })
        .from(memberships)
        .where(and(eq(memberships.workspaceId, ctx.actor.workspaceId), eq(memberships.status, 'active'), inArray(memberships.id, added)));
      if (rows.length !== added.length) throw fieldFail('followerMembershipIds', 'INVALID', 'Followers must be active members.');
    }
    patch.followerMembershipIds = followers;
  }

  // Links
  const links = pickLinks(input as unknown as Record<string, unknown>);
  if (Object.keys(links).length) {
    await validateLinks(ctx, t.projectId, links);
    Object.assign(patch, links);
  }

  // Dates
  let dueChange: { to: Date | null } | null = null;
  if (input.due !== undefined) {
    const due = resolveDueInput(input.due);
    const changed = (due?.dueAt.getTime() ?? null) !== (t.dueAt?.getTime() ?? null) || (due?.dueDate ?? null) !== t.dueDate;
    if (changed) {
      patch.dueAt = due?.dueAt ?? null;
      patch.dueDate = due?.dueDate ?? null;
      patch.dueTimezone = due?.dueTimezone ?? null;
      dueChange = { to: due?.dueAt ?? null };
    }
  }
  if (input.startAt !== undefined) patch.startAt = input.startAt ? new Date(input.startAt) : null;
  const startAt = patch.startAt !== undefined ? patch.startAt : t.startAt;
  const dueAt = patch.dueAt !== undefined ? patch.dueAt : t.dueAt;
  if (startAt && dueAt && startAt.getTime() > dueAt.getTime()) throw fieldFail(input.startAt !== undefined ? 'startAt' : 'due', 'AFTER_DUE', 'The start must be on or before the deadline.');
  if (dueChange) patch.baselineDueAt = baselineAfter({ baseline: t.baselineDueAt, status: t.status, dueAt: dueChange.to });

  if (Object.keys(patch).length === 0) return id;
  const [row] = await ctx.tx.update(tasks).set({ ...patch, ...touch(ctx, tasks) }).where(eq(tasks.id, id)).returning();
  if (dueChange) await recordDueChange(ctx, t, dueChange.to, input.dueReason?.trim() || null);
  await audit(ctx, {
    action: 'task.updated',
    entityType: 'task',
    entityId: id,
    projectId: t.projectId,
    reason: dueChange ? input.dueReason?.trim() || null : null,
    diff: diffFields(t, row!, [
      'title',
      'description',
      'priority',
      'assigneeMembershipId',
      'reviewerMembershipId',
      'startAt',
      'dueAt',
      'dueDate',
      'estimateMinutes',
      'requiredForParent',
      'tags',
      'accountId',
      'contentItemId',
      'publicationId',
      'shiftId',
      'operationId',
      'dealId',
      'deliverableId',
      'articleId',
    ]),
  });
  await emit(ctx, { type: assigneeChanged ? 'task.assigned' : dueChange ? 'task.rescheduled' : 'task.updated', entityType: 'task', entityId: id, revision: row!.rowVersion });
  await indexTask(ctx, row!);
  await notifyAssignment(ctx, row!, { assignee: assigneeChanged ? nextAssignee : null, reviewer: reviewerChanged ? nextReviewer : null });
  return id;
};

export const blockTask = async (ctx: CommandContext, id: string, input: { reason: string; nextCheckAt?: string | null }) => {
  const t = await lockTask(ctx, id);
  authorizeObject(ctx, 'tasks.edit', taskScope(t), 'tasks.read');
  assertVersion(ctx, t);
  if (t.archivedAt || t.status === 'done' || t.status === 'cancelled') throw new AppError('INVALID_STATE', 'Only open tasks can be blocked.');
  if (t.blockedAt) throw new AppError('INVALID_STATE', 'This task is already blocked. Unblock it first to record a new reason.');
  const at = ctx.app.clock.now();
  const next = input.nextCheckAt ? new Date(input.nextCheckAt) : null;
  if (next && next.getTime() <= at.getTime()) throw fieldFail('nextCheckAt', 'MUST_BE_FUTURE', 'Choose a future date and time.');
  await ctx.tx.insert(taskBlockIntervals).values({ ...stamp(ctx), id: newId(), taskId: id, reason: input.reason.trim(), startedAt: at });
  const [row] = await ctx.tx.update(tasks).set({ blockedAt: at, blockedReason: input.reason.trim(), nextCheckAt: next, ...touch(ctx, tasks) }).where(eq(tasks.id, id)).returning();
  await audit(ctx, { action: 'task.blocked', entityType: 'task', entityId: id, projectId: t.projectId, reason: input.reason });
  await emit(ctx, { type: 'task.blocked', entityType: 'task', entityId: id, revision: row!.rowVersion });
  if (t.assigneeMembershipId && t.assigneeMembershipId !== ctx.actor.membershipId)
    await notify(ctx.tx, {
      workspaceId: t.workspaceId,
      recipientMembershipIds: [t.assigneeMembershipId],
      eventType: 'task.blocked',
      eventKey: `task.blocked:${id}:${row!.rowVersion}`,
      kind: 'general',
      title: `Blocked: ${t.title}`,
      excerpt: input.reason,
      entityType: 'task',
      entityId: id,
      projectId: t.projectId,
      actorMembershipId: ctx.actor.membershipId,
      at,
    });
  return id;
};

export const unblockTask = async (ctx: CommandContext, id: string, input: { resolution: string }) => {
  const t = await lockTask(ctx, id);
  authorizeObject(ctx, 'tasks.edit', taskScope(t), 'tasks.read');
  assertVersion(ctx, t);
  if (!t.blockedAt) throw new AppError('INVALID_STATE', 'This task is not blocked.');
  const at = ctx.app.clock.now();
  await ctx.tx
    .update(taskBlockIntervals)
    .set({ endedAt: at, resolution: input.resolution.trim(), ...touch(ctx, taskBlockIntervals) })
    .where(and(eq(taskBlockIntervals.taskId, id), isNull(taskBlockIntervals.endedAt)));
  const [row] = await ctx.tx.update(tasks).set({ blockedAt: null, blockedReason: null, nextCheckAt: null, ...touch(ctx, tasks) }).where(eq(tasks.id, id)).returning();
  await audit(ctx, { action: 'task.unblocked', entityType: 'task', entityId: id, projectId: t.projectId, reason: input.resolution });
  await emit(ctx, { type: 'task.unblocked', entityType: 'task', entityId: id, revision: row!.rowVersion });
  return id;
};

export const acceptTaskCancellation = async (ctx: CommandContext, id: string, input: { note?: string }) => {
  const t = await lockTask(ctx, id);
  authorizeObject(ctx, 'tasks.assign', taskScope(t), 'tasks.read');
  assertVersion(ctx, t);
  if (t.status !== 'cancelled') throw new AppError('INVALID_STATE', 'Only cancelled tasks have a cancellation to accept.');
  if (t.cancellationAccepted) return id;
  const [row] = await ctx.tx.update(tasks).set({ cancellationAccepted: true, ...touch(ctx, tasks) }).where(eq(tasks.id, id)).returning();
  await audit(ctx, { action: 'task.cancellation_accepted', entityType: 'task', entityId: id, projectId: t.projectId, reason: input.note ?? null });
  await emit(ctx, { type: 'task.updated', entityType: 'task', entityId: id, revision: row!.rowVersion });
  if (t.parentTaskId) await emit(ctx, { type: 'task.updated', entityType: 'task', entityId: t.parentTaskId });
  return id;
};

export const createSubtask = async (ctx: CommandContext, parentId: string, input: Omit<TaskCreateBody, 'projectId' | 'parentTaskId'>) => {
  const parent = await lockTask(ctx, parentId);
  authorizeObject(ctx, 'tasks.create', taskScope(parent), 'tasks.read');
  return createTask(ctx, { ...input, projectId: parent.projectId, parentTaskId: parentId } as TaskCreateBody);
};

type CopyField = 'description' | 'checklist' | 'assignee' | 'reviewer' | 'estimate' | 'tags' | 'links' | 'priority' | 'attachments';

/** Duplicate as a new Draft: only the chosen fields are copied — never status, history, time, comments or completion. */
export const duplicateTask = async (ctx: CommandContext, id: string, input: { targetProjectId?: string; title?: string; copiedFields: CopyField[] }) => {
  const t = await lockTask(ctx, id);
  authorizeRead(ctx, 'tasks.read', taskScope(t));
  const copy = new Set(input.copiedFields);
  const projectId = input.targetProjectId ?? t.projectId;
  const sameProject = projectId === t.projectId;
  const checklist = copy.has('checklist')
    ? await ctx.tx
        .select({ label: taskChecklistItems.label, mandatory: taskChecklistItems.mandatory })
        .from(taskChecklistItems)
        .where(and(eq(taskChecklistItems.taskId, id), isNull(taskChecklistItems.removedAt)))
        .orderBy(taskChecklistItems.position)
    : [];
  const title = (input.title ?? `${t.title} (copy)`).slice(0, 200);
  const newId_ = await createTask(ctx, {
    title,
    projectId,
    description: copy.has('description') ? t.description : null,
    status: 'draft',
    priority: copy.has('priority') ? t.priority : 'normal',
    assigneeMembershipId: copy.has('assignee') ? t.assigneeMembershipId : null,
    reviewerMembershipId: copy.has('reviewer') ? t.reviewerMembershipId : null,
    estimateMinutes: copy.has('estimate') ? t.estimateMinutes : null,
    tags: copy.has('tags') ? t.tags : [],
    checklist,
    ...(copy.has('links') && sameProject
      ? {
          accountId: t.accountId,
          contentItemId: t.contentItemId,
          publicationId: t.publicationId,
          shiftId: t.shiftId,
          operationId: t.operationId,
          dealId: t.dealId,
          deliverableId: t.deliverableId,
          articleId: t.articleId,
        }
      : {}),
  } as TaskCreateBody);
  if (copy.has('attachments')) {
    const links = await ctx.tx
      .select()
      .from(assetLinks)
      .where(and(eq(assetLinks.workspaceId, ctx.actor.workspaceId), eq(assetLinks.entityType, 'task'), eq(assetLinks.entityId, id), isNull(assetLinks.removedAt)));
    for (const l of links) await linkAsset(ctx, l.assetId, { versionId: l.assetVersionId ?? undefined, target: { entityType: 'task', entityId: newId_, role: l.role } });
  }
  await audit(ctx, { action: 'task.duplicated', entityType: 'task', entityId: newId_, projectId, metadata: { sourceTaskId: id, copiedFields: [...copy] } });
  return newId_;
};

export const followTask = async (ctx: CommandContext, id: string, following: boolean) => {
  const t = await lockTask(ctx, id);
  authorizeRead(ctx, 'tasks.read', taskScope(t));
  const me = ctx.actor.membershipId;
  if (!me) throw new AppError('FORBIDDEN', 'Only members can follow tasks.');
  const has = t.followerMembershipIds.includes(me);
  if (has === following) return { following };
  const next = following ? [...t.followerMembershipIds, me] : t.followerMembershipIds.filter((m) => m !== me);
  // Following changes neither the task content nor its version: no conflict for concurrent editors.
  await ctx.tx.update(tasks).set({ followerMembershipIds: next }).where(eq(tasks.id, id));
  await emit(ctx, { type: 'task.followers_changed', entityType: 'task', entityId: id });
  return { following };
};
