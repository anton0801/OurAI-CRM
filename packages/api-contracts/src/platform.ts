import { z } from 'zod';
import { CHANGE_SOURCES, INCIDENT_KINDS, INCIDENT_SEVERITIES, INCIDENT_STATES, JOB_POOLS, JOB_STATES, LIMITS } from '@castlane/domain';
import { endpoint } from './core';
import { boolQuery, csv, impactItem, isoDateTime, memberRef, okResponse, page, pageQuery, reason, shortName, uuid, wsId } from './common';
import { searchResult } from './shell';
import { exportEndpoints, importEndpoints } from './platform-data';
import { customFieldEndpoints, templateEndpoints } from './platform-config';

export * from './platform-data';
export * from './platform-config';

// ——— Inbox (S10, section 20) ———

export const NOTIFICATION_VIEWS = ['unread', 'all', 'archived'] as const;

export const notificationItem = z.object({
  id: uuid,
  eventType: z.string(),
  title: z.string(),
  /** Removed (null) when the recipient can no longer read the object. */
  excerpt: z.string().nullable(),
  entityType: z.string().nullable(),
  entityId: uuid.nullable(),
  projectId: uuid.nullable(),
  href: z.string().nullable(),
  actor: memberRef.nullable(),
  thumbnailUrl: z.string().nullable(),
  /** The recipient's access to the object changed since the notification was created. */
  accessRevoked: z.boolean(),
  security: z.boolean(),
  sensitive: z.boolean(),
  readAt: isoDateTime.nullable(),
  archivedAt: isoDateTime.nullable(),
  createdAt: isoDateTime,
  rowVersion: z.number().int(),
});
export type NotificationItem = z.infer<typeof notificationItem>;

export const inboxFilter = z.object({
  view: z.enum(NOTIFICATION_VIEWS).default('unread'),
  eventType: z.string().max(80).optional(),
  projectId: uuid.optional(),
});
export type InboxFilter = z.infer<typeof inboxFilter>;

export const inboxEndpoints = {
  list: endpoint({
    id: 'notifications.list',
    method: 'GET',
    path: '/workspaces/{workspaceId}/notifications',
    summary: 'Own in-app notifications (Unread / All / Archived); excerpts are re-checked against current access.',
    tags: ['Notifications'],
    auth: 'workspace',
    params: wsId({}),
    query: pageQuery.extend(inboxFilter.shape),
    response: page(notificationItem),
  }),
  facets: endpoint({
    id: 'notifications.facets',
    method: 'GET',
    path: '/workspaces/{workspaceId}/notifications/facets',
    summary: 'Event types and readable projects present in the member’s own notifications (filter options).',
    tags: ['Notifications'],
    auth: 'workspace',
    params: wsId({}),
    response: z.object({
      eventTypes: z.array(z.object({ eventType: z.string(), total: z.number().int(), unread: z.number().int() })),
      projects: z.array(z.object({ id: uuid, name: z.string() })),
    }),
  }),
  setRead: endpoint({
    id: 'notifications.setRead',
    method: 'POST',
    path: '/workspaces/{workspaceId}/notifications/{notificationId}/read',
    summary: 'Mark one own notification read or unread. Reading never completes the underlying work.',
    tags: ['Notifications'],
    auth: 'workspace',
    idempotent: true,
    params: wsId({ notificationId: uuid }),
    body: z.object({ read: z.boolean().default(true) }),
    response: notificationItem,
  }),
  setArchived: endpoint({
    id: 'notifications.setArchived',
    method: 'POST',
    path: '/workspaces/{workspaceId}/notifications/{notificationId}/archive',
    summary: 'Archive (or restore) one own notification.',
    tags: ['Notifications'],
    auth: 'workspace',
    idempotent: true,
    params: wsId({ notificationId: uuid }),
    body: z.object({ archived: z.boolean().default(true) }),
    response: notificationItem,
  }),
  markReadPreview: endpoint({
    id: 'notifications.markReadPreview',
    method: 'POST',
    path: '/workspaces/{workspaceId}/notifications/mark-read-preview',
    summary: 'Count own unread notifications matching the current filter (shown before Mark All Read).',
    tags: ['Notifications'],
    auth: 'workspace',
    params: wsId({}),
    body: z.object({ eventType: z.string().max(80).optional(), projectId: uuid.optional() }),
    response: z.object({ count: z.number().int(), asOf: isoDateTime }),
  }),
  markRead: endpoint({
    id: 'notifications.markRead',
    method: 'POST',
    path: '/workspaces/{workspaceId}/notifications/mark-read',
    summary: 'Mark own unread notifications matching the previewed filter as read (only those created up to asOf).',
    tags: ['Notifications'],
    auth: 'workspace',
    idempotent: true,
    params: wsId({}),
    body: z.object({ eventType: z.string().max(80).optional(), projectId: uuid.optional(), asOf: isoDateTime }),
    response: z.object({ updated: z.number().int() }),
  }),
};

