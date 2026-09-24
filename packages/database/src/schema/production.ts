import { index, pgTable, uniqueIndex } from 'drizzle-orm/pg-core';
import {
  COMMENT_SEVERITIES,
  COMMENT_STATES,
  CONTENT_FORMATS,
  CONTENT_SLOTS,
  CONTENT_STAGES,
  REVIEW_STATUSES,
  REVIEW_STEP_KINDS,
  REVIEW_TARGET_TYPES,
} from '@castlane/domain';
import {
  archivable,
  boolean,
  dec,
  enumCheck,
  enumText,
  integer,
  json,
  rawCheck,
  sql,
  tenantBase,
  text,
  tfk,
  trashable,
  ts,
  uuid,
} from '../columns';
import { memberships, tenantUnique } from './identity';
import { assetVersions } from './media';
import { characterVersions, projects, socialAccounts } from './organization';

export interface ContentBrief {
  /** Short brief summary (required before Ready, section 10.1). */
  summary?: string;
  objective?: string;
  audience?: string;
  hook?: string;
  script?: string;
  captionDraft?: string;
  cta?: string;
  notes?: string;
}

export const contentItems = pgTable(
  'content_items',
  {
    ...tenantBase(),
    ...archivable(),
    ...trashable(),
    projectId: uuid('project_id').notNull(),
    title: text('title').notNull(),
    format: enumText('format', CONTENT_FORMATS).notNull(),
    stage: enumText('stage', CONTENT_STAGES).notNull().default('idea'),
    ownerMembershipId: uuid('owner_membership_id'),
    reviewerMembershipId: uuid('reviewer_membership_id'),
    brief: json<ContentBrief>('brief').notNull().default({}),
    language: text('language'),
    dueAt: ts('due_at'),
    noDeadline: boolean('no_deadline').notNull().default(false),
    tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
    currentVersionId: uuid('current_version_id'),
    approvedVersionId: uuid('approved_version_id'),
    firstApprovedAt: ts('first_approved_at'),
    enteredReadyAt: ts('entered_ready_at'),
    /** Independent flags (section 10.1): never replace the canonical stage. */
    pausedAt: ts('paused_at'),
    pausedReason: text('paused_reason'),
    blockedAt: ts('blocked_at'),
    blockedReason: text('blocked_reason'),
    needsConsistencyReview: boolean('needs_consistency_review').notNull().default(false),
    duplicatedFromId: uuid('duplicated_from_id'),
    templateVersionId: uuid('template_version_id'),
    episodeId: uuid('episode_id'),
    campaignId: uuid('campaign_id'),
    /** Planned target account (optional); placements are separate publication records. */
    accountId: uuid('account_id'),
  },
  (t) => [
    tenantUnique('content_items', t),
    tfk('content_items_project_fk', t.workspaceId, t.projectId, projects),
    tfk('content_items_account_fk', t.workspaceId, t.accountId, socialAccounts),
    index('content_items_account_idx').on(t.workspaceId, t.accountId),
    index('content_items_owner_idx').on(t.workspaceId, t.ownerMembershipId, t.stage),
    tfk('content_items_owner_fk', t.workspaceId, t.ownerMembershipId, memberships),
    tfk('content_items_reviewer_fk', t.workspaceId, t.reviewerMembershipId, memberships),
    index('content_items_list_idx').on(t.workspaceId, t.stage, t.updatedAt, t.id),
    index('content_items_project_idx').on(t.workspaceId, t.projectId, t.stage),
    enumCheck('content_items_format_ck', 'format', CONTENT_FORMATS),
    enumCheck('content_items_stage_ck', 'stage', CONTENT_STAGES),
  ],
);

export const contentStageEvents = pgTable(
  'content_stage_events',
  {
    ...tenantBase(),
    contentItemId: uuid('content_item_id').notNull(),
    fromStage: enumText('from_stage', CONTENT_STAGES),
    toStage: enumText('to_stage', CONTENT_STAGES).notNull(),
    occurredAt: ts('occurred_at').notNull(),
    reason: text('reason'),
    actorMembershipId: uuid('actor_membership_id'),
  },
  (t) => [
    tenantUnique('content_stage_events', t),
    tfk('cse_content_fk', t.workspaceId, t.contentItemId, contentItems),
    index('cse_content_idx').on(t.workspaceId, t.contentItemId, t.occurredAt),
  ],
);

