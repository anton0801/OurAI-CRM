# Production: content pipeline, editor, versions & reviews (S22–S26, §10)

Code: `packages/application/src/production/` (pure rules in `rules.ts` + `rules.test.ts`), contracts
`packages/api-contracts/src/production.ts` (`contentEndpoints` `content.*`, `contentVersionEndpoints` `content.versions.*` /
`content.submit`, `reviewEndpoints` `reviews.*`), handlers `apps/web/src/server/handlers/production.ts`, UI
`apps/web/src/features/{content,reviews}/`. DB guards: `content_versions_draft_uq` (one draft per item) and
`packages/database/sql/post/003_immutable_versions.sql` (submitted versions and their files are frozen).

Helpers for other modules:
- `contentVersionPlacement(db, ws, versionId)` / `assertContentVersionPlaceable(ctx, versionId)` (reviews.ts) — the placement
  check: the version is approved and its approval is not revoked. Publishing's `ensurePlaceableVersion` and the package job call
  it. The check is per version, so an older approved, non-revoked version stays placeable after a newer one is approved.
- `createContent(ctx, input, { originReferenceId })` — new item in Idea; references' "Use as Idea" (`creative/reference-idea.ts`)
  and Duplicate as New Draft use it.
- `contentScope` / `canReadContent` / `canOnContent` / `contentVisibility` / `readableContentIds` (scope.ts) — authorise content
  and links to it. Account-scoped members (publishers) also reach content through placements on their accounts.
- `pendingReviewsOf(db, ws, membershipId)` — pending content reviews assigned to a member.
- `episodeContent` / `requestEpisodePackage` — the episode panel and the episode ZIP.
- `contentRules` (pure): `CONTENT_TRANSITIONS`, `MANUAL_TRANSITIONS`, `transitionRequirements`, `submitRequirements`,
  `reviewSteps`, `selfReviewOutcome`, `annotationErrors`, `isContentOverdue`.

Pipeline and editor:
- Manual moves are only Idea → Brief → Ready → Production, Changes Requested → Production and Approved → Production (New
  Revision, reason required; `approvedVersionId` stays set). Review, Approved and Changes Requested are reached only through
  submit and review decisions. Moves need `content.edit`; the owner may start Production with `content.upload`.
- Brief → Ready needs summary, objective, owner, reviewer and a due date or No Deadline. → Production needs an active project,
  an owner, no Blocked/Paused flag and no blocked open tasks. Custom fields required for the target stage are checked too.
  Once Ready, edits cannot break these conditions.
- The reviewer must hold `content.approve` in the project and cannot be the owner unless the project policy allows
  self-review. The format can change only in Idea/Brief/Ready and only while no version was submitted.
- Blocked and Paused are separate flags with reason and history (`content_flag_intervals`). They do not change the stage.
- WIP limits live in `workspaces.settings.contentWipLimits` (needs `workspace.update`); going over only returns a warning.
- `applyContentTemplate` creates the template's tasks once per content + template version (`contentApplicationKey`; the
  preview token must match). Started or done tasks are kept; only not-started tasks picked in the preview are cancelled.

Versions and submit:
- A version is created in Ready, Production, Review or Changes Requested. Numbers only go up, and there is at most one draft.
  Files of an earlier version can be reused. External links and rejected/failed files are refused. Files still uploading or
  being checked can be attached but block submit.
- Checklist before submit: the version gets the template's or the format's default checklist. Those items cannot be removed or
  made optional. Only `content.edit` holders may add new mandatory items.
- `submitContentVersion` (`content.submit`, stage Production or Changes Requested, active project) requires every required slot
  filled, every file Available, a non-empty version (a text post may use the caption draft) and every mandatory checklist item
  done. A stale `reviewPolicyVersion` (FNV hash of the project policy) is refused. Submit freezes the brief snapshot and the
  character versions, supersedes older pending reviews and opens round N+1 with a `policySnapshot`.

