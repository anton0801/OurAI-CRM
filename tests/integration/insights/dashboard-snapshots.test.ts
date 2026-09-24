import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { analyticsEndpoints as A, teamEndpoints } from '@castlane/api-contracts';
import {
  analyticsDashboard,
  getAppServices,
  memberJobContext,
  refreshDashboardSnapshots,
} from '@castlane/application';
import type { AnalyticsDashboard } from '@castlane/api-contracts';
import { analyticsDashboardSnapshots, roleAssignments } from '@castlane/database';
import { dispatchOutboxBatch } from '../../../apps/worker/src/outbox';
import {
  at,
  cumulativeBody,
  db,
  insertPublication,
  insightsFixture,
  kpi,
  memberOf,
  record,
  type InsightsFixture,
} from './helpers';

/**
 * Dashboard read model: figures served from analytics_dashboard_snapshots must be exactly what the
 * live computation returns on the same data and for the same access scope; a data change marks
 * the snapshot stale and the worker's refresh brings it back in line with the live result.
 */
const TAB = 'content' as const;
const QUERY = { preset: 'last_30_days' as const, compare: true };

/**
 * Figures only, in their JSON form: the time of computation, the elapsed end of an unfinished
 * comparison window and the read-model metadata differ by design.
 */
const figures = (d: AnalyticsDashboard) => {
  const { asOf: _asOf, snapshot: _snapshot, ...rest } = JSON.parse(JSON.stringify(d)) as AnalyticsDashboard;
  void _asOf;
  void _snapshot;
  return { ...rest, comparison: rest.comparison ? { ...rest.comparison, end: null } : null };
};

const live = async (f: InsightsFixture, membershipId: string, tab: 'content' | 'production' = TAB) => {
  const ctx = (await memberJobContext(getAppServices(), f.ws.workspaceId, membershipId))!;
  return analyticsDashboard(ctx, tab, QUERY);
};

const drainOutbox = async () => {
  for (let i = 0; i < 20; i++) if ((await dispatchOutboxBatch(getAppServices(), 500)) === 0) break;
};

const seedViews = async (f: InsightsFixture, views: string) => {
  const pub = await insertPublication(f, { publishedAt: at(6, 12) });
  await record(
    f.owner,
    f,
    cumulativeBody(pub, at(5, 12), { 'publication.views': views, 'publication.likes': '10' }),
  );
  return pub;
};

let minRefresh: string | undefined;
beforeAll(() => {
  minRefresh = process.env.ANALYTICS_SNAPSHOT_MIN_REFRESH_SECONDS;
  process.env.ANALYTICS_SNAPSHOT_MIN_REFRESH_SECONDS = '0';
});
afterAll(() => {
  if (minRefresh === undefined) delete process.env.ANALYTICS_SNAPSHOT_MIN_REFRESH_SECONDS;
  else process.env.ANALYTICS_SNAPSHOT_MIN_REFRESH_SECONDS = minRefresh;
});

