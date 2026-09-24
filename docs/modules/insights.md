# Insights: Metrics Inbox, metric entry, analytics & reports (S49–S52, §15–§17)

Code: `packages/application/src/insights/` (`observations.ts`, `checkpoints.ts`, `catalog.ts` + `catalog-view.ts`, `dashboards.ts`,
`reports/{engine,reports,schedules,pdf}.ts`, `semantic/*.ts`, `registries.ts`), pure maths `packages/analytics/src/`
(`value.ts`, `formulas.ts`, `periods.ts`, `observations.ts`, `grouping.ts`), core registry
`packages/application/src/core/metric-registry.ts`, contracts `packages/api-contracts/src/insights.ts` (`metricsEndpoints`
`metrics.*`, `analyticsEndpoints` `analytics.*`, `reportEndpoints` `reports.*`), handlers
`apps/web/src/server/handlers/insights.ts`, UI `apps/web/src/features/{metrics,analytics,reports}/`.

Helpers for other modules:
- `evaluateMetric(ctx, id, query)` (core/metric-registry.ts) — the only way other modules read M/X metrics (goals, overview).
  It checks the metric's `permission`, its dimensions and its grains, then runs the insights formula.
- `ensurePublicationMetricCheckpoints` / `cancelPublicationCheckpoints` — publications write checkpoint rows themselves on
  Mark Published; `ensure…` writes the same rows (`occurrence_key = publication:{id}:{key}`, idempotent) for backfills, and
  `cancel…` cancels only pending rows.
- `getContentMetricResults`, `getPublicationMetrics`, `getAccountMetrics` — content Results, publication and account Metrics tabs.
- `metricsInboxSummary`, `myMetricCheckpoints` (My Work); `completeCheckpoint`; `checkpointLabel` (also labels the
  `automation:` keys written by the automation action `create_checkpoint`).

Observations (entry and revision, S50):
- Four datasets: account snapshot, account period, publication cumulative, OFM period. Allowed fields come from the
  `metric_definitions` catalogue per definition set version.
- Each value is Known, Unknown, Not Provided or Not Applicable. Known needs a value; the others must be empty. At least one value
  must be Known (Mark Unavailable closes a request without data). Counters are integers 0…9×10^15; other numbers cannot be
  negative and take ≤ 6 decimals; money needs a currency.
- Observed At ≤ now + 5 min. A period must have ended, with Observed At ≥ its end. A cumulative value cannot be observed before
  the post went live, and only Published publications take metrics.
- Duplicate key = entity + definition set + kind + observed_at or period + segment + source namespace (DB partial unique index).
  An exact duplicate is refused (`DUPLICATE`). Another source for the same slot is saved non-canonical with an `ALTERNATE_SOURCE`
  warning. "Use in Reports" (`setObservationCanonical`, `metrics.revise` + reason) switches the canonical record of a slot, and
  the whole revision chain keeps the flag.
- These warnings need a `warningNote`: reach > impressions, completions > views, a cumulative drop, overlapping periods. A drop
  is kept as a "Source Correction", never as negative views. Overlapping canonical periods are never summed; they stay in Needs
  Review until one is excluded.
- Corrections: `submitCorrection` (`metrics.revise`) adds a `pending_correction` revision while the current values stay in use.
  Only one correction per chain can wait (DB partial unique index). `approveCorrection` (`metrics.approve`) supersedes the old
  revision and moves the checkpoint's `completedObservationId`. It and `markObservationReviewed` refuse the member who entered
  the values, unless they are the workspace Owner. Only `unverified` / `reviewed` rows count; `pending_correction`, `superseded`
  and `rejected` never do.
- Bulk grid (`bulkCreateObservations`): each row is saved or refused in its own savepoint; duplicates are reported, never replaced.

Checkpoints (Metrics Inbox, S49):
- Policy: the active versioned `checkpoint_policies` row; without one, `pub_24h` (±2 h) and `pub_7d` (±12 h), version 0.
- `insights.checkpoints` (every 15 min) creates account snapshot checkpoints from each account's cadence and sends "Metrics
  update needed" once per checkpoint.
- An entry completes the checkpoint it names, or else the pending checkpoint whose window contains `observed_at`. Timing
  (on_time/early/late) comes from the real `observed_at`, and early/late values are left out of standard checkpoint comparisons.
- Mark Unavailable sets `missing` with a reason and writes no zeros. Overdue is computed on read; nothing closes pending
  checkpoints automatically.

