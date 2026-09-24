import { and, desc, eq, gt, sql } from 'drizzle-orm';
import { assets, assetVersions, folders, uploadSessions, workspaces } from '@castlane/database';
import { AppError, newId, notFound } from '@castlane/domain';
import { allowed, requirePermission } from '../core/access';
import { audit } from '../core/audit';
import type { CommandContext, QueryContext } from '../core/context';
import { emit } from '../core/events';
import { enqueueJob } from '../core/jobs';
import { stamp } from '../core/rows';
import { assertFolderFor, assetScope, canReadAsset } from './assets';
import { LINK_ACCESS, resolveLinkTarget } from './link-access';
import { isDeclaredAllowed, sizeLimit, type UploadPurpose } from './sniff';

const PART_SIZE = 8 * 1024 * 1024;
const SESSION_TTL_MS = 24 * 3_600_000;
const PART_URL_TTL_S = 3600;
const DEFAULT_QUOTA = 500n * 1024n ** 3n;

const kindFromMime = (mime: string) =>
  mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : mime === 'application/zip' || mime === 'application/x-zip-compressed' ? 'archive' : 'document';

/**
 * Reserve quota atomically (used + in-flight reservations + this file ≤ quota); concurrent
 * uploads near the limit cannot jointly exceed it.
 */
const reserveQuota = async (ctx: CommandContext, bytes: number) => {
  const [ws] = await ctx.tx.select({ settings: workspaces.settings }).from(workspaces).where(eq(workspaces.id, ctx.actor.workspaceId));
  const quota = BigInt(ws?.settings?.fileQuotaBytes ?? DEFAULT_QUOTA.toString());
  const res = await ctx.tx.execute<{ id: string }>(sql`
    UPDATE ${workspaces} SET storage_reserved_bytes = storage_reserved_bytes + ${bytes}
    WHERE id = ${ctx.actor.workspaceId} AND storage_used_bytes + storage_reserved_bytes + ${bytes} <= ${quota.toString()}::bigint
    RETURNING id`);
  if (res.rows.length === 0)
    throw new AppError('QUOTA_EXCEEDED', 'The workspace storage quota is full. Existing files stay available; delete or archive files, or ask the Owner to raise the quota.');
};

export const releaseReservation = async (db: CommandContext['tx'] | QueryContext['app']['db'], workspaceId: string, bytes: number) => {
  await db.execute(sql`UPDATE ${workspaces} SET storage_reserved_bytes = GREATEST(0, storage_reserved_bytes - ${bytes}) WHERE id = ${workspaceId}`);
};

const partUrls = async (ctx: QueryContext, s: typeof uploadSessions.$inferSelect, partNumbers: number[]) =>
  Promise.all(
    partNumbers.map(async (n) => {
      const p = await ctx.app.storage.presignUploadPart(s.quarantineKey, s.multipartUploadId!, n, PART_URL_TTL_S);
      return { partNumber: n, url: p.url, method: 'PUT' as const, headers: p.headers };
    }),
  );

export interface InitiateUploadInput {
  filename: string;
  mimeType: string;
  byteSize: number;
  checksumSha256?: string;
  assetId?: string;
  projectId?: string | null;
  folderId?: string | null;
  sensitivity?: 'normal' | 'restricted';
  purpose: UploadPurpose;
  target?: { entityType: string; entityId: string; role?: string };
  note?: string;
}

/**
 * Authorise → reserve quota → create the logical asset (or new version) → open a multipart
 * upload whose credentials only ever point at this session's quarantine key.
 */
