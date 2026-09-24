import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { mediaEndpoints } from '@castlane/api-contracts';
import { getAppServices } from '@castlane/application';
import { assetVersions, workspaces } from '@castlane/database';
import { addMember, clientFor, createProject, createWorkspace, runQueuedJobs, sessionFor, TestClient } from '../../support';

const db = () => getAppServices().db;

const png = () => sharp({ create: { width: 600, height: 400, channels: 3, background: '#176B50' } }).png().toBuffer();

const putParts = async (c: TestClient, parts: { url: string }[], body: Buffer, partSize: number) => {
  const etags: { partNumber: number; etag: string }[] = [];
  for (let i = 0; i < parts.length; i++) {
    const chunk = body.subarray(i * partSize, (i + 1) * partSize);
    const res = await fetchLocal(c, parts[i]!.url, chunk);
    etags.push({ partNumber: i + 1, etag: res.headers.get('etag')! });
  }
  return etags;
};

// The filesystem driver's signed part URL is served by a dedicated route handler.
const fetchLocal = async (_c: TestClient, url: string, body: Buffer) => {
  const { PUT } = await import('@/../app/api/v1/storage/fs/part/route');
  return PUT(new Request(url, { method: 'PUT', body, duplex: 'half' } as RequestInit));
};

describe('upload pipeline (section 14)', () => {
  it('uploads to quarantine, verifies, stores and makes the version available with derivatives', async () => {
    const ws = await createWorkspace(db());
    const c = await clientFor(await sessionFor(db(), ws.owner.userId));
    const body = await png();
    const init = await c.call(mediaEndpoints.initiateUpload, {
      params: { workspaceId: ws.workspaceId },
      body: { filename: 'cover.png', mimeType: 'image/png', byteSize: body.length, purpose: 'cover' },
    });
    const etags = await putParts(c, init.parts, body, init.partSize);
    const done = await c.call(mediaEndpoints.completeUpload, { params: { workspaceId: ws.workspaceId, uploadId: init.uploadId }, body: { parts: etags } });
    expect(done.status).toBe('checking');
    // Replayed completion is harmless (idempotent) — T075.
    const again = await c.call(mediaEndpoints.completeUpload, { params: { workspaceId: ws.workspaceId, uploadId: init.uploadId }, body: { parts: etags } });
    expect(again.assetVersionId).toBe(done.assetVersionId);
    await runQueuedJobs(['media.process']);
    const asset = await c.call(mediaEndpoints.get, { params: { workspaceId: ws.workspaceId, assetId: init.assetId } });
    expect(asset.currentVersion?.status).toBe('available');
    expect(asset.currentVersion?.mime).toBe('image/png');
    expect(asset.currentVersion?.width).toBe(600);
    expect(asset.thumbnailUrl).toBeTruthy();
    const [w] = await db().select().from(workspaces).where(eq(workspaces.id, ws.workspaceId));
    expect(w!.storageReservedBytes).toBe(0n);
    expect(w!.storageUsedBytes).toBe(BigInt(body.length));
    const dl = await c.call(mediaEndpoints.download, { params: { workspaceId: ws.workspaceId, assetId: init.assetId }, body: {} });
    expect(dl.mode).toBe('proxy');
  });

  it('rejects a file whose content does not match an allowed type (T073)', async () => {
    const ws = await createWorkspace(db());
    const c = await clientFor(await sessionFor(db(), ws.owner.userId));
    const body = Buffer.from('MZ\x90\x00 this is not an image at all, it pretends to be one'.repeat(20));
    const init = await c.call(mediaEndpoints.initiateUpload, {
      params: { workspaceId: ws.workspaceId },
      body: { filename: 'photo.jpg', mimeType: 'image/jpeg', byteSize: body.length, purpose: 'content' },
    });
    const etags = await putParts(c, init.parts, body, init.partSize);
    await c.call(mediaEndpoints.completeUpload, { params: { workspaceId: ws.workspaceId, uploadId: init.uploadId }, body: { parts: etags } });
    await runQueuedJobs(['media.process']);
    const [v] = await db().select().from(assetVersions).where(eq(assetVersions.id, init.assetVersionId));
    expect(v!.status).toBe('rejected');
    expect(v!.storageKey).toBeNull();
    const dl = await c.attempt(mediaEndpoints.download, { params: { workspaceId: ws.workspaceId, assetId: init.assetId }, body: {} });
    expect(dl.status).toBe(409);
    const [w] = await db().select().from(workspaces).where(eq(workspaces.id, ws.workspaceId));
    expect(w!.storageReservedBytes).toBe(0n);
  });

  it('concurrent reservations cannot exceed the quota (T076)', async () => {
    const ws = await createWorkspace(db());
    await db().update(workspaces).set({ settings: { fileQuotaBytes: '1000' } }).where(eq(workspaces.id, ws.workspaceId));
    const c = await clientFor(await sessionFor(db(), ws.owner.userId));
    const attempt = () =>
      c.attempt(mediaEndpoints.initiateUpload, { params: { workspaceId: ws.workspaceId }, body: { filename: 'a.png', mimeType: 'image/png', byteSize: 600, purpose: 'content' } });
    const [a, b] = await Promise.all([attempt(), attempt()]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect([a.code, b.code]).toContain('QUOTA_EXCEEDED');
  });

  it('a member without project access cannot see or download another project’s file (T078)', async () => {
    const ws = await createWorkspace(db());
    const p = await createProject(db(), ws, {});
    const owner = await clientFor(await sessionFor(db(), ws.owner.userId));
    const body = await png();
    const init = await owner.call(mediaEndpoints.initiateUpload, {
      params: { workspaceId: ws.workspaceId },
      body: { filename: 'x.png', mimeType: 'image/png', byteSize: body.length, purpose: 'content', projectId: p.id },
    });
    await owner.call(mediaEndpoints.completeUpload, { params: { workspaceId: ws.workspaceId, uploadId: init.uploadId }, body: { parts: await putParts(owner, init.parts, body, init.partSize) } });
    await runQueuedJobs(['media.process']);
    const creator = await addMember(db(), ws, { roleKey: 'creator', scopeType: 'assigned_projects' });
    const c = await clientFor(await sessionFor(db(), creator.userId));
    expect((await c.attempt(mediaEndpoints.get, { params: { workspaceId: ws.workspaceId, assetId: init.assetId } })).status).toBe(404);
    expect((await c.attempt(mediaEndpoints.download, { params: { workspaceId: ws.workspaceId, assetId: init.assetId }, body: {} })).status).toBe(404);
  });
});
