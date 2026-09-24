import { and, asc, count, desc, eq, gt, inArray, isNotNull, lt, lte, ne, or, sql, type SQL } from 'drizzle-orm';
import {
  absences,
  handovers,
  interactionLogs,
  ofmAssignments,
  ofmProfiles,
  operations,
  saleCandidates,
  shiftAccounts,
  shiftBreaks,
  shiftReports,
  shiftSwapRequests,
  shiftTimeCorrections,
  shifts,
  tasks,
} from '@castlane/database';
import {
  AppError,
  isAppError,
  repeatOccurrences,
  validateRepeatPattern,
  type RepeatPattern,
  SHIFT_LIMITS,
  SHIFT_TRANSITIONS,
  SWAP_TRANSITIONS,
  assertTransition,
  dstInfo,
  isValidPercent,
  isValidShiftDuration,
  localDate,
  newId,
  notFound,
  shiftDurationMinutes,
  toBig,
  validateBreaks,
} from '@castlane/domain';
import { allowed, requireAnyPermission } from '../core/access';
import { audit, diffFields } from '../core/audit';
import { all, dbOf, type CommandContext, type QueryContext } from '../core/context';
import { emit } from '../core/events';
import { loadMemberRefs, refOrUnknown } from '../core/members';
import { notify } from '../core/notify';
import { assertVersion, findById, lockById, stamp, touch } from '../core/rows';
import { coversInterval, activeAt } from './assignments';
import {
  accountLabel,
  advisoryLocks,
  assertActiveMember,
  exprKeyset,
  fieldErr,
  holds,
  invalid,
  loadAccountInfos,
  loadProfiles,
  me,
  memberTimezones,
  requireOfmAccount,
  resolveSettings,
  signToken,
  verifyToken,
  workspaceInfo,
  type AccountInfo,
  type Ctx,
} from './common';
import { ensureReportDraft } from './reports';
import {
  authorRefs,
  canReadSale,
  canReadShift,
  handoverSummaries,
  loadBreaks,
  loadShiftAccounts,
  operationScope,
  operationSummaries,
  reportDetail,
  saleViews,
  shiftBriefs,
  shiftScope,
  shiftSummaries,
  shiftVisibility,
  taskRefs,
  type ShiftRow,
} from './views';

type Lane = (typeof shiftAccounts.$inferSelect)['coverageLane'];

export interface ScheduleIssue {
  code: string;
  message: string;
  shiftId?: string | null;
  accountId?: string | null;
}

export interface ScheduleInput {
  membershipId: string;
  primaryAccountId: string;
  additionalAccountIds: string[];
  scheduledStart: Date;
  scheduledEnd: Date;
  timezone: string;
  parallelCoverage: boolean;
  excludeShiftId?: string;
}

const LIVE_STATES = ['scheduled', 'active', 'paused', 'ended'] as const;

const authorizeSchedule = (ctx: Ctx, projectId: string, accountId: string) => {
  const scope = { projectId, accountId };
  if (allowed(ctx, 'shifts.schedule', scope)) return;
  if (allowed(ctx, 'shifts.read.scope', scope) || allowed(ctx, 'ofm.overview.read', scope)) throw new AppError('FORBIDDEN', 'You cannot schedule shifts for this account.');
  throw notFound('Account');
};

/**
 * Schedule checks (§13.1, T085–T087): every account needs a valid assignment of the member for the
 * whole interval (its lane becomes the shift lane); one member cannot hold overlapping shifts; an
 * account lane already covered by another member needs explicit parallel coverage; leave and DST
 * changes are warnings.
 */
export const checkSchedule = async (ctx: Ctx, input: ScheduleInput, opts: { authorize: boolean }) => {
  const db = dbOf(ctx);
  const ws = ctx.actor.workspaceId;
  const accountIds = [...new Set([input.primaryAccountId, ...input.additionalAccountIds.filter((a) => a !== input.primaryAccountId)])];
  const { account: primary, project } = await requireOfmAccount(ctx, input.primaryAccountId, 'primaryAccountId');
  const [accounts, profiles, wsInfo] = await all(ctx, [
    () => loadAccountInfos(db, ws, accountIds),
    () => loadProfiles(db, ws, [project.id]),
    () => workspaceInfo(db, ws),
  ] as const);
  const settings = resolveSettings(profiles.get(project.id)?.settings, wsInfo.settings.maxShiftAccounts);
  if (accountIds.length > Math.min(settings.maxShiftAccounts, SHIFT_LIMITS.maxAccounts))
    throw fieldErr('additionalAccountIds', 'TOO_MANY', `A shift covers at most ${Math.min(settings.maxShiftAccounts, SHIFT_LIMITS.maxAccounts)} accounts.`);
  for (const id of accountIds) {
    const a = accounts.get(id);
    if (!a || a.deletedAt) throw fieldErr('additionalAccountIds', 'NOT_FOUND', 'Choose existing accounts.');
    if (a.projectId !== project.id) throw fieldErr('additionalAccountIds', 'DIFFERENT_PROJECT', 'All accounts of a shift must belong to the same model.');
    if (a.archivedAt) throw fieldErr(id === primary.id ? 'primaryAccountId' : 'additionalAccountIds', 'ARCHIVED', `${accountLabel(a)} is archived.`);
    if (opts.authorize) authorizeSchedule(ctx, project.id, id);
  }
  if (!isValidShiftDuration(input.scheduledStart, input.scheduledEnd))
    throw fieldErr('scheduledEnd', 'DURATION', `A shift lasts ${SHIFT_LIMITS.minMinutes} minutes to ${SHIFT_LIMITS.maxMinutes / 60} hours.`);

  const conflicts: ScheduleIssue[] = [];
  const assignmentIssues: ScheduleIssue[] = [];
  const warnings: ScheduleIssue[] = [];
  const lanes = new Map<string, { lane: Lane; label: string | null; supervisor: string | null; assignmentId: string }>();

  const assignmentRows = await db
    .select()
    .from(ofmAssignments)
    .where(
      and(
        eq(ofmAssignments.workspaceId, ws),
        eq(ofmAssignments.membershipId, input.membershipId),
        inArray(ofmAssignments.accountId, accountIds),
        coversInterval(input.scheduledStart, input.scheduledEnd),
      ),
    )
    .orderBy(desc(ofmAssignments.validFrom));
  for (const id of accountIds) {
    const a = assignmentRows.find((r) => r.accountId === id);
    const acc = accounts.get(id)!;
    if (!a) {
      assignmentIssues.push({
        code: 'NO_VALID_ASSIGNMENT',
        accountId: id,
        message: `The member has no OFM assignment for ${accountLabel(acc)} covering the whole shift.`,
      });
      continue;
    }
    lanes.set(id, { lane: a.coverageLane, label: a.coverageLaneLabel, supervisor: a.supervisorMembershipId, assignmentId: a.id });
  }

  const overlapping = and(lt(shifts.scheduledStart, input.scheduledEnd), gt(shifts.scheduledEnd, input.scheduledStart));
  const exclude = input.excludeShiftId ? ne(shifts.id, input.excludeShiftId) : undefined;
  const memberOverlap = await db
    .select({ id: shifts.id, start: shifts.scheduledStart })
    .from(shifts)
    .where(and(eq(shifts.workspaceId, ws), eq(shifts.membershipId, input.membershipId), inArray(shifts.state, [...LIVE_STATES]), overlapping, exclude));
  for (const o of memberOverlap)
    conflicts.push({ code: 'MEMBER_OVERLAP', shiftId: o.id, message: 'The member already has a shift at this time. Use one multi-account shift instead of overlapping shifts.' });

  for (const [accountId, l] of lanes) {
    const same = await db
      .select({ id: shifts.id, member: shifts.membershipId })
      .from(shifts)
      .innerJoin(shiftAccounts, and(eq(shiftAccounts.shiftId, shifts.id), eq(shiftAccounts.accountId, accountId)))
      .where(
        and(
          eq(shifts.workspaceId, ws),
          inArray(shifts.state, [...LIVE_STATES]),
          ne(shifts.membershipId, input.membershipId),
          overlapping,
          exclude,
          eq(shiftAccounts.coverageLane, l.lane),
          l.lane === 'custom' ? sql`${shiftAccounts.coverageLaneLabel} IS NOT DISTINCT FROM ${l.label}` : undefined,
        ),
      );
    for (const o of same) {
      const issue = {
        code: 'LANE_OVERLAP',
        shiftId: o.id,
        accountId,
        message: `${accountLabel(accounts.get(accountId)!)} already has ${l.lane === 'custom' ? (l.label ?? 'this lane') : l.lane} coverage at this time. Mark the shift as parallel coverage or use another lane.`,
      };
      if (input.parallelCoverage) warnings.push({ ...issue, code: 'PARALLEL_COVERAGE' });
      else conflicts.push(issue);
    }
  }

  const tz = (await memberTimezones(db, ws, [input.membershipId])).get(input.membershipId) ?? input.timezone;
  const dates = [...new Set([localDate(input.scheduledStart, tz), localDate(new Date(input.scheduledEnd.getTime() - 1), tz)])];
  const leave = await db
    .select({ id: absences.id })
    .from(absences)
    .where(
      and(
        eq(absences.workspaceId, ws),
        eq(absences.membershipId, input.membershipId),
        eq(absences.state, 'approved'),
        or(...dates.map((d) => and(lte(absences.startDate, d), sql`${absences.endDate} >= ${d}`))),
      ),
    );
  if (leave.length) warnings.push({ code: 'ON_LEAVE', message: 'The member has approved leave on this day. The shift is highlighted, not cancelled.' });
  const dst = dstInfo(input.scheduledStart, input.scheduledEnd, input.timezone);
  if (dst.offsetChanges)
    warnings.push({ code: 'DST_CHANGE', message: `Clocks change during this shift: ${dst.elapsedMinutes} minutes elapse for ${dst.wallClockMinutes} minutes on the wall clock.` });
  if (input.scheduledEnd.getTime() <= ctx.app.clock.now().getTime()) conflicts.push({ code: 'IN_PAST', message: 'Choose a future end time.' });

  return {
    ok: conflicts.length === 0 && assignmentIssues.length === 0,
    durationMinutes: shiftDurationMinutes(input.scheduledStart, input.scheduledEnd),
    conflicts,
    assignmentIssues,
    warnings,
    dst: { offsetChanges: dst.offsetChanges, elapsedMinutes: dst.elapsedMinutes, wallClockMinutes: dst.wallClockMinutes, localStart: dst.localStart, localEnd: dst.localEnd },
    accounts: accountIds.map((id) => accounts.get(id)!),
    project,
    lanes,
    profileSupervisor: profiles.get(project.id)?.supervisorMembershipId ?? null,
  };
};

