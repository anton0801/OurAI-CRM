# ADR 0008 — Jobs, outbox and idempotency

Status: accepted (2026-09-24)

## Context
R18 forbids duplicates from retries, double clicks or re-run jobs. §19–20 require automations,
reminders, notifications, digests, imports/exports and scheduled work.

## Decision
* Every creating/stateful endpoint requires an `Idempotency-Key` (UUID). The key, request hash and
  stored response live in `idempotency_records`; a replay returns the stored response, a different
  body with the same key returns 422.
* Edits require `If-Match: <rowVersion>` (428 when missing, 412 when stale).
* Domain events are written to an outbox table in the same transaction as the change; the worker
  dispatches them to consumers with per-consumer idempotency.
* Jobs live in PostgreSQL (`jobs`), claimed with `FOR UPDATE SKIP LOCKED` leases per pool (light,
  data, media), retried with backoff [30 s, 2 m, 10 m, 30 m, 2 h] and dead-lettered afterwards.
  Each job has an idempotency key; handlers are written to be safe under at-least-once delivery.
* Schedules enqueue one job per time bucket (deterministic key), so multiple workers do not double
  fire.
* Business uniqueness (one publication per placement, one accrual per source, one measurement task
  per checkpoint…) is enforced by unique indexes as the last line of defence.

## Consequences
No external broker is required. Throughput is bounded by PostgreSQL, which is sufficient for a
single company team; the runner interface allows swapping in a broker later.
