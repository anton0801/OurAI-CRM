import { z } from 'zod';
import {
  AUTOMATION_ACTION_TYPES,
  AUTOMATION_FIELD_TYPES,
  AUTOMATION_OPERATORS,
  AUTOMATION_PERSON_KINDS,
  AUTOMATION_QUIET_HOURS_POLICIES,
  AUTOMATION_RUN_STATES,
  AUTOMATION_SCHEDULE_CADENCES,
  AUTOMATION_SCOPE_TYPES,
  AUTOMATION_SETTABLE_FIELDS,
  AUTOMATION_STATES,
  AUTOMATION_TRIGGER_KEYS,
  INCIDENT_SEVERITIES,
  LIMITS,
  TASK_PRIORITIES,
} from '@castlane/domain';
import { endpoint } from './core';
import { boolQuery, csv, isoDateTime, memberRef, page, pageQuery, reason, shortName, tag, uuid, wsId } from './common';

/**
 * Automations S64/S65 (spec §19). Rules are declarative: a trigger from a closed list, conditions
 * over typed facts of the triggering record and actions limited to internal effects. There is no
 * field for code, SQL or webhook URLs.
 */

// ——— Rule configuration ———

export const automationSchedule = z.object({
  cadence: z.enum(AUTOMATION_SCHEDULE_CADENCES),
  localTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a time like 09:00.'),
  weekday: z.number().int().min(1).max(7).optional(),
  monthDay: z.number().int().min(1).max(31).optional(),
});

export const automationTrigger = z.object({
  event: z.enum(AUTOMATION_TRIGGER_KEYS),
  /** Deadline triggers: hours before (due soon) or after (overdue, report overdue, metrics stale) the deadline. */
  thresholdHours: z.number().int().min(0).max(8760).optional(),
  schedule: automationSchedule.optional(),
});
export type AutomationTriggerInput = z.infer<typeof automationTrigger>;

const conditionValue = z.union([z.string().max(200), z.number().finite(), z.boolean(), z.null(), z.array(z.string().max(200)).max(50)]);

export const automationCondition = z.object({
  field: z.string().min(1).max(80),
  operator: z.enum(AUTOMATION_OPERATORS),
  value: conditionValue,
});
export type AutomationConditionInputBody = z.infer<typeof automationCondition>;

export const automationPersonRef = z.object({
  kind: z.enum(AUTOMATION_PERSON_KINDS),
  /** Required when kind = member. */
  membershipId: uuid.nullable().optional(),
});
export type AutomationPersonRef = z.infer<typeof automationPersonRef>;

const text200 = z.string().trim().min(3).max(200);
const hours = z.number().int().min(0).max(8760);

export const automationActionParams = {
  create_task: z.object({
    title: text200,
    description: z.string().trim().max(2000).optional(),
    /** Fixed project; empty = the project of the triggering record (required for scheduled triggers). */
    projectId: uuid.nullable().optional(),
    assignee: automationPersonRef.optional(),
    dueInHours: hours.optional(),
    priority: z.enum(TASK_PRIORITIES).optional(),
    checklist: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
    tags: z.array(tag).max(10).optional(),
    linkToRecord: z.boolean().optional(),
  }),
  create_task_from_template: z.object({
    templateVersionId: uuid,
    projectId: uuid.nullable().optional(),
    startOffsetDays: z.number().int().min(0).max(365).optional(),
  }),
  assign_member: z.object({ assignee: automationPersonRef, onlyIfUnassigned: z.boolean().optional() }),
  add_checklist_item: z.object({ label: z.string().trim().min(1).max(200), mandatory: z.boolean().optional() }),
  add_tag: z.object({ tag }),
  set_field: z.object({ field: z.enum(AUTOMATION_SETTABLE_FIELDS), value: z.enum(TASK_PRIORITIES) }),
  create_checkpoint: z.object({ label: z.string().trim().min(2).max(80), dueInHours: z.number().int().min(1).max(720), windowHours: z.number().int().min(1).max(168).optional() }),
  notify: z.object({ recipients: z.array(automationPersonRef).min(1).max(10), title: z.string().trim().min(3).max(140), message: z.string().trim().max(500).optional() }),
  request_internal_approval: z.object({ approver: automationPersonRef, title: text200, note: z.string().trim().max(2000).optional(), dueInHours: hours.optional() }),
  create_incident: z.object({ severity: z.enum(INCIDENT_SEVERITIES), title: text200, description: z.string().trim().max(2000).optional() }),
} as const;