export const initiateUpload = async (ctx: CommandContext, input: InitiateUploadInput) => {
  requirePermission(ctx, 'assets.upload');
  const mime = input.mimeType.toLowerCase();
  if (!isDeclaredAllowed(mime)) throw new AppError('VALIDATION_FAILED', 'This file type is not supported.', { fieldErrors: [{ field: 'mimeType', code: 'UNSUPPORTED', message: 'This file type is not supported.' }] });
  const limit = sizeLimit(input.purpose, mime, ctx.app.config.MAX_UPLOAD_BYTES);
  if (input.byteSize > limit) throw new AppError('PAYLOAD_TOO_LARGE', `The file is larger than the ${Math.round(limit / 1024 / 1024)} MB limit for this type.`);

  let projectId = input.projectId ?? null;
  if (input.target) {
    if (!LINK_ACCESS.has(input.target.entityType)) throw new AppError('VALIDATION_FAILED', `Files cannot be attached to ${input.target.entityType}.`);
    const scope = await resolveLinkTarget(ctx, input.target.entityType, input.target.entityId);
    if (!scope) throw notFound('Target');
    projectId = projectId ?? scope.projectId ?? null;
  }
  if (input.folderId && !input.assetId) {
    // A project folder gives its project to new files; workspace folders keep the chosen scope.
    const [f] = await ctx.tx.select({ projectId: folders.projectId }).from(folders).where(and(eq(folders.workspaceId, ctx.actor.workspaceId), eq(folders.id, input.folderId)));
    if (f?.projectId && input.projectId === undefined && !input.target) projectId = f.projectId;
    await assertFolderFor(ctx, input.folderId, projectId);
  }
  if (!allowed(ctx, 'assets.upload', { projectId })) throw new AppError('FORBIDDEN', 'You cannot upload files here.');
  if (input.sensitivity === 'restricted' && !allowed(ctx, 'assets.restricted.read', { projectId }))
    throw new AppError('FORBIDDEN', 'Only members with restricted-media access can upload restricted media.');

  await reserveQuota(ctx, input.byteSize);
  const at = ctx.app.clock.now();
  let assetId = input.assetId;
  let versionNo = 1;
  if (assetId) {
    const [a] = await ctx.tx.select().from(assets).where(and(eq(assets.workspaceId, ctx.actor.workspaceId), eq(assets.id, assetId))).for('update');
    if (!a || !(await canReadAsset(ctx, a))) throw notFound('File');
    if (!allowed(ctx, 'assets.upload', assetScope(a))) throw new AppError('FORBIDDEN', 'You cannot add versions to this file.');
    if (a.kind === 'external_link') throw new AppError('INVALID_STATE', 'External links have no stored versions.');
    if (a.archivedAt) throw new AppError('INVALID_STATE', 'Restore the file before adding a new version.');
    const [{ max } = { max: 0 }] = await ctx.tx.select({ max: sql<number>`coalesce(max(${assetVersions.versionNo}), 0)` }).from(assetVersions).where(eq(assetVersions.assetId, assetId));
    versionNo = Number(max) + 1;
    projectId = a.projectId;
  } else {
    assetId = newId();
    await ctx.tx.insert(assets).values({
      ...stamp(ctx),
      id: assetId,
      name: input.filename.slice(0, 120),
      kind: kindFromMime(mime),
      folderId: input.folderId ?? null,
      projectId,
      sensitivity: input.sensitivity ?? 'normal',
      ownerMembershipId: ctx.actor.membershipId,
    });
  }
  const versionId = newId();
  await ctx.tx.insert(assetVersions).values({
    ...stamp(ctx),
    id: versionId,
    assetId,
    versionNo,
    status: 'uploading',
    originalFilename: input.filename,
    declaredMime: mime,
    byteSize: input.byteSize,
    checksumSha256: null,
    note: input.note ?? null,
  });
  const uploadId = newId();
  const quarantineKey = `quarantine/${ctx.actor.workspaceId}/${uploadId}`;
  const mp = await ctx.app.storage.createMultipartUpload(quarantineKey, mime);
  const [session] = await ctx.tx
    .insert(uploadSessions)
    .values({
      ...stamp(ctx),
      id: uploadId,
      assetId,
      assetVersionId: versionId,
      targetRef: input.target ?? null,
      folderId: input.folderId ?? null,
      projectId,
      sensitivity: input.sensitivity ?? 'normal',
      filename: input.filename,
      purpose: input.purpose,
      declaredMime: mime,
      declaredSize: input.byteSize,
      expectedChecksum: input.checksumSha256 ?? null,
      quarantineKey,
      multipartUploadId: mp.uploadId,
      partSize: PART_SIZE,
      state: 'open',
      reservedBytes: input.byteSize,
      expiresAt: new Date(at.getTime() + SESSION_TTL_MS),
      ownerMembershipId: ctx.actor.membershipId!,
    })
    .returning();
  const partCount = Math.max(1, Math.ceil(input.byteSize / PART_SIZE));
  await audit(ctx, { action: 'upload.initiated', entityType: 'asset', entityId: assetId, projectId, metadata: { bytes: input.byteSize, mime, purpose: input.purpose } });
  return {
    uploadId,
    assetId,
    assetVersionId: versionId,
    partSize: PART_SIZE,
    partCount,
    parts: await partUrls(ctx, session!, Array.from({ length: partCount }, (_, i) => i + 1)),
    expiresAt: session!.expiresAt.toISOString(),
  };
};

