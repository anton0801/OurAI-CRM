import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { newIdempotencyKey } from '@castlane/api-client';
import { directionEndpoints, financeEndpoints as F, projectEndpoints } from '@castlane/api-contracts';
import { getAppServices } from '@castlane/application';
import { contentItems, financialAllocations, metricObservations, projects, publications, seasons, shifts, tasks } from '@castlane/database';
import { newId } from '@castlane/domain';
import { addMember, assignToProject, clientFor, createAccount, createDirection, createProject, createWorkspace, sessionFor } from '../../support';
import { onProject, postedEntry } from '../finance/helpers';
import { at, cumulativeBody, insertPublication, insightsFixture, isoDay, query, record, result } from '../insights/helpers';

const db = () => getAppServices().db;

const setup = async () => {
  const ws = await createWorkspace(db());
  const owner = await clientFor(await sessionFor(db(), ws.owner.userId));
  const directionId = await createDirection(db(), ws, 'AI Series');
  return { ws, owner, directionId };
};

describe('projects', () => {
  it('create is idempotent under double submit (T021)', async () => {
    const { ws, owner, directionId } = await setup();
    const key = newIdempotencyKey();
    const body = { name: 'Night Shift', type: 'series' as const, directionId, ownerMembershipId: ws.owner.membershipId, briefSummary: 'Thriller' };
    const [a, b] = await Promise.all([
      owner.attempt(projectEndpoints.create, { params: { workspaceId: ws.workspaceId }, body }, { idempotencyKey: key }),
      owner.attempt(projectEndpoints.create, { params: { workspaceId: ws.workspaceId }, body }, { idempotencyKey: key }),
    ]);
    const ok = [a, b].filter((r) => r.ok);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    for (const r of [a, b]) if (!r.ok) expect(r.code).toBe('OPERATION_IN_PROGRESS');
    const replay = await owner.call(projectEndpoints.create, { params: { workspaceId: ws.workspaceId }, body }, { idempotencyKey: key });
    expect(replay.id).toBe(ok[0]!.data!.id);
    const rows = await db().select().from(projects).where(eq(projects.workspaceId, ws.workspaceId));
    expect(rows).toHaveLength(1);
  });

  it('the same key with a different body is 409 and creates nothing (T163)', async () => {
    const { ws, owner, directionId } = await setup();
    const key = newIdempotencyKey();
    const body = { name: 'Night Shift', type: 'series' as const, directionId, ownerMembershipId: ws.owner.membershipId, briefSummary: 'Thriller' };
    const first = await owner.call(projectEndpoints.create, { params: { workspaceId: ws.workspaceId }, body }, { idempotencyKey: key });
    const mismatch = await owner.attempt(projectEndpoints.create, { params: { workspaceId: ws.workspaceId }, body: { ...body, name: 'Other' } }, { idempotencyKey: key });
    expect(mismatch.status).toBe(409);
    expect(mismatch.code).toBe('IDEMPOTENCY_PAYLOAD_MISMATCH');
    const rows = await db().select().from(projects).where(eq(projects.workspaceId, ws.workspaceId));
    expect(rows.map((r) => [r.id, r.name])).toEqual([[first.id, 'Night Shift']]);
  });

  it('requires If-Match and rejects stale versions (T164)', async () => {
    const { ws, owner, directionId } = await setup();
    const p = await owner.call(projectEndpoints.create, { params: { workspaceId: ws.workspaceId }, body: { name: 'Model A', type: 'model', directionId, ownerMembershipId: ws.owner.membershipId } });
    const missing = await owner.attempt(projectEndpoints.update, { params: { workspaceId: ws.workspaceId, projectId: p.id }, body: { name: 'Model B' } });
    expect(missing.status).toBe(428);
    const ok = await owner.call(projectEndpoints.update, { params: { workspaceId: ws.workspaceId, projectId: p.id }, body: { name: 'Model B' } }, { ifMatch: p.rowVersion });
    expect(ok.name).toBe('Model B');
    const stale = await owner.attempt(projectEndpoints.update, { params: { workspaceId: ws.workspaceId, projectId: p.id }, body: { name: 'Model C' } }, { ifMatch: p.rowVersion });
    expect(stale.status).toBe(412);
    expect(stale.code).toBe('VERSION_CONFLICT');
  });

  it('locks the type once seasons exist (T022)', async () => {
    const { ws, owner, directionId } = await setup();
    const p = await owner.call(projectEndpoints.create, { params: { workspaceId: ws.workspaceId }, body: { name: 'Series', type: 'series', directionId, ownerMembershipId: ws.owner.membershipId } });
    await db().insert(seasons).values({ id: newId(), workspaceId: ws.workspaceId, projectId: p.id, name: 'Season 1', orderNo: 1 });
    const detail = await owner.call(projectEndpoints.get, { params: { workspaceId: ws.workspaceId, projectId: p.id } });
    expect(detail.locked.type).toMatch(/Seasons/);
    const r = await owner.attempt(projectEndpoints.update, { params: { workspaceId: ws.workspaceId, projectId: p.id }, body: { type: 'model' } }, { ifMatch: detail.rowVersion });
    expect(r.status).toBe(409);
  });

  it('activation requires a brief; completion is blocked by scheduled work and reopening needs a reason', async () => {
    const { ws, owner, directionId } = await setup();
    const p = await owner.call(projectEndpoints.create, { params: { workspaceId: ws.workspaceId }, body: { name: 'Influencer', type: 'influencer', directionId, ownerMembershipId: ws.owner.membershipId } });
    const noBrief = await owner.attempt(projectEndpoints.transition, { params: { workspaceId: ws.workspaceId, projectId: p.id }, body: { targetState: 'active' } }, { ifMatch: p.rowVersion });
    expect(noBrief.status).toBe(409);
    const withBrief = await owner.call(projectEndpoints.update, { params: { workspaceId: ws.workspaceId, projectId: p.id }, body: { briefSummary: 'Lifestyle' } }, { ifMatch: p.rowVersion });
    const active = await owner.call(projectEndpoints.transition, { params: { workspaceId: ws.workspaceId, projectId: p.id }, body: { targetState: 'active' } }, { ifMatch: withBrief.rowVersion });
    expect(active.status).toBe('active');
    const done = await owner.call(projectEndpoints.transition, { params: { workspaceId: ws.workspaceId, projectId: p.id }, body: { targetState: 'completed' } }, { ifMatch: active.rowVersion });
    const reopen = await owner.attempt(projectEndpoints.transition, { params: { workspaceId: ws.workspaceId, projectId: p.id }, body: { targetState: 'active' } }, { ifMatch: done.rowVersion });
    expect(reopen.status).toBe(422);
    const archived = await owner.call(projectEndpoints.transition, { params: { workspaceId: ws.workspaceId, projectId: p.id }, body: { targetState: 'archived', reason: 'Season wrapped' } }, { ifMatch: done.rowVersion });
    expect(archived.status).toBe('archived');
    // Archived hidden by default, visible with includeArchived (T024 history remains).
    const list = await owner.call(projectEndpoints.list, { params: { workspaceId: ws.workspaceId }, query: {} });
    expect(list.items.find((i) => i.id === p.id)).toBeUndefined();
    const all = await owner.call(projectEndpoints.list, { params: { workspaceId: ws.workspaceId }, query: { includeArchived: true } });
    expect(all.items.find((i) => i.id === p.id)?.status).toBe('archived');
  });
});

