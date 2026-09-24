import type { PgColumn } from 'drizzle-orm/pg-core';
import { and, asc, count, desc, eq, ilike, inArray, isNotNull, isNull, lt, lte, gte, ne, or, sql, type SQL } from 'drizzle-orm';
import {
  auditEvents,
  recurrenceOccurrences,
  taskBlockIntervals,
  taskChecklistItems,
  taskDependencies,
  taskDueRevisions,
  tasks,
  taskStatusEvents,
  timeEntries,
} from '@castlane/database';
import type { TaskListQuery, TaskRow } from '@castlane/api-contracts';
import { clampPageSize, decodeCursor, encodeCursor } from '@castlane/domain';
import { allowed, authorizeRead, requirePermission, scopePredicate, whereAll } from '../core/access';
import { all, dbOf, type CommandContext, type QueryContext } from '../core/context';
import { loadMemberRefs, refOrUnknown, type MemberRef } from '../core/members';
import { isOverdue, OPEN_TASK_STATUSES, TASK_TRANSITIONS, type TaskStatus } from './rules/task-status';
import { linkedRefsOf, loadLinkedInfo, loadTask, LINK_COLUMNS, projectNames, TASK_SCOPE_COLUMNS, taskScope, type TaskRowDb } from './shared';
import { evaluateTransition, loadTransitionFacts, TRANSITION_LABELS } from './task-transitions';

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export const dueViewOf = (t: Pick<TaskRowDb, 'dueAt' | 'dueDate' | 'dueTimezone'>) =>
  t.dueAt ? { at: t.dueAt.toISOString(), date: t.dueDate, timezone: t.dueTimezone } : null;

