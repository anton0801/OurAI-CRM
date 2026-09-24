import { and, asc, count, desc, eq, gt, ilike, inArray, isNull, lte, ne, or, sql } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import {
  comments,
  memberships,
  personalReminders,
  projects,
  savedViews,
  taskChecklistItems,
  taskDependencies,
  taskDueRevisions,
  tasks,
  taskStatusEvents,
  taskBlockIntervals,
  timeEntries,
  timeSheetSubmissions,
  users,
  workspaces,
} from '@castlane/database';
import { AppError, isIsoDate, isUuid, newId, normalizeEmail, notFound, TASK_PRIORITIES, zonedDateTimeToUtc } from '@castlane/domain';
import { allowed, authorizeObject, authorizeRead, requirePermission, scopePredicate, whereAll } from '../core/access';
import { defineArchiveHandler } from '../core/archive-registry';
import { audit } from '../core/audit';
import { dbOf, type CommandContext, type QueryContext } from '../core/context';
import { emit } from '../core/events';
import { defineExportDataset } from '../core/export-registry';
import { defineImportDataset, type ImportIssue } from '../core/import-registry';
import { defineLookup, likePattern } from '../core/lookup-registry';
import { loadMemberRefs, refOrUnknown } from '../core/members';
import { defineResponsibilityProvider } from '../core/responsibility-registry';
import { stamp, touch } from '../core/rows';
import { defineLinkAccess } from '../media/link-access';
import { defineCommentParent } from './comments';
import { OPEN_TASK_STATUSES } from './rules/task-status';
import { createTask, updateTask } from './tasks';
import { transitionTask } from './task-transitions';
import { timeVisibilitySql } from './time';
import { indexTask, loadTask, lockTask, memberCan, projectNames, TASK_SCOPE_COLUMNS, taskScope, type TaskRowDb } from './shared';

// ——— Pickers, file links, comments ———

defineLookup({
  type: 'task',
  async search(ctx, input) {
    requirePermission(ctx, 'tasks.read');
    const rows = await dbOf(ctx)
      .select()
      .from(tasks)
      .where(
        whereAll(
          eq(tasks.workspaceId, ctx.actor.workspaceId),
          isNull(tasks.deletedAt),
          scopePredicate(ctx, 'tasks.read', TASK_SCOPE_COLUMNS),
          input.ids?.length ? inArray(tasks.id, input.ids) : undefined,
          !input.ids?.length && !input.includeArchived ? isNull(tasks.archivedAt) : undefined,
          input.status?.length ? inArray(tasks.status, input.status as never[]) : undefined,
          input.projectId ? eq(tasks.projectId, input.projectId) : undefined,
          input.accountId ? eq(tasks.accountId, input.accountId) : undefined,
          input.parentId ? eq(tasks.parentTaskId, input.parentId) : undefined,
          input.q ? ilike(tasks.title, likePattern(input.q)) : undefined,
        ),
      )
      .orderBy(desc(sql`(${tasks.status} IN ('draft','backlog','ready','in_progress','in_review'))`), asc(tasks.title))
      .limit(input.ids?.length ? Math.max(input.ids.length, input.limit) : input.limit);
    const names = await projectNames(dbOf(ctx), ctx.actor.workspaceId, rows.map((r) => r.projectId));
    return rows.map((r) => ({
      id: r.id,
      label: r.title,
      sublabel: names.get(r.projectId)?.name ?? null,
      status: r.status,
      projectId: r.projectId,
      archived: !!r.archivedAt,
    }));
  },
});

// Task attachments are readable by whoever can read the task (a contractor sees the brief's files, not the project).
defineLinkAccess('task', {
  permission: 'tasks.read',
  scope: async (ctx, id) => {
    const [t] = await dbOf(ctx).select().from(tasks).where(and(eq(tasks.workspaceId, ctx.actor.workspaceId), eq(tasks.id, id)));
    return t && !t.deletedAt ? { ...taskScope(t), label: t.title, href: `/w/${t.workspaceId}/tasks/${t.id}` } : null;
  },
});

defineCommentParent('task', {
  readPermission: 'tasks.read',
  commentPermission: 'tasks.edit',
  moderatePermission: 'tasks.assign',
  scope: async (ctx, id) => {
    const [t] = await dbOf(ctx).select().from(tasks).where(and(eq(tasks.workspaceId, ctx.actor.workspaceId), eq(tasks.id, id)));
    if (!t || t.deletedAt) return null;
    return { ...taskScope(t), title: t.title, watcherMembershipIds: [t.assigneeMembershipId, t.reviewerMembershipId, ...t.followerMembershipIds] };
  },
});

// ——— Archive / trash ———

