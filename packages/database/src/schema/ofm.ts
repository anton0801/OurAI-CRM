import { index, pgTable, uniqueIndex } from 'drizzle-orm/pg-core';
import {
  CONTACT_STAGES,
  COVERAGE_LANES,
  ERASURE_STATES,
  HANDOVER_ITEM_STATES,
  HANDOVER_STATES,
  INTERACTION_TYPES,
  OPERATION_STATUSES,
  OPERATION_TYPES,
  QUALITY_REVIEW_STATES,
  SALE_CANDIDATE_STATES,
  SHIFT_REPORT_STATES,
  SHIFT_STATES,
  SWAP_REQUEST_STATES,
  TASK_PRIORITIES,
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
  minor,
  rawCheck,
  sql,
  tenantBase,
  text,
  tfk,
  ts,
  uuid,
} from '../columns';
import { memberships, tenantUnique } from './identity';
import { projects, socialAccounts } from './organization';

export const ofmProfiles = pgTable(
  'ofm_profiles',
  {
    ...tenantBase(),
    projectId: uuid('project_id').notNull(),
    supervisorMembershipId: uuid('supervisor_membership_id'),
    settings: json<{ maxShiftAccounts?: number; handoverRequired?: boolean }>('settings').notNull().default({}),
    disabledAt: ts('disabled_at'),
  },
  (t) => [
    tenantUnique('ofm_profiles', t),
    tfk('ofm_profiles_project_fk', t.workspaceId, t.projectId, projects),
    uniqueIndex('ofm_profiles_project_uq').on(t.projectId),
  ],
);

export const ofmAssignments = pgTable(
  'ofm_assignments',
  {
    ...tenantBase(),
    projectId: uuid('project_id').notNull(),
    accountId: uuid('account_id').notNull(),
    membershipId: uuid('membership_id').notNull(),
    responsibility: text('responsibility').notNull(),
    coverageLane: enumText('coverage_lane', COVERAGE_LANES).notNull().default('primary'),
    coverageLaneLabel: text('coverage_lane_label'),
    validFrom: ts('valid_from').notNull(),
    validTo: ts('valid_to'),
    supervisorMembershipId: uuid('supervisor_membership_id'),
    handoverRequired: boolean('handover_required').notNull().default(true),
    endedAt: ts('ended_at'),
    endedReason: text('ended_reason'),
    transferredFromId: uuid('transferred_from_id'),
  },
  (t) => [
    tenantUnique('ofm_assignments', t),
    tfk('ofm_assignments_project_fk', t.workspaceId, t.projectId, projects),
    tfk('ofm_assignments_account_fk', t.workspaceId, t.accountId, socialAccounts),
    tfk('ofm_assignments_member_fk', t.workspaceId, t.membershipId, memberships),
    index('ofm_assignments_member_idx').on(t.workspaceId, t.membershipId, t.validTo),
    rawCheck('ofm_assignments_interval_ck', '"valid_to" IS NULL OR "valid_to" > "valid_from"'),
  ],
);

export const shifts = pgTable(
  'shifts',
  {
    ...tenantBase(),
    projectId: uuid('project_id').notNull(),
    primaryAccountId: uuid('primary_account_id').notNull(),
    membershipId: uuid('membership_id').notNull(),
    supervisorMembershipId: uuid('supervisor_membership_id'),
    scheduledStart: ts('scheduled_start').notNull(),
    scheduledEnd: ts('scheduled_end').notNull(),
    timezone: text('timezone').notNull(),
    state: enumText('state', SHIFT_STATES).notNull().default('scheduled'),
    reportState: enumText('report_state', SHIFT_REPORT_STATES).notNull().default('not_started'),
    actualStart: ts('actual_start'),
    actualEnd: ts('actual_end'),
    parallelCoverage: boolean('parallel_coverage').notNull().default(false),
    startOverrideReason: text('start_override_reason'),
    acknowledgedHandoverId: uuid('acknowledged_handover_id'),
    noHandoverReason: text('no_handover_reason'),
    endNote: text('end_note'),
    aborted: boolean('aborted').notNull().default(false),
    cancelReason: text('cancel_reason'),
    missedConfirmedAt: ts('missed_confirmed_at'),
    needsReviewReason: text('needs_review_reason'),
    forgotEndAlertedAt: ts('forgot_end_alerted_at'),
    correctedAt: ts('corrected_at'),
    correctionReason: text('correction_reason'),
    repeatGroupId: uuid('repeat_group_id'),
    occurrenceKey: text('occurrence_key'),
  },
  (t) => [
    tenantUnique('shifts', t),
    tfk('shifts_project_fk', t.workspaceId, t.projectId, projects),
    tfk('shifts_account_fk', t.workspaceId, t.primaryAccountId, socialAccounts),
    tfk('shifts_member_fk', t.workspaceId, t.membershipId, memberships),
    uniqueIndex('shifts_one_active_uq').on(t.membershipId).where(sql`state IN ('active', 'paused')`),
    uniqueIndex('shifts_occurrence_uq').on(t.repeatGroupId, t.occurrenceKey).where(sql`occurrence_key IS NOT NULL`),
    index('shifts_member_time_idx').on(t.workspaceId, t.membershipId, t.scheduledStart),
    index('shifts_state_idx').on(t.workspaceId, t.state, t.scheduledEnd),
    enumCheck('shifts_state_ck', 'state', SHIFT_STATES),
    enumCheck('shifts_report_state_ck', 'report_state', SHIFT_REPORT_STATES),
    rawCheck('shifts_schedule_ck', '"scheduled_end" > "scheduled_start"'),
    rawCheck('shifts_actual_ck', '"actual_end" IS NULL OR "actual_start" IS NULL OR "actual_end" >= "actual_start"'),
  ],
);