describe('analytics dashboard read model', () => {
  it('computes live once, then serves a stored snapshot identical to the live computation', async () => {
    const f = await insightsFixture();
    await seedViews(f, '400');
    const params = { ...f.p, tab: TAB };
    const first = await f.owner.call(A.dashboard, { params, query: QUERY });
    expect(first.snapshot).toMatchObject({ live: true, refreshPending: false });
    const second = await f.owner.call(A.dashboard, { params, query: QUERY });
    expect(second.snapshot).toMatchObject({ live: false, refreshPending: false });
    expect(second.snapshot!.computedAt).toBe(first.asOf);
    expect(second.asOf).toBe(first.asOf);
    expect(figures(second)).toEqual(figures(await live(f, f.ws.owner.membershipId)));
    expect(kpi(second, 'M14').value).toMatchObject({ status: 'known', value: '400' });
    const rows = await db()
      .select()
      .from(analyticsDashboardSnapshots)
      .where(eq(analyticsDashboardSnapshots.workspaceId, f.ws.workspaceId));
    expect(rows).toHaveLength(1);
  });

  it('a data change marks the snapshot stale; the worker refresh brings it back to the live result', async () => {
    const f = await insightsFixture();
    await seedViews(f, '400');
    await drainOutbox();
    const params = { ...f.p, tab: TAB };
    await f.owner.call(A.dashboard, { params, query: QUERY });
    const before = await f.owner.call(A.dashboard, { params, query: QUERY });
    expect(before.snapshot?.refreshPending).toBe(false);

    await seedViews(f, '600'); // the observation emits a domain event
    await drainOutbox();
    const stale = await f.owner.call(A.dashboard, { params, query: QUERY });
    expect(stale.snapshot).toMatchObject({ live: false, refreshPending: true });
    expect(figures(stale)).toEqual(figures(before)); // stale figures are served with their age, never mixed

    const r = await refreshDashboardSnapshots(getAppServices(), { workspaceId: f.ws.workspaceId });
    expect(r.refreshed).toBe(1);
    const fresh = await f.owner.call(A.dashboard, { params, query: QUERY });
    expect(fresh.snapshot).toMatchObject({ live: false, refreshPending: false });
    expect(figures(fresh)).toEqual(figures(await live(f, f.ws.owner.membershipId)));
    expect(kpi(fresh, 'M14').value).toMatchObject({ status: 'known', value: '1000', sampleSize: 2 });
  });

  it('keeps access scopes apart: a scoped member never receives a wider snapshot, equal scopes share one', async () => {
    const f = await insightsFixture();
    await seedViews(f, '400');
    const otherPub = await insertPublication(f, {
      projectId: f.otherProjectId,
      accountId: f.otherAccountId,
      publishedAt: at(6, 12),
    });
    await record(
      f.owner,
      f,
      cumulativeBody(otherPub, at(5, 12), { 'publication.views': '900', 'publication.likes': '9' }),
    );
    const params = { ...f.p, tab: TAB };
    const owner = await f.owner.call(A.dashboard, { params, query: QUERY });
    expect(kpi(owner, 'M14').value.value).toBe('1300');

    const lead1 = await memberOf(f, 'project_lead', { projects: [f.projectId] });
    const lead2 = await memberOf(f, 'project_lead', { projects: [f.projectId] });
    const a = await lead1.client.call(A.dashboard, { params, query: QUERY });
    expect(a.snapshot?.live).toBe(true);
    expect(kpi(a, 'M14').value.value).toBe('400');
    expect(figures(a)).toEqual(figures(await live(f, lead1.membershipId)));
    // Same effective access (same role, same project): the second lead is served the first lead's snapshot.
    const b = await lead2.client.call(A.dashboard, { params, query: QUERY });
    expect(b.snapshot?.live).toBe(false);
    expect(figures(b)).toEqual(figures(a));
    const rows = await db()
      .select()
      .from(analyticsDashboardSnapshots)
      .where(eq(analyticsDashboardSnapshots.workspaceId, f.ws.workspaceId));
    expect(rows).toHaveLength(2);
  });

  it('checks permissions before serving: a member who lost the dashboard gets 403 although a snapshot exists', async () => {
    const f = await insightsFixture();
    await seedViews(f, '400');
    const analyst = await memberOf(f, 'analyst');
    const params = { ...f.p, tab: TAB };
    await analyst.client.call(A.dashboard, { params, query: QUERY });
    expect((await analyst.client.call(A.dashboard, { params, query: QUERY })).snapshot?.live).toBe(false);
    const [grant] = await db()
      .select()
      .from(roleAssignments)
      .where(eq(roleAssignments.membershipId, analyst.membershipId));
    await f.owner.call(
      teamEndpoints.revokeRole,
      { params: { ...f.p, assignmentId: grant!.id }, body: { reason: 'Changed team' } },
      { ifMatch: grant!.rowVersion },
    );
    expect((await analyst.client.attempt(A.dashboard, { params, query: QUERY })).status).toBe(403);
    // The worker drops snapshots whose member lost the tab instead of refreshing them.
    await refreshDashboardSnapshots(getAppServices(), { workspaceId: f.ws.workspaceId });
    const left = await db()
      .select()
      .from(analyticsDashboardSnapshots)
      .where(
        and(
          eq(analyticsDashboardSnapshots.workspaceId, f.ws.workspaceId),
          eq(analyticsDashboardSnapshots.membershipId, analyst.membershipId),
        ),
      );
    expect(left).toHaveLength(0);
  });

  it('keeps availability semantics: an empty workspace is served as empty with no fabricated values', async () => {
    const f = await insightsFixture();
    const params = { ...f.p, tab: 'production' as const };
    await f.owner.call(A.dashboard, { params, query: QUERY });
    const served = await f.owner.call(A.dashboard, { params, query: QUERY });
    expect(served.snapshot?.live).toBe(false);
    expect(served.empty).toBe(true);
    expect(figures(served)).toEqual(figures(await live(f, f.ws.owner.membershipId, 'production')));
    for (const k of served.kpis)
      expect(k.value.value === null || (Number(k.value.value) === 0 && (k.value.sampleSize ?? 0) === 0)).toBe(
        true,
      );
  });
});
