import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { eq } from 'drizzle-orm';
import { newIdempotencyKey } from '@castlane/api-client';
import { exportEndpoints, projectEndpoints } from '@castlane/api-contracts';
import { defineExportDataset, getAppServices, runRetention } from '@castlane/application';
import { accessDenies, exportJobs, jobs } from '@castlane/database';
import { newId } from '@castlane/domain';
import { addMember, assignToProject, clientFor, createDirection, createWorkspace, resetClock, runQueuedJobs, sessionFor, setClock, type TestClient } from '../../support';
import { db } from './helpers';

beforeAll(() => {
  // A dataset that fails after writing some rows: the export must end Failed without a file (T154).
  defineExportDataset({
    key: 'test_failing',
    label: 'Failing test dataset',
    permission: 'projects.read',
    classification: 'normal',
    columns: [{ key: 'n', label: 'N', type: 'integer', default: true }],
    async *rows() {
      yield { n: 1 };
      yield { n: 2 };
      throw new Error('source unavailable');
    },
  });
});

afterEach(() => resetClock());

const setup = async () => {
  const ws = await createWorkspace(db());
  const owner = await clientFor(await sessionFor(db(), ws.owner.userId));
  const directionId = await createDirection(db(), ws, 'AI Series');
  const params = { workspaceId: ws.workspaceId };
  const make = (name: string) => owner.call(projectEndpoints.create, { params, body: { name, type: 'series', directionId, ownerMembershipId: ws.owner.membershipId } });
  return { ws, owner, params, make, directionId };
};

const download = async (c: TestClient, workspaceId: string, exportId: string) => {
  const link = await c.call(exportEndpoints.download, { params: { workspaceId, exportId } });
  const res = await c.raw('GET', link.url.replace('/api/v1', ''));
  return { res, link };
};

