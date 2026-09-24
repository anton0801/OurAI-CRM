# Job queue and outbox recovery

Signals (System Health / S71 and alerts): oldest due job > 10 min, dead-letter count rising,
outbox lag > 5 min, scan queue stalled > 15 min.

## Diagnose
```sql
-- queue depth by pool/state
SELECT pool, state, count(*), min(run_at) FROM jobs GROUP BY 1, 2 ORDER BY 1, 2;
-- oldest due jobs
SELECT id, type, attempts, run_at, last_error_code FROM jobs WHERE state = 'queued' AND run_at < now() ORDER BY run_at LIMIT 20;
-- running jobs with expired leases (worker died) — they are re-claimed automatically
SELECT id, type, lease_owner, lease_expires_at FROM jobs WHERE state = 'running' AND lease_expires_at < now();
-- outbox lag
SELECT count(*), min(occurred_at) FROM outbox_events WHERE dispatched_at IS NULL;
```
(Column names: see `packages/database/src/schema/platform.ts`.)

## Actions
* **Worker down / crash loop**: check worker logs (`docker compose logs worker`), fix config (the
  worker refuses to start with invalid production configuration), restart. Expired leases are
  re-claimed; handlers are idempotent, so re-running a job does not duplicate effects.
* **Dead-lettered jobs**: open System Health → Jobs, read the error, fix the cause, then **Retry**
  (keeps the idempotency key). Do not insert new jobs by hand.
* **Poison job blocking a pool**: jobs are retried with backoff (30 s, 2 m, 10 m, 30 m, 2 h) and
  then dead-lettered, so a single job cannot block a pool forever. Media jobs have their own pool.
* **Outbox lag**: usually the worker is down or a consumer throws. Consumers are per-event
  idempotent; after the fix the dispatcher catches up. Never delete outbox rows to "clear" lag.
* **Scheduler**: schedules enqueue one job per time bucket with a deterministic key; running two
  workers is safe.