/** Pause/block intervals with actor, reason, start and end (independent of stage). */
export const contentFlagIntervals = pgTable(
  'content_flag_intervals',
  {
    ...tenantBase(),
    contentItemId: uuid('content_item_id').notNull(),
    flag: text('flag', { enum: ['paused', 'blocked'] }).notNull(),
    reason: text('reason').notNull(),
    startedAt: ts('started_at').notNull(),
    endedAt: ts('ended_at'),
    resolution: text('resolution'),
  },
  (t) => [tenantUnique('content_flag_intervals', t), tfk('cfi_content_fk', t.workspaceId, t.contentItemId, contentItems)],
);

export const contentCharacters = pgTable(
  'content_characters',
  {
    ...tenantBase(),
    contentItemId: uuid('content_item_id').notNull(),
    characterVersionId: uuid('character_version_id').notNull(),
  },
  (t) => [
    tenantUnique('content_characters', t),
    tfk('content_characters_content_fk', t.workspaceId, t.contentItemId, contentItems),
    tfk('content_characters_cv_fk', t.workspaceId, t.characterVersionId, characterVersions),
    uniqueIndex('content_characters_uq').on(t.contentItemId, t.characterVersionId),
  ],
);

/** A logical version: a set of asset versions + frozen brief snapshot. Immutable after submission. */
export const contentVersions = pgTable(
  'content_versions',
  {
    ...tenantBase(),
    contentItemId: uuid('content_item_id').notNull(),
    versionNo: integer('version_no').notNull(),
    note: text('note'),
    briefSnapshot: json<ContentBrief>('brief_snapshot').notNull().default({}),
    characterVersionIds: uuid('character_version_ids').array().notNull().default(sql`'{}'::uuid[]`),
    checklist: json<{ label: string; done: boolean; mandatory: boolean }[]>('checklist').notNull().default([]),
    submittedAt: ts('submitted_at'),
    submittedBy: uuid('submitted_by'),
    approvedAt: ts('approved_at'),
    approvalRevokedAt: ts('approval_revoked_at'),
    approvalRevokedReason: text('approval_revoked_reason'),
    fixesClaimed: text('fixes_claimed'),
  },
  (t) => [
    tenantUnique('content_versions', t),
    tfk('content_versions_content_fk', t.workspaceId, t.contentItemId, contentItems),
    uniqueIndex('content_versions_no_uq').on(t.contentItemId, t.versionNo),
    /** At most one open (not yet submitted) version per content item. */
    uniqueIndex('content_versions_draft_uq').on(t.contentItemId).where(sql`submitted_at IS NULL`),
  ],
);

export const contentVersionAssets = pgTable(
  'content_version_assets',
  {
    ...tenantBase(),
    contentVersionId: uuid('content_version_id').notNull(),
    slot: enumText('slot', CONTENT_SLOTS).notNull(),
    assetVersionId: uuid('asset_version_id').notNull(),
    position: integer('position').notNull().default(0),
  },
  (t) => [
    tenantUnique('content_version_assets', t),
    tfk('cva_version_fk', t.workspaceId, t.contentVersionId, contentVersions),
    tfk('cva_asset_version_fk', t.workspaceId, t.assetVersionId, assetVersions),
    uniqueIndex('cva_slot_uq').on(t.contentVersionId, t.slot, t.position),
    enumCheck('cva_slot_ck', 'slot', CONTENT_SLOTS),
  ],
);

export interface ReviewPolicySnapshot {
  steps: (typeof REVIEW_STEP_KINDS)[number][];
  allowSelfReview: boolean;
  requiredApprovals: number;
}

/**
 * One review round for one frozen target version. Steps are ordered; each step is its own row
 * sharing `round_key`. A review decision is only valid for the exact submitted target.
 */
