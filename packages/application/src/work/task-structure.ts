import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { assetLinks, assets, bulkPreviews, taskChecklistItems, taskDependencies, tasks } from '@castlane/database';
import { AppError, newId, notFound } from '@castlane/domain';
import { allowed, authorizeObject, authorizeRead } from '../core/access';
import { audit, diffFields } from '../core/audit';
import { dbOf, type CommandContext, type QueryContext } from '../core/context';
import { emit } from '../core/events';
import { loadMemberRefs, refOrUnknown } from '../core/members';
import { notify } from '../core/notify';
import { assertVersion, stamp, touch } from '../core/rows';
import { toAssetView } from '../media/assets';
import { cyclePath, propagateSchedule, type ScheduledNode } from './rules/graph';
import { shiftDue } from './rules/due';
import { baselineAfter, isOpenStatus } from './rules/task-status';
import { recordDueChange, resolveDueInput } from './tasks';
import { reachableEdges } from './task-transitions';
import { fieldFail, indexTask, loadTask, lockTask, taskScope, type TaskRowDb } from './shared';
import type { DueInputBody } from '@castlane/api-contracts';

// ——— Checklist ———

type ItemRow = typeof taskChecklistItems.$inferSelect;

const itemView = async (ctx: QueryContext | CommandContext, i: ItemRow) => {
  const refs = await loadMemberRefs(dbOf(ctx), ctx.actor.workspaceId, [i.doneBy]);
  return {
    id: i.id,
    label: i.label,
    mandatory: i.mandatory,
    done: i.done,
    doneAt: i.doneAt?.toISOString() ?? null,
    doneBy: refOrUnknown(refs, i.doneBy),
    position: i.position,
    rowVersion: i.rowVersion,
  };
};

const editableTask = async (ctx: CommandContext, taskId: string) => {
  const t = await lockTask(ctx, taskId);
  authorizeObject(ctx, 'tasks.edit', taskScope(t), 'tasks.read');
  if (t.archivedAt || t.status === 'done' || t.status === 'cancelled') throw new AppError('INVALID_STATE', 'Reopen the task to change its checklist.');
  return t;
};

/** A mandatory-flag change on a task under review is a review change: lead only, reviewer notified. */
const reviewChange = async (ctx: CommandContext, t: TaskRowDb, what: string) => {
  if (t.status !== 'in_review') return;
  if (!allowed(ctx, 'tasks.assign', taskScope(t))) throw new AppError('FORBIDDEN', 'While the task is in review, only a lead can change mandatory checklist items.');
  await audit(ctx, { action: 'task.review_changed', entityType: 'task', entityId: t.id, projectId: t.projectId, metadata: { change: what } });
  if (t.reviewerMembershipId)
    await notify(ctx.tx, {
      workspaceId: t.workspaceId,
      recipientMembershipIds: [t.reviewerMembershipId],
      eventType: 'task.review_changed',
      eventKey: `task.review_changed:${t.id}:${newId()}`,
      kind: 'general',
      title: `Checklist requirements changed during review: ${t.title}`,
      entityType: 'task',
      entityId: t.id,
      projectId: t.projectId,
      actorMembershipId: ctx.actor.membershipId,
      at: ctx.app.clock.now(),
    });
};

export const addChecklistItem = async (ctx: CommandContext, taskId: string, input: { label: string; mandatory: boolean }) => {
  const t = await editableTask(ctx, taskId);
  if (input.mandatory) await reviewChange(ctx, t, 'mandatory item added');
  const [{ max } = { max: -1 }] = await ctx.tx
    .select({ max: sql<number>`coalesce(max(${taskChecklistItems.position}), -1)` })
    .from(taskChecklistItems)
    .where(and(eq(taskChecklistItems.taskId, taskId), isNull(taskChecklistItems.removedAt)));
  const id = newId();
  const [row] = await ctx.tx.insert(taskChecklistItems).values({ ...stamp(ctx), id, taskId, label: input.label.trim(), mandatory: input.mandatory, position: Number(max) + 1 }).returning();
  await ctx.tx.update(tasks).set({ ...touch(ctx, tasks) }).where(eq(tasks.id, taskId));
  await audit(ctx, { action: 'task.checklist_item_added', entityType: 'task', entityId: taskId, projectId: t.projectId, metadata: { itemId: id, mandatory: input.mandatory } });
  await emit(ctx, { type: 'task.checklist_changed', entityType: 'task', entityId: taskId });
  return itemView(ctx, row!);
};

