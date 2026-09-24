import { z } from 'zod';
import { CONTENT_FORMATS, CONTENT_SLOTS, CUSTOM_FIELD_TYPES, LIMITS, RESPONSIBILITIES, TEMPLATE_KINDS, TEMPLATE_VERSION_STATES } from '@castlane/domain';
import { endpoint } from './core';
import { boolQuery, decimalString, isoDate, isoDateTime, memberRef, reason, shortName, uuid, wsId } from './common';

// ——— Templates (S72) ———

export const templateNodeKey = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/, 'Use 1–40 lowercase letters, digits, - or _.');
const checklistItem = z.object({ label: z.string().trim().min(2).max(200), mandatory: z.boolean() });

export const templateTaskNode = z.object({
  key: templateNodeKey,
  title: z.string().trim().min(LIMITS.taskTitleMin).max(LIMITS.taskTitleMax),
  description: z.string().max(LIMITS.noteMax).optional(),
  responsibility: z.enum(RESPONSIBILITIES).optional(),
  defaultRoleKey: z.string().max(60).optional(),
  offsetDaysFromStart: z.number().int().min(0).max(3650).optional(),
  durationDays: z.number().int().min(0).max(3650).optional(),
  estimateMinutes: z.number().int().min(0).max(100_000).optional(),
  dependsOn: z.array(templateNodeKey).max(50).optional(),
  checklist: z.array(checklistItem).max(50).optional(),
  requiresReview: z.boolean().optional(),
});
export type TemplateTaskNodeInput = z.infer<typeof templateTaskNode>;

export const templateConfig = z.object({
  format: z.enum(CONTENT_FORMATS).optional(),
  deliverableSlots: z.array(z.object({ slot: z.enum(CONTENT_SLOTS), required: z.boolean() })).max(20).optional(),
  checklist: z.array(checklistItem).max(100).optional(),
  tasks: z.array(templateTaskNode).max(200).optional(),
  reviewerRoleKey: z.string().max(60).optional(),
  rubric: z.array(z.object({ key: templateNodeKey, label: z.string().trim().min(2).max(120), weight: decimalString })).max(30).optional(),
});
export type TemplateConfigInput = z.infer<typeof templateConfig>;

export const templateVersionItem = z.object({
  id: uuid,
  versionNo: z.number().int(),
  state: z.enum(TEMPLATE_VERSION_STATES),
  publishedAt: isoDateTime.nullable(),
  createdAt: isoDateTime,
  createdBy: z.string().nullable(),
  applications: z.number().int(),
  rowVersion: z.number().int(),
});

export const templateSummary = z.object({
  id: uuid,
  kind: z.enum(TEMPLATE_KINDS),
  name: z.string(),
  description: z.string().nullable(),
  status: z.enum(['draft', 'published', 'disabled']),
  publishedVersion: z.object({ id: uuid, versionNo: z.number().int(), publishedAt: isoDateTime.nullable() }).nullable(),
  draftVersion: z.object({ id: uuid, versionNo: z.number().int() }).nullable(),
  disabledAt: isoDateTime.nullable(),
  updatedAt: isoDateTime,
  rowVersion: z.number().int(),
});
export type TemplateSummary = z.infer<typeof templateSummary>;

export const templateDetail = templateSummary.extend({
  versions: z.array(templateVersionItem),
  draft: z.object({ id: uuid, versionNo: z.number().int(), config: templateConfig, rowVersion: z.number().int() }).nullable(),
  published: z.object({ id: uuid, versionNo: z.number().int(), config: templateConfig }).nullable(),
  permissions: z.object({ manage: z.boolean() }),
});
export type TemplateDetail = z.infer<typeof templateDetail>;

export const templatePreview = z.object({
  versionId: uuid,
  versionNo: z.number().int(),
  startDate: isoDate,
  endDate: isoDate.nullable(),
  totalEstimateMinutes: z.number().int(),
  tasks: z.array(
    z.object({
      key: z.string(),
      title: z.string(),
      startDate: isoDate,
      dueDate: isoDate,
      estimateMinutes: z.number().int().nullable(),
      dependsOn: z.array(z.string()),
      responsibility: z.string().nullable(),
      roleKey: z.string().nullable(),
      assignee: memberRef.nullable(),
      checklist: z.array(z.object({ label: z.string(), mandatory: z.boolean() })),
      requiresReview: z.boolean(),
    }),
  ),
  checklist: z.array(z.object({ label: z.string(), mandatory: z.boolean() })),
  rubric: z.array(z.object({ key: z.string(), label: z.string(), weight: z.string() })),
  warnings: z.array(z.string()),
});
export type TemplatePreview = z.infer<typeof templatePreview>;