const hasDependents = async (ctx: QueryContext | CommandContext, t: TaskRowDb) => {
  const db = dbOf(ctx);
  const [[te], [deps], [children], [cm]] = [
    await db.select({ n: count() }).from(timeEntries).where(eq(timeEntries.taskId, t.id)),
    await db.select({ n: count() }).from(taskDependencies).where(and(or(eq(taskDependencies.predecessorId, t.id), eq(taskDependencies.successorId, t.id)), isNull(taskDependencies.removedAt))),
    await db.select({ n: count() }).from(tasks).where(and(eq(tasks.parentTaskId, t.id), isNull(tasks.deletedAt))),
    await db.select({ n: count() }).from(comments).where(and(eq(comments.parentType, 'task'), eq(comments.parentId, t.id), isNull(comments.deletedAt))),
  ];
  return { time: Number(te?.n ?? 0), deps: Number(deps?.n ?? 0), children: Number(children?.n ?? 0), comments: Number(cm?.n ?? 0) };
};

defineArchiveHandler({
  entityType: 'task',
  label: 'Task',
  async preview(ctx, id) {
    const t = await loadTask(ctx, id);
    authorizeObject(ctx, 'tasks.assign', taskScope(t), 'tasks.read');
    const d = await hasDependents(ctx, t);
    const items = [
      { kind: 'open_task', label: 'The task is still open', count: t.status === 'done' || t.status === 'cancelled' ? 0 : 1, blocking: true, resolution: 'Complete or cancel the task before archiving it.' },
      { kind: 'open_subtasks', label: 'Subtasks', count: d.children, blocking: false, resolution: 'Subtasks keep their own status.' },
      { kind: 'time_entries', label: 'Recorded time entries (kept)', count: d.time, blocking: false },
    ].filter((i) => i.count > 0);
    return { title: t.title, rowVersion: t.rowVersion, items };
  },
  async archive(ctx, id, input) {
    const t = await lockTask(ctx, id);
    authorizeObject(ctx, 'tasks.assign', taskScope(t), 'tasks.read');
    if (t.status !== 'done' && t.status !== 'cancelled') throw new AppError('INVALID_STATE', 'Complete or cancel the task before archiving it.');
    if (t.archivedAt) return;
    const [row] = await ctx.tx
      .update(tasks)
      .set({ archivedAt: ctx.app.clock.now(), archivedBy: ctx.actor.userId, archiveReason: input.reason ?? null, ...touch(ctx, tasks) })
      .where(eq(tasks.id, id))
      .returning();
    await audit(ctx, { action: 'task.archived', entityType: 'task', entityId: id, projectId: t.projectId, reason: input.reason ?? null });
    await emit(ctx, { type: 'task.archived', entityType: 'task', entityId: id, revision: row!.rowVersion });
    await indexTask(ctx, row!);
  },
  async restorePreview(ctx, id) {
    const t = await loadTask(ctx, id, { includeTrashed: true });
    authorizeObject(ctx, 'tasks.assign', taskScope(t), 'tasks.read');
    const [p] = await dbOf(ctx).select({ status: projects.status }).from(projects).where(eq(projects.id, t.projectId));
    return {
      title: t.title,
      items: p?.status === 'archived' ? [{ kind: 'archived_project', label: 'The project is archived', count: 1, blocking: true, resolution: 'Restore the project first.' }] : [],
    };
  },
  async restore(ctx, id) {
    const t = await lockTask(ctx, id, { includeTrashed: true });
    authorizeObject(ctx, 'tasks.assign', taskScope(t), 'tasks.read');
    const [p] = await ctx.tx.select({ status: projects.status }).from(projects).where(eq(projects.id, t.projectId));
    if (p?.status === 'archived') throw new AppError('INVALID_STATE', 'Restore the project first.');
    const [row] = await ctx.tx
      .update(tasks)
      .set({ archivedAt: null, archivedBy: null, archiveReason: null, deletedAt: null, deletedBy: null, purgeAfter: null, ...touch(ctx, tasks) })
      .where(eq(tasks.id, id))
      .returning();
    await audit(ctx, { action: 'task.restored', entityType: 'task', entityId: id, projectId: t.projectId });
    await emit(ctx, { type: 'task.restored', entityType: 'task', entityId: id, revision: row!.rowVersion });
    await indexTask(ctx, row!);
  },
  /** Only Draft tasks without time, dependencies, subtasks or comments may go to the trash. */
  async trash(ctx, id, reason) {
    const t = await lockTask(ctx, id);
    const scope = taskScope(t);
    authorizeRead(ctx, 'tasks.read', scope);
    if (!allowed(ctx, 'tasks.assign', scope) && t.createdBy !== ctx.actor.userId) throw new AppError('FORBIDDEN', 'Only a lead or the creator can move this draft to the trash.');
    if (t.status !== 'draft') throw new AppError('INVALID_STATE', 'Only draft tasks can be moved to the trash. Cancel or archive other tasks.');
    const d = await hasDependents(ctx, t);
    if (d.time || d.deps || d.children || d.comments)
      throw new AppError('INVALID_STATE', 'This draft already has time, dependencies, subtasks or comments. Cancel it instead.', { details: d });
    const at = ctx.app.clock.now();
    const [row] = await ctx.tx
      .update(tasks)
      .set({ deletedAt: at, deletedBy: ctx.actor.userId, purgeAfter: new Date(at.getTime() + 30 * 86_400_000), ...touch(ctx, tasks) })
      .where(eq(tasks.id, id))
      .returning();
    await ctx.tx.update(personalReminders).set({ dismissedAt: at, dismissedReason: 'trashed' }).where(and(eq(personalReminders.entityType, 'task'), eq(personalReminders.entityId, id), isNull(personalReminders.dismissedAt)));
    await audit(ctx, { action: 'task.trashed', entityType: 'task', entityId: id, projectId: t.projectId, reason });
    await emit(ctx, { type: 'task.trashed', entityType: 'task', entityId: id, revision: row!.rowVersion });
    await indexTask(ctx, row!);
  },
  async purge(ctx, id) {
    const t = await lockTask(ctx, id, { includeTrashed: true });
    if (!t.deletedAt || t.status !== 'draft') throw new AppError('INVALID_STATE', 'Only trashed drafts can be purged.');
    await ctx.tx.delete(taskChecklistItems).where(eq(taskChecklistItems.taskId, id));
    await ctx.tx.delete(taskStatusEvents).where(eq(taskStatusEvents.taskId, id));
    await ctx.tx.delete(taskDueRevisions).where(eq(taskDueRevisions.taskId, id));
    await ctx.tx.delete(taskBlockIntervals).where(eq(taskBlockIntervals.taskId, id));
    await ctx.tx.delete(taskDependencies).where(or(eq(taskDependencies.predecessorId, id), eq(taskDependencies.successorId, id)));
    await ctx.tx.delete(personalReminders).where(and(eq(personalReminders.entityType, 'task'), eq(personalReminders.entityId, id)));
    await ctx.tx.delete(tasks).where(eq(tasks.id, id));
    await audit(ctx, { action: 'task.purged', entityType: 'task', entityId: id, projectId: t.projectId });
  },
});