describe('archiving an active project (T023)', () => {
  it('needs scheduled publications, active shifts and open high-priority work resolved first', async () => {
    const { ws, owner, directionId } = await setup();
    const W = { workspaceId: ws.workspaceId };
    const p = await createProject(db(), ws, { directionId, name: 'Night Shift', type: 'influencer' });
    await db().update(projects).set({ status: 'active', briefSummary: 'Lifestyle' }).where(eq(projects.id, p.id));
    const accountId = await createAccount(db(), ws, { projectId: p.id });
    const now = new Date();
    const taskId = newId();
    await db().insert(tasks).values({ id: taskId, workspaceId: ws.workspaceId, projectId: p.id, title: 'Cut the trailer', status: 'in_progress', priority: 'urgent', createdAt: now, updatedAt: now });
    const shiftId = newId();
    await db().insert(shifts).values({ id: shiftId, workspaceId: ws.workspaceId, projectId: p.id, primaryAccountId: accountId, membershipId: ws.owner.membershipId, scheduledStart: new Date(now.getTime() + 3_600_000), scheduledEnd: new Date(now.getTime() + 7_200_000), timezone: 'Europe/Berlin', state: 'scheduled', createdAt: now, updatedAt: now });
    const contentItemId = newId();
    await db().insert(contentItems).values({ id: contentItemId, workspaceId: ws.workspaceId, projectId: p.id, title: 'Teaser', format: 'short_video', stage: 'approved', ownerMembershipId: ws.owner.membershipId, createdAt: now, updatedAt: now });
    const publicationId = newId();
    await db().insert(publications).values({ id: publicationId, workspaceId: ws.workspaceId, contentItemId, accountId, projectId: p.id, ownerMembershipId: ws.owner.membershipId, status: 'scheduled', scheduledAt: new Date(now.getTime() + 86_400_000), createdAt: now, updatedAt: now });

    const detail = await owner.call(projectEndpoints.get, { params: { ...W, projectId: p.id } });
    // Active → Archived is not a direct transition: the project is completed first.
    const direct = await owner.attempt(projectEndpoints.transition, { params: { ...W, projectId: p.id }, body: { targetState: 'archived', reason: 'Wrapped' } }, { ifMatch: detail.rowVersion });
    expect(direct.status).toBe(409);
    const preview = await owner.call(projectEndpoints.archivePreview, { params: { ...W, projectId: p.id } });
    expect(preview.items.filter((i) => i.blocking).map((i) => i.kind).sort()).toEqual(['active_shifts', 'open_tasks', 'scheduled_publications']);
    const blocked = await owner.attempt(projectEndpoints.transition, { params: { ...W, projectId: p.id }, body: { targetState: 'completed' } }, { ifMatch: detail.rowVersion });
    expect(blocked.status).toBe(409);
    expect((blocked.error as unknown as { details: { items: { kind: string }[] } }).details.items.map((i) => i.kind).sort()).toEqual(['active_shifts', 'open_tasks', 'scheduled_publications']);
    expect((await db().select().from(projects).where(eq(projects.id, p.id)))[0]?.status).toBe('active');

    // Untangle: the task is done, the shift and the placement cancelled → complete, then archive.
    await db().update(tasks).set({ status: 'done', completedAt: now }).where(eq(tasks.id, taskId));
    await db().update(shifts).set({ state: 'cancelled' }).where(eq(shifts.id, shiftId));
    await db().update(publications).set({ status: 'cancelled' }).where(eq(publications.id, publicationId));
    expect((await owner.call(projectEndpoints.archivePreview, { params: { ...W, projectId: p.id } })).items.filter((i) => i.blocking)).toEqual([]);
    const done = await owner.call(projectEndpoints.transition, { params: { ...W, projectId: p.id }, body: { targetState: 'completed' } }, { ifMatch: detail.rowVersion });
    const archived = await owner.call(projectEndpoints.transition, { params: { ...W, projectId: p.id }, body: { targetState: 'archived', reason: 'Wrapped' } }, { ifMatch: done.rowVersion });
    expect(archived.status).toBe('archived');
  });
});

