import { beforeAll, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { and, count, eq } from 'drizzle-orm';
import { newIdempotencyKey } from '@castlane/api-client';
import { importEndpoints, projectEndpoints } from '@castlane/api-contracts';
import { defineImportDataset, getAppServices } from '@castlane/application';
import { auditEvents, externalReferences, jobs, projects, tasks } from '@castlane/database';
import { AppError, newId } from '@castlane/domain';
import { addMember, clientFor, createDirection, createWorkspace, runQueuedJobs, sessionFor } from '../../support';
import { csv, db, uploadImport, validateImport } from './helpers';

/** Fake FX-rate dataset (registered by the test) to exercise typed columns and undo generically. */
beforeAll(() => {
  defineImportDataset<{ date: string; currency: string; rate: string }>({
    key: 'fx_rates',
    label: 'Test FX rates',
    permission: 'imports.create',
    duplicatePolicies: ['error', 'skip'],
    columns: [
      { key: 'date', label: 'Date', type: 'date', required: true },
      { key: 'currency', label: 'Currency', type: 'currency', required: true },
      { key: 'rate', label: 'Rate', type: 'decimal', required: true },
    ],
    async validate(ctx, row, opts) {
      const key = `${String(row.date)}:${String(row.currency)}`;
      const [dup] = await ('tx' in ctx ? (ctx as { tx: typeof getAppServices extends never ? never : ReturnType<typeof getAppServices>['db'] }).tx : ctx.app.db)
        .select({ id: externalReferences.id })
        .from(externalReferences)
        .where(and(eq(externalReferences.workspaceId, ctx.actor.workspaceId), eq(externalReferences.namespace, 'fx-test'), eq(externalReferences.externalId, key)));
      if (dup)
        return opts.duplicatePolicy === 'skip'
          ? { action: 'skip', normalized: row as never, errors: [], warnings: [{ field: 'date', code: 'EXISTS', message: 'Exists' }], dedupeKey: key }
          : { action: 'create', normalized: row as never, errors: [{ field: 'date', code: 'DUPLICATE', message: 'Rate already exists' }], warnings: [], dedupeKey: key };
      return { action: 'create', normalized: row as never, errors: [], warnings: [], dedupeKey: key };
    },
    async apply(ctx, row) {
      const id = newId();
      const at = ctx.app.clock.now();
      await ctx.tx.insert(externalReferences).values({ id, workspaceId: ctx.actor.workspaceId, createdAt: at, updatedAt: at, namespace: 'fx-test', externalId: `${row.date}:${row.currency}`, entityType: 'fx_rate', entityId: id });
      return id;
    },
    async undo(ctx, entityId) {
      const [r] = await ctx.tx.select().from(externalReferences).where(eq(externalReferences.id, entityId));
      if (!r) return;
      if (r.rowVersion !== 1) throw new AppError('INVALID_STATE', 'Changed after import');
      await ctx.tx.delete(externalReferences).where(eq(externalReferences.id, entityId));
    },
  });
});

const setup = async () => {
  const ws = await createWorkspace(db());
  const owner = await clientFor(await sessionFor(db(), ws.owner.userId));
  const directionId = await createDirection(db(), ws, 'AI Series');
  return { ws, owner, directionId, params: { workspaceId: ws.workspaceId } };
};

const projectCount = async (workspaceId: string) => Number((await db().select({ n: count() }).from(projects).where(eq(projects.workspaceId, workspaceId)))[0]!.n);

describe('Import Center — projects dataset', () => {
  it('parses CSV (BOM, semicolons), validates, commits atomically exactly once (T147)', async () => {
    const { ws, owner, params } = await setup();
    const file = csv([`﻿Project Name;Type;Direction;Owner;Tags`, `Night Shift;series;ai series;${ws.owner.email};thriller, noir`, `Harbor;Series;AI Series;${ws.owner.email};`]);
    const job = await uploadImport(owner, ws.workspaceId, { name: 'projects.csv', body: file });
    expect(job.state).toBe('parsed');
    expect(job.delimiter).toBe(';');
    expect(job.rowCount).toBe(2);
    expect(job.mapping).toMatchObject({ name: 'Project Name', type: 'Type', direction: 'Direction', owner: 'Owner', tags: 'Tags' });
    const v = await validateImport(owner, ws.workspaceId, job.id, undefined, { decimalSeparator: '.' });
    expect(v.state).toBe('validated');
    expect(v.validationReport!.totals).toMatchObject({ rows: 2, create: 2, errorRows: 0 });
    expect(await projectCount(ws.workspaceId)).toBe(0);

    const key = newIdempotencyKey();
    const commit = await owner.call(importEndpoints.commit, { params: { ...params, importId: job.id }, body: { validationToken: v.validationToken!, warningsAccepted: false } }, { idempotencyKey: key, ifMatch: v.rowVersion });
    expect(commit.state).toBe('committing');
    const replay = await owner.call(importEndpoints.commit, { params: { ...params, importId: job.id }, body: { validationToken: v.validationToken!, warningsAccepted: false } }, { idempotencyKey: key, ifMatch: v.rowVersion });
    expect(replay.id).toBe(commit.id);
    const second = await owner.attempt(importEndpoints.commit, { params: { ...params, importId: job.id }, body: { validationToken: v.validationToken!, warningsAccepted: false } }, { ifMatch: commit.rowVersion });
    expect(second.status).toBe(409);
    expect((await db().select().from(jobs).where(eq(jobs.type, 'imports.commit'))).length).toBe(1);
    await runQueuedJobs(['imports.commit']);
    const done = await owner.call(importEndpoints.get, { params: { ...params, importId: job.id } });
    expect(done.state).toBe('committed');
    expect(done.result).toMatchObject({ created: 2, updated: 0 });
    const rows = await db().select().from(projects).where(eq(projects.workspaceId, ws.workspaceId));
    expect(rows.map((r) => r.status)).toEqual(['draft', 'draft']);
    expect(rows.find((r) => r.name === 'Night Shift')!.tags).toEqual(['thriller', 'noir']);
    const audits = await db().select().from(auditEvents).where(and(eq(auditEvents.workspaceId, ws.workspaceId), eq(auditEvents.action, 'project.created')));
    expect(audits.every((a) => a.source === 'import' && a.actorKind === 'import')).toBe(true);
  });

  it('a validation error blocks Confirm and changes no domain rows (T145)', async () => {
    const { ws, owner, params } = await setup();
    const job = await uploadImport(owner, ws.workspaceId, { name: 'p.csv', body: csv(['Name,Type,Direction,Owner', `Good,series,AI Series,${ws.owner.email}`, `Bad,series,Unknown Direction,${ws.owner.email}`]) });
    const v = await validateImport(owner, ws.workspaceId, job.id);
    expect(v.validationReport!.totals).toMatchObject({ rows: 2, errorRows: 1 });
    expect(v.validationReport!.byIssue[0]).toMatchObject({ field: 'direction', code: 'UNKNOWN_REFERENCE', severity: 'error' });
    const r = await owner.attempt(importEndpoints.commit, { params: { ...params, importId: job.id }, body: { validationToken: v.validationToken!, warningsAccepted: true } }, { ifMatch: v.rowVersion });
    expect(r.status).toBe(409);
    expect(await projectCount(ws.workspaceId)).toBe(0);
    const rows = await owner.call(importEndpoints.rows, { params: { ...params, importId: job.id }, query: { status: ['error'] } });
    expect(rows.items.map((i) => i.rowNo)).toEqual([2]);
    // Full error report is downloadable.
    const res = await owner.raw('GET', `/workspaces/${ws.workspaceId}/imports/${job.id}/error-report`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('UNKNOWN_REFERENCE');
  });

  it('targets changed after validation → Needs Revalidation with zero partial commit (T146)', async () => {
    const { ws, owner, directionId, params } = await setup();
    const existing = await owner.call(projectEndpoints.create, { params, body: { name: 'Existing', type: 'series', directionId, ownerMembershipId: ws.owner.membershipId } });
    const job = await uploadImport(owner, ws.workspaceId, { name: 'p.csv', body: csv(['Name,Type,Direction,Owner,Brief Summary', `Brand New,series,AI Series,${ws.owner.email},`, `Existing,,,,Updated brief`]) });
    const v = await validateImport(owner, ws.workspaceId, job.id, undefined, { duplicatePolicy: 'revise_existing' });
    expect(v.validationReport!.totals).toMatchObject({ create: 1, update: 1, errorRows: 0 });
    // Someone edits the target after validation.
    await owner.call(projectEndpoints.update, { params: { ...params, projectId: existing.id }, body: { description: 'Edited meanwhile' } }, { ifMatch: existing.rowVersion });
    await owner.call(importEndpoints.commit, { params: { ...params, importId: job.id }, body: { validationToken: v.validationToken!, warningsAccepted: false } }, { ifMatch: v.rowVersion });
    await runQueuedJobs(['imports.commit']);
    const after = await owner.call(importEndpoints.get, { params: { ...params, importId: job.id } });
    expect(after.state).toBe('needs_revalidation');
    expect(after.errorMessage).toMatch(/Validate again before importing/);
    expect(await projectCount(ws.workspaceId)).toBe(1); // "Brand New" was not created
    // Re-validate and commit succeeds.
    const v2 = await validateImport(owner, ws.workspaceId, job.id, undefined, { duplicatePolicy: 'revise_existing' });
    await owner.call(importEndpoints.commit, { params: { ...params, importId: job.id }, body: { validationToken: v2.validationToken!, warningsAccepted: false } }, { ifMatch: v2.rowVersion });
    await runQueuedJobs(['imports.commit']);
    expect(await projectCount(ws.workspaceId)).toBe(2);
    const [updated] = await db().select().from(projects).where(eq(projects.id, existing.id));
    expect(updated!.briefSummary).toBe('Updated brief');
    expect(updated!.description).toBe('Edited meanwhile');
  });

  it('duplicate policies: error, skip; duplicates inside the file are caught', async () => {
    const { ws, owner, directionId, params } = await setup();
    await owner.call(projectEndpoints.create, { params, body: { name: 'Taken', type: 'series', directionId, ownerMembershipId: ws.owner.membershipId } });
    const job = await uploadImport(owner, ws.workspaceId, { name: 'p.csv', body: csv(['Name,Type,Direction,Owner', `Taken,series,AI Series,${ws.owner.email}`, `Twice,series,AI Series,${ws.owner.email}`, `twice,series,AI Series,${ws.owner.email}`]) });
    const asError = await validateImport(owner, ws.workspaceId, job.id);
    expect(asError.validationReport!.byIssue.map((i) => i.code).sort()).toEqual(['DUPLICATE', 'DUPLICATE_IN_FILE']);
    const asSkip = await validateImport(owner, ws.workspaceId, job.id, undefined, { duplicatePolicy: 'skip' });
    expect(asSkip.validationReport!.totals).toMatchObject({ create: 1, skip: 2, errorRows: 0 });
    expect(asSkip.validationReport!.reportNo).toBe(2);
    const commit = await owner.attempt(importEndpoints.commit, { params: { ...params, importId: job.id }, body: { validationToken: asSkip.validationToken!, warningsAccepted: false } }, { ifMatch: asSkip.rowVersion });
    expect(commit.status).toBe(422); // warnings must be acknowledged
    await owner.call(importEndpoints.commit, { params: { ...params, importId: job.id }, body: { validationToken: asSkip.validationToken!, warningsAccepted: true } }, { ifMatch: asSkip.rowVersion });
    await runQueuedJobs(['imports.commit']);
    expect(await projectCount(ws.workspaceId)).toBe(2);
  });

  it('Undo Import shows obstacles and never deletes related facts (T150)', async () => {
    const { ws, owner, params } = await setup();
    const job = await uploadImport(owner, ws.workspaceId, { name: 'p.csv', body: csv(['Name,Type,Direction,Owner', `First,series,AI Series,${ws.owner.email}`, `Second,series,AI Series,${ws.owner.email}`]) });
    const v = await validateImport(owner, ws.workspaceId, job.id);
    await owner.call(importEndpoints.commit, { params: { ...params, importId: job.id }, body: { validationToken: v.validationToken!, warningsAccepted: false } }, { ifMatch: v.rowVersion });
    await runQueuedJobs(['imports.commit']);
    const [first] = await db().select().from(projects).where(and(eq(projects.workspaceId, ws.workspaceId), eq(projects.name, 'First')));
    const at = new Date();
    await db().insert(tasks).values({ id: newId(), workspaceId: ws.workspaceId, projectId: first!.id, title: 'Depends on First', createdAt: at, updatedAt: at });
    const preview = await owner.call(importEndpoints.undoPreview, { params: { ...params, importId: job.id }, body: { reason: 'Wrong file' } });
    expect(preview.removable.map((r) => r.title)).toEqual(['Second']);
    expect(preview.obstacles).toHaveLength(1);
    expect(preview.obstacles[0]!.reason).toMatch(/1 tasks/);
    // The preview itself changed nothing.
    expect((await db().select().from(projects).where(eq(projects.workspaceId, ws.workspaceId))).every((p) => p.deletedAt === null)).toBe(true);
    const cur = await owner.call(importEndpoints.get, { params: { ...params, importId: job.id } });
    const undone = await owner.call(importEndpoints.undo, { params: { ...params, importId: job.id }, body: { previewToken: preview.token } }, { ifMatch: cur.rowVersion });
    expect(undone.state).toBe('undone');
    expect(undone.result!.undo).toMatchObject({ removed: 1, kept: 1 });
    const all = await db().select().from(projects).where(eq(projects.workspaceId, ws.workspaceId));
    expect(all.find((p) => p.name === 'Second')!.deletedAt).not.toBeNull();
    expect(all.find((p) => p.name === 'First')!.deletedAt).toBeNull();
    expect((await db().select().from(tasks).where(eq(tasks.projectId, first!.id))).length).toBe(1);
    const again = await owner.attempt(importEndpoints.undo, { params: { ...params, importId: job.id }, body: { previewToken: preview.token } }, { ifMatch: undone.rowVersion });
    expect(again.status).toBe(409);
  });

  it('enforces access: commit needs imports.commit; other members cannot see the job; limits apply', async () => {
    const { ws, owner, params } = await setup();
    const lead = await addMember(db(), ws, { roleKey: 'direction_lead', scopeType: 'workspace' });
    const c = await clientFor(await sessionFor(db(), lead.userId));
    const job = await uploadImport(c, ws.workspaceId, { name: 'p.csv', body: csv(['Name,Type,Direction,Owner', `Lead Project,series,AI Series,${ws.owner.email}`]) });
    const v = await validateImport(c, ws.workspaceId, job.id);
    const denied = await c.attempt(importEndpoints.commit, { params: { ...params, importId: job.id }, body: { validationToken: v.validationToken!, warningsAccepted: false } }, { ifMatch: v.rowVersion });
    expect(denied.status).toBe(403);
    const creator = await addMember(db(), ws, { roleKey: 'creator', scopeType: 'assigned_projects' });
    const cc = await clientFor(await sessionFor(db(), creator.userId));
    expect((await cc.attempt(importEndpoints.get, { params: { ...params, importId: job.id } })).status).toBe(403);
    const analyst = await addMember(db(), ws, { roleKey: 'analyst', scopeType: 'workspace' });
    const ac = await clientFor(await sessionFor(db(), analyst.userId));
    expect((await ac.call(importEndpoints.datasets, { params })).map((d) => d.key)).not.toContain('projects');
    // The owner (imports.commit) can see and confirm it.
    await owner.call(importEndpoints.commit, { params: { ...params, importId: job.id }, body: { validationToken: v.validationToken!, warningsAccepted: false } }, { ifMatch: v.rowVersion });
    const tooBig = await owner.attempt(importEndpoints.initiateUpload, { params, body: { filename: 'big.csv', byteSize: 20 * 1024 * 1024 + 1 } });
    expect(tooBig.status).toBe(413);
    const macro = await owner.attempt(importEndpoints.initiateUpload, { params, body: { filename: 'm.xlsm', byteSize: 100 } });
    expect(macro.status).toBe(422);
  });

  it('re-parses with an explicit delimiter, saves mappings and cancels without side effects', async () => {
    const { ws, owner, params } = await setup();
    const job = await uploadImport(owner, ws.workspaceId, { name: 'p.csv', body: csv(['Name;Type', 'A;series']) });
    const cur = await owner.call(importEndpoints.reparse, { params: { ...params, importId: job.id }, body: { delimiter: ',' } }, { ifMatch: job.rowVersion });
    expect(cur.state).toBe('uploaded');
    await runQueuedJobs(['imports.parse']);
    const re = await owner.call(importEndpoints.get, { params: { ...params, importId: job.id } });
    expect(re.headers).toEqual(['Name;Type']);
    expect(re.delimiter).toBe(',');
    await owner.call(importEndpoints.saveMapping, { params: { ...params, dataset: 'projects' }, body: { name: 'Agency sheet', mapping: { name: 'Project', owner: 'Owner Email' } } });
    const maps = await owner.call(importEndpoints.mappings, { params: { ...params, dataset: 'projects' } });
    expect(maps.map((m) => m.name)).toEqual(['Agency sheet']);
    const cancelled = await owner.call(importEndpoints.cancel, { params: { ...params, importId: job.id }, body: {} }, { ifMatch: re.rowVersion });
    expect(cancelled.state).toBe('cancelled');
    expect(await projectCount(ws.workspaceId)).toBe(0);
  });
});

describe('Import Center — typed columns and XLSX', () => {
  it('never guesses ambiguous numbers or dates; an explicit format resolves them (T149)', async () => {
    const { ws, owner } = await setup();
    const job = await uploadImport(owner, ws.workspaceId, { name: 'fx.csv', body: csv(['Date,Currency,Rate', '01/02/2026,usd,"1,234"']) }, 'fx_rates');
    const v = await validateImport(owner, ws.workspaceId, job.id);
    const codes = v.validationReport!.byIssue.map((i) => i.code).sort();
    expect(codes).toEqual(['AMBIGUOUS_NUMBER', 'DATE_FORMAT']);
    const fixed = await validateImport(owner, ws.workspaceId, job.id, undefined, { dateFormat: 'dd/mm/yyyy', decimalSeparator: ',' });
    expect(fixed.validationReport!.totals.errorRows).toBe(0);
    const [row] = (await owner.call(importEndpoints.rows, { params: { workspaceId: ws.workspaceId, importId: job.id }, query: {} })).items;
    expect(row!.mapped).toMatchObject({ date: '2026-02-01', currency: 'USD', rate: '1.234' });
  });

  it('XLSX formulas are never evaluated; cached values need confirmation and are labelled (T152)', async () => {
    const { ws, owner, params } = await setup();
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet('Rates');
    sheet.addRow(['Date', 'Currency', 'Rate']);
    sheet.addRow(['2026-10-01', 'USD', { formula: '1/0.9', result: 1.1 }]);
    sheet.addRow(['2026-10-02', 'USD', 1.2]);
    const job = await uploadImport(owner, ws.workspaceId, { name: 'rates.xlsx', body: Buffer.from(await wb.xlsx.writeBuffer()) }, 'fx_rates');
    expect(job.hasFormulaCells).toBe(true);
    const unconfirmed = await validateImport(owner, ws.workspaceId, job.id);
    expect(unconfirmed.validationReport!.byIssue[0]).toMatchObject({ code: 'CACHED_FORMULA_NOT_CONFIRMED', severity: 'error' });
    const confirmed = await validateImport(owner, ws.workspaceId, job.id, undefined, { acceptCachedFormulaValues: true });
    expect(confirmed.validationReport!.totals).toMatchObject({ errorRows: 0, warningRows: 1, cachedFormulaValues: 1 });
    expect(confirmed.validationReport!.byIssue[0]!.message).toMatch(/Cached Formula Value/);
    await owner.call(importEndpoints.commit, { params: { ...params, importId: job.id }, body: { validationToken: confirmed.validationToken!, warningsAccepted: true } }, { ifMatch: confirmed.rowVersion });
    await runQueuedJobs(['imports.commit']);
    const refs = await db().select().from(externalReferences).where(eq(externalReferences.workspaceId, ws.workspaceId));
    expect(refs.map((r) => r.externalId).sort()).toEqual(['2026-10-01:USD', '2026-10-02:USD']);

    const noCache = new ExcelJS.Workbook();
    const s2 = noCache.addWorksheet('Rates');
    s2.addRow(['Date', 'Currency', 'Rate']);
    s2.addRow(['2026-10-03', 'EUR', { formula: 'RAND()' }]);
    const j2 = await uploadImport(owner, ws.workspaceId, { name: 'nocache.xlsx', body: Buffer.from(await noCache.xlsx.writeBuffer()) }, 'fx_rates');
    const v2 = await validateImport(owner, ws.workspaceId, j2.id, undefined, { acceptCachedFormulaValues: true });
    expect(v2.validationReport!.byIssue[0]).toMatchObject({ code: 'FORMULA_WITHOUT_CACHED_VALUE', severity: 'error' });
  });

  it('warns when the same file was already imported and applies the duplicate policy', async () => {
    const { ws, owner, params } = await setup();
    const body = csv(['Date,Currency,Rate', '2026-10-05,EUR,1.0']);
    const a = await uploadImport(owner, ws.workspaceId, { name: 'fx.csv', body }, 'fx_rates');
    const va = await validateImport(owner, ws.workspaceId, a.id);
    await owner.call(importEndpoints.commit, { params: { ...params, importId: a.id }, body: { validationToken: va.validationToken!, warningsAccepted: false } }, { ifMatch: va.rowVersion });
    await runQueuedJobs(['imports.commit']);
    const b = await uploadImport(owner, ws.workspaceId, { name: 'fx.csv', body }, 'fx_rates');
    const vb = await validateImport(owner, ws.workspaceId, b.id, undefined, { duplicatePolicy: 'skip' });
    expect(vb.validationReport!.byIssue.map((i) => i.code)).toContain('FILE_ALREADY_IMPORTED');
    expect(vb.validationReport!.totals).toMatchObject({ skip: 1, create: 0 });
  });
});