// ——— Responsibilities (F12: deactivating a member lists and transfers open work) ———

const openTasksOf = async (ctx: QueryContext | CommandContext, column: PgColumn, membershipId: string) =>
  dbOf(ctx)
    .select()
    .from(tasks)
    .where(and(eq(tasks.workspaceId, ctx.actor.workspaceId), eq(column, membershipId), inArray(tasks.status, [...OPEN_TASK_STATUSES]), isNull(tasks.deletedAt)))
    .orderBy(asc(tasks.dueAt));

const systemCtx = (ctx: CommandContext): CommandContext => ({ ...ctx, request: { ...ctx.request, expectedVersion: undefined } });

defineResponsibilityProvider({
  kind: 'tasks.assignee',
  label: 'Assigned tasks',
  unassignedBehaviour: 'Left unassigned in the project’s task list; work in progress moves back to Ready.',
  async list(ctx, membershipId) {
    const rows = await openTasksOf(ctx, tasks.assigneeMembershipId, membershipId);
    return rows.map((t) => ({ kind: 'tasks.assignee', entityType: 'task', entityId: t.id, title: t.title, projectId: t.projectId, dueAt: t.dueAt?.toISOString() ?? null, requiresSuccessor: false }));
  },
  async transfer(ctx, from, resolutions) {
    for (const r of resolutions) {
      const t = await lockTask(ctx, r.entityId);
      if (t.assigneeMembershipId !== from || !OPEN_TASK_STATUSES.includes(t.status)) continue;
      const c = systemCtx(ctx);
      // Without a successor, work in progress goes back to Ready (an unassigned task cannot be in progress).
      if (!r.successorMembershipId && t.status === 'in_review')
        await transitionTask(c, t.id, { targetState: 'in_progress', reason: 'The assignee was deactivated.' }, { skipVersion: true });
      if (!r.successorMembershipId && (t.status === 'in_review' || t.status === 'in_progress'))
        await transitionTask(c, t.id, { targetState: 'ready', reason: 'The assignee was deactivated.' }, { skipVersion: true });
      const [fresh] = await ctx.tx.select({ rowVersion: tasks.rowVersion }).from(tasks).where(eq(tasks.id, t.id));
      await updateTask({ ...c, request: { ...c.request, expectedVersion: fresh!.rowVersion } }, t.id, { assigneeMembershipId: r.successorMembershipId });
    }
  },
});

defineResponsibilityProvider({
  kind: 'tasks.reviewer',
  label: 'Tasks to review',
  unassignedBehaviour: 'The reviewer is cleared; tasks waiting for review return to In Progress until a new reviewer is chosen.',
  async list(ctx, membershipId) {
    const rows = await openTasksOf(ctx, tasks.reviewerMembershipId, membershipId);
    return rows.map((t) => ({ kind: 'tasks.reviewer', entityType: 'task', entityId: t.id, title: t.title, projectId: t.projectId, dueAt: t.dueAt?.toISOString() ?? null, requiresSuccessor: t.status === 'in_review' }));
  },
  async transfer(ctx, from, resolutions) {
    for (const r of resolutions) {
      const t = await lockTask(ctx, r.entityId);
      if (t.reviewerMembershipId !== from || !OPEN_TASK_STATUSES.includes(t.status)) continue;
      const c = systemCtx(ctx);
      if (!r.successorMembershipId && t.status === 'in_review')
        await transitionTask(c, t.id, { targetState: 'in_progress', reason: 'The reviewer was deactivated.' }, { skipVersion: true });
      const [fresh] = await ctx.tx.select({ rowVersion: tasks.rowVersion }).from(tasks).where(eq(tasks.id, t.id));
      await updateTask({ ...c, request: { ...c.request, expectedVersion: fresh!.rowVersion } }, t.id, { reviewerMembershipId: r.successorMembershipId });
    }
  },
});

