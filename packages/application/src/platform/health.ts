import { and, desc, eq, gte, inArray, isNull, lt, lte, ne, or, sql, type SQL } from 'drizzle-orm';
import { backupRuns, incidents, jobs, mailMessages, outboxEvents, workspaces, type Db } from '@castlane/database';
import { AppError, clampPageSize, decodeCursor, encodeCursor, newId, notFound, type EnumValue, type JOB_STATES } from '@castlane/domain';
import { requirePermission, requireRecentAuth } from '../core/access';
import { audit } from '../core/audit';
import type { AppServices, CommandContext, QueryContext } from '../core/context';
import { emit, streamEvent } from '../core/events';
import { defineJob, defineSchedule } from '../core/jobs-registry';

type JobState = EnumValue<typeof JOB_STATES>;

export const BACKUP_FRESHNESS_HOURS = 26;
export const QUEUE_STALL_MINUTES = 10;
export const OUTBOX_LAG_MINUTES = 5;
export const STORAGE_ALERT_PERCENT = 85;
const DEFAULT_QUOTA = 500n * 1024n ** 3n;

/** Public liveness: process is up. No infrastructure metadata. */
export const liveness = () => ({ status: 'ok' as const });

/** Public readiness: database and object storage reachable. */
export const readiness = async (app: AppServices) => {
  let database: 'ok' | 'failed' = 'ok';
  let storage: 'ok' | 'failed' = 'ok';
  try {
    await app.db.execute(sql`SELECT 1`);
  } catch {
    database = 'failed';
  }
  try {
    storage = (await app.storage.healthCheck()).ok ? 'ok' : 'failed';
  } catch {
    storage = 'failed';
  }
  return { status: database === 'ok' && storage === 'ok' ? ('ready' as const) : ('not_ready' as const), checks: { database, storage } };
};

/** Jobs of this workspace plus deployment-wide maintenance jobs (no workspace). */
const jobScope = (ctx: QueryContext): SQL => or(eq(jobs.workspaceId, ctx.actor.workspaceId), isNull(jobs.workspaceId))!;

const quotaOf = (settings: { fileQuotaBytes?: string } | null | undefined) => BigInt(settings?.fileQuotaBytes ?? DEFAULT_QUOTA.toString());

const percent = (used: bigint, quota: bigint) => (quota > 0n ? (Number((used * 1000n) / quota) / 10).toFixed(1) : null);

export const latestBackups = async (db: Db) => {
  const [lastSuccess] = await db.select().from(backupRuns).where(and(eq(backupRuns.kind, 'backup'), eq(backupRuns.status, 'succeeded'))).orderBy(desc(backupRuns.finishedAt)).limit(1);
  const [lastRun] = await db.select().from(backupRuns).where(eq(backupRuns.kind, 'backup')).orderBy(desc(backupRuns.startedAt)).limit(1);
  const [lastDrill] = await db.select().from(backupRuns).where(eq(backupRuns.kind, 'restore_drill')).orderBy(desc(backupRuns.startedAt)).limit(1);
  return { lastSuccess, lastRun, lastDrill };
};

/**
 * Technical health for administrators (S71 System tab). "Backup healthy" requires a confirmed
 * successful backup within the freshness window; the last restore test is reported separately.
 * Operational incidents never influence these values.
 */
