import { index, pgTable, uniqueIndex } from 'drizzle-orm/pg-core';
import {
  ACCOUNT_STATUSES,
  CHARACTER_VERSION_STATES,
  DIRECTION_STATUSES,
  PLATFORMS,
  PROJECT_STATUSES,
  PROJECT_TYPES,
  RESPONSIBILITIES,
} from '@castlane/domain';
import {
  archivable,
  boolean,
  day,
  enumCheck,
  enumText,
  integer,
  json,
  sql,
  tenantBase,
  text,
  tfk,
  trashable,
  ts,
  uuid,
} from '../columns';
import { memberships, tenantUnique } from './identity';

export const directions = pgTable(
  'directions',
  {
    ...tenantBase(),
    ...archivable(),
    name: text('name').notNull(),
    nameKey: text('name_key').notNull(),
    description: text('description'),
    leadMembershipId: uuid('lead_membership_id'),
    status: enumText('status', DIRECTION_STATUSES).notNull().default('active'),
    sortOrder: integer('sort_order').notNull().default(0),
    /** Preset kind this direction was created from (series/model/influencer) — informational only. */
    presetKind: text('preset_kind'),
  },
  (t) => [
    tenantUnique('directions', t),
    tfk('directions_lead_fk', t.workspaceId, t.leadMembershipId, memberships),
    uniqueIndex('directions_active_name_uq').on(t.workspaceId, t.nameKey).where(sql`status = 'active'`),
    enumCheck('directions_status_ck', 'status', DIRECTION_STATUSES),
  ],
);

export interface ReviewPolicy {
  contentQualityStep: boolean;
  releaseApprovalStep: boolean;
  /** Exceptional self-review, audited. Default false (separation of duties). */
  allowSelfReview: boolean;
  eligibleReviewerMembershipIds?: string[];
}
export interface CaptionPolicy {
  maxLength?: number;
  requireCaptionForFormats?: string[];
}

export const projects = pgTable(
  'projects',
  {
    ...tenantBase(),
    ...archivable(),
    ...trashable(),
    type: enumText('type', PROJECT_TYPES).notNull(),
    directionId: uuid('direction_id').notNull(),
    name: text('name').notNull(),
    ownerMembershipId: uuid('owner_membership_id').notNull(),
    status: enumText('status', PROJECT_STATUSES).notNull().default('draft'),
    briefSummary: text('brief_summary'),
    description: text('description'),
    language: text('language'),
    targetMarkets: text('target_markets').array().notNull().default(sql`'{}'::text[]`),
    audience: text('audience'),
    tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
    startDate: day('start_date'),
    coverAssetId: uuid('cover_asset_id'),
    ofmEnabled: boolean('ofm_enabled').notNull().default(false),
    reviewPolicy: json<ReviewPolicy>('review_policy')
      .notNull()
      .default({ contentQualityStep: false, releaseApprovalStep: true, allowSelfReview: false }),
    captionPolicy: json<CaptionPolicy>('caption_policy').notNull().default({}),
    completedAt: ts('completed_at'),
    statusReason: text('status_reason'),
  },
  (t) => [
    tenantUnique('projects', t),
    tfk('projects_direction_fk', t.workspaceId, t.directionId, directions),
    tfk('projects_owner_fk', t.workspaceId, t.ownerMembershipId, memberships),
    index('projects_list_idx').on(t.workspaceId, t.status, t.updatedAt, t.id),
    index('projects_direction_idx').on(t.workspaceId, t.directionId),
    enumCheck('projects_type_ck', 'type', PROJECT_TYPES),
    enumCheck('projects_status_ck', 'status', PROJECT_STATUSES),
  ],
);

/** Direction attribution history so production reports can use direction_at_event. */
export const projectDirectionHistory = pgTable(
  'project_direction_history',
  {
    ...tenantBase(),
    projectId: uuid('project_id').notNull(),
    fromDirectionId: uuid('from_direction_id'),
    toDirectionId: uuid('to_direction_id').notNull(),
    effectiveAt: ts('effective_at').notNull(),
    reason: text('reason'),
  },
  (t) => [tenantUnique('project_direction_history', t), tfk('pdh_project_fk', t.workspaceId, t.projectId, projects)],
);

