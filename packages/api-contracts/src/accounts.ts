import { z } from 'zod';
import { ACCOUNT_STATUSES, LIMITS, PLATFORMS, RESPONSIBILITIES } from '@castlane/domain';
import { endpoint } from './core';
import {
  boolQuery,
  csv,
  impactItem,
  isoDateTime,
  memberRef,
  okResponse,
  page,
  pageQuery,
  reason,
  tags,
  uuid,
  wsId,
} from './common';

/**
 * Accounts (S18–S20). External platform accounts are registered by link only: the server never
 * fetches the URL, imports statistics or publishes content (R05, T033).
 */

export const METRICS_CADENCES = ['daily', 'weekly', 'monthly'] as const;
/** States an account may be created in; later changes go through the transition command. */
export const ACCOUNT_INITIAL_STATUSES = ['preparing', 'active'] as const;

export const accountProjectRef = z.object({ id: uuid, name: z.string() });

export const accountSummary = z.object({
  id: uuid,
  platform: z.enum(PLATFORMS),
  handle: z.string().nullable(),
  displayName: z.string().nullable(),
  canonicalUrl: z.string(),
  originalUrl: z.string(),
  project: accountProjectRef,
  owner: memberRef,
  status: z.enum(ACCOUNT_STATUSES),
  statusReason: z.string().nullable(),
  tags: z.array(z.string()),
  avatarUrl: z.string().nullable(),
  /** Latest observation time of a recorded metric; null = no data recorded (never 0). */
  lastMetricsAt: isoDateTime.nullable(),
  nextPublicationAt: isoDateTime.nullable(),
  /** Checkpoints marked missing or past their window without an observation. */
  missingCheckpoints: z.number().int(),
  archivedAt: isoDateTime.nullable(),
  updatedAt: isoDateTime,
  rowVersion: z.number().int(),
});
export type AccountSummary = z.infer<typeof accountSummary>;

export const accountAssignment = z.object({
  id: uuid,
  member: memberRef,
  duty: z.enum(RESPONSIBILITIES),
  supervisor: memberRef.nullable(),
  validFrom: isoDateTime,
  validTo: isoDateTime.nullable(),
  endedReason: z.string().nullable(),
  rowVersion: z.number().int(),
});
export type AccountAssignment = z.infer<typeof accountAssignment>;

export const accountDetail = accountSummary.extend({
  language: z.string().nullable(),
  markets: z.array(z.string()),
  purpose: z.string().nullable(),
  notes: z.string().nullable(),
  avatarAssetId: uuid.nullable(),
  metricsCadence: z.enum(METRICS_CADENCES),
  metricsDayOfWeek: z.number().int(),
  metricsTime: z.string(),
  captionMaxLength: z.number().int().nullable(),
  assignments: z.array(accountAssignment),
  /** Target states the actor may move this account to (UI courtesy; the server re-checks). */
  allowedTransitions: z.array(z.enum(ACCOUNT_STATUSES)),
  permissions: z.object({
    update: z.boolean(),
    assign: z.boolean(),
    archive: z.boolean(),
    transfer: z.boolean(),
    transition: z.boolean(),
    createPublication: z.boolean(),
    addMetrics: z.boolean(),
  }),
});
export type AccountDetail = z.infer<typeof accountDetail>;

const metricsTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use the HH:MM format.');

const accountFields = {
  platform: z.enum(PLATFORMS),
  profileUrl: z.string().trim().min(1).max(LIMITS.urlMax),
  ownerMembershipId: uuid,
  handle: z.string().trim().max(LIMITS.handleMax).nullable().optional(),
  displayName: z.string().trim().max(LIMITS.shortNameMax).nullable().optional(),
  language: z.string().trim().max(20).nullable().optional(),
  markets: z.array(z.string().trim().min(2).max(40)).max(30).optional(),
  purpose: z.string().trim().max(2000).nullable().optional(),
  notes: z.string().max(LIMITS.noteMax).nullable().optional(),
  tags: tags.optional(),
  avatarAssetId: uuid.nullable().optional(),
  metricsCadence: z.enum(METRICS_CADENCES).optional(),
  metricsDayOfWeek: z.number().int().min(1).max(7).optional(),
  metricsTime: metricsTime.optional(),
  captionMaxLength: z.number().int().min(1).max(100_000).nullable().optional(),
};

