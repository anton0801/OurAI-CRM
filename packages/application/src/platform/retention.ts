import { and, eq, inArray, isNotNull, lt, not, sql } from 'drizzle-orm';
import { importJobs, jobs, uploadSessions, workspaces } from '@castlane/database';
import type { AppServices } from '../core/context';
import { defineJob, defineSchedule } from '../core/jobs-registry';
import { purgeExpiredTrash } from './archive';
import { expireExports } from './exports/engine';

const DAY = 86_400_000;
export const IMPORT_SOURCE_RETENTION_DAYS = 30;
export const JOB_DEBUG_RETENTION_DAYS = 14;
export const ORPHAN_UPLOAD_HOURS = 24;

/** Import uploads never attached to an import job are removed after 24 h (quarantine included). */
export const cleanOrphanImportUploads = async (app: AppServices) => {
  const cutoff = new Date(app.clock.now().getTime() - ORPHAN_UPLOAD_HOURS * 3_600_000);
  const stale = await app.db
    .select()
    .from(uploadSessions)
    .where(and(eq(uploadSessions.purpose, 'import'), inArray(uploadSessions.state, ['open', 'expired']), lt(uploadSessions.expiresAt, app.clock.now())))
    .limit(500);
  for (const s of stale) {
    if (s.multipartUploadId) await app.storage.abortMultipartUpload(s.quarantineKey, s.multipartUploadId).catch(() => undefined);
    await app.storage.deleteObject(s.quarantineKey).catch(() => undefined);
    await app.db.update(uploadSessions).set({ state: 'aborted', updatedAt: app.clock.now() }).where(eq(uploadSessions.id, s.id));
  }
  void cutoff;
  return stale.length;
};

/** Source files of finished imports are deleted after 30 days; the job record and result stay. */
export const cleanImportSources = async (app: AppServices) => {
  const cutoff = new Date(app.clock.now().getTime() - IMPORT_SOURCE_RETENTION_DAYS * DAY);
  const done = await app.db
    .select({ id: importJobs.id, key: importJobs.fileStorageKey })
    .from(importJobs)
    .where(and(inArray(importJobs.state, ['committed', 'cancelled', 'undone', 'failed']), lt(importJobs.updatedAt, cutoff), not(sql`${importJobs.fileStorageKey} LIKE 'deleted:%'`)))
    .limit(500);
  for (const j of done) {
    await app.storage.deleteObject(j.key).catch(() => undefined);
    await app.db.update(importJobs).set({ fileStorageKey: `deleted:${j.key}` }).where(eq(importJobs.id, j.id));
  }
  return done.length;
};

/** Job debug information (failed / dead-lettered jobs) is kept for 14 days after they finished. */
export const cleanJobDebugLogs = async (app: AppServices) => {
  const cutoff = new Date(app.clock.now().getTime() - JOB_DEBUG_RETENTION_DAYS * DAY);
  const rows = await app.db.delete(jobs).where(and(inArray(jobs.state, ['failed', 'dead']), isNotNull(jobs.finishedAt), lt(jobs.finishedAt, cutoff))).returning({ id: jobs.id });
  return rows.length;
};

/** Audit events older than the workspace's audit retention (default 24 months) via the SECURITY DEFINER purge. */
export const purgeExpiredAudit = async (app: AppServices) => {
  const wss = await app.db.select({ id: workspaces.id, settings: workspaces.settings }).from(workspaces);
  let removed = 0;
  for (const w of wss) {
    const months = Math.max(1, w.settings?.retention?.auditMonths ?? 24);
    const cutoff = new Date(app.clock.now());
    cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
    const r = await app.db.execute<{ n: number }>(sql`SELECT castlane_purge_audit_ws(${w.id}::uuid, ${cutoff.toISOString()}::timestamptz) AS n`);
    removed += Number(r.rows[0]?.n ?? 0);
  }
  return removed;
};

/** Daily retention run (section 22.3): each step is independent and idempotent. */
export const runRetention = async (app: AppServices) => {
  const out: Record<string, number | string> = {};
  const steps: [string, () => Promise<number>][] = [
    ['expiredExports', () => expireExports(app)],
    ['orphanImportUploads', () => cleanOrphanImportUploads(app)],
    ['importSources', () => cleanImportSources(app)],
    ['trashPurged', () => purgeExpiredTrash(app)],
    ['jobDebugLogs', () => cleanJobDebugLogs(app)],
    ['auditPurged', () => purgeExpiredAudit(app)],
  ];
  for (const [name, fn] of steps) {
    try {
      out[name] = await fn();
    } catch (e) {
      app.logger.error('retention_step_failed', { step: name, error: (e as { code?: string }).code ?? (e as Error)?.name ?? 'Error' });
      out[name] = 'failed';
    }
  }
  return out;
};

defineJob('platform.retention', 'light', async ({ app }) => runRetention(app), { leaseSeconds: 1800 });
defineSchedule({ name: 'platform.retention', everySeconds: 86_400, jobType: 'platform.retention' });
