import { beforeAll, describe, expect, it } from 'vitest';
import { and, count, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import { financeEndpoints as F, overviewEndpoints as O, type OverviewResponse } from '@castlane/api-contracts';
import { buckets, countValue, percentValue } from '@castlane/analytics';
import { EXPORT_DATASETS_REGISTRY, defineMetric, getAppServices, landingPath, memberJobContext, scopePredicate } from '@castlane/application';
import { contentItems, metricCheckpoints, metricObservations, publications, reviews, shifts, tasks } from '@castlane/database';
import { DateTime, newId } from '@castlane/domain';
import { addMember, assignToProject, clientFor, createAccount, createDirection, createProject, createWorkspace, sessionFor, type TestWorkspace } from '../../support';

const db = () => getAppServices().db;
const HOUR = 3_600_000;

/**
 * Test definitions of M01/M07/M08 (the insights module ships the real catalogue): scope applied
 * in SQL before aggregation, filters honoured, M01 with a daily series.
 */
beforeAll(() => {
  const pubWhere = (ctx: Parameters<Parameters<typeof defineMetric>[0]['compute']>[0], q: Parameters<Parameters<typeof defineMetric>[0]['compute']>[1], start: Date, end: Date) =>
    and(
      eq(publications.workspaceId, ctx.actor.workspaceId),
      eq(publications.status, 'published'),
      gte(publications.actualPublishedAt, start),
      lt(publications.actualPublishedAt, end),
      scopePredicate(ctx, 'publications.read', { projectId: publications.projectId, accountId: publications.accountId, assigned: [publications.ownerMembershipId] }),
      q.filters.projectIds?.length ? inArray(publications.projectId, q.filters.projectIds) : undefined,
      q.filters.directionIds?.length ? sql`${publications.projectId} IN (SELECT id FROM projects WHERE direction_id IN (${sql.join(q.filters.directionIds.map((d) => sql`${d}::uuid`), sql`, `)}))` : undefined,
    );
  defineMetric({
    id: 'M01',
    key: 'published_count',
    label: 'Published',
    description: 'Unique publications confirmed as published in the period.',
    unit: 'count',
    permission: 'publications.read',
    dimensions: ['project'],
    grains: ['day', 'week', 'month'],
    definitionVersion: 1,
    async compute(ctx, q) {
      const [t] = await ctx.app.db.select({ n: count() }).from(publications).where(pubWhere(ctx, q, q.period.start, q.period.end));
      const series = q.grain
        ? await Promise.all(
            buckets(q.period, q.grain).map(async (b) => {
              const [r] = await ctx.app.db.select({ n: count() }).from(publications).where(pubWhere(ctx, q, b.start, b.end));
              return { bucket: b.key, value: countValue(Number(r?.n ?? 0)) };
            }),
          )
        : undefined;
      return { total: countValue(Number(t?.n ?? 0)), series, drillDown: { href: `/w/${ctx.actor.workspaceId}/publications?status=published`, label: 'Published placements' } };
    },
  });
  defineMetric({
    id: 'M07',
    key: 'task_on_time_rate',
    label: 'On-Time Rate',
    description: 'Done by baseline / tasks with a baseline in the period.',
    unit: 'percent',
    rate: true,
    permission: 'tasks.read',
    dimensions: [],
    grains: ['day'],
    definitionVersion: 1,
    async compute(ctx, q) {
      const where = and(
        eq(tasks.workspaceId, ctx.actor.workspaceId),
        gte(tasks.baselineDueAt, q.period.start),
        lt(tasks.baselineDueAt, q.period.end),
        scopePredicate(ctx, 'tasks.read', { projectId: tasks.projectId, accountId: tasks.accountId, assigned: [tasks.assigneeMembershipId] }),
        q.filters.projectIds?.length ? inArray(tasks.projectId, q.filters.projectIds) : undefined,
      );
      const [r] = await ctx.app.db
        .select({ all: count(), onTime: sql<number>`count(*) FILTER (WHERE ${tasks.status} = 'done' AND ${tasks.completedAt} <= ${tasks.baselineDueAt})::int` })
        .from(tasks)
        .where(where);
      return { total: percentValue(Number(r?.onTime ?? 0), Number(r?.all ?? 0)) };
    },
  });
  defineMetric({
    id: 'M08',
    key: 'overdue_tasks',
    label: 'Overdue Tasks',
    description: 'Open tasks with a passed deadline.',
    unit: 'count',
    permission: 'tasks.read',
    dimensions: [],
    grains: ['day'],
    definitionVersion: 1,
    async compute(ctx, q) {
      const [r] = await ctx.app.db
        .select({ n: count() })
        .from(tasks)
        .where(
          and(
            eq(tasks.workspaceId, ctx.actor.workspaceId),
            inArray(tasks.status, ['draft', 'backlog', 'ready', 'in_progress', 'in_review']),
            isNull(tasks.deletedAt),
            lt(tasks.dueAt, q.asOf),
            scopePredicate(ctx, 'tasks.read', { projectId: tasks.projectId, accountId: tasks.accountId, assigned: [tasks.assigneeMembershipId] }),
            q.filters.projectIds?.length ? inArray(tasks.projectId, q.filters.projectIds) : undefined,
          ),
        );
      return { total: countValue(Number(r?.n ?? 0)) };
    },
  });
});

const insertTask = async (ws: TestWorkspace, projectId: string, input: Partial<typeof tasks.$inferInsert> = {}) => {
  const id = newId();
  const at = new Date();
  await db().insert(tasks).values({ id, workspaceId: ws.workspaceId, projectId, title: input.title ?? `Task ${id.slice(0, 4)}`, status: 'in_progress', createdAt: at, updatedAt: at, ...input });
  return id;
};

const insertContentItem = async (ws: TestWorkspace, projectId: string, title: string) => {
  const id = newId();
  const at = new Date();
  await db().insert(contentItems).values({ id, workspaceId: ws.workspaceId, projectId, title, format: 'short_video', stage: 'review', ownerMembershipId: ws.owner.membershipId, createdAt: at, updatedAt: at });
  return id;
};

const insertPublication = async (ws: TestWorkspace, input: { projectId: string; accountId: string; status: 'scheduled' | 'published'; at: Date; title: string }) => {
  const contentItemId = await insertContentItem(ws, input.projectId, input.title);
  const now = new Date();
  await db()
    .insert(publications)
    .values({
      id: newId(),
      workspaceId: ws.workspaceId,
      contentItemId,
      accountId: input.accountId,
      projectId: input.projectId,
      ownerMembershipId: ws.owner.membershipId,
      status: input.status,
      scheduledAt: input.at,
      actualPublishedAt: input.status === 'published' ? input.at : null,
      createdAt: now,
      updatedAt: now,
    });
};

const seed = async () => {
  const ws = await createWorkspace(db());
  const owner = await clientFor(await sessionFor(db(), ws.owner.userId));
  const W = { workspaceId: ws.workspaceId };
  const directionId = await createDirection(db(), ws, 'AI Models');
  const a = (await createProject(db(), ws, { directionId, name: 'Alpha Model', type: 'model' })).id;
  const b = (await createProject(db(), ws, { directionId, name: 'Beta Series', type: 'series' })).id;
  const accA = await createAccount(db(), ws, { projectId: a });
  const accB = await createAccount(db(), ws, { projectId: b });
  const now = Date.now();
  // Overdue and blocked tasks.
  await insertTask(ws, a, { title: 'Alpha overdue', dueAt: new Date(now - 5 * HOUR), baselineDueAt: new Date(now - 5 * HOUR) });
  await insertTask(ws, b, { title: 'Beta overdue', dueAt: new Date(now - 100 * HOUR), baselineDueAt: new Date(now - 100 * HOUR) });
  await insertTask(ws, a, { title: 'Alpha blocked', blockedAt: new Date(now - 2 * HOUR), blockedReason: 'Waiting for voice track' });
  await insertTask(ws, a, { title: 'Alpha done on time', status: 'done', dueAt: new Date(now - 10 * HOUR), baselineDueAt: new Date(now - 10 * HOUR), completedAt: new Date(now - 12 * HOUR) });
  // A review waiting for 3 days.
  const contentId = await insertContentItem(ws, a, 'Morning Routine Reel');
  await db().insert(reviews).values({
    id: newId(),
    workspaceId: ws.workspaceId,
    targetType: 'content_version',
    targetId: newId(),
    subjectId: contentId,
    projectId: a,
    roundNo: 1,
    status: 'pending',
    reviewerMembershipId: ws.owner.membershipId,
    submittedAt: new Date(now - 72 * HOUR),
    policySnapshot: { steps: ['release_approval'], allowSelfReview: false, requiredApprovals: 1 },
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  // Published placements (Alpha ×2, Beta ×1) and a scheduled one without an approved version.
  await insertPublication(ws, { projectId: a, accountId: accA, status: 'published', at: new Date(now - 30 * HOUR), title: 'Alpha post 1' });
  await insertPublication(ws, { projectId: a, accountId: accA, status: 'published', at: new Date(now - 2 * HOUR), title: 'Alpha post 2' });
  await insertPublication(ws, { projectId: b, accountId: accB, status: 'published', at: new Date(now - 3 * HOUR), title: 'Beta trailer' });
  await insertPublication(ws, { projectId: a, accountId: accA, status: 'scheduled', at: new Date(now + 6 * HOUR), title: 'Alpha unapproved' });
  // A checkpoint whose window closed without data; an observation 10 days old on Alpha's account.
  await db().insert(metricCheckpoints).values({
    id: newId(),
    workspaceId: ws.workspaceId,
    entityType: 'account',
    entityId: accA,
    accountId: accA,
    projectId: a,
    checkpointKey: '7d',
    policyVersion: 1,
    expectedAt: new Date(now - 48 * HOUR),
    windowStart: new Date(now - 60 * HOUR),
    windowEnd: new Date(now - 36 * HOUR),
    state: 'pending',
    occurrenceKey: `test:${newId()}`,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const obsAt = new Date(now - 10 * 24 * HOUR);
  const obsId = newId();
  await db().insert(metricObservations).values({
    id: obsId,
    workspaceId: ws.workspaceId,
    entityType: 'account',
    entityId: accA,
    accountId: accA,
    projectId: a,
    kind: 'snapshot',
    observedAt: obsAt,
    sourceType: 'manual',
    sourceNote: 'Manual entry',
    enteredAt: obsAt,
    rootObservationId: obsId,
    dedupeKey: `test:${obsId}`,
    createdAt: obsAt,
    updatedAt: obsAt,
  });
  // A shift that should have ended 2 hours ago.
  await db().insert(shifts).values({
    id: newId(),
    workspaceId: ws.workspaceId,
    projectId: a,
    primaryAccountId: accA,
    membershipId: ws.owner.membershipId,
    scheduledStart: new Date(now - 10 * HOUR),
    scheduledEnd: new Date(now - 2 * HOUR),
    timezone: 'Europe/Berlin',
    state: 'active',
    actualStart: new Date(now - 10 * HOUR),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  // A budget over plan through an open commitment (actual + committed > planned).
  const cats = await owner.call(F.categoriesList, { params: W, query: {} });
  const production = cats.find((c) => c.key === 'production_services')!.id;
  const today = DateTime.fromJSDate(new Date(), { zone: 'Europe/Berlin' });
  const budget = await owner.call(F.budgetsCreate, {
    params: W,
    body: { name: 'Alpha production', scopeType: 'project', scopeId: a, periodStart: today.startOf('month').toISODate()!, periodEnd: today.endOf('month').toISODate()!, currency: 'EUR', ownerMembershipId: ws.owner.membershipId, lines: [{ categoryId: production, planned: '100.00' }] },
  });
  await owner.call(F.budgetsApprove, { params: { ...W, budgetId: budget.id }, body: { versionId: budget.versions[0]!.id } }, { ifMatch: budget.rowVersion });
  await owner.call(F.commitmentsCreate, { params: W, body: { projectId: a, categoryId: production, amount: '400.00', currency: 'EUR', dueDate: today.toISODate()!, description: 'Studio booking' } });
  return { ws, owner, W, directionId, a, b, accA, accB };
};

const counts = (o: OverviewResponse) => Object.fromEntries(o.needsAttention.counts.map((c) => [c.kind, c.count]));
const kpi = (o: OverviewResponse, key: string) => o.kpis.find((k) => k.key === key)!;

describe('overview (S08)', () => {
  it('an empty workspace shows the setup checklist and no fake KPIs or charts (T169)', async () => {
    const ws = await createWorkspace(db());
    const owner = await clientFor(await sessionFor(db(), ws.owner.userId));
    const o = await owner.call(O.get, { params: { workspaceId: ws.workspaceId }, query: {} });
    expect(o.setup.empty).toBe(true);
    expect(o.setup.steps.map((s) => [s.label, s.done, s.permitted])).toEqual([
      ['Start a Project', false, true],
      ['Add an Account', false, true],
      ['Create a Task', false, true],
    ]);
    expect(o.kpis).toEqual([]);
    expect(o.trend.series).toEqual([]);
    expect(o.projects.items).toEqual([]);
    expect(o.needsAttention.total).toBe(0);
    // Contractors have no Overview at all.
    const contractor = await addMember(db(), ws, { roleKey: 'contractor', scopeType: 'assigned_object' });
    const cc = await clientFor(await sessionFor(db(), contractor.userId));
    expect((await cc.attempt(O.get, { params: { workspaceId: ws.workspaceId }, query: {} })).status).toBe(403);
  });

  it('computes KPIs, trend, Needs Attention, projects and freshness from real records', async () => {
    const f = await seed();
    const o = await f.owner.call(O.get, { params: f.W, query: { period: 'last_7_days' } });
    expect(o.setup.empty).toBe(false);
    expect(kpi(o, 'published').value).toMatchObject({ status: 'known', value: '3' });
    expect(kpi(o, 'published').href).toContain('/publications?status=published');
    expect(kpi(o, 'pending_reviews').value.value).toBe('1');
    expect(kpi(o, 'overdue_tasks').value.value).toBe('2');
    expect(kpi(o, 'on_time_rate').value).toMatchObject({ status: 'known', unit: 'percent' });
    expect(kpi(o, 'on_time_rate').comparison?.unitLabel).toBe('pp');
    expect(counts(o)).toEqual({
      overdue_task: 2,
      blocked_task: 1,
      review_waiting: 1,
      publication_unapproved: 1,
      checkpoint_missing: 1,
      shift_end_forgotten: 1,
      budget_overspent: 1,
    });
    for (const item of o.needsAttention.items) expect(item.href).toMatch(new RegExp(`^/w/${f.ws.workspaceId}/`));
    expect(o.needsAttention.items.find((i) => i.kind === 'review_waiting')).toMatchObject({ title: 'Morning Routine Reel', actionLabel: 'Review' });
    expect(o.needsAttention.items.find((i) => i.kind === 'budget_overspent')?.detail).toMatch(/% of plan used/);
    const series = o.trend.series.find((s) => s.metricId === 'M01')!;
    expect(o.trend.grain).toBe('day');
    expect(series.points).toHaveLength(7);
    expect(series.points.reduce((a, p) => a + Number(p.value.value ?? 0), 0)).toBe(3);
    expect(o.projects.items.map((p) => [p.name, p.openTasks, p.overdueTasks])).toEqual([
      ['Alpha Model', 2, 1],
      ['Beta Series', 1, 1],
    ]);
    expect(o.projects.items[0]!.lastPublicationAt).not.toBeNull();
    expect(o.freshness?.totalAccounts).toBe(2);
    expect(o.freshness?.staleAccounts).toBe(2);
    const alpha = o.freshness!.accounts.find((x) => x.id === f.accA)!;
    expect(alpha).toMatchObject({ overdue: true });
    expect(alpha.lastObservedAt).not.toBeNull();
    expect(o.freshness!.accounts.find((x) => x.id === f.accB)).toMatchObject({ lastObservedAt: null, overdue: true });
    // One expected checkpoint in the period, none usable: 0 % — a real zero with its coverage.
    expect(o.freshness!.coverage).toMatchObject({ status: 'known', value: '0.00', coverage: { usable: 0, expected: 1 } });
    expect(o.finance).toBeDefined();
    expect(o.finance?.baseCurrency).toBe('EUR');
  });

  it('applies scope before aggregation and omits finance without access (T016)', async () => {
    const f = await seed();
    const lead = await addMember(db(), f.ws, { roleKey: 'project_lead', scopeType: 'assigned_projects' });
    await assignToProject(db(), f.ws, f.a, lead.membershipId);
    const lc = await clientFor(await sessionFor(db(), lead.userId));
    const o = await lc.call(O.get, { params: f.W, query: { period: 'last_7_days' } });
    expect(kpi(o, 'published').value.value).toBe('2');
    expect(kpi(o, 'overdue_tasks').value.value).toBe('1');
    expect(counts(o).overdue_task).toBe(1);
    expect(counts(o).budget_overspent).toBeUndefined();
    expect(o.needsAttention.items.every((i) => i.project?.id !== f.b)).toBe(true);
    expect(o.projects.items.map((p) => p.name)).toEqual(['Alpha Model']);
    expect(o.freshness?.totalAccounts).toBe(1);
    expect('finance' in o).toBe(false);
    // A project outside the scope does not exist for the lead; custom periods need both dates.
    expect((await lc.attempt(O.get, { params: f.W, query: { projectId: f.b } })).status).toBe(404);
    expect((await lc.attempt(O.get, { params: f.W, query: { period: 'custom', from: '2026-09-01' } })).status).toBe(422);
    // The owner can filter to one project.
    const onlyB = await f.owner.call(O.get, { params: f.W, query: { period: 'last_7_days', projectId: f.b } });
    expect(onlyB.filters.project?.name).toBe('Beta Series');
    expect(kpi(onlyB, 'published').value.value).toBe('1');
    expect(onlyB.projects.items.map((p) => p.name)).toEqual(['Beta Series']);
    expect(counts(onlyB).blocked_task).toBe(0);
    // Export View: the same projects table, scoped to the requester.
    const ctx = (await memberJobContext(getAppServices(), f.ws.workspaceId, lead.membershipId))!;
    const rows: Record<string, unknown>[] = [];
    for await (const r of EXPORT_DATASETS_REGISTRY.get('overview_projects')!.rows(ctx, { filters: {}, boundAt: new Date(Date.now() + 1000), fields: [] })) rows.push(r);
    expect(rows.map((r) => [r.project, r.overdue_tasks, r.pending_reviews])).toEqual([['Alpha Model', 1, 1]]);
  });

  it('sends leads to Overview and other staff to My Work after sign-in', async () => {
    const ws = await createWorkspace(db());
    expect(await landingPath(db(), ws.owner.userId)).toBe(`/w/${ws.workspaceId}/overview`);
    const lead = await addMember(db(), ws, { roleKey: 'project_lead', scopeType: 'assigned_projects' });
    expect(await landingPath(db(), lead.userId)).toBe(`/w/${ws.workspaceId}/overview`);
    const creator = await addMember(db(), ws, { roleKey: 'creator', scopeType: 'assigned_projects' });
    expect(await landingPath(db(), creator.userId)).toBe(`/w/${ws.workspaceId}/my-work`);
  });
});