Reviews (queue S25, studio S26):
- Who can decide: any member with `content.approve` in the content scope, not only the assigned reviewer. With an
  eligible-reviewer list on the project, only listed members can approve (workspace Owner exempt); Request Changes does not check
  the list. The author (submitter) may approve only with an explicit `selfReviewException` reason, and only when the policy
  snapshot allows self-review or the author is the workspace Owner. The exception is audited with `sensitivity: 'security'`.
- Decisions apply only to the exact `versionId` of the review, while it is still the latest submitted version (review row
  locked, If-Match). Unresolved top-level `blocking` comments on the version block approval.
- Steps: optional Content Quality, then Release Approval. Approving the first step opens the second and assigns the content
  reviewer, unless that reviewer is the decider or the author. Only the final step sets `approvedAt`, stage Approved and
  `approvedVersionId`.
- Request Changes needs a summary and either an unresolved comment on the version or an explanation (saved as an `issue` comment).
- Revoke Approval (final-step review only, with a reason) sets `approvalRevokedAt`. If this was the approved version,
  `approvedVersionId` is cleared and Approved → Changes Requested. Published placements get `approvalRevokedAfterPublication` and
  a "check the external post" task; scheduled/draft placements get a "replace or cancel" task. The tasks are created as the actor,
  or as a narrow system actor when the actor lacks task rights. Nothing is unpublished or cancelled.
- Annotations: timecodes only on video/audio and within the known duration; points only on images, normalised to 0–1. A comment
  belongs to the version it was written on.

Content package (ZIP): `requestContentPackage` / `requestEpisodePackage` (`exports.create`) accept only placeable versions and
share the Export Center quotas (5 active per member, 20 per workspace). They write an `export_jobs` row with dataset
`content_package`. Job `content.package` (pool data, no retries) re-authorises every item as the requester (`assets.download`;
restricted media need `assets.restricted.read`). It streams the files into a temp ZIP (`manifest.json`, `metadata.json`,
`files/<slot>/…`) and completes with the 7-day export TTL; any refusal fails the whole package.
`defineExportProducer('content_package')` gives the Export Center its label, the `assets.download` download check and Retry
(requeue re-checks that each item is still readable).

Bulk (S22): `bulkContentPreview` / `bulkContentApply` assign owner/reviewer, add/remove a tag or move the stage. The 10-minute
preview token is bound to row versions and the access revision. Each item is applied in its own savepoint.

Registries: lookup `content_item`; link access `content_item`, `content_version`; comment parents `content_item`,
`content_version`, `review` (severity + annotations); responsibility `content.owner`, `content.reviewer`; export dataset
`content_items`; export producer `content_package`; job `content.package`; saved-view module `content`; archive handler
`content_item`:
- Archiving is blocked while placements are scheduled, and it cancels pending reviews.
- Restore returns to the stage before archiving; Review becomes Production.
- The trash takes only Idea/Brief drafts with no versions, tasks, placements or comments (`purgeAfter` 30 days).
  A draft created by "Use as Idea" is never purged.

Slots: contributes `ACCOUNT_TABS` Content, `CHARACTER_PANELS` "Content using this character", `EPISODE_PANELS` Content,
`MY_WORK_SECTIONS` Reviewing and project tab Content. The content detail renders `CONTENT_PANELS` (`{ contentId, projectId,
tab }`) in its Publications and Results tabs. Publishing registers `publications` and metrics registers `results`; with no visible
panel, the tab shows an empty state.

Known limits: WIP limits are counted across the whole workspace, whatever the board filter. Each step takes one approval
(`requiredApprovals: 1`), and the same member may approve both steps. Nothing is scheduled for content deadlines: overdue is
computed on read. The queue's `decide` flag and the studio's `approve` flag ignore the eligible-reviewer list; only the command
enforces it. `listContentPackages` shows only the member's own last 10 packages.
