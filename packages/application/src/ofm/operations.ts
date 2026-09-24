import { and, eq, gt, ilike, inArray, isNull, lt, min, sql, type SQL } from 'drizzle-orm';
import { can } from '@castlane/authorization';
import { contentItems, memberships, ofmContacts, operations, shiftAccounts, shifts } from '@castlane/database';
import { AppError, OPERATION_TRANSITIONS, TASK_PRIORITIES, assertTransition, canTransition, newId, notFound, OPERATION_STATUSES } from '@castlane/domain';
import { allowed, loadAccessSnapshot, requirePermission } from '../core/access';
import { audit, diffFields } from '../core/audit';
import { dbOf, type CommandContext, type QueryContext } from '../core/context';
import { emit } from '../core/events';
import { likePattern } from '../core/lookup-registry';
import { loadMemberRefs, refOrUnknown } from '../core/members';
import { notify } from '../core/notify';
import { assertVersion, lockById, stamp, touch } from '../core/rows';
import { indexSearchDocument } from '../core/search';
import { assertAccountOpen, assertActiveMember, assertAssetsExist, exprKeyset, fieldErr, invalid, me, requireOfmAccount, type Ctx } from './common';
import { createOfmTask } from './tasks-bridge';
import { authorRefs, canReadContact, canReadShift, operationScope, operationSummaries, operationVisibility, type OperationRow } from './views';

/**
 * Operations Queue (S47, §13.4): requests, follow-ups and checks with a business state machine.
 * Completion never means payment; Content Request produces a brief task for the creator without any
 * contact notes (T097).
 */

type OpType = OperationRow['type'];
type Priority = (typeof TASK_PRIORITIES)[number];
type Status = (typeof OPERATION_STATUSES)[number];

const PRIORITY_RANK = sql`CASE ${operations.priority} WHEN 'urgent' THEN 4 WHEN 'high' THEN 3 WHEN 'normal' THEN 2 ELSE 1 END`;

export interface ListOperationsInput {
  cursor?: string;
  pageSize?: number;
  status?: Status[];
  type?: OpType[];
  accountId?: string;
  projectId?: string;
  ownerMembershipId?: string;
  contactId?: string;
  shiftId?: string;
  due?: 'overdue' | 'today' | 'week';
  q?: string;
  includeArchived?: boolean;
  sort: 'dueAt' | 'updatedAt' | 'priority' | 'createdAt';
  direction: 'asc' | 'desc';
}

export const listOperations = async (ctx: QueryContext, input: ListOperationsInput) => {
  requirePermission(ctx, 'operations.read');
  const now = ctx.app.clock.now();
  const open = inArray(operations.status, ['open', 'in_progress', 'waiting']);
  const sortExpr =
    input.sort === 'dueAt'
      ? sql`COALESCE(${operations.dueAt}, 'infinity'::timestamptz)`
      : input.sort === 'priority'
        ? PRIORITY_RANK
        : input.sort === 'createdAt'
          ? sql`${operations.createdAt}`
          : sql`${operations.updatedAt}`;
  const k = exprKeyset(sortExpr, operations.id, input.sort === 'priority' ? 'number' : 'timestamp', input.direction, input);
  const rows = await ctx.app.db
    .select()
    .from(operations)
    .where(
      and(
        eq(operations.workspaceId, ctx.actor.workspaceId),
        operationVisibility(ctx),
        input.includeArchived ? undefined : isNull(operations.archivedAt),
        input.status?.length ? inArray(operations.status, input.status) : undefined,
        input.type?.length ? inArray(operations.type, input.type) : undefined,
        input.accountId ? eq(operations.accountId, input.accountId) : undefined,
        input.projectId ? eq(operations.projectId, input.projectId) : undefined,
        input.ownerMembershipId ? eq(operations.ownerMembershipId, input.ownerMembershipId) : undefined,
        input.contactId ? eq(operations.contactId, input.contactId) : undefined,
        input.shiftId ? eq(operations.shiftId, input.shiftId) : undefined,
        input.due === 'overdue' ? and(open, lt(operations.dueAt, now)) : undefined,
        input.due === 'today' ? and(open, lt(operations.dueAt, new Date(now.getTime() + 86_400_000))) : undefined,
        input.due === 'week' ? and(open, lt(operations.dueAt, new Date(now.getTime() + 7 * 86_400_000))) : undefined,
        input.q ? ilike(operations.title, likePattern(input.q)) : undefined,
        k.where,
      ),
    )
    .orderBy(...k.orderBy)
    .limit(k.limit);
  const rank: Record<string, number> = { urgent: 4, high: 3, normal: 2, low: 1 };
  const page = k.finish(
    rows,
    (r) => (input.sort === 'dueAt' ? (r.dueAt ?? new Date(8.64e15)) : input.sort === 'priority' ? rank[r.priority]! : input.sort === 'createdAt' ? r.createdAt : r.updatedAt),
    (r) => r.id,
  );
  return { ...page, items: await operationSummaries(ctx, page.items) };
};

