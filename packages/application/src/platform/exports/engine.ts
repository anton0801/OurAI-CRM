import { createReadStream, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, desc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import { hasAnywhere } from '@castlane/authorization';
import { exportJobs, jobs } from '@castlane/database';
import { AppError, clampPageSize, decodeCursor, encodeCursor, newId, notFound } from '@castlane/domain';
import { requirePermission } from '../../core/access';
import { audit } from '../../core/audit';
import type { CommandContext, QueryContext } from '../../core/context';
import { dbOf } from '../../core/context';
import { hmac, safeEqual } from '../../core/crypto';
import { emit, streamEvent } from '../../core/events';
import { EXPORT_DATASETS_REGISTRY, type ExportColumn, type ExportDatasetDefinition } from '../../core/export-registry';
import { enqueueJob } from '../../core/jobs';
import { defineJob, memberJobContext } from '../../core/jobs-registry';
import { loadMemberRefs, refOrUnknown } from '../../core/members';
import { assertVersion, lockById, stamp, touch } from '../../core/rows';
import { createCsvWriter, createXlsxWriter, safeCell, type SheetWriter } from './writers';

type ExportRow = typeof exportJobs.$inferSelect;

export const EXPORT_TTL_MS = 7 * 86_400_000;
export const DOWNLOAD_TTL_MS = 5 * 60_000;
export const ACTIVE_EXPORTS_PER_USER = 5;
export const ACTIVE_EXPORTS_PER_WORKSPACE = 20;
const ACTIVE_STATES = ['queued', 'running'] as const;

const datasetOf = (key: string): ExportDatasetDefinition => {
  const d = EXPORT_DATASETS_REGISTRY.get(key);
  if (!d) throw new AppError('VALIDATION_FAILED', 'This dataset cannot be exported.', { fieldErrors: [{ field: 'dataset', code: 'UNKNOWN', message: 'Choose a dataset.' }] });
  return d;
};

const columnAvailable = (ctx: QueryContext, c: ExportColumn) => !c.permission || hasAnywhere(ctx.actor.access, c.permission);

/** Member may export the dataset at all (module permission + dataset permission). */
const assertDatasetAccess = (ctx: QueryContext, d: ExportDatasetDefinition) => {
  requirePermission(ctx, 'exports.create');
  if (!hasAnywhere(ctx.actor.access, d.permission)) throw new AppError('FORBIDDEN', 'You cannot export this dataset.');
};

/** Datasets and columns offered in the Export Center; sensitive columns are flagged and gated. */
export const listExportDatasets = (ctx: QueryContext) => {
  requirePermission(ctx, 'exports.create');
  return [...EXPORT_DATASETS_REGISTRY.values()]
    .filter((d) => hasAnywhere(ctx.actor.access, d.permission))
    .map((d) => ({
      key: d.key,
      label: d.label,
      classification: d.classification,
      columns: d.columns.map((c) => ({ key: c.key, label: c.label, type: c.type, default: !!c.default, sensitive: !!c.permission, available: columnAvailable(ctx, c) })),
      filters: (d.filters ?? []).map((f) => ({ key: f.key, label: f.label, type: f.type, enumValues: f.enumValues ? [...f.enumValues] : null, lookup: f.lookup ?? null })),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
};

const resolveColumns = (ctx: QueryContext, d: ExportDatasetDefinition, fields: string[]): ExportColumn[] => {
  const cols: ExportColumn[] = [];
  for (const f of [...new Set(fields)]) {
    const c = d.columns.find((x) => x.key === f);
    if (!c) throw new AppError('VALIDATION_FAILED', `Unknown field "${f}".`, { fieldErrors: [{ field: 'fields', code: 'UNKNOWN', message: `Unknown field "${f}".` }] });
    if (!columnAvailable(ctx, c)) throw new AppError('FORBIDDEN', `You do not have access to the field "${c.label}".`);
    cols.push(c);
  }
  return cols;
};

const sanitizeFilters = (d: ExportDatasetDefinition, filters: Record<string, unknown>) => {
  const allowed = new Set([...(d.filters ?? []).map((f) => f.key), 'q', 'includeArchived', 'actorMembershipId', 'entityId']);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(filters)) if (allowed.has(k) && v !== undefined && v !== null && v !== '') out[k] = v;
  return out;
};

const classificationOf = (d: ExportDatasetDefinition, cols: ExportColumn[]): 'normal' | 'private' | 'finance' | 'ofm' =>
  d.classification !== 'normal' ? d.classification : cols.some((c) => c.permission) ? 'private' : 'normal';

/** Preview Fields: selected columns plus up to 10 sample rows, exactly as they would be exported. */
export const previewExport = async (ctx: QueryContext, input: { dataset: string; fields: string[]; filters: Record<string, unknown> }) => {
  const d = datasetOf(input.dataset);
  assertDatasetAccess(ctx, d);
  const cols = resolveColumns(ctx, d, input.fields);
  const rows: Record<string, string | number | boolean | null>[] = [];
  for await (const r of d.rows(ctx, { filters: sanitizeFilters(d, input.filters), boundAt: ctx.app.clock.now(), fields: cols.map((c) => c.key) })) {
    rows.push(Object.fromEntries(cols.map((c) => [c.key, safeCell(r[c.key] ?? null, c.type)])));
    if (rows.length >= 10) break;
  }
  const classification = classificationOf(d, cols);
  const warnings: string[] = [];
  if (cols.some((c) => c.permission)) warnings.push('Private fields are selected. Only you can download this file, and access is checked again at download time.');
  if (classification !== 'normal') warnings.push(`This export is classified as ${classification}. Store downloaded copies securely; a downloaded file cannot be revoked.`);
  return { columns: cols.map((c) => ({ key: c.key, label: c.label, type: c.type })), rows, classification, warnings };
};

const canOversee = (ctx: QueryContext) => hasAnywhere(ctx.actor.access, 'audit.read');

const toItem = (ctx: QueryContext, r: ExportRow, refs: Awaited<ReturnType<typeof loadMemberRefs>>) => {
  const own = r.requestedByMembershipId === ctx.actor.membershipId;
  const now = ctx.app.clock.now();
  const d = EXPORT_DATASETS_REGISTRY.get(r.dataset);
  return {
    id: r.id,
    dataset: r.dataset,
    datasetLabel: d?.label ?? r.dataset,
    format: r.format,
    fields: r.fields,
    filters: r.filters,
    classification: r.classification,
    state: r.state === 'completed' && r.expiresAt && r.expiresAt <= now ? ('expired' as const) : r.state,
    requestedBy: refOrUnknown(refs, r.requestedByMembershipId)!,
    own,
    sourceBoundAt: r.sourceBoundAt.toISOString(),
    fileName: r.fileName,
    byteSize: r.byteSize,
    progress: r.progress,
    errorMessage: r.errorMessage,
    createdAt: r.createdAt.toISOString(),
    completedAt: r.completedAt?.toISOString() ?? null,
    expiresAt: r.expiresAt?.toISOString() ?? null,
    rowVersion: r.rowVersion,
    permissions: {
      download: own && r.state === 'completed' && !!r.expiresAt && r.expiresAt > now && hasAnywhere(ctx.actor.access, 'exports.download'),
      cancel: own && (r.state === 'queued' || r.state === 'running'),
      delete: own && r.state === 'completed',
      retry: own && r.state === 'failed',
    },
  };
};

const loadVisible = async (ctx: QueryContext | CommandContext, id: string, forUpdate = false) => {
  const q = dbOf(ctx).select().from(exportJobs).where(and(eq(exportJobs.workspaceId, ctx.actor.workspaceId), eq(exportJobs.id, id)));
  const [r] = forUpdate && 'tx' in ctx ? await q.for('update') : await q;
  if (!r) throw notFound('Export');
  if (r.requestedByMembershipId !== ctx.actor.membershipId && !canOversee(ctx)) throw notFound('Export');
  return r;
};

export const getExport = async (ctx: QueryContext | CommandContext, id: string) => {
  requirePermission(ctx, 'exports.create');
  const r = await loadVisible(ctx, id);
  const refs = await loadMemberRefs(dbOf(ctx), ctx.actor.workspaceId, [r.requestedByMembershipId]);
  return toItem(ctx, r, refs);
};

export const listExports = async (ctx: QueryContext, input: { cursor?: string; pageSize?: number; state?: ExportRow['state'][]; mine?: boolean }) => {
  requirePermission(ctx, 'exports.create');
  const size = clampPageSize(input.pageSize);
  const c = input.cursor ? decodeCursor(input.cursor) : null;
  const onlyOwn = input.mine || !canOversee(ctx);
  const rows = await ctx.app.db
    .select()
    .from(exportJobs)
    .where(
      and(
        eq(exportJobs.workspaceId, ctx.actor.workspaceId),
        onlyOwn ? eq(exportJobs.requestedByMembershipId, ctx.actor.membershipId!) : undefined,
        input.state?.length ? inArray(exportJobs.state, input.state) : undefined,
        c ? or(lt(exportJobs.createdAt, new Date(String(c.v[0]))), and(eq(exportJobs.createdAt, new Date(String(c.v[0]))), lt(exportJobs.id, c.id))) : undefined,
      ),
    )
    .orderBy(desc(exportJobs.createdAt), desc(exportJobs.id))
    .limit(size + 1);
  const hasMore = rows.length > size;
  const page = hasMore ? rows.slice(0, size) : rows;
  const refs = await loadMemberRefs(ctx.app.db, ctx.actor.workspaceId, page.map((r) => r.requestedByMembershipId));
  const last = page[page.length - 1];
  return { items: page.map((r) => toItem(ctx, r, refs)), hasMore, nextCursor: hasMore && last ? encodeCursor({ v: [last.createdAt.toISOString()], id: last.id }) : null };
};

const enqueueGeneration = (ctx: CommandContext, r: ExportRow) =>
  enqueueJob(ctx.tx, {
    type: 'exports.generate',
    pool: 'data',
    workspaceId: ctx.actor.workspaceId,
    payload: { exportId: r.id },
    requestedBy: ctx.actor.membershipId,
    idempotencyKey: `exports.generate:${r.id}:${r.rowVersion}`,
    maxRetries: 0,
  });

/**
 * Request Export: fixes dataset, fields, filters, requester and the source boundary; enforces
 * quotas (5 active per member, 20 per workspace) and queues generation.
 */
export const requestExport = async (ctx: CommandContext, input: { dataset: string; format: 'csv' | 'xlsx'; fields: string[]; filters: Record<string, unknown> }) => {
  if (!ctx.actor.membershipId) throw new AppError('FORBIDDEN', 'Only members can request exports.');
  const d = datasetOf(input.dataset);
  assertDatasetAccess(ctx, d);
  const cols = resolveColumns(ctx, d, input.fields);
  // Serialise quota checks per workspace so concurrent requests cannot exceed the limits.
  await ctx.tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`exports:${ctx.actor.workspaceId}`}))`);
  const [counts] = await ctx.tx
    .select({
      mine: sql<number>`count(*) FILTER (WHERE ${exportJobs.requestedByMembershipId} = ${ctx.actor.membershipId})::int`,
      all: sql<number>`count(*)::int`,
    })
    .from(exportJobs)
    .where(and(eq(exportJobs.workspaceId, ctx.actor.workspaceId), inArray(exportJobs.state, [...ACTIVE_STATES])));
  if (Number(counts?.mine ?? 0) >= ACTIVE_EXPORTS_PER_USER)
    throw new AppError('QUOTA_EXCEEDED', `You already have ${ACTIVE_EXPORTS_PER_USER} exports in progress. Wait for one to finish or cancel it.`);
  if (Number(counts?.all ?? 0) >= ACTIVE_EXPORTS_PER_WORKSPACE)
    throw new AppError('QUOTA_EXCEEDED', `The workspace already has ${ACTIVE_EXPORTS_PER_WORKSPACE} exports in progress. Try again shortly.`);
  const id = newId();
  const now = ctx.app.clock.now();
  const [row] = await ctx.tx
    .insert(exportJobs)
    .values({
      ...stamp(ctx),
      id,
      requestedByMembershipId: ctx.actor.membershipId,
      dataset: d.key,
      format: input.format,
      fields: cols.map((c) => c.key),
      filters: sanitizeFilters(d, input.filters),
      classification: classificationOf(d, cols),
      state: 'queued',
      sourceBoundAt: now,
    })
    .returning();
  const jobId = await enqueueGeneration(ctx, row!);
  await ctx.tx.update(exportJobs).set({ jobId }).where(eq(exportJobs.id, id));
  await audit(ctx, { action: 'export.requested', entityType: 'export_job', entityId: id, metadata: { dataset: d.key, format: input.format, fields: cols.map((c) => c.key), classification: row!.classification }, sensitivity: row!.classification === 'normal' ? 'normal' : 'security' });
  await emit(ctx, { type: 'export.requested', entityType: 'export_job', entityId: id, revision: 1 });
  return id;
};

const lockOwn = async (ctx: CommandContext, id: string) => {
  requirePermission(ctx, 'exports.create');
  const r = await loadVisible(ctx, id, true);
  if (r.requestedByMembershipId !== ctx.actor.membershipId) throw new AppError('FORBIDDEN', 'Only the member who requested the export can change it.');
  assertVersion(ctx, r);
  return r;
};

const deleteArtifact = async (ctx: { app: QueryContext['app'] }, key: string | null) => {
  if (!key) return;
  try {
    await ctx.app.storage.deleteObject(key);
  } catch {
    /* already gone; retention sweeps retry */
  }
};

/** Cancel Queued / running: stops future processing and removes any partial artifact. */
export const cancelExport = async (ctx: CommandContext, id: string) => {
  const r = await lockOwn(ctx, id);
  if (r.state !== 'queued' && r.state !== 'running') throw new AppError('INVALID_STATE', 'Only queued or running exports can be cancelled.');
  await ctx.tx.update(exportJobs).set({ state: 'cancelled', storageKey: null, progress: 0, ...touch(ctx, exportJobs) }).where(eq(exportJobs.id, id));
  if (r.jobId) await ctx.tx.update(jobs).set({ cancelRequested: true, updatedAt: ctx.app.clock.now() }).where(eq(jobs.id, r.jobId));
  await deleteArtifact(ctx, r.storageKey);
  await audit(ctx, { action: 'export.cancelled', entityType: 'export_job', entityId: id });
  await emit(ctx, { type: 'export.cancelled', entityType: 'export_job', entityId: id });
  return id;
};

/** Delete File: removes the generated file before expiry; the job record stays for history. */
export const deleteExportFile = async (ctx: CommandContext, id: string) => {
  const r = await lockOwn(ctx, id);
  if (r.state !== 'completed') throw new AppError('INVALID_STATE', 'Only a completed export has a file to delete.');
  await ctx.tx.update(exportJobs).set({ state: 'deleted', storageKey: null, ...touch(ctx, exportJobs) }).where(eq(exportJobs.id, id));
  await deleteArtifact(ctx, r.storageKey);
  await audit(ctx, { action: 'export.file_deleted', entityType: 'export_job', entityId: id });
  await emit(ctx, { type: 'export.file_deleted', entityType: 'export_job', entityId: id });
  return id;
};

/** Retry Failed: same fields, filters and source boundary; access is checked again when it runs. */
export const retryExport = async (ctx: CommandContext, id: string) => {
  const r = await lockOwn(ctx, id);
  if (r.state !== 'failed') throw new AppError('INVALID_STATE', 'Only failed exports can be retried.');
  const d = datasetOf(r.dataset);
  assertDatasetAccess(ctx, d);
  resolveColumns(ctx, d, r.fields);
  const [row] = await ctx.tx.update(exportJobs).set({ state: 'queued', errorMessage: null, progress: 0, ...touch(ctx, exportJobs) }).where(eq(exportJobs.id, id)).returning();
  const jobId = await enqueueGeneration(ctx, row!);
  await ctx.tx.update(exportJobs).set({ jobId }).where(eq(exportJobs.id, id));
  await audit(ctx, { action: 'export.retried', entityType: 'export_job', entityId: id });
  await emit(ctx, { type: 'export.retried', entityType: 'export_job', entityId: id, revision: row!.rowVersion });
  return id;
};

const downloadToken = (secret: string, exportId: string, exp: number, membershipId: string) => `${exp}.${hmac(secret, `export:${exportId}:${exp}:${membershipId}`)}`;

/**
 * Current access for downloading one export: the requester only, still holding exports.download,
 * the dataset permission and every sensitive column permission (T153).
 */
const assertDownloadAccess = (ctx: QueryContext, r: ExportRow) => {
  if (r.requestedByMembershipId !== ctx.actor.membershipId) throw new AppError('FORBIDDEN', 'Only the member who requested this export can download it.');
  const d = EXPORT_DATASETS_REGISTRY.get(r.dataset);
  const revoked = new AppError('FORBIDDEN', 'Your access changed. This export can no longer be downloaded.');
  if (!hasAnywhere(ctx.actor.access, 'exports.download')) throw revoked;
  if (d) {
    if (!hasAnywhere(ctx.actor.access, d.permission)) throw revoked;
    for (const f of r.fields) {
      const c = d.columns.find((x) => x.key === f);
      if (c && !columnAvailable(ctx, c)) throw revoked;
    }
  }
  if (r.state !== 'completed' || !r.storageKey) throw new AppError('INVALID_STATE', 'This export has no file to download.');
  if (!r.expiresAt || r.expiresAt <= ctx.app.clock.now()) throw new AppError('INVALID_STATE', 'This export has expired. Request it again.');
};

/** Issue a short-lived (5 min) download link bound to the requester; access is re-checked now and at download. */
export const issueExportDownload = async (ctx: CommandContext, id: string) => {
  const r = await loadVisible(ctx, id);
  assertDownloadAccess(ctx, r);
  const exp = ctx.app.clock.now().getTime() + DOWNLOAD_TTL_MS;
  const token = downloadToken(ctx.app.config.SESSION_SECRET, r.id, exp, ctx.actor.membershipId!);
  await audit(ctx, { action: 'export.download_issued', entityType: 'export_job', entityId: id, metadata: { dataset: r.dataset, classification: r.classification }, sensitivity: r.classification === 'normal' ? 'normal' : 'security' });
  return { url: `/api/v1/workspaces/${ctx.actor.workspaceId}/exports/${r.id}/file?token=${encodeURIComponent(token)}`, expiresAt: new Date(exp).toISOString() };
};

/** Resolve the file for the authorised stream (token + current permissions). */
export const loadExportForDownload = async (ctx: QueryContext, id: string, token: string) => {
  const r = await loadVisible(ctx, id);
  const [exp, sig] = token.split('.');
  const e = Number(exp);
  const expected = Number.isFinite(e) ? downloadToken(ctx.app.config.SESSION_SECRET, r.id, e, ctx.actor.membershipId ?? '') : '';
  if (!Number.isFinite(e) || e < ctx.app.clock.now().getTime() || !sig || !safeEqual(token, expected))
    throw new AppError('FORBIDDEN', 'The download link expired. Request the file again.');
  assertDownloadAccess(ctx, r);
  const contentType = r.format === 'csv' ? 'text/csv; charset=utf-8' : r.format === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : r.format === 'pdf' ? 'application/pdf' : 'application/zip';
  return { storageKey: r.storageKey!, fileName: r.fileName ?? `export.${r.format}`, contentType };
};

// ——— Generation job ———

const fail = async (app: QueryContext['app'], r: ExportRow, message: string) => {
  await app.db
    .update(exportJobs)
    .set({ state: 'failed', errorMessage: message.slice(0, 500), progress: 0, storageKey: null, updatedAt: app.clock.now(), rowVersion: sql`${exportJobs.rowVersion} + 1` })
    .where(and(eq(exportJobs.id, r.id), inArray(exportJobs.state, ['queued', 'running'])));
  await streamEvent(app.db, { workspaceId: r.workspaceId, kind: 'entity_changed', entityType: 'export_job', entityId: r.id });
  return { failed: message };
};

/**
 * Generate the file: re-authorise as the requester, stream permitted rows (as of the source
 * boundary) into a private temp file, upload, then mark Completed with a 7-day expiry. Any error
 * marks the export Failed without a file — an empty or partial file is never presented as
 * Completed (T154). Cancellation is honoured between batches and removes the partial artifact.
 */
defineJob(
  'exports.generate',
  'data',
  async ({ app, job, heartbeat, cancelled }) => {
    const { exportId } = job.payload as { exportId: string };
    const [r] = await app.db.select().from(exportJobs).where(eq(exportJobs.id, exportId));
    if (!r || (r.state !== 'queued' && r.state !== 'running')) return { skipped: r?.state ?? 'missing' };
    const ctx = await memberJobContext(app, r.workspaceId, r.requestedByMembershipId, { source: 'system' });
    if (!ctx) return fail(app, r, 'The requesting member no longer has access to this workspace.');
    const d = EXPORT_DATASETS_REGISTRY.get(r.dataset);
    if (!d) return fail(app, r, 'This dataset is no longer available for export.');
    let cols: ExportColumn[];
    try {
      assertDatasetAccess(ctx, d);
      cols = resolveColumns(ctx, d, r.fields);
    } catch {
      return fail(app, r, 'Your access changed after the export was requested. Request it again.');
    }
    await app.db.update(exportJobs).set({ state: 'running', progress: 1, updatedAt: app.clock.now() }).where(and(eq(exportJobs.id, r.id), eq(exportJobs.state, 'queued')));
    const ext = r.format === 'xlsx' ? 'xlsx' : 'csv';
    const boundLabel = r.sourceBoundAt.toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
    const fileName = `${d.key}-${boundLabel}.${ext}`;
    const tmp = join(tmpdir(), `castlane-export-${r.id}-${newId().slice(0, 8)}.${ext}`);
    const key = `exports/${r.workspaceId}/${r.id}/${fileName}`;
    const header = cols.map((c) => c.label);
    const writer: SheetWriter = ext === 'xlsx' ? createXlsxWriter(tmp, header, cols.map((c) => c.type), d.label) : createCsvWriter(tmp, header);
    let rows = 0;
    let uploaded = false;
    try {
      for await (const rec of d.rows(ctx, { filters: r.filters, boundAt: r.sourceBoundAt, fields: cols.map((c) => c.key) })) {
        await writer.writeRow(cols.map((c) => safeCell(rec[c.key] ?? null, c.type)));
        rows++;
        if (rows % 500 === 0) {
          if (await cancelled()) throw Object.assign(new Error('cancelled'), { cancelled: true });
          const [cur] = await app.db.select({ state: exportJobs.state }).from(exportJobs).where(eq(exportJobs.id, r.id));
          if (cur?.state !== 'running') throw Object.assign(new Error('cancelled'), { cancelled: true });
          await heartbeat(Math.min(90, 5 + Math.floor(rows / 500)), `${rows} rows`);
          await app.db.update(exportJobs).set({ progress: Math.min(90, 5 + Math.floor(rows / 500)) }).where(eq(exportJobs.id, r.id));
        }
      }
      await writer.finish();
      const stat = await fs.stat(tmp);
      await app.storage.putObject(key, createReadStream(tmp), { contentType: ext === 'csv' ? 'text/csv' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', contentLength: stat.size });
      uploaded = true;
      const now = app.clock.now();
      const done = await app.db
        .update(exportJobs)
        .set({ state: 'completed', storageKey: key, fileName, byteSize: stat.size, progress: 100, completedAt: now, expiresAt: new Date(now.getTime() + EXPORT_TTL_MS), errorMessage: null, updatedAt: now, rowVersion: sql`${exportJobs.rowVersion} + 1` })
        .where(and(eq(exportJobs.id, r.id), eq(exportJobs.state, 'running')))
        .returning({ id: exportJobs.id });
      if (done.length === 0) {
        // Cancelled while uploading: the artifact must not survive.
        await app.storage.deleteObject(key).catch(() => undefined);
        return { cancelled: true };
      }
      await streamEvent(app.db, { workspaceId: r.workspaceId, kind: 'entity_changed', entityType: 'export_job', entityId: r.id });
      return { rows, bytes: stat.size };
    } catch (e) {
      await writer.abort();
      if (uploaded) await app.storage.deleteObject(key).catch(() => undefined);
      if ((e as { cancelled?: boolean }).cancelled) {
        await app.db.update(exportJobs).set({ state: 'cancelled', storageKey: null, updatedAt: app.clock.now() }).where(and(eq(exportJobs.id, r.id), inArray(exportJobs.state, ['queued', 'running', 'cancelled'])));
        return { cancelled: true, rows };
      }
      // Only the error code/name is logged: messages may quote exported values.
      app.logger.warn('export_failed', { exportId: r.id, dataset: r.dataset, error: (e as { code?: string }).code ?? (e as Error)?.name ?? 'Error' });
      return fail(app, r, 'The export could not be generated. No file was created; retry the export.');
    } finally {
      await fs.rm(tmp, { force: true });
    }
  },
  { leaseSeconds: 900 },
);

/** Retention: expired export files are deleted after the 7-day TTL (section 22.3). */
export const expireExports = async (app: QueryContext['app']) => {
  const now = app.clock.now();
  const due = await app.db.select().from(exportJobs).where(and(eq(exportJobs.state, 'completed'), lt(exportJobs.expiresAt, now))).limit(500);
  for (const r of due) {
    await deleteArtifact({ app }, r.storageKey);
    await app.db.update(exportJobs).set({ state: 'expired', storageKey: null, updatedAt: now, rowVersion: sql`${exportJobs.rowVersion} + 1` }).where(eq(exportJobs.id, r.id));
  }
  return due.length;
};
