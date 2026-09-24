import { beforeAll, describe, expect, it } from 'vitest';
import { and, count, eq, gte, inArray, lt } from 'drizzle-orm';
import { newIdempotencyKey } from '@castlane/api-client';
import { goalEndpoints as G, lookupEndpoints, type GoalDetail } from '@castlane/api-contracts';
import { countValue, unavailable } from '@castlane/analytics';
import { EXPORT_DATASETS_REGISTRY, RESPONSIBILITY_PROVIDERS, defineMetric, executeCommand, getAppServices, memberJobContext, scopePredicate } from '@castlane/application';
import { goalRevisions, tasks } from '@castlane/database';
import { DateTime, newId } from '@castlane/domain';
import { addMember, assignToProject, clientFor, createDirection, createProject, createWorkspace, sessionFor } from '../../support';

const db = () => getAppServices().db;

/**
 * Test metric definitions (the insights module ships the real catalogue M01–M42). TG1 counts done
 * tasks in the period inside the viewer's scope; TG2 is a metric without any source data.
 */
beforeAll(() => {
  defineMetric({
    id: 'TG1',
    key: 'test_done_tasks',
    label: 'Done Tasks',
    description: 'Tasks completed in the period.',
    unit: 'count',
    permission: 'tasks.read',
    dimensions: ['project'],
    grains: ['day', 'week', 'month'],
    definitionVersion: 1,
    async compute(ctx, q) {
      const [r] = await ctx.app.db
        .select({ n: count() })
        .from(tasks)
        .where(
          and(
            eq(tasks.workspaceId, ctx.actor.workspaceId),
            eq(tasks.status, 'done'),
            gte(tasks.completedAt, q.period.start),
            lt(tasks.completedAt, q.period.end),
            scopePredicate(ctx, 'tasks.read', { projectId: tasks.projectId, accountId: tasks.accountId, assigned: [tasks.assigneeMembershipId] }),
            q.filters.projectIds?.length ? inArray(tasks.projectId, q.filters.projectIds) : undefined,
          ),
        );
      const n = Number(r?.n ?? 0);
      return { total: countValue(n, { coverage: { usable: 3, expected: 4 } }), drillDown: { href: `/w/${ctx.actor.workspaceId}/tasks?status=done`, label: 'Done tasks' } };
    },
  });
  defineMetric({
    id: 'TG2',
    key: 'test_unmeasured',
    label: 'Reported Revenue Units',
    description: 'A metric without source data in this workspace.',
    unit: 'count',
    permission: 'tasks.read',
    dimensions: [],
    grains: ['month'],
    definitionVersion: 1,
    async compute() {
      return { total: unavailable('no_data', 'count') };
    },
  });
});

const setup = async () => {
  const ws = await createWorkspace(db());
  const owner = await clientFor(await sessionFor(db(), ws.owner.userId));
  const directionId = await createDirection(db(), ws, 'AI Models');
  const p1 = await createProject(db(), ws, { directionId, name: 'Emma Model', type: 'model' });
  const p2 = await createProject(db(), ws, { directionId, name: 'Night Shift', type: 'series' });
  const W = { workspaceId: ws.workspaceId };
  const today = DateTime.fromJSDate(new Date(), { zone: 'Europe/Berlin' });
  const period = { periodStart: today.startOf('month').toISODate()!, periodEnd: today.endOf('month').toISODate()! };
  return { ws, owner, W, p1: p1.id, p2: p2.id, period };
};

const doneTask = async (workspaceId: string, projectId: string) => {
  const at = new Date(Date.now() - 60_000);
  await db().insert(tasks).values({ id: newId(), workspaceId, projectId, title: `Done ${Math.random().toString(36).slice(2, 6)}`, status: 'done', completedAt: at, createdAt: at, updatedAt: at });
};

