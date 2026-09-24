import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { reportEndpoints as R, type ReportConfigInput } from '@castlane/api-contracts';
import { EXPORT_DATASETS_REGISTRY, RESPONSIBILITY_PROVIDERS, executeCommand, getAppServices, memberJobContext, runDueReportSchedules } from '@castlane/application';
import { memberships, notifications, reportSchedules } from '@castlane/database';
import { at, db, insertApprovedTime, insertPublication, insertTask, insertTaskComment, insightsFixture, isoDay, memberOf, record, snapshotBody, type InsightsFixture } from './helpers';

const config = (extra: Partial<ReportConfigInput> = {}): ReportConfigInput => ({
  dataset: 'publications',
  dimensions: ['project'],
  metrics: ['M01'],
  filters: {},
  timeGrain: 'week',
  sort: [],
  chart: 'table',
  datePolicy: { kind: 'fixed', from: isoDay(10), to: isoDay(1) },
  ...extra,
});

const fieldCodes = (r: { error: unknown }) => ((r.error as { fieldErrors?: { code: string }[] } | null)?.fieldErrors ?? []).map((e) => e.code);

/** One publication on Alpha and two on Beta inside the report period. */
const publishBoth = async (f: InsightsFixture) => {
  await insertPublication(f, { publishedAt: at(4, 12) });
  await insertPublication(f, { projectId: f.otherProjectId, accountId: f.otherAccountId, publishedAt: at(4, 12) });
  await insertPublication(f, { projectId: f.otherProjectId, accountId: f.otherAccountId, publishedAt: at(3, 12) });
};

const rowsOf = (r: { rows: { dims: Record<string, { label: string }>; values: Record<string, { value: string | null }> }[] }, metric = 'M01') =>
  r.rows.map((x) => [x.dims.project?.label ?? null, x.values[metric]?.value ?? null]).sort();

