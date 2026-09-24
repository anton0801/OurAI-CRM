import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { commentEndpoints, exportEndpoints, mediaEndpoints, teamEndpoints } from '@castlane/api-contracts';
import { EXPORT_DATASETS_REGISTRY, RESPONSIBILITY_PROVIDERS, getAppServices, memberJobContext } from '@castlane/application';
import { contentItems, episodes, exportJobs, reviews, seasons } from '@castlane/database';
import { newId } from '@castlane/domain';
import { runQueuedJobs } from '../../support';
import { C, R, contentInReview, db, getContent, member, newContent, prodFixture, review } from './helpers';

/** Minimal ZIP reader (central directory) for checking generated packages. */
const readZip = (buf: Buffer) => {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + compSize);
    out.set(name, method === 8 ? inflateRawSync(raw) : Buffer.from(raw));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
};

const streamToBuffer = async (s: NodeJS.ReadableStream) => {
  const chunks: Buffer[] = [];
  for await (const c of s) chunks.push(Buffer.from(c as Buffer));
  return Buffer.concat(chunks);
};

describe('content package export (§22.2)', () => {
  it('builds a ZIP with manifest.json, metadata and the approved files; download goes through the Export Center', async () => {
    const f = await prodFixture();
    const creator = await member(f, 'creator', { projects: [f.projectId] });
    const lead = await member(f, 'project_lead', { projects: [f.projectId] });
    const r = await contentInReview(creator.client, f, { ownerMembershipId: creator.membershipId, reviewerMembershipId: lead.membershipId, creator: f.owner });
    // Not approved yet → refused.
    expect((await lead.client.attempt(C.requestPackage, { params: { ...f.params, contentId: r.contentId }, body: {} })).status).toBe(409);
    await lead.client.call(R.approve, { params: { ...f.params, reviewId: r.reviewId }, body: { versionId: r.versionId } }, { ifMatch: (await review(lead.client, f, r.reviewId)).rowVersion });
    // Creators have no export permission.
    expect((await creator.client.attempt(C.requestPackage, { params: { ...f.params, contentId: r.contentId }, body: {} })).status).toBe(403);
    const job = await lead.client.call(C.requestPackage, { params: { ...f.params, contentId: r.contentId }, body: {} });
    expect(job).toMatchObject({ dataset: 'content_package', format: 'zip', state: 'queued' });
    await runQueuedJobs(['content.package']);
    const done = await lead.client.call(exportEndpoints.get, { params: { ...f.params, exportId: job.id } });
    expect(done.state).toBe('completed');
    expect(done.fileName).toMatch(/\.zip$/);
    const listed = await lead.client.call(C.packages, { params: { ...f.params, contentId: r.contentId } });
    expect(listed.map((j) => j.id)).toEqual([job.id]);
    const dl = await lead.client.call(exportEndpoints.download, { params: { ...f.params, exportId: job.id } });
    expect(dl.url).toContain(`/exports/${job.id}/file`);
    const [row] = await db().select().from(exportJobs).where(eq(exportJobs.id, job.id));
    const { stream } = await getAppServices().storage.getObjectStream(row!.storageKey!);
    const zip = readZip(await streamToBuffer(stream));
    const manifest = JSON.parse(zip.get('manifest.json')!.toString('utf8')) as { items: { versionNo: number; approvedBy: string | null }[]; files: { path: string; sha256: string; slot: string }[] };
    expect(manifest.items[0]).toMatchObject({ versionNo: 1 });
    expect(manifest.items[0]?.approvedBy).toBeTruthy();
    expect(manifest.files.length).toBe(1);
    expect(manifest.files[0]?.slot).toBe('main_image');
    const file = zip.get(manifest.files[0]!.path)!;
    const { createHash } = await import('node:crypto');
    expect(createHash('sha256').update(file).digest('hex')).toBe(manifest.files[0]!.sha256);
    const meta = JSON.parse(zip.get('metadata.json')!.toString('utf8')) as { brief: { summary?: string } };
    expect(meta.brief.summary).toBeTruthy();
  });

  it('fails honestly when the approval is revoked before generation; episode packages include approved items only', async () => {
    const f = await prodFixture();
    const creator = await member(f, 'creator', { projects: [f.projectId] });
    const lead = await member(f, 'project_lead', { projects: [f.projectId] });
    const r = await contentInReview(creator.client, f, { ownerMembershipId: creator.membershipId, reviewerMembershipId: lead.membershipId, creator: f.owner });
    await lead.client.call(R.approve, { params: { ...f.params, reviewId: r.reviewId }, body: { versionId: r.versionId } }, { ifMatch: (await review(lead.client, f, r.reviewId)).rowVersion });
    const job = await lead.client.call(C.requestPackage, { params: { ...f.params, contentId: r.contentId }, body: {} });
    await lead.client.call(R.revoke, { params: { ...f.params, reviewId: r.reviewId }, body: { reason: 'Wrong music licence' } }, { ifMatch: (await review(lead.client, f, r.reviewId)).rowVersion });
    await runQueuedJobs(['content.package']);
    const failed = await lead.client.call(exportEndpoints.get, { params: { ...f.params, exportId: job.id } });
    expect(failed.state).toBe('failed');
    expect(failed.errorMessage).toMatch(/revoked/);
    expect(failed.fileName).toBeNull();
    // Episode package.
    const seasonId = newId();
    await db().insert(seasons).values({ id: seasonId, workspaceId: f.ws.workspaceId, projectId: f.projectId, name: 'Season 1', orderNo: 1 });
    const episodeId = newId();
    await db().insert(episodes).values({ id: episodeId, workspaceId: f.ws.workspaceId, projectId: f.projectId, seasonId, number: 1, title: 'Pilot' });
    const empty = await lead.client.attempt(C.requestEpisodePackage, { params: { ...f.params, episodeId }, body: {} });
    expect(empty.status).toBe(409);
    const r2 = await contentInReview(creator.client, f, { ownerMembershipId: creator.membershipId, reviewerMembershipId: lead.membershipId, creator: f.owner });
    await db().update(contentItems).set({ episodeId }).where(eq(contentItems.id, r2.contentId));
    await lead.client.call(R.approve, { params: { ...f.params, reviewId: r2.reviewId }, body: { versionId: r2.versionId } }, { ifMatch: (await review(lead.client, f, r2.reviewId)).rowVersion });
    const epContent = await lead.client.call(C.episodeContent, { params: { ...f.params, episodeId } });
    expect(epContent.items.map((i) => i.id)).toEqual([r2.contentId]);
    expect(epContent.approvedCount).toBe(1);
    const ep = await lead.client.call(C.requestEpisodePackage, { params: { ...f.params, episodeId }, body: {} });
    await runQueuedJobs(['content.package']);
    expect((await lead.client.call(exportEndpoints.get, { params: { ...f.params, exportId: ep.id } })).state).toBe('completed');
  });
});

