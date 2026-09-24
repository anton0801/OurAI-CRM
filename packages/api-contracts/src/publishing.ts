import { z } from 'zod';
import {
  ACCOUNT_STATUSES,
  ATTRIBUTION_TYPES,
  CAMPAIGN_STATUSES,
  CHECKPOINT_STATES,
  CHECKPOINT_TIMING,
  CONTENT_FORMATS,
  CONTENT_STAGES,
  EXPERIMENT_STATUSES,
  LIMITS,
  METRIC_SEGMENTS,
  PLATFORMS,
  PUBLICATION_AVAILABILITY,
  PUBLICATION_STATUSES,
  TASK_STATUSES,
} from '@castlane/domain';
import { endpoint } from './core';
import {
  boolQuery,
  csv,
  httpsUrl,
  isoDate,
  isoDateTime,
  memberRef,
  money,
  page,
  pageQuery,
  reason,
  shortName,
  tags,
  timezone,
  uuid,
  wsId,
} from './common';

/**
 * Publications (placements), calendar, plan baselines, campaigns, tracking links and experiments
 * (S31–S35, §12). Nothing here talks to an external platform: a publication becomes Published only
 * through Mark Published with the post URL (or a reason it is missing) — never because time passed.
 * Tagged URLs are ordinary links; clicks and conversions exist only as entered source reports.
 */

const caption = z.string().max(LIMITS.noteMax);
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();
const noUrlReason = z.string().trim().min(LIMITS.noUrlReasonMin).max(LIMITS.noUrlReasonMax);
const ref = z.object({ id: uuid, name: z.string() });

// ——— Publications (S32) ———

export const publicationAccountRef = z.object({
  id: uuid,
  label: z.string(),
  platform: z.enum(PLATFORMS),
  status: z.enum(ACCOUNT_STATUSES),
  url: z.string(),
});

export const publicationRow = z.object({
  id: uuid,
  /** Title of the content item that is placed. */
  title: z.string(),
  contentItemId: uuid,
  contentVersion: z.object({ id: uuid, versionNo: z.number().int(), approved: z.boolean(), approvalRevoked: z.boolean() }).nullable(),
  format: z.enum(CONTENT_FORMATS).nullable(),
  account: publicationAccountRef,
  /** Project at creation (account transfers never rewrite it). */
  project: ref,
  owner: memberRef,
  status: z.enum(PUBLICATION_STATUSES),
  availability: z.enum(PUBLICATION_AVAILABILITY),
  scheduledAt: isoDateTime.nullable(),
  scheduleTimezone: z.string().nullable(),
  actualPublishedAt: isoDateTime.nullable(),
  externalPostUrl: z.string().nullable(),
  /** Published without a post URL (badge "URL Missing"). */
  urlMissing: z.boolean(),
  /** Scheduled time has passed and nobody confirmed the post yet (the CRM never assumes it happened). */
  awaitingConfirmation: z.boolean(),
  historicalEntry: z.boolean(),
  primaryCampaign: ref.nullable(),
  thumbnailUrl: z.string().nullable(),
  approvalRevokedAfterPublication: z.boolean(),
  archivedAt: isoDateTime.nullable(),
  updatedAt: isoDateTime,
  rowVersion: z.number().int(),
});
export type PublicationRow = z.infer<typeof publicationRow>;

export const publicationCheckpoint = z.object({
  id: uuid,
  key: z.string(),
  label: z.string(),
  policyVersion: z.number().int(),
  expectedAt: isoDateTime,
  windowStart: isoDateTime,
  windowEnd: isoDateTime,
  state: z.enum(CHECKPOINT_STATES),
  timing: z.enum(CHECKPOINT_TIMING).nullable(),
  assignee: memberRef.nullable(),
  missingReason: z.string().nullable(),
  cancelledReason: z.string().nullable(),
  completedObservationId: uuid.nullable(),
});
export type PublicationCheckpoint = z.infer<typeof publicationCheckpoint>;

export const publicationPlanRevision = z.object({
  id: uuid,
  fromScheduledAt: isoDateTime.nullable(),
  toScheduledAt: isoDateTime.nullable(),
  reason: z.string().nullable(),
  changedAt: isoDateTime,
  actorName: z.string().nullable(),
});

export const publicationCorrection = z.object({
  id: uuid,
  before: z.record(z.string(), z.unknown()),
  after: z.record(z.string(), z.unknown()),
  reason: z.string(),
  createdAt: isoDateTime,
  actorName: z.string().nullable(),
});

export const publicationDetail = publicationRow.extend({
  caption: z.string().nullable(),
  cta: z.string().nullable(),
  destinationUrl: z.string().nullable(),
  descriptiveTags: z.array(z.string()),
  originalScheduledAt: isoDateTime.nullable(),
  noUrlReason: z.string().nullable(),
  sourceNote: z.string().nullable(),
  failureReason: z.string().nullable(),
  cancelReason: z.string().nullable(),
  overrideReason: z.string().nullable(),
  availabilityChangedAt: isoDateTime.nullable(),
  availabilityReason: z.string().nullable(),
  confirmedBy: memberRef.nullable(),
  /** Internal caption limit configured on the account (the platform itself is checked manually). */
  captionLimit: z.number().int().nullable(),
  checkpoints: z.array(publicationCheckpoint),
  planRevisions: z.array(publicationPlanRevision),
  corrections: z.array(publicationCorrection),
  trackingLinks: z.array(z.object({ id: uuid, label: z.string(), builtUrl: z.string(), campaignId: uuid })),
  experiments: z.array(z.object({ id: uuid, hypothesis: z.string(), variantName: z.string(), segment: z.enum(METRIC_SEGMENTS) })),
  tasks: z.array(z.object({ id: uuid, title: z.string(), status: z.enum(TASK_STATUSES), dueAt: isoDateTime.nullable(), assignee: memberRef.nullable() })),
  /** Transitions the current state allows (the server re-checks every gate). */
  allowedActions: z.array(z.enum(['schedule', 'reschedule', 'markPublished', 'fail', 'cancel', 'retry', 'correct', 'setAvailability'])),
  permissions: z.object({
    update: z.boolean(),
    schedule: z.boolean(),
    confirm: z.boolean(),
    correct: z.boolean(),
    overrideAccountStatus: z.boolean(),
    archive: z.boolean(),
    addMetrics: z.boolean(),
  }),
});
export type PublicationDetail = z.infer<typeof publicationDetail>;

export const publicationSort = z.enum(['when', 'updatedAt']);

const publicationListQuery = pageQuery.extend({
  q: z.string().trim().max(120).optional(),
  projectId: uuid.optional(),
  accountId: uuid.optional(),
  campaignId: uuid.optional(),
  contentItemId: uuid.optional(),
  episodeId: uuid.optional(),
  dealId: uuid.optional(),
  ownerMembershipId: uuid.optional(),
  status: csv(z.enum(PUBLICATION_STATUSES)).optional(),
  availability: csv(z.enum(PUBLICATION_AVAILABILITY)).optional(),
  platform: csv(z.enum(PLATFORMS)).optional(),
  /** Planned or actual time window (half-open), UTC boundaries computed by the client from its period. */
  from: isoDateTime.optional(),
  to: isoDateTime.optional(),
  includeArchived: boolQuery.optional(),
  sort: publicationSort.default('when'),
  direction: z.enum(['asc', 'desc']).default('desc'),
});