const canRead = (ctx: Ctx, o: OperationRow) => allowed(ctx, 'operations.read', operationScope(o));

export const getOperation = async (ctx: QueryContext | CommandContext, id: string) => {
  requirePermission(ctx, 'operations.read');
  const [o] = await dbOf(ctx).select().from(operations).where(and(eq(operations.workspaceId, ctx.actor.workspaceId), eq(operations.id, id)));
  if (!o || !canRead(ctx, o)) throw notFound('Operation');
  const [summary] = await operationSummaries(ctx, [o]);
  const author = await authorRefs(dbOf(ctx), ctx.actor.workspaceId, [o.createdBy]);
  const scope = operationScope(o);
  const write = allowed(ctx, 'operations.write', scope);
  const active = !['completed', 'cancelled'].includes(o.status) && !o.archivedAt;
  return {
    ...summary!,
    details: o.details,
    createdBy: author(o.createdBy),
    permissions: {
      update: write && active,
      transition: write && active,
      createContentBrief: o.type === 'content_request' && !o.taskId && active && allowed(ctx, 'tasks.create', scope),
      linkContent: write && !o.archivedAt,
      registerSale: allowed(ctx, 'sale-candidates.write', scope),
    },
    allowedTransitions: write && !o.archivedAt ? OPERATION_TRANSITIONS[o.status].filter((t) => canTransition(OPERATION_TRANSITIONS, o.status, t)) : [],
  };
};

const indexOperation = (ctx: CommandContext, o: OperationRow) =>
  // Title and type only: details may mention a contact and are never indexed.
  indexSearchDocument(ctx.tx, {
    workspaceId: ctx.actor.workspaceId,
    entityType: 'operation',
    entityId: o.id,
    title: o.title,
    body: o.type.replace(/_/g, ' '),
    projectId: o.projectId,
    accountId: o.accountId,
    permission: 'operations.read',
    ownerMembershipId: o.ownerMembershipId,
    assigneeMembershipIds: [o.ownerMembershipId],
    archived: !!o.archivedAt,
    status: o.status,
    at: ctx.app.clock.now(),
  });

/** The owner must be able to see the operation (never assign work into a scope the member cannot open). */
const assertOwnerCanRead = async (ctx: CommandContext, ownerId: string, scope: { projectId: string; accountId: string }) => {
  await assertActiveMember(ctx, ownerId, 'ownerMembershipId');
  const [m] = await ctx.tx.select({ userId: memberships.userId }).from(memberships).where(eq(memberships.id, ownerId));
  const snap = m ? await loadAccessSnapshot(ctx.app.db, ctx.actor.workspaceId, m.userId, ctx.app.clock.now()) : null;
  if (!snap || !can(snap, 'operations.read', { ...scope, ownerMembershipId: ownerId, assignedMembershipIds: [ownerId] }))
    throw fieldErr('ownerMembershipId', 'NO_ACCESS', 'This member cannot access operations of this account.');
};

