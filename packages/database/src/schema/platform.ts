import { bigserial, index, pgTable, primaryKey, uniqueIndex } from 'drizzle-orm/pg-core';
import {
  AUTOMATION_RUN_STATES,
  AUTOMATION_STATES,
  CHANGE_SOURCES,
  CUSTOM_FIELD_TYPES,
  DUPLICATE_POLICIES,
  EXPORT_FORMATS,
  EXPORT_STATES,
  IMPORT_DATASETS,
  IMPORT_STATES,
  INCIDENT_KINDS,
  INCIDENT_SEVERITIES,
  INCIDENT_STATES,
  JOB_POOLS,
  JOB_STATES,
  NOTIFICATION_CHANNELS,
  TEMPLATE_KINDS,
  TEMPLATE_VERSION_STATES,
} from '@castlane/domain';
import {
  archivable,
  bigint,
  boolean,
  enumCheck,
  enumText,
  integer,
  json,
  sql,
  tenantBase,
  text,
  tfk,
  ts,
  tsvector,
  uuid,
} from '../columns';
import { memberships, tenantUnique } from './identity';

/** Append-only audit log (UPDATE/DELETE blocked by trigger for the application role). */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id'),
    actorUserId: uuid('actor_user_id'),
    actorMembershipId: uuid('actor_membership_id'),
    actorKind: text('actor_kind', { enum: ['user', 'system', 'automation', 'import', 'anonymous'] }).notNull(),
    actorDisplay: text('actor_display'),
    action: text('action').notNull(),
    entityType: text('entity_type'),
    entityId: uuid('entity_id'),
    projectId: uuid('project_id'),
    occurredAt: ts('occurred_at').notNull().defaultNow(),
    requestId: text('request_id'),
    source: enumText('source', CHANGE_SOURCES).notNull().default('ui'),
    reason: text('reason'),
    /** Field diff with secrets removed and sensitive text masked. */
    diff: json<Record<string, { from?: unknown; to?: unknown }>>('diff'),
    metadata: json<Record<string, unknown>>('metadata'),
    sensitivity: text('sensitivity', { enum: ['normal', 'finance', 'ofm', 'security'] }).notNull().default('normal'),
    ipHash: text('ip_hash'),
  },
  (t) => [
    index('audit_events_ws_actor_idx').on(t.workspaceId, t.actorMembershipId, t.occurredAt),
    index('audit_events_ws_entity_idx').on(t.workspaceId, t.entityType, t.entityId, t.occurredAt),
    index('audit_events_ws_time_idx').on(t.workspaceId, t.occurredAt),
  ],
);

/** Transactional outbox: written in the same transaction as the domain change. */
export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: uuid('id').primaryKey(),
    seq: bigserial('seq', { mode: 'number' }).notNull(),
    workspaceId: uuid('workspace_id'),
    eventType: text('event_type').notNull(),
    entityType: text('entity_type'),
    entityId: uuid('entity_id'),
    payload: json<Record<string, unknown>>('payload').notNull().default({}),
    actorMembershipId: uuid('actor_membership_id'),
    occurredAt: ts('occurred_at').notNull().defaultNow(),
    rootEventId: uuid('root_event_id').notNull(),
    parentEventId: uuid('parent_event_id'),
    depth: integer('depth').notNull().default(0),
    dispatchedAt: ts('dispatched_at'),
    dispatchAttempts: integer('dispatch_attempts').notNull().default(0),
    lastError: text('last_error'),
  },
  (t) => [index('outbox_events_pending_idx').on(t.dispatchedAt, t.seq), uniqueIndex('outbox_events_seq_uq').on(t.seq)],
);