describe('Report Builder (S52)', () => {
  it('aggregates each fact to the grain before joining: task comments never multiply time (T115)', async () => {
    const f = await insightsFixture();
    const busy = await insertTask(f, { assigneeMembershipId: f.ws.owner.membershipId });
    const quiet = await insertTask(f, { assigneeMembershipId: f.ws.owner.membershipId });
    await insertApprovedTime(f, busy, { membershipId: f.ws.owner.membershipId, workDate: isoDay(5), seconds: 2 * 3600 });
    await insertApprovedTime(f, busy, { membershipId: f.ws.owner.membershipId, workDate: isoDay(4), seconds: 3 * 3600 });
    await insertApprovedTime(f, quiet, { membershipId: f.ws.owner.membershipId, workDate: isoDay(4), seconds: 3600 });
    for (const d of [5, 4, 3]) await insertTaskComment(f, busy, at(d, 15));

    const preview = await f.owner.call(R.preview, { params: f.p, body: { config: config({ dataset: 'tasks', metrics: ['X03', 'X10'], dimensions: ['project'] }) } });
    expect(preview.columns.map((c) => c.key)).toEqual(['project', 'X03', 'X10']);
    expect(preview.rows).toHaveLength(1);
    expect(preview.rows[0]!.dims.project!.label).toBe('Model Alpha');
    expect(preview.rows[0]!.values.X03).toMatchObject({ status: 'known', value: '6.00' });
    expect(preview.rows[0]!.values.X10).toMatchObject({ status: 'known', value: '3' });
    expect(preview.totals.X03!.value).toBe('6.00');
    expect(preview.formulas.map((x) => x.key)).toEqual(['X03', 'X10']);

    const byMember = await f.owner.call(R.preview, { params: f.p, body: { config: config({ dataset: 'tasks', metrics: ['X03', 'X10'], dimensions: ['member', 'period'], timeGrain: 'day' }) } });
    const cell = (d: number) => byMember.rows.find((r) => r.dims.period!.id === isoDay(d))!;
    expect(byMember.rows.every((r) => r.dims.member!.id === f.ws.owner.membershipId)).toBe(true);
    expect([cell(5).values.X03!.value, cell(5).values.X10!.value]).toEqual(['2.00', '1']);
    expect([cell(4).values.X03!.value, cell(4).values.X10!.value]).toEqual(['4.00', '1']);
    expect(Number(cell(3).values.X03!.value)).toBe(0);
    expect(cell(3).values.X10!.value).toBe('1');
  });

  it('versions saved configurations, checks If-Match, duplicates and validates the join graph', async () => {
    const f = await insightsFixture();
    const created = await f.owner.call(R.create, { params: f.p, body: { name: 'Weekly publishing', config: config() } });
    expect(f.owner.lastStatus).toBe(201);
    expect(created).toMatchObject({ name: 'Weekly publishing', configVersion: 1, own: true, sharing: 'private', datasetAvailable: true });
    const noVersion = await f.owner.attempt(R.update, { params: { ...f.p, reportId: created.id }, body: { name: 'Renamed' } });
    expect(noVersion.status).toBe(428);
    const stale = await f.owner.attempt(R.update, { params: { ...f.p, reportId: created.id }, body: { name: 'Renamed' } }, { ifMatch: created.rowVersion + 3 });
    expect(stale.status).toBe(412);
    const updated = await f.owner.call(R.update, { params: { ...f.p, reportId: created.id }, body: { config: config({ dimensions: ['platform'] }), changeNote: 'By platform' } }, { ifMatch: created.rowVersion });
    expect(updated.configVersion).toBe(2);
    expect(updated.config.dimensions).toEqual(['platform']);
    const versions = await f.owner.call(R.versions, { params: { ...f.p, reportId: created.id } });
    expect(versions.map((v) => [v.versionNo, v.changeNote])).toEqual([
      [2, 'By platform'],
      [1, 'Created'],
    ]);
    expect(versions[1]!.config.dimensions).toEqual(['project']);
    const copy = await f.owner.call(R.duplicate, { params: { ...f.p, reportId: created.id }, body: {} });
    expect(copy).toMatchObject({ name: 'Copy of Weekly publishing', configVersion: 1, duplicatedFromId: created.id });
    const mine = await f.owner.call(R.list, { params: f.p, query: { scope: 'mine' } });
    expect(mine.items.map((r) => r.name).sort()).toEqual(['Copy of Weekly publishing', 'Weekly publishing']);

    const invalid = async (c: Partial<ReportConfigInput>) => fieldCodes(await f.owner.attempt(R.preview, { params: f.p, body: { config: config(c) } }));
    expect(await invalid({ metrics: ['X03'] })).toContain('NOT_IN_DATASET');
    expect(await invalid({ chart: 'line' })).toContain('NEEDS_PERIOD');
    expect(await invalid({ metrics: ['M01', 'M19'], chart: 'stacked_bar' })).toContain('NOT_ADDITIVE');
    expect(await invalid({ metrics: ['M14'], dimensions: ['project', 'category'] as never })).toContain('NOT_ALLOWED');
    const tooMany = await f.owner.attempt(R.preview, { params: f.p, body: { config: config({ dimensions: ['project', 'account', 'platform', 'format'] }) } });
    expect(tooMany.status).toBe(422);

    const archived = await f.owner.call(R.archive, { params: { ...f.p, reportId: copy.id }, body: { reason: 'Not needed' } }, { ifMatch: copy.rowVersion });
    expect(archived.archivedAt).not.toBeNull();
    expect((await f.owner.call(R.list, { params: f.p, query: { scope: 'mine' } })).items.map((r) => r.id)).toEqual([created.id]);
  });

  it('runs a shared report in each member’s own scope and requires a project filter for restricted datasets', async () => {
    const f = await insightsFixture();
    const analyst = await memberOf(f, 'analyst');
    const lead = await memberOf(f, 'project_lead', { projects: [f.projectId] });
    const viewer = await memberOf(f, 'viewer');
    await publishBoth(f);
    const report = await analyst.client.call(R.create, { params: f.p, body: { name: 'Publishing by project', config: config() } });
    const shared = await analyst.client.call(R.share, { params: { ...f.p, reportId: report.id }, body: { sharing: 'shared', memberIds: [lead.membershipId] } }, { ifMatch: report.rowVersion });
    expect(shared.sharedWith.map((m) => m.membershipId)).toEqual([lead.membershipId]);
    const note = await db().select().from(notifications).where(and(eq(notifications.workspaceId, f.ws.workspaceId), eq(notifications.recipientMembershipId, lead.membershipId), eq(notifications.eventType, 'report.shared')));
    expect(note).toHaveLength(1);

    const ownerRun = await analyst.client.call(R.run, { params: { ...f.p, reportId: report.id }, body: {} });
    expect(rowsOf(ownerRun)).toEqual([
      ['Model Alpha', '1'],
      ['Model Beta', '2'],
    ]);
    const leadRun = await lead.client.call(R.run, { params: { ...f.p, reportId: report.id }, body: {} });
    expect(rowsOf(leadRun)).toEqual([['Model Alpha', '1']]);
    expect(leadRun.scopeSummary).toContain('1 project(s)');
    const leadList = await lead.client.call(R.list, { params: f.p, query: { scope: 'shared' } });
    expect(leadList.items.map((r) => r.id)).toEqual([report.id]);
    const leadView = await lead.client.call(R.get, { params: { ...f.p, reportId: report.id } });
    expect(leadView.permissions.edit).toBe(false);
    expect((await lead.client.attempt(R.update, { params: { ...f.p, reportId: report.id }, body: { name: 'Mine now' } }, { ifMatch: leadView.rowVersion })).status).toBe(403);
    expect((await viewer.client.attempt(R.get, { params: { ...f.p, reportId: report.id } })).status).toBe(404);

    // Restricted dataset: sharing needs an explicit project filter.
    const fin = await f.owner.call(R.create, { params: f.p, body: { name: 'Margin', config: config({ dataset: 'finance', metrics: ['M36'], dimensions: ['project'] }) } });
    const refused = await f.owner.attempt(R.share, { params: { ...f.p, reportId: fin.id }, body: { sharing: 'shared', memberIds: [analyst.membershipId] } }, { ifMatch: fin.rowVersion });
    expect(fieldCodes(refused)).toContain('PROJECT_FILTER_REQUIRED');
    const limited = await f.owner.call(R.update, { params: { ...f.p, reportId: fin.id }, body: { config: config({ dataset: 'finance', metrics: ['M36'], dimensions: ['project'], filters: { projectIds: [f.projectId] } }) } }, { ifMatch: fin.rowVersion });
    const ok = await f.owner.call(R.share, { params: { ...f.p, reportId: fin.id }, body: { sharing: 'shared', memberIds: [analyst.membershipId] } }, { ifMatch: limited.rowVersion });
    expect(ok.sharing).toBe('shared');
    // The analyst has no finance access: the shared report does not open its data.
    const blocked = await analyst.client.call(R.get, { params: { ...f.p, reportId: fin.id } });
    expect(blocked.datasetAvailable).toBe(false);
    expect((await analyst.client.attempt(R.run, { params: { ...f.p, reportId: fin.id }, body: {} })).status).toBe(403);
  });

  it('saves immutable snapshots, marks them stale after source changes and exports a PDF', async () => {
    const f = await insightsFixture();
    const viewer = await memberOf(f, 'viewer');
    await publishBoth(f);
    const report = await f.owner.call(R.create, { params: f.p, body: { name: 'Snapshot test', config: config() } });
    const snap = await f.owner.call(R.snapshot, { params: { ...f.p, reportId: report.id }, body: {} });
    expect(snap).toMatchObject({ reportId: report.id, configVersion: 1, scheduled: false, stale: false, fromDate: isoDay(10), toDate: isoDay(1), rowCount: 2 });
    expect(snap.generatedFor.membershipId).toBe(f.ws.owner.membershipId);
    expect(rowsOf(snap.result)).toEqual([
      ['Model Alpha', '1'],
      ['Model Beta', '2'],
    ]);
    // Later changes do not alter the snapshot; they mark it stale.
    await record(f.owner, f, snapshotBody(f.accountId, at(1), { 'account.followers': '10' }));
    await insertPublication(f, { publishedAt: at(2, 12) });
    const again = await f.owner.call(R.snapshotGet, { params: { ...f.p, snapshotId: snap.id } });
    expect(again.stale).toBe(true);
    expect(rowsOf(again.result)).toEqual(rowsOf(snap.result));
    const list = await f.owner.call(R.reportSnapshots, { params: { ...f.p, reportId: report.id } });
    expect(list.map((s) => s.id)).toEqual([snap.id]);

    const res = await f.owner.raw('GET', `/workspaces/${f.ws.workspaceId}/report-snapshots/${snap.id}/pdf`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="Snapshot-test-\d{4}-\d{2}-\d{2}\.pdf"$/);
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
    expect(bytes.length).toBeGreaterThan(1500);

    // Snapshots belong to the member they were generated for; PDF export needs exports.download.
    expect((await viewer.client.attempt(R.snapshotGet, { params: { ...f.p, snapshotId: snap.id } })).status).toBe(404);
    expect((await viewer.client.raw('GET', `/workspaces/${f.ws.workspaceId}/report-snapshots/${snap.id}/pdf`)).status).toBe(403);

    // CSV/XLSX go through the export engine with the requester's own result.
    const ds = EXPORT_DATASETS_REGISTRY.get('report_result')!;
    const ctx = (await memberJobContext(getAppServices(), f.ws.workspaceId, f.ws.owner.membershipId))!;
    const out: Record<string, unknown>[] = [];
    for await (const row of ds.rows(ctx, { filters: { reportId: report.id }, boundAt: new Date(), fields: [] })) out.push(row);
    expect(out.filter((r) => r.row !== 0).map((r) => [r.dimension_1, r.value]).sort()).toEqual([
      ['Model Alpha', '2'],
      ['Model Beta', '2'],
    ]);
  });

  it('delivers scheduled reports per recipient with their own permissions into their Inbox (T116)', async () => {
    const f = await insightsFixture();
    const analyst = await memberOf(f, 'analyst', { name: 'Ana Analyst' });
    const lead = await memberOf(f, 'project_lead', { projects: [f.projectId] });
    const outsider = await memberOf(f, 'contractor');
    await publishBoth(f);
    const report = await analyst.client.call(R.create, { params: f.p, body: { name: 'Daily publishing', config: config() } });
    // Reports are shared explicitly: recipients must be on the share list.
    await analyst.client.call(R.share, { params: { ...f.p, reportId: report.id }, body: { sharing: 'shared', memberIds: [lead.membershipId] } }, { ifMatch: report.rowVersion });
    const bad = await analyst.client.attempt(R.scheduleCreate, { params: f.p, body: { reportId: report.id, cadence: 'daily', recipientMembershipIds: [outsider.membershipId], localTime: '08:00', timezone: 'UTC', emailNotify: false } });
    expect(fieldCodes(bad)).toContain('INVALID_RECIPIENT');
    const schedule = await analyst.client.call(R.scheduleCreate, {
      params: f.p,
      body: { reportId: report.id, cadence: 'daily', recipientMembershipIds: [analyst.membershipId, lead.membershipId], localTime: '08:00', timezone: 'UTC', emailNotify: true },
    });
    expect(schedule).toMatchObject({ status: 'active', cadence: 'daily', localTime: '08:00' });
    expect(new Date(schedule.nextRunAt).getTime()).toBeGreaterThan(Date.now());

    await db().update(reportSchedules).set({ nextRunAt: new Date(Date.now() - 60_000) }).where(eq(reportSchedules.id, schedule.id));
    await runDueReportSchedules(getAppServices());
    await runDueReportSchedules(getAppServices()); // nothing is due any more: no duplicates

    const leadSnaps = await lead.client.call(R.snapshots, { params: f.p, query: {} });
    expect(leadSnaps.items).toHaveLength(1);
    expect(leadSnaps.items[0]!.scheduled).toBe(true);
    const leadResult = await lead.client.call(R.snapshotGet, { params: { ...f.p, snapshotId: leadSnaps.items[0]!.id } });
    expect(rowsOf(leadResult.result)).toEqual([['Model Alpha', '1']]);
    expect(JSON.stringify(leadResult.result)).not.toContain('Model Beta');
    const ownSnaps = await analyst.client.call(R.snapshots, { params: f.p, query: {} });
    expect(ownSnaps.items).toHaveLength(1);
    const ownResult = await analyst.client.call(R.snapshotGet, { params: { ...f.p, snapshotId: ownSnaps.items[0]!.id } });
    expect(rowsOf(ownResult.result)).toEqual([
      ['Model Alpha', '1'],
      ['Model Beta', '2'],
    ]);
    expect((await lead.client.attempt(R.snapshotGet, { params: { ...f.p, snapshotId: ownSnaps.items[0]!.id } })).status).toBe(404);

    const inbox = await db().select().from(notifications).where(and(eq(notifications.workspaceId, f.ws.workspaceId), eq(notifications.eventType, 'report.scheduled_snapshot')));
    expect(inbox.map((n) => n.recipientMembershipId).sort()).toEqual([analyst.membershipId, lead.membershipId].sort());
    expect(inbox.every((n) => n.entityType === 'report_snapshot' && !(n.excerpt ?? '').includes('Beta'))).toBe(true);
    const after = await analyst.client.call(R.scheduleGet, { params: { ...f.p, scheduleId: schedule.id } });
    expect(after.lastRunResult).toMatchObject({ delivered: 2, skipped: [] });
    expect(new Date(after.nextRunAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('pauses schedules of a departed owner as Needs Owner until another member resumes them', async () => {
    const f = await insightsFixture();
    const analyst = await memberOf(f, 'analyst');
    const lead = await memberOf(f, 'project_lead', { projects: [f.projectId] });
    const report = await analyst.client.call(R.create, { params: f.p, body: { name: 'Owner handover', config: config() } });
    await analyst.client.call(R.share, { params: { ...f.p, reportId: report.id }, body: { sharing: 'shared', memberIds: [f.ws.owner.membershipId, lead.membershipId] } }, { ifMatch: report.rowVersion });
    const body = { reportId: report.id, cadence: 'weekly' as const, recipientMembershipIds: [analyst.membershipId], localTime: '09:00', timezone: 'UTC', emailNotify: false };
    const first = await analyst.client.call(R.scheduleCreate, { params: f.p, body });
    const second = await analyst.client.call(R.scheduleCreate, { params: f.p, body: { ...body, cadence: 'monthly' } });

    // Offboarding: the successor must be able to schedule and open the report; no successor → Needs Owner.
    const provider = RESPONSIBILITY_PROVIDERS.get('reports.schedule_owner')!;
    const ctx = (await memberJobContext(getAppServices(), f.ws.workspaceId, f.ws.owner.membershipId))!;
    expect((await provider.list(ctx, analyst.membershipId)).map((x) => x.entityId).sort()).toEqual([first.id, second.id].sort());
    await expect(executeCommand(ctx, (c) => provider.transfer(c, analyst.membershipId, [{ entityId: first.id, successorMembershipId: lead.membershipId }] as never))).rejects.toThrow(/successor cannot take over/);
    await executeCommand(ctx, (c) => provider.transfer(c, analyst.membershipId, [{ entityId: first.id, successorMembershipId: null }] as never));
    const paused = await f.owner.call(R.scheduleGet, { params: { ...f.p, scheduleId: first.id } });
    expect(paused.status).toBe('paused_needs_owner');
    expect(paused.pausedReason).toContain('Needs Owner');

    // A deactivated owner: the delivery job pauses instead of sending.
    await db().update(memberships).set({ status: 'deactivated' }).where(eq(memberships.id, analyst.membershipId));
    await db().update(reportSchedules).set({ nextRunAt: new Date(Date.now() - 60_000) }).where(eq(reportSchedules.id, second.id));
    await runDueReportSchedules(getAppServices());
    const second2 = await f.owner.call(R.scheduleGet, { params: { ...f.p, scheduleId: second.id } });
    expect(second2.status).toBe('paused_needs_owner');

    // Resuming takes the schedule over.
    const resumed = await f.owner.call(R.scheduleResume, { params: { ...f.p, scheduleId: second.id } }, { ifMatch: second2.rowVersion });
    expect(resumed.status).toBe('active');
    expect(resumed.owner.membershipId).toBe(f.ws.owner.membershipId);
  });
});
