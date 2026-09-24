import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { authEndpoints, exportEndpoints, importEndpoints } from '@castlane/api-contracts';
import { defineExportDataset, defineImportDataset, getAppServices, setAppServices, type Logger } from '@castlane/application';
import { auditEvents } from '@castlane/database';
import { clientFor, createWorkspace, runQueuedJobs, sessionFor, TestClient } from '../../support';
import { csv, db, uploadImport, validateImport } from './helpers';

const lines: string[] = [];
let original: Logger;

beforeAll(() => {
  const app = getAppServices();
  original = app.logger;
  const capture = (level: string) => (msg: string, meta?: Record<string, unknown>) => lines.push(JSON.stringify({ level, msg, ...meta }));
  setAppServices({ ...app, logger: { debug: capture('debug'), info: capture('info'), warn: capture('warn'), error: capture('error') } });
  defineExportDataset({
    key: 'test_secret_failure',
    label: 'Secret failure',
    permission: 'projects.read',
    classification: 'normal',
    columns: [{ key: 'v', label: 'V', type: 'text', default: true }],
    async *rows() {
      yield { v: 'ok' };
      throw new Error('contact note leaked: CONTACT-ALIAS-7781');
    },
  });
  defineImportDataset<{ note: string }>({
    key: 'sale_candidates',
    label: 'Test notes',
    permission: 'imports.create',
    duplicatePolicies: ['error'],
    columns: [{ key: 'note', label: 'Note', type: 'text', required: true }],
    async validate(_ctx, row) {
      return { action: 'create', normalized: { note: String(row.note) }, errors: [], warnings: [] };
    },
    async apply(_ctx, row) {
      throw new Error(`database rejected ${row.note}`);
    },
  });
});

afterAll(() => setAppServices({ ...getAppServices(), logger: original }));

describe('sensitive logs audit (T171)', () => {
  it('never writes passwords, tokens, signed URLs or imported/exported values to logs or audit', async () => {
    const ws = await createWorkspace(db());
    const owner = await clientFor(await sessionFor(db(), ws.owner.userId));
    const params = { workspaceId: ws.workspaceId };

    // Failed sign-in with a password that must never be stored or logged.
    const anon = await new TestClient().init();
    await anon.attempt(authEndpoints.signIn, { body: { email: ws.owner.email, password: 'Wrong Password 42!' } });

    // Export failure whose error message quotes data.
    const ex = await owner.call(exportEndpoints.create, { params, body: { dataset: 'test_secret_failure', format: 'csv', fields: ['v'], filters: {} } });
    await runQueuedJobs(['exports.generate']);
    expect((await owner.call(exportEndpoints.get, { params: { ...params, exportId: ex.id } })).state).toBe('failed');

    // Import commit failure whose error quotes a private note.
    const job = await uploadImport(owner, ws.workspaceId, { name: 'notes.csv', body: csv(['Note', 'PRIVATE-NOTE-5512']) }, 'sale_candidates');
    const v = await validateImport(owner, ws.workspaceId, job.id);
    await owner.call(importEndpoints.commit, { params: { ...params, importId: job.id }, body: { validationToken: v.validationToken!, warningsAccepted: false } }, { ifMatch: v.rowVersion });
    await runQueuedJobs(['imports.commit']);
    const failed = await owner.call(importEndpoints.get, { params: { ...params, importId: job.id } });
    expect(failed.state).toBe('failed');
    expect(failed.errorMessage).toMatch(/failed without changes/);

    // A download link (bearer secret) for a completed export.
    const ok = await owner.call(exportEndpoints.create, { params, body: { dataset: 'projects', format: 'csv', fields: ['id'], filters: {} } });
    await runQueuedJobs(['exports.generate']);
    const link = await owner.call(exportEndpoints.download, { params: { ...params, exportId: ok.id } });
    const token = new URL(link.url, 'http://x').searchParams.get('token')!;

    const logText = lines.join('\n');
    expect(lines.some((l) => l.includes('export_failed'))).toBe(true);
    expect(lines.some((l) => l.includes('import_commit_failed'))).toBe(true);
    for (const secret of ['Wrong Password 42!', 'CONTACT-ALIAS-7781', 'PRIVATE-NOTE-5512', token, 'castlane_session']) expect(logText).not.toContain(secret);

    const audits = await db().select().from(auditEvents).where(eq(auditEvents.workspaceId, ws.workspaceId));
    const auditText = JSON.stringify(audits);
    for (const secret of ['Wrong Password 42!', 'PRIVATE-NOTE-5512', token]) expect(auditText).not.toContain(secret);
  });
});
