import { and, asc, desc, eq, inArray, lte, sql } from 'drizzle-orm';
import { hasAnywhere } from '@castlane/authorization';
import { memberships, notifications, reportSchedules, reportSnapshots, savedReports } from '@castlane/database';
import type { ReportScheduleRow } from '@castlane/api-contracts';
import { AppError, DateTime, isAppError, newId, notFound } from '@castlane/domain';
import { loadAccessSnapshot, requirePermission } from '../../core/access';
import { audit } from '../../core/audit';
import { executeSystemCommand } from '../../core/command';
import { all, dbOf, type AppServices, type CommandContext, type QueryContext } from '../../core/context';
import { emit } from '../../core/events';
import { enqueueJob } from '../../core/jobs';
import { defineJob, defineSchedule, memberJobContext } from '../../core/jobs-registry';
import { loadMemberRefs, refOrUnknown } from '../../core/members';
import { notify } from '../../core/notify';
import { defineResponsibilityProvider } from '../../core/responsibility-registry';
import { assertVersion, lockById, stamp, touch } from '../../core/rows';
import type { Ctx } from '../common';

type ScheduleRow = typeof reportSchedules.$inferSelect;
type Cadence = ScheduleRow['cadence'];

const me = (ctx: Ctx) => ctx.actor.membershipId ?? '00000000-0000-4000-8000-000000000000';

/** Next delivery after `after`: daily at HH:MM, weekly on Monday, monthly on the 1st (in the schedule zone). */
export const nextScheduleRun = (cadence: Cadence, localTime: string, zone: string, after: Date): Date => {
  const [hh, mm] = localTime.split(':').map(Number);
  const at = (d: DateTime) => d.set({ hour: hh ?? 8, minute: mm ?? 0, second: 0, millisecond: 0 });
  const local = DateTime.fromJSDate(after, { zone });
  let c: DateTime;
  if (cadence === 'daily') {
    c = at(local);
    if (c.toMillis() <= after.getTime()) c = at(local.plus({ days: 1 }));
  } else if (cadence === 'weekly') {
    c = at(local.set({ weekday: 1 }));
    if (c.toMillis() <= after.getTime()) c = at(local.set({ weekday: 1 }).plus({ weeks: 1 }));
  } else {
    c = at(local.startOf('month'));
    if (c.toMillis() <= after.getTime()) c = at(local.startOf('month').plus({ months: 1 }));
  }
  return c.toUTC().toJSDate();
};

export const scheduleStatus = (s: Pick<ScheduleRow, 'active' | 'pausedReason'>): ReportScheduleRow['status'] => (s.active ? 'active' : s.pausedReason === 'needs_owner' ? 'paused_needs_owner' : 'paused');

const PAUSE_TEXT: Record<string, string> = {
  needs_owner: 'Paused — Needs Owner: the schedule owner is no longer active.',
  report_archived: 'Paused because the report was archived.',
  owner_lost_access: 'Paused because the owner can no longer schedule reports.',
  manual: 'Paused by a member.',
};

export const toScheduleRows = async (ctx: Ctx, rows: ScheduleRow[]): Promise<ReportScheduleRow[]> => {
  if (!rows.length) return [];
  const db = dbOf(ctx);
  const ws = ctx.actor.workspaceId;
  const [reports, refs] = await all(ctx, [
    () => db.select({ id: savedReports.id, name: savedReports.name }).from(savedReports).where(and(eq(savedReports.workspaceId, ws), inArray(savedReports.id, rows.map((r) => r.reportId)))),
    () => loadMemberRefs(db, ws, rows.flatMap((r) => [r.ownerMembershipId, ...r.recipientMembershipIds])),
  ] as const);
  return rows.map((s) => ({
    id: s.id,
    reportId: s.reportId,
    reportName: reports.find((r) => r.id === s.reportId)?.name ?? 'Report',
    cadence: s.cadence,
    recipients: s.recipientMembershipIds.map((m) => refOrUnknown(refs, m)!),
    owner: refOrUnknown(refs, s.ownerMembershipId)!,
    localTime: s.localTime,
    timezone: s.timezone,
    nextRunAt: s.nextRunAt.toISOString(),
    lastRunAt: s.lastRunAt?.toISOString() ?? null,
    status: scheduleStatus(s),
    pausedReason: s.active ? null : (PAUSE_TEXT[s.pausedReason ?? 'manual'] ?? s.pausedReason),
    emailNotify: s.emailNotify,
    lastRunResult: s.lastRunResult ?? null,
    rowVersion: s.rowVersion,
    permissions: { edit: (s.ownerMembershipId === me(ctx) || ctx.actor.access.isOwner) && hasAnywhere(ctx.actor.access, 'reports.schedule') },
  }));
};

