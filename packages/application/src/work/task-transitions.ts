import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { taskBlockIntervals, taskChecklistItems, taskDependencies, tasks, taskStatusEvents } from '@castlane/database';
import { AppError, canTransition, newId, type ErrorCode } from '@castlane/domain';
import { allowed, authorizeRead } from '../core/access';
import { audit } from '../core/audit';
import { dbOf, type CommandContext, type QueryContext } from '../core/context';
import { emit } from '../core/events';
import { notify } from '../core/notify';
import { assertVersion, stamp, touch } from '../core/rows';
import { baselineAfter, nextCycle, TASK_TRANSITIONS, transitionKind, type TaskStatus } from './rules/task-status';
import { createsCycle } from './rules/graph';
import { onRecurringTaskClosed } from './recurrence';
import { dismissTaskReminders } from './reminders';
import { fieldFail, indexTask, lockTask, taskScope, type TaskRowDb } from './shared';

export const TRANSITION_LABELS: Record<string, string> = {
  'draft>backlog': 'Move to Backlog',
  'draft>ready': 'Mark Ready',
  'draft>in_progress': 'Start Work',
  'draft>cancelled': 'Cancel Task',
  'backlog>draft': 'Move to Draft',
  'backlog>ready': 'Mark Ready',
  'backlog>in_progress': 'Start Work',
  'backlog>cancelled': 'Cancel Task',
  'ready>backlog': 'Move to Backlog',
  'ready>in_progress': 'Start Work',
  'ready>cancelled': 'Cancel Task',
  'in_progress>ready': 'Stop Work',
  'in_progress>in_review': 'Submit for Review',
  'in_progress>done': 'Complete',
  'in_progress>cancelled': 'Cancel Task',
  'in_review>in_progress': 'Return to In Progress',
  'in_review>done': 'Approve and Complete',
  'in_review>cancelled': 'Cancel Task',
  'done>ready': 'Reopen',
  'done>in_progress': 'Reopen and Start',
  'cancelled>backlog': 'Restore',
};

export interface TransitionFacts {
  openPredecessors: { id: string; title: string | null; status: TaskStatus | null; readable: boolean; dependencyId: string; dueAt: string | null }[];
  mandatoryOpen: { id: string; label: string }[];
  requiredChildrenOpen: { id: string; title: string }[];
  unacceptedCancellations: { id: string; title: string }[];
  openSuccessors: { dependencyId: string; id: string; title: string | null; readable: boolean }[];
}

export const loadTransitionFacts = async (ctx: QueryContext | CommandContext, t: TaskRowDb): Promise<TransitionFacts> => {
  const db = dbOf(ctx);
  const ws = t.workspaceId;
  const preds = await db
    .select({ dep: taskDependencies, task: tasks })
    .from(taskDependencies)
    .innerJoin(tasks, eq(tasks.id, taskDependencies.predecessorId))
    .where(and(eq(taskDependencies.workspaceId, ws), eq(taskDependencies.successorId, t.id), isNull(taskDependencies.removedAt), ne(tasks.status, 'done')));
  const items = await db
    .select({ id: taskChecklistItems.id, label: taskChecklistItems.label })
    .from(taskChecklistItems)
    .where(and(eq(taskChecklistItems.workspaceId, ws), eq(taskChecklistItems.taskId, t.id), isNull(taskChecklistItems.removedAt), eq(taskChecklistItems.mandatory, true), eq(taskChecklistItems.done, false)));
  const children = await db
    .select({ id: tasks.id, title: tasks.title, status: tasks.status, accepted: tasks.cancellationAccepted })
    .from(tasks)
    .where(and(eq(tasks.workspaceId, ws), eq(tasks.parentTaskId, t.id), eq(tasks.requiredForParent, true), isNull(tasks.deletedAt)));
  const succs = await db
    .select({ dep: taskDependencies, task: tasks })
    .from(taskDependencies)
    .innerJoin(tasks, eq(tasks.id, taskDependencies.successorId))
    .where(
      and(
        eq(taskDependencies.workspaceId, ws),
        eq(taskDependencies.predecessorId, t.id),
        isNull(taskDependencies.removedAt),
        inArray(tasks.status, ['draft', 'backlog', 'ready', 'in_progress', 'in_review']),
      ),
    );
  return {
    openPredecessors: preds.map((p) => {
      const readable = allowed(ctx, 'tasks.read', taskScope(p.task));
      return {
        id: p.task.id,
        title: readable ? p.task.title : null,
        status: readable ? p.task.status : null,
        readable,
        dependencyId: p.dep.id,
        dueAt: readable && p.task.dueAt ? p.task.dueAt.toISOString() : null,
      };
    }),
    mandatoryOpen: items,
    requiredChildrenOpen: children.filter((c) => c.status !== 'done' && c.status !== 'cancelled').map((c) => ({ id: c.id, title: c.title })),
    unacceptedCancellations: children.filter((c) => c.status === 'cancelled' && !c.accepted).map((c) => ({ id: c.id, title: c.title })),
    openSuccessors: succs.map((s) => {
      const readable = allowed(ctx, 'tasks.read', taskScope(s.task));
      return { dependencyId: s.dep.id, id: s.task.id, title: readable ? s.task.title : null, readable };
    }),
  };
};