export const reviews = pgTable(
  'reviews',
  {
    ...tenantBase(),
    targetType: enumText('target_type', REVIEW_TARGET_TYPES).notNull(),
    targetId: uuid('target_id').notNull(),
    /** Parent object (content item or character) for listing and scope checks. */
    subjectId: uuid('subject_id').notNull(),
    projectId: uuid('project_id').notNull(),
    roundNo: integer('round_no').notNull(),
    stepKind: enumText('step_kind', REVIEW_STEP_KINDS).notNull().default('release_approval'),
    stepOrder: integer('step_order').notNull().default(1),
    status: enumText('status', REVIEW_STATUSES).notNull().default('pending'),
    reviewerMembershipId: uuid('reviewer_membership_id'),
    authorMembershipId: uuid('author_membership_id'),
    submittedAt: ts('submitted_at').notNull(),
    dueAt: ts('due_at'),
    decidedAt: ts('decided_at'),
    policySnapshot: json<ReviewPolicySnapshot>('policy_snapshot').notNull(),
    selfReviewException: boolean('self_review_exception').notNull().default(false),
  },
  (t) => [
    tenantUnique('reviews', t),
    tfk('reviews_project_fk', t.workspaceId, t.projectId, projects),
    tfk('reviews_reviewer_fk', t.workspaceId, t.reviewerMembershipId, memberships),
    index('reviews_queue_idx').on(t.workspaceId, t.status, t.submittedAt),
    index('reviews_subject_idx').on(t.workspaceId, t.subjectId),
    index('reviews_reviewer_idx').on(t.workspaceId, t.reviewerMembershipId, t.status),
    uniqueIndex('reviews_target_step_uq').on(t.targetId, t.stepKind, t.roundNo),
    enumCheck('reviews_status_ck', 'status', REVIEW_STATUSES),
  ],
);

/** Exactly one effective final decision per review step (enforced by partial unique index). */
export const reviewDecisions = pgTable(
  'review_decisions',
  {
    ...tenantBase(),
    reviewId: uuid('review_id').notNull(),
    decision: text('decision', { enum: ['approved', 'changes_requested', 'revoked'] }).notNull(),
    summary: text('summary'),
    decidedByMembershipId: uuid('decided_by_membership_id').notNull(),
    decidedAt: ts('decided_at').notNull(),
    targetVersionId: uuid('target_version_id').notNull(),
  },
  (t) => [
    tenantUnique('review_decisions', t),
    tfk('review_decisions_review_fk', t.workspaceId, t.reviewId, reviews),
    uniqueIndex('review_decisions_final_uq').on(t.reviewId).where(sql`decision <> 'revoked'`),
  ],
);

/** Comment on a specific target version; optional video timecode or normalised image point. */
export const comments = pgTable(
  'comments',
  {
    ...tenantBase(),
    parentType: text('parent_type').notNull(),
    parentId: uuid('parent_id').notNull(),
    projectId: uuid('project_id'),
    threadRootId: uuid('thread_root_id'),
    replyToId: uuid('reply_to_id'),
    depth: integer('depth').notNull().default(0),
    authorMembershipId: uuid('author_membership_id').notNull(),
    body: text('body').notNull(),
    severity: enumText('severity', COMMENT_SEVERITIES).notNull().default('note'),
    state: enumText('state', COMMENT_STATES).notNull().default('open'),
    /** For review comments: the content/character version this comment is about. */
    targetVersionId: uuid('target_version_id'),
    assetVersionId: uuid('asset_version_id'),
    timecodeMs: integer('timecode_ms'),
    pointX: dec('point_x', 6, 5),
    pointY: dec('point_y', 6, 5),
    resolvedAt: ts('resolved_at'),
    resolvedBy: uuid('resolved_by'),
    resolutionNote: text('resolution_note'),
    editedAt: ts('edited_at'),
    mentions: uuid('mentions').array().notNull().default(sql`'{}'::uuid[]`),
    deletedAt: ts('deleted_at'),
  },
  (t) => [
    tenantUnique('comments', t),
    tfk('comments_author_fk', t.workspaceId, t.authorMembershipId, memberships),
    index('comments_parent_idx').on(t.workspaceId, t.parentType, t.parentId, t.createdAt),
    rawCheck('comments_depth_ck', '"depth" BETWEEN 0 AND 2'),
    rawCheck('comments_point_ck', '("point_x" IS NULL OR ("point_x" >= 0 AND "point_x" <= 1)) AND ("point_y" IS NULL OR ("point_y" >= 0 AND "point_y" <= 1))'),
    enumCheck('comments_severity_ck', 'severity', COMMENT_SEVERITIES),
  ],
);

/** Append-only text revisions of edited comments (the original stays auditable). */
export const commentRevisions = pgTable(
  'comment_revisions',
  {
    ...tenantBase(),
    commentId: uuid('comment_id').notNull(),
    previousBody: text('previous_body').notNull(),
  },
  (t) => [tenantUnique('comment_revisions', t), tfk('comment_revisions_comment_fk', t.workspaceId, t.commentId, comments)],
);