/** Bulk read-model extras for a page of tasks (counts, people, links, parents) — scope-checked per record. */
export const toTaskRows = async (ctx: QueryContext | CommandContext, rows: TaskRowDb[]): Promise<TaskRow[]> => {
  if (rows.length === 0) return [];
  const db = dbOf(ctx);
  const ws = ctx.actor.workspaceId;
  const ids = rows.map((r) => r.id);
  const parentIds = [...new Set(rows.map((r) => r.parentTaskId).filter((x): x is string => !!x))];
  const [deps, checklist, children, parents, projectsById, refs] = await all(ctx, [
    () =>
      db
        .select({
          taskId: taskDependencies.successorId,
          total: count(),
          open: sql<number>`count(*) filter (where ${tasks.status} <> 'done')`,
        })
        .from(taskDependencies)
        .innerJoin(tasks, eq(tasks.id, taskDependencies.predecessorId))
        .where(and(eq(taskDependencies.workspaceId, ws), inArray(taskDependencies.successorId, ids), isNull(taskDependencies.removedAt)))
        .groupBy(taskDependencies.successorId),
    () =>
      db
        .select({
          taskId: taskChecklistItems.taskId,
          total: count(),
          done: sql<number>`count(*) filter (where ${taskChecklistItems.done})`,
          mandatoryOpen: sql<number>`count(*) filter (where ${taskChecklistItems.mandatory} and not ${taskChecklistItems.done})`,
        })
        .from(taskChecklistItems)
        .where(and(eq(taskChecklistItems.workspaceId, ws), inArray(taskChecklistItems.taskId, ids), isNull(taskChecklistItems.removedAt)))
        .groupBy(taskChecklistItems.taskId),
    () =>
      db
        .select({
          parentId: tasks.parentTaskId,
          total: count(),
          open: sql<number>`count(*) filter (where ${tasks.status} in ('draft','backlog','ready','in_progress','in_review'))`,
        })
        .from(tasks)
        .where(and(eq(tasks.workspaceId, ws), inArray(tasks.parentTaskId, ids), isNull(tasks.deletedAt)))
        .groupBy(tasks.parentTaskId),
    () => (parentIds.length ? db.select().from(tasks).where(and(eq(tasks.workspaceId, ws), inArray(tasks.id, parentIds))) : Promise.resolve([] as TaskRowDb[])),
    () => projectNames(db, ws, rows.map((r) => r.projectId)),
    () => loadMemberRefs(db, ws, rows.flatMap((r) => [r.assigneeMembershipId, r.reviewerMembershipId])),
  ] as const);
  const linkRefs = rows.flatMap((r) => LINK_COLUMNS.filter((l) => r[l.column]).map((l) => ({ type: l.type, id: r[l.column] as string })));
  const linkInfo = await loadLinkedInfo(ctx, linkRefs);
  const depBy = new Map(deps.map((d) => [d.taskId, d]));
  const clBy = new Map(checklist.map((c) => [c.taskId, c]));
  const chBy = new Map(children.map((c) => [c.parentId, c]));
  const parentBy = new Map(parents.map((p) => [p.id, p]));
  const now = ctx.app.clock.now();
  const me = ctx.actor.membershipId;
  return rows.map((t) => {
    const d = depBy.get(t.id);
    const c = clBy.get(t.id);
    const ch = chBy.get(t.id);
    const parent = t.parentTaskId ? parentBy.get(t.parentTaskId) : undefined;
    const parentReadable = !!parent && allowed(ctx, 'tasks.read', taskScope(parent));
    return {
      id: t.id,
      title: t.title,
      status: t.status,
      priority: t.priority,
      project: { id: t.projectId, name: projectsById.get(t.projectId)?.name ?? 'Unknown project' },
      assignee: refOrUnknown(refs, t.assigneeMembershipId),
      reviewer: refOrUnknown(refs, t.reviewerMembershipId),
      startAt: iso(t.startAt),
      due: dueViewOf(t),
      overdue: isOverdue(t, now),
      estimateMinutes: t.estimateMinutes,
      blocked: t.blockedAt ? { reason: t.blockedReason ?? '', since: t.blockedAt.toISOString(), nextCheckAt: iso(t.nextCheckAt) } : null,
      dependencies: { total: Number(d?.total ?? 0), openPredecessors: Number(d?.open ?? 0) },
      checklist: { total: Number(c?.total ?? 0), done: Number(c?.done ?? 0), mandatoryOpen: Number(c?.mandatoryOpen ?? 0) },
      subtasks: { total: Number(ch?.total ?? 0), open: Number(ch?.open ?? 0) },
      parent: t.parentTaskId
        ? { id: t.parentTaskId, title: parentReadable ? parent!.title : null, status: parentReadable ? parent!.status : null, readable: parentReadable }
        : null,
      linked: linkedRefsOf(t, linkInfo, ws),
      tags: t.tags,
      source: t.source,
      recurring: !!t.recurrenceOccurrenceId,
      following: !!me && t.followerMembershipIds.includes(me),
      completedAt: iso(t.completedAt),
      archivedAt: iso(t.archivedAt),
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
      rowVersion: t.rowVersion,
    };
  });
};

type FilterInput = Omit<TaskListQuery, 'cursor' | 'pageSize' | 'sort' | 'direction'>;

const memberFilter = (ctx: QueryContext, col: PgColumn, v: string | undefined): SQL | undefined => {
  if (!v) return undefined;
  if (v === 'unassigned') return isNull(col);
  if (v === 'me') return ctx.actor.membershipId ? eq(col, ctx.actor.membershipId) : sql`false`;
  return /^[0-9a-f-]{36}$/i.test(v) ? eq(col, v) : sql`false`;
};

