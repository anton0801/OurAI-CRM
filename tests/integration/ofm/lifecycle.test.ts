import { afterEach, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { newIdempotencyKey } from '@castlane/api-client';
import { ofmEndpoints as E } from '@castlane/api-contracts';
import { enqueueJob, getAppServices, runShiftMonitor } from '@castlane/application';
import { auditEvents, outboxEvents, shiftBreaks, shiftReports, shiftTimeCorrections, shifts } from '@castlane/database';
import { mutableClock, resetClock, runQueuedJobs } from '../../support';
import { HOUR, MIN, at, db, notificationsFor, ofmSetup } from './helpers';

afterEach(() => resetClock());

const clockAt = (iso: string, deltaMinutes = 0) => mutableClock(new Date(new Date(iso).getTime() + deltaMinutes * MIN).toISOString());

describe('Shift lifecycle (S43, §13.2)', () => {
  it('T088: starting from two tabs yields one actual start and one active shift', async () => {
    const s = await ofmSetup();
    const shift = await s.schedule(s.manager.membershipId, 1, 5);
    clockAt(shift.scheduledStart, -5);
    const params = { ...s.p, shiftId: shift.id };
    const [a, b] = await Promise.all([
      s.manager.client.attempt(E.startShift, { params, body: {} }, { idempotencyKey: newIdempotencyKey(), ifMatch: shift.rowVersion }),
      s.manager.client.attempt(E.startShift, { params, body: {} }, { idempotencyKey: newIdempotencyKey(), ifMatch: shift.rowVersion }),
    ]);
    const ok = [a, b].filter((r) => r.ok);
    expect(ok).toHaveLength(1);
    for (const r of [a, b]) if (!r.ok) expect([409, 412]).toContain(r.status);
    const rows = await db().select().from(shifts).where(and(eq(shifts.membershipId, s.manager.membershipId), inArray(shifts.state, ['active', 'paused'])));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actualStart).not.toBeNull();
    // A second shift of the same member cannot become active at the same time (DB uniqueness backs this).
    const later = await s.schedule(s.manager.membershipId, 6, 8);
    const early = await s.manager.client.attempt(E.startShift, { params: { ...s.p, shiftId: later.id }, body: {} }, { ifMatch: later.rowVersion });
    expect(early.status).toBe(409);
    const allowed = await s.supervisor.client.call(E.allowEarlyStart, { params: { ...s.p, shiftId: later.id }, body: { reason: 'Covering a gap' } }, { ifMatch: later.rowVersion });
    const second = await s.manager.client.attempt(E.startShift, { params: { ...s.p, shiftId: later.id }, body: {} }, { ifMatch: allowed.rowVersion });
    expect(second.status).toBe(409);
  });

  it('T089: pause/resume/end close every break exactly once and net hours exclude breaks', async () => {
    const s = await ofmSetup();
    const shift = await s.schedule(s.manager.membershipId, 1, 9);
    const clock = clockAt(shift.scheduledStart);
    const params = { ...s.p, shiftId: shift.id };
    let d = await s.manager.client.call(E.startShift, { params, body: {} }, { ifMatch: shift.rowVersion });
    expect(d.state).toBe('active');
    expect(d.lateMinutes).toBe(0);
    clock.advance(60);
    d = await s.manager.client.call(E.pauseShift, { params, body: { reason: 'Lunch' } }, { ifMatch: d.rowVersion });
    expect(d.state).toBe('paused');
    const wrong = await s.manager.client.attempt(E.resumeShift, { params, body: { breakId: shift.id } }, { ifMatch: d.rowVersion });
    expect(wrong.status).toBe(422);
    clock.advance(15);
    d = await s.manager.client.call(E.resumeShift, { params, body: { breakId: d.openBreakId! } }, { ifMatch: d.rowVersion });
    expect(d.openBreakId).toBeNull();
    clock.advance(60);
    d = await s.manager.client.call(E.pauseShift, { params, body: {} }, { ifMatch: d.rowVersion });
    clock.advance(10);
    // End while paused: the open break closes at the same instant as the actual end.
    d = await s.manager.client.call(E.endShift, { params, body: { endNote: 'Quiet evening' } }, { ifMatch: d.rowVersion });
    expect(d.state).toBe('ended');
    expect(d.netSeconds).toBe(120 * 60);
    const breaks = await db().select().from(shiftBreaks).where(eq(shiftBreaks.shiftId, shift.id));
    expect(breaks).toHaveLength(2);
    expect(breaks.every((b) => b.endedAt !== null)).toBe(true);
    const lastBreak = breaks.sort((x, y) => x.startedAt.getTime() - y.startedAt.getTime())[1]!;
    expect(lastBreak.endedAt!.toISOString()).toBe(d.actualEnd);
    // End opens the report draft (Ended / Report Pending).
    expect(d.reportState).toBe('draft');
    expect(d.report?.state).toBe('draft');
    const again = await s.manager.client.attempt(E.endShift, { params, body: {} }, { ifMatch: d.rowVersion });
    expect(again.status).toBe(409);
    // Supervisors cannot start/end somebody else's shift.
    const shift2 = await s.schedule(s.manager2.membershipId, 5, 7);
    clock.set(shift2.scheduledStart);
    const foreign = await s.supervisor.client.attempt(E.startShift, { params: { ...s.p, shiftId: shift2.id }, body: {} }, { ifMatch: shift2.rowVersion });
    expect(foreign.status).toBe(403);
  });

  it('T090: a forgotten End raises a supervisor alert and Needs Review without inventing an actual end', async () => {
    const s = await ofmSetup();
    const shift = await s.schedule(s.manager.membershipId, 1, 3);
    const idle = await s.schedule(s.manager2.membershipId, 1, 3);
    const clock = clockAt(shift.scheduledStart);
    await s.manager.client.call(E.startShift, { params: { ...s.p, shiftId: shift.id }, body: {} }, { ifMatch: shift.rowVersion });
    clock.set(new Date(new Date(shift.scheduledEnd).getTime() + 20 * MIN).toISOString());
    await runShiftMonitor(getAppServices());
    let [row] = await db().select().from(shifts).where(eq(shifts.id, shift.id));
    expect(row!.needsReviewReason).toBeNull();
    clock.advance(15);
    await enqueueJob(db(), { type: 'ofm.shift_monitor', workspaceId: null, idempotencyKey: `test:${shift.id}` });
    await runQueuedJobs(['ofm.shift_monitor']);
    [row] = await db().select().from(shifts).where(eq(shifts.id, shift.id));
    expect(row!.needsReviewReason).toBe('forgotten_end');
    expect(row!.forgotEndAlertedAt).not.toBeNull();
    expect(row!.actualEnd).toBeNull();
    expect(row!.state).toBe('active');
    const [idleRow] = await db().select().from(shifts).where(eq(shifts.id, idle.id));
    expect(idleRow!.needsReviewReason).toBe('not_started');
    expect(idleRow!.state).toBe('scheduled');
    await runShiftMonitor(getAppServices());
    const supNotes = (await notificationsFor(s.ws.workspaceId, s.supervisor.membershipId)).filter((n) => n.eventKey === `shift.forgotten_end:${shift.id}`);
    expect(supNotes).toHaveLength(1);
    const detail = await s.supervisor.client.call(E.getShift, { params: { ...s.p, shiftId: shift.id } });
    expect(detail.needsReview).toBe('forgotten_end');
    expect(detail.netSeconds).toBeNull();
    // The supervisor confirms Missed for the never-started shift.
    const missed = await s.supervisor.client.call(E.markMissed, { params: { ...s.p, shiftId: idle.id }, body: { reason: 'No show' } }, { ifMatch: idleRow!.rowVersion });
    expect(missed.state).toBe('missed');
  });

  it('T091: supervisor time correction needs a reason, is audited and flags compensation sources', async () => {
    const s = await ofmSetup();
    const shift = await s.schedule(s.manager.membershipId, 1, 5);
    const clock = clockAt(shift.scheduledStart, 5);
    const params = { ...s.p, shiftId: shift.id };
    let d = await s.manager.client.call(E.startShift, { params, body: {} }, { ifMatch: shift.rowVersion });
    expect(d.lateMinutes).toBe(5);
    clock.advance(4 * 60);
    d = await s.manager.client.call(E.endShift, { params, body: {} }, { ifMatch: d.rowVersion });
    const own = await s.manager.client.attempt(E.correctTime, { params, body: { actualStart: shift.scheduledStart, reason: 'Started on time' } }, { ifMatch: d.rowVersion });
    expect(own.status).toBe(403);
    const noReason = await s.supervisor.client.attempt(E.correctTime, { params, body: { actualStart: shift.scheduledStart, reason: '' } }, { ifMatch: d.rowVersion });
    expect(noReason.status).toBe(422);
    const corrected = await s.supervisor.client.call(
      E.correctTime,
      { params, body: { actualStart: shift.scheduledStart, breaks: [{ startedAt: new Date(new Date(shift.scheduledStart).getTime() + HOUR).toISOString(), endedAt: new Date(new Date(shift.scheduledStart).getTime() + HOUR + 30 * MIN).toISOString() }], reason: 'Clocked in late by mistake; 30 min lunch not recorded' } },
      { ifMatch: d.rowVersion },
    );
    expect(corrected.correctedAt).not.toBeNull();
    expect(corrected.netSeconds).toBe(4 * 3600 + 5 * 60 - 30 * 60);
    expect(corrected.corrections).toHaveLength(1);
    const corrections = await db().select().from(shiftTimeCorrections).where(eq(shiftTimeCorrections.shiftId, shift.id));
    expect(corrections[0]!.reason).toMatch(/lunch/);
    expect((corrections[0]!.before as { actualStart: string }).actualStart).toBe(d.actualStart);
    const audit = await db().select().from(auditEvents).where(and(eq(auditEvents.entityId, shift.id), eq(auditEvents.action, 'shift.time_corrected')));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.reason).toMatch(/lunch/);
    const events = await db().select().from(outboxEvents).where(and(eq(outboxEvents.entityId, shift.id), eq(outboxEvents.eventType, 'shift.time_corrected')));
    expect(events[0]!.payload).toMatchObject({ compensationSourceInvalidated: true });
    // Overlapping breaks are rejected.
    const bad = await s.supervisor.client.attempt(
      E.correctTime,
      {
        params,
        body: {
          breaks: [
            { startedAt: new Date(new Date(shift.scheduledStart).getTime() + HOUR).toISOString(), endedAt: new Date(new Date(shift.scheduledStart).getTime() + 2 * HOUR).toISOString() },
            { startedAt: new Date(new Date(shift.scheduledStart).getTime() + 90 * MIN).toISOString(), endedAt: new Date(new Date(shift.scheduledStart).getTime() + 3 * HOUR).toISOString() },
          ],
          reason: 'Test overlap',
        },
      },
      { ifMatch: corrected.rowVersion },
    );
    expect(bad.status).toBe(422);
  });

  it('forced end by a supervisor records the correction and opens the report draft', async () => {
    const s = await ofmSetup();
    const shift = await s.schedule(s.manager.membershipId, 1, 3);
    const clock = clockAt(shift.scheduledStart);
    const d = await s.manager.client.call(E.startShift, { params: { ...s.p, shiftId: shift.id }, body: {} }, { ifMatch: shift.rowVersion });
    clock.advance(5 * 60);
    const forced = await s.supervisor.client.call(
      E.correctTime,
      { params: { ...s.p, shiftId: shift.id }, body: { actualEnd: shift.scheduledEnd, reason: 'Member confirmed they stopped at the scheduled end' } },
      { ifMatch: d.rowVersion },
    );
    expect(forced.state).toBe('ended');
    expect(forced.actualEnd).toBe(shift.scheduledEnd);
    const [report] = await db().select().from(shiftReports).where(eq(shiftReports.shiftId, shift.id));
    expect(report!.state).toBe('draft');
    const audit = await db().select().from(auditEvents).where(and(eq(auditEvents.entityId, shift.id), eq(auditEvents.action, 'shift.force_ended')));
    expect(audit[0]!.actorMembershipId).toBe(s.supervisor.membershipId);
    void at;
  });

  it('cancelling an active shift is refused (End with Aborted instead)', async () => {
    const s = await ofmSetup();
    const shift = await s.schedule(s.manager.membershipId, 1, 3);
    clockAt(shift.scheduledStart);
    const d = await s.manager.client.call(E.startShift, { params: { ...s.p, shiftId: shift.id }, body: {} }, { ifMatch: shift.rowVersion });
    const cancel = await s.supervisor.client.attempt(E.cancelShift, { params: { ...s.p, shiftId: shift.id }, body: { reason: 'Stop now' } }, { ifMatch: d.rowVersion });
    expect(cancel.status).toBe(409);
    const noReason = await s.manager.client.attempt(E.endShift, { params: { ...s.p, shiftId: shift.id }, body: { aborted: true } }, { ifMatch: d.rowVersion });
    expect(noReason.status).toBe(422);
    const aborted = await s.manager.client.call(E.endShift, { params: { ...s.p, shiftId: shift.id }, body: { aborted: true, abortReason: 'Platform outage' } }, { ifMatch: d.rowVersion });
    expect(aborted.aborted).toBe(true);
    expect(aborted.endNote).toContain('Platform outage');
  });
});
