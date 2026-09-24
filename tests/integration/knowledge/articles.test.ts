import { describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { knowledgeEndpoints as K, shellEndpoints, type RichTextDocument } from '@castlane/api-contracts';
import { getAppServices, RESPONSIBILITY_PROVIDERS, executeCommand, memberJobContext } from '@castlane/application';
import { articleAcknowledgements, articleVersions, auditEvents, notifications, readingAssignments, taskChecklistItems, tasks } from '@castlane/database';
import { addMember, assignToProject, clientFor, createProject, createWorkspace, sessionFor } from '../../support';

const db = () => getAppServices().db;

/** First field error of a failed attempt. */
const firstFieldError = (r: { error: { fieldErrors?: unknown } | null }) => (r.error?.fieldErrors as { field: string; code: string; message: string }[] | undefined)?.[0];

const doc = (...paras: string[]): RichTextDocument => ({ type: 'doc', content: paras.map((t) => ({ type: 'paragraph', content: [{ type: 'text', text: t }] })) });

const setup = async () => {
  const ws = await createWorkspace(db());
  const owner = await clientFor(await sessionFor(db(), ws.owner.userId));
  const w = ws.workspaceId;
  const cat = await owner.call(K.createCategory, { params: { workspaceId: w }, body: { name: 'Regulations' } });
  const newArticle = async (over: Partial<Parameters<typeof owner.call<typeof K.create>>[1]['body']> = {}) =>
    owner.call(K.create, {
      params: { workspaceId: w },
      body: { title: 'Posting rules', categoryId: cat.id, scopeType: 'workspace', ownerMembershipId: ws.owner.membershipId, body: doc('Always check the caption.'), ...over },
    });
  const publish = async (id: string, revisionKind: 'major' | 'minor' = 'major') => {
    const a = await owner.call(K.get, { params: { workspaceId: w, articleId: id } });
    return owner.call(K.publish, { params: { workspaceId: w, articleId: id }, body: { versionId: a.draft!.id, revisionKind } }, { ifMatch: a.rowVersion });
  };
  const edit = async (id: string, text: string) => {
    const a = await owner.call(K.get, { params: { workspaceId: w, articleId: id } });
    return owner.call(K.update, { params: { workspaceId: w, articleId: id }, body: { body: doc(text) } }, { ifMatch: a.rowVersion });
  };
  return { ws, w, owner, cat, newArticle, publish, edit };
};

const memberClient = async (ws: Awaited<ReturnType<typeof createWorkspace>>, roleKey: string, scopeType: 'workspace' | 'assigned_projects' = 'workspace') => {
  const m = await addMember(db(), ws, { roleKey, scopeType });
  return { ...m, c: await clientFor(await sessionFor(db(), m.userId)) };
};

describe('knowledge articles: publish, frozen versions, drafts (T082)', () => {
  it('publishing freezes the version; a later edit becomes a new draft and never changes the published text (T082)', async () => {
    const { w, owner, newArticle, publish, edit } = await setup();
    const created = await newArticle();
    expect(created.status).toBe('draft');
    expect(created.published).toBeNull();
    const published = await publish(created.id);
    expect(published.status).toBe('published');
    expect(published.publishedVersionNo).toBe(1);
    expect(published.draft).toBeNull();
    const v1 = published.published!;

    const edited = await edit(created.id, 'Always check the caption and the tags.');
    expect(edited.draft?.versionNo).toBe(2);
    expect(edited.published?.id).toBe(v1.id);
    expect(JSON.stringify(edited.published?.body)).toContain('Always check the caption.');
    expect(JSON.stringify(edited.published?.body)).not.toContain('tags');

    // The database refuses to change a published version, even outside the API.
    const refused = await db()
      .execute(sql`UPDATE article_versions SET body = '{"type":"doc","content":[]}'::jsonb WHERE id = ${v1.id}`)
      .then(() => null)
      .catch((e: Error & { cause?: Error }) => e.cause?.message ?? e.message);
    expect(refused).toMatch(/immutable/);

    const again = await publish(created.id, 'minor');
    expect(again.publishedVersionNo).toBe(2);
    const versions = await owner.call(K.versions, { params: { workspaceId: w, articleId: created.id } });
    expect(versions.map((v) => [v.versionNo, v.state])).toEqual([
      [2, 'published'],
      [1, 'superseded'],
    ]);
    const cmp = await owner.call(K.compare, { params: { workspaceId: w, articleId: created.id }, query: { from: versions[1]!.id, to: versions[0]!.id } });
    expect(cmp.summary.changed).toBe(1);
    expect(cmp.changes[0]).toMatchObject({ kind: 'changed', before: 'Always check the caption.' });
  });

  it('only the current draft can be published, If-Match is required and stale versions conflict', async () => {
    const { w, owner, newArticle } = await setup();
    const a = await newArticle();
    const missing = await owner.attempt(K.update, { params: { workspaceId: w, articleId: a.id }, body: { title: 'Changed title' } });
    expect(missing.status).toBe(428);
    const ok = await owner.call(K.update, { params: { workspaceId: w, articleId: a.id }, body: { title: 'Changed title' } }, { ifMatch: a.rowVersion });
    const stale = await owner.attempt(K.update, { params: { workspaceId: w, articleId: a.id }, body: { title: 'Other title' } }, { ifMatch: a.rowVersion });
    expect(stale.status).toBe(412);
    expect(stale.code).toBe('VERSION_CONFLICT');
    const wrong = await owner.attempt(K.publish, { params: { workspaceId: w, articleId: a.id }, body: { versionId: a.id, revisionKind: 'major' } }, { ifMatch: ok.rowVersion });
    expect(wrong.status).toBe(409);
  });

  it('autosaves are aggregated into one history entry per editing session', async () => {
    const { w, owner, newArticle } = await setup();
    let a = await newArticle();
    for (const t of ['First words', 'First words and more', 'First words and even more']) a = await owner.call(K.update, { params: { workspaceId: w, articleId: a.id }, body: { body: doc(t), autosave: true } }, { ifMatch: a.rowVersion });
    const saves = await db().select().from(auditEvents).where(and(eq(auditEvents.entityId, a.id), eq(auditEvents.action, 'article.draft_saved')));
    expect(saves).toHaveLength(1);
    expect(JSON.stringify(a.draft?.body)).toContain('even more');
  });

  it('rejects unsafe links and never stores HTML', async () => {
    const { w, owner, cat, ws } = await setup();
    const bad = await owner.attempt(K.create, {
      params: { workspaceId: w },
      body: {
        title: 'Links',
        categoryId: cat.id,
        scopeType: 'workspace',
        ownerMembershipId: ws.owner.membershipId,
        body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x', href: 'javascript:alert(1)' }] }] },
      },
    });
    expect(bad.status).toBe(422);
    expect(firstFieldError(bad)).toMatchObject({ code: 'UNSAFE_LINK' });
    const raw = await owner.raw('POST', `/workspaces/${w}/articles`, {
      headers: { 'idempotency-key': '6f1c2b1e-9a55-4c77-8a1e-0d0c1b1a2f3e' },
      body: {
        title: 'Scripts',
        categoryId: cat.id,
        scopeType: 'workspace',
        ownerMembershipId: ws.owner.membershipId,
        body: { type: 'doc', content: [{ type: 'paragraph', html: '<script>x</script>', content: [{ type: 'text', text: 'safe', style: 'x' }] }] },
      },
    });
    expect(raw.status).toBe(201);
    const stored = await db().select({ body: articleVersions.body }).from(articleVersions).where(eq(articleVersions.title, 'Scripts'));
    expect(JSON.stringify(stored[0]!.body)).not.toMatch(/script|style/);
  });

  it('replays an idempotent create instead of creating a second article', async () => {
    const { w, owner, cat, ws } = await setup();
    const body = { title: 'Once', categoryId: cat.id, scopeType: 'workspace' as const, ownerMembershipId: ws.owner.membershipId };
    const key = '0b8a3f9e-2c1d-4e5f-8a7b-6c5d4e3f2a1b';
    const a = await owner.call(K.create, { params: { workspaceId: w }, body }, { idempotencyKey: key });
    const b = await owner.call(K.create, { params: { workspaceId: w }, body }, { idempotencyKey: key });
    expect(b.id).toBe(a.id);
    const list = await owner.call(K.list, { params: { workspaceId: w }, query: { q: 'Once' } });
    expect(list.items).toHaveLength(1);
  });
});

describe('knowledge access: drafts for editors, published text in the article scope', () => {
  it('readers never see drafts; project articles are hidden outside the project (404, lists and counts)', async () => {
    const { ws, w, owner, cat, newArticle, publish } = await setup();
    const p1 = await createProject(db(), ws, {});
    const p2 = await createProject(db(), ws, {});
    const creator = await memberClient(ws, 'creator', 'assigned_projects');
    await assignToProject(db(), ws, p1.id, creator.membershipId);

    const draft = await newArticle({ title: 'Unpublished plan' });
    const general = await newArticle({ title: 'Team handbook' });
    await publish(general.id);
    const inP1 = await newArticle({ title: 'P1 guide', scopeType: 'project', scopeId: p1.id });
    await publish(inP1.id);
    const inP2 = await newArticle({ title: 'P2 guide', scopeType: 'project', scopeId: p2.id });
    await publish(inP2.id);

    expect((await creator.c.attempt(K.get, { params: { workspaceId: w, articleId: draft.id } })).status).toBe(404);
    expect((await creator.c.attempt(K.get, { params: { workspaceId: w, articleId: inP2.id } })).status).toBe(404);
    const seen = await creator.c.call(K.get, { params: { workspaceId: w, articleId: inP1.id } });
    expect(seen.draft).toBeUndefined();
    expect(seen.permissions.edit).toBe(false);

    const list = await creator.c.call(K.list, { params: { workspaceId: w }, query: {} });
    expect(list.items.map((i) => i.title).sort()).toEqual(['P1 guide', 'Team handbook']);
    const cats = await creator.c.call(K.listCategories, { params: { workspaceId: w }, query: {} });
    expect(cats.items.find((c) => c.id === cat.id)?.articleCount).toBe(2);
    expect(cats.canManage).toBe(false);
    // Editing needs knowledge.write: 403 on a visible article.
    const upd = await creator.c.attempt(K.update, { params: { workspaceId: w, articleId: inP1.id }, body: { title: 'Hack' } }, { ifMatch: seen.rowVersion });
    expect(upd.status).toBe(403);

    const found = await creator.c.call(shellEndpoints.search, { params: { workspaceId: w }, query: { q: 'guide', types: 'article' } });
    expect(found.results.map((r) => r.title)).toEqual(['P1 guide']);
    const draftSearch = await owner.call(shellEndpoints.search, { params: { workspaceId: w }, query: { q: 'Unpublished', types: 'article' } });
    expect(draftSearch.results).toHaveLength(0);
  });

  it('project leads manage articles of their projects only; categories need a workspace-wide editor', async () => {
    const { ws, w, cat } = await setup();
    const p1 = await createProject(db(), ws, {});
    const p2 = await createProject(db(), ws, {});
    const lead = await memberClient(ws, 'project_lead', 'assigned_projects');
    await assignToProject(db(), ws, p1.id, lead.membershipId);
    const body = { title: 'Lead guide', categoryId: cat.id, ownerMembershipId: lead.membershipId };
    const ok = await lead.c.attempt(K.create, { params: { workspaceId: w }, body: { ...body, scopeType: 'project', scopeId: p1.id } });
    expect(ok.status).toBe(201);
    expect((await lead.c.attempt(K.create, { params: { workspaceId: w }, body: { ...body, scopeType: 'project', scopeId: p2.id } })).status).toBe(422);
    expect((await lead.c.attempt(K.create, { params: { workspaceId: w }, body: { ...body, scopeType: 'workspace' } })).status).toBe(403);
    expect((await lead.c.attempt(K.createCategory, { params: { workspaceId: w }, body: { name: 'Lead category' } })).status).toBe(403);
    const viewer = await memberClient(ws, 'viewer');
    expect((await viewer.c.attempt(K.create, { params: { workspaceId: w }, body: { ...body, scopeType: 'workspace' } })).status).toBe(403);
  });

  it('category names are unique (case-insensitive) among active categories', async () => {
    const { w, owner } = await setup();
    const dup = await owner.attempt(K.createCategory, { params: { workspaceId: w }, body: { name: '  regulations ' } });
    expect(dup.status).toBe(422);
    expect(firstFieldError(dup)).toMatchObject({ field: 'name', code: 'DUPLICATE' });
  });
});

describe('required reading and acknowledgements (T083, T084)', () => {
  it('opening the article does not acknowledge it; only the explicit action does, idempotently (T083)', async () => {
    const { ws, w, owner, newArticle, publish } = await setup();
    const viewer = await memberClient(ws, 'viewer');
    const a = await publish((await newArticle()).id);
    const assigned = await owner.call(K.assignReading, { params: { workspaceId: w, articleId: a.id }, body: { versionId: a.published!.id, membershipIds: [viewer.membershipId] } });
    expect(assigned).toMatchObject({ created: 1, alreadyAssigned: 0 });
    const [n] = await db().select().from(notifications).where(and(eq(notifications.recipientMembershipId, viewer.membershipId), eq(notifications.entityId, a.id)));
    expect(n?.title).toContain('Required reading');

    // Opening (and re-opening) the article never records reading.
    const opened = await viewer.c.call(K.get, { params: { workspaceId: w, articleId: a.id } });
    await viewer.c.call(K.get, { params: { workspaceId: w, articleId: a.id } });
    expect(opened.myReading?.status).toBe('open');
    expect(opened.acknowledgedCurrent).toBe(false);
    expect(await db().select().from(articleAcknowledgements).where(eq(articleAcknowledgements.membershipId, viewer.membershipId))).toHaveLength(0);
    const open = await viewer.c.call(K.myReading, { params: { workspaceId: w }, query: {} });
    expect(open.items.map((i) => i.articleId)).toEqual([a.id]);

    const key = 'c3d2e1f0-a9b8-4c7d-8e6f-5a4b3c2d1e0f';
    const ack = await viewer.c.call(K.acknowledge, { params: { workspaceId: w, articleId: a.id }, body: { versionId: a.published!.id } }, { idempotencyKey: key });
    expect(ack.fulfilledRequests).toBe(1);
    const replay = await viewer.c.call(K.acknowledge, { params: { workspaceId: w, articleId: a.id }, body: { versionId: a.published!.id } }, { idempotencyKey: key });
    expect(replay.acknowledgedAt).toBe(ack.acknowledgedAt);
    const second = await viewer.c.call(K.acknowledge, { params: { workspaceId: w, articleId: a.id }, body: { versionId: a.published!.id } });
    expect(second.acknowledgedAt).toBe(ack.acknowledgedAt);
    expect(second.fulfilledRequests).toBe(0);
    expect((await viewer.c.call(K.myReading, { params: { workspaceId: w }, query: {} })).items).toHaveLength(0);
    const status = await owner.call(K.readingStatus, { params: { workspaceId: w, articleId: a.id }, query: {} });
    expect(status.items[0]).toMatchObject({ status: 'acknowledged', versionNo: 1 });
    // Readers cannot see who acknowledged.
    expect((await viewer.c.attempt(K.readingStatus, { params: { workspaceId: w, articleId: a.id }, query: {} })).status).toBe(403);
  });

  it('a major revision of required reading asks again and keeps the earlier acknowledgement; a minor one does not (T084)', async () => {
    const { ws, w, owner, newArticle, publish, edit } = await setup();
    const v = await memberClient(ws, 'viewer');
    const pending = await memberClient(ws, 'viewer');
    const a = await publish((await newArticle()).id);
    await owner.call(K.assignReading, { params: { workspaceId: w, articleId: a.id }, body: { versionId: a.published!.id, membershipIds: [v.membershipId, pending.membershipId] } });
    await v.c.call(K.acknowledge, { params: { workspaceId: w, articleId: a.id }, body: { versionId: a.published!.id } });

    await edit(a.id, 'New mandatory step: check the music licence.');
    const v2 = await publish(a.id, 'major');
    const reqs = await db().select().from(readingAssignments).where(eq(readingAssignments.articleId, a.id));
    const byMember = (m: string) => reqs.filter((r) => r.membershipId === m).map((r) => [r.articleVersionId === v2.published!.id ? 2 : 1, r.status]);
    expect(byMember(v.membershipId).sort()).toEqual([
      [1, 'acknowledged'],
      [2, 'open'],
    ]);
    expect(byMember(pending.membershipId).sort()).toEqual([
      [1, 'superseded'],
      [2, 'open'],
    ]);
    const facts = await db().select().from(articleAcknowledgements).where(eq(articleAcknowledgements.membershipId, v.membershipId));
    expect(facts.map((f) => f.articleVersionId)).toEqual([a.published!.id]);
    // Acknowledging the old version is refused once a newer one is published.
    const stale = await v.c.attempt(K.acknowledge, { params: { workspaceId: w, articleId: a.id }, body: { versionId: a.published!.id } });
    expect(stale.status).toBe(409);
    const detail = await v.c.call(K.get, { params: { workspaceId: w, articleId: a.id } });
    expect(detail.myReading).toMatchObject({ status: 'open', versionNo: 2 });
    expect(detail.myAcknowledgement?.versionNo).toBe(1);
    await v.c.call(K.acknowledge, { params: { workspaceId: w, articleId: a.id }, body: { versionId: v2.published!.id } });

    // Minor revision: no new request for members who acknowledged; open requests move to the new version.
    await edit(a.id, 'New mandatory step: check the music licence (typo fixed).');
    const v3 = await publish(a.id, 'minor');
    const after = await db().select().from(readingAssignments).where(and(eq(readingAssignments.articleId, a.id), eq(readingAssignments.articleVersionId, v3.published!.id)));
    expect(after.map((r) => r.membershipId)).toEqual([pending.membershipId]);
  });

  it('assigns reading by role and project and skips members who cannot read the article', async () => {
    const { ws, w, owner, newArticle, publish } = await setup();
    const p1 = await createProject(db(), ws, {});
    const p2 = await createProject(db(), ws, {});
    const inTeam = await memberClient(ws, 'creator', 'assigned_projects');
    await assignToProject(db(), ws, p1.id, inTeam.membershipId);
    const outsider = await memberClient(ws, 'creator', 'assigned_projects');
    await assignToProject(db(), ws, p2.id, outsider.membershipId);
    const a = await publish((await newArticle({ title: 'P1 only', scopeType: 'project', scopeId: p1.id })).id);
    const creatorRole = await ws.roleId('creator');
    const r = await owner.call(K.assignReading, { params: { workspaceId: w, articleId: a.id }, body: { versionId: a.published!.id, roleIds: [creatorRole], projectIds: [p1.id] } });
    expect(r).toMatchObject({ created: 1, skippedNoAccess: 1 });
    const again = await owner.call(K.assignReading, { params: { workspaceId: w, articleId: a.id }, body: { versionId: a.published!.id, membershipIds: [inTeam.membershipId] } });
    expect(again).toMatchObject({ created: 0, alreadyAssigned: 1 });
    const past = await owner.attempt(K.assignReading, { params: { workspaceId: w, articleId: a.id }, body: { versionId: a.published!.id, membershipIds: [inTeam.membershipId], dueAt: '2020-01-01T00:00:00Z' } });
    expect(past.status).toBe(422);
    const aud = await owner.call(K.audiences, { params: { workspaceId: w } });
    expect(aud.roles.find((x) => x.id === creatorRole)?.memberCount).toBe(2);
  });

  it('archiving withdraws open requests but keeps acknowledgements; restore publishes again', async () => {
    const { ws, w, owner, newArticle, publish } = await setup();
    const v = await memberClient(ws, 'viewer');
    const a = await publish((await newArticle()).id);
    await owner.call(K.assignReading, { params: { workspaceId: w, articleId: a.id }, body: { versionId: a.published!.id, membershipIds: [v.membershipId] } });
    const preview = await owner.call(K.archivePreview, { params: { workspaceId: w, articleId: a.id } });
    expect(preview.items[0]).toMatchObject({ kind: 'open_reading', count: 1, blocking: false });
    const archived = await owner.call(K.archive, { params: { workspaceId: w, articleId: a.id }, body: {} }, { ifMatch: preview.rowVersion });
    expect(archived.status).toBe('archived');
    expect((await v.c.call(K.myReading, { params: { workspaceId: w }, query: {} })).items).toHaveLength(0);
    const restored = await owner.call(K.restore, { params: { workspaceId: w, articleId: a.id }, body: {} }, { ifMatch: archived.rowVersion });
    expect(restored.status).toBe('published');
  });
});

describe('create task from checklist, revert, ownership transfer', () => {
  it('creates a project task with the checklist of a published version', async () => {
    const { ws, w, owner, cat } = await setup();
    const p = await createProject(db(), ws, {});
    const created = await owner.call(K.create, {
      params: { workspaceId: w },
      body: {
        title: 'Release checklist',
        categoryId: cat.id,
        scopeType: 'workspace',
        ownerMembershipId: ws.owner.membershipId,
        body: {
          type: 'doc',
          content: [
            { type: 'heading', level: 2, content: [{ type: 'text', text: 'Before release' }] },
            { type: 'checklist', items: [{ id: 'a', content: [{ type: 'text', text: 'Check caption' }] }, { id: 'b', content: [{ type: 'text', text: 'Check music licence' }] }] },
          ],
        },
      },
    });
    const a = await owner.call(K.publish, { params: { workspaceId: w, articleId: created.id }, body: { versionId: created.draft!.id, revisionKind: 'major' } }, { ifMatch: created.rowVersion });
    const notList = await owner.attempt(K.createTask, { params: { workspaceId: w, articleId: a.id }, body: { versionId: a.published!.id, blockIndex: 0, projectId: p.id, title: 'Release episode 1' } });
    expect(notList.status).toBe(422);
    const r = await owner.call(K.createTask, { params: { workspaceId: w, articleId: a.id }, body: { versionId: a.published!.id, blockIndex: 1, projectId: p.id, title: 'Release episode 1', assigneeMembershipId: ws.owner.membershipId } });
    expect(r.checklistItems).toBe(2);
    const [t] = await db().select().from(tasks).where(eq(tasks.id, r.taskId));
    expect(t).toMatchObject({ projectId: p.id, articleId: a.id, status: 'backlog', title: 'Release episode 1' });
    const items = await db().select().from(taskChecklistItems).where(eq(taskChecklistItems.taskId, r.taskId));
    expect(items.map((i) => i.label).sort()).toEqual(['Check caption', 'Check music licence']);
  });

  it('revert starts a new draft from an old version without rewriting history', async () => {
    const { w, owner, newArticle, publish, edit } = await setup();
    const a = await publish((await newArticle()).id);
    await edit(a.id, 'Completely different text');
    const b = await publish(a.id, 'major');
    const cur = await owner.call(K.get, { params: { workspaceId: w, articleId: a.id } });
    const reverted = await owner.call(K.revert, { params: { workspaceId: w, articleId: a.id }, body: { versionId: a.published!.id } }, { ifMatch: cur.rowVersion });
    expect(reverted.draft?.versionNo).toBe(3);
    expect(JSON.stringify(reverted.draft?.body)).toContain('Always check the caption.');
    expect(reverted.published?.id).toBe(b.published!.id);
    const discarded = await owner.call(K.discardDraft, { params: { workspaceId: w, articleId: a.id }, body: {} }, { ifMatch: reverted.rowVersion });
    expect(discarded.draft).toBeNull();
  });

  it('lists owned articles and open reading on deactivation and transfers ownership', async () => {
    const { ws, w, owner, newArticle, publish } = await setup();
    const leaving = await memberClient(ws, 'viewer');
    const successor = await memberClient(ws, 'admin');
    const a = await publish((await newArticle({ ownerMembershipId: leaving.membershipId })).id);
    await owner.call(K.assignReading, { params: { workspaceId: w, articleId: a.id }, body: { versionId: a.published!.id, membershipIds: [leaving.membershipId] } });
    const ctx = (await memberJobContext(getAppServices(), w, ws.owner.membershipId))!;
    const ownerP = RESPONSIBILITY_PROVIDERS.get('knowledge.article_owner')!;
    const readP = RESPONSIBILITY_PROVIDERS.get('knowledge.reading')!;
    const owned = await ownerP.list(ctx, leaving.membershipId);
    const reading = await readP.list(ctx, leaving.membershipId);
    expect(owned.map((o) => o.entityId)).toEqual([a.id]);
    expect(reading).toHaveLength(1);
    await executeCommand(ctx, async (c) => {
      await ownerP.transfer(c, leaving.membershipId, [{ entityId: a.id, successorMembershipId: successor.membershipId }]);
      await readP.transfer(c, leaving.membershipId, reading.map((r) => ({ entityId: r.entityId, successorMembershipId: null })));
    });
    const after = await owner.call(K.get, { params: { workspaceId: w, articleId: a.id } });
    expect(after.owner.membershipId).toBe(successor.membershipId);
    expect(await readP.list(ctx, leaving.membershipId)).toHaveLength(0);
  });
});
