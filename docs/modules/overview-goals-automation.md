# Overview, goals & automations (S08, S53, S64–S65, §17, §19)

Code: `packages/application/src/{overview,goals,automation}/`, contracts `packages/api-contracts/src/{overview,goals,automation}.ts`
(`overview.get`, `goals.*`, `automations.*`), handlers `apps/web/src/server/handlers/{overview,goals,automation}.ts`, UI
`apps/web/src/features/{overview,goals,automations}/`. Pure rules: `goals/progress.ts` (+ test), `packages/analytics`
`goalProgress`, `packages/domain/src/automation.ts` (limits, chain verdict, throttle, conditions, placeholders).

## Overview (S08)

`getOverview` needs `projects.read` or `analytics.production.read`. The period is resolved in the member's time zone and uses the
workspace week start.
- Empty state: when the member can see no projects, the response is a setup checklist (Start a Project, Add an Account, Create
  a Task) with no KPIs.
- KPIs: M01 Published, M07 On-Time Rate and M08 Overdue Tasks come from `evaluateMetric`. A KPI is hidden without permission and
  becomes Not Measured on error. Each is compared with the previous period, or the same elapsed time for a running period.
  Pending Reviews counts pending reviews now as the Review Queue shows them (`visibleReviewPredicate`: content reviews in the
  content's read scope, profile reviews through `characters.read`); the same rule feeds "reviews waiting".
- Trend: M01 and M02 by day (≤ 31 days), week (≤ 190) or month.
- Needs Attention (5 items per kind, 25 in total, danger first): overdue and blocked tasks; reviews waiting > 48 h or past due;
  scheduled placements whose version is missing, unapproved or revoked; pending checkpoints past their window; shifts still
  running after the scheduled end + grace; budgets with remaining < 0.
- Projects table: ≤ 50 non-archived projects. Open/overdue task counts (not archived) are narrowed by `tasks.read`, the last
  publication by `publications.read`. Freshness (`metrics.read` + `accounts.read`): an account is stale after 7 days
  without an observation; coverage comes from M40 or a checkpoint count.
- The finance row appears only with `finance.read` and not under a direction-only filter. Finance errors are swallowed.
- Export: dataset `overview_projects` (`projects.read`): the same per-project counts as the screen, plus pending reviews per
  project, all in the requester's scope.

## Goals (S53)

- Metric options, create and edit accept only metrics the member can use (`canUseMetricDefinition`: permission plus `requires`, e.g.
  `finance.read` for revenue metrics); for a viewer lacking them an existing goal shows `metric.available: false`, Not Measured.
- A goal targets one canonical metric (`metricKey` = M/X id, unit copied from the definition) for a scope: workspace, direction,
  project, account or campaign. A campaign goal is authorised through any of the campaign's projects. Visibility is applied in SQL
  (`goalVisibilitySql`). A goal's owner sees it whenever they hold `goals.read` anywhere.
- Target types (`progress.ts` → `goalProgress`): `absolute` = current / target; `increase_by` = (current − baseline) / target;
  `decrease_to` = (baseline − current) / (baseline − target). The relative types need a baseline. A zero denominator gives
  Not Defined. Progress is never clamped: above 100 % it is labelled Over Target.
- Current value: the metric wins when it is known or partial. Otherwise the latest manual check-in is used, labelled Manual (its
  source is required). Otherwise the goal is Not Measured. The metric is evaluated in the viewer's scope, so different viewers can
  see different values.
- `CHANGE_METRIC`: metrics with `measuresChange` (M11, M15, M24, M41) accept only Absolute targets.
- Revisions (`updateGoal`): each change of type, target, baseline or period bumps `revisionNo` and appends a `goal_revisions`
  snapshot. After the period started (workspace-local date), such a change needs a reason (≥ 3 chars) and takes effect from today.
  The metric is locked after the start.
- Check-ins are append-only and store the measured value alongside. Close stores the achieved value, completeness (the metric's
  coverage) and an assessment; the effective time cannot be in the future or before the period start. Archive/restore keeps the
  history.
- Exported helpers: `measureGoal`, `goalScopes`, `canGoal`, `goalVisibilitySql`, `goalMetricOptions`, and pure `goalCurrentValue`,
  `goalProgressOf`, `goalCompleteness`.
- Registries: lookup `goal`; archive handler `goal`; responsibility `goals.owner` (a successor is required and must be able to
  read the goal scope); export `goals` (evaluated in the requester's scope). Slot: project tab Goals.

## Automations (S64–S65)

- Rules: states `draft | enabled | disabled | paused_needs_owner | paused_requires_attention` (`AUTOMATION_RULE_TRANSITIONS`);
  scope workspace, direction, project or account. Every config change adds a version; Enable takes an explicit `versionId`
  (`enabledVersionId`), so edits change nothing that runs until that version is enabled.
- Catalogue (`catalog.ts`), 17 triggers with typed condition fields and their own allowed actions. Events: content
  submitted/approved/changes requested, publication published, shift ended, handover unacknowledged, budget threshold crossed,
  deal stage changed. Deadlines: task due soon/overdue, checkpoint due/overdue, shift report overdue, account metrics stale.
  Schedules: `schedule.daily|weekly|monthly` (no conditions; created tasks need a fixed project).
- Actions: create task, create tasks from a template, assign member, add checklist item, add tag, set field (priority only),
  create checkpoint (never records values), notify, request internal approval (a task; nothing is approved automatically),
  create incident. `templates.ts` holds seven starter rules.
- Principal (`principal.ts`): a run acts as `rulePrincipal`, an `automation` actor with the owner's identity and the owner's
  current rights narrowed to the rule scope (`narrowAccess` drops assigned-object and own-record grants and always clears
  `isOwner`: a workspace rule keeps the owner's grants but never Owner-only exceptions). Enabling needs an active owner holding every required permission over the whole scope and on fixed
  projects (`authorityGaps`: the trigger's read permission plus each action's permissions); the enabling member must hold them too.
- Runtime (`runtime.ts`): event triggers go through the outbox consumer `automation.dispatch`, which creates one run per
  `event:{eventId}:{versionId}` (unique `automation_runs_operation_uq`) and queues job `automation.run`. Deadline and schedule
  triggers come from `automation.tick` (every 60 s): deadline keys include the deadline revision, a scan creates ≤ 200 runs per
  rule, and only the latest missed schedule slot runs. A run executes the version stored on it (`run.ruleVersionId`), and only
  while that version is still the enabled one: after another version is enabled, a queued run is skipped as `VERSION_CHANGED`
  (never replayed with the old or a different config) and cannot be retried.
- Before actions: the rule must still be enabled. A missing owner means skipped + `paused_needs_owner`; permission gaps or an
  unreadable record mean failed + `paused_requires_attention`. Loop protection (`automationChainVerdict`): depth > 5 is
  `DEPTH_LIMIT`, the same rule already in the chain is `RECURSION`, and > 50 tasks/notifications per root event is
  `BUDGET_EXCEEDED`. Each raises a deduplicated system incident and an owner Inbox item. Above 100 runs per rule per hour, runs
  are `throttled` (delayed, never dropped). Unmet conditions mean skipped.
- Actions run through the owning modules' use cases, each in a savepoint, and claim effect key
  `{eventId}:{versionId}:{index}` in `automation_action_effects`, so a retry never repeats an effect. A FORBIDDEN/NOT_FOUND
  action pauses the rule. Notify reaches only members who can open the record; `quietHoursPolicy: 'ignore_for_inbox'` means Inbox
  only (no email).
- Transient errors retry after 30 s, 2 min, 10 min, 30 min and 2 h, then the run is `dead`. Retry Failed Run (`automations.edit`,
  reason, rule enabled) reuses the operation and effect keys. Access and deactivation events queue `automation.revalidate`, which
  pauses rules whose owner no longer covers the scope.
- Dry run (`dryRunAutomationRule`) evaluates the conditions, then runs the real action use cases as the principal in a
  transaction that is always rolled back. It writes no run or effect rows and sends no mail. Readers (`automations.read`) dry-run
  the saved version; an unsaved config needs `automations.edit`, passes `validateRuleDraft`, and the requester must hold every
  permission it uses in the rule scope.
- Run records (`automation_runs`) have states pending, throttled, running, succeeded, failed, skipped and dead, plus per-action
  results and an error code/message.
- Used elsewhere: `accountLabelOf` (overview, goals). Insights labels `automation:` checkpoint keys.
- Registries: lookup `automation`; archive handler `automation_rule` (archiving cancels pending runs; restore sets Disabled);
  responsibility `automations.owner` (a successor must cover the scope; with none, an enabled rule pauses as Needs Owner); jobs
  `automation.run`, `automation.tick` (schedule 60 s), `automation.revalidate`; consumer `automation.dispatch`.

Known limits:
- Automations cannot approve, post finance, change roles, delete or send external messages. There are no user-defined triggers or
  fields.