export const systemHealth = async (ctx: QueryContext) => {
  requirePermission(ctx, 'system.jobs.read');
  const db = ctx.app.db;
  const now = ctx.app.clock.now();
  const [byState, [oldest], [dead], [outbox], [mail], [ws], backups, [openAlerts]] = await Promise.all([
    db
      .select({ pool: jobs.pool, state: jobs.state, count: sql<number>`count(*)::int` })
      .from(jobs)
      .where(and(jobScope(ctx), inArray(jobs.state, ['queued', 'running', 'failed', 'dead'])))
      .groupBy(jobs.pool, jobs.state),
    db.select({ at: sql<Date | null>`min(${jobs.runAt})` }).from(jobs).where(and(jobScope(ctx), eq(jobs.state, 'queued'), lte(jobs.runAt, now))),
    db.select({ n: sql<number>`count(*)::int` }).from(jobs).where(and(jobScope(ctx), eq(jobs.state, 'dead'))),
    db
      .select({ n: sql<number>`count(*)::int`, oldest: sql<Date | null>`min(${outboxEvents.occurredAt})` })
      .from(outboxEvents)
      .where(and(or(eq(outboxEvents.workspaceId, ctx.actor.workspaceId), isNull(outboxEvents.workspaceId)), isNull(outboxEvents.dispatchedAt))),
    db
      .select({
        sent: sql<number>`count(*) FILTER (WHERE ${mailMessages.status} = 'sent')::int`,
        failed: sql<number>`count(*) FILTER (WHERE ${mailMessages.status} = 'failed')::int`,
        lastFailure: sql<Date | null>`max(${mailMessages.createdAt}) FILTER (WHERE ${mailMessages.status} = 'failed')`,
      })
      .from(mailMessages)
      .where(and(eq(mailMessages.workspaceId, ctx.actor.workspaceId), gte(mailMessages.createdAt, new Date(now.getTime() - 86_400_000)))),
    db.select().from(workspaces).where(eq(workspaces.id, ctx.actor.workspaceId)),
    latestBackups(db),
    db.select({ n: sql<number>`count(*)::int` }).from(incidents).where(and(eq(incidents.workspaceId, ctx.actor.workspaceId), eq(incidents.kind, 'system'), ne(incidents.state, 'resolved'))),
  ]);
  const storageCheck = await ctx.app.storage.healthCheck().catch(() => ({ ok: false }));
  const scannerCheck = await ctx.app.scanner.healthCheck().catch(() => ({ ok: false }));
  const quota = quotaOf(ws?.settings);
  const used = ws?.storageUsedBytes ?? 0n;
  const toDate = (v: Date | string | null | undefined) => (v ? new Date(v) : null);
  const oldestOutbox = toDate(outbox?.oldest);
  const lastSuccessAt = backups.lastSuccess?.finishedAt ?? null;
  return {
    asOf: now.toISOString(),
    jobs: byState.map((r) => ({ pool: r.pool, state: r.state, count: Number(r.count) })),
    oldestDueJobAt: toDate(oldest?.at)?.toISOString() ?? null,
    deadLettered: Number(dead?.n ?? 0),
    outbox: { pending: Number(outbox?.n ?? 0), oldestPendingAt: oldestOutbox?.toISOString() ?? null, lagSeconds: oldestOutbox ? Math.max(0, Math.round((now.getTime() - oldestOutbox.getTime()) / 1000)) : null },
    mail: { transport: ctx.app.config.MAIL_TRANSPORT, sentLast24h: Number(mail?.sent ?? 0), failedLast24h: Number(mail?.failed ?? 0), lastFailureAt: toDate(mail?.lastFailure)?.toISOString() ?? null },
    storage: { ok: storageCheck.ok, usedBytes: used.toString(), reservedBytes: (ws?.storageReservedBytes ?? 0n).toString(), quotaBytes: quota.toString(), usedPercent: percent(used, quota) },
    scanner: { mode: ctx.app.scanner.mode, ok: scannerCheck.ok },
    backup: {
      lastSuccessAt: lastSuccessAt?.toISOString() ?? null,
      lastRunStatus: backups.lastRun?.status ?? null,
      healthy: !!lastSuccessAt && now.getTime() - lastSuccessAt.getTime() <= BACKUP_FRESHNESS_HOURS * 3_600_000,
      freshnessHours: BACKUP_FRESHNESS_HOURS,
      lastRestoreTestAt: (backups.lastDrill?.finishedAt ?? backups.lastDrill?.startedAt)?.toISOString() ?? null,
      lastRestoreResult: backups.lastDrill?.status ?? null,
    },
    openSystemIncidents: Number(openAlerts?.n ?? 0),
  };
};

export const listJobs = async (ctx: QueryContext, input: { cursor?: string; pageSize?: number; state?: JobState[]; pool?: 'light' | 'data' | 'media'; type?: string }) => {
  requirePermission(ctx, 'system.jobs.read');
  const size = clampPageSize(input.pageSize);
  const c = input.cursor ? decodeCursor(input.cursor) : null;
  const states = input.state?.length ? input.state : (['dead', 'failed'] as JobState[]);
  const rows = await ctx.app.db
    .select()
    .from(jobs)
    .where(
      and(
        jobScope(ctx),
        inArray(jobs.state, states),
        input.pool ? eq(jobs.pool, input.pool) : undefined,
        input.type ? eq(jobs.type, input.type) : undefined,
        c ? or(lt(jobs.createdAt, new Date(String(c.v[0]))), and(eq(jobs.createdAt, new Date(String(c.v[0]))), lt(jobs.id, c.id))) : undefined,
      ),
    )
    .orderBy(desc(jobs.createdAt), desc(jobs.id))
    .limit(size + 1);
  const hasMore = rows.length > size;
  const page = hasMore ? rows.slice(0, size) : rows;
  const last = page[page.length - 1];
  const canRetry = (s: JobState) => s === 'dead' || s === 'failed';
  return {
    items: page.map((j) => ({
      id: j.id,
      type: j.type,
      pool: j.pool,
      state: j.state,
      attempts: j.attempts,
      maxRetries: j.maxRetries,
      progress: j.progress,
      lastErrorCode: j.lastErrorCode,
      lastErrorMessage: j.lastErrorMessage,
      runAt: j.runAt.toISOString(),
      createdAt: j.createdAt.toISOString(),
      finishedAt: j.finishedAt?.toISOString() ?? null,
      canRetry: canRetry(j.state),
      canCancel: j.state === 'queued' || j.state === 'running',
    })),
    hasMore,
    nextCursor: hasMore && last ? encodeCursor({ v: [last.createdAt.toISOString()], id: last.id }) : null,
  };
};