export const shiftAccounts = pgTable(
  'shift_accounts',
  {
    ...tenantBase(),
    shiftId: uuid('shift_id').notNull(),
    accountId: uuid('account_id').notNull(),
    isPrimary: boolean('is_primary').notNull().default(false),
    coverageLane: enumText('coverage_lane', COVERAGE_LANES).notNull().default('primary'),
    coverageLaneLabel: text('coverage_lane_label'),
    /** Confirmed time allocation share (percent). Null = not allocated. */
    timeAllocationShare: dec('time_allocation_share', 7, 4),
  },
  (t) => [
    tenantUnique('shift_accounts', t),
    tfk('shift_accounts_shift_fk', t.workspaceId, t.shiftId, shifts),
    tfk('shift_accounts_account_fk', t.workspaceId, t.accountId, socialAccounts),
    uniqueIndex('shift_accounts_uq').on(t.shiftId, t.accountId),
  ],
);

export const shiftBreaks = pgTable(
  'shift_breaks',
  {
    ...tenantBase(),
    shiftId: uuid('shift_id').notNull(),
    startedAt: ts('started_at').notNull(),
    endedAt: ts('ended_at'),
    reason: text('reason'),
  },
  (t) => [
    tenantUnique('shift_breaks', t),
    tfk('shift_breaks_shift_fk', t.workspaceId, t.shiftId, shifts),
    uniqueIndex('shift_breaks_one_open_uq').on(t.shiftId).where(sql`ended_at IS NULL`),
    rawCheck('shift_breaks_interval_ck', '"ended_at" IS NULL OR "ended_at" >= "started_at"'),
  ],
);

export const shiftTimeCorrections = pgTable(
  'shift_time_corrections',
  {
    ...tenantBase(),
    shiftId: uuid('shift_id').notNull(),
    before: json<Record<string, unknown>>('before').notNull(),
    after: json<Record<string, unknown>>('after').notNull(),
    reason: text('reason').notNull(),
  },
  (t) => [tenantUnique('shift_time_corrections', t), tfk('stc_shift_fk', t.workspaceId, t.shiftId, shifts)],
);

export const shiftReports = pgTable(
  'shift_reports',
  {
    ...tenantBase(),
    shiftId: uuid('shift_id').notNull(),
    state: enumText('state', SHIFT_REPORT_STATES).notNull().default('draft'),
    currentVersionId: uuid('current_version_id'),
    approvedVersionId: uuid('approved_version_id'),
    reviewerMembershipId: uuid('reviewer_membership_id'),
    submittedAt: ts('submitted_at'),
    approvedAt: ts('approved_at'),
  },
  (t) => [
    tenantUnique('shift_reports', t),
    tfk('shift_reports_shift_fk', t.workspaceId, t.shiftId, shifts),
    uniqueIndex('shift_reports_shift_uq').on(t.shiftId),
  ],
);

export interface ShiftReportCounts {
  conversationsHandled: number | null;
  followUpsCompleted: number | null;
  contentRequests: number | null;
  conversionEvents: number | null;
}

