import { sql } from 'drizzle-orm';
import { rateLimitBuckets, type DbOrTx } from '@castlane/database';
import { AppError } from '@castlane/domain';

/**
 * Fixed-window counter stored in PostgreSQL so limits hold across web instances. Used for
 * authentication (5 failures / 15 min per account and per IP) with progressive delay.
 */
export const hitBucket = async (
  db: DbOrTx,
  key: string,
  opts: { limit: number; windowSeconds: number; blockSeconds?: number; at: Date },
): Promise<{ count: number; blockedUntil: Date | null }> => {
  const res = await db.execute<{ count: number; blocked_until: Date | null }>(sql`
    INSERT INTO ${rateLimitBuckets} (key, window_start, count, blocked_until)
    VALUES (${key}, ${opts.at}, 1, NULL)
    ON CONFLICT (key) DO UPDATE SET
      count = CASE WHEN ${rateLimitBuckets.windowStart} < ${opts.at}::timestamptz - make_interval(secs => ${opts.windowSeconds})
                   THEN 1 ELSE ${rateLimitBuckets.count} + 1 END,
      window_start = CASE WHEN ${rateLimitBuckets.windowStart} < ${opts.at}::timestamptz - make_interval(secs => ${opts.windowSeconds})
                   THEN ${opts.at} ELSE ${rateLimitBuckets.windowStart} END,
      blocked_until = CASE WHEN (CASE WHEN ${rateLimitBuckets.windowStart} < ${opts.at}::timestamptz - make_interval(secs => ${opts.windowSeconds})
                   THEN 1 ELSE ${rateLimitBuckets.count} + 1 END) >= ${opts.limit}
                   THEN ${opts.at}::timestamptz + make_interval(secs => ${opts.blockSeconds ?? opts.windowSeconds})
                   ELSE ${rateLimitBuckets.blockedUntil} END
    RETURNING count, blocked_until
  `);
  const row = res.rows[0];
  return { count: Number(row?.count ?? 1), blockedUntil: row?.blocked_until ? new Date(row.blocked_until) : null };
};

export const checkBlocked = async (db: DbOrTx, keys: string[], at: Date): Promise<number | null> => {
  if (keys.length === 0) return null;
  const res = await db.execute<{ blocked_until: Date | null }>(sql`
    SELECT max(blocked_until) AS blocked_until FROM ${rateLimitBuckets} WHERE key IN (${sql.join(keys.map((k) => sql`${k}`), sql`, `)})
  `);
  const until = res.rows[0]?.blocked_until ? new Date(res.rows[0].blocked_until) : null;
  if (until && until > at) return Math.ceil((until.getTime() - at.getTime()) / 1000);
  return null;
};

export const clearBucket = async (db: DbOrTx, key: string) => {
  await db.execute(sql`DELETE FROM ${rateLimitBuckets} WHERE key = ${key}`);
};

export const rateLimited = (retryAfterSeconds: number) =>
  new AppError('RATE_LIMITED', 'Too many attempts. Try again later.', { retryAfterSeconds, retryable: true });

/** Progressive delay after repeated failures (bounded to keep the request responsive). */
export const progressiveDelay = async (failures: number) => {
  const ms = Math.min(2000, failures <= 1 ? 0 : 150 * 2 ** Math.min(failures - 2, 4));
  if (ms > 0) await new Promise((r) => setTimeout(r, ms));
};