// ——— Search page (S11) ———

export const searchEndpoints = {
  page: endpoint({
    id: 'search.page',
    method: 'GET',
    path: '/workspaces/{workspaceId}/search/results',
    summary: 'Full search results with type facets and pagination; counts include only records the member may read.',
    tags: ['Search'],
    auth: 'workspace',
    params: wsId({}),
    query: z.object({
      q: z.string().trim().min(2).max(200),
      types: csv(z.string().max(40)).optional(),
      projectId: uuid.optional(),
      assigneeMembershipId: uuid.optional(),
      status: z.string().max(40).optional(),
      cursor: z.string().max(200).optional(),
      pageSize: z.coerce.number().int().min(1).max(50).default(20),
    }),
    response: z.object({
      results: z.array(searchResult),
      hasMore: z.boolean(),
      nextCursor: z.string().nullable(),
      facets: z.array(z.object({ entityType: z.string(), count: z.number().int() })),
    }),
  }),
};

// ——— Saved views (section 21) ———

export const FILTER_OPERATORS = ['equals', 'not_equals', 'in', 'contains', 'before', 'after', 'is_empty', 'is_not_empty'] as const;
export const filterValue = z.union([z.string().max(500), z.number(), z.boolean(), z.null(), z.array(z.union([z.string().max(200), z.number()])).max(200)]);
export const filterClause = z.object({ field: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.]{0,59}$/), operator: z.enum(FILTER_OPERATORS), value: filterValue.optional() });
export interface FilterGroupInput {
  op: 'and' | 'or';
  clauses: (z.infer<typeof filterClause> | FilterGroupInput)[];
}
export const filterAst: z.ZodType<FilterGroupInput> = z.lazy(() =>
  z.object({ op: z.enum(['and', 'or']), clauses: z.array(z.union([filterClause, filterAst])).max(30) }),
);
export const viewSort = z.array(z.object({ key: z.string().max(60), direction: z.enum(['asc', 'desc']) })).max(3);

export const savedView = z.object({
  id: uuid,
  module: z.string(),
  name: z.string(),
  filterAst,
  sort: viewSort,
  columns: z.array(z.string()),
  shared: z.boolean(),
  owner: memberRef,
  own: z.boolean(),
  updatedAt: isoDateTime,
  rowVersion: z.number().int(),
});
export type SavedView = z.infer<typeof savedView>;

const viewModule = z.string().regex(/^[a-z][a-z0-9_.:-]{1,59}$/);

