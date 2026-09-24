# Finance (S55–S60)

Code: `packages/application/src/finance/`, contracts `finance.ts`, pure calculations `packages/domain/src/finance/`, UI `features/finance/`.
Semantics: ADR 0004.

* Entries: draft → submitted → posted → reversed; posted rows immutable (`sql/post/004_finance_guards.sql`), corrections by reversal
  or replacement; allocations conserve minor units exactly; FX base equivalents frozen at posting; period locks with audited reopen;
  one posting per source (unique guard).
* Settlements record money actually received/paid (never transfers); platform payouts reconcile income without new revenue;
  overpayments become explicit advances.
* Sale candidates from OFM are confirmed into draft income entries or rejected; nothing is posted automatically.
* Budgets with versions and alerts, commitments consumed on conversion to actuals.
* Compensation: rules with versions (fixed, hourly, per unit, revenue share…), proration policies, overlap protection between time
  entries and shifts, runs (calculate → submit → approve → record payments), adjustments in the next open run, carry-forward.
* The §18.7 worked example is `tests/integration/finance/worked-example.test.ts`.

Slots: project tab "Finance", member tab "Compensation", deal panel "Finance", campaign tab "Budget".
Registries: lookups finance_category, budget, compensation_rule; link access financial_entry, settlement; import `financial_drafts`
(drafts only), `fx_rates`; export ledger and compensation lines (classification finance); responsibility `finance.budget_owner`.
Amount fields are omitted (not null) without finance permissions; finance records are not in global search.