Semantic layer (`semantic/`, M01–M42 + X01–X10):
- `defineInsightMetric` stores the definition in `INSIGHT_METRICS` and also calls core `defineMetric`, so goals and overview use
  the same formula. A definition has unit, rate, `measuresChange`, family, permission, optional `requires`, dimensions, grains,
  `additive`, `zeroWhenEmpty`, `load` (scope applied in SQL before aggregation) and `reduce`. `requires` is copied into the core
  definition; core `canUseMetricDefinition` (permission + every `requires`) guards `availableMetrics`, `evaluateMetric`, goals and
  the overview.
- Families and permissions: production `analytics.production.read` (M01–M10, X10); accounts `analytics.accounts.read` (X01,
  M11–M13, M22, X05); content `analytics.content.read` (M14–M21, M23); OFM `analytics.ofm.read` (M24–M31, X06, X07; M27/M29
  also need `finance.read`); team `analytics.team.read` (X02–X04, X09, M32); finance `analytics.finance.read` + `finance.read`
  (M33–M39, M41, M42, X08; M38 also `budgets.read`, M39 `compensation.runs.read`); coverage `metrics.read` (M40).
- Publication metrics use one canonical checkpoint observation per post (default `pub_24h`): the on-time one closest to the
  expected time, totals only (`combined` preferred over `unknown`; organic/paid never mixed with totals).
- `measuresChange: true` marks M11 Followers Change, M15 Period Views Delta, M24 Paid Subscriber Net Change and M41 Cash
  Movement. Goals on them accept only Absolute targets (`CHANGE_METRIC`).

Availability (`packages/analytics`): every value is a `MetricValue` (decimal string + `status`: known, partial, no_data,
not_defined, not_enough_data, not_measured, not_attributable, pending, not_applicable, not_comparable). Missing data is never
zero. An empty sum is `no_data`, a zero denominator is `not_defined`, and a missing first/last snapshot is `not_enough_data`.
Empty series buckets are a known 0 only for `zeroWhenEmpty` record counts; otherwise they are gaps. Comparisons use the previous
period of equal length, or the same elapsed time while the period is running. Rates compare in percentage points, and partial or
unknown values give `no_comparison`.

Analytics (S51): six tabs gated by `TAB_PERMISSIONS` (finance also needs `finance.read`). Charts fold the tail into "Other" only
for additive metrics. Drill Down lists only the source records the member may open.

Reports (S52):
- Datasets are tasks, content, publications, account_metrics, ofm and finance, each with a fixed metric list. A report has
  ≤ 8 metrics and ≤ 3 dimensions supported by every metric, and returns ≤ 500 rows. Stacked charts need additive metrics.
  Shared ofm/finance reports need a project filter. Each config change adds a version.
- Sharing (`reports.share`) never widens access: runs, snapshots and the `report_result` export use the viewer's own scope.
  `createReportSnapshot` stores an immutable result, readable only by the member it was generated for.
- Schedules (`reports.schedule`, job `insights.reportSchedules` every 5 min) make one snapshot per recipient with that
  recipient's rights; a slot is never duplicated. Recipients need `reports.read` and must be able to read the report (its owner
  or on its share list, `isReportReader`) when scheduled and again at send time; at send time others are skipped and listed in
  `lastRunResult.skipped`. A schedule pauses when its owner leaves or loses access, or when the report is
  archived.
- `reportSnapshotPdf` (`exports.download`) renders with pdfkit: title, period, scope, as-of, formulas, coverage and page numbers.
  It draws no charts, and unknown values stay labelled, never zero.

Registries: lookups `metric_definition`, `saved_report`; link access `metric_observation` (evidence files); import
`metric_observations` (duplicate policy skip / revise_existing / error, per-row `conflict_action`; undo only while untouched, the
correction chain counted inside the workspace);
exports `metric_observations`, `report_result` (private); archive handler `saved_report`; responsibility
`reports.schedule_owner`; jobs/schedules `insights.checkpoints` (900 s), `insights.reportSchedules` (300 s); metric definitions
M01–M42, X01–X10. Slots: `ACCOUNT_TABS` Metrics, `MY_WORK_SECTIONS` Metric Checkpoints, `CONTENT_PANELS` Results.

Known limits:
- `report_snapshots.source_revised` is never written (snapshots stay immutable; flagging them would need every source-changing
  command to find affected snapshots). "Stale" comes only from `reportSourceChangedSince` (a source row's `updated_at` is later
  than the as-of time), computed on the snapshot detail; the snapshot list's `sourceRevised` is therefore always false.