export const savedViewEndpoints = {
  list: endpoint({
    id: 'savedViews.list',
    method: 'GET',
    path: '/workspaces/{workspaceId}/saved-views',
    summary: 'Own and shared saved views of a list screen (typed filter AST, never SQL).',
    tags: ['Saved Views'],
    auth: 'workspace',
    params: wsId({}),
    query: z.object({ module: viewModule }),
    response: z.array(savedView),
  }),
  create: endpoint({
    id: 'savedViews.create',
    method: 'POST',
    path: '/workspaces/{workspaceId}/saved-views',
    summary: 'Save the current filters as a personal or shared view (max 30 clauses, depth 3).',
    tags: ['Saved Views'],
    auth: 'workspace',
    idempotent: true,
    params: wsId({}),
    body: z.object({ module: viewModule, name: shortName, filterAst, sort: viewSort.default([]), columns: z.array(z.string().max(60)).max(60).default([]), shared: z.boolean().default(false) }),
    response: savedView,
    successStatus: 201,
  }),
  update: endpoint({
    id: 'savedViews.update',
    method: 'PATCH',
    path: '/workspaces/{workspaceId}/saved-views/{viewId}',
    summary: 'Rename, update filters or change sharing of an own view.',
    tags: ['Saved Views'],
    auth: 'workspace',
    ifMatch: true,
    params: wsId({ viewId: uuid }),
    body: z.object({ name: shortName.optional(), filterAst: filterAst.optional(), sort: viewSort.optional(), columns: z.array(z.string().max(60)).max(60).optional(), shared: z.boolean().optional() }),
    response: savedView,
  }),
  remove: endpoint({
    id: 'savedViews.remove',
    method: 'POST',
    path: '/workspaces/{workspaceId}/saved-views/{viewId}/remove',
    summary: 'Delete an own saved view (filters only; no records are affected).',
    tags: ['Saved Views'],
    auth: 'workspace',
    idempotent: true,
    ifMatch: true,
    params: wsId({ viewId: uuid }),
    response: okResponse,
  }),
};

// ——— Audit log (S69) ———

export const auditChange = z.object({ field: z.string(), from: z.unknown().optional(), to: z.unknown().optional() });

export const auditEventItem = z.object({
  id: uuid,
  occurredAt: isoDateTime,
  actor: z.object({ kind: z.string(), membershipId: uuid.nullable(), displayName: z.string(), avatarUrl: z.string().nullable() }),
  action: z.string(),
  entityType: z.string().nullable(),
  entityId: uuid.nullable(),
  projectId: uuid.nullable(),
  href: z.string().nullable(),
  requestId: z.string().nullable(),
  source: z.enum(CHANGE_SOURCES),
  reason: z.string().nullable(),
  sensitivity: z.enum(['normal', 'finance', 'ofm', 'security']),
  /** True when some values are hidden because the viewer lacks the sensitive permission. */
  masked: z.boolean(),
  changes: z.array(auditChange),
  metadata: z.record(z.string(), z.unknown()).nullable(),
});
export type AuditEventItem = z.infer<typeof auditEventItem>;

export const auditQuery = z.object({
  actorMembershipId: uuid.optional(),
  action: z.string().max(80).optional(),
  entityType: z.string().max(60).optional(),
  entityId: uuid.optional(),
  projectId: uuid.optional(),
  /** UTC boundaries computed by the client from the member's period and timezone. */
  from: isoDateTime.optional(),
  to: isoDateTime.optional(),
  source: csv(z.enum(CHANGE_SOURCES)).optional(),
});

export const auditEndpoints = {
  list: endpoint({
    id: 'audit.list',
    method: 'GET',
    path: '/workspaces/{workspaceId}/audit-events',
    summary: 'Immutable audit events within the viewer’s audit scope; sensitive values are masked by permission.',
    tags: ['Audit'],
    auth: 'workspace',
    permission: 'audit.read',
    params: wsId({}),
    query: pageQuery.extend(auditQuery.shape),
    response: page(auditEventItem),
  }),
  facets: endpoint({
    id: 'audit.facets',
    method: 'GET',
    path: '/workspaces/{workspaceId}/audit-events/facets',
    summary: 'Action names and entity types present in the viewer’s audit scope (filter options).',
    tags: ['Audit'],
    auth: 'workspace',
    permission: 'audit.read',
    params: wsId({}),
    response: z.object({ actions: z.array(z.string()), entityTypes: z.array(z.string()) }),
  }),
  get: endpoint({
    id: 'audit.get',
    method: 'GET',
    path: '/workspaces/{workspaceId}/audit-events/{eventId}',
    summary: 'One audit event with its masked field diff.',
    tags: ['Audit'],
    auth: 'workspace',
    permission: 'audit.read',
    params: wsId({ eventId: uuid }),
    response: auditEventItem,
  }),
};