export const accountSort = z.enum(['handle', 'updatedAt', 'status', 'platform']);

export const urlPreview = z.object({
  ok: z.boolean(),
  error: z.enum(['INVALID_URL', 'HTTPS_REQUIRED', 'HOST_MISMATCH']).nullable(),
  message: z.string().nullable(),
  canonicalUrl: z.string().nullable(),
  handle: z.string().nullable(),
  host: z.string().nullable(),
  /** Removed tracking parameters (for the preview explanation). */
  removedParams: z.array(z.string()),
  duplicate: z
    .object({
      /** Present only when the existing account is readable by the actor. */
      account: z.object({ id: uuid, handle: z.string().nullable(), platform: z.enum(PLATFORMS), projectName: z.string(), status: z.enum(ACCOUNT_STATUSES) }).nullable(),
    })
    .nullable(),
});

export const accountHistory = z.object({
  identity: z.array(
    z.object({
      id: uuid,
      oldHandle: z.string().nullable(),
      newHandle: z.string().nullable(),
      oldUrl: z.string().nullable(),
      newUrl: z.string().nullable(),
      effectiveAt: isoDateTime,
      reason: z.string().nullable(),
      actorName: z.string().nullable(),
    }),
  ),
  status: z.array(
    z.object({
      id: uuid,
      fromStatus: z.enum(ACCOUNT_STATUSES).nullable(),
      toStatus: z.enum(ACCOUNT_STATUSES),
      reason: z.string().nullable(),
      occurredAt: isoDateTime,
      actorName: z.string().nullable(),
    }),
  ),
  transfers: z.array(
    z.object({
      id: uuid,
      fromProject: accountProjectRef.nullable(),
      toProject: accountProjectRef.nullable(),
      transferredAt: isoDateTime,
      reason: z.string(),
      actorName: z.string().nullable(),
    }),
  ),
});

export const activityItem = z.object({
  id: uuid,
  action: z.string(),
  entityType: z.string().nullable(),
  entityId: uuid.nullable(),
  actorName: z.string().nullable(),
  occurredAt: isoDateTime,
  reason: z.string().nullable(),
  changes: z.array(z.object({ field: z.string(), from: z.unknown().optional(), to: z.unknown().optional() })),
});

export const bulkItemResult = z.object({ id: uuid, ok: z.boolean(), code: z.string().nullable(), message: z.string().nullable() });

