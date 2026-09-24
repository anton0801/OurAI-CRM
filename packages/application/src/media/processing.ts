import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { and, eq, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import sharp from 'sharp';
import { assetDerivatives, assetLinks, assets, assetVersions, uploadSessions, withTransaction, workspaces } from '@castlane/database';
import { newId } from '@castlane/domain';
import type { AppServices } from '../core/context';
import { streamEvent } from '../core/events';
import { defineJob, defineSchedule } from '../core/jobs-registry';
import { indexAsset } from './assets';
import { discardEmptyAsset, releaseReservation } from './uploads';
import { pixelLimit, sizeLimit, sniff, type UploadPurpose } from './sniff';

const THUMB_SIZES = [64, 128, 256];
const COVER_SIZES: [number, number][] = [
  [320, 180],
  [640, 360],
  [1280, 720],
];

const run = (cmd: string, args: string[], timeoutMs = 120_000) =>
  new Promise<string>((resolve, reject) =>
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout))),
  );

/** Attempts of `media.process` (first run + 5 retries, section 19); the last one fails honestly. */
const FINAL_ATTEMPT = 6;

const reject = async (app: AppServices, s: typeof uploadSessions.$inferSelect, reason: string, status: 'rejected' | 'failed' = 'rejected') => {
  await withTransaction(app.db, async (tx) => {
    await tx.update(assetVersions).set({ status, rejectionReason: reason, processedAt: app.clock.now() }).where(eq(assetVersions.id, s.assetVersionId!));
    await tx.update(uploadSessions).set({ state: 'completed', completedAt: app.clock.now() }).where(eq(uploadSessions.id, s.id));
    await releaseReservation(tx, s.workspaceId, s.reservedBytes);
  });
  try {
    await app.storage.deleteObject(s.quarantineKey);
  } catch {
    /* ignore */
  }
  await streamEvent(app.db, { workspaceId: s.workspaceId, kind: 'entity_changed', entityType: 'asset', entityId: s.assetId! });
  return { rejected: reason };
};

/**
 * Verification pipeline (section 14): checksum → sniffed type vs allowlist → decoded bounds →
 * malware scan → copy the exact verified bytes to a server-generated final key (the client never
 * had write access to it) → derivatives → Available. Any failure leaves the file unavailable.
 */