// ——— Archive / Trash (S70) ———

export const entityRef = z.object({ entityType: z.string().max(60), entityId: uuid, state: z.enum(['archived', 'trash']).optional() });
export type EntityRef = z.infer<typeof entityRef>;

export const archiveItem = z.object({
  entityType: z.string(),
  entityId: uuid,
  typeLabel: z.string(),
  title: z.string(),
  state: z.enum(['archived', 'trash']),
  at: isoDateTime,
  by: memberRef.nullable(),
  reason: z.string().nullable(),
  projectId: uuid.nullable(),
  purgeAfter: isoDateTime.nullable(),
  href: z.string().nullable(),
  thumbnailUrl: z.string().nullable(),
  canRestore: z.boolean(),
  canPurge: z.boolean(),
});
export type ArchiveItem = z.infer<typeof archiveItem>;

export const entityPreviewItem = z.object({
  entityType: z.string(),
  entityId: uuid,
  title: z.string(),
  status: z.enum(['ok', 'blocked', 'forbidden', 'not_found', 'not_supported']),
  message: z.string().nullable(),
  items: z.array(impactItem),
  /** Unique collisions that need a choice before restoring (e.g. a handle now used by another record). */
  collisions: z.array(z.object({ field: z.string(), value: z.string(), message: z.string(), options: z.array(z.object({ value: z.string(), label: z.string() })) })),
});
export type EntityPreviewItem = z.infer<typeof entityPreviewItem>;

export const entityPreview = z.object({ token: z.string(), expiresAt: isoDateTime, items: z.array(entityPreviewItem), eligibleCount: z.number().int() });
export type EntityPreview = z.infer<typeof entityPreview>;

const targetsBody = z.object({ targets: z.array(entityRef).min(1).max(200) });
const resolutions = z.record(z.string().max(120), z.record(z.string().max(60), z.string().max(200)));
const entityResult = z.object({
  done: z.array(entityRef),
  failed: z.array(entityRef.extend({ message: z.string() })),
});