const publicationFields = {
  contentVersionId: uuid.nullable().optional(),
  ownerMembershipId: uuid,
  caption: caption.nullable().optional(),
  cta: optionalText(500),
  destinationUrl: httpsUrl.nullable().optional(),
  primaryCampaignId: uuid.nullable().optional(),
  descriptiveTags: tags.optional(),
};

export const publicationScheduleGate = z.object({ code: z.string(), message: z.string() });
export const publicationSchedulePreview = z.object({
  /** True when Schedule would succeed with the given input (overrides included). */
  allowed: z.boolean(),
  /** Hard stops (unapproved version, archived account, past time…). */
  blockers: z.array(publicationScheduleGate),
  /** Gates a lead may override with a reason (Preparing/Paused/Restricted account). */
  overridable: z.array(publicationScheduleGate),
  warnings: z.array(publicationScheduleGate),
  /** Other placements on the same account within 15 minutes. */
  conflicts: z.array(z.object({ publicationId: uuid, title: z.string(), scheduledAt: isoDateTime, status: z.enum(PUBLICATION_STATUSES) })),
  canOverride: z.boolean(),
  /** Rescheduling an already scheduled placement records a plan revision and needs a reason. */
  requiresReason: z.boolean(),
  /** Frozen weekly plans touched by the move; their original rows are kept (M09). */
  baselines: z.array(z.object({ weekStart: isoDate, effect: z.enum(['kept_in_original_week', 'added_after_baseline']) })),
  localTime: z.string(),
  timezone: z.string(),
});
export type PublicationSchedulePreview = z.infer<typeof publicationSchedulePreview>;

const scheduleBody = z.object({
  scheduledAt: isoDateTime,
  timezone,
  contentVersionId: uuid.optional(),
  reason: reason.optional(),
  accountOverrideReason: reason.optional(),
  conflictOverrideReason: reason.optional(),
});

export const publicationContentOption = z.object({
  id: uuid,
  title: z.string(),
  format: z.enum(CONTENT_FORMATS),
  stage: z.enum(CONTENT_STAGES),
  approvedVersion: z.object({ id: uuid, versionNo: z.number().int(), approvedAt: isoDateTime }).nullable(),
  latestVersionNo: z.number().int().nullable(),
});
export type PublicationContentOption = z.infer<typeof publicationContentOption>;

export const publicationContentVersion = z.object({
  id: uuid,
  versionNo: z.number().int(),
  note: z.string().nullable(),
  submittedAt: isoDateTime.nullable(),
  approvedAt: isoDateTime.nullable(),
  approvalRevokedAt: isoDateTime.nullable(),
  approved: z.boolean(),
});

