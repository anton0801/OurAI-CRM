import { and, asc, count, desc, eq, gt, gte, ilike, inArray, isNull, lt, lte, ne, or, sql, type SQL } from 'drizzle-orm';
import { hasAnywhere } from '@castlane/authorization';
import { assetDerivatives, assetLinks, assets, assetVersions, auditEvents, folders, memberships, projects, workspaces, type DbOrTx } from '@castlane/database';
import { AppError, clampPageSize, decodeCursor, encodeCursor, newId, notFound } from '@castlane/domain';
import type { ImpactItem } from '@castlane/api-contracts';
import { allowed, authorizeObject, requirePermission, scopePredicate, whereAll } from '../core/access';
import { audit, diffFields } from '../core/audit';
import { all, dbOf, type CommandContext, type QueryContext } from '../core/context';
import { hmac } from '../core/crypto';
import { emit } from '../core/events';
import { loadMemberRefs, type MemberRef } from '../core/members';
import { assertVersion, lockById, stamp, touch } from '../core/rows';
import { indexSearchDocument, removeSearchDocument } from '../core/search';
import { resolveTags } from '../core/tags';
import { LINK_ACCESS, resolveLinkTarget } from './link-access';

type AssetRow = typeof assets.$inferSelect;
type VersionRow = typeof assetVersions.$inferSelect;

const DEFAULT_TRASH_DAYS = 30;

export const assetScope = (a: Pick<AssetRow, 'id' | 'projectId' | 'ownerMembershipId'>) => ({
  objectType: 'asset',
  objectId: a.id,
  projectId: a.projectId,
  ownerMembershipId: a.ownerMembershipId,
});

/** Restricted media needs assets.restricted.read in the file's scope for anything beyond "it does not exist". */
export const canSeeRestricted = (ctx: QueryContext, a: Pick<AssetRow, 'projectId' | 'sensitivity'>) =>
  a.sensitivity !== 'restricted' || allowed(ctx, 'assets.restricted.read', { projectId: a.projectId });

/** SQL visibility of restricted media: normal files, or restricted files inside the restricted-media scope. */
export const restrictedVisibility = (ctx: QueryContext): SQL | undefined => {
  const pred = scopePredicate(ctx, 'assets.restricted.read', { projectId: assets.projectId });
  if (pred === undefined) return undefined;
  return or(eq(assets.sensitivity, 'normal'), pred);
};

/**
 * An asset is readable when the actor can read it in its own project scope (assets.read), or can
 * read at least one entity it is linked to (registered link-access resolvers). Restricted media
 * is invisible without assets.restricted.read (no metadata leak, T078/T079).
 */
export const canReadAsset = async (ctx: QueryContext, a: AssetRow): Promise<boolean> => {
  if (a.deletedAt) return false;
  if (!canSeeRestricted(ctx, a)) return false;
  if (allowed(ctx, 'assets.read', assetScope(a))) return true;
  const links = await dbOf(ctx)
    .select({ entityType: assetLinks.entityType, entityId: assetLinks.entityId })
    .from(assetLinks)
    .where(and(eq(assetLinks.workspaceId, ctx.actor.workspaceId), eq(assetLinks.assetId, a.id), isNull(assetLinks.removedAt)))
    .limit(50);
  for (const l of links) if (await resolveLinkTarget(ctx, l.entityType, l.entityId)) return true;
  return false;
};

export const loadReadableAsset = async (ctx: QueryContext, assetId: string): Promise<AssetRow> => {
  const [a] = await dbOf(ctx).select().from(assets).where(and(eq(assets.workspaceId, ctx.actor.workspaceId), eq(assets.id, assetId)));
  if (!a || a.deletedAt || !(await canReadAsset(ctx, a))) throw notFound('File');
  return a;
};

/** Membership references for user ids (row authors are stored as user ids). */
export const loadUserMemberRefs = async (db: DbOrTx, workspaceId: string, userIds: (string | null | undefined)[]): Promise<Map<string, MemberRef>> => {
  const unique = [...new Set(userIds.filter((x): x is string => !!x))];
  const out = new Map<string, MemberRef>();
  if (!unique.length) return out;
  const ms = await db
    .select({ id: memberships.id, userId: memberships.userId })
    .from(memberships)
    .where(and(eq(memberships.workspaceId, workspaceId), inArray(memberships.userId, unique)));
  const refs = await loadMemberRefs(db, workspaceId, ms.map((m) => m.id));
  for (const m of ms) {
    const r = refs.get(m.id);
    if (r) out.set(m.userId, r);
  }
  return out;
};

const versionView = (v: VersionRow, refs: Map<string, MemberRef>, previewAvailable: boolean, currentId: string | null) => ({
  id: v.id,
  versionNo: v.versionNo,
  status: v.status,
  originalFilename: v.originalFilename,
  mime: v.detectedMime ?? v.declaredMime,
  byteSize: v.byteSize,
  width: v.width,
  height: v.height,
  durationMs: v.durationMs,
  checksumSha256: v.checksumSha256,
  scan: v.scanResult ? { engine: v.scanResult.engine, clean: v.scanResult.clean, devBypass: v.scanResult.devBypass } : null,
  rejectionReason: v.rejectionReason,
  note: v.note,
  createdAt: v.createdAt.toISOString(),
  createdBy: v.createdBy ? (refs.get(v.createdBy) ?? null) : null,
  previewAvailable: previewAvailable && !v.deletedAt,
  deletedAt: v.deletedAt?.toISOString() ?? null,
  isCurrent: v.id === currentId,
});

const thumbUrl = (a: AssetRow, versionId: string, size = 256) => `/api/v1/workspaces/${a.workspaceId}/assets/${a.id}/thumbnail?size=${size}&versionId=${versionId}`;

export const canDownloadAsset = (ctx: QueryContext, a: AssetRow) =>
  (allowed(ctx, 'assets.download', assetScope(a)) || hasAnywhere(ctx.actor.access, 'assets.download')) && canSeeRestricted(ctx, a);