export const validateShift = async (
  ctx: QueryContext,
  input: { membershipId: string; primaryAccountId: string; additionalAccountIds: string[]; scheduledStart: string; scheduledEnd: string; timezone: string; parallelCoverage: boolean; shiftId?: string },
) => {
  const r = await checkSchedule(
    ctx,
    { ...input, scheduledStart: new Date(input.scheduledStart), scheduledEnd: new Date(input.scheduledEnd), excludeShiftId: input.shiftId },
    { authorize: true },
  );
  return { ok: r.ok, durationMinutes: r.durationMinutes, conflicts: r.conflicts, assignmentIssues: r.assignmentIssues, warnings: r.warnings, dst: r.dst };
};

const scheduleConflictError = (r: { conflicts: ScheduleIssue[]; assignmentIssues: ScheduleIssue[] }) => {
  const first = r.assignmentIssues[0] ?? r.conflicts[0];
  return new AppError('CONFLICT', first?.message ?? 'The shift conflicts with the schedule.', { details: { conflicts: r.conflicts, assignmentIssues: r.assignmentIssues } });
};

const writeShiftAccounts = async (ctx: CommandContext, shiftId: string, accounts: AccountInfo[], lanes: Map<string, { lane: Lane; label: string | null }>, primaryId: string) => {
  await ctx.tx.delete(shiftAccounts).where(and(eq(shiftAccounts.workspaceId, ctx.actor.workspaceId), eq(shiftAccounts.shiftId, shiftId)));
  for (const a of accounts) {
    const l = lanes.get(a.id);
    await ctx.tx.insert(shiftAccounts).values({
      ...stamp(ctx),
      id: newId(),
      shiftId,
      accountId: a.id,
      isPrimary: a.id === primaryId,
      coverageLane: l?.lane ?? 'primary',
      coverageLaneLabel: l?.label ?? null,
    });
  }
};

const notifyMember = (ctx: CommandContext, s: Pick<ShiftRow, 'id' | 'projectId'>, recipient: string | null | undefined, eventKey: string, title: string, excerpt?: string | null, kind: 'assignment' | 'general' | 'due_reminder' | 'review_request' = 'assignment') =>
  recipient
    ? notify(ctx.tx, {
        workspaceId: ctx.actor.workspaceId,
        recipientMembershipIds: [recipient],
        eventType: eventKey.split(':')[0]!,
        eventKey,
        kind,
        title,
        excerpt: excerpt ?? null,
        entityType: 'shift',
        entityId: s.id,
        projectId: s.projectId,
        actorMembershipId: ctx.actor.membershipId,
        at: ctx.app.clock.now(),
      })
    : Promise.resolve(0);

export interface CreateShiftInput {
  membershipId: string;
  primaryAccountId: string;
  additionalAccountIds: string[];
  scheduledStart: string;
  scheduledEnd: string;
  timezone: string;
  supervisorMembershipId?: string | null;
  parallelCoverage: boolean;
}

export const createShift = async (ctx: CommandContext, input: CreateShiftInput, opts: { repeatGroupId?: string; occurrenceKey?: string; silent?: boolean } = {}) => {
  const start = new Date(input.scheduledStart);
  const end = new Date(input.scheduledEnd);
  if (end.getTime() <= ctx.app.clock.now().getTime()) throw fieldErr('scheduledEnd', 'MUST_BE_FUTURE', 'Choose a future end time.');
  await assertActiveMember(ctx, input.membershipId, 'membershipId');
  if (input.supervisorMembershipId) await assertActiveMember(ctx, input.supervisorMembershipId, 'supervisorMembershipId');
  await advisoryLocks(ctx, [`ofm-member:${input.membershipId}`, ...[input.primaryAccountId, ...input.additionalAccountIds].map((a) => `ofm-lane:${a}`)]);
  const r = await checkSchedule(ctx, { ...input, scheduledStart: start, scheduledEnd: end }, { authorize: true });
  if (!r.ok) throw scheduleConflictError(r);
  const id = newId();
  const supervisor = input.supervisorMembershipId ?? r.lanes.get(input.primaryAccountId)?.supervisor ?? r.profileSupervisor;
  const [row] = await ctx.tx
    .insert(shifts)
    .values({
      ...stamp(ctx),
      id,
      projectId: r.project.id,
      primaryAccountId: input.primaryAccountId,
      membershipId: input.membershipId,
      supervisorMembershipId: supervisor,
      scheduledStart: start,
      scheduledEnd: end,
      timezone: input.timezone,
      parallelCoverage: input.parallelCoverage,
      repeatGroupId: opts.repeatGroupId ?? null,
      occurrenceKey: opts.occurrenceKey ?? null,
    })
    .onConflictDoNothing()
    .returning();
  if (!row) return null;
  await writeShiftAccounts(ctx, id, r.accounts, r.lanes, input.primaryAccountId);
  await audit(ctx, {
    action: 'shift.scheduled',
    entityType: 'shift',
    entityId: id,
    projectId: r.project.id,
    diff: diffFields(null, row, ['membershipId', 'primaryAccountId', 'scheduledStart', 'scheduledEnd', 'timezone', 'supervisorMembershipId', 'parallelCoverage']),
    metadata: { accountIds: r.accounts.map((a) => a.id), repeatGroupId: opts.repeatGroupId ?? null },
  });
  await emit(ctx, { type: 'shift.scheduled', entityType: 'shift', entityId: id, revision: 1, payload: { membershipId: input.membershipId } });
  if (!opts.silent) await notifyMember(ctx, row, input.membershipId, `shift.assigned:${id}:${input.membershipId}`, 'Shift assigned to you', accountLabel(r.accounts[0]!));
  return id;
};

// ——— Repeat schedule (preview ≤ 8 weeks, then apply exactly once) ———

export interface RepeatInput {
  membershipId: string;
  primaryAccountId: string;
  additionalAccountIds: string[];
  supervisorMembershipId?: string | null;
  parallelCoverage: boolean;
  pattern: RepeatPattern;
}