export const publicationEndpoints = {
  list: endpoint({
    id: 'publications.list',
    method: 'GET',
    path: '/workspaces/{workspaceId}/publications',
    summary: 'Placements in the actor’s scope (project/account/campaign/content/episode/deal filters, keyset pages).',
    tags: ['Publications'],
    auth: 'workspace',
    permission: 'publications.read',
    params: wsId({}),
    query: publicationListQuery,
    response: page(publicationRow),
  }),
  due: endpoint({
    id: 'publications.due',
    method: 'GET',
    path: '/workspaces/{workspaceId}/publication-queue/due',
    summary: 'My Work: the member’s scheduled placements for the next 7 days and those awaiting confirmation.',
    tags: ['Publications'],
    auth: 'workspace',
    params: wsId({}),
    query: z.object({ limit: z.coerce.number().int().min(1).max(100).default(30) }),
    response: z.object({ items: z.array(publicationRow), total: z.number().int(), awaitingConfirmation: z.number().int(), canRead: z.boolean() }),
  }),
  contentOptions: endpoint({
    id: 'publications.contentOptions',
    method: 'GET',
    path: '/workspaces/{workspaceId}/publication-queue/content-options',
    summary: 'Content of the account’s project that can be placed on it (approved version shown when present).',
    tags: ['Publications'],
    auth: 'workspace',
    permission: 'publications.write',
    params: wsId({}),
    query: z.object({ accountId: uuid, q: z.string().trim().max(120).optional(), ids: csv(uuid).optional(), limit: z.coerce.number().int().min(1).max(50).default(20) }),
    response: z.array(publicationContentOption),
  }),
  contentVersions: endpoint({
    id: 'publications.contentVersions',
    method: 'GET',
    path: '/workspaces/{workspaceId}/publication-queue/content-versions',
    summary: 'Versions of a content item for pinning on a placement; only approved, non-revoked versions can be scheduled.',
    tags: ['Publications'],
    auth: 'workspace',
    permission: 'publications.write',
    params: wsId({}),
    query: z.object({ contentItemId: uuid, accountId: uuid }),
    response: z.array(publicationContentVersion),
  }),
  get: endpoint({
    id: 'publications.get',
    method: 'GET',
    path: '/workspaces/{workspaceId}/publications/{publicationId}',
    summary: 'Publication detail with checkpoints, plan revisions, corrections and allowed actions.',
    tags: ['Publications'],
    auth: 'workspace',
    permission: 'publications.read',
    params: wsId({ publicationId: uuid }),
    response: publicationDetail,
  }),
  create: endpoint({
    id: 'publications.create',
    method: 'POST',
    path: '/workspaces/{workspaceId}/publications',
    summary: 'Save a Draft placement (one account per record); with schedule=true the Schedule gates run in the same transaction.',
    tags: ['Publications'],
    auth: 'workspace',
    permission: 'publications.write',
    idempotent: true,
    params: wsId({}),
    body: z.object({
      contentItemId: uuid,
      accountId: uuid,
      ...publicationFields,
      scheduledAt: isoDateTime.nullable().optional(),
      timezone: timezone.optional(),
      schedule: z.boolean().optional(),
      accountOverrideReason: reason.optional(),
      conflictOverrideReason: reason.optional(),
    }),
    response: publicationDetail,
    successStatus: 201,
  }),
  createHistorical: endpoint({
    id: 'publications.createHistorical',
    method: 'POST',
    path: '/workspaces/{workspaceId}/publications/historical',
    summary: 'Record a placement that was already published (past date, source note required); creates its checkpoints.',
    tags: ['Publications'],
    auth: 'workspace',
    permission: 'publications.confirm',
    idempotent: true,
    params: wsId({}),
    body: z.object({
      contentItemId: uuid,
      accountId: uuid,
      ...publicationFields,
      actualPublishedAt: isoDateTime,
      externalUrl: httpsUrl.optional(),
      noUrlReason: noUrlReason.optional(),
      sourceNote: z.string().trim().min(3).max(2000),
    }),
    response: publicationDetail,
    successStatus: 201,
  }),
  update: endpoint({
    id: 'publications.update',
    method: 'PATCH',
    path: '/workspaces/{workspaceId}/publications/{publicationId}',
    summary: 'Edit a Draft/Scheduled/Failed placement. Status and scheduled time change only through commands.',
    tags: ['Publications'],
    auth: 'workspace',
    permission: 'publications.write',
    ifMatch: true,
    params: wsId({ publicationId: uuid }),
    body: z.object({
      ...publicationFields,
      ownerMembershipId: uuid.optional(),
      accountId: uuid.optional(),
      contentItemId: uuid.optional(),
      /** Tentative time of a Draft (a Scheduled placement is moved with Schedule). */
      scheduledAt: isoDateTime.nullable().optional(),
      timezone: timezone.optional(),
    }),
    response: publicationDetail,
  }),
  schedulePreview: endpoint({
    id: 'publications.schedulePreview',
    method: 'GET',
    path: '/workspaces/{workspaceId}/publications/{publicationId}/schedule-preview',
    summary: 'Dry run of Schedule/Reschedule: gates, overridable account status, 15-minute conflicts and baseline effects.',
    tags: ['Publications'],
    auth: 'workspace',
    permission: 'publications.write',
    params: wsId({ publicationId: uuid }),
    query: z.object({ scheduledAt: isoDateTime, timezone, contentVersionId: uuid.optional() }),
    response: publicationSchedulePreview,
  }),
  schedule: endpoint({
    id: 'publications.schedule',
    method: 'POST',
    path: '/workspaces/{workspaceId}/publications/{publicationId}/schedule',
    summary: 'Schedule (Draft/Failed → Scheduled) or reschedule with a plan revision. Requires an approved version and a future time.',
    tags: ['Publications'],
    auth: 'workspace',
    permission: 'publications.write',
    idempotent: true,
    ifMatch: true,
    params: wsId({ publicationId: uuid }),
    body: scheduleBody,
    response: publicationDetail,
  }),
  markPublished: endpoint({
    id: 'publications.markPublished',
    method: 'POST',
    path: '/workspaces/{workspaceId}/publications/{publicationId}/mark-published',
    summary: 'Confirm the external post: actual time and HTTPS post URL (or a 10–500 character reason). Creates checkpoints once.',
    tags: ['Publications'],
    auth: 'workspace',
    permission: 'publications.confirm',
    idempotent: true,
    ifMatch: true,
    params: wsId({ publicationId: uuid }),
    body: z.object({ actualPublishedAt: isoDateTime, externalUrl: httpsUrl.optional(), noUrlReason: noUrlReason.optional() }),
    response: publicationDetail,
  }),
  fail: endpoint({
    id: 'publications.fail',
    method: 'POST',
    path: '/workspaces/{workspaceId}/publications/{publicationId}/fail',
    summary: 'Mark a scheduled placement Failed with a reason. No statistics are created.',
    tags: ['Publications'],
    auth: 'workspace',
    permission: 'publications.confirm',
    idempotent: true,
    ifMatch: true,
    params: wsId({ publicationId: uuid }),
    body: z.object({ reason }),
    response: publicationDetail,
  }),
  cancel: endpoint({
    id: 'publications.cancel',
    method: 'POST',
    path: '/workspaces/{workspaceId}/publications/{publicationId}/cancel',
    summary: 'Cancel a scheduled or failed placement with a reason; frozen plans keep the row with the reason.',
    tags: ['Publications'],
    auth: 'workspace',
    permission: 'publications.write',
    idempotent: true,
    ifMatch: true,
    params: wsId({ publicationId: uuid }),
    body: z.object({ reason }),
    response: publicationDetail,
  }),
  correct: endpoint({
    id: 'publications.correct',
    method: 'POST',
    path: '/workspaces/{workspaceId}/publications/{publicationId}/correct',
    summary: 'Historical correction of a published placement with a reason (before/after kept). Completed observations are never moved.',
    tags: ['Publications'],
    auth: 'workspace',
    permission: 'publications.correct',
    idempotent: true,
    ifMatch: true,
    params: wsId({ publicationId: uuid }),
    body: z.object({
      changes: z.object({
        actualPublishedAt: isoDateTime.optional(),
        externalUrl: httpsUrl.nullable().optional(),
        noUrlReason: noUrlReason.nullable().optional(),
        caption: caption.nullable().optional(),
        primaryCampaignId: uuid.nullable().optional(),
        contentVersionId: uuid.optional(),
      }),
      reason,
      /** Move pending (not completed) checkpoints to the corrected publication time. */
      recalculateCheckpoints: z.boolean().optional(),
    }),
    response: publicationDetail,
  }),
  setAvailability: endpoint({
    id: 'publications.setAvailability',
    method: 'POST',
    path: '/workspaces/{workspaceId}/publications/{publicationId}/availability',
    summary: 'Record that a published post was removed/became unavailable (or is available again). Status and facts stay.',
    tags: ['Publications'],
    auth: 'workspace',
    permission: 'publications.confirm',
    idempotent: true,
    ifMatch: true,
    params: wsId({ publicationId: uuid }),
    body: z.object({ availability: z.enum(PUBLICATION_AVAILABILITY), effectiveAt: isoDateTime.optional(), reason }),
    response: publicationDetail,
  }),
  archive: endpoint({
    id: 'publications.archive',
    method: 'POST',
    path: '/workspaces/{workspaceId}/publications/{publicationId}/archive',
    summary: 'Hide a published, failed or cancelled placement from active lists; history and reports keep it.',
    tags: ['Publications'],
    auth: 'workspace',
    permission: 'publications.write',
    idempotent: true,
    ifMatch: true,
    params: wsId({ publicationId: uuid }),
    body: z.object({ reason: reason.optional() }),
    response: publicationDetail,
  }),
  activity: endpoint({
    id: 'publications.activity',
    method: 'GET',
    path: '/workspaces/{workspaceId}/publications/{publicationId}/activity',
    summary: 'Meaningful history of the placement (audit, sensitive categories excluded).',
    tags: ['Publications'],
    auth: 'workspace',
    permission: 'publications.read',
    params: wsId({ publicationId: uuid }),
    query: pageQuery,
    response: page(
      z.object({
        id: uuid,
        action: z.string(),
        actorName: z.string().nullable(),
        occurredAt: isoDateTime,
        reason: z.string().nullable(),
        changes: z.array(z.object({ field: z.string(), from: z.unknown().optional(), to: z.unknown().optional() })),
      }),
    ),
  }),
};

// ——— Calendar (S31) ———

export const CALENDAR_LAYERS = ['publications', 'tasks', 'milestones', 'shifts'] as const;
export type CalendarLayer = (typeof CALENDAR_LAYERS)[number];

export const calendarEvent = z.object({
  /** `${type}:${entityId}` */
  key: z.string(),
  type: z.enum(['publication', 'task', 'milestone', 'shift']),
  entityId: uuid,
  title: z.string(),
  /** Moment events (publications, timed task deadlines, shifts). */
  start: isoDateTime.nullable(),
  end: isoDateTime.nullable(),
  /** Calendar-day events (milestones, date-only deadlines) are not shifted by time zones. */
  date: isoDate.nullable(),
  status: z.string(),
  project: ref.nullable(),
  account: z.object({ id: uuid, label: z.string(), platform: z.enum(PLATFORMS) }).nullable(),
  member: memberRef.nullable(),
  /** Placement within 15 minutes of another on the same account. */
  conflict: z.boolean(),
  awaitingConfirmation: z.boolean(),
  overdue: z.boolean(),
  /** Placement that can be moved with Reschedule (Draft/Scheduled/Failed and permitted). */
  canReschedule: z.boolean(),
  /** Published placement whose actual time may be corrected (never by dragging the plan). */
  canCorrect: z.boolean(),
  rowVersion: z.number().int().nullable(),
  timezone: z.string().nullable(),
  href: z.string(),
});
export type CalendarEvent = z.infer<typeof calendarEvent>;

