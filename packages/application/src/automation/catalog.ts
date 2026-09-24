import { and, eq, inArray, isNull, lte, gt, or, sql, type SQL } from 'drizzle-orm';
import {
  ACCOUNT_STATUSES,
  AUTOMATION_ACTION_TYPES,
  AUTOMATION_TRIGGER_KIND,
  CHECKPOINT_STATES,
  CONTENT_FORMATS,
  CONTENT_STAGES,
  DEAL_STAGES,
  HANDOVER_STATES,
  PLATFORMS,
  PROJECT_TYPES,
  PUBLICATION_STATUSES,
  SHIFT_REPORT_STATES,
  SHIFT_STATES,
  TASK_PRIORITIES,
  TASK_STATUSES,
  type AutomationActionType,
  type AutomationFieldSpec,
  type AutomationTriggerKey,
  type AutomationTriggerKind,
} from '@castlane/domain';
import { metricCheckpoints, projects, shifts, socialAccounts, taskDueRevisions, tasks, type DbOrTx } from '@castlane/database';
import type { OutboxEventRecord } from '../core/jobs-registry';
import { contentIdFromEvent, type AutomationRecordType, type RuleScopeLike } from './records';

/**
 * The rule language catalogue (§19): allowed triggers with the typed facts their conditions may
 * use, the actions each trigger allows, and how deadline triggers find due records.
 */

const PROJECT_FIELDS: AutomationFieldSpec[] = [
  { key: 'project.type', label: 'Project type', type: 'enum', options: PROJECT_TYPES },
  { key: 'project.id', label: 'Project', type: 'id', lookup: 'project' },
  { key: 'direction.id', label: 'Direction', type: 'id', lookup: 'direction' },
];

const CONTENT_FIELDS: AutomationFieldSpec[] = [
  ...PROJECT_FIELDS,
  { key: 'content.format', label: 'Format', type: 'enum', options: CONTENT_FORMATS },
  { key: 'content.stage', label: 'Stage', type: 'enum', options: CONTENT_STAGES },
  { key: 'content.owner', label: 'Content owner', type: 'member' },
  { key: 'content.reviewer', label: 'Reviewer', type: 'member' },
  { key: 'content.tags', label: 'Tags', type: 'tags' },
  { key: 'content.dueAt', label: 'Content deadline', type: 'datetime' },
  { key: 'content.submittedAt', label: 'Submitted for review', type: 'datetime' },
];

const ACCOUNT_REF_FIELDS: AutomationFieldSpec[] = [
  { key: 'account.id', label: 'Account', type: 'id', lookup: 'account' },
  { key: 'account.platform', label: 'Platform', type: 'enum', options: PLATFORMS },
];

const TASK_FIELDS: AutomationFieldSpec[] = [
  ...PROJECT_FIELDS,
  { key: 'task.status', label: 'Status', type: 'enum', options: TASK_STATUSES },
  { key: 'task.priority', label: 'Priority', type: 'enum', options: TASK_PRIORITIES },
  { key: 'task.assignee', label: 'Assignee', type: 'member' },
  { key: 'task.reviewer', label: 'Reviewer', type: 'member' },
  { key: 'task.tags', label: 'Tags', type: 'tags' },
  { key: 'task.dueAt', label: 'Deadline', type: 'datetime' },
  { key: 'task.hoursOverdue', label: 'Hours overdue', type: 'number', unit: 'hours' },
  { key: 'task.blocked', label: 'Blocked', type: 'boolean' },
];

const TASK_ACTIONS: AutomationActionType[] = ['create_task', 'create_task_from_template', 'assign_member', 'add_checklist_item', 'add_tag', 'set_field', 'notify', 'request_internal_approval', 'create_incident'];
const RECORD_ACTIONS: AutomationActionType[] = ['create_task', 'create_task_from_template', 'notify', 'request_internal_approval', 'create_incident'];
const ACCOUNT_ACTIONS: AutomationActionType[] = [...RECORD_ACTIONS, 'create_checkpoint'];