export const templateEndpoints = {
  list: endpoint({
    id: 'templates.list',
    method: 'GET',
    path: '/workspaces/{workspaceId}/templates',
    summary: 'Task, content, checklist and quality rubric templates.',
    tags: ['Templates'],
    auth: 'workspace',
    params: wsId({}),
    query: z.object({ kind: z.enum(TEMPLATE_KINDS).optional(), includeDisabled: boolQuery.optional(), q: z.string().trim().max(120).optional() }),
    response: z.array(templateSummary),
  }),
  get: endpoint({
    id: 'templates.get',
    method: 'GET',
    path: '/workspaces/{workspaceId}/templates/{templateId}',
    summary: 'Template with versions, the editable draft and the current published configuration.',
    tags: ['Templates'],
    auth: 'workspace',
    params: wsId({ templateId: uuid }),
    response: templateDetail,
  }),
  create: endpoint({
    id: 'templates.create',
    method: 'POST',
    path: '/workspaces/{workspaceId}/templates',
    summary: 'New Template: creates the template with draft version 1.',
    tags: ['Templates'],
    auth: 'workspace',
    permission: 'templates.manage',
    idempotent: true,
    params: wsId({}),
    body: z.object({ kind: z.enum(TEMPLATE_KINDS), name: shortName, description: z.string().trim().max(2000).nullable().optional(), config: templateConfig.optional() }),
    response: templateDetail,
    successStatus: 201,
  }),
  update: endpoint({
    id: 'templates.update',
    method: 'PATCH',
    path: '/workspaces/{workspaceId}/templates/{templateId}',
    summary: 'Rename or describe a template (published versions never change).',
    tags: ['Templates'],
    auth: 'workspace',
    permission: 'templates.manage',
    ifMatch: true,
    params: wsId({ templateId: uuid }),
    body: z.object({ name: shortName.optional(), description: z.string().trim().max(2000).nullable().optional() }),
    response: templateDetail,
  }),
  saveDraft: endpoint({
    id: 'templates.saveDraft',
    method: 'PATCH',
    path: '/workspaces/{workspaceId}/templates/{templateId}/versions/{versionId}',
    summary: 'Save the configuration of a draft version (If-Match: the draft version’s row version).',
    tags: ['Templates'],
    auth: 'workspace',
    permission: 'templates.manage',
    ifMatch: true,
    params: wsId({ templateId: uuid, versionId: uuid }),
    body: z.object({ config: templateConfig }),
    response: templateDetail,
  }),
  newVersion: endpoint({
    id: 'templates.newVersion',
    method: 'POST',
    path: '/workspaces/{workspaceId}/templates/{templateId}/versions',
    summary: 'New Version: a draft copied from the published (or given) version.',
    tags: ['Templates'],
    auth: 'workspace',
    permission: 'templates.manage',
    idempotent: true,
    params: wsId({ templateId: uuid }),
    body: z.object({ fromVersionId: uuid.optional() }),
    response: templateDetail,
    successStatus: 201,
  }),
  publish: endpoint({
    id: 'templates.publish',
    method: 'POST',
    path: '/workspaces/{workspaceId}/templates/{templateId}/publish',
    summary: 'Publish the draft as an immutable usable version; the previous published version is withdrawn.',
    tags: ['Templates'],
    auth: 'workspace',
    permission: 'templates.manage',
    idempotent: true,
    ifMatch: true,
    params: wsId({ templateId: uuid }),
    body: z.object({ draftVersionId: uuid }),
    response: templateDetail,
  }),
  disable: endpoint({
    id: 'templates.disable',
    method: 'POST',
    path: '/workspaces/{workspaceId}/templates/{templateId}/disable',
    summary: 'Disable: the template can no longer be applied; existing applications are unaffected.',
    tags: ['Templates'],
    auth: 'workspace',
    permission: 'templates.manage',
    idempotent: true,
    ifMatch: true,
    params: wsId({ templateId: uuid }),
    body: z.object({ reason: reason.optional() }),
    response: templateDetail,
  }),
  enable: endpoint({
    id: 'templates.enable',
    method: 'POST',
    path: '/workspaces/{workspaceId}/templates/{templateId}/enable',
    summary: 'Enable a disabled template again.',
    tags: ['Templates'],
    auth: 'workspace',
    permission: 'templates.manage',
    idempotent: true,
    ifMatch: true,
    params: wsId({ templateId: uuid }),
    response: templateDetail,
  }),
  previewApplication: endpoint({
    id: 'templates.previewApplication',
    method: 'POST',
    path: '/workspaces/{workspaceId}/templates/{templateId}/preview-application',
    summary: 'Dry-run the task graph with dates and proposed assignees. No records are created.',
    tags: ['Templates'],
    auth: 'workspace',
    params: wsId({ templateId: uuid }),
    body: z.object({ versionId: uuid.optional(), startDate: isoDate, assignees: z.record(z.string().max(60), uuid).optional(), projectId: uuid.optional() }),
    response: templatePreview,
  }),
};