const loadOwnSession = async (ctx: QueryContext | CommandContext, uploadId: string) => {
  const db = 'tx' in ctx ? ctx.tx : ctx.app.db;
  const [s] = await db.select().from(uploadSessions).where(and(eq(uploadSessions.workspaceId, ctx.actor.workspaceId), eq(uploadSessions.id, uploadId)));
  if (!s || s.ownerMembershipId !== ctx.actor.membershipId) throw notFound('Upload');
  return s;
};

export const resumeUpload = async (ctx: QueryContext, uploadId: string) => {
  const s = await loadOwnSession(ctx, uploadId);
  if (s.state !== 'open' || s.expiresAt <= ctx.app.clock.now())
    return { state: s.expiresAt <= ctx.app.clock.now() && s.state === 'open' ? 'expired' : s.state, uploaded: [], missing: [], expiresAt: s.expiresAt.toISOString() };
  const uploaded = await ctx.app.storage.listParts(s.quarantineKey, s.multipartUploadId!);
  const have = new Set(uploaded.map((p) => p.partNumber));
  const count = Math.max(1, Math.ceil(s.declaredSize / s.partSize));
  const missing = Array.from({ length: count }, (_, i) => i + 1).filter((n) => !have.has(n));
  return { state: s.state, uploaded, missing: await partUrls(ctx, s, missing), expiresAt: s.expiresAt.toISOString() };
};

/**
 * Assemble the multipart object in quarantine and queue verification. Idempotent: completing an
 * already-completed session returns the same version; a stale session cannot replace anything.
 */
export const completeUpload = async (ctx: CommandContext, uploadId: string, parts: { partNumber: number; etag: string }[]) => {
  const s = await loadOwnSession(ctx, uploadId);
  const [locked] = await ctx.tx.select().from(uploadSessions).where(eq(uploadSessions.id, s.id)).for('update');
  if (!locked) throw notFound('Upload');
  if (locked.state === 'completed' || locked.state === 'completing') {
    const [v] = await ctx.tx.select({ status: assetVersions.status }).from(assetVersions).where(eq(assetVersions.id, locked.assetVersionId!));
    return { assetId: locked.assetId!, assetVersionId: locked.assetVersionId!, status: v?.status ?? 'checking' };
  }
  if (locked.state !== 'open') throw new AppError('INVALID_STATE', `This upload was ${locked.state}.`);
  if (locked.expiresAt <= ctx.app.clock.now()) throw new AppError('INVALID_STATE', 'This upload session expired. Start the upload again.');
  const expectedParts = Math.max(1, Math.ceil(locked.declaredSize / locked.partSize));
  if (parts.length !== expectedParts) throw new AppError('VALIDATION_FAILED', `Expected ${expectedParts} parts, received ${parts.length}.`);
  await ctx.app.storage.completeMultipartUpload(locked.quarantineKey, locked.multipartUploadId!, parts);
  const head = await ctx.app.storage.headObject(locked.quarantineKey);
  if (!head || head.size !== locked.declaredSize) {
    await ctx.tx.update(assetVersions).set({ status: 'rejected', rejectionReason: 'The uploaded size does not match the declared size.' }).where(eq(assetVersions.id, locked.assetVersionId!));
    await ctx.tx.update(uploadSessions).set({ state: 'completed', completedAt: ctx.app.clock.now() }).where(eq(uploadSessions.id, locked.id));
    await releaseReservation(ctx.tx, ctx.actor.workspaceId, locked.reservedBytes);
    return { assetId: locked.assetId!, assetVersionId: locked.assetVersionId!, status: 'rejected' as const };
  }
  await ctx.tx.update(uploadSessions).set({ state: 'completing', parts: parts.map((p) => ({ ...p, size: 0 })) }).where(eq(uploadSessions.id, locked.id));
  await ctx.tx.update(assetVersions).set({ status: 'checking', quarantineKey: locked.quarantineKey }).where(eq(assetVersions.id, locked.assetVersionId!));
  await enqueueJob(ctx.tx, { type: 'media.process', pool: 'media', workspaceId: ctx.actor.workspaceId, payload: { uploadId: locked.id }, idempotencyKey: `media.process:${locked.id}` });
  await audit(ctx, { action: 'upload.completed', entityType: 'asset', entityId: locked.assetId!, projectId: locked.projectId });
  await emit(ctx, { type: 'upload.completed', entityType: 'asset', entityId: locked.assetId! });
  return { assetId: locked.assetId!, assetVersionId: locked.assetVersionId!, status: 'checking' as const };
};

