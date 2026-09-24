import { and, asc, desc, eq, gte, inArray, isNull, lte, lt, ne, or, sql, type SQL } from 'drizzle-orm';
import { hasAnywhere } from '@castlane/authorization';
import { memberships, tasks, timeEntries, timeSheetSubmissions, userPreferences, users, workspaces } from '@castlane/database';
import type { TimeEntryView, TimeSheetView } from '@castlane/api-contracts';
import { AppError, clampPageSize, decodeCursor, encodeCursor, isoDateAddDays, localDate, newId, notFound, weekStartDate } from '@castlane/domain';
import { allowed, authorizeRead, requireAnyPermission, requirePermission, scopePredicate, whereAll } from '../core/access';
import { audit, diffFields } from '../core/audit';
import { dbOf, type CommandContext, type QueryContext } from '../core/context';
import { emit } from '../core/events';
import { defineJob, defineSchedule, systemJobContext } from '../core/jobs-registry';
import { executeSystemCommand } from '../core/command';
import { loadMemberRefs, refOrUnknown } from '../core/members';
import { notify } from '../core/notify';
import { assertVersion, stamp, touch } from '../core/rows';
import { MAX_ENTRY_SECONDS, overlappingIds, findOverlaps, TIMER_REVIEW_AFTER_SECONDS, validateInterval } from './rules/time';
import { fieldFail, loadTask, memberCan, projectNames, taskScope } from './shared';

type EntryRow = typeof timeEntries.$inferSelect;
type SheetRow = typeof timeSheetSubmissions.$inferSelect;

const EDITABLE: EntryRow['state'][] = ['draft', 'needs_review', 'returned'];
const entryScope = (e: Pick<EntryRow, 'id' | 'projectId' | 'membershipId'>) => ({ objectType: 'time_entry', objectId: e.id, projectId: e.projectId, ownerMembershipId: e.membershipId, assignedMembershipIds: [e.membershipId] });

/** Own entries always; others' entries only with time.read.scope over their project. */
const canSeeEntry = (ctx: QueryContext, e: EntryRow) =>
  (e.membershipId === ctx.actor.membershipId && allowed(ctx, 'time.read.own', entryScope(e))) || allowed(ctx, 'time.read.scope', entryScope(e));

/** Time entries visible to the actor: own entries, and entries in projects with time.read.scope. */
export const timeVisibilitySql = (ctx: QueryContext): SQL => {
  const me = ctx.actor.membershipId;
  const own = me && hasAnywhere(ctx.actor.access, 'time.read.own') ? eq(timeEntries.membershipId, me) : undefined;
  const scoped = hasAnywhere(ctx.actor.access, 'time.read.scope') ? scopePredicate(ctx, 'time.read.scope', { projectId: timeEntries.projectId }) ?? sql`true` : undefined;
  const parts = [own, scoped].filter((p): p is SQL => !!p);
  return parts.length === 0 ? sql`false` : parts.length === 1 ? parts[0]! : or(...parts)!;
};

/** Member timezone (personal preference, else workspace). */
export const memberTimezone = async (ctx: QueryContext | CommandContext, membershipId: string): Promise<string> => {
  const [r] = await dbOf(ctx)
    .select({ userTz: userPreferences.timezone, wsTz: workspaces.timezone })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
    .leftJoin(userPreferences, eq(userPreferences.userId, users.id))
    .where(and(eq(memberships.workspaceId, ctx.actor.workspaceId), eq(memberships.id, membershipId)));
  return r?.userTz ?? r?.wsTz ?? ctx.actor.timezone;
};

const workspaceWeekStart = async (ctx: QueryContext | CommandContext) => {
  const [w] = await dbOf(ctx).select({ weekStartsOn: workspaces.weekStartsOn }).from(workspaces).where(eq(workspaces.id, ctx.actor.workspaceId));
  return w?.weekStartsOn ?? 'monday';
};

/** Overlaps of each entry with the same member's other intervals (running timers and superseded rows excluded). */
const overlapMap = async (ctx: QueryContext | CommandContext, entries: EntryRow[]) => {
  const out = new Map<string, string[]>();
  const members = [...new Set(entries.map((e) => e.membershipId))];
  if (members.length === 0) return out;
  const withTimes = entries.filter((e) => e.startedAt && e.endedAt);
  if (withTimes.length === 0) return out;
  const min = new Date(Math.min(...withTimes.map((e) => e.startedAt!.getTime())) - 86_400_000);
  const max = new Date(Math.max(...withTimes.map((e) => e.endedAt!.getTime())) + 86_400_000);
  const others = await dbOf(ctx)
    .select()
    .from(timeEntries)
    .where(
      and(
        eq(timeEntries.workspaceId, ctx.actor.workspaceId),
        inArray(timeEntries.membershipId, members),
        ne(timeEntries.state, 'running'),
        isNull(timeEntries.supersededAt),
        lt(timeEntries.startedAt, max),
        gte(timeEntries.endedAt, min),
      ),
    );
  // An approved entry being corrected by a pending revision does not overlap with that revision.
  const revisionOf = new Map(others.filter((o) => o.revisionOfId).map((o) => [o.id, o.revisionOfId!]));
  for (const m of members) {
    const list = others.filter((o) => o.membershipId === m && o.startedAt && o.endedAt).map((o) => ({ id: o.id, startedAt: o.startedAt!, endedAt: o.endedAt! }));
    for (const [a, b] of findOverlaps(list)) {
      if (revisionOf.get(a) === b || revisionOf.get(b) === a) continue;
      out.set(a, [...(out.get(a) ?? []), b]);
      out.set(b, [...(out.get(b) ?? []), a]);
    }
  }
  return out;
};

