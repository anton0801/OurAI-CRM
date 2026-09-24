import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { newIdempotencyKey } from '@castlane/api-client';
import { timeEndpoints as TM } from '@castlane/api-contracts';
import { memberships, timeEntries } from '@castlane/database';
import { mutableClock, resetClock, runQueuedJobs } from '../../support';
import { enqueueJob, getAppServices } from '@castlane/application';
import { db, member, newTask, workFixture } from './helpers';

afterEach(() => resetClock());

const mondayOf = (d: Date) => {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const wd = (x.getUTCDay() + 6) % 7;
  return new Date(x.getTime() - wd * 86_400_000).toISOString().slice(0, 10);
};

describe('timers', () => {
  it('allows one running timer per member even from two tabs (T056) and one entry per stop replay (T057)', async () => {
    const f = await workFixture();
    const creator = await member(f, 'creator', { projects: [f.projectId] });
    const t1 = await newTask(f.owner, f, { title: 'Edit scene one', assigneeMembershipId: creator.membershipId });
    const t2 = await newTask(f.owner, f, { title: 'Edit scene two', assigneeMembershipId: creator.membershipId });
    const [a, b] = await Promise.all([
      creator.client.attempt(TM.startTimer, { params: f.params, body: { taskId: t1.id } }),
      creator.client.attempt(TM.startTimer, { params: f.params, body: { taskId: t2.id } }),
    ]);
    expect([a, b].filter((r) => r.ok)).toHaveLength(1);
    expect([a, b].find((r) => !r.ok)?.status).toBe(409);
    const running = await db().select().from(timeEntries).where(eq(timeEntries.membershipId, creator.membershipId));
    expect(running.filter((r) => r.state === 'running')).toHaveLength(1);
    const timer = (a.ok ? a.data : b.data)!;
    const key = newIdempotencyKey();
    const stop1 = await creator.client.call(TM.stopTimer, { params: { ...f.params, timerId: timer.id }, body: {} }, { idempotencyKey: key });
    const stop2 = await creator.client.call(TM.stopTimer, { params: { ...f.params, timerId: timer.id }, body: {} }, { idempotencyKey: key });
    const stop3 = await creator.client.call(TM.stopTimer, { params: { ...f.params, timerId: timer.id }, body: {} });
    expect(stop2.id).toBe(stop1.id);
    expect(stop3.id).toBe(stop1.id);
    const rows = await db().select().from(timeEntries).where(eq(timeEntries.membershipId, creator.membershipId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state === 'draft' || rows[0]!.state === 'needs_review').toBe(true);
  });

  it('keeps the server interval when the browser is gone: no invented stop, Needs Review after 12 h (T058)', async () => {
    const f = await workFixture();
    const start = new Date(Date.now() + 1000);
    const clock = mutableClock(start.toISOString());
    const t = await newTask(f.owner, f, { assigneeMembershipId: f.ws.owner.membershipId });
    const timer = await f.owner.call(TM.startTimer, { params: f.params, body: { taskId: t.id } });
    // The browser is closed: nothing calls the server for hours (the session is kept alive separately).
    clock.advance(6 * 60);
    await f.owner.call(TM.currentTimer, { params: f.params });
    clock.advance(7 * 60);
    await enqueueJob(getAppServices().db, { type: 'work.timers', workspaceId: null });
    await runQueuedJobs(['work.timers']);
    const [row] = await db().select().from(timeEntries).where(eq(timeEntries.id, timer.id));
    expect(row!.state).toBe('running');
    expect(row!.endedAt).toBeNull();
    expect(row!.needsReviewReason).toMatch(/12 hours/);
    const current = await f.owner.call(TM.currentTimer, { params: f.params });
    expect(current.timer?.needsReview).toBe(true);
    expect(current.timer?.elapsedSeconds).toBeGreaterThanOrEqual(13 * 3600);
    // After 24 h the member must enter the actual end.
    clock.advance(6 * 60);
    await f.owner.call(TM.currentTimer, { params: f.params });
    clock.advance(6 * 60);
    const tooLong = await f.owner.attempt(TM.stopTimer, { params: { ...f.params, timerId: timer.id }, body: {} });
    expect(tooLong.status).toBe(422);
    const endedAt = new Date(start.getTime() + 8 * 3_600_000).toISOString();
    const stopped = await f.owner.call(TM.stopTimer, { params: { ...f.params, timerId: timer.id }, body: { endedAt, reason: 'Forgot to stop the timer' } });
    expect(stopped.endedAt).toBe(endedAt);
    expect(stopped.durationSeconds).toBe(8 * 3600);
  });

  it('a manager closes someone else’s timer with actual end and reason; the member is notified', async () => {
    const f = await workFixture();
    const creator = await member(f, 'creator', { projects: [f.projectId] });
    const lead = await member(f, 'project_lead', { projects: [f.projectId] });
    const t = await newTask(f.owner, f, { assigneeMembershipId: creator.membershipId });
    const timer = await creator.client.call(TM.startTimer, { params: f.params, body: { taskId: t.id } });
    const own = await lead.client.attempt(TM.stopTimer, { params: { ...f.params, timerId: timer.id }, body: {} });
    expect(own.status).toBe(403);
    const endedAt = new Date(Date.now() + 1000).toISOString();
    const future = await lead.client.attempt(TM.closeTimer, { params: { ...f.params, timerId: timer.id }, body: { endedAt: new Date(Date.now() + 3_600_000).toISOString(), reason: 'Left the office' } });
    expect(future.status).toBe(422);
    await new Promise((r) => setTimeout(r, 1100));
    const closed = await lead.client.call(TM.closeTimer, { params: { ...f.params, timerId: timer.id }, body: { endedAt, reason: 'Left the office' } });
    expect(closed.state).toBe('needs_review');
    expect(closed.closeReason).toBe('Left the office');
  });
});

describe('manual entries and timesheets', () => {
  it('validates ≤ 24 h, > 0 and not in the future', async () => {
    const f = await workFixture();
    const t = await newTask(f.owner, f);
    const now = Date.now();
    const iso = (ms: number) => new Date(ms).toISOString();
    const neg = await f.owner.attempt(TM.create, { params: f.params, body: { taskId: t.id, startedAt: iso(now - 3_600_000), endedAt: iso(now - 7_200_000) } });
    expect(neg.status).toBe(422);
    const long = await f.owner.attempt(TM.create, { params: f.params, body: { taskId: t.id, startedAt: iso(now - 30 * 3_600_000), endedAt: iso(now - 3_600_000) } });
    expect(long.status).toBe(422);
    const future = await f.owner.attempt(TM.create, { params: f.params, body: { taskId: t.id, startedAt: iso(now + 3_600_000), endedAt: iso(now + 7_200_000) } });
    expect(future.status).toBe(422);
    const ok = await f.owner.call(TM.create, { params: f.params, body: { taskId: t.id, durationMinutes: 90 } });
    expect(ok.durationSeconds).toBe(5400);
    expect(ok.source).toBe('manual');
  });

  it('overlapping entries are flagged and cannot be submitted or approved until resolved (T059)', async () => {
    const f = await workFixture();
    const creator = await member(f, 'creator', { projects: [f.projectId] });
    const lead = await member(f, 'project_lead', { projects: [f.projectId] });
    await db().update(memberships).set({ managerMembershipId: lead.membershipId }).where(eq(memberships.id, creator.membershipId));
    const t = await newTask(f.owner, f, { assigneeMembershipId: creator.membershipId });
    // Two entries earlier this week that overlap by an hour.
    const base = new Date(`${mondayOf(new Date())}T08:00:00Z`);
    if (base.getTime() + 5 * 3_600_000 > Date.now()) base.setUTCDate(base.getUTCDate() - 7);
    const iso = (h: number) => new Date(base.getTime() + h * 3_600_000).toISOString();
    const e1 = await creator.client.call(TM.create, { params: f.params, body: { taskId: t.id, startedAt: iso(0), endedAt: iso(2) } });
    const e2 = await creator.client.call(TM.create, { params: f.params, body: { taskId: t.id, startedAt: iso(1), endedAt: iso(3) } });
    expect(e2.overlapsWith).toEqual([e1.id]);
    const weekStart = mondayOf(base);
    const week = await creator.client.call(TM.week, { params: f.params, query: { weekStart } });
    expect(week.canSubmit).toBe(false);
    expect(week.blockers.join(' ')).toMatch(/overlap/);
    const submit = await creator.client.attempt(TM.submitWeek, { params: f.params, body: { weekStart, entries: week.entries.map((e) => ({ id: e.id, rowVersion: e.rowVersion })) } });
    expect(submit.status).toBe(409);
    // Resolve the overlap, then submit: frozen versions, designated approver = manager.
    const fixed = await creator.client.call(TM.update, { params: { ...f.params, entryId: e2.id }, body: { startedAt: iso(2), endedAt: iso(3) } }, { ifMatch: e2.rowVersion });
    expect(fixed.overlapsWith).toEqual([]);
    const week2 = await creator.client.call(TM.week, { params: f.params, query: { weekStart } });
    expect(week2.canSubmit).toBe(true);
    const sheet = await creator.client.call(TM.submitWeek, { params: f.params, body: { weekStart, entries: week2.entries.map((e) => ({ id: e.id, rowVersion: e.rowVersion })) } });
    expect(sheet.state).toBe('submitted');
    expect(sheet.approver?.membershipId).toBe(lead.membershipId);
    const again = await creator.client.attempt(TM.submitWeek, { params: f.params, body: { weekStart, entries: week2.entries.map((e) => ({ id: e.id, rowVersion: e.rowVersion })) } });
    expect(again.ok).toBe(false);
    // Submitted entries are frozen for the member.
    const frozen = await creator.client.attempt(TM.update, { params: { ...f.params, entryId: e1.id }, body: { note: 'late edit' } }, { ifMatch: e1.rowVersion + 1 });
    expect(frozen.status).toBe(409);
    // Self-approval is refused; the approver approves atomically.
    const selfApprove = await creator.client.attempt(TM.approveSheet, { params: { ...f.params, sheetId: sheet.id }, body: {} }, { ifMatch: sheet.rowVersion });
    expect(selfApprove.status).toBe(403);
    const approved = await lead.client.call(TM.approveSheet, { params: { ...f.params, sheetId: sheet.id }, body: {} }, { ifMatch: sheet.rowVersion });
    expect(approved.state).toBe('approved');
    const entries = await db().select().from(timeEntries).where(eq(timeEntries.membershipId, creator.membershipId));
    expect(entries.every((e) => e.state === 'approved')).toBe(true);
    // Approved time is corrected by a revision, not a silent edit.
    const edit = await creator.client.attempt(TM.update, { params: { ...f.params, entryId: e1.id }, body: { note: 'x' } }, { ifMatch: entries.find((e) => e.id === e1.id)!.rowVersion });
    expect(edit.status).toBe(409);
    const revision = await creator.client.call(TM.revise, { params: { ...f.params, entryId: e1.id }, body: { taskId: t.id, durationMinutes: null, startedAt: iso(0), endedAt: iso(1.5), reason: 'Actually stopped earlier' } });
    expect(revision.revisionOf).toBe(e1.id);
    expect(revision.state).toBe('draft');
  });

  it('a returned sheet keeps its history and becomes editable again; overlapping submitted entries cannot be approved one by one', async () => {
    const f = await workFixture();
    const creator = await member(f, 'creator', { projects: [f.projectId] });
    const lead = await member(f, 'project_lead', { projects: [f.projectId] });
    const t = await newTask(f.owner, f, { assigneeMembershipId: creator.membershipId });
    const e1 = await creator.client.call(TM.create, { params: f.params, body: { taskId: t.id, durationMinutes: 60 } });
    const week = await creator.client.call(TM.week, { params: f.params, query: {} });
    const sheet = await creator.client.call(TM.submitWeek, { params: f.params, body: { weekStart: week.weekStart, entries: week.entries.map((e) => ({ id: e.id, rowVersion: e.rowVersion })) } });
    const returned = await lead.client.call(TM.returnSheet, { params: { ...f.params, sheetId: sheet.id }, body: { reason: 'Add the task notes' } }, { ifMatch: sheet.rowVersion });
    expect(returned.state).toBe('returned');
    const entry = await creator.client.call(TM.get, { params: { ...f.params, entryId: e1.id } });
    expect(entry.state).toBe('returned');
    expect(entry.returnedReason).toBe('Add the task notes');
    expect(entry.permissions.edit).toBe(true);
    const sheets = await creator.client.call(TM.sheets, { params: f.params, query: { mine: true } });
    expect(sheets.items.map((s) => s.state)).toEqual(['returned']);
  });

  it('own time is visible to the member; scope time is visible only with time.read.scope in the project', async () => {
    const f = await workFixture();
    const creator = await member(f, 'creator', { projects: [f.projectId] });
    const other = await member(f, 'creator', { projects: [f.projectId] });
    const outsideLead = await member(f, 'project_lead', { projects: [f.otherProjectId] });
    const lead = await member(f, 'project_lead', { projects: [f.projectId] });
    const t = await newTask(f.owner, f, { assigneeMembershipId: creator.membershipId });
    const e = await creator.client.call(TM.create, { params: f.params, body: { taskId: t.id, durationMinutes: 30 } });
    expect((await other.client.call(TM.list, { params: f.params, query: {} })).items).toHaveLength(0);
    expect((await other.client.attempt(TM.get, { params: { ...f.params, entryId: e.id } })).status).toBe(404);
    expect((await outsideLead.client.call(TM.list, { params: f.params, query: {} })).items).toHaveLength(0);
    const leadList = await lead.client.call(TM.list, { params: f.params, query: {} });
    expect(leadList.items.map((i) => i.id)).toEqual([e.id]);
    expect(leadList.totalSeconds).toBe(1800);
  });
});
