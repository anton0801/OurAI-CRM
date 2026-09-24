import { z } from 'zod';
import { ARTICLE_STATUSES, LIMITS, REVISION_KINDS } from '@castlane/domain';
import { endpoint } from './core';
import { boolQuery, csv, impactItem, isoDateTime, memberRef, okResponse, page, pageQuery, reason, shortName, taskTitle, uuid, wsId } from './common';
import { assetView } from './media';

// ——— Structured rich text (§14): no raw HTML is ever accepted or stored ———

export const RICH_TEXT_MARKS = ['bold', 'italic', 'code'] as const;
export const RICH_TEXT_BLOCKS = ['heading', 'paragraph', 'bullet_list', 'ordered_list', 'checklist', 'quote', 'table', 'image', 'file'] as const;

/** One run of text. `href` makes it a link (http/https only; validated again on the server). Unknown keys are stripped. */
export const richInline = z.object({
  type: z.literal('text'),
  text: z.string().max(20_000),
  marks: z.array(z.enum(RICH_TEXT_MARKS)).max(3).optional(),
  href: z.string().max(LIMITS.urlMax).optional(),
});
export type RichInline = z.infer<typeof richInline>;
const inlines = z.array(richInline).max(1000);

export const richBlock = z.discriminatedUnion('type', [
  z.object({ type: z.literal('heading'), level: z.union([z.literal(1), z.literal(2), z.literal(3)]), content: inlines }),
  z.object({ type: z.literal('paragraph'), content: inlines }),
  z.object({ type: z.literal('bullet_list'), items: z.array(inlines).min(1).max(500) }),
  z.object({ type: z.literal('ordered_list'), items: z.array(inlines).min(1).max(500) }),
  z.object({ type: z.literal('checklist'), items: z.array(z.object({ id: z.string().min(1).max(40), content: inlines })).min(1).max(500) }),
  z.object({ type: z.literal('quote'), content: inlines }),
  z.object({ type: z.literal('table'), header: z.boolean(), rows: z.array(z.array(inlines).min(1).max(20)).min(1).max(500) }),
  /** `versionId` is pinned by the server when the version is published (frozen file reference). */
  z.object({ type: z.literal('image'), assetId: uuid, versionId: uuid.optional(), alt: z.string().max(300), caption: z.string().max(500).optional() }),
  z.object({ type: z.literal('file'), assetId: uuid, versionId: uuid.optional(), label: z.string().max(200).optional() }),
]);
export type RichBlock = z.infer<typeof richBlock>;

export const richTextDoc = z.object({ type: z.literal('doc'), content: z.array(richBlock).max(5000) });
export type RichTextDocument = z.infer<typeof richTextDoc>;

export const emptyRichTextDoc = (): RichTextDocument => ({ type: 'doc', content: [] });

// ——— Read models ———

export const ARTICLE_SCOPE_TYPES = ['workspace', 'direction', 'project'] as const;
export const READING_STATUSES = ['open', 'acknowledged', 'cancelled', 'superseded'] as const;
export const READING_SOURCES = ['member', 'role', 'project', 'revision'] as const;

export const articleScope = z.object({ type: z.enum(ARTICLE_SCOPE_TYPES), id: uuid.nullable(), label: z.string().nullable() });

export const categoryView = z.object({
  id: uuid,
  name: z.string(),
  description: z.string().nullable(),
  sortOrder: z.number().int(),
  articleCount: z.number().int(),
  archivedAt: isoDateTime.nullable(),
  rowVersion: z.number().int(),
});
export type CategoryView = z.infer<typeof categoryView>;

export const articleRow = z.object({
  id: uuid,
  title: z.string(),
  status: z.enum(ARTICLE_STATUSES),
  category: z.object({ id: uuid, name: z.string(), archived: z.boolean() }),
  scope: articleScope,
  owner: memberRef,
  requiredReading: z.boolean(),
  publishedVersionNo: z.number().int().nullable(),
  publishedAt: isoDateTime.nullable(),
  /** Present only for members who may edit the article. */
  hasDraft: z.boolean().optional(),
  lastReviewedAt: isoDateTime.nullable(),
  updatedAt: isoDateTime,
  rowVersion: z.number().int(),
  /** The member’s own open/fulfilled reading request for the current version. */
  myReading: z.object({ status: z.enum(READING_STATUSES), dueAt: isoDateTime.nullable(), overdue: z.boolean() }).nullable(),
});
export type ArticleRow = z.infer<typeof articleRow>;