export const repeatPreview = async (ctx: QueryContext, input: RepeatInput) => {
  const bad = validateRepeatPattern(input.pattern);
  if (bad.length) throw fieldErr(`pattern.${bad[0]}`, 'INVALID', 'Check the repeat pattern.');
  const occurrences = repeatOccurrences(input.pattern);
  if (!occurrences.length) throw fieldErr('pattern.weekdays', 'EMPTY', 'No days match the pattern.');
  const out = [];
  for (const o of occurrences) {
    const r = await checkSchedule(ctx, { ...input, scheduledStart: o.start, scheduledEnd: o.end, timezone: input.pattern.timezone }, { authorize: true });
    out.push({
      date: o.date,
      start: o.start.toISOString(),
      end: o.end.toISOString(),
      durationMinutes: o.durationMinutes,
      dstShifted: o.dstShifted,
      offsetChanges: o.offsetChanges,
      conflicts: r.conflicts,
      assignmentIssues: r.assignmentIssues,
      warnings: r.warnings,
      ok: r.ok,
    });
  }
  const { token, expiresAt } = signToken(ctx, 'shift-repeat', { input, groupId: newId() }, 15);
  return { previewToken: token, expiresAt: expiresAt.toISOString(), occurrences: out };
};

/** Apply a previewed repeat: occurrence keys (group + date) make replays and double submits harmless. */
export const repeatApply = async (ctx: CommandContext, input: { previewToken: string; skipConflicting: boolean }) => {
  const p = verifyToken<{ input: RepeatInput; groupId: string }>(ctx, 'shift-repeat', input.previewToken);
  const created: string[] = [];
  const skipped: { date: string; reason: string }[] = [];
  for (const o of repeatOccurrences(p.input.pattern)) {
    try {
      const id = await createShift(
        ctx,
        {
          membershipId: p.input.membershipId,
          primaryAccountId: p.input.primaryAccountId,
          additionalAccountIds: p.input.additionalAccountIds,
          scheduledStart: o.start.toISOString(),
          scheduledEnd: o.end.toISOString(),
          timezone: p.input.pattern.timezone,
          supervisorMembershipId: p.input.supervisorMembershipId,
          parallelCoverage: p.input.parallelCoverage,
        },
        { repeatGroupId: p.groupId, occurrenceKey: o.date, silent: true },
      );
      if (id) created.push(id);
      else skipped.push({ date: o.date, reason: 'Already created by this schedule.' });
    } catch (e) {
      // Checks run before any write, so a refused occurrence leaves the transaction usable.
      if (isAppError(e) && (e.code === 'CONFLICT' || e.code === 'VALIDATION_FAILED') && input.skipConflicting) skipped.push({ date: o.date, reason: e.message });
      else throw e;
    }
  }
  if (created.length) {
    const [first] = await ctx.tx.select().from(shifts).where(eq(shifts.id, created[0]!));
    await notifyMember(ctx, first!, p.input.membershipId, `shift.repeat_assigned:${p.groupId}`, `${created.length} shifts were scheduled for you`);
    await audit(ctx, { action: 'shift.repeat_applied', entityType: 'shift', entityId: created[0]!, projectId: first!.projectId, metadata: { repeatGroupId: p.groupId, created: created.length, skipped: skipped.length } });
  }
  return { repeatGroupId: p.groupId, created, skipped };
};

const lockShift = async (ctx: CommandContext, id: string) => {
  const s = await lockById(ctx, shifts, id, 'Shift');
  if (!canReadShift(ctx, s)) throw notFound('Shift');
  return s;
};

const requireScheduleRights = (ctx: Ctx, s: ShiftRow) => {
  if (!allowed(ctx, 'shifts.schedule', shiftScope(s))) throw new AppError('FORBIDDEN', 'You cannot change the schedule of this shift.');
};

export const updateShift = async (
  ctx: CommandContext,
  id: string,
  input: Partial<Omit<CreateShiftInput, 'parallelCoverage'>> & { parallelCoverage?: boolean },
) => {
  const s = await lockShift(ctx, id);
  requireScheduleRights(ctx, s);
  assertVersion(ctx, s);
  if (s.state !== 'scheduled') throw invalid('Only scheduled shifts can be edited. Actual times change through Correct Time.');
  const links = await loadShiftAccounts(ctx.tx, ctx.actor.workspaceId, [s.id]);
  const next = {
    membershipId: input.membershipId ?? s.membershipId,
    primaryAccountId: input.primaryAccountId ?? s.primaryAccountId,
    additionalAccountIds: input.additionalAccountIds ?? links.filter((l) => !l.isPrimary).map((l) => l.accountId),
    scheduledStart: input.scheduledStart ? new Date(input.scheduledStart) : s.scheduledStart,
    scheduledEnd: input.scheduledEnd ? new Date(input.scheduledEnd) : s.scheduledEnd,
    timezone: input.timezone ?? s.timezone,
    parallelCoverage: input.parallelCoverage ?? s.parallelCoverage,
  };
  if (next.scheduledEnd.getTime() <= ctx.app.clock.now().getTime()) throw fieldErr('scheduledEnd', 'MUST_BE_FUTURE', 'Choose a future end time.');
  if (input.membershipId) await assertActiveMember(ctx, input.membershipId, 'membershipId');
  if (input.supervisorMembershipId) await assertActiveMember(ctx, input.supervisorMembershipId, 'supervisorMembershipId');
  await advisoryLocks(ctx, [`ofm-member:${next.membershipId}`, ...[next.primaryAccountId, ...next.additionalAccountIds].map((a) => `ofm-lane:${a}`)]);
  const r = await checkSchedule(ctx, { ...next, excludeShiftId: s.id }, { authorize: true });
  if (!r.ok) throw scheduleConflictError(r);
  if (r.project.id !== s.projectId) throw fieldErr('primaryAccountId', 'DIFFERENT_PROJECT', 'A shift cannot move to another model.');
  const [row] = await ctx.tx
    .update(shifts)
    .set({
      membershipId: next.membershipId,
      primaryAccountId: next.primaryAccountId,
      scheduledStart: next.scheduledStart,
      scheduledEnd: next.scheduledEnd,
      timezone: next.timezone,
      parallelCoverage: next.parallelCoverage,
      supervisorMembershipId: input.supervisorMembershipId !== undefined ? input.supervisorMembershipId : s.supervisorMembershipId,
      needsReviewReason: null,
      ...touch(ctx, shifts),
    })
    .where(eq(shifts.id, id))
    .returning();
  await writeShiftAccounts(ctx, id, r.accounts, r.lanes, next.primaryAccountId);
  await audit(ctx, {
    action: 'shift.rescheduled',
    entityType: 'shift',
    entityId: id,
    projectId: s.projectId,
    diff: diffFields(s, row!, ['membershipId', 'primaryAccountId', 'scheduledStart', 'scheduledEnd', 'timezone', 'supervisorMembershipId', 'parallelCoverage']),
  });
  await emit(ctx, { type: 'shift.rescheduled', entityType: 'shift', entityId: id, revision: row!.rowVersion });
  if (next.membershipId !== s.membershipId) {
    await notifyMember(ctx, row!, next.membershipId, `shift.assigned:${id}:${next.membershipId}`, 'Shift assigned to you', accountLabel(r.accounts[0]!));
    await notifyMember(ctx, row!, s.membershipId, `shift.unassigned:${id}:${s.membershipId}:${row!.rowVersion}`, 'A shift was reassigned to another member', null, 'general');
  } else if (next.scheduledStart.getTime() !== s.scheduledStart.getTime() || next.scheduledEnd.getTime() !== s.scheduledEnd.getTime()) {
    await notifyMember(ctx, row!, s.membershipId, `shift.rescheduled:${id}:${row!.rowVersion}`, 'Your shift time changed', null, 'general');
  }
  return id;
};

/** Cancel a scheduled shift (reminders keyed on it stop because they check the state). */
export const cancelShiftInternal = async (ctx: CommandContext, s: ShiftRow, reason: string) => {
  assertTransition(SHIFT_TRANSITIONS, s.state, 'cancelled', 'shift');
  const [row] = await ctx.tx.update(shifts).set({ state: 'cancelled', cancelReason: reason, needsReviewReason: null, ...touch(ctx, shifts) }).where(eq(shifts.id, s.id)).returning();
  await ctx.tx
    .update(shiftSwapRequests)
    .set({ state: 'cancelled', decidedAt: ctx.app.clock.now(), decisionNote: 'Shift cancelled', ...touch(ctx, shiftSwapRequests) })
    .where(and(eq(shiftSwapRequests.shiftId, s.id), inArray(shiftSwapRequests.state, ['pending_acceptance', 'pending_approval'])));
  await audit(ctx, { action: 'shift.cancelled', entityType: 'shift', entityId: s.id, projectId: s.projectId, reason, diff: { state: { from: s.state, to: 'cancelled' } } });
  await emit(ctx, { type: 'shift.cancelled', entityType: 'shift', entityId: s.id, revision: row!.rowVersion });
  await notifyMember(ctx, s, s.membershipId, `shift.cancelled:${s.id}`, 'Your shift was cancelled', null, 'general');
  return row!;
};