defineResponsibilityProvider({
  kind: 'time.sheet_approvals',
  label: 'Time sheets awaiting approval',
  unassignedBehaviour: 'Any member with time approval rights in the projects can approve them.',
  async list(ctx, membershipId) {
    const rows = await dbOf(ctx)
      .select({ s: timeSheetSubmissions, name: memberships.displayNameSnapshot })
      .from(timeSheetSubmissions)
      .innerJoin(memberships, eq(memberships.id, timeSheetSubmissions.membershipId))
      .where(and(eq(timeSheetSubmissions.workspaceId, ctx.actor.workspaceId), eq(timeSheetSubmissions.approverMembershipId, membershipId), eq(timeSheetSubmissions.state, 'submitted')));
    return rows.map(({ s, name }) => ({ kind: 'time.sheet_approvals', entityType: 'time_sheet', entityId: s.id, title: `Time sheet of ${name}, week of ${s.weekStart}`, projectId: null, dueAt: null, requiresSuccessor: false }));
  },
  async transfer(ctx, from, resolutions) {
    for (const r of resolutions) {
      const [s] = await ctx.tx.select().from(timeSheetSubmissions).where(and(eq(timeSheetSubmissions.id, r.entityId), eq(timeSheetSubmissions.approverMembershipId, from))).for('update');
      if (!s) continue;
      await ctx.tx.update(timeSheetSubmissions).set({ approverMembershipId: r.successorMembershipId, ...touch(ctx, timeSheetSubmissions) }).where(eq(timeSheetSubmissions.id, s.id));
      await audit(ctx, { action: 'time.sheet_approver_transferred', entityType: 'time_sheet', entityId: s.id, metadata: { from, to: r.successorMembershipId } });
    }
  },
});

defineResponsibilityProvider({
  kind: 'time.running_timer',
  label: 'Running timer',
  unassignedBehaviour: 'Closed at the time of deactivation and marked Needs Review (the time is not changed afterwards).',
  async list(ctx, membershipId) {
    const rows = await dbOf(ctx)
      .select({ e: timeEntries, title: tasks.title })
      .from(timeEntries)
      .innerJoin(tasks, eq(tasks.id, timeEntries.taskId))
      .where(and(eq(timeEntries.workspaceId, ctx.actor.workspaceId), eq(timeEntries.membershipId, membershipId), eq(timeEntries.state, 'running')));
    return rows.map(({ e, title }) => ({ kind: 'time.running_timer', entityType: 'time_entry', entityId: e.id, title: `Timer on ${title}`, projectId: e.projectId, dueAt: null, requiresSuccessor: false }));
  },
  async transfer(ctx, from, resolutions) {
    const at = ctx.app.clock.now();
    for (const r of resolutions) {
      const [e] = await ctx.tx.select().from(timeEntries).where(and(eq(timeEntries.id, r.entityId), eq(timeEntries.membershipId, from), eq(timeEntries.state, 'running'))).for('update');
      if (!e) continue;
      const seconds = Math.min(24 * 3600, Math.max(1, Math.floor((at.getTime() - e.startedAt!.getTime()) / 1000)));
      await ctx.tx
        .update(timeEntries)
        .set({
          state: 'needs_review',
          endedAt: new Date(e.startedAt!.getTime() + seconds * 1000),
          durationSeconds: seconds,
          needsReviewReason: 'Closed when the member was deactivated.',
          closedByMembershipId: ctx.actor.membershipId,
          closeReason: 'Member deactivated',
          ...touch(ctx, timeEntries),
        })
        .where(eq(timeEntries.id, e.id));
      await audit(ctx, { action: 'time.timer_closed', entityType: 'time_entry', entityId: e.id, projectId: e.projectId, reason: 'Member deactivated' });
    }
  },
});

// ——— Import Center dataset ———

export interface TaskImportRow {
  title: string;
  projectId: string;
  description: string | null;
  status: 'draft' | 'backlog' | 'ready';
  priority: (typeof TASK_PRIORITIES)[number];
  assigneeMembershipId: string | null;
  reviewerMembershipId: string | null;
  startAt: string | null;
  due: { kind: 'date'; date: string; timezone: string } | { kind: 'datetime'; at: string } | null;
  estimateMinutes: number | null;
  tags: string[];
}

const resolveMemberRef = async (ctx: QueryContext, value: unknown): Promise<{ id: string | null; error?: string }> => {
  if (value === null || value === undefined || value === '') return { id: null };
  const v = String(value).trim();
  const db = dbOf(ctx);
  if (isUuid(v)) {
    const [m] = await db.select({ id: memberships.id, status: memberships.status }).from(memberships).where(and(eq(memberships.workspaceId, ctx.actor.workspaceId), eq(memberships.id, v)));
    return m ? (m.status === 'active' ? { id: m.id } : { id: null, error: 'The member is not active.' }) : { id: null, error: 'Unknown member.' };
  }
  const [m] = await db
    .select({ id: memberships.id, status: memberships.status })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.workspaceId, ctx.actor.workspaceId), eq(users.normalizedEmail, normalizeEmail(v))));
  return m ? (m.status === 'active' ? { id: m.id } : { id: null, error: 'The member is not active.' }) : { id: null, error: 'Unknown member. Use the member’s e-mail or id.' };
};

