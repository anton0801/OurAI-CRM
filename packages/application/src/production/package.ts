import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { ZipArchive } from 'archiver';
import { hasAnywhere } from '@castlane/authorization';
import { characters, characterVersions, contentItems, contentVersions, episodes, exportJobs, projects, reviewDecisions, reviews } from '@castlane/database';
import { AppError, newId, notFound } from '@castlane/domain';
import { allowed, requirePermission } from '../core/access';
import { audit } from '../core/audit';
import type { CommandContext, QueryContext } from '../core/context';
import { emit, streamEvent } from '../core/events';
import { enqueueJob } from '../core/jobs';
import { defineJob, memberJobContext } from '../core/jobs-registry';
import { loadMemberRefs } from '../core/members';
import { stamp } from '../core/rows';
import { EXPORT_TTL_MS } from '../platform/exports/engine';
import { loadVersionFiles, type RawVersionFile } from './files';
import { contentVersionPlacement } from './reviews';
import { slotLabel, type BriefFields } from './rules';
import { canReadContent, readableContent } from './scope';

export const CONTENT_PACKAGE_DATASET = 'content_package';
const ACTIVE_PER_MEMBER = 5;
const ACTIVE_PER_WORKSPACE = 20;

interface PackageItem {
  contentItemId: string;
  versionId: string;
}

const slug = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[^\w\s.-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 60)
    .toLowerCase() || 'content';