export const cancelShift = async (ctx: CommandContext, id: string, input: { reason: string }) => {
  const s = await lockShift(ctx, id);
  requireScheduleRights(ctx, s);
  assertVersion(ctx, s);
  if (s.state === 'active' || s.state === 'paused') throw invalid('An active shift cannot be cancelled. End it with the reason Aborted.');
  await cancelShiftInternal(ctx, s, input.reason);
  return id;
};

export const markMissed = async (ctx: CommandContext, id: string, input: { reason: string }) => {
  const s = await lockShift(ctx, id);
  requireScheduleRights(ctx, s);
  assertVersion(ctx, s);
  assertTransition(SHIFT_TRANSITIONS, s.state, 'missed', 'shift');
  if (ctx.app.clock.now().getTime() < s.scheduledEnd.getTime()) throw invalid('A shift can be marked Missed only after its scheduled end.');
  const [row] = await ctx.tx
    .update(shifts)
    .set({ state: 'missed', missedConfirmedAt: ctx.app.clock.now(), cancelReason: input.reason, needsReviewReason: null, ...touch(ctx, shifts) })
    .where(eq(shifts.id, id))
    .returning();
  await audit(ctx, { action: 'shift.missed_confirmed', entityType: 'shift', entityId: id, projectId: s.projectId, reason: input.reason, diff: { state: { from: s.state, to: 'missed' } } });
  await emit(ctx, { type: 'shift.missed', entityType: 'shift', entityId: id, revision: row!.rowVersion });
  return id;
};

export const allowEarlyStart = async (ctx: CommandContext, id: string, input: { reason: string }) => {
  const s = await lockShift(ctx, id);
  requireScheduleRights(ctx, s);
  assertVersion(ctx, s);
  if (s.state !== 'scheduled') throw invalid('Only scheduled shifts can get an early start override.');
  const [row] = await ctx.tx.update(shifts).set({ startOverrideReason: input.reason, ...touch(ctx, shifts) }).where(eq(shifts.id, id)).returning();
  await audit(ctx, { action: 'shift.early_start_allowed', entityType: 'shift', entityId: id, projectId: s.projectId, reason: input.reason });
  await emit(ctx, { type: 'shift.updated', entityType: 'shift', entityId: id, revision: row!.rowVersion });
  await notifyMember(ctx, s, s.membershipId, `shift.early_start:${id}`, 'You may start your shift early', null, 'general');
  return id;
};

/** Own-shift actions: only the assigned member, holding the start/end permission of their role. */
const requireOwn = (ctx: Ctx, s: ShiftRow, permission: 'shifts.start.own' | 'shifts.end.own') => {
  if (s.membershipId !== me(ctx)) throw new AppError('FORBIDDEN', 'Only the assigned member can do this. Supervisors use Correct Time.');
  if (!holds(ctx, permission)) throw new AppError('FORBIDDEN', 'Your role does not allow this shift action.');
};

/** Pending (submitted, unacknowledged) handovers addressed to this shift or to its member for its accounts. */
const pendingHandoversFor = async (ctx: Ctx, s: ShiftRow, accountIds: string[]) =>
  dbOf(ctx)
    .select()
    .from(handovers)
    .where(
      and(
        eq(handovers.workspaceId, ctx.actor.workspaceId),
        eq(handovers.state, 'submitted'),
        ne(handovers.fromShiftId, s.id),
        or(eq(handovers.toShiftId, s.id), and(eq(handovers.recipientMembershipId, s.membershipId), inArray(handovers.accountId, accountIds))),
      ),
    );

export const startShift = async (ctx: CommandContext, id: string, input: { handoverAcknowledgementId?: string; noHandoverReason?: string }) => {
  const s = await lockShift(ctx, id);
  requireOwn(ctx, s, 'shifts.start.own');
  assertVersion(ctx, s);
  assertTransition(SHIFT_TRANSITIONS, s.state, 'active', 'shift');
  const now = ctx.app.clock.now();
  if (now.getTime() < s.scheduledStart.getTime() - SHIFT_LIMITS.earlyStartMinutes * 60_000 && !s.startOverrideReason)
    throw invalid('Starting more than 15 minutes before the scheduled start needs a supervisor override.', { code: 'EARLY_START' });
  const links = await loadShiftAccounts(ctx.tx, ctx.actor.workspaceId, [s.id]);
  const accountIds = links.map((l) => l.accountId);
  const valid = await ctx.tx
    .select({ accountId: ofmAssignments.accountId })
    .from(ofmAssignments)
    .where(and(eq(ofmAssignments.workspaceId, ctx.actor.workspaceId), eq(ofmAssignments.membershipId, s.membershipId), inArray(ofmAssignments.accountId, accountIds), activeAt(now)));
  const missing = accountIds.filter((a) => !valid.some((v) => v.accountId === a));
  if (missing.length) throw invalid('You have no valid OFM assignment for every account of this shift.', { code: 'NO_VALID_ASSIGNMENT', accountIds: missing });
  const other = await ctx.tx
    .select({ id: shifts.id })
    .from(shifts)
    .where(and(eq(shifts.workspaceId, ctx.actor.workspaceId), eq(shifts.membershipId, s.membershipId), inArray(shifts.state, ['active', 'paused']), ne(shifts.id, s.id)));
  if (other.length) throw invalid('You already have an active shift. End it before starting another.', { activeShiftId: other[0]!.id });
  const pending = await pendingHandoversFor(ctx, s, accountIds);
  let acknowledgedHandoverId: string | null = null;
  if (input.handoverAcknowledgementId) {
    const [h] = await ctx.tx
      .select()
      .from(handovers)
      .where(and(eq(handovers.workspaceId, ctx.actor.workspaceId), eq(handovers.id, input.handoverAcknowledgementId)));
    if (!h || h.state !== 'acknowledged' || (h.toShiftId !== s.id && h.recipientMembershipId !== s.membershipId))
      throw fieldErr('handoverAcknowledgementId', 'NOT_ACKNOWLEDGED', 'Acknowledge the handover before starting.');
    acknowledgedHandoverId = h.id;
  }
  const stillPending = pending.filter((p) => p.id !== acknowledgedHandoverId);
  if (stillPending.length && !input.noHandoverReason)
    throw fieldErr('handoverAcknowledgementId', 'HANDOVER_PENDING', 'Acknowledge the previous handover or explain why you start without it.');
  const [row] = await ctx.tx
    .update(shifts)
    .set({
      state: 'active',
      actualStart: now,
      acknowledgedHandoverId,
      noHandoverReason: stillPending.length ? (input.noHandoverReason ?? null) : null,
      needsReviewReason: s.needsReviewReason === 'not_started' ? null : s.needsReviewReason,
      ...touch(ctx, shifts),
    })
    .where(eq(shifts.id, id))
    .returning();
  await audit(ctx, { action: 'shift.started', entityType: 'shift', entityId: id, projectId: s.projectId, metadata: { lateMinutes: Math.round((now.getTime() - s.scheduledStart.getTime()) / 60_000) } });
  await emit(ctx, { type: 'shift.started', entityType: 'shift', entityId: id, revision: row!.rowVersion });
  if (stillPending.length && input.noHandoverReason) {
    // The unacknowledged matters stay visible to the supervisor.
    const supervisor = s.supervisorMembershipId ?? (await profileSupervisor(ctx, s.projectId));
    for (const h of stillPending)
      await notify(ctx.tx, {
        workspaceId: ctx.actor.workspaceId,
        recipientMembershipIds: [supervisor ?? ''],
        eventType: 'handover.unacknowledged',
        eventKey: `handover.unacknowledged:${h.id}`,
        kind: 'general',
        title: 'A handover was not acknowledged at shift start',
        entityType: 'handover',
        entityId: h.id,
        projectId: s.projectId,
        actorMembershipId: ctx.actor.membershipId,
        at: now,
      });
  }
  return id;
};

export const profileSupervisor = async (ctx: Ctx, projectId: string) => {
  const [p] = await dbOf(ctx).select({ s: ofmProfiles.supervisorMembershipId }).from(ofmProfiles).where(eq(ofmProfiles.projectId, projectId));
  return p?.s ?? null;
};