describe('archiving a completed project (T024)', () => {
  it('keeps its historical analytics and finance readable and unchanged', async () => {
    const f = await insightsFixture();
    const W = f.p;
    // History: a publication with metric observations, and a posted expense allocated to the project.
    const pub = await insertPublication(f, { publishedAt: at(9, 12) });
    await record(f.owner, f, cumulativeBody(pub, at(8, 12), { 'publication.views': '100' }));
    await record(f.owner, f, cumulativeBody(pub, at(5, 12), { 'publication.views': '160' }));
    const fm = await addMember(db(), f.ws, { roleKey: 'finance_manager' });
    const fmc = await clientFor(await sessionFor(db(), fm.userId));
    const cats = await f.owner.call(F.categoriesList, { params: W, query: {} });
    const expense = await postedEntry(fmc, f.owner, W, {
      type: 'expense',
      title: 'Voice-over session',
      recognitionDate: isoDay(6),
      lines: [{ categoryId: cats.find((c) => c.key === 'production_services')!.id, amount: '250.00', currency: 'EUR' }],
      allocation: onProject(f.projectId),
    });
    const period = { periodStart: isoDay(10), periodEnd: isoDay(1) };
    const snapshot = async () => {
      const q = await query(f.owner, f, ['M01', 'M15'], 10, 1, { projectIds: [f.projectId] });
      const entries = await f.owner.call(F.entriesList, { params: W, query: { projectId: f.projectId } });
      const summary = await f.owner.call(F.projectSummary, { params: { ...W, projectId: f.projectId }, query: period });
      const allocations = await db().select().from(financialAllocations).where(eq(financialAllocations.entryId, expense.id));
      return {
        published: result(q, 'M01').total,
        views: result(q, 'M15').total,
        entries: entries.items.map((e) => [e.id, e.state]),
        expenses: summary.accrual?.operatingExpenses,
        recent: summary.recentEntries?.map((e) => e.id),
        allocations: allocations.map((a) => [a.projectId, a.amountMinor]),
      };
    };
    const before = await snapshot();
    expect(before.published).toMatchObject({ status: 'known', value: '1' });
    expect(before.views).toMatchObject({ status: 'known', value: '60' });
    expect(before.entries).toEqual([[expense.id, 'posted']]);
    expect(before.expenses?.amount).toBe('250.00');
    expect(before.allocations).toEqual([[f.projectId, 25000n]]);

    // Complete, then archive the project.
    const detail = await f.owner.call(projectEndpoints.get, { params: { ...W, projectId: f.projectId } });
    const done = await f.owner.call(projectEndpoints.transition, { params: { ...W, projectId: f.projectId }, body: { targetState: 'completed' } }, { ifMatch: detail.rowVersion });
    const archived = await f.owner.call(projectEndpoints.transition, { params: { ...W, projectId: f.projectId }, body: { targetState: 'archived', reason: 'Season wrapped' } }, { ifMatch: done.rowVersion });
    expect(archived.status).toBe('archived');

    // The same analytics and finance, read after archiving, are identical.
    expect(await snapshot()).toEqual(before);
    expect((await f.owner.call(projectEndpoints.get, { params: { ...W, projectId: f.projectId } })).status).toBe('archived');
    expect((await f.owner.call(F.entriesGet, { params: { ...W, entryId: expense.id } })).state).toBe('posted');
    const observations = await db().select().from(metricObservations).where(eq(metricObservations.entityId, pub));
    expect(observations.map((o) => o.projectId)).toEqual([f.projectId, f.projectId]);
  });
});

