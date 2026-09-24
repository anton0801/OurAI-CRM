import { and, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import { handovers, ofmProfiles, shifts } from '@castlane/database';
import { SHIFT_LIMITS } from '@castlane/domain';
import { audit } from '../core/audit';
import { executeSystemCommand } from '../core/command';
import type { AppServices, CommandContext } from '../core/context';
import { emit } from '../core/events';
import { defineJob, defineSchedule, systemJobContext } from '../core/jobs-registry';
import { notify } from '../core/notify';
import { applyContactRetention, executeContactErasure } from './contacts';

/**
 * OFM background work. The shift monitor never invents an actual end (T090): a forgotten End only
 * raises a supervisor alert and a Needs Review flag; a shift that was never started is flagged for the
 * supervisor to confirm as Missed. Reminders use deterministic keys (a rescheduled start is a new key).
 */

const HANDOVER_ACK_ALERT_HOURS = 12;

const supervisorsOf = async (ctx: CommandContext, rows: { projectId: string; supervisorMembershipId: string | null }[]) => {
  const missing = [...new Set(rows.filter((r) => !r.supervisorMembershipId).map((r) => r.projectId))];
  const profiles = missing.length ? await ctx.tx.select().from(ofmProfiles).where(inArray(ofmProfiles.projectId, missing)) : [];
  return (r: { projectId: string; supervisorMembershipId: string | null }) => r.supervisorMembershipId ?? profiles.find((p) => p.projectId === r.projectId)?.supervisorMembershipId ?? null;
};

const monitorWorkspace = async (ctx: CommandContext) => {
  const ws = ctx.actor.workspaceId;
  const now = ctx.app.clock.now();
  const grace = new Date(now.getTime() - SHIFT_LIMITS.forgottenEndGraceMinutes * 60_000);
  const counts = { forgottenEnd: 0, notStarted: 0, reminders: 0, unacknowledgedHandovers: 0 };

  const forgotten = await ctx.tx
    .update(shifts)
    .set({ forgotEndAlertedAt: now, needsReviewReason: 'forgotten_end', rowVersion: sql`${shifts.rowVersion} + 1`, updatedAt: now })
    .where(and(eq(shifts.workspaceId, ws), inArray(shifts.state, ['active', 'paused']), lt(shifts.scheduledEnd, grace), isNull(shifts.forgotEndAlertedAt)))
    .returning();
  const supervisorOf = await supervisorsOf(ctx, forgotten);
  for (const s of forgotten) {
    counts.forgottenEnd++;
    await audit(ctx, { action: 'shift.forgotten_end_flagged', entityType: 'shift', entityId: s.id, projectId: s.projectId, metadata: { scheduledEnd: s.scheduledEnd.toISOString() } });
    await emit(ctx, { type: 'shift.forgotten_end', entityType: 'shift', entityId: s.id, revision: s.rowVersion });
    const base = { workspaceId: ws, entityType: 'shift', entityId: s.id, projectId: s.projectId, at: now, excludeActor: false } as const;
    await notify(ctx.tx, { ...base, recipientMembershipIds: [supervisorOf(s) ?? ''], eventType: 'shift.forgotten_end', eventKey: `shift.forgotten_end:${s.id}`, kind: 'general', title: 'A shift was not ended — review needed' });
    await notify(ctx.tx, { ...base, recipientMembershipIds: [s.membershipId], eventType: 'shift.forgotten_end', eventKey: `shift.forgotten_end:${s.id}`, kind: 'due_reminder', title: 'Your shift is still running — end it or ask your supervisor to correct it' });
  }

  const notStarted = await ctx.tx
    .update(shifts)
    .set({ needsReviewReason: 'not_started', rowVersion: sql`${shifts.rowVersion} + 1`, updatedAt: now })
    .where(and(eq(shifts.workspaceId, ws), eq(shifts.state, 'scheduled'), lt(shifts.scheduledEnd, now), isNull(shifts.needsReviewReason)))
    .returning();
  const supervisorOf2 = await supervisorsOf(ctx, notStarted);
  for (const s of notStarted) {
    counts.notStarted++;
    await audit(ctx, { action: 'shift.not_started_flagged', entityType: 'shift', entityId: s.id, projectId: s.projectId });
    await emit(ctx, { type: 'shift.not_started', entityType: 'shift', entityId: s.id, revision: s.rowVersion });
    await notify(ctx.tx, {
      workspaceId: ws,
      recipientMembershipIds: [supervisorOf2(s) ?? ''],
      eventType: 'shift.not_started',
      eventKey: `shift.not_started:${s.id}`,
      kind: 'general',
      title: 'A scheduled shift was not started — confirm Missed or reschedule',
      entityType: 'shift',
      entityId: s.id,
      projectId: s.projectId,
      at: now,
    });
  }

  const soon = await ctx.tx
    .select()
    .from(shifts)
    .where(and(eq(shifts.workspaceId, ws), eq(shifts.state, 'scheduled'), gte(shifts.scheduledStart, now), lt(shifts.scheduledStart, new Date(now.getTime() + SHIFT_LIMITS.reminderMinutesBefore * 60_000))));
  for (const s of soon)
    counts.reminders += await notify(ctx.tx, {
      workspaceId: ws,
      recipientMembershipIds: [s.membershipId],
      eventType: 'shift.reminder',
      eventKey: `shift.reminder:${s.id}:${s.scheduledStart.toISOString()}`,
      kind: 'due_reminder',
      title: 'Your shift starts in 30 minutes',
      entityType: 'shift',
      entityId: s.id,
      projectId: s.projectId,
      at: now,
    });

  const stale = await ctx.tx
    .select({ h: handovers, projectId: shifts.projectId, supervisorMembershipId: shifts.supervisorMembershipId })
    .from(handovers)
    .innerJoin(shifts, eq(shifts.id, handovers.fromShiftId))
    .where(and(eq(handovers.workspaceId, ws), eq(handovers.state, 'submitted'), lt(handovers.submittedAt, new Date(now.getTime() - HANDOVER_ACK_ALERT_HOURS * 3_600_000))));
  const supervisorOf3 = await supervisorsOf(ctx, stale);
  for (const r of stale) {
    const sent = await notify(ctx.tx, {
      workspaceId: ws,
      recipientMembershipIds: [supervisorOf3(r) ?? ''],
      eventType: 'handover.unacknowledged',
      eventKey: `handover.unacknowledged:${r.h.id}`,
      kind: 'general',
      title: 'A handover is still not acknowledged',
      entityType: 'handover',
      entityId: r.h.id,
      projectId: r.projectId,
      at: now,
    });
    if (sent) {
      counts.unacknowledgedHandovers++;
      await emit(ctx, { type: 'handover.unacknowledged', entityType: 'handover', entityId: r.h.id });
    }
  }
  return counts;
};

/** One pass over every workspace with due OFM checks (idempotent: flags and notification keys dedupe). */
export const runShiftMonitor = async (app: AppServices) => {
  const now = app.clock.now();
  const grace = new Date(now.getTime() - SHIFT_LIMITS.forgottenEndGraceMinutes * 60_000);
  const soon = new Date(now.getTime() + SHIFT_LIMITS.reminderMinutesBefore * 60_000);
  const rows = await app.db.execute<{ workspace_id: string }>(sql`
    SELECT DISTINCT workspace_id FROM shifts
    WHERE (state IN ('active', 'paused') AND scheduled_end < ${grace} AND forgot_end_alerted_at IS NULL)
       OR (state = 'scheduled' AND scheduled_end < ${now} AND needs_review_reason IS NULL)
       OR (state = 'scheduled' AND scheduled_start >= ${now} AND scheduled_start < ${soon})
    UNION
    SELECT DISTINCT workspace_id FROM handovers WHERE state = 'submitted' AND submitted_at < ${new Date(now.getTime() - HANDOVER_ACK_ALERT_HOURS * 3_600_000)}`);
  const result: Record<string, unknown> = {};
  for (const r of rows.rows) {
    const ctx = await systemJobContext(app, r.workspace_id, ['shifts.read.scope']);
    result[r.workspace_id] = await executeSystemCommand(ctx, monitorWorkspace);
  }
  return { workspaces: rows.rows.length };
};

defineJob('ofm.shift_monitor', 'light', async ({ app }) => runShiftMonitor(app));
defineSchedule({ name: 'ofm.shift_monitor', everySeconds: 300, jobType: 'ofm.shift_monitor' });

defineJob('ofm.contact_erasure', 'data', async ({ app, job }) => {
  if (!job.workspaceId) return { skipped: true };
  const ctx = await systemJobContext(app, job.workspaceId, ['contacts.erase']);
  const result = await executeSystemCommand(ctx, (c) => executeContactErasure(c, String(job.payload.requestId)));
  return { requestId: job.payload.requestId, result };
});

export const runContactRetention = async (app: AppServices) => {
  const rows = await app.db.execute<{ workspace_id: string }>(sql`SELECT DISTINCT workspace_id FROM ofm_contacts WHERE archived_at IS NOT NULL`);
  let contacts = 0;
  for (const r of rows.rows) {
    const ctx = await systemJobContext(app, r.workspace_id, ['contacts.erase']);
    contacts += (await executeSystemCommand(ctx, applyContactRetention)).contacts;
  }
  return { workspaces: rows.rows.length, contacts };
};

defineJob('ofm.contact_retention', 'data', async ({ app }) => runContactRetention(app));
defineSchedule({ name: 'ofm.contact_retention', everySeconds: 86_400, jobType: 'ofm.contact_retention', pool: 'data' });