export const projectMemberships = pgTable(
  'project_memberships',
  {
    ...tenantBase(),
    projectId: uuid('project_id').notNull(),
    membershipId: uuid('membership_id').notNull(),
    responsibility: enumText('responsibility', RESPONSIBILITIES),
    note: text('note'),
    validFrom: ts('valid_from').notNull().defaultNow(),
    validTo: ts('valid_to'),
    endedReason: text('ended_reason'),
  },
  (t) => [
    tenantUnique('project_memberships', t),
    tfk('project_memberships_project_fk', t.workspaceId, t.projectId, projects),
    tfk('project_memberships_member_fk', t.workspaceId, t.membershipId, memberships),
    index('project_memberships_member_idx').on(t.workspaceId, t.membershipId, t.validTo),
    index('project_memberships_project_idx').on(t.workspaceId, t.projectId, t.validTo),
  ],
);

/** Pinned project decisions (S15 "Pin Decision" freezes the decision text version). */
export const projectDecisions = pgTable(
  'project_decisions',
  {
    ...tenantBase(),
    ...archivable(),
    projectId: uuid('project_id').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    version: integer('version').notNull().default(1),
    pinnedAt: ts('pinned_at'),
    decidedAt: ts('decided_at').notNull(),
  },
  (t) => [tenantUnique('project_decisions', t), tfk('project_decisions_project_fk', t.workspaceId, t.projectId, projects)],
);

export const projectMilestones = pgTable(
  'project_milestones',
  {
    ...tenantBase(),
    ...archivable(),
    projectId: uuid('project_id').notNull(),
    title: text('title').notNull(),
    dueDate: day('due_date'),
    completedAt: ts('completed_at'),
  },
  (t) => [tenantUnique('project_milestones', t), tfk('project_milestones_project_fk', t.workspaceId, t.projectId, projects)],
);

export const characters = pgTable(
  'characters',
  {
    ...tenantBase(),
    ...archivable(),
    projectId: uuid('project_id').notNull(),
    name: text('name').notNull(),
    role: text('role'),
    isPrimary: boolean('is_primary').notNull().default(false),
    currentVersionId: uuid('current_version_id'),
    approvedVersionId: uuid('approved_version_id'),
  },
  (t) => [
    tenantUnique('characters', t),
    tfk('characters_project_fk', t.workspaceId, t.projectId, projects),
    uniqueIndex('characters_primary_uq').on(t.projectId).where(sql`is_primary AND archived_at IS NULL`),
  ],
);

export interface CharacterProfile {
  fictionalIdentityNote?: string;
  /** Required for OFM-context characters: explicit declaration that the persona is an adult. */
  adultAgeDeclaration?: { declared: boolean; statedAge?: number };
  appearance?: string;
  voice?: string;
  personality?: string;
  tone?: string;
  allowedVariation?: string;
  biography?: string;
  audience?: string;
  styleConstraints?: string;
  toolsSettings?: string;
}
export interface CharacterPrompt {
  title: string;
  text: string;
  tool?: string;
}

export const characterVersions = pgTable(
  'character_versions',
  {
    ...tenantBase(),
    characterId: uuid('character_id').notNull(),
    versionNo: integer('version_no').notNull(),
    state: enumText('state', CHARACTER_VERSION_STATES).notNull().default('draft'),
    profile: json<CharacterProfile>('profile').notNull().default({}),
    prompts: json<CharacterPrompt[]>('prompts').notNull().default([]),
    referenceAssetVersionIds: uuid('reference_asset_version_ids').array().notNull().default(sql`'{}'::uuid[]`),
    changeNote: text('change_note'),
    submittedAt: ts('submitted_at'),
    approvedAt: ts('approved_at'),
    approvedBy: uuid('approved_by'),
    reviewId: uuid('review_id'),
  },
  (t) => [
    tenantUnique('character_versions', t),
    tfk('character_versions_character_fk', t.workspaceId, t.characterId, characters),
    uniqueIndex('character_versions_no_uq').on(t.characterId, t.versionNo),
    enumCheck('character_versions_state_ck', 'state', CHARACTER_VERSION_STATES),
  ],
);

export const seasons = pgTable(
  'seasons',
  {
    ...tenantBase(),
    ...archivable(),
    projectId: uuid('project_id').notNull(),
    name: text('name').notNull(),
    orderNo: integer('order_no').notNull(),
  },
  (t) => [tenantUnique('seasons', t), tfk('seasons_project_fk', t.workspaceId, t.projectId, projects)],
);