export const toEntryViews = async (ctx: QueryContext | CommandContext, rows: EntryRow[]): Promise<TimeEntryView[]> => {
  if (rows.length === 0) return [];
  const db = dbOf(ctx);
  const ws = ctx.actor.workspaceId;
  const taskRows = await db.select().from(tasks).where(and(eq(tasks.workspaceId, ws), inArray(tasks.id, [...new Set(rows.map((r) => r.taskId))])));
  const taskBy = new Map(taskRows.map((t) => [t.id, t]));
  const names = await projectNames(db, ws, rows.map((r) => r.projectId));
  const refs = await loadMemberRefs(db, ws, rows.flatMap((r) => [r.membershipId, r.approvedBy, r.closedByMembershipId]));
  const overlaps = await overlapMap(ctx, rows);
  const me = ctx.actor.membershipId;
  const openRevisions = await db
    .select({ of: timeEntries.revisionOfId })
    .from(timeEntries)
    .where(and(eq(timeEntries.workspaceId, ws), inArray(timeEntries.revisionOfId, rows.map((r) => r.id)), isNull(timeEntries.supersededAt), ne(timeEntries.state, 'approved')));
  const hasOpenRevision = new Set(openRevisions.map((r) => r.of));
  return rows.map((e) => {
    const t = taskBy.get(e.taskId);
    const readable = !!t && allowed(ctx, 'tasks.read', taskScope(t));
    const own = e.membershipId === me;
    const canApprove = allowed(ctx, 'time.approve', entryScope(e));
    return {
      id: e.id,
      member: refOrUnknown(refs, e.membershipId)!,
      task: { id: e.taskId, title: readable ? t!.title : null, status: readable ? t!.status : null, readable },
      project: { id: e.projectId, name: names.get(e.projectId)?.name ?? 'Unknown project' },
      source: e.source,
      state: e.state,
      startedAt: e.startedAt?.toISOString() ?? null,
      endedAt: e.endedAt?.toISOString() ?? null,
      durationSeconds: e.durationSeconds,
      workDate: e.workDate,
      note: e.note,
      ...(canApprove ? { billable: e.billable } : {}),
      submissionId: e.submissionId,
      approvedAt: e.approvedAt?.toISOString() ?? null,
      approvedBy: refOrUnknown(refs, e.approvedBy),
      returnedReason: e.returnedReason,
      revisionOf: e.revisionOfId,
      supersededAt: e.supersededAt?.toISOString() ?? null,
      needsReviewReason: e.needsReviewReason,
      closedBy: refOrUnknown(refs, e.closedByMembershipId),
      closeReason: e.closeReason,
      overlapsWith: overlaps.get(e.id) ?? [],
      permissions: {
        edit: own && EDITABLE.includes(e.state),
        discard: own && EDITABLE.includes(e.state),
        revise: own && e.state === 'approved' && !e.supersededAt && !hasOpenRevision.has(e.id),
        approve: !own && e.state === 'submitted' && canApprove,
        stop: own && e.state === 'running',
        close: !own && e.state === 'running' && canApprove,
      },
      createdAt: e.createdAt.toISOString(),
      rowVersion: e.rowVersion,
    };
  });
};

const timerView = async (ctx: QueryContext | CommandContext, e: EntryRow) => {
  const [v] = await toEntryViews(ctx, [e]);
  const now = ctx.app.clock.now();
  return {
    id: e.id,
    task: v!.task,
    project: v!.project,
    startedAt: e.startedAt!.toISOString(),
    elapsedSeconds: Math.max(0, Math.floor((now.getTime() - e.startedAt!.getTime()) / 1000)),
    needsReview: !!e.needsReviewReason || now.getTime() - e.startedAt!.getTime() > TIMER_REVIEW_AFTER_SECONDS * 1000,
    note: e.note,
    rowVersion: e.rowVersion,
  };
};

export const currentTimer = async (ctx: QueryContext) => {
  const me = ctx.actor.membershipId;
  if (!me) return { timer: null };
  const [e] = await dbOf(ctx)
    .select()
    .from(timeEntries)
    .where(and(eq(timeEntries.workspaceId, ctx.actor.workspaceId), eq(timeEntries.membershipId, me), eq(timeEntries.state, 'running')));
  return { timer: e ? await timerView(ctx, e) : null };
};

const taskForTime = async (ctx: CommandContext, taskId: string) => {
  const t = await loadTask(ctx, taskId);
  const scope = taskScope(t);
  authorizeRead(ctx, 'tasks.read', scope);
  if (!allowed(ctx, 'time.write.own', scope)) throw new AppError('FORBIDDEN', 'You cannot record time on this task.');
  if (t.archivedAt) throw new AppError('INVALID_STATE', 'Archived tasks accept no time entries.');
  return t;
};

/** Start a timer: one running timer per member, enforced by a partial unique index (T056). */
export const startTimer = async (ctx: CommandContext, input: { taskId: string; note?: string }) => {
  requirePermission(ctx, 'time.write.own');
  const me = ctx.actor.membershipId;
  if (!me) throw new AppError('FORBIDDEN', 'Only members can track time.');
  const t = await taskForTime(ctx, input.taskId);
  if (t.status === 'done' || t.status === 'cancelled') throw new AppError('INVALID_STATE', 'Start timers on open tasks only. Add a manual entry for past work.');
  const [running] = await ctx.tx
    .select({ id: timeEntries.id, taskId: timeEntries.taskId })
    .from(timeEntries)
    .where(and(eq(timeEntries.membershipId, me), eq(timeEntries.state, 'running')));
  if (running) throw new AppError('CONFLICT', 'A timer is already running. Stop it before starting another one.', { details: { timerId: running.id, taskId: running.taskId } });
  const at = ctx.app.clock.now();
  const tz = await memberTimezone(ctx, me);
  const id = newId();
  const [row] = await ctx.tx
    .insert(timeEntries)
    .values({ ...stamp(ctx), id, membershipId: me, taskId: t.id, projectId: t.projectId, source: 'timer', state: 'running', startedAt: at, workDate: localDate(at, tz), note: input.note?.trim() || null })
    .returning();
  await audit(ctx, { action: 'time.timer_started', entityType: 'time_entry', entityId: id, projectId: t.projectId, metadata: { taskId: t.id } });
  await emit(ctx, { type: 'time.timer_started', entityType: 'time_entry', entityId: id, revision: 1, payload: { taskId: t.id } });
  return timerView(ctx, row!);
};

const lockEntry = async (ctx: CommandContext, id: string) => {
  const [e] = await ctx.tx.select().from(timeEntries).where(and(eq(timeEntries.workspaceId, ctx.actor.workspaceId), eq(timeEntries.id, id))).for('update');
  if (!e || !canSeeEntry(ctx, e)) throw notFound('Time entry');
  return e;
};

const closeInterval = (start: Date, end: Date) => {
  const ms = end.getTime() - start.getTime();
  if (ms <= 0) throw fieldFail('endedAt', 'END_BEFORE_START', 'The end must be after the start.');
  // Whole seconds; a timer stopped within its first second still records its (positive) interval.
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds > MAX_ENTRY_SECONDS) throw fieldFail('endedAt', 'TOO_LONG', 'A time entry can be at most 24 hours. Enter when you actually stopped.');
  return seconds;
};

/**
 * Stop your timer. The server interval is authoritative; a replay of Stop returns the same entry
 * and never creates a second one (T057). A timer running longer than 24 h is never cut off
 * automatically: the member enters the actual end.
 */
