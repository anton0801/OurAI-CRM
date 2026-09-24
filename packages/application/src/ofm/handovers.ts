import { and, asc, eq, gte, inArray, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import { handoverItems, handovers, operations, shiftAccounts, shifts, tasks } from '@castlane/database';
import { AppError, TASK_PRIORITIES, newId, notFound } from '@castlane/domain';
import { allowed } from '../core/access';
import { audit } from '../core/audit';
import { all, dbOf, type CommandContext, type QueryContext } from '../core/context';
import { emit } from '../core/events';
import { notify } from '../core/notify';
import { assertVersion, lockById, stamp, touch } from '../core/rows';
import { assertActiveMember, exprKeyset, fieldErr, holds, invalid, me, type Ctx } from './common';
import { reviewerFor } from './reports';
import { createOfmTask } from './tasks-bridge';
import {
  canReadHandover,
  canReadShift,
  handoverSummaries,
  handoverVisibility,
  operationScope,
  operationSummaries,
  shiftScope,
  taskRefs,
  type HandoverRow,
  type ShiftRow,
} from './views';

/**
 * Handover Desk (S44, §13.3): items reference tasks/operations by id and are never cloned; one open
 * item per matter (DB constraint). Acknowledgement records who/when and accepts selected items — it
 * never resolves, completes or copies anything (T094).
 */

type Priority = (typeof TASK_PRIORITIES)[number];
type ItemRow = typeof handoverItems.$inferSelect;

export interface HandoverItemInput {
  title: string;
  businessExplanation?: string | null;
  priority: Priority;
  dueAt?: string | null;
  taskId?: string | null;
  operationId?: string | null;
  carriedFromItemId?: string | null;
}

const isWriter = (ctx: Ctx, s: ShiftRow) =>
  allowed(ctx, 'handovers.write', shiftScope(s)) &&
  (s.membershipId === me(ctx) || allowed(ctx, 'shifts.schedule', shiftScope(s)) || allowed(ctx, 'shifts.correct', shiftScope(s)));

const loadFromShift = async (ctx: Ctx, h: HandoverRow) => {
  const [s] = await dbOf(ctx).select().from(shifts).where(eq(shifts.id, h.fromShiftId));
  return s!;
};

const handoverDetail = async (ctx: Ctx, h: HandoverRow, from: ShiftRow) => {
  const db = dbOf(ctx);
  const items = await db.select().from(handoverItems).where(and(eq(handoverItems.workspaceId, ctx.actor.workspaceId), eq(handoverItems.handoverId, h.id))).orderBy(asc(handoverItems.createdAt), asc(handoverItems.id));
  const opIds = items.map((i) => i.operationId).filter((x): x is string => !!x);
  const [summary] = await handoverSummaries(ctx, [h]);
  const [taskMap, opRows] = await all(ctx, [
    () => taskRefs(ctx, items.map((i) => i.taskId)),
    () => (opIds.length ? db.select().from(operations).where(inArray(operations.id, opIds)) : Promise.resolve([] as (typeof operations.$inferSelect)[])),
  ] as const);
  const opBy = new Map(opRows.filter((o) => allowed(ctx, 'operations.read', operationScope(o)) || h.recipientMembershipId === me(ctx)).map((o) => [o.id, o]));
  const writer = isWriter(ctx, from);
  const recipient = h.recipientMembershipId === me(ctx);
  const scope = { projectId: from.projectId, accountId: h.accountId };
  return {
    ...summary!,
    items: items.map((i) => {
      const o = i.operationId ? opBy.get(i.operationId) : undefined;
      return {
        id: i.id,
        title: i.title,
        businessExplanation: i.businessExplanation,
        priority: i.priority,
        dueAt: i.dueAt?.toISOString() ?? null,
        state: i.state,
        acceptedAt: i.acceptedAt?.toISOString() ?? null,
        resolvedAt: i.resolvedAt?.toISOString() ?? null,
        task: i.taskId ? (taskMap.get(i.taskId) ?? null) : null,
        operation: o ? { id: o.id, title: o.title, type: o.type, status: o.status } : null,
        carriedFromItemId: i.carriedFromItemId,
        rowVersion: i.rowVersion,
      };
    }),
    permissions: {
      edit: h.state === 'draft' && writer,
      submit: h.state === 'draft' && writer,
      acknowledge: h.state === 'submitted' && recipient && holds(ctx, 'handovers.acknowledge'),
      assignRecipient: h.state === 'submitted' && allowed(ctx, 'handovers.write', scope) && allowed(ctx, 'shifts.schedule', shiftScope(from)),
      resolveItems: h.state !== 'draft' && (recipient || writer || allowed(ctx, 'handovers.write', scope)),
      convertToTask: allowed(ctx, 'tasks.create', scope) && (writer || recipient),
    },
  };
};

export const getHandover = async (ctx: QueryContext | CommandContext, id: string) => {
  const [h] = await dbOf(ctx).select().from(handovers).where(and(eq(handovers.workspaceId, ctx.actor.workspaceId), eq(handovers.id, id)));
  if (!h) throw notFound('Handover');
  const from = await loadFromShift(ctx, h);
  if (!canReadHandover(ctx, h, from)) throw notFound('Handover');
  return handoverDetail(ctx, h, from);
};

export interface ListHandoversInput {
  cursor?: string;
  pageSize?: number;
  box: 'incoming' | 'outgoing' | 'all' | 'unacknowledged';
  state?: HandoverRow['state'][];
  accountId?: string;
  projectId?: string;
}

export const listHandovers = async (ctx: QueryContext, input: ListHandoversInput) => {
  if (!holds(ctx, 'handovers.read') && !holds(ctx, 'handovers.acknowledge')) throw new AppError('FORBIDDEN', 'You do not have permission to perform this action.');
  const box: SQL | undefined =
    input.box === 'incoming'
      ? eq(handovers.recipientMembershipId, me(ctx))
      : input.box === 'outgoing'
        ? eq(shifts.membershipId, me(ctx))
        : input.box === 'unacknowledged'
          ? or(
              eq(handovers.state, 'submitted'),
              and(eq(handovers.state, 'acknowledged'), sql`EXISTS (SELECT 1 FROM handover_items hi WHERE hi.handover_id = ${handovers.id} AND hi.state = 'open')`),
            )
          : undefined;
  const k = exprKeyset(handovers.createdAt, handovers.id, 'timestamp', 'desc', input);
  const rows = await ctx.app.db
    .select({ h: handovers })
    .from(handovers)
    .innerJoin(shifts, eq(shifts.id, handovers.fromShiftId))
    .where(
      and(
        eq(handovers.workspaceId, ctx.actor.workspaceId),
        handoverVisibility(ctx),
        box,
        input.box !== 'outgoing' && input.box !== 'all' ? ne(handovers.state, 'draft') : undefined,
        input.state?.length ? inArray(handovers.state, input.state) : undefined,
        input.accountId ? eq(handovers.accountId, input.accountId) : undefined,
        input.projectId ? eq(shifts.projectId, input.projectId) : undefined,
        k.where,
      ),
    )
    .orderBy(...k.orderBy)
    .limit(k.limit);
  const page = k.finish(
    rows.map((r) => r.h),
    (r) => r.createdAt,
    (r) => r.id,
  );
  return { ...page, items: await handoverSummaries(ctx, page.items) };
};

/** Open matters that can be handed over from a shift (referenced, not copied). */
export const handoverCandidates = async (ctx: QueryContext, shiftId: string) => {
  const [s] = await ctx.app.db.select().from(shifts).where(and(eq(shifts.workspaceId, ctx.actor.workspaceId), eq(shifts.id, shiftId)));
  if (!s || !canReadShift(ctx, s)) throw notFound('Shift');
  const links = await ctx.app.db.select({ accountId: shiftAccounts.accountId }).from(shiftAccounts).where(eq(shiftAccounts.shiftId, shiftId));
  const accountIds = links.map((l) => l.accountId);
  if (!accountIds.length) return { carriedItems: [], operations: [] };
  const received = await ctx.app.db
    .select({ item: handoverItems, handoverId: handovers.id })
    .from(handoverItems)
    .innerJoin(handovers, eq(handovers.id, handoverItems.handoverId))
    .where(
      and(
        eq(handoverItems.workspaceId, ctx.actor.workspaceId),
        eq(handovers.recipientMembershipId, s.membershipId),
        inArray(handovers.accountId, accountIds),
        eq(handoverItems.state, 'accepted'),
        sql`NOT EXISTS (SELECT 1 FROM handover_items c WHERE c.carried_from_item_id = ${handoverItems.id})`,
      ),
    )
    .limit(100);
  const inOpenItems = sql`NOT EXISTS (SELECT 1 FROM handover_items x WHERE x.operation_id = ${operations.id} AND x.state = 'open')`;
  const ops = await ctx.app.db
    .select()
    .from(operations)
    .where(
      and(
        eq(operations.workspaceId, ctx.actor.workspaceId),
        inArray(operations.accountId, accountIds),
        eq(operations.ownerMembershipId, s.membershipId),
        inArray(operations.status, ['open', 'in_progress', 'waiting']),
        isNull(operations.archivedAt),
        inOpenItems,
      ),
    )
    .orderBy(asc(operations.dueAt))
    .limit(100);
  const taskMap = await taskRefs(ctx, received.map((r) => r.item.taskId));
  const opIds = received.map((r) => r.item.operationId).filter((x): x is string => !!x);
  const opRows = opIds.length ? await ctx.app.db.select().from(operations).where(inArray(operations.id, opIds)) : [];
  return {
    carriedItems: received.map(({ item: i, handoverId }) => {
      const o = opRows.find((x) => x.id === i.operationId);
      return {
        id: i.id,
        handoverId,
        title: i.title,
        businessExplanation: i.businessExplanation,
        priority: i.priority,
        dueAt: i.dueAt?.toISOString() ?? null,
        state: i.state,
        acceptedAt: i.acceptedAt?.toISOString() ?? null,
        resolvedAt: i.resolvedAt?.toISOString() ?? null,
        task: i.taskId ? (taskMap.get(i.taskId) ?? null) : null,
        operation: o ? { id: o.id, title: o.title, type: o.type, status: o.status } : null,
        carriedFromItemId: i.carriedFromItemId,
        rowVersion: i.rowVersion,
      };
    }),
    operations: await operationSummaries(
      ctx,
      ops.filter((o) => allowed(ctx, 'operations.read', operationScope(o))),
    ),
  };
};

const insertItem = async (ctx: CommandContext, h: HandoverRow, from: ShiftRow, input: HandoverItemInput) => {
  let taskId = input.taskId ?? null;
  let operationId = input.operationId ?? null;
  if (input.carriedFromItemId) {
    const [src] = await ctx.tx
      .select({ item: handoverItems, recipient: handovers.recipientMembershipId })
      .from(handoverItems)
      .innerJoin(handovers, eq(handovers.id, handoverItems.handoverId))
      .where(and(eq(handoverItems.workspaceId, ctx.actor.workspaceId), eq(handoverItems.id, input.carriedFromItemId)));
    if (!src || src.recipient !== from.membershipId) throw fieldErr('carriedFromItemId', 'NOT_FOUND', 'Only items handed over to this shift’s member can be carried on.');
    if (src.item.state !== 'accepted') throw fieldErr('carriedFromItemId', 'NOT_ACCEPTED', 'Accept the item before handing it on, or resolve it.');
    const [already] = await ctx.tx.select({ id: handoverItems.id }).from(handoverItems).where(eq(handoverItems.carriedFromItemId, src.item.id));
    if (already) throw new AppError('DUPLICATE', 'This item was already handed on.');
    taskId = taskId ?? src.item.taskId;
    operationId = operationId ?? src.item.operationId;
  }
  if (taskId) {
    const [t] = await ctx.tx.select({ id: tasks.id, projectId: tasks.projectId }).from(tasks).where(and(eq(tasks.workspaceId, ctx.actor.workspaceId), eq(tasks.id, taskId)));
    if (!t || t.projectId !== from.projectId) throw fieldErr('taskId', 'NOT_FOUND', 'Choose a task of this model.');
    const [open] = await ctx.tx.select({ id: handoverItems.id }).from(handoverItems).where(and(eq(handoverItems.taskId, taskId), eq(handoverItems.state, 'open')));
    if (open) throw new AppError('DUPLICATE', 'This task is already in an open handover item.', { details: { itemId: open.id } });
  }
  if (operationId) {
    const [o] = await ctx.tx.select({ id: operations.id, accountId: operations.accountId }).from(operations).where(and(eq(operations.workspaceId, ctx.actor.workspaceId), eq(operations.id, operationId)));
    if (!o || o.accountId !== h.accountId) throw fieldErr('operationId', 'NOT_FOUND', 'Choose an operation of this account.');
    const [open] = await ctx.tx.select({ id: handoverItems.id }).from(handoverItems).where(and(eq(handoverItems.operationId, operationId), eq(handoverItems.state, 'open')));
    if (open) throw new AppError('DUPLICATE', 'This operation is already in an open handover item.', { details: { itemId: open.id } });
  }
  const id = newId();
  await ctx.tx.insert(handoverItems).values({
    ...stamp(ctx),
    id,
    handoverId: h.id,
    taskId,
    operationId,
    title: input.title.trim(),
    businessExplanation: input.businessExplanation ?? null,
    priority: input.priority,
    dueAt: input.dueAt ? new Date(input.dueAt) : null,
    carriedFromItemId: input.carriedFromItemId ?? null,
  });
  return id;
};

const requireWriterOf = (ctx: Ctx, s: ShiftRow) => {
  if (!isWriter(ctx, s)) {
    if (canReadShift(ctx, s)) throw new AppError('FORBIDDEN', 'You cannot write handovers for this shift.');
    throw notFound('Shift');
  }
};

export const createHandover = async (
  ctx: CommandContext,
  input: { fromShiftId: string; accountId?: string; summary: string; recipientMembershipId?: string | null; toShiftId?: string | null; noOpenItems: boolean; items: HandoverItemInput[] },
) => {
  const from = await lockById(ctx, shifts, input.fromShiftId, 'Shift');
  if (!canReadShift(ctx, from)) throw notFound('Shift');
  requireWriterOf(ctx, from);
  if (!['active', 'paused', 'ended'].includes(from.state)) throw invalid('Handovers are written from a started shift.');
  const links = await ctx.tx.select({ accountId: shiftAccounts.accountId }).from(shiftAccounts).where(eq(shiftAccounts.shiftId, from.id));
  const accountId = input.accountId ?? from.primaryAccountId;
  if (!links.some((l) => l.accountId === accountId)) throw fieldErr('accountId', 'NOT_IN_SHIFT', 'Choose an account of this shift.');
  if (input.noOpenItems && input.items.length) throw fieldErr('noOpenItems', 'CONFLICT', 'Remove the items or clear No Open Items.');
  const [dup] = await ctx.tx.select({ id: handovers.id }).from(handovers).where(and(eq(handovers.fromShiftId, from.id), eq(handovers.accountId, accountId)));
  if (dup) throw new AppError('DUPLICATE', 'A handover from this shift for this account already exists.', { details: { handoverId: dup.id } });
  if (input.recipientMembershipId) await assertActiveMember(ctx, input.recipientMembershipId, 'recipientMembershipId');
  const id = newId();
  const [h] = await ctx.tx
    .insert(handovers)
    .values({
      ...stamp(ctx),
      id,
      fromShiftId: from.id,
      toShiftId: input.toShiftId ?? null,
      recipientMembershipId: input.recipientMembershipId ?? null,
      accountId,
      summary: input.summary.trim(),
      noOpenItems: input.noOpenItems,
    })
    .returning();
  for (const item of input.items) await insertItem(ctx, h!, from, item);
  await audit(ctx, { action: 'handover.created', entityType: 'handover', entityId: id, projectId: from.projectId, metadata: { fromShiftId: from.id, items: input.items.length } });
  await emit(ctx, { type: 'handover.created', entityType: 'handover', entityId: id, revision: 1 });
  return id;
};

const lockHandover = async (ctx: CommandContext, id: string) => {
  const h = await lockById(ctx, handovers, id, 'Handover');
  const from = await loadFromShift(ctx, h);
  if (!canReadHandover(ctx, h, from)) throw notFound('Handover');
  return { h, from };
};

export const updateHandover = async (ctx: CommandContext, id: string, input: { summary?: string; recipientMembershipId?: string | null; toShiftId?: string | null; noOpenItems?: boolean }) => {
  const { h, from } = await lockHandover(ctx, id);
  requireWriterOf(ctx, from);
  assertVersion(ctx, h);
  if (h.state !== 'draft') throw invalid('Only draft handovers can be edited.');
  if (input.recipientMembershipId) await assertActiveMember(ctx, input.recipientMembershipId, 'recipientMembershipId');
  if (input.noOpenItems) {
    const [item] = await ctx.tx.select({ id: handoverItems.id }).from(handoverItems).where(eq(handoverItems.handoverId, id)).limit(1);
    if (item) throw fieldErr('noOpenItems', 'CONFLICT', 'Remove the items or clear No Open Items.');
  }
  await ctx.tx
    .update(handovers)
    .set({
      summary: input.summary?.trim() ?? h.summary,
      recipientMembershipId: input.recipientMembershipId !== undefined ? input.recipientMembershipId : h.recipientMembershipId,
      toShiftId: input.toShiftId !== undefined ? input.toShiftId : h.toShiftId,
      noOpenItems: input.noOpenItems ?? h.noOpenItems,
      ...touch(ctx, handovers),
    })
    .where(eq(handovers.id, id));
  await emit(ctx, { type: 'handover.updated', entityType: 'handover', entityId: id });
  return id;
};

export const addHandoverItem = async (ctx: CommandContext, id: string, input: HandoverItemInput) => {
  const { h, from } = await lockHandover(ctx, id);
  requireWriterOf(ctx, from);
  if (h.state !== 'draft') throw invalid('Items can be added while the handover is a draft.');
  if (h.noOpenItems) throw fieldErr('noOpenItems', 'CONFLICT', 'Clear No Open Items before adding items.');
  await insertItem(ctx, h, from, input);
  await ctx.tx.update(handovers).set({ ...touch(ctx, handovers) }).where(eq(handovers.id, id));
  await emit(ctx, { type: 'handover.updated', entityType: 'handover', entityId: id });
  return id;
};

export const removeHandoverItem = async (ctx: CommandContext, id: string, itemId: string) => {
  const { h, from } = await lockHandover(ctx, id);
  requireWriterOf(ctx, from);
  if (h.state !== 'draft') throw invalid('Items can be removed while the handover is a draft.');
  const deleted = await ctx.tx.delete(handoverItems).where(and(eq(handoverItems.id, itemId), eq(handoverItems.handoverId, id))).returning({ id: handoverItems.id });
  if (!deleted.length) throw notFound('Item');
  await ctx.tx.update(handovers).set({ ...touch(ctx, handovers) }).where(eq(handovers.id, id));
  await emit(ctx, { type: 'handover.updated', entityType: 'handover', entityId: id });
  return id;
};

/** Recipient: chosen member, else the next shift covering the account, else the supervisor (§S44). */
const resolveRecipient = async (ctx: CommandContext, h: HandoverRow, from: ShiftRow, input: { recipientMembershipId?: string | null; toShiftId?: string | null }) => {
  if (input.toShiftId) {
    const [to] = await ctx.tx
      .select({ s: shifts })
      .from(shifts)
      .innerJoin(shiftAccounts, and(eq(shiftAccounts.shiftId, shifts.id), eq(shiftAccounts.accountId, h.accountId)))
      .where(and(eq(shifts.workspaceId, ctx.actor.workspaceId), eq(shifts.id, input.toShiftId), inArray(shifts.state, ['scheduled', 'active', 'paused'])));
    if (!to) throw fieldErr('toShiftId', 'NOT_FOUND', 'Choose an upcoming shift that covers this account.');
    return { recipient: input.recipientMembershipId ?? to.s.membershipId, toShiftId: to.s.id };
  }
  if (input.recipientMembershipId) return { recipient: input.recipientMembershipId, toShiftId: null };
  const [next] = await ctx.tx
    .select({ s: shifts })
    .from(shifts)
    .innerJoin(shiftAccounts, and(eq(shiftAccounts.shiftId, shifts.id), eq(shiftAccounts.accountId, h.accountId)))
    .where(
      and(
        eq(shifts.workspaceId, ctx.actor.workspaceId),
        ne(shifts.id, from.id),
        inArray(shifts.state, ['scheduled', 'active', 'paused']),
        gte(shifts.scheduledStart, from.scheduledStart),
      ),
    )
    .orderBy(asc(shifts.scheduledStart))
    .limit(1);
  if (next) return { recipient: next.s.membershipId, toShiftId: next.s.id };
  return { recipient: await reviewerFor(ctx, from), toShiftId: null };
};

export const submitHandoverInternal = async (ctx: CommandContext, id: string, input: { recipientMembershipId?: string | null; toShiftId?: string | null }) => {
  const h = await lockById(ctx, handovers, id, 'Handover');
  const from = await loadFromShift(ctx, h);
  if (h.state !== 'draft') throw invalid('This handover was already submitted.');
  if (!h.summary.trim()) throw fieldErr('summary', 'REQUIRED', 'Add a summary.');
  const [item] = await ctx.tx.select({ id: handoverItems.id }).from(handoverItems).where(eq(handoverItems.handoverId, id)).limit(1);
  if (!item && !h.noOpenItems) throw fieldErr('noOpenItems', 'HANDOVER_OR_NO_OPEN_ITEMS', 'Add at least one item or confirm No Open Items.');
  if (input.recipientMembershipId) await assertActiveMember(ctx, input.recipientMembershipId, 'recipientMembershipId');
  const r = await resolveRecipient(ctx, h, from, {
    recipientMembershipId: input.recipientMembershipId ?? h.recipientMembershipId,
    toShiftId: input.toShiftId ?? h.toShiftId,
  });
  if (!r.recipient) throw fieldErr('recipientMembershipId', 'REQUIRED', 'No next shift or supervisor was found. Choose a recipient.');
  const at = ctx.app.clock.now();
  await ctx.tx
    .update(handovers)
    .set({ state: 'submitted', submittedAt: at, recipientMembershipId: r.recipient, toShiftId: r.toShiftId, ...touch(ctx, handovers) })
    .where(eq(handovers.id, id));
  await audit(ctx, { action: 'handover.submitted', entityType: 'handover', entityId: id, projectId: from.projectId, metadata: { recipientMembershipId: r.recipient, toShiftId: r.toShiftId } });
  await emit(ctx, { type: 'handover.submitted', entityType: 'handover', entityId: id });
  await notify(ctx.tx, {
    workspaceId: ctx.actor.workspaceId,
    recipientMembershipIds: [r.recipient],
    eventType: 'handover.submitted',
    eventKey: `handover.submitted:${id}:${r.recipient}`,
    kind: 'assignment',
    title: 'Handover waiting for you',
    entityType: 'handover',
    entityId: id,
    projectId: from.projectId,
    actorMembershipId: ctx.actor.membershipId,
    at,
  });
  return id;
};

export const submitHandover = async (ctx: CommandContext, id: string, input: { recipientMembershipId?: string | null; toShiftId?: string | null }) => {
  const { h, from } = await lockHandover(ctx, id);
  requireWriterOf(ctx, from);
  assertVersion(ctx, h);
  return submitHandoverInternal(ctx, id, input);
};

export const acknowledgeHandover = async (ctx: CommandContext, id: string, input: { acceptedItemIds: string[] }) => {
  const { h, from } = await lockHandover(ctx, id);
  if (h.recipientMembershipId !== me(ctx)) throw new AppError('FORBIDDEN', 'Only the recipient acknowledges a handover.');
  assertVersion(ctx, h);
  if (h.state !== 'submitted') throw invalid(h.state === 'draft' ? 'This handover has not been submitted yet.' : 'This handover was already acknowledged.');
  const items = await ctx.tx.select().from(handoverItems).where(eq(handoverItems.handoverId, id));
  const accept = [...new Set(input.acceptedItemIds)];
  const unknown = accept.filter((a) => !items.some((i) => i.id === a && i.state === 'open'));
  if (unknown.length) throw fieldErr('acceptedItemIds', 'NOT_OPEN', 'Accept only open items of this handover.');
  const at = ctx.app.clock.now();
  if (accept.length)
    await ctx.tx.update(handoverItems).set({ state: 'accepted', acceptedAt: at, ...touch(ctx, handoverItems) }).where(inArray(handoverItems.id, accept));
  await ctx.tx.update(handovers).set({ state: 'acknowledged', acknowledgedAt: at, acknowledgedBy: ctx.actor.membershipId, ...touch(ctx, handovers) }).where(eq(handovers.id, id));
  const notAccepted = items.filter((i) => i.state === 'open' && !accept.includes(i.id)).length;
  await audit(ctx, { action: 'handover.acknowledged', entityType: 'handover', entityId: id, projectId: from.projectId, metadata: { accepted: accept.length, notAccepted } });
  await emit(ctx, { type: 'handover.acknowledged', entityType: 'handover', entityId: id, payload: { notAccepted } });
  return id;
};

export const assignHandoverRecipient = async (ctx: CommandContext, id: string, input: { recipientMembershipId: string; toShiftId?: string | null; reason?: string }) => {
  const { h, from } = await lockHandover(ctx, id);
  if (!allowed(ctx, 'handovers.write', shiftScope(from)) || !allowed(ctx, 'shifts.schedule', shiftScope(from)))
    throw new AppError('FORBIDDEN', 'Only a supervisor can re-route handovers.');
  assertVersion(ctx, h);
  if (h.state !== 'submitted') throw invalid('Only submitted, unacknowledged handovers can be re-routed.');
  await assertActiveMember(ctx, input.recipientMembershipId, 'recipientMembershipId');
  const r = await resolveRecipient(ctx, h, from, { recipientMembershipId: input.recipientMembershipId, toShiftId: input.toShiftId ?? null });
  await ctx.tx.update(handovers).set({ recipientMembershipId: r.recipient, toShiftId: r.toShiftId, ...touch(ctx, handovers) }).where(eq(handovers.id, id));
  await audit(ctx, { action: 'handover.rerouted', entityType: 'handover', entityId: id, projectId: from.projectId, reason: input.reason, diff: { recipientMembershipId: { from: h.recipientMembershipId, to: r.recipient } } });
  await emit(ctx, { type: 'handover.updated', entityType: 'handover', entityId: id });
  await notify(ctx.tx, {
    workspaceId: ctx.actor.workspaceId,
    recipientMembershipIds: [r.recipient!],
    eventType: 'handover.submitted',
    eventKey: `handover.submitted:${id}:${r.recipient}`,
    kind: 'assignment',
    title: 'Handover waiting for you',
    entityType: 'handover',
    entityId: id,
    projectId: from.projectId,
    actorMembershipId: ctx.actor.membershipId,
    at: ctx.app.clock.now(),
  });
  return id;
};

const lockItem = async (ctx: CommandContext, itemId: string) => {
  const item = await lockById(ctx, handoverItems, itemId, 'Item');
  const { h, from } = await lockHandover(ctx, item.handoverId);
  return { item: item as ItemRow, h, from };
};

export const resolveHandoverItem = async (ctx: CommandContext, itemId: string, input: { note?: string }) => {
  const { item, h, from } = await lockItem(ctx, itemId);
  const scope = { projectId: from.projectId, accountId: h.accountId };
  if (h.recipientMembershipId !== me(ctx) && !isWriter(ctx, from) && !allowed(ctx, 'handovers.write', scope)) throw new AppError('FORBIDDEN', 'You cannot resolve this item.');
  assertVersion(ctx, item);
  if (h.state === 'draft') throw invalid('Submit the handover first, or remove the item.');
  if (item.state === 'resolved') throw invalid('This item is already resolved.');
  await ctx.tx.update(handoverItems).set({ state: 'resolved', resolvedAt: ctx.app.clock.now(), ...touch(ctx, handoverItems) }).where(eq(handoverItems.id, itemId));
  await audit(ctx, { action: 'handover.item_resolved', entityType: 'handover', entityId: h.id, projectId: from.projectId, reason: input.note, metadata: { itemId } });
  await emit(ctx, { type: 'handover.updated', entityType: 'handover', entityId: h.id });
  return h.id;
};

/** Convert Item to Task: exactly one task per item, linked by id (later handovers reference it). */
export const convertHandoverItem = async (ctx: CommandContext, itemId: string, input: { assigneeMembershipId?: string | null; dueAt?: string | null; title?: string }) => {
  const { item, h, from } = await lockItem(ctx, itemId);
  const scope = { projectId: from.projectId, accountId: h.accountId };
  if (!allowed(ctx, 'tasks.create', scope)) throw new AppError('FORBIDDEN', 'You cannot create tasks for this model.');
  if (h.recipientMembershipId !== me(ctx) && !isWriter(ctx, from)) throw new AppError('FORBIDDEN', 'You cannot convert this item.');
  assertVersion(ctx, item);
  if (item.taskId) throw invalid('This item is already linked to a task.');
  if (item.state === 'resolved') throw invalid('Resolved items are not converted.');
  const assignee = input.assigneeMembershipId !== undefined ? input.assigneeMembershipId : (h.recipientMembershipId ?? from.membershipId);
  if (assignee) await assertActiveMember(ctx, assignee, 'assigneeMembershipId');
  const taskId = await createOfmTask(ctx, {
    projectId: from.projectId,
    accountId: h.accountId,
    title: input.title ?? item.title,
    description: item.businessExplanation,
    assigneeMembershipId: assignee ?? null,
    dueAt: input.dueAt ? new Date(input.dueAt) : item.dueAt,
    priority: item.priority,
    shiftId: from.id,
    operationId: item.operationId,
    source: 'handover',
    notifyTitle: 'Task from a handover assigned to you',
  });
  await ctx.tx.update(handoverItems).set({ taskId, ...touch(ctx, handoverItems) }).where(eq(handoverItems.id, itemId));
  await audit(ctx, { action: 'handover.item_converted', entityType: 'handover', entityId: h.id, projectId: from.projectId, metadata: { itemId, taskId } });
  await emit(ctx, { type: 'handover.updated', entityType: 'handover', entityId: h.id });
  return h.id;
};

