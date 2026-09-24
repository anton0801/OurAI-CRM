import { z } from 'zod';
import { GOAL_STATUSES, GOAL_TARGET_TYPES, LIMITS } from '@castlane/domain';
import { endpoint } from './core';
import { boolQuery, csv, decimalString, isoDate, isoDateTime, memberRef, page, pageQuery, reason, shortName, uuid, wsId } from './common';

/**
 * Metric value with explicit availability (R17): `value` is a decimal string present only when
 * status is known/partial. Shared by Goals and Overview.
 */
export const goalMeasuredValue = z.object({
  status: z.enum(['known', 'partial', 'no_data', 'not_defined', 'not_enough_data', 'not_measured', 'not_attributable', 'pending', 'not_applicable', 'not_comparable']),
  value: z.string().nullable(),
  unit: z.enum(['count', 'percent', 'hours', 'seconds', 'money', 'ratio', 'score', 'number']),
  currency: z.string().optional(),
  sampleSize: z.number().int().optional(),
  excluded: z.array(z.object({ count: z.number().int(), reason: z.string() })).optional(),
  missing: z.array(z.string()).optional(),
  coverage: z.object({ usable: z.number().int(), expected: z.number().int() }).optional(),
  note: z.string().optional(),
});
export type GoalMeasuredValue = z.infer<typeof goalMeasuredValue>;

export const GOAL_SCOPE_TYPES = ['workspace', 'direction', 'project', 'account', 'campaign'] as const;

const scopeView = z.object({ type: z.enum(GOAL_SCOPE_TYPES), id: uuid.nullable(), label: z.string() });

export const goalRow = z.object({
  id: uuid,
  name: z.string(),
  owner: memberRef,
  scope: scopeView,
  metric: z.object({ id: z.string(), label: z.string(), unit: z.string(), available: z.boolean(), rate: z.boolean() }),
  targetType: z.enum(GOAL_TARGET_TYPES),
  targetValue: z.string(),
  unit: z.string(),
  periodStart: isoDate,
  periodEnd: isoDate,
  baselineValue: z.string().nullable(),
  direction: z.enum(['increase', 'decrease']),
  status: z.enum(GOAL_STATUSES),
  revisionNo: z.number().int(),
  /** Current value: canonical metric, else the latest manual check-in labelled Manual, else Not Measured. */
  current: z.object({ value: goalMeasuredValue, source: z.enum(['metric', 'manual', 'none']), asOf: isoDateTime, manualSource: z.string().nullable() }),
  /** Progress %: may exceed 100 (labelled Over Target) — never clamped. */
  progress: goalMeasuredValue,
  overTarget: z.boolean(),
  /** Source completeness % (usable/expected inputs) when the metric reports coverage. */
  completeness: z.string().nullable(),
  closedAt: isoDateTime.nullable(),
  achievedValue: z.string().nullable(),
  assessment: z.string().nullable(),
  linkedCampaigns: z.array(z.object({ id: uuid, name: z.string() })),
  archivedAt: isoDateTime.nullable(),
  updatedAt: isoDateTime,
  rowVersion: z.number().int(),
});
export type GoalRow = z.infer<typeof goalRow>;

export const goalRevisionView = z.object({
  revisionNo: z.number().int(),
  targetType: z.enum(GOAL_TARGET_TYPES),
  targetValue: z.string(),
  baselineValue: z.string().nullable(),
  periodStart: isoDate,
  periodEnd: isoDate,
  effectiveFrom: isoDate,
  reason: z.string().nullable(),
  createdAt: isoDateTime,
  createdBy: memberRef.nullable(),
});

export const goalCheckInView = z.object({
  id: uuid,
  member: memberRef,
  note: z.string(),
  manualValue: z.string().nullable(),
  manualSource: z.string().nullable(),
  measuredValue: z.string().nullable(),
  createdAt: isoDateTime,
});

export const goalDetail = goalRow.extend({
  revisions: z.array(goalRevisionView),
  checkIns: z.array(goalCheckInView),
  /** Where the underlying records can be opened. */
  sources: z.object({ href: z.string(), label: z.string() }).nullable(),
  periodStarted: z.boolean(),
  permissions: z.object({ edit: z.boolean(), checkIn: z.boolean(), close: z.boolean(), archive: z.boolean() }),
});
export type GoalDetail = z.infer<typeof goalDetail>;

export const goalMetricOption = z.object({ id: z.string(), label: z.string(), description: z.string(), unit: z.string(), rate: z.boolean(), higherIsBetter: z.boolean().nullable() });