export interface DeadlineCandidate {
  entityId: string;
  /** Unique deadline key: entity + deadline revision + threshold (§19). */
  deadlineKey: string;
}

export interface TriggerDefinition {
  key: AutomationTriggerKey;
  label: string;
  description: string;
  kind: AutomationTriggerKind;
  entityType: AutomationRecordType | null;
  fields: AutomationFieldSpec[];
  actions: AutomationActionType[];
  /** Outbox event types delivering this trigger (aliases across modules). */
  eventTypes?: string[];
  thresholdLabel?: string;
  defaultThresholdHours?: number;
  /** Event → id of the triggering record. */
  entityFromEvent?: (db: DbOrTx, e: OutboxEventRecord) => Promise<string | null>;
  /** Deadline triggers: records due now for this rule (scope pre-filtered in SQL). */
  scan?: (db: DbOrTx, ws: string, scope: RuleScopeLike, thresholdHours: number, now: Date, limit: number) => Promise<DeadlineCandidate[]>;
}

const sameEntity = (type: string) => async (_db: DbOrTx, e: OutboxEventRecord) => (e.entityType === type ? e.entityId : null);

/** SQL restricting a project/account column pair to the rule scope. */
const scopeSql = (scope: RuleScopeLike, projectCol: SQL, accountCol?: SQL): SQL | undefined => {
  if (scope.scopeType === 'workspace' || !scope.scopeId) return undefined;
  if (scope.scopeType === 'project') return sql`${projectCol} = ${scope.scopeId}`;
  if (scope.scopeType === 'direction') return sql`${projectCol} IN (SELECT p.id FROM projects p WHERE p.direction_id = ${scope.scopeId})`;
  return accountCol ? sql`${accountCol} = ${scope.scopeId}` : sql`false`;
};

const OPEN_TASK_STATUSES = ['draft', 'backlog', 'ready', 'in_progress', 'in_review'] as const;

const taskScan =
  (mode: 'due_soon' | 'overdue') =>
  async (db: DbOrTx, ws: string, scope: RuleScopeLike, h: number, now: Date, limit: number): Promise<DeadlineCandidate[]> => {
    const soonEnd = new Date(now.getTime() + h * 3_600_000);
    const overdueBefore = new Date(now.getTime() - h * 3_600_000);
    const rows = await db
      .select({ id: tasks.id, rev: sql<number>`coalesce((SELECT max(${taskDueRevisions.deadlineRevision}) FROM ${taskDueRevisions} WHERE ${taskDueRevisions.taskId} = ${tasks.id}), 0)` })
      .from(tasks)
      .where(
        and(
          eq(tasks.workspaceId, ws),
          inArray(tasks.status, [...OPEN_TASK_STATUSES]),
          isNull(tasks.archivedAt),
          isNull(tasks.deletedAt),
          mode === 'due_soon' ? and(gt(tasks.dueAt, now), lte(tasks.dueAt, soonEnd)) : lte(tasks.dueAt, overdueBefore),
          scopeSql(scope, sql`${tasks.projectId}`, sql`${tasks.accountId}`),
        ),
      )
      .orderBy(tasks.dueAt, tasks.id)
      .limit(limit);
    return rows.map((r) => ({ entityId: r.id, deadlineKey: `task:${r.id}:${Number(r.rev)}:${mode}:${h}` }));
  };