/** Safe change feed for SSE: ids and revisions only, never field values. */
export const eventStream = pgTable(
  'event_stream',
  {
    seq: bigserial('seq', { mode: 'number' }).primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    kind: text('kind', { enum: ['entity_changed', 'inbox', 'job_progress', 'access_changed'] }).notNull(),
    entityType: text('entity_type'),
    entityId: uuid('entity_id'),
    revision: integer('revision'),
    recipientMembershipId: uuid('recipient_membership_id'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('event_stream_ws_seq_idx').on(t.workspaceId, t.seq)],
);

export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id'),
    type: text('type').notNull(),
    pool: enumText('pool', JOB_POOLS).notNull().default('light'),
    payload: json<Record<string, unknown>>('payload').notNull().default({}),
    payloadVersion: integer('payload_version').notNull().default(1),
    state: enumText('state', JOB_STATES).notNull().default('queued'),
    priority: integer('priority').notNull().default(0),
    runAt: ts('run_at').notNull().defaultNow(),
    attempts: integer('attempts').notNull().default(0),
    maxRetries: integer('max_retries').notNull().default(5),
    leaseOwner: text('lease_owner'),
    leaseExpiresAt: ts('lease_expires_at'),
    heartbeatAt: ts('heartbeat_at'),
    progress: integer('progress').notNull().default(0),
    progressNote: text('progress_note'),
    lastErrorCode: text('last_error_code'),
    lastErrorMessage: text('last_error_message'),
    result: json<Record<string, unknown>>('result'),
    idempotencyKey: text('idempotency_key'),
    causation: json<{ rootEventId?: string; parentEventId?: string; depth?: number }>('causation'),
    requestedBy: uuid('requested_by'),
    cancelRequested: boolean('cancel_requested').notNull().default(false),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    finishedAt: ts('finished_at'),
  },
  (t) => [
    index('jobs_claim_idx').on(t.pool, t.state, t.runAt, t.priority),
    uniqueIndex('jobs_idempotency_uq').on(t.idempotencyKey).where(sql`idempotency_key IS NOT NULL`),
    enumCheck('jobs_state_ck', 'state', JOB_STATES),
  ],
);

export const idempotencyRecords = pgTable(
  'idempotency_records',
  {
    id: uuid('id').primaryKey(),
    /** workspace:actor:route:key */
    scopeKey: text('scope_key').notNull(),
    workspaceId: uuid('workspace_id'),
    actorUserId: uuid('actor_user_id'),
    routeKey: text('route_key').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    requestHash: text('request_hash').notNull(),
    state: text('state', { enum: ['pending', 'completed'] }).notNull().default('pending'),
    responseStatus: integer('response_status'),
    responseBody: json<unknown>('response_body'),
    entityType: text('entity_type'),
    entityId: uuid('entity_id'),
    createdAt: ts('created_at').notNull().defaultNow(),
    completedAt: ts('completed_at'),
    expiresAt: ts('expires_at').notNull(),
  },
  (t) => [uniqueIndex('idempotency_records_scope_uq').on(t.scopeKey), index('idempotency_records_expiry_idx').on(t.expiresAt)],
);

export const notifications = pgTable(
  'notifications',
  {
    ...tenantBase(),
    recipientMembershipId: uuid('recipient_membership_id').notNull(),
    eventType: text('event_type').notNull(),
    /** Dedupe key: event + recipient + channel is unique. */
    eventKey: text('event_key').notNull(),
    channel: enumText('channel', NOTIFICATION_CHANNELS).notNull().default('in_app'),
    title: text('title').notNull(),
    excerpt: text('excerpt'),
    entityType: text('entity_type'),
    entityId: uuid('entity_id'),
    projectId: uuid('project_id'),
    actorMembershipId: uuid('actor_membership_id'),
    sensitive: boolean('sensitive').notNull().default(false),
    security: boolean('security').notNull().default(false),
    readAt: ts('read_at'),
    archivedAt: ts('archived_at'),
    deliveryState: text('delivery_state', { enum: ['pending', 'delivered', 'deferred', 'failed', 'suppressed'] })
      .notNull()
      .default('delivered'),
    deliverAfter: ts('deliver_after'),
    deliveredAt: ts('delivered_at'),
  },
  (t) => [
    tenantUnique('notifications', t),
    tfk('notifications_recipient_fk', t.workspaceId, t.recipientMembershipId, memberships),
    uniqueIndex('notifications_dedupe_uq').on(t.workspaceId, t.eventKey, t.recipientMembershipId, t.channel),
    index('notifications_inbox_idx').on(t.workspaceId, t.recipientMembershipId, t.archivedAt, t.readAt, t.createdAt),
  ],
);

export const mailMessages = pgTable(
  'mail_messages',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id'),
    toAddress: text('to_address').notNull(),
    subject: text('subject').notNull(),
    textBody: text('text_body').notNull(),
    htmlBody: text('html_body'),
    template: text('template').notNull(),
    status: text('status', { enum: ['queued', 'sent', 'failed'] }).notNull().default('queued'),
    transport: text('transport', { enum: ['smtp', 'dev_sink'] }),
    attempts: integer('attempts').notNull().default(0),
    error: text('error'),
    providerMessageId: text('provider_message_id'),
    relatedEntityType: text('related_entity_type'),
    relatedEntityId: uuid('related_entity_id'),
    createdAt: ts('created_at').notNull().defaultNow(),
    sentAt: ts('sent_at'),
  },
  (t) => [index('mail_messages_status_idx').on(t.status, t.createdAt)],
);