export const calendarEndpoints = {
  get: endpoint({
    id: 'calendar.get',
    method: 'GET',
    path: '/workspaces/{workspaceId}/calendar',
    summary: 'Publications, task deadlines, project milestones and shifts in a window, each layer scoped by its own permission.',
    tags: ['Calendar'],
    auth: 'workspace',
    params: wsId({}),
    query: z.object({
      from: isoDateTime,
      to: isoDateTime,
      layers: csv(z.enum(CALENDAR_LAYERS)).optional(),
      projectId: uuid.optional(),
      accountId: uuid.optional(),
      platform: csv(z.enum(PLATFORMS)).optional(),
      status: csv(z.enum(PUBLICATION_STATUSES)).optional(),
      memberId: uuid.optional(),
    }),
    response: z.object({
      from: isoDateTime,
      to: isoDateTime,
      events: z.array(calendarEvent),
      /** Layers the member may see (others are omitted, never shown as empty). */
      layers: z.record(z.enum(CALENDAR_LAYERS), z.boolean()),
      truncated: z.boolean(),
    }),
  }),
};

// ——— Plan baselines (§12, M09/M10) ———

export const planBaselineItem = z.object({
  publicationId: uuid,
  title: z.string(),
  account: z.object({ id: uuid, label: z.string(), platform: z.enum(PLATFORMS) }),
  project: ref,
  status: z.enum(PUBLICATION_STATUSES),
  baselineScheduledAt: isoDateTime.nullable(),
  currentScheduledAt: isoDateTime.nullable(),
  actualPublishedAt: isoDateTime.nullable(),
  addedAfterBaseline: z.boolean(),
  removedAfterBaselineAt: isoDateTime.nullable(),
  removalReason: z.string().nullable(),
  /** The current schedule left the frozen week (the original row stays in its week). */
  movedOutOfWeek: z.boolean(),
  /** Published no later than baseline + grace (null while not published / not in the baseline). */
  onTimeAgainstBaseline: z.boolean().nullable(),
});
export type PlanBaselineItem = z.infer<typeof planBaselineItem>;

export const planBaselineWeek = z.object({
  weekStart: isoDate,
  weekEnd: isoDate,
  timezone: z.string(),
  graceMinutes: z.number().int(),
  baseline: z.object({ id: uuid, frozenAt: isoDateTime }).nullable(),
  /** Original Plan: rows frozen at the start of the week (plus Added After Baseline rows). */
  original: z.array(planBaselineItem),
  /** Current Plan: placements whose current time falls in the week. */
  current: z.array(publicationRow),
  canFreeze: z.boolean(),
});
export type PlanBaselineWeek = z.infer<typeof planBaselineWeek>;

export const planBaselineEndpoints = {
  week: endpoint({
    id: 'planBaselines.week',
    method: 'GET',
    path: '/workspaces/{workspaceId}/plan-baselines/week',
    summary: 'Original (frozen) and current plan of one week, scoped to the member’s placements.',
    tags: ['Publications'],
    auth: 'workspace',
    permission: 'publications.read',
    params: wsId({}),
    query: z.object({ weekStart: isoDate, projectId: uuid.optional(), accountId: uuid.optional() }),
    response: planBaselineWeek,
  }),
  freeze: endpoint({
    id: 'planBaselines.freeze',
    method: 'POST',
    path: '/workspaces/{workspaceId}/plan-baselines/freeze',
    summary: 'Freeze the current week’s plan when the automatic Monday freeze has not run yet (never a past week).',
    tags: ['Publications'],
    auth: 'workspace',
    permission: 'publications.correct',
    idempotent: true,
    params: wsId({}),
    body: z.object({ weekStart: isoDate }),
    response: planBaselineWeek,
  }),
};

// ——— Campaigns (S33–S34) ———

export const CAMPAIGN_GOAL_UNITS = ['count', 'percent', 'money', 'other'] as const;
export const campaignGoal = z.object({ metricKey: z.string().trim().min(2).max(80), target: z.string().trim().min(1).max(40), unit: z.string().trim().min(1).max(20) });

export const campaignRow = z.object({
  id: uuid,
  name: z.string(),
  objective: z.string(),
  owner: memberRef,
  startDate: isoDate,
  endDate: isoDate,
  status: z.enum(CAMPAIGN_STATUSES),
  projects: z.array(ref),
  partner: ref.nullable(),
  tags: z.array(z.string()),
  coverUrl: z.string().nullable(),
  publications: z.object({ planned: z.number().int(), published: z.number().int() }),
  /** Sums of source-reported values only; null when no report carries the value (never 0 by default). */
  confirmedResults: z.object({ clicks: z.string().nullable(), conversions: z.string().nullable(), reports: z.number().int() }),
  /** Approved campaign budget; present only with budgets.read on the campaign’s projects (omitted otherwise). */
  budget: z.object({ planned: money, periodStart: isoDate, periodEnd: isoDate }).nullable().optional(),
  closedAt: isoDateTime.nullable(),
  archivedAt: isoDateTime.nullable(),
  updatedAt: isoDateTime,
  rowVersion: z.number().int(),
});
export type CampaignRow = z.infer<typeof campaignRow>;

export const campaignDetail = campaignRow.extend({
  goals: z.array(campaignGoal),
  closingSummary: z.string().nullable(),
  duplicatedFrom: ref.nullable(),
  coverAssetId: uuid.nullable(),
  deals: z.array(z.object({ id: uuid, title: z.string(), stage: z.string(), partnerName: z.string() })),
  counts: z.object({ trackingLinks: z.number().int(), sourceReports: z.number().int(), experiments: z.number().int() }),
  allowedTransitions: z.array(z.enum(CAMPAIGN_STATUSES)),
  permissions: z.object({
    update: z.boolean(),
    transition: z.boolean(),
    manageLinks: z.boolean(),
    manageReports: z.boolean(),
    linkDeal: z.boolean(),
    readCosts: z.boolean(),
    allocateCosts: z.boolean(),
    createPublication: z.boolean(),
    archive: z.boolean(),
  }),
});
export type CampaignDetail = z.infer<typeof campaignDetail>;

const campaignFields = {
  name: shortName,
  objective: z.string().trim().min(3).max(2000),
  ownerMembershipId: uuid,
  startDate: isoDate,
  endDate: isoDate,
  projectIds: z.array(uuid).min(1).max(50),
  partnerId: uuid.nullable().optional(),
  goals: z.array(campaignGoal).max(20).optional(),
  tags: tags.optional(),
  coverAssetId: uuid.nullable().optional(),
};

export const campaignSourceValue = z.object({
  value: z.string().nullable(),
  /** Why no value is shown (no report, overlapping periods, …). */
  note: z.string().nullable(),
});