describe('project access scope', () => {
  it('scoped roles see only their projects; out-of-scope ids are 404; budget field absent without finance rights (T016)', async () => {
    const { ws } = await setup();
    const dirA = await createDirection(db(), ws, 'A');
    const dirB = await createDirection(db(), ws, 'B');
    const pa = await createProject(db(), ws, { directionId: dirA, name: 'Alpha' });
    const pb = await createProject(db(), ws, { directionId: dirB, name: 'Beta' });
    const lead = await addMember(db(), ws, { roleKey: 'direction_lead', scopeType: 'direction', scopeId: dirA });
    const creator = await addMember(db(), ws, { roleKey: 'creator', scopeType: 'assigned_projects' });
    await assignToProject(db(), ws, pb.id, creator.membershipId);

    const leadC = await clientFor(await sessionFor(db(), lead.userId));
    const leadList = await leadC.call(projectEndpoints.list, { params: { workspaceId: ws.workspaceId }, query: {} });
    expect(leadList.items.map((i) => i.name)).toEqual(['Alpha']);
    expect('budget' in leadList.items[0]!).toBe(false);
    const foreign = await leadC.attempt(projectEndpoints.get, { params: { workspaceId: ws.workspaceId, projectId: pb.id } });
    expect(foreign.status).toBe(404);

    const creatorC = await clientFor(await sessionFor(db(), creator.userId));
    const cList = await creatorC.call(projectEndpoints.list, { params: { workspaceId: ws.workspaceId }, query: {} });
    expect(cList.items.map((i) => i.name)).toEqual(['Beta']);
    const cannotEdit = await creatorC.attempt(projectEndpoints.update, { params: { workspaceId: ws.workspaceId, projectId: pb.id }, body: { name: 'Valid name' } }, { ifMatch: 1 });
    expect(cannotEdit.status).toBe(403);
    const cannotSeeA = await creatorC.attempt(projectEndpoints.update, { params: { workspaceId: ws.workspaceId, projectId: pa.id }, body: { name: 'Valid name' } }, { ifMatch: 1 });
    expect(cannotSeeA.status).toBe(404);
  });

  it('a workspace id the member does not belong to is 404 (T015)', async () => {
    const { owner } = await setup();
    const other = await createWorkspace(db());
    const r = await owner.attempt(projectEndpoints.list, { params: { workspaceId: other.workspaceId }, query: {} });
    expect(r.status).toBe(404);
  });

  it('revoking a role takes effect on the next read and write, with zero mutation (T017)', async () => {
    const { ws, directionId } = await setup();
    const p = await createProject(db(), ws, { directionId, name: 'Night Shift' });
    const lead = await addMember(db(), ws, { roleKey: 'project_lead', scopeType: 'assigned_projects' });
    await assignToProject(db(), ws, p.id, lead.membershipId);
    const c = await clientFor(await sessionFor(db(), lead.userId));
    const W = { workspaceId: ws.workspaceId };
    expect((await c.attempt(projectEndpoints.list, { params: W, query: {} })).ok).toBe(true);
    // The open tab still holds the record and its version; the edit it was about to save worked a moment ago.
    const open = await c.call(projectEndpoints.get, { params: { ...W, projectId: p.id } });
    const edited = await c.call(projectEndpoints.update, { params: { ...W, projectId: p.id }, body: { description: 'First pass' } }, { ifMatch: open.rowVersion });
    await db().execute(`UPDATE role_assignments SET revoked_at = now() WHERE membership_id = '${lead.membershipId}'`);
    const after = await c.attempt(projectEndpoints.list, { params: W, query: {} });
    expect(after.status).toBe(403);
    expect((await c.attempt(projectEndpoints.get, { params: { ...W, projectId: p.id } })).ok).toBe(false);
    const write = await c.attempt(projectEndpoints.update, { params: { ...W, projectId: p.id }, body: { name: 'Renamed after revoke', description: 'Second pass' } }, { ifMatch: edited.rowVersion });
    expect(write.ok).toBe(false);
    expect([403, 404]).toContain(write.status);
    const create = await c.attempt(projectEndpoints.create, { params: W, body: { name: 'Sneaky project', type: 'series', directionId, ownerMembershipId: lead.membershipId } });
    expect(create.ok).toBe(false);
    const [row] = await db().select().from(projects).where(eq(projects.id, p.id));
    expect(row).toMatchObject({ name: 'Night Shift', description: 'First pass', rowVersion: edited.rowVersion });
    expect(await db().select().from(projects).where(eq(projects.workspaceId, ws.workspaceId))).toHaveLength(1);
  });

  it('direction names must be unique among active directions', async () => {
    const { ws, owner } = await setup();
    const dup = await owner.attempt(directionEndpoints.create, { params: { workspaceId: ws.workspaceId }, body: { name: 'ai series' } });
    expect(dup.status).toBe(409);
  });
});
