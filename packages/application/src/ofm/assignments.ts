import { and, asc, desc, eq, gt, inArray, isNull, lte, ne, or, sql, type SQL } from 'drizzle-orm';
import { accountAssignments, ofmAssignments, ofmProfiles, shiftAccounts, shifts } from '@castlane/database';
import { AppError, RESPONSIBILITIES, newId, notFound } from '@castlane/domain';
import { allowed, requireAnyPermission, scopePredicate } from '../core/access';
import { audit, diffFields } from '../core/audit';
import { all, dbOf, type CommandContext, type QueryContext } from '../core/context';
import { emit } from '../core/events';
import { loadMemberRefs, refOrUnknown } from '../core/members';
import { notify } from '../core/notify';
import { assertVersion, lockById, stamp, touch } from '../core/rows';
import {
  accountRefOr,
  advisoryLocks,
  anyOf,
  assertAccountOpen,
  assertActiveMember,
  bumpAccessRevision,
  exprKeyset,
  fieldErr,
  invalid,
  loadAccountInfos,
  loadProjectInfos,
  me,
  projectRefOr,
  requireOfmAccount,
  type AccountInfo,
  type Ctx,
} from './common';
import { shiftBriefs, type ShiftRow } from './views';

/** OFM assignments (S41): member ↔ model account for a validity interval and coverage lane. */

export type AssignmentRow = typeof ofmAssignments.$inferSelect;
type Responsibility = (typeof RESPONSIBILITIES)[number];
type Lane = AssignmentRow['coverageLane'];

export const assignmentScope = (a: Pick<AssignmentRow, 'id' | 'projectId' | 'accountId' | 'membershipId' | 'supervisorMembershipId'>) => ({
  objectType: 'ofm_assignment',
  objectId: a.id,
  projectId: a.projectId,
  accountId: a.accountId,
  ownerMembershipId: a.membershipId,
  assignedMembershipIds: [a.membershipId, a.supervisorMembershipId],
});

const canReadAssignment = (ctx: Ctx, a: AssignmentRow) =>
  a.membershipId === me(ctx) ||
  allowed(ctx, 'ofm.assignments.manage', assignmentScope(a)) ||
  allowed(ctx, 'ofm.overview.read', assignmentScope(a));

const statusOf = (a: AssignmentRow, now: Date): 'upcoming' | 'current' | 'ended' => {
  if (a.endedAt && a.endedAt.getTime() <= now.getTime()) return 'ended';
  if (a.validTo && a.validTo.getTime() <= now.getTime()) return 'ended';
  if (a.validFrom.getTime() > now.getTime()) return 'upcoming';
  return 'current';
};

/** SQL: assignment active at `at` (the same rule as the access snapshot). */
export const activeAt = (at: Date): SQL =>
  and(isNull(ofmAssignments.endedAt), lte(ofmAssignments.validFrom, at), or(isNull(ofmAssignments.validTo), gt(ofmAssignments.validTo, at)))!;

/** SQL: assignment covers the whole interval [start, end]. */
export const coversInterval = (start: Date, end: Date): SQL =>
  and(
    lte(ofmAssignments.validFrom, start),
    or(isNull(ofmAssignments.validTo), sql`${ofmAssignments.validTo} >= ${end}`),
    or(isNull(ofmAssignments.endedAt), sql`${ofmAssignments.endedAt} >= ${end}`),
  )!;