export const campaignResults = z.object({
  publications: z.record(z.enum(PUBLICATION_STATUSES), z.number().int()),
  removedOrUnavailable: z.number().int(),
  sources: z.array(
    z.object({
      sourceName: z.string(),
      attributionLabel: z.enum(ATTRIBUTION_TYPES),
      reports: z.number().int(),
      clicks: campaignSourceValue,
      conversions: campaignSourceValue,
      /** conversions / clicks × 100 for the same source when both are known. */
      conversionRate: campaignSourceValue,
      overlapping: z.boolean(),
      periodStart: isoDateTime,
      periodEnd: isoDateTime,
    }),
  ),
  totals: z.object({ clicks: campaignSourceValue, conversions: campaignSourceValue }),
  goals: z.array(campaignGoal),
  trackingLinks: z.number().int(),
});
export type CampaignResults = z.infer<typeof campaignResults>;

export const campaignCostLine = z.object({
  lineId: uuid,
  entryId: uuid,
  entryTitle: z.string(),
  entryState: z.string(),
  recognitionDate: isoDate,
  category: z.string(),
  amount: money,
  allocations: z.array(z.object({ id: uuid, project: ref.nullable(), amount: money, sharePercent: z.string().nullable() })),
  /** Amount of the line attributed to this campaign (sum of its allocations, or the full line when not yet allocated). */
  campaignAmount: money,
  unallocated: money.nullable(),
  canAllocate: z.boolean(),
});
export type CampaignCostLine = z.infer<typeof campaignCostLine>;

export const campaignCosts = z.object({
  totals: z.array(z.object({ currency: z.string(), posted: z.string(), pending: z.string() })),
  lines: z.array(campaignCostLine),
  incompleteAllocation: z.boolean(),
  note: z.string(),
});
export type CampaignCosts = z.infer<typeof campaignCosts>;

export const campaignEndpoints = {
  list: endpoint({
    id: 'campaigns.list',
    method: 'GET',
    path: '/workspaces/{workspaceId}/campaigns',
    summary: 'Campaigns visible through any of their projects (or owned). Archived hidden by default.',
    tags: ['Campaigns'],
    auth: 'workspace',
    permission: 'campaigns.read',
    params: wsId({}),
    query: pageQuery.extend({
      q: z.string().trim().max(120).optional(),
      status: csv(z.enum(CAMPAIGN_STATUSES)).optional(),
      projectId: uuid.optional(),
      ownerMembershipId: uuid.optional(),
      partnerId: uuid.optional(),
      activeOn: isoDate.optional(),
      includeArchived: boolQuery.optional(),
      sort: z.enum(['startDate', 'name', 'updatedAt']).default('startDate'),
      direction: z.enum(['asc', 'desc']).default('desc'),
    }),
    response: page(campaignRow),
  }),
  get: endpoint({
    id: 'campaigns.get',
    method: 'GET',
    path: '/workspaces/{workspaceId}/campaigns/{campaignId}',
    summary: 'Campaign workspace header: objective, projects, goals, deals, counts and allowed actions.',
    tags: ['Campaigns'],
    auth: 'workspace',
    permission: 'campaigns.read',
    params: wsId({ campaignId: uuid }),
    response: campaignDetail,
  }),
  create: endpoint({
    id: 'campaigns.create',
    method: 'POST',
    path: '/workspaces/{workspaceId}/campaigns',
    summary: 'Create a Planned campaign. No accounts, metrics, costs or results are created.',
    tags: ['Campaigns'],
    auth: 'workspace',
    permission: 'campaigns.write',
    idempotent: true,
    params: wsId({}),
    body: z.object(campaignFields),
    response: campaignDetail,
    successStatus: 201,
  }),
  update: endpoint({
    id: 'campaigns.update',
    method: 'PATCH',
    path: '/workspaces/{workspaceId}/campaigns/{campaignId}',
    summary: 'Edit campaign fields and project links.',
    tags: ['Campaigns'],
    auth: 'workspace',
    permission: 'campaigns.write',
    ifMatch: true,
    params: wsId({ campaignId: uuid }),
    body: z.object(campaignFields).partial(),
    response: campaignDetail,
  }),
  transition: endpoint({
    id: 'campaigns.transition',
    method: 'POST',
    path: '/workspaces/{workspaceId}/campaigns/{campaignId}/transition',
    summary: 'Start, Close (with summary) or Reopen (with reason) a campaign.',
    tags: ['Campaigns'],
    auth: 'workspace',
    permission: 'campaigns.write',
    idempotent: true,
    ifMatch: true,
    params: wsId({ campaignId: uuid }),
    body: z.object({ targetStatus: z.enum(CAMPAIGN_STATUSES), closingSummary: z.string().trim().min(3).max(5000).optional(), reason: reason.optional() }),
    response: campaignDetail,
  }),
  duplicate: endpoint({
    id: 'campaigns.duplicate',
    method: 'POST',
    path: '/workspaces/{workspaceId}/campaigns/{campaignId}/duplicate',
    summary: 'Duplicate Structure: a new Planned campaign without costs, income, placements or results.',
    tags: ['Campaigns'],
    auth: 'workspace',
    permission: 'campaigns.write',
    idempotent: true,
    params: wsId({ campaignId: uuid }),
    body: z.object({ name: shortName, startDate: isoDate, endDate: isoDate, copyTrackingLinks: z.boolean().optional() }),
    response: campaignDetail,
    successStatus: 201,
  }),
  linkDeal: endpoint({
    id: 'campaigns.linkDeal',
    method: 'POST',
    path: '/workspaces/{workspaceId}/campaigns/{campaignId}/link-deal',
    summary: 'Link a partnership deal to the campaign (explicit relation, no amounts copied).',
    tags: ['Campaigns'],
    auth: 'workspace',
    permission: 'campaigns.write',
    idempotent: true,
    params: wsId({ campaignId: uuid }),
    body: z.object({ dealId: uuid, unlink: z.boolean().optional() }),
    response: campaignDetail,
  }),
  results: endpoint({
    id: 'campaigns.results',
    method: 'GET',
    path: '/workspaces/{workspaceId}/campaigns/{campaignId}/results',
    summary: 'Placements by status and source-reported clicks/conversions (never generated from tagged links).',
    tags: ['Campaigns'],
    auth: 'workspace',
    permission: 'campaigns.read',
    params: wsId({ campaignId: uuid }),
    response: campaignResults,
  }),
  costs: endpoint({
    id: 'campaigns.costs',
    method: 'GET',
    path: '/workspaces/{workspaceId}/campaigns/{campaignId}/costs',
    summary: 'Expense lines attributed to the campaign through finance allocations (each allocation counted once).',
    tags: ['Campaigns'],
    auth: 'workspace',
    permission: 'finance.read',
    params: wsId({ campaignId: uuid }),
    response: campaignCosts,
  }),
  allocateCost: endpoint({
    id: 'campaigns.allocateCost',
    method: 'POST',
    path: '/workspaces/{workspaceId}/campaigns/{campaignId}/cost-allocations',
    summary: 'Split one expense line across the campaign’s projects; allocations sum exactly to the line amount.',
    tags: ['Campaigns'],
    auth: 'workspace',
    permission: 'finance.allocate',
    idempotent: true,
    params: wsId({ campaignId: uuid }),
    body: z.object({
      lineId: uuid,
      method: z.enum(['equal', 'weights', 'amounts']),
      shares: z
        .array(z.object({ projectId: uuid, weight: z.string().regex(/^\d{1,6}(\.\d{1,4})?$/).optional(), amount: z.string().regex(/^\d{1,15}(\.\d{1,3})?$/).optional() }))
        .min(1)
        .max(50),
      reason: reason.optional(),
    }),
    response: campaignCosts,
  }),
  activity: endpoint({
    id: 'campaigns.activity',
    method: 'GET',
    path: '/workspaces/{workspaceId}/campaigns/{campaignId}/activity',
    summary: 'Campaign history (links, reports, transitions; finance amounts excluded).',
    tags: ['Campaigns'],
    auth: 'workspace',
    permission: 'campaigns.read',
    params: wsId({ campaignId: uuid }),
    query: pageQuery,
    response: page(
      z.object({
        id: uuid,
        action: z.string(),
        actorName: z.string().nullable(),
        occurredAt: isoDateTime,
        reason: z.string().nullable(),
        changes: z.array(z.object({ field: z.string(), from: z.unknown().optional(), to: z.unknown().optional() })),
      }),
    ),
  }),
  archive: endpoint({
    id: 'campaigns.archive',
    method: 'POST',
    path: '/workspaces/{workspaceId}/campaigns/{campaignId}/archive',
    summary: 'Archive a planned or closed campaign (history and reports keep it).',
    tags: ['Campaigns'],
    auth: 'workspace',
    permission: 'campaigns.write',
    idempotent: true,
    ifMatch: true,
    params: wsId({ campaignId: uuid }),
    body: z.object({ reason: reason.optional() }),
    response: campaignDetail,
  }),
  restore: endpoint({
    id: 'campaigns.restore',
    method: 'POST',
    path: '/workspaces/{workspaceId}/campaigns/{campaignId}/restore',
    summary: 'Restore an archived campaign as Closed.',
    tags: ['Campaigns'],
    auth: 'workspace',
    permission: 'campaigns.write',
    idempotent: true,
    ifMatch: true,
    params: wsId({ campaignId: uuid }),
    response: campaignDetail,
  }),
};

