import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { calendarEndpoints as CAL, planBaselineEndpoints as B, publicationEndpoints as P } from '@castlane/api-contracts';
import { planBaselineItems, planBaselines, projectMilestones, shifts, tasks } from '@castlane/database';
import { getAppServices, runPlanFreeze } from '@castlane/application';
import { newId } from '@castlane/domain';
import { resetClock, setClock } from '../../support';
import { at, db, insertContent, memberClient, publish, scheduled, setup } from './support';

afterEach(() => resetClock());

describe('plan baselines', () => {
  it('keeps the original weekly row when a placement moves out of the frozen week; Current Plan is separate (T067)', async () => {
    const f = await setup();
    // Monday 08:00 Berlin: plan the week, then the Monday freeze runs.
    const a = await scheduled(f.owner, f, { scheduledAt: at(50) }); // Wednesday
    const c2 = await insertContent(f.ws, f.project.id, { title: 'Thursday carousel' });
    const b = await scheduled(f.owner, f, { contentItemId: c2.id, contentVersionId: c2.approvedVersionId!, scheduledAt: at(74) });
    expect(await runPlanFreeze(getAppServices())).toMatchObject({ frozen: expect.any(Number) });
    const [baseline] = await db().select().from(planBaselines).where(eq(planBaselines.workspaceId, f.ws.workspaceId));
    expect(baseline!.weekStart).toBe('2030-06-03');
    // Idempotent freeze.
    await runPlanFreeze(getAppServices());
    expect(await db().select().from(planBaselines).where(eq(planBaselines.workspaceId, f.ws.workspaceId))).toHaveLength(1);
    // Move A into next week, add C to this week after the freeze, cancel B.
    const moved = await f.owner.call(P.schedule, { params: { ...f.W, publicationId: a.id }, body: { scheduledAt: at(7 * 24 + 26), timezone: 'Europe/Berlin', reason: 'Moved to next week' } }, { ifMatch: a.rowVersion });
    expect(moved.scheduledAt).toBe(at(7 * 24 + 26));
    const c3 = await insertContent(f.ws, f.project.id, { title: 'Friday add-on' });
    const late = await scheduled(f.owner, f, { contentItemId: c3.id, contentVersionId: c3.approvedVersionId!, scheduledAt: at(98) });
    await f.owner.call(P.cancel, { params: { ...f.W, publicationId: b.id }, body: { reason: 'Partner withdrew the product' } }, { ifMatch: b.rowVersion });
    const week = await f.owner.call(B.week, { params: f.W, query: { weekStart: '2030-06-05' } });
    expect(week.weekStart).toBe('2030-06-03');
    expect(week.baseline?.id).toBe(baseline!.id);
    const byId = new Map(week.original.map((i) => [i.publicationId, i]));
    expect(byId.get(a.id)).toMatchObject({ baselineScheduledAt: at(50), currentScheduledAt: at(7 * 24 + 26), movedOutOfWeek: true, addedAfterBaseline: false });
    expect(byId.get(b.id)).toMatchObject({ baselineScheduledAt: at(74), removalReason: 'Partner withdrew the product', status: 'cancelled' });
    expect(byId.get(late.id)).toMatchObject({ addedAfterBaseline: true, baselineScheduledAt: null });
    // Current Plan: only placements whose current time is in the week (A left, B cancelled).
    expect(week.current.map((p) => p.id)).toEqual([late.id]);
    // Next week's current plan contains A; its (not yet frozen) baseline is empty.
    const next = await f.owner.call(B.week, { params: f.W, query: { weekStart: '2030-06-10' } });
    expect(next.baseline).toBeNull();
    expect(next.current.map((p) => p.id)).toEqual([a.id]);
    // M09 fact: published after its baseline time + grace is not on time against the baseline.
    const items = await db().select().from(planBaselineItems).where(eq(planBaselineItems.baselineId, baseline!.id));
    expect(items).toHaveLength(3);
  });

  it('marks placements published on plan against the frozen time; manual freeze only for the current week', async () => {
    const f = await setup();
    const early = await f.owner.call(B.week, { params: f.W, query: { weekStart: '2030-06-03' } });
    expect(early.baseline).toBeNull();
    expect(early.canFreeze).toBe(true);
    const p = await scheduled(f.owner, f, { scheduledAt: at(1) });
    const frozen = await f.owner.call(B.freeze, { params: f.W, body: { weekStart: '2030-06-03' } });
    expect(frozen.baseline).not.toBeNull();
    expect(frozen.original.map((i) => i.publicationId)).toEqual([p.id]);
    const again = await f.owner.call(B.freeze, { params: f.W, body: { weekStart: '2030-06-03' } });
    expect(again.baseline!.id).toBe(frozen.baseline!.id);
    expect((await f.owner.attempt(B.freeze, { params: f.W, body: { weekStart: '2030-05-27' } })).status).toBe(409);
    setClock(at(1.1));
    const owner = await (await import('./support')).clientAt(f.ws.owner.userId);
    await publish(owner, f, p, { actualPublishedAt: at(1.1), externalUrl: 'https://www.instagram.com/p/ONTIME/' });
    const week = await owner.call(B.week, { params: f.W, query: { weekStart: '2030-06-03' } });
    expect(week.original[0]!.onTimeAgainstBaseline).toBe(true);
    // Publishers cannot freeze plans.
    const publisher = await memberClient(f.ws, 'publisher', { accounts: [f.accountId] });
    expect((await publisher.client.attempt(B.freeze, { params: f.W, body: { weekStart: '2030-06-03' } })).status).toBe(403);
  });
});