const assertContact = async (ctx: CommandContext, contactId: string, accountId: string) => {
  const [c] = await ctx.tx.select().from(ofmContacts).where(and(eq(ofmContacts.workspaceId, ctx.actor.workspaceId), eq(ofmContacts.id, contactId)));
  if (!c || !canReadContact(ctx, c)) throw fieldErr('contactId', 'NOT_FOUND', 'Choose a contact you can access.');
  if (c.accountId !== accountId) throw fieldErr('contactId', 'OTHER_ACCOUNT', 'The contact belongs to another account.');
  if (c.mergedIntoId || c.erasedAt) throw fieldErr('contactId', 'CLOSED', 'This contact was merged or erased.');
  return c;
};

const assertShift = async (ctx: CommandContext, shiftId: string, accountId: string) => {
  const [s] = await ctx.tx.select().from(shifts).where(and(eq(shifts.workspaceId, ctx.actor.workspaceId), eq(shifts.id, shiftId)));
  const [link] = s ? await ctx.tx.select({ id: shiftAccounts.id }).from(shiftAccounts).where(and(eq(shiftAccounts.shiftId, s.id), eq(shiftAccounts.accountId, accountId))) : [];
  if (!s || !canReadShift(ctx, s) || !link) throw fieldErr('shiftId', 'NOT_FOUND', 'Choose a shift that covers this account.');
};

/** Keep the contact's Next Follow-up in sync with its earliest open follow-up operation. */
const syncFollowUp = async (ctx: CommandContext, contactId: string | null) => {
  if (!contactId) return;
  const [r] = await ctx.tx
    .select({ due: min(operations.dueAt) })
    .from(operations)
    .where(and(eq(operations.contactId, contactId), eq(operations.type, 'follow_up'), inArray(operations.status, ['open', 'in_progress', 'waiting']), isNull(operations.archivedAt)));
  await ctx.tx.update(ofmContacts).set({ nextFollowUpAt: r?.due ?? null }).where(eq(ofmContacts.id, contactId));
};

const notifyOwner = (ctx: CommandContext, o: OperationRow) =>
  o.ownerMembershipId === me(ctx)
    ? Promise.resolve(0)
    : notify(ctx.tx, {
        workspaceId: ctx.actor.workspaceId,
        recipientMembershipIds: [o.ownerMembershipId],
        eventType: 'operation.assigned',
        eventKey: `operation.assigned:${o.id}:${o.ownerMembershipId}`,
        kind: 'assignment',
        title: 'An OFM operation was assigned to you',
        excerpt: o.title,
        entityType: 'operation',
        entityId: o.id,
        projectId: o.projectId,
        actorMembershipId: ctx.actor.membershipId,
        at: ctx.app.clock.now(),
      });

export interface CreateOperationInput {
  type: OpType;
  accountId: string;
  contactId?: string | null;
  ownerMembershipId: string;
  title: string;
  details?: string | null;
  dueAt?: string | null;
  priority: Priority;
  shiftId?: string | null;
  promisedDeliverable?: string | null;
  evidenceAssetIds: string[];
}