/** Scope-restricted filter (scope is part of the SQL, before paging and counting). */
export const taskFilterSql = (ctx: QueryContext, q: FilterInput): SQL | undefined => {
  const now = ctx.app.clock.now();
  return whereAll(
    eq(tasks.workspaceId, ctx.actor.workspaceId),
    isNull(tasks.deletedAt),
    scopePredicate(ctx, 'tasks.read', TASK_SCOPE_COLUMNS),
    q.includeArchived ? undefined : isNull(tasks.archivedAt),
    q.status?.length ? inArray(tasks.status, q.status) : q.includeClosed ? undefined : inArray(tasks.status, [...OPEN_TASK_STATUSES]),
    q.priority?.length ? inArray(tasks.priority, q.priority) : undefined,
    q.projectId ? eq(tasks.projectId, q.projectId) : undefined,
    memberFilter(ctx, tasks.assigneeMembershipId, q.assignee),
    memberFilter(ctx, tasks.reviewerMembershipId, q.reviewer),
    q.following && ctx.actor.membershipId ? sql`${ctx.actor.membershipId}::uuid = ANY(${tasks.followerMembershipIds})` : undefined,
    q.dueFrom ? gte(tasks.dueAt, new Date(q.dueFrom)) : undefined,
    q.dueTo ? lte(tasks.dueAt, new Date(q.dueTo)) : undefined,
    q.overdue ? and(lt(tasks.dueAt, now), inArray(tasks.status, [...OPEN_TASK_STATUSES])) : undefined,
    q.noDue ? isNull(tasks.dueAt) : undefined,
    q.blocked === true ? isNotNull(tasks.blockedAt) : q.blocked === false ? isNull(tasks.blockedAt) : undefined,
    q.tag ? sql`lower(${q.tag}) = ANY(SELECT lower(x) FROM unnest(${tasks.tags}) x)` : undefined,
    q.accountId ? eq(tasks.accountId, q.accountId) : undefined,
    q.contentItemId ? eq(tasks.contentItemId, q.contentItemId) : undefined,
    q.publicationId ? eq(tasks.publicationId, q.publicationId) : undefined,
    q.shiftId ? eq(tasks.shiftId, q.shiftId) : undefined,
    q.dealId ? eq(tasks.dealId, q.dealId) : undefined,
    q.parentTaskId ? eq(tasks.parentTaskId, q.parentTaskId) : undefined,
    q.q ? or(ilike(tasks.title, `%${q.q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`), eq(sql`${tasks.id}::text`, q.q)) : undefined,
  );
};

const SORTS = {
  dueAt: { expr: sql`coalesce(${tasks.dueAt}, 'infinity'::timestamptz)`, value: (t: TaskRowDb) => (t.dueAt ? t.dueAt.toISOString() : 'infinity'), cast: 'timestamptz' },
  updatedAt: { expr: sql`${tasks.updatedAt}`, value: (t: TaskRowDb) => t.updatedAt.toISOString(), cast: 'timestamptz' },
  createdAt: { expr: sql`${tasks.createdAt}`, value: (t: TaskRowDb) => t.createdAt.toISOString(), cast: 'timestamptz' },
  title: { expr: sql`lower(${tasks.title})`, value: (t: TaskRowDb) => t.title.toLowerCase(), cast: 'text' },
} as const;

export const listTaskRows = async (ctx: QueryContext, q: TaskListQuery, extra?: SQL) => {
  const size = clampPageSize(q.pageSize);
  const s = SORTS[q.sort];
  const c = q.cursor ? decodeCursor(q.cursor) : null;
  const op = q.direction === 'asc' ? sql`>` : sql`<`;
  const cursorCond = c ? sql`(${s.expr}, ${tasks.id}) ${op} (${String(c.v[0])}::${sql.raw(s.cast)}, ${c.id}::uuid)` : undefined;
  const dir = q.direction === 'asc' ? asc : desc;
  const rows = await dbOf(ctx)
    .select()
    .from(tasks)
    .where(whereAll(taskFilterSql(ctx, q), cursorCond, extra))
    .orderBy(dir(s.expr), dir(tasks.id))
    .limit(size + 1);
  const hasMore = rows.length > size;
  const pageRows = hasMore ? rows.slice(0, size) : rows;
  const last = pageRows[pageRows.length - 1];
  return { rows: pageRows, hasMore, nextCursor: hasMore && last ? encodeCursor({ v: [s.value(last)], id: last.id }) : null };
};

