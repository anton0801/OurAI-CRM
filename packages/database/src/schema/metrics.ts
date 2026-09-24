import { index, pgTable, uniqueIndex } from 'drizzle-orm/pg-core';
import {
  CHECKPOINT_STATES,
  CHECKPOINT_TIMING,
  GOAL_STATUSES,
  GOAL_TARGET_TYPES,
  METRIC_ENTITY_TYPES,
  METRIC_QUALITY_STATES,
  METRIC_SEGMENTS,
  METRIC_SOURCE_TYPES,
  OBSERVATION_KINDS,
  REPORT_CADENCES,
  VALUE_AVAILABILITY,
} from '@castlane/domain';
import {
  archivable,
  boolean,
  currency,
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
  ts,
  uuid,
  day,
} from '../columns';
import { memberships, tenantUnique } from './identity';

/** System metric catalog (not tenant-owned). Versioned: a definition change is a new row. */
export const metricDefinitions = pgTable(
  'metric_definitions',
  {
    id: uuid('id').primaryKey(),
    key: text('key').notNull(),
    version: integer('version').notNull(),
    label: text('label').notNull(),
    description: text('description').notNull(),
    entityType: enumText('entity_type', METRIC_ENTITY_TYPES).notNull(),
    observationKind: enumText('observation_kind', OBSERVATION_KINDS).notNull(),
    unit: text('unit').notNull(),
    valueType: text('value_type', { enum: ['integer', 'decimal', 'money', 'duration_seconds'] }).notNull(),
    aggregation: text('aggregation', { enum: ['sum_non_overlapping', 'last_snapshot', 'checkpoint_value', 'none'] }).notNull(),
    platforms: text('platforms').array(),
    active: boolean('active').notNull().default(true),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('metric_definitions_key_version_uq').on(t.key, t.version)],
);

export const metricObservations = pgTable(
  'metric_observations',
  {
    ...tenantBase(),
    entityType: enumText('entity_type', METRIC_ENTITY_TYPES).notNull(),
    entityId: uuid('entity_id').notNull(),
    accountId: uuid('account_id').notNull(),
    projectId: uuid('project_id').notNull(),
    publicationId: uuid('publication_id'),
    kind: enumText('kind', OBSERVATION_KINDS).notNull(),
    observedAt: ts('observed_at').notNull(),
    periodStart: ts('period_start'),
    periodEnd: ts('period_end'),
    platformTimezone: text('platform_timezone'),
    definitionSetVersion: integer('definition_set_version').notNull().default(1),
    segment: enumText('segment', METRIC_SEGMENTS).notNull().default('unknown'),
    sourceType: enumText('source_type', METRIC_SOURCE_TYPES).notNull(),
    sourceNamespace: text('source_namespace').notNull().default('manual'),
    sourceNote: text('source_note').notNull(),
    evidenceAssetIds: uuid('evidence_asset_ids').array().notNull().default(sql`'{}'::uuid[]`),
    enteredAt: ts('entered_at').notNull(),
    enteredByMembershipId: uuid('entered_by_membership_id'),
    qualityState: enumText('quality_state', METRIC_QUALITY_STATES).notNull().default('unverified'),
    revisionNo: integer('revision_no').notNull().default(1),
    /** Revision chain: the first observation's id groups all its revisions. */
    rootObservationId: uuid('root_observation_id').notNull(),
    supersedesId: uuid('supersedes_id'),
    correctionReason: text('correction_reason'),
    /** Approval note or rejection reason of a correction / review decision. */
    decisionNote: text('decision_note'),
    reviewedBy: uuid('reviewed_by'),
    reviewedAt: ts('reviewed_at'),
    checkpointId: uuid('checkpoint_id'),
    importJobId: uuid('import_job_id'),
    warnings: json<string[]>('warnings').notNull().default([]),
    warningNote: text('warning_note'),
    dedupeKey: text('dedupe_key').notNull(),
    /** Chosen observation when several sources report the same period. */
    canonical: boolean('canonical').notNull().default(true),
  },
  (t) => [
    tenantUnique('metric_observations', t),
    index('metric_observations_entity_idx').on(t.workspaceId, t.entityType, t.entityId, t.observedAt),
    index('metric_observations_account_idx').on(t.workspaceId, t.accountId, t.observedAt),
    /** Metrics freshness per project (project list/detail). */
    index('metric_observations_project_idx').on(t.workspaceId, t.projectId, t.observedAt),
    uniqueIndex('metric_observations_dedupe_uq')
      .on(t.workspaceId, t.dedupeKey)
      .where(sql`quality_state NOT IN ('superseded', 'rejected', 'pending_correction')`),
    /** At most one correction awaiting review per revision chain (concurrent corrections conflict). */
    uniqueIndex('metric_observations_pending_uq')
      .on(t.workspaceId, t.rootObservationId)
      .where(sql`quality_state = 'pending_correction'`),
    index('metric_observations_publication_idx').on(t.workspaceId, t.publicationId, t.observedAt),
    rawCheck('metric_observations_period_ck', '"kind" <> \'period\' OR ("period_start" IS NOT NULL AND "period_end" IS NOT NULL AND "period_end" > "period_start")'),
    enumCheck('metric_observations_kind_ck', 'kind', OBSERVATION_KINDS),
    enumCheck('metric_observations_quality_ck', 'quality_state', METRIC_QUALITY_STATES),
  ],
);