export const stopTimer = async (ctx: CommandContext, timerId: string, input: { note?: string; endedAt?: string; reason?: string }) => {
  const e = await lockEntry(ctx, timerId);
  if (e.membershipId !== ctx.actor.membershipId) throw new AppError('FORBIDDEN', 'Only the member who started a timer can stop it. Managers can close it with the actual end.');
  if (e.state !== 'running') return (await toEntryViews(ctx, [e]))[0]!;
  const now = ctx.app.clock.now();
  const end = input.endedAt ? new Date(input.endedAt) : now;
  if (end.getTime() > now.getTime() + 60_000) throw fieldFail('endedAt', 'IN_FUTURE', 'The end cannot be in the future.');
  if (input.endedAt && !input.reason?.trim() && Math.abs(end.getTime() - now.getTime()) > 5 * 60_000)
    throw fieldFail('reason', 'REQUIRED', 'Explain why the actual end differs from now.');
  const seconds = closeInterval(e.startedAt!, end);
  const long = seconds > TIMER_REVIEW_AFTER_SECONDS;
  const [row] = await ctx.tx
    .update(timeEntries)
    .set({
      state: long ? 'needs_review' : 'draft',
      endedAt: end,
      durationSeconds: seconds,
      note: input.note?.trim() || e.note,
      needsReviewReason: long ? (e.needsReviewReason ?? 'The timer ran longer than 12 hours.') : e.needsReviewReason,
      closeReason: input.reason?.trim() || null,
      ...touch(ctx, timeEntries),
    })
    .where(eq(timeEntries.id, e.id))
    .returning();
  await audit(ctx, { action: 'time.timer_stopped', entityType: 'time_entry', entityId: e.id, projectId: e.projectId, reason: input.reason ?? null, metadata: { durationSeconds: seconds } });
  await emit(ctx, { type: 'time.timer_stopped', entityType: 'time_entry', entityId: e.id, revision: row!.rowVersion });
  return (await toEntryViews(ctx, [row!]))[0]!;
};

/** A manager closes someone else's running timer with the actual end and a reason (T058: no fake auto-stop). */
export const closeTimer = async (ctx: CommandContext, timerId: string, input: { endedAt: string; reason: string }) => {
  const e = await lockEntry(ctx, timerId);
  if (!allowed(ctx, 'time.approve', entryScope(e))) throw new AppError('FORBIDDEN', 'Closing someone else’s timer needs time approval rights.');
  if (e.membershipId === ctx.actor.membershipId) throw new AppError('INVALID_STATE', 'Stop your own timer instead.');
  if (e.state !== 'running') throw new AppError('INVALID_STATE', 'This timer is no longer running.');
  const now = ctx.app.clock.now();
  const end = new Date(input.endedAt);
  if (end.getTime() > now.getTime()) throw fieldFail('endedAt', 'IN_FUTURE', 'The end cannot be in the future.');
  const seconds = closeInterval(e.startedAt!, end);
  const [row] = await ctx.tx
    .update(timeEntries)
    .set({
      state: 'needs_review',
      endedAt: end,
      durationSeconds: seconds,
      needsReviewReason: 'Closed by a manager with the actual end.',
      closedByMembershipId: ctx.actor.membershipId,
      closeReason: input.reason.trim(),
      ...touch(ctx, timeEntries),
    })
    .where(eq(timeEntries.id, e.id))
    .returning();
  await audit(ctx, { action: 'time.timer_closed', entityType: 'time_entry', entityId: e.id, projectId: e.projectId, reason: input.reason, metadata: { endedAt: end.toISOString() } });
  await emit(ctx, { type: 'time.timer_closed', entityType: 'time_entry', entityId: e.id, revision: row!.rowVersion });
  await notify(ctx.tx, {
    workspaceId: e.workspaceId,
    recipientMembershipIds: [e.membershipId],
    eventType: 'time.timer_closed',
    eventKey: `time.timer_closed:${e.id}`,
    kind: 'general',
    title: 'Your timer was closed by a manager — please review the entry',
    excerpt: input.reason,
    entityType: 'time_entry',
    entityId: e.id,
    projectId: e.projectId,
    actorMembershipId: ctx.actor.membershipId,
    at: now,
  });
  return (await toEntryViews(ctx, [row!]))[0]!;
};

interface EntryInput {
  taskId?: string;
  startedAt?: string | null;
  endedAt?: string | null;
  durationMinutes?: number | null;
  workDate?: string;
  note?: string | null;
  billable?: boolean;
}

/** Normalise start/end or duration-on-a-date into stored columns, with §11 validation. */
const resolveInterval = (input: EntryInput, tz: string, now: Date) => {
  const start = input.startedAt ? new Date(input.startedAt) : null;
  const end = input.endedAt ? new Date(input.endedAt) : null;
  if (start || end) {
    if (!start || !end) throw fieldFail(start ? 'endedAt' : 'startedAt', 'REQUIRED', 'Enter both start and end, or a duration.');
    const problem = validateInterval(start, end, now);
    if (problem === 'END_BEFORE_START') throw fieldFail('endedAt', problem, 'The end must be after the start.');
    if (problem === 'TOO_LONG') throw fieldFail('endedAt', problem, 'A time entry can be at most 24 hours.');
    if (problem === 'IN_FUTURE') throw fieldFail('endedAt', problem, 'Time entries cannot be in the future.');
    return { startedAt: start, endedAt: end, durationSeconds: Math.floor((end.getTime() - start.getTime()) / 1000), workDate: input.workDate ?? localDate(start, tz) };
  }
  if (!input.durationMinutes) throw fieldFail('durationMinutes', 'REQUIRED', 'Enter start and end, or a duration.');
  const workDate = input.workDate ?? localDate(now, tz);
  if (workDate > localDate(now, tz)) throw fieldFail('workDate', 'IN_FUTURE', 'Time entries cannot be in the future.');
  return { startedAt: null, endedAt: null, durationSeconds: input.durationMinutes * 60, workDate };
};

