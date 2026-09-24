# Architecture Decision Records

| ADR | Decision |
|---|---|
| [0001](0001-stack-and-modular-monolith.md) | TypeScript modular monolith: Next.js web + separate worker, PostgreSQL, pnpm workspaces |
| [0002](0002-identity-and-sessions.md) | Own identity: Argon2id, TOTP MFA, opaque server sessions, CSRF, bootstrap once |
| [0003](0003-access-control-model.md) | Permission catalog + role presets + scoped grants, evaluated server-side, scope in SQL |
| [0004](0004-money-and-finance-semantics.md) | Integer minor units, draft→submitted→posted, reversal instead of edit, recorded payments only |
| [0005](0005-metric-semantics.md) | Observations with provenance and revisions; missing ≠ 0; semantic metric layer |
| [0006](0006-navigation-additions.md) | Tasks, Partners, Metrics and Goals are visible sidebar entries |
| [0007](0007-files-and-media-pipeline.md) | Private object storage, quarantine → scan → final key, authorised proxy |
| [0008](0008-jobs-outbox-and-idempotency.md) | PostgreSQL job queue, transactional outbox, idempotency records |
| [0009](0009-deployment-and-backups.md) | Container deployment, PostgreSQL PITR + object storage versioning, restore drills |
| [0010](0010-multi-tenancy.md) | Workspace-scoped rows with composite tenant foreign keys |

The engineering conventions that follow from these decisions are in `../conventions.md`.