const lockJob = async (ctx: CommandContext, id: string) => {
  const [j] = await ctx.tx.select().from(jobs).where(and(eq(jobs.id, id), jobScope(ctx))).for('update');
  if (!j) throw notFound('Job');
  return j;
};

/**
 * Manual Retry of a dead-lettered/failed job: same payload and operation (idempotency) key; the
 * handler re-authorises its principal when it runs, so a revoked requester's job fails again.
 */
export const retryJob = async (ctx: CommandContext, id: string, reason?: string) => {
  requirePermission(ctx, 'system.jobs.retry');
  const j = await lockJob(ctx, id);
  if (j.state !== 'dead' && j.state !== 'failed') throw new AppError('INVALID_STATE', 'Only failed or dead-lettered jobs can be retried.', { details: { state: j.state } });
  const now = ctx.app.clock.now();
  await ctx.tx
    .update(jobs)
    .set({ state: 'queued', runAt: now, attempts: 0, finishedAt: null, cancelRequested: false, leaseOwner: null, leaseExpiresAt: null, updatedAt: now })
    .where(eq(jobs.id, id));
  await audit(ctx, { action: 'job.retried', entityType: 'job', entityId: id, reason: reason ?? null, metadata: { type: j.type, previousState: j.state, lastErrorCode: j.lastErrorCode }, sensitivity: 'security' });
  await streamEvent(ctx.tx, { workspaceId: ctx.actor.workspaceId, kind: 'job_progress', entityType: 'job', entityId: id });
  return { ok: true as const };
};

export const cancelJob = async (ctx: CommandContext, id: string, reason?: string) => {
  requirePermission(ctx, 'system.jobs.retry');
  const j = await lockJob(ctx, id);
  const now = ctx.app.clock.now();
  if (j.state === 'queued') await ctx.tx.update(jobs).set({ state: 'cancelled', cancelRequested: true, finishedAt: now, updatedAt: now }).where(eq(jobs.id, id));
  else if (j.state === 'running') await ctx.tx.update(jobs).set({ cancelRequested: true, updatedAt: now }).where(eq(jobs.id, id));
  else throw new AppError('INVALID_STATE', 'Only queued or running jobs can be cancelled.', { details: { state: j.state } });
  await audit(ctx, { action: 'job.cancel_requested', entityType: 'job', entityId: id, reason: reason ?? null, metadata: { type: j.type, state: j.state }, sensitivity: 'security' });
  await streamEvent(ctx.tx, { workspaceId: ctx.actor.workspaceId, kind: 'job_progress', entityType: 'job', entityId: id });
  return { ok: true as const };
};

/** Mail delivery records (subjects and outcome only, never bodies). */
export const listMail = async (ctx: QueryContext, input: { cursor?: string; pageSize?: number; status?: 'queued' | 'sent' | 'failed' }) => {
  requirePermission(ctx, 'system.jobs.read');
  const size = clampPageSize(input.pageSize);
  const c = input.cursor ? decodeCursor(input.cursor) : null;
  const rows = await ctx.app.db
    .select({
      id: mailMessages.id,
      to: mailMessages.toAddress,
      subject: mailMessages.subject,
      template: mailMessages.template,
      status: mailMessages.status,
      transport: mailMessages.transport,
      attempts: mailMessages.attempts,
      error: mailMessages.error,
      createdAt: mailMessages.createdAt,
      sentAt: mailMessages.sentAt,
    })
    .from(mailMessages)
    .where(
      and(
        eq(mailMessages.workspaceId, ctx.actor.workspaceId),
        input.status ? eq(mailMessages.status, input.status) : undefined,
        c ? or(lt(mailMessages.createdAt, new Date(String(c.v[0]))), and(eq(mailMessages.createdAt, new Date(String(c.v[0]))), lt(mailMessages.id, c.id))) : undefined,
      ),
    )
    .orderBy(desc(mailMessages.createdAt), desc(mailMessages.id))
    .limit(size + 1);
  const hasMore = rows.length > size;
  const page = hasMore ? rows.slice(0, size) : rows;
  const last = page[page.length - 1];
  return {
    items: page.map((m) => ({ ...m, createdAt: m.createdAt.toISOString(), sentAt: m.sentAt?.toISOString() ?? null })),
    hasMore,
    nextCursor: hasMore && last ? encodeCursor({ v: [last.createdAt.toISOString()], id: last.id }) : null,
  };
};

