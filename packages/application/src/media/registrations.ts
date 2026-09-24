import { and, asc, eq, gt, ilike, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { assets, assetVersions, folders, projects } from '@castlane/database';
import { ASSET_KINDS, SENSITIVITIES } from '@castlane/domain';
import { requirePermission, whereAll } from '../core/access';
import { defineArchiveHandler } from '../core/archive-registry';
import { dbOf } from '../core/context';
import { defineExportDataset } from '../core/export-registry';
import { defineLookup, likePattern } from '../core/lookup-registry';
import { loadMemberRefs } from '../core/members';
import { archiveAsset, assetArchivePreview, assetListWhere, restoreAsset, type AssetListFilter } from './assets';
import { archiveFolder, folderArchivePreview, folderVisibility, restoreFolder } from './folders';

// ——— Pickers ———

defineLookup({
  type: 'asset',
  async search(ctx, input) {
    requirePermission(ctx, 'assets.read');
    const kinds = (input.status ?? []).filter((s): s is (typeof ASSET_KINDS)[number] => (ASSET_KINDS as readonly string[]).includes(s));
    const rows = await dbOf(ctx)
      .select({ id: assets.id, name: assets.name, kind: assets.kind, projectId: assets.projectId, archivedAt: assets.archivedAt, projectName: projects.name })
      .from(assets)
      .leftJoin(projects, and(eq(projects.workspaceId, assets.workspaceId), eq(projects.id, assets.projectId)))
      .where(
        whereAll(
          assetListWhere(ctx, {
            projectId: input.projectId,
            folderId: input.parentId,
            kind: kinds.length ? kinds : undefined,
            archived: input.ids?.length || input.includeArchived ? 'include' : 'exclude',
          }),
          input.ids?.length ? inArray(assets.id, input.ids) : undefined,
          input.q ? ilike(assets.name, likePattern(input.q)) : undefined,
        ),
      )
      .orderBy(asc(assets.name))
      .limit(input.ids?.length ? Math.max(input.ids.length, input.limit) : input.limit);
    return rows.map((r) => ({
      id: r.id,
      label: r.name,
      sublabel: [r.kind === 'external_link' ? 'External Link' : r.kind.charAt(0).toUpperCase() + r.kind.slice(1), r.projectName].filter(Boolean).join(' · ') || null,
      status: r.kind,
      projectId: r.projectId,
      archived: !!r.archivedAt,
    }));
  },
});

defineLookup({
  type: 'folder',
  async search(ctx, input) {
    requirePermission(ctx, 'assets.read');
    const rows = await dbOf(ctx)
      .select({ id: folders.id, name: folders.name, projectId: folders.projectId, archivedAt: folders.archivedAt, depth: folders.depth, projectName: projects.name })
      .from(folders)
      .leftJoin(projects, and(eq(projects.workspaceId, folders.workspaceId), eq(projects.id, folders.projectId)))
      .where(
        whereAll(
          eq(folders.workspaceId, ctx.actor.workspaceId),
          folderVisibility(ctx),
          input.ids?.length ? inArray(folders.id, input.ids) : undefined,
          !input.ids?.length && !input.includeArchived ? isNull(folders.archivedAt) : undefined,
          input.projectId ? or(eq(folders.projectId, input.projectId), isNull(folders.projectId)) : undefined,
          input.parentId ? eq(folders.parentId, input.parentId) : undefined,
          input.q ? ilike(folders.name, likePattern(input.q)) : undefined,
        ),
      )
      .orderBy(asc(folders.nameKey))
      .limit(input.ids?.length ? Math.max(input.ids.length, input.limit) : input.limit);
    return rows.map((r) => ({
      id: r.id,
      label: r.name,
      sublabel: r.projectName ?? 'Workspace library',
      status: null,
      projectId: r.projectId,
      archived: !!r.archivedAt,
    }));
  },
});

// ——— Archive / restore (generic Archive screen) ———

defineArchiveHandler({
  entityType: 'asset',
  label: 'File',
  preview: assetArchivePreview,
  archive: async (ctx, id, input) => {
    await archiveAsset(ctx, id, input.reason, { skipVersion: true });
  },
  restorePreview: async (ctx, id) => {
    const p = await assetArchivePreview(ctx, id);
    return { title: p.title, items: [] };
  },
  restore: async (ctx, id) => {
    await restoreAsset(ctx, id, { skipVersion: true });
  },
});

defineArchiveHandler({
  entityType: 'folder',
  label: 'Folder',
  preview: folderArchivePreview,
  archive: async (ctx, id, input) => {
    await archiveFolder(ctx, id, { reason: input.reason }, { skipVersion: true });
  },
  restorePreview: async (ctx, id) => {
    const p = await folderArchivePreview(ctx, id);
    return { title: p.title, items: [] };
  },
  restore: async (ctx, id) => {
    await restoreFolder(ctx, id, { skipVersion: true });
  },
});

// ——— Export Center: asset metadata inventory (never file contents or URLs to stored files) ———

const PAGE = 500;

defineExportDataset({
  key: 'assets.inventory',
  label: 'Library — file inventory',
  permission: 'assets.read',
  classification: 'normal',
  columns: [
    { key: 'id', label: 'File ID', type: 'id', default: true },
    { key: 'name', label: 'Name', type: 'text', default: true },
    { key: 'kind', label: 'Type', type: 'text', default: true },
    { key: 'project', label: 'Project', type: 'text', default: true },
    { key: 'folder', label: 'Folder', type: 'text', default: true },
    { key: 'sensitivity', label: 'Sensitivity', type: 'text', default: true },
    { key: 'tags', label: 'Tags', type: 'text', default: true },
    { key: 'status', label: 'Processing Status', type: 'text', default: true },
    { key: 'versionNo', label: 'Current Version', type: 'integer', default: true },
    { key: 'originalFilename', label: 'Original Filename', type: 'text' },
    { key: 'mime', label: 'MIME Type', type: 'text', default: true },
    { key: 'byteSize', label: 'Size (bytes)', type: 'integer', default: true },
    { key: 'width', label: 'Width (px)', type: 'integer' },
    { key: 'height', label: 'Height (px)', type: 'integer' },
    { key: 'durationMs', label: 'Duration (ms)', type: 'integer' },
    { key: 'checksumSha256', label: 'SHA-256', type: 'text' },
    { key: 'externalUrl', label: 'External Link', type: 'text' },
    { key: 'uploader', label: 'Uploader', type: 'text', default: true },
    { key: 'usageLinks', label: 'Usage Links', type: 'integer', default: true },
    { key: 'createdAt', label: 'Created At', type: 'datetime', default: true },
    { key: 'updatedAt', label: 'Updated At', type: 'datetime' },
    { key: 'archivedAt', label: 'Archived At', type: 'datetime' },
  ],
  filters: [
    { key: 'projectId', label: 'Project', type: 'reference', lookup: 'project' },
    { key: 'folderId', label: 'Folder', type: 'reference', lookup: 'folder' },
    { key: 'kind', label: 'Type', type: 'enum', enumValues: ASSET_KINDS },
    { key: 'sensitivity', label: 'Sensitivity', type: 'enum', enumValues: SENSITIVITIES },
    { key: 'q', label: 'Name contains', type: 'text' },
  ],
  async *rows(ctx, { filters, boundAt }) {
    requirePermission(ctx, 'assets.read');
    const f: AssetListFilter = {
      projectId: typeof filters.projectId === 'string' ? filters.projectId : undefined,
      folderId: typeof filters.folderId === 'string' ? filters.folderId : undefined,
      kind: Array.isArray(filters.kind) ? (filters.kind as AssetListFilter['kind']) : typeof filters.kind === 'string' ? ([filters.kind] as AssetListFilter['kind']) : undefined,
      sensitivity: filters.sensitivity === 'restricted' || filters.sensitivity === 'normal' ? filters.sensitivity : undefined,
      q: typeof filters.q === 'string' ? filters.q : undefined,
      archived: 'include',
    };
    const fetchPage = (after: { createdAt: Date; id: string } | null) =>
      ctx.app.db
        .select({
          a: assets,
          v: assetVersions,
          project: projects.name,
          folder: folders.name,
          usage: sql<number>`(SELECT count(*) FROM asset_links l WHERE l.asset_id = ${assets.id} AND l.removed_at IS NULL)::int`,
        })
        .from(assets)
        .leftJoin(assetVersions, eq(assetVersions.id, assets.currentVersionId))
        .leftJoin(projects, and(eq(projects.workspaceId, assets.workspaceId), eq(projects.id, assets.projectId)))
        .leftJoin(folders, and(eq(folders.workspaceId, assets.workspaceId), eq(folders.id, assets.folderId)))
        .where(
          whereAll(
            assetListWhere(ctx, f),
            lte(assets.createdAt, boundAt),
            after ? or(gt(assets.createdAt, after.createdAt), and(eq(assets.createdAt, after.createdAt), gt(assets.id, after.id))) : undefined,
          ),
        )
        .orderBy(asc(assets.createdAt), asc(assets.id))
        .limit(PAGE);
    let after: { createdAt: Date; id: string } | null = null;
    for (;;) {
      const page = await fetchPage(after);
      if (!page.length) return;
      const refs = await loadMemberRefs(ctx.app.db, ctx.actor.workspaceId, page.map((r) => r.a.ownerMembershipId));
      for (const r of page) {
        yield {
          id: r.a.id,
          name: r.a.name,
          kind: r.a.kind,
          project: r.project ?? null,
          folder: r.folder ?? null,
          sensitivity: r.a.sensitivity,
          tags: r.a.tags.join(', '),
          status: r.a.kind === 'external_link' ? 'external' : (r.v?.status ?? 'uploading'),
          versionNo: r.v?.versionNo ?? null,
          originalFilename: r.v?.originalFilename ?? null,
          mime: r.v?.detectedMime ?? r.v?.declaredMime ?? null,
          byteSize: r.v?.byteSize ?? null,
          width: r.v?.width ?? null,
          height: r.v?.height ?? null,
          durationMs: r.v?.durationMs ?? null,
          checksumSha256: r.v?.checksumSha256 ?? null,
          externalUrl: r.a.externalUrl,
          uploader: r.a.ownerMembershipId ? (refs.get(r.a.ownerMembershipId)?.displayName ?? null) : null,
          usageLinks: Number(r.usage),
          createdAt: r.a.createdAt.toISOString(),
          updatedAt: r.a.updatedAt.toISOString(),
          archivedAt: r.a.archivedAt?.toISOString() ?? null,
        };
      }
      const last = page[page.length - 1]!;
      after = { createdAt: last.a.createdAt, id: last.a.id };
      if (page.length < PAGE) return;
    }
  },
});