export const accountEndpoints = {
  list: endpoint({
    id: 'accounts.list',
    method: 'GET',
    path: '/workspaces/{workspaceId}/accounts',
    summary: 'Accounts in the actor’s scope with responsibility and freshness columns. Archived hidden by default.',
    tags: ['Accounts'],
    auth: 'workspace',
    permission: 'accounts.read',
    params: wsId({}),
    query: pageQuery.extend({
      q: z.string().trim().max(120).optional(),
      platform: csv(z.enum(PLATFORMS)).optional(),
      status: csv(z.enum(ACCOUNT_STATUSES)).optional(),
      projectId: uuid.optional(),
      ownerMembershipId: uuid.optional(),
      assignedMembershipId: uuid.optional(),
      tag: z.string().max(40).optional(),
      includeArchived: boolQuery.optional(),
      sort: accountSort.default('updatedAt'),
      direction: z.enum(['asc', 'desc']).default('desc'),
    }),
    response: page(accountSummary),
  }),
  get: endpoint({
    id: 'accounts.get',
    method: 'GET',
    path: '/workspaces/{workspaceId}/accounts/{accountId}',
    summary: 'Account detail with current assignments and allowed actions.',
    tags: ['Accounts'],
    auth: 'workspace',
    permission: 'accounts.read',
    params: wsId({ accountId: uuid }),
    response: accountDetail,
  }),
  urlPreview: endpoint({
    id: 'accounts.urlPreview',
    method: 'GET',
    path: '/workspaces/{workspaceId}/account-url-preview',
    summary: 'Normalize a profile URL for the chosen platform and detect an existing account with the same identity. Never fetches the URL.',
    tags: ['Accounts'],
    auth: 'workspace',
    permission: 'accounts.write',
    params: wsId({}),
    query: z.object({ platform: z.enum(PLATFORMS), url: z.string().max(LIMITS.urlMax), excludeAccountId: uuid.optional() }),
    response: urlPreview,
  }),
  create: endpoint({
    id: 'accounts.create',
    method: 'POST',
    path: '/workspaces/{workspaceId}/accounts',
    summary: 'Register an external account by link (no OAuth, no import, no password).',
    tags: ['Accounts'],
    auth: 'workspace',
    permission: 'accounts.write',
    idempotent: true,
    params: wsId({}),
    body: z.object({ ...accountFields, projectId: uuid, status: z.enum(ACCOUNT_INITIAL_STATUSES).optional() }),
    response: accountDetail,
    successStatus: 201,
  }),
  update: endpoint({
    id: 'accounts.update',
    method: 'PATCH',
    path: '/workspaces/{workspaceId}/accounts/{accountId}',
    summary: 'Update account fields. A handle or URL change is recorded in the identity history.',
    tags: ['Accounts'],
    auth: 'workspace',
    permission: 'accounts.write',
    ifMatch: true,
    params: wsId({ accountId: uuid }),
    body: z.object(accountFields).partial().extend({ identityChangeReason: z.string().trim().max(LIMITS.reasonMax).optional() }),
    response: accountDetail,
  }),
  transition: endpoint({
    id: 'accounts.transition',
    method: 'POST',
    path: '/workspaces/{workspaceId}/accounts/{accountId}/transition',
    summary: 'Preparing → Active ↔ Paused; Active/Paused → Restricted (reason); Restricted → Active (resolution); → Archived without blocking obligations.',
    tags: ['Accounts'],
    auth: 'workspace',
    permission: 'accounts.write',
    idempotent: true,
    ifMatch: true,
    params: wsId({ accountId: uuid }),
    body: z.object({ targetState: z.enum(ACCOUNT_STATUSES), reason: reason.optional() }),
    response: accountDetail,
  }),
  restore: endpoint({
    id: 'accounts.restore',
    method: 'POST',
    path: '/workspaces/{workspaceId}/accounts/{accountId}/restore',
    summary: 'Restore an archived account to its status before archiving (identity uniqueness re-checked).',
    tags: ['Accounts'],
    auth: 'workspace',
    permission: 'accounts.archive',
    idempotent: true,
    ifMatch: true,
    params: wsId({ accountId: uuid }),
    body: z.object({ reason: reason.optional() }),
    response: accountDetail,
  }),
  archivePreview: endpoint({
    id: 'accounts.archivePreview',
    method: 'GET',
    path: '/workspaces/{workspaceId}/accounts/{accountId}/archive-preview',
    summary: 'Open obligations that block archiving (scheduled publications, active shifts) and non-blocking notes.',
    tags: ['Accounts'],
    auth: 'workspace',
    permission: 'accounts.archive',
    params: wsId({ accountId: uuid }),
    response: z.object({ title: z.string(), rowVersion: z.number().int(), items: z.array(impactItem) }),
  }),
  transferPreview: endpoint({
    id: 'accounts.transferPreview',
    method: 'GET',
    path: '/workspaces/{workspaceId}/accounts/{accountId}/transfer-preview',
    summary: 'Preview moving the account to another project: blocking obligations, effects and an impact token (10 min).',
    tags: ['Accounts'],
    auth: 'workspace',
    permission: 'accounts.write',
    params: wsId({ accountId: uuid }),
    query: z.object({ targetProjectId: uuid }),
    response: z.object({
      account: z.object({ id: uuid, handle: z.string().nullable(), rowVersion: z.number().int() }),
      fromProject: accountProjectRef,
      toProject: accountProjectRef,
      items: z.array(impactItem),
      blocked: z.boolean(),
      impactToken: z.string().nullable(),
      expiresAt: isoDateTime.nullable(),
    }),
  }),
  transfer: endpoint({
    id: 'accounts.transfer',
    method: 'POST',
    path: '/workspaces/{workspaceId}/accounts/{accountId}/transfer',
    summary: 'Move the account to another project. Existing publications, tasks, metrics and finance keep their project at creation.',
    tags: ['Accounts'],
    auth: 'workspace',
    permission: 'accounts.write',
    idempotent: true,
    ifMatch: true,
    params: wsId({ accountId: uuid }),
    body: z.object({ targetProjectId: uuid, impactToken: z.string().min(10).max(400), reason }),
    response: accountDetail,
  }),
  history: endpoint({
    id: 'accounts.history',
    method: 'GET',
    path: '/workspaces/{workspaceId}/accounts/{accountId}/history',
    summary: 'Identity (handle/URL), status and project transfer history.',
    tags: ['Accounts'],
    auth: 'workspace',
    permission: 'accounts.read',
    params: wsId({ accountId: uuid }),
    response: accountHistory,
  }),
  activity: endpoint({
    id: 'accounts.activity',
    method: 'GET',
    path: '/workspaces/{workspaceId}/accounts/{accountId}/activity',
    summary: 'Meaningful account history (sensitive audit categories excluded).',
    tags: ['Accounts'],
    auth: 'workspace',
    permission: 'accounts.read',
    params: wsId({ accountId: uuid }),
    query: pageQuery,
    response: page(activityItem),
  }),
  assignments: endpoint({
    id: 'accounts.assignments',
    method: 'GET',
    path: '/workspaces/{workspaceId}/accounts/{accountId}/assignments',
    summary: 'Current and (optionally) ended member assignments of the account.',
    tags: ['Accounts'],
    auth: 'workspace',
    permission: 'accounts.read',
    params: wsId({ accountId: uuid }),
    query: z.object({ includeEnded: boolQuery.optional() }),
    response: z.array(accountAssignment),
  }),
  assign: endpoint({
    id: 'accounts.assign',
    method: 'POST',
    path: '/workspaces/{workspaceId}/accounts/{accountId}/assignments',
    summary: 'Assign a member to the account with a duty. Limits role scope; grants no sensitive permissions.',
    tags: ['Accounts'],
    auth: 'workspace',
    permission: 'accounts.assign',
    idempotent: true,
    params: wsId({ accountId: uuid }),
    body: z.object({ membershipId: uuid, duty: z.enum(RESPONSIBILITIES), supervisorMembershipId: uuid.nullable().optional() }),
    response: accountAssignment,
    successStatus: 201,
  }),
  updateAssignment: endpoint({
    id: 'accounts.updateAssignment',
    method: 'PATCH',
    path: '/workspaces/{workspaceId}/accounts/{accountId}/assignments/{assignmentId}',
    summary: 'Change the supervisor of an open assignment (duty changes end the assignment and create a new one).',
    tags: ['Accounts'],
    auth: 'workspace',
    permission: 'accounts.assign',
    ifMatch: true,
    params: wsId({ accountId: uuid, assignmentId: uuid }),
    body: z.object({ supervisorMembershipId: uuid.nullable() }),
    response: accountAssignment,
  }),
  endAssignment: endpoint({
    id: 'accounts.endAssignment',
    method: 'POST',
    path: '/workspaces/{workspaceId}/accounts/{accountId}/assignments/{assignmentId}/end',
    summary: 'End an assignment; the history row is kept.',
    tags: ['Accounts'],
    auth: 'workspace',
    permission: 'accounts.assign',
    idempotent: true,
    params: wsId({ accountId: uuid, assignmentId: uuid }),
    body: z.object({ reason: reason.optional() }),
    response: okResponse,
  }),
  bulkAssign: endpoint({
    id: 'accounts.bulkAssign',
    method: 'POST',
    path: '/workspaces/{workspaceId}/accounts-bulk/assign',
    summary: 'Assign one member to several accounts. Each account is authorised separately; results are per item.',
    tags: ['Accounts'],
    auth: 'workspace',
    permission: 'accounts.assign',
    idempotent: true,
    params: wsId({}),
    body: z.object({ accountIds: z.array(uuid).min(1).max(200), membershipId: uuid, duty: z.enum(RESPONSIBILITIES) }),
    response: z.object({ results: z.array(bulkItemResult), succeeded: z.number().int(), failed: z.number().int() }),
  }),
};
