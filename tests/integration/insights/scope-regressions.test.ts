import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { reportEndpoints as R, type ReportConfigInput } from '@castlane/api-contracts';
import { IMPORT_DATASETS_REGISTRY, executeCommand, getAppServices, memberJobContext, runDueReportSchedules } from '@castlane/application';
import { metricObservations, notifications, reportSchedules, reportSnapshots } from '@castlane/database';
import { at, db, insertPublication, insightsFixture, isoDay, memberOf, type InsightsFixture } from './helpers';

const config: ReportConfigInput = {
  dataset: 'publications',
  dimensions: ['project'],
  metrics: ['M01'],
  filters: {},
  timeGrain: 'week',
  sort: [],
  chart: 'table',
  datePolicy: { kind: 'fixed', from: isoDay(10), to: isoDay(1) },
};

const fieldCodes = (r: { error: unknown }) => ((r.error as { fieldErrors?: { code: string }[] } | null)?.fieldErrors ?? []).map((e) => e.code);

describe('scheduled report recipients', () => {
  it('must be on the report’s share list when scheduled and when the snapshot is sent', async () => {
    const f = await insightsFixture();
    const analyst = await memberOf(f, 'analyst');
    const lead = await memberOf(f, 'project_lead', { projects: [f.projectId] });
    await insertPublication(f, { publishedAt: at(4, 12) });
    const report = await analyst.client.call(R.create, { params: f.p, body: { name: 'Daily publishing', config } });
    const body = { reportId: report.id, cadence: 'daily' as const, recipientMembershipIds: [analyst.membershipId, lead.membershipId], localTime: '08:00', timezone: 'UTC', emailNotify: false };

    // The lead can open reports in general, but not this private report.
    const refused = await analyst.client.attempt(R.scheduleCreate, { params: f.p, body });
    expect(refused.status).toBe(422);
    expect(fieldCodes(refused)).toContain('INVALID_RECIPIENT');

    const shared = await analyst.client.call(R.share, { params: { ...f.p, reportId: report.id }, body: { sharing: 'shared', memberIds: [lead.membershipId] } }, { ifMatch: report.rowVersion });
    const schedule = await analyst.client.call(R.scheduleCreate, { params: f.p, body });

    // Unshared later: at send time the lead is skipped with the reason recorded; nothing is created for them.
    await analyst.client.call(R.share, { params: { ...f.p, reportId: report.id }, body: { sharing: 'private', memberIds: [] } }, { ifMatch: shared.rowVersion });
    await db().update(reportSchedules).set({ nextRunAt: new Date(Date.now() - 60_000) }).where(eq(reportSchedules.id, schedule.id));
    await runDueReportSchedules(getAppServices());
    const after = await analyst.client.call(R.scheduleGet, { params: { ...f.p, scheduleId: schedule.id } });
    expect(after.lastRunResult).toMatchObject({ delivered: 1, skipped: [{ membershipId: lead.membershipId, reason: 'Not on the report’s share list' }] });
    const snaps = await db().select({ forId: reportSnapshots.generatedForMembershipId }).from(reportSnapshots).where(eq(reportSnapshots.reportId, report.id));
    expect(snaps.map((x) => x.forId)).toEqual([analyst.membershipId]);
    const inbox = await db().select().from(notifications).where(and(eq(notifications.workspaceId, f.ws.workspaceId), eq(notifications.eventType, 'report.scheduled_snapshot')));
    expect(inbox.map((n) => n.recipientMembershipId)).toEqual([analyst.membershipId]);
  });
});

describe('metric observation import undo', () => {
  it('counts the correction chain inside the workspace only', async () => {
    const ds = IMPORT_DATASETS_REGISTRY.get('metric_observations')!;
    const imported = async (f: InsightsFixture) => {
      const ctx = (await memberJobContext(getAppServices(), f.ws.workspaceId, f.ws.owner.membershipId, { source: 'import' }))!;
      const row = { entity_type: 'account', entity: f.accountId, kind: 'snapshot', observed_at: at(3, 9), source_note: 'Weekly CSV export', 'account.followers': '1200' };
      const v = await ds.validate(ctx, row, { duplicatePolicy: 'error', rowNo: 1 });
      expect(v.errors).toEqual([]);
      return { ctx, id: (await executeCommand(ctx, (c) => ds.apply(c, v.normalized, { action: 'create' }))).body as string };
    };
    const a = await imported(await insightsFixture());
    const b = await imported(await insightsFixture());
    // A row of another workspace that carries the same root id (nothing ties the root to a workspace).
    await db().update(metricObservations).set({ rootObservationId: a.id }).where(eq(metricObservations.id, b.id));
    await executeCommand(a.ctx, (c) => ds.undo!(c, a.id));
    expect(await db().select().from(metricObservations).where(eq(metricObservations.id, a.id))).toHaveLength(0);
    expect(await db().select().from(metricObservations).where(eq(metricObservations.id, b.id))).toHaveLength(1);
  });
});