const loadVisibleSchedule = async (ctx: Ctx, id: string) => {
  requirePermission(ctx, 'reports.schedule');
  const [s] = await dbOf(ctx).select().from(reportSchedules).where(and(eq(reportSchedules.workspaceId, ctx.actor.workspaceId), eq(reportSchedules.id, id)));
  if (!s) throw notFound('Schedule');
  if (s.ownerMembershipId !== me(ctx) && !ctx.actor.access.isOwner) {
    const [r] = await dbOf(ctx).select({ owner: savedReports.ownerMembershipId }).from(savedReports).where(eq(savedReports.id, s.reportId));
    if (r?.owner !== me(ctx)) throw notFound('Schedule');
  }
  return s;
};

export const getReportSchedule = async (ctx: Ctx, id: string) => (await toScheduleRows(ctx, [await loadVisibleSchedule(ctx, id)]))[0]!;

export const listReportSchedules = async (ctx: QueryContext, input: { reportId?: string }) => {
  requirePermission(ctx, 'reports.schedule');
  const rows = await ctx.app.db
    .select()
    .from(reportSchedules)
    .where(and(eq(reportSchedules.workspaceId, ctx.actor.workspaceId), input.reportId ? eq(reportSchedules.reportId, input.reportId) : undefined, eq(reportSchedules.ownerMembershipId, me(ctx))))
    .orderBy(asc(reportSchedules.nextRunAt));
  return toScheduleRows(ctx, rows);
};

type ScheduledReport = Pick<typeof savedReports.$inferSelect, 'ownerMembershipId' | 'sharing' | 'sharedWithMembershipIds'>;

/**
 * Recipients must be active members who can open reports and can read this report (its owner or on its
 * share list — reports are shared explicitly); each receives only their own permitted result.
 */
const assertRecipients = async (ctx: CommandContext, ids: string[], report: ScheduledReport) => {
  const { isReportReader } = await import('./reports');
  const unique = [...new Set(ids)];
  const rows = await ctx.tx
    .select({ id: memberships.id, userId: memberships.userId, status: memberships.status })
    .from(memberships)
    .where(and(eq(memberships.workspaceId, ctx.actor.workspaceId), inArray(memberships.id, unique)));
  for (const id of unique) {
    const m = rows.find((r) => r.id === id);
    const fail = (message: string) => new AppError('VALIDATION_FAILED', message, { fieldErrors: [{ field: 'recipientMembershipIds', code: 'INVALID_RECIPIENT', message }] });
    if (!m || m.status !== 'active') throw fail('Recipients must be active members.');
    const access = await loadAccessSnapshot(ctx.app.db, ctx.actor.workspaceId, m.userId, ctx.app.clock.now());
    if (!access || !hasAnywhere(access, 'reports.read')) throw fail('A recipient cannot open reports. Choose members with report access.');
    if (!isReportReader(report, id)) throw fail('A recipient is not on the report’s share list. Share the report with them first.');
  }
  return unique;
};

