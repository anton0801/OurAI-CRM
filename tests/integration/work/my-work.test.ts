import { afterEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { myWorkEndpoints as MW, reminderEndpoints as RM, taskEndpoints as T, timeEndpoints as TM } from '@castlane/api-contracts';
import { enqueueJob, getAppServices } from '@castlane/application';
import { notifications, personalReminders, userPreferences } from '@castlane/database';
import { newId } from '@castlane/domain';
import { mutableClock, resetClock, runQueuedJobs } from '../../support';
import { db, getTask, member, newTask, transition, workFixture } from './helpers';

afterEach(() => resetClock());

const runReminders = async () => {
  await enqueueJob(getAppServices().db, { type: 'work.reminders', workspaceId: null, idempotencyKey: `test:${newId()}` });
  return runQueuedJobs(['work.reminders']);
};

const dueNotifications = (membershipId: string) =>
  db()
    .select()
    .from(notifications)
    .where(and(eq(notifications.recipientMembershipId, membershipId), eq(notifications.eventType, 'task.due_soon')));

describe('due reminders', () => {
  it('a rescheduled deadline makes the old reminder stale: it never sends (T143); snooze never changes the deadline', async () => {
    const f = await workFixture();
    const creator = await member(f, 'creator', { projects: [f.projectId] });
    const t0 = Date.now() + 1000;
    const clock = mutableClock(new Date(t0).toISOString());
    const due = new Date(t0 + 30 * 3_600_000);
    const t = await newTask(f.owner, f, { title: 'Publish trailer', assigneeMembershipId: creator.membershipId, due: { kind: 'datetime', at: due.toISOString() } });
    // Reschedule before the 24 h reminder fires: the first deadline revision becomes stale.
    const later = new Date(t0 + 80 * 3_600_000);
    await f.owner.call(T.update, { params: { ...f.params, taskId: t.id }, body: { due: { kind: 'datetime', at: later.toISOString() }, dueReason: 'Client moved the launch' } }, { ifMatch: t.rowVersion });
    // Time passes (sessions stay active) to 1 h before the *old* deadline: nothing is sent.
    const advance = async (hours: number) => {
      for (let h = hours; h > 0; h -= 6) {
        clock.advance(Math.min(6, h) * 60);
        await creator.client.call(MW.get, { params: f.params, query: {} });
        await f.owner.call(MW.get, { params: f.params, query: {} });
      }
    };
    await advance(29);
    await runReminders();
    expect(await dueNotifications(creator.membershipId)).toHaveLength(0);
    // 24 h before the new deadline the current revision reminds once, even when the job runs twice.
    await advance(32);
    await runReminders();
    await runReminders();
    const sent = await dueNotifications(creator.membershipId);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.eventKey).toBe(`task.due:${t.id}:r2:24h`);
    // The reminder shows in My Work; snoozing it moves only the reminder.
    const mw = await creator.client.call(MW.get, { params: f.params, query: {} });
    const reminder = mw.reminders.find((r) => r.entityId === t.id)!;
    expect(reminder.threshold).toBe('24h');
    const until = new Date(clock.now().getTime() + 2 * 3_600_000).toISOString();
    const snoozed = await creator.client.call(RM.snooze, { params: { ...f.params, reminderId: reminder.id }, body: { until } });
    expect(snoozed.snoozedUntil).toBe(until);
    expect((await getTask(f.owner, f, t.id)).due?.at).toBe(later.toISOString());
    // Someone else's reminder does not exist for another member.
    const foreign = await f.owner.attempt(RM.snooze, { params: { ...f.params, reminderId: reminder.id }, body: { until } });
    expect(foreign.status).toBe(404);
    // Completing the task cancels future reminders.
    const cur = await getTask(creator.client, f, t.id);
    const started = (await transition(creator.client, f, cur, 'in_progress')).data!;
    await transition(creator.client, f, started, 'done');
    const [row] = await db().select().from(personalReminders).where(eq(personalReminders.id, reminder.id));
    expect(row!.dismissedReason).toBe('completed');
  });

  it('a task created after the 24 h threshold gets only the nearest reminder', async () => {
    const f = await workFixture();
    const t0 = Date.now() + 1000;
    mutableClock(new Date(t0).toISOString());
    const t = await newTask(f.owner, f, { title: 'Late brief', assigneeMembershipId: f.ws.owner.membershipId, due: { kind: 'datetime', at: new Date(t0 + 30 * 60_000).toISOString() } });
    await runReminders();
    const rows = await db().select().from(notifications).where(and(eq(notifications.recipientMembershipId, f.ws.owner.membershipId), eq(notifications.entityId, t.id)));
    const due = rows.filter((r) => r.eventType === 'task.due_soon');
    expect(due.map((r) => r.eventKey)).toEqual([`task.due:${t.id}:r1:1h`]);
  });

  it('manual reminders fire once per effective time and require read access', async () => {
    const f = await workFixture();
    const t0 = Date.now() + 1000;
    const clock = mutableClock(new Date(t0).toISOString());
    const t = await newTask(f.owner, f, { title: 'Check captions' });
    const r = await f.owner.call(RM.create, { params: f.params, body: { entityType: 'task', entityId: t.id, remindAt: new Date(t0 + 60 * 60_000).toISOString(), note: 'Before lunch' } });
    const past = await f.owner.attempt(RM.create, { params: f.params, body: { entityType: 'task', entityId: t.id, remindAt: new Date(t0 - 60_000).toISOString() } });
    expect(past.status).toBe(422);
    clock.advance(61);
    await runReminders();
    await runReminders();
    const sent = await db().select().from(notifications).where(and(eq(notifications.recipientMembershipId, f.ws.owner.membershipId), eq(notifications.eventType, 'reminder.due')));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.eventKey).toContain(r.id);
    const outsider = await member(f, 'creator', { projects: [f.otherProjectId] });
    const hidden = await outsider.client.attempt(RM.create, { params: f.params, body: { entityType: 'task', entityId: t.id, remindAt: new Date(t0 + 3 * 3_600_000).toISOString() } });
    expect(hidden.status).toBe(404);
  });
});

