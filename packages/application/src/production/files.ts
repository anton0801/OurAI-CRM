import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { hasAnywhere } from '@castlane/authorization';
import { assetDerivatives, assets, assetVersions, contentVersionAssets, type DbOrTx } from '@castlane/database';
import { allowed } from '../core/access';
import type { QueryContext } from '../core/context';
import { mediaKindOf, type ContentSlot } from './rules';

/** One file in a content version slot, with the stored asset version's state. */
export interface RawVersionFile {
  id: string;
  contentVersionId: string;
  slot: ContentSlot;
  position: number;
  assetId: string;
  assetVersionId: string;
  fileName: string;
  mime: string | null;
  status: string;
  byteSize: number | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  checksumSha256: string | null;
  rejectionReason: string | null;
  sensitivity: 'normal' | 'restricted';
  assetProjectId: string | null;
  storageKey: string | null;
  hasDerivative: boolean;
}

export const loadVersionFiles = async (db: DbOrTx, workspaceId: string, versionIds: string[]): Promise<RawVersionFile[]> => {
  if (!versionIds.length) return [];
  const rows = await db
    .select({
      id: contentVersionAssets.id,
      contentVersionId: contentVersionAssets.contentVersionId,
      slot: contentVersionAssets.slot,
      position: contentVersionAssets.position,
      assetId: assetVersions.assetId,
      assetVersionId: assetVersions.id,
      fileName: assetVersions.originalFilename,
      detectedMime: assetVersions.detectedMime,
      declaredMime: assetVersions.declaredMime,
      status: assetVersions.status,
      byteSize: assetVersions.byteSize,
      width: assetVersions.width,
      height: assetVersions.height,
      durationMs: assetVersions.durationMs,
      checksumSha256: assetVersions.checksumSha256,
      rejectionReason: assetVersions.rejectionReason,
      sensitivity: assets.sensitivity,
      assetProjectId: assets.projectId,
      storageKey: assetVersions.storageKey,
      hasDerivative: sql<boolean>`EXISTS (SELECT 1 FROM ${assetDerivatives} d WHERE d.asset_version_id = ${assetVersions.id})`,
    })
    .from(contentVersionAssets)
    .innerJoin(assetVersions, and(eq(assetVersions.workspaceId, contentVersionAssets.workspaceId), eq(assetVersions.id, contentVersionAssets.assetVersionId)))
    .innerJoin(assets, and(eq(assets.workspaceId, assetVersions.workspaceId), eq(assets.id, assetVersions.assetId)))
    .where(and(eq(contentVersionAssets.workspaceId, workspaceId), inArray(contentVersionAssets.contentVersionId, versionIds)))
    .orderBy(asc(contentVersionAssets.slot), asc(contentVersionAssets.position));
  return rows.map((r) => ({ ...r, mime: r.detectedMime ?? r.declaredMime, hasDerivative: !!r.hasDerivative }));
};

const SLOT_PRIORITY: ContentSlot[] = ['main_image', 'cover', 'main_video', 'image_set', 'audio', 'caption', 'subtitles', 'document', 'source_archive', 'other'];

/** The file that represents a version in lists (thumbnail source). */
export const primaryFile = (files: RawVersionFile[]): RawVersionFile | null =>
  [...files].sort((a, b) => SLOT_PRIORITY.indexOf(a.slot) - SLOT_PRIORITY.indexOf(b.slot) || a.position - b.position)[0] ?? null;

/** Authorised derivative URL; restricted media never gets a list thumbnail (placeholder instead). */
export const fileThumbnailUrl = (workspaceId: string, f: RawVersionFile | null, size = 256): string | null =>
  f && f.hasDerivative && f.sensitivity !== 'restricted' && f.status === 'available' ? `/api/v1/workspaces/${workspaceId}/assets/${f.assetId}/thumbnail?size=${size}&versionId=${f.assetVersionId}` : null;

const canSeeRestrictedFile = (ctx: QueryContext, f: RawVersionFile) => f.sensitivity !== 'restricted' || allowed(ctx, 'assets.restricted.read', { projectId: f.assetProjectId });

export const toVersionFileView = (ctx: QueryContext, f: RawVersionFile) => {
  const restricted = f.sensitivity === 'restricted';
  const visibleRestricted = canSeeRestrictedFile(ctx, f);
  return {
    id: f.id,
    slot: f.slot,
    position: f.position,
    assetId: f.assetId,
    assetVersionId: f.assetVersionId,
    // Restricted media without permission shows a neutral placeholder: no file name, no preview.
    fileName: restricted && !visibleRestricted ? 'Restricted media' : f.fileName,
    mime: f.mime,
    kind: mediaKindOf(f.mime),
    status: f.status,
    byteSize: f.byteSize,
    width: f.width,
    height: f.height,
    durationMs: f.durationMs,
    checksumSha256: restricted && !visibleRestricted ? null : f.checksumSha256,
    rejectionReason: f.rejectionReason,
    restricted,
    canReveal: restricted && visibleRestricted && f.hasDerivative,
    previewAvailable: f.hasDerivative && f.status === 'available',
    thumbnailUrl: fileThumbnailUrl(ctx.actor.workspaceId, f, 1280),
    canDownload: f.status === 'available' && hasAnywhere(ctx.actor.access, 'assets.download') && visibleRestricted,
  };
};