// ——— Campaign source reports ———

export const sourceReportRow = z.object({
  id: uuid,
  campaignId: uuid,
  sourceName: z.string(),
  periodStart: isoDateTime,
  periodEnd: isoDateTime,
  clicks: z.number().int().nullable(),
  conversions: z.number().int().nullable(),
  attributionLabel: z.enum(ATTRIBUTION_TYPES),
  trackingLink: z.object({ id: uuid, label: z.string() }).nullable(),
  evidenceAssetId: uuid.nullable(),
  note: z.string().nullable(),
  enteredBy: memberRef.nullable(),
  createdAt: isoDateTime,
  rowVersion: z.number().int(),
});
export type SourceReportRow = z.infer<typeof sourceReportRow>;

const sourceReportFields = {
  sourceName: z.string().trim().min(2).max(120),
  periodStart: isoDateTime,
  periodEnd: isoDateTime,
  clicks: z.number().int().min(0).max(9_000_000_000_000).nullable().optional(),
  conversions: z.number().int().min(0).max(9_000_000_000_000).nullable().optional(),
  attributionLabel: z.enum(ATTRIBUTION_TYPES),
  trackingLinkId: uuid.nullable().optional(),
  evidenceAssetId: uuid.nullable().optional(),
  note: z.string().trim().max(2000).nullable().optional(),
};

export const sourceReportEndpoints = {
  list: endpoint({
    id: 'campaigns.sourceReports',
    method: 'GET',
    path: '/workspaces/{workspaceId}/campaigns/{campaignId}/source-reports',
    summary: 'Externally reported clicks/conversions entered for the campaign.',
    tags: ['Campaigns'],
    auth: 'workspace',
    permission: 'campaigns.read',
    params: wsId({ campaignId: uuid }),
    response: z.array(sourceReportRow),
  }),
  create: endpoint({
    id: 'campaigns.createSourceReport',
    method: 'POST',
    path: '/workspaces/{workspaceId}/campaigns/{campaignId}/source-reports',
    summary: 'Add Source Report: a period, the reported values (empty = not reported) and an attribution label.',
    tags: ['Campaigns'],
    auth: 'workspace',
    permission: 'campaigns.write',
    idempotent: true,
    params: wsId({ campaignId: uuid }),
    body: z.object(sourceReportFields),
    response: sourceReportRow,
    successStatus: 201,
  }),
  update: endpoint({
    id: 'campaigns.updateSourceReport',
    method: 'PATCH',
    path: '/workspaces/{workspaceId}/campaign-source-reports/{reportId}',
    summary: 'Correct a source report (audited).',
    tags: ['Campaigns'],
    auth: 'workspace',
    permission: 'campaigns.write',
    ifMatch: true,
    params: wsId({ reportId: uuid }),
    body: z.object(sourceReportFields).partial().extend({ reason }),
    response: sourceReportRow,
  }),
};

// ——— Tracking links ———

export const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'] as const;
const utmValue = z.string().trim().min(1).max(200);
export const utmFields = z.object({
  utmSource: utmValue.nullable().optional(),
  utmMedium: utmValue.nullable().optional(),
  utmCampaign: utmValue.nullable().optional(),
  utmContent: utmValue.nullable().optional(),
  utmTerm: utmValue.nullable().optional(),
});