export const createTimeEntry = async (ctx: CommandContext, input: EntryInput & { taskId: string }) => {
  requirePermission(ctx, 'time.write.own');
  const me = ctx.actor.membershipId;
  if (!me) throw new AppError('FORBIDDEN', 'Only members can track time.');
  const t = await taskForTime(ctx, input.taskId);
  const tz = await memberTimezone(ctx, me);
  const iv = resolveInterval(input, tz, ctx.app.clock.now());
  if (input.billable !== undefined && !allowed(ctx, 'time.approve', { projectId: t.projectId })) throw fieldFail('billable', 'NOT_ALLOWED', 'You cannot set the billable flag.');
  const id = newId();
  const [row] = await ctx.tx
    .insert(timeEntries)
    .values({ ...stamp(ctx), id, membershipId: me, taskId: t.id, projectId: t.projectId, source: 'manual', state: 'draft', ...iv, note: input.note?.trim() || null, billable: input.billable ?? false })
    .returning();
  await audit(ctx, { action: 'time.entry_created', entityType: 'time_entry', entityId: id, projectId: t.projectId, metadata: { taskId: t.id, durationSeconds: iv.durationSeconds, workDate: iv.workDate } });
  await emit(ctx, { type: 'time.entry_created', entityType: 'time_entry', entityId: id, revision: 1 });
  return (await toEntryViews(ctx, [row!]))[0]!;
};

export const updateTimeEntry = async (ctx: CommandContext, id: string, input: EntryInput) => {
  const e = await lockEntry(ctx, id);
  if (e.membershipId !== ctx.actor.membershipId) throw new AppError('FORBIDDEN', 'You can only edit your own time entries.');
  assertVersion(ctx, e);
  if (!EDITABLE.includes(e.state)) throw new AppError('INVALID_STATE', e.state === 'approved' ? 'Approved time is corrected with a revision, not edited.' : 'Submitted time cannot be edited until it is returned.');
  const tz = await memberTimezone(ctx, e.membershipId);
  let taskId = e.taskId;
  let projectId = e.projectId;
  if (input.taskId && input.taskId !== e.taskId) {
    const t = await taskForTime(ctx, input.taskId);
    taskId = t.id;
    projectId = t.projectId;
  }
  const intervalTouched = input.startedAt !== undefined || input.endedAt !== undefined || input.durationMinutes !== undefined || input.workDate !== undefined;
  const iv = intervalTouched
    ? resolveInterval(
        {
          startedAt: input.startedAt !== undefined ? input.startedAt : e.startedAt?.toISOString(),
          endedAt: input.endedAt !== undefined ? input.endedAt : e.endedAt?.toISOString(),
          durationMinutes: input.durationMinutes !== undefined ? input.durationMinutes : e.startedAt ? null : Math.round((e.durationSeconds ?? 0) / 60),
          workDate: input.workDate ?? e.workDate,
        },
        tz,
        ctx.app.clock.now(),
      )
    : null;
  if (input.billable !== undefined && !allowed(ctx, 'time.approve', { projectId })) throw fieldFail('billable', 'NOT_ALLOWED', 'You cannot set the billable flag.');
  const [row] = await ctx.tx
    .update(timeEntries)
    .set({
      taskId,
      projectId,
      ...(iv ?? {}),
      ...(input.note !== undefined ? { note: input.note?.trim() || null } : {}),
      ...(input.billable !== undefined ? { billable: input.billable } : {}),
      // Editing confirms the entry: Needs Review / Returned go back to Draft (reasons stay in history).
      state: 'draft',
      needsReviewReason: null,
      ...touch(ctx, timeEntries),
    })
    .where(eq(timeEntries.id, id))
    .returning();
  await audit(ctx, { action: 'time.entry_updated', entityType: 'time_entry', entityId: id, projectId, diff: diffFields(e, row!, ['taskId', 'startedAt', 'endedAt', 'durationSeconds', 'workDate', 'note', 'billable', 'state']) });
  await emit(ctx, { type: 'time.entry_updated', entityType: 'time_entry', entityId: id, revision: row!.rowVersion });
  return (await toEntryViews(ctx, [row!]))[0]!;
};

export const discardTimeEntry = async (ctx: CommandContext, id: string) => {
  const e = await lockEntry(ctx, id);
  if (e.membershipId !== ctx.actor.membershipId) throw new AppError('FORBIDDEN', 'You can only discard your own time entries.');
  assertVersion(ctx, e);
  if (!EDITABLE.includes(e.state)) throw new AppError('INVALID_STATE', 'Only unapproved, unsubmitted entries can be discarded.');
  await ctx.tx.delete(timeEntries).where(eq(timeEntries.id, id));
  await audit(ctx, { action: 'time.entry_discarded', entityType: 'time_entry', entityId: id, projectId: e.projectId, metadata: { durationSeconds: e.durationSeconds, workDate: e.workDate, taskId: e.taskId } });
  await emit(ctx, { type: 'time.entry_discarded', entityType: 'time_entry', entityId: id });
  return { ok: true as const };
};

/** Approved time is corrected by a new revision; the approved row stays until the revision is approved. */
export const reviseTimeEntry = async (ctx: CommandContext, id: string, input: EntryInput & { reason: string }) => {
  const e = await lockEntry(ctx, id);
  if (e.membershipId !== ctx.actor.membershipId) throw new AppError('FORBIDDEN', 'You can only correct your own time.');
  if (e.state !== 'approved' || e.supersededAt) throw new AppError('INVALID_STATE', 'Only the current approved entry can be corrected with a revision.');
  const [open] = await ctx.tx
    .select({ id: timeEntries.id })
    .from(timeEntries)
    .where(and(eq(timeEntries.revisionOfId, id), isNull(timeEntries.supersededAt), ne(timeEntries.state, 'approved')));
  if (open) throw new AppError('CONFLICT', 'A correction of this entry is already pending.', { details: { revisionId: open.id } });
  const tz = await memberTimezone(ctx, e.membershipId);
  const t = input.taskId ? await taskForTime(ctx, input.taskId) : null;
  const iv = resolveInterval(
    {
      startedAt: input.startedAt !== undefined ? input.startedAt : e.startedAt?.toISOString(),
      endedAt: input.endedAt !== undefined ? input.endedAt : e.endedAt?.toISOString(),
      durationMinutes: input.durationMinutes !== undefined ? input.durationMinutes : e.startedAt ? null : Math.round((e.durationSeconds ?? 0) / 60),
      workDate: input.workDate ?? e.workDate,
    },
    tz,
    ctx.app.clock.now(),
  );
  const newIdValue = newId();
  const [row] = await ctx.tx
    .insert(timeEntries)
    .values({
      ...stamp(ctx),
      id: newIdValue,
      membershipId: e.membershipId,
      taskId: t?.id ?? e.taskId,
      projectId: t?.projectId ?? e.projectId,
      source: e.source,
      state: 'draft',
      ...iv,
      note: input.note !== undefined ? input.note?.trim() || null : e.note,
      billable: e.billable,
      revisionOfId: e.id,
    })
    .returning();
  await audit(ctx, { action: 'time.entry_revised', entityType: 'time_entry', entityId: newIdValue, projectId: row!.projectId, reason: input.reason, metadata: { revisionOf: e.id } });
  await emit(ctx, { type: 'time.entry_revised', entityType: 'time_entry', entityId: newIdValue, revision: 1 });
  return (await toEntryViews(ctx, [row!]))[0]!;
};