// ——— Custom fields (section 21) ———

export const customFieldOption = z.object({ key: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/), label: z.string().trim().min(1).max(120), archivedAt: isoDateTime.nullable().optional() });

export const customFieldDefinition = z.object({
  id: uuid,
  entityType: z.string(),
  key: z.string(),
  name: z.string(),
  type: z.enum(CUSTOM_FIELD_TYPES),
  scopeProject: z.object({ id: uuid, name: z.string() }).nullable(),
  options: z.array(customFieldOption),
  requiredAtStage: z.string().nullable(),
  unit: z.string().nullable(),
  precision: z.number().int().nullable(),
  replacedById: uuid.nullable(),
  usedAt: isoDateTime.nullable(),
  archivedAt: isoDateTime.nullable(),
  archiveReason: z.string().nullable(),
  valueCount: z.number().int(),
  updatedAt: isoDateTime,
  rowVersion: z.number().int(),
});
export type CustomFieldDefinition = z.infer<typeof customFieldDefinition>;

const fieldKey = z.string().regex(/^[a-z][a-z0-9_]{1,39}$/, 'Use 2–40 lowercase letters, digits or _, starting with a letter.');
const definitionShape = {
  name: shortName,
  type: z.enum(CUSTOM_FIELD_TYPES),
  scopeProjectId: uuid.nullable().optional(),
  options: z.array(customFieldOption).max(100).optional(),
  requiredAtStage: z.string().max(40).nullable().optional(),
  unit: z.string().trim().max(20).nullable().optional(),
  precision: z.number().int().min(0).max(6).nullable().optional(),
};

export const customFieldValueView = z.object({
  definition: customFieldDefinition.pick({ id: true, key: true, name: true, type: true, options: true, requiredAtStage: true, unit: true, precision: true, archivedAt: true }),
  value: z.unknown().nullable(),
  /** Human-readable value (historical labels kept for archived options). */
  displayValue: z.string().nullable(),
  required: z.boolean(),
  needsCompletion: z.boolean(),
  rowVersion: z.number().int().nullable(),
});
export type CustomFieldValueView = z.infer<typeof customFieldValueView>;

export const customFieldValues = z.object({
  entityType: z.string(),
  entityId: uuid,
  stage: z.string().nullable(),
  canEdit: z.boolean(),
  fields: z.array(customFieldValueView),
});
export type CustomFieldValues = z.infer<typeof customFieldValues>;