export const episodes = pgTable(
  'episodes',
  {
    ...tenantBase(),
    ...archivable(),
    projectId: uuid('project_id').notNull(),
    seasonId: uuid('season_id').notNull(),
    number: integer('number').notNull(),
    title: text('title').notNull(),
    synopsis: text('synopsis'),
    targetDurationSeconds: integer('target_duration_seconds'),
    language: text('language').notNull().default('en'),
    contentItemId: uuid('content_item_id'),
    thumbnailAssetId: uuid('thumbnail_asset_id'),
  },
  (t) => [
    tenantUnique('episodes', t),
    tfk('episodes_project_fk', t.workspaceId, t.projectId, projects),
    tfk('episodes_season_fk', t.workspaceId, t.seasonId, seasons),
    uniqueIndex('episodes_number_uq').on(t.seasonId, t.number, t.language).where(sql`archived_at IS NULL`),
  ],
);

export interface SceneDeliverable {
  label: string;
  format?: string;
  done?: boolean;
}

export const scenes = pgTable(
  'scenes',
  {
    ...tenantBase(),
    ...archivable(),
    projectId: uuid('project_id').notNull(),
    episodeId: uuid('episode_id').notNull(),
    orderNo: integer('order_no').notNull(),
    title: text('title').notNull(),
    script: text('script'),
    deliverables: json<SceneDeliverable[]>('deliverables').notNull().default([]),
    thumbnailAssetId: uuid('thumbnail_asset_id'),
  },
  (t) => [
    tenantUnique('scenes', t),
    tfk('scenes_project_fk', t.workspaceId, t.projectId, projects),
    tfk('scenes_episode_fk', t.workspaceId, t.episodeId, episodes),
  ],
);

/** Scenes reference frozen character versions, never "the latest profile". */
export const sceneCharacters = pgTable(
  'scene_characters',
  {
    ...tenantBase(),
    sceneId: uuid('scene_id').notNull(),
    characterVersionId: uuid('character_version_id').notNull(),
  },
  (t) => [
    tenantUnique('scene_characters', t),
    tfk('scene_characters_scene_fk', t.workspaceId, t.sceneId, scenes),
    tfk('scene_characters_cv_fk', t.workspaceId, t.characterVersionId, characterVersions),
    uniqueIndex('scene_characters_uq').on(t.sceneId, t.characterVersionId),
  ],
);

export const socialAccounts = pgTable(
  'social_accounts',
  {
    ...tenantBase(),
    ...archivable(),
    ...trashable(),
    projectId: uuid('project_id').notNull(),
    platform: enumText('platform', PLATFORMS).notNull(),
    originalUrl: text('original_url').notNull(),
    canonicalUrl: text('canonical_url').notNull(),
    identityKey: text('identity_key').notNull(),
    handle: text('handle'),
    displayName: text('display_name'),
    ownerMembershipId: uuid('owner_membership_id').notNull(),
    status: enumText('status', ACCOUNT_STATUSES).notNull().default('preparing'),
    statusReason: text('status_reason'),
    language: text('language'),
    markets: text('markets').array().notNull().default(sql`'{}'::text[]`),
    purpose: text('purpose'),
    notes: text('notes'),
    tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
    avatarAssetId: uuid('avatar_asset_id'),
    metricsCadence: text('metrics_cadence', { enum: ['daily', 'weekly', 'monthly'] })
      .notNull()
      .default('weekly'),
    metricsDayOfWeek: integer('metrics_day_of_week').notNull().default(1),
    metricsTime: text('metrics_time').notNull().default('10:00'),
    captionMaxLength: integer('caption_max_length'),
  },
  (t) => [
    tenantUnique('social_accounts', t),
    tfk('social_accounts_project_fk', t.workspaceId, t.projectId, projects),
    tfk('social_accounts_owner_fk', t.workspaceId, t.ownerMembershipId, memberships),
    uniqueIndex('social_accounts_identity_uq')
      .on(t.workspaceId, t.identityKey)
      .where(sql`archived_at IS NULL AND deleted_at IS NULL`),
    index('social_accounts_list_idx').on(t.workspaceId, t.status, t.updatedAt, t.id),
    index('social_accounts_project_idx').on(t.workspaceId, t.projectId),
    enumCheck('social_accounts_platform_ck', 'platform', PLATFORMS),
    enumCheck('social_accounts_status_ck', 'status', ACCOUNT_STATUSES),
  ],
);