defineImportDataset<TaskImportRow>({
  key: 'tasks',
  label: 'Tasks',
  permission: 'tasks.create',
  duplicatePolicies: ['skip', 'error'],
  columns: [
    { key: 'title', label: 'Title', type: 'text', required: true, aliases: ['task', 'name'] },
    { key: 'project', label: 'Project', type: 'reference', required: true, aliases: ['project id', 'project name'], description: 'Project id, or the exact name of one project you can access.' },
    { key: 'description', label: 'Description', type: 'long_text' },
    { key: 'status', label: 'Status', type: 'enum', enumValues: ['draft', 'backlog', 'ready'] },
    { key: 'priority', label: 'Priority', type: 'enum', enumValues: TASK_PRIORITIES },
    { key: 'assignee', label: 'Assignee', type: 'reference', aliases: ['assignee email', 'owner'], description: 'Member e-mail or id; unknown members are errors.' },
    { key: 'reviewer', label: 'Reviewer', type: 'reference', aliases: ['reviewer email'] },
    { key: 'start_date', label: 'Start Date', type: 'date' },
    { key: 'due_date', label: 'Due Date', type: 'date', description: 'Due by the end of this day in the due time zone.' },
    { key: 'due_at', label: 'Due At', type: 'datetime', description: 'Exact deadline (use either Due Date or Due At).' },
    { key: 'due_timezone', label: 'Due Time Zone', type: 'timezone' },
    { key: 'estimate_minutes', label: 'Estimate (minutes)', type: 'integer' },
    { key: 'tags', label: 'Tags', type: 'tags' },
  ],
  async validate(ctx, row, opts) {
    const errors: ImportIssue[] = [];
    const warnings: ImportIssue[] = [];
    const title = String(row.title ?? '').trim();
    if (title.length < 3 || title.length > 200) errors.push({ field: 'title', code: 'LENGTH', message: 'Use 3–200 characters.' });
    // Project: stable id or one unambiguous name in the actor's scope — never auto-created.
    let projectId: string | null = null;
    const pv = String(row.project ?? '').trim();
    const scopeProjects = scopePredicate(ctx, 'tasks.create', { projectId: projects.id });
    const found = await dbOf(ctx)
      .select({ id: projects.id, status: projects.status })
      .from(projects)
      .where(whereAll(eq(projects.workspaceId, ctx.actor.workspaceId), isUuid(pv) ? eq(projects.id, pv) : sql`lower(${projects.name}) = lower(${pv})`, scopeProjects))
      .limit(3);
    if (!pv) errors.push({ field: 'project', code: 'REQUIRED', message: 'The project is required.' });
    else if (found.length === 0) errors.push({ field: 'project', code: 'UNKNOWN', message: 'Unknown project, or you cannot create tasks there.' });
    else if (found.length > 1) errors.push({ field: 'project', code: 'AMBIGUOUS', message: 'Several projects have this name. Use the project id.' });
    else if (found[0]!.status === 'archived') errors.push({ field: 'project', code: 'ARCHIVED', message: 'The project is archived.' });
    else projectId = found[0]!.id;
    const assignee = await resolveMemberRef(ctx, row.assignee);
    if (assignee.error) errors.push({ field: 'assignee', code: 'UNKNOWN', message: assignee.error });
    const reviewer = await resolveMemberRef(ctx, row.reviewer);
    if (reviewer.error) errors.push({ field: 'reviewer', code: 'UNKNOWN', message: reviewer.error });
    if (assignee.id && assignee.id === reviewer.id) errors.push({ field: 'reviewer', code: 'SAME_AS_ASSIGNEE', message: 'The reviewer must differ from the assignee.' });
    if (projectId && (assignee.id || reviewer.id) && !allowed(ctx, 'tasks.assign', { projectId })) errors.push({ field: 'assignee', code: 'FORBIDDEN', message: 'You cannot assign tasks in this project.' });
    for (const [field, m] of [['assignee', assignee.id], ['reviewer', reviewer.id]] as const)
      if (m && projectId && !(await memberCan(ctx.app.db, ctx.actor.workspaceId, m, 'tasks.read', { projectId, assignedMembershipIds: [m] }, ctx.app.clock.now())).ok)
        errors.push({ field, code: 'NO_ACCESS', message: 'This member cannot access the project.' });
    const [ws] = await dbOf(ctx).select({ tz: workspaces.timezone }).from(workspaces).where(eq(workspaces.id, ctx.actor.workspaceId));
    const tz = row.due_timezone ? String(row.due_timezone) : (ws?.tz ?? 'UTC');
    let due: TaskImportRow['due'] = null;
    if (row.due_date && row.due_at) errors.push({ field: 'due_at', code: 'BOTH', message: 'Use either Due Date or Due At.' });
    else if (row.due_date) {
      if (!isIsoDate(row.due_date)) errors.push({ field: 'due_date', code: 'INVALID', message: 'Use YYYY-MM-DD.' });
      else due = { kind: 'date', date: String(row.due_date), timezone: tz };
    } else if (row.due_at) due = { kind: 'datetime', at: String(row.due_at) };
    let startAt: string | null = null;
    if (row.start_date) {
      if (!isIsoDate(row.start_date)) errors.push({ field: 'start_date', code: 'INVALID', message: 'Use YYYY-MM-DD.' });
      else startAt = zonedDateTimeToUtc(String(row.start_date), '00:00', tz).utc.toISOString();
    }
    const estimate = row.estimate_minutes === undefined || row.estimate_minutes === null || row.estimate_minutes === '' ? null : Number(row.estimate_minutes);
    if (estimate !== null && (!Number.isInteger(estimate) || estimate < 0 || estimate > 100_000)) errors.push({ field: 'estimate_minutes', code: 'INVALID', message: 'Enter whole minutes (0–100000).' });
    if (estimate === null) warnings.push({ field: 'estimate_minutes', code: 'UNESTIMATED', message: 'No estimate: the task counts as unestimated in Workload, not as zero hours.' });
    const status = (row.status ? String(row.status) : 'backlog') as TaskImportRow['status'];
    const priority = (row.priority ? String(row.priority) : 'normal') as TaskImportRow['priority'];
    const tags = Array.isArray(row.tags) ? (row.tags as string[]) : row.tags ? String(row.tags).split(/[,;]/).map((t) => t.trim()).filter(Boolean) : [];
    // Within-file duplicate key: same project, title and deadline.
    const dedupeKey = projectId ? `${projectId}|${title.toLowerCase()}|${row.due_date ?? row.due_at ?? ''}` : undefined;
    let action: 'create' | 'skip' = 'create';
    if (projectId && !errors.length) {
      const [dup] = await dbOf(ctx)
        .select({ id: tasks.id })
        .from(tasks)
        .where(and(eq(tasks.workspaceId, ctx.actor.workspaceId), eq(tasks.projectId, projectId), sql`lower(${tasks.title}) = lower(${title})`, isNull(tasks.deletedAt), inArray(tasks.status, [...OPEN_TASK_STATUSES])))
        .limit(1);
      if (dup) {
        if (opts.duplicatePolicy === 'error') errors.push({ field: 'title', code: 'DUPLICATE', message: 'An open task with this title already exists in the project.' });
        else {
          action = 'skip';
          warnings.push({ field: 'title', code: 'DUPLICATE_SKIPPED', message: 'An open task with this title already exists; the row is skipped.' });
        }
      }
    }
    return {
      action,
      errors,
      warnings,
      dedupeKey,
      normalized: {
        title,
        projectId: projectId ?? '',
        description: row.description ? String(row.description) : null,
        status,
        priority,
        assigneeMembershipId: assignee.id,
        reviewerMembershipId: reviewer.id,
        startAt,
        due,
        estimateMinutes: estimate,
        tags,
      },
    };
  },
  async apply(ctx, row) {
    return createTask(ctx, { ...row, due: row.due ?? null } as never, { source: 'import' });
  },
  /** Undo moves an untouched imported task to the trash; anything that happened since blocks the undo. */
  async undo(ctx, entityId) {
    const t = await lockTask(ctx, entityId);
    const d = await hasDependents(ctx, t);
    const [events] = await ctx.tx.select({ n: count() }).from(taskStatusEvents).where(eq(taskStatusEvents.taskId, t.id));
    if (t.source !== 'import' || t.rowVersion > 1 || Number(events?.n ?? 0) > 1 || d.time || d.deps || d.children || d.comments)
      throw new AppError('INVALID_STATE', 'This task changed after the import.', { details: { taskId: t.id, title: t.title, ...d } });
    const at = ctx.app.clock.now();
    const [row] = await ctx.tx.update(tasks).set({ deletedAt: at, deletedBy: ctx.actor.userId, purgeAfter: new Date(at.getTime() + 30 * 86_400_000), ...touch(ctx, tasks) }).where(eq(tasks.id, t.id)).returning();
    await audit(ctx, { action: 'task.import_undone', entityType: 'task', entityId: t.id, projectId: t.projectId });
    await indexTask(ctx, row!);
  },
});