const overlapProblems = async (ctx: CommandContext, entries: EntryRow[]) => {
  const map = await overlapMap(ctx, entries);
  return entries.filter((e) => (map.get(e.id) ?? []).length).map((e) => ({ id: e.id, workDate: e.workDate, overlapsWith: map.get(e.id)! }));
};

const approveRows = async (ctx: CommandContext, rows: EntryRow[], note: string | null) => {
  const at = ctx.app.clock.now();
  for (const e of rows) {
    await ctx.tx.update(timeEntries).set({ state: 'approved', approvedAt: at, approvedBy: ctx.actor.membershipId, ...touch(ctx, timeEntries) }).where(eq(timeEntries.id, e.id));
    if (e.revisionOfId) await ctx.tx.update(timeEntries).set({ supersededAt: at, ...touch(ctx, timeEntries) }).where(eq(timeEntries.id, e.revisionOfId));
    await audit(ctx, { action: 'time.entry_approved', entityType: 'time_entry', entityId: e.id, projectId: e.projectId, reason: note, metadata: { durationSeconds: e.durationSeconds, revisionOf: e.revisionOfId } });
    await emit(ctx, { type: 'time.entry_approved', entityType: 'time_entry', entityId: e.id });
  }
};

const assertCanDecide = (ctx: CommandContext, rows: EntryRow[]) => {
  for (const e of rows) {
    if (!allowed(ctx, 'time.approve', entryScope(e))) throw new AppError('FORBIDDEN', 'You cannot approve time for one of these projects.');
    if (e.membershipId === ctx.actor.membershipId && !ctx.actor.access.isOwner) throw new AppError('FORBIDDEN', 'You cannot approve your own time.');
  }
};

/** Approve one submitted entry (T059: overlapping entries cannot be approved until resolved). */
export const approveTimeEntry = async (ctx: CommandContext, id: string, input: { reviewerNote?: string }) => {
  const e = await lockEntry(ctx, id);
  assertCanDecide(ctx, [e]);
  assertVersion(ctx, e);
  if (e.state !== 'submitted') throw new AppError('INVALID_STATE', 'Only submitted entries can be approved.');
  const problems = await overlapProblems(ctx, [e]);
  if (problems.length) throw new AppError('INVALID_STATE', 'This entry overlaps other time of the same member. Resolve the overlap before approval.', { details: { overlaps: problems } });
  await approveRows(ctx, [e], input.reviewerNote ?? null);
  if (e.submissionId) await settleSheetIfComplete(ctx, e.submissionId);
  const [row] = await ctx.tx.select().from(timeEntries).where(eq(timeEntries.id, id));
  return (await toEntryViews(ctx, [row!]))[0]!;
};

const settleSheetIfComplete = async (ctx: CommandContext, sheetId: string) => {
  const rows = await ctx.tx.select({ state: timeEntries.state }).from(timeEntries).where(eq(timeEntries.submissionId, sheetId));
  if (rows.length && rows.every((r) => r.state === 'approved'))
    await ctx.tx
      .update(timeSheetSubmissions)
      .set({ state: 'approved', decidedAt: ctx.app.clock.now(), decidedBy: ctx.actor.membershipId, ...touch(ctx, timeSheetSubmissions) })
      .where(and(eq(timeSheetSubmissions.id, sheetId), eq(timeSheetSubmissions.state, 'submitted')));
};

// ——— Lists and weeks ———

export const listTimeEntries = async (
  ctx: QueryContext,
  q: { cursor?: string; pageSize?: number; from?: string; to?: string; membershipId?: string; projectId?: string; taskId?: string; state?: EntryRow['state'][]; includeSuperseded?: boolean },
) => {
  requireAnyPermission(ctx, ['time.read.own', 'time.read.scope']);
  const size = clampPageSize(q.pageSize);
  const c = q.cursor ? decodeCursor(q.cursor) : null;
  const base = whereAll(
    eq(timeEntries.workspaceId, ctx.actor.workspaceId),
    timeVisibilitySql(ctx),
    q.includeSuperseded ? undefined : isNull(timeEntries.supersededAt),
    q.from ? gte(timeEntries.workDate, q.from) : undefined,
    q.to ? lte(timeEntries.workDate, q.to) : undefined,
    q.membershipId ? eq(timeEntries.membershipId, q.membershipId) : undefined,
    q.projectId ? eq(timeEntries.projectId, q.projectId) : undefined,
    q.taskId ? eq(timeEntries.taskId, q.taskId) : undefined,
    q.state?.length ? inArray(timeEntries.state, q.state) : undefined,
  );
  const cursorCond = c ? sql`(${timeEntries.workDate}, ${timeEntries.createdAt}, ${timeEntries.id}) < (${String(c.v[0])}::date, ${String(c.v[1])}::timestamptz, ${c.id}::uuid)` : undefined;
  const rows = await dbOf(ctx)
    .select()
    .from(timeEntries)
    .where(whereAll(base, cursorCond))
    .orderBy(desc(timeEntries.workDate), desc(timeEntries.createdAt), desc(timeEntries.id))
    .limit(size + 1);
  const [sum] = await dbOf(ctx)
    .select({ s: sql<number>`coalesce(sum(${timeEntries.durationSeconds}) filter (where ${timeEntries.state} <> 'running'), 0)` })
    .from(timeEntries)
    .where(base);
  const hasMore = rows.length > size;
  const page = hasMore ? rows.slice(0, size) : rows;
  const last = page[page.length - 1];
  return {
    items: await toEntryViews(ctx, page),
    hasMore,
    nextCursor: hasMore && last ? encodeCursor({ v: [last.workDate, last.createdAt.toISOString()], id: last.id }) : null,
    totalSeconds: Number(sum?.s ?? 0),
  };
};

export const getTimeEntry = async (ctx: QueryContext, id: string) => {
  const [e] = await dbOf(ctx).select().from(timeEntries).where(and(eq(timeEntries.workspaceId, ctx.actor.workspaceId), eq(timeEntries.id, id)));
  if (!e || !canSeeEntry(ctx, e)) throw notFound('Time entry');
  return (await toEntryViews(ctx, [e]))[0]!;
};