export const shiftReportVersions = pgTable(
  'shift_report_versions',
  {
    ...tenantBase(),
    reportId: uuid('report_id').notNull(),
    versionNo: integer('version_no').notNull(),
    summary: text('summary').notNull().default(''),
    completedWork: text('completed_work'),
    issues: text('issues'),
    nextActions: text('next_actions'),
    accountSections: json<{ accountId: string; notes: string }[]>('account_sections').notNull().default([]),
    counts: json<ShiftReportCounts>('counts')
      .notNull()
      .default({ conversationsHandled: null, followUpsCompleted: null, contentRequests: null, conversionEvents: null }),
    sourceRefs: json<{ label: string; assetId?: string; note?: string }[]>('source_refs').notNull().default([]),
    noOpenItems: boolean('no_open_items').notNull().default(false),
    handoverId: uuid('handover_id'),
    state: text('state', { enum: ['draft', 'submitted', 'changes_requested', 'approved'] }).notNull().default('draft'),
    reviewSummary: text('review_summary'),
    submittedAt: ts('submitted_at'),
  },
  (t) => [
    tenantUnique('shift_report_versions', t),
    tfk('srv_report_fk', t.workspaceId, t.reportId, shiftReports),
    uniqueIndex('srv_no_uq').on(t.reportId, t.versionNo),
  ],
);

export const handovers = pgTable(
  'handovers',
  {
    ...tenantBase(),
    fromShiftId: uuid('from_shift_id').notNull(),
    toShiftId: uuid('to_shift_id'),
    recipientMembershipId: uuid('recipient_membership_id'),
    accountId: uuid('account_id').notNull(),
    summary: text('summary').notNull(),
    state: enumText('state', HANDOVER_STATES).notNull().default('draft'),
    noOpenItems: boolean('no_open_items').notNull().default(false),
    submittedAt: ts('submitted_at'),
    acknowledgedAt: ts('acknowledged_at'),
    acknowledgedBy: uuid('acknowledged_by'),
  },
  (t) => [
    tenantUnique('handovers', t),
    tfk('handovers_from_shift_fk', t.workspaceId, t.fromShiftId, shifts),
    tfk('handovers_to_shift_fk', t.workspaceId, t.toShiftId, shifts),
    index('handovers_recipient_idx').on(t.workspaceId, t.recipientMembershipId, t.state),
    enumCheck('handovers_state_ck', 'state', HANDOVER_STATES),
  ],
);

/** Items reference existing tasks/operations by ID — never cloned between shifts. */
export const handoverItems = pgTable(
  'handover_items',
  {
    ...tenantBase(),
    handoverId: uuid('handover_id').notNull(),
    taskId: uuid('task_id'),
    operationId: uuid('operation_id'),
    title: text('title').notNull(),
    businessExplanation: text('business_explanation'),
    priority: enumText('priority', TASK_PRIORITIES).notNull().default('normal'),
    dueAt: ts('due_at'),
    state: enumText('state', HANDOVER_ITEM_STATES).notNull().default('open'),
    acceptedAt: ts('accepted_at'),
    resolvedAt: ts('resolved_at'),
    carriedFromItemId: uuid('carried_from_item_id'),
  },
  (t) => [tenantUnique('handover_items', t), tfk('handover_items_handover_fk', t.workspaceId, t.handoverId, handovers)],
);

export const ofmContacts = pgTable(
  'ofm_contacts',
  {
    ...tenantBase(),
    ...archivable(),
    accountId: uuid('account_id').notNull(),
    projectId: uuid('project_id').notNull(),
    externalIdentifier: text('external_identifier').notNull(),
    alias: text('alias').notNull(),
    managerMembershipId: uuid('manager_membership_id'),
    stage: enumText('stage', CONTACT_STAGES).notNull().default('new'),
    lastActivityAt: ts('last_activity_at'),
    nextFollowUpAt: ts('next_follow_up_at'),
    businessNotes: text('business_notes'),
    restricted: boolean('restricted').notNull().default(false),
    mergedIntoId: uuid('merged_into_id'),
    erasedAt: ts('erased_at'),
  },
  (t) => [
    tenantUnique('ofm_contacts', t),
    tfk('ofm_contacts_account_fk', t.workspaceId, t.accountId, socialAccounts),
    tfk('ofm_contacts_project_fk', t.workspaceId, t.projectId, projects),
    uniqueIndex('ofm_contacts_identity_uq').on(t.accountId, t.externalIdentifier),
    index('ofm_contacts_list_idx').on(t.workspaceId, t.accountId, t.stage),
    enumCheck('ofm_contacts_stage_ck', 'stage', CONTACT_STAGES),
  ],
);