describe('goals (S53, §17)', () => {
  it('creates goals with the metric’s fixed unit; relative types require a baseline', async () => {
    const f = await setup();
    const base = { name: 'Ship 4 tasks', ownerMembershipId: f.ws.owner.membershipId, scopeType: 'project' as const, scopeId: f.p1, metricId: 'TG1', ...f.period };
    const noBaseline = await f.owner.attempt(G.create, { params: f.W, body: { ...base, targetType: 'increase_by', targetValue: '10' } });
    expect(noBaseline.status).toBe(422);
    expect((noBaseline.error as { fieldErrors: { field: string }[] }).fieldErrors.map((e) => e.field)).toContain('baselineValue');
    const unknown = await f.owner.attempt(G.create, { params: f.W, body: { ...base, metricId: 'M99', targetType: 'absolute', targetValue: '4' } });
    expect((unknown.error as { fieldErrors: { field: string }[] }).fieldErrors.map((e) => e.field)).toContain('metricId');
    const key = newIdempotencyKey();
    const goal = await f.owner.call(G.create, { params: f.W, body: { ...base, targetType: 'absolute', targetValue: '4' } }, { idempotencyKey: key });
    const replay = await f.owner.call(G.create, { params: f.W, body: { ...base, targetType: 'absolute', targetValue: '4' } }, { idempotencyKey: key });
    expect(replay.id).toBe(goal.id);
    expect(goal).toMatchObject({ unit: 'count', metric: { id: 'TG1', label: 'Done Tasks', available: true }, status: 'active', revisionNo: 1, scope: { type: 'project', label: 'Emma Model' } });
    // Nothing done yet: a known zero count, not Not Measured.
    expect(goal.current).toMatchObject({ source: 'metric', value: { status: 'known', value: '0' } });
    expect(goal.progress).toMatchObject({ status: 'known', value: '0.00' });
    const options = await f.owner.call(G.metricOptions, { params: f.W });
    expect(options.map((o) => o.id)).toEqual(expect.arrayContaining(['TG1', 'TG2']));
  });

  it('reads current value from the canonical metric in scope and labels over-target progress without clamping', async () => {
    const f = await setup();
    const goal = await f.owner.call(G.create, { params: f.W, body: { name: 'Ship 4 tasks', ownerMembershipId: f.ws.owner.membershipId, scopeType: 'project', scopeId: f.p1, metricId: 'TG1', targetType: 'absolute', targetValue: '4', ...f.period } });
    await doneTask(f.ws.workspaceId, f.p1);
    await doneTask(f.ws.workspaceId, f.p1);
    await doneTask(f.ws.workspaceId, f.p2);
    let g = await f.owner.call(G.get, { params: { ...f.W, goalId: goal.id } });
    expect(g.current.value.value).toBe('2');
    expect(g.progress).toMatchObject({ status: 'known', value: '50.00' });
    expect(g.completeness).toBe('75.0000');
    expect(g.sources?.href).toContain('/tasks?status=done');
    for (let i = 0; i < 4; i++) await doneTask(f.ws.workspaceId, f.p1);
    g = await f.owner.call(G.get, { params: { ...f.W, goalId: goal.id } });
    expect(g).toMatchObject({ overTarget: true, progress: { value: '150.00', note: 'Over Target' } });
  });

  it('a target revised mid-period keeps the target and baseline history (T118)', async () => {
    const f = await setup();
    const goal = await f.owner.call(G.create, {
      params: f.W,
      body: { name: 'Grow done tasks', ownerMembershipId: f.ws.owner.membershipId, scopeType: 'project', scopeId: f.p1, metricId: 'TG1', targetType: 'increase_by', targetValue: '10', baselineValue: '5', ...f.period },
    });
    expect((await f.owner.attempt(G.update, { params: { ...f.W, goalId: goal.id }, body: { targetValue: '12' } })).status).toBe(428);
    const noReason = await f.owner.attempt(G.update, { params: { ...f.W, goalId: goal.id }, body: { targetValue: '12' } }, { ifMatch: goal.rowVersion });
    expect(noReason.status).toBe(422);
    expect((noReason.error as { fieldErrors: { field: string }[] }).fieldErrors.map((e) => e.field)).toEqual(['reason']);
    const revised = await f.owner.call(G.update, { params: { ...f.W, goalId: goal.id }, body: { targetValue: '12', baselineValue: '6', reason: 'Two more creators joined' } }, { ifMatch: goal.rowVersion });
    expect(revised).toMatchObject({ targetValue: '12', baselineValue: '6', revisionNo: 2, periodStarted: true });
    expect(revised.revisions.map((r) => [r.revisionNo, r.targetValue, r.baselineValue, r.reason])).toEqual([
      [2, '12', '6', 'Two more creators joined'],
      [1, '10', '5', null],
    ]);
    expect(revised.revisions[0]!.effectiveFrom).toBe(DateTime.fromJSDate(new Date(), { zone: 'Europe/Berlin' }).toISODate());
    const stale = await f.owner.attempt(G.update, { params: { ...f.W, goalId: goal.id }, body: { name: 'Renamed' } }, { ifMatch: goal.rowVersion });
    expect(stale.status).toBe(412);
    // A name change is not a target revision; the metric is fixed once the period started.
    const renamed = await f.owner.call(G.update, { params: { ...f.W, goalId: goal.id }, body: { name: 'Grow completed tasks' } }, { ifMatch: revised.rowVersion });
    expect(renamed.revisionNo).toBe(2);
    expect((await f.owner.attempt(G.update, { params: { ...f.W, goalId: goal.id }, body: { metricId: 'TG2' } }, { ifMatch: renamed.rowVersion })).status).toBe(422);
    expect(await db().select().from(goalRevisions).where(eq(goalRevisions.goalId, goal.id))).toHaveLength(2);
  });

  it('without sources the goal is Not Measured; manual check-ins are labelled Manual; closing stores the achieved value', async () => {
    const f = await setup();
    const goal = await f.owner.call(G.create, { params: f.W, body: { name: 'Revenue units', ownerMembershipId: f.ws.owner.membershipId, scopeType: 'workspace', metricId: 'TG2', targetType: 'absolute', targetValue: '100', ...f.period } });
    expect(goal.current).toMatchObject({ source: 'none', value: { status: 'not_measured', value: null } });
    expect(goal.progress.status).toBe('not_measured');
    const noSource = await f.owner.attempt(G.checkIn, { params: { ...f.W, goalId: goal.id }, body: { note: 'From the platform dashboard', manualValue: '30' } });
    expect(noSource.status).toBe(422);
    const checked: GoalDetail = await f.owner.call(G.checkIn, { params: { ...f.W, goalId: goal.id }, body: { note: 'From the platform dashboard', manualValue: '30', manualSource: 'Platform statement screenshot' } });
    expect(checked.current).toMatchObject({ source: 'manual', manualSource: 'Platform statement screenshot', value: { value: '30', note: 'Manual' } });
    expect(checked.progress.value).toBe('30.00');
    expect(checked.checkIns[0]).toMatchObject({ manualValue: '30', measuredValue: null, note: 'From the platform dashboard' });
    const closed = await f.owner.call(G.close, { params: { ...f.W, goalId: goal.id }, body: { assessment: 'Reached a third of the target; source is manual only.' } }, { ifMatch: checked.rowVersion });
    expect(closed).toMatchObject({ status: 'closed', achievedValue: '30', completeness: null, permissions: { edit: false, checkIn: false, close: false } });
    expect((await f.owner.attempt(G.update, { params: { ...f.W, goalId: goal.id }, body: { name: 'x y z' } }, { ifMatch: closed.rowVersion })).status).toBe(409);
    expect((await f.owner.attempt(G.checkIn, { params: { ...f.W, goalId: goal.id }, body: { note: 'Late note' } })).status).toBe(409);
    const archived = await f.owner.call(G.archive, { params: { ...f.W, goalId: goal.id }, body: { reason: 'Quarter finished' } }, { ifMatch: closed.rowVersion });
    expect(archived.status).toBe('archived');
    expect((await f.owner.call(G.list, { params: f.W, query: {} })).items.map((g) => g.id)).not.toContain(goal.id);
    const restored = await f.owner.call(G.archive, { params: { ...f.W, goalId: goal.id }, body: { restore: true } }, { ifMatch: archived.rowVersion });
    expect(restored).toMatchObject({ status: 'closed', archivedAt: null, achievedValue: '30' });
  });

  it('applies scope: leads see and manage goals of their projects only; viewers read but cannot write', async () => {
    const f = await setup();
    const goal = await f.owner.call(G.create, { params: f.W, body: { name: 'Emma tasks', ownerMembershipId: f.ws.owner.membershipId, scopeType: 'project', scopeId: f.p1, metricId: 'TG1', targetType: 'absolute', targetValue: '4', ...f.period } });
    const lead = await addMember(db(), f.ws, { roleKey: 'project_lead', scopeType: 'assigned_projects' });
    await assignToProject(db(), f.ws, f.p2, lead.membershipId);
    const leadClient = await clientFor(await sessionFor(db(), lead.userId));
    expect((await leadClient.attempt(G.get, { params: { ...f.W, goalId: goal.id } })).status).toBe(404);
    expect((await leadClient.call(G.list, { params: f.W, query: {} })).items).toHaveLength(0);
    expect((await leadClient.attempt(G.create, { params: f.W, body: { name: 'Not mine', ownerMembershipId: lead.membershipId, scopeType: 'project', scopeId: f.p1, metricId: 'TG1', targetType: 'absolute', targetValue: '1', ...f.period } })).status).toBe(403);
    const own = await leadClient.call(G.create, { params: f.W, body: { name: 'Night tasks', ownerMembershipId: lead.membershipId, scopeType: 'project', scopeId: f.p2, metricId: 'TG1', targetType: 'absolute', targetValue: '2', ...f.period } });
    expect((await leadClient.call(G.list, { params: f.W, query: { projectId: f.p2 } })).items.map((g) => g.id)).toEqual([own.id]);
    const found = await leadClient.call(lookupEndpoints.search, { params: { ...f.W, type: 'goal' }, query: { limit: 20 } });
    expect(found.items.map((i) => i.id)).toEqual([own.id]);
    const viewer = await addMember(db(), f.ws, { roleKey: 'viewer' });
    const viewerClient = await clientFor(await sessionFor(db(), viewer.userId));
    expect((await viewerClient.call(G.list, { params: f.W, query: {} })).items.map((g) => g.id).sort()).toEqual([goal.id, own.id].sort());
    expect((await viewerClient.attempt(G.create, { params: f.W, body: { name: 'Viewer goal', ownerMembershipId: viewer.membershipId, scopeType: 'workspace', metricId: 'TG1', targetType: 'absolute', targetValue: '1', ...f.period } })).status).toBe(403);
    const other = await createWorkspace(db());
    const otherOwner = await clientFor(await sessionFor(db(), other.owner.userId));
    expect((await otherOwner.attempt(G.get, { params: { workspaceId: other.workspaceId, goalId: goal.id } })).status).toBe(404);
  });

  it('exports goals in scope and hands ownership over on deactivation', async () => {
    const f = await setup();
    const lead = await addMember(db(), f.ws, { roleKey: 'project_lead', scopeType: 'assigned_projects' });
    await assignToProject(db(), f.ws, f.p1, lead.membershipId);
    const goal = await f.owner.call(G.create, { params: f.W, body: { name: 'Emma tasks', ownerMembershipId: lead.membershipId, scopeType: 'project', scopeId: f.p1, metricId: 'TG1', targetType: 'absolute', targetValue: '4', ...f.period } });
    const ctx = (await memberJobContext(getAppServices(), f.ws.workspaceId, f.ws.owner.membershipId))!;
    const rows: Record<string, unknown>[] = [];
    for await (const r of EXPORT_DATASETS_REGISTRY.get('goals')!.rows(ctx, { filters: {}, boundAt: new Date(Date.now() + 1000), fields: [] })) rows.push(r);
    expect(rows).toEqual([expect.objectContaining({ id: goal.id, current_source: 'Metric', current_value: '0', progress_percent: '0.00', unit: 'count' })]);
    const provider = RESPONSIBILITY_PROVIDERS.get('goals.owner')!;
    expect(await provider.list(ctx, lead.membershipId)).toEqual([expect.objectContaining({ entityId: goal.id, requiresSuccessor: true })]);
    const outsider = await addMember(db(), f.ws, { roleKey: 'project_lead', scopeType: 'assigned_projects' });
    await expect(executeCommand(ctx, (c) => provider.transfer(c, lead.membershipId, [{ entityId: goal.id, successorMembershipId: outsider.membershipId }]))).rejects.toThrow(/cannot see/);
    await executeCommand(ctx, (c) => provider.transfer(c, lead.membershipId, [{ entityId: goal.id, successorMembershipId: f.ws.owner.membershipId }]));
    const after = await f.owner.call(G.get, { params: { ...f.W, goalId: goal.id } });
    expect(after.owner.membershipId).toBe(f.ws.owner.membershipId);
  });
});