export const automationAction = z.discriminatedUnion('type', [
  z.object({ type: z.literal('create_task'), params: automationActionParams.create_task }),
  z.object({ type: z.literal('create_task_from_template'), params: automationActionParams.create_task_from_template }),
  z.object({ type: z.literal('assign_member'), params: automationActionParams.assign_member }),
  z.object({ type: z.literal('add_checklist_item'), params: automationActionParams.add_checklist_item }),
  z.object({ type: z.literal('add_tag'), params: automationActionParams.add_tag }),
  z.object({ type: z.literal('set_field'), params: automationActionParams.set_field }),
  z.object({ type: z.literal('create_checkpoint'), params: automationActionParams.create_checkpoint }),
  z.object({ type: z.literal('notify'), params: automationActionParams.notify }),
  z.object({ type: z.literal('request_internal_approval'), params: automationActionParams.request_internal_approval }),
  z.object({ type: z.literal('create_incident'), params: automationActionParams.create_incident }),
]);
export type AutomationActionInput = z.infer<typeof automationAction>;

export const automationRuleConfig = z.object({
  trigger: automationTrigger,
  conditions: z.array(automationCondition).max(20),
  actions: z.array(automationAction).min(1).max(10),
  quietHoursPolicy: z.enum(AUTOMATION_QUIET_HOURS_POLICIES),
});
export type AutomationRuleConfig = z.infer<typeof automationRuleConfig>;

// ——— Read models ———

const scopeView = z.object({ type: z.enum(AUTOMATION_SCOPE_TYPES), id: uuid.nullable(), label: z.string() });

export const automationVersionView = automationRuleConfig.extend({
  id: uuid,
  versionNo: z.number().int(),
  createdAt: isoDateTime,
  createdBy: memberRef.nullable(),
});
export type AutomationVersionView = z.infer<typeof automationVersionView>;

export const automationRuleRow = z.object({
  id: uuid,
  name: z.string(),
  state: z.enum(AUTOMATION_STATES),
  trigger: z.object({ event: z.enum(AUTOMATION_TRIGGER_KEYS), label: z.string(), kind: z.enum(['event', 'deadline', 'schedule']) }),
  scope: scopeView,
  owner: memberRef.nullable(),
  needsOwner: z.boolean(),
  currentVersionNo: z.number().int().nullable(),
  enabledVersionNo: z.number().int().nullable(),
  /** The saved version differs from the one that runs. */
  hasUnpublishedChanges: z.boolean(),
  lastRunAt: isoDateTime.nullable(),
  lastRunState: z.enum(AUTOMATION_RUN_STATES).nullable(),
  /** Failed runs in the last 7 days. */
  failureCount: z.number().int(),
  pausedReason: z.string().nullable(),
  nextScheduledAt: isoDateTime.nullable(),
  archivedAt: isoDateTime.nullable(),
  updatedAt: isoDateTime,
  rowVersion: z.number().int(),
});
export type AutomationRuleRow = z.infer<typeof automationRuleRow>;

export const automationRuleDetail = automationRuleRow.extend({
  currentVersion: automationVersionView.nullable(),
  enabledVersionId: uuid.nullable(),
  versions: z.array(z.object({ id: uuid, versionNo: z.number().int(), createdAt: isoDateTime, createdBy: memberRef.nullable(), enabled: z.boolean() })),
  runCounts: z.object({ succeeded: z.number().int(), failed: z.number().int(), skipped: z.number().int(), pending: z.number().int() }),
  permissions: z.object({ edit: z.boolean(), enable: z.boolean(), disable: z.boolean(), duplicate: z.boolean(), archive: z.boolean(), retry: z.boolean(), dryRun: z.boolean() }),
});
export type AutomationRuleDetail = z.infer<typeof automationRuleDetail>;

