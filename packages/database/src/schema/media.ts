import { bigint, index, pgTable, uniqueIndex } from 'drizzle-orm/pg-core';
import {
  ARTICLE_STATUSES,
  ASSET_KINDS,
  ASSET_VERSION_STATUSES,
  REVISION_KINDS,
  SENSITIVITIES,
  UPLOAD_SESSION_STATES,
} from '@castlane/domain';
import { archivable, boolean, rawCheck, enumCheck, enumText, integer, json, sql, tenantBase, text, tfk, trashable, ts, uuid } from '../columns';
import { memberships, tenantUnique } from './identity';
import { projects } from './organization';

export const folders = pgTable(
  'folders',
  {
    ...tenantBase(),
    ...archivable(),
    parentId: uuid('parent_id'),
    name: text('name').notNull(),
    projectId: uuid('project_id'),
    depth: integer('depth').notNull().default(0),
  },
  (t) => [
    tenantUnique('folders', t),
    tfk('folders_parent_fk', t.workspaceId, t.parentId, t),
    tfk('folders_project_fk', t.workspaceId, t.projectId, projects),
    index('folders_parent_idx').on(t.workspaceId, t.parentId),
    rawCheck('folders_depth_ck', '"depth" BETWEEN 0 AND 5'),
  ],
);

export const assets = pgTable(
  'assets',
  {
    ...tenantBase(),
    ...archivable(),
    ...trashable(),
    name: text('name').notNull(),
    kind: enumText('kind', ASSET_KINDS).notNull(),
    folderId: uuid('folder_id'),
    /** Scope classification; null = workspace library. */
    projectId: uuid('project_id'),
    sensitivity: enumText('sensitivity', SENSITIVITIES).notNull().default('normal'),
    tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
    currentVersionId: uuid('current_version_id'),
    /** For external_link assets only; never fetched by the server. */
    externalUrl: text('external_url'),
    ownerMembershipId: uuid('owner_membership_id'),
    description: text('description'),
  },
  (t) => [
    tenantUnique('assets', t),
    tfk('assets_folder_fk', t.workspaceId, t.folderId, folders),
    tfk('assets_project_fk', t.workspaceId, t.projectId, projects),
    index('assets_list_idx').on(t.workspaceId, t.updatedAt, t.id),
    enumCheck('assets_kind_ck', 'kind', ASSET_KINDS),
    enumCheck('assets_sensitivity_ck', 'sensitivity', SENSITIVITIES),
  ],
);

export interface AssetScanResult {
  engine: string;
  clean: boolean;
  signature?: string;
  scannedAt: string;
  /** True only in non-production environments where scanning is explicitly disabled. */
  devBypass?: boolean;
}

/** Immutable stored object. Replacement always creates a new version. */
export const assetVersions = pgTable(
  'asset_versions',
  {
    ...tenantBase(),
    assetId: uuid('asset_id').notNull(),
    versionNo: integer('version_no').notNull(),
    status: enumText('status', ASSET_VERSION_STATUSES).notNull().default('uploading'),
    storageKey: text('storage_key'),
    quarantineKey: text('quarantine_key'),
    storageVersionId: text('storage_version_id'),
    originalFilename: text('original_filename').notNull(),
    declaredMime: text('declared_mime'),
    detectedMime: text('detected_mime'),
    byteSize: bigint('byte_size', { mode: 'number' }),
    checksumSha256: text('checksum_sha256'),
    width: integer('width'),
    height: integer('height'),
    durationMs: integer('duration_ms'),
    pageCount: integer('page_count'),
    scanResult: json<AssetScanResult>('scan_result'),
    rejectionReason: text('rejection_reason'),
    processedAt: ts('processed_at'),
    note: text('note'),
    reusedFromVersionId: uuid('reused_from_version_id'),
  },
  (t) => [
    tenantUnique('asset_versions', t),
    tfk('asset_versions_asset_fk', t.workspaceId, t.assetId, assets),
    uniqueIndex('asset_versions_no_uq').on(t.assetId, t.versionNo),
    index('asset_versions_checksum_idx').on(t.workspaceId, t.checksumSha256),
    enumCheck('asset_versions_status_ck', 'status', ASSET_VERSION_STATUSES),
  ],
);

export const assetDerivatives = pgTable(
  'asset_derivatives',
  {
    ...tenantBase(),
    assetVersionId: uuid('asset_version_id').notNull(),
    kind: text('kind').notNull(),
    storageKey: text('storage_key').notNull(),
    mime: text('mime').notNull(),
    width: integer('width'),
    height: integer('height'),
    byteSize: bigint('byte_size', { mode: 'number' }),
  },
  (t) => [
    tenantUnique('asset_derivatives', t),
    tfk('asset_derivatives_version_fk', t.workspaceId, t.assetVersionId, assetVersions),
    uniqueIndex('asset_derivatives_kind_uq').on(t.assetVersionId, t.kind),
  ],
);

/** Contextual usage of an asset. Removing a link never removes the blob. */
export const assetLinks = pgTable(
  'asset_links',
  {
    ...tenantBase(),
    assetId: uuid('asset_id').notNull(),
    assetVersionId: uuid('asset_version_id'),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    role: text('role').notNull().default('attachment'),
    projectId: uuid('project_id'),
    /** Holding links (approved content, published placement, finance evidence) block deletion. */
    holding: boolean('holding').notNull().default(false),
    removedAt: ts('removed_at'),
    removedBy: uuid('removed_by'),
  },
  (t) => [
    tenantUnique('asset_links', t),
    tfk('asset_links_asset_fk', t.workspaceId, t.assetId, assets),
    tfk('asset_links_version_fk', t.workspaceId, t.assetVersionId, assetVersions),
    index('asset_links_entity_idx').on(t.workspaceId, t.entityType, t.entityId),
    index('asset_links_asset_idx').on(t.workspaceId, t.assetId),
  ],
);

