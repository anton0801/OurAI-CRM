import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { taskEndpoints as T, workloadEndpoints as W } from '@castlane/api-contracts';
import { memberships, workspaces } from '@castlane/database';
import { db, member, newTask, workFixture } from './helpers';

/** Monday of next week (UTC dates; the workspace zone is set to UTC in these tests). */
const nextMonday = () => {
  const d = new Date();
  const wd = (d.getUTCDay() + 6) % 7;
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) + (7 - wd) * 86_400_000);
  return monday.toISOString().slice(0, 10);
};
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

describe('workload (S29)', () => {
  it('unestimated tasks are an explicit unknown count, never zero hours; capacity is unknown until confirmed (T060)', async () => {
    const f = await workFixture();
    await db().update(workspaces).set({ timezone: 'UTC' }).where(eq(workspaces.id, f.ws.workspaceId));
    const creator = await member(f, 'creator', { projects: [f.projectId], name: 'Casey Creator' });
    const monday = nextMonday();
    await newTask(f.owner, f, { title: 'Estimated', assigneeMembershipId: creator.membershipId, estimateMinutes: 600, startAt: `${monday}T00:00:00Z`, due: { kind: 'date', date: addDays(monday, 4), timezone: 'UTC' } });
    await newTask(f.owner, f, { title: 'No estimate', assigneeMembershipId: creator.membershipId, due: { kind: 'date', date: addDays(monday, 2), timezone: 'UTC' } });
    const before = await f.owner.call(W.get, { params: f.params, query: { from: monday, period: 'week', membershipIds: [creator.membershipId] } });
    const m = before.members[0]!;
    expect(m.unestimatedCount).toBe(1);
    expect(m.plannedMinutes).toBe(600);
    expect(m.capacityCoverage).toBe('none');
    expect(m.capacityMinutes).toBeNull();
    expect(m.overloadMinutes).toBeNull();
    expect(m.tasks.find((t) => t.title === 'No estimate')!.method).toBe('unestimated');
    expect(m.tasks.find((t) => t.title === 'No estimate')!.remainingMinutes).toBeNull();
    // Confirm 8 h Mon–Fri and record one day of approved leave: available 32 h, the estimate spreads over 4 days.
    const cap = await f.owner.call(W.setCapacity, {
      params: f.params,
      body: { membershipId: creator.membershipId, effectiveFrom: addDays(monday, -7), weekdayMinutes: { monday: 480, tuesday: 480, wednesday: 480, thursday: 480, friday: 480, saturday: 0, sunday: 0 } },
    });
    expect(cap.weeklyMinutes).toBe(2400);
    const leave = await f.owner.call(W.createAbsence, { params: f.params, body: { membershipId: creator.membershipId, startDate: addDays(monday, 1), endDate: addDays(monday, 1), category: 'personal', privateReason: 'Family matter' } });
    expect(leave.state).toBe('approved');
    expect(leave.affected.tasksDue).toBe(0);
    const after = await f.owner.call(W.get, { params: f.params, query: { from: monday, period: 'week', membershipIds: [creator.membershipId] } });
    const a = after.members[0]!;
    expect(a.capacityMinutes).toBe(2400);
    expect(a.availableMinutes).toBe(1920);
    expect(a.days.find((d) => d.date === addDays(monday, 1))!.plannedMinutes).toBe(0);
    expect(a.days.filter((d) => d.plannedMinutes > 0)).toHaveLength(4);
    expect(a.plannedMinutes).toBe(600);
    expect(a.overloadMinutes).toBe(0);
    expect(a.unestimatedCount).toBe(1);
    expect(after.algorithm).toMatch(/never treated as zero hours/);
  });

  it('members see their own leave reason; colleagues without workload rights do not; requests need a manager', async () => {
    const f = await workFixture();
    const creator = await member(f, 'creator', { projects: [f.projectId] });
    const colleague = await member(f, 'creator', { projects: [f.projectId] });
    const lead = await member(f, 'direction_lead', { scopeType: 'direction' });
    await db().update(memberships).set({ managerMembershipId: lead.membershipId }).where(eq(memberships.id, creator.membershipId));
    const monday = nextMonday();
    const req = await creator.client.call(W.createAbsence, { params: f.params, body: { membershipId: creator.membershipId, startDate: monday, endDate: addDays(monday, 2), category: 'vacation', privateReason: 'Wedding' } });
    expect(req.state).toBe('requested');
    expect(req.privateReason).toBe('Wedding');
    const overlap = await creator.client.attempt(W.createAbsence, { params: f.params, body: { membershipId: creator.membershipId, startDate: addDays(monday, 1), endDate: addDays(monday, 3), category: 'vacation' } });
    expect(overlap.status).toBe(409);
    const forOther = await colleague.client.attempt(W.createAbsence, { params: f.params, body: { membershipId: creator.membershipId, startDate: addDays(monday, 5), endDate: addDays(monday, 5), category: 'sick' } });
    expect(forOther.status).toBe(403);
    expect(await colleague.client.call(W.absences, { params: f.params, query: {} })).toEqual([]);
    const selfApprove = await creator.client.attempt(W.decideAbsence, { params: { ...f.params, absenceId: req.id }, body: { decision: 'approve' } }, { ifMatch: req.rowVersion });
    expect(selfApprove.status).toBe(403);
    const approved = await f.owner.call(W.decideAbsence, { params: { ...f.params, absenceId: req.id }, body: { decision: 'approve' } }, { ifMatch: req.rowVersion });
    expect(approved.state).toBe('approved');
  });

  it('reassign preview shows both members’ planned load; a stale reassignment is a version conflict', async () => {
    const f = await workFixture();
    await db().update(workspaces).set({ timezone: 'UTC' }).where(eq(workspaces.id, f.ws.workspaceId));
    const a = await member(f, 'creator', { projects: [f.projectId] });
    const b = await member(f, 'creator', { projects: [f.projectId] });
    const outsider = await member(f, 'creator', { projects: [f.otherProjectId] });
    const monday = nextMonday();
    const t = await newTask(f.owner, f, { title: 'Big edit', assigneeMembershipId: a.membershipId, estimateMinutes: 300, startAt: `${monday}T00:00:00Z`, due: { kind: 'date', date: addDays(monday, 4), timezone: 'UTC' } });
    const preview = await f.owner.call(W.reassignPreview, { params: f.params, body: { taskId: t.id, toMembershipId: b.membershipId, from: monday, period: 'week' } });
    expect(preview.from?.plannedBefore).toBe(300);
    expect(preview.from?.plannedAfter).toBe(0);
    expect(preview.to.plannedBefore).toBe(0);
    expect(preview.to.plannedAfter).toBe(300);
    expect(preview.to.canAccessTask).toBe(true);
    const noAccess = await f.owner.call(W.reassignPreview, { params: f.params, body: { taskId: t.id, toMembershipId: outsider.membershipId, from: monday, period: 'week' } });
    expect(noAccess.to.canAccessTask).toBe(false);
    await f.owner.call(T.update, { params: { ...f.params, taskId: t.id }, body: { estimateMinutes: 360 } }, { ifMatch: preview.task.rowVersion });
    const stale = await f.owner.attempt(T.update, { params: { ...f.params, taskId: t.id }, body: { assigneeMembershipId: b.membershipId } }, { ifMatch: preview.task.rowVersion });
    expect(stale.status).toBe(412);
  });

  it('workload is scoped: members and tasks outside the viewer’s projects are not summed', async () => {
    const f = await workFixture();
    const creator = await member(f, 'creator', { projects: [f.projectId, f.otherProjectId] });
    const lead = await member(f, 'project_lead', { projects: [f.projectId] });
    const monday = nextMonday();
    await newTask(f.owner, f, { title: 'Visible', assigneeMembershipId: creator.membershipId, estimateMinutes: 120, due: { kind: 'date', date: addDays(monday, 1), timezone: 'UTC' } });
    await newTask(f.owner, f, { title: 'Invisible', projectId: f.otherProjectId, assigneeMembershipId: creator.membershipId, estimateMinutes: 600, due: { kind: 'date', date: addDays(monday, 1), timezone: 'UTC' } });
    const w = await lead.client.call(W.get, { params: f.params, query: { from: monday, period: 'week' } });
    const m = w.members.find((x) => x.member.membershipId === creator.membershipId)!;
    expect(m.tasks.map((t) => t.title)).toEqual(['Visible']);
    const viewer = await member(f, 'finance_manager');
    expect((await viewer.client.attempt(W.get, { params: f.params, query: {} })).status).toBe(403);
  });
});