describe('My Work (S09)', () => {
  it('sections use the personal time zone; unassigned tasks never appear in Assigned to Me; Following respects access', async () => {
    const f = await workFixture();
    const creator = await member(f, 'creator', { projects: [f.projectId] });
    await db().update(userPreferences).set({ timezone: 'Pacific/Auckland' }).where(eq(userPreferences.userId, creator.userId));
    const now = Date.now();
    const soon = await newTask(f.owner, f, { title: 'Due very soon', assigneeMembershipId: creator.membershipId, due: { kind: 'datetime', at: new Date(now + 60_000).toISOString() } });
    const nextWeek = await newTask(f.owner, f, { title: 'Due in 3 days', assigneeMembershipId: creator.membershipId, due: { kind: 'datetime', at: new Date(now + 3 * 86_400_000).toISOString() } });
    await newTask(f.owner, f, { title: 'Unassigned in project', followerMembershipIds: [creator.membershipId] });
    const hidden = await newTask(f.owner, f, { title: 'Other project, followed', projectId: f.otherProjectId, followerMembershipIds: [creator.membershipId] });
    const reviewing = await newTask(f.owner, f, { title: 'Please review', assigneeMembershipId: f.ws.owner.membershipId, reviewerMembershipId: creator.membershipId });
    const mw = await creator.client.call(MW.get, { params: f.params, query: {} });
    expect(mw.timezone).toBe('Pacific/Auckland');
    expect(mw.sections.assigned.items.map((i) => i.id).sort()).toEqual([soon.id, nextWeek.id].sort());
    expect(mw.sections.upcoming.items.map((i) => i.id)).toContain(nextWeek.id);
    expect(mw.sections.reviewing.items.map((i) => i.id)).toEqual([reviewing.id]);
    expect(mw.sections.following.items.map((i) => i.title)).toEqual(['Unassigned in project']);
    expect(mw.sections.following.items.some((i) => i.id === hidden.id)).toBe(false);
    expect(mw.sections.overdue.total).toBe(0);
  });

  it('shows the running timer from the server', async () => {
    const f = await workFixture();
    const t = await newTask(f.owner, f, { assigneeMembershipId: f.ws.owner.membershipId });
    await f.owner.call(TM.startTimer, { params: f.params, body: { taskId: t.id } });
    const mw = await f.owner.call(MW.get, { params: f.params, query: {} });
    expect(mw.timer?.task.id).toBe(t.id);
  });
});