export const articleVersionSummary = z.object({
  id: uuid,
  versionNo: z.number().int(),
  state: z.enum(['draft', 'published', 'superseded']),
  title: z.string(),
  revisionKind: z.enum(REVISION_KINDS).nullable(),
  changeNote: z.string().nullable(),
  publishedAt: isoDateTime.nullable(),
  publishedBy: memberRef.nullable(),
  createdAt: isoDateTime,
  createdBy: memberRef.nullable(),
  updatedAt: isoDateTime,
  wordCount: z.number().int(),
});
export type ArticleVersionSummary = z.infer<typeof articleVersionSummary>;

export const articleVersionDetail = articleVersionSummary.extend({ body: richTextDoc });
export type ArticleVersionDetail = z.infer<typeof articleVersionDetail>;

export const articleAttachment = assetView.extend({ linkId: uuid, role: z.string(), holding: z.boolean() });

export const articleDetail = articleRow.omit({ myReading: true }).extend({
  published: articleVersionDetail.nullable(),
  /** The working draft — returned only to members who may edit the article. */
  draft: articleVersionDetail.nullable().optional(),
  myReading: z
    .object({
      assignmentId: uuid,
      versionId: uuid,
      versionNo: z.number().int(),
      status: z.enum(READING_STATUSES),
      dueAt: isoDateTime.nullable(),
      assignedAt: isoDateTime,
      overdue: z.boolean(),
    })
    .nullable(),
  /** Latest explicit acknowledgement by the member (never inferred from opening the article). */
  myAcknowledgement: z.object({ versionId: uuid, versionNo: z.number().int(), acknowledgedAt: isoDateTime }).nullable(),
  acknowledgedCurrent: z.boolean(),
  attachments: z.array(articleAttachment),
  readingSummary: z.object({ open: z.number().int(), acknowledged: z.number().int(), overdue: z.number().int() }).optional(),
  archivedAt: isoDateTime.nullable(),
  versionCount: z.number().int(),
  permissions: z.object({
    edit: z.boolean(),
    publish: z.boolean(),
    archive: z.boolean(),
    assignReading: z.boolean(),
    acknowledge: z.boolean(),
    createTask: z.boolean(),
    viewReadingStatus: z.boolean(),
    attach: z.boolean(),
  }),
});
export type ArticleDetail = z.infer<typeof articleDetail>;

export const readingAssignmentRow = z.object({
  id: uuid,
  member: memberRef,
  versionId: uuid,
  versionNo: z.number().int(),
  status: z.enum(READING_STATUSES),
  source: z.enum(READING_SOURCES),
  dueAt: isoDateTime.nullable(),
  overdue: z.boolean(),
  assignedAt: isoDateTime,
  acknowledgedAt: isoDateTime.nullable(),
  closeReason: z.string().nullable(),
});
export type ReadingAssignmentRow = z.infer<typeof readingAssignmentRow>;

export const myReadingRow = z.object({
  assignmentId: uuid,
  articleId: uuid,
  title: z.string(),
  categoryName: z.string(),
  versionId: uuid,
  versionNo: z.number().int(),
  revisionKind: z.enum(REVISION_KINDS).nullable(),
  status: z.enum(READING_STATUSES),
  dueAt: isoDateTime.nullable(),
  overdue: z.boolean(),
  assignedAt: isoDateTime,
  acknowledgedAt: isoDateTime.nullable(),
});
export type MyReadingRow = z.infer<typeof myReadingRow>;