export const createOperation = async (ctx: CommandContext, input: CreateOperationInput) => {
  const { account, project } = await requireOfmAccount(ctx, input.accountId);
  const scope = { projectId: project.id, accountId: account.id };
  if (!allowed(ctx, 'operations.write', scope)) {
    if (allowed(ctx, 'operations.read', scope)) throw new AppError('FORBIDDEN', 'You cannot create operations for this account.');
    throw notFound('Account');
  }
  assertAccountOpen(account);
  await assertOwnerCanRead(ctx, input.ownerMembershipId, scope);
  if (input.contactId) await assertContact(ctx, input.contactId, account.id);
  if (input.shiftId) await assertShift(ctx, input.shiftId, account.id);
  const evidence = await assertAssetsExist(ctx, input.evidenceAssetIds, 'evidenceAssetIds');
  const id = newId();
  const [row] = await ctx.tx
    .insert(operations)
    .values({
      ...stamp(ctx),
      id,
      accountId: account.id,
      projectId: project.id,
      contactId: input.contactId ?? null,
      ownerMembershipId: input.ownerMembershipId,
      type: input.type,
      title: input.title.trim(),
      details: input.details?.trim() || null,
      dueAt: input.dueAt ? new Date(input.dueAt) : null,
      priority: input.priority,
      shiftId: input.shiftId ?? null,
      promisedDeliverable: input.promisedDeliverable ?? null,
      evidenceAssetIds: evidence,
    })
    .returning();
  if (row!.type === 'follow_up') await syncFollowUp(ctx, row!.contactId);
  await audit(ctx, {
    action: 'operation.created',
    entityType: 'operation',
    entityId: id,
    projectId: project.id,
    diff: diffFields(null, row!, ['type', 'accountId', 'ownerMembershipId', 'title', 'dueAt', 'priority', 'contactId', 'shiftId'], ['details']),
  });
  await emit(ctx, { type: 'operation.created', entityType: 'operation', entityId: id, revision: 1, payload: { type: row!.type } });
  await indexOperation(ctx, row!);
  await notifyOwner(ctx, row!);
  return id;
};

const lockOperation = async (ctx: CommandContext, id: string) => {
  const o = await lockById(ctx, operations, id, 'Operation');
  if (!canRead(ctx, o)) throw notFound('Operation');
  if (!allowed(ctx, 'operations.write', operationScope(o))) throw new AppError('FORBIDDEN', 'You cannot change this operation.');
  return o;
};

export const updateOperation = async (
  ctx: CommandContext,
  id: string,
  input: { title?: string; details?: string | null; dueAt?: string | null; priority?: Priority; ownerMembershipId?: string; contactId?: string | null; promisedDeliverable?: string | null; evidenceAssetIds?: string[] },
) => {
  const o = await lockOperation(ctx, id);
  assertVersion(ctx, o);
  if (['completed', 'cancelled'].includes(o.status) || o.archivedAt) throw invalid('Closed operations cannot be edited.');
  if (input.ownerMembershipId && input.ownerMembershipId !== o.ownerMembershipId) await assertOwnerCanRead(ctx, input.ownerMembershipId, { projectId: o.projectId, accountId: o.accountId });
  if (input.contactId) await assertContact(ctx, input.contactId, o.accountId);
  const evidence = input.evidenceAssetIds ? await assertAssetsExist(ctx, input.evidenceAssetIds, 'evidenceAssetIds') : o.evidenceAssetIds;
  const [row] = await ctx.tx
    .update(operations)
    .set({
      title: input.title?.trim() ?? o.title,
      details: input.details !== undefined ? input.details?.trim() || null : o.details,
      dueAt: input.dueAt !== undefined ? (input.dueAt ? new Date(input.dueAt) : null) : o.dueAt,
      priority: input.priority ?? o.priority,
      ownerMembershipId: input.ownerMembershipId ?? o.ownerMembershipId,
      contactId: input.contactId !== undefined ? input.contactId : o.contactId,
      promisedDeliverable: input.promisedDeliverable !== undefined ? input.promisedDeliverable : o.promisedDeliverable,
      evidenceAssetIds: evidence,
      ...touch(ctx, operations),
    })
    .where(eq(operations.id, id))
    .returning();
  if (row!.type === 'follow_up') {
    await syncFollowUp(ctx, o.contactId);
    if (row!.contactId !== o.contactId) await syncFollowUp(ctx, row!.contactId);
  }
  await audit(ctx, {
    action: 'operation.updated',
    entityType: 'operation',
    entityId: id,
    projectId: o.projectId,
    diff: diffFields(o, row!, ['title', 'details', 'dueAt', 'priority', 'ownerMembershipId', 'contactId', 'promisedDeliverable'], ['details']),
  });
  await emit(ctx, { type: 'operation.updated', entityType: 'operation', entityId: id, revision: row!.rowVersion });
  await indexOperation(ctx, row!);
  if (row!.ownerMembershipId !== o.ownerMembershipId) await notifyOwner(ctx, row!);
  return id;
};