/** Explicit pseudonymous relation across accounts (separate permission); no identity merge. */
export const ofmContactRelations = pgTable(
  'ofm_contact_relations',
  {
    ...tenantBase(),
    contactAId: uuid('contact_a_id').notNull(),
    contactBId: uuid('contact_b_id').notNull(),
    reason: text('reason').notNull(),
  },
  (t) => [
    tenantUnique('ofm_contact_relations', t),
    tfk('ocr_a_fk', t.workspaceId, t.contactAId, ofmContacts),
    tfk('ocr_b_fk', t.workspaceId, t.contactBId, ofmContacts),
  ],
);

export const interactionLogs = pgTable(
  'interaction_logs',
  {
    ...tenantBase(),
    contactId: uuid('contact_id').notNull(),
    accountId: uuid('account_id').notNull(),
    membershipId: uuid('membership_id').notNull(),
    shiftId: uuid('shift_id'),
    occurredAt: ts('occurred_at').notNull(),
    type: enumText('type', INTERACTION_TYPES).notNull(),
    businessNote: text('business_note').notNull(),
    erasedAt: ts('erased_at'),
  },
  (t) => [
    tenantUnique('interaction_logs', t),
    tfk('interaction_logs_contact_fk', t.workspaceId, t.contactId, ofmContacts),
    index('interaction_logs_contact_idx').on(t.workspaceId, t.contactId, t.occurredAt),
  ],
);

export const operations = pgTable(
  'operations',
  {
    ...tenantBase(),
    ...archivable(),
    accountId: uuid('account_id').notNull(),
    projectId: uuid('project_id').notNull(),
    contactId: uuid('contact_id'),
    ownerMembershipId: uuid('owner_membership_id').notNull(),
    type: enumText('type', OPERATION_TYPES).notNull(),
    title: text('title').notNull(),
    details: text('details'),
    dueAt: ts('due_at'),
    priority: enumText('priority', TASK_PRIORITIES).notNull().default('normal'),
    status: enumText('status', OPERATION_STATUSES).notNull().default('open'),
    waitingFor: text('waiting_for'),
    nextCheckAt: ts('next_check_at'),
    outcome: text('outcome'),
    cancelReason: text('cancel_reason'),
    shiftId: uuid('shift_id'),
    taskId: uuid('task_id'),
    contentItemId: uuid('content_item_id'),
    promisedDeliverable: text('promised_deliverable'),
    evidenceAssetIds: uuid('evidence_asset_ids').array().notNull().default(sql`'{}'::uuid[]`),
    completedAt: ts('completed_at'),
  },
  (t) => [
    tenantUnique('operations', t),
    tfk('operations_account_fk', t.workspaceId, t.accountId, socialAccounts),
    tfk('operations_contact_fk', t.workspaceId, t.contactId, ofmContacts),
    tfk('operations_owner_fk', t.workspaceId, t.ownerMembershipId, memberships),
    index('operations_queue_idx').on(t.workspaceId, t.status, t.dueAt),
    enumCheck('operations_type_ck', 'type', OPERATION_TYPES),
    enumCheck('operations_status_ck', 'status', OPERATION_STATUSES),
  ],
);

export const saleCandidates = pgTable(
  'sale_candidates',
  {
    ...tenantBase(),
    accountId: uuid('account_id').notNull(),
    projectId: uuid('project_id').notNull(),
    sourceNamespace: text('source_namespace').notNull(),
    /** External transaction id, or a generated manual reference with evidence. */
    sourceTransactionId: text('source_transaction_id').notNull(),
    manualReference: boolean('manual_reference').notNull().default(false),
    contactId: uuid('contact_id'),
    shiftId: uuid('shift_id'),
    operationId: uuid('operation_id'),
    occurredAt: ts('occurred_at').notNull(),
    grossMinor: minor('gross_minor'),
    refundMinor: minor('refund_minor'),
    feeMinor: minor('fee_minor'),
    netMinor: minor('net_minor'),
    currency: currency('currency').notNull(),
    sourceNote: text('source_note'),
    evidenceAssetIds: uuid('evidence_asset_ids').array().notNull().default(sql`'{}'::uuid[]`),
    claimedAllocations: json<{ membershipId: string; sharePercent: string }[]>('claimed_allocations').notNull().default([]),
    state: enumText('state', SALE_CANDIDATE_STATES).notNull().default('pending'),
    reviewNote: text('review_note'),
    reviewedBy: uuid('reviewed_by'),
    reviewedAt: ts('reviewed_at'),
    financialEntryId: uuid('financial_entry_id'),
    duplicateWarning: json<Record<string, unknown>>('duplicate_warning'),
  },
  (t) => [
    tenantUnique('sale_candidates', t),
    tfk('sale_candidates_account_fk', t.workspaceId, t.accountId, socialAccounts),
    uniqueIndex('sale_candidates_source_uq').on(t.workspaceId, t.sourceNamespace, t.sourceTransactionId),
    enumCheck('sale_candidates_state_ck', 'state', SALE_CANDIDATE_STATES),
  ],
);