const loadScheduledReport = async (ctx: CommandContext, reportId: string) => {
  const { loadReadableReport, parseReportConfig } = await import('./reports');
  const { validateReportConfig } = await import('./engine');
  const r = await loadReadableReport(ctx, reportId);
  if (r.archivedAt) throw new AppError('INVALID_STATE', 'Restore the report before scheduling it.');
  return { r, config: parseReportConfig(r.config), validateReportConfig };
};

export const createReportSchedule = async (
  ctx: CommandContext,
  input: { reportId: string; cadence: Cadence; recipientMembershipIds: string[]; localTime: string; timezone: string; emailNotify: boolean },
) => {
  requirePermission(ctx, 'reports.schedule');
  if (!ctx.actor.membershipId) throw new AppError('FORBIDDEN', 'Only members can schedule reports.');
  const { r, config, validateReportConfig } = await loadScheduledReport(ctx, input.reportId);
  const recipients = await assertRecipients(ctx, input.recipientMembershipIds, r);
  validateReportConfig(ctx, config, { shared: recipients.some((x) => x !== ctx.actor.membershipId) });
  const id = newId();
  const nextRunAt = nextScheduleRun(input.cadence, input.localTime, input.timezone, ctx.app.clock.now());
  await ctx.tx.insert(reportSchedules).values({
    ...stamp(ctx),
    id,
    reportId: r.id,
    cadence: input.cadence,
    recipientMembershipIds: recipients,
    ownerMembershipId: ctx.actor.membershipId,
    localTime: input.localTime,
    timezone: input.timezone,
    nextRunAt,
    active: true,
    emailNotify: input.emailNotify,
  });
  await audit(ctx, { action: 'report_schedule.created', entityType: 'report_schedule', entityId: id, metadata: { reportId: r.id, cadence: input.cadence, recipients: recipients.length, emailNotify: input.emailNotify } });
  await emit(ctx, { type: 'report_schedule.created', entityType: 'report_schedule', entityId: id, revision: 1 });
  return id;
};

const lockOwnSchedule = async (ctx: CommandContext, id: string) => {
  await loadVisibleSchedule(ctx, id);
  const s = await lockById(ctx, reportSchedules, id, 'Schedule');
  if (s.ownerMembershipId !== me(ctx) && !ctx.actor.access.isOwner && s.pausedReason !== 'needs_owner') throw new AppError('FORBIDDEN', 'Only the schedule owner can change it.');
  assertVersion(ctx, s);
  return s;
};

export const updateReportSchedule = async (ctx: CommandContext, id: string, input: { cadence?: Cadence; recipientMembershipIds?: string[]; localTime?: string; timezone?: string; emailNotify?: boolean }) => {
  const s = await lockOwnSchedule(ctx, id);
  let recipients = s.recipientMembershipIds;
  if (input.recipientMembershipIds) {
    const { r, config, validateReportConfig } = await loadScheduledReport(ctx, s.reportId);
    recipients = await assertRecipients(ctx, input.recipientMembershipIds, r);
    validateReportConfig(ctx, config, { shared: recipients.some((x) => x !== s.ownerMembershipId) });
  }
  const cadence = input.cadence ?? s.cadence;
  const localTime = input.localTime ?? s.localTime;
  const timezone = input.timezone ?? s.timezone;
  await ctx.tx
    .update(reportSchedules)
    .set({ cadence, localTime, timezone, recipientMembershipIds: recipients, emailNotify: input.emailNotify ?? s.emailNotify, nextRunAt: nextScheduleRun(cadence, localTime, timezone, ctx.app.clock.now()), ...touch(ctx, reportSchedules) })
    .where(eq(reportSchedules.id, id));
  await audit(ctx, { action: 'report_schedule.updated', entityType: 'report_schedule', entityId: id, diff: { cadence: { from: s.cadence, to: cadence }, localTime: { from: s.localTime, to: localTime }, recipients: { from: s.recipientMembershipIds.length, to: recipients.length } } });
  await emit(ctx, { type: 'report_schedule.updated', entityType: 'report_schedule', entityId: id });
  return id;
};

