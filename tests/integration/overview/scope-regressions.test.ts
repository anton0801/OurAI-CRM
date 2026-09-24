import { describe, expect, it } from 'vitest';
import { overviewEndpoints as O, type OverviewResponse } from '@castlane/api-contracts';
import { EXPORT_DATASETS_REGISTRY, getAppServices, memberJobContext } from '@castlane/application';
import { characters, contentItems, publications, reviews, tasks } from '@castlane/database';
import { newId } from '@castlane/domain';
import { addMember, assignToProject, clientFor, createAccount, createDirection, createProject, createWorkspace, sessionFor, type TestWorkspace } from '../../support';

const db = () => getAppServices().db;
const HOUR = 3_600_000;

const insertTask = async (ws: TestWorkspace, projectId: string, input: Partial<typeof tasks.$inferInsert> = {}) => {
  const at = new Date();
  await db().insert(tasks).values({ id: newId(), workspaceId: ws.workspaceId, projectId, title: `Task ${newId().slice(0, 4)}`, status: 'in_progress', createdAt: at, updatedAt: at, ...input });
};

const pendingReview = async (ws: TestWorkspace, projectId: string, targetType: 'content_version' | 'character_version', subjectId: string) => {
  await db()
    .insert(reviews)
    .values({
      id: newId(),
      workspaceId: ws.workspaceId,
      targetType,
      targetId: newId(),
      subjectId,
      projectId,
      roundNo: 1,
      status: 'pending',
      reviewerMembershipId: ws.owner.membershipId,
      submittedAt: new Date(Date.now() - 72 * HOUR),
      policySnapshot: { steps: ['release_approval'], allowSelfReview: false, requiredApprovals: 1 },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
};

/** Project Alpha: two open tasks (one overdue) plus an archived overdue one, a pending content review and a pending profile review, one published placement. */
const seed = async () => {
  const ws = await createWorkspace(db());
  const owner = await clientFor(await sessionFor(db(), ws.owner.userId));
  const directionId = await createDirection(db(), ws, 'AI Models');
  const a = (await createProject(db(), ws, { directionId, name: 'Alpha Model', type: 'model' })).id;
  const accA = await createAccount(db(), ws, { projectId: a });
  const now = Date.now();
  await insertTask(ws, a, { dueAt: new Date(now - 5 * HOUR) });
  await insertTask(ws, a, { dueAt: new Date(now + 50 * HOUR) });
  await insertTask(ws, a, { dueAt: new Date(now - 5 * HOUR), archivedAt: new Date() });
  const contentId = newId();
  await db().insert(contentItems).values({ id: contentId, workspaceId: ws.workspaceId, projectId: a, title: 'Morning Routine Reel', format: 'short_video', stage: 'review', ownerMembershipId: ws.owner.membershipId });
  await pendingReview(ws, a, 'content_version', contentId);
  const characterId = newId();
  await db().insert(characters).values({ id: characterId, workspaceId: ws.workspaceId, projectId: a, name: 'Emma' });
  await pendingReview(ws, a, 'character_version', characterId);
  await db()
    .insert(publications)
    .values({ id: newId(), workspaceId: ws.workspaceId, contentItemId: contentId, accountId: accA, projectId: a, ownerMembershipId: ws.owner.membershipId, status: 'published', actualPublishedAt: new Date(now - 2 * HOUR) });
  const scoped = async (roleKey: string) => {
    const m = await addMember(db(), ws, { roleKey, scopeType: 'assigned_projects' });
    await assignToProject(db(), ws, a, m.membershipId);
    return { ...m, client: await clientFor(await sessionFor(db(), m.userId)) };
  };
  return { ws, owner, W: { workspaceId: ws.workspaceId }, a, scoped };
};

const overview = (c: Awaited<ReturnType<typeof clientFor>>, W: { workspaceId: string }) => c.call(O.get, { params: W, query: { period: 'last_7_days' } });
const pendingKpi = (o: OverviewResponse) => o.kpis.find((k) => k.key === 'pending_reviews')?.value.value ?? null;
const waiting = (o: OverviewResponse) => o.needsAttention.counts.find((c) => c.kind === 'review_waiting')?.count ?? null;
const exportRows = async (ws: TestWorkspace, membershipId: string) => {
  const ctx = (await memberJobContext(getAppServices(), ws.workspaceId, membershipId))!;
  const rows: Record<string, unknown>[] = [];
  for await (const r of EXPORT_DATASETS_REGISTRY.get('overview_projects')!.rows(ctx, { filters: {}, boundAt: new Date(Date.now() + 1000), fields: [] })) rows.push(r);
  return rows.map((r) => ({ project: r.project, open: r.open_tasks, overdue: r.overdue_tasks, pending: r.pending_reviews, lastPublication: r.last_publication_at !== null }));
};

describe('overview scope regressions', () => {
  it('the Owner sees every count; the export matches the screen (archived tasks excluded)', async () => {
    const f = await seed();
    const o = await overview(f.owner, f.W);
    expect(o.projects.items.map((p) => [p.name, p.openTasks, p.overdueTasks, p.lastPublicationAt !== null])).toEqual([['Alpha Model', 2, 1, true]]);
    expect(pendingKpi(o)).toBe('2');
    expect(waiting(o)).toBe(2);
    expect(await exportRows(f.ws, f.ws.owner.membershipId)).toEqual([{ project: 'Alpha Model', open: 2, overdue: 1, pending: 2, lastPublication: true }]);
  });

  it('per-project task counts follow tasks.read; profile reviews need characters.read (T159)', async () => {
    const f = await seed();
    // Analyst: projects/content/publications read on Alpha, but no tasks.read and no characters.read.
    const analyst = await f.scoped('analyst');
    const o = await overview(analyst.client, f.W);
    expect(o.projects.items.map((p) => [p.name, p.openTasks, p.overdueTasks, p.lastPublicationAt !== null])).toEqual([['Alpha Model', 0, 0, true]]);
    expect(pendingKpi(o)).toBe('1');
    expect(waiting(o)).toBe(1);
    expect(o.needsAttention.items.filter((i) => i.kind === 'review_waiting').map((i) => i.title)).toEqual(['Morning Routine Reel']);
    expect(await exportRows(f.ws, analyst.membershipId)).toEqual([{ project: 'Alpha Model', open: 0, overdue: 0, pending: 1, lastPublication: true }]);
  });

  it('the last publication date follows publications.read', async () => {
    const f = await seed();
    // Creator: tasks, content and characters on Alpha, but no publications.read.
    const creator = await f.scoped('creator');
    const o = await overview(creator.client, f.W);
    expect(o.projects.items.map((p) => [p.name, p.openTasks, p.overdueTasks, p.lastPublicationAt])).toEqual([['Alpha Model', 2, 1, null]]);
    expect(pendingKpi(o)).toBe('2');
    expect(await exportRows(f.ws, creator.membershipId)).toEqual([{ project: 'Alpha Model', open: 2, overdue: 1, pending: 2, lastPublication: false }]);
  });
});