export const diffChange = z.object({
  kind: z.enum(['added', 'removed', 'changed']),
  blockType: z.string(),
  before: z.string().nullable(),
  after: z.string().nullable(),
});
export const compareResult = z.object({
  from: articleVersionSummary,
  to: articleVersionSummary,
  titleChanged: z.boolean(),
  summary: z.object({ added: z.number().int(), removed: z.number().int(), changed: z.number().int(), wordsBefore: z.number().int(), wordsAfter: z.number().int() }),
  changes: z.array(diffChange),
  truncated: z.boolean(),
});
export type CompareResult = z.infer<typeof compareResult>;

// ——— Inputs ———

const scopeInput = { scopeType: z.enum(ARTICLE_SCOPE_TYPES), scopeId: uuid.nullable().optional() };

export const ARTICLE_SORTS = ['updatedAt', 'title'] as const;

export const knowledgeEndpoints = {
  listCategories: endpoint({
    id: 'knowledge.categories.list',
    method: 'GET',
    path: '/workspaces/{workspaceId}/knowledge/categories',
    summary: 'Article categories with the number of articles the member can see.',
    tags: ['Knowledge'],
    auth: 'workspace',
    permission: 'knowledge.read',
    params: wsId({}),
    query: z.object({ includeArchived: boolQuery.optional() }),
    response: z.object({
      items: z.array(categoryView),
      /** Categories are one workspace-wide taxonomy: only workspace-wide knowledge editors manage them. */
      canManage: z.boolean(),
      /** The member can create articles in at least one scope. */
      canCreateArticles: z.boolean(),
    }),
  }),
  createCategory: endpoint({
    id: 'knowledge.categories.create',
    method: 'POST',
    path: '/workspaces/{workspaceId}/knowledge/categories',
    summary: 'Create a category (names are unique, case-insensitive).',
    tags: ['Knowledge'],
    auth: 'workspace',
    permission: 'knowledge.write',
    idempotent: true,
    params: wsId({}),
    body: z.object({ name: shortName, description: z.string().trim().max(500).nullable().optional(), sortOrder: z.number().int().min(0).max(10_000).optional() }),
    response: categoryView,
    successStatus: 201,
  }),
  updateCategory: endpoint({
    id: 'knowledge.categories.update',
    method: 'PATCH',
    path: '/workspaces/{workspaceId}/knowledge/categories/{categoryId}',
    summary: 'Rename or reorder a category.',
    tags: ['Knowledge'],
    auth: 'workspace',
    permission: 'knowledge.write',
    ifMatch: true,
    params: wsId({ categoryId: uuid }),
    body: z.object({ name: shortName.optional(), description: z.string().trim().max(500).nullable().optional(), sortOrder: z.number().int().min(0).max(10_000).optional() }),
    response: categoryView,
  }),
  archiveCategory: endpoint({
    id: 'knowledge.categories.archive',
    method: 'POST',
    path: '/workspaces/{workspaceId}/knowledge/categories/{categoryId}/archive',
    summary: 'Hide a category from pickers; its articles keep it for history.',
    tags: ['Knowledge'],
    auth: 'workspace',
    permission: 'knowledge.write',
    idempotent: true,
    ifMatch: true,
    params: wsId({ categoryId: uuid }),
    body: z.object({ reason: z.string().max(500).optional() }),
    response: categoryView,
  }),
  restoreCategory: endpoint({
    id: 'knowledge.categories.restore',
    method: 'POST',
    path: '/workspaces/{workspaceId}/knowledge/categories/{categoryId}/restore',
    summary: 'Restore an archived category.',
    tags: ['Knowledge'],
    auth: 'workspace',
    permission: 'knowledge.write',
    idempotent: true,
    ifMatch: true,
    params: wsId({ categoryId: uuid }),
    body: z.object({}),
    response: categoryView,
  }),
  list: endpoint({
    id: 'knowledge.articles.list',
    method: 'GET',
    path: '/workspaces/{workspaceId}/articles',
    summary: 'Articles: published ones in the article’s scope, drafts only for authors/editors.',
    tags: ['Knowledge'],
    auth: 'workspace',
    permission: 'knowledge.read',
    params: wsId({}),
    query: pageQuery.extend({
      q: z.string().trim().max(120).optional(),
      categoryId: uuid.optional(),
      status: csv(z.enum(ARTICLE_STATUSES)).optional(),
      scopeType: z.enum(ARTICLE_SCOPE_TYPES).optional(),
      projectId: uuid.optional(),
      directionId: uuid.optional(),
      ownerMembershipId: uuid.optional(),
      required: boolQuery.optional(),
      myReading: z.enum(['open', 'acknowledged']).optional(),
      includeArchived: boolQuery.optional(),
      sort: z.enum(ARTICLE_SORTS).default('updatedAt'),
      direction: z.enum(['asc', 'desc']).default('desc'),
    }),
    response: page(articleRow),
  }),
  get: endpoint({
    id: 'knowledge.articles.get',
    method: 'GET',
    path: '/workspaces/{workspaceId}/articles/{articleId}',
    summary: 'Reader/editor view. Opening an article never records an acknowledgement.',
    tags: ['Knowledge'],
    auth: 'workspace',
    permission: 'knowledge.read',
    params: wsId({ articleId: uuid }),
    response: articleDetail,
  }),
  create: endpoint({
    id: 'knowledge.articles.create',
    method: 'POST',
    path: '/workspaces/{workspaceId}/articles',
    summary: 'Create a draft article (nothing is published until Publish Version).',
    tags: ['Knowledge'],
    auth: 'workspace',
    permission: 'knowledge.write',
    idempotent: true,
    params: wsId({}),
    body: z.object({
      title: shortName,
      categoryId: uuid,
      ...scopeInput,
      ownerMembershipId: uuid,
      requiredReading: z.boolean().optional(),
      body: richTextDoc.optional(),
    }),
    response: articleDetail,
    successStatus: 201,
  }),
  update: endpoint({
    id: 'knowledge.articles.update',
    method: 'PATCH',
    path: '/workspaces/{workspaceId}/articles/{articleId}',
    summary: 'Save the draft (explicit Save Draft or autosave). Published versions never change; the first edit after publishing starts a new draft.',
    tags: ['Knowledge'],
    auth: 'workspace',
    permission: 'knowledge.write',
    ifMatch: true,
    params: wsId({ articleId: uuid }),
    body: z.object({
      title: shortName.optional(),
      categoryId: uuid.optional(),
      scopeType: z.enum(ARTICLE_SCOPE_TYPES).optional(),
      scopeId: uuid.nullable().optional(),
      ownerMembershipId: uuid.optional(),
      requiredReading: z.boolean().optional(),
      body: richTextDoc.optional(),
      /** Autosave of the draft text (aggregated into one history entry per editing session). */
      autosave: z.boolean().optional(),
    }),
    response: articleDetail,
  }),
  publish: endpoint({
    id: 'knowledge.articles.publish',
    method: 'POST',
    path: '/workspaces/{workspaceId}/articles/{articleId}/publish',
    summary: 'Freeze the draft as the published version. Major revisions of required reading create new acknowledgement requests.',
    tags: ['Knowledge'],
    auth: 'workspace',
    permission: 'knowledge.publish',
    idempotent: true,
    ifMatch: true,
    params: wsId({ articleId: uuid }),
    body: z.object({ versionId: uuid, revisionKind: z.enum(REVISION_KINDS), changeNote: z.string().trim().max(1000).optional() }),
    response: articleDetail,
  }),
  discardDraft: endpoint({
    id: 'knowledge.articles.discardDraft',
    method: 'POST',
    path: '/workspaces/{workspaceId}/articles/{articleId}/discard-draft',
    summary: 'Discard the unpublished draft of a published article (the published version stays).',
    tags: ['Knowledge'],
    auth: 'workspace',
    permission: 'knowledge.write',
    idempotent: true,
    ifMatch: true,
    params: wsId({ articleId: uuid }),
    body: z.object({}),
    response: articleDetail,
  }),
  revert: endpoint({
    id: 'knowledge.articles.revert',
    method: 'POST',
    path: '/workspaces/{workspaceId}/articles/{articleId}/revert',
    summary: 'Start a new draft from an earlier version (history is never rewritten).',
    tags: ['Knowledge'],
    auth: 'workspace',
    permission: 'knowledge.write',
    idempotent: true,
    ifMatch: true,
    params: wsId({ articleId: uuid }),
    body: z.object({ versionId: uuid }),
    response: articleDetail,
  }),
  markReviewed: endpoint({
    id: 'knowledge.articles.markReviewed',
    method: 'POST',
    path: '/workspaces/{workspaceId}/articles/{articleId}/mark-reviewed',
    summary: 'Record that the published text was reviewed and is still accurate (no new version).',
    tags: ['Knowledge'],
    auth: 'workspace',
    permission: 'knowledge.publish',
    idempotent: true,
    ifMatch: true,
    params: wsId({ articleId: uuid }),
    body: z.object({ note: z.string().trim().max(500).optional() }),
    response: articleDetail,
  }),
  archive: endpoint({
    id: 'knowledge.articles.archive',
    method: 'POST',
    path: '/workspaces/{workspaceId}/articles/{articleId}/archive',
    summary: 'Archive the article; open reading requests are closed, acknowledgements stay.',
    tags: ['Knowledge'],
    auth: 'workspace',
    permission: 'knowledge.write',
    idempotent: true,
    ifMatch: true,
    params: wsId({ articleId: uuid }),
    body: z.object({ reason: z.string().trim().max(500).optional() }),
    response: articleDetail,
  }),
  archivePreview: endpoint({
    id: 'knowledge.articles.archivePreview',
    method: 'GET',
    path: '/workspaces/{workspaceId}/articles/{articleId}/archive-preview',
    summary: 'Effects of archiving (open reading requests that will be closed).',
    tags: ['Knowledge'],
    auth: 'workspace',
    permission: 'knowledge.write',
    params: wsId({ articleId: uuid }),
    response: z.object({ title: z.string(), rowVersion: z.number().int(), items: z.array(impactItem) }),
  }),
  restore: endpoint({
    id: 'knowledge.articles.restore',
    method: 'POST',
    path: '/workspaces/{workspaceId}/articles/{articleId}/restore',
    summary: 'Restore an archived article (published again if it had a published version).',
    tags: ['Knowledge'],
    auth: 'workspace',
    permission: 'knowledge.write',
    idempotent: true,
    ifMatch: true,
    params: wsId({ articleId: uuid }),
    body: z.object({}),
    response: articleDetail,
  }),
  versions: endpoint({
    id: 'knowledge.articles.versions',
    method: 'GET',
    path: '/workspaces/{workspaceId}/articles/{articleId}/versions',
    summary: 'Version history (drafts only for editors).',
    tags: ['Knowledge'],
    auth: 'workspace',
    permission: 'knowledge.read',
    params: wsId({ articleId: uuid }),
    response: z.array(articleVersionSummary),
  }),
  version: endpoint({
    id: 'knowledge.articles.version',
    method: 'GET',
    path: '/workspaces/{workspaceId}/articles/{articleId}/versions/{versionId}',
    summary: 'One frozen version with its body.',
    tags: ['Knowledge'],
    auth: 'workspace',
    permission: 'knowledge.read',
    params: wsId({ articleId: uuid, versionId: uuid }),
    response: articleVersionDetail,
  }),
  compare: endpoint({
    id: 'knowledge.articles.compare',
    method: 'GET',
    path: '/workspaces/{workspaceId}/articles/{articleId}/compare',
    summary: 'Diff summary between two versions (blocks added, removed, changed).',
    tags: ['Knowledge'],
    auth: 'workspace',
    permission: 'knowledge.read',
    params: wsId({ articleId: uuid }),
    query: z.object({ from: uuid, to: uuid }),
    response: compareResult,
  }),
  assignReading: endpoint({
    id: 'knowledge.articles.assignReading',
    method: 'POST',
    path: '/workspaces/{workspaceId}/articles/{articleId}/assign-reading',
    summary: 'Create acknowledgement requests for members, role holders or project teams (only members who can read the article).',
    tags: ['Knowledge'],
    auth: 'workspace',
    permission: 'knowledge.publish',
    idempotent: true,
    params: wsId({ articleId: uuid }),
    body: z
      .object({
        versionId: uuid,
        membershipIds: z.array(uuid).max(200).default([]),
        roleIds: z.array(uuid).max(50).default([]),
        projectIds: z.array(uuid).max(50).default([]),
        dueAt: isoDateTime.nullable().optional(),
      })
      .refine((v) => v.membershipIds.length + v.roleIds.length + v.projectIds.length > 0, { message: 'Choose at least one member, role or project.', path: ['membershipIds'] }),
    response: z.object({
      created: z.number().int(),
      alreadyAssigned: z.number().int(),
      skippedNoAccess: z.number().int(),
      skippedInactive: z.number().int(),
    }),
  }),
  readingStatus: endpoint({
    id: 'knowledge.articles.reading',
    method: 'GET',
    path: '/workspaces/{workspaceId}/articles/{articleId}/reading',
    summary: 'Acknowledgement requests of the article and their state (authors, editors and publishers).',
    tags: ['Knowledge'],
    auth: 'workspace',
    permission: 'knowledge.read',
    params: wsId({ articleId: uuid }),
    query: pageQuery.extend({ status: csv(z.enum(READING_STATUSES)).optional() }),
    response: page(readingAssignmentRow),
  }),
  cancelReading: endpoint({
    id: 'knowledge.articles.cancelReading',
    method: 'POST',
    path: '/workspaces/{workspaceId}/reading-assignments/{assignmentId}/cancel',
    summary: 'Withdraw an open acknowledgement request (the history stays).',
    tags: ['Knowledge'],
    auth: 'workspace',
    permission: 'knowledge.publish',
    idempotent: true,
    params: wsId({ assignmentId: uuid }),
    body: z.object({ reason }),
    response: okResponse,
  }),
  acknowledge: endpoint({
    id: 'knowledge.articles.acknowledge',
    method: 'POST',
    path: '/workspaces/{workspaceId}/articles/{articleId}/acknowledge',
    summary: 'Explicit reading acknowledgement of the current published version.',
    tags: ['Knowledge'],
    auth: 'workspace',
    permission: 'knowledge.acknowledge',
    idempotent: true,
    params: wsId({ articleId: uuid }),
    body: z.object({ versionId: uuid }),
    response: z.object({ versionId: uuid, versionNo: z.number().int(), acknowledgedAt: isoDateTime, fulfilledRequests: z.number().int() }),
  }),
  myReading: endpoint({
    id: 'knowledge.myReading',
    method: 'GET',
    path: '/workspaces/{workspaceId}/knowledge/my-reading',
    summary: 'The member’s own required reading (open requests first).',
    tags: ['Knowledge'],
    auth: 'workspace',
    params: wsId({}),
    query: pageQuery.extend({ status: z.enum(['open', 'acknowledged']).default('open') }),
    response: page(myReadingRow),
  }),
  audiences: endpoint({
    id: 'knowledge.audiences',
    method: 'GET',
    path: '/workspaces/{workspaceId}/knowledge/reading-audiences',
    summary: 'Roles that can be chosen as a reading audience, with their active member counts.',
    tags: ['Knowledge'],
    auth: 'workspace',
    permission: 'knowledge.publish',
    params: wsId({}),
    response: z.object({ roles: z.array(z.object({ id: uuid, name: z.string(), memberCount: z.number().int() })) }),
  }),
  createTask: endpoint({
    id: 'knowledge.articles.createTask',
    method: 'POST',
    path: '/workspaces/{workspaceId}/articles/{articleId}/create-task',
    summary: 'Create a project task whose checklist is copied from a checklist of the published version.',
    tags: ['Knowledge'],
    auth: 'workspace',
    permission: 'tasks.create',
    idempotent: true,
    params: wsId({ articleId: uuid }),
    body: z.object({
      versionId: uuid,
      /** Position of the checklist block in the version body. */
      blockIndex: z.number().int().min(0).max(5000),
      projectId: uuid,
      title: taskTitle,
      assigneeMembershipId: uuid.nullable().optional(),
      dueAt: isoDateTime.nullable().optional(),
    }),
    response: z.object({ taskId: uuid, checklistItems: z.number().int() }),
    successStatus: 201,
  }),
};