const checkpointScan =
  (mode: 'due' | 'overdue') =>
  async (db: DbOrTx, ws: string, scope: RuleScopeLike, h: number, now: Date, limit: number): Promise<DeadlineCandidate[]> => {
    const rows = await db
      .select({ id: metricCheckpoints.id, expectedAt: metricCheckpoints.expectedAt, windowEnd: metricCheckpoints.windowEnd })
      .from(metricCheckpoints)
      .where(
        and(
          eq(metricCheckpoints.workspaceId, ws),
          eq(metricCheckpoints.state, 'pending'),
          mode === 'due'
            ? and(lte(metricCheckpoints.expectedAt, new Date(now.getTime() + h * 3_600_000)), gt(metricCheckpoints.windowEnd, now))
            : lte(metricCheckpoints.windowEnd, new Date(now.getTime() - h * 3_600_000)),
          scopeSql(scope, sql`${metricCheckpoints.projectId}`, sql`${metricCheckpoints.accountId}`),
        ),
      )
      .orderBy(metricCheckpoints.expectedAt, metricCheckpoints.id)
      .limit(limit);
    return rows.map((r) => ({ entityId: r.id, deadlineKey: `checkpoint:${r.id}:${(mode === 'due' ? r.expectedAt : r.windowEnd).toISOString()}:${mode}:${h}` }));
  };

const reportOverdueScan = async (db: DbOrTx, ws: string, scope: RuleScopeLike, h: number, now: Date, limit: number): Promise<DeadlineCandidate[]> => {
  const rows = await db
    .select({ id: shifts.id, actualEnd: shifts.actualEnd })
    .from(shifts)
    .where(
      and(
        eq(shifts.workspaceId, ws),
        eq(shifts.state, 'ended'),
        inArray(shifts.reportState, ['not_started', 'draft', 'changes_requested']),
        lte(shifts.actualEnd, new Date(now.getTime() - h * 3_600_000)),
        scopeSql(scope, sql`${shifts.projectId}`, sql`${shifts.primaryAccountId}`),
      ),
    )
    .orderBy(shifts.actualEnd, shifts.id)
    .limit(limit);
  return rows.map((r) => ({ entityId: r.id, deadlineKey: `shift:${r.id}:${r.actualEnd?.toISOString() ?? 'none'}:report_overdue:${h}` }));
};

const metricsStaleScan = async (db: DbOrTx, ws: string, scope: RuleScopeLike, h: number, now: Date, limit: number): Promise<DeadlineCandidate[]> => {
  const before = new Date(now.getTime() - h * 3_600_000);
  const last = sql<string | null>`(SELECT max(o.observed_at)::text FROM metric_observations o WHERE o.workspace_id = ${socialAccounts.workspaceId} AND o.account_id = ${socialAccounts.id} AND o.quality_state NOT IN ('superseded', 'rejected', 'pending_correction'))`;
  const rows = await db
    .select({ id: socialAccounts.id, last })
    .from(socialAccounts)
    .innerJoin(projects, eq(projects.id, socialAccounts.projectId))
    .where(
      and(
        eq(socialAccounts.workspaceId, ws),
        eq(socialAccounts.status, 'active'),
        isNull(socialAccounts.archivedAt),
        isNull(socialAccounts.deletedAt),
        // An account that was never observed is stale once it has existed longer than the threshold.
        or(sql`${last} IS NOT NULL AND ${last}::timestamptz <= ${before}`, sql`${last} IS NULL AND ${socialAccounts.createdAt} <= ${before}`),
        scopeSql(scope, sql`${socialAccounts.projectId}`, sql`${socialAccounts.id}`),
      ),
    )
    .orderBy(socialAccounts.id)
    .limit(limit);
  return rows.map((r) => ({ entityId: r.id, deadlineKey: `account:${r.id}:${r.last ?? 'never'}:metrics_stale:${h}` }));
};