export const pauseShift = async (ctx: CommandContext, id: string, input: { reason?: string }) => {
  const s = await lockShift(ctx, id);
  requireOwn(ctx, s, 'shifts.start.own');
  assertVersion(ctx, s);
  assertTransition(SHIFT_TRANSITIONS, s.state, 'paused', 'shift');
  const now = ctx.app.clock.now();
  await ctx.tx.insert(shiftBreaks).values({ ...stamp(ctx), id: newId(), shiftId: id, startedAt: now, reason: input.reason ?? null });
  const [row] = await ctx.tx.update(shifts).set({ state: 'paused', ...touch(ctx, shifts) }).where(eq(shifts.id, id)).returning();
  await audit(ctx, { action: 'shift.paused', entityType: 'shift', entityId: id, projectId: s.projectId });
  await emit(ctx, { type: 'shift.paused', entityType: 'shift', entityId: id, revision: row!.rowVersion });
  return id;
};

export const resumeShift = async (ctx: CommandContext, id: string, input: { breakId: string }) => {
  const s = await lockShift(ctx, id);
  requireOwn(ctx, s, 'shifts.start.own');
  assertVersion(ctx, s);
  assertTransition(SHIFT_TRANSITIONS, s.state, 'active', 'shift');
  const [b] = await ctx.tx
    .select()
    .from(shiftBreaks)
    .where(and(eq(shiftBreaks.workspaceId, ctx.actor.workspaceId), eq(shiftBreaks.id, input.breakId), eq(shiftBreaks.shiftId, id)))
    .for('update');
  if (!b) throw fieldErr('breakId', 'NOT_FOUND', 'This break does not belong to the shift.');
  if (b.endedAt) throw invalid('This break is already closed.');
  const now = ctx.app.clock.now();
  await ctx.tx.update(shiftBreaks).set({ endedAt: now, ...touch(ctx, shiftBreaks) }).where(eq(shiftBreaks.id, b.id));
  const [row] = await ctx.tx.update(shifts).set({ state: 'active', ...touch(ctx, shifts) }).where(eq(shifts.id, id)).returning();
  await audit(ctx, { action: 'shift.resumed', entityType: 'shift', entityId: id, projectId: s.projectId });
  await emit(ctx, { type: 'shift.resumed', entityType: 'shift', entityId: id, revision: row!.rowVersion });
  return id;
};

/** Actual intervals of one member must not overlap; overlaps are flagged for review before compensation. */
const flagActualOverlaps = async (ctx: CommandContext, s: ShiftRow) => {
  if (!s.actualStart || !s.actualEnd) return;
  const others = await ctx.tx
    .select({ id: shifts.id })
    .from(shifts)
    .where(
      and(
        eq(shifts.workspaceId, ctx.actor.workspaceId),
        eq(shifts.membershipId, s.membershipId),
        ne(shifts.id, s.id),
        isNotNull(shifts.actualStart),
        lt(shifts.actualStart, s.actualEnd),
        or(sql`${shifts.actualEnd} IS NULL`, gt(shifts.actualEnd, s.actualStart)),
      ),
    );
  if (!others.length) return;
  await ctx.tx
    .update(shifts)
    .set({ needsReviewReason: 'actual_overlap' })
    .where(inArray(shifts.id, [s.id, ...others.map((o) => o.id)]));
};

/** Close an open break at `at` (End and forced end use the same instant). */
const closeOpenBreak = async (ctx: CommandContext, shiftId: string, at: Date) => {
  const [open] = await ctx.tx.select().from(shiftBreaks).where(and(eq(shiftBreaks.shiftId, shiftId), sql`${shiftBreaks.endedAt} IS NULL`)).for('update');
  if (!open) return;
  if (open.startedAt.getTime() > at.getTime()) throw fieldErr('actualEnd', 'BREAK_AFTER_END', 'The shift cannot end before its open break started.');
  await ctx.tx.update(shiftBreaks).set({ endedAt: at, ...touch(ctx, shiftBreaks) }).where(eq(shiftBreaks.id, open.id));
};

export const endShift = async (ctx: CommandContext, id: string, input: { endNote?: string; aborted?: boolean; abortReason?: string }) => {
  const s = await lockShift(ctx, id);
  requireOwn(ctx, s, 'shifts.end.own');
  assertVersion(ctx, s);
  assertTransition(SHIFT_TRANSITIONS, s.state, 'ended', 'shift');
  if (input.aborted && !input.abortReason) throw fieldErr('abortReason', 'REQUIRED', 'Give the reason the shift was aborted.');
  const now = ctx.app.clock.now();
  await closeOpenBreak(ctx, id, now);
  const note = [input.aborted ? `Aborted: ${input.abortReason}` : null, input.endNote ?? null].filter(Boolean).join('\n\n') || null;
  const [row] = await ctx.tx
    .update(shifts)
    .set({ state: 'ended', actualEnd: now, endNote: note, aborted: !!input.aborted, ...touch(ctx, shifts) })
    .where(eq(shifts.id, id))
    .returning();
  await ensureReportDraft(ctx, row!);
  await flagActualOverlaps(ctx, row!);
  await audit(ctx, { action: input.aborted ? 'shift.aborted' : 'shift.ended', entityType: 'shift', entityId: id, projectId: s.projectId, reason: input.aborted ? input.abortReason : undefined });
  await emit(ctx, { type: 'shift.ended', entityType: 'shift', entityId: id, revision: row!.rowVersion, payload: { aborted: !!input.aborted } });
  return id;
};

/**
 * Supervisor correction (T091): reason required, before/after recorded, audit written and an event
 * tells compensation that the shift-hour source changed. An End entered here for an active shift is
 * a forced end (entered_by = the supervisor); nothing is invented from the schedule.
 */
export const correctShiftTime = async (
  ctx: CommandContext,
  id: string,
  input: { actualStart?: string; actualEnd?: string; breaks?: { id?: string; startedAt: string; endedAt: string }[]; reason: string },
) => {
  const s = await lockShift(ctx, id);
  if (!allowed(ctx, 'shifts.correct', shiftScope(s))) throw new AppError('FORBIDDEN', 'Only a supervisor can correct shift time.');
  if (s.membershipId === me(ctx)) throw new AppError('FORBIDDEN', 'You cannot correct the time of your own shift.');
  assertVersion(ctx, s);
  if (!['active', 'paused', 'ended'].includes(s.state)) throw invalid('Only started shifts have actual time to correct.');
  const forcedEnd = s.state !== 'ended' && !!input.actualEnd;
  if (s.state !== 'ended' && input.breaks && !forcedEnd) throw fieldErr('breaks', 'SHIFT_RUNNING', 'Correct breaks after the shift has ended, or enter the end time as well.');
  const actualStart = input.actualStart ? new Date(input.actualStart) : s.actualStart!;
  const actualEnd = input.actualEnd ? new Date(input.actualEnd) : s.actualEnd;
  const now = ctx.app.clock.now();
  if (actualStart.getTime() > now.getTime() + 60_000) throw fieldErr('actualStart', 'IN_FUTURE', 'Actual start cannot be in the future.');
  if (actualEnd && actualEnd.getTime() > now.getTime() + 60_000) throw fieldErr('actualEnd', 'IN_FUTURE', 'Actual end cannot be in the future.');
  if (actualEnd && actualEnd.getTime() < actualStart.getTime()) throw fieldErr('actualEnd', 'BEFORE_START', 'Actual end must be after the actual start.');
  const before = await loadBreaks(ctx.tx, ctx.actor.workspaceId, [id]);
  const snapshot = (st: Date | null, en: Date | null, br: { startedAt: Date; endedAt: Date | null }[]) => ({
    actualStart: st?.toISOString() ?? null,
    actualEnd: en?.toISOString() ?? null,
    breaks: br.map((b) => ({ startedAt: b.startedAt.toISOString(), endedAt: b.endedAt?.toISOString() ?? null })),
  });
  let nextBreaks: { id?: string; startedAt: Date; endedAt: Date | null }[] = before.map((b) => ({ id: b.id, startedAt: b.startedAt, endedAt: b.endedAt }));
  if (input.breaks) nextBreaks = input.breaks.map((b) => ({ id: b.id, startedAt: new Date(b.startedAt), endedAt: new Date(b.endedAt) }));
  else if (forcedEnd) nextBreaks = nextBreaks.map((b) => ({ ...b, endedAt: b.endedAt ?? actualEnd }));
  const issues = validateBreaks(actualStart, actualEnd, nextBreaks);
  if (issues.length) throw fieldErr(`breaks.${issues[0]!.index}`, issues[0]!.code, issues[0]!.message);
  // Apply breaks: update matching ids, delete removed, insert new.
  const keep = new Set(nextBreaks.map((b) => b.id).filter(Boolean));
  for (const b of before) if (!keep.has(b.id)) await ctx.tx.delete(shiftBreaks).where(eq(shiftBreaks.id, b.id));
  for (const b of nextBreaks) {
    if (b.id && before.some((x) => x.id === b.id)) await ctx.tx.update(shiftBreaks).set({ startedAt: b.startedAt, endedAt: b.endedAt, ...touch(ctx, shiftBreaks) }).where(eq(shiftBreaks.id, b.id));
    else await ctx.tx.insert(shiftBreaks).values({ ...stamp(ctx), id: newId(), shiftId: id, startedAt: b.startedAt, endedAt: b.endedAt, reason: 'Supervisor correction' });
  }
  const correctionId = newId();
  await ctx.tx.insert(shiftTimeCorrections).values({
    ...stamp(ctx),
    id: correctionId,
    shiftId: id,
    before: snapshot(s.actualStart, s.actualEnd, before),
    after: { ...snapshot(actualStart, actualEnd, nextBreaks), forcedEnd },
    reason: input.reason,
  });
  const [row] = await ctx.tx
    .update(shifts)
    .set({
      actualStart,
      actualEnd,
      state: forcedEnd ? 'ended' : s.state,
      correctedAt: now,
      correctionReason: input.reason,
      needsReviewReason: null,
      ...(forcedEnd ? { endNote: `Ended by supervisor correction: ${input.reason}` } : {}),
      ...touch(ctx, shifts),
    })
    .where(eq(shifts.id, id))
    .returning();
  if (forcedEnd) await ensureReportDraft(ctx, row!);
  await flagActualOverlaps(ctx, row!);
  await audit(ctx, {
    action: forcedEnd ? 'shift.force_ended' : 'shift.time_corrected',
    entityType: 'shift',
    entityId: id,
    projectId: s.projectId,
    reason: input.reason,
    diff: diffFields(s, row!, ['actualStart', 'actualEnd', 'state']),
    metadata: { correctionId, breaksBefore: before.length, breaksAfter: nextBreaks.length },
  });
  // Compensation source invalidation: finance compares shifts.corrected_at with its calculation time.
  await emit(ctx, { type: 'shift.time_corrected', entityType: 'shift', entityId: id, revision: row!.rowVersion, payload: { compensationSourceInvalidated: true, forcedEnd, correctionId } });
  await notifyMember(ctx, s, s.membershipId, `shift.corrected:${correctionId}`, 'Your shift time was corrected by a supervisor', null, 'general');
  return id;
};