export const archiveEndpoints = {
  types: endpoint({
    id: 'archive.types',
    method: 'GET',
    path: '/workspaces/{workspaceId}/archive/types',
    summary: 'Entity types with archive/trash support and what the member may do with them.',
    tags: ['Archive'],
    auth: 'workspace',
    params: wsId({}),
    response: z.array(z.object({ entityType: z.string(), label: z.string(), trash: z.boolean(), purge: z.boolean(), listable: z.boolean() })),
  }),
  list: endpoint({
    id: 'archive.list',
    method: 'GET',
    path: '/workspaces/{workspaceId}/archive',
    summary: 'Archived or trashed records the member can read, newest first.',
    tags: ['Archive'],
    auth: 'workspace',
    params: wsId({}),
    query: pageQuery.extend({ state: z.enum(['archived', 'trash']).default('archived'), entityType: z.string().max(60).optional(), q: z.string().trim().max(120).optional(), projectId: uuid.optional() }),
    response: page(archiveItem),
  }),
  archivePreview: endpoint({
    id: 'archive.archivePreview',
    method: 'POST',
    path: '/workspaces/{workspaceId}/entities/archive-preview',
    summary: 'Open obligations and permitted effects before archiving.',
    tags: ['Archive'],
    auth: 'workspace',
    params: wsId({}),
    body: targetsBody,
    response: entityPreview,
  }),
  archive: endpoint({
    id: 'archive.archive',
    method: 'POST',
    path: '/workspaces/{workspaceId}/entities/archive',
    summary: 'Archive previewed records without history loss (targets changed since the preview are refused).',
    tags: ['Archive'],
    auth: 'workspace',
    idempotent: true,
    params: wsId({}),
    body: z.object({ previewToken: z.string().max(100), reason: z.string().trim().max(LIMITS.reasonMax).optional(), resolutions: resolutions.optional() }),
    response: entityResult,
  }),
  trash: endpoint({
    id: 'archive.trash',
    method: 'POST',
    path: '/workspaces/{workspaceId}/entities/trash',
    summary: 'Move eligible drafts to the trash (restorable during the grace period).',
    tags: ['Archive'],
    auth: 'workspace',
    idempotent: true,
    params: wsId({}),
    body: targetsBody.extend({ reason }),
    response: entityResult,
  }),
  restorePreview: endpoint({
    id: 'archive.restorePreview',
    method: 'POST',
    path: '/workspaces/{workspaceId}/entities/restore-preview',
    summary: 'Dependencies and unique collisions before restoring archived or trashed records.',
    tags: ['Archive'],
    auth: 'workspace',
    params: wsId({}),
    body: targetsBody,
    response: entityPreview,
  }),
  restore: endpoint({
    id: 'archive.restore',
    method: 'POST',
    path: '/workspaces/{workspaceId}/entities/restore',
    summary: 'Restore previewed records with current authorization; collisions need an explicit resolution.',
    tags: ['Archive'],
    auth: 'workspace',
    idempotent: true,
    params: wsId({}),
    body: z.object({ previewToken: z.string().max(100), resolutions: resolutions.optional() }),
    response: entityResult,
  }),
  purgePreview: endpoint({
    id: 'archive.purgePreview',
    method: 'POST',
    path: '/workspaces/{workspaceId}/entities/purge-preview',
    summary: 'Which trashed records may be permanently deleted (Owner only; never finance or audit).',
    tags: ['Archive'],
    auth: 'workspace',
    permission: 'trash.purge',
    params: wsId({}),
    body: targetsBody,
    response: entityPreview,
  }),
  purge: endpoint({
    id: 'archive.purge',
    method: 'POST',
    path: '/workspaces/{workspaceId}/entities/purge',
    summary: 'Queue permanent deletion of previewed trash (typed confirmation, recent authentication, asynchronous).',
    tags: ['Archive'],
    auth: 'workspace',
    permission: 'trash.purge',
    idempotent: true,
    params: wsId({}),
    body: z.object({ previewToken: z.string().max(100), confirmation: z.string().max(40) }),
    response: z.object({ jobId: uuid.nullable(), count: z.number().int() }),
    successStatus: 202,
  }),
};

// ——— System health & incidents (S71) ———

