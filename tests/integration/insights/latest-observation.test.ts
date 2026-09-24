import { accountEndpoints, projectEndpoints } from '@castlane/api-contracts';
import { metricObservations } from '@castlane/database';
import { and, eq, max, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { at, db, insightsFixture, record, snapshotBody } from './helpers';

// Project and account lists show when metrics were last observed. The lookup probes the latest
// usable observation per row; it must agree with the aggregate over all observations.
describe('latest observation on project and account lists', () => {
  it('shows the newest usable observation, skips rejected and superseded ones, and agrees with the aggregate', async () => {
    const f = await insightsFixture();
    await record(f.owner, f, snapshotBody(f.accountId, at(9), { 'account.followers': '90' }));
    await record(f.owner, f, snapshotBody(f.accountId, at(5), { 'account.followers': '100' }));
    const newest = await record(f.owner, f, snapshotBody(f.accountId, at(2), { 'account.followers': '120' }));
    // The newest one is rejected afterwards: the lists fall back to the one before it.
    await db().update(metricObservations).set({ qualityState: 'rejected' }).where(eq(metricObservations.id, newest.id));

    const projects = await f.owner.call(projectEndpoints.list, { params: f.p, query: {} });
    const accounts = await f.owner.call(accountEndpoints.list, { params: f.p, query: {} });
    const project = projects.items.find((p) => p.id === f.projectId)!;
    const otherProject = projects.items.find((p) => p.id === f.otherProjectId)!;
    const account = accounts.items.find((a) => a.id === f.accountId)!;
    const otherAccount = accounts.items.find((a) => a.id === f.otherAccountId)!;
    expect(project.metricsUpdatedAt).toBe(at(5));
    expect(account.lastMetricsAt).toBe(at(5));
    // Nothing observed is unknown (null), never a date.
    expect(otherProject.metricsUpdatedAt).toBeNull();
    expect(otherAccount.lastMetricsAt).toBeNull();

    const usable = and(eq(metricObservations.workspaceId, f.ws.workspaceId), sql`${metricObservations.qualityState} NOT IN ('superseded', 'rejected')`);
    const byProject = await db().select({ id: metricObservations.projectId, last: max(metricObservations.observedAt) }).from(metricObservations).where(usable).groupBy(metricObservations.projectId);
    const byAccount = await db().select({ id: metricObservations.accountId, last: max(metricObservations.observedAt) }).from(metricObservations).where(usable).groupBy(metricObservations.accountId);
    const aggregate = (rows: { id: string | null; last: Date | null }[], id: string) => rows.find((r) => r.id === id)?.last?.toISOString() ?? null;
    for (const p of projects.items) expect(p.metricsUpdatedAt, p.name).toBe(aggregate(byProject, p.id));
    for (const a of accounts.items) expect(a.lastMetricsAt, a.id).toBe(aggregate(byAccount, a.id));
  });
});
