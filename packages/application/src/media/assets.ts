import { and, desc, eq, ilike, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { hasAnywhere } from '@castlane/authorization';
import { assetDerivatives, assetLinks, assets, assetVersions } from '@castlane/database';
import { AppError, clampPageSize, decodeCursor, encodeCursor, newId, notFound } from '@castlane/domain';
import { allowed, authorizeObject, requirePermission, scopePredicate, whereAll } from '../core/access';
import { audit, diffFields } from '../core/audit';
import { dbOf, type CommandContext, type QueryContext } from '../core/context';
import { hmac } from '../core/crypto';
import { emit } from '../core/events';
import { loadMemberRefs, refOrUnknown } from '../core/members';
import { assertVersion, lockById, stamp, touch } from '../core/rows';
import { indexSearchDocument } from '../core/search';
import { resolveTags } from '../core/tags';
import { LINK_ACCESS } from './link-access';

type AssetRow = typeof assets.$inferSelect;
type VersionRow = typeof assetVersions.$inferSelect;

export const assetScope = (a: Pick<AssetRow, 'id' | 'projectId' | 'ownerMembershipId'>) => ({
  objectType: 'asset',
  objectId: a.id,
  projectId: a.projectId,
  ownerMembershipId: a.ownerMembershipId,
});

/**
 * An asset is readable when the actor can read it in its own project scope (assets.read), or can
 * read at least one entity it is linked to (registered link-access resolvers). Restricted media
 * additionally needs assets.restricted.read for any content/thumbnail.
 */
export const canReadAsset = async (ctx: QueryContext, a: AssetRow): Promise<boolean> => {
  if (allowed(ctx, 'assets.read', assetScope(a))) return true;
  const links = await dbOf(ctx)
    .select({ entityType: assetLinks.entityType, entityId: assetLinks.entityId })
    .from(assetLinks)
    .where(and(eq(assetLinks.workspaceId, ctx.actor.workspaceId), eq(assetLinks.assetId, a.id), isNull(assetLinks.removedAt)))
    .limit(50);
  for (const l of links) {
    const r = LINK_ACCESS.get(l.entityType);
    if (!r) continue;
    const scope = await r.scope(ctx, l.entityId);
    if (scope && allowed(ctx, r.permission, scope)) return true;
  }
  return false;
};

export const canSeeRestricted = (ctx: QueryContext, a: Pick<AssetRow, 'projectId' | 'sensitivity'>) =>
  a.sensitivity !== 'restricted' || allowed(ctx, 'assets.restricted.read', { projectId: a.projectId });

export const loadReadableAsset = async (ctx: QueryContext, assetId: string): Promise<AssetRow> => {
  const [a] = await dbOf(ctx).select().from(assets).where(and(eq(assets.workspaceId, ctx.actor.workspaceId), eq(assets.id, assetId)));
  if (!a || a.deletedAt || !(await canReadAsset(ctx, a))) throw notFound('File');
  return a;
};

const versionView = (v: VersionRow, refs: Awaited<ReturnType<typeof loadMemberRefs>>, previewAvailable: boolean) => ({
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
  previewAvailable,
});

export const toAssetView = async (ctx: QueryContext, rows: AssetRow[]) => {
  const db = dbOf(ctx);
  const versionIds = rows.map((r) => r.currentVersionId).filter((x): x is string => !!x);
  const versions = versionIds.length ? await db.select().from(assetVersions).where(inArray(assetVersions.id, versionIds)) : [];
  const derivs = versionIds.length
    ? await db.select({ versionId: assetDerivatives.assetVersionId, kind: assetDerivatives.kind }).from(assetDerivatives).where(inArray(assetDerivatives.assetVersionId, versionIds))
    : [];
  const hasDeriv = new Set(derivs.map((d) => d.versionId));
  const byId = new Map(versions.map((v) => [v.id, v]));
  const refs = new Map();
  return rows.map((a) => {
    const v = a.currentVersionId ? byId.get(a.currentVersionId) : undefined;
    const hidden = !canSeeRestricted(ctx, a) || a.sensitivity === 'restricted';
    return {
      id: a.id,
      name: a.name,
      kind: a.kind,
      projectId: a.projectId,
      folderId: a.folderId,
      sensitivity: a.sensitivity,
      tags: a.tags,
      description: a.description,
      externalUrl: a.externalUrl,
      currentVersion: v ? versionView(v, refs, hasDeriv.has(v.id)) : null,
      archivedAt: a.archivedAt?.toISOString() ?? null,
      updatedAt: a.updatedAt.toISOString(),
      rowVersion: a.rowVersion,
      thumbnailUrl: v && hasDeriv.has(v.id) && !hidden ? `/api/v1/workspaces/${a.workspaceId}/assets/${a.id}/thumbnail?size=256` : null,
      canDownload: !!v && v.status === 'available' && allowed(ctx, 'assets.download', assetScope(a)) && canSeeRestricted(ctx, a),
      restrictedHidden: a.sensitivity === 'restricted',
    };
  });
};

export const listAssets = async (
  ctx: QueryContext,
  input: { cursor?: string; pageSize?: number; q?: string; projectId?: string; folderId?: string; rootOnly?: boolean; kind?: AssetRow['kind'][]; tag?: string; includeArchived?: boolean },
) => {
  requirePermission(ctx, 'assets.read');
  const size = clampPageSize(input.pageSize);
  const c = input.cursor ? decodeCursor(input.cursor) : null;
  const where = whereAll(
    eq(assets.workspaceId, ctx.actor.workspaceId),
    isNull(assets.deletedAt),
    scopePredicate(ctx, 'assets.read', { projectId: assets.projectId, ownerMembership: assets.ownerMembershipId }),
    input.includeArchived ? undefined : isNull(assets.archivedAt),
    input.projectId ? eq(assets.projectId, input.projectId) : undefined,
    input.folderId ? eq(assets.folderId, input.folderId) : input.rootOnly ? isNull(assets.folderId) : undefined,
    input.kind?.length ? inArray(assets.kind, input.kind) : undefined,
    input.tag ? sql`${input.tag} = ANY(${assets.tags})` : undefined,
    input.q ? ilike(assets.name, `%${input.q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`) : undefined,
    c ? or(lt(assets.updatedAt, new Date(String(c.v[0]))), and(eq(assets.updatedAt, new Date(String(c.v[0]))), lt(assets.id, c.id))) : undefined,
  );
  const rows = await ctx.app.db.select().from(assets).where(where).orderBy(desc(assets.updatedAt), desc(assets.id)).limit(size + 1);
  const hasMore = rows.length > size;
  const page = hasMore ? rows.slice(0, size) : rows;
  const last = page[page.length - 1];
  return { items: await toAssetView(ctx, page), hasMore, nextCursor: hasMore && last ? encodeCursor({ v: [last.updatedAt.toISOString()], id: last.id }) : null };
};

export const getAsset = async (ctx: QueryContext, assetId: string) => {
  const a = await loadReadableAsset(ctx, assetId);
  const db = dbOf(ctx);
  const versions = await db.select().from(assetVersions).where(eq(assetVersions.assetId, a.id)).orderBy(desc(assetVersions.versionNo));
  const derivs = versions.length ? await db.select({ versionId: assetDerivatives.assetVersionId }).from(assetDerivatives).where(inArray(assetDerivatives.assetVersionId, versions.map((v) => v.id))) : [];
  const has = new Set(derivs.map((d) => d.versionId));
  const links = await db.select().from(assetLinks).where(and(eq(assetLinks.workspaceId, ctx.actor.workspaceId), eq(assetLinks.assetId, a.id), isNull(assetLinks.removedAt)));
  // Usage links are listed only where the actor can read the linked entity; others are counted, not named.
  const usage: { id: string; entityType: string; entityId: string; role: string; label: string | null; href: string | null }[] = [];
  let hidden = 0;
  for (const l of links) {
    const r = LINK_ACCESS.get(l.entityType);
    const scope = r ? await r.scope(ctx, l.entityId) : null;
    if (r && scope && allowed(ctx, r.permission, scope)) usage.push({ id: l.id, entityType: l.entityType, entityId: l.entityId, role: l.role, label: scope.label ?? null, href: scope.href ?? null });
    else hidden++;
  }
  const refs = await loadMemberRefs(db, ctx.actor.workspaceId, []);
  const [view] = await toAssetView(ctx, [a]);
  const scope = assetScope(a);
  return {
    ...view!,
    versions: versions.map((v) => versionView(v, refs, has.has(v.id))),
    usage,
    hiddenUsageCount: hidden,
    permissions: {
      update: allowed(ctx, 'assets.upload', scope),
      upload: allowed(ctx, 'assets.upload', scope),
      archive: allowed(ctx, 'assets.archive', scope),
      link: allowed(ctx, 'assets.link', scope),
    },
  };
};

const indexAsset = (ctx: CommandContext, a: AssetRow) =>
  indexSearchDocument(ctx.tx, {
    workspaceId: ctx.actor.workspaceId,
    entityType: 'asset',
    entityId: a.id,
    title: a.name,
    body: [a.description, a.tags.join(' ')].filter(Boolean).join('\n'),
    projectId: a.projectId,
    permission: 'assets.read',
    ownerMembershipId: a.ownerMembershipId,
    restricted: a.sensitivity === 'restricted',
    archived: !!a.archivedAt,
    thumbnailAssetId: a.sensitivity === 'restricted' ? null : a.id,
    at: ctx.app.clock.now(),
  });

export const updateAsset = async (
  ctx: CommandContext,
  assetId: string,
  input: { name?: string; tags?: string[]; description?: string | null; sensitivity?: AssetRow['sensitivity']; folderId?: string | null },
) => {
  const a = await lockById(ctx, assets, assetId, 'File');
  authorizeObject(ctx, 'assets.upload', assetScope(a), 'assets.read');
  assertVersion(ctx, a);
  if (input.sensitivity && input.sensitivity !== a.sensitivity && !allowed(ctx, 'assets.restricted.read', { projectId: a.projectId }))
    throw new AppError('FORBIDDEN', 'Only members with restricted-media access can change sensitivity.');
  const patch: Partial<AssetRow> = {};
  if (input.name) patch.name = input.name.trim();
  if (input.tags) patch.tags = await resolveTags(ctx, input.tags);
  if (input.description !== undefined) patch.description = input.description;
  if (input.sensitivity) patch.sensitivity = input.sensitivity;
  if (input.folderId !== undefined) patch.folderId = input.folderId;
  const [row] = await ctx.tx.update(assets).set({ ...patch, ...touch(ctx, assets) }).where(eq(assets.id, assetId)).returning();
  await audit(ctx, { action: 'asset.updated', entityType: 'asset', entityId: assetId, projectId: a.projectId, diff: diffFields(a, row!, ['name', 'tags', 'description', 'sensitivity', 'folderId']) });
  await emit(ctx, { type: 'asset.updated', entityType: 'asset', entityId: assetId, revision: row!.rowVersion });
  await indexAsset(ctx, row!);
  return (await toAssetView(ctx, [row!]))[0]!;
};

export const archiveAsset = async (ctx: CommandContext, assetId: string, reason?: string) => {
  const a = await lockById(ctx, assets, assetId, 'File');
  authorizeObject(ctx, 'assets.archive', assetScope(a), 'assets.read');
  assertVersion(ctx, a);
  const [row] = await ctx.tx
    .update(assets)
    .set({ archivedAt: ctx.app.clock.now(), archivedBy: ctx.actor.userId, archiveReason: reason ?? null, ...touch(ctx, assets) })
    .where(eq(assets.id, assetId))
    .returning();
  await audit(ctx, { action: 'asset.archived', entityType: 'asset', entityId: assetId, projectId: a.projectId, reason });
  await emit(ctx, { type: 'asset.archived', entityType: 'asset', entityId: assetId, revision: row!.rowVersion });
  await indexAsset(ctx, row!);
  return (await toAssetView(ctx, [row!]))[0]!;
};

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
  const resolver = LINK_ACCESS.get(input.target.entityType);
  if (!resolver) throw new AppError('VALIDATION_FAILED', `Files cannot be linked to ${input.target.entityType}.`);
  const scope = await resolver.scope(ctx, input.target.entityId);
  if (!scope || !allowed(ctx, resolver.permission, scope)) throw notFound('Target');
  if (!allowed(ctx, 'assets.link', { projectId: scope.projectId ?? a.projectId }) && !allowed(ctx, 'assets.upload', { projectId: scope.projectId ?? a.projectId }))
    throw new AppError('FORBIDDEN', 'You cannot attach files here.');
  if (!canSeeRestricted(ctx, a)) throw new AppError('FORBIDDEN', 'Restricted media requires restricted-media access.');
  if (input.versionId) {
    const [v] = await ctx.tx.select({ id: assetVersions.id }).from(assetVersions).where(and(eq(assetVersions.assetId, assetId), eq(assetVersions.id, input.versionId)));
    if (!v) throw notFound('File version');
  }
  const [existing] = await ctx.tx
    .select({ id: assetLinks.id })
    .from(assetLinks)
    .where(
      and(
        eq(assetLinks.assetId, assetId),
        eq(assetLinks.entityType, input.target.entityType),
        eq(assetLinks.entityId, input.target.entityId),
        eq(assetLinks.role, input.target.role ?? 'attachment'),
        input.versionId ? eq(assetLinks.assetVersionId, input.versionId) : isNull(assetLinks.assetVersionId),
        isNull(assetLinks.removedAt),
      ),
    );
  if (existing) return { linkId: existing.id };
  const id = newId();
  await ctx.tx.insert(assetLinks).values({
    ...stamp(ctx),
    id,
    assetId,
    assetVersionId: input.versionId ?? null,
    entityType: input.target.entityType,
    entityId: input.target.entityId,
    role: input.target.role ?? 'attachment',
    projectId: scope.projectId ?? a.projectId,
    holding: input.holding ?? false,
  });
  await audit(ctx, { action: 'asset.linked', entityType: 'asset', entityId: assetId, projectId: scope.projectId ?? a.projectId, metadata: { target: input.target.entityType, targetId: input.target.entityId } });
  await emit(ctx, { type: 'asset.linked', entityType: 'asset', entityId: assetId, payload: { targetType: input.target.entityType, targetId: input.target.entityId } });
  return { linkId: id };
};