export const setTimeAllocation = async (ctx: CommandContext, id: string, input: { shares: { accountId: string; sharePercent: string }[] | null }) => {
  const s = await lockShift(ctx, id);
  if (!allowed(ctx, 'shifts.correct', shiftScope(s))) throw new AppError('FORBIDDEN', 'Only a supervisor can confirm time allocation.');
  assertVersion(ctx, s);
  const links = await loadShiftAccounts(ctx.tx, ctx.actor.workspaceId, [id]);
  if (input.shares) {
    const ids = new Set(links.map((l) => l.accountId));
    if (input.shares.length !== links.length || input.shares.some((x) => !ids.has(x.accountId)) || new Set(input.shares.map((x) => x.accountId)).size !== links.length)
      throw fieldErr('shares', 'ACCOUNTS', 'Give one share for every account of the shift.');
    if (input.shares.some((x) => !isValidPercent(x.sharePercent))) throw fieldErr('shares', 'INVALID', 'Shares are percentages with at most 4 decimals.');
    const total = input.shares.reduce((a, x) => a.plus(toBig(x.sharePercent)), toBig('0'));
    if (!total.eq(100)) throw fieldErr('shares', 'NOT_100', 'Confirmed shares must add up to exactly 100%.');
  }
  for (const l of links) {
    const share = input.shares?.find((x) => x.accountId === l.accountId)?.sharePercent ?? null;
    await ctx.tx.update(shiftAccounts).set({ timeAllocationShare: share, ...touch(ctx, shiftAccounts) }).where(eq(shiftAccounts.id, l.id));
  }
  const [row] = await ctx.tx.update(shifts).set({ ...touch(ctx, shifts) }).where(eq(shifts.id, id)).returning();
  await audit(ctx, { action: 'shift.time_allocation_set', entityType: 'shift', entityId: id, projectId: s.projectId, metadata: { shares: input.shares } });
  await emit(ctx, { type: 'shift.updated', entityType: 'shift', entityId: id, revision: row!.rowVersion });
  return id;
};

/** Move a scheduled shift to another member after assignment/overlap checks (swap, transfer, deactivation). */
export const reassignShift = async (ctx: CommandContext, s: ShiftRow, toMembershipId: string, reason: string) => {
  if (s.state !== 'scheduled') throw invalid('Only scheduled shifts can be reassigned.');
  const links = await loadShiftAccounts(ctx.tx, ctx.actor.workspaceId, [s.id]);
  await advisoryLocks(ctx, [`ofm-member:${toMembershipId}`, ...links.map((l) => `ofm-lane:${l.accountId}`)]);
  const r = await checkSchedule(
    ctx,
    {
      membershipId: toMembershipId,
      primaryAccountId: s.primaryAccountId,
      additionalAccountIds: links.filter((l) => !l.isPrimary).map((l) => l.accountId),
      scheduledStart: s.scheduledStart,
      scheduledEnd: s.scheduledEnd,
      timezone: s.timezone,
      parallelCoverage: s.parallelCoverage,
      excludeShiftId: s.id,
    },
    { authorize: false },
  );
  if (!r.ok) throw scheduleConflictError(r);
  const [row] = await ctx.tx.update(shifts).set({ membershipId: toMembershipId, startOverrideReason: null, ...touch(ctx, shifts) }).where(eq(shifts.id, s.id)).returning();
  await writeShiftAccounts(ctx, s.id, r.accounts, r.lanes, s.primaryAccountId);
  await audit(ctx, { action: 'shift.reassigned', entityType: 'shift', entityId: s.id, projectId: s.projectId, reason, diff: { membershipId: { from: s.membershipId, to: toMembershipId } } });
  await emit(ctx, { type: 'shift.reassigned', entityType: 'shift', entityId: s.id, revision: row!.rowVersion });
  await notifyMember(ctx, s, toMembershipId, `shift.assigned:${s.id}:${toMembershipId}`, 'Shift assigned to you', accountLabel(r.accounts[0]!));
  await notifyMember(ctx, s, s.membershipId, `shift.unassigned:${s.id}:${s.membershipId}:${row!.rowVersion}`, 'A shift was reassigned to another member', null, 'general');
  return row!;
};

// ——— Swap requests (§33.2) ———

type SwapRow = typeof shiftSwapRequests.$inferSelect;

const swapViews = async (ctx: Ctx, rows: SwapRow[]) => {
  if (!rows.length) return [];
  const db = dbOf(ctx);
  const ws = ctx.actor.workspaceId;
  const shiftRows = await db.select().from(shifts).where(and(eq(shifts.workspaceId, ws), inArray(shifts.id, rows.map((r) => r.shiftId))));
  const shiftBy = new Map(shiftRows.map((s) => [s.id, s]));
  const [briefs, refs] = await all(ctx, [() => shiftBriefs(ctx, shiftRows), () => loadMemberRefs(db, ws, rows.flatMap((r) => [r.fromMembershipId, r.proposedMembershipId, r.decidedBy]))] as const);
  const briefBy = new Map(briefs.map((b) => [b.id, b]));
  return rows.map((r) => {
    const s = shiftBy.get(r.shiftId)!;
    const schedule = allowed(ctx, 'shifts.schedule', shiftScope(s));
    const open = r.state === 'pending_acceptance' || r.state === 'pending_approval';
    return {
      id: r.id,
      shift: briefBy.get(r.shiftId)!,
      from: refOrUnknown(refs, r.fromMembershipId)!,
      proposed: refOrUnknown(refs, r.proposedMembershipId)!,
      reason: r.reason,
      state: r.state,
      acceptedAt: r.acceptedAt?.toISOString() ?? null,
      decidedAt: r.decidedAt?.toISOString() ?? null,
      decidedBy: refOrUnknown(refs, r.decidedBy),
      decisionNote: r.decisionNote,
      createdAt: r.createdAt.toISOString(),
      rowVersion: r.rowVersion,
      permissions: {
        accept: r.state === 'pending_acceptance' && r.proposedMembershipId === me(ctx),
        decline: open && (r.proposedMembershipId === me(ctx) || schedule),
        approve: r.state === 'pending_approval' && schedule && s.membershipId !== me(ctx),
        cancel: open && (r.fromMembershipId === me(ctx) || r.createdBy === ctx.actor.userId),
      },
    };
  });
};