export const pauseReportSchedule = async (ctx: CommandContext, id: string) => {
  const s = await lockOwnSchedule(ctx, id);
  if (!s.active) throw new AppError('INVALID_STATE', 'This schedule is already paused.');
  await ctx.tx.update(reportSchedules).set({ active: false, pausedReason: 'manual', ...touch(ctx, reportSchedules) }).where(eq(reportSchedules.id, id));
  await audit(ctx, { action: 'report_schedule.paused', entityType: 'report_schedule', entityId: id });
  await emit(ctx, { type: 'report_schedule.paused', entityType: 'report_schedule', entityId: id });
  return id;
};

/** Resume; a schedule that needed an owner is taken over by the member who resumes it. */
export const resumeReportSchedule = async (ctx: CommandContext, id: string) => {
  const s = await lockOwnSchedule(ctx, id);
  if (s.active) throw new AppError('INVALID_STATE', 'This schedule is already active.');
  const { config, validateReportConfig } = await loadScheduledReport(ctx, s.reportId);
  validateReportConfig(ctx, config, { shared: s.recipientMembershipIds.some((x) => x !== me(ctx)) });
  const takeOver = s.pausedReason === 'needs_owner' && s.ownerMembershipId !== me(ctx);
  await ctx.tx
    .update(reportSchedules)
    .set({
      active: true,
      pausedReason: null,
      ownerMembershipId: takeOver ? me(ctx) : s.ownerMembershipId,
      nextRunAt: nextScheduleRun(s.cadence, s.localTime, s.timezone, ctx.app.clock.now()),
      ...touch(ctx, reportSchedules),
    })
    .where(eq(reportSchedules.id, id));
  await audit(ctx, { action: 'report_schedule.resumed', entityType: 'report_schedule', entityId: id, metadata: takeOver ? { newOwner: me(ctx), previousOwner: s.ownerMembershipId } : undefined });
  await emit(ctx, { type: 'report_schedule.resumed', entityType: 'report_schedule', entityId: id });
  return id;
};

// ——— Delivery job ———

const pause = (app: AppServices, s: ScheduleRow, reason: string) =>
  app.db.update(reportSchedules).set({ active: false, pausedReason: reason, updatedAt: app.clock.now(), rowVersion: sql`${reportSchedules.rowVersion} + 1` }).where(eq(reportSchedules.id, s.id));

/**
 * Deliver one schedule: every recipient gets a snapshot computed with their own current
 * permissions (T116: never one broad snapshot for all), an Inbox notification and, when enabled, a
 * minimal e-mail notice without report data. Re-running the same slot never duplicates snapshots.
 */
