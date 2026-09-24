# ADR 0004 — Money and finance semantics

Status: accepted (2026-09-24)

## Context
§18 describes management accounting (not statutory bookkeeping): transactions, budgets, accruals,
compensation runs and recorded payments. R12/R18/R19 require exact amounts, no duplicates and
preserved history. No bank transfers are made.

## Decision
* Amounts are `bigint` minor units with an ISO currency code; on the wire they are decimal strings.
  No floating point anywhere. Rounding is banker's (half-even) only where the spec calls for it;
  allocations use largest remainder so parts always sum to the whole.
* Exchange rates are stored as decimal strings with an effective date and source; conversions keep
  the original amount and the rate used.
* Lifecycle: Draft → Submitted → Posted (→ Reversed via a reversal document). Posted documents and
  their lines are immutable (database trigger); corrections are reversal + new document.
* Settlements (money actually received/paid) are separate from recognised income/expense; a
  platform payout reconciles earlier income without creating a second income.
* Compensation runs snapshot inputs, calculate, are approved, and then payments are recorded
  (partial or full). "Record Payment" never moves money.
* Every financial command is idempotent and protected by unique constraints (e.g. one accrual per
  source per period).

## Consequences
Reports compute from posted records; drafts are visible but excluded from totals unless a filter
includes them explicitly. Deleting finance history is impossible through the API.