const lockItem = async (ctx: CommandContext, taskId: string, itemId: string) => {
  const [i] = await ctx.tx
    .select()
    .from(taskChecklistItems)
    .where(and(eq(taskChecklistItems.workspaceId, ctx.actor.workspaceId), eq(taskChecklistItems.id, itemId), eq(taskChecklistItems.taskId, taskId)))
    .for('update');
  if (!i || i.removedAt) throw notFound('Checklist item');
  return i;
};

export const updateChecklistItem = async (ctx: CommandContext, taskId: string, itemId: string, input: { label?: string; mandatory?: boolean; done?: boolean; position?: number }) => {
  const t = await editableTask(ctx, taskId);
  const i = await lockItem(ctx, taskId, itemId);
  assertVersion(ctx, i);
  if (input.mandatory !== undefined && input.mandatory !== i.mandatory) await reviewChange(ctx, t, input.mandatory ? 'item made mandatory' : 'item made optional');
  const at = ctx.app.clock.now();
  const patch: Partial<ItemRow> = {};
  if (input.label !== undefined) patch.label = input.label.trim();
  if (input.mandatory !== undefined) patch.mandatory = input.mandatory;
  if (input.position !== undefined) patch.position = input.position;
  if (input.done !== undefined && input.done !== i.done) Object.assign(patch, { done: input.done, doneAt: input.done ? at : null, doneBy: input.done ? ctx.actor.membershipId : null });
  const [row] = await ctx.tx.update(taskChecklistItems).set({ ...patch, ...touch(ctx, taskChecklistItems) }).where(eq(taskChecklistItems.id, itemId)).returning();
  await ctx.tx.update(tasks).set({ ...touch(ctx, tasks) }).where(eq(tasks.id, taskId));
  await audit(ctx, { action: 'task.checklist_item_updated', entityType: 'task', entityId: taskId, projectId: t.projectId, diff: diffFields(i, row!, ['label', 'mandatory', 'done', 'position']), metadata: { itemId } });
  await emit(ctx, { type: 'task.checklist_changed', entityType: 'task', entityId: taskId });
  return itemView(ctx, row!);
};

export const removeChecklistItem = async (ctx: CommandContext, taskId: string, itemId: string) => {
  const t = await editableTask(ctx, taskId);
  const i = await lockItem(ctx, taskId, itemId);
  assertVersion(ctx, i);
  if (i.mandatory) await reviewChange(ctx, t, 'mandatory item removed');
  await ctx.tx.update(taskChecklistItems).set({ removedAt: ctx.app.clock.now(), ...touch(ctx, taskChecklistItems) }).where(eq(taskChecklistItems.id, itemId));
  await ctx.tx.update(tasks).set({ ...touch(ctx, tasks) }).where(eq(tasks.id, taskId));
  await audit(ctx, { action: 'task.checklist_item_removed', entityType: 'task', entityId: taskId, projectId: t.projectId, metadata: { itemId, label: i.label, mandatory: i.mandatory } });
  await emit(ctx, { type: 'task.checklist_changed', entityType: 'task', entityId: taskId });
  return { ok: true as const };
};

// ——— Dependencies ———

const depView = (ctx: QueryContext | CommandContext, d: typeof taskDependencies.$inferSelect, t: TaskRowDb) => {
  const readable = allowed(ctx, 'tasks.read', taskScope(t));
  return {
    id: d.id,
    task: { id: t.id, title: readable ? t.title : null, status: readable ? t.status : null, readable },
    kind: 'finish_to_start' as const,
    overriddenAt: d.overriddenAt?.toISOString() ?? null,
    overrideReason: d.overrideReason,
    createdAt: d.createdAt.toISOString(),
  };
};

export const listDependencies = async (ctx: QueryContext, taskId: string) => {
  const t = await loadTask(ctx, taskId);
  authorizeRead(ctx, 'tasks.read', taskScope(t));
  const db = dbOf(ctx);
  const ws = ctx.actor.workspaceId;
  const preds = await db
    .select({ d: taskDependencies, t: tasks })
    .from(taskDependencies)
    .innerJoin(tasks, eq(tasks.id, taskDependencies.predecessorId))
    .where(and(eq(taskDependencies.workspaceId, ws), eq(taskDependencies.successorId, taskId), isNull(taskDependencies.removedAt)))
    .orderBy(asc(taskDependencies.createdAt));
  const succs = await db
    .select({ d: taskDependencies, t: tasks })
    .from(taskDependencies)
    .innerJoin(tasks, eq(tasks.id, taskDependencies.successorId))
    .where(and(eq(taskDependencies.workspaceId, ws), eq(taskDependencies.predecessorId, taskId), isNull(taskDependencies.removedAt)))
    .orderBy(asc(taskDependencies.createdAt));
  return { predecessors: preds.map((p) => depView(ctx, p.d, p.t)), successors: succs.map((s) => depView(ctx, s.d, s.t)) };
};