export interface RubricCriterion {
  key: string;
  label: string;
  /** Percent weight (decimal string). */
  weight: string;
  description?: string;
}

export const rubricVersions = pgTable(
  'rubric_versions',
  {
    ...tenantBase(),
    name: text('name').notNull(),
    rubricKey: text('rubric_key').notNull(),
    versionNo: integer('version_no').notNull(),
    criteria: json<RubricCriterion[]>('criteria').notNull(),
    state: text('state', { enum: ['draft', 'published', 'retired'] }).notNull().default('draft'),
    publishedAt: ts('published_at'),
  },
  (t) => [tenantUnique('rubric_versions', t), uniqueIndex('rubric_versions_uq').on(t.workspaceId, t.rubricKey, t.versionNo)],
);

export interface QualityScore {
  key: string;
  /** 0–4, or null for Not Applicable. */
  score: number | null;
  note?: string;
  evidenceAssetIds?: string[];
}

export const qualityReviews = pgTable(
  'quality_reviews',
  {
    ...tenantBase(),
    subjectType: text('subject_type', { enum: ['shift', 'operation'] }).notNull(),
    subjectId: uuid('subject_id').notNull(),
    subjectMembershipId: uuid('subject_membership_id').notNull(),
    projectId: uuid('project_id').notNull(),
    reviewerMembershipId: uuid('reviewer_membership_id').notNull(),
    rubricVersionId: uuid('rubric_version_id').notNull(),
    scores: json<QualityScore[]>('scores').notNull().default([]),
    factualNotes: text('factual_notes'),
    improvements: text('improvements'),
    totalScore: dec('total_score', 7, 4),
    state: enumText('state', QUALITY_REVIEW_STATES).notNull().default('draft'),
    publishedAt: ts('published_at'),
    acknowledgedAt: ts('acknowledged_at'),
    employeeResponse: text('employee_response'),
    revisionOfId: uuid('revision_of_id'),
    supersededAt: ts('superseded_at'),
  },
  (t) => [
    tenantUnique('quality_reviews', t),
    tfk('quality_reviews_rubric_fk', t.workspaceId, t.rubricVersionId, rubricVersions),
    rawCheck('quality_reviews_self_ck', '"subject_membership_id" <> "reviewer_membership_id"'),
    enumCheck('quality_reviews_state_ck', 'state', QUALITY_REVIEW_STATES),
  ],
);

export const qualityDisputes = pgTable(
  'quality_disputes',
  {
    ...tenantBase(),
    qualityReviewId: uuid('quality_review_id').notNull(),
    raisedByMembershipId: uuid('raised_by_membership_id').notNull(),
    reason: text('reason').notNull(),
    state: text('state', { enum: ['open', 'resolved'] }).notNull().default('open'),
    decision: text('decision', { enum: ['upheld', 'revised', 'withdrawn'] }),
    resolution: text('resolution'),
    resolvedBy: uuid('resolved_by'),
    resolvedAt: ts('resolved_at'),
    replacementReviewId: uuid('replacement_review_id'),
  },
  (t) => [tenantUnique('quality_disputes', t), tfk('quality_disputes_review_fk', t.workspaceId, t.qualityReviewId, qualityReviews)],
);

export const shiftSwapRequests = pgTable(
  'shift_swap_requests',
  {
    ...tenantBase(),
    shiftId: uuid('shift_id').notNull(),
    fromMembershipId: uuid('from_membership_id').notNull(),
    proposedMembershipId: uuid('proposed_membership_id').notNull(),
    reason: text('reason').notNull(),
    state: enumText('state', SWAP_REQUEST_STATES).notNull().default('pending_acceptance'),
    acceptedAt: ts('accepted_at'),
    decidedAt: ts('decided_at'),
    decidedBy: uuid('decided_by'),
    decisionNote: text('decision_note'),
  },
  (t) => [tenantUnique('shift_swap_requests', t), tfk('ssr_shift_fk', t.workspaceId, t.shiftId, shifts)],
);

export const erasureRequests = pgTable(
  'erasure_requests',
  {
    ...tenantBase(),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    reason: text('reason').notNull(),
    state: enumText('state', ERASURE_STATES).notNull().default('queued'),
    plan: json<Record<string, unknown>>('plan').notNull().default({}),
    result: json<Record<string, unknown>>('result'),
    completedAt: ts('completed_at'),
  },
  (t) => [tenantUnique('erasure_requests', t)],
);