describe('Export Center (S54)', () => {
  it('neutralises spreadsheet formulas in CSV and XLSX without breaking numeric columns (T151)', async () => {
    const { ws, owner, params, make } = await setup();
    await make('=HYPERLINK("http://evil.example","open")');
    await make('+SUM(1,2)');
    const req = await owner.call(exportEndpoints.create, { params, body: { dataset: 'projects', format: 'csv', fields: ['name', 'openTasks'], filters: {} } });
    expect(req.state).toBe('queued');
    await runQueuedJobs(['exports.generate']);
    const done = await owner.call(exportEndpoints.get, { params: { ...params, exportId: req.id } });
    expect(done.state).toBe('completed');
    expect(done.expiresAt).not.toBeNull();
    const { res } = await download(owner, ws.workspaceId, req.id);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toMatch(/attachment/);
    const text = await res.text();
    expect(text).toContain(`"'=HYPERLINK(""http://evil.example"",""open"")",0`);
    expect(text).toContain(`"'+SUM(1,2)",0`);

    const x = await owner.call(exportEndpoints.create, { params, body: { dataset: 'projects', format: 'xlsx', fields: ['name', 'openTasks'], filters: {} } });
    await runQueuedJobs(['exports.generate']);
    const xr = await download(owner, ws.workspaceId, x.id);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await xr.res.arrayBuffer()) as unknown as ArrayBuffer);
    const sheet = wb.worksheets[0]!;
    const values = [2, 3].map((r) => [sheet.getRow(r).getCell(1).value, sheet.getRow(r).getCell(2).value]);
    for (const [name, open] of values) {
      expect(typeof name).toBe('string');
      expect(String(name).startsWith("'")).toBe(true);
      expect(open).toBe(0);
    }
  });

  it('re-checks access at download time; a revoked member cannot use old or new links (T153)', async () => {
    const { ws, params, make } = await setup();
    const p = await make('Scoped');
    const lead = await addMember(db(), ws, { roleKey: 'project_lead', scopeType: 'assigned_projects' });
    await assignToProject(db(), ws, p.id, lead.membershipId);
    const c = await clientFor(await sessionFor(db(), lead.userId));
    const req = await c.call(exportEndpoints.create, { params, body: { dataset: 'projects', format: 'csv', fields: ['id', 'name'], filters: {} } });
    await runQueuedJobs(['exports.generate']);
    const link = await c.call(exportEndpoints.download, { params: { ...params, exportId: req.id } });
    const at = new Date();
    await db().insert(accessDenies).values({ id: newId(), workspaceId: ws.workspaceId, membershipId: lead.membershipId, permission: 'exports.download', reason: 'Offboarding', createdAt: at, updatedAt: at });
    const c2 = await clientFor(await sessionFor(db(), lead.userId));
    const old = await c2.raw('GET', link.url.replace('/api/v1', ''));
    expect(old.status).toBe(403);
    const fresh = await c2.attempt(exportEndpoints.download, { params: { ...params, exportId: req.id } });
    expect(fresh.status).toBe(403);
  });

  it('only the requester downloads; links are short-lived; the scope boundary is fixed at request time', async () => {
    const { ws, owner, params, make } = await setup();
    await make('Before');
    const lead = await addMember(db(), ws, { roleKey: 'direction_lead', scopeType: 'workspace' });
    const c = await clientFor(await sessionFor(db(), lead.userId));
    const req = await c.call(exportEndpoints.create, { params, body: { dataset: 'projects', format: 'csv', fields: ['name'], filters: {} } });
    await make('After');
    await runQueuedJobs(['exports.generate']);
    const { res, link } = await download(c, ws.workspaceId, req.id);
    const text = await res.text();
    expect(text).toContain('Before');
    expect(text).not.toContain('After');
    // Administrators see the job, but only the requester may download it.
    const listed = await owner.call(exportEndpoints.list, { params, query: {} });
    expect(listed.items.find((i) => i.id === req.id)!.permissions.download).toBe(false);
    expect((await owner.attempt(exportEndpoints.download, { params: { ...params, exportId: req.id } })).status).toBe(403);
    setClock(new Date(Date.now() + 6 * 60_000));
    expect((await c.raw('GET', link.url.replace('/api/v1', ''))).status).toBe(403);
  });

  it('gates sensitive columns, enforces quotas and cancels without leaving files', async () => {
    const { ws, owner, params } = await setup();
    const lead = await addMember(db(), ws, { roleKey: 'direction_lead', scopeType: 'workspace' });
    const c = await clientFor(await sessionFor(db(), lead.userId));
    const datasets = await c.call(exportEndpoints.datasets, { params });
    const budget = datasets.find((d) => d.key === 'projects')!.columns.find((col) => col.key === 'budgetPlanned')!;
    expect(budget).toMatchObject({ sensitive: true, available: false });
    expect((await c.attempt(exportEndpoints.create, { params, body: { dataset: 'projects', format: 'csv', fields: ['name', 'budgetPlanned'], filters: {} } })).status).toBe(403);
    expect(datasets.map((d) => d.key)).not.toContain('audit_events');
    for (let i = 0; i < 5; i++) await owner.call(exportEndpoints.create, { params, body: { dataset: 'projects', format: 'csv', fields: ['name'], filters: {} } });
    const sixth = await owner.attempt(exportEndpoints.create, { params, body: { dataset: 'projects', format: 'csv', fields: ['name'], filters: {} } });
    expect(sixth.code).toBe('QUOTA_EXCEEDED');
    const queued = (await owner.call(exportEndpoints.list, { params, query: { mine: true } })).items[0]!;
    const cancelled = await owner.call(exportEndpoints.cancel, { params: { ...params, exportId: queued.id } }, { ifMatch: queued.rowVersion });
    expect(cancelled.state).toBe('cancelled');
    const [job] = await db().select().from(jobs).where(eq(jobs.id, (await db().select().from(exportJobs).where(eq(exportJobs.id, queued.id)))[0]!.jobId!));
    expect(job!.cancelRequested).toBe(true);
    await runQueuedJobs(['exports.generate']);
    const [row] = await db().select().from(exportJobs).where(eq(exportJobs.id, queued.id));
    expect(row!.state).toBe('cancelled');
    expect(row!.storageKey).toBeNull();
  });

  it('a failed export never yields an empty "completed" file and can be retried (T154)', async () => {
    const { owner, params } = await setup();
    const key = newIdempotencyKey();
    const req = await owner.call(exportEndpoints.create, { params, body: { dataset: 'test_failing', format: 'csv', fields: ['n'], filters: {} } }, { idempotencyKey: key });
    const replay = await owner.call(exportEndpoints.create, { params, body: { dataset: 'test_failing', format: 'csv', fields: ['n'], filters: {} } }, { idempotencyKey: key });
    expect(replay.id).toBe(req.id);
    await runQueuedJobs(['exports.generate']);
    const failed = await owner.call(exportEndpoints.get, { params: { ...params, exportId: req.id } });
    expect(failed.state).toBe('failed');
    expect(failed.byteSize).toBeNull();
    expect(failed.fileName).toBeNull();
    expect(failed.permissions.retry).toBe(true);
    expect((await owner.attempt(exportEndpoints.download, { params: { ...params, exportId: req.id } })).status).toBe(409);
    const retried = await owner.call(exportEndpoints.retry, { params: { ...params, exportId: req.id } }, { ifMatch: failed.rowVersion });
    expect(retried.state).toBe('queued');
  });

  it('expires files after 7 days and previews permitted sample rows', async () => {
    const { owner, params, make } = await setup();
    await make('=cmd|calc');
    const preview = await owner.call(exportEndpoints.preview, { params, body: { dataset: 'projects', fields: ['name', 'status'], filters: {} } });
    expect(preview.rows[0]!.name).toBe("'=cmd|calc");
    const req = await owner.call(exportEndpoints.create, { params, body: { dataset: 'projects', format: 'csv', fields: ['name'], filters: {} } });
    await runQueuedJobs(['exports.generate']);
    const [before] = await db().select().from(exportJobs).where(eq(exportJobs.id, req.id));
    expect(await getAppServices().storage.headObject(before!.storageKey!)).not.toBeNull();
    setClock(new Date(Date.now() + 8 * 86_400_000));
    await runRetention(getAppServices());
    const [after] = await db().select().from(exportJobs).where(eq(exportJobs.id, req.id));
    expect(after!.state).toBe('expired');
    expect(await getAppServices().storage.headObject(before!.storageKey!)).toBeNull();
  });
});