export const assignmentRows = async (ctx: Ctx, rows: AssignmentRow[]) => {
  if (!rows.length) return [];
  const db = dbOf(ctx);
  const ws = ctx.actor.workspaceId;
  const now = ctx.app.clock.now();
  const [accounts, projects, refs] = await all(ctx, [
    () => loadAccountInfos(db, ws, rows.map((r) => r.accountId)),
    () => loadProjectInfos(db, ws, rows.map((r) => r.projectId)),
    () => loadMemberRefs(db, ws, rows.flatMap((r) => [r.membershipId, r.supervisorMembershipId])),
  ] as const);
  return rows.map((a) => ({
    id: a.id,
    project: projectRefOr(projects, a.projectId),
    account: accountRefOr(accounts, a.accountId, a.projectId),
    member: refOrUnknown(refs, a.membershipId)!,
    responsibility: (RESPONSIBILITIES as readonly string[]).includes(a.responsibility) ? (a.responsibility as Responsibility) : ('ofm_operations' as const),
    coverageLane: a.coverageLane,
    coverageLaneLabel: a.coverageLaneLabel,
    validFrom: a.validFrom.toISOString(),
    validTo: a.validTo?.toISOString() ?? null,
    supervisor: refOrUnknown(refs, a.supervisorMembershipId),
    handoverRequired: a.handoverRequired,
    endedAt: a.endedAt?.toISOString() ?? null,
    endedReason: a.endedReason,
    transferredFromId: a.transferredFromId,
    status: statusOf(a, now),
    createdAt: a.createdAt.toISOString(),
    rowVersion: a.rowVersion,
  }));
};

export interface ListAssignmentsInput {
  cursor?: string;
  pageSize?: number;
  projectId?: string;
  accountId?: string;
  membershipId?: string;
  status?: ('upcoming' | 'current' | 'ended')[];
  sort: 'validFrom' | 'member' | 'account';
  direction: 'asc' | 'desc';
}

export const listAssignments = async (ctx: QueryContext, input: ListAssignmentsInput) => {
  requireAnyPermission(ctx, ['ofm.assignments.manage', 'ofm.overview.read']);
  const now = ctx.app.clock.now();
  const cols = { projectId: ofmAssignments.projectId, accountId: ofmAssignments.accountId, ownerMembership: ofmAssignments.membershipId };
  const visibility = anyOf(scopePredicate(ctx, 'ofm.assignments.manage', cols), scopePredicate(ctx, 'ofm.overview.read', cols), eq(ofmAssignments.membershipId, me(ctx)));
  const statusConds: SQL[] = [];
  for (const s of input.status ?? []) {
    if (s === 'current') statusConds.push(activeAt(now));
    if (s === 'upcoming') statusConds.push(and(isNull(ofmAssignments.endedAt), gt(ofmAssignments.validFrom, now))!);
    if (s === 'ended') statusConds.push(or(sql`${ofmAssignments.endedAt} <= ${now}`, sql`${ofmAssignments.validTo} <= ${now}`)!);
  }
  // Sorting by member/account uses stable ids (names live in other tables); validFrom is the default.
  const sortExpr = input.sort === 'member' ? ofmAssignments.membershipId : input.sort === 'account' ? ofmAssignments.accountId : ofmAssignments.validFrom;
  const k = exprKeyset(sortExpr, ofmAssignments.id, input.sort === 'validFrom' ? 'timestamp' : 'text', input.direction, input);
  const rows = await dbOf(ctx)
    .select()
    .from(ofmAssignments)
    .where(
      and(
        eq(ofmAssignments.workspaceId, ctx.actor.workspaceId),
        visibility,
        input.projectId ? eq(ofmAssignments.projectId, input.projectId) : undefined,
        input.accountId ? eq(ofmAssignments.accountId, input.accountId) : undefined,
        input.membershipId ? eq(ofmAssignments.membershipId, input.membershipId) : undefined,
        statusConds.length ? or(...statusConds) : undefined,
        k.where,
      ),
    )
    .orderBy(...k.orderBy)
    .limit(k.limit);
  const page = k.finish(rows, (r) => (input.sort === 'member' ? r.membershipId : input.sort === 'account' ? r.accountId : r.validFrom), (r) => r.id);
  return { ...page, items: await assignmentRows(ctx, page.items) };
};

/** Scheduled/active shifts of a member that include the account (optionally outside an interval). */
const memberShiftsOnAccount = async (ctx: Ctx, membershipId: string, accountId: string, cond?: SQL) =>
  dbOf(ctx)
    .select({ shift: shifts })
    .from(shifts)
    .innerJoin(shiftAccounts, and(eq(shiftAccounts.shiftId, shifts.id), eq(shiftAccounts.accountId, accountId)))
    .where(and(eq(shifts.workspaceId, ctx.actor.workspaceId), eq(shifts.membershipId, membershipId), inArray(shifts.state, ['scheduled', 'active', 'paused']), cond))
    .orderBy(asc(shifts.scheduledStart))
    .then((r) => r.map((x) => x.shift));