export const trackingLinkRow = z.object({
  id: uuid,
  campaign: ref,
  label: z.string(),
  destinationUrl: z.string(),
  utmSource: z.string().nullable(),
  utmMedium: z.string().nullable(),
  utmCampaign: z.string().nullable(),
  utmContent: z.string().nullable(),
  utmTerm: z.string().nullable(),
  builtUrl: z.string(),
  publication: z.object({ id: uuid, title: z.string() }).nullable(),
  /** Sum of clicks from source reports that reference this link; null when none report clicks. */
  reportedClicks: z.string().nullable(),
  archivedAt: isoDateTime.nullable(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
  rowVersion: z.number().int(),
});
export type TrackingLinkRow = z.infer<typeof trackingLinkRow>;

export const trackingLinkPreview = z.object({
  valid: z.boolean(),
  url: z.string().nullable(),
  /** Parameters already present on the destination with a different value. */
  conflicts: z.array(z.object({ key: z.string(), existing: z.string(), proposed: z.string() })),
  message: z.string().nullable(),
});

const trackingLinkFields = utmFields.extend({
  label: shortName,
  destinationUrl: httpsUrl,
  publicationId: uuid.nullable().optional(),
  /** Required to replace UTM parameters that already exist on the destination with other values. */
  overwriteConflicts: z.boolean().optional(),
});

export const trackingLinkEndpoints = {
  list: endpoint({
    id: 'trackingLinks.list',
    method: 'GET',
    path: '/workspaces/{workspaceId}/tracking-links',
    summary: 'Tagged links of the campaigns the member can read.',
    tags: ['Campaigns'],
    auth: 'workspace',
    permission: 'campaigns.read',
    params: wsId({}),
    query: z.object({ campaignId: uuid.optional(), publicationId: uuid.optional(), q: z.string().trim().max(120).optional(), includeArchived: boolQuery.optional() }),
    response: z.array(trackingLinkRow),
  }),
  get: endpoint({
    id: 'trackingLinks.get',
    method: 'GET',
    path: '/workspaces/{workspaceId}/tracking-links/{linkId}',
    summary: 'One tagged link.',
    tags: ['Campaigns'],
    auth: 'workspace',
    permission: 'campaigns.read',
    params: wsId({ linkId: uuid }),
    response: trackingLinkRow,
  }),
  preview: endpoint({
    id: 'trackingLinks.preview',
    method: 'GET',
    path: '/workspaces/{workspaceId}/tracking-link-preview',
    summary: 'Build Tagged URL preview (URL-encoded parameters; existing different values reported, not overwritten).',
    tags: ['Campaigns'],
    auth: 'workspace',
    permission: 'campaigns.read',
    params: wsId({}),
    query: utmFields.extend({ destinationUrl: z.string().max(LIMITS.urlMax) }),
    response: trackingLinkPreview,
  }),
  create: endpoint({
    id: 'trackingLinks.create',
    method: 'POST',
    path: '/workspaces/{workspaceId}/campaigns/{campaignId}/tracking-links',
    summary: 'Save a tagged link for the campaign. Creating it records no clicks or conversions.',
    tags: ['Campaigns'],
    auth: 'workspace',
    permission: 'campaigns.write',
    idempotent: true,
    params: wsId({ campaignId: uuid }),
    body: trackingLinkFields,
    response: trackingLinkRow,
    successStatus: 201,
  }),
  update: endpoint({
    id: 'trackingLinks.update',
    method: 'PATCH',
    path: '/workspaces/{workspaceId}/tracking-links/{linkId}',
    summary: 'Edit a tagged link (the URL is rebuilt).',
    tags: ['Campaigns'],
    auth: 'workspace',
    permission: 'campaigns.write',
    ifMatch: true,
    params: wsId({ linkId: uuid }),
    body: trackingLinkFields.partial(),
    response: trackingLinkRow,
  }),
  archive: endpoint({
    id: 'trackingLinks.archive',
    method: 'POST',
    path: '/workspaces/{workspaceId}/tracking-links/{linkId}/archive',
    summary: 'Archive (or restore) a tagged link; reports that reference it keep it.',
    tags: ['Campaigns'],
    auth: 'workspace',
    permission: 'campaigns.write',
    idempotent: true,
    ifMatch: true,
    params: wsId({ linkId: uuid }),
    body: z.object({ restore: z.boolean().optional(), reason: reason.optional() }),
    response: trackingLinkRow,
  }),
};

// ——— Experiments (S35) ———

export const experimentVariant = z.object({
  id: uuid,
  name: z.string(),
  description: z.string().nullable(),
  position: z.number().int(),
  thumbnailAssetId: uuid.nullable(),
  thumbnailUrl: z.string().nullable(),
  publicationCount: z.number().int(),
});

export const experimentRow = z.object({
  id: uuid,
  hypothesis: z.string(),
  project: ref,
  owner: memberRef,
  status: z.enum(EXPERIMENT_STATUSES),
  primaryMetricKey: z.string(),
  primaryMetricLabel: z.string(),
  observationWindowHours: z.number().int(),
  minimumSample: z.number().int(),
  startAt: isoDateTime.nullable(),
  endAt: isoDateTime.nullable(),
  variants: z.array(experimentVariant),
  publicationCount: z.number().int(),
  planVersion: z.number().int(),
  archivedAt: isoDateTime.nullable(),
  updatedAt: isoDateTime,
  rowVersion: z.number().int(),
});
export type ExperimentRow = z.infer<typeof experimentRow>;

export const experimentConclusion = z.object({
  findings: z.string(),
  limitations: z.string(),
  selectedVariantId: uuid.nullable(),
  selectionRationale: z.string().nullable(),
  concludedAt: isoDateTime,
  concludedBy: z.string().nullable(),
  /** Frozen comparable-results snapshot used as evidence. */
  evidence: z.record(z.string(), z.unknown()),
});

export const experimentDetail = experimentRow.extend({
  limitations: z.string().nullable(),
  resultNote: z.string().nullable(),
  selectedVariant: z.object({ id: uuid, name: z.string() }).nullable(),
  planFrozenAt: isoDateTime.nullable(),
  conclusion: experimentConclusion.nullable(),
  duplicatedFrom: z.object({ id: uuid, hypothesis: z.string() }).nullable(),
  publications: z.array(z.object({ linkId: uuid, variantId: uuid, segment: z.enum(METRIC_SEGMENTS), publication: publicationRow })),
  hiddenPublications: z.number().int(),
  revisions: z.array(z.object({ id: uuid, planVersion: z.number().int(), reason: z.string().nullable(), createdAt: isoDateTime, snapshot: z.record(z.string(), z.unknown()) })),
  permissions: z.object({ update: z.boolean(), start: z.boolean(), conclude: z.boolean(), linkPublications: z.boolean(), archive: z.boolean(), duplicate: z.boolean() }),
});
export type ExperimentDetail = z.infer<typeof experimentDetail>;

export const EXPERIMENT_ITEM_STATES = ['comparable', 'not_published', 'too_young', 'no_observation_in_window', 'unknown_value', 'removed'] as const;

export const experimentResults = z.object({
  metricKey: z.string(),
  metricLabel: z.string(),
  windowHours: z.number().int(),
  toleranceHours: z.number(),
  evaluatedAt: isoDateTime,
  method: z.string(),
  /** Always shown: this is an organic comparison, not a randomized test; no significance is computed. */
  caveat: z.string(),
  status: z.enum(['comparable', 'not_comparable', 'insufficient_sample', 'no_data']),
  reasons: z.array(z.string()),
  segments: z.array(
    z.object({
      segment: z.enum(METRIC_SEGMENTS),
      variants: z.array(
        z.object({
          variantId: uuid,
          name: z.string(),
          sampleSize: z.number().int(),
          median: z.string().nullable(),
          mean: z.string().nullable(),
          min: z.string().nullable(),
          max: z.string().nullable(),
          outliers: z.array(z.object({ publicationId: uuid, value: z.string() })),
          excluded: z.record(z.enum(EXPERIMENT_ITEM_STATES), z.number().int()),
        }),
      ),
    }),
  ),
  items: z.array(
    z.object({
      publicationId: uuid,
      title: z.string(),
      variantId: uuid,
      segment: z.enum(METRIC_SEGMENTS),
      state: z.enum(EXPERIMENT_ITEM_STATES),
      actualPublishedAt: isoDateTime.nullable(),
      ageHours: z.number().nullable(),
      value: z.string().nullable(),
      observedAt: isoDateTime.nullable(),
      observedAgeHours: z.number().nullable(),
    }),
  ),
});
export type ExperimentResults = z.infer<typeof experimentResults>;

const variantInput = z.object({
  id: uuid.optional(),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).nullable().optional(),
  thumbnailAssetId: uuid.nullable().optional(),
});

const experimentFields = {
  hypothesis: z.string().trim().min(10).max(2000),
  projectId: uuid,
  ownerMembershipId: uuid,
  primaryMetricKey: z.string().trim().min(3).max(80),
  observationWindowHours: z.number().int().min(1).max(24 * 90),
  minimumSample: z.number().int().min(1).max(1000),
  startAt: isoDateTime.nullable().optional(),
  endAt: isoDateTime.nullable().optional(),
  limitations: z.string().trim().max(5000).nullable().optional(),
  variants: z.array(variantInput).min(2).max(8),
};

