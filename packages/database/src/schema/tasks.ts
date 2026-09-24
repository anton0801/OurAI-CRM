import { index, pgTable, uniqueIndex } from 'drizzle-orm/pg-core';
import {
  ABSENCE_CATEGORIES,
  ABSENCE_STATES,
  MONTH_DAY_POLICIES,
  RECURRENCE_CADENCES,
  RECURRENCE_MODES,
  TASK_PRIORITIES,
  TASK_STATUSES,
  TIME_ENTRY_SOURCES,
  TIME_ENTRY_STATES,
} from '@castlane/domain';
import {
  archivable,
  boolean,
  day,
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
import { projects, socialAccounts } from './organization';
import { contentItems } from './production';

export const tasks = pgTable(
  'tasks',
  {
    ...tenantBase(),
    ...archivable(),
    ...trashable(),
    projectId: uuid('project_id').notNull(),
    title: text('title').notNull(),
    description: text('description'),
    status: enumText('status', TASK_STATUSES).notNull().default('draft'),
    priority: enumText('priority', TASK_PRIORITIES).notNull().default('normal'),
    assigneeMembershipId: uuid('assignee_membership_id'),
    reviewerMembershipId: uuid('reviewer_membership_id'),
    startAt: ts('start_at'),
    dueAt: ts('due_at'),
    /** When the deadline was entered as a calendar date: stored as end of that day in dueTimezone. */
    dueDate: day('due_date'),
    dueTimezone: text('due_timezone'),
    baselineDueAt: ts('baseline_due_at'),
    estimateMinutes: integer('estimate_minutes'),
    parentTaskId: uuid('parent_task_id'),
    /** Typed optional links (explicit columns rather than a polymorphic pair). */
    accountId: uuid('account_id'),
    contentItemId: uuid('content_item_id'),
    publicationId: uuid('publication_id'),
    shiftId: uuid('shift_id'),
    operationId: uuid('operation_id'),
    dealId: uuid('deal_id'),
    deliverableId: uuid('deliverable_id'),
    articleId: uuid('article_id'),
    blockedAt: ts('blocked_at'),
    blockedReason: text('blocked_reason'),
    nextCheckAt: ts('next_check_at'),
    completedAt: ts('completed_at'),
    completedBy: uuid('completed_by'),
    completionEffectiveAt: ts('completion_effective_at'),
    cancelledAt: ts('cancelled_at'),
    cancelReason: text('cancel_reason'),
    cancellationAccepted: boolean('cancellation_accepted').notNull().default(false),
    reopenCount: integer('reopen_count').notNull().default(0),
    assigneeAtCompletion: uuid('assignee_at_completion'),
    source: text('source', { enum: ['manual', 'template', 'automation', 'recurrence', 'handover', 'import', 'deal'] })
      .notNull()
      .default('manual'),
    templateApplicationId: uuid('template_application_id'),
    recurrenceOccurrenceId: uuid('recurrence_occurrence_id'),
    requiredForParent: boolean('required_for_parent').notNull().default(true),
    tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
    followerMembershipIds: uuid('follower_membership_ids').array().notNull().default(sql`'{}'::uuid[]`),
  },
  (t) => [
    tenantUnique('tasks', t),
    tfk('tasks_project_fk', t.workspaceId, t.projectId, projects),
    tfk('tasks_assignee_fk', t.workspaceId, t.assigneeMembershipId, memberships),
    tfk('tasks_reviewer_fk', t.workspaceId, t.reviewerMembershipId, memberships),
    tfk('tasks_parent_fk', t.workspaceId, t.parentTaskId, t),
    tfk('tasks_account_fk', t.workspaceId, t.accountId, socialAccounts),
    tfk('tasks_content_fk', t.workspaceId, t.contentItemId, contentItems),
    index('tasks_list_idx').on(t.workspaceId, t.status, t.updatedAt, t.id),
    index('tasks_assignee_due_idx').on(t.workspaceId, t.assigneeMembershipId, t.dueAt),
    index('tasks_project_idx').on(t.workspaceId, t.projectId, t.status),
    enumCheck('tasks_status_ck', 'status', TASK_STATUSES),
    enumCheck('tasks_priority_ck', 'priority', TASK_PRIORITIES),
    rawCheck('tasks_dates_ck', '"start_at" IS NULL OR "due_at" IS NULL OR "start_at" <= "due_at"'),
    rawCheck('tasks_estimate_ck', '"estimate_minutes" IS NULL OR "estimate_minutes" >= 0'),
  ],
);

export const taskChecklistItems = pgTable(
  'task_checklist_items',
  {
    ...tenantBase(),
    taskId: uuid('task_id').notNull(),
    label: text('label').notNull(),
    mandatory: boolean('mandatory').notNull().default(false),
    done: boolean('done').notNull().default(false),
    doneAt: ts('done_at'),
    doneBy: uuid('done_by'),
    position: integer('position').notNull().default(0),
    removedAt: ts('removed_at'),
  },
  (t) => [
    tenantUnique('task_checklist_items', t),
    tfk('task_checklist_items_task_fk', t.workspaceId, t.taskId, tasks),
    index('task_checklist_items_task_idx').on(t.workspaceId, t.taskId),
  ],
);

export const taskDependencies = pgTable(
  'task_dependencies',
  {
    ...tenantBase(),
    predecessorId: uuid('predecessor_id').notNull(),
    successorId: uuid('successor_id').notNull(),
    kind: text('kind', { enum: ['finish_to_start'] }).notNull().default('finish_to_start'),
    overriddenAt: ts('overridden_at'),
    overrideReason: text('override_reason'),
    removedAt: ts('removed_at'),
    removedReason: text('removed_reason'),
  },
  (t) => [
    tenantUnique('task_dependencies', t),
    tfk('task_dependencies_pred_fk', t.workspaceId, t.predecessorId, tasks),
    tfk('task_dependencies_succ_fk', t.workspaceId, t.successorId, tasks),
    uniqueIndex('task_dependencies_active_uq').on(t.predecessorId, t.successorId).where(sql`removed_at IS NULL`),
    rawCheck('task_dependencies_self_ck', '"predecessor_id" <> "successor_id"'),
  ],
);

/** Source of cycle-time analytics: every status transition. */
export const taskStatusEvents = pgTable(
  'task_status_events',
  {
    ...tenantBase(),
    taskId: uuid('task_id').notNull(),
    fromStatus: enumText('from_status', TASK_STATUSES),
    toStatus: enumText('to_status', TASK_STATUSES).notNull(),
    occurredAt: ts('occurred_at').notNull(),
    effectiveAt: ts('effective_at'),
    actorMembershipId: uuid('actor_membership_id'),
    reason: text('reason'),
    cycle: integer('cycle').notNull().default(1),
  },
  (t) => [
    tenantUnique('task_status_events', t),
    tfk('task_status_events_task_fk', t.workspaceId, t.taskId, tasks),
    index('task_status_events_task_idx').on(t.workspaceId, t.taskId, t.occurredAt),
  ],
);

export const taskBlockIntervals = pgTable(
  'task_block_intervals',
  {
    ...tenantBase(),
    taskId: uuid('task_id').notNull(),
    reason: text('reason').notNull(),
    startedAt: ts('started_at').notNull(),
    endedAt: ts('ended_at'),
    resolution: text('resolution'),
  },
  (t) => [tenantUnique('task_block_intervals', t), tfk('task_block_intervals_task_fk', t.workspaceId, t.taskId, tasks)],
);

/** Task due-date revisions (baseline_due_at never moves with ordinary reschedules). */
export const taskDueRevisions = pgTable(
  'task_due_revisions',
  {
    ...tenantBase(),
    taskId: uuid('task_id').notNull(),
    fromDueAt: ts('from_due_at'),
    toDueAt: ts('to_due_at'),
    reason: text('reason'),
    deadlineRevision: integer('deadline_revision').notNull(),
  },
  (t) => [tenantUnique('task_due_revisions', t), tfk('task_due_revisions_task_fk', t.workspaceId, t.taskId, tasks)],
);

export interface RecurrenceTaskTemplate {
  title: string;
  description?: string;
  assigneeMembershipId?: string | null;
  reviewerMembershipId?: string | null;
  priority?: (typeof TASK_PRIORITIES)[number];
  estimateMinutes?: number | null;
  checklist?: { label: string; mandatory: boolean }[];
  dueOffsetMinutes?: number;
}

export const recurrenceRules = pgTable(
  'recurrence_rules',
  {
    ...tenantBase(),
    ...archivable(),
    projectId: uuid('project_id').notNull(),
    ownerMembershipId: uuid('owner_membership_id').notNull(),
    template: json<RecurrenceTaskTemplate>('template').notNull(),
    cadence: enumText('cadence', RECURRENCE_CADENCES).notNull(),
    intervalCount: integer('interval_count').notNull().default(1),
    weekdays: integer('weekdays').array().notNull().default(sql`'{}'::int[]`),
    monthDay: integer('month_day'),
    monthDayPolicy: enumText('month_day_policy', MONTH_DAY_POLICIES).notNull().default('last_day_of_month'),
    localTime: text('local_time').notNull().default('09:00'),
    timezone: text('timezone').notNull(),
    mode: enumText('mode', RECURRENCE_MODES).notNull().default('fixed_schedule'),
    startsOn: day('starts_on').notNull(),
    endsOn: day('ends_on'),
    horizonDays: integer('horizon_days').notNull().default(30),
    backfillLimit: integer('backfill_limit').notNull().default(0),
    ruleVersion: integer('rule_version').notNull().default(1),
    active: boolean('active').notNull().default(true),
    lastGeneratedThrough: ts('last_generated_through'),
  },
  (t) => [
    tenantUnique('recurrence_rules', t),
    tfk('recurrence_rules_project_fk', t.workspaceId, t.projectId, projects),
    rawCheck('recurrence_rules_backfill_ck', '"backfill_limit" BETWEEN 0 AND 30'),
  ],
);

export const recurrenceOccurrences = pgTable(
  'recurrence_occurrences',
  {
    ...tenantBase(),
    ruleId: uuid('rule_id').notNull(),
    ruleVersion: integer('rule_version').notNull(),
    occurrenceKey: text('occurrence_key').notNull(),
    scheduledFor: ts('scheduled_for').notNull(),
    taskId: uuid('task_id'),
    state: text('state', { enum: ['created', 'missed', 'skipped', 'cancelled'] }).notNull().default('created'),
    missedDates: json<string[]>('missed_dates').notNull().default([]),
  },
  (t) => [
    tenantUnique('recurrence_occurrences', t),
    tfk('recurrence_occurrences_rule_fk', t.workspaceId, t.ruleId, recurrenceRules),
    uniqueIndex('recurrence_occurrences_key_uq').on(t.ruleId, t.occurrenceKey),
  ],
);

export const timeEntries = pgTable(
  'time_entries',
  {
    ...tenantBase(),
    membershipId: uuid('membership_id').notNull(),
    taskId: uuid('task_id').notNull(),
    projectId: uuid('project_id').notNull(),
    source: enumText('source', TIME_ENTRY_SOURCES).notNull(),
    state: enumText('state', TIME_ENTRY_STATES).notNull().default('draft'),
    startedAt: ts('started_at'),
    endedAt: ts('ended_at'),
    durationSeconds: integer('duration_seconds'),
    workDate: day('work_date').notNull(),
    note: text('note'),
    billable: boolean('billable').notNull().default(false),
    submissionId: uuid('submission_id'),
    approvedAt: ts('approved_at'),
    approvedBy: uuid('approved_by'),
    returnedReason: text('returned_reason'),
    /** Approved entries are corrected via a new revision row that supersedes the old one. */
    revisionOfId: uuid('revision_of_id'),
    supersededAt: ts('superseded_at'),
    needsReviewReason: text('needs_review_reason'),
    closedByMembershipId: uuid('closed_by_membership_id'),
    closeReason: text('close_reason'),
  },
  (t) => [
    tenantUnique('time_entries', t),
    tfk('time_entries_member_fk', t.workspaceId, t.membershipId, memberships),
    tfk('time_entries_task_fk', t.workspaceId, t.taskId, tasks),
    tfk('time_entries_project_fk', t.workspaceId, t.projectId, projects),
    uniqueIndex('time_entries_one_running_uq').on(t.membershipId).where(sql`state = 'running'`),
    index('time_entries_member_date_idx').on(t.workspaceId, t.membershipId, t.workDate),
    enumCheck('time_entries_state_ck', 'state', TIME_ENTRY_STATES),
    rawCheck('time_entries_duration_ck', '"duration_seconds" IS NULL OR ("duration_seconds" > 0 AND "duration_seconds" <= 86400)'),
    rawCheck('time_entries_interval_ck', '"started_at" IS NULL OR "ended_at" IS NULL OR "ended_at" > "started_at"'),
  ],
);

export const timeSheetSubmissions = pgTable(
  'time_sheet_submissions',
  {
    ...tenantBase(),
    membershipId: uuid('membership_id').notNull(),
    weekStart: day('week_start').notNull(),
    state: text('state', { enum: ['submitted', 'approved', 'returned'] }).notNull().default('submitted'),
    entrySnapshot: json<{ id: string; rowVersion: number; durationSeconds: number }[]>('entry_snapshot').notNull(),
    submittedAt: ts('submitted_at').notNull(),
    decidedAt: ts('decided_at'),
    decidedBy: uuid('decided_by'),
    reason: text('reason'),
    /** Designated approver (the member's manager when they may approve); null = any approver in scope. */
    approverMembershipId: uuid('approver_membership_id'),
  },
  (t) => [
    tenantUnique('time_sheet_submissions', t),
    tfk('tss_member_fk', t.workspaceId, t.membershipId, memberships),
    tfk('tss_approver_fk', t.workspaceId, t.approverMembershipId, memberships),
    /** One pending (submitted) sheet per member and week; approved and returned sheets stay as history. */
    uniqueIndex('tss_member_week_pending_uq').on(t.membershipId, t.weekStart).where(sql`state = 'submitted'`),
  ],
);

export type WeekdayMinutes = Record<'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday', number>;

export const capacities = pgTable(
  'capacities',
  {
    ...tenantBase(),
    membershipId: uuid('membership_id').notNull(),
    weekdayMinutes: json<WeekdayMinutes>('weekday_minutes').notNull(),
    effectiveFrom: day('effective_from').notNull(),
    confirmedAt: ts('confirmed_at'),
    confirmedBy: uuid('confirmed_by'),
  },
  (t) => [
    tenantUnique('capacities', t),
    tfk('capacities_member_fk', t.workspaceId, t.membershipId, memberships),
    uniqueIndex('capacities_member_from_uq').on(t.membershipId, t.effectiveFrom),
  ],
);

export const absences = pgTable(
  'absences',
  {
    ...tenantBase(),
    membershipId: uuid('membership_id').notNull(),
    startDate: day('start_date').notNull(),
    endDate: day('end_date').notNull(),
    category: enumText('category', ABSENCE_CATEGORIES).notNull(),
    /** Visible only to the member, their manager and workload managers. */
    privateReason: text('private_reason'),
    state: enumText('state', ABSENCE_STATES).notNull().default('approved'),
    decidedBy: uuid('decided_by'),
  },
  (t) => [
    tenantUnique('absences', t),
    tfk('absences_member_fk', t.workspaceId, t.membershipId, memberships),
    rawCheck('absences_dates_ck', '"end_date" >= "start_date"'),
  ],
);

export const workloadAllocations = pgTable(
  'workload_allocations',
  {
    ...tenantBase(),
    taskId: uuid('task_id').notNull(),
    membershipId: uuid('membership_id').notNull(),
    workDate: day('work_date').notNull(),
    minutes: integer('minutes').notNull(),
  },
  (t) => [
    tenantUnique('workload_allocations', t),
    tfk('workload_allocations_task_fk', t.workspaceId, t.taskId, tasks),
    uniqueIndex('workload_allocations_uq').on(t.taskId, t.membershipId, t.workDate),
  ],
);

/** Personal reminders — snoozing one never moves the underlying deadline. */
export const personalReminders = pgTable(
  'personal_reminders',
  {
    ...tenantBase(),
    membershipId: uuid('membership_id').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    remindAt: ts('remind_at').notNull(),
    snoozedUntil: ts('snoozed_until'),
    dismissedAt: ts('dismissed_at'),
    note: text('note'),
    /** manual = "Remind Me"; due = generated from a task deadline revision (24 h / 1 h / overdue). */
    source: text('source', { enum: ['manual', 'due'] }).notNull().default('manual'),
    threshold: text('threshold'),
    /** Deadline revision a due reminder belongs to; a rescheduled deadline makes it stale. */
    deadlineRevision: integer('deadline_revision'),
    /** Last delivery (in-app notification); a later snooze time fires again. */
    firedAt: ts('fired_at'),
    dismissedReason: text('dismissed_reason'),
  },
  (t) => [
    tenantUnique('personal_reminders', t),
    tfk('personal_reminders_member_fk', t.workspaceId, t.membershipId, memberships),
    index('personal_reminders_member_idx').on(t.workspaceId, t.membershipId, t.dismissedAt),
    uniqueIndex('personal_reminders_due_uq')
      .on(t.membershipId, t.entityType, t.entityId, t.threshold, t.deadlineRevision)
      .where(sql`source = 'due'`),
  ],
);