export const getAssignment = async (ctx: QueryContext | CommandContext, id: string) => {
  const db = dbOf(ctx);
  const [a] = await db.select().from(ofmAssignments).where(and(eq(ofmAssignments.workspaceId, ctx.actor.workspaceId), eq(ofmAssignments.id, id)));
  if (!a || !canReadAssignment(ctx, a)) throw notFound('Assignment');
  const now = ctx.app.clock.now();
  const [upcoming, history] = await all(ctx, [
    () => memberShiftsOnAccount(ctx, a.membershipId, a.accountId, sql`${shifts.scheduledEnd} >= ${now}`),
    () =>
      db
        .select()
        .from(ofmAssignments)
        .where(and(eq(ofmAssignments.workspaceId, ctx.actor.workspaceId), eq(ofmAssignments.accountId, a.accountId), ne(ofmAssignments.id, a.id)))
        .orderBy(desc(ofmAssignments.validFrom))
        .limit(50),
  ] as const);
  const [row] = await assignmentRows(ctx, [a]);
  const scope = assignmentScope(a);
  const manage = allowed(ctx, 'ofm.assignments.manage', scope);
  const ended = statusOf(a, now) === 'ended';
  return {
    ...row!,
    upcomingShifts: await shiftBriefs(ctx, upcoming.slice(0, 20)),
    history: await assignmentRows(ctx, history.filter((h) => canReadAssignment(ctx, h))),
    permissions: { update: manage && !ended, end: manage && !ended, transfer: manage && !ended },
  };
};

const authorizeManage = (ctx: Ctx, scope: { projectId: string; accountId: string }) => {
  if (allowed(ctx, 'ofm.assignments.manage', scope)) return;
  if (allowed(ctx, 'ofm.overview.read', scope) || allowed(ctx, 'accounts.read', scope)) throw new AppError('FORBIDDEN', 'You cannot manage OFM assignments for this account.');
  throw notFound('Account');
};

const assertNoOverlap = async (ctx: CommandContext, input: { accountId: string; membershipId: string; validFrom: Date; validTo: Date | null; excludeId?: string }) => {
  const rows = await ctx.tx
    .select({ id: ofmAssignments.id })
    .from(ofmAssignments)
    .where(
      and(
        eq(ofmAssignments.workspaceId, ctx.actor.workspaceId),
        eq(ofmAssignments.accountId, input.accountId),
        eq(ofmAssignments.membershipId, input.membershipId),
        isNull(ofmAssignments.endedAt),
        input.excludeId ? ne(ofmAssignments.id, input.excludeId) : undefined,
        or(isNull(ofmAssignments.validTo), gt(ofmAssignments.validTo, input.validFrom)),
        input.validTo ? sql`${ofmAssignments.validFrom} < ${input.validTo}` : undefined,
      ),
    );
  if (rows.length)
    throw new AppError('CONFLICT', 'This member already has an overlapping assignment for this account.', { details: { assignmentIds: rows.map((r) => r.id) } });
};

const defaultSupervisor = async (ctx: CommandContext, projectId: string) => {
  const [p] = await ctx.tx.select({ s: ofmProfiles.supervisorMembershipId }).from(ofmProfiles).where(eq(ofmProfiles.projectId, projectId));
  return p?.s ?? null;
};

const notifyAssignment = (ctx: CommandContext, a: AssignmentRow, account: AccountInfo, key: string, title: string) =>
  notify(ctx.tx, {
    workspaceId: ctx.actor.workspaceId,
    recipientMembershipIds: [a.membershipId],
    eventType: 'ofm_assignment.changed',
    eventKey: key,
    kind: 'assignment',
    title,
    excerpt: account.handle ? `@${account.handle}` : account.displayName,
    entityType: 'ofm_assignment',
    entityId: a.id,
    projectId: a.projectId,
    actorMembershipId: ctx.actor.membershipId,
    at: ctx.app.clock.now(),
  });

export interface CreateAssignmentInput {
  accountId: string;
  membershipId: string;
  responsibility: Responsibility;
  coverageLane: Lane;
  coverageLaneLabel?: string | null;
  validFrom: string;
  validTo?: string | null;
  supervisorMembershipId?: string | null;
  handoverRequired?: boolean;
}