export const abortUpload = async (ctx: CommandContext, uploadId: string) => {
  const s = await loadOwnSession(ctx, uploadId);
  const [locked] = await ctx.tx.select().from(uploadSessions).where(eq(uploadSessions.id, s.id)).for('update');
  if (!locked || locked.state !== 'open') return { ok: true as const };
  try {
    await ctx.app.storage.abortMultipartUpload(locked.quarantineKey, locked.multipartUploadId!);
  } catch {
    /* already gone */
  }
  await ctx.tx.update(uploadSessions).set({ state: 'aborted' }).where(eq(uploadSessions.id, locked.id));
  await ctx.tx.update(assetVersions).set({ status: 'failed', rejectionReason: 'Upload cancelled.' }).where(eq(assetVersions.id, locked.assetVersionId!));
  await releaseReservation(ctx.tx, ctx.actor.workspaceId, locked.reservedBytes);
  await discardEmptyAsset(ctx.tx, locked.assetId!, ctx.app.clock.now(), ctx.actor.userId);
  await audit(ctx, { action: 'upload.cancelled', entityType: 'asset', entityId: locked.assetId!, projectId: locked.projectId });
  await emit(ctx, { type: 'upload.cancelled', entityType: 'asset', entityId: locked.assetId! });
  return { ok: true as const };
};

/**
 * A new file whose only upload was cancelled or expired never had content: it leaves the Library
 * (moved to trash) instead of lingering as an empty record. Files with an earlier version stay.
 */
export const discardEmptyAsset = async (db: CommandContext['tx'], assetId: string, at: Date, userId: string | null) => {
  await db.execute(sql`
    UPDATE assets SET deleted_at = ${at}, deleted_by = ${userId}, updated_at = ${at}, row_version = row_version + 1
    WHERE id = ${assetId} AND deleted_at IS NULL AND current_version_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM asset_versions v WHERE v.asset_id = ${assetId} AND v.status NOT IN ('failed'))`);
};

/** The member's own unfinished uploads (resume after a reload by choosing the same file again). */
export const listOpenUploads = async (ctx: QueryContext) => {
  requirePermission(ctx, 'assets.upload');
  const rows = await ctx.app.db
    .select()
    .from(uploadSessions)
    .where(
      and(
        eq(uploadSessions.workspaceId, ctx.actor.workspaceId),
        eq(uploadSessions.ownerMembershipId, ctx.actor.membershipId!),
        eq(uploadSessions.state, 'open'),
        gt(uploadSessions.expiresAt, ctx.app.clock.now()),
      ),
    )
    .orderBy(desc(uploadSessions.createdAt))
    .limit(100);
  return rows.map((s) => ({
    uploadId: s.id,
    assetId: s.assetId,
    assetVersionId: s.assetVersionId,
    filename: s.filename,
    byteSize: s.declaredSize,
    state: s.state,
    folderId: s.folderId,
    projectId: s.projectId,
    createdAt: s.createdAt.toISOString(),
    expiresAt: s.expiresAt.toISOString(),
  }));
};