export const listTasks = async (ctx: QueryContext, q: TaskListQuery) => {
  requirePermission(ctx, 'tasks.read');
  const r = await listTaskRows(ctx, q);
  return { items: await toTaskRows(ctx, r.rows), hasMore: r.hasMore, nextCursor: r.nextCursor };
};

export const countTasks = async (ctx: QueryContext, q: FilterInput) => {
  requirePermission(ctx, 'tasks.read');
  const [r] = await dbOf(ctx).select({ n: count() }).from(tasks).where(taskFilterSql(ctx, q));
  return { count: Number(r?.n ?? 0) };
};

const PERMISSION_KEYS = ['tasks.edit', 'tasks.assign', 'tasks.complete', 'tasks.reopen', 'tasks.create', 'time.write.own', 'assets.upload', 'assets.link'] as const;

export const getTask = async (ctx: QueryContext | CommandContext, id: string) => {
  const t = await loadTask(ctx, id);
  const scope = taskScope(t);
  authorizeRead(ctx, 'tasks.read', scope);
  const db = dbOf(ctx);
  const ws = ctx.actor.workspaceId;
  const [row] = await toTaskRows(ctx, [t]);
  const [items, preds, succs, subs, events, dueRevs, blocks, logged, myTimer, occurrence] = await all(ctx, [
    () =>
      db
        .select()
        .from(taskChecklistItems)
        .where(and(eq(taskChecklistItems.workspaceId, ws), eq(taskChecklistItems.taskId, id), isNull(taskChecklistItems.removedAt)))
        .orderBy(asc(taskChecklistItems.position), asc(taskChecklistItems.createdAt)),
    () =>
      db
        .select({ dep: taskDependencies, task: tasks })
        .from(taskDependencies)
        .innerJoin(tasks, eq(tasks.id, taskDependencies.predecessorId))
        .where(and(eq(taskDependencies.workspaceId, ws), eq(taskDependencies.successorId, id), isNull(taskDependencies.removedAt)))
        .orderBy(asc(taskDependencies.createdAt)),
    () =>
      db
        .select({ dep: taskDependencies, task: tasks })
        .from(taskDependencies)
        .innerJoin(tasks, eq(tasks.id, taskDependencies.successorId))
        .where(and(eq(taskDependencies.workspaceId, ws), eq(taskDependencies.predecessorId, id), isNull(taskDependencies.removedAt)))
        .orderBy(asc(taskDependencies.createdAt)),
    () =>
      db
        .select()
        .from(tasks)
        .where(and(eq(tasks.workspaceId, ws), eq(tasks.parentTaskId, id), isNull(tasks.deletedAt)))
        .orderBy(asc(tasks.createdAt)),
    () => db.select().from(taskStatusEvents).where(and(eq(taskStatusEvents.workspaceId, ws), eq(taskStatusEvents.taskId, id))).orderBy(desc(taskStatusEvents.occurredAt)).limit(100),
    () => db.select().from(taskDueRevisions).where(and(eq(taskDueRevisions.workspaceId, ws), eq(taskDueRevisions.taskId, id))).orderBy(desc(taskDueRevisions.deadlineRevision)).limit(100),
    () => db.select().from(taskBlockIntervals).where(and(eq(taskBlockIntervals.workspaceId, ws), eq(taskBlockIntervals.taskId, id))).orderBy(desc(taskBlockIntervals.startedAt)).limit(50),
    () =>
      db
        .select({ s: sql<number>`coalesce(sum(${timeEntries.durationSeconds}), 0)` })
        .from(timeEntries)
        .where(and(eq(timeEntries.workspaceId, ws), eq(timeEntries.taskId, id), ne(timeEntries.state, 'running'), isNull(timeEntries.supersededAt))),
    () =>
      ctx.actor.membershipId
        ? db
            .select({ id: timeEntries.id })
            .from(timeEntries)
            .where(and(eq(timeEntries.workspaceId, ws), eq(timeEntries.taskId, id), eq(timeEntries.membershipId, ctx.actor.membershipId), eq(timeEntries.state, 'running')))
        : Promise.resolve([] as { id: string }[]),
    () =>
      t.recurrenceOccurrenceId
        ? db.select({ ruleId: recurrenceOccurrences.ruleId }).from(recurrenceOccurrences).where(eq(recurrenceOccurrences.id, t.recurrenceOccurrenceId))
        : Promise.resolve([] as { ruleId: string }[]),
  ] as const);
  const refs = await loadMemberRefs(db, ws, [
    ...items.map((i) => i.doneBy),
    ...subs.map((s) => s.assigneeMembershipId),
    ...events.map((e) => e.actorMembershipId),
    ...t.followerMembershipIds,
    t.completedBy,
    t.assigneeAtCompletion,
  ]);
  const depView = (d: { dep: typeof taskDependencies.$inferSelect; task: TaskRowDb }) => {
    const readable = allowed(ctx, 'tasks.read', taskScope(d.task));
    return {
      id: d.dep.id,
      task: { id: d.task.id, title: readable ? d.task.title : null, status: readable ? d.task.status : null, readable },
      kind: 'finish_to_start' as const,
      overriddenAt: iso(d.dep.overriddenAt),
      overrideReason: d.dep.overrideReason,
      createdAt: d.dep.createdAt.toISOString(),
    };
  };
  const now = ctx.app.clock.now();
  const facts = await loadTransitionFacts(ctx, t);
  const can = (p: (typeof PERMISSION_KEYS)[number]) => allowed(ctx, p, scope);
  const isClosed = t.status === 'done' || t.status === 'cancelled';
  const active = !t.archivedAt;
  const transitions = (TASK_TRANSITIONS[t.status] as readonly TaskStatus[]).map((to) => {
    const ev = evaluateTransition(ctx, t, to, facts, {});
    const label = TRANSITION_LABELS[`${t.status}>${to}`] ?? to;
    return { to, label, allowed: active && ev.ok, reason: !active ? 'Archived tasks are read-only.' : ev.ok ? null : ev.message, needsReason: ev.needsReason };
  });
  const requiredChildren = subs.filter((s) => s.requiredForParent);
  return {
    ...row!,
    description: t.description,
    baselineDueAt: iso(t.baselineDueAt),
    requiredForParent: t.requiredForParent,
    completedBy: refOrUnknown(refs, t.completedBy),
    completionEffectiveAt: iso(t.completionEffectiveAt),
    assigneeAtCompletion: refOrUnknown(refs, t.assigneeAtCompletion),
    cancelledAt: iso(t.cancelledAt),
    cancelReason: t.cancelReason,
    cancellationAccepted: t.cancellationAccepted,
    reopenCount: t.reopenCount,
    cycle: t.reopenCount + 1,
    followers: t.followerMembershipIds.map((m) => refOrUnknown(refs, m)).filter((x): x is MemberRef => !!x),
    checklistItems: items.map((i) => ({
      id: i.id,
      label: i.label,
      mandatory: i.mandatory,
      done: i.done,
      doneAt: iso(i.doneAt),
      doneBy: refOrUnknown(refs, i.doneBy),
      position: i.position,
      rowVersion: i.rowVersion,
    })),
    predecessors: preds.map(depView),
    successors: succs.map(depView),
    subtaskList: subs
      .filter((s) => allowed(ctx, 'tasks.read', taskScope(s)))
      .map((s) => ({
        id: s.id,
        title: s.title,
        status: s.status,
        assignee: refOrUnknown(refs, s.assigneeMembershipId),
        due: dueViewOf(s),
        overdue: isOverdue(s, now),
        rowVersion: s.rowVersion,
        requiredForParent: s.requiredForParent,
        cancellationAccepted: s.cancellationAccepted,
      })),
    parentPolicy: {
      requiredOpen: requiredChildren.filter((s) => s.status !== 'done' && s.status !== 'cancelled').length,
      unacceptedCancellations: requiredChildren.filter((s) => s.status === 'cancelled' && !s.cancellationAccepted).length,
    },
    statusEvents: events.map((e) => ({
      id: e.id,
      from: e.fromStatus,
      to: e.toStatus,
      at: e.occurredAt.toISOString(),
      effectiveAt: iso(e.effectiveAt),
      actor: refOrUnknown(refs, e.actorMembershipId),
      reason: e.reason,
      cycle: e.cycle,
    })),
    dueRevisions: dueRevs.map((r) => ({
      id: r.id,
      from: iso(r.fromDueAt),
      to: iso(r.toDueAt),
      reason: r.reason,
      revision: r.deadlineRevision,
      at: r.createdAt.toISOString(),
      actor: null as string | null,
    })),
    blockIntervals: blocks.map((b) => ({ id: b.id, reason: b.reason, startedAt: b.startedAt.toISOString(), endedAt: iso(b.endedAt), resolution: b.resolution })),
    time: { loggedSeconds: Number(logged[0]?.s ?? 0), myRunningTimerId: myTimer[0]?.id ?? null },
    recurrenceRuleId: occurrence[0]?.ruleId ?? null,
    templateApplicationId: t.templateApplicationId,
    transitions,
    permissions: {
      edit: active && !isClosed && can('tasks.edit'),
      assign: active && !isClosed && can('tasks.assign'),
      complete: active && can('tasks.complete'),
      reopen: active && t.status === 'done' && can('tasks.reopen'),
      cancel: active && !isClosed && can('tasks.edit') && (can('tasks.assign') || t.createdBy === ctx.actor.userId),
      block: active && !isClosed && can('tasks.edit'),
      comment: can('tasks.edit'),
      createSubtask: active && !isClosed && can('tasks.create'),
      overrideDependencies: active && can('tasks.assign'),
      trackTime: active && t.status !== 'cancelled' && can('time.write.own'),
      manageChecklist: active && !isClosed && can('tasks.edit'),
      attach: active && (can('assets.upload') || can('assets.link')),
      archive: !t.archivedAt && isClosed && can('tasks.assign'),
      trash: t.status === 'draft' && (can('tasks.assign') || t.createdBy === ctx.actor.userId),
      duplicate: can('tasks.create'),
    },
  };
};