export const deliverReportSchedule = async (app: AppServices, s: ScheduleRow) => {
  const runKey = s.nextRunAt.toISOString();
  const [owner] = await app.db.select({ status: memberships.status }).from(memberships).where(eq(memberships.id, s.ownerMembershipId));
  if (owner?.status !== 'active') {
    await pause(app, s, 'needs_owner');
    return { paused: 'needs_owner' };
  }
  const [report] = await app.db.select().from(savedReports).where(and(eq(savedReports.workspaceId, s.workspaceId), eq(savedReports.id, s.reportId)));
  if (!report || report.archivedAt) {
    await pause(app, s, 'report_archived');
    return { paused: 'report_archived' };
  }
  const ownerCtx = await memberJobContext(app, s.workspaceId, s.ownerMembershipId, { source: 'system' });
  if (!ownerCtx || !hasAnywhere(ownerCtx.actor.access, 'reports.schedule')) {
    await pause(app, s, 'owner_lost_access');
    return { paused: 'owner_lost_access' };
  }
  const { canReadReport, createReportSnapshot } = await import('./reports');
  let delivered = 0;
  const skipped: { membershipId: string; reason: string }[] = [];
  for (const recipient of s.recipientMembershipIds) {
    const ctx = await memberJobContext(app, s.workspaceId, recipient, { source: 'system' });
    if (!ctx) {
      skipped.push({ membershipId: recipient, reason: 'Member is not active' });
      continue;
    }
    if (!hasAnywhere(ctx.actor.access, 'reports.read')) {
      skipped.push({ membershipId: recipient, reason: 'No report access' });
      continue;
    }
    // The share list is read at send time: a member removed from it gets nothing (the snapshot below is
    // created on the recipient's behalf without the read check of an interactive run).
    if (!canReadReport(ctx, report)) {
      skipped.push({ membershipId: recipient, reason: 'Not on the report’s share list' });
      continue;
    }
    const [done] = await app.db
      .select({ id: reportSnapshots.id })
      .from(reportSnapshots)
      .where(and(eq(reportSnapshots.workspaceId, s.workspaceId), eq(reportSnapshots.reportId, s.reportId), eq(reportSnapshots.generatedForMembershipId, recipient), sql`${reportSnapshots.params} ->> 'runKey' = ${runKey}`, sql`${reportSnapshots.params} ->> 'scheduleId' = ${s.id}`));
    if (done) {
      delivered++;
      continue;
    }
    try {
      const snapshotId = await executeSystemCommand(ctx, async (c) => {
        const id = await createReportSnapshot(c, report.id, {}, { scheduleId: s.id, runKey, forMembershipId: recipient, report });
        await notify(c.tx, {
          workspaceId: s.workspaceId,
          recipientMembershipIds: [recipient],
          eventType: 'report.scheduled_snapshot',
          eventKey: `report.scheduled:${s.id}:${runKey}:${recipient}`,
          kind: 'general',
          title: `Scheduled report ready: ${report.name}`,
          excerpt: 'Your results are calculated with your own access.',
          entityType: 'report_snapshot',
          entityId: id,
          at: app.clock.now(),
          excludeActor: false,
        });
        if (s.emailNotify) {
          const [n] = await c.tx
            .select({ id: notifications.id })
            .from(notifications)
            .where(and(eq(notifications.workspaceId, s.workspaceId), eq(notifications.recipientMembershipId, recipient), eq(notifications.eventKey, `report.scheduled:${s.id}:${runKey}:${recipient}`)));
          if (n) await enqueueJob(c.tx, { type: 'mail.notification', workspaceId: s.workspaceId, payload: { notificationId: n.id, membershipId: recipient }, idempotencyKey: `mail.notification:report:${id}` });
        }
        return id;
      });
      if (snapshotId) delivered++;
    } catch (e) {
      if (!isAppError(e)) throw e;
      skipped.push({ membershipId: recipient, reason: e.code === 'FORBIDDEN' ? 'No access to this dataset' : e.message.slice(0, 200) });
    }
  }
  const now = app.clock.now();
  await app.db
    .update(reportSchedules)
    .set({
      lastRunAt: now,
      nextRunAt: nextScheduleRun(s.cadence, s.localTime, s.timezone, new Date(Math.max(now.getTime(), s.nextRunAt.getTime()))),
      lastRunResult: { delivered, skipped, at: now.toISOString() },
      updatedAt: now,
      rowVersion: sql`${reportSchedules.rowVersion} + 1`,
    })
    .where(eq(reportSchedules.id, s.id));
  return { delivered, skipped: skipped.length };
};

export const runDueReportSchedules = async (app: AppServices) => {
  const due = await app.db.select().from(reportSchedules).where(and(eq(reportSchedules.active, true), lte(reportSchedules.nextRunAt, app.clock.now()))).orderBy(asc(reportSchedules.nextRunAt)).limit(100);
  let delivered = 0;
  for (const s of due) delivered += ((await deliverReportSchedule(app, s)) as { delivered?: number }).delivered ?? 0;
  return { schedules: due.length, delivered };
};