export const healthEndpoints = {
  live: endpoint({
    id: 'health.live',
    method: 'GET',
    path: '/health/live',
    summary: 'Process liveness. Public; returns no infrastructure metadata.',
    tags: ['Health'],
    auth: 'public',
    rateLimit: 'none',
    response: z.object({ status: z.literal('ok') }),
  }),
  ready: endpoint({
    id: 'health.ready',
    method: 'GET',
    path: '/health/ready',
    summary: 'Readiness: database and object storage reachable (503 when not ready). Public; no metadata.',
    tags: ['Health'],
    auth: 'public',
    rateLimit: 'none',
    response: z.object({ status: z.enum(['ready', 'not_ready']), checks: z.object({ database: z.enum(['ok', 'failed']), storage: z.enum(['ok', 'failed']) }) }),
  }),
  system: endpoint({
    id: 'health.system',
    method: 'GET',
    path: '/workspaces/{workspaceId}/system/health',
    summary: 'Technical health for administrators: queues, dead letters, outbox lag, mail, storage, backups.',
    tags: ['Health'],
    auth: 'workspace',
    permission: 'system.jobs.read',
    params: wsId({}),
    response: z.object({
      asOf: isoDateTime,
      jobs: z.array(z.object({ pool: z.enum(JOB_POOLS), state: z.enum(JOB_STATES), count: z.number().int() })),
      oldestDueJobAt: isoDateTime.nullable(),
      deadLettered: z.number().int(),
      outbox: z.object({ pending: z.number().int(), oldestPendingAt: isoDateTime.nullable(), lagSeconds: z.number().int().nullable() }),
      mail: z.object({ transport: z.string(), sentLast24h: z.number().int(), failedLast24h: z.number().int(), lastFailureAt: isoDateTime.nullable() }),
      storage: z.object({ ok: z.boolean(), usedBytes: z.string(), reservedBytes: z.string(), quotaBytes: z.string(), usedPercent: z.string().nullable() }),
      scanner: z.object({ mode: z.string(), ok: z.boolean() }),
      backup: z.object({
        lastSuccessAt: isoDateTime.nullable(),
        lastRunStatus: z.enum(['running', 'succeeded', 'failed']).nullable(),
        /** Healthy only with a confirmed successful backup newer than the freshness window (26 h). */
        healthy: z.boolean(),
        freshnessHours: z.number().int(),
        lastRestoreTestAt: isoDateTime.nullable(),
        lastRestoreResult: z.enum(['running', 'succeeded', 'failed']).nullable(),
      }),
      openSystemIncidents: z.number().int(),
    }),
  }),
  jobs: endpoint({
    id: 'health.jobs',
    method: 'GET',
    path: '/workspaces/{workspaceId}/system/jobs',
    summary: 'Background jobs by state (dead-lettered and failed first).',
    tags: ['Health'],
    auth: 'workspace',
    permission: 'system.jobs.read',
    params: wsId({}),
    query: pageQuery.extend({ state: csv(z.enum(JOB_STATES)).optional(), pool: z.enum(JOB_POOLS).optional(), type: z.string().max(80).optional() }),
    response: page(
      z.object({
        id: uuid,
        type: z.string(),
        pool: z.enum(JOB_POOLS),
        state: z.enum(JOB_STATES),
        attempts: z.number().int(),
        maxRetries: z.number().int(),
        progress: z.number().int(),
        lastErrorCode: z.string().nullable(),
        lastErrorMessage: z.string().nullable(),
        runAt: isoDateTime,
        createdAt: isoDateTime,
        finishedAt: isoDateTime.nullable(),
        canRetry: z.boolean(),
        canCancel: z.boolean(),
      }),
    ),
  }),
  retryJob: endpoint({
    id: 'health.retryJob',
    method: 'POST',
    path: '/workspaces/{workspaceId}/system/jobs/{jobId}/retry',
    summary: 'Retry a dead-lettered or failed job with the same operation key; the job re-authorises when it runs.',
    tags: ['Health'],
    auth: 'workspace',
    permission: 'system.jobs.retry',
    idempotent: true,
    params: wsId({ jobId: uuid }),
    body: z.object({ reason: z.string().trim().max(LIMITS.reasonMax).optional() }),
    response: okResponse,
  }),
  cancelJob: endpoint({
    id: 'health.cancelJob',
    method: 'POST',
    path: '/workspaces/{workspaceId}/system/jobs/{jobId}/cancel',
    summary: 'Request safe cancellation of a queued or running job.',
    tags: ['Health'],
    auth: 'workspace',
    permission: 'system.jobs.retry',
    idempotent: true,
    params: wsId({ jobId: uuid }),
    body: z.object({ reason: z.string().trim().max(LIMITS.reasonMax).optional() }),
    response: okResponse,
  }),
  mail: endpoint({
    id: 'health.mail',
    method: 'GET',
    path: '/workspaces/{workspaceId}/system/mail',
    summary: 'Outgoing mail delivery records of this workspace (subjects only, never bodies).',
    tags: ['Health'],
    auth: 'workspace',
    permission: 'system.jobs.read',
    params: wsId({}),
    query: pageQuery.extend({ status: z.enum(['queued', 'sent', 'failed']).optional() }),
    response: page(
      z.object({ id: uuid, to: z.string(), subject: z.string(), template: z.string(), status: z.enum(['queued', 'sent', 'failed']), transport: z.string().nullable(), attempts: z.number().int(), error: z.string().nullable(), createdAt: isoDateTime, sentAt: isoDateTime.nullable() }),
    ),
  }),
  backups: endpoint({
    id: 'health.backups',
    method: 'GET',
    path: '/workspaces/{workspaceId}/system/backups',
    summary: 'Recent backup runs and restore drills as reported by the backup tooling.',
    tags: ['Health'],
    auth: 'workspace',
    permission: 'backups.status.read',
    params: wsId({}),
    query: z.object({ kind: z.enum(['backup', 'restore_drill']).optional() }),
    response: z.array(
      z.object({
        id: uuid,
        kind: z.enum(['backup', 'restore_drill']),
        status: z.enum(['running', 'succeeded', 'failed']),
        startedAt: isoDateTime,
        finishedAt: isoDateTime.nullable(),
        recoveredTimestamp: isoDateTime.nullable(),
        durationSeconds: z.number().int().nullable(),
        details: z.record(z.string(), z.unknown()),
        reportedBy: z.string(),
      }),
    ),
  }),
  recordRestoreDrill: endpoint({
    id: 'health.recordRestoreDrill',
    method: 'POST',
    path: '/workspaces/{workspaceId}/system/restore-drills',
    summary: 'Record the result of a restore drill (duration, recovered timestamp, missing objects, verified counts).',
    tags: ['Health'],
    auth: 'workspace',
    permission: 'backups.status.read',
    idempotent: true,
    params: wsId({}),
    body: z.object({
      status: z.enum(['succeeded', 'failed']),
      startedAt: isoDateTime,
      finishedAt: isoDateTime,
      recoveredTimestamp: isoDateTime.nullable().optional(),
      missingObjects: z.number().int().min(0).max(1_000_000_000),
      verifiedCounts: z.string().trim().max(2000),
      notes: z.string().trim().max(LIMITS.noteMax).optional(),
    }),
    response: okResponse,
    successStatus: 201,
  }),
};