export interface UploadTargetRef {
  entityType: string;
  entityId: string;
  role?: string;
}

export const uploadSessions = pgTable(
  'upload_sessions',
  {
    ...tenantBase(),
    assetId: uuid('asset_id'),
    assetVersionId: uuid('asset_version_id'),
    targetRef: json<UploadTargetRef | null>('target_ref'),
    folderId: uuid('folder_id'),
    projectId: uuid('project_id'),
    sensitivity: enumText('sensitivity', SENSITIVITIES).notNull().default('normal'),
    filename: text('filename').notNull(),
    purpose: text('purpose').notNull().default('general'),
    declaredMime: text('declared_mime').notNull(),
    declaredSize: bigint('declared_size', { mode: 'number' }).notNull(),
    expectedChecksum: text('expected_checksum'),
    quarantineKey: text('quarantine_key').notNull(),
    multipartUploadId: text('multipart_upload_id'),
    partSize: integer('part_size').notNull(),
    parts: json<{ partNumber: number; etag: string; size: number }[]>('parts').notNull().default([]),
    state: enumText('state', UPLOAD_SESSION_STATES).notNull().default('open'),
    reservedBytes: bigint('reserved_bytes', { mode: 'number' }).notNull(),
    expiresAt: ts('expires_at').notNull(),
    completedAt: ts('completed_at'),
    ownerMembershipId: uuid('owner_membership_id').notNull(),
  },
  (t) => [
    tenantUnique('upload_sessions', t),
    index('upload_sessions_state_idx').on(t.state, t.expiresAt),
    enumCheck('upload_sessions_state_ck', 'state', UPLOAD_SESSION_STATES),
  ],
);

export const articleCategories = pgTable(
  'article_categories',
  {
    ...tenantBase(),
    ...archivable(),
    name: text('name').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => [tenantUnique('article_categories', t)],
);

export const articles = pgTable(
  'articles',
  {
    ...tenantBase(),
    ...archivable(),
    categoryId: uuid('category_id').notNull(),
    title: text('title').notNull(),
    scopeType: text('scope_type', { enum: ['workspace', 'direction', 'project'] }).notNull().default('workspace'),
    scopeId: uuid('scope_id'),
    ownerMembershipId: uuid('owner_membership_id').notNull(),
    status: enumText('status', ARTICLE_STATUSES).notNull().default('draft'),
    draftVersionId: uuid('draft_version_id'),
    publishedVersionId: uuid('published_version_id'),
    requiredReading: boolean('required_reading').notNull().default(false),
    lastReviewedAt: ts('last_reviewed_at'),
    coverAssetId: uuid('cover_asset_id'),
  },
  (t) => [
    tenantUnique('articles', t),
    tfk('articles_category_fk', t.workspaceId, t.categoryId, articleCategories),
    tfk('articles_owner_fk', t.workspaceId, t.ownerMembershipId, memberships),
    enumCheck('articles_status_ck', 'status', ARTICLE_STATUSES),
  ],
);

/** Structured rich-text document (sanitised node tree, no raw HTML). */
export interface RichTextDoc {
  type: 'doc';
  content: unknown[];
}

export const articleVersions = pgTable(
  'article_versions',
  {
    ...tenantBase(),
    articleId: uuid('article_id').notNull(),
    versionNo: integer('version_no').notNull(),
    title: text('title').notNull(),
    body: json<RichTextDoc>('body').notNull(),
    bodyText: text('body_text').notNull().default(''),
    state: text('state', { enum: ['draft', 'published', 'superseded'] }).notNull().default('draft'),
    revisionKind: enumText('revision_kind', REVISION_KINDS),
    changeNote: text('change_note'),
    publishedAt: ts('published_at'),
    publishedBy: uuid('published_by'),
  },
  (t) => [
    tenantUnique('article_versions', t),
    tfk('article_versions_article_fk', t.workspaceId, t.articleId, articles),
    uniqueIndex('article_versions_no_uq').on(t.articleId, t.versionNo),
  ],
);

export const articleAcknowledgements = pgTable(
  'article_acknowledgements',
  {
    ...tenantBase(),
    articleId: uuid('article_id').notNull(),
    articleVersionId: uuid('article_version_id').notNull(),
    membershipId: uuid('membership_id').notNull(),
    acknowledgedAt: ts('acknowledged_at').notNull(),
  },
  (t) => [
    tenantUnique('article_acknowledgements', t),
    tfk('article_ack_version_fk', t.workspaceId, t.articleVersionId, articleVersions),
    tfk('article_ack_member_fk', t.workspaceId, t.membershipId, memberships),
    uniqueIndex('article_ack_uq').on(t.articleVersionId, t.membershipId),
  ],
);

export const readingAssignments = pgTable(
  'reading_assignments',
  {
    ...tenantBase(),
    articleId: uuid('article_id').notNull(),
    articleVersionId: uuid('article_version_id').notNull(),
    membershipId: uuid('membership_id').notNull(),
    dueAt: ts('due_at'),
    status: text('status', { enum: ['open', 'acknowledged', 'cancelled'] }).notNull().default('open'),
    acknowledgedAt: ts('acknowledged_at'),
  },
  (t) => [
    tenantUnique('reading_assignments', t),
    tfk('reading_assignments_version_fk', t.workspaceId, t.articleVersionId, articleVersions),
    tfk('reading_assignments_member_fk', t.workspaceId, t.membershipId, memberships),
    uniqueIndex('reading_assignments_uq').on(t.articleVersionId, t.membershipId),
  ],
);