defineJob('insights.reportSchedules', 'data', async ({ app }) => runDueReportSchedules(app), { leaseSeconds: 900 });
defineSchedule({ name: 'insights.reportSchedules', everySeconds: 300, jobType: 'insights.reportSchedules', pool: 'data' });

// ——— Responsibility (F12): schedules owned by a deactivated member ———

defineResponsibilityProvider({
  kind: 'reports.schedule_owner',
  label: 'Scheduled reports',
  unassignedBehaviour: 'Paused — Needs Owner until another member resumes it',
  list: async (ctx, membershipId) => {
    const rows = await dbOf(ctx)
      .select({ id: reportSchedules.id, nextRunAt: reportSchedules.nextRunAt, name: savedReports.name })
      .from(reportSchedules)
      .innerJoin(savedReports, eq(savedReports.id, reportSchedules.reportId))
      .where(and(eq(reportSchedules.workspaceId, ctx.actor.workspaceId), eq(reportSchedules.ownerMembershipId, membershipId), eq(reportSchedules.active, true)))
      .orderBy(desc(reportSchedules.nextRunAt));
    return rows.map((r) => ({ kind: 'reports.schedule_owner', entityType: 'report_schedule', entityId: r.id, title: `Scheduled report: ${r.name}`, projectId: null, dueAt: r.nextRunAt.toISOString(), requiresSuccessor: false }));
  },
  transfer: async (ctx, fromMembershipId, resolutions) => {
    for (const res of resolutions) {
      const [s] = await ctx.tx
        .select()
        .from(reportSchedules)
        .where(and(eq(reportSchedules.workspaceId, ctx.actor.workspaceId), eq(reportSchedules.id, res.entityId), eq(reportSchedules.ownerMembershipId, fromMembershipId)))
        .for('update');
      if (!s) continue;
      if (!res.successorMembershipId) {
        await ctx.tx.update(reportSchedules).set({ active: false, pausedReason: 'needs_owner', ...touch(ctx, reportSchedules) }).where(eq(reportSchedules.id, s.id));
        await audit(ctx, { action: 'report_schedule.paused_needs_owner', entityType: 'report_schedule', entityId: s.id, metadata: { previousOwner: fromMembershipId } });
        continue;
      }
      // The successor must be able to schedule reports and open this report.
      const [m] = await ctx.tx.select({ userId: memberships.userId, status: memberships.status }).from(memberships).where(and(eq(memberships.workspaceId, ctx.actor.workspaceId), eq(memberships.id, res.successorMembershipId)));
      const access = m?.status === 'active' ? await loadAccessSnapshot(ctx.app.db, ctx.actor.workspaceId, m.userId, ctx.app.clock.now()) : null;
      const [r] = await ctx.tx.select().from(savedReports).where(eq(savedReports.id, s.reportId));
      const canOpen = !!r && (r.ownerMembershipId === res.successorMembershipId || (r.sharing === 'shared' && r.sharedWithMembershipIds.includes(res.successorMembershipId)));
      if (!access || !hasAnywhere(access, 'reports.schedule') || !hasAnywhere(access, 'reports.read') || !canOpen)
        throw new AppError('VALIDATION_FAILED', 'The successor cannot take over this report schedule (needs report scheduling access and access to the report).', {
          fieldErrors: [{ field: `resolutions.${res.entityId}`, code: 'SUCCESSOR_NO_ACCESS', message: 'Choose a member who can open and schedule this report.' }],
        });
      await ctx.tx.update(reportSchedules).set({ ownerMembershipId: res.successorMembershipId, ...touch(ctx, reportSchedules) }).where(eq(reportSchedules.id, s.id));
      await audit(ctx, { action: 'report_schedule.owner_transferred', entityType: 'report_schedule', entityId: s.id, metadata: { from: fromMembershipId, to: res.successorMembershipId } });
    }
  },
});
