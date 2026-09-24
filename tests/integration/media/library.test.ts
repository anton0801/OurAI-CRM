import { afterEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { folderEndpoints as F, lookupEndpoints, mediaEndpoints as M, shellEndpoints } from '@castlane/api-contracts';
import { ARCHIVE_HANDLERS, EXPORT_DATASETS_REGISTRY, enqueueJob, getAppServices, memberJobContext, setAppServices } from '@castlane/application';
import { assetLinks, assets, assetVersions, jobs, memberships, roleAssignments, roles, uploadSessions, workspaces } from '@castlane/database';
import { newId } from '@castlane/domain';
import { addMember, assignToProject, clientFor, createProject, createWorkspace, resetClock, runQueuedJobs, sessionFor, setClock } from '../../support';
import { db, png, putParts, uploadFile } from './helpers';

const setup = async () => {
  const ws = await createWorkspace(db());
  const owner = await clientFor(await sessionFor(db(), ws.owner.userId));
  return { ws, w: ws.workspaceId, owner };
};

const member = async (ws: Awaited<ReturnType<typeof createWorkspace>>, roleKey: string, scopeType: 'workspace' | 'assigned_projects' = 'workspace') => {
  const m = await addMember(db(), ws, { roleKey, scopeType });
  return { ...m, c: await clientFor(await sessionFor(db(), m.userId)) };
};

/** A custom role holding restricted-media access for assigned projects. */
const restrictedRole = async (workspaceId: string) => {
  const at = new Date();
  await db()
    .insert(roles)
    .values({
      id: newId(),
      workspaceId,
      key: 'restricted_media',
      name: 'Restricted Media Reviewer',
      permissions: ['assets.read', 'assets.download', 'assets.upload', 'assets.restricted.read', 'projects.read'],
      defaultScopeType: 'assigned_projects',
      createdAt: at,
      updatedAt: at,
    })
    .onConflictDoNothing();
};

afterEach(() => resetClock());

/** First field error of a failed attempt. */
const firstFieldError = (r: { error: { fieldErrors?: unknown } | null }) => (r.error?.fieldErrors as { field: string; code: string; message: string }[] | undefined)?.[0];

describe('folders (S36): tree, uniqueness, move rules, archive', () => {
  it('builds a tree, refuses duplicate names, cycles and nesting beyond six levels', async () => {
    const { w, owner } = await setup();
    const root = await owner.call(F.create, { params: { workspaceId: w }, body: { name: 'Brand' } });
    expect(root).toMatchObject({ depth: 0, projectId: null, path: [{ id: root.id, name: 'Brand' }] });
    const dup = await owner.attempt(F.create, { params: { workspaceId: w }, body: { name: 'brand' } });
    expect(dup.status).toBe(422);
    expect(firstFieldError(dup)).toMatchObject({ field: 'name', code: 'DUPLICATE' });
    let parent = root;
    const chain = [root];
    for (let i = 1; i <= 5; i++) {
      parent = await owner.call(F.create, { params: { workspaceId: w }, body: { name: `Level ${i}`, parentId: parent.id } });
      chain.push(parent);
    }
    expect(parent.depth).toBe(5);
    expect(parent.path).toHaveLength(6);
    const tooDeep = await owner.attempt(F.create, { params: { workspaceId: w }, body: { name: 'Level 6', parentId: parent.id } });
    expect(tooDeep.status).toBe(422);
    const cycle = await owner.attempt(F.move, { params: { workspaceId: w, folderId: root.id }, body: { parentId: chain[3]!.id } }, { ifMatch: root.rowVersion });
    expect(cycle.status).toBe(422);
    expect(firstFieldError(cycle)).toMatchObject({ code: 'CYCLE' });
    // Moving "Level 3" (height 2) to the root re-computes the depth of its subtree.
    const moved = await owner.call(F.move, { params: { workspaceId: w, folderId: chain[3]!.id }, body: { parentId: null } }, { ifMatch: chain[3]!.rowVersion });
    expect(moved.depth).toBe(0);
    const tree = await owner.call(F.list, { params: { workspaceId: w }, query: {} });
    expect(tree.find((f) => f.id === chain[5]!.id)?.depth).toBe(2);
    const stale = await owner.attempt(F.update, { params: { workspaceId: w, folderId: chain[3]!.id }, body: { name: 'Renamed' } }, { ifMatch: chain[3]!.rowVersion });
    expect(stale.status).toBe(412);
  });

  it('archiving needs an empty folder; archived folders can be restored', async () => {
    const { w, owner } = await setup();
    const f = await owner.call(F.create, { params: { workspaceId: w }, body: { name: 'Old campaign' } });
    const init = await uploadFile(owner, w, await png(), { folderId: f.id });
    const preview = await owner.call(F.archivePreview, { params: { workspaceId: w, folderId: f.id } });
    expect(preview.items).toEqual([expect.objectContaining({ kind: 'files', count: 1, blocking: true })]);
    const blocked = await owner.attempt(F.archive, { params: { workspaceId: w, folderId: f.id }, body: {} }, { ifMatch: f.rowVersion });
    expect(blocked.status).toBe(409);
    const a = await owner.call(M.get, { params: { workspaceId: w, assetId: init.assetId } });
    await owner.call(M.update, { params: { workspaceId: w, assetId: a.id }, body: { folderId: null } }, { ifMatch: a.rowVersion });
    const archived = await owner.call(F.archive, { params: { workspaceId: w, folderId: f.id }, body: { reason: 'Campaign ended' } }, { ifMatch: f.rowVersion });
    expect(archived.archivedAt).not.toBeNull();
    expect((await owner.call(F.list, { params: { workspaceId: w }, query: {} })).map((x) => x.id)).not.toContain(f.id);
    // The generic Archive screen uses the same handler.
    expect(ARCHIVE_HANDLERS.get('folder')?.label).toBe('Folder');
    const restored = await owner.call(F.restore, { params: { workspaceId: w, folderId: f.id }, body: {} }, { ifMatch: archived.rowVersion });
    expect(restored.archivedAt).toBeNull();
  });

  it('project folders are visible only in the project scope; subfolders keep the project', async () => {
    const { ws, w, owner } = await setup();
    const p1 = await createProject(db(), ws, {});
    const p2 = await createProject(db(), ws, {});
    const creator = await member(ws, 'creator', 'assigned_projects');
    await assignToProject(db(), ws, p1.id, creator.membershipId);
    const f1 = await owner.call(F.create, { params: { workspaceId: w }, body: { name: 'P1 files', projectId: p1.id } });
    const f2 = await owner.call(F.create, { params: { workspaceId: w }, body: { name: 'P2 files', projectId: p2.id } });
    const shared = await owner.call(F.create, { params: { workspaceId: w }, body: { name: 'Shared' } });
    const sub = await owner.call(F.create, { params: { workspaceId: w }, body: { name: 'Sub', parentId: f1.id } });
    expect(sub.projectId).toBe(p1.id);
    const mismatch = await owner.attempt(F.create, { params: { workspaceId: w }, body: { name: 'X', parentId: f1.id, projectId: p2.id } });
    expect(mismatch.status).toBe(422);
    const cross = await owner.attempt(F.move, { params: { workspaceId: w, folderId: sub.id }, body: { parentId: f2.id } }, { ifMatch: sub.rowVersion });
    expect(cross.status).toBe(422);

    const seen = await creator.c.call(F.list, { params: { workspaceId: w }, query: {} });
    expect(seen.map((f) => f.name).sort()).toEqual(['P1 files', 'Shared', 'Sub']);
    expect((await creator.c.attempt(F.get, { params: { workspaceId: w, folderId: f2.id } })).status).toBe(404);
    // Creators cannot create workspace folders (no workspace-wide upload grant).
    expect((await creator.c.attempt(F.create, { params: { workspaceId: w }, body: { name: 'Mine' } })).status).toBe(403);
    expect(shared.permissions.create).toBe(true);
    const picker = await creator.c.call(lookupEndpoints.search, { params: { workspaceId: w, type: 'folder' }, query: { q: 'files' } });
    expect(picker.items.map((i) => i.label)).toEqual(['P1 files']);
  });
});

describe('library listing, filters and scope', () => {
  it('filters by kind, tag, status, folder, uploader and text within the member scope', async () => {
    const { ws, w, owner } = await setup();
    const p1 = await createProject(db(), ws, {});
    const p2 = await createProject(db(), ws, {});
    const creator = await member(ws, 'creator', 'assigned_projects');
    await assignToProject(db(), ws, p1.id, creator.membershipId);
    const folder = await owner.call(F.create, { params: { workspaceId: w }, body: { name: 'Covers', projectId: p1.id } });
    const a1 = await uploadFile(owner, w, await png(), { filename: 'hero-cover.png', folderId: folder.id });
    await uploadFile(owner, w, await png(300, 200), { filename: 'other.png', projectId: p2.id });
    const ext = await owner.call(M.externalLink, { params: { workspaceId: w }, body: { url: 'https://drive.example.com/file/123', title: 'Raw footage (Drive)', projectId: p1.id, tags: ['Footage'] } });
    const a1v = await owner.call(M.get, { params: { workspaceId: w, assetId: a1.assetId } });
    expect(a1v.projectId).toBe(p1.id); // a project folder gives its project to new files
    await owner.call(M.update, { params: { workspaceId: w, assetId: a1.assetId }, body: { tags: ['Hero', 'Cover'], description: 'Season 1 key art' } }, { ifMatch: a1v.rowVersion });

    const list = (query: Record<string, unknown>, c = owner) => c.call(M.list, { params: { workspaceId: w }, query: query as never });
    expect((await list({ kind: ['external_link'] })).items.map((i) => i.id)).toEqual([ext.id]);
    expect((await list({ status: ['external'] })).items.map((i) => i.id)).toEqual([ext.id]);
    expect((await list({ status: ['available'], projectId: p1.id })).items.map((i) => i.id)).toEqual([a1.assetId]);
    expect((await list({ tag: ['hero'] })).items.map((i) => i.id)).toEqual([a1.assetId]);
    expect((await list({ q: 'key art' })).items.map((i) => i.id)).toEqual([a1.assetId]);
    expect((await list({ folderId: folder.id })).items.map((i) => i.id)).toEqual([a1.assetId]);
    expect((await list({ uploaderMembershipId: ws.owner.membershipId })).items).toHaveLength(3);
    const byName = await list({ sort: 'name', direction: 'asc' });
    expect(byName.items.map((i) => i.name)).toEqual(['hero-cover.png', 'other.png', 'Raw footage (Drive)']);
    const paged = await list({ pageSize: 2, sort: 'name', direction: 'asc' });
    const next = await list({ pageSize: 2, sort: 'name', direction: 'asc', cursor: paged.nextCursor });
    expect([...paged.items, ...next.items].map((i) => i.name)).toEqual(byName.items.map((i) => i.name));

    const seen = await list({}, creator.c);
    expect(seen.items.map((i) => i.id).sort()).toEqual([a1.assetId, ext.id].sort());
    expect(seen.items.find((i) => i.id === a1.assetId)?.usageCount).toBe(0);
  });

  it('shows an external link honestly: metadata only, no download, no preview (T081)', async () => {
    const { w, owner } = await setup();
    const ext = await owner.call(M.externalLink, { params: { workspaceId: w }, body: { url: 'https://unreachable.invalid/video.mp4', title: 'Partner video' } });
    expect(ext).toMatchObject({ kind: 'external_link', currentVersion: null, thumbnailUrl: null, canDownload: false, externalUrl: 'https://unreachable.invalid/video.mp4' });
    const dl = await owner.attempt(M.download, { params: { workspaceId: w, assetId: ext.id }, body: {} });
    expect(dl.status).toBe(409);
    expect(dl.error?.message).toMatch(/external link/i);
    const newVersion = await owner.attempt(M.initiateUpload, { params: { workspaceId: w }, body: { filename: 'x.png', mimeType: 'image/png', byteSize: 10, purpose: 'content', assetId: ext.id } });
    expect(newVersion.status).toBe(409);
    const unsafe = await owner.attempt(M.externalLink, { params: { workspaceId: w }, body: { url: 'javascript:alert(1)', title: 'Bad' } });
    expect(unsafe.status).toBe(422);
    const detail = await owner.call(M.get, { params: { workspaceId: w, assetId: ext.id } });
    expect(detail.versions).toHaveLength(0);
    expect(detail.permissions.upload).toBe(false);
  });

  it('offers reuse of an identical readable file without disclosing others', async () => {
    const { ws, w, owner } = await setup();
    const p1 = await createProject(db(), ws, {});
    const body = await png(128, 128, '#123456');
    const first = await uploadFile(owner, w, body, { projectId: p1.id });
    const [v] = await db().select().from(assetVersions).where(eq(assetVersions.id, first.assetVersionId));
    const dups = await owner.call(M.duplicates, { params: { workspaceId: w }, query: { checksum: v!.checksumSha256! } });
    expect(dups.map((d) => d.assetId)).toEqual([first.assetId]);
    const outsider = await member(ws, 'creator', 'assigned_projects');
    expect(await outsider.c.call(M.duplicates, { params: { workspaceId: w }, query: { checksum: v!.checksumSha256! } })).toEqual([]);
  });

  it('links files to entities, lists them per entity and never removes holding links', async () => {
    const { ws, w, owner } = await setup();
    const p = await createProject(db(), ws, {});
    const init = await uploadFile(owner, w, await png(), { projectId: p.id });
    expect((await owner.call(M.linkTargets, { params: { workspaceId: w } }))).toEqual(expect.arrayContaining(['article', 'project']));
    const { linkId } = await owner.call(M.link, { params: { workspaceId: w, assetId: init.assetId }, body: { target: { entityType: 'project', entityId: p.id } } });
    const again = await owner.call(M.link, { params: { workspaceId: w, assetId: init.assetId }, body: { target: { entityType: 'project', entityId: p.id } } });
    expect(again.linkId).toBe(linkId);
    const files = await owner.call(M.entityFiles, { params: { workspaceId: w, entityType: 'project', entityId: p.id } });
    expect(files.map((f) => f.linkId)).toEqual([linkId]);
    const detail = await owner.call(M.get, { params: { workspaceId: w, assetId: init.assetId } });
    expect(detail.usage[0]).toMatchObject({ entityType: 'project', entityId: p.id, holding: false });
    await db().update(assetLinks).set({ holding: true }).where(eq(assetLinks.id, linkId));
    expect((await owner.attempt(M.removeLink, { params: { workspaceId: w, linkId }, body: {} })).status).toBe(409);
    await db().update(assetLinks).set({ holding: false }).where(eq(assetLinks.id, linkId));
    await owner.call(M.removeLink, { params: { workspaceId: w, linkId }, body: { reason: 'Wrong project' } });
    expect(await owner.call(M.entityFiles, { params: { workspaceId: w, entityType: 'project', entityId: p.id } })).toHaveLength(0);
    const outsider = await member(ws, 'creator', 'assigned_projects');
    expect((await outsider.c.attempt(M.entityFiles, { params: { workspaceId: w, entityType: 'project', entityId: p.id } })).status).toBe(404);
    const activity = await owner.call(M.activity, { params: { workspaceId: w, assetId: init.assetId }, query: {} });
    expect(activity.items.map((i) => i.action)).toEqual(expect.arrayContaining(['asset.linked', 'asset.link_removed', 'upload.completed']));
  });
});

describe('restricted media (§6, T078, T079)', () => {
  it('restricted files are invisible without restricted access: list, detail, thumbnail, search, export (T078)', async () => {
    const { ws, w, owner } = await setup();
    const p = await createProject(db(), ws, {});
    const lead = await member(ws, 'project_lead', 'assigned_projects');
    await assignToProject(db(), ws, p.id, lead.membershipId);
    const normal = await uploadFile(owner, w, await png(), { projectId: p.id, filename: 'teaser.png' });
    const secret = await uploadFile(owner, w, await png(200, 200), { projectId: p.id, filename: 'private-set.png', sensitivity: 'restricted' });

    const ownerView = await owner.call(M.get, { params: { workspaceId: w, assetId: secret.assetId } });
    expect(ownerView).toMatchObject({ sensitivity: 'restricted', restrictedHidden: true, thumbnailUrl: null, canReveal: true });

    const list = await lead.c.call(M.list, { params: { workspaceId: w }, query: {} });
    expect(list.items.map((i) => i.id)).toEqual([normal.assetId]);
    expect((await lead.c.attempt(M.get, { params: { workspaceId: w, assetId: secret.assetId } })).status).toBe(404);
    expect((await lead.c.attempt(M.download, { params: { workspaceId: w, assetId: secret.assetId }, body: {} })).status).toBe(404);
    const thumb = await lead.c.raw('GET', `/workspaces/${w}/assets/${secret.assetId}/thumbnail?size=256&reveal=true`);
    expect(thumb.status).toBe(404);
    // Even the owner gets no thumbnail without an explicit reveal.
    expect((await owner.raw('GET', `/workspaces/${w}/assets/${secret.assetId}/thumbnail?size=256`)).status).toBe(404);
    expect((await owner.raw('GET', `/workspaces/${w}/assets/${secret.assetId}/thumbnail?size=256&reveal=true`)).status).toBe(200);
    const search = await owner.call(shellEndpoints.search, { params: { workspaceId: w }, query: { q: 'private-set', types: 'asset' } });
    expect(search.results).toHaveLength(0);
    const ctx = (await memberJobContext(getAppServices(), w, lead.membershipId))!;
    const rows: unknown[] = [];
    for await (const r of EXPORT_DATASETS_REGISTRY.get('assets.inventory')!.rows(ctx, { filters: {}, boundAt: new Date(), fields: [] })) rows.push(r);
    expect(rows.map((r) => (r as { id: string }).id)).toEqual([normal.assetId]);
    // Only restricted-media members may make a file restricted.
    const n = await lead.c.call(M.get, { params: { workspaceId: w, assetId: normal.assetId } });
    expect((await lead.c.attempt(M.update, { params: { workspaceId: w, assetId: n.id }, body: { sensitivity: 'restricted' } }, { ifMatch: n.rowVersion })).status).toBe(403);
  });

  it('revoking restricted access stops new reads through the proxy immediately (T079)', async () => {
    const { ws, w, owner } = await setup();
    await restrictedRole(w);
    const p = await createProject(db(), ws, {});
    const reviewer = await member(ws, 'restricted_media', 'assigned_projects');
    await assignToProject(db(), ws, p.id, reviewer.membershipId);
    const secret = await uploadFile(owner, w, await png(), { projectId: p.id, sensitivity: 'restricted' });
    const dl = await reviewer.c.call(M.download, { params: { workspaceId: w, assetId: secret.assetId }, body: {} });
    expect(dl.mode).toBe('proxy'); // restricted media never gets a presigned object URL
    const first = await reviewer.c.fetch(dl.url);
    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toContain('no-store');

    await db().update(roleAssignments).set({ revokedAt: new Date() }).where(eq(roleAssignments.membershipId, reviewer.membershipId));
    await db().update(memberships).set({ accessRevision: sql`${memberships.accessRevision} + 1` }).where(eq(memberships.id, reviewer.membershipId));
    const afterRevoke = await reviewer.c.fetch(dl.url);
    expect(afterRevoke.status).toBe(404);
    expect((await reviewer.c.attempt(M.download, { params: { workspaceId: w, assetId: secret.assetId }, body: {} })).status).toBeGreaterThanOrEqual(403);
  });
});

describe('versions (S37): new version, delete guard for referenced versions (T080), purge', () => {
  it('refuses to delete a referenced version, offers archive, keeps the historical file; unreferenced versions are purged later', async () => {
    const { ws, w, owner } = await setup();
    const p = await createProject(db(), ws, {});
    const v1 = await uploadFile(owner, w, await png(), { projectId: p.id, filename: 'episode-cover.png' });
    const v2 = await uploadFile(owner, w, await png(640, 360, '#aa3344'), { assetId: v1.assetId, filename: 'episode-cover-v2.png', note: 'Brighter' });
    const detail = await owner.call(M.get, { params: { workspaceId: w, assetId: v1.assetId } });
    expect(detail.versions.map((v) => [v.versionNo, v.isCurrent])).toEqual([
      [2, true],
      [1, false],
    ]);
    // v1 is held by an approved/published record.
    await db().insert(assetLinks).values({ id: newId(), workspaceId: w, assetId: v1.assetId, assetVersionId: v1.assetVersionId, entityType: 'project', entityId: p.id, role: 'approved_cover', projectId: p.id, holding: true });
    const preview = await owner.call(M.versionDeletePreview, { params: { workspaceId: w, assetId: v1.assetId, versionId: v1.assetVersionId } });
    expect(preview).toMatchObject({ deletable: false, versionNo: 1 });
    expect(preview.items[0]).toMatchObject({ kind: 'holding_links', blocking: true });
    expect(preview.suggestion).toMatch(/Archive/);
    const refused = await owner.attempt(M.deleteVersion, { params: { workspaceId: w, assetId: v1.assetId, versionId: v1.assetVersionId }, body: { reason: 'Old cover' } }, { ifMatch: detail.rowVersion });
    expect(refused.status).toBe(409);

    // Archive instead: hidden from browse, the historical version stays downloadable.
    const archived = await owner.call(M.archive, { params: { workspaceId: w, assetId: v1.assetId }, body: { reason: 'Replaced' } }, { ifMatch: detail.rowVersion });
    expect((await owner.call(M.list, { params: { workspaceId: w }, query: {} })).items.map((i) => i.id)).not.toContain(v1.assetId);
    expect((await owner.call(M.list, { params: { workspaceId: w }, query: { archived: 'only' } })).items.map((i) => i.id)).toEqual([v1.assetId]);
    const hist = await owner.call(M.download, { params: { workspaceId: w, assetId: v1.assetId }, body: { versionId: v1.assetVersionId } });
    expect((await owner.fetch(hist.url)).status).toBe(200);
    const restored = await owner.call(M.restore, { params: { workspaceId: w, assetId: v1.assetId }, body: {} }, { ifMatch: archived.rowVersion });

    // The unreferenced current version can be deleted: v1 becomes current again.
    const [before] = await db().select().from(workspaces).where(eq(workspaces.id, w));
    const del = await owner.call(M.deleteVersion, { params: { workspaceId: w, assetId: v1.assetId, versionId: v2.assetVersionId }, body: { reason: 'Uploaded by mistake' } }, { ifMatch: restored.rowVersion });
    expect(del.currentVersion?.id).toBe(v1.assetVersionId);
    expect(del.versions.find((v) => v.id === v2.assetVersionId)?.deletedAt).not.toBeNull();
    expect((await owner.attempt(M.download, { params: { workspaceId: w, assetId: v1.assetId }, body: { versionId: v2.assetVersionId } })).status).toBe(404);

    // Purge after the trash period releases the stored bytes.
    await db().insert(jobs).values({ id: newId(), workspaceId: null, type: 'media.purgeDeletedVersions', pool: 'media', payload: {}, runAt: new Date() });
    setClock(new Date(Date.now() + 31 * 86_400_000));
    await runQueuedJobs(['media.purgeDeletedVersions']);
    const [v2row] = await db().select().from(assetVersions).where(eq(assetVersions.id, v2.assetVersionId));
    expect(v2row!.purgedAt).not.toBeNull();
    const [after] = await db().select().from(workspaces).where(eq(workspaces.id, w));
    expect(after!.storageUsedBytes).toBe(before!.storageUsedBytes - BigInt(v2row!.byteSize!));
  });
});

describe('bulk move / tag / archive with preview', () => {
  it('previews scope changes and denials, applies per file and reports conflicts', async () => {
    const { ws, w, owner } = await setup();
    const p1 = await createProject(db(), ws, {});
    const p2 = await createProject(db(), ws, {});
    const target = await owner.call(F.create, { params: { workspaceId: w }, body: { name: 'P2 library', projectId: p2.id } });
    const a = await uploadFile(owner, w, await png(), { projectId: p1.id, filename: 'a.png' });
    const b = await uploadFile(owner, w, await png(300, 300), { projectId: p1.id, filename: 'b.png' });
    const c = await uploadFile(owner, w, await png(400, 300), { projectId: p2.id, filename: 'c.png' });
    const preview = await owner.call(M.bulkPreview, { params: { workspaceId: w }, body: { action: 'move', assetIds: [a.assetId, b.assetId, c.assetId], folderId: target.id } });
    expect(preview.counts).toEqual({ apply: 3, skip: 0, denied: 0, conflict: 0 });
    expect(preview.items.filter((i) => i.scopeChange).map((i) => i.id).sort()).toEqual([a.assetId, b.assetId].sort());
    // b changes after the preview → reported, not silently applied.
    const bNow = await owner.call(M.get, { params: { workspaceId: w, assetId: b.assetId } });
    await owner.call(M.update, { params: { workspaceId: w, assetId: b.assetId }, body: { name: 'b-renamed.png' } }, { ifMatch: bNow.rowVersion });
    const key = '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a';
    const res = await owner.call(M.bulkApply, { params: { workspaceId: w }, body: { token: preview.token } }, { idempotencyKey: key });
    expect([...res.applied].sort()).toEqual([a.assetId, c.assetId].sort());
    expect(res.failed).toEqual([{ id: b.assetId, reason: expect.stringMatching(/changed/) }]);
    const replay = await owner.call(M.bulkApply, { params: { workspaceId: w }, body: { token: preview.token } }, { idempotencyKey: key });
    expect(replay).toEqual(res);
    const [moved] = await db().select().from(assets).where(eq(assets.id, a.assetId));
    expect(moved).toMatchObject({ folderId: target.id, projectId: p2.id });
    const retried = await owner.attempt(M.bulkApply, { params: { workspaceId: w }, body: { token: preview.token } });
    expect(retried.status).toBe(409);
  });

  it('select-all-matching previews use the typed filter within the member scope and deny what the member cannot change', async () => {
    const { ws, w, owner } = await setup();
    const p1 = await createProject(db(), ws, {});
    const viewer = await member(ws, 'viewer');
    await uploadFile(owner, w, await png(), { projectId: p1.id, filename: 'one.png' });
    await uploadFile(owner, w, await png(200, 100), { projectId: p1.id, filename: 'two.png' });
    const tag = await owner.call(M.bulkPreview, { params: { workspaceId: w }, body: { action: 'tag', filter: { projectId: p1.id }, expectedCount: 2, tags: ['Approved'] } });
    expect(tag.counts.apply).toBe(2);
    const applied = await owner.call(M.bulkApply, { params: { workspaceId: w }, body: { token: tag.token } });
    expect(applied.applied).toHaveLength(2);
    const tagged = await owner.call(M.list, { params: { workspaceId: w }, query: { tag: ['approved'] } });
    expect(tagged.items).toHaveLength(2);
    const denied = await viewer.c.call(M.bulkPreview, { params: { workspaceId: w }, body: { action: 'archive', filter: { projectId: p1.id } } });
    expect(denied.counts).toMatchObject({ apply: 0, denied: 2 });
    // Another member cannot use someone else's preview token.
    expect((await viewer.c.attempt(M.bulkApply, { params: { workspaceId: w }, body: { token: tag.token } })).status).toBe(404);
  });
});

describe('upload pipeline additions', () => {
  it('rejects an avatar over the decoded pixel limit and releases the reservation (T074)', async () => {
    const { w, owner } = await setup();
    const big = await png(4200, 4200, '#000000');
    const init = await uploadFile(owner, w, big, { purpose: 'avatar', filename: 'huge.png' });
    const [v] = await db().select().from(assetVersions).where(eq(assetVersions.id, init.assetVersionId));
    expect(v!.status).toBe('rejected');
    expect(v!.rejectionReason).toMatch(/pixel|dimension/i);
    const [ws] = await db().select().from(workspaces).where(eq(workspaces.id, w));
    expect(ws!.storageReservedBytes).toBe(0n);
    expect(ws!.storageUsedBytes).toBe(0n);
  });

  it('resumes an interrupted multipart upload within the TTL into one file with one stored blob; after the TTL it expires cleanly (T075)', async () => {
    const { w, owner } = await setup();
    const body = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(9 * 1024 * 1024 - 4, 7)]);
    const init = await owner.call(M.initiateUpload, { params: { workspaceId: w }, body: { filename: 'project-files.zip', mimeType: 'application/zip', byteSize: body.length, purpose: 'general' } });
    expect(init.partCount).toBe(2);
    await putParts(init.parts.slice(0, 1), body, init.partSize);
    const open = await owner.call(M.listOpenUploads, { params: { workspaceId: w } });
    expect(open.map((u) => u.uploadId)).toEqual([init.uploadId]);
    const resume = await owner.call(M.resumeUpload, { params: { workspaceId: w, uploadId: init.uploadId } });
    expect(resume.uploaded.map((p) => p.partNumber)).toEqual([1]);
    expect(resume.missing.map((p) => p.partNumber)).toEqual([2]);
    const tail = await putParts(resume.missing, body, init.partSize);
    const parts = [...resume.uploaded.map((p) => ({ partNumber: p.partNumber, etag: p.etag })), ...tail];
    await owner.call(M.completeUpload, { params: { workspaceId: w, uploadId: init.uploadId }, body: { parts } });
    await runQueuedJobs(['media.process']);
    const a = await owner.call(M.get, { params: { workspaceId: w, assetId: init.assetId } });
    expect(a.currentVersion).toMatchObject({ status: 'available', mime: 'application/zip', byteSize: body.length });
    expect(a.kind).toBe('archive');
    expect(await owner.call(M.listOpenUploads, { params: { workspaceId: w } })).toHaveLength(0);
    // Replaying the completion changes nothing.
    const replay = await owner.call(M.completeUpload, { params: { workspaceId: w, uploadId: init.uploadId }, body: { parts } });
    expect(replay.assetVersionId).toBe(init.assetVersionId);

    // One owner of the bytes: one asset, one version, one stored original, quota counted once, and
    // nothing left in quarantine.
    const storage = getAppServices().storage;
    expect((await db().select().from(assets).where(eq(assets.workspaceId, w))).map((x) => x.id)).toEqual([init.assetId]);
    const versions = await db().select().from(assetVersions).where(eq(assetVersions.workspaceId, w));
    expect(versions.map((v) => [v.id, v.status])).toEqual([[init.assetVersionId, 'available']]);
    expect(versions[0]!.storageKey).toBeTruthy();
    expect((await storage.headObject(versions[0]!.storageKey!))?.size).toBe(body.length);
    expect((await storage.listObjects(`assets/${w}/`)).filter((k) => k.endsWith('/original'))).toEqual([versions[0]!.storageKey]);
    expect(await storage.listObjects(`quarantine/${w}/`)).toEqual([]);
    const [wsAfter] = await db().select().from(workspaces).where(eq(workspaces.id, w));
    expect(wsAfter!.storageUsedBytes).toBe(BigInt(body.length));
    expect(wsAfter!.storageReservedBytes).toBe(0n);

    // A second interrupted upload outlives its 24 h session: resume and completion are refused, and
    // the expiry sweep aborts it, frees the reservation and leaves no empty file behind.
    const late = await owner.call(M.initiateUpload, { params: { workspaceId: w }, body: { filename: 'late.zip', mimeType: 'application/zip', byteSize: body.length, purpose: 'general' } });
    const lateParts = await putParts(late.parts.slice(0, 1), body, late.partSize);
    const [reserved] = await db().select().from(workspaces).where(eq(workspaces.id, w));
    expect(reserved!.storageReservedBytes).toBe(BigInt(body.length));
    // The 24 h session TTL passes (the member's own sign-in session is unaffected).
    const [lateSession] = await db().select().from(uploadSessions).where(eq(uploadSessions.id, late.uploadId));
    expect(Math.round((lateSession!.expiresAt.getTime() - lateSession!.createdAt.getTime()) / 60_000)).toBe(24 * 60);
    await db().update(uploadSessions).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(uploadSessions.id, late.uploadId));
    const expired = await owner.call(M.resumeUpload, { params: { workspaceId: w, uploadId: late.uploadId } });
    expect(expired).toMatchObject({ state: 'expired', uploaded: [], missing: [] });
    const lateComplete = await owner.attempt(M.completeUpload, { params: { workspaceId: w, uploadId: late.uploadId }, body: { parts: [...lateParts, { partNumber: 2, etag: 'x' }] } });
    expect(lateComplete.status).toBe(409);
    expect(await owner.call(M.listOpenUploads, { params: { workspaceId: w } })).toHaveLength(0);
    await enqueueJob(db(), { type: 'media.expireUploads', workspaceId: null, payload: {} });
    await runQueuedJobs(['media.expireUploads']);
    const [lateVersion] = await db().select().from(assetVersions).where(eq(assetVersions.id, late.assetVersionId));
    expect(lateVersion).toMatchObject({ status: 'failed', storageKey: null });
    const [wsLate] = await db().select().from(workspaces).where(eq(workspaces.id, w));
    expect(wsLate!.storageReservedBytes).toBe(0n);
    expect(wsLate!.storageUsedBytes).toBe(BigInt(body.length));
    expect((await owner.call(M.list, { params: { workspaceId: w }, query: {} })).items.map((i) => i.id)).toEqual([init.assetId]);
    expect(await storage.listObjects(`quarantine/${w}/`)).toEqual([]);
  });

  it('a cancelled first upload leaves no empty file in the Library', async () => {
    const { w, owner } = await setup();
    const init = await owner.call(M.initiateUpload, { params: { workspaceId: w }, body: { filename: 'draft.png', mimeType: 'image/png', byteSize: 1000, purpose: 'content' } });
    await owner.call(M.abortUpload, { params: { workspaceId: w, uploadId: init.uploadId }, body: {} });
    expect((await owner.call(M.list, { params: { workspaceId: w }, query: {} })).items).toHaveLength(0);
    const [ws] = await db().select().from(workspaces).where(eq(workspaces.id, w));
    expect(ws!.storageReservedBytes).toBe(0n);
  });

  it('keeps the file Checking while the malware scanner is down and fails it honestly after the last attempt (T077)', async () => {
    const { w, owner } = await setup();
    const app = getAppServices();
    const down = { mode: 'clamd' as const, scan: async () => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:3310')), healthCheck: async () => ({ ok: false }) };
    setAppServices({ ...app, scanner: down });
    try {
      const init = await uploadFile(owner, w, await png(), {}, false);
      await expect(runQueuedJobs(['media.process'])).rejects.toThrow(/unavailable/);
      const [checking] = await db().select().from(assetVersions).where(eq(assetVersions.id, init.assetVersionId));
      expect(checking!.status).toBe('checking');
      expect(checking!.storageKey).toBeNull();
      expect((await owner.attempt(M.download, { params: { workspaceId: w, assetId: init.assetId }, body: {} })).status).toBe(409);
      // Final retry: the job gives up and says so.
      await db().update(jobs).set({ state: 'queued', attempts: 5 }).where(and(eq(jobs.type, 'media.process'), eq(jobs.workspaceId, w)));
      await runQueuedJobs(['media.process']);
      const [failed] = await db().select().from(assetVersions).where(eq(assetVersions.id, init.assetVersionId));
      expect(failed!.status).toBe('failed');
      expect(failed!.rejectionReason).toMatch(/malware scan service was unavailable/);
      const [ws] = await db().select().from(workspaces).where(eq(workspaces.id, w));
      expect(ws!.storageReservedBytes).toBe(0n);
    } finally {
      setAppServices(app);
    }
  });
});
