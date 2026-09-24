import { and, eq, inArray, lte, or, sql } from 'drizzle-orm';
import { jobs } from '@castlane/database';
import { isAppError } from '@castlane/domain';
import { JOB_DEFINITIONS, streamEvent, type AppServices, type JobRecord } from '@castlane/application';

/** Retry schedule after the first attempt (section 19): 30 s, 2 min, 10 min, 30 min, 2 h. */
export const RETRY_DELAYS_S = [30, 120, 600, 1800, 7200];

/** Validation/permission/state errors are permanent: they never retry automatically. */
const PERMANENT_CODES = new Set(['VALIDATION_FAILED', 'FORBIDDEN', 'NOT_FOUND', 'INVALID_STATE', 'DUPLICATE', 'MALFORMED_REQUEST', 'QUOTA_EXCEEDED', 'IDEMPOTENCY_PAYLOAD_MISMATCH']);

export const isPermanentError = (e: unknown) => isAppError(e) && PERMANENT_CODES.has(e.code);

export class JobRunner {
  private running = 0;
  private stopping = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly inflight = new Set<Promise<void>>();

  constructor(
    private readonly app: AppServices,
    private readonly pool: 'light' | 'data' | 'media',
    private readonly concurrency: number,
    private readonly workerId: string,
  ) {}

  start() {
    this.loop();
  }

  private loop = () => {
    if (this.stopping) return;
    const free = this.concurrency - this.running;
    const work = free > 0 ? this.claim(free) : Promise.resolve(0);
    work
      .catch((e) => this.app.logger.error('job_claim_failed', { pool: this.pool, error: (e as Error).message }))
      .then((n) => {
        this.timer = setTimeout(this.loop, n ? 50 : 1000);
      });
  };

  /** Claim due jobs with FOR UPDATE SKIP LOCKED and a lease; expired leases are reclaimed. */
  async claim(limit: number): Promise<number> {
    const now = this.app.clock.now();
    const types = [...JOB_DEFINITIONS.values()].filter((d) => d.pool === this.pool).map((d) => d.type);
    if (types.length === 0) return 0;
    const claimed = await this.app.db.execute<{ id: string }>(sql`
      UPDATE ${jobs} SET state = 'running', lease_owner = ${this.workerId},
        lease_expires_at = ${now}::timestamptz + interval '5 minutes', heartbeat_at = ${now}, attempts = attempts + 1, updated_at = ${now}
      WHERE id IN (
        SELECT id FROM ${jobs}
        WHERE pool = ${this.pool} AND type IN (${sql.join(types.map((t) => sql`${t}`), sql`, `)})
          AND ((state = 'queued' AND run_at <= ${now}) OR (state = 'running' AND lease_expires_at < ${now}))
          AND cancel_requested = false
        ORDER BY priority DESC, run_at ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id`);
    for (const row of claimed.rows) {
      this.running++;
      const p = this.execute(row.id).finally(() => {
        this.running--;
        this.inflight.delete(p);
      });
      this.inflight.add(p);
    }
    return claimed.rows.length;
  }

  private async execute(id: string) {
    const [job] = await this.app.db.select().from(jobs).where(eq(jobs.id, id));
    if (!job) return;
    const def = JOB_DEFINITIONS.get(job.type);
    const record: JobRecord = {
      id: job.id,
      type: job.type,
      workspaceId: job.workspaceId,
      payload: job.payload,
      attempts: job.attempts,
      causation: job.causation,
      requestedBy: job.requestedBy,
    };
    const started = Date.now();
    try {
      if (!def) throw Object.assign(new Error(`No handler for job type ${job.type}`), { permanent: true });
      const result = await def.handler({
        app: this.app,
        job: record,
        heartbeat: async (progress, note) => {
          const at = this.app.clock.now();
          await this.app.db
            .update(jobs)
            .set({
              heartbeatAt: at,
              leaseExpiresAt: new Date(at.getTime() + (def.leaseSeconds ?? 300) * 1000),
              progress: progress === undefined ? undefined : Math.min(99, Math.max(0, Math.round(progress))),
              progressNote: note,
            })
            .where(and(eq(jobs.id, id), eq(jobs.leaseOwner, this.workerId)));
          if (job.workspaceId) await streamEvent(this.app.db, { workspaceId: job.workspaceId, kind: 'job_progress', entityType: 'job', entityId: id });
        },
        cancelled: async () => {
          const [r] = await this.app.db.select({ c: jobs.cancelRequested }).from(jobs).where(eq(jobs.id, id));
          return !!r?.c;
        },
      });
      await this.app.db
        .update(jobs)
        .set({ state: 'succeeded', progress: 100, result: result ?? null, finishedAt: this.app.clock.now(), leaseOwner: null, leaseExpiresAt: null, updatedAt: this.app.clock.now() })
        .where(and(eq(jobs.id, id), eq(jobs.leaseOwner, this.workerId)));
      this.app.logger.info('job_succeeded', { jobId: id, type: job.type, ms: Date.now() - started });
    } catch (e) {
      const permanent = isPermanentError(e) || (e as { permanent?: boolean }).permanent === true;
      const retriesUsed = job.attempts - 1;
      const exhausted = retriesUsed >= Math.min(job.maxRetries, RETRY_DELAYS_S.length);
      const code = isAppError(e) ? e.code : (e as { code?: string }).code ?? 'ERROR';
      const message = ((e as Error).message ?? 'error').slice(0, 500);
      const at = this.app.clock.now();
      if (permanent || exhausted) {
        await this.app.db
          .update(jobs)
          .set({ state: permanent ? 'failed' : 'dead', lastErrorCode: code, lastErrorMessage: message, finishedAt: at, leaseOwner: null, leaseExpiresAt: null, updatedAt: at })
          .where(eq(jobs.id, id));
        this.app.logger.warn(permanent ? 'job_failed_permanently' : 'job_dead_lettered', { jobId: id, type: job.type, code });
      } else {
        const delay = RETRY_DELAYS_S[retriesUsed] ?? 7200;
        await this.app.db
          .update(jobs)
          .set({ state: 'queued', runAt: new Date(at.getTime() + delay * 1000), lastErrorCode: code, lastErrorMessage: message, leaseOwner: null, leaseExpiresAt: null, updatedAt: at })
          .where(eq(jobs.id, id));
        this.app.logger.warn('job_retry_scheduled', { jobId: id, type: job.type, code, inSeconds: delay });
      }
    }
  }

  /** Stop claiming; wait for running jobs up to the grace period (unfinished jobs return via lease expiry). */
  async stop(graceMs = 25_000) {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    await Promise.race([Promise.all([...this.inflight]), new Promise((r) => setTimeout(r, graceMs))]);
  }
}

/** Cancel requested jobs that have not started yet (running ones check `cancelled()`). */
export const sweepCancelled = async (app: AppServices) => {
  await app.db
    .update(jobs)
    .set({ state: 'cancelled', finishedAt: app.clock.now(), updatedAt: app.clock.now() })
    .where(and(eq(jobs.cancelRequested, true), inArray(jobs.state, ['queued']), or(lte(jobs.runAt, app.clock.now()), sql`true`)));
};
