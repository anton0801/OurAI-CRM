# Publications, calendar, campaigns, tracking links & experiments (S31–S35, §12)

Code: `packages/application/src/publishing/`, contracts `packages/api-contracts/src/publishing.ts`, handlers
`apps/web/src/server/handlers/publishing.ts`, UI `apps/web/src/features/{publications,calendar,campaigns,experiments}/`.

Helpers for other modules:
- `createCampaign(ctx, input, { source: { dealId }, partnerFromDeal })` — the deals module's `createCampaignForDeal` calls it.
- `writeCampaignCostAllocations` (campaign-costs.ts) — the single writer of campaign `financial_allocations` (exact split with
  `allocateLargestRemainder`; posted entries get adjustment rows). Finance can swap its body for its own allocation command.
- `publicationScope` / `publicationVisibility` / `canPublication` — authorise records that belong to a placement.
- `activePublicationPolicy` / `createPublicationCheckpoints` / `occurrenceKeyOf` — checkpoint rows (see below).
- Pure logic: `checkpointWindows`, `checkpointTiming` (early/on_time/late from the real observed_at), `classifyComparable`,
  `summarizeComparable`, `onTimeAgainstBaseline`, `planWeekOf`, `splitCostMinor`.

Checkpoints (for the insights module): Mark Published / historical entry creates one `metric_checkpoints` row per policy entry
(`occurrence_key = publication:{id}:{key}`, unique per workspace — never a second set). Filled: entity/publication ids, account,
project, `checkpoint_key`, `policy_version`, `expected_at = actual_published_at + offset`, `window_start/window_end` (elapsed UTC
hours), `state='pending'`, assignee = publication owner. Insights sets `completed_observation_id`, `timing`, `missing_reason`.
Measurement tasks ("Record 24h metrics: …", due at the window end, future windows only) are created by this module — do not
duplicate them. Correcting the published time moves only pending checkpoints. Publication pages link "Add Metrics" to
`/metrics/new?publicationId=`.

Rules worth knowing: nothing becomes Published by time (a reminder asks to confirm); Mark Published needs an https post URL or a
10–500 character reason; `(workspace, normalized_post_url)` is unique (partial index); restricted/paused/preparing accounts need a
lead override (`publications.correct`) with a reason, archived accounts never; a second placement on the account within 15 minutes
needs a reason; weekly plans freeze Monday 00:00 workspace time (job `publishing.freezePlans`), moving a placement out keeps its
original row; tracking links never carry clicks — clicks/conversions come only from campaign source reports; experiments compare
values only at the same post age (± tolerance) and never name a winner or significance.

Registries: lookups publication, campaign, experiment, tracking_link; link access publication, campaign, experiment; archive
handlers publication (archive + draft trash), campaign, experiment, tracking_link; responsibility `publications.owner`,
`campaigns.owner`, `experiments.owner`; exports `publications`, `campaigns`; jobs `publishing.reminders` (due soon / awaiting
confirmation), `publishing.freezePlans`. Slots: `ACCOUNT_TABS` Publications, project tabs Publications + Calendar,
`MY_WORK_SECTIONS` Publications Due, `CONTENT_PANELS`, `EPISODE_PANELS`, `DEAL_PANELS`; renders `CAMPAIGN_TABS` (finance adds its
budget tab there; the built-in "Costs" tab shows allocations).