export const listBackupRuns = async (ctx: QueryContext, kind?: 'backup' | 'restore_drill') => {
  requirePermission(ctx, 'backups.status.read');
  const rows = await ctx.app.db.select().from(backupRuns).where(kind ? eq(backupRuns.kind, kind) : undefined).orderBy(desc(backupRuns.startedAt)).limit(50);
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    status: r.status,
    startedAt: r.startedAt.toISOString(),
    finishedAt: r.finishedAt?.toISOString() ?? null,
    recoveredTimestamp: r.recoveredTimestamp?.toISOString() ?? null,
    durationSeconds: r.durationSeconds,
    details: r.details,
    reportedBy: r.reportedBy,
  }));
};

export interface BackupRunInput {
  kind: 'backup' | 'restore_drill';
  status: 'running' | 'succeeded' | 'failed';
  startedAt: Date;
  finishedAt?: Date | null;
  recoveredTimestamp?: Date | null;
  details?: Record<string, unknown>;
  reportedBy: string;
}

/** Called by backup tooling (worker CLI) to report a backup run or an automated restore drill. */
export const recordBackupRun = async (db: Db, input: BackupRunInput) => {
  const id = newId();
  await db.insert(backupRuns).values({
    id,
    kind: input.kind,
    status: input.status,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt ?? null,
    recoveredTimestamp: input.recoveredTimestamp ?? null,
    durationSeconds: input.finishedAt ? Math.max(0, Math.round((input.finishedAt.getTime() - input.startedAt.getTime()) / 1000)) : null,
    details: input.details ?? {},
    reportedBy: input.reportedBy.slice(0, 120),
  });
  return id;
};

/** Record a restore drill performed by an operator (duration, recovered point, missing objects, verified counts). */
export const recordRestoreDrill = async (
  ctx: CommandContext,
  input: { status: 'succeeded' | 'failed'; startedAt: string; finishedAt: string; recoveredTimestamp?: string | null; missingObjects: number; verifiedCounts: string; notes?: string },
) => {
  requirePermission(ctx, 'backups.status.read');
  requireRecentAuth(ctx);
  const startedAt = new Date(input.startedAt);
  const finishedAt = new Date(input.finishedAt);
  if (finishedAt < startedAt) throw new AppError('VALIDATION_FAILED', 'The drill cannot finish before it started.', { fieldErrors: [{ field: 'finishedAt', code: 'BEFORE_START', message: 'The drill cannot finish before it started.' }] });
  if (finishedAt > ctx.app.clock.now()) throw new AppError('VALIDATION_FAILED', 'Record drills that already happened.', { fieldErrors: [{ field: 'finishedAt', code: 'FUTURE', message: 'Record drills that already happened.' }] });
  const id = await recordBackupRun(ctx.tx as unknown as Db, {
    kind: 'restore_drill',
    status: input.status,
    startedAt,
    finishedAt,
    recoveredTimestamp: input.recoveredTimestamp ? new Date(input.recoveredTimestamp) : null,
    details: { missingObjects: input.missingObjects, verifiedCounts: input.verifiedCounts, notes: input.notes ?? null, source: 'manual', workspaceId: ctx.actor.workspaceId },
    reportedBy: `${ctx.actor.displayName} (recorded manually)`,
  });
  await audit(ctx, { action: 'backup.restore_drill_recorded', entityType: 'backup_run', entityId: id, metadata: { status: input.status, missingObjects: input.missingObjects }, sensitivity: 'security' });
  return { ok: true as const };
};

// ——— Health monitor: system alerts as system incidents (deduplicated by alert key) ———

interface AlertCondition {
  key: string;
  active: boolean;
  severity: 'low' | 'medium' | 'high' | 'critical';
  title: string;
  description: string;
}