export const createAssignment = async (ctx: CommandContext, input: CreateAssignmentInput, opts: { transferredFromId?: string } = {}) => {
  const { account, project } = await requireOfmAccount(ctx, input.accountId);
  authorizeManage(ctx, { projectId: project.id, accountId: account.id });
  assertAccountOpen(account);
  await assertActiveMember(ctx, input.membershipId, 'membershipId');
  if (input.supervisorMembershipId) await assertActiveMember(ctx, input.supervisorMembershipId, 'supervisorMembershipId');
  const validFrom = new Date(input.validFrom);
  const validTo = input.validTo ? new Date(input.validTo) : null;
  if (validTo && validTo.getTime() <= validFrom.getTime()) throw fieldErr('validTo', 'BEFORE_START', 'Valid To must be after Valid From.');
  if (input.coverageLane === 'custom' && !input.coverageLaneLabel) throw fieldErr('coverageLaneLabel', 'REQUIRED', 'Name the custom coverage lane.');
  await advisoryLocks(ctx, [`ofm-assign:${account.id}:${input.membershipId}`]);
  await assertNoOverlap(ctx, { accountId: account.id, membershipId: input.membershipId, validFrom, validTo });
  const id = newId();
  const [row] = await ctx.tx
    .insert(ofmAssignments)
    .values({
      ...stamp(ctx),
      id,
      projectId: project.id,
      accountId: account.id,
      membershipId: input.membershipId,
      responsibility: input.responsibility,
      coverageLane: input.coverageLane,
      coverageLaneLabel: input.coverageLane === 'custom' ? (input.coverageLaneLabel ?? null) : null,
      validFrom,
      validTo,
      supervisorMembershipId: input.supervisorMembershipId ?? (await defaultSupervisor(ctx, project.id)),
      handoverRequired: input.handoverRequired ?? true,
      transferredFromId: opts.transferredFromId ?? null,
    })
    .returning();
  await bumpAccessRevision(ctx, [input.membershipId]);
  await audit(ctx, {
    action: 'ofm_assignment.created',
    entityType: 'ofm_assignment',
    entityId: id,
    projectId: project.id,
    diff: diffFields(null, row!, ['accountId', 'membershipId', 'responsibility', 'coverageLane', 'validFrom', 'validTo', 'supervisorMembershipId', 'handoverRequired']),
    sensitivity: 'security',
  });
  await emit(ctx, { type: 'ofm_assignment.created', entityType: 'ofm_assignment', entityId: id, revision: 1, payload: { accountId: account.id, membershipId: input.membershipId } });
  await notifyAssignment(ctx, row!, account, `ofm_assignment.created:${id}`, 'You were assigned to an OFM account');
  return id;
};

const lockAssignment = async (ctx: CommandContext, id: string) => {
  const a = await lockById(ctx, ofmAssignments, id, 'Assignment');
  if (!canReadAssignment(ctx, a)) throw notFound('Assignment');
  authorizeManage(ctx, { projectId: a.projectId, accountId: a.accountId });
  return a;
};

const outsideInterval = (validFrom: Date, validTo: Date | null): SQL =>
  or(sql`${shifts.scheduledStart} < ${validFrom}`, validTo ? sql`${shifts.scheduledEnd} > ${validTo}` : sql`false`)!;

