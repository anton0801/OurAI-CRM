/**
 * In-process token buckets for API rate limits (section 24.3). Authentication limits are
 * enforced in PostgreSQL (shared across instances); these protect a single web instance from
 * bursts. Defaults are configurable through environment variables.
 */
export type Budget = 'read' | 'write' | 'expensive' | 'auth' | 'download' | 'none';

const PER_MINUTE: Record<Budget, number> = {
  read: Number(process.env.RATE_LIMIT_READ_PER_MIN ?? 300),
  write: Number(process.env.RATE_LIMIT_WRITE_PER_MIN ?? 120),
  expensive: Number(process.env.RATE_LIMIT_EXPENSIVE_PER_MIN ?? 10),
  auth: Number(process.env.RATE_LIMIT_AUTH_PER_MIN ?? 30),
  download: Number(process.env.RATE_LIMIT_DOWNLOAD_PER_MIN ?? 20),
  none: Number.POSITIVE_INFINITY,
};

interface Bucket {
  tokens: number;
  updatedAt: number;
}
const buckets = new Map<string, Bucket>();
let lastSweep = Date.now();

/** Returns seconds to wait when the budget is exhausted, otherwise null. */
export const consume = (key: string, budget: Budget, now = Date.now()): number | null => {
  const capacity = PER_MINUTE[budget];
  if (!Number.isFinite(capacity)) return null;
  const k = `${budget}:${key}`;
  const refillPerMs = capacity / 60_000;
  const b = buckets.get(k) ?? { tokens: capacity, updatedAt: now };
  b.tokens = Math.min(capacity, b.tokens + (now - b.updatedAt) * refillPerMs);
  b.updatedAt = now;
  if (b.tokens < 1) {
    buckets.set(k, b);
    return Math.max(1, Math.ceil((1 - b.tokens) / refillPerMs / 1000));
  }
  b.tokens -= 1;
  buckets.set(k, b);
  if (now - lastSweep > 300_000) {
    lastSweep = now;
    for (const [key2, v] of buckets) if (now - v.updatedAt > 600_000) buckets.delete(key2);
  }
  return null;
};

export const resetRateLimits = () => buckets.clear();
