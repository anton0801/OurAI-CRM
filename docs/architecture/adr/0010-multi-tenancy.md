# ADR 0010 — Workspace isolation

Status: accepted (2026-09-24)

## Context
The product serves one company, but the data model has workspaces (a user may belong to several),
and a leak between workspaces would be a critical defect.

## Decision
* Every tenant table has `workspace_id`; foreign keys between tenant tables are composite
  `(workspace_id, ref_id)` so a row can never reference another workspace's row, even through a bug.
* Application lookups always filter by workspace (`findById`/`lockById`); ids from clients are never
  trusted.
* Unique business keys are scoped by workspace (partial unique indexes, excluding archived/trashed
  rows where the spec allows reuse).

## Consequences
Slightly wider indexes and foreign keys; cross-workspace reporting is intentionally impossible.