export const automationActionResult = z.object({
  index: z.number().int(),
  type: z.string(),
  ok: z.boolean(),
  skipped: z.boolean().optional(),
  entityType: z.string().nullable().optional(),
  entityId: uuid.nullable().optional(),
  /** Deep link to the created/changed record when the viewer may open it. */
  href: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
  effects: z.number().int().optional(),
});

export const automationRunRow = z.object({
  id: uuid,
  ruleId: uuid,
  ruleVersionId: uuid,
  versionNo: z.number().int().nullable(),
  state: z.enum(AUTOMATION_RUN_STATES),
  triggerEvent: z.string().nullable(),
  eventId: uuid,
  rootEventId: uuid,
  depth: z.number().int(),
  operationKey: z.string(),
  record: z.object({ entityType: z.string(), entityId: uuid, label: z.string().nullable(), href: z.string().nullable() }).nullable(),
  attempts: z.number().int(),
  startedAt: isoDateTime.nullable(),
  finishedAt: isoDateTime.nullable(),
  notBefore: isoDateTime.nullable(),
  createdAt: isoDateTime,
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  actionResults: z.array(automationActionResult),
  canRetry: z.boolean(),
  rowVersion: z.number().int(),
});
export type AutomationRunRow = z.infer<typeof automationRunRow>;

export const automationFieldSpec = z.object({
  key: z.string(),
  label: z.string(),
  type: z.enum(AUTOMATION_FIELD_TYPES),
  options: z.array(z.string()).optional(),
  lookup: z.string().optional(),
  unit: z.string().optional(),
});

export const automationCatalog = z.object({
  triggers: z.array(
    z.object({
      key: z.enum(AUTOMATION_TRIGGER_KEYS),
      label: z.string(),
      description: z.string(),
      kind: z.enum(['event', 'deadline', 'schedule']),
      entityType: z.string().nullable(),
      thresholdLabel: z.string().nullable(),
      defaultThresholdHours: z.number().int().nullable(),
      fields: z.array(automationFieldSpec),
      actions: z.array(z.enum(AUTOMATION_ACTION_TYPES)),
    }),
  ),
  actions: z.array(z.object({ type: z.enum(AUTOMATION_ACTION_TYPES), label: z.string(), description: z.string(), createsEffects: z.boolean() })),
  operators: z.array(z.object({ key: z.enum(AUTOMATION_OPERATORS), label: z.string(), fieldTypes: z.array(z.enum(AUTOMATION_FIELD_TYPES)) })),
  placeholders: z.array(z.object({ key: z.string(), label: z.string() })),
  limits: z.object({ maxDepth: z.number().int(), maxEffectsPerRoot: z.number().int(), runsPerHour: z.number().int(), maxConditions: z.number().int(), maxActions: z.number().int() }),
});
export type AutomationCatalog = z.infer<typeof automationCatalog>;

export const automationTemplate = z.object({
  key: z.string(),
  name: z.string(),
  description: z.string(),
  config: automationRuleConfig,
});
export type AutomationTemplate = z.infer<typeof automationTemplate>;

export const automationValidation = z.object({
  ok: z.boolean(),
  errors: z.array(z.object({ field: z.string(), code: z.string(), message: z.string() })),
  warnings: z.array(z.string()),
});

export const automationDryRunResult = z.object({
  record: z.object({ entityType: z.string(), entityId: uuid, label: z.string().nullable() }).nullable(),
  matched: z.boolean(),
  /** Why nothing would run (owner access, chain limits, rule scope…). */
  blockedReason: z.string().nullable(),
  conditions: z.array(z.object({ index: z.number().int(), field: z.string(), label: z.string(), operator: z.enum(AUTOMATION_OPERATORS), expected: z.unknown(), actual: z.unknown(), passed: z.boolean(), reason: z.string().nullable() })),
  actions: z.array(z.object({ index: z.number().int(), type: z.string(), ok: z.boolean(), preview: z.string(), error: z.string().nullable() })),
  /** Always true: the dry run is executed in a transaction that is rolled back; no mail is sent. */
  rolledBack: z.literal(true),
});
export type AutomationDryRunResult = z.infer<typeof automationDryRunResult>;

// ——— Endpoints ———