/** Same quotas as the Export Center (5 active per member, 20 per workspace), serialised per workspace. */
const assertQuota = async (ctx: CommandContext) => {
  await ctx.tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`exports:${ctx.actor.workspaceId}`}))`);
  const [counts] = await ctx.tx
    .select({
      mine: sql<number>`count(*) FILTER (WHERE ${exportJobs.requestedByMembershipId} = ${ctx.actor.membershipId})::int`,
      all: sql<number>`count(*)::int`,
    })
    .from(exportJobs)
    .where(and(eq(exportJobs.workspaceId, ctx.actor.workspaceId), inArray(exportJobs.state, ['queued', 'running'])));
  if (Number(counts?.mine ?? 0) >= ACTIVE_PER_MEMBER) throw new AppError('QUOTA_EXCEEDED', `You already have ${ACTIVE_PER_MEMBER} exports in progress. Wait for one to finish or cancel it.`);
  if (Number(counts?.all ?? 0) >= ACTIVE_PER_WORKSPACE) throw new AppError('QUOTA_EXCEEDED', `The workspace already has ${ACTIVE_PER_WORKSPACE} exports in progress. Try again shortly.`);
};

const queuePackage = async (ctx: CommandContext, items: PackageItem[], filters: Record<string, unknown>, restricted: boolean, auditTarget: { entityType: string; entityId: string; projectId: string }) => {
  if (!ctx.actor.membershipId) throw new AppError('FORBIDDEN', 'Only members can request exports.');
  await assertQuota(ctx);
  const id = newId();
  const [row] = await ctx.tx
    .insert(exportJobs)
    .values({
      ...stamp(ctx),
      id,
      requestedByMembershipId: ctx.actor.membershipId,
      dataset: CONTENT_PACKAGE_DATASET,
      format: 'zip',
      fields: [],
      filters: { ...filters, items },
      classification: restricted ? 'private' : 'normal',
      state: 'queued',
      sourceBoundAt: ctx.app.clock.now(),
    })
    .returning();
  const jobId = await enqueueJob(ctx.tx, { type: 'content.package', pool: 'data', workspaceId: ctx.actor.workspaceId, payload: { exportId: id }, requestedBy: ctx.actor.membershipId, idempotencyKey: `content.package:${id}`, maxRetries: 0 });
  await ctx.tx.update(exportJobs).set({ jobId }).where(eq(exportJobs.id, id));
  await audit(ctx, { action: 'export.requested', entityType: 'export_job', entityId: id, metadata: { dataset: CONTENT_PACKAGE_DATASET, format: 'zip', items: items.length, classification: row!.classification } });
  await audit(ctx, { action: 'content.package_requested', entityType: auditTarget.entityType, entityId: auditTarget.entityId, projectId: auditTarget.projectId, metadata: { exportId: id, items: items.length } });
  await emit(ctx, { type: 'export.requested', entityType: 'export_job', entityId: id, revision: 1 });
  return id;
};

const hasRestricted = async (ctx: CommandContext, versionIds: string[]) => (await loadVersionFiles(ctx.tx, ctx.actor.workspaceId, versionIds)).some((f) => f.sensitivity === 'restricted');

/** ZIP package of one approved content version (§22.2): manifest.json, files, subtitles, metadata. */
export const requestContentPackage = async (ctx: CommandContext, contentId: string, input: { versionId?: string }) => {
  requirePermission(ctx, 'exports.create');
  const c = await readableContent(ctx, contentId);
  const versionId = input.versionId ?? c.approvedVersionId;
  if (!versionId) throw new AppError('INVALID_STATE', 'This content has no approved version to export yet.');
  const [v] = await ctx.tx.select({ id: contentVersions.id }).from(contentVersions).where(and(eq(contentVersions.id, versionId), eq(contentVersions.contentItemId, c.id)));
  if (!v) throw notFound('Version');
  const state = await contentVersionPlacement(ctx.tx, ctx.actor.workspaceId, versionId);
  if (!state.placeable) throw new AppError('INVALID_STATE', `Only approved versions are exported as a package. ${state.reason}`);
  return queuePackage(ctx, [{ contentItemId: c.id, versionId }], { contentItemId: c.id }, await hasRestricted(ctx, [versionId]), { entityType: 'content_item', entityId: c.id, projectId: c.projectId });
};

/** ZIP package of an episode: every readable content item of the episode with an approved version. */
export const requestEpisodePackage = async (ctx: CommandContext, episodeId: string) => {
  requirePermission(ctx, 'exports.create');
  const [e] = await ctx.tx.select().from(episodes).where(and(eq(episodes.workspaceId, ctx.actor.workspaceId), eq(episodes.id, episodeId)));
  if (!e || !(allowed(ctx, 'series.read', { projectId: e.projectId }) || allowed(ctx, 'content.read', { projectId: e.projectId }))) throw notFound('Episode');
  const rows = await ctx.tx
    .select()
    .from(contentItems)
    .where(and(eq(contentItems.workspaceId, ctx.actor.workspaceId), isNull(contentItems.deletedAt), or(eq(contentItems.episodeId, episodeId), e.contentItemId ? eq(contentItems.id, e.contentItemId) : undefined)));
  const items: PackageItem[] = [];
  for (const r of rows) {
    if (!r.approvedVersionId || !(await canReadContent(ctx, r))) continue;
    if ((await contentVersionPlacement(ctx.tx, ctx.actor.workspaceId, r.approvedVersionId)).placeable) items.push({ contentItemId: r.id, versionId: r.approvedVersionId });
  }
  if (!items.length) throw new AppError('INVALID_STATE', 'This episode has no approved content you can export yet.');
  return queuePackage(ctx, items, { episodeId }, await hasRestricted(ctx, items.map((i) => i.versionId)), { entityType: 'episode', entityId: e.id, projectId: e.projectId });
};

/** The member's own package exports of one content item (download through the Export Center endpoints). */
export const listContentPackages = async (ctx: QueryContext, contentId: string) => {
  requirePermission(ctx, 'exports.create');
  await readableContent(ctx, contentId);
  const rows = await ctx.app.db
    .select({ id: exportJobs.id })
    .from(exportJobs)
    .where(
      and(
        eq(exportJobs.workspaceId, ctx.actor.workspaceId),
        eq(exportJobs.dataset, CONTENT_PACKAGE_DATASET),
        eq(exportJobs.requestedByMembershipId, ctx.actor.membershipId ?? ''),
        sql`${exportJobs.filters} ->> 'contentItemId' = ${contentId}`,
      ),
    )
    .orderBy(desc(exportJobs.createdAt))
    .limit(10);
  return rows.map((r) => r.id);
};

// ——— Generation job ———

const failPackage = async (app: QueryContext['app'], r: typeof exportJobs.$inferSelect, message: string) => {
  await app.db
    .update(exportJobs)
    .set({ state: 'failed', errorMessage: message.slice(0, 500), progress: 0, storageKey: null, updatedAt: app.clock.now(), rowVersion: sql`${exportJobs.rowVersion} + 1` })
    .where(and(eq(exportJobs.id, r.id), inArray(exportJobs.state, ['queued', 'running'])));
  await streamEvent(app.db, { workspaceId: r.workspaceId, kind: 'entity_changed', entityType: 'export_job', entityId: r.id });
  return { failed: message };
};

class PackageRefusal extends Error {}

/** Everything that goes into the package, re-authorised as the requester at generation time. */
const collect = async (ctx: QueryContext, items: PackageItem[]) => {
  const db = ctx.app.db;
  const out: { content: typeof contentItems.$inferSelect; projectName: string; version: typeof contentVersions.$inferSelect; files: RawVersionFile[]; approval: { by: string | null; at: string | null }; characters: { name: string; versionNo: number }[] }[] = [];
  if (!hasAnywhere(ctx.actor.access, 'assets.download')) throw new PackageRefusal('You no longer have download access. Request the package again after your access is restored.');
  for (const it of items) {
    const [c] = await db.select().from(contentItems).where(and(eq(contentItems.workspaceId, ctx.actor.workspaceId), eq(contentItems.id, it.contentItemId)));
    if (!c || c.deletedAt || !(await canReadContent(ctx, c))) throw new PackageRefusal('Some content in this package is no longer available to you.');
    const state = await contentVersionPlacement(db, ctx.actor.workspaceId, it.versionId);
    if (!state.placeable) throw new PackageRefusal(`“${c.title}”: ${state.reason}`);
    const [v] = await db.select().from(contentVersions).where(eq(contentVersions.id, it.versionId));
    const files = await loadVersionFiles(db, ctx.actor.workspaceId, [it.versionId]);
    for (const f of files) {
      if (f.status !== 'available' || !f.storageKey) throw new PackageRefusal(`“${c.title}”: a file of version ${v!.versionNo} is not available.`);
      if (f.sensitivity === 'restricted' && !allowed(ctx, 'assets.restricted.read', { projectId: f.assetProjectId })) throw new PackageRefusal(`“${c.title}” contains restricted media you cannot access.`);
    }
    const [p] = await db.select({ name: projects.name }).from(projects).where(eq(projects.id, c.projectId));
    const [decision] = await db
      .select({ by: reviewDecisions.decidedByMembershipId, at: reviewDecisions.decidedAt })
      .from(reviewDecisions)
      .innerJoin(reviews, eq(reviews.id, reviewDecisions.reviewId))
      .where(and(eq(reviews.targetId, it.versionId), eq(reviewDecisions.decision, 'approved')))
      .orderBy(desc(reviewDecisions.decidedAt))
      .limit(1);
    const refs = await loadMemberRefs(db, ctx.actor.workspaceId, [decision?.by]);
    const chars = v!.characterVersionIds.length
      ? await db
          .select({ name: characters.name, versionNo: characterVersions.versionNo })
          .from(characterVersions)
          .innerJoin(characters, eq(characters.id, characterVersions.characterId))
          .where(inArray(characterVersions.id, v!.characterVersionIds))
      : [];
    out.push({ content: c, projectName: p?.name ?? '', version: v!, files, approval: { by: decision?.by ? (refs.get(decision.by)?.displayName ?? null) : null, at: decision?.at.toISOString() ?? null }, characters: chars });
  }
  return out;
};

/** Add one entry and wait until the archiver consumed it (one storage stream open at a time). */
const appendAndWait = async (archive: ZipArchive, source: NodeJS.ReadableStream | Buffer, data: { name: string; store?: boolean; date?: Date }) => {
  const done = new Promise<void>((resolve, reject) => {
    const onEntry = (e: { name: string }) => {
      if (e.name === data.name) {
        archive.off('entry', onEntry);
        archive.off('error', onError);
        resolve();
      }
    };
    const onError = (err: Error) => {
      archive.off('entry', onEntry);
      reject(err);
    };
    archive.on('entry', onEntry);
    archive.on('error', onError);
  });
  archive.append(source as never, data);
  await done;
};

/**
 * Build the package without holding it in memory: files are streamed one by one from storage into
 * a ZIP written to a private temp file, uploaded, then the export row is marked Completed (7-day
 * TTL). Any refusal (revoked approval, lost access, restricted media) fails the export honestly —
 * a partial archive is never presented as Completed.
 */
defineJob(
  'content.package',
  'data',
  async ({ app, job, heartbeat, cancelled }) => {
    const { exportId } = job.payload as { exportId: string };
    const [r] = await app.db.select().from(exportJobs).where(eq(exportJobs.id, exportId));
    if (!r || (r.state !== 'queued' && r.state !== 'running')) return { skipped: r?.state ?? 'missing' };
    const ctx = await memberJobContext(app, r.workspaceId, r.requestedByMembershipId, { source: 'system' });
    if (!ctx) return failPackage(app, r, 'The requesting member no longer has access to this workspace.');
    if (!hasAnywhere(ctx.actor.access, 'exports.create')) return failPackage(app, r, 'Your access changed after the export was requested. Request it again.');
    const items = ((r.filters as { items?: PackageItem[] }).items ?? []) as PackageItem[];
    let parts: Awaited<ReturnType<typeof collect>>;
    try {
      parts = await collect(ctx, items);
    } catch (e) {
      if (e instanceof PackageRefusal) return failPackage(app, r, e.message);
      throw e;
    }
    await app.db.update(exportJobs).set({ state: 'running', progress: 1, updatedAt: app.clock.now() }).where(and(eq(exportJobs.id, r.id), eq(exportJobs.state, 'queued')));
    const bound = r.sourceBoundAt.toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
    const base = parts.length === 1 ? `${slug(parts[0]!.content.title)}-v${parts[0]!.version.versionNo}` : `episode-package-${(r.filters as { episodeId?: string }).episodeId?.slice(0, 8) ?? 'content'}`;
    const fileName = `${base}-${bound}.zip`;
    const tmp = join(tmpdir(), `castlane-package-${r.id}-${newId().slice(0, 8)}.zip`);
    const key = `exports/${r.workspaceId}/${r.id}/${fileName}`;
    const archive = new ZipArchive({ zlib: { level: 6 } });
    const output = createWriteStream(tmp, { mode: 0o600 });
    archive.pipe(output);
    let uploaded = false;
    try {
      const manifestFiles: Record<string, unknown>[] = [];
      const plan: { path: string; file: RawVersionFile }[] = [];
      for (const p of parts) {
        const dir = parts.length === 1 ? '' : `${slug(p.content.title)}-v${p.version.versionNo}/`;
        const used = new Set<string>();
        for (const f of p.files) {
          let name = `${dir}files/${f.slot}/${f.position + 1}-${f.fileName.replace(/[\\/]/g, '_')}`;
          while (used.has(name)) name = `${name}_`;
          used.add(name);
          plan.push({ path: name, file: f });
          manifestFiles.push({ path: name, contentItemId: p.content.id, versionNo: p.version.versionNo, slot: f.slot, slotLabel: slotLabel(f.slot), fileName: f.fileName, mime: f.mime, bytes: f.byteSize, sha256: f.checksumSha256, width: f.width, height: f.height, durationMs: f.durationMs });
        }
      }
      const manifest = {
        format: 'castlane-content-package',
        formatVersion: 1,
        generatedAt: app.clock.now().toISOString(),
        sourceBoundAt: r.sourceBoundAt.toISOString(),
        requestedBy: ctx.actor.displayName,
        items: parts.map((p) => ({
          contentItemId: p.content.id,
          title: p.content.title,
          project: p.projectName,
          format: p.content.format,
          language: p.content.language,
          versionId: p.version.id,
          versionNo: p.version.versionNo,
          submittedAt: p.version.submittedAt?.toISOString() ?? null,
          approvedAt: p.version.approvedAt?.toISOString() ?? null,
          approvedBy: p.approval.by,
          metadataPath: `${parts.length === 1 ? '' : `${slug(p.content.title)}-v${p.version.versionNo}/`}metadata.json`,
        })),
        files: manifestFiles,
        note: 'Files are the approved originals stored in Castlane. Nothing was published or sent anywhere by this export.',
      };
      await appendAndWait(archive, Buffer.from(JSON.stringify(manifest, null, 2)), { name: 'manifest.json', date: r.sourceBoundAt });
      for (const p of parts) {
        const dir = parts.length === 1 ? '' : `${slug(p.content.title)}-v${p.version.versionNo}/`;
        const brief = (p.version.briefSnapshot ?? {}) as BriefFields;
        const metadata = {
          title: p.content.title,
          project: p.projectName,
          format: p.content.format,
          language: p.content.language,
          tags: p.content.tags,
          version: { number: p.version.versionNo, note: p.version.note, fixesClaimed: p.version.fixesClaimed, submittedAt: p.version.submittedAt?.toISOString() ?? null, approvedAt: p.version.approvedAt?.toISOString() ?? null, approvedBy: p.approval.by },
          brief,
          characters: p.characters.map((ch) => ({ name: ch.name, profileVersion: ch.versionNo })),
          checklist: p.version.checklist,
        };
        await appendAndWait(archive, Buffer.from(JSON.stringify(metadata, null, 2)), { name: `${dir}metadata.json`, date: r.sourceBoundAt });
      }
      let n = 0;
      for (const item of plan) {
        if (await cancelled()) throw Object.assign(new Error('cancelled'), { cancelled: true });
        const [cur] = await app.db.select({ state: exportJobs.state }).from(exportJobs).where(eq(exportJobs.id, r.id));
        if (cur?.state !== 'running') throw Object.assign(new Error('cancelled'), { cancelled: true });
        const { stream } = await app.storage.getObjectStream(item.file.storageKey!);
        // Media is already compressed: store it; text files (subtitles, captions) are deflated.
        const compressible = /^(text\/|application\/(json|x-subrip))/.test(item.file.mime ?? '') || item.file.slot === 'subtitles' || item.file.slot === 'caption';
        await appendAndWait(archive, stream, { name: item.path, store: !compressible, date: r.sourceBoundAt });
        n++;
        const progress = Math.min(90, 5 + Math.floor((n / Math.max(1, plan.length)) * 85));
        await heartbeat(progress, `${n} of ${plan.length} files`);
        await app.db.update(exportJobs).set({ progress }).where(eq(exportJobs.id, r.id));
      }
      const closed = once(output, 'close');
      await archive.finalize();
      await closed;
      const stat = await fs.stat(tmp);
      await app.storage.putObject(key, createReadStream(tmp), { contentType: 'application/zip', contentLength: stat.size });
      uploaded = true;
      const now = app.clock.now();
      const done = await app.db
        .update(exportJobs)
        .set({ state: 'completed', storageKey: key, fileName, byteSize: stat.size, progress: 100, completedAt: now, expiresAt: new Date(now.getTime() + EXPORT_TTL_MS), errorMessage: null, updatedAt: now, rowVersion: sql`${exportJobs.rowVersion} + 1` })
        .where(and(eq(exportJobs.id, r.id), eq(exportJobs.state, 'running')))
        .returning({ id: exportJobs.id });
      if (!done.length) {
        await app.storage.deleteObject(key).catch(() => undefined);
        return { cancelled: true };
      }
      await streamEvent(app.db, { workspaceId: r.workspaceId, kind: 'entity_changed', entityType: 'export_job', entityId: r.id });
      return { files: plan.length, bytes: stat.size };
    } catch (e) {
      archive.abort();
      if (uploaded) await app.storage.deleteObject(key).catch(() => undefined);
      if ((e as { cancelled?: boolean }).cancelled) {
        await app.db.update(exportJobs).set({ state: 'cancelled', storageKey: null, updatedAt: app.clock.now() }).where(and(eq(exportJobs.id, r.id), inArray(exportJobs.state, ['queued', 'running', 'cancelled'])));
        return { cancelled: true };
      }
      app.logger.warn('content_package_failed', { exportId: r.id, error: (e as { code?: string }).code ?? (e as Error)?.name ?? 'Error' });
      return failPackage(app, r, 'The package could not be generated. No file was created; request it again.');
    } finally {
      output.destroy();
      await fs.rm(tmp, { force: true });
    }
  },
  { leaseSeconds: 1800 },
);