export const getSwap = async (ctx: Ctx, id: string) => {
  const [r] = await dbOf(ctx).select().from(shiftSwapRequests).where(and(eq(shiftSwapRequests.workspaceId, ctx.actor.workspaceId), eq(shiftSwapRequests.id, id)));
  if (!r) throw notFound('Swap request');
  const [s] = await dbOf(ctx).select().from(shifts).where(eq(shifts.id, r.shiftId));
  if (!s || !(canReadShift(ctx, s) || r.proposedMembershipId === me(ctx))) throw notFound('Swap request');
  return (await swapViews(ctx, [r]))[0]!;
};

export const listSwaps = async (ctx: QueryContext, input: { state?: SwapRow['state'][]; shiftId?: string }) => {
  const rows = await ctx.app.db
    .select({ swap: shiftSwapRequests, shift: shifts })
    .from(shiftSwapRequests)
    .innerJoin(shifts, eq(shifts.id, shiftSwapRequests.shiftId))
    .where(
      and(
        eq(shiftSwapRequests.workspaceId, ctx.actor.workspaceId),
        input.state?.length ? inArray(shiftSwapRequests.state, input.state) : undefined,
        input.shiftId ? eq(shiftSwapRequests.shiftId, input.shiftId) : undefined,
        or(shiftVisibility(ctx) ?? sql`true`, eq(shiftSwapRequests.proposedMembershipId, me(ctx))),
      ),
    )
    .orderBy(desc(shiftSwapRequests.createdAt))
    .limit(200);
  return swapViews(ctx, rows.map((r) => r.swap));
};

export const requestSwap = async (ctx: CommandContext, shiftId: string, input: { proposedMembershipId: string; reason: string }) => {
  const s = await lockShift(ctx, shiftId);
  if (s.membershipId !== me(ctx) && !allowed(ctx, 'shifts.schedule', shiftScope(s))) throw new AppError('FORBIDDEN', 'Only the assigned member or a scheduler can request a swap.');
  if (s.state !== 'scheduled') throw invalid('Only scheduled shifts can be swapped.');
  if (input.proposedMembershipId === s.membershipId) throw fieldErr('proposedMembershipId', 'SAME_MEMBER', 'Choose another member.');
  await assertActiveMember(ctx, input.proposedMembershipId, 'proposedMembershipId');
  const id = newId();
  await ctx.tx.insert(shiftSwapRequests).values({ ...stamp(ctx), id, shiftId, fromMembershipId: s.membershipId, proposedMembershipId: input.proposedMembershipId, reason: input.reason });
  await audit(ctx, { action: 'shift.swap_requested', entityType: 'shift', entityId: shiftId, projectId: s.projectId, reason: input.reason, metadata: { swapId: id, proposedMembershipId: input.proposedMembershipId } });
  await emit(ctx, { type: 'shift.swap_requested', entityType: 'shift', entityId: shiftId });
  await notifyMember(ctx, s, input.proposedMembershipId, `shift.swap_requested:${id}`, 'A shift swap was proposed to you');
  return id;
};

const lockSwap = async (ctx: CommandContext, id: string) => {
  const r = await lockById(ctx, shiftSwapRequests, id, 'Swap request');
  const s = await lockById(ctx, shifts, r.shiftId, 'Shift');
  if (!(canReadShift(ctx, s) || r.proposedMembershipId === me(ctx))) throw notFound('Swap request');
  assertVersion(ctx, r);
  return { r, s };
};

const decideSwap = async (ctx: CommandContext, r: SwapRow, s: ShiftRow, to: SwapRow['state'], note: string | null) => {
  assertTransition(SWAP_TRANSITIONS, r.state, to, 'swap request');
  const at = ctx.app.clock.now();
  await ctx.tx
    .update(shiftSwapRequests)
    .set({
      state: to,
      ...(to === 'pending_approval' ? { acceptedAt: at } : { decidedAt: at, decidedBy: ctx.actor.membershipId, decisionNote: note }),
      ...touch(ctx, shiftSwapRequests),
    })
    .where(eq(shiftSwapRequests.id, r.id));
  await audit(ctx, { action: `shift.swap_${to}`, entityType: 'shift', entityId: s.id, projectId: s.projectId, reason: note, metadata: { swapId: r.id } });
  await emit(ctx, { type: `shift.swap_${to}`, entityType: 'shift', entityId: s.id });
};

export const acceptSwap = async (ctx: CommandContext, id: string) => {
  const { r, s } = await lockSwap(ctx, id);
  if (r.proposedMembershipId !== me(ctx)) throw new AppError('FORBIDDEN', 'Only the proposed member can accept.');
  await decideSwap(ctx, r, s, 'pending_approval', null);
  const supervisor = s.supervisorMembershipId ?? (await profileSupervisor(ctx, s.projectId));
  await notifyMember(ctx, s, supervisor, `shift.swap_accepted:${r.id}`, 'A shift swap is waiting for approval', null, 'review_request');
  return id;
};

export const declineSwap = async (ctx: CommandContext, id: string, input: { reason: string }) => {
  const { r, s } = await lockSwap(ctx, id);
  if (r.proposedMembershipId !== me(ctx) && !allowed(ctx, 'shifts.schedule', shiftScope(s))) throw new AppError('FORBIDDEN', 'You cannot decline this swap.');
  await decideSwap(ctx, r, s, 'declined', input.reason);
  await notifyMember(ctx, s, r.fromMembershipId, `shift.swap_declined:${r.id}`, 'Your shift swap request was declined', null, 'general');
  return id;
};

export const cancelSwap = async (ctx: CommandContext, id: string) => {
  const { r, s } = await lockSwap(ctx, id);
  if (r.fromMembershipId !== me(ctx) && r.createdBy !== ctx.actor.userId) throw new AppError('FORBIDDEN', 'Only the requester can withdraw the swap.');
  await decideSwap(ctx, r, s, 'cancelled', 'Withdrawn by requester');
  return id;
};

export const approveSwap = async (ctx: CommandContext, id: string, input: { note?: string }) => {
  const { r, s } = await lockSwap(ctx, id);
  if (!allowed(ctx, 'shifts.schedule', shiftScope(s))) throw new AppError('FORBIDDEN', 'Only a supervisor can approve swaps.');
  if (s.membershipId === me(ctx)) throw new AppError('FORBIDDEN', 'You cannot approve a swap of your own shift.');
  assertTransition(SWAP_TRANSITIONS, r.state, 'approved', 'swap request');
  if (s.membershipId !== r.fromMembershipId) throw invalid('The shift was reassigned after the request. Ask for a new swap.');
  await reassignShift(ctx, s, r.proposedMembershipId, input.note ?? r.reason);
  await decideSwap(ctx, r, s, 'approved', input.note ?? null);
  return id;
};

// ——— Queries ———

export interface ListShiftsInput {
  cursor?: string;
  pageSize?: number;
  from?: string;
  to?: string;
  membershipId?: string;
  accountId?: string;
  projectId?: string;
  state?: ShiftRow['state'][];
  reportState?: ShiftRow['reportState'][];
  needsReview?: boolean;
  mine?: boolean;
  direction: 'asc' | 'desc';
}

export const shiftFilters = (ctx: Ctx, input: Omit<ListShiftsInput, 'cursor' | 'pageSize' | 'direction'>): SQL[] => {
  const out: SQL[] = [eq(shifts.workspaceId, ctx.actor.workspaceId)];
  const vis = shiftVisibility(ctx);
  if (vis) out.push(vis);
  if (input.from) out.push(gt(shifts.scheduledEnd, new Date(input.from)));
  if (input.to) out.push(lt(shifts.scheduledStart, new Date(input.to)));
  if (input.membershipId) out.push(eq(shifts.membershipId, input.membershipId));
  if (input.mine) out.push(eq(shifts.membershipId, me(ctx)));
  if (input.projectId) out.push(eq(shifts.projectId, input.projectId));
  if (input.accountId) out.push(sql`EXISTS (SELECT 1 FROM ${shiftAccounts} sa WHERE sa.shift_id = ${shifts.id} AND sa.account_id = ${input.accountId})`);
  if (input.state?.length) out.push(inArray(shifts.state, input.state));
  if (input.reportState?.length) out.push(inArray(shifts.reportState, input.reportState));
  if (input.needsReview) out.push(isNotNull(shifts.needsReviewReason));
  return out;
};