export const customFieldEndpoints = {
  targets: endpoint({
    id: 'customFields.targets',
    method: 'GET',
    path: '/workspaces/{workspaceId}/custom-fields/targets',
    summary: 'Entity types that support custom fields, with their stages for Required At Stage.',
    tags: ['Custom Fields'],
    auth: 'workspace',
    params: wsId({}),
    response: z.array(z.object({ entityType: z.string(), label: z.string(), stages: z.array(z.string()), activeFields: z.number().int(), maxActiveFields: z.number().int() })),
  }),
  list: endpoint({
    id: 'customFields.list',
    method: 'GET',
    path: '/workspaces/{workspaceId}/custom-fields',
    summary: 'Custom field definitions (active; archived on request).',
    tags: ['Custom Fields'],
    auth: 'workspace',
    params: wsId({}),
    query: z.object({ entityType: z.string().max(60).optional(), includeArchived: boolQuery.optional() }),
    response: z.array(customFieldDefinition),
  }),
  get: endpoint({
    id: 'customFields.get',
    method: 'GET',
    path: '/workspaces/{workspaceId}/custom-fields/{fieldId}',
    summary: 'One custom field definition.',
    tags: ['Custom Fields'],
    auth: 'workspace',
    params: wsId({ fieldId: uuid }),
    response: customFieldDefinition,
  }),
  create: endpoint({
    id: 'customFields.create',
    method: 'POST',
    path: '/workspaces/{workspaceId}/custom-fields',
    summary: 'Add Field (max 30 active per entity type). Custom fields never change finance totals, statuses or permissions.',
    tags: ['Custom Fields'],
    auth: 'workspace',
    permission: 'custom-fields.manage',
    idempotent: true,
    params: wsId({}),
    body: z.object({ entityType: z.string().max(60), key: fieldKey, ...definitionShape }),
    response: customFieldDefinition,
    successStatus: 201,
  }),
  update: endpoint({
    id: 'customFields.update',
    method: 'PATCH',
    path: '/workspaces/{workspaceId}/custom-fields/{fieldId}',
    summary: 'Rename, edit options (removed options are archived, labels kept), unit/precision or Required At Stage.',
    tags: ['Custom Fields'],
    auth: 'workspace',
    permission: 'custom-fields.manage',
    ifMatch: true,
    params: wsId({ fieldId: uuid }),
    body: z.object({ name: shortName.optional(), options: z.array(customFieldOption).max(100).optional(), requiredAtStage: definitionShape.requiredAtStage, unit: definitionShape.unit, precision: definitionShape.precision, scopeProjectId: definitionShape.scopeProjectId }),
    response: customFieldDefinition,
  }),
  archive: endpoint({
    id: 'customFields.archive',
    method: 'POST',
    path: '/workspaces/{workspaceId}/custom-fields/{fieldId}/archive',
    summary: 'Archive Field: inactive definition; stored values and labels remain.',
    tags: ['Custom Fields'],
    auth: 'workspace',
    permission: 'custom-fields.manage',
    idempotent: true,
    ifMatch: true,
    params: wsId({ fieldId: uuid }),
    body: z.object({ reason }),
    response: customFieldDefinition,
  }),
  replacePreview: endpoint({
    id: 'customFields.replacePreview',
    method: 'POST',
    path: '/workspaces/{workspaceId}/custom-fields/{fieldId}/replace-preview',
    summary: 'Migration preview for a type change: how many existing values convert to the new type.',
    tags: ['Custom Fields'],
    auth: 'workspace',
    permission: 'custom-fields.manage',
    params: wsId({ fieldId: uuid }),
    body: z.object({ type: z.enum(CUSTOM_FIELD_TYPES), options: z.array(customFieldOption).max(100).optional(), precision: definitionShape.precision }),
    response: z.object({ total: z.number().int(), convertible: z.number().int(), notConvertible: z.number().int(), samples: z.array(z.object({ from: z.string(), to: z.string().nullable() })) }),
  }),
  replace: endpoint({
    id: 'customFields.replace',
    method: 'POST',
    path: '/workspaces/{workspaceId}/custom-fields/{fieldId}/replace',
    summary: 'Replace the field with a new definition of another type; the old one is archived with its values.',
    tags: ['Custom Fields'],
    auth: 'workspace',
    permission: 'custom-fields.manage',
    idempotent: true,
    ifMatch: true,
    params: wsId({ fieldId: uuid }),
    body: z.object({ type: z.enum(CUSTOM_FIELD_TYPES), name: shortName.optional(), options: z.array(customFieldOption).max(100).optional(), unit: definitionShape.unit, precision: definitionShape.precision, migrateValues: z.boolean() }),
    response: customFieldDefinition,
    successStatus: 201,
  }),
  values: endpoint({
    id: 'customFields.values',
    method: 'GET',
    path: '/workspaces/{workspaceId}/custom-field-values',
    summary: 'Custom field values of one record the member can read.',
    tags: ['Custom Fields'],
    auth: 'workspace',
    params: wsId({}),
    query: z.object({ entityType: z.string().max(60), entityId: uuid }),
    response: customFieldValues,
  }),
  setValues: endpoint({
    id: 'customFields.setValues',
    method: 'POST',
    path: '/workspaces/{workspaceId}/custom-field-values',
    summary: 'Save custom field values of one record (each value carries its row version for conflicts).',
    tags: ['Custom Fields'],
    auth: 'workspace',
    idempotent: true,
    params: wsId({}),
    body: z.object({
      entityType: z.string().max(60),
      entityId: uuid,
      values: z.array(z.object({ definitionId: uuid, value: z.unknown(), rowVersion: z.number().int().nullable().optional() })).min(1).max(30),
    }),
    response: customFieldValues,
  }),
};
