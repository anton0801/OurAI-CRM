# ADR 0009 — Deployment, backups and restore

Status: accepted (2026-09-24)

## Context
§27 requires reproducible deployment, backups with verified restore, observability and runbooks.

## Decision
* Artifacts: two container images (web — Next.js standalone output; worker — bundled Node script)
  built from the same commit, plus a one-shot `migrate` command run before rollout.
* Reference deployment: `infra/docker-compose.yml` (PostgreSQL 16, MinIO/S3, ClamAV, SMTP relay
  placeholder, web, worker) and container-platform manifests. Secrets come from the environment;
  `.env.example` documents every variable.
* Backups: PostgreSQL base backups + WAL archiving (point-in-time recovery, 35-day retention by
  default) and nightly logical dumps; object storage with versioning and a lifecycle policy.
  The restore runbook restores database and objects to the same point and verifies checksums.
* Observability: structured JSON logs with request ids and redaction, `/api/v1/health/live` and
  `/ready`, job queue metrics, outbox lag and error-rate alerts.
* Migrations are forward-only; rollback means redeploying the previous image when the migration is
  backward compatible, otherwise restoring from backup (documented in the runbook).

## Consequences
Production deployment, real invitations and data migration require the environment owner's approval
and credentials; the repository contains everything needed to perform them.