export const savedViews = pgTable(
  'saved_views',
  {
    ...tenantBase(),
    ownerMembershipId: uuid('owner_membership_id').notNull(),
    module: text('module').notNull(),
    name: text('name').notNull(),
    filterAst: json<unknown>('filter_ast').notNull(),
    sort: json<{ key: string; direction: 'asc' | 'desc' }[]>('sort').notNull().default([]),
    columns: json<string[]>('columns').notNull().default([]),
    shared: boolean('shared').notNull().default(false),
  },
  (t) => [tenantUnique('saved_views', t), tfk('saved_views_owner_fk', t.workspaceId, t.ownerMembershipId, memberships)],
);

export const bulkPreviews = pgTable(
  'bulk_previews',
  {
    ...tenantBase(),
    actorMembershipId: uuid('actor_membership_id').notNull(),
    action: text('action').notNull(),
    params: json<Record<string, unknown>>('params').notNull().default({}),
    targets: json<{ type: string; id: string; rowVersion: number; status: 'ok' | 'forbidden' | 'conflict' }[]>('targets').notNull(),
    accessRevision: integer('access_revision').notNull(),
    summary: json<Record<string, unknown>>('summary').notNull().default({}),
    expiresAt: ts('expires_at').notNull(),
    consumedAt: ts('consumed_at'),
  },
  (t) => [tenantUnique('bulk_previews', t)],
);

export const tags = pgTable(
  'tags',
  {
    ...tenantBase(),
    name: text('name').notNull(),
    nameKey: text('name_key').notNull(),
  },
  (t) => [tenantUnique('tags', t), uniqueIndex('tags_name_uq').on(t.workspaceId, t.nameKey)],
);

/** Manually entered identifiers of external systems (e.g. a future Dramora id). Empty by default. */
export const externalReferences = pgTable(
  'external_references',
  {
    ...tenantBase(),
    namespace: text('namespace').notNull(),
    externalId: text('external_id').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
  },
  (t) => [tenantUnique('external_references', t), uniqueIndex('external_references_uq').on(t.workspaceId, t.namespace, t.externalId)],
);

export interface CustomFieldOption {
  key: string;
  label: string;
  archivedAt?: string;
}

export const customFieldDefinitions = pgTable(
  'custom_field_definitions',
  {
    ...tenantBase(),
    ...archivable(),
    entityType: text('entity_type').notNull(),
    key: text('key').notNull(),
    name: text('name').notNull(),
    type: enumText('type', CUSTOM_FIELD_TYPES).notNull(),
    scopeProjectId: uuid('scope_project_id'),
    options: json<CustomFieldOption[]>('options').notNull().default([]),
    requiredAtStage: text('required_at_stage'),
    unit: text('unit'),
    precision: integer('precision'),
    replacedById: uuid('replaced_by_id'),
    usedAt: ts('used_at'),
  },
  (t) => [
    tenantUnique('custom_field_definitions', t),
    uniqueIndex('custom_field_definitions_key_uq').on(t.workspaceId, t.entityType, t.key).where(sql`archived_at IS NULL`),
  ],
);

export const customFieldValues = pgTable(
  'custom_field_values',
  {
    ...tenantBase(),
    definitionId: uuid('definition_id').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    value: json<unknown>('value'),
    needsCompletion: boolean('needs_completion').notNull().default(false),
  },
  (t) => [
    tenantUnique('custom_field_values', t),
    tfk('custom_field_values_def_fk', t.workspaceId, t.definitionId, customFieldDefinitions),
    uniqueIndex('custom_field_values_uq').on(t.definitionId, t.entityId),
    index('custom_field_values_entity_idx').on(t.workspaceId, t.entityType, t.entityId),
  ],
);

export const templates = pgTable(
  'templates',
  {
    ...tenantBase(),
    ...archivable(),
    kind: enumText('kind', TEMPLATE_KINDS).notNull(),
    name: text('name').notNull(),
    description: text('description'),
    publishedVersionId: uuid('published_version_id'),
    draftVersionId: uuid('draft_version_id'),
    disabledAt: ts('disabled_at'),
  },
  (t) => [tenantUnique('templates', t)],
);