export interface TransitionInput {
  targetState?: TaskStatus;
  reason?: string;
  overrideDependencies?: boolean;
  effectiveAt?: string;
  successorPolicy?: 'remove_dependency' | 'keep_blocked' | 'replace';
  replacementTaskId?: string;
}

type Evaluation =
  | { ok: true; needsReason: boolean }
  | { ok: false; code: ErrorCode; message: string; details?: Record<string, unknown>; needsReason: boolean };

const fail = (code: ErrorCode, message: string, needsReason: boolean, details?: Record<string, unknown>): Evaluation => ({ ok: false, code, message, details, needsReason });

/**
 * Decide whether the actor may move the task to `to` given the current facts. Used by the command
 * (errors) and by the detail read model (disabled actions with the explanation).
 */
export const evaluateTransition = (ctx: QueryContext, t: TaskRowDb, to: TaskStatus, f: TransitionFacts, input: TransitionInput): Evaluation => {
  const scope = taskScope(t);
  const kind = transitionKind(t.status, to);
  const me = ctx.actor.membershipId;
  const isLead = allowed(ctx, 'tasks.assign', scope);
  const isAssignee = !!me && t.assigneeMembershipId === me;
  const isCreator = !!ctx.actor.userId && t.createdBy === ctx.actor.userId;
  let needsReason = kind === 'cancel' || kind === 'reopen' || (t.status === 'in_review' && to === 'in_progress' && !isAssignee) || !!input.overrideDependencies || !!input.effectiveAt;
  if (!canTransition(TASK_TRANSITIONS, t.status, to)) return fail('INVALID_STATE', `This task cannot move from ${t.status} to ${to}.`, false, { from: t.status, to });
  const perm = kind === 'complete' ? 'tasks.complete' : kind === 'reopen' ? 'tasks.reopen' : 'tasks.edit';
  if (!allowed(ctx, perm, scope)) return fail('FORBIDDEN', 'Your role does not allow this status change.', needsReason);

  const dependencyCheck = (): Evaluation | null => {
    if (!t.assigneeMembershipId) return fail('INVALID_STATE', 'Assign an owner before starting this work.', needsReason, { missing: ['assignee'] });
    if (f.openPredecessors.length === 0) return null;
    if (!input.overrideDependencies) {
      const hidden = f.openPredecessors.filter((p) => !p.readable).length;
      const names = f.openPredecessors.filter((p) => p.readable).map((p) => `“${p.title}”`);
      const list = [...names, ...(hidden ? [`${hidden} task${hidden === 1 ? '' : 's'} you cannot view`] : [])].join(', ');
      return fail('INVALID_STATE', `This task waits for unfinished predecessor${f.openPredecessors.length === 1 ? '' : 's'}: ${list}.`, needsReason, {
        predecessors: f.openPredecessors.map((p) => ({ id: p.readable ? p.id : null, title: p.title, status: p.status })),
        canOverride: isLead,
      });
    }
    if (!isLead) return fail('FORBIDDEN', 'Only a lead can override dependencies.', true);
    needsReason = true;
    return null;
  };

  switch (kind) {
    case 'start': {
      if (!isAssignee && !isLead) return fail('FORBIDDEN', 'Only the assignee or a lead can start this task.', needsReason);
      const d = dependencyCheck();
      if (d) return d;
      break;
    }
    case 'reopen': {
      if (to === 'in_progress') {
        const d = dependencyCheck();
        if (d) return d;
      }
      break;
    }
    case 'submit': {
      if (!isAssignee && !isLead) return fail('FORBIDDEN', 'Only the assignee or a lead can submit this task for review.', needsReason);
      if (!t.reviewerMembershipId) return fail('INVALID_STATE', 'Choose a reviewer before submitting for review.', needsReason, { missing: ['reviewer'] });
      if (f.mandatoryOpen.length)
        return fail('INVALID_STATE', 'Complete the mandatory checklist items first.', needsReason, { checklist: f.mandatoryOpen });
      break;
    }
    case 'complete': {
      if (t.blockedAt) return fail('INVALID_STATE', 'Unblock the task before completing it.', needsReason);
      if (t.reviewerMembershipId) {
        if (t.status !== 'in_review') return fail('INVALID_STATE', 'This task needs review: submit it for review first.', needsReason);
        const eligible = me === t.reviewerMembershipId || (isLead && !isAssignee);
        if (!eligible) return fail('FORBIDDEN', 'Only the reviewer can complete a task under review.', needsReason);
      } else if (!isAssignee && !isLead) return fail('FORBIDDEN', 'Only the assignee or a lead can complete this task.', needsReason);
      if (f.mandatoryOpen.length) return fail('INVALID_STATE', 'Complete the mandatory checklist items first.', needsReason, { checklist: f.mandatoryOpen });
      if (f.requiredChildrenOpen.length || f.unacceptedCancellations.length)
        return fail('INVALID_STATE', 'Required subtasks must be Done, or Cancelled with an accepted reason.', needsReason, {
          openSubtasks: f.requiredChildrenOpen,
          unacceptedCancellations: f.unacceptedCancellations,
        });
      if (input.effectiveAt && !isLead) return fail('FORBIDDEN', 'Only a lead can record a backdated completion.', true);
      break;
    }
    case 'cancel': {
      if (!isLead && !isCreator) return fail('FORBIDDEN', 'Only a lead or the task’s creator can cancel it.', needsReason);
      if (f.openSuccessors.length && !input.successorPolicy)
        return fail('INVALID_STATE', 'Other tasks wait for this one. Choose whether to replace the dependency, remove it or keep them blocked.', needsReason, {
          successors: f.openSuccessors.map((s) => ({ id: s.readable ? s.id : null, title: s.title })),
          needsSuccessorPolicy: true,
        });
      break;
    }
    case 'restore': {
      if (!isLead && !isCreator) return fail('FORBIDDEN', 'Only a lead or the task’s creator can restore it.', needsReason);
      break;
    }
    case 'plan': {
      if (t.status === 'in_review' && to === 'in_progress') {
        if (me !== t.reviewerMembershipId && !isLead && !isAssignee) return fail('FORBIDDEN', 'Only the reviewer, the assignee or a lead can return this task.', needsReason);
      } else if (t.status === 'in_progress' && to === 'ready' && !isAssignee && !isLead) {
        return fail('FORBIDDEN', 'Only the assignee or a lead can stop work on this task.', needsReason);
      }
      break;
    }
  }
  return { ok: true, needsReason };
};

