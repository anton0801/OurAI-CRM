import { and, isNotNull, lt, or, sql } from 'drizzle-orm';
import { authChallenges, eventStream, idempotencyRecords, jobs, rateLimitBuckets, sessions } from '@castlane/database';
import { defineJob, defineSchedule } from '../core/jobs-registry';

/** Periodic cleanup of operational data with short retention (section 22.3). */
defineJob('maintenance.cleanup', 'light', async ({ app }) => {
  const now = app.clock.now();
  const day = 86_400_000;
  const r1 = await app.db.delete(idempotencyRecords).where(lt(idempotencyRecords.expiresAt, now)).returning({ id: idempotencyRecords.id });
  const r2 = await app.db.delete(eventStream).where(lt(eventStream.createdAt, new Date(now.getTime() - day))).returning({ seq: eventStream.seq });
  const r3 = await app.db.delete(authChallenges).where(lt(authChallenges.expiresAt, new Date(now.getTime() - day))).returning({ id: authChallenges.id });
  const r4 = await app.db
    .delete(sessions)
    .where(or(lt(sessions.absoluteExpiresAt, new Date(now.getTime() - 30 * day)), and(isNotNull(sessions.revokedAt), lt(sessions.revokedAt, new Date(now.getTime() - 30 * day)))))
    .returning({ id: sessions.id });
  const r5 = await app.db.delete(rateLimitBuckets).where(lt(rateLimitBuckets.windowStart, new Date(now.getTime() - day))).returning({ key: rateLimitBuckets.key });
  const r6 = await app.db
    .delete(jobs)
    .where(and(sql`${jobs.state} IN ('succeeded', 'cancelled')`, lt(jobs.finishedAt, new Date(now.getTime() - 14 * day))))
    .returning({ id: jobs.id });
  return { idempotency: r1.length, stream: r2.length, challenges: r3.length, sessions: r4.length, buckets: r5.length, jobs: r6.length };
});

defineSchedule({ name: 'maintenance.cleanup', everySeconds: 3600, jobType: 'maintenance.cleanup' });