// ——— Export Center datasets ———

const cell = (v: unknown): string | number | boolean | null => (v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : (v as string | number | boolean));

defineExportDataset({
  key: 'tasks',
  label: 'Tasks',
  permission: 'exports.create',
  classification: 'normal',
  columns: [
    { key: 'id', label: 'Task ID', type: 'id', default: true },
    { key: 'title', label: 'Title', type: 'text', default: true },
    { key: 'project', label: 'Project', type: 'text', default: true },
    { key: 'status', label: 'Status', type: 'text', default: true },
    { key: 'priority', label: 'Priority', type: 'text', default: true },
    { key: 'assignee', label: 'Assignee', type: 'text', default: true },
    { key: 'reviewer', label: 'Reviewer', type: 'text' },
    { key: 'start_at', label: 'Start', type: 'datetime' },
    { key: 'due_at', label: 'Due At', type: 'datetime', default: true },
    { key: 'due_date', label: 'Due Date (date-only)', type: 'date' },
    { key: 'due_timezone', label: 'Due Time Zone', type: 'text' },
    { key: 'baseline_due_at', label: 'Baseline Due', type: 'datetime' },
    { key: 'estimate_minutes', label: 'Estimate (minutes)', type: 'integer', default: true },
    { key: 'blocked_reason', label: 'Blocked Reason', type: 'text' },
    { key: 'tags', label: 'Tags', type: 'text' },
    { key: 'completed_at', label: 'Completed At', type: 'datetime' },
    { key: 'reopen_count', label: 'Reopened', type: 'integer' },
    { key: 'created_at', label: 'Created At', type: 'datetime' },
  ],
  filters: [
    { key: 'projectId', label: 'Project', type: 'reference', lookup: 'project' },
    { key: 'status', label: 'Status', type: 'enum', enumValues: ['draft', 'backlog', 'ready', 'in_progress', 'in_review', 'done', 'cancelled'] },
    { key: 'assignee', label: 'Assignee', type: 'reference' },
  ],
  async *rows(ctx, input) {
    requirePermission(ctx, 'tasks.read');
    let after: string | null = null;
    for (;;) {
      const f = input.filters as { projectId?: string; status?: string; assignee?: string };
      const rows: TaskRowDb[] = await dbOf(ctx)
        .select()
        .from(tasks)
        .where(
          whereAll(
            eq(tasks.workspaceId, ctx.actor.workspaceId),
            isNull(tasks.deletedAt),
            lte(tasks.createdAt, input.boundAt),
            scopePredicate(ctx, 'tasks.read', TASK_SCOPE_COLUMNS),
            f.projectId ? eq(tasks.projectId, f.projectId) : undefined,
            f.status ? eq(tasks.status, f.status as never) : undefined,
            f.assignee ? eq(tasks.assigneeMembershipId, f.assignee) : undefined,
            after ? gt(tasks.id, after) : undefined,
          ),
        )
        .orderBy(asc(tasks.id))
        .limit(500);
      if (rows.length === 0) return;
      const names = await projectNames(dbOf(ctx), ctx.actor.workspaceId, rows.map((r) => r.projectId));
      const refs = await loadMemberRefs(dbOf(ctx), ctx.actor.workspaceId, rows.flatMap((r) => [r.assigneeMembershipId, r.reviewerMembershipId]));
      for (const r of rows)
        yield {
          id: r.id,
          title: r.title,
          project: names.get(r.projectId)?.name ?? null,
          status: r.status,
          priority: r.priority,
          assignee: refOrUnknown(refs, r.assigneeMembershipId)?.displayName ?? null,
          reviewer: refOrUnknown(refs, r.reviewerMembershipId)?.displayName ?? null,
          start_at: cell(r.startAt),
          due_at: cell(r.dueAt),
          due_date: r.dueDate,
          due_timezone: r.dueTimezone,
          baseline_due_at: cell(r.baselineDueAt),
          estimate_minutes: r.estimateMinutes,
          blocked_reason: r.blockedReason,
          tags: r.tags.join(', '),
          completed_at: cell(r.completedAt),
          reopen_count: r.reopenCount,
          created_at: cell(r.createdAt),
        };
      after = rows[rows.length - 1]!.id;
    }
  },
});

