import { Readable } from 'node:stream';
import ExcelJS from 'exceljs';
import { and, asc, desc, eq, gt, inArray, lt, or, sql } from 'drizzle-orm';
import { hasAnywhere } from '@castlane/authorization';
import { bulkPreviews, importJobs, importRows, jobs, savedViews, uploadSessions } from '@castlane/database';
import {
  AppError,
  assertTransition,
  clampPageSize,
  decodeCursor,
  encodeCursor,
  isAppError,
  newId,
  notFound,
  type EnumValue,
  type IMPORT_STATES,
  type TransitionTable,
} from '@castlane/domain';
import { requirePermission } from '../../core/access';
import { audit } from '../../core/audit';
import { executeCommand, executeSystemCommand } from '../../core/command';
import type { CommandContext, QueryContext } from '../../core/context';
import { dbOf } from '../../core/context';
import { sha256, stableStringify } from '../../core/crypto';
import { emit, streamEvent } from '../../core/events';
import { IMPORT_DATASETS_REGISTRY, type ImportDatasetDefinition, type ImportIssue } from '../../core/import-registry';
import { enqueueJob } from '../../core/jobs';
import { defineJob, memberJobContext } from '../../core/jobs-registry';
import { loadMemberRefs, refOrUnknown } from '../../core/members';
import { assertVersion, stamp, touch } from '../../core/rows';
import { csvLine, safeCell } from '../exports/writers';
import { IMPORT_MAPPING_MODULE } from '../saved-views';
import { coerceValue, suggestMapping, type CoerceOptions } from './coerce';
import { MAX_IMPORT_ROWS, formulaHeaders, parseImportFile, toStagedRaw, visibleRaw } from './parse';

type ImportState = EnumValue<typeof IMPORT_STATES>;
type ImportJobRow = typeof importJobs.$inferSelect;
type ImportRowRow = typeof importRows.$inferSelect;

export const IMPORT_MAX_BYTES = 20 * 1024 * 1024;
const PART_SIZE = 8 * 1024 * 1024;
const UPLOAD_TTL_MS = 24 * 3_600_000;
const COMMIT_BUDGET_MS = 10 * 60_000;
const UNDO_PREVIEW_TTL_MS = 10 * 60_000;

export interface ImportOptionsValue extends CoerceOptions {
  currency?: string;
  duplicatePolicy: 'skip' | 'revise_existing' | 'error';
  delimiter?: ',' | ';';
  acceptCachedFormulaValues?: boolean;
}

/** Import job lifecycle (section 22.1). Commit is the only step that changes domain data. */
export const IMPORT_TRANSITIONS: TransitionTable<ImportState> = {
  uploaded: ['parsed', 'failed', 'cancelled'],
  parsed: ['validating', 'uploaded', 'cancelled', 'failed'],
  validating: ['validated', 'failed', 'cancelled', 'validating'],
  validated: ['validating', 'committing', 'uploaded', 'cancelled'],
  needs_revalidation: ['validating', 'uploaded', 'cancelled'],
  committing: ['committed', 'needs_revalidation', 'failed'],
  committed: ['undone'],
  failed: ['validating', 'uploaded', 'cancelled'],
  cancelled: [],
  undone: [],
};

/** Entity type created by each dataset (for result links). */
export const IMPORT_DATASET_ENTITY: Record<string, string> = {
  projects: 'project',
  accounts: 'account',
  tasks: 'task',
  references: 'reference',
  metric_observations: 'metric_observation',
  ofm_contacts: 'ofm_contact',
  sale_candidates: 'sale_candidate',
  financial_drafts: 'financial_entry',
  fx_rates: 'fx_rate',
};

const datasetOf = (key: string): ImportDatasetDefinition => {
  const d = IMPORT_DATASETS_REGISTRY.get(key);
  if (!d) throw new AppError('VALIDATION_FAILED', 'This dataset cannot be imported yet.', { fieldErrors: [{ field: 'dataset', code: 'UNAVAILABLE', message: 'This dataset cannot be imported yet.' }] });
  return d;
};

const assertDatasetAccess = (ctx: QueryContext, d: ImportDatasetDefinition) => {
  requirePermission(ctx, 'imports.create');
  if (!hasAnywhere(ctx.actor.access, d.permission)) throw new AppError('FORBIDDEN', `You cannot import ${d.label.toLowerCase()}.`);
};

const canCommitImports = (ctx: QueryContext) => hasAnywhere(ctx.actor.access, 'imports.commit');

// ——— Datasets, templates, mappings ———