describe('calendar', () => {
  it('combines scoped layers, flags 15-minute conflicts and never exposes other projects', async () => {
    const f = await setup();
    const a = await scheduled(f.owner, f, { scheduledAt: at(26) });
    const c2 = await insertContent(f.ws, f.project.id, { title: 'Clash' });
    const b = await f.owner.call(P.create, {
      params: f.W,
      body: { contentItemId: c2.id, contentVersionId: c2.approvedVersionId!, accountId: f.accountId, ownerMembershipId: f.ws.owner.membershipId, scheduledAt: at(26.05), timezone: 'Europe/Berlin', schedule: true, conflictOverrideReason: 'Both are needed' },
    });
    const otherContent = await insertContent(f.ws, f.other.id, { title: 'Nova teaser' });
    const theirs = await scheduled(f.owner, f, { accountId: f.otherAccountId, contentItemId: otherContent.id, contentVersionId: otherContent.approvedVersionId! });
    const now = new Date();
    await db().insert(projectMilestones).values({ id: newId(), workspaceId: f.ws.workspaceId, projectId: f.project.id, title: 'Season launch', dueDate: '2030-06-05', createdAt: now, updatedAt: now });
    await db().insert(tasks).values({ id: newId(), workspaceId: f.ws.workspaceId, projectId: f.project.id, title: 'Edit teaser', status: 'ready', dueAt: new Date(at(30)), createdAt: now, updatedAt: now });
    await db().insert(shifts).values({
      id: newId(),
      workspaceId: f.ws.workspaceId,
      projectId: f.project.id,
      primaryAccountId: f.accountId,
      membershipId: f.ws.owner.membershipId,
      scheduledStart: new Date(at(8)),
      scheduledEnd: new Date(at(12)),
      timezone: 'Europe/Berlin',
      createdAt: now,
      updatedAt: now,
    });
    const q = { from: at(-6), to: at(7 * 24) };
    const all = await f.owner.call(CAL.get, { params: f.W, query: q });
    expect(all.layers).toEqual({ publications: true, tasks: true, milestones: true, shifts: true });
    const byKey = new Map(all.events.map((e) => [e.key, e]));
    expect(byKey.get(`publication:${a.id}`)).toMatchObject({ conflict: true, canReschedule: true, status: 'scheduled', timezone: 'Europe/Berlin' });
    expect(byKey.get(`publication:${b.id}`)!.conflict).toBe(true);
    expect(byKey.get(`publication:${theirs.id}`)!.conflict).toBe(false);
    expect(all.events.filter((e) => e.type === 'milestone')[0]).toMatchObject({ date: '2030-06-05', title: 'Season launch' });
    expect(all.events.filter((e) => e.type === 'task')).toHaveLength(1);
    expect(all.events.filter((e) => e.type === 'shift')[0]!.title).toContain('Shift');
    // A lead of the other project sees only its records; a publisher sees only publications (+ own tasks layer).
    const lead = await memberClient(f.ws, 'project_lead', { projects: [f.other.id] });
    const leadCal = await lead.client.call(CAL.get, { params: f.W, query: q });
    expect(leadCal.events.map((e) => e.entityId)).toEqual([theirs.id]);
    const publisher = await memberClient(f.ws, 'publisher', { accounts: [f.accountId] });
    const pubCal = await publisher.client.call(CAL.get, { params: f.W, query: { ...q, layers: ['publications'] } });
    expect(pubCal.layers.shifts).toBe(false);
    expect(pubCal.events.map((e) => e.entityId).sort()).toEqual([a.id, b.id].sort());
    // Filters: account and status.
    const filtered = await f.owner.call(CAL.get, { params: f.W, query: { ...q, accountId: f.otherAccountId, layers: ['publications'] } });
    expect(filtered.events.map((e) => e.entityId)).toEqual([theirs.id]);
    // Invalid windows are rejected.
    expect((await f.owner.attempt(CAL.get, { params: f.W, query: { from: at(10), to: at(0) } })).status).toBe(422);
    expect((await f.owner.attempt(CAL.get, { params: f.W, query: { from: at(0), to: at(24 * 120) } })).status).toBe(422);
    // A member without any calendar layer gets 403.
    const contractor = await memberClient(f.ws, 'contractor', { scopeType: 'assigned_object' });
    const r = await contractor.client.attempt(CAL.get, { params: f.W, query: q });
    expect(r.ok).toBe(true);
    expect(r.data!.layers.publications).toBe(false);
  });
});
