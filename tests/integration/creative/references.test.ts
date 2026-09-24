import { afterEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { newIdempotencyKey } from '@castlane/api-client';
import { characterEndpoints as C, referenceEndpoints as R } from '@castlane/api-contracts';
import { assets, contentItems, referenceLinks, references } from '@castlane/database';
import { IMPORT_DATASETS_REGISTRY, executeCommand, getAppServices, memberJobContext } from '@castlane/application';
import { addMember, assignToProject, clientFor, createProject, sessionFor } from '../../support';
import { baseSetup, db, insertImageAsset } from '../accounts/support';

afterEach(() => vi.restoreAllMocks());

describe('references', () => {
  it('creating from a URL keeps a note and never downloads anything (T034)', async () => {
    const { ws, owner, W } = await baseSetup();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const before = await db().select().from(assets).where(eq(assets.workspaceId, ws.workspaceId));
    const r = await owner.call(R.create, {
      params: W,
      body: { title: 'Hook in first second', sourceUrl: 'https://www.tiktok.com/@creator/video/123', whatToReuse: 'Cold open with a question', tags: ['hook', 'edit'] },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(r.sourceUrl).toBe('https://www.tiktok.com/@creator/video/123');
    expect(r.previewUrl).toBeNull();
    expect(r.project).toBeNull();
    const after = await db().select().from(assets).where(eq(assets.workspaceId, ws.workspaceId));
    expect(after).toHaveLength(before.length);
    // A source is required; unsafe schemes are rejected.
    expect((await owner.attempt(R.create, { params: W, body: { title: 'No source', whatToReuse: 'Nothing' } })).status).toBe(422);
    expect((await owner.attempt(R.create, { params: W, body: { title: 'Bad', sourceUrl: 'javascript:alert(1)', whatToReuse: 'Nothing' } })).status).toBe(422);
    // A preview comes only from an uploaded image.
    const img = await insertImageAsset(ws);
    const withPreview = await owner.call(R.update, { params: { ...W, referenceId: r.id }, body: { previewAssetId: img.assetId } }, { ifMatch: r.rowVersion });
    expect(withPreview.previewAssetId).toBe(img.assetId);
  });

  it('Use as Idea creates exactly one linked draft and shows the usage (T035)', async () => {
    const { ws, owner, project, W } = await baseSetup();
    const r = await owner.call(R.create, { params: W, body: { title: 'Lighting study', sourceUrl: 'https://example.com/light', whatToReuse: 'Rim light at dusk', tags: ['lighting'], projectId: project.id } });
    const key = newIdempotencyKey();
    const first = await owner.call(R.useAsIdea, { params: { ...W, referenceId: r.id }, body: { projectId: project.id, format: 'short_video' } }, { idempotencyKey: key });
    expect(first.created).toBe(true);
    const replay = await owner.call(R.useAsIdea, { params: { ...W, referenceId: r.id }, body: { projectId: project.id, format: 'short_video' } }, { idempotencyKey: key });
    expect(replay.contentItemId).toBe(first.contentItemId);
    // A second deliberate click (new key) still returns the same draft.
    const again = await owner.call(R.useAsIdea, { params: { ...W, referenceId: r.id }, body: { projectId: project.id, format: 'image' } });
    expect(again.created).toBe(false);
    expect(again.contentItemId).toBe(first.contentItemId);
    const drafts = await db().select().from(contentItems).where(eq(contentItems.workspaceId, ws.workspaceId));
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ stage: 'idea', projectId: project.id, title: 'Lighting study' });
    const detail = await owner.call(R.get, { params: { ...W, referenceId: r.id } });
    expect(detail.idea?.contentItemId).toBe(first.contentItemId);
    expect(detail.usage.content).toBe(1);
    expect(detail.links.find((l) => l.kind === 'idea')?.href).toContain(`/content/${first.contentItemId}`);
    // The idea link cannot be removed; archiving keeps the links (used references are archived, not deleted).
    const ideaLink = detail.links.find((l) => l.kind === 'idea')!;
    expect((await owner.attempt(R.unlink, { params: { ...W, referenceId: r.id, linkId: ideaLink.id }, body: {} })).status).toBe(409);
    const archived = await owner.call(R.archive, { params: { ...W, referenceId: r.id }, body: { reason: 'Outdated' } }, { ifMatch: detail.rowVersion });
    expect(archived.archivedAt).not.toBeNull();
    const links = await db().select().from(referenceLinks).where(eq(referenceLinks.referenceId, r.id));
    expect(links).toHaveLength(1);
  });

  it('links to projects and characters within scope; workspace-wide references are visible to scoped readers', async () => {
    const { ws, owner, project, W } = await baseSetup();
    const other = await createProject(db(), ws, { name: 'Hidden', type: 'influencer' });
    const character = await owner.call(C.create, { params: { ...W, projectId: project.id }, body: { name: 'Emma' } });
    const wide = await owner.call(R.create, { params: W, body: { title: 'Story arc', sourceUrl: 'https://example.com/arc', whatToReuse: 'Three-act structure', tags: ['story'] } });
    const hidden = await owner.call(R.create, { params: W, body: { title: 'Secret project ref', sourceUrl: 'https://example.com/x', whatToReuse: 'Colour grade', projectId: other.id } });
    const linked = await owner.call(R.link, { params: { ...W, referenceId: wide.id }, body: { targetType: 'character', targetId: character.id } });
    expect(linked.usage.characters).toBe(1);
    await owner.call(R.link, { params: { ...W, referenceId: wide.id }, body: { targetType: 'project', targetId: other.id } });

    const producer = await addMember(db(), ws, { roleKey: 'producer', scopeType: 'assigned_projects' });
    await assignToProject(db(), ws, project.id, producer.membershipId);
    const pc = await clientFor(await sessionFor(db(), producer.userId));
    const list = await pc.call(R.list, { params: W, query: {} });
    expect(list.items.map((i) => i.id)).toEqual([wide.id]);
    expect((await pc.attempt(R.get, { params: { ...W, referenceId: hidden.id } })).status).toBe(404);
    const detail = await pc.call(R.get, { params: { ...W, referenceId: wide.id } });
    // The link to the hidden project is counted, never named.
    expect(detail.links.map((l) => l.label)).toEqual(['Emma']);
    expect(detail.hiddenLinkCount).toBe(1);
    // Producers cannot link to records outside their scope, nor edit references they do not own.
    expect((await pc.attempt(R.update, { params: { ...W, referenceId: wide.id }, body: { title: 'Mine now' } }, { ifMatch: detail.rowVersion })).status).toBe(403);
    const own = await pc.call(R.create, { params: W, body: { title: 'My ref', sourceUrl: 'https://example.com/mine', whatToReuse: 'Pacing', projectId: project.id } });
    const bad = await pc.attempt(R.link, { params: { ...W, referenceId: own.id }, body: { targetType: 'project', targetId: other.id } });
    expect(bad.status).toBe(422);
    const byCharacter = await pc.call(R.list, { params: W, query: { characterId: character.id } });
    expect(byCharacter.items.map((i) => i.id)).toEqual([wide.id]);
  });

  it('import dataset validates rows and applies them with duplicate policies', async () => {
    const { ws, owner, project, W } = await baseSetup();
    await owner.call(R.create, { params: W, body: { title: 'Existing', sourceUrl: 'https://example.com/a', whatToReuse: 'Old note', projectId: project.id } });
    const ds = IMPORT_DATASETS_REGISTRY.get('references')!;
    const ctx = (await memberJobContext(getAppServices(), ws.workspaceId, ws.owner.membershipId, { source: 'import' }))!;
    const bad = await ds.validate(ctx, { title: 'X', source_url: 'ftp://nope', what_to_reuse: '', tags: 'hook,glitter', project: 'Missing project' }, { duplicatePolicy: 'skip', rowNo: 1 });
    expect(bad.errors.map((e) => e.field).sort()).toEqual(['project', 'source_url', 'tags', 'title', 'what_to_reuse']);
    const dupSkip = await ds.validate(ctx, { title: 'Existing again', source_url: 'https://example.com/a', what_to_reuse: 'New note', project: 'Emma Model' }, { duplicatePolicy: 'skip', rowNo: 2 });
    expect(dupSkip.action).toBe('skip');
    const revise = await ds.validate(ctx, { title: 'Existing (revised)', source_url: 'https://example.com/a', what_to_reuse: 'New note', project: project.id }, { duplicatePolicy: 'revise_existing', rowNo: 3 });
    expect(revise.action).toBe('update');
    const create = await ds.validate(ctx, { title: 'Brand new', source_url: 'https://example.com/b', what_to_reuse: 'Transitions', tags: ['edit'] }, { duplicatePolicy: 'error', rowNo: 4 });
    expect(create.errors).toEqual([]);
    const ids = await executeCommand(ctx, async (c) => [
      await ds.apply(c, revise.normalized, { action: 'update', targetId: revise.targetId, targetRowVersion: revise.targetRowVersion }),
      await ds.apply(c, create.normalized, { action: 'create' }),
    ]);
    const rows = await db().select().from(references).where(eq(references.workspaceId, ws.workspaceId));
    expect(rows.find((r) => r.id === ids.body[0])!.title).toBe('Existing (revised)');
    expect(rows.find((r) => r.id === ids.body[1])!.projectId).toBeNull();
    // Undo removes the untouched imported record only.
    await executeCommand(ctx, (c) => ds.undo!(c, ids.body[1]!));
    const remaining = await db().select().from(references).where(and(eq(references.workspaceId, ws.workspaceId)));
    expect(remaining).toHaveLength(1);
  });
});