/** Waiting needs Waiting For + Next Check At; Completed needs an Outcome; Cancelled needs a Reason. No payment effect. */
export const transitionOperation = async (
  ctx: CommandContext,
  id: string,
  input: { targetState: Status; outcome?: string; reason?: string; waitingFor?: string; nextCheckAt?: string },
) => {
  const o = await lockOperation(ctx, id);
  assertVersion(ctx, o);
  if (o.archivedAt) throw invalid('Archived operations cannot change.');
  assertTransition(OPERATION_TRANSITIONS, o.status, input.targetState, 'operation');
  const now = ctx.app.clock.now();
  const patch: Partial<OperationRow> = { status: input.targetState };
  if (input.targetState === 'waiting') {
    const errors = [];
    if (!input.waitingFor) errors.push({ field: 'waitingFor', code: 'REQUIRED', message: 'Say what the operation is waiting for.' });
    if (!input.nextCheckAt) errors.push({ field: 'nextCheckAt', code: 'REQUIRED', message: 'Choose when to check again.' });
    else if (new Date(input.nextCheckAt).getTime() <= now.getTime()) errors.push({ field: 'nextCheckAt', code: 'MUST_BE_FUTURE', message: 'Choose a future date and time.' });
    if (errors.length) throw new AppError('VALIDATION_FAILED', errors[0]!.message, { fieldErrors: errors });
    patch.waitingFor = input.waitingFor!;
    patch.nextCheckAt = new Date(input.nextCheckAt!);
  } else {
    patch.waitingFor = null;
    patch.nextCheckAt = null;
  }
  if (input.targetState === 'completed') {
    if (!input.outcome) throw fieldErr('outcome', 'REQUIRED', 'Record the outcome to complete the operation.');
    patch.outcome = input.outcome;
    patch.completedAt = now;
  }
  if (input.targetState === 'cancelled') {
    if (!input.reason) throw fieldErr('reason', 'REQUIRED', 'Give a reason for cancelling.');
    patch.cancelReason = input.reason;
  }
  const [row] = await ctx.tx.update(operations).set({ ...patch, ...touch(ctx, operations) }).where(eq(operations.id, id)).returning();
  if (row!.type === 'follow_up') await syncFollowUp(ctx, row!.contactId);
  await audit(ctx, {
    action: `operation.${input.targetState}`,
    entityType: 'operation',
    entityId: id,
    projectId: o.projectId,
    reason: input.reason ?? null,
    diff: { status: { from: o.status, to: input.targetState } },
  });
  await emit(ctx, { type: 'operation.status_changed', entityType: 'operation', entityId: id, revision: row!.rowVersion, payload: { from: o.status, to: input.targetState } });
  await indexOperation(ctx, row!);
  return id;
};

/**
 * Content Request → brief (T097). The creator receives a task holding ONLY the brief the manager wrote
 * for production; contact alias, notes and interaction history are not copied and remain invisible to
 * the creator (who has no contacts permission).
 */