const toSheetViews = async (ctx: QueryContext | CommandContext, rows: SheetRow[]): Promise<TimeSheetView[]> => {
  if (rows.length === 0) return [];
  const db = dbOf(ctx);
  const refs = await loadMemberRefs(db, ctx.actor.workspaceId, rows.flatMap((r) => [r.membershipId, r.decidedBy, r.approverMembershipId]));
  const entries = await db.select().from(timeEntries).where(inArray(timeEntries.submissionId, rows.map((r) => r.id)));
  const overlaps = await overlapMap(ctx, entries);
  return rows.map((s) => {
    const own = entries.filter((e) => e.submissionId === s.id);
    const canDecide = s.state === 'submitted' && own.length > 0 && own.every((e) => allowed(ctx, 'time.approve', entryScope(e))) && (s.membershipId !== ctx.actor.membershipId || ctx.actor.access.isOwner);
    return {
      id: s.id,
      member: refOrUnknown(refs, s.membershipId)!,
      weekStart: s.weekStart,
      state: s.state,
      submittedAt: s.submittedAt.toISOString(),
      decidedAt: s.decidedAt?.toISOString() ?? null,
      decidedBy: refOrUnknown(refs, s.decidedBy),
      approver: refOrUnknown(refs, s.approverMembershipId),
      reason: s.reason,
      totalSeconds: s.entrySnapshot.reduce((a, e) => a + e.durationSeconds, 0),
      entryCount: s.entrySnapshot.length,
      overlapCount: own.filter((e) => (overlaps.get(e.id) ?? []).length > 0).length,
      canDecide,
      rowVersion: s.rowVersion,
    };
  });
};

/** A member's week (their time zone): entries, totals by day, overlaps and the latest submission. */
export const getWeek = async (ctx: QueryContext, q: { weekStart?: string; membershipId?: string }) => {
  requireAnyPermission(ctx, ['time.read.own', 'time.read.scope']);
  const member = q.membershipId ?? ctx.actor.membershipId;
  if (!member) throw notFound('Member');
  const tz = await memberTimezone(ctx, member);
  const weekStartsOn = await workspaceWeekStart(ctx);
  const weekStart = q.weekStart ? weekStartDate(new Date(`${q.weekStart}T12:00:00Z`), 'UTC', weekStartsOn) : weekStartDate(ctx.app.clock.now(), tz, weekStartsOn);
  const weekEnd = isoDateAddDays(weekStart, 6);
  const rows = await dbOf(ctx)
    .select()
    .from(timeEntries)
    .where(
      and(
        eq(timeEntries.workspaceId, ctx.actor.workspaceId),
        eq(timeEntries.membershipId, member),
        isNull(timeEntries.supersededAt),
        gte(timeEntries.workDate, weekStart),
        lte(timeEntries.workDate, weekEnd),
        timeVisibilitySql(ctx),
      ),
    )
    .orderBy(asc(timeEntries.workDate), asc(timeEntries.startedAt), asc(timeEntries.createdAt));
  if (member !== ctx.actor.membershipId && rows.length === 0 && !hasAnywhere(ctx.actor.access, 'time.read.scope')) throw notFound('Member');
  const entries = await toEntryViews(ctx, rows);
  const [sheet] = await dbOf(ctx)
    .select()
    .from(timeSheetSubmissions)
    .where(and(eq(timeSheetSubmissions.workspaceId, ctx.actor.workspaceId), eq(timeSheetSubmissions.membershipId, member), eq(timeSheetSubmissions.weekStart, weekStart)))
    .orderBy(desc(timeSheetSubmissions.submittedAt))
    .limit(1);
  const refs = await loadMemberRefs(dbOf(ctx), ctx.actor.workspaceId, [member]);
  const byDay = Array.from({ length: 7 }, (_, i) => isoDateAddDays(weekStart, i)).map((date) => ({
    date,
    seconds: rows.filter((r) => r.workDate === date && r.state !== 'running').reduce((a, r) => a + (r.durationSeconds ?? 0), 0),
  }));
  const pending = rows.filter((r) => EDITABLE.includes(r.state));
  const blockers: string[] = [];
  if (rows.some((r) => r.state === 'running')) blockers.push('A timer is still running in this week. Stop it first.');
  const overlapCount = entries.filter((e) => e.overlapsWith.length && EDITABLE.includes(e.state)).length;
  if (overlapCount) blockers.push(`${overlapCount} entr${overlapCount === 1 ? 'y overlaps' : 'ies overlap'} other time. Fix the overlaps before submitting.`);
  if (pending.length === 0) blockers.push('There is no unsubmitted time in this week.');
  return {
    member: refOrUnknown(refs, member)!,
    weekStart,
    weekEnd,
    timezone: tz,
    entries,
    totalSeconds: byDay.reduce((a, d) => a + d.seconds, 0),
    byDay,
    submission: sheet ? ((await toSheetViews(ctx, [sheet]))[0] ?? null) : null,
    canSubmit: member === ctx.actor.membershipId && blockers.length === 0,
    blockers,
  };
};