const ruleParams = wsId({ ruleId: uuid });
const ruleBody = z.object({
  name: shortName,
  ownerMembershipId: uuid.nullable(),
  scopeType: z.enum(AUTOMATION_SCOPE_TYPES),
  scopeId: uuid.nullable().optional(),
  config: automationRuleConfig,
});

export const automationEndpoints = {
  catalog: endpoint({
    id: 'automations.catalog',
    method: 'GET',
    path: '/workspaces/{workspaceId}/automations/catalog',
    summary: 'Allowed triggers, condition fields/operators and action types (the whole rule language).',
    tags: ['Automations'],
    auth: 'workspace',
    permission: 'automations.read',
    params: wsId({}),
    response: automationCatalog,
  }),
  templates: endpoint({
    id: 'automations.templates',
    method: 'GET',
    path: '/workspaces/{workspaceId}/automations/templates',
    summary: 'Starter templates with real actions.',
    tags: ['Automations'],
    auth: 'workspace',
    permission: 'automations.read',
    params: wsId({}),
    response: z.array(automationTemplate),
  }),
  validate: endpoint({
    id: 'automations.validate',
    method: 'POST',
    path: '/workspaces/{workspaceId}/automations/validate',
    summary: 'Validate a rule draft (trigger, conditions, actions, owner rights inside the scope). Read-only.',
    tags: ['Automations'],
    auth: 'workspace',
    permission: 'automations.read',
    params: wsId({}),
    body: ruleBody.extend({ ruleId: uuid.optional() }),
    response: automationValidation,
  }),
  list: endpoint({
    id: 'automations.list',
    method: 'GET',
    path: '/workspaces/{workspaceId}/automations',
    summary: 'Rules with trigger, scope, state, last run, failures and owner.',
    tags: ['Automations'],
    auth: 'workspace',
    permission: 'automations.read',
    params: wsId({}),
    query: pageQuery.extend({
      q: z.string().trim().max(120).optional(),
      state: csv(z.enum(AUTOMATION_STATES)).optional(),
      trigger: z.enum(AUTOMATION_TRIGGER_KEYS).optional(),
      ownerMembershipId: uuid.optional(),
      needsAttention: boolQuery.optional(),
      includeArchived: boolQuery.optional(),
    }),
    response: page(automationRuleRow),
  }),
  get: endpoint({
    id: 'automations.get',
    method: 'GET',
    path: '/workspaces/{workspaceId}/automations/{ruleId}',
    summary: 'Rule detail with the saved and the enabled version.',
    tags: ['Automations'],
    auth: 'workspace',
    permission: 'automations.read',
    params: ruleParams,
    response: automationRuleDetail,
  }),
  create: endpoint({
    id: 'automations.create',
    method: 'POST',
    path: '/workspaces/{workspaceId}/automations',
    summary: 'Create a rule (saved disabled as version 1).',
    tags: ['Automations'],
    auth: 'workspace',
    permission: 'automations.create',
    idempotent: true,
    params: wsId({}),
    body: ruleBody,
    response: automationRuleDetail,
    successStatus: 201,
  }),
  update: endpoint({
    id: 'automations.update',
    method: 'PATCH',
    path: '/workspaces/{workspaceId}/automations/{ruleId}',
    summary: 'Save changes. A configuration change creates a new version; an enabled rule keeps running its enabled version until the new one is enabled.',
    tags: ['Automations'],
    auth: 'workspace',
    permission: 'automations.edit',
    ifMatch: true,
    params: ruleParams,
    body: ruleBody.partial(),
    response: automationRuleDetail,
  }),
  enable: endpoint({
    id: 'automations.enable',
    method: 'POST',
    path: '/workspaces/{workspaceId}/automations/{ruleId}/enable',
    summary: 'Validate owner/scope and activate a version.',
    tags: ['Automations'],
    auth: 'workspace',
    permission: 'automations.enable',
    idempotent: true,
    ifMatch: true,
    params: ruleParams,
    body: z.object({ versionId: uuid }),
    response: automationRuleDetail,
  }),
  disable: endpoint({
    id: 'automations.disable',
    method: 'POST',
    path: '/workspaces/{workspaceId}/automations/{ruleId}/disable',
    summary: 'Stop the rule; runs that have not started are cancelled, completed actions stay.',
    tags: ['Automations'],
    auth: 'workspace',
    permission: 'automations.enable',
    idempotent: true,
    ifMatch: true,
    params: ruleParams,
    body: z.object({ reason: z.string().trim().max(LIMITS.reasonMax).optional() }),
    response: automationRuleDetail,
  }),
  duplicate: endpoint({
    id: 'automations.duplicate',
    method: 'POST',
    path: '/workspaces/{workspaceId}/automations/{ruleId}/duplicate',
    summary: 'Copy the saved version into a new disabled rule.',
    tags: ['Automations'],
    auth: 'workspace',
    permission: 'automations.create',
    idempotent: true,
    params: ruleParams,
    body: z.object({ name: shortName.optional() }),
    response: automationRuleDetail,
    successStatus: 201,
  }),
  archive: endpoint({
    id: 'automations.archive',
    method: 'POST',
    path: '/workspaces/{workspaceId}/automations/{ruleId}/archive',
    summary: 'Archive (disables and cancels pending runs) or restore (as disabled). History is kept.',
    tags: ['Automations'],
    auth: 'workspace',
    permission: 'automations.edit',
    idempotent: true,
    ifMatch: true,
    params: ruleParams,
    body: z.object({ restore: z.boolean().optional(), reason: z.string().trim().max(LIMITS.reasonMax).optional() }),
    response: automationRuleDetail,
  }),
  dryRunSamples: endpoint({
    id: 'automations.dryRunSamples',
    method: 'GET',
    path: '/workspaces/{workspaceId}/automations/{ruleId}/dry-run-samples',
    summary: 'Recent records the rule could run for (inside its scope and readable by you).',
    tags: ['Automations'],
    auth: 'workspace',
    permission: 'automations.read',
    params: ruleParams,
    query: z.object({ trigger: z.enum(AUTOMATION_TRIGGER_KEYS).optional(), q: z.string().trim().max(120).optional() }),
    response: z.array(z.object({ entityType: z.string(), entityId: uuid, label: z.string(), at: isoDateTime.nullable() })),
  }),
  dryRun: endpoint({
    id: 'automations.dryRun',
    method: 'POST',
    path: '/workspaces/{workspaceId}/automations/{ruleId}/dry-run',
    summary: 'Evaluate conditions and preview action effects for a sample record. Zero domain mutations and zero mail.',
    tags: ['Automations'],
    auth: 'workspace',
    permission: 'automations.read',
    params: ruleParams,
    body: z.object({ sample: z.object({ entityType: z.string().max(40), entityId: uuid }).nullable(), config: automationRuleConfig.optional() }),
    response: automationDryRunResult,
  }),
  runs: endpoint({
    id: 'automations.runs',
    method: 'GET',
    path: '/workspaces/{workspaceId}/automations/{ruleId}/runs',
    summary: 'Run timeline with event ids, action results and errors, newest first.',
    tags: ['Automations'],
    auth: 'workspace',
    permission: 'automations.read',
    params: ruleParams,
    query: pageQuery.extend({ state: csv(z.enum(AUTOMATION_RUN_STATES)).optional() }),
    response: page(automationRunRow),
  }),
  run: endpoint({
    id: 'automations.run',
    method: 'GET',
    path: '/workspaces/{workspaceId}/automation-runs/{runId}',
    summary: 'One run with its effects.',
    tags: ['Automations'],
    auth: 'workspace',
    permission: 'automations.read',
    params: wsId({ runId: uuid }),
    response: automationRunRow,
  }),
  retryRun: endpoint({
    id: 'automations.retryRun',
    method: 'POST',
    path: '/workspaces/{workspaceId}/automation-runs/{runId}/retry',
    summary: 'Retry a failed run with the same operation key (completed effects are not repeated; access is re-checked).',
    tags: ['Automations'],
    auth: 'workspace',
    permission: 'automations.edit',
    idempotent: true,
    ifMatch: true,
    params: wsId({ runId: uuid }),
    body: z.object({ reason }),
    response: automationRunRow,
    successStatus: 202,
  }),
};