export const TRIGGERS: TriggerDefinition[] = [
  {
    key: 'content.submitted',
    label: 'Content submitted for review',
    description: 'A content version was submitted for review.',
    kind: 'event',
    entityType: 'content_item',
    fields: CONTENT_FIELDS,
    actions: RECORD_ACTIONS,
    eventTypes: ['content.submitted', 'content_item.submitted', 'review.requested'],
    entityFromEvent: (db, e) => contentIdFromEvent(db, e.workspaceId ?? '', e.entityType, e.entityId),
  },
  {
    key: 'content.approved',
    label: 'Content approved',
    description: 'A reviewer approved a content version.',
    kind: 'event',
    entityType: 'content_item',
    fields: CONTENT_FIELDS,
    actions: RECORD_ACTIONS,
    eventTypes: ['content.approved', 'content_item.approved', 'review.approved'],
    entityFromEvent: (db, e) => contentIdFromEvent(db, e.workspaceId ?? '', e.entityType, e.entityId),
  },
  {
    key: 'content.changes_requested',
    label: 'Changes requested on content',
    description: 'A reviewer requested changes on a content version.',
    kind: 'event',
    entityType: 'content_item',
    fields: CONTENT_FIELDS,
    actions: RECORD_ACTIONS,
    eventTypes: ['content.changes_requested', 'content_item.changes_requested', 'review.changes_requested'],
    entityFromEvent: (db, e) => contentIdFromEvent(db, e.workspaceId ?? '', e.entityType, e.entityId),
  },
  {
    key: 'publication.published',
    label: 'Publication confirmed as published',
    description: 'A placement was marked Published with its actual time.',
    kind: 'event',
    entityType: 'publication',
    fields: [
      ...PROJECT_FIELDS,
      ...ACCOUNT_REF_FIELDS,
      { key: 'publication.format', label: 'Format', type: 'enum', options: CONTENT_FORMATS },
      { key: 'publication.status', label: 'Status', type: 'enum', options: PUBLICATION_STATUSES },
      { key: 'publication.owner', label: 'Publication owner', type: 'member' },
      { key: 'publication.tags', label: 'Tags', type: 'tags' },
      { key: 'publication.actualPublishedAt', label: 'Published at', type: 'datetime' },
    ],
    actions: ACCOUNT_ACTIONS,
    eventTypes: ['publication.published', 'publication.marked_published'],
    entityFromEvent: sameEntity('publication'),
  },
  {
    key: 'task.due_soon',
    label: 'Task due soon',
    description: 'An open task reaches the chosen number of hours before its deadline (once per deadline revision).',
    kind: 'deadline',
    entityType: 'task',
    fields: TASK_FIELDS,
    actions: TASK_ACTIONS,
    thresholdLabel: 'Hours before the deadline',
    defaultThresholdHours: 24,
    scan: taskScan('due_soon'),
  },
  {
    key: 'task.overdue',
    label: 'Task overdue',
    description: 'An open task passes its deadline by the chosen number of hours (once per deadline revision).',
    kind: 'deadline',
    entityType: 'task',
    fields: TASK_FIELDS,
    actions: TASK_ACTIONS,
    thresholdLabel: 'Hours after the deadline',
    defaultThresholdHours: 0,
    scan: taskScan('overdue'),
  },
  {
    key: 'checkpoint.due',
    label: 'Metrics checkpoint due',
    description: 'A pending metrics checkpoint reaches its expected time (window open).',
    kind: 'deadline',
    entityType: 'metric_checkpoint',
    fields: [
      ...PROJECT_FIELDS,
      ...ACCOUNT_REF_FIELDS,
      { key: 'checkpoint.key', label: 'Checkpoint', type: 'text' },
      { key: 'checkpoint.assignee', label: 'Assignee', type: 'member' },
      { key: 'checkpoint.expectedAt', label: 'Expected at', type: 'datetime' },
    ],
    actions: RECORD_ACTIONS,
    thresholdLabel: 'Hours before the expected time',
    defaultThresholdHours: 0,
    scan: checkpointScan('due'),
  },
  {
    key: 'checkpoint.overdue',
    label: 'Metrics checkpoint overdue',
    description: 'A metrics checkpoint window closed without usable data.',
    kind: 'deadline',
    entityType: 'metric_checkpoint',
    fields: [
      ...PROJECT_FIELDS,
      ...ACCOUNT_REF_FIELDS,
      { key: 'checkpoint.key', label: 'Checkpoint', type: 'text' },
      { key: 'checkpoint.state', label: 'State', type: 'enum', options: CHECKPOINT_STATES },
      { key: 'checkpoint.assignee', label: 'Assignee', type: 'member' },
      { key: 'checkpoint.expectedAt', label: 'Expected at', type: 'datetime' },
    ],
    actions: RECORD_ACTIONS,
    thresholdLabel: 'Hours after the window closed',
    defaultThresholdHours: 0,
    scan: checkpointScan('overdue'),
  },
  {
    key: 'shift.ended',
    label: 'Shift ended',
    description: 'An OFM shift was ended (the report may still be pending).',
    kind: 'event',
    entityType: 'shift',
    fields: [
      ...PROJECT_FIELDS,
      ...ACCOUNT_REF_FIELDS,
      { key: 'shift.member', label: 'Shift member', type: 'member' },
      { key: 'shift.state', label: 'State', type: 'enum', options: SHIFT_STATES },
      { key: 'shift.reportState', label: 'Report state', type: 'enum', options: SHIFT_REPORT_STATES },
      { key: 'shift.netHours', label: 'Net hours', type: 'number', unit: 'hours' },
    ],
    actions: RECORD_ACTIONS,
    eventTypes: ['shift.ended'],
    entityFromEvent: sameEntity('shift'),
  },
  {
    key: 'shift.report_overdue',
    label: 'Shift report overdue',
    description: 'A shift ended the chosen number of hours ago and its report is not submitted.',
    kind: 'deadline',
    entityType: 'shift',
    fields: [
      ...PROJECT_FIELDS,
      ...ACCOUNT_REF_FIELDS,
      { key: 'shift.member', label: 'Shift member', type: 'member' },
      { key: 'shift.reportState', label: 'Report state', type: 'enum', options: SHIFT_REPORT_STATES },
      { key: 'shift.actualEnd', label: 'Ended at', type: 'datetime' },
    ],
    actions: RECORD_ACTIONS,
    thresholdLabel: 'Hours after the shift ended',
    defaultThresholdHours: 12,
    scan: reportOverdueScan,
  },
  {
    key: 'handover.unacknowledged',
    label: 'Handover not acknowledged',
    description: 'A submitted handover is still not acknowledged by its recipient.',
    kind: 'event',
    entityType: 'handover',
    fields: [
      ...PROJECT_FIELDS,
      ...ACCOUNT_REF_FIELDS,
      { key: 'handover.state', label: 'State', type: 'enum', options: HANDOVER_STATES },
      { key: 'handover.recipient', label: 'Recipient', type: 'member' },
      { key: 'handover.submittedAt', label: 'Submitted at', type: 'datetime' },
      { key: 'handover.noOpenItems', label: 'No open items', type: 'boolean' },
    ],
    actions: RECORD_ACTIONS,
    eventTypes: ['handover.unacknowledged'],
    entityFromEvent: sameEntity('handover'),
  },
  {
    key: 'budget.threshold_crossed',
    label: 'Budget threshold crossed',
    description: 'Spending and open commitments crossed a budget alert threshold. No finance record is changed by rules.',
    kind: 'event',
    entityType: 'budget',
    fields: [
      ...PROJECT_FIELDS,
      { key: 'budget.scopeType', label: 'Budget scope', type: 'enum', options: ['workspace', 'direction', 'project', 'campaign'] },
      { key: 'budget.threshold', label: 'Threshold crossed', type: 'number', unit: '%' },
      { key: 'budget.owner', label: 'Budget owner', type: 'member' },
    ],
    actions: ['notify', 'create_task', 'request_internal_approval', 'create_incident'],
    eventTypes: ['budget.threshold_crossed'],
    entityFromEvent: sameEntity('budget'),
  },
  {
    key: 'account.metrics_stale',
    label: 'Account metrics stale',
    description: 'No usable metrics observation was recorded for an active account for the chosen number of hours.',
    kind: 'deadline',
    entityType: 'account',
    fields: [
      ...PROJECT_FIELDS,
      { key: 'account.id', label: 'Account', type: 'id', lookup: 'account' },
      { key: 'account.platform', label: 'Platform', type: 'enum', options: PLATFORMS },
      { key: 'account.status', label: 'Account status', type: 'enum', options: ACCOUNT_STATUSES },
      { key: 'account.owner', label: 'Account owner', type: 'member' },
      { key: 'account.daysSinceObservation', label: 'Days since last observation', type: 'number', unit: 'days' },
    ],
    actions: ACCOUNT_ACTIONS,
    thresholdLabel: 'Hours without observations',
    defaultThresholdHours: 168,
    scan: metricsStaleScan,
  },
  {
    key: 'deal.stage_changed',
    label: 'Deal stage changed',
    description: 'A partnership deal moved to another stage.',
    kind: 'event',
    entityType: 'deal',
    fields: [
      ...PROJECT_FIELDS,
      { key: 'deal.stage', label: 'New stage', type: 'enum', options: DEAL_STAGES },
      { key: 'deal.fromStage', label: 'Previous stage', type: 'enum', options: DEAL_STAGES },
      { key: 'deal.owner', label: 'Deal owner', type: 'member' },
    ],
    actions: RECORD_ACTIONS,
    eventTypes: ['deal.stage_changed'],
    entityFromEvent: sameEntity('deal'),
  },
  ...(['daily', 'weekly', 'monthly'] as const).map(
    (c): TriggerDefinition => ({
      key: `schedule.${c}`,
      label: `Scheduled ${c}`,
      description: `Runs ${c} at the chosen local time of the workspace.`,
      kind: 'schedule',
      entityType: null,
      fields: [],
      actions: ['create_task', 'create_task_from_template', 'notify', 'create_incident'],
    }),
  ),
];