/**
 * Add predecessor → task (Finish-to-Start). The graph is locked per workspace so two concurrent
 * edges can never close a cycle together; cycles and self-edges are rejected (T048).
 */
export const addDependency = async (ctx: CommandContext, taskId: string, predecessorId: string) => {
  // Serialise graph changes in this workspace.
  await ctx.tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`task-deps:${ctx.actor.workspaceId}`}))`);
  const t = await lockTask(ctx, taskId);
  authorizeObject(ctx, 'tasks.edit', taskScope(t), 'tasks.read');
  if (predecessorId === taskId) throw fieldFail('predecessorId', 'SELF', 'A task cannot depend on itself.');
  const p = await lockTask(ctx, predecessorId).catch(() => null);
  if (!p || !allowed(ctx, 'tasks.read', taskScope(p))) throw fieldFail('predecessorId', 'NOT_FOUND', 'The predecessor task was not found.');
  if (t.status === 'done' || t.status === 'cancelled') throw new AppError('INVALID_STATE', 'Closed tasks cannot get new dependencies.');
  const [existing] = await ctx.tx
    .select({ id: taskDependencies.id })
    .from(taskDependencies)
    .where(and(eq(taskDependencies.predecessorId, predecessorId), eq(taskDependencies.successorId, taskId), isNull(taskDependencies.removedAt)));
  if (existing) throw new AppError('DUPLICATE', 'This dependency already exists.');
  const edges = await reachableEdges(ctx, taskId);
  const path = cyclePath(edges, predecessorId, taskId);
  if (path) {
    const named = await ctx.tx.select().from(tasks).where(inArray(tasks.id, path));
    const byId = new Map(named.map((n) => [n.id, n]));
    throw new AppError('INVALID_STATE', 'This dependency would create a cycle.', {
      details: { cycle: path.map((id) => ({ id, title: byId.get(id) && allowed(ctx, 'tasks.read', taskScope(byId.get(id)!)) ? byId.get(id)!.title : null })) },
    });
  }
  const id = newId();
  const [row] = await ctx.tx.insert(taskDependencies).values({ ...stamp(ctx), id, predecessorId, successorId: taskId }).returning();
  await ctx.tx.update(tasks).set({ ...touch(ctx, tasks) }).where(eq(tasks.id, taskId));
  await audit(ctx, { action: 'task.dependency_added', entityType: 'task', entityId: taskId, projectId: t.projectId, metadata: { predecessorId } });
  await emit(ctx, { type: 'task.dependency_added', entityType: 'task', entityId: taskId, payload: { predecessorId } });
  return depView(ctx, row!, p);
};

export const removeDependency = async (ctx: CommandContext, taskId: string, dependencyId: string, reason: string) => {
  const t = await lockTask(ctx, taskId);
  authorizeObject(ctx, 'tasks.edit', taskScope(t), 'tasks.read');
  const [d] = await ctx.tx
    .select()
    .from(taskDependencies)
    .where(and(eq(taskDependencies.workspaceId, ctx.actor.workspaceId), eq(taskDependencies.id, dependencyId), eq(taskDependencies.successorId, taskId)))
    .for('update');
  if (!d) throw notFound('Dependency');
  if (d.removedAt) return { ok: true as const };
  await ctx.tx.update(taskDependencies).set({ removedAt: ctx.app.clock.now(), removedReason: reason.trim(), ...touch(ctx, taskDependencies) }).where(eq(taskDependencies.id, dependencyId));
  await ctx.tx.update(tasks).set({ ...touch(ctx, tasks) }).where(eq(tasks.id, taskId));
  await audit(ctx, { action: 'task.dependency_removed', entityType: 'task', entityId: taskId, projectId: t.projectId, reason, metadata: { predecessorId: d.predecessorId } });
  await emit(ctx, { type: 'task.dependency_removed', entityType: 'task', entityId: taskId });
  return { ok: true as const };
};

// ——— Reschedule with dependency preview ———

const PREVIEW_TTL_MS = 10 * 60_000;
const DAY = 86_400_000;

interface PlannedChange {
  id: string;
  toStart: string | null;
  toDue: string | null;
  toDueDate: string | null;
  toDueTimezone: string | null;
  rowVersion: number;
  canApply: boolean;
}

/**
 * Preview new dates and the pushed dates of dependent tasks (Finish-to-Start). Nothing moves until
 * the preview is applied; tasks the actor may not edit are shown but never moved silently.
 */
export const reschedulePreview = async (ctx: CommandContext, taskId: string, input: { startAt?: string | null; due?: DueInputBody | null; propagate: boolean }) => {
  const t = await loadTask(ctx, taskId);
  authorizeObject(ctx, 'tasks.edit', taskScope(t), 'tasks.read');
  if (!isOpenStatus(t.status)) throw new AppError('INVALID_STATE', 'Only open tasks can be rescheduled.');
  const due = input.due === undefined ? (t.dueAt ? { dueAt: t.dueAt, dueDate: t.dueDate, dueTimezone: t.dueTimezone } : null) : resolveDueInput(input.due);
  const startAt = input.startAt === undefined ? t.startAt : input.startAt ? new Date(input.startAt) : null;
  if (startAt && due && startAt.getTime() > due.dueAt.getTime()) throw fieldFail('startAt', 'AFTER_DUE', 'The start must be on or before the deadline.');
  const edges = input.propagate ? await reachableEdges(ctx, taskId) : [];
  const ids = [...new Set(edges.flatMap((e) => [e.predecessorId, e.successorId]))].filter((id) => id !== taskId);
  const rows = ids.length ? await ctx.tx.select().from(tasks).where(and(eq(tasks.workspaceId, ctx.actor.workspaceId), inArray(tasks.id, ids))) : [];
  const nodes = new Map<string, ScheduledNode>([[t.id, { id: t.id, startAt: t.startAt, dueAt: t.dueAt, dateOnly: !!t.dueDate, open: true }]]);
  for (const r of rows) nodes.set(r.id, { id: r.id, startAt: r.startAt, dueAt: r.dueAt, dateOnly: !!r.dueDate, open: isOpenStatus(r.status) && !r.archivedAt });
  const changes = propagateSchedule(nodes, edges, { id: t.id, startAt, dueAt: due?.dueAt ?? null });
  const byId = new Map([t, ...rows].map((r) => [r.id, r]));
  const planned: PlannedChange[] = changes.map((c) => {
    const r = byId.get(c.id)!;
    let toDue = c.toDue;
    let toDueDate: string | null = null;
    let toDueTimezone: string | null = r.dueTimezone;
    if (c.id === t.id) {
      toDueDate = due?.dueDate ?? null;
      toDueTimezone = due?.dueTimezone ?? null;
    } else if (r.dueDate && r.dueTimezone && r.dueAt && c.toDue) {
      // Date-only deadlines move by whole days in their own zone.
      const days = Math.ceil((c.toDue.getTime() - r.dueAt.getTime()) / DAY);
      const shifted = shiftDue({ dueAt: r.dueAt, dueDate: r.dueDate, dueTimezone: r.dueTimezone }, days);
      toDue = shifted.dueAt;
      toDueDate = shifted.dueDate;
    }
    return {
      id: c.id,
      toStart: c.toStart?.toISOString() ?? null,
      toDue: toDue?.toISOString() ?? null,
      toDueDate,
      toDueTimezone,
      rowVersion: r.rowVersion,
      canApply: allowed(ctx, 'tasks.edit', taskScope(r)) && isOpenStatus(r.status),
    };
  });
  const token = newId();
  const expiresAt = new Date(ctx.app.clock.now().getTime() + PREVIEW_TTL_MS);
  await ctx.tx.insert(bulkPreviews).values({
    ...stamp(ctx),
    id: token,
    actorMembershipId: ctx.actor.membershipId!,
    action: 'task.reschedule',
    params: { rootId: t.id, changes: planned },
    targets: planned.map((p) => ({ type: 'task', id: p.id, rowVersion: p.rowVersion, status: p.canApply ? 'ok' : 'forbidden' })),
    accessRevision: ctx.actor.access.accessRevision,
    summary: { count: planned.length },
    expiresAt,
  });
  return {
    token,
    expiresAt: expiresAt.toISOString(),
    changes: changes.map((c) => {
      const r = byId.get(c.id)!;
      const p = planned.find((x) => x.id === c.id)!;
      const readable = allowed(ctx, 'tasks.read', taskScope(r));
      return {
        task: { id: r.id, title: readable ? r.title : null, status: readable ? r.status : null, readable },
        fromStart: c.fromStart?.toISOString() ?? null,
        toStart: p.toStart,
        fromDue: c.fromDue?.toISOString() ?? null,
        toDue: p.toDue,
        causedBy: c.causedBy,
        canApply: p.canApply,
        rowVersion: r.rowVersion,
      };
    }),
  };
};

/** Apply a reschedule preview atomically; a task changed since the preview rejects the whole apply. */
export const applyReschedule = async (ctx: CommandContext, taskId: string, input: { previewToken: string; applyTaskIds?: string[]; reason?: string }) => {
  const root = await lockTask(ctx, taskId);
  authorizeObject(ctx, 'tasks.edit', taskScope(root), 'tasks.read');
  assertVersion(ctx, root);
  const [p] = await ctx.tx.select().from(bulkPreviews).where(and(eq(bulkPreviews.workspaceId, ctx.actor.workspaceId), eq(bulkPreviews.id, input.previewToken))).for('update');
  const params = p?.params as { rootId?: string; changes?: PlannedChange[] } | undefined;
  if (!p || p.actorMembershipId !== ctx.actor.membershipId || p.action !== 'task.reschedule' || params?.rootId !== taskId) throw fieldFail('previewToken', 'INVALID', 'Preview the new dates again.');
  if (p.consumedAt) throw new AppError('INVALID_STATE', 'This preview was already applied.');
  if (p.expiresAt.getTime() < ctx.app.clock.now().getTime()) throw new AppError('INVALID_STATE', 'The preview expired. Preview the new dates again.');
  const selected = new Set([taskId, ...(input.applyTaskIds ?? [])]);
  const changes = (params.changes ?? []).filter((c) => selected.has(c.id) && c.canApply);
  for (const c of changes) {
    const t = c.id === taskId ? root : await lockTask(ctx, c.id);
    if (t.rowVersion !== c.rowVersion) throw new AppError('CONFLICT', 'Some tasks changed after the preview. Preview again.', { details: { taskId: c.id } });
    if (!allowed(ctx, 'tasks.edit', taskScope(t))) throw new AppError('FORBIDDEN', 'You can no longer reschedule one of the selected tasks.');
    const dueAt = c.toDue ? new Date(c.toDue) : null;
    const startAt = c.toStart ? new Date(c.toStart) : null;
    const [row] = await ctx.tx
      .update(tasks)
      .set({
        startAt,
        dueAt,
        dueDate: c.toDueDate,
        dueTimezone: c.toDueTimezone,
        baselineDueAt: baselineAfter({ baseline: t.baselineDueAt, status: t.status, dueAt }),
        ...touch(ctx, tasks),
      })
      .where(eq(tasks.id, c.id))
      .returning();
    if ((dueAt?.getTime() ?? null) !== (t.dueAt?.getTime() ?? null))
      await recordDueChange(ctx, t, dueAt, c.id === taskId ? input.reason?.trim() || null : `Moved with predecessor ${root.title}`.slice(0, 2000));
    await audit(ctx, {
      action: 'task.rescheduled',
      entityType: 'task',
      entityId: c.id,
      projectId: t.projectId,
      reason: input.reason ?? null,
      diff: diffFields(t, row!, ['startAt', 'dueAt', 'dueDate']),
      metadata: c.id === taskId ? undefined : { causedByTaskId: taskId },
    });
    await emit(ctx, { type: 'task.rescheduled', entityType: 'task', entityId: c.id, revision: row!.rowVersion });
    await indexTask(ctx, row!);
  }
  await ctx.tx.update(bulkPreviews).set({ consumedAt: ctx.app.clock.now() }).where(eq(bulkPreviews.id, p.id));
  return taskId;
};

// ——— Attachments ———

export const taskAttachments = async (ctx: QueryContext, taskId: string) => {
  const t = await loadTask(ctx, taskId);
  authorizeRead(ctx, 'tasks.read', taskScope(t));
  const links = await dbOf(ctx)
    .select({ link: assetLinks, asset: assets })
    .from(assetLinks)
    .innerJoin(assets, eq(assets.id, assetLinks.assetId))
    .where(and(eq(assetLinks.workspaceId, ctx.actor.workspaceId), eq(assetLinks.entityType, 'task'), eq(assetLinks.entityId, taskId), isNull(assetLinks.removedAt), isNull(assets.deletedAt)))
    .orderBy(asc(assetLinks.createdAt));
  const views = await toAssetView(ctx, links.map((l) => l.asset));
  return links.map((l, i) => ({ linkId: l.link.id, linkedAt: l.link.createdAt.toISOString(), asset: views[i]! }));
};