export interface TemplateTaskNode {
  key: string;
  title: string;
  description?: string;
  responsibility?: string;
  defaultRoleKey?: string;
  offsetDaysFromStart?: number;
  durationDays?: number;
  estimateMinutes?: number;
  dependsOn?: string[];
  checklist?: { label: string; mandatory: boolean }[];
  requiresReview?: boolean;
}
export interface TemplateConfig {
  format?: string;
  deliverableSlots?: { slot: string; required: boolean }[];
  checklist?: { label: string; mandatory: boolean }[];
  tasks?: TemplateTaskNode[];
  reviewerRoleKey?: string;
  rubric?: { key: string; label: string; weight: string }[];
}

export const templateVersions = pgTable(
  'template_versions',
  {
    ...tenantBase(),
    templateId: uuid('template_id').notNull(),
    versionNo: integer('version_no').notNull(),
    state: enumText('state', TEMPLATE_VERSION_STATES).notNull().default('draft'),
    config: json<TemplateConfig>('config').notNull(),
    publishedAt: ts('published_at'),
  },
  (t) => [
    tenantUnique('template_versions', t),
    tfk('template_versions_template_fk', t.workspaceId, t.templateId, templates),
    uniqueIndex('template_versions_no_uq').on(t.templateId, t.versionNo),
  ],
);

export const templateApplications = pgTable(
  'template_applications',
  {
    ...tenantBase(),
    templateVersionId: uuid('template_version_id').notNull(),
    targetType: text('target_type').notNull(),
    targetId: uuid('target_id').notNull(),
    applicationKey: text('application_key').notNull(),
    createdTaskIds: uuid('created_task_ids').array().notNull().default(sql`'{}'::uuid[]`),
    result: json<Record<string, unknown>>('result').notNull().default({}),
    appliedAt: ts('applied_at').notNull(),
  },
  (t) => [
    tenantUnique('template_applications', t),
    tfk('template_applications_version_fk', t.workspaceId, t.templateVersionId, templateVersions),
    uniqueIndex('template_applications_key_uq').on(t.workspaceId, t.applicationKey),
  ],
);

export interface AutomationTrigger {
  event: string;
  schedule?: { cadence: 'daily' | 'weekly' | 'monthly'; localTime: string; weekday?: number; monthDay?: number };
}
export interface AutomationCondition {
  field: string;
  operator: 'equals' | 'not_equals' | 'in' | 'gte' | 'lte' | 'elapsed_gte';
  value: unknown;
}
export interface AutomationAction {
  type:
    | 'create_task_from_template'
    | 'assign_member'
    | 'create_checkpoint'
    | 'notify'
    | 'request_internal_approval'
    | 'create_incident'
    | 'generate_report';
  params: Record<string, unknown>;
}

export const automationRules = pgTable(
  'automation_rules',
  {
    ...tenantBase(),
    ...archivable(),
    name: text('name').notNull(),
    ownerMembershipId: uuid('owner_membership_id'),
    state: enumText('state', AUTOMATION_STATES).notNull().default('draft'),
    currentVersionId: uuid('current_version_id'),
    enabledVersionId: uuid('enabled_version_id'),
    scopeType: text('scope_type', { enum: ['workspace', 'direction', 'project', 'account'] }).notNull().default('workspace'),
    scopeId: uuid('scope_id'),
    lastRunAt: ts('last_run_at'),
    failureCount: integer('failure_count').notNull().default(0),
    pausedReason: text('paused_reason'),
    nextScheduledAt: ts('next_scheduled_at'),
  },
  (t) => [tenantUnique('automation_rules', t), enumCheck('automation_rules_state_ck', 'state', AUTOMATION_STATES)],
);

export const automationRuleVersions = pgTable(
  'automation_rule_versions',
  {
    ...tenantBase(),
    ruleId: uuid('rule_id').notNull(),
    versionNo: integer('version_no').notNull(),
    trigger: json<AutomationTrigger>('trigger').notNull(),
    conditions: json<AutomationCondition[]>('conditions').notNull().default([]),
    actions: json<AutomationAction[]>('actions').notNull(),
    quietHoursPolicy: text('quiet_hours_policy', { enum: ['respect', 'ignore_for_inbox'] }).notNull().default('respect'),
  },
  (t) => [
    tenantUnique('automation_rule_versions', t),
    tfk('arv_rule_fk', t.workspaceId, t.ruleId, automationRules),
    uniqueIndex('arv_no_uq').on(t.ruleId, t.versionNo),
  ],
);