export const updateAssignment = async (
  ctx: CommandContext,
  id: string,
  input: { responsibility?: Responsibility; coverageLane?: Lane; coverageLaneLabel?: string | null; validFrom?: string; validTo?: string | null; supervisorMembershipId?: string | null; handoverRequired?: boolean },
) => {
  const a = await lockAssignment(ctx, id);
  assertVersion(ctx, a);
  const now = ctx.app.clock.now();
  if (statusOf(a, now) === 'ended') throw invalid('Ended assignments are history and cannot change.');
  const validFrom = input.validFrom ? new Date(input.validFrom) : a.validFrom;
  if (input.validFrom && validFrom.getTime() !== a.validFrom.getTime() && a.validFrom.getTime() <= now.getTime())
    throw fieldErr('validFrom', 'STARTED', 'The start of an assignment that already began cannot change.');
  const validTo = input.validTo === undefined ? a.validTo : input.validTo ? new Date(input.validTo) : null;
  if (validTo && validTo.getTime() <= validFrom.getTime()) throw fieldErr('validTo', 'BEFORE_START', 'Valid To must be after Valid From.');
  const lane = input.coverageLane ?? a.coverageLane;
  const laneLabel = lane === 'custom' ? (input.coverageLaneLabel !== undefined ? input.coverageLaneLabel : a.coverageLaneLabel) : null;
  if (lane === 'custom' && !laneLabel) throw fieldErr('coverageLaneLabel', 'REQUIRED', 'Name the custom coverage lane.');
  if (input.supervisorMembershipId) await assertActiveMember(ctx, input.supervisorMembershipId, 'supervisorMembershipId');
  await advisoryLocks(ctx, [`ofm-assign:${a.accountId}:${a.membershipId}`]);
  await assertNoOverlap(ctx, { accountId: a.accountId, membershipId: a.membershipId, validFrom, validTo, excludeId: a.id });
  const intervalChanged = validFrom.getTime() !== a.validFrom.getTime() || (validTo?.getTime() ?? null) !== (a.validTo?.getTime() ?? null);
  if (intervalChanged) {
    const outside = await memberShiftsOnAccount(ctx, a.membershipId, a.accountId, and(eq(shifts.state, 'scheduled'), outsideInterval(validFrom, validTo)));
    if (outside.length)
      throw invalid(`Cancel or reassign ${outside.length} scheduled shift(s) outside the new interval first.`, { shifts: await shiftBriefs(ctx, outside) });
  }
  const [row] = await ctx.tx
    .update(ofmAssignments)
    .set({
      responsibility: input.responsibility ?? a.responsibility,
      coverageLane: lane,
      coverageLaneLabel: laneLabel,
      validFrom,
      validTo,
      supervisorMembershipId: input.supervisorMembershipId !== undefined ? input.supervisorMembershipId : a.supervisorMembershipId,
      handoverRequired: input.handoverRequired ?? a.handoverRequired,
      ...touch(ctx, ofmAssignments),
    })
    .where(eq(ofmAssignments.id, id))
    .returning();
  if (intervalChanged) await bumpAccessRevision(ctx, [a.membershipId]);
  await audit(ctx, {
    action: 'ofm_assignment.updated',
    entityType: 'ofm_assignment',
    entityId: id,
    projectId: a.projectId,
    diff: diffFields(a, row!, ['responsibility', 'coverageLane', 'coverageLaneLabel', 'validFrom', 'validTo', 'supervisorMembershipId', 'handoverRequired']),
    sensitivity: 'security',
  });
  await emit(ctx, { type: 'ofm_assignment.updated', entityType: 'ofm_assignment', entityId: id, revision: row!.rowVersion });
  return id;
};

