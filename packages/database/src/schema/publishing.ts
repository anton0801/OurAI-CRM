import { index, pgTable, uniqueIndex } from 'drizzle-orm/pg-core';
import {
  CAMPAIGN_STATUSES,
  CONTENT_FORMATS,
  DEAL_STAGES,
  EXPERIMENT_STATUSES,
  METRIC_SEGMENTS,
  PARTNER_KINDS,
  PUBLICATION_AVAILABILITY,
  PUBLICATION_STATUSES,
} from '@castlane/domain';
import {
  archivable,
  boolean,
  currency,
  day,
  enumCheck,
  enumText,
  integer,
  json,
  minor,
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
import { projects, socialAccounts } from './organization';
import { contentItems, contentVersions } from './production';

export const campaigns = pgTable(
  'campaigns',
  {
    ...tenantBase(),
    ...archivable(),
    name: text('name').notNull(),
    objective: text('objective').notNull(),
    ownerMembershipId: uuid('owner_membership_id').notNull(),
    startDate: day('start_date').notNull(),
    endDate: day('end_date').notNull(),
    status: enumText('status', CAMPAIGN_STATUSES).notNull().default('planned'),
    goals: json<{ metricKey: string; target: string; unit: string }[]>('goals').notNull().default([]),
    partnerId: uuid('partner_id'),
    coverAssetId: uuid('cover_asset_id'),
    closingSummary: text('closing_summary'),
    closedAt: ts('closed_at'),
    duplicatedFromId: uuid('duplicated_from_id'),
    tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
  },
  (t) => [
    tenantUnique('campaigns', t),
    tfk('campaigns_owner_fk', t.workspaceId, t.ownerMembershipId, memberships),
    rawCheck('campaigns_dates_ck', '"end_date" >= "start_date"'),
    enumCheck('campaigns_status_ck', 'status', CAMPAIGN_STATUSES),
  ],
);

export const campaignProjects = pgTable(
  'campaign_projects',
  {
    ...tenantBase(),
    campaignId: uuid('campaign_id').notNull(),
    projectId: uuid('project_id').notNull(),
  },
  (t) => [
    tenantUnique('campaign_projects', t),
    tfk('campaign_projects_campaign_fk', t.workspaceId, t.campaignId, campaigns),
    tfk('campaign_projects_project_fk', t.workspaceId, t.projectId, projects),
    uniqueIndex('campaign_projects_uq').on(t.campaignId, t.projectId),
  ],
);

export const publications = pgTable(
  'publications',
  {
    ...tenantBase(),
    ...archivable(),
    ...trashable(),
    contentItemId: uuid('content_item_id').notNull(),
    contentVersionId: uuid('content_version_id'),
    accountId: uuid('account_id').notNull(),
    /** Project at creation; account transfers never rewrite it. */
    projectId: uuid('project_id').notNull(),
    ownerMembershipId: uuid('owner_membership_id').notNull(),
    caption: text('caption'),
    cta: text('cta'),
    destinationUrl: text('destination_url'),
    primaryCampaignId: uuid('primary_campaign_id'),
    descriptiveTags: text('descriptive_tags').array().notNull().default(sql`'{}'::text[]`),
    status: enumText('status', PUBLICATION_STATUSES).notNull().default('draft'),
    scheduledAt: ts('scheduled_at'),
    scheduleTimezone: text('schedule_timezone'),
    originalScheduledAt: ts('original_scheduled_at'),
    actualPublishedAt: ts('actual_published_at'),
    externalPostUrl: text('external_post_url'),
    normalizedPostUrl: text('normalized_post_url'),
    noUrlReason: text('no_url_reason'),
    historicalEntry: boolean('historical_entry').notNull().default(false),
    sourceNote: text('source_note'),
    failureReason: text('failure_reason'),
    cancelReason: text('cancel_reason'),
    overrideReason: text('override_reason'),
    availability: enumText('availability', PUBLICATION_AVAILABILITY).notNull().default('available'),
    availabilityChangedAt: ts('availability_changed_at'),
    availabilityReason: text('availability_reason'),
    approvalRevokedAfterPublication: boolean('approval_revoked_after_publication').notNull().default(false),
    confirmedByMembershipId: uuid('confirmed_by_membership_id'),
    format: enumText('format', CONTENT_FORMATS),
  },
  (t) => [
    tenantUnique('publications', t),
    tfk('publications_content_fk', t.workspaceId, t.contentItemId, contentItems),
    tfk('publications_version_fk', t.workspaceId, t.contentVersionId, contentVersions),
    tfk('publications_account_fk', t.workspaceId, t.accountId, socialAccounts),
    tfk('publications_project_fk', t.workspaceId, t.projectId, projects),
    tfk('publications_owner_fk', t.workspaceId, t.ownerMembershipId, memberships),
    tfk('publications_campaign_fk', t.workspaceId, t.primaryCampaignId, campaigns),
    uniqueIndex('publications_post_url_uq').on(t.accountId, t.normalizedPostUrl).where(sql`normalized_post_url IS NOT NULL`),
    index('publications_account_published_idx').on(t.accountId, t.actualPublishedAt),
    index('publications_schedule_idx').on(t.workspaceId, t.status, t.scheduledAt),
    enumCheck('publications_status_ck', 'status', PUBLICATION_STATUSES),
  ],
);

export const publicationPlanRevisions = pgTable(
  'publication_plan_revisions',
  {
    ...tenantBase(),
    publicationId: uuid('publication_id').notNull(),
    fromScheduledAt: ts('from_scheduled_at'),
    toScheduledAt: ts('to_scheduled_at'),
    reason: text('reason'),
    changedAt: ts('changed_at').notNull(),
  },
  (t) => [tenantUnique('publication_plan_revisions', t), tfk('ppr_publication_fk', t.workspaceId, t.publicationId, publications)],
);

export const publicationCorrections = pgTable(
  'publication_corrections',
  {
    ...tenantBase(),
    publicationId: uuid('publication_id').notNull(),
    before: json<Record<string, unknown>>('before').notNull(),
    after: json<Record<string, unknown>>('after').notNull(),
    reason: text('reason').notNull(),
  },
  (t) => [tenantUnique('publication_corrections', t), tfk('pc_publication_fk', t.workspaceId, t.publicationId, publications)],
);

/** Weekly plan freeze (Monday 00:00 workspace time) used by M09. */
export const planBaselines = pgTable(
  'plan_baselines',
  {
    ...tenantBase(),
    weekStart: day('week_start').notNull(),
    frozenAt: ts('frozen_at').notNull(),
    timezone: text('timezone').notNull(),
  },
  (t) => [tenantUnique('plan_baselines', t), uniqueIndex('plan_baselines_week_uq').on(t.workspaceId, t.weekStart)],
);

export const planBaselineItems = pgTable(
  'plan_baseline_items',
  {
    ...tenantBase(),
    baselineId: uuid('baseline_id').notNull(),
    publicationId: uuid('publication_id').notNull(),
    accountId: uuid('account_id').notNull(),
    projectId: uuid('project_id').notNull(),
    baselineScheduledAt: ts('baseline_scheduled_at'),
    addedAfterBaseline: boolean('added_after_baseline').notNull().default(false),
    removedAfterBaselineAt: ts('removed_after_baseline_at'),
    removalReason: text('removal_reason'),
  },
  (t) => [
    tenantUnique('plan_baseline_items', t),
    tfk('pbi_baseline_fk', t.workspaceId, t.baselineId, planBaselines),
    tfk('pbi_publication_fk', t.workspaceId, t.publicationId, publications),
    uniqueIndex('pbi_uq').on(t.baselineId, t.publicationId),
  ],
);

export const trackingLinks = pgTable(
  'tracking_links',
  {
    ...tenantBase(),
    ...archivable(),
    campaignId: uuid('campaign_id').notNull(),
    label: text('label').notNull(),
    destinationUrl: text('destination_url').notNull(),
    utmSource: text('utm_source'),
    utmMedium: text('utm_medium'),
    utmCampaign: text('utm_campaign'),
    utmContent: text('utm_content'),
    utmTerm: text('utm_term'),
    builtUrl: text('built_url').notNull(),
    publicationId: uuid('publication_id'),
  },
  (t) => [tenantUnique('tracking_links', t), tfk('tracking_links_campaign_fk', t.workspaceId, t.campaignId, campaigns)],
);

/** Externally reported campaign results (clicks/conversions exist only when entered here). */
export const campaignSourceReports = pgTable(
  'campaign_source_reports',
  {
    ...tenantBase(),
    campaignId: uuid('campaign_id').notNull(),
    sourceName: text('source_name').notNull(),
    periodStart: ts('period_start').notNull(),
    periodEnd: ts('period_end').notNull(),
    clicks: integer('clicks'),
    conversions: integer('conversions'),
    attributionLabel: text('attribution_label').notNull(),
    trackingLinkId: uuid('tracking_link_id'),
    evidenceAssetId: uuid('evidence_asset_id'),
    note: text('note'),
  },
  (t) => [
    tenantUnique('campaign_source_reports', t),
    tfk('csr_campaign_fk', t.workspaceId, t.campaignId, campaigns),
    rawCheck('csr_period_ck', '"period_end" > "period_start"'),
  ],
);

export const experiments = pgTable(
  'experiments',
  {
    ...tenantBase(),
    ...archivable(),
    projectId: uuid('project_id').notNull(),
    ownerMembershipId: uuid('owner_membership_id').notNull(),
    hypothesis: text('hypothesis').notNull(),
    primaryMetricKey: text('primary_metric_key').notNull(),
    observationWindowHours: integer('observation_window_hours').notNull(),
    minimumSample: integer('minimum_sample').notNull().default(1),
    startAt: ts('start_at'),
    endAt: ts('end_at'),
    status: enumText('status', EXPERIMENT_STATUSES).notNull().default('draft'),
    limitations: text('limitations'),
    resultNote: text('result_note'),
    selectedVariantId: uuid('selected_variant_id'),
    planVersion: integer('plan_version').notNull().default(1),
    planFrozenAt: ts('plan_frozen_at'),
    conclusion: json<Record<string, unknown>>('conclusion'),
    duplicatedFromId: uuid('duplicated_from_id'),
  },
  (t) => [
    tenantUnique('experiments', t),
    tfk('experiments_project_fk', t.workspaceId, t.projectId, projects),
    enumCheck('experiments_status_ck', 'status', EXPERIMENT_STATUSES),
  ],
);

export const experimentVariants = pgTable(
  'experiment_variants',
  {
    ...tenantBase(),
    experimentId: uuid('experiment_id').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    thumbnailAssetId: uuid('thumbnail_asset_id'),
    position: integer('position').notNull().default(0),
  },
  (t) => [tenantUnique('experiment_variants', t), tfk('experiment_variants_exp_fk', t.workspaceId, t.experimentId, experiments)],
);

export const experimentPublications = pgTable(
  'experiment_publications',
  {
    ...tenantBase(),
    experimentId: uuid('experiment_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    publicationId: uuid('publication_id').notNull(),
    segment: enumText('segment', METRIC_SEGMENTS).notNull().default('organic'),
  },
  (t) => [
    tenantUnique('experiment_publications', t),
    tfk('ep_experiment_fk', t.workspaceId, t.experimentId, experiments),
    tfk('ep_variant_fk', t.workspaceId, t.variantId, experimentVariants),
    tfk('ep_publication_fk', t.workspaceId, t.publicationId, publications),
    uniqueIndex('ep_uq').on(t.experimentId, t.publicationId),
  ],
);

export const experimentRevisions = pgTable(
  'experiment_revisions',
  {
    ...tenantBase(),
    experimentId: uuid('experiment_id').notNull(),
    planVersion: integer('plan_version').notNull(),
    snapshot: json<Record<string, unknown>>('snapshot').notNull(),
    reason: text('reason'),
  },
  (t) => [tenantUnique('experiment_revisions', t), tfk('er_experiment_fk', t.workspaceId, t.experimentId, experiments)],
);

export const partners = pgTable(
  'partners',
  {
    ...tenantBase(),
    ...archivable(),
    kind: enumText('kind', PARTNER_KINDS).notNull(),
    name: text('name').notNull(),
    contactName: text('contact_name'),
    businessEmail: text('business_email'),
    website: text('website'),
    ownerMembershipId: uuid('owner_membership_id').notNull(),
    tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
    logoAssetId: uuid('logo_asset_id'),
    notes: text('notes'),
    mergedIntoId: uuid('merged_into_id'),
  },
  (t) => [
    tenantUnique('partners', t),
    tfk('partners_owner_fk', t.workspaceId, t.ownerMembershipId, memberships),
    index('partners_list_idx').on(t.workspaceId, t.updatedAt, t.id),
  ],
);

export const partnerInteractions = pgTable(
  'partner_interactions',
  {
    ...tenantBase(),
    partnerId: uuid('partner_id').notNull(),
    dealId: uuid('deal_id'),
    occurredAt: ts('occurred_at').notNull(),
    kind: text('kind', { enum: ['call', 'meeting', 'email_summary', 'note', 'other'] }).notNull(),
    summary: text('summary').notNull(),
    membershipId: uuid('membership_id').notNull(),
  },
  (t) => [
    tenantUnique('partner_interactions', t),
    tfk('pi_partner_fk', t.workspaceId, t.partnerId, partners),
    index('pi_partner_idx').on(t.workspaceId, t.partnerId, t.occurredAt),
  ],
);

export const deals = pgTable(
  'deals',
  {
    ...tenantBase(),
    ...archivable(),
    title: text('title').notNull(),
    partnerId: uuid('partner_id').notNull(),
    ownerMembershipId: uuid('owner_membership_id').notNull(),
    stage: enumText('stage', DEAL_STAGES).notNull().default('lead'),
    /** Planned amount only — never recognised revenue. */
    amountMinor: minor('amount_minor'),
    currency: currency('currency'),
    campaignId: uuid('campaign_id'),
    expectedCloseDate: day('expected_close_date'),
    stageReason: text('stage_reason'),
    outcome: text('outcome'),
    closedAt: ts('closed_at'),
    paymentSchedule: json<{ dueDate: string; amount: string; currency: string; note?: string }[]>('payment_schedule')
      .notNull()
      .default([]),
  },
  (t) => [
    tenantUnique('deals', t),
    tfk('deals_partner_fk', t.workspaceId, t.partnerId, partners),
    tfk('deals_owner_fk', t.workspaceId, t.ownerMembershipId, memberships),
    index('deals_list_idx').on(t.workspaceId, t.stage, t.updatedAt, t.id),
    index('deals_partner_idx').on(t.workspaceId, t.partnerId),
    enumCheck('deals_stage_ck', 'stage', DEAL_STAGES),
  ],
);

export const dealProjects = pgTable(
  'deal_projects',
  {
    ...tenantBase(),
    dealId: uuid('deal_id').notNull(),
    projectId: uuid('project_id').notNull(),
  },
  (t) => [
    tenantUnique('deal_projects', t),
    tfk('deal_projects_deal_fk', t.workspaceId, t.dealId, deals),
    tfk('deal_projects_project_fk', t.workspaceId, t.projectId, projects),
    uniqueIndex('deal_projects_uq').on(t.dealId, t.projectId),
    index('deal_projects_project_idx').on(t.workspaceId, t.projectId),
  ],
);

export const dealStageEvents = pgTable(
  'deal_stage_events',
  {
    ...tenantBase(),
    dealId: uuid('deal_id').notNull(),
    fromStage: enumText('from_stage', DEAL_STAGES),
    toStage: enumText('to_stage', DEAL_STAGES).notNull(),
    reason: text('reason'),
    occurredAt: ts('occurred_at').notNull(),
  },
  (t) => [tenantUnique('deal_stage_events', t), tfk('dse_deal_fk', t.workspaceId, t.dealId, deals)],
);

export const deliverables = pgTable(
  'deliverables',
  {
    ...tenantBase(),
    ...archivable(),
    dealId: uuid('deal_id').notNull(),
    title: text('title').notNull(),
    format: enumText('format', CONTENT_FORMATS),
    projectId: uuid('project_id'),
    accountId: uuid('account_id'),
    dueAt: ts('due_at'),
    acceptanceCriteria: text('acceptance_criteria'),
    contentItemId: uuid('content_item_id'),
    agreedAmountMinor: minor('agreed_amount_minor'),
    currency: currency('currency'),
    status: text('status', { enum: ['open', 'delivered', 'accepted', 'cancelled'] }).notNull().default('open'),
  },
  (t) => [
    tenantUnique('deliverables', t),
    tfk('deliverables_deal_fk', t.workspaceId, t.dealId, deals),
    tfk('deliverables_project_fk', t.workspaceId, t.projectId, projects),
    tfk('deliverables_account_fk', t.workspaceId, t.accountId, socialAccounts),
    tfk('deliverables_content_fk', t.workspaceId, t.contentItemId, contentItems),
    index('deliverables_deal_idx').on(t.workspaceId, t.dealId),
  ],
);