/** Submit your week: the listed entry versions are frozen (all unsubmitted entries of the week must be included). */
export const submitWeek = async (ctx: CommandContext, input: { weekStart: string; entries: { id: string; rowVersion: number }[] }) => {
  requirePermission(ctx, 'time.write.own');
  const me = ctx.actor.membershipId;
  if (!me) throw new AppError('FORBIDDEN', 'Only members submit time.');
  const weekStartsOn = await workspaceWeekStart(ctx);
  if (weekStartDate(new Date(`${input.weekStart}T12:00:00Z`), 'UTC', weekStartsOn) !== input.weekStart)
    throw fieldFail('weekStart', 'NOT_WEEK_START', `Weeks start on ${weekStartsOn === 'monday' ? 'Monday' : 'Sunday'}.`);
  const weekEnd = isoDateAddDays(input.weekStart, 6);
  const rows = await ctx.tx
    .select()
    .from(timeEntries)
    .where(and(eq(timeEntries.workspaceId, ctx.actor.workspaceId), eq(timeEntries.membershipId, me), gte(timeEntries.workDate, input.weekStart), lte(timeEntries.workDate, weekEnd), isNull(timeEntries.supersededAt)))
    .for('update');
  if (rows.some((r) => r.state === 'running')) throw new AppError('INVALID_STATE', 'A timer is still running in this week. Stop it first.');
  const pending = rows.filter((r) => EDITABLE.includes(r.state));
  const listed = new Map(input.entries.map((e) => [e.id, e.rowVersion]));
  const unknown = input.entries.filter((e) => !pending.some((p) => p.id === e.id));
  if (unknown.length) throw new AppError('CONFLICT', 'Some entries are not unsubmitted time of this week. Reload and try again.', { details: { entries: unknown.map((u) => u.id) } });
  const missing = pending.filter((p) => !listed.has(p.id));
  if (missing.length) throw new AppError('CONFLICT', 'New time was added to this week. Reload and submit again.', { details: { entries: missing.map((m) => m.id) } });
  const changed = pending.filter((p) => listed.get(p.id) !== p.rowVersion);
  if (changed.length) throw new AppError('CONFLICT', 'Some entries changed after you reviewed them. Reload and submit again.', { details: { entries: changed.map((c) => c.id) } });
  const problems = await overlapProblems(ctx, pending);
  if (problems.length) throw new AppError('INVALID_STATE', 'Some entries overlap other time. Fix the overlaps before submitting.', { details: { overlaps: problems } });
  // The member's manager is the designated approver when they may approve all projects involved.
  const [m] = await ctx.tx.select({ manager: memberships.managerMembershipId }).from(memberships).where(eq(memberships.id, me));
  let approver: string | null = null;
  if (m?.manager) {
    let all = true;
    for (const projectId of new Set(pending.map((p) => p.projectId)))
      if (!(await memberCan(ctx.app.db, ctx.actor.workspaceId, m.manager, 'time.approve', { projectId }, ctx.app.clock.now())).ok) all = false;
    if (all) approver = m.manager;
  }
  const id = newId();
  const at = ctx.app.clock.now();
  const [sheet] = await ctx.tx
    .insert(timeSheetSubmissions)
    .values({
      ...stamp(ctx),
      id,
      membershipId: me,
      weekStart: input.weekStart,
      state: 'submitted',
      entrySnapshot: pending.map((p) => ({ id: p.id, rowVersion: p.rowVersion + 1, durationSeconds: p.durationSeconds ?? 0 })),
      submittedAt: at,
      approverMembershipId: approver,
    })
    .returning();
  await ctx.tx
    .update(timeEntries)
    .set({ state: 'submitted', submissionId: id, returnedReason: null, ...touch(ctx, timeEntries) })
    .where(inArray(timeEntries.id, pending.map((p) => p.id)));
  await audit(ctx, { action: 'time.week_submitted', entityType: 'time_sheet', entityId: id, metadata: { weekStart: input.weekStart, entries: pending.length } });
  await emit(ctx, { type: 'time.week_submitted', entityType: 'time_sheet', entityId: id, revision: 1 });
  if (approver)
    await notify(ctx.tx, {
      workspaceId: ctx.actor.workspaceId,
      recipientMembershipIds: [approver],
      eventType: 'time.sheet_submitted',
      eventKey: `time.sheet_submitted:${id}`,
      kind: 'review_request',
      title: `Time sheet to approve: ${ctx.actor.displayName}, week of ${input.weekStart}`,
      entityType: 'time_sheet',
      entityId: id,
      actorMembershipId: me,
      at,
    });
  return (await toSheetViews(ctx, [sheet!]))[0]!;
};

export const listTimeSheets = async (ctx: QueryContext, q: { cursor?: string; pageSize?: number; state?: SheetRow['state'][]; membershipId?: string; mine?: boolean }) => {
  requireAnyPermission(ctx, ['time.read.own', 'time.read.scope', 'time.approve']);
  const me = ctx.actor.membershipId;
  const size = clampPageSize(q.pageSize);
  const c = q.cursor ? decodeCursor(q.cursor) : null;
  // Sheets are visible to their member, and to approvers when at least one entry is in their approval scope.
  const approveScope = scopePredicate(ctx, 'time.approve', { projectId: timeEntries.projectId });
  const approverSees = hasAnywhere(ctx.actor.access, 'time.approve')
    ? sql`EXISTS (SELECT 1 FROM ${timeEntries} WHERE ${timeEntries.submissionId} = ${timeSheetSubmissions.id} AND ${approveScope ?? sql`true`})`
    : sql`false`;
  const rows = await dbOf(ctx)
    .select()
    .from(timeSheetSubmissions)
    .where(
      whereAll(
        eq(timeSheetSubmissions.workspaceId, ctx.actor.workspaceId),
        q.mine ? (me ? eq(timeSheetSubmissions.membershipId, me) : sql`false`) : or(me ? eq(timeSheetSubmissions.membershipId, me) : sql`false`, approverSees),
        q.state?.length ? inArray(timeSheetSubmissions.state, q.state) : undefined,
        q.membershipId ? eq(timeSheetSubmissions.membershipId, q.membershipId) : undefined,
        c ? sql`(${timeSheetSubmissions.submittedAt}, ${timeSheetSubmissions.id}) < (${String(c.v[0])}::timestamptz, ${c.id}::uuid)` : undefined,
      ),
    )
    .orderBy(desc(timeSheetSubmissions.submittedAt), desc(timeSheetSubmissions.id))
    .limit(size + 1);
  const hasMore = rows.length > size;
  const page = hasMore ? rows.slice(0, size) : rows;
  const last = page[page.length - 1];
  return { items: await toSheetViews(ctx, page), hasMore, nextCursor: hasMore && last ? encodeCursor({ v: [last.submittedAt.toISOString()], id: last.id }) : null };
};

const loadSheet = async (ctx: QueryContext | CommandContext, id: string, lock = false) => {
  const q = dbOf(ctx).select().from(timeSheetSubmissions).where(and(eq(timeSheetSubmissions.workspaceId, ctx.actor.workspaceId), eq(timeSheetSubmissions.id, id)));
  const [s] = lock && 'tx' in ctx ? await q.for('update') : await q;
  if (!s) throw notFound('Time sheet');
  const entries = await dbOf(ctx).select().from(timeEntries).where(eq(timeEntries.submissionId, id));
  const visible = s.membershipId === ctx.actor.membershipId || entries.some((e) => allowed(ctx, 'time.approve', entryScope(e)) || allowed(ctx, 'time.read.scope', entryScope(e)));
  if (!visible) throw notFound('Time sheet');
  return { sheet: s, entries };
};