export const automationRuns = pgTable(
  'automation_runs',
  {
    ...tenantBase(),
    ruleId: uuid('rule_id').notNull(),
    ruleVersionId: uuid('rule_version_id').notNull(),
    eventId: uuid('event_id').notNull(),
    rootEventId: uuid('root_event_id').notNull(),
    depth: integer('depth').notNull().default(0),
    state: enumText('state', AUTOMATION_RUN_STATES).notNull().default('pending'),
    operationKey: text('operation_key').notNull(),
    startedAt: ts('started_at'),
    finishedAt: ts('finished_at'),
    actionResults: json<{ index: number; type: string; ok: boolean; entityType?: string; entityId?: string; error?: string }[]>(
      'action_results',
    )
      .notNull()
      .default([]),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    attempts: integer('attempts').notNull().default(0),
  },
  (t) => [
    tenantUnique('automation_runs', t),
    tfk('automation_runs_rule_fk', t.workspaceId, t.ruleId, automationRules),
    uniqueIndex('automation_runs_operation_uq').on(t.workspaceId, t.operationKey),
    index('automation_runs_rule_idx').on(t.workspaceId, t.ruleId, t.createdAt),
  ],
);

/** Idempotent action effects: event + rule version + action index can only produce one effect. */
export const automationActionEffects = pgTable(
  'automation_action_effects',
  {
    workspaceId: uuid('workspace_id').notNull(),
    effectKey: text('effect_key').notNull(),
    runId: uuid('run_id').notNull(),
    entityType: text('entity_type'),
    entityId: uuid('entity_id'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ name: 'automation_action_effects_pk', columns: [t.workspaceId, t.effectKey] })],
);

export interface ImportOptions {
  timezone: string;
  currency?: string;
  dateFormat: 'iso' | 'dd.mm.yyyy' | 'mm/dd/yyyy' | 'dd/mm/yyyy';
  decimalSeparator: '.' | ',';
  delimiter?: ',' | ';';
  duplicatePolicy: (typeof DUPLICATE_POLICIES)[number];
  acceptCachedFormulaValues?: boolean;
}

export const importJobs = pgTable(
  'import_jobs',
  {
    ...tenantBase(),
    dataset: enumText('dataset', IMPORT_DATASETS).notNull(),
    state: enumText('state', IMPORT_STATES).notNull().default('uploaded'),
    fileName: text('file_name').notNull(),
    fileKind: text('file_kind', { enum: ['csv', 'xlsx'] }).notNull(),
    fileHash: text('file_hash').notNull(),
    fileStorageKey: text('file_storage_key').notNull(),
    byteSize: integer('byte_size').notNull(),
    rowCount: integer('row_count'),
    headers: json<string[]>('headers').notNull().default([]),
    templateVersion: integer('template_version').notNull().default(1),
    mapping: json<Record<string, string | null>>('mapping').notNull().default({}),
    options: json<ImportOptions>('options'),
    validationReport: json<Record<string, unknown>>('validation_report'),
    validationToken: text('validation_token'),
    validatedAt: ts('validated_at'),
    warningsAccepted: boolean('warnings_accepted').notNull().default(false),
    committedAt: ts('committed_at'),
    result: json<Record<string, unknown>>('result'),
    errorMessage: text('error_message'),
    requestedByMembershipId: uuid('requested_by_membership_id').notNull(),
    undoneAt: ts('undone_at'),
  },
  (t) => [tenantUnique('import_jobs', t), enumCheck('import_jobs_state_ck', 'state', IMPORT_STATES)],
);

export const importRows = pgTable(
  'import_rows',
  {
    ...tenantBase(),
    jobId: uuid('job_id').notNull(),
    rowNo: integer('row_no').notNull(),
    raw: json<Record<string, string>>('raw').notNull(),
    mapped: json<Record<string, unknown>>('mapped'),
    status: text('status', { enum: ['pending', 'valid', 'warning', 'error', 'skipped'] }).notNull().default('pending'),
    errors: json<{ field: string; code: string; message: string }[]>('errors').notNull().default([]),
    warnings: json<{ field: string; code: string; message: string }[]>('warnings').notNull().default([]),
    action: text('action', { enum: ['create', 'update', 'skip'] }),
    targetId: uuid('target_id'),
    targetRowVersion: integer('target_row_version'),
    createdEntityId: uuid('created_entity_id'),
  },
  (t) => [
    tenantUnique('import_rows', t),
    tfk('import_rows_job_fk', t.workspaceId, t.jobId, importJobs),
    uniqueIndex('import_rows_no_uq').on(t.jobId, t.rowNo),
  ],
);

