import { SCHEDULES, enqueueJob, type AppServices } from '@castlane/application';

/**
 * Enqueue each schedule once per time bucket. The idempotency key makes concurrent schedulers
 * (several worker replicas) and restarts harmless.
 */
export const runSchedulerTick = async (app: AppServices): Promise<void> => {
  const now = app.clock.now().getTime();
  for (const s of SCHEDULES) {
    const bucket = Math.floor(now / (s.everySeconds * 1000));
    await enqueueJob(app.db, {
      type: s.jobType,
      workspaceId: null,
      pool: s.pool,
      idempotencyKey: `schedule:${s.name}:${bucket}`,
      payload: { bucket, scheduledAt: new Date(bucket * s.everySeconds * 1000).toISOString() },
    });
  }
};