export const getTimeSheet = async (ctx: QueryContext | CommandContext, id: string) => {
  const { sheet, entries } = await loadSheet(ctx, id);
  const [view] = await toSheetViews(ctx, [sheet]);
  const snap = new Map(sheet.entrySnapshot.map((e) => [e.id, e.rowVersion]));
  return {
    ...view!,
    entries: await toEntryViews(ctx, entries.filter((e) => canSeeEntry(ctx, e) || allowed(ctx, 'time.approve', entryScope(e)))),
    changedSinceSubmission: sheet.state === 'submitted' ? entries.filter((e) => snap.get(e.id) !== e.rowVersion).map((e) => e.id) : [],
  };
};

/** Approve the whole sheet atomically (T059: blocked while entries overlap; frozen versions must match). */
export const approveTimeSheet = async (ctx: CommandContext, id: string, input: { reviewerNote?: string }) => {
  const { sheet } = await loadSheet(ctx, id, true);
  assertVersion(ctx, sheet);
  if (sheet.state !== 'submitted') throw new AppError('INVALID_STATE', 'Only submitted sheets can be approved.');
  const entries = await ctx.tx.select().from(timeEntries).where(eq(timeEntries.submissionId, id)).for('update');
  assertCanDecide(ctx, entries);
  const snap = new Map(sheet.entrySnapshot.map((e) => [e.id, e.rowVersion]));
  const changed = entries.filter((e) => e.state !== 'submitted' || snap.get(e.id) !== e.rowVersion);
  if (changed.length) throw new AppError('CONFLICT', 'Entries of this sheet changed after submission. Return it to the member.', { details: { entries: changed.map((c) => c.id) } });
  const problems = await overlapProblems(ctx, entries);
  if (problems.length)
    throw new AppError('INVALID_STATE', 'Some entries overlap other time of the same member. Return the sheet so the overlaps are resolved.', { details: { overlaps: problems } });
  await approveRows(ctx, entries, input.reviewerNote ?? null);
  const at = ctx.app.clock.now();
  const [row] = await ctx.tx
    .update(timeSheetSubmissions)
    .set({ state: 'approved', decidedAt: at, decidedBy: ctx.actor.membershipId, reason: input.reviewerNote ?? null, ...touch(ctx, timeSheetSubmissions) })
    .where(eq(timeSheetSubmissions.id, id))
    .returning();
  await audit(ctx, { action: 'time.sheet_approved', entityType: 'time_sheet', entityId: id, reason: input.reviewerNote ?? null, metadata: { entries: entries.length } });
  await emit(ctx, { type: 'time.sheet_approved', entityType: 'time_sheet', entityId: id, revision: row!.rowVersion });
  await notify(ctx.tx, {
    workspaceId: ctx.actor.workspaceId,
    recipientMembershipIds: [sheet.membershipId],
    eventType: 'time.sheet_approved',
    eventKey: `time.sheet_approved:${id}`,
    kind: 'general',
    title: `Time sheet approved: week of ${sheet.weekStart}`,
    entityType: 'time_sheet',
    entityId: id,
    actorMembershipId: ctx.actor.membershipId,
    at,
  });
  return (await toSheetViews(ctx, [row!]))[0]!;
};

export const returnTimeSheet = async (ctx: CommandContext, id: string, input: { reason: string }) => {
  const { sheet } = await loadSheet(ctx, id, true);
  assertVersion(ctx, sheet);
  if (sheet.state !== 'submitted') throw new AppError('INVALID_STATE', 'Only submitted sheets can be returned.');
  const entries = await ctx.tx.select().from(timeEntries).where(eq(timeEntries.submissionId, id)).for('update');
  assertCanDecide(ctx, entries);
  const at = ctx.app.clock.now();
  await ctx.tx
    .update(timeEntries)
    .set({ state: 'returned', returnedReason: input.reason.trim(), ...touch(ctx, timeEntries) })
    .where(and(eq(timeEntries.submissionId, id), eq(timeEntries.state, 'submitted')));
  const [row] = await ctx.tx
    .update(timeSheetSubmissions)
    .set({ state: 'returned', decidedAt: at, decidedBy: ctx.actor.membershipId, reason: input.reason.trim(), ...touch(ctx, timeSheetSubmissions) })
    .where(eq(timeSheetSubmissions.id, id))
    .returning();
  await audit(ctx, { action: 'time.sheet_returned', entityType: 'time_sheet', entityId: id, reason: input.reason });
  await emit(ctx, { type: 'time.sheet_returned', entityType: 'time_sheet', entityId: id, revision: row!.rowVersion });
  await notify(ctx.tx, {
    workspaceId: ctx.actor.workspaceId,
    recipientMembershipIds: [sheet.membershipId],
    eventType: 'time.sheet_returned',
    eventKey: `time.sheet_returned:${id}`,
    kind: 'general',
    title: `Time sheet returned: week of ${sheet.weekStart}`,
    excerpt: input.reason,
    entityType: 'time_sheet',
    entityId: id,
    actorMembershipId: ctx.actor.membershipId,
    at,
  });
  return (await toSheetViews(ctx, [row!]))[0]!;
};

/**
 * Timers running longer than 12 h are flagged Needs Review and the member is reminded; the timer
 * keeps running on the server — nothing is stopped or invented (T058).
 */
export const runTimerReview = async (app: QueryContext['app']) => {
  const now = app.clock.now();
  const long = await app.db
    .select()
    .from(timeEntries)
    .where(and(eq(timeEntries.state, 'running'), isNull(timeEntries.needsReviewReason), lt(timeEntries.startedAt, new Date(now.getTime() - TIMER_REVIEW_AFTER_SECONDS * 1000))))
    .limit(1000);
  for (const e of long) {
    const base = await systemJobContext(app, e.workspaceId, ['time.read.scope']);
    await executeSystemCommand(base, async (ctx) => {
      await ctx.tx.update(timeEntries).set({ needsReviewReason: 'The timer has been running for more than 12 hours.' }).where(and(eq(timeEntries.id, e.id), eq(timeEntries.state, 'running')));
      await notify(ctx.tx, {
        workspaceId: e.workspaceId,
        recipientMembershipIds: [e.membershipId],
        eventType: 'time.timer_needs_review',
        eventKey: `time.timer_needs_review:${e.id}`,
        kind: 'due_reminder',
        title: 'Your timer has been running for more than 12 hours',
        entityType: 'time_entry',
        entityId: e.id,
        projectId: e.projectId,
        at: now,
        excludeActor: false,
      });
      await emit(ctx, { type: 'time.timer_needs_review', entityType: 'time_entry', entityId: e.id });
    });
  }
  return { flagged: long.length };
};

defineJob('work.timers', 'light', async ({ app }) => runTimerReview(app));
defineSchedule({ name: 'work.timers', everySeconds: 900, jobType: 'work.timers' });