export const incidentItem = z.object({
  id: uuid,
  kind: z.enum(INCIDENT_KINDS),
  severity: z.enum(INCIDENT_SEVERITIES),
  title: z.string(),
  description: z.string().nullable(),
  state: z.enum(INCIDENT_STATES),
  project: z.object({ id: uuid, name: z.string() }).nullable(),
  account: z.object({ id: uuid, label: z.string() }).nullable(),
  owner: memberRef.nullable(),
  resolution: z.string().nullable(),
  resolvedAt: isoDateTime.nullable(),
  acknowledgedAt: isoDateTime.nullable(),
  alertKey: z.string().nullable(),
  jobId: uuid.nullable(),
  evidence: z.array(z.object({ assetId: uuid, name: z.string(), thumbnailUrl: z.string().nullable() })),
  hiddenEvidenceCount: z.number().int(),
  createdAt: isoDateTime,
  createdBy: z.string().nullable(),
  updatedAt: isoDateTime,
  rowVersion: z.number().int(),
  permissions: z.object({ update: z.boolean() }),
});
export type IncidentItem = z.infer<typeof incidentItem>;

const incidentFields = {
  title: z.string().trim().min(3).max(200),
  description: z.string().trim().max(LIMITS.noteMax).nullable().optional(),
  severity: z.enum(INCIDENT_SEVERITIES),
  projectId: uuid.nullable().optional(),
  accountId: uuid.nullable().optional(),
  ownerMembershipId: uuid.nullable().optional(),
  evidenceAssetIds: z.array(uuid).max(20).optional(),
};