defineExportDataset({
  key: 'time_entries',
  label: 'Time Entries',
  permission: 'exports.create',
  classification: 'private',
  columns: [
    { key: 'id', label: 'Entry ID', type: 'id', default: true },
    { key: 'member', label: 'Member', type: 'text', default: true },
    { key: 'work_date', label: 'Date', type: 'date', default: true },
    { key: 'project', label: 'Project', type: 'text', default: true },
    { key: 'task', label: 'Task', type: 'text', default: true },
    { key: 'started_at', label: 'Start', type: 'datetime' },
    { key: 'ended_at', label: 'End', type: 'datetime' },
    { key: 'duration_minutes', label: 'Duration (minutes)', type: 'integer', default: true },
    { key: 'source', label: 'Source', type: 'text' },
    { key: 'state', label: 'State', type: 'text', default: true },
    { key: 'note', label: 'Note', type: 'text' },
    { key: 'billable', label: 'Billable', type: 'boolean', permission: 'time.approve' },
    { key: 'approved_at', label: 'Approved At', type: 'datetime' },
  ],
  filters: [
    { key: 'from', label: 'From', type: 'date' },
    { key: 'to', label: 'To', type: 'date' },
    { key: 'membershipId', label: 'Member', type: 'reference' },
    { key: 'projectId', label: 'Project', type: 'reference', lookup: 'project' },
  ],
  async *rows(ctx, input) {
    const visible = timeVisibilitySql(ctx);
    const f = input.filters as { from?: string; to?: string; membershipId?: string; projectId?: string };
    let after: string | null = null;
    for (;;) {
      const rows = await dbOf(ctx)
        .select({ e: timeEntries, title: tasks.title })
        .from(timeEntries)
        .innerJoin(tasks, eq(tasks.id, timeEntries.taskId))
        .where(
          whereAll(
            eq(timeEntries.workspaceId, ctx.actor.workspaceId),
            ne(timeEntries.state, 'running'),
            isNull(timeEntries.supersededAt),
            lte(timeEntries.createdAt, input.boundAt),
            visible,
            f.from ? sql`${timeEntries.workDate} >= ${f.from}` : undefined,
            f.to ? sql`${timeEntries.workDate} <= ${f.to}` : undefined,
            f.membershipId ? eq(timeEntries.membershipId, f.membershipId) : undefined,
            f.projectId ? eq(timeEntries.projectId, f.projectId) : undefined,
            after ? gt(timeEntries.id, after) : undefined,
          ),
        )
        .orderBy(asc(timeEntries.id))
        .limit(500);
      if (rows.length === 0) return;
      const names = await projectNames(dbOf(ctx), ctx.actor.workspaceId, rows.map((r) => r.e.projectId));
      const refs = await loadMemberRefs(dbOf(ctx), ctx.actor.workspaceId, rows.map((r) => r.e.membershipId));
      for (const { e, title } of rows)
        yield {
          id: e.id,
          member: refOrUnknown(refs, e.membershipId)?.displayName ?? null,
          work_date: e.workDate,
          project: names.get(e.projectId)?.name ?? null,
          task: title,
          started_at: cell(e.startedAt),
          ended_at: cell(e.endedAt),
          duration_minutes: e.durationSeconds === null ? null : Math.round(e.durationSeconds / 60),
          source: e.source,
          state: e.state,
          note: e.note,
          ...(allowed(ctx, 'time.approve', { projectId: e.projectId }) ? { billable: e.billable } : {}),
          approved_at: cell(e.approvedAt),
        };
      after = rows[rows.length - 1]!.e.id;
    }
  },
});