export const toAssetView = async (ctx: QueryContext, rows: AssetRow[]) => {
  if (rows.length === 0) return [];
  const db = dbOf(ctx);
  const ws = ctx.actor.workspaceId;
  const ids = rows.map((r) => r.id);
  const currentIds = rows.map((r) => r.currentVersionId).filter((x): x is string => !!x);
  const [current, latest, usage, projectRows] = await all(ctx, [
    () => (currentIds.length ? db.select().from(assetVersions).where(inArray(assetVersions.id, currentIds)) : Promise.resolve([] as VersionRow[])),
    () =>
      db
        .selectDistinctOn([assetVersions.assetId])
        .from(assetVersions)
        .where(and(eq(assetVersions.workspaceId, ws), inArray(assetVersions.assetId, ids), isNull(assetVersions.deletedAt)))
        .orderBy(assetVersions.assetId, desc(assetVersions.versionNo)),
    () =>
      db
        .select({ assetId: assetLinks.assetId, n: count() })
        .from(assetLinks)
        .where(and(eq(assetLinks.workspaceId, ws), inArray(assetLinks.assetId, ids), isNull(assetLinks.removedAt)))
        .groupBy(assetLinks.assetId),
    () => {
      const pids = [...new Set(rows.map((r) => r.projectId).filter((x): x is string => !!x))];
      return pids.length ? db.select({ id: projects.id, name: projects.name }).from(projects).where(and(eq(projects.workspaceId, ws), inArray(projects.id, pids))) : Promise.resolve([]);
    },
  ] as const);
  const versionIds = [...new Set([...current.map((v) => v.id), ...latest.map((v) => v.id)])];
  const derivs = versionIds.length ? await db.select({ versionId: assetDerivatives.assetVersionId }).from(assetDerivatives).where(inArray(assetDerivatives.assetVersionId, versionIds)) : [];
  const hasDeriv = new Set(derivs.map((d) => d.versionId));
  const byId = new Map(current.map((v) => [v.id, v]));
  const latestBy = new Map(latest.map((v) => [v.assetId, v]));
  const usageBy = new Map(usage.map((u) => [u.assetId, Number(u.n)]));
  const projectName = new Map(projectRows.map((p) => [p.id, p.name]));
  const ownerRefs = await loadMemberRefs(db, ws, rows.map((r) => r.ownerMembershipId));
  const userRefs = await loadUserMemberRefs(db, ws, [...current, ...latest].map((v) => v.createdBy));
  return rows.map((a) => {
    const v = a.currentVersionId ? byId.get(a.currentVersionId) : undefined;
    const l = latestBy.get(a.id);
    const pending = l && l.id !== a.currentVersionId ? l : undefined;
    const restricted = a.sensitivity === 'restricted';
    return {
      id: a.id,
      name: a.name,
      kind: a.kind,
      projectId: a.projectId,
      projectName: a.projectId && allowed(ctx, 'projects.read', { projectId: a.projectId }) ? (projectName.get(a.projectId) ?? null) : null,
      folderId: a.folderId,
      sensitivity: a.sensitivity,
      tags: a.tags,
      description: a.description,
      externalUrl: a.externalUrl,
      currentVersion: v ? versionView(v, userRefs, hasDeriv.has(v.id), a.currentVersionId) : null,
      pendingVersion: pending ? versionView(pending, userRefs, hasDeriv.has(pending.id), a.currentVersionId) : null,
      owner: a.ownerMembershipId ? (ownerRefs.get(a.ownerMembershipId) ?? null) : null,
      usageCount: usageBy.get(a.id) ?? 0,
      archivedAt: a.archivedAt?.toISOString() ?? null,
      createdAt: a.createdAt.toISOString(),
      updatedAt: a.updatedAt.toISOString(),
      rowVersion: a.rowVersion,
      thumbnailUrl: v && hasDeriv.has(v.id) && !restricted ? thumbUrl(a, v.id) : null,
      canDownload: !!v && v.status === 'available' && !v.deletedAt && canDownloadAsset(ctx, a),
      restrictedHidden: restricted,
      canReveal: restricted && canSeeRestricted(ctx, a) && !!v && hasDeriv.has(v.id),
    };
  });
};
export type AssetViewModel = Awaited<ReturnType<typeof toAssetView>>[number];