export const experimentEndpoints = {
  list: endpoint({
    id: 'experiments.list',
    method: 'GET',
    path: '/workspaces/{workspaceId}/experiments',
    summary: 'Experiments in the member’s projects.',
    tags: ['Experiments'],
    auth: 'workspace',
    permission: 'experiments.read',
    params: wsId({}),
    query: pageQuery.extend({
      q: z.string().trim().max(120).optional(),
      projectId: uuid.optional(),
      status: csv(z.enum(EXPERIMENT_STATUSES)).optional(),
      ownerMembershipId: uuid.optional(),
      includeArchived: boolQuery.optional(),
    }),
    response: page(experimentRow),
  }),
  metrics: endpoint({
    id: 'experiments.metrics',
    method: 'GET',
    path: '/workspaces/{workspaceId}/experiment-metrics',
    summary: 'Publication metrics that can be an experiment’s primary metric (cumulative, per post).',
    tags: ['Experiments'],
    auth: 'workspace',
    permission: 'experiments.read',
    params: wsId({}),
    response: z.array(z.object({ key: z.string(), label: z.string(), description: z.string() })),
  }),
  get: endpoint({
    id: 'experiments.get',
    method: 'GET',
    path: '/workspaces/{workspaceId}/experiments/{experimentId}',
    summary: 'Experiment with variants, linked publications, plan revisions and conclusion.',
    tags: ['Experiments'],
    auth: 'workspace',
    permission: 'experiments.read',
    params: wsId({ experimentId: uuid }),
    response: experimentDetail,
  }),
  create: endpoint({
    id: 'experiments.create',
    method: 'POST',
    path: '/workspaces/{workspaceId}/experiments',
    summary: 'Create a Draft experiment: hypothesis, variants, primary metric and comparison window fixed before start.',
    tags: ['Experiments'],
    auth: 'workspace',
    permission: 'experiments.write',
    idempotent: true,
    params: wsId({}),
    body: z.object(experimentFields),
    response: experimentDetail,
    successStatus: 201,
  }),
  update: endpoint({
    id: 'experiments.update',
    method: 'PATCH',
    path: '/workspaces/{workspaceId}/experiments/{experimentId}',
    summary: 'Edit the plan. After start every change needs a reason and creates a plan revision.',
    tags: ['Experiments'],
    auth: 'workspace',
    permission: 'experiments.write',
    ifMatch: true,
    params: wsId({ experimentId: uuid }),
    body: z.object(experimentFields).omit({ projectId: true }).partial().extend({ reason: reason.optional() }),
    response: experimentDetail,
  }),
  start: endpoint({
    id: 'experiments.start',
    method: 'POST',
    path: '/workspaces/{workspaceId}/experiments/{experimentId}/start',
    summary: 'Start: freeze plan version 1 (hypothesis, variants, metric, window, sample, limitations).',
    tags: ['Experiments'],
    auth: 'workspace',
    permission: 'experiments.write',
    idempotent: true,
    ifMatch: true,
    params: wsId({ experimentId: uuid }),
    body: z.object({ startAt: isoDateTime.optional() }),
    response: experimentDetail,
  }),
  conclude: endpoint({
    id: 'experiments.conclude',
    method: 'POST',
    path: '/workspaces/{workspaceId}/experiments/{experimentId}/conclude',
    summary: 'Conclude with findings and limitations; a selected variant needs the owner’s rationale (never an automatic winner).',
    tags: ['Experiments'],
    auth: 'workspace',
    permission: 'experiments.write',
    idempotent: true,
    ifMatch: true,
    params: wsId({ experimentId: uuid }),
    body: z.object({
      findings: z.string().trim().min(10).max(5000),
      limitations: z.string().trim().min(3).max(5000),
      selectedVariantId: uuid.nullable().optional(),
      selectionRationale: z.string().trim().min(10).max(2000).optional(),
    }),
    response: experimentDetail,
  }),
  duplicate: endpoint({
    id: 'experiments.duplicate',
    method: 'POST',
    path: '/workspaces/{workspaceId}/experiments/{experimentId}/duplicate',
    summary: 'Duplicate Hypothesis into a new Draft (no linked publications or results).',
    tags: ['Experiments'],
    auth: 'workspace',
    permission: 'experiments.write',
    idempotent: true,
    params: wsId({ experimentId: uuid }),
    body: z.object({ projectId: uuid.optional() }),
    response: experimentDetail,
    successStatus: 201,
  }),
  linkPublications: endpoint({
    id: 'experiments.linkPublications',
    method: 'POST',
    path: '/workspaces/{workspaceId}/experiments/{experimentId}/publications',
    summary: 'Link placements of the experiment’s project to a variant (paid and organic stay separate).',
    tags: ['Experiments'],
    auth: 'workspace',
    permission: 'experiments.write',
    idempotent: true,
    ifMatch: true,
    params: wsId({ experimentId: uuid }),
    body: z.object({ variantId: uuid, publicationIds: z.array(uuid).min(1).max(100), segment: z.enum(METRIC_SEGMENTS).default('organic'), reason: reason.optional() }),
    response: experimentDetail,
  }),
  unlinkPublication: endpoint({
    id: 'experiments.unlinkPublication',
    method: 'POST',
    path: '/workspaces/{workspaceId}/experiments/{experimentId}/publications/{linkId}/remove',
    summary: 'Remove a linked placement (after start: reason + plan revision).',
    tags: ['Experiments'],
    auth: 'workspace',
    permission: 'experiments.write',
    idempotent: true,
    ifMatch: true,
    params: wsId({ experimentId: uuid, linkId: uuid }),
    body: z.object({ reason: reason.optional() }),
    response: experimentDetail,
  }),
  results: endpoint({
    id: 'experiments.results',
    method: 'GET',
    path: '/workspaces/{workspaceId}/experiments/{experimentId}/results',
    summary: 'View Comparable Results: values observed at the same post age only; unequal ages are Not Comparable.',
    tags: ['Experiments'],
    auth: 'workspace',
    permission: 'experiments.read',
    params: wsId({ experimentId: uuid }),
    response: experimentResults,
  }),
  archive: endpoint({
    id: 'experiments.archive',
    method: 'POST',
    path: '/workspaces/{workspaceId}/experiments/{experimentId}/archive',
    summary: 'Archive a draft or concluded experiment.',
    tags: ['Experiments'],
    auth: 'workspace',
    permission: 'experiments.write',
    idempotent: true,
    ifMatch: true,
    params: wsId({ experimentId: uuid }),
    body: z.object({ reason: reason.optional() }),
    response: experimentDetail,
  }),
};

export const PUBLISHING_ENDPOINT_GROUPS = {
  publications: publicationEndpoints,
  calendar: calendarEndpoints,
  planBaselines: planBaselineEndpoints,
  campaigns: campaignEndpoints,
  campaignSourceReports: sourceReportEndpoints,
  trackingLinks: trackingLinkEndpoints,
  experiments: experimentEndpoints,
};