export const removeAssetLink = async (ctx: CommandContext, linkId: string, reason?: string) => {
  const l = await lockById(ctx, assetLinks, linkId, 'Link');
  if (l.removedAt) return { ok: true as const };
  if (l.holding) throw new AppError('INVALID_STATE', 'This file is part of an approved or published record and cannot be unlinked.');
  const resolver = LINK_ACCESS.get(l.entityType);
  const scope = resolver ? await resolver.scope(ctx, l.entityId) : null;
  if (!scope || !resolver || !allowed(ctx, resolver.permission, scope)) throw notFound('Link');
  if (!allowed(ctx, 'assets.link', { projectId: scope.projectId ?? l.projectId }) && !allowed(ctx, 'assets.upload', { projectId: scope.projectId ?? l.projectId }))
    throw new AppError('FORBIDDEN', 'You cannot remove this attachment.');
  await ctx.tx.update(assetLinks).set({ removedAt: ctx.app.clock.now(), removedBy: ctx.actor.userId, ...touch(ctx, assetLinks) }).where(eq(assetLinks.id, linkId));
  await audit(ctx, { action: 'asset.link_removed', entityType: 'asset', entityId: l.assetId, projectId: l.projectId, reason });
  await emit(ctx, { type: 'asset.link_removed', entityType: 'asset', entityId: l.assetId });
  return { ok: true as const };
};