export const exportJobs = pgTable(
  'export_jobs',
  {
    ...tenantBase(),
    requestedByMembershipId: uuid('requested_by_membership_id').notNull(),
    dataset: text('dataset').notNull(),
    format: enumText('format', EXPORT_FORMATS).notNull(),
    fields: text('fields').array().notNull().default(sql`'{}'::text[]`),
    filters: json<Record<string, unknown>>('filters').notNull().default({}),
    classification: text('classification', { enum: ['normal', 'private', 'finance', 'ofm'] }).notNull().default('normal'),
    state: enumText('state', EXPORT_STATES).notNull().default('queued'),
    sourceBoundAt: ts('source_bound_at').notNull(),
    storageKey: text('storage_key'),
    fileName: text('file_name'),
    byteSize: bigint('byte_size', { mode: 'number' }),
    progress: integer('progress').notNull().default(0),
    expiresAt: ts('expires_at'),
    errorMessage: text('error_message'),
    completedAt: ts('completed_at'),
    jobId: uuid('job_id'),
  },
  (t) => [tenantUnique('export_jobs', t), index('export_jobs_requester_idx').on(t.workspaceId, t.requestedByMembershipId, t.state)],
);

export const incidents = pgTable(
  'incidents',
  {
    ...tenantBase(),
    kind: enumText('kind', INCIDENT_KINDS).notNull(),
    severity: enumText('severity', INCIDENT_SEVERITIES).notNull(),
    title: text('title').notNull(),
    description: text('description'),
    accountId: uuid('account_id'),
    projectId: uuid('project_id'),
    ownerMembershipId: uuid('owner_membership_id'),
    state: enumText('state', INCIDENT_STATES).notNull().default('open'),
    resolution: text('resolution'),
    resolvedAt: ts('resolved_at'),
    evidenceAssetIds: uuid('evidence_asset_ids').array().notNull().default(sql`'{}'::uuid[]`),
    jobId: uuid('job_id'),
    alertKey: text('alert_key'),
    acknowledgedAt: ts('acknowledged_at'),
  },
  (t) => [
    tenantUnique('incidents', t),
    uniqueIndex('incidents_alert_open_uq').on(t.workspaceId, t.alertKey).where(sql`alert_key IS NOT NULL AND state <> 'resolved'`),
  ],
);

/** Replayed after a backup restore so erased/purged data stays erased. */
export const deletionTombstones = pgTable(
  'deletion_tombstones',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    action: text('action', { enum: ['purge', 'erase', 'revoke'] }).notNull(),
    details: json<Record<string, unknown>>('details').notNull().default({}),
    executedAt: ts('executed_at').notNull().defaultNow(),
  },
  (t) => [index('deletion_tombstones_time_idx').on(t.executedAt)],
);

export const backupRuns = pgTable('backup_runs', {
  id: uuid('id').primaryKey(),
  kind: text('kind', { enum: ['backup', 'restore_drill'] }).notNull(),
  status: text('status', { enum: ['running', 'succeeded', 'failed'] }).notNull(),
  startedAt: ts('started_at').notNull(),
  finishedAt: ts('finished_at'),
  recoveredTimestamp: ts('recovered_timestamp'),
  durationSeconds: integer('duration_seconds'),
  details: json<Record<string, unknown>>('details').notNull().default({}),
  reportedBy: text('reported_by').notNull(),
});

/** Permission-aware search index; maintained transactionally by use cases. */
export const searchDocuments = pgTable(
  'search_documents',
  {
    workspaceId: uuid('workspace_id').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    tsv: tsvector('tsv')
      .notNull()
      .generatedAlwaysAs(sql`to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(body, ''))`),
    projectId: uuid('project_id'),
    accountId: uuid('account_id'),
    directionId: uuid('direction_id'),
    /** Permission required to see this document at all (e.g. tasks.read). */
    permission: text('permission').notNull(),
    ownerMembershipId: uuid('owner_membership_id'),
    assigneeMembershipIds: uuid('assignee_membership_ids').array().notNull().default(sql`'{}'::uuid[]`),
    restricted: boolean('restricted').notNull().default(false),
    archived: boolean('archived').notNull().default(false),
    status: text('status'),
    thumbnailAssetId: uuid('thumbnail_asset_id'),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'search_documents_pk', columns: [t.workspaceId, t.entityType, t.entityId] }),
    index('search_documents_tsv_idx').using('gin', t.tsv),
    index('search_documents_title_trgm_idx').using('gin', sql`${t.title} gin_trgm_ops`),
  ],
);
