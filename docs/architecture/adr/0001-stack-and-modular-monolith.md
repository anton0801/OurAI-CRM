# ADR 0001 — TypeScript modular monolith

Status: accepted (2026-09-24)

## Context
The specification (R03, §26) asks for a standalone system with its own database, authentication,
application and deployment, built as a CLEAN / modular monolith for a single company team. There is
no requirement for independent scaling of modules, and the domain is highly relational (projects ↔
accounts ↔ content ↔ publications ↔ metrics ↔ finance). Correctness invariants (idempotency,
permission scope, immutable finance) are easiest to guarantee inside one ACID database.

## Decision
* One repository, pnpm workspaces, TypeScript (strict) everywhere.
* `apps/web` — Next.js App Router: server-rendered shell + React client screens and the REST API
  (`/api/v1`) served by a single catch-all route that dispatches to a contract-driven router.
* `apps/worker` — separate Node process for jobs, outbox dispatch and schedules. The web process
  never runs long work.
* `packages/domain` (pure rules) → `packages/application` (use cases, the only writer) →
  `packages/database` (Drizzle schema, SQL migrations). HTTP handlers and worker jobs are thin
  adapters over application use cases.
* API contracts are zod schemas in `packages/api-contracts`; OpenAPI and the typed client are
  generated from them, so client and server cannot drift.
* PostgreSQL 16 is the single system of record (data, queue, outbox, search index, rate buckets).
  No Redis/Kafka dependency is required; the abstractions (job runner, rate limiter) allow adding one.

## Consequences
* Module boundaries are enforced by folder/package structure and review, not by the network.
* One migration history and one backup cover everything that must be restored consistently.
* The worker and web scale horizontally; jobs use `FOR UPDATE SKIP LOCKED` leases.