/** Signed, short-lived token binding one version to the proxy route (≤ 5 minutes). */
export const contentToken = (secret: string, versionId: string, expiresAt: number, membershipId: string) =>
  `${expiresAt}.${hmac(secret, `asset:${versionId}:${expiresAt}:${membershipId}`)}`;

export const verifyContentToken = (secret: string, token: string, versionId: string, membershipId: string, now: number): boolean => {
  const [exp, sig] = token.split('.');
  const e = Number(exp);
  if (!Number.isFinite(e) || e < now || !sig) return false;
  return sig === hmac(secret, `asset:${versionId}:${e}:${membershipId}`);
};

export const issueDownload = async (ctx: QueryContext, assetId: string, versionId?: string) => {
  const a = await loadReadableAsset(ctx, assetId);
  // Download is a separate permission from read; readers through a linked entity (e.g. contractor
  // task attachments) need assets.download somewhere in their grants.
  if (!allowed(ctx, 'assets.download', assetScope(a)) && !hasAnywhere(ctx.actor.access, 'assets.download'))
    throw new AppError('FORBIDDEN', 'You can view this file but not download it.');
  if (!canSeeRestricted(ctx, a)) throw new AppError('FORBIDDEN', 'Restricted media requires restricted-media access.');
  const vId = versionId ?? a.currentVersionId;
  if (!vId) throw new AppError('INVALID_STATE', 'This file has no stored version (external link).');
  const [v] = await ctx.app.db.select().from(assetVersions).where(and(eq(assetVersions.assetId, a.id), eq(assetVersions.id, vId)));
  if (!v) throw notFound('File version');
  if (v.status !== 'available' || !v.storageKey) throw new AppError('INVALID_STATE', 'The file is still being checked or was rejected.');
  const ttl = 300;
  const expiresAt = new Date(ctx.app.clock.now().getTime() + ttl * 1000);
  const restricted = a.sensitivity === 'restricted';
  if (restricted || ctx.app.storage.driver === 'filesystem') {
    const token = contentToken(ctx.app.config.SESSION_SECRET, v.id, expiresAt.getTime(), ctx.actor.membershipId ?? 'system');
    return {
      url: `/api/v1/workspaces/${ctx.actor.workspaceId}/assets/${a.id}/versions/${v.id}/content?token=${encodeURIComponent(token)}&disposition=attachment`,
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
  if (!v || v.status !== 'available' || !v.storageKey) throw notFound('File');
  return { asset: a, version: v };
};


/** External link as a metadata-only asset: the URL is a note; the server never fetches it. */
export const createExternalLinkAsset = async (
  ctx: CommandContext,
  input: { url: string; title: string; projectId?: string | null; folderId?: string | null; target?: { entityType: string; entityId: string; role?: string } },
) => {
  requirePermission(ctx, 'assets.upload');
  let projectId = input.projectId ?? null;
  if (input.target) {
    const r = LINK_ACCESS.get(input.target.entityType);
    const scope = r ? await r.scope(ctx, input.target.entityId) : null;
    if (!r || !scope || !allowed(ctx, r.permission, scope)) throw notFound('Target');
    projectId = projectId ?? scope.projectId ?? null;
  }
  if (!allowed(ctx, 'assets.upload', { projectId })) throw new AppError('FORBIDDEN', 'You cannot add files here.');
  const id = newId();
  const [row] = await ctx.tx
    .insert(assets)
    .values({ ...stamp(ctx), id, name: input.title.trim(), kind: 'external_link', externalUrl: input.url.trim(), projectId, folderId: input.folderId ?? null, ownerMembershipId: ctx.actor.membershipId })
    .returning();
  if (input.target)
    await ctx.tx.insert(assetLinks).values({ ...stamp(ctx), id: newId(), assetId: id, entityType: input.target.entityType, entityId: input.target.entityId, role: input.target.role ?? 'attachment', projectId });
  await audit(ctx, { action: 'asset.external_link_added', entityType: 'asset', entityId: id, projectId });
  await emit(ctx, { type: 'asset.created', entityType: 'asset', entityId: id, revision: 1 });
  await indexAsset(ctx, row!);
  return (await toAssetView(ctx, [row!]))[0]!;
};