export const listImportDatasets = (ctx: QueryContext) => {
  requirePermission(ctx, 'imports.create');
  return [...IMPORT_DATASETS_REGISTRY.values()]
    .filter((d) => hasAnywhere(ctx.actor.access, d.permission))
    .map((d) => ({
      key: d.key,
      label: d.label,
      columns: d.columns.map((c) => ({ key: c.key, label: c.label, type: c.type, required: !!c.required, enumValues: c.enumValues ? [...c.enumValues] : null, aliases: c.aliases ?? [], description: c.description ?? null })),
      duplicatePolicies: [...d.duplicatePolicies],
      canCommit: canCommitImports(ctx),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
};

/** Download Template: header row only (CSV UTF-8 with BOM, or XLSX), never example data. */
export const importTemplate = async (ctx: QueryContext, dataset: string, format: 'csv' | 'xlsx') => {
  const d = datasetOf(dataset);
  assertDatasetAccess(ctx, d);
  const header = d.columns.map((c) => c.label);
  if (format === 'csv') return { fileName: `${d.key}-template.csv`, contentType: 'text/csv; charset=utf-8', body: Buffer.from(`﻿${csvLine(header)}`, 'utf8') };
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(d.label.slice(0, 31));
  ws.addRow(header);
  const notes = wb.addWorksheet('Columns');
  notes.addRow(['Column', 'Required', 'Type', 'Allowed values', 'Description']);
  for (const c of d.columns) notes.addRow([c.label, c.required ? 'Yes' : 'No', c.type, (c.enumValues ?? []).join(', '), c.description ?? '']);
  return { fileName: `${d.key}-template.xlsx`, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', body: Buffer.from(await wb.xlsx.writeBuffer()) };
};

export const listImportMappings = async (ctx: QueryContext, dataset: string) => {
  assertDatasetAccess(ctx, datasetOf(dataset));
  const rows = await dbOf(ctx)
    .select()
    .from(savedViews)
    .where(
      and(
        eq(savedViews.workspaceId, ctx.actor.workspaceId),
        eq(savedViews.module, IMPORT_MAPPING_MODULE(dataset)),
        or(eq(savedViews.ownerMembershipId, ctx.actor.membershipId ?? ''), eq(savedViews.shared, true)),
      ),
    )
    .orderBy(asc(savedViews.name));
  return rows.map((r) => ({ id: r.id, name: r.name, mapping: ((r.filterAst as { mapping?: Record<string, string | null> }).mapping ?? {}) as Record<string, string | null>, shared: r.shared, own: r.ownerMembershipId === ctx.actor.membershipId, rowVersion: r.rowVersion }));
};

export const saveImportMapping = async (ctx: CommandContext, dataset: string, input: { name: string; mapping: Record<string, string | null>; shared: boolean }) => {
  const d = datasetOf(dataset);
  assertDatasetAccess(ctx, d);
  const keys = new Set(d.columns.map((c) => c.key));
  for (const k of Object.keys(input.mapping)) if (!keys.has(k)) throw new AppError('VALIDATION_FAILED', `Unknown column "${k}".`);
  const id = newId();
  await ctx.tx.insert(savedViews).values({ ...stamp(ctx), id, ownerMembershipId: ctx.actor.membershipId!, module: IMPORT_MAPPING_MODULE(dataset), name: input.name.trim(), filterAst: { mapping: input.mapping }, shared: input.shared });
  await audit(ctx, { action: 'import.mapping_saved', entityType: 'saved_view', entityId: id, metadata: { dataset, shared: input.shared } });
  return { ok: true as const };
};

// ——— Upload into quarantine ———

const fileKindOf = (filename: string): 'csv' | 'xlsx' => {
  const ext = filename.toLowerCase().split('.').pop();
  if (ext === 'csv') return 'csv';
  if (ext === 'xlsx') return 'xlsx';
  if (ext === 'xlsm' || ext === 'xls' || ext === 'xlsb')
    throw new AppError('VALIDATION_FAILED', 'Only .xlsx workbooks without macros and CSV files can be imported.', { fieldErrors: [{ field: 'filename', code: 'UNSUPPORTED', message: 'Save the file as .xlsx or CSV UTF-8.' }] });
  throw new AppError('VALIDATION_FAILED', 'Upload a .csv or .xlsx file.', { fieldErrors: [{ field: 'filename', code: 'UNSUPPORTED', message: 'Upload a .csv or .xlsx file.' }] });
};

/** Open a resumable upload whose credentials only target this session's quarantine key. */
export const initiateImportUpload = async (ctx: CommandContext, input: { filename: string; byteSize: number; mimeType?: string }) => {
  requirePermission(ctx, 'imports.create');
  if (!ctx.actor.membershipId) throw new AppError('FORBIDDEN', 'Only members can upload import files.');
  const kind = fileKindOf(input.filename);
  if (input.byteSize > IMPORT_MAX_BYTES)
    throw new AppError('PAYLOAD_TOO_LARGE', 'Import files are limited to 20 MB. Split the file and import the parts separately.');
  const id = newId();
  const quarantineKey = `quarantine/${ctx.actor.workspaceId}/${id}`;
  const mime = kind === 'csv' ? 'text/csv' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const mp = await ctx.app.storage.createMultipartUpload(quarantineKey, mime);
  const expiresAt = new Date(ctx.app.clock.now().getTime() + UPLOAD_TTL_MS);
  await ctx.tx.insert(uploadSessions).values({
    ...stamp(ctx),
    id,
    filename: input.filename.slice(0, 255),
    purpose: 'import',
    declaredMime: mime,
    declaredSize: input.byteSize,
    quarantineKey,
    multipartUploadId: mp.uploadId,
    partSize: PART_SIZE,
    state: 'open',
    reservedBytes: 0,
    expiresAt,
    ownerMembershipId: ctx.actor.membershipId,
  });
  const partCount = Math.max(1, Math.ceil(input.byteSize / PART_SIZE));
  const parts = [];
  for (let n = 1; n <= partCount; n++) {
    const p = await ctx.app.storage.presignUploadPart(quarantineKey, mp.uploadId, n, 3600);
    parts.push({ partNumber: n, url: p.url, method: 'PUT' as const, headers: p.headers });
  }
  return { uploadId: id, partSize: PART_SIZE, partCount, parts, expiresAt: expiresAt.toISOString() };
};

const readObject = async (ctx: { app: QueryContext['app'] }, key: string, limit = IMPORT_MAX_BYTES + 1): Promise<Buffer> => {
  const { stream } = await ctx.app.storage.getObjectStream(key);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    total += chunk.length;
    if (total > limit) throw new AppError('PAYLOAD_TOO_LARGE', 'Import files are limited to 20 MB.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
};

/** Content check: the bytes must really be UTF-8 text (CSV) or an OOXML workbook (XLSX). */
const verifyContent = (buf: Buffer, kind: 'csv' | 'xlsx') => {
  if (kind === 'xlsx') {
    const latin = buf.subarray(0, Math.min(buf.length, 1_000_000)).toString('latin1');
    if (buf[0] !== 0x50 || buf[1] !== 0x4b || !latin.includes('xl/')) throw new AppError('VALIDATION_FAILED', 'The file is not a valid .xlsx workbook.');
    return;
  }
  if (buf.subarray(0, 4096).includes(0)) throw new AppError('VALIDATION_FAILED', 'The file contains binary data and is not a CSV file.');
};

/**
 * Finish the upload: assemble in quarantine, verify size, content and malware scan, move the exact
 * bytes to a private key and create the import job. Parsing into staging runs in the background.
 * Nothing in the domain changes (section 22.1).
 */
export const createImport = async (ctx: CommandContext, input: { uploadId: string; parts: { partNumber: number; etag: string }[]; dataset: string }) => {
  const d = datasetOf(input.dataset);
  assertDatasetAccess(ctx, d);
  const [s] = await ctx.tx.select().from(uploadSessions).where(and(eq(uploadSessions.workspaceId, ctx.actor.workspaceId), eq(uploadSessions.id, input.uploadId))).for('update');
  if (!s || s.ownerMembershipId !== ctx.actor.membershipId || s.purpose !== 'import') throw notFound('Upload');
  if (s.state !== 'open') throw new AppError('INVALID_STATE', 'This upload was already used or cancelled. Upload the file again.');
  if (s.expiresAt <= ctx.app.clock.now()) throw new AppError('INVALID_STATE', 'This upload expired. Upload the file again.');
  const kind = fileKindOf(s.filename);
  const expectedParts = Math.max(1, Math.ceil(s.declaredSize / s.partSize));
  if (input.parts.length !== expectedParts) throw new AppError('VALIDATION_FAILED', `Expected ${expectedParts} parts, received ${input.parts.length}.`);
  try {
    await ctx.app.storage.completeMultipartUpload(s.quarantineKey, s.multipartUploadId!, input.parts);
  } catch {
    throw new AppError('INVALID_STATE', 'The uploaded parts are incomplete or no longer available. Upload the file again.');
  }
  const buf = await readObject(ctx, s.quarantineKey);
  const discard = async () => {
    await ctx.app.storage.deleteObject(s.quarantineKey).catch(() => undefined);
  };
  if (buf.length !== s.declaredSize) {
    await discard();
    throw new AppError('VALIDATION_FAILED', 'The uploaded size does not match the declared size. Upload the file again.');
  }
  try {
    verifyContent(buf, kind);
  } catch (e) {
    await discard();
    throw e;
  }
  const scan = await ctx.app.scanner.scan(Readable.from(buf));
  if (!scan.clean) {
    await discard();
    throw new AppError('VALIDATION_FAILED', `The file was rejected by the malware scan (${scan.signature ?? 'threat detected'}).`);
  }
  const id = newId();
  const finalKey = `imports/${ctx.actor.workspaceId}/${id}/source.${kind}`;
  await ctx.app.storage.putObject(finalKey, buf, { contentType: s.declaredMime, contentLength: buf.length });
  await discard();
  await ctx.tx.update(uploadSessions).set({ state: 'completed', completedAt: ctx.app.clock.now() }).where(eq(uploadSessions.id, s.id));
  const hash = sha256(buf);
  await ctx.tx.insert(importJobs).values({
    ...stamp(ctx),
    id,
    dataset: d.key,
    state: 'uploaded',
    fileName: s.filename,
    fileKind: kind,
    fileHash: hash,
    fileStorageKey: finalKey,
    byteSize: buf.length,
    requestedByMembershipId: ctx.actor.membershipId!,
  });
  await enqueueJob(ctx.tx, { type: 'imports.parse', pool: 'data', workspaceId: ctx.actor.workspaceId, payload: { importId: id }, requestedBy: ctx.actor.membershipId, idempotencyKey: `imports.parse:${id}:1`, maxRetries: 2 });
  await audit(ctx, { action: 'import.uploaded', entityType: 'import_job', entityId: id, metadata: { dataset: d.key, fileKind: kind, bytes: buf.length, scan: scan.devBypass ? 'dev-bypass' : scan.engine } });
  await emit(ctx, { type: 'import.uploaded', entityType: 'import_job', entityId: id, revision: 1 });
  return id;
};

// ——— Read models ———

const loadVisible = async (ctx: QueryContext | CommandContext, id: string, lock = false) => {
  requirePermission(ctx, 'imports.create');
  const q = dbOf(ctx).select().from(importJobs).where(and(eq(importJobs.workspaceId, ctx.actor.workspaceId), eq(importJobs.id, id)));
  const [j] = lock && 'tx' in ctx ? await q.for('update') : await q;
  if (!j || (j.requestedByMembershipId !== ctx.actor.membershipId && !canCommitImports(ctx))) throw notFound('Import');
  return j;
};

const latestJob = async (ctx: QueryContext | CommandContext, importId: string) => {
  const [j] = await dbOf(ctx)
    .select({ state: jobs.state, progress: jobs.progress, note: jobs.progressNote })
    .from(jobs)
    .where(and(eq(jobs.workspaceId, ctx.actor.workspaceId), sql`${jobs.payload} ->> 'importId' = ${importId}`, inArray(jobs.state, ['queued', 'running'])))
    .orderBy(desc(jobs.createdAt))
    .limit(1);
  return j ? { state: j.state, percent: j.progress, note: j.note } : null;
};

const toSummary = (j: ImportJobRow, refs: Awaited<ReturnType<typeof loadMemberRefs>>) => ({
  id: j.id,
  dataset: j.dataset,
  datasetLabel: IMPORT_DATASETS_REGISTRY.get(j.dataset)?.label ?? j.dataset,
  state: j.state,
  fileName: j.fileName,
  fileKind: j.fileKind,
  byteSize: j.byteSize,
  rowCount: j.rowCount,
  requestedBy: refOrUnknown(refs, j.requestedByMembershipId)!,
  createdAt: j.createdAt.toISOString(),
  updatedAt: j.updatedAt.toISOString(),
  committedAt: j.committedAt?.toISOString() ?? null,
  rowVersion: j.rowVersion,
});

export const getImport = async (ctx: QueryContext | CommandContext, id: string) => {
  const j = await loadVisible(ctx, id);
  const d = IMPORT_DATASETS_REGISTRY.get(j.dataset);
  const refs = await loadMemberRefs(dbOf(ctx), ctx.actor.workspaceId, [j.requestedByMembershipId]);
  const own = j.requestedByMembershipId === ctx.actor.membershipId;
  const opts = (j.options ?? null) as ImportOptionsValue | null;
  const [formulaCount] = await dbOf(ctx)
    .select({ n: sql<number>`count(*)::int` })
    .from(importRows)
    .where(and(eq(importRows.jobId, j.id), sql`${importRows.raw} ? ${'\u0001formulas'}`));
  const hasRows = (j.rowCount ?? 0) > 0;
  return {
    ...toSummary(j, refs),
    fileHash: j.fileHash,
    headers: j.headers,
    mapping: j.mapping,
    suggestedMapping: d ? suggestMapping(d.columns, j.headers) : {},
    options: opts
      ? {
          timezone: opts.timezone,
          currency: opts.currency,
          dateFormat: opts.dateFormat,
          decimalSeparator: opts.decimalSeparator,
          duplicatePolicy: opts.duplicatePolicy,
          acceptCachedFormulaValues: !!opts.acceptCachedFormulaValues,
        }
      : null,
    delimiter: opts?.delimiter ?? null,
    hasFormulaCells: Number(formulaCount?.n ?? 0) > 0,
    validationReport: (j.validationReport ?? null) as never,
    validationToken: j.state === 'validated' ? j.validationToken : null,
    validatedAt: j.validatedAt?.toISOString() ?? null,
    warningsAccepted: j.warningsAccepted,
    result: (j.result ?? null) as never,
    errorMessage: j.errorMessage,
    undoneAt: j.undoneAt?.toISOString() ?? null,
    progress: await latestJob(ctx, j.id),
    permissions: {
      validate: own && hasRows && ['parsed', 'validated', 'needs_revalidation', 'failed'].includes(j.state),
      commit: canCommitImports(ctx) && !!d && hasAnywhere(ctx.actor.access, d.permission) && j.state === 'validated',
      cancel: (own || canCommitImports(ctx)) && ['uploaded', 'parsed', 'validated', 'needs_revalidation', 'failed'].includes(j.state),
      undo: canCommitImports(ctx) && !!d?.undo && j.state === 'committed' && ((j.result as { created?: number } | null)?.created ?? 0) > 0,
    },
  };
};

export const listImports = async (ctx: QueryContext, input: { cursor?: string; pageSize?: number; state?: ImportState[]; dataset?: string }) => {
  requirePermission(ctx, 'imports.create');
  const size = clampPageSize(input.pageSize);
  const c = input.cursor ? decodeCursor(input.cursor) : null;
  const rows = await ctx.app.db
    .select()
    .from(importJobs)
    .where(
      and(
        eq(importJobs.workspaceId, ctx.actor.workspaceId),
        canCommitImports(ctx) ? undefined : eq(importJobs.requestedByMembershipId, ctx.actor.membershipId ?? ''),
        input.state?.length ? inArray(importJobs.state, input.state) : undefined,
        input.dataset ? eq(importJobs.dataset, input.dataset as never) : undefined,
        c ? or(lt(importJobs.createdAt, new Date(String(c.v[0]))), and(eq(importJobs.createdAt, new Date(String(c.v[0]))), lt(importJobs.id, c.id))) : undefined,
      ),
    )
    .orderBy(desc(importJobs.createdAt), desc(importJobs.id))
    .limit(size + 1);
  const hasMore = rows.length > size;
  const page = hasMore ? rows.slice(0, size) : rows;
  const refs = await loadMemberRefs(ctx.app.db, ctx.actor.workspaceId, page.map((r) => r.requestedByMembershipId));
  const last = page[page.length - 1];
  return { items: page.map((r) => toSummary(r, refs)), hasMore, nextCursor: hasMore && last ? encodeCursor({ v: [last.createdAt.toISOString()], id: last.id }) : null };
};

export const listImportRows = async (ctx: QueryContext, id: string, input: { cursor?: string; pageSize?: number; status?: ImportRowRow['status'][] }) => {
  const j = await loadVisible(ctx, id);
  const size = clampPageSize(input.pageSize);
  const c = input.cursor ? decodeCursor(input.cursor) : null;
  const rows = await ctx.app.db
    .select()
    .from(importRows)
    .where(and(eq(importRows.jobId, j.id), input.status?.length ? inArray(importRows.status, input.status) : undefined, c ? gt(importRows.rowNo, Number(c.v[0])) : undefined))
    .orderBy(asc(importRows.rowNo))
    .limit(size + 1);
  const hasMore = rows.length > size;
  const page = hasMore ? rows.slice(0, size) : rows;
  const last = page[page.length - 1];
  return {
    items: page.map((r) => ({
      id: r.id,
      rowNo: r.rowNo,
      status: r.status,
      action: r.action,
      raw: visibleRaw(r.raw),
      mapped: (r.mapped ?? null) as Record<string, unknown> | null,
      errors: r.errors,
      warnings: r.warnings,
      targetId: r.targetId,
      createdEntityId: r.createdEntityId,
    })),
    hasMore,
    nextCursor: hasMore && last ? encodeCursor({ v: [last.rowNo], id: last.id }) : null,
  };
};

/** Downloadable full error report (every error and warning), neutralised against spreadsheet formulas. */
export const importErrorReport = async (ctx: QueryContext, id: string) => {
  const j = await loadVisible(ctx, id);
  const rows = await ctx.app.db
    .select()
    .from(importRows)
    .where(and(eq(importRows.jobId, j.id), inArray(importRows.status, ['error', 'warning', 'skipped'])))
    .orderBy(asc(importRows.rowNo));
  let out = `﻿${csvLine(['Row', 'Severity', 'Column', 'Code', 'Message', 'Value'])}`;
  const mapping = j.mapping as Record<string, string | null>;
  for (const r of rows) {
    const issues = [...r.errors.map((e) => ({ ...e, severity: 'error' })), ...r.warnings.map((w) => ({ ...w, severity: 'warning' }))];
    for (const i of issues) {
      const header = mapping[i.field];
      const value = header ? (r.raw[header] ?? '') : '';
      out += csvLine([r.rowNo, i.severity, i.field, i.code, i.message, value].map((v) => safeCell(v as string | number, typeof v === 'number' ? 'integer' : 'text')));
    }
  }
  const report = j.validationReport as { byIssue?: { field: string; code: string; severity: string; message: string }[] } | null;
  for (const f of report?.byIssue?.filter((b) => b.field === '_file') ?? []) out += csvLine(['', f.severity, 'file', f.code, safeCell(f.message, 'text'), '']);
  return { fileName: `${j.fileName.replace(/\.[^.]+$/, '')}-issues.csv`, body: Buffer.from(out, 'utf8') };
};

// ——— Commands ———

const setState = (ctx: CommandContext, j: ImportJobRow, to: ImportState, patch: Partial<ImportJobRow> = {}) => {
  assertTransition(IMPORT_TRANSITIONS, j.state, to, 'import');
  return ctx.tx.update(importJobs).set({ ...patch, state: to, ...touch(ctx, importJobs) }).where(eq(importJobs.id, j.id)).returning();
};

const validateMapping = (d: ImportDatasetDefinition, headers: string[], mapping: Record<string, string | null>) => {
  const errors: { field: string; code: string; message: string }[] = [];
  const hs = new Set(headers);
  const used = new Map<string, string>();
  for (const [k, h] of Object.entries(mapping)) {
    const col = d.columns.find((c) => c.key === k);
    if (!col) {
      errors.push({ field: `mapping.${k}`, code: 'UNKNOWN_COLUMN', message: `Unknown column "${k}".` });
      continue;
    }
    if (h === null || h === '') continue;
    if (!hs.has(h)) errors.push({ field: `mapping.${k}`, code: 'UNKNOWN_HEADER', message: `The file has no column “${h}”.` });
    const prev = used.get(h);
    if (prev) errors.push({ field: `mapping.${k}`, code: 'DUPLICATE_HEADER', message: `“${h}” is already mapped to ${prev}.` });
    used.set(h, col.label);
  }
  for (const c of d.columns) if (c.required && !mapping[c.key]) errors.push({ field: `mapping.${c.key}`, code: 'REQUIRED', message: `Map a column to ${c.label}.` });
  if (errors.length) throw new AppError('VALIDATION_FAILED', errors[0]!.message, { fieldErrors: errors });
};

/** Save mapping/options and queue validation. The file hash and options are fixed into the report. */
export const requestImportValidation = async (ctx: CommandContext, id: string, input: { mapping: Record<string, string | null>; options: ImportOptionsValue }) => {
  const j = await loadVisible(ctx, id, true);
  if (j.requestedByMembershipId !== ctx.actor.membershipId) throw new AppError('FORBIDDEN', 'Only the member who uploaded the file can change its mapping.');
  assertVersion(ctx, j);
  const d = datasetOf(j.dataset);
  assertDatasetAccess(ctx, d);
  if (!j.rowCount) throw new AppError('INVALID_STATE', 'The file has no parsed rows to validate.');
  if (!d.duplicatePolicies.includes(input.options.duplicatePolicy))
    throw new AppError('VALIDATION_FAILED', 'This duplicate policy is not available for the dataset.', { fieldErrors: [{ field: 'options.duplicatePolicy', code: 'INVALID', message: 'Choose an available duplicate policy.' }] });
  validateMapping(d, j.headers, input.mapping);
  const prev = (j.options ?? {}) as Partial<ImportOptionsValue>;
  const options: ImportOptionsValue = { ...input.options, delimiter: prev.delimiter };
  const [row] = await setState(ctx, j, 'validating', { mapping: input.mapping, options, validationToken: null, warningsAccepted: false, errorMessage: null });
  await enqueueJob(ctx.tx, {
    type: 'imports.validate',
    pool: 'data',
    workspaceId: ctx.actor.workspaceId,
    payload: { importId: id, actorMembershipId: ctx.actor.membershipId, rowVersion: row!.rowVersion },
    requestedBy: ctx.actor.membershipId,
    idempotencyKey: `imports.validate:${id}:${row!.rowVersion}`,
    maxRetries: 2,
  });
  await audit(ctx, { action: 'import.validation_requested', entityType: 'import_job', entityId: id, metadata: { dataset: j.dataset, duplicatePolicy: options.duplicatePolicy, dateFormat: options.dateFormat, decimalSeparator: options.decimalSeparator, cachedFormulas: !!options.acceptCachedFormulaValues } });
  await emit(ctx, { type: 'import.validating', entityType: 'import_job', entityId: id, revision: row!.rowVersion });
  return id;
};

/** Parse the CSV again with an explicitly chosen delimiter. Staged rows are replaced; nothing else changes. */
export const reparseImport = async (ctx: CommandContext, id: string, delimiter: ',' | ';') => {
  const j = await loadVisible(ctx, id, true);
  if (j.requestedByMembershipId !== ctx.actor.membershipId) throw new AppError('FORBIDDEN', 'Only the member who uploaded the file can change it.');
  assertVersion(ctx, j);
  if (j.fileKind !== 'csv') throw new AppError('VALIDATION_FAILED', 'The delimiter applies to CSV files only.');
  const [row] = await setState(ctx, j, 'uploaded', { options: { ...((j.options ?? {}) as ImportOptionsValue), delimiter }, validationReport: null, validationToken: null, validatedAt: null, errorMessage: null });
  await enqueueJob(ctx.tx, { type: 'imports.parse', pool: 'data', workspaceId: ctx.actor.workspaceId, payload: { importId: id, delimiter }, requestedBy: ctx.actor.membershipId, idempotencyKey: `imports.parse:${id}:${row!.rowVersion}`, maxRetries: 2 });
  await audit(ctx, { action: 'import.reparse_requested', entityType: 'import_job', entityId: id, metadata: { delimiter } });
  await emit(ctx, { type: 'import.reparsing', entityType: 'import_job', entityId: id, revision: row!.rowVersion });
  return id;
};

/**
 * Confirm Import: only a validated file with zero blocking errors, and with warnings explicitly
 * acknowledged. The commit runs once (state + job idempotency key) in one transaction.
 */
export const requestImportCommit = async (ctx: CommandContext, id: string, input: { validationToken: string; warningsAccepted: boolean }) => {
  requirePermission(ctx, 'imports.commit');
  const j = await loadVisible(ctx, id, true);
  assertVersion(ctx, j);
  const d = datasetOf(j.dataset);
  if (!hasAnywhere(ctx.actor.access, d.permission)) throw new AppError('FORBIDDEN', `You cannot import ${d.label.toLowerCase()}.`);
  if (j.state === 'committing' || j.state === 'committed') throw new AppError('INVALID_STATE', 'This import was already confirmed.', { details: { state: j.state } });
  if (j.state !== 'validated') throw new AppError('INVALID_STATE', 'Validate the file before importing.', { details: { state: j.state } });
  if (!j.validationToken || j.validationToken !== input.validationToken)
    throw new AppError('INVALID_STATE', 'Some records changed after validation. Validate again before importing.', { details: { reason: 'stale_validation' } });
  const report = j.validationReport as { totals: { errorRows: number; warningRows: number }; byIssue: { severity: string; field: string }[] } | null;
  if (!report || report.totals.errorRows > 0) throw new AppError('INVALID_STATE', 'Fix all blocking errors and validate again before importing.', { details: { errorRows: report?.totals.errorRows ?? null } });
  const hasWarnings = report.totals.warningRows > 0 || report.byIssue.some((b) => b.severity === 'warning' && b.field === '_file');
  if (hasWarnings && !input.warningsAccepted)
    throw new AppError('VALIDATION_FAILED', 'Review and acknowledge the warnings before importing.', { fieldErrors: [{ field: 'warningsAccepted', code: 'REQUIRED', message: 'Acknowledge the warnings to continue.' }] });
  const [row] = await setState(ctx, j, 'committing', { warningsAccepted: input.warningsAccepted });
  await enqueueJob(ctx.tx, {
    type: 'imports.commit',
    pool: 'data',
    workspaceId: ctx.actor.workspaceId,
    payload: { importId: id, actorMembershipId: ctx.actor.membershipId, token: input.validationToken },
    requestedBy: ctx.actor.membershipId,
    // One application per validated file version, however often Confirm is pressed or the job is re-delivered.
    idempotencyKey: `imports.commit:${id}:${input.validationToken}`,
    maxRetries: 0,
  });
  await audit(ctx, { action: 'import.commit_requested', entityType: 'import_job', entityId: id, metadata: { dataset: j.dataset, warningsAccepted: input.warningsAccepted } });
  await emit(ctx, { type: 'import.committing', entityType: 'import_job', entityId: id, revision: row!.rowVersion });
  return id;
};

export const cancelImport = async (ctx: CommandContext, id: string, reason?: string) => {
  const j = await loadVisible(ctx, id, true);
  assertVersion(ctx, j);
  if (j.requestedByMembershipId !== ctx.actor.membershipId && !canCommitImports(ctx)) throw new AppError('FORBIDDEN', 'You cannot cancel this import.');
  if (j.state === 'committing') throw new AppError('INVALID_STATE', 'The import is being applied and can no longer be cancelled.');
  await setState(ctx, j, 'cancelled', { errorMessage: reason ?? null });
  await ctx.tx.delete(importRows).where(eq(importRows.jobId, id));
  await audit(ctx, { action: 'import.cancelled', entityType: 'import_job', entityId: id, reason });
  await emit(ctx, { type: 'import.cancelled', entityType: 'import_job', entityId: id });
  return id;
};

// ——— Row validation (shared by validation and commit re-validation) ———

interface RowOutcome {
  action: 'create' | 'update' | 'skip' | null;
  normalized: unknown;
  targetId: string | null;
  targetRowVersion: number | null;
  errors: ImportIssue[];
  warnings: ImportIssue[];
  cachedFormulas: number;
}

const issueFromError = (e: unknown, field = '_row'): ImportIssue[] | null => {
  if (!isAppError(e)) return null;
  if (e.code === 'VALIDATION_FAILED' && e.fieldErrors.length) return e.fieldErrors.map((f) => ({ field: f.field, code: f.code, message: f.message }));
  if (e.code === 'FORBIDDEN' || e.code === 'NOT_FOUND') return [{ field, code: 'NOT_PERMITTED', message: 'You do not have permission to create or change this record.' }];
  if (['VALIDATION_FAILED', 'INVALID_STATE', 'DUPLICATE', 'CONFLICT'].includes(e.code)) return [{ field, code: e.code, message: e.message }];
  return null;
};

export const validateImportRow = async (
  ctx: QueryContext,
  d: ImportDatasetDefinition,
  mapping: Record<string, string | null>,
  options: ImportOptionsValue,
  raw: Record<string, string>,
  rowNo: number,
  seen: Map<string, number>,
): Promise<RowOutcome> => {
  const { formulas, noCache } = formulaHeaders(raw);
  const errors: ImportIssue[] = [];
  const warnings: ImportIssue[] = [];
  const record: Record<string, unknown> = {};
  let cachedFormulas = 0;
  for (const col of d.columns) {
    const header = mapping[col.key];
    if (!header) {
      record[col.key] = null;
      continue;
    }
    if (noCache.has(header)) {
      errors.push({ field: col.key, code: 'FORMULA_WITHOUT_CACHED_VALUE', message: `${col.label}: the formula has no stored value. Recalculate and save the workbook, or enter the value.` });
      continue;
    }
    if (formulas.has(header)) {
      if (!options.acceptCachedFormulaValues) {
        errors.push({ field: col.key, code: 'CACHED_FORMULA_NOT_CONFIRMED', message: `${col.label} comes from a formula. Confirm “Import cached formula values” to use the stored result.` });
        continue;
      }
      cachedFormulas++;
      warnings.push({ field: col.key, code: 'CACHED_FORMULA_VALUE', message: `${col.label}: Cached Formula Value (the formula was not evaluated).` });
    }
    const c = coerceValue(raw[header], col, options);
    if (!c.ok) {
      errors.push({ field: col.key, code: c.code, message: `${col.label}: ${c.message}` });
      continue;
    }
    if (c.value === null && col.required) errors.push({ field: col.key, code: 'REQUIRED', message: `${col.label} is required.` });
    record[col.key] = c.value;
  }
  if (errors.length) return { action: null, normalized: null, targetId: null, targetRowVersion: null, errors, warnings, cachedFormulas };
  let v;
  try {
    v = await d.validate(ctx, record, { duplicatePolicy: options.duplicatePolicy, rowNo });
  } catch (e) {
    const issues = issueFromError(e);
    if (!issues) throw e;
    return { action: null, normalized: null, targetId: null, targetRowVersion: null, errors: issues, warnings, cachedFormulas };
  }
  errors.push(...v.errors);
  warnings.push(...v.warnings);
  let action: RowOutcome['action'] = v.action;
  if (v.dedupeKey && action !== 'skip') {
    const first = seen.get(v.dedupeKey);
    if (first !== undefined) {
      if (options.duplicatePolicy === 'skip') {
        action = 'skip';
        warnings.push({ field: '_row', code: 'DUPLICATE_IN_FILE', message: `Same record as row ${first}; this row is skipped.` });
      } else errors.push({ field: '_row', code: 'DUPLICATE_IN_FILE', message: `Same record as row ${first}. Remove one of the rows.` });
    } else seen.set(v.dedupeKey, rowNo);
  }
  return {
    action: errors.length ? null : action,
    normalized: v.normalized,
    targetId: v.targetId ?? null,
    targetRowVersion: v.targetRowVersion ?? null,
    errors,
    warnings,
    cachedFormulas,
  };
};

// ——— Background jobs ———

const jobUpdate = async (app: QueryContext['app'], id: string, from: ImportState[], patch: Partial<ImportJobRow>) => {
  const rows = await app.db
    .update(importJobs)
    .set({ ...patch, updatedAt: app.clock.now(), rowVersion: sql`${importJobs.rowVersion} + 1` })
    .where(and(eq(importJobs.id, id), inArray(importJobs.state, from)))
    .returning();
  if (rows[0]) await streamEvent(app.db, { workspaceId: rows[0].workspaceId, kind: 'entity_changed', entityType: 'import_job', entityId: id, revision: rows[0].rowVersion });
  return rows[0];
};

const safeMessage = (e: unknown) => (isAppError(e) ? e.message : 'An unexpected error occurred.');

/** Parse the quarantined-and-scanned file into staging rows and propose a mapping. */
defineJob(
  'imports.parse',
  'data',
  async ({ app, job, heartbeat }) => {
    const { importId, delimiter } = job.payload as { importId: string; delimiter?: ',' | ';' };
    const [j] = await app.db.select().from(importJobs).where(eq(importJobs.id, importId));
    if (!j || j.state !== 'uploaded') return { skipped: j?.state ?? 'missing' };
    let parsed;
    try {
      const buf = await readObject({ app }, j.fileStorageKey);
      if (sha256(buf) !== j.fileHash) throw new AppError('VALIDATION_FAILED', 'The stored file does not match the uploaded file. Upload it again.');
      parsed = await parseImportFile(buf, j.fileKind, delimiter ?? (j.options as ImportOptionsValue | null)?.delimiter);
    } catch (e) {
      await jobUpdate(app, j.id, ['uploaded'], { state: 'failed', errorMessage: safeMessage(e) });
      return { failed: safeMessage(e) };
    }
    await app.db.delete(importRows).where(eq(importRows.jobId, j.id));
    const at = app.clock.now();
    for (let i = 0; i < parsed.rows.length; i += 1000) {
      await app.db.insert(importRows).values(
        parsed.rows.slice(i, i + 1000).map((cells, k) => ({
          id: newId(),
          workspaceId: j.workspaceId,
          createdAt: at,
          updatedAt: at,
          createdBy: j.createdBy,
          updatedBy: j.createdBy,
          jobId: j.id,
          rowNo: i + k + 1,
          raw: toStagedRaw(parsed.headers, cells),
          status: 'pending' as const,
        })),
      );
      await heartbeat(Math.min(90, Math.round(((i + 1000) / parsed.rows.length) * 90)), 'staging rows');
    }
    const d = IMPORT_DATASETS_REGISTRY.get(j.dataset);
    // Reuse the mapping of this member's last committed import with the same headers, else suggest from aliases.
    const [prev] = await app.db
      .select({ mapping: importJobs.mapping })
      .from(importJobs)
      .where(and(eq(importJobs.workspaceId, j.workspaceId), eq(importJobs.dataset, j.dataset), eq(importJobs.requestedByMembershipId, j.requestedByMembershipId), eq(importJobs.state, 'committed'), sql`${importJobs.headers} = ${JSON.stringify(parsed.headers)}::jsonb`))
      .orderBy(desc(importJobs.committedAt))
      .limit(1);
    const mapping = prev?.mapping && Object.keys(prev.mapping).length ? prev.mapping : d ? suggestMapping(d.columns, parsed.headers) : {};
    const prevOptions = (j.options ?? null) as ImportOptionsValue | null;
    const [ws] = await app.db.execute<{ timezone: string; base_currency: string }>(sql`SELECT timezone, base_currency FROM workspaces WHERE id = ${j.workspaceId}`).then((r) => r.rows);
    const options: ImportOptionsValue = prevOptions?.timezone
      ? { ...prevOptions, delimiter: parsed.delimiter ?? undefined }
      : {
          timezone: ws?.timezone ?? 'UTC',
          currency: ws?.base_currency,
          dateFormat: 'iso',
          decimalSeparator: parsed.delimiter === ';' ? ',' : '.',
          duplicatePolicy: d?.duplicatePolicies[0] ?? 'error',
          delimiter: parsed.delimiter ?? undefined,
          acceptCachedFormulaValues: false,
        };
    await jobUpdate(app, j.id, ['uploaded'], {
      state: 'parsed',
      headers: parsed.headers,
      rowCount: parsed.rows.length,
      mapping,
      options,
      errorMessage: parsed.warnings.length ? parsed.warnings.join(' ') : null,
    });
    return { rows: parsed.rows.length, headers: parsed.headers.length };
  },
  { leaseSeconds: 900 },
);

interface ReportAccumulator {
  totals: { rows: number; create: number; update: number; skip: number; errorRows: number; warningRows: number; errors: number; warnings: number; cachedFormulaValues: number };
  issues: Map<string, { field: string; code: string; severity: 'error' | 'warning'; count: number; message: string }>;
}

const addIssues = (acc: ReportAccumulator, list: ImportIssue[], severity: 'error' | 'warning') => {
  for (const i of list) {
    const k = `${severity}:${i.field}:${i.code}`;
    const cur = acc.issues.get(k);
    if (cur) cur.count++;
    else acc.issues.set(k, { field: i.field, code: i.code, severity, count: 1, message: i.message });
  }
};

/**
 * Validate every staged row (syntax, references, permissions, duplicates) and freeze an immutable
 * report and a validation token bound to the file hash, mapping and options. No domain rows change.
 */
defineJob(
  'imports.validate',
  'data',
  async ({ app, job, heartbeat }) => {
    const { importId, actorMembershipId, rowVersion } = job.payload as { importId: string; actorMembershipId: string; rowVersion: number };
    const [j] = await app.db.select().from(importJobs).where(eq(importJobs.id, importId));
    if (!j || j.state !== 'validating' || j.rowVersion !== rowVersion) return { skipped: j?.state ?? 'missing' };
    const d = IMPORT_DATASETS_REGISTRY.get(j.dataset);
    const ctx = await memberJobContext(app, j.workspaceId, actorMembershipId, { source: 'import' });
    if (!d || !ctx) {
      await jobUpdate(app, j.id, ['validating'], { state: 'failed', errorMessage: !d ? 'This dataset is not available.' : 'The member who started validation no longer has access.' });
      return { failed: true };
    }
    const options = j.options as ImportOptionsValue;
    const mapping = j.mapping as Record<string, string | null>;
    const acc: ReportAccumulator = { totals: { rows: 0, create: 0, update: 0, skip: 0, errorRows: 0, warningRows: 0, errors: 0, warnings: 0, cachedFormulaValues: 0 }, issues: new Map() };
    const seen = new Map<string, number>();
    let lastRowNo = 0;
    for (;;) {
      const batch = await app.db.select().from(importRows).where(and(eq(importRows.jobId, j.id), gt(importRows.rowNo, lastRowNo))).orderBy(asc(importRows.rowNo)).limit(500);
      if (batch.length === 0) break;
      const [cur] = await app.db.select({ state: importJobs.state, rv: importJobs.rowVersion }).from(importJobs).where(eq(importJobs.id, j.id));
      if (cur?.state !== 'validating' || cur.rv !== rowVersion) return { skipped: 'superseded' };
      for (const r of batch) {
        const o = await validateImportRow(ctx, d, mapping, options, r.raw, r.rowNo, seen);
        acc.totals.rows++;
        acc.totals.cachedFormulaValues += o.cachedFormulas;
        if (o.errors.length) acc.totals.errorRows++;
        if (o.warnings.length) acc.totals.warningRows++;
        acc.totals.errors += o.errors.length;
        acc.totals.warnings += o.warnings.length;
        if (o.action) acc.totals[o.action]++;
        addIssues(acc, o.errors, 'error');
        addIssues(acc, o.warnings, 'warning');
        await app.db
          .update(importRows)
          .set({
            status: o.errors.length ? 'error' : o.action === 'skip' ? 'skipped' : o.warnings.length ? 'warning' : 'valid',
            action: o.action,
            mapped: (o.normalized ?? null) as Record<string, unknown> | null,
            errors: o.errors,
            warnings: o.warnings,
            targetId: o.targetId,
            targetRowVersion: o.targetRowVersion,
            updatedAt: app.clock.now(),
          })
          .where(eq(importRows.id, r.id));
        lastRowNo = r.rowNo;
      }
      await heartbeat(Math.min(95, Math.round((acc.totals.rows / Math.max(1, j.rowCount ?? 1)) * 95)), `${acc.totals.rows} rows validated`);
    }
    // The same file already applied once: the second confirmation needs an explicit acknowledgement.
    const [dup] = await app.db
      .select({ id: importJobs.id, committedAt: importJobs.committedAt })
      .from(importJobs)
      .where(and(eq(importJobs.workspaceId, j.workspaceId), eq(importJobs.dataset, j.dataset), eq(importJobs.fileHash, j.fileHash), eq(importJobs.state, 'committed'), sql`${importJobs.id} <> ${j.id}`))
      .limit(1);
    const byIssue = [...acc.issues.values()].sort((a, b) => (a.severity === b.severity ? b.count - a.count : a.severity === 'error' ? -1 : 1));
    if (dup) byIssue.push({ field: '_file', code: 'FILE_ALREADY_IMPORTED', severity: 'warning', count: 1, message: `This file was already imported on ${dup.committedAt?.toISOString().slice(0, 10) ?? 'an earlier date'}. Duplicate records are handled by the duplicate policy.` });
    const reportNo = ((j.validationReport as { reportNo?: number } | null)?.reportNo ?? 0) + 1;
    const validatedAt = app.clock.now();
    const report = {
      reportNo,
      validatedAt: validatedAt.toISOString(),
      validatedBy: ctx.actor.displayName,
      fileHash: j.fileHash,
      duplicatePolicy: options.duplicatePolicy,
      totals: acc.totals,
      byIssue,
    };
    const token = sha256(stableStringify({ id: j.id, fileHash: j.fileHash, mapping, options, reportNo, at: report.validatedAt })).slice(0, 40);
    const updated = await jobUpdate(app, j.id, ['validating'], { state: 'validated', validationReport: report, validationToken: token, validatedAt });
    if (updated)
      await executeSystemCommand(ctx, (c) =>
        audit(c, { action: 'import.validated', entityType: 'import_job', entityId: j.id, metadata: { reportNo, rows: acc.totals.rows, errorRows: acc.totals.errorRows, warningRows: acc.totals.warningRows } }),
      );
    return { rows: acc.totals.rows, errorRows: acc.totals.errorRows };
  },
  { leaseSeconds: 900 },
);

class NeedsRevalidation extends Error {
  constructor(readonly rowNo: number | null, message: string) {
    super(message);
  }
}

/**
 * Apply the validated rows atomically in ONE transaction as the confirming member. Each row is
 * validated again against the current data and permissions; any difference from the validated
 * outcome (changed target version, new duplicate, lost permission) aborts the whole commit and the
 * job becomes Needs Revalidation — zero partial commit (T145/T146).
 */
defineJob(
  'imports.commit',
  'data',
  async ({ app, job, heartbeat }) => {
    const { importId, actorMembershipId, token } = job.payload as { importId: string; actorMembershipId: string; token: string };
    const [j] = await app.db.select().from(importJobs).where(eq(importJobs.id, importId));
    if (!j || j.state !== 'committing') return { skipped: j?.state ?? 'missing' };
    const d = IMPORT_DATASETS_REGISTRY.get(j.dataset);
    const ctx = await memberJobContext(app, j.workspaceId, actorMembershipId, { source: 'import', requestId: `import_${j.id.slice(0, 8)}` });
    if (!d || !ctx) {
      await jobUpdate(app, j.id, ['committing'], { state: 'failed', errorMessage: 'The import failed without changes: the confirming member no longer has access.' });
      return { failed: true };
    }
    if (j.validationToken !== token) {
      await jobUpdate(app, j.id, ['committing'], { state: 'needs_revalidation', errorMessage: 'Some records changed after validation. Validate again before importing.' });
      return { needsRevalidation: true };
    }
    const started = Date.now();
    try {
      const buf = await readObject({ app }, j.fileStorageKey);
      if (sha256(buf) !== j.fileHash) throw new NeedsRevalidation(null, 'The stored file changed after validation.');
      const options = j.options as ImportOptionsValue;
      const mapping = j.mapping as Record<string, string | null>;
      const result = await executeCommand(ctx, async (c) => {
        const [locked] = await c.tx.select().from(importJobs).where(and(eq(importJobs.id, j.id), eq(importJobs.state, 'committing'))).for('update');
        if (!locked) throw new AppError('INVALID_STATE', 'The import is no longer waiting to be applied.');
        const rows = await c.tx.select().from(importRows).where(eq(importRows.jobId, j.id)).orderBy(asc(importRows.rowNo));
        if (rows.length > MAX_IMPORT_ROWS) throw new AppError('INVALID_STATE', 'The import exceeds the row limit.');
        const seen = new Map<string, number>();
        const createdIds: string[] = [];
        const updatedIds: string[] = [];
        let skipped = 0;
        let i = 0;
        for (const r of rows) {
          if (Date.now() - started > COMMIT_BUDGET_MS)
            throw new AppError('INVALID_STATE', 'The import is too large to apply within the time limit. Split the file into smaller parts and import them separately.');
          if (r.status === 'error' || r.action === null) throw new NeedsRevalidation(r.rowNo, `Row ${r.rowNo} has blocking errors.`);
          const o = await validateImportRow(c, d, mapping, options, r.raw, r.rowNo, seen);
          // A skipped row stays skipped even when it now matches a record created earlier in this commit.
          const same = o.action === 'skip' && r.action === 'skip' ? true : o.action === r.action && o.targetId === r.targetId && o.targetRowVersion === r.targetRowVersion;
          if (o.errors.length || !same) throw new NeedsRevalidation(r.rowNo, o.errors[0]?.message ?? `Row ${r.rowNo} changed after validation.`);
          if (o.action === 'skip') {
            skipped++;
          } else {
            const rc: CommandContext = { ...c, request: { ...c.request, expectedVersion: o.targetRowVersion ?? undefined } };
            const entityId = await d.apply(rc, o.normalized, { action: o.action!, targetId: o.targetId ?? undefined, targetRowVersion: o.targetRowVersion ?? undefined });
            if (o.action === 'create') createdIds.push(entityId);
            else updatedIds.push(entityId);
            await c.tx.update(importRows).set({ createdEntityId: o.action === 'create' ? entityId : null, targetId: o.action === 'update' ? entityId : r.targetId }).where(eq(importRows.id, r.id));
          }
          if (++i % 200 === 0) await heartbeat(Math.min(95, Math.round((i / rows.length) * 95)), `${i} rows applied`);
        }
        const res = { created: createdIds.length, updated: updatedIds.length, skipped, createdIds, updatedIds, undo: null };
        await c.tx.update(importJobs).set({ state: 'committed', committedAt: c.app.clock.now(), result: res, errorMessage: null, ...touch(c, importJobs) }).where(eq(importJobs.id, j.id));
        await audit(c, { action: 'import.committed', entityType: 'import_job', entityId: j.id, metadata: { dataset: j.dataset, created: res.created, updated: res.updated, skipped } });
        await emit(c, { type: 'import.committed', entityType: 'import_job', entityId: j.id, payload: { dataset: j.dataset } });
        return res;
      });
      return { created: result.body.created, updated: result.body.updated, skipped: result.body.skipped };
    } catch (e) {
      if (e instanceof NeedsRevalidation || (isAppError(e) && e.code === 'VERSION_CONFLICT')) {
        const message = `Some records changed after validation. Validate again before importing.${e instanceof NeedsRevalidation && e.rowNo ? ` (row ${e.rowNo}: ${e.message})` : ''}`;
        await jobUpdate(app, j.id, ['committing'], { state: 'needs_revalidation', errorMessage: message.slice(0, 500), validationToken: null });
        return { needsRevalidation: true };
      }
      // Only the error code/name is logged: messages may quote imported values (contacts, notes).
      app.logger.warn('import_commit_failed', { importId: j.id, dataset: j.dataset, error: isAppError(e) ? e.code : ((e as Error)?.name ?? 'Error') });
      await jobUpdate(app, j.id, ['committing'], { state: 'failed', errorMessage: `The import failed without changes: ${safeMessage(e)}`.slice(0, 500), validationToken: null });
      return { failed: true };
    }
  },
  { leaseSeconds: 1800 },
);

// ——— Undo Import ———

class DryRun extends Error {
  constructor(readonly outcome: unknown) {
    super('dry-run');
  }
}

const createdEntities = async (ctx: QueryContext | CommandContext, jobId: string) =>
  dbOf(ctx)
    .select({ entityId: importRows.createdEntityId, rowNo: importRows.rowNo, mapped: importRows.mapped })
    .from(importRows)
    .where(and(eq(importRows.jobId, jobId), eq(importRows.action, 'create'), sql`${importRows.createdEntityId} IS NOT NULL`))
    .orderBy(asc(importRows.rowNo));

const titleOf = (mapped: unknown, fallback: string) => {
  const m = (mapped ?? {}) as Record<string, unknown>;
  const t = m.name ?? m.title ?? m.label;
  return typeof t === 'string' && t ? t : fallback;
};

/**
 * Undo preview: every record created by this import is removed tentatively inside a transaction
 * that is always rolled back, so obstacles (later changes, dependent records) are found exactly as
 * the real undo would find them. Updated records are never reverted.
 */
export const importUndoPreview = async (ctx: QueryContext, id: string, reason?: string) => {
  requirePermission(ctx, 'imports.commit');
  const j = await loadVisible(ctx, id);
  const d = datasetOf(j.dataset);
  if (!d.undo) throw new AppError('INVALID_STATE', 'This dataset does not support Undo Import. Archive or correct the records manually.');
  if (j.state !== 'committed') throw new AppError('INVALID_STATE', 'Only a committed import can be undone.');
  const created = await createdEntities(ctx, j.id);
  let outcome: { removable: { entityId: string; title: string }[]; obstacles: { entityId: string; title: string; reason: string }[] } = { removable: [], obstacles: [] };
  try {
    await executeCommand(ctx, async (c) => {
      const out: typeof outcome = { removable: [], obstacles: [] };
      for (const r of created) {
        const title = titleOf(r.mapped, `Row ${r.rowNo}`);
        await c.tx.execute(sql`SAVEPOINT undo_item`);
        try {
          await d.undo!(c, r.entityId!);
          await c.tx.execute(sql`RELEASE SAVEPOINT undo_item`);
          out.removable.push({ entityId: r.entityId!, title });
        } catch (e) {
          await c.tx.execute(sql`ROLLBACK TO SAVEPOINT undo_item`);
          if (!isAppError(e)) throw e;
          out.obstacles.push({ entityId: r.entityId!, title, reason: e.message });
        }
      }
      throw new DryRun(out);
    });
  } catch (e) {
    if (!(e instanceof DryRun)) throw e;
    outcome = e.outcome as typeof outcome;
  }
  const expiresAt = new Date(ctx.app.clock.now().getTime() + UNDO_PREVIEW_TTL_MS);
  const token = await executeSystemCommand(ctx, async (c) => {
    const tokenId = newId();
    await c.tx.insert(bulkPreviews).values({
      ...stamp(c),
      id: tokenId,
      actorMembershipId: ctx.actor.membershipId!,
      action: 'import.undo',
      params: { importId: j.id, reason: reason ?? null, jobVersion: j.rowVersion },
      targets: outcome.removable.map((r) => ({ type: IMPORT_DATASET_ENTITY[j.dataset] ?? j.dataset, id: r.entityId, rowVersion: 0, status: 'ok' as const })),
      accessRevision: ctx.actor.access.accessRevision,
      summary: { obstacles: outcome.obstacles.length },
      expiresAt,
    });
    return tokenId;
  });
  const updated = (j.result as { updated?: number } | null)?.updated ?? 0;
  return { token, expiresAt: expiresAt.toISOString(), removable: outcome.removable, obstacles: outcome.obstacles, notReverted: updated };
};

/** Undo Import: removes the previewed untouched records in one transaction; obstacles stay listed. */
export const undoImport = async (ctx: CommandContext, id: string, previewToken: string) => {
  requirePermission(ctx, 'imports.commit');
  const j = await loadVisible(ctx, id, true);
  assertVersion(ctx, j);
  const d = datasetOf(j.dataset);
  if (!d.undo) throw new AppError('INVALID_STATE', 'This dataset does not support Undo Import.');
  const [p] = await ctx.tx
    .select()
    .from(bulkPreviews)
    .where(and(eq(bulkPreviews.workspaceId, ctx.actor.workspaceId), eq(bulkPreviews.id, previewToken)))
    .for('update');
  const params = (p?.params ?? {}) as { importId?: string; reason?: string | null };
  if (!p || p.action !== 'import.undo' || params.importId !== j.id || p.actorMembershipId !== ctx.actor.membershipId || p.consumedAt || p.expiresAt <= ctx.app.clock.now())
    throw new AppError('INVALID_STATE', 'The undo preview expired. Preview again.');
  if (p.accessRevision !== ctx.actor.access.accessRevision) throw new AppError('INVALID_STATE', 'Your access changed after the preview. Preview again.');
  const created = new Set((await createdEntities(ctx, j.id)).map((r) => r.entityId));
  let removed = 0;
  for (const t of p.targets) {
    if (!created.has(t.id)) continue;
    try {
      await d.undo(ctx, t.id);
      removed++;
    } catch (e) {
      if (isAppError(e)) throw new AppError('INVALID_STATE', `A record changed after the preview (${e.message}). Preview again.`);
      throw e;
    }
  }
  const kept = created.size - removed;
  const result = { ...((j.result ?? {}) as Record<string, unknown>), undo: { removed, kept, at: ctx.app.clock.now().toISOString() } };
  await setState(ctx, j, 'undone', { undoneAt: ctx.app.clock.now(), result });
  await ctx.tx.update(bulkPreviews).set({ consumedAt: ctx.app.clock.now() }).where(eq(bulkPreviews.id, p.id));
  await audit(ctx, { action: 'import.undone', entityType: 'import_job', entityId: j.id, reason: params.reason ?? null, metadata: { dataset: j.dataset, removed, kept } });
  await emit(ctx, { type: 'import.undone', entityType: 'import_job', entityId: j.id });
  return id;
};