export const accountAssignments = pgTable(
  'account_assignments',
  {
    ...tenantBase(),
    accountId: uuid('account_id').notNull(),
    membershipId: uuid('membership_id').notNull(),
    duty: enumText('duty', RESPONSIBILITIES).notNull(),
    supervisorMembershipId: uuid('supervisor_membership_id'),
    validFrom: ts('valid_from').notNull().defaultNow(),
    validTo: ts('valid_to'),
    endedReason: text('ended_reason'),
  },
  (t) => [
    tenantUnique('account_assignments', t),
    tfk('account_assignments_account_fk', t.workspaceId, t.accountId, socialAccounts),
    tfk('account_assignments_member_fk', t.workspaceId, t.membershipId, memberships),
    index('account_assignments_member_idx').on(t.workspaceId, t.membershipId, t.validTo),
  ],
);

export const accountIdentityHistory = pgTable(
  'account_identity_history',
  {
    ...tenantBase(),
    accountId: uuid('account_id').notNull(),
    oldHandle: text('old_handle'),
    newHandle: text('new_handle'),
    oldUrl: text('old_url'),
    newUrl: text('new_url'),
    effectiveAt: ts('effective_at').notNull(),
    reason: text('reason'),
  },
  (t) => [tenantUnique('account_identity_history', t), tfk('aih_account_fk', t.workspaceId, t.accountId, socialAccounts)],
);

export const accountTransfers = pgTable(
  'account_transfers',
  {
    ...tenantBase(),
    accountId: uuid('account_id').notNull(),
    fromProjectId: uuid('from_project_id').notNull(),
    toProjectId: uuid('to_project_id').notNull(),
    transferredAt: ts('transferred_at').notNull(),
    reason: text('reason').notNull(),
  },
  (t) => [tenantUnique('account_transfers', t), tfk('account_transfers_account_fk', t.workspaceId, t.accountId, socialAccounts)],
);

export const accountStatusEvents = pgTable(
  'account_status_events',
  {
    ...tenantBase(),
    accountId: uuid('account_id').notNull(),
    fromStatus: enumText('from_status', ACCOUNT_STATUSES),
    toStatus: enumText('to_status', ACCOUNT_STATUSES).notNull(),
    reason: text('reason'),
    occurredAt: ts('occurred_at').notNull(),
  },
  (t) => [tenantUnique('account_status_events', t), tfk('ase_account_fk', t.workspaceId, t.accountId, socialAccounts)],
);

export const references = pgTable(
  'references',
  {
    ...tenantBase(),
    ...archivable(),
    title: text('title').notNull(),
    sourceUrl: text('source_url'),
    sourceAssetId: uuid('source_asset_id'),
    previewAssetVersionId: uuid('preview_asset_version_id'),
    whatToReuse: text('what_to_reuse').notNull(),
    notes: text('notes'),
    tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
    ownerMembershipId: uuid('owner_membership_id').notNull(),
    /** Primary project scope; null = workspace-wide reference visible to references.read holders. */
    projectId: uuid('project_id'),
  },
  (t) => [
    tenantUnique('references', t),
    tfk('references_owner_fk', t.workspaceId, t.ownerMembershipId, memberships),
    tfk('references_project_fk', t.workspaceId, t.projectId, projects),
    index('references_list_idx').on(t.workspaceId, t.updatedAt, t.id),
  ],
);

export const referenceLinks = pgTable(
  'reference_links',
  {
    ...tenantBase(),
    referenceId: uuid('reference_id').notNull(),
    targetType: text('target_type', { enum: ['project', 'content_item', 'character'] }).notNull(),
    targetId: uuid('target_id').notNull(),
  },
  (t) => [
    tenantUnique('reference_links', t),
    tfk('reference_links_ref_fk', t.workspaceId, t.referenceId, references),
    uniqueIndex('reference_links_uq').on(t.referenceId, t.targetType, t.targetId),
    index('reference_links_target_idx').on(t.workspaceId, t.targetType, t.targetId),
  ],
);