describe('production registries', () => {
  it('version files are readable through the content (link access) and downloadable with assets.download', async () => {
    const f = await prodFixture();
    const creator = await member(f, 'creator', { projects: [f.projectId] });
    const lead = await member(f, 'project_lead', { projects: [f.projectId] });
    const r = await contentInReview(creator.client, f, { ownerMembershipId: creator.membershipId, reviewerMembershipId: lead.membershipId, creator: f.owner });
    const files = await lead.client.call(mediaEndpoints.entityFiles, { params: { ...f.params, entityType: 'content_version', entityId: r.versionId } });
    expect(files.map((x) => x.id)).toEqual([r.assetId]);
    const outsider = await member(f, 'project_lead', { projects: [f.otherProjectId] });
    expect((await outsider.client.attempt(mediaEndpoints.entityFiles, { params: { ...f.params, entityType: 'content_version', entityId: r.versionId } })).status).toBe(404);
    expect((await outsider.client.attempt(mediaEndpoints.get, { params: { ...f.params, assetId: r.assetId } })).status).toBe(404);
  });

  it('review-level comments bind to the reviewed version', async () => {
    const f = await prodFixture();
    const creator = await member(f, 'creator', { projects: [f.projectId] });
    const lead = await member(f, 'project_lead', { projects: [f.projectId] });
    const r = await contentInReview(creator.client, f, { ownerMembershipId: creator.membershipId, reviewerMembershipId: lead.membershipId, creator: f.owner });
    const c = await lead.client.call(commentEndpoints.create, { params: f.params, body: { parentType: 'review', parentId: r.reviewId, body: 'Blocking: colour grade', severity: 'blocking' } });
    expect(c.targetVersionId).toBe(r.versionId);
    expect((await review(lead.client, f, r.reviewId)).openBlocking).toBe(1);
  });

  it('responsibility providers list owned content and pending reviews and transfer them to eligible successors (F12)', async () => {
    const f = await prodFixture();
    const creator = await member(f, 'creator', { projects: [f.projectId] });
    const lead = await member(f, 'project_lead', { projects: [f.projectId] });
    const lead2 = await member(f, 'project_lead', { projects: [f.projectId] });
    const outsider = await member(f, 'project_lead', { projects: [f.otherProjectId] });
    const r = await contentInReview(creator.client, f, { ownerMembershipId: creator.membershipId, reviewerMembershipId: lead.membershipId, creator: f.owner });
    const reviewerProvider = RESPONSIBILITY_PROVIDERS.get('content.reviewer')!;
    const ownerProvider = RESPONSIBILITY_PROVIDERS.get('content.owner')!;
    const ctx = (await memberJobContext(getAppServices(), f.ws.workspaceId, f.ws.owner.membershipId))!;
    const items = await reviewerProvider.list(ctx, lead.membershipId);
    expect(items.find((i) => i.entityType === 'review')).toMatchObject({ entityId: r.reviewId, requiresSuccessor: true });
    expect((await ownerProvider.list(ctx, creator.membershipId)).map((i) => i.entityId)).toEqual([r.contentId]);
    // Transfer through the team module's deactivation flow.
    const preview = await f.owner.attempt(teamEndpoints.deactivationPreview, { params: { ...f.params, membershipId: lead.membershipId }, body: { resolutions: [] } });
    expect(preview.status).toBe(200);
    const { executeCommand } = await import('@castlane/application');
    const bad = await executeCommand(ctx, (c) => reviewerProvider.transfer(c, lead.membershipId, [{ entityId: r.reviewId, successorMembershipId: outsider.membershipId }])).catch((e) => e);
    expect(bad.code).toBe('VALIDATION_FAILED');
    await executeCommand(ctx, (c) => reviewerProvider.transfer(c, lead.membershipId, [{ entityId: r.reviewId, successorMembershipId: lead2.membershipId }, { entityId: r.contentId, successorMembershipId: lead2.membershipId }]));
    const [rev] = await db().select().from(reviews).where(eq(reviews.id, r.reviewId));
    expect(rev!.reviewerMembershipId).toBe(lead2.membershipId);
    expect((await getContent(f.owner, f, r.contentId)).reviewer?.membershipId).toBe(lead2.membershipId);
    await executeCommand(ctx, (c) => ownerProvider.transfer(c, creator.membershipId, [{ entityId: r.contentId, successorMembershipId: null }]));
    expect((await getContent(f.owner, f, r.contentId)).owner?.membershipId).toBe(f.ws.owner.membershipId);
  });

  it('export dataset yields permitted rows as of the boundary (unknown stays empty)', async () => {
    const f = await prodFixture();
    const outsider = await member(f, 'creator', { projects: [f.otherProjectId] });
    await newContent(f.owner, f, { title: 'Exported item', dueAt: '2027-01-01T10:00:00Z' });
    const ds = EXPORT_DATASETS_REGISTRY.get('content_items')!;
    const ownerCtx = (await memberJobContext(getAppServices(), f.ws.workspaceId, f.ws.owner.membershipId))!;
    const rows: Record<string, unknown>[] = [];
    for await (const row of ds.rows(ownerCtx, { filters: {}, boundAt: new Date(Date.now() + 1000), fields: [] })) rows.push(row);
    expect(rows.map((x) => x.title)).toEqual(['Exported item']);
    expect(rows[0]).toMatchObject({ stage: 'idea', approved_version: null, publication_count: 0 });
    const before: unknown[] = [];
    for await (const row of ds.rows(ownerCtx, { filters: {}, boundAt: new Date(Date.now() - 3_600_000), fields: [] })) before.push(row);
    expect(before).toEqual([]);
    const outCtx = (await memberJobContext(getAppServices(), f.ws.workspaceId, outsider.membershipId))!;
    const none: unknown[] = [];
    for await (const row of ds.rows(outCtx, { filters: {}, boundAt: new Date(Date.now() + 1000), fields: [] })) none.push(row);
    expect(none).toEqual([]);
    const listed = await f.owner.call(exportEndpoints.datasets, { params: f.params });
    expect(listed.map((d) => d.key)).toContain('content_items');
    void and;
  });
});