export const taskActivity = async (ctx: QueryContext, id: string, input: { cursor?: string; pageSize?: number }) => {
  const t = await loadTask(ctx, id);
  authorizeRead(ctx, 'tasks.read', taskScope(t));
  const size = clampPageSize(input.pageSize ?? 30);
  const c = input.cursor ? decodeCursor(input.cursor) : null;
  const rows = await ctx.app.db
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.workspaceId, ctx.actor.workspaceId),
        eq(auditEvents.entityType, 'task'),
        eq(auditEvents.entityId, id),
        eq(auditEvents.sensitivity, 'normal'),
        c ? or(lt(auditEvents.occurredAt, new Date(String(c.v[0]))), and(eq(auditEvents.occurredAt, new Date(String(c.v[0]))), lt(auditEvents.id, c.id))) : undefined,
      ),
    )
    .orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id))
    .limit(size + 1);
  const hasMore = rows.length > size;
  const items = (hasMore ? rows.slice(0, size) : rows).map((r) => ({
    id: r.id,
    action: r.action,
    actorName: r.actorDisplay,
    occurredAt: r.occurredAt.toISOString(),
    reason: r.reason,
    changes: Object.entries(r.diff ?? {}).map(([field, v]) => ({ field, from: v.from, to: v.to })),
  }));
  const last = items[items.length - 1];
  return { items, hasMore, nextCursor: hasMore && last ? encodeCursor({ v: [last.occurredAt], id: last.id }) : null };
};