export const incidentEndpoints = {
  list: endpoint({
    id: 'incidents.list',
    method: 'GET',
    path: '/workspaces/{workspaceId}/incidents',
    summary: 'Operational incidents in scope; system incidents for administrators.',
    tags: ['Incidents'],
    auth: 'workspace',
    params: wsId({}),
    query: pageQuery.extend({
      kind: z.enum(INCIDENT_KINDS).default('operational'),
      state: csv(z.enum(INCIDENT_STATES)).optional(),
      severity: csv(z.enum(INCIDENT_SEVERITIES)).optional(),
      projectId: uuid.optional(),
      ownerMembershipId: uuid.optional(),
      q: z.string().trim().max(120).optional(),
    }),
    response: page(incidentItem),
  }),
  get: endpoint({
    id: 'incidents.get',
    method: 'GET',
    path: '/workspaces/{workspaceId}/incidents/{incidentId}',
    summary: 'Incident detail with permitted evidence.',
    tags: ['Incidents'],
    auth: 'workspace',
    params: wsId({ incidentId: uuid }),
    response: incidentItem,
  }),
  create: endpoint({
    id: 'incidents.create',
    method: 'POST',
    path: '/workspaces/{workspaceId}/incidents',
    summary: 'Log an operational incident (system incidents are raised by health monitoring or administrators).',
    tags: ['Incidents'],
    auth: 'workspace',
    permission: 'incidents.write',
    idempotent: true,
    params: wsId({}),
    body: z.object({ ...incidentFields, kind: z.enum(INCIDENT_KINDS).default('operational') }),
    response: incidentItem,
    successStatus: 201,
  }),
  update: endpoint({
    id: 'incidents.update',
    method: 'PATCH',
    path: '/workspaces/{workspaceId}/incidents/{incidentId}',
    summary: 'Edit an open incident’s description, severity or evidence.',
    tags: ['Incidents'],
    auth: 'workspace',
    permission: 'incidents.write',
    ifMatch: true,
    params: wsId({ incidentId: uuid }),
    body: z.object({ title: incidentFields.title.optional(), description: incidentFields.description, severity: incidentFields.severity.optional(), evidenceAssetIds: incidentFields.evidenceAssetIds }),
    response: incidentItem,
  }),
  acknowledge: endpoint({
    id: 'incidents.acknowledge',
    method: 'POST',
    path: '/workspaces/{workspaceId}/incidents/{incidentId}/acknowledge',
    summary: 'Acknowledge an alert or incident and start investigating.',
    tags: ['Incidents'],
    auth: 'workspace',
    permission: 'incidents.write',
    idempotent: true,
    ifMatch: true,
    params: wsId({ incidentId: uuid }),
    response: incidentItem,
  }),
  assign: endpoint({
    id: 'incidents.assign',
    method: 'POST',
    path: '/workspaces/{workspaceId}/incidents/{incidentId}/assign',
    summary: 'Assign or change the incident owner (the new owner is notified).',
    tags: ['Incidents'],
    auth: 'workspace',
    permission: 'incidents.write',
    idempotent: true,
    ifMatch: true,
    params: wsId({ incidentId: uuid }),
    body: z.object({ ownerMembershipId: uuid.nullable() }),
    response: incidentItem,
  }),
  resolve: endpoint({
    id: 'incidents.resolve',
    method: 'POST',
    path: '/workspaces/{workspaceId}/incidents/{incidentId}/resolve',
    summary: 'Resolve with an outcome; optional evidence files.',
    tags: ['Incidents'],
    auth: 'workspace',
    permission: 'incidents.write',
    idempotent: true,
    ifMatch: true,
    params: wsId({ incidentId: uuid }),
    body: z.object({ resolution: z.string().trim().min(3).max(LIMITS.noteMax), evidenceAssetIds: z.array(uuid).max(20).optional() }),
    response: incidentItem,
  }),
  reopen: endpoint({
    id: 'incidents.reopen',
    method: 'POST',
    path: '/workspaces/{workspaceId}/incidents/{incidentId}/reopen',
    summary: 'Reopen a resolved incident with a reason.',
    tags: ['Incidents'],
    auth: 'workspace',
    permission: 'incidents.write',
    idempotent: true,
    ifMatch: true,
    params: wsId({ incidentId: uuid }),
    body: z.object({ reason }),
    response: incidentItem,
  }),
};

/** Every platform endpoint group (registered in ENDPOINT_GROUPS with one line). */
export const PLATFORM_ENDPOINT_GROUPS = {
  inbox: inboxEndpoints,
  searchPage: searchEndpoints,
  savedViews: savedViewEndpoints,
  audit: auditEndpoints,
  archive: archiveEndpoints,
  health: healthEndpoints,
  incidents: incidentEndpoints,
  imports: importEndpoints,
  exports: exportEndpoints,
  templates: templateEndpoints,
  customFields: customFieldEndpoints,
};

void boolQuery;