/** End (history kept). Blocks while the member is mid-shift or has scheduled shifts after the end. */
export const endAssignment = async (ctx: CommandContext, id: string, input: { endAt?: string; reason: string }, opts: { skipVersion?: boolean } = {}) => {
  const a = await lockAssignment(ctx, id);
  if (!opts.skipVersion) assertVersion(ctx, a);
  const now = ctx.app.clock.now();
  if (statusOf(a, now) === 'ended') throw invalid('This assignment has already ended.');
  const endAt = input.endAt ? new Date(input.endAt) : now;
  if (endAt.getTime() < now.getTime() - 60_000) throw fieldErr('endAt', 'IN_PAST', 'An assignment cannot end in the past.');
  if (endAt.getTime() <= a.validFrom.getTime() && a.validFrom.getTime() <= now.getTime()) throw fieldErr('endAt', 'BEFORE_START', 'End must be after the start.');
  const active = await memberShiftsOnAccount(ctx, a.membershipId, a.accountId, and(inArray(shifts.state, ['active', 'paused']), sql`${endAt} <= ${now}`));
  if (active.length) throw invalid('The member is on an active shift for this account. End the shift first.', { shifts: await shiftBriefs(ctx, active) });
  const after = await memberShiftsOnAccount(ctx, a.membershipId, a.accountId, and(eq(shifts.state, 'scheduled'), sql`${shifts.scheduledEnd} > ${endAt}`));
  if (after.length)
    throw invalid(`Cancel or reassign ${after.length} scheduled shift(s) after the end first.`, { shifts: await shiftBriefs(ctx, after) });
  const immediate = endAt.getTime() <= now.getTime() + 60_000;
  const upcomingOnly = a.validFrom.getTime() > now.getTime();
  const [row] = await ctx.tx
    .update(ofmAssignments)
    .set({
      validTo: upcomingOnly && immediate ? a.validTo : a.validTo && a.validTo.getTime() < endAt.getTime() ? a.validTo : endAt,
      endedAt: immediate ? now : null,
      endedReason: input.reason,
      ...touch(ctx, ofmAssignments),
    })
    .where(eq(ofmAssignments.id, id))
    .returning();
  await bumpAccessRevision(ctx, [a.membershipId]);
  await audit(ctx, { action: 'ofm_assignment.ended', entityType: 'ofm_assignment', entityId: id, projectId: a.projectId, reason: input.reason, diff: diffFields(a, row!, ['validTo', 'endedAt']), sensitivity: 'security' });
  await emit(ctx, { type: 'ofm_assignment.ended', entityType: 'ofm_assignment', entityId: id, revision: row!.rowVersion });
  const accounts = await loadAccountInfos(ctx.tx, ctx.actor.workspaceId, [a.accountId]);
  await notifyAssignment(ctx, row!, accounts.get(a.accountId)!, `ofm_assignment.ended:${id}`, 'Your OFM assignment ends');
  return id;
};

/**
 * Transfer: the old assignment ends at the effective time, a new one starts for the successor with the
 * same lane, and (optionally) future scheduled shifts move after overlap/assignment checks.
 */
export const transferAssignment = async (
  ctx: CommandContext,
  id: string,
  input: { toMembershipId: string; effectiveAt?: string; reason: string; moveFutureShifts: boolean },
  opts: { skipVersion?: boolean } = {},
) => {
  const a = await lockAssignment(ctx, id);
  if (!opts.skipVersion) assertVersion(ctx, a);
  const now = ctx.app.clock.now();
  if (statusOf(a, now) === 'ended') throw invalid('This assignment has already ended.');
  if (input.toMembershipId === a.membershipId) throw fieldErr('toMembershipId', 'SAME_MEMBER', 'Choose a different member.');
  await assertActiveMember(ctx, input.toMembershipId, 'toMembershipId');
  const effectiveAt = input.effectiveAt ? new Date(input.effectiveAt) : now;
  if (effectiveAt.getTime() < now.getTime() - 60_000) throw fieldErr('effectiveAt', 'IN_PAST', 'Choose now or a future time.');
  const startAt = effectiveAt.getTime() < a.validFrom.getTime() ? a.validFrom : effectiveAt;
  const future = await memberShiftsOnAccount(ctx, a.membershipId, a.accountId, and(eq(shifts.state, 'scheduled'), sql`${shifts.scheduledEnd} > ${startAt}`));
  if (future.length && !input.moveFutureShifts)
    throw invalid(`Cancel or move ${future.length} scheduled shift(s) first, or transfer them with the assignment.`, { shifts: await shiftBriefs(ctx, future) });
  // New assignment for the successor.
  const newId_ = await createAssignment(
    ctx,
    {
      accountId: a.accountId,
      membershipId: input.toMembershipId,
      responsibility: (RESPONSIBILITIES as readonly string[]).includes(a.responsibility) ? (a.responsibility as Responsibility) : 'ofm_operations',
      coverageLane: a.coverageLane,
      coverageLaneLabel: a.coverageLaneLabel,
      validFrom: startAt.toISOString(),
      validTo: a.validTo?.toISOString() ?? null,
      supervisorMembershipId: a.supervisorMembershipId,
      handoverRequired: a.handoverRequired,
    },
    { transferredFromId: a.id },
  );
  if (future.length) {
    const { reassignShift } = await import('./shifts');
    for (const s of future) {
      if (s.scheduledStart.getTime() < startAt.getTime()) continue;
      await reassignShift(ctx, s, input.toMembershipId, input.reason);
    }
  }
  const immediate = startAt.getTime() <= now.getTime() + 60_000;
  const [row] = await ctx.tx
    .update(ofmAssignments)
    .set({ validTo: startAt, endedAt: immediate ? now : null, endedReason: input.reason, ...touch(ctx, ofmAssignments) })
    .where(eq(ofmAssignments.id, id))
    .returning();
  await bumpAccessRevision(ctx, [a.membershipId]);
  await audit(ctx, {
    action: 'ofm_assignment.transferred',
    entityType: 'ofm_assignment',
    entityId: id,
    projectId: a.projectId,
    reason: input.reason,
    metadata: { toMembershipId: input.toMembershipId, newAssignmentId: newId_, movedShifts: future.length },
    diff: diffFields(a, row!, ['validTo', 'endedAt']),
    sensitivity: 'security',
  });
  await emit(ctx, { type: 'ofm_assignment.transferred', entityType: 'ofm_assignment', entityId: id, revision: row!.rowVersion, payload: { newAssignmentId: newId_ } });
  return newId_;
};