export const createContentRequestBrief = async (ctx: CommandContext, id: string, input: { creatorMembershipId: string; title: string; brief: string; dueAt?: string | null }) => {
  const o = await lockById(ctx, operations, id, 'Operation');
  if (!canRead(ctx, o)) throw notFound('Operation');
  if (!allowed(ctx, 'tasks.create', { projectId: o.projectId, accountId: o.accountId })) throw new AppError('FORBIDDEN', 'You cannot create production tasks for this model.');
  assertVersion(ctx, o);
  if (o.type !== 'content_request') throw invalid('Only Content Request operations produce a brief.');
  if (o.taskId) throw invalid('A brief task already exists for this request.', { taskId: o.taskId });
  if (['completed', 'cancelled'].includes(o.status)) throw invalid('The request is closed.');
  await assertActiveMember(ctx, input.creatorMembershipId, 'creatorMembershipId');
  const [m] = await ctx.tx.select({ userId: memberships.userId }).from(memberships).where(eq(memberships.id, input.creatorMembershipId));
  const snap = await loadAccessSnapshot(ctx.app.db, ctx.actor.workspaceId, m!.userId, ctx.app.clock.now());
  if (!snap || !can(snap, 'tasks.read', { projectId: o.projectId, accountId: o.accountId, assignedMembershipIds: [input.creatorMembershipId] }))
    throw fieldErr('creatorMembershipId', 'NO_ACCESS', 'This member cannot access production tasks of this model.');
  const taskId = await createOfmTask(ctx, {
    projectId: o.projectId,
    accountId: o.accountId,
    title: input.title,
    description: input.brief.trim(),
    assigneeMembershipId: input.creatorMembershipId,
    dueAt: input.dueAt ? new Date(input.dueAt) : o.dueAt,
    priority: o.priority,
    operationId: o.id,
    source: 'manual',
    notifyTitle: 'Content request brief assigned to you',
  });
  const [row] = await ctx.tx
    .update(operations)
    .set({ taskId, status: o.status === 'open' ? 'in_progress' : o.status, ...touch(ctx, operations) })
    .where(eq(operations.id, id))
    .returning();
  await audit(ctx, { action: 'operation.content_brief_created', entityType: 'operation', entityId: id, projectId: o.projectId, metadata: { taskId, creatorMembershipId: input.creatorMembershipId } });
  await emit(ctx, { type: 'operation.updated', entityType: 'operation', entityId: id, revision: row!.rowVersion, payload: { taskId } });
  return id;
};

export const linkOperationContent = async (ctx: CommandContext, id: string, input: { contentItemId: string | null }) => {
  const o = await lockOperation(ctx, id);
  assertVersion(ctx, o);
  if (input.contentItemId) {
    const [ci] = await ctx.tx.select({ id: contentItems.id, projectId: contentItems.projectId }).from(contentItems).where(and(eq(contentItems.workspaceId, ctx.actor.workspaceId), eq(contentItems.id, input.contentItemId)));
    if (!ci || ci.projectId !== o.projectId) throw fieldErr('contentItemId', 'NOT_FOUND', 'Choose content of this model.');
  }
  const [row] = await ctx.tx.update(operations).set({ contentItemId: input.contentItemId, ...touch(ctx, operations) }).where(eq(operations.id, id)).returning();
  await audit(ctx, { action: 'operation.content_linked', entityType: 'operation', entityId: id, projectId: o.projectId, diff: { contentItemId: { from: o.contentItemId, to: input.contentItemId } } });
  await emit(ctx, { type: 'operation.updated', entityType: 'operation', entityId: id, revision: row!.rowVersion });
  return id;
};

export const archiveOperationInternal = async (ctx: CommandContext, o: OperationRow, reason?: string) => {
  const [row] = await ctx.tx
    .update(operations)
    .set({ archivedAt: ctx.app.clock.now(), archivedBy: ctx.actor.userId, archiveReason: reason ?? null, ...touch(ctx, operations) })
    .where(eq(operations.id, o.id))
    .returning();
  await audit(ctx, { action: 'operation.archived', entityType: 'operation', entityId: o.id, projectId: o.projectId, reason });
  await emit(ctx, { type: 'operation.archived', entityType: 'operation', entityId: o.id, revision: row!.rowVersion });
  await indexOperation(ctx, row!);
};

export const restoreOperationInternal = async (ctx: CommandContext, o: OperationRow) => {
  const [row] = await ctx.tx.update(operations).set({ archivedAt: null, archivedBy: null, archiveReason: null, ...touch(ctx, operations) }).where(eq(operations.id, o.id)).returning();
  await audit(ctx, { action: 'operation.restored', entityType: 'operation', entityId: o.id, projectId: o.projectId });
  await emit(ctx, { type: 'operation.restored', entityType: 'operation', entityId: o.id, revision: row!.rowVersion });
  await indexOperation(ctx, row!);
};

