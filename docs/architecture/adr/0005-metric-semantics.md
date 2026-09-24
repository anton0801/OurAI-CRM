# ADR 0005 — Metric semantics

Status: accepted (2026-09-24)

## Context
R10/R17 and §15–16 require manual/bulk/CSV metrics with provenance, conflict handling by revision,
and formulas M01–M42 where missing data is never zero.

## Decision
* Raw observations (account snapshots, publication measurements, OFM results) are stored with
  observed-at, period, source, evidence and entering member. A correction creates a new revision
  and supersedes the old one; history remains queryable.
* A metric catalog (`packages/database/src/metric-catalog.ts`, seeded at migration) defines keys,
  units and aggregation. Custom metrics are workspace rows.
* The semantic layer (`packages/analytics`) evaluates formulas with explicit availability:
  a value is `{ value, status: 'ok' | 'partial' | 'missing' | 'not_applicable', coverage }`.
  Division by zero or missing inputs produce `missing`, not 0.
* Dashboards and reports read through the same layer and the same permission scope, so a number on a
  dashboard can always be opened as its source records.

## Consequences
Charts show gaps for missing periods; totals show coverage (e.g. "8 of 10 accounts reported").