export const listShifts = async (ctx: QueryContext, input: ListShiftsInput) => {
  requireAnyPermission(ctx, ['shifts.read.scope', 'shifts.read.own']);
  const k = exprKeyset(shifts.scheduledStart, shifts.id, 'timestamp', input.direction, input);
  const rows = await ctx.app.db
    .select()
    .from(shifts)
    .where(and(...shiftFilters(ctx, input), k.where))
    .orderBy(...k.orderBy)
    .limit(k.limit);
  const page = k.finish(rows, (r) => r.scheduledStart, (r) => r.id);
  return { ...page, items: await shiftSummaries(ctx, page.items) };
};

export const getShiftDetail = async (ctx: QueryContext | CommandContext, id: string) => {
  const s = await findById(ctx, shifts, id, 'Shift');
  if (!canReadShift(ctx, s)) throw notFound('Shift');
  const db = dbOf(ctx);
  const ws = ctx.actor.workspaceId;
  const now = ctx.app.clock.now();
  const [summary] = await shiftSummaries(ctx, [s]);
  const accountIds = summary!.accounts.map((a) => a.account.id);
  const scope = shiftScope(s);
  const own = s.membershipId === me(ctx);
  const [breaks, corrections, incoming, outgoing, opRows, saleRows, reportRows, swaps, tz, wsInfo, taskRows, interactions] = await all(ctx, [
    () => loadBreaks(db, ws, [id]),
    () => db.select().from(shiftTimeCorrections).where(and(eq(shiftTimeCorrections.workspaceId, ws), eq(shiftTimeCorrections.shiftId, id))).orderBy(desc(shiftTimeCorrections.createdAt)),
    () =>
      db
        .select()
        .from(handovers)
        .where(
          and(
            eq(handovers.workspaceId, ws),
            ne(handovers.fromShiftId, id),
            or(
              eq(handovers.toShiftId, id),
              s.acknowledgedHandoverId ? eq(handovers.id, s.acknowledgedHandoverId) : sql`false`,
              and(eq(handovers.state, 'submitted'), eq(handovers.recipientMembershipId, s.membershipId), inArray(handovers.accountId, accountIds)),
            ),
          ),
        )
        .orderBy(desc(handovers.submittedAt))
        .limit(10),
    () => db.select().from(handovers).where(and(eq(handovers.workspaceId, ws), eq(handovers.fromShiftId, id))).orderBy(asc(handovers.createdAt)),
    () =>
      db
        .select()
        .from(operations)
        .where(
          and(
            eq(operations.workspaceId, ws),
            or(
              eq(operations.shiftId, id),
              and(eq(operations.ownerMembershipId, s.membershipId), inArray(operations.accountId, accountIds), inArray(operations.status, ['open', 'in_progress', 'waiting'])),
            ),
            sql`${operations.archivedAt} IS NULL`,
          ),
        )
        .orderBy(asc(operations.dueAt))
        .limit(50),
    () => db.select().from(saleCandidates).where(and(eq(saleCandidates.workspaceId, ws), eq(saleCandidates.shiftId, id))).orderBy(desc(saleCandidates.occurredAt)),
    () => db.select().from(shiftReports).where(and(eq(shiftReports.workspaceId, ws), eq(shiftReports.shiftId, id))),
    () => db.select().from(shiftSwapRequests).where(and(eq(shiftSwapRequests.workspaceId, ws), eq(shiftSwapRequests.shiftId, id))).orderBy(desc(shiftSwapRequests.createdAt)).limit(10),
    () => memberTimezones(db, ws, [s.membershipId]),
    () => workspaceInfo(db, ws),
    () => db.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.workspaceId, ws), eq(tasks.shiftId, id))).limit(50),
    () => db.select({ n: count() }).from(interactionLogs).where(and(eq(interactionLogs.workspaceId, ws), eq(interactionLogs.shiftId, id))),
  ] as const);
  const report = reportRows[0] ?? null;
  const author = await authorRefs(db, ws, corrections.map((c) => c.createdBy));
  const opsVisible = opRows.filter((o) => allowed(ctx, 'operations.read', operationScope(o)));
  const salesVisible = saleRows.filter((x) => canReadSale(ctx, x));
  const taskMap = holds(ctx, 'tasks.read') ? await taskRefs(ctx, taskRows.map((t) => t.id)) : null;
  const openSwap = swaps.some((w) => w.state === 'pending_acceptance' || w.state === 'pending_approval');
  const schedule = allowed(ctx, 'shifts.schedule', scope);
  const correct = allowed(ctx, 'shifts.correct', scope);
  const dst = dstInfo(s.scheduledStart, s.scheduledEnd, s.timezone);
  const reportOpen = !!report && (report.state === 'draft' || report.state === 'changes_requested');
  const started = ['active', 'paused', 'ended'].includes(s.state);
  return {
    ...summary!,
    breaks: breaks.map((b) => ({ id: b.id, startedAt: b.startedAt.toISOString(), endedAt: b.endedAt?.toISOString() ?? null, reason: b.reason })),
    openBreakId: breaks.find((b) => !b.endedAt)?.id ?? null,
    serverNow: now.toISOString(),
    memberTimezone: tz.get(s.membershipId) ?? wsInfo.timezone,
    workspaceTimezone: wsInfo.timezone,
    dst: { offsetChanges: dst.offsetChanges, elapsedMinutes: dst.elapsedMinutes, wallClockMinutes: dst.wallClockMinutes },
    startOverrideReason: s.startOverrideReason,
    noHandoverReason: s.noHandoverReason,
    acknowledgedHandoverId: s.acknowledgedHandoverId,
    endNote: s.endNote,
    aborted: s.aborted,
    missedConfirmedAt: s.missedConfirmedAt?.toISOString() ?? null,
    forgotEndAlertedAt: s.forgotEndAlertedAt?.toISOString() ?? null,
    correctedAt: s.correctedAt?.toISOString() ?? null,
    correctionReason: s.correctionReason,
    corrections: corrections.map((c) => ({ id: c.id, before: c.before, after: c.after, reason: c.reason, createdAt: c.createdAt.toISOString(), by: author(c.createdBy) })),
    incomingHandovers: await handoverSummaries(ctx, incoming),
    outgoingHandover: outgoing.length ? (await handoverSummaries(ctx, [outgoing.find((h) => h.accountId === s.primaryAccountId) ?? outgoing[0]!]))[0]! : null,
    ...(taskMap ? { tasks: [...taskMap.values()] } : {}),
    operations: await operationSummaries(ctx, opsVisible),
    ...(allowed(ctx, 'contacts.read', { projectId: s.projectId, accountId: s.primaryAccountId }) ? { interactionsCount: Number(interactions[0]?.n ?? 0) } : {}),
    ...(salesVisible.length || allowed(ctx, 'sale-candidates.write', scope) ? { saleCandidates: await saleViews(ctx, salesVisible) } : {}),
    report: report ? await reportDetail(ctx, s, report) : null,
    swapRequests: await swapViews(ctx, swaps),
    earlyStartAllowed: !!s.startOverrideReason,
    permissions: {
      start: own && s.state === 'scheduled' && holds(ctx, 'shifts.start.own'),
      pause: own && s.state === 'active' && holds(ctx, 'shifts.start.own'),
      resume: own && s.state === 'paused' && holds(ctx, 'shifts.start.own'),
      end: own && (s.state === 'active' || s.state === 'paused') && holds(ctx, 'shifts.end.own'),
      cancel: s.state === 'scheduled' && schedule,
      editSchedule: s.state === 'scheduled' && schedule,
      correct: correct && !own && started,
      markMissed: s.state === 'scheduled' && schedule && now.getTime() >= s.scheduledEnd.getTime(),
      allowEarlyStart: s.state === 'scheduled' && schedule && !s.startOverrideReason,
      requestSwap: s.state === 'scheduled' && (own || schedule) && !openSwap,
      editReport: own && reportOpen,
      submitReport: own && reportOpen,
      approveReport: !!report && report.state === 'submitted' && allowed(ctx, 'shifts.approve', scope) && !own,
      writeHandover: started && allowed(ctx, 'handovers.write', scope) && (own || schedule || correct),
      addOperation: s.state !== 'cancelled' && allowed(ctx, 'operations.write', scope),
      registerSale: allowed(ctx, 'sale-candidates.write', scope),
      logInteraction: started && allowed(ctx, 'contacts.write', scope),
      setTimeAllocation: correct && summary!.accounts.length > 1,
    },
  };
};