/** Execute a status change with all guards, history, audit, events, reminders and notifications. */
export const transitionTask = async (
  ctx: CommandContext,
  id: string,
  input: TransitionInput & { targetState: TaskStatus },
  opts: { skipVersion?: boolean } = {},
) => {
  const t = await lockTask(ctx, id);
  const scope = taskScope(t);
  authorizeRead(ctx, 'tasks.read', scope);
  if (!opts.skipVersion) assertVersion(ctx, t);
  if (t.archivedAt) throw new AppError('INVALID_STATE', 'Archived tasks are read-only. Restore the task first.');
  const to = input.targetState;
  const facts = await loadTransitionFacts(ctx, t);
  const ev = evaluateTransition(ctx, t, to, facts, input);
  if (!ev.ok) throw new AppError(ev.code, ev.message, { details: ev.details });
  if (ev.needsReason && !input.reason?.trim()) throw fieldFail('reason', 'REQUIRED', 'Give a reason for this change.');
  const at = ctx.app.clock.now();
  let effectiveAt: Date | null = null;
  if (input.effectiveAt) {
    if (to !== 'done') throw fieldFail('effectiveAt', 'NOT_APPLICABLE', 'An effective date applies only to completion.');
    effectiveAt = new Date(input.effectiveAt);
    if (effectiveAt.getTime() > at.getTime()) throw fieldFail('effectiveAt', 'MUST_BE_PAST', 'The effective date cannot be in the future.');
  }
  const kind = transitionKind(t.status, to);
  const patch: Partial<TaskRowDb> = { status: to };
  if (kind === 'complete') {
    Object.assign(patch, { completedAt: at, completedBy: ctx.actor.membershipId, completionEffectiveAt: effectiveAt, assigneeAtCompletion: t.assigneeMembershipId });
  }
  if (kind === 'reopen') {
    Object.assign(patch, { reopenCount: t.reopenCount + 1, completedAt: null, completedBy: null, completionEffectiveAt: null });
  }
  if (kind === 'cancel') {
    Object.assign(patch, {
      cancelledAt: at,
      cancelReason: input.reason!.trim(),
      cancellationAccepted: allowed(ctx, 'tasks.assign', scope),
      blockedAt: null,
      blockedReason: null,
      nextCheckAt: null,
    });
  }
  if (kind === 'restore') Object.assign(patch, { cancelledAt: null, cancelReason: null, cancellationAccepted: false });
  patch.baselineDueAt = baselineAfter({ baseline: t.baselineDueAt, status: to, dueAt: t.dueAt });
  const [row] = await ctx.tx.update(tasks).set({ ...patch, ...touch(ctx, tasks) }).where(eq(tasks.id, id)).returning();
  const cycle = nextCycle(t.reopenCount + 1, t.status, to);
  const eventId = newId();
  await ctx.tx.insert(taskStatusEvents).values({
    ...stamp(ctx),
    id: eventId,
    taskId: id,
    fromStatus: t.status,
    toStatus: to,
    occurredAt: at,
    effectiveAt,
    actorMembershipId: ctx.actor.membershipId,
    reason: input.reason?.trim() || null,
    cycle,
  });

  // Dependency override: explicit, audited, with a snapshot of the unfinished predecessors (T049).
  if (input.overrideDependencies && facts.openPredecessors.length) {
    await ctx.tx
      .update(taskDependencies)
      .set({ overriddenAt: at, overrideReason: input.reason!.trim(), ...touch(ctx, taskDependencies) })
      .where(inArray(taskDependencies.id, facts.openPredecessors.map((p) => p.dependencyId)));
    await audit(ctx, {
      action: 'task.dependency_overridden',
      entityType: 'task',
      entityId: id,
      projectId: t.projectId,
      reason: input.reason,
      metadata: { predecessors: facts.openPredecessors.map((p) => ({ id: p.id, status: p.status, dueAt: p.dueAt })) },
    });
  }

  // Cancelling a predecessor: the caller chose what happens to waiting tasks.
  if (kind === 'cancel' && facts.openSuccessors.length) {
    if (input.successorPolicy === 'remove_dependency') {
      await ctx.tx
        .update(taskDependencies)
        .set({ removedAt: at, removedReason: `Predecessor cancelled: ${input.reason!.trim()}`.slice(0, 2000), ...touch(ctx, taskDependencies) })
        .where(inArray(taskDependencies.id, facts.openSuccessors.map((s) => s.dependencyId)));
    } else if (input.successorPolicy === 'replace') {
      if (!input.replacementTaskId) throw fieldFail('replacementTaskId', 'REQUIRED', 'Choose the task that replaces this one.');
      const replacement = await lockTask(ctx, input.replacementTaskId);
      if (!allowed(ctx, 'tasks.read', taskScope(replacement))) throw fieldFail('replacementTaskId', 'NOT_FOUND', 'The replacement task was not found.');
      if (replacement.id === id) throw fieldFail('replacementTaskId', 'SELF', 'Choose a different task.');
      for (const s of facts.openSuccessors) {
        await ctx.tx
          .update(taskDependencies)
          .set({ removedAt: at, removedReason: 'Predecessor cancelled and replaced', ...touch(ctx, taskDependencies) })
          .where(eq(taskDependencies.id, s.dependencyId));
        const edges = await reachableEdges(ctx, s.id);
        if (s.id === replacement.id || createsCycle(edges, replacement.id, s.id))
          throw new AppError('INVALID_STATE', 'The replacement would create a dependency cycle.', { details: { successorId: s.id } });
        await ctx.tx
          .insert(taskDependencies)
          .values({ ...stamp(ctx), id: newId(), predecessorId: replacement.id, successorId: s.id })
          .onConflictDoNothing();
      }
    }
    await audit(ctx, { action: 'task.successors_resolved', entityType: 'task', entityId: id, projectId: t.projectId, metadata: { policy: input.successorPolicy, successors: facts.openSuccessors.map((s) => s.id) } });
  }

  if (kind === 'cancel' && t.blockedAt) {
    await ctx.tx
      .update(taskBlockIntervals)
      .set({ endedAt: at, resolution: 'Task cancelled', ...touch(ctx, taskBlockIntervals) })
      .where(and(eq(taskBlockIntervals.taskId, id), isNull(taskBlockIntervals.endedAt)));
  }

  await audit(ctx, {
    action: kind === 'complete' ? 'task.completed' : kind === 'reopen' ? 'task.reopened' : kind === 'cancel' ? 'task.cancelled' : 'task.status_changed',
    entityType: 'task',
    entityId: id,
    projectId: t.projectId,
    reason: input.reason,
    diff: { status: { from: t.status, to } },
    metadata: effectiveAt ? { effectiveAt: effectiveAt.toISOString() } : undefined,
  });
  await emit(ctx, {
    type: kind === 'complete' ? 'task.completed' : kind === 'reopen' ? 'task.reopened' : 'task.status_changed',
    entityType: 'task',
    entityId: id,
    revision: row!.rowVersion,
    payload: { from: t.status, to, cycle, projectId: t.projectId },
  });

  await indexTask(ctx, row!);

  // Side effects of closing: future reminders are cancelled; "after completion" rules schedule the next one.
  if (to === 'done' || to === 'cancelled') {
    await dismissTaskReminders(ctx, id, to === 'done' ? 'completed' : 'cancelled');
    await onRecurringTaskClosed(ctx, row!);
  }

  const title = t.title;
  if (kind === 'submit' && t.reviewerMembershipId)
    await notify(ctx.tx, {
      workspaceId: t.workspaceId,
      recipientMembershipIds: [t.reviewerMembershipId],
      eventType: 'task.review_requested',
      eventKey: `task.review_requested:${eventId}`,
      kind: 'review_request',
      title: `Review requested: ${title}`,
      entityType: 'task',
      entityId: id,
      projectId: t.projectId,
      actorMembershipId: ctx.actor.membershipId,
      at,
    });
  if (t.status === 'in_review' && to === 'in_progress' && t.assigneeMembershipId)
    await notify(ctx.tx, {
      workspaceId: t.workspaceId,
      recipientMembershipIds: [t.assigneeMembershipId],
      eventType: 'task.changes_requested',
      eventKey: `task.changes_requested:${eventId}`,
      kind: 'general',
      title: `Changes requested: ${title}`,
      excerpt: input.reason ?? null,
      entityType: 'task',
      entityId: id,
      projectId: t.projectId,
      actorMembershipId: ctx.actor.membershipId,
      at,
    });
  if ((kind === 'complete' || kind === 'reopen' || kind === 'cancel') && t.assigneeMembershipId)
    await notify(ctx.tx, {
      workspaceId: t.workspaceId,
      recipientMembershipIds: [t.assigneeMembershipId],
      eventType: `task.${kind === 'complete' ? 'completed' : kind === 'reopen' ? 'reopened' : 'cancelled'}`,
      eventKey: `task.${kind}:${eventId}`,
      kind: 'general',
      title: `${kind === 'complete' ? 'Completed' : kind === 'reopen' ? 'Reopened' : 'Cancelled'}: ${title}`,
      excerpt: kind === 'complete' ? null : (input.reason ?? null),
      entityType: 'task',
      entityId: id,
      projectId: t.projectId,
      actorMembershipId: ctx.actor.membershipId,
      at,
    });
  return id;
};

/** Edges reachable downstream from a task (for cycle checks without loading the whole graph). */
export const reachableEdges = async (ctx: QueryContext | CommandContext, fromTaskId: string) => {
  const res = await dbOf(ctx).execute<{ predecessor_id: string; successor_id: string }>(sql`
    WITH RECURSIVE reach(predecessor_id, successor_id) AS (
      SELECT predecessor_id, successor_id FROM task_dependencies
      WHERE workspace_id = ${ctx.actor.workspaceId} AND predecessor_id = ${fromTaskId} AND removed_at IS NULL
      UNION
      SELECT d.predecessor_id, d.successor_id FROM task_dependencies d
      JOIN reach r ON d.predecessor_id = r.successor_id
      WHERE d.workspace_id = ${ctx.actor.workspaceId} AND d.removed_at IS NULL
    )
    SELECT predecessor_id, successor_id FROM reach LIMIT 20000`);
  return res.rows.map((r) => ({ predecessorId: r.predecessor_id, successorId: r.successor_id }));
};