/** Access impact preview (S41): what the member will (no longer) see. Never grants finance access. */
export const assignmentImpact = async (
  ctx: QueryContext,
  input: { membershipId: string; accountId: string; validFrom?: string; validTo?: string; assignmentId?: string; action: 'create' | 'update' | 'end' | 'transfer' },
) => {
  const { account, project } = await requireOfmAccount(ctx, input.accountId);
  if (!allowed(ctx, 'ofm.assignments.manage', { projectId: project.id, accountId: account.id })) throw notFound('Account');
  const db = dbOf(ctx);
  const ws = ctx.actor.workspaceId;
  const now = ctx.app.clock.now();
  const [others, acct, refs] = await all(ctx, [
    () =>
      db
        .select({ id: ofmAssignments.id })
        .from(ofmAssignments)
        .where(and(eq(ofmAssignments.workspaceId, ws), eq(ofmAssignments.accountId, account.id), eq(ofmAssignments.membershipId, input.membershipId), activeAt(now), input.assignmentId ? ne(ofmAssignments.id, input.assignmentId) : undefined)),
    () =>
      db
        .select({ id: accountAssignments.id })
        .from(accountAssignments)
        .where(
          and(
            eq(accountAssignments.workspaceId, ws),
            eq(accountAssignments.accountId, account.id),
            eq(accountAssignments.membershipId, input.membershipId),
            lte(accountAssignments.validFrom, now),
            or(isNull(accountAssignments.validTo), gt(accountAssignments.validTo, now)),
          ),
        ),
    () => loadMemberRefs(db, ws, [input.membershipId]),
  ] as const);
  const alreadyVisible = others.length + acct.length > 0;
  const validFrom = input.validFrom ? new Date(input.validFrom) : now;
  const validTo = input.validTo ? new Date(input.validTo) : null;
  let outside: ShiftRow[] = [];
  if (input.action === 'end' || input.action === 'transfer')
    outside = await memberShiftsOnAccount(ctx, input.membershipId, account.id, and(eq(shifts.state, 'scheduled'), sql`${shifts.scheduledEnd} > ${validTo ?? now}`));
  else if (input.action === 'update') outside = await memberShiftsOnAccount(ctx, input.membershipId, account.id, and(eq(shifts.state, 'scheduled'), outsideInterval(validFrom, validTo)));
  const notes = [
    'OFM assignments never grant finance access by themselves.',
    'Contacts stay hidden unless the member’s role includes the Contacts permission.',
    alreadyVisible ? 'The member already sees this account through another assignment.' : null,
  ].filter((x): x is string => !!x);
  return {
    member: refOrUnknown(refs, input.membershipId)!,
    account: accountRefOr(new Map([[account.id, account]]), account.id, project.id),
    gainsAccountAccess: (input.action === 'create' || input.action === 'update') && !alreadyVisible,
    losesAccountAccess: (input.action === 'end' || input.action === 'transfer') && !alreadyVisible,
    financeAccess: false as const,
    notes,
    shiftsOutsideInterval: await shiftBriefs(ctx, outside),
  };
};