const escapeLike = (q: string) => `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;

export interface AssetListFilter {
  q?: string;
  projectId?: string;
  folderId?: string;
  rootOnly?: boolean;
  kind?: AssetRow['kind'][];
  tag?: string[];
  sensitivity?: AssetRow['sensitivity'];
  status?: string[];
  uploaderMembershipId?: string;
  accountId?: string;
  updatedFrom?: string;
  updatedTo?: string;
  archived?: 'exclude' | 'include' | 'only';
  includeArchived?: boolean;
}

/** Library predicate: scope and restricted-media visibility are part of the SQL (before paging and counts). */
export const assetListWhere = (ctx: QueryContext, f: AssetListFilter): SQL | undefined => {
  const archived = f.archived ?? (f.includeArchived ? 'include' : 'exclude');
  const statuses = (f.status ?? []).filter((s) => s !== 'external');
  const wantsExternal = (f.status ?? []).includes('external');
  const tagList = (f.tag ?? []).map((t) => t.trim()).filter(Boolean);
  return whereAll(
    eq(assets.workspaceId, ctx.actor.workspaceId),
    isNull(assets.deletedAt),
    scopePredicate(ctx, 'assets.read', { projectId: assets.projectId, ownerMembership: assets.ownerMembershipId }),
    restrictedVisibility(ctx),
    archived === 'exclude' ? isNull(assets.archivedAt) : archived === 'only' ? sql`${assets.archivedAt} IS NOT NULL` : undefined,
    f.projectId ? eq(assets.projectId, f.projectId) : undefined,
    f.folderId ? eq(assets.folderId, f.folderId) : f.rootOnly ? isNull(assets.folderId) : undefined,
    f.kind?.length ? inArray(assets.kind, f.kind) : undefined,
    tagList.length
      ? sql`EXISTS (SELECT 1 FROM unnest(${assets.tags}) t WHERE lower(t) IN (${sql.join(
          tagList.map((t) => sql`${t.toLowerCase()}`),
          sql`, `,
        )}))`
      : undefined,
    f.sensitivity ? eq(assets.sensitivity, f.sensitivity) : undefined,
    statuses.length || wantsExternal
      ? or(
          wantsExternal ? eq(assets.kind, 'external_link') : undefined,
          statuses.length
            ? sql`(SELECT v.status FROM asset_versions v WHERE v.asset_id = ${assets.id} AND v.deleted_at IS NULL ORDER BY v.version_no DESC LIMIT 1) IN (${sql.join(
                statuses.map((s) => sql`${s}`),
                sql`, `,
              )})`
            : undefined,
        )
      : undefined,
    f.uploaderMembershipId ? eq(assets.ownerMembershipId, f.uploaderMembershipId) : undefined,
    f.accountId
      ? sql`EXISTS (SELECT 1 FROM asset_links al WHERE al.asset_id = ${assets.id} AND al.removed_at IS NULL AND (
          (al.entity_type = 'account' AND al.entity_id = ${f.accountId}::uuid)
          OR (al.entity_type = 'publication' AND al.entity_id IN (SELECT p.id FROM publications p WHERE p.workspace_id = ${ctx.actor.workspaceId}::uuid AND p.account_id = ${f.accountId}::uuid))))`
      : undefined,
    f.updatedFrom ? gte(assets.updatedAt, new Date(f.updatedFrom)) : undefined,
    f.updatedTo ? lte(assets.updatedAt, new Date(f.updatedTo)) : undefined,
    f.q
      ? or(
          ilike(assets.name, escapeLike(f.q)),
          ilike(assets.description, escapeLike(f.q)),
          sql`EXISTS (SELECT 1 FROM unnest(${assets.tags}) t WHERE t ILIKE ${escapeLike(f.q)})`,
        )
      : undefined,
  );
};

const SORTS = { updatedAt: assets.updatedAt, createdAt: assets.createdAt, name: assets.name } as const;

export const listAssets = async (
  ctx: QueryContext,
  input: AssetListFilter & { cursor?: string; pageSize?: number; sort?: keyof typeof SORTS; direction?: 'asc' | 'desc' },
) => {
  requirePermission(ctx, 'assets.read');
  const size = clampPageSize(input.pageSize);
  const sortKey = input.sort ?? 'updatedAt';
  // Names sort case-insensitively (what people expect in a file browser).
  const col: SQL | (typeof SORTS)[keyof typeof SORTS] = sortKey === 'name' ? sql`lower(${assets.name})` : SORTS[sortKey];
  const dir = input.direction ?? 'desc';
  const op = sql.raw(dir === 'asc' ? '>' : '<');
  const c = input.cursor ? decodeCursor(input.cursor) : null;
  let cursorCond: SQL | undefined;
  if (c) {
    const v = sortKey === 'name' ? String(c.v[0]) : new Date(String(c.v[0]));
    cursorCond = sql`(${col} ${op} ${v} OR (${col} = ${v} AND ${assets.id} ${op} ${c.id}))`;
  }
  const rows = await ctx.app.db
    .select()
    .from(assets)
    .where(whereAll(assetListWhere(ctx, input), cursorCond))
    .orderBy(dir === 'asc' ? asc(col) : desc(col), dir === 'asc' ? asc(assets.id) : desc(assets.id))
    .limit(size + 1);
  const hasMore = rows.length > size;
  const page = hasMore ? rows.slice(0, size) : rows;
  const last = page[page.length - 1];
  const lastValue = last ? (sortKey === 'name' ? last.name.toLowerCase() : (last[sortKey] as Date).toISOString()) : null;
  return { items: await toAssetView(ctx, page), hasMore, nextCursor: hasMore && last ? encodeCursor({ v: [lastValue], id: last.id }) : null };
};

export const folderPath = async (ctx: QueryContext, folderId: string | null) => {
  if (!folderId) return [];
  const res = await dbOf(ctx).execute<{ id: string; name: string; depth: number }>(sql`
    WITH RECURSIVE chain AS (
      SELECT id, parent_id, name, depth FROM folders WHERE workspace_id = ${ctx.actor.workspaceId} AND id = ${folderId}
      UNION ALL
      SELECT f.id, f.parent_id, f.name, f.depth FROM folders f JOIN chain c ON f.id = c.parent_id WHERE f.workspace_id = ${ctx.actor.workspaceId}
    ) SELECT id, name, depth FROM chain ORDER BY depth ASC`);
  return res.rows.map((r) => ({ id: r.id, name: r.name }));
};

const workspaceTrashDays = async (ctx: QueryContext) => {
  const [w] = await dbOf(ctx).select({ settings: workspaces.settings }).from(workspaces).where(eq(workspaces.id, ctx.actor.workspaceId));
  return w?.settings?.retention?.trashDays ?? DEFAULT_TRASH_DAYS;
};

export const getAsset = async (ctx: QueryContext, assetId: string) => {
  requirePermission(ctx, 'assets.read');
  const a = await loadReadableAsset(ctx, assetId);
  const db = dbOf(ctx);
  const versions = await db.select().from(assetVersions).where(and(eq(assetVersions.workspaceId, ctx.actor.workspaceId), eq(assetVersions.assetId, a.id))).orderBy(desc(assetVersions.versionNo));
  const derivs = versions.length ? await db.select({ versionId: assetDerivatives.assetVersionId }).from(assetDerivatives).where(inArray(assetDerivatives.assetVersionId, versions.map((v) => v.id))) : [];
  const has = new Set(derivs.map((d) => d.versionId));
  const links = await db
    .select()
    .from(assetLinks)
    .where(and(eq(assetLinks.workspaceId, ctx.actor.workspaceId), eq(assetLinks.assetId, a.id), isNull(assetLinks.removedAt)))
    .orderBy(desc(assetLinks.createdAt));
  // Usage links are listed only where the actor can read the linked entity; others are counted, not named.
  const byVersion = new Map(versions.map((v) => [v.id, v.versionNo]));
  const usage: {
    id: string;
    entityType: string;
    entityId: string;
    role: string;
    label: string | null;
    href: string | null;
    versionId: string | null;
    versionNo: number | null;
    holding: boolean;
    createdAt: string;
  }[] = [];
  let hidden = 0;
  for (const l of links) {
    const scope = await resolveLinkTarget(ctx, l.entityType, l.entityId);
    if (scope)
      usage.push({
        id: l.id,
        entityType: l.entityType,
        entityId: l.entityId,
        role: l.role,
        label: scope.label ?? null,
        href: scope.href ?? null,
        versionId: l.assetVersionId,
        versionNo: l.assetVersionId ? (byVersion.get(l.assetVersionId) ?? null) : null,
        holding: l.holding,
        createdAt: l.createdAt.toISOString(),
      });
    else hidden++;
  }
  const refs = await loadUserMemberRefs(db, ctx.actor.workspaceId, versions.map((v) => v.createdBy));
  const [view] = await toAssetView(ctx, [a]);
  const scope = assetScope(a);
  const canUpload = allowed(ctx, 'assets.upload', scope);
  const canArchive = allowed(ctx, 'assets.archive', scope);
  return {
    ...view!,
    versions: versions.map((v) => versionView(v, refs, has.has(v.id), a.currentVersionId)),
    usage,
    hiddenUsageCount: hidden,
    folderPath: await folderPath(ctx, a.folderId),
    retention: { trashDays: await workspaceTrashDays(ctx), heldByReferences: links.some((l) => l.holding) },
    permissions: {
      update: canUpload && !a.archivedAt,
      upload: canUpload && !a.archivedAt && a.kind !== 'external_link',
      archive: canArchive && !a.archivedAt,
      restore: canArchive && !!a.archivedAt,
      link: (allowed(ctx, 'assets.link', scope) || canUpload) && !a.archivedAt,
      download: canDownloadAsset(ctx, a),
      changeSensitivity: canUpload && allowed(ctx, 'assets.restricted.read', { projectId: a.projectId }),
      deleteVersion: canArchive,
    },
  };
};

/** File history from the audit log (safe fields only). */
export const assetActivity = async (ctx: QueryContext, assetId: string, input: { cursor?: string; pageSize?: number }) => {
  await loadReadableAsset(ctx, assetId);
  const size = clampPageSize(input.pageSize ?? 30);
  const c = input.cursor ? decodeCursor(input.cursor) : null;
  const rows = await ctx.app.db
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.workspaceId, ctx.actor.workspaceId),
        eq(auditEvents.entityType, 'asset'),
        eq(auditEvents.entityId, assetId),
        ne(auditEvents.sensitivity, 'finance'),
        ne(auditEvents.sensitivity, 'ofm'),
        c ? or(lt(auditEvents.occurredAt, new Date(String(c.v[0]))), and(eq(auditEvents.occurredAt, new Date(String(c.v[0]))), lt(auditEvents.id, c.id))) : undefined,
      ),
    )
    .orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id))
    .limit(size + 1);
  const hasMore = rows.length > size;
  const items = (hasMore ? rows.slice(0, size) : rows).map((r) => ({
    id: r.id,
    action: r.action,
    actorName: r.actorDisplay,
    occurredAt: r.occurredAt.toISOString(),
    reason: r.reason,
    changes: Object.entries(r.diff ?? {}).map(([field, v]) => ({ field, from: v.from, to: v.to })),
  }));
  const last = items[items.length - 1];
  return { items, hasMore, nextCursor: hasMore && last ? encodeCursor({ v: [last.occurredAt], id: last.id }) : null };
};

/** Search projection: restricted media is never indexed (no title or thumbnail leak through global search). */
export const indexAsset = async (db: DbOrTx, a: AssetRow, at: Date) => {
  if (a.sensitivity === 'restricted' || a.deletedAt) {
    await removeSearchDocument(db, a.workspaceId, 'asset', a.id);
    return;
  }
  await indexSearchDocument(db, {
    workspaceId: a.workspaceId,
    entityType: 'asset',
    entityId: a.id,
    title: a.name,
    body: [a.description, a.tags.join(' ')].filter(Boolean).join('\n'),
    projectId: a.projectId,
    permission: 'assets.read',
    ownerMembershipId: a.ownerMembershipId,
    restricted: false,
    archived: !!a.archivedAt,
    status: a.kind,
    thumbnailAssetId: a.currentVersionId && a.kind !== 'external_link' ? a.id : null,
    at,
  });
};

/** A folder the asset may be placed in: visible, active, same project scope (workspace folders accept any scope). */
export const assertFolderFor = async (ctx: CommandContext, folderId: string, projectId: string | null) => {
  const [f] = await ctx.tx.select().from(folders).where(and(eq(folders.workspaceId, ctx.actor.workspaceId), eq(folders.id, folderId)));
  if (!f) throw new AppError('VALIDATION_FAILED', 'Choose an existing folder.', { fieldErrors: [{ field: 'folderId', code: 'NOT_FOUND', message: 'Choose an existing folder.' }] });
  if (f.archivedAt) throw new AppError('VALIDATION_FAILED', 'This folder is archived.', { fieldErrors: [{ field: 'folderId', code: 'ARCHIVED', message: 'This folder is archived.' }] });
  if (f.projectId && f.projectId !== projectId)
    throw new AppError('VALIDATION_FAILED', 'This folder belongs to another project. Use Move to change a file’s project (the change is previewed first).', {
      fieldErrors: [{ field: 'folderId', code: 'SCOPE_MISMATCH', message: 'This folder belongs to another project.' }],
    });
  return f;
};

export const updateAsset = async (
  ctx: CommandContext,
  assetId: string,
  input: { name?: string; tags?: string[]; description?: string | null; sensitivity?: AssetRow['sensitivity']; folderId?: string | null; externalUrl?: string },
) => {
  const a = await lockById(ctx, assets, assetId, 'File');
  if (a.deletedAt || !canSeeRestricted(ctx, a)) throw notFound('File');
  authorizeObject(ctx, 'assets.upload', assetScope(a), 'assets.read');
  assertVersion(ctx, a);
  if (a.archivedAt) throw new AppError('INVALID_STATE', 'Archived files are read-only. Restore the file to change it.');
  if (input.sensitivity && input.sensitivity !== a.sensitivity && !allowed(ctx, 'assets.restricted.read', { projectId: a.projectId }))
    throw new AppError('FORBIDDEN', 'Only members with restricted-media access can change sensitivity.');
  if (input.externalUrl !== undefined && a.kind !== 'external_link')
    throw new AppError('VALIDATION_FAILED', 'Only external links have a URL.', { fieldErrors: [{ field: 'externalUrl', code: 'NOT_EXTERNAL', message: 'Only external links have a URL.' }] });
  if (input.folderId) await assertFolderFor(ctx, input.folderId, a.projectId);
  const patch: Partial<AssetRow> = {};
  if (input.name) patch.name = input.name.trim();
  if (input.tags) patch.tags = await resolveTags(ctx, input.tags);
  if (input.description !== undefined) patch.description = input.description?.trim() || null;
  if (input.sensitivity) patch.sensitivity = input.sensitivity;
  if (input.folderId !== undefined) patch.folderId = input.folderId;
  if (input.externalUrl !== undefined) patch.externalUrl = input.externalUrl.trim();
  const [row] = await ctx.tx.update(assets).set({ ...patch, ...touch(ctx, assets) }).where(eq(assets.id, assetId)).returning();
  await audit(ctx, {
    action: input.sensitivity && input.sensitivity !== a.sensitivity ? 'asset.sensitivity_changed' : 'asset.updated',
    entityType: 'asset',
    entityId: assetId,
    projectId: a.projectId,
    diff: diffFields(a, row!, ['name', 'tags', 'description', 'sensitivity', 'folderId', 'externalUrl']),
  });
  await emit(ctx, { type: 'asset.updated', entityType: 'asset', entityId: assetId, revision: row!.rowVersion });
  await indexAsset(ctx.tx, row!, ctx.app.clock.now());
  return (await toAssetView(ctx, [row!]))[0]!;
};

export const assetArchivePreview = async (ctx: QueryContext, assetId: string) => {
  const a = await loadReadableAsset(ctx, assetId);
  authorizeObject(ctx, 'assets.archive', assetScope(a), 'assets.read');
  const [links] = await dbOf(ctx)
    .select({ n: count(), holding: sql<number>`count(*) FILTER (WHERE ${assetLinks.holding})` })
    .from(assetLinks)
    .where(and(eq(assetLinks.workspaceId, ctx.actor.workspaceId), eq(assetLinks.assetId, a.id), isNull(assetLinks.removedAt)));
  const items: ImpactItem[] = [];
  if (Number(links?.n ?? 0) > 0)
    items.push({ kind: 'usage_links', label: 'Places where this file is used', count: Number(links!.n), blocking: false, resolution: 'Links keep working for historical records.' });
  if (Number(links?.holding ?? 0) > 0)
    items.push({ kind: 'holding_references', label: 'Approved, published or evidence references', count: Number(links!.holding), blocking: false, resolution: 'These records keep their exact file version.' });
  return { title: a.name, rowVersion: a.rowVersion, items };
};

export const archiveAsset = async (ctx: CommandContext, assetId: string, reason?: string, opts: { skipVersion?: boolean } = {}) => {
  const a = await lockById(ctx, assets, assetId, 'File');
  if (a.deletedAt || !canSeeRestricted(ctx, a)) throw notFound('File');
  authorizeObject(ctx, 'assets.archive', assetScope(a), 'assets.read');
  if (!opts.skipVersion) assertVersion(ctx, a);
  if (a.archivedAt) return (await toAssetView(ctx, [a]))[0]!;
  const [row] = await ctx.tx
    .update(assets)
    .set({ archivedAt: ctx.app.clock.now(), archivedBy: ctx.actor.userId, archiveReason: reason ?? null, ...touch(ctx, assets) })
    .where(eq(assets.id, assetId))
    .returning();
  await audit(ctx, { action: 'asset.archived', entityType: 'asset', entityId: assetId, projectId: a.projectId, reason });
  await emit(ctx, { type: 'asset.archived', entityType: 'asset', entityId: assetId, revision: row!.rowVersion });
  await indexAsset(ctx.tx, row!, ctx.app.clock.now());
  return (await toAssetView(ctx, [row!]))[0]!;
};

export const restoreAsset = async (ctx: CommandContext, assetId: string, opts: { skipVersion?: boolean } = {}) => {
  const a = await lockById(ctx, assets, assetId, 'File');
  if (a.deletedAt || !canSeeRestricted(ctx, a)) throw notFound('File');
  authorizeObject(ctx, 'assets.archive', assetScope(a), 'assets.read');
  if (!opts.skipVersion) assertVersion(ctx, a);
  if (!a.archivedAt) throw new AppError('INVALID_STATE', 'This file is not archived.');
  let folderId = a.folderId;
  if (folderId) {
    const [f] = await ctx.tx.select({ archivedAt: folders.archivedAt }).from(folders).where(eq(folders.id, folderId));
    if (!f || f.archivedAt) folderId = null; // the folder was archived meanwhile: restore to the library root
  }
  const [row] = await ctx.tx
    .update(assets)
    .set({ archivedAt: null, archivedBy: null, archiveReason: null, folderId, ...touch(ctx, assets) })
    .where(eq(assets.id, assetId))
    .returning();
  await audit(ctx, { action: 'asset.restored', entityType: 'asset', entityId: assetId, projectId: a.projectId, diff: diffFields(a, row!, ['folderId']) });
  await emit(ctx, { type: 'asset.restored', entityType: 'asset', entityId: assetId, revision: row!.rowVersion });
  await indexAsset(ctx.tx, row!, ctx.app.clock.now());
  return (await toAssetView(ctx, [row!]))[0]!;
};

// ——— Version deletion (section 14, T080) ———

interface RefCount {
  kind: string;
  label: string;
  count: number;
}

/**
 * References that hold a stored version: approved/submitted content versions, character
 * versions, review comments, holding links (published placements, article versions), and
 * evidence of financial/metric/OFM records. Other modules' tables are only read here.
 */
const versionReferences = async (db: DbOrTx, ws: string, a: AssetRow, v: VersionRow, hasFallback: boolean): Promise<RefCount[]> => {
  const isCurrent = a.currentVersionId === v.id;
  const res = await db.execute<{ kind: string; n: string }>(sql`
    SELECT 'holding_links' AS kind, count(*)::text AS n FROM asset_links
      WHERE workspace_id = ${ws} AND asset_id = ${a.id} AND removed_at IS NULL AND holding
        AND (asset_version_id = ${v.id} OR (asset_version_id IS NULL AND ${isCurrent}))
    UNION ALL SELECT 'version_links', count(*)::text FROM asset_links
      WHERE workspace_id = ${ws} AND asset_id = ${a.id} AND removed_at IS NULL AND NOT holding AND asset_version_id = ${v.id}
    UNION ALL SELECT 'asset_links_only_version', count(*)::text FROM asset_links
      WHERE workspace_id = ${ws} AND asset_id = ${a.id} AND removed_at IS NULL AND NOT holding AND asset_version_id IS NULL AND ${isCurrent && !hasFallback}
    UNION ALL SELECT 'content_versions', count(*)::text FROM content_version_assets WHERE workspace_id = ${ws} AND asset_version_id = ${v.id}
    UNION ALL SELECT 'character_versions', count(*)::text FROM character_versions WHERE workspace_id = ${ws} AND ${v.id}::uuid = ANY(reference_asset_version_ids)
    UNION ALL SELECT 'reference_previews', count(*)::text FROM "references" WHERE workspace_id = ${ws} AND preview_asset_version_id = ${v.id}
    UNION ALL SELECT 'review_comments', count(*)::text FROM comments WHERE workspace_id = ${ws} AND asset_version_id = ${v.id} AND deleted_at IS NULL
    UNION ALL SELECT 'evidence', (
      (SELECT count(*) FROM financial_entries WHERE workspace_id = ${ws} AND ${a.id}::uuid = ANY(evidence_asset_ids))
      + (SELECT count(*) FROM settlements WHERE workspace_id = ${ws} AND ${a.id}::uuid = ANY(evidence_asset_ids))
      + (SELECT count(*) FROM metric_observations WHERE workspace_id = ${ws} AND ${a.id}::uuid = ANY(evidence_asset_ids))
      + (SELECT count(*) FROM operations WHERE workspace_id = ${ws} AND ${a.id}::uuid = ANY(evidence_asset_ids))
      + (SELECT count(*) FROM sale_candidates WHERE workspace_id = ${ws} AND ${a.id}::uuid = ANY(evidence_asset_ids))
      + (SELECT count(*) FROM incidents WHERE workspace_id = ${ws} AND ${a.id}::uuid = ANY(evidence_asset_ids))
      + (SELECT count(*) FROM campaign_source_reports WHERE workspace_id = ${ws} AND evidence_asset_id = ${a.id})
    )::text
    UNION ALL SELECT 'covers', (
      (SELECT count(*) FROM projects WHERE workspace_id = ${ws} AND cover_asset_id = ${a.id})
      + (SELECT count(*) FROM campaigns WHERE workspace_id = ${ws} AND cover_asset_id = ${a.id})
      + (SELECT count(*) FROM articles WHERE workspace_id = ${ws} AND cover_asset_id = ${a.id})
      + (SELECT count(*) FROM social_accounts WHERE workspace_id = ${ws} AND avatar_asset_id = ${a.id})
      + (SELECT count(*) FROM partners WHERE workspace_id = ${ws} AND logo_asset_id = ${a.id})
      + (SELECT count(*) FROM episodes WHERE workspace_id = ${ws} AND thumbnail_asset_id = ${a.id})
      + (SELECT count(*) FROM scenes WHERE workspace_id = ${ws} AND thumbnail_asset_id = ${a.id})
      + (SELECT count(*) FROM experiment_variants WHERE workspace_id = ${ws} AND thumbnail_asset_id = ${a.id})
      + (SELECT count(*) FROM "references" WHERE workspace_id = ${ws} AND source_asset_id = ${a.id})
      + (SELECT count(*) FROM workspaces WHERE id = ${ws} AND logo_asset_id = ${a.id})
      + (SELECT count(*) FROM users WHERE avatar_asset_id = ${a.id})
    )::text WHERE ${isCurrent && !hasFallback}`);
  const LABELS: Record<string, string> = {
    holding_links: 'Approved content, published placements or article versions',
    version_links: 'Links to exactly this version',
    asset_links_only_version: 'Links to this file (no other available version would remain)',
    content_versions: 'Content versions',
    character_versions: 'Character profile versions',
    reference_previews: 'Reference previews',
    review_comments: 'Review comments on this version',
    evidence: 'Evidence of financial, metric or operational records',
    covers: 'Covers, avatars or logos using this file',
  };
  return res.rows.map((r) => ({ kind: r.kind, label: LABELS[r.kind] ?? r.kind, count: Number(r.n) })).filter((r) => r.count > 0);
};

const loadVersionOf = async (db: DbOrTx, ws: string, assetId: string, versionId: string) => {
  const [v] = await db.select().from(assetVersions).where(and(eq(assetVersions.workspaceId, ws), eq(assetVersions.assetId, assetId), eq(assetVersions.id, versionId)));
  if (!v) throw notFound('File version');
  return v;
};

const fallbackVersion = async (db: DbOrTx, ws: string, a: AssetRow, excludeId: string) => {
  const [v] = await db
    .select()
    .from(assetVersions)
    .where(and(eq(assetVersions.workspaceId, ws), eq(assetVersions.assetId, a.id), ne(assetVersions.id, excludeId), eq(assetVersions.status, 'available'), isNull(assetVersions.deletedAt)))
    .orderBy(desc(assetVersions.versionNo))
    .limit(1);
  return v ?? null;
};

export const versionDeletePreview = async (ctx: QueryContext, assetId: string, versionId: string) => {
  const a = await loadReadableAsset(ctx, assetId);
  authorizeObject(ctx, 'assets.archive', assetScope(a), 'assets.read');
  const db = dbOf(ctx);
  const v = await loadVersionOf(db, ctx.actor.workspaceId, a.id, versionId);
  const fb = await fallbackVersion(db, ctx.actor.workspaceId, a, v.id);
  const refs = v.deletedAt ? [] : await versionReferences(db, ctx.actor.workspaceId, a, v, !!fb);
  const items: ImpactItem[] = refs.map((r) => ({ kind: r.kind, label: r.label, count: r.count, blocking: true }));
  if (v.deletedAt) items.push({ kind: 'already_deleted', label: 'This version was already deleted', count: 1, blocking: true });
  if (a.currentVersionId === v.id && fb && !refs.length)
    items.push({ kind: 'current_version', label: `Version ${fb.versionNo} becomes the current file`, count: 1, blocking: false });
  return {
    versionId: v.id,
    versionNo: v.versionNo,
    isCurrent: a.currentVersionId === v.id,
    deletable: !items.some((i) => i.blocking),
    byteSize: v.byteSize,
    items,
    suggestion: refs.length ? 'This version is kept for historical records. Archive the file to hide it from the Library instead.' : null,
  };
};

/**
 * Delete Version: refused while anything holds the version (approved content, placements,
 * evidence, article versions — T080); otherwise the version is hidden and its blob purged after the
 * trash period by `media.purgeDeletedVersions`. The original blob itself is never modified.
 */
export const deleteAssetVersion = async (ctx: CommandContext, assetId: string, versionId: string, reason: string) => {
  const a = await lockById(ctx, assets, assetId, 'File');
  if (a.deletedAt || !(await canReadAsset(ctx, a))) throw notFound('File');
  authorizeObject(ctx, 'assets.archive', assetScope(a), 'assets.read');
  assertVersion(ctx, a);
  const [v] = await ctx.tx.select().from(assetVersions).where(and(eq(assetVersions.assetId, a.id), eq(assetVersions.id, versionId))).for('update');
  if (!v) throw notFound('File version');
  if (v.deletedAt) throw new AppError('INVALID_STATE', 'This version was already deleted.');
  if (['uploading', 'checking', 'processing'].includes(v.status))
    throw new AppError('INVALID_STATE', 'This version is still being uploaded or checked. Cancel the upload instead.');
  const fb = await fallbackVersion(ctx.tx, ctx.actor.workspaceId, a, v.id);
  const refs = await versionReferences(ctx.tx, ctx.actor.workspaceId, a, v, !!fb);
  if (refs.length)
    throw new AppError('INVALID_STATE', 'This version is referenced by other records and cannot be deleted. Archive the file instead.', {
      details: { items: refs.map((r) => ({ ...r, blocking: true })) },
    });
  const at = ctx.app.clock.now();
  await ctx.tx.update(assetVersions).set({ deletedAt: at, deletedBy: ctx.actor.userId, deleteReason: reason, ...touch(ctx, assetVersions) }).where(eq(assetVersions.id, v.id));
  const patch: Partial<AssetRow> = {};
  if (a.currentVersionId === v.id) patch.currentVersionId = fb?.id ?? null;
  const [row] = await ctx.tx.update(assets).set({ ...patch, ...touch(ctx, assets) }).where(eq(assets.id, a.id)).returning();
  await audit(ctx, { action: 'asset.version_deleted', entityType: 'asset', entityId: a.id, projectId: a.projectId, reason, metadata: { versionId: v.id, versionNo: v.versionNo } });
  await emit(ctx, { type: 'asset.version_deleted', entityType: 'asset', entityId: a.id, revision: row!.rowVersion, payload: { versionId: v.id } });
  await indexAsset(ctx.tx, row!, at);
  return a.id;
};

// ——— Links ———

/**
 * Link an asset to an entity. The actor must be able to link in the asset's scope and to read the
 * target entity (registered resolver); restricted media requires restricted access.
 */
export const linkAsset = async (
  ctx: CommandContext,
  assetId: string,
  input: { versionId?: string; target: { entityType: string; entityId: string; role?: string }; holding?: boolean },
): Promise<{ linkId: string }> => {
  const a = await lockById(ctx, assets, assetId, 'File');
  if (!(await canReadAsset(ctx, a))) throw notFound('File');
  if (!LINK_ACCESS.has(input.target.entityType)) throw new AppError('VALIDATION_FAILED', `Files cannot be linked to ${input.target.entityType}.`);
  const scope = await resolveLinkTarget(ctx, input.target.entityType, input.target.entityId);
  if (!scope) throw notFound('Target');
  const pid = scope.projectId ?? a.projectId;
  if (!allowed(ctx, 'assets.link', { projectId: pid }) && !allowed(ctx, 'assets.upload', { projectId: pid }) && !allowed(ctx, 'assets.link', assetScope(a)))
    throw new AppError('FORBIDDEN', 'You cannot attach files here.');
  if (a.archivedAt) throw new AppError('INVALID_STATE', 'Restore the file before linking it again.');
  if (input.versionId) {
    const [v] = await ctx.tx.select({ id: assetVersions.id, deletedAt: assetVersions.deletedAt }).from(assetVersions).where(and(eq(assetVersions.assetId, assetId), eq(assetVersions.id, input.versionId)));
    if (!v || v.deletedAt) throw notFound('File version');
  }
  const role = input.target.role ?? 'attachment';
  const [existing] = await ctx.tx
    .select({ id: assetLinks.id, holding: assetLinks.holding })
    .from(assetLinks)
    .where(
      and(
        eq(assetLinks.workspaceId, ctx.actor.workspaceId),
        eq(assetLinks.assetId, assetId),
        eq(assetLinks.entityType, input.target.entityType),
        eq(assetLinks.entityId, input.target.entityId),
        eq(assetLinks.role, role),
        input.versionId ? eq(assetLinks.assetVersionId, input.versionId) : isNull(assetLinks.assetVersionId),
        isNull(assetLinks.removedAt),
      ),
    );
  if (existing) {
    if (input.holding && !existing.holding) await ctx.tx.update(assetLinks).set({ holding: true, ...touch(ctx, assetLinks) }).where(eq(assetLinks.id, existing.id));
    return { linkId: existing.id };
  }
  const id = newId();
  await ctx.tx.insert(assetLinks).values({
    ...stamp(ctx),
    id,
    assetId,
    assetVersionId: input.versionId ?? null,
    entityType: input.target.entityType,
    entityId: input.target.entityId,
    role,
    projectId: pid,
    holding: input.holding ?? false,
  });
  await audit(ctx, { action: 'asset.linked', entityType: 'asset', entityId: assetId, projectId: pid, metadata: { target: input.target.entityType, targetId: input.target.entityId, role } });
  await emit(ctx, { type: 'asset.linked', entityType: 'asset', entityId: assetId, payload: { targetType: input.target.entityType, targetId: input.target.entityId } });
  return { linkId: id };
};

export const removeAssetLink = async (ctx: CommandContext, linkId: string, reason?: string, opts: { allowHolding?: boolean } = {}) => {
  const l = await lockById(ctx, assetLinks, linkId, 'Link');
  if (l.removedAt) return { ok: true as const };
  const scope = await resolveLinkTarget(ctx, l.entityType, l.entityId);
  if (!scope) throw notFound('Link');
  if (l.holding && !opts.allowHolding) throw new AppError('INVALID_STATE', 'This file is part of an approved or published record and cannot be unlinked.');
  const pid = scope.projectId ?? l.projectId;
  if (!allowed(ctx, 'assets.link', { projectId: pid }) && !allowed(ctx, 'assets.upload', { projectId: pid })) throw new AppError('FORBIDDEN', 'You cannot remove this attachment.');
  await ctx.tx.update(assetLinks).set({ removedAt: ctx.app.clock.now(), removedBy: ctx.actor.userId, ...touch(ctx, assetLinks) }).where(eq(assetLinks.id, linkId));
  await audit(ctx, { action: 'asset.link_removed', entityType: 'asset', entityId: l.assetId, projectId: l.projectId, reason, metadata: { target: l.entityType, targetId: l.entityId } });
  await emit(ctx, { type: 'asset.link_removed', entityType: 'asset', entityId: l.assetId });
  return { ok: true as const };
};

/** Files linked to one entity (attachments panel). The entity must be readable; restricted media stays hidden without permission. */
export const listEntityFiles = async (ctx: QueryContext, entityType: string, entityId: string) => {
  if (!(await resolveLinkTarget(ctx, entityType, entityId))) throw notFound('Record');
  const db = dbOf(ctx);
  const links = await db
    .select()
    .from(assetLinks)
    .where(and(eq(assetLinks.workspaceId, ctx.actor.workspaceId), eq(assetLinks.entityType, entityType), eq(assetLinks.entityId, entityId), isNull(assetLinks.removedAt)))
    .orderBy(asc(assetLinks.createdAt))
    .limit(500);
  if (!links.length) return [];
  const rows = await db.select().from(assets).where(and(eq(assets.workspaceId, ctx.actor.workspaceId), inArray(assets.id, [...new Set(links.map((l) => l.assetId))]), isNull(assets.deletedAt)));
  const visible = rows.filter((a) => canSeeRestricted(ctx, a));
  const views = new Map((await toAssetView(ctx, visible)).map((v) => [v.id, v]));
  return links.flatMap((l) => {
    const v = views.get(l.assetId);
    return v ? [{ ...v, linkId: l.id, role: l.role, holding: l.holding }] : [];
  });
};

export const linkTargetTypes = () => [...LINK_ACCESS.keys()].sort();

// ——— Download / preview delivery ———

/** Signed, short-lived token binding one version to the proxy route (≤ 5 minutes). */
export const contentToken = (secret: string, versionId: string, expiresAt: number, membershipId: string) =>
  `${expiresAt}.${hmac(secret, `asset:${versionId}:${expiresAt}:${membershipId}`)}`;

export const verifyContentToken = (secret: string, token: string, versionId: string, membershipId: string, now: number): boolean => {
  const [exp, sig] = token.split('.');
  const e = Number(exp);
  if (!Number.isFinite(e) || e < now || !sig) return false;
  return sig === hmac(secret, `asset:${versionId}:${e}:${membershipId}`);
};

export const issueDownload = async (ctx: QueryContext, assetId: string, versionId?: string, disposition: 'attachment' | 'inline' = 'attachment') => {
  const a = await loadReadableAsset(ctx, assetId);
  // Download is a separate permission from read; readers through a linked entity (e.g. contractor
  // task attachments) need assets.download somewhere in their grants.
  if (!allowed(ctx, 'assets.download', assetScope(a)) && !hasAnywhere(ctx.actor.access, 'assets.download'))
    throw new AppError('FORBIDDEN', 'You can view this file but not download it.');
  if (!canSeeRestricted(ctx, a)) throw notFound('File');
  if (a.kind === 'external_link') throw new AppError('INVALID_STATE', 'This is an external link. It is not stored in Castlane — open the link instead.');
  const vId = versionId ?? a.currentVersionId;
  if (!vId) throw new AppError('INVALID_STATE', 'This file has no available version yet.');
  const [v] = await ctx.app.db.select().from(assetVersions).where(and(eq(assetVersions.assetId, a.id), eq(assetVersions.id, vId)));
  if (!v || v.deletedAt) throw notFound('File version');
  if (v.status !== 'available' || !v.storageKey) throw new AppError('INVALID_STATE', 'The file is still being checked or was rejected.');
  const ttl = 300;
  const expiresAt = new Date(ctx.app.clock.now().getTime() + ttl * 1000);
  const restricted = a.sensitivity === 'restricted';
  if (restricted || disposition === 'inline' || ctx.app.storage.driver === 'filesystem') {
    const token = contentToken(ctx.app.config.SESSION_SECRET, v.id, expiresAt.getTime(), ctx.actor.membershipId ?? 'system');
    return {
      url: `/api/v1/workspaces/${ctx.actor.workspaceId}/assets/${a.id}/versions/${v.id}/content?token=${encodeURIComponent(token)}&disposition=${disposition}`,
      expiresAt: expiresAt.toISOString(),
      mode: 'proxy' as const,
    };
  }
  const url = await ctx.app.storage.presignDownload(v.storageKey, { expiresSeconds: ttl, filename: v.originalFilename, contentType: v.detectedMime ?? undefined });
  return { url, expiresAt: expiresAt.toISOString(), mode: 'presigned' as const };
};

export const loadDerivative = async (ctx: QueryContext, assetId: string, size: number, versionId?: string, reveal?: boolean) => {
  const a = await loadReadableAsset(ctx, assetId);
  if (a.sensitivity === 'restricted' && (!reveal || !canSeeRestricted(ctx, a))) throw notFound('Preview');
  const vId = versionId ?? a.currentVersionId;
  if (!vId) throw notFound('Preview');
  const [v] = await ctx.app.db.select({ deletedAt: assetVersions.deletedAt, assetId: assetVersions.assetId }).from(assetVersions).where(eq(assetVersions.id, vId));
  if (!v || v.assetId !== a.id || v.deletedAt) throw notFound('Preview');
  const derivs = await ctx.app.db.select().from(assetDerivatives).where(eq(assetDerivatives.assetVersionId, vId));
  const sized = derivs
    .filter((d) => d.kind.startsWith('thumb_') || d.kind.startsWith('cover_') || d.kind === 'poster' || d.kind === 'preview')
    .sort((x, y) => (x.width ?? 0) - (y.width ?? 0));
  const pick = sized.find((d) => (d.width ?? 0) >= size) ?? sized[sized.length - 1];
  if (!pick) throw notFound('Preview');
  return pick;
};

export const loadVersionForStream = async (ctx: QueryContext, assetId: string, versionId: string, token: string) => {
  const a = await loadReadableAsset(ctx, assetId);
  if (!canSeeRestricted(ctx, a)) throw notFound('File');
  if (!verifyContentToken(ctx.app.config.SESSION_SECRET, token, versionId, ctx.actor.membershipId ?? 'system', ctx.app.clock.now().getTime()))
    throw new AppError('FORBIDDEN', 'The file link expired. Request the file again.');
  const [v] = await ctx.app.db.select().from(assetVersions).where(and(eq(assetVersions.assetId, a.id), eq(assetVersions.id, versionId)));
  if (!v || v.deletedAt || v.status !== 'available' || !v.storageKey) throw notFound('File');
  return { asset: a, version: v };
};

// ——— External links, duplicates, quota ———

/** External link as a metadata-only asset: the URL is a note; the server never fetches it (T081). */
export const createExternalLinkAsset = async (
  ctx: CommandContext,
  input: {
    url: string;
    title: string;
    projectId?: string | null;
    folderId?: string | null;
    target?: { entityType: string; entityId: string; role?: string };
    description?: string | null;
    tags?: string[];
  },
) => {
  requirePermission(ctx, 'assets.upload');
  let projectId = input.projectId ?? null;
  if (input.target) {
    const scope = await resolveLinkTarget(ctx, input.target.entityType, input.target.entityId);
    if (!scope) throw notFound('Target');
    projectId = projectId ?? scope.projectId ?? null;
  }
  if (input.folderId) {
    const f = await assertFolderFor(ctx, input.folderId, projectId ?? null).catch(async (e) => {
      // A project folder implies its project when no project was chosen.
      const [row] = await ctx.tx.select().from(folders).where(and(eq(folders.workspaceId, ctx.actor.workspaceId), eq(folders.id, input.folderId!)));
      if (row && !row.archivedAt && row.projectId && !projectId) return row;
      throw e;
    });
    projectId = projectId ?? f.projectId;
  }
  if (!allowed(ctx, 'assets.upload', { projectId })) throw new AppError('FORBIDDEN', 'You cannot add files here.');
  const id = newId();
  const [row] = await ctx.tx
    .insert(assets)
    .values({
      ...stamp(ctx),
      id,
      name: input.title.trim(),
      kind: 'external_link',
      externalUrl: input.url.trim(),
      projectId,
      folderId: input.folderId ?? null,
      ownerMembershipId: ctx.actor.membershipId,
      description: input.description?.trim() || null,
      tags: await resolveTags(ctx, input.tags),
    })
    .returning();
  if (input.target)
    await ctx.tx.insert(assetLinks).values({ ...stamp(ctx), id: newId(), assetId: id, entityType: input.target.entityType, entityId: input.target.entityId, role: input.target.role ?? 'attachment', projectId });
  await audit(ctx, { action: 'asset.external_link_added', entityType: 'asset', entityId: id, projectId });
  await emit(ctx, { type: 'asset.created', entityType: 'asset', entityId: id, revision: 1 });
  await indexAsset(ctx.tx, row!, ctx.app.clock.now());
  return (await toAssetView(ctx, [row!]))[0]!;
};

/** Reuse instead of a second upload: only files the member can read are returned (nothing about others). */
export const findDuplicates = async (ctx: QueryContext, checksum: string) => {
  requirePermission(ctx, 'assets.read');
  const rows = await ctx.app.db
    .select({ a: assets, versionId: assetVersions.id, versionNo: assetVersions.versionNo })
    .from(assetVersions)
    .innerJoin(assets, and(eq(assets.workspaceId, assetVersions.workspaceId), eq(assets.id, assetVersions.assetId)))
    .where(
      and(
        eq(assetVersions.workspaceId, ctx.actor.workspaceId),
        eq(assetVersions.checksumSha256, checksum),
        eq(assetVersions.status, 'available'),
        isNull(assetVersions.deletedAt),
        isNull(assets.deletedAt),
      ),
    )
    .limit(20);
  const out: { assetId: string; versionId: string; name: string; versionNo: number; projectId: string | null }[] = [];
  for (const r of rows) if (await canReadAsset(ctx, r.a)) out.push({ assetId: r.a.id, versionId: r.versionId, name: r.a.name, versionNo: r.versionNo, projectId: r.a.projectId });
  return out;
};

const DEFAULT_QUOTA = 500n * 1024n ** 3n;

export const storageUsage = async (ctx: QueryContext) => {
  requirePermission(ctx, 'assets.upload');
  const [w] = await ctx.app.db
    .select({ used: workspaces.storageUsedBytes, reserved: workspaces.storageReservedBytes, settings: workspaces.settings })
    .from(workspaces)
    .where(eq(workspaces.id, ctx.actor.workspaceId));
  const quota = BigInt(w?.settings?.fileQuotaBytes ?? DEFAULT_QUOTA.toString());
  const used = w?.used ?? 0n;
  const reserved = w?.reserved ?? 0n;
  return { usedBytes: used.toString(), reservedBytes: reserved.toString(), quotaBytes: quota.toString(), full: used + reserved >= quota };
};