export const metricValues = pgTable(
  'metric_values',
  {
    ...tenantBase(),
    observationId: uuid('observation_id').notNull(),
    metricKey: text('metric_key').notNull(),
    definitionVersion: integer('definition_version').notNull().default(1),
    /** Null unless availability = known. Zero is only ever an explicit input. */
    value: dec('value', 30, 6),
    availability: enumText('availability', VALUE_AVAILABILITY).notNull(),
    unit: text('unit').notNull(),
    currency: currency('currency'),
  },
  (t) => [
    tenantUnique('metric_values', t),
    tfk('metric_values_observation_fk', t.workspaceId, t.observationId, metricObservations),
    uniqueIndex('metric_values_uq').on(t.observationId, t.metricKey),
    index('metric_values_key_idx').on(t.workspaceId, t.metricKey),
    rawCheck('metric_values_known_ck', '("availability" = \'known\') = ("value" IS NOT NULL)'),
  ],
);

export interface CheckpointPolicyConfig {
  publication: { key: string; offsetHours: number; toleranceHours: number; requiredMetrics: string[] }[];
  account: { requiredMetrics: string[]; graceHours: number };
}

export const checkpointPolicies = pgTable(
  'checkpoint_policies',
  {
    ...tenantBase(),
    version: integer('version').notNull(),
    config: json<CheckpointPolicyConfig>('config').notNull(),
    active: boolean('active').notNull().default(true),
  },
  (t) => [tenantUnique('checkpoint_policies', t), uniqueIndex('checkpoint_policies_version_uq').on(t.workspaceId, t.version)],
);

export const metricCheckpoints = pgTable(
  'metric_checkpoints',
  {
    ...tenantBase(),
    entityType: enumText('entity_type', METRIC_ENTITY_TYPES).notNull(),
    entityId: uuid('entity_id').notNull(),
    accountId: uuid('account_id').notNull(),
    projectId: uuid('project_id').notNull(),
    publicationId: uuid('publication_id'),
    checkpointKey: text('checkpoint_key').notNull(),
    policyVersion: integer('policy_version').notNull(),
    expectedAt: ts('expected_at').notNull(),
    windowStart: ts('window_start').notNull(),
    windowEnd: ts('window_end').notNull(),
    state: enumText('state', CHECKPOINT_STATES).notNull().default('pending'),
    completedObservationId: uuid('completed_observation_id'),
    timing: enumText('timing', CHECKPOINT_TIMING),
    missingReason: text('missing_reason'),
    cancelledReason: text('cancelled_reason'),
    occurrenceKey: text('occurrence_key').notNull(),
    assigneeMembershipId: uuid('assignee_membership_id'),
  },
  (t) => [
    tenantUnique('metric_checkpoints', t),
    uniqueIndex('metric_checkpoints_occurrence_uq').on(t.workspaceId, t.occurrenceKey),
    index('metric_checkpoints_due_idx').on(t.workspaceId, t.state, t.expectedAt),
    enumCheck('metric_checkpoints_state_ck', 'state', CHECKPOINT_STATES),
  ],
);

export const goals = pgTable(
  'goals',
  {
    ...tenantBase(),
    ...archivable(),
    name: text('name').notNull(),
    ownerMembershipId: uuid('owner_membership_id').notNull(),
    scopeType: text('scope_type', { enum: ['workspace', 'direction', 'project', 'account', 'campaign'] }).notNull(),
    scopeId: uuid('scope_id'),
    metricKey: text('metric_key').notNull(),
    targetType: enumText('target_type', GOAL_TARGET_TYPES).notNull(),
    targetValue: dec('target_value', 30, 6).notNull(),
    unit: text('unit').notNull(),
    periodStart: day('period_start').notNull(),
    periodEnd: day('period_end').notNull(),
    baselineValue: dec('baseline_value', 30, 6),
    direction: text('direction', { enum: ['increase', 'decrease'] }).notNull().default('increase'),
    linkedCampaignIds: uuid('linked_campaign_ids').array().notNull().default(sql`'{}'::uuid[]`),
    status: enumText('status', GOAL_STATUSES).notNull().default('active'),
    revisionNo: integer('revision_no').notNull().default(1),
    closedAt: ts('closed_at'),
    achievedValue: dec('achieved_value', 30, 6),
    completeness: dec('completeness', 7, 4),
    assessment: text('assessment'),
  },
  (t) => [
    tenantUnique('goals', t),
    tfk('goals_owner_fk', t.workspaceId, t.ownerMembershipId, memberships),
    rawCheck('goals_period_ck', '"period_end" >= "period_start"'),
  ],
);