defineJob(
  'media.process',
  'media',
  async ({ app, job, heartbeat }) => {
    const { uploadId } = job.payload as { uploadId: string };
    const [s] = await app.db.select().from(uploadSessions).where(eq(uploadSessions.id, uploadId));
    if (!s) return { skipped: 'missing session' };
    if (s.state === 'completed') return { skipped: 'already processed' };
    const [version] = await app.db.select().from(assetVersions).where(eq(assetVersions.id, s.assetVersionId!));
    if (!version || version.status === 'available') return { skipped: 'already available' };

    const tmp = join(tmpdir(), `castlane-${uploadId}`);
    try {
      // 1. Pull the quarantined object once, hashing while writing to a private temp file.
      const hash = createHash('sha256');
      const { stream } = await app.storage.getObjectStream(s.quarantineKey);
      let head = Buffer.alloc(0);
      await pipeline(
        stream,
        new Transform({
          transform(chunk: Buffer, _enc, cb) {
            hash.update(chunk);
            if (head.length < 8192) head = Buffer.concat([head, chunk.subarray(0, 8192 - head.length)]);
            cb(null, chunk);
          },
        }),
        createWriteStream(tmp, { mode: 0o600 }),
      );
      const checksum = hash.digest('hex');
      const stat = await fs.stat(tmp);
      await heartbeat(20, 'checksum verified');
      if (s.expectedChecksum && s.expectedChecksum !== checksum) return reject(app, s, 'The file checksum does not match the upload declaration.');
      if (stat.size !== s.declaredSize) return reject(app, s, 'The uploaded size does not match the declared size.');

      // 2. Type from content, never from the browser or extension.
      const detected = sniff(head, s.filename);
      if (!detected) return reject(app, s, 'The file type could not be verified or is not supported.');
      const purpose = (s.purpose as UploadPurpose) ?? 'general';
      if (stat.size > sizeLimit(purpose, detected.mime, app.config.MAX_UPLOAD_BYTES)) return reject(app, s, 'The file exceeds the size limit for its type.');

      // 3. Decoded bounds for raster images (decompression-bomb guard) before any processing.
      let width: number | null = null;
      let height: number | null = null;
      let durationMs: number | null = null;
      if (detected.kind === 'image' && detected.mime !== 'image/svg+xml') {
        try {
          const meta = await sharp(tmp, { limitInputPixels: pixelLimit(purpose), failOn: 'error' }).metadata();
          width = meta.width ?? null;
          height = meta.height ?? null;
          if (!width || !height || width * height > pixelLimit(purpose)) return reject(app, s, 'The image dimensions exceed the allowed limit.');
        } catch {
          return reject(app, s, 'The image could not be decoded safely or exceeds the pixel limit.');
        }
      }

      // 4. Malware scan of the exact bytes that will be stored. When the scanner is unavailable the
      //    file stays "Checking" while the job retries, and fails honestly after the last attempt
      //    — it never becomes Available unscanned (T077).
      await app.db.update(assetVersions).set({ status: 'checking' }).where(eq(assetVersions.id, version.id));
      let scan: Awaited<ReturnType<typeof app.scanner.scan>>;
      try {
        scan = await app.scanner.scan(createReadStream(tmp));
      } catch (e) {
        app.logger.warn('malware_scan_unavailable', { uploadId, attempt: job.attempts, error: (e as Error).message });
        if (job.attempts >= FINAL_ATTEMPT)
          return reject(app, s, 'The malware scan service was unavailable, so the file could not be checked. Upload it again later.', 'failed');
        throw Object.assign(new Error('Malware scan service unavailable; the check will be retried.'), { code: 'DEPENDENCY_UNAVAILABLE' });
      }
      if (!scan.clean) return reject(app, s, `The file was rejected by the malware scan (${scan.signature ?? 'threat detected'}).`);
      await heartbeat(50, 'scanned');

      // 5. Store under a server-generated final key.
      await app.db.update(assetVersions).set({ status: 'processing' }).where(eq(assetVersions.id, version.id));
      const base = `assets/${s.workspaceId}/${s.assetId}/${version.id}`;
      const finalKey = `${base}/original`;
      const put = await app.storage.putObject(finalKey, createReadStream(tmp), { contentType: detected.mime, contentLength: stat.size });

      // 6. Derivatives (isolated to this worker; failures do not block availability of the original).
      const derivatives: { kind: string; key: string; width: number; height: number; bytes: number }[] = [];
      try {
        if (detected.kind === 'image') {
          const src = () => sharp(tmp, { limitInputPixels: pixelLimit(purpose), density: detected.mime === 'image/svg+xml' ? 96 : undefined });
          for (const size of THUMB_SIZES) {
            const buf = await src().rotate().resize(size, size, { fit: 'cover' }).webp({ quality: 80 }).toBuffer();
            await app.storage.putObject(`${base}/thumb_${size}.webp`, buf, { contentType: 'image/webp' });
            derivatives.push({ kind: `thumb_${size}`, key: `${base}/thumb_${size}.webp`, width: size, height: size, bytes: buf.length });
          }
          for (const [w, h] of COVER_SIZES) {
            const buf = await src().rotate().resize(w, h, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
            const m = await sharp(buf).metadata();
            await app.storage.putObject(`${base}/cover_${w}.webp`, buf, { contentType: 'image/webp' });
            derivatives.push({ kind: `cover_${w}`, key: `${base}/cover_${w}.webp`, width: m.width ?? w, height: m.height ?? h, bytes: buf.length });
          }
          if (detected.mime === 'image/svg+xml') {
            const m = await sharp(tmp, { density: 96 }).metadata();
            width = m.width ?? null;
            height = m.height ?? null;
          }
        } else if (detected.kind === 'video' && app.config.FFPROBE_PATH) {
          const probe = JSON.parse(await run(app.config.FFPROBE_PATH, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', tmp])) as {
            format?: { duration?: string };
            streams?: { codec_type?: string; width?: number; height?: number }[];
          };
          durationMs = probe.format?.duration ? Math.round(Number(probe.format.duration) * 1000) : null;
          const v = probe.streams?.find((x) => x.codec_type === 'video');
          width = v?.width ?? null;
          height = v?.height ?? null;
          if (app.config.FFMPEG_PATH) {
            const poster = `${tmp}.jpg`;
            await run(app.config.FFMPEG_PATH, ['-v', 'error', '-ss', '1', '-i', tmp, '-frames:v', '1', '-vf', 'scale=1280:-2', poster]);
            for (const size of THUMB_SIZES) {
              const buf = await sharp(poster).resize(size, size, { fit: 'cover' }).webp({ quality: 80 }).toBuffer();
              await app.storage.putObject(`${base}/thumb_${size}.webp`, buf, { contentType: 'image/webp' });
              derivatives.push({ kind: `thumb_${size}`, key: `${base}/thumb_${size}.webp`, width: size, height: size, bytes: buf.length });
            }
            const pbuf = await sharp(poster).resize(1280, 720, { fit: 'inside' }).webp({ quality: 82 }).toBuffer();
            await app.storage.putObject(`${base}/poster.webp`, pbuf, { contentType: 'image/webp' });
            derivatives.push({ kind: 'poster', key: `${base}/poster.webp`, width: 1280, height: 720, bytes: pbuf.length });
            await fs.rm(poster, { force: true });
          }
        }
      } catch (e) {
        app.logger.warn('derivative_failed', { uploadId, error: (e as Error).message });
      }
      await heartbeat(90, 'derivatives');

      // 7. Commit: version available, reservation → usage, optional target link.
      await withTransaction(app.db, async (tx) => {
        await tx
          .update(assetVersions)
          .set({
            status: 'available',
            storageKey: finalKey,
            storageVersionId: put.versionId ?? null,
            quarantineKey: null,
            detectedMime: detected.mime,
            byteSize: stat.size,
            checksumSha256: checksum,
            width,
            height,
            durationMs,
            scanResult: { engine: scan.engine, clean: true, devBypass: scan.devBypass, scannedAt: app.clock.now().toISOString() },
            processedAt: app.clock.now(),
          })
          .where(eq(assetVersions.id, version.id));
        for (const d of derivatives)
          await tx
            .insert(assetDerivatives)
            .values({ id: newId(), workspaceId: s.workspaceId, assetVersionId: version.id, kind: d.kind, storageKey: d.key, mime: 'image/webp', width: d.width, height: d.height, byteSize: d.bytes })
            .onConflictDoNothing();
        const [asset] = await tx
          .update(assets)
          .set({ currentVersionId: version.id, kind: detected.kind === 'document' || detected.kind === 'archive' || detected.kind === 'other' ? detected.kind : detected.kind, updatedAt: app.clock.now(), rowVersion: sql`${assets.rowVersion} + 1` })
          .where(eq(assets.id, s.assetId!))
          .returning();
        await tx.update(uploadSessions).set({ state: 'completed', completedAt: app.clock.now() }).where(eq(uploadSessions.id, s.id));
        await tx.execute(
          sql`UPDATE workspaces SET storage_reserved_bytes = GREATEST(0, storage_reserved_bytes - ${s.reservedBytes}), storage_used_bytes = storage_used_bytes + ${stat.size} WHERE id = ${s.workspaceId}`,
        );
        const target = s.targetRef as { entityType: string; entityId: string; role?: string } | null;
        if (target) {
          await tx
            .insert(assetLinks)
            .values({
              id: newId(),
              workspaceId: s.workspaceId,
              assetId: s.assetId!,
              assetVersionId: version.id,
              entityType: target.entityType,
              entityId: target.entityId,
              role: target.role ?? 'attachment',
              projectId: s.projectId,
              createdBy: s.createdBy,
            })
            .onConflictDoNothing();
        }
        // Restricted media is never indexed for global search.
        if (asset) await indexAsset(tx, asset, app.clock.now());
      });
      try {
        await app.storage.deleteObject(s.quarantineKey);
      } catch {
        /* quarantine cleanup is retried by the orphan sweep */
      }
      await streamEvent(app.db, { workspaceId: s.workspaceId, kind: 'entity_changed', entityType: 'asset', entityId: s.assetId! });
      return { versionId: version.id, mime: detected.mime, bytes: stat.size, derivatives: derivatives.length, devBypassScan: !!scan.devBypass };
    } finally {
      await fs.rm(tmp, { force: true });
    }
  },
  { leaseSeconds: 900 },
);

/** Abandoned upload sessions release their reservation after 24 h (section 14). */
defineJob('media.expireUploads', 'light', async ({ app }) => {
  const now = app.clock.now();
  const stale = await app.db.select().from(uploadSessions).where(and(eq(uploadSessions.state, 'open'), lt(uploadSessions.expiresAt, now))).limit(200);
  for (const s of stale) {
    try {
      await app.storage.abortMultipartUpload(s.quarantineKey, s.multipartUploadId!);
    } catch {
      /* ignore */
    }
    await withTransaction(app.db, async (tx) => {
      await tx.update(uploadSessions).set({ state: 'expired' }).where(eq(uploadSessions.id, s.id));
      await tx.update(assetVersions).set({ status: 'failed', rejectionReason: 'The upload session expired before completion.' }).where(eq(assetVersions.id, s.assetVersionId!));
      await releaseReservation(tx, s.workspaceId, s.reservedBytes);
      if (s.assetId) await discardEmptyAsset(tx, s.assetId, now, null);
    });
  }
  return { expired: stale.length };
});

defineSchedule({ name: 'media.expireUploads', everySeconds: 3600, jobType: 'media.expireUploads' });

/**
 * Purge the stored file of deleted versions once the workspace trash period has passed: the
 * original and its derivatives are removed from storage and the usage is released. The version
 * row stays (history, audit) with purgedAt set. Idempotent.
 */
defineJob('media.purgeDeletedVersions', 'media', async ({ app }) => {
  const now = app.clock.now();
  const due = await app.db
    .select({ v: assetVersions, trashDays: sql<number | null>`(${workspaces.settings} -> 'retention' ->> 'trashDays')::int` })
    .from(assetVersions)
    .innerJoin(workspaces, eq(workspaces.id, assetVersions.workspaceId))
    .where(and(isNotNull(assetVersions.deletedAt), isNull(assetVersions.purgedAt)))
    .limit(200);
  let purged = 0;
  for (const { v, trashDays } of due) {
    const days = trashDays ?? 30;
    if (!v.deletedAt || v.deletedAt.getTime() + days * 86_400_000 > now.getTime()) continue;
    const derivs = await app.db.select().from(assetDerivatives).where(eq(assetDerivatives.assetVersionId, v.id));
    for (const key of [v.storageKey, ...derivs.map((d) => d.storageKey)]) {
      if (!key) continue;
      try {
        await app.storage.deleteObject(key);
      } catch {
        /* already gone — purge stays idempotent */
      }
    }
    await withTransaction(app.db, async (tx) => {
      const [row] = await tx
        .update(assetVersions)
        .set({ purgedAt: now })
        .where(and(eq(assetVersions.id, v.id), isNull(assetVersions.purgedAt)))
        .returning({ id: assetVersions.id });
      if (!row) return;
      await tx.delete(assetDerivatives).where(eq(assetDerivatives.assetVersionId, v.id));
      if (v.status === 'available' && v.byteSize)
        await tx.execute(sql`UPDATE workspaces SET storage_used_bytes = GREATEST(0, storage_used_bytes - ${v.byteSize}) WHERE id = ${v.workspaceId}`);
    });
    purged++;
  }
  return { purged };
});

defineSchedule({ name: 'media.purgeDeletedVersions', everySeconds: 6 * 3600, jobType: 'media.purgeDeletedVersions', pool: 'media' });