const raiseOrClear = async (app: AppServices, workspaceId: string, c: AlertCondition) => {
  const now = app.clock.now();
  if (c.active) {
    const rows = await app.db
      .insert(incidents)
      .values({ id: newId(), workspaceId, createdAt: now, updatedAt: now, kind: 'system', severity: c.severity, title: c.title, description: c.description, state: 'open', alertKey: c.key })
      .onConflictDoNothing()
      .returning({ id: incidents.id });
    if (rows[0]) await streamEvent(app.db, { workspaceId, kind: 'entity_changed', entityType: 'incident', entityId: rows[0].id });
    return rows.length;
  }
  const cleared = await app.db
    .update(incidents)
    .set({ state: 'resolved', resolution: 'Condition cleared automatically.', resolvedAt: now, updatedAt: now, rowVersion: sql`${incidents.rowVersion} + 1` })
    .where(and(eq(incidents.workspaceId, workspaceId), eq(incidents.alertKey, c.key), ne(incidents.state, 'resolved')))
    .returning({ id: incidents.id });
  for (const r of cleared) await streamEvent(app.db, { workspaceId, kind: 'entity_changed', entityType: 'incident', entityId: r.id });
  return 0;
};

/** Evaluate the operational alert thresholds (section 27.3) and raise/clear system incidents. */
export const runHealthMonitor = async (app: AppServices) => {
  const now = app.clock.now();
  const wss = await app.db.select().from(workspaces);
  const backups = await latestBackups(app.db);
  const backupOk = !!backups.lastSuccess?.finishedAt && now.getTime() - backups.lastSuccess.finishedAt.getTime() <= BACKUP_FRESHNESS_HOURS * 3_600_000;
  const [stalled] = await app.db
    .select({ at: sql<Date | null>`min(${jobs.runAt})` })
    .from(jobs)
    .where(and(eq(jobs.state, 'queued'), lt(jobs.runAt, new Date(now.getTime() - QUEUE_STALL_MINUTES * 60_000))));
  const [lag] = await app.db
    .select({ at: sql<Date | null>`min(${outboxEvents.occurredAt})` })
    .from(outboxEvents)
    .where(and(isNull(outboxEvents.dispatchedAt), lt(outboxEvents.occurredAt, new Date(now.getTime() - OUTBOX_LAG_MINUTES * 60_000))));
  let raised = 0;
  for (const w of wss) {
    const [dead] = await app.db.select({ n: sql<number>`count(*)::int` }).from(jobs).where(and(eq(jobs.workspaceId, w.id), eq(jobs.state, 'dead')));
    const quota = quotaOf(w.settings);
    const usedPct = quota > 0n ? Number((w.storageUsedBytes * 100n) / quota) : 0;
    const conditions: AlertCondition[] = [
      {
        key: 'backup.stale',
        active: !backupOk,
        severity: 'high',
        title: 'No recent successful backup',
        description: backups.lastSuccess?.finishedAt
          ? `The last confirmed successful backup finished at ${backups.lastSuccess.finishedAt.toISOString()} (older than ${BACKUP_FRESHNESS_HOURS} h).`
          : 'No successful backup has been reported by the backup tooling yet.',
      },
      { key: 'queue.stalled', active: !!stalled?.at, severity: 'high', title: 'Background jobs are not being processed', description: `The oldest due job has waited more than ${QUEUE_STALL_MINUTES} minutes. Check that the worker is running.` },
      { key: 'outbox.lag', active: !!lag?.at, severity: 'medium', title: 'Event delivery is delayed', description: `Domain events have waited more than ${OUTBOX_LAG_MINUTES} minutes for delivery. Notifications and automations may be late.` },
      { key: 'jobs.dead', active: Number(dead?.n ?? 0) > 0, severity: 'medium', title: 'Background jobs failed permanently', description: `${Number(dead?.n ?? 0)} job(s) are dead-lettered. Review them and retry after fixing the cause.` },
      { key: 'storage.quota', active: usedPct >= STORAGE_ALERT_PERCENT, severity: 'medium', title: 'Storage almost full', description: `File storage is ${usedPct}% of the workspace quota.` },
    ];
    for (const c of conditions) raised += await raiseOrClear(app, w.id, c);
  }
  return { workspaces: wss.length, raised };
};

defineJob('platform.healthMonitor', 'light', async ({ app }) => runHealthMonitor(app));
defineSchedule({ name: 'platform.healthMonitor', everySeconds: 300, jobType: 'platform.healthMonitor' });

void emit;