export const triggerDef = (key: string): TriggerDefinition | undefined => TRIGGERS.find((t) => t.key === key);

/** Trigger keys delivered by an outbox event type. */
export const triggersForEvent = (eventType: string): TriggerDefinition[] => TRIGGERS.filter((t) => t.eventTypes?.includes(eventType));

export const ALL_TRIGGER_EVENT_TYPES = [...new Set(TRIGGERS.flatMap((t) => t.eventTypes ?? []))];

export interface ActionDefinition {
  type: AutomationActionType;
  label: string;
  description: string;
  /** Counts toward the per-root budget of created tasks/notifications. */
  createsEffects: boolean;
}

export const ACTIONS: ActionDefinition[] = [
  { type: 'create_task', label: 'Create task', description: 'Creates a task in the record’s project (or a chosen project) with an optional assignee, deadline, checklist and tags.', createsEffects: true },
  { type: 'create_task_from_template', label: 'Create tasks from template', description: 'Applies a published task template once per triggering event.', createsEffects: true },
  { type: 'assign_member', label: 'Assign member', description: 'Assigns the triggering task to an eligible member (who can access its project).', createsEffects: false },
  { type: 'add_checklist_item', label: 'Add checklist item', description: 'Adds a checklist item to the triggering task.', createsEffects: false },
  { type: 'add_tag', label: 'Add tag', description: 'Adds a tag to the triggering task.', createsEffects: false },
  { type: 'set_field', label: 'Set field', description: 'Sets an allowed field (priority) on the triggering task.', createsEffects: false },
  { type: 'create_checkpoint', label: 'Create metrics checkpoint', description: 'Creates a metrics checkpoint (measurement reminder) for the account or publication. It never records values.', createsEffects: true },
  { type: 'notify', label: 'Send in-app notification', description: 'Notifies members who can open the record. Inbox records are created immediately; email copies respect quiet hours.', createsEffects: true },
  { type: 'request_internal_approval', label: 'Request internal approval', description: 'Creates an approval task for a member and notifies them. Nothing is approved automatically.', createsEffects: true },
  { type: 'create_incident', label: 'Create incident', description: 'Logs an operational incident owned by the rule owner.', createsEffects: false },
];

export const actionDef = (type: string) => ACTIONS.find((a) => a.type === type);

void AUTOMATION_ACTION_TYPES;
void AUTOMATION_TRIGGER_KIND;