export const goalRevisions = pgTable(
  'goal_revisions',
  {
    ...tenantBase(),
    goalId: uuid('goal_id').notNull(),
    revisionNo: integer('revision_no').notNull(),
    snapshot: json<Record<string, unknown>>('snapshot').notNull(),
    reason: text('reason'),
  },
  (t) => [tenantUnique('goal_revisions', t), tfk('goal_revisions_goal_fk', t.workspaceId, t.goalId, goals)],
);

export const goalCheckIns = pgTable(
  'goal_check_ins',
  {
    ...tenantBase(),
    goalId: uuid('goal_id').notNull(),
    membershipId: uuid('membership_id').notNull(),
    note: text('note').notNull(),
    manualValue: dec('manual_value', 30, 6),
    manualSource: text('manual_source'),
    measuredValue: dec('measured_value', 30, 6),
  },
  (t) => [tenantUnique('goal_check_ins', t), tfk('goal_check_ins_goal_fk', t.workspaceId, t.goalId, goals)],
);

export interface SavedReportConfig {
  dataset: string;
  dimensions: string[];
  metrics: string[];
  filters: { directionId?: string; projectIds?: string[]; accountIds?: string[]; platforms?: string[]; formats?: string[]; memberIds?: string[]; statuses?: string[] };
  timeGrain?: 'day' | 'week' | 'month' | 'quarter';
  sort?: { key: string; direction: 'asc' | 'desc' }[];
  chart?: 'line' | 'bar' | 'stacked_bar' | 'table';
  datePolicy?: { kind: 'relative'; preset: string } | { kind: 'fixed'; from: string; to: string };
}

export const savedReports = pgTable(
  'saved_reports',
  {
    ...tenantBase(),
    ...archivable(),
    name: text('name').notNull(),
    dataset: text('dataset').notNull(),
    config: json<SavedReportConfig>('config').notNull(),
    configVersion: integer('config_version').notNull().default(1),
    ownerMembershipId: uuid('owner_membership_id').notNull(),
    sharing: text('sharing', { enum: ['private', 'shared'] }).notNull().default('private'),
    sharedWithMembershipIds: uuid('shared_with_membership_ids').array().notNull().default(sql`'{}'::uuid[]`),
    duplicatedFromId: uuid('duplicated_from_id'),
  },
  (t) => [tenantUnique('saved_reports', t), tfk('saved_reports_owner_fk', t.workspaceId, t.ownerMembershipId, memberships)],
);

/** Configuration history of a saved report: every change of name/config is a new version (§17). */
export const savedReportVersions = pgTable(
  'saved_report_versions',
  {
    ...tenantBase(),
    reportId: uuid('report_id').notNull(),
    versionNo: integer('version_no').notNull(),
    name: text('name').notNull(),
    config: json<SavedReportConfig>('config').notNull(),
    changeNote: text('change_note'),
  },
  (t) => [
    tenantUnique('saved_report_versions', t),
    tfk('saved_report_versions_report_fk', t.workspaceId, t.reportId, savedReports),
    uniqueIndex('saved_report_versions_no_uq').on(t.reportId, t.versionNo),
  ],
);

export const reportSnapshots = pgTable(
  'report_snapshots',
  {
    ...tenantBase(),
    reportId: uuid('report_id').notNull(),
    configSnapshot: json<SavedReportConfig>('config_snapshot').notNull(),
    generatedForMembershipId: uuid('generated_for_membership_id').notNull(),
    asOf: ts('as_of').notNull(),
    sourceBounds: json<Record<string, unknown>>('source_bounds').notNull(),
    params: json<Record<string, unknown>>('params').notNull().default({}),
    result: json<Record<string, unknown>>('result').notNull(),
    sourceRevised: boolean('source_revised').notNull().default(false),
  },
  (t) => [tenantUnique('report_snapshots', t), tfk('report_snapshots_report_fk', t.workspaceId, t.reportId, savedReports)],
);

export const reportSchedules = pgTable(
  'report_schedules',
  {
    ...tenantBase(),
    reportId: uuid('report_id').notNull(),
    cadence: enumText('cadence', REPORT_CADENCES).notNull(),
    recipientMembershipIds: uuid('recipient_membership_ids').array().notNull(),
    ownerMembershipId: uuid('owner_membership_id').notNull(),
    localTime: text('local_time').notNull().default('08:00'),
    timezone: text('timezone').notNull(),
    nextRunAt: ts('next_run_at').notNull(),
    lastRunAt: ts('last_run_at'),
    active: boolean('active').notNull().default(true),
    pausedReason: text('paused_reason'),
    emailNotify: boolean('email_notify').notNull().default(false),
    /** Outcome of the last delivery: delivered / skipped recipients (no report data). */
    lastRunResult: json<{ delivered: number; skipped: { membershipId: string; reason: string }[]; at: string }>('last_run_result'),
  },
  (t) => [tenantUnique('report_schedules', t), tfk('report_schedules_report_fk', t.workspaceId, t.reportId, savedReports)],
);