// ——— Saved task views (typed URL filters, never SQL) ———

const VIEW_KEYS = new Set(['q', 'status', 'priority', 'projectId', 'assignee', 'reviewer', 'following', 'overdue', 'noDue', 'blocked', 'tag', 'includeClosed', 'sort', 'dir', 'view', 'group']);

export const listTaskViews = async (ctx: QueryContext) => {
  requirePermission(ctx, 'tasks.read');
  const me = ctx.actor.membershipId;
  const rows = await dbOf(ctx)
    .select()
    .from(savedViews)
    .where(and(eq(savedViews.workspaceId, ctx.actor.workspaceId), eq(savedViews.module, 'tasks'), or(me ? eq(savedViews.ownerMembershipId, me) : sql`false`, eq(savedViews.shared, true))))
    .orderBy(asc(savedViews.name))
    .limit(200);
  const refs = await loadMemberRefs(dbOf(ctx), ctx.actor.workspaceId, rows.map((r) => r.ownerMembershipId));
  return rows.map((r) => ({ id: r.id, name: r.name, filters: r.filterAst as Record<string, string>, shared: r.shared, mine: r.ownerMembershipId === me, owner: refOrUnknown(refs, r.ownerMembershipId) }));
};

export const saveTaskView = async (ctx: CommandContext, input: { name: string; filters: Record<string, string>; shared: boolean }) => {
  requirePermission(ctx, 'tasks.read');
  const me = ctx.actor.membershipId;
  if (!me) throw new AppError('FORBIDDEN', 'Only members can save views.');
  const filters = Object.fromEntries(Object.entries(input.filters).filter(([k]) => VIEW_KEYS.has(k)));
  if (Object.keys(filters).length > 30) throw new AppError('VALIDATION_FAILED', 'A view can have at most 30 filters.');
  if (input.shared && !allowed(ctx, 'tasks.assign')) throw new AppError('FORBIDDEN', 'Only workspace-wide leads can share views with everyone.');
  const id = newId();
  await ctx.tx.insert(savedViews).values({ ...stamp(ctx), id, ownerMembershipId: me, module: 'tasks', name: input.name.trim(), filterAst: filters, shared: input.shared });
  const refs = await loadMemberRefs(ctx.tx, ctx.actor.workspaceId, [me]);
  return { id, name: input.name.trim(), filters, shared: input.shared, mine: true, owner: refOrUnknown(refs, me) };
};

export const deleteTaskView = async (ctx: CommandContext, id: string) => {
  const [v] = await ctx.tx.select().from(savedViews).where(and(eq(savedViews.workspaceId, ctx.actor.workspaceId), eq(savedViews.id, id), eq(savedViews.module, 'tasks')));
  if (!v || (v.ownerMembershipId !== ctx.actor.membershipId && !v.shared)) throw notFound('View');
  if (v.ownerMembershipId !== ctx.actor.membershipId) throw new AppError('FORBIDDEN', 'Only the owner can delete a saved view.');
  await ctx.tx.delete(savedViews).where(eq(savedViews.id, id));
  return { ok: true as const };
};