const goalFields = {
  name: shortName,
  ownerMembershipId: uuid,
  scopeType: z.enum(GOAL_SCOPE_TYPES),
  scopeId: uuid.nullable().optional(),
  metricId: z.string().min(1).max(40),
  targetType: z.enum(GOAL_TARGET_TYPES),
  targetValue: decimalString,
  baselineValue: decimalString.nullable().optional(),
  periodStart: isoDate,
  periodEnd: isoDate,
  direction: z.enum(['increase', 'decrease']).optional(),
  linkedCampaignIds: z.array(uuid).max(20).optional(),
};

export const goalEndpoints = {
  metricOptions: endpoint({
    id: 'goals.metricOptions',
    method: 'GET',
    path: '/workspaces/{workspaceId}/goals/metric-options',
    summary: 'Canonical metrics a goal can measure (unit fixed by the metric).',
    tags: ['Goals'],
    auth: 'workspace',
    permission: 'goals.read',
    params: wsId({}),
    response: z.array(goalMetricOption),
  }),
  list: endpoint({
    id: 'goals.list',
    method: 'GET',
    path: '/workspaces/{workspaceId}/goals',
    summary: 'Goals in the member’s scope with current value and progress.',
    tags: ['Goals'],
    auth: 'workspace',
    permission: 'goals.read',
    params: wsId({}),
    query: pageQuery.extend({
      q: z.string().trim().max(120).optional(),
      status: csv(z.enum(GOAL_STATUSES)).optional(),
      ownerMembershipId: uuid.optional(),
      projectId: uuid.optional(),
      scopeType: z.enum(GOAL_SCOPE_TYPES).optional(),
      metricId: z.string().max(40).optional(),
      includeArchived: boolQuery.optional(),
    }),
    response: page(goalRow),
  }),
  get: endpoint({
    id: 'goals.get',
    method: 'GET',
    path: '/workspaces/{workspaceId}/goals/{goalId}',
    summary: 'Goal with revisions (target and baseline history) and check-ins.',
    tags: ['Goals'],
    auth: 'workspace',
    permission: 'goals.read',
    params: wsId({ goalId: uuid }),
    response: goalDetail,
  }),
  create: endpoint({
    id: 'goals.create',
    method: 'POST',
    path: '/workspaces/{workspaceId}/goals',
    summary: 'Create a goal. Baseline is required for Increase By and Decrease To.',
    tags: ['Goals'],
    auth: 'workspace',
    permission: 'goals.write',
    idempotent: true,
    params: wsId({}),
    body: z.object(goalFields),
    response: goalDetail,
    successStatus: 201,
  }),
  update: endpoint({
    id: 'goals.update',
    method: 'PATCH',
    path: '/workspaces/{workspaceId}/goals/{goalId}',
    summary: 'Edit a goal. Changing target, baseline, type or period after the period started creates a revision (reason required).',
    tags: ['Goals'],
    auth: 'workspace',
    permission: 'goals.write',
    ifMatch: true,
    params: wsId({ goalId: uuid }),
    body: z.object({ ...goalFields, reason: z.string().trim().max(LIMITS.reasonMax).optional() }).partial(),
    response: goalDetail,
  }),
  checkIn: endpoint({
    id: 'goals.checkIn',
    method: 'POST',
    path: '/workspaces/{workspaceId}/goals/{goalId}/check-in',
    summary: 'Append a check-in: note plus an optional manual value with its source (labelled Manual).',
    tags: ['Goals'],
    auth: 'workspace',
    permission: 'goals.write',
    idempotent: true,
    params: wsId({ goalId: uuid }),
    body: z
      .object({ note: z.string().trim().min(3).max(2000), manualValue: decimalString.nullable().optional(), manualSource: z.string().trim().min(3).max(300).nullable().optional() })
      .refine((b) => b.manualValue == null || !!b.manualSource, { message: 'Describe the source of the manual value.', path: ['manualSource'] }),
    response: goalDetail,
    successStatus: 201,
  }),
  close: endpoint({
    id: 'goals.close',
    method: 'POST',
    path: '/workspaces/{workspaceId}/goals/{goalId}/close',
    summary: 'Close with an assessment; stores the achieved value and source completeness. Metrics are not changed.',
    tags: ['Goals'],
    auth: 'workspace',
    permission: 'goals.write',
    idempotent: true,
    ifMatch: true,
    params: wsId({ goalId: uuid }),
    body: z.object({ assessment: reason, effectiveAt: isoDateTime.optional() }),
    response: goalDetail,
  }),
  archive: endpoint({
    id: 'goals.archive',
    method: 'POST',
    path: '/workspaces/{workspaceId}/goals/{goalId}/archive',
    summary: 'Archive or restore a goal. Revisions and check-ins are kept.',
    tags: ['Goals'],
    auth: 'workspace',
    permission: 'goals.write',
    idempotent: true,
    ifMatch: true,
    params: wsId({ goalId: uuid }),
    body: z.object({ restore: z.boolean().optional(), reason: z.string().trim().max(LIMITS.reasonMax).optional() }),
    response: goalDetail,
  }),
};
