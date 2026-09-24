import { afterEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { accountEndpoints, projectEndpoints, teamEndpoints } from '@castlane/api-contracts';
import { getAppServices } from '@castlane/application';
import { accountAssignments, projects, roleAssignments } from '@castlane/database';
import {
  addMember,
  clientFor,
  createAccount,
  createDirection,
  createProject,
  createWorkspace,
  mutableClock,
  resetClock,
  sessionFor,
  type TestClient,
} from '../../support';

/**
 * Access snapshot cache (load profile): snapshots are cached per workspace access revision (bumped by triggers in the
 * changing transaction). Every path below warms the cache first, then changes access and expects
 * the very next request to see the change.
 */
const db = () => getAppServices().db;
const signedIn = async (userId: string) => clientFor(await sessionFor(db(), userId));

/** Count queries of the member's grant rows, to prove warm requests are served from the cache. */
const countGrantQueries = async <T>(fn: () => Promise<T>): Promise<{ result: T; grantQueries: number }> => {
  const pool = (db() as unknown as { $client: { query: (...a: unknown[]) => Promise<unknown> } }).$client;
  const original = pool.query.bind(pool);
  let grantQueries = 0;
  pool.query = (...a: unknown[]) => {
    const text = typeof a[0] === 'string' ? a[0] : ((a[0] as { text?: string }).text ?? '');
    if (/from "role_assignments"/.test(text)) grantQueries++;
    return original(...a);
  };
  try {
    return { result: await fn(), grantQueries };
  } finally {
    pool.query = original;
  }
};

const get = (c: TestClient, workspaceId: string, projectId: string) =>
  c.attempt(projectEndpoints.get, { params: { workspaceId, projectId } });

afterEach(() => resetClock());

describe('access snapshot cache', () => {
  it('serves warm requests from the cache; revoking a role applies to the very next request (T017)', async () => {
    const ws = await createWorkspace(db());
    const owner = await signedIn(ws.owner.userId);
    const viewer = await addMember(db(), ws, { roleKey: 'viewer' });
    const vc = await signedIn(viewer.userId);
    const params = { workspaceId: ws.workspaceId };
    expect((await vc.attempt(projectEndpoints.list, { params, query: {} })).status).toBe(200);
    const warm = await countGrantQueries(() => vc.attempt(projectEndpoints.list, { params, query: {} }));
    expect(warm.result.status).toBe(200);
    expect(warm.grantQueries).toBe(0);

    const [grant] = await db()
      .select()
      .from(roleAssignments)
      .where(eq(roleAssignments.membershipId, viewer.membershipId));
    await owner.call(
      teamEndpoints.revokeRole,
      { params: { ...params, assignmentId: grant!.id }, body: { reason: 'Left the team' } },
      { ifMatch: grant!.rowVersion },
    );
    expect((await vc.attempt(projectEndpoints.list, { params, query: {} })).status).toBe(403);
  });

  it('a grant changed outside the application code (direct SQL) still applies to the next request', async () => {
    const ws = await createWorkspace(db());
    const viewer = await addMember(db(), ws, { roleKey: 'viewer' });
    const vc = await signedIn(viewer.userId);
    const params = { workspaceId: ws.workspaceId };
    expect((await vc.attempt(projectEndpoints.list, { params, query: {} })).status).toBe(200);
    expect((await vc.attempt(projectEndpoints.list, { params, query: {} })).status).toBe(200);
    // The trigger bumps the workspace revision in this statement's transaction; memberships.access_revision is untouched.
    await db()
      .update(roleAssignments)
      .set({ revokedAt: new Date() })
      .where(eq(roleAssignments.membershipId, viewer.membershipId));
    expect((await vc.attempt(projectEndpoints.list, { params, query: {} })).status).toBe(403);
  });

  it('moving a project to another direction changes direction-scoped access on the next request', async () => {
    const ws = await createWorkspace(db());
    const owner = await signedIn(ws.owner.userId);
    const dirA = await createDirection(db(), ws, 'Direction A');
    const dirB = await createDirection(db(), ws, 'Direction B');
    const p = await createProject(db(), ws, { directionId: dirA, name: 'Moving Project' });
    const leadA = await addMember(db(), ws, {
      roleKey: 'direction_lead',
      scopeType: 'direction',
      scopeId: dirA,
    });
    const leadB = await addMember(db(), ws, {
      roleKey: 'direction_lead',
      scopeType: 'direction',
      scopeId: dirB,
    });
    const a = await signedIn(leadA.userId);
    const b = await signedIn(leadB.userId);
    const listed = async (c: TestClient) =>
      (await c.call(projectEndpoints.list, { params: { workspaceId: ws.workspaceId }, query: {} })).items.map(
        (x) => x.id,
      );
    for (let i = 0; i < 2; i++) {
      expect((await get(a, ws.workspaceId, p.id)).status).toBe(200);
      expect((await get(b, ws.workspaceId, p.id)).status).toBe(404);
      // Direction-scoped lists resolve project ids from the cached project → direction structure.
      expect(await listed(a)).toContain(p.id);
      expect(await listed(b)).not.toContain(p.id);
    }
    const [row] = await db().select().from(projects).where(eq(projects.id, p.id));
    await owner.call(
      projectEndpoints.transferDirection,
      {
        params: { workspaceId: ws.workspaceId, projectId: p.id },
        body: { directionId: dirB, reason: 'Reorganised directions' },
      },
      { ifMatch: row!.rowVersion },
    );
    expect((await get(a, ws.workspaceId, p.id)).status).toBe(404);
    expect((await get(b, ws.workspaceId, p.id)).status).toBe(200);
    expect(await listed(a)).not.toContain(p.id);
    expect(await listed(b)).toContain(p.id);
  });

  it('a project added to a direction by any path (direct insert) appears in the direction lead’s list on the next request', async () => {
    const ws = await createWorkspace(db());
    const dir = await createDirection(db(), ws, 'Direction C');
    await createProject(db(), ws, { directionId: dir, name: 'Existing Project' });
    const lead = await addMember(db(), ws, {
      roleKey: 'direction_lead',
      scopeType: 'direction',
      scopeId: dir,
    });
    const c = await signedIn(lead.userId);
    const listed = async () =>
      (await c.call(projectEndpoints.list, { params: { workspaceId: ws.workspaceId }, query: {} })).items.map(
        (x) => x.name,
      );
    expect(await listed()).toEqual(['Existing Project']);
    expect(await listed()).toEqual(['Existing Project']);
    await createProject(db(), ws, { directionId: dir, name: 'Imported Project' });
    expect((await listed()).sort()).toEqual(['Existing Project', 'Imported Project']);
  });

  it('reassigning an account moves account-scoped access on the next request', async () => {
    const ws = await createWorkspace(db());
    const owner = await signedIn(ws.owner.userId);
    const p = await createProject(db(), ws, { name: 'Accounts Project' });
    const accountId = await createAccount(db(), ws, { projectId: p.id });
    const first = await addMember(db(), ws, { roleKey: 'publisher', scopeType: 'assigned_accounts' });
    const second = await addMember(db(), ws, { roleKey: 'publisher', scopeType: 'assigned_accounts' });
    const params = { workspaceId: ws.workspaceId, accountId };
    const assigned = await owner.call(accountEndpoints.assign, {
      params,
      body: { membershipId: first.membershipId, duty: 'publishing' },
    });
    const c1 = await signedIn(first.userId);
    const c2 = await signedIn(second.userId);
    for (let i = 0; i < 2; i++) {
      expect((await c1.attempt(accountEndpoints.get, { params })).status).toBe(200);
      expect((await c2.attempt(accountEndpoints.get, { params })).status).toBe(404);
    }
    await owner.call(accountEndpoints.endAssignment, {
      params: { ...params, assignmentId: assigned.id },
      body: { reason: 'Handed over' },
    });
    await owner.call(accountEndpoints.assign, {
      params,
      body: { membershipId: second.membershipId, duty: 'publishing' },
    });
    expect((await c1.attempt(accountEndpoints.get, { params })).status).toBe(404);
    expect((await c2.attempt(accountEndpoints.get, { params })).status).toBe(200);
    const open = await db()
      .select()
      .from(accountAssignments)
      .where(and(eq(accountAssignments.accountId, accountId), sql`${accountAssignments.validTo} IS NULL`));
    expect(open.map((r) => r.membershipId)).toEqual([second.membershipId]);
  });

  it('a time-bounded grant expires on time without any write (validity evaluated per request)', async () => {
    const clock = mutableClock('2026-03-02T09:00:00.000Z');
    const ws = await createWorkspace(db());
    const viewer = await addMember(db(), ws, { roleKey: 'viewer' });
    await db()
      .update(roleAssignments)
      .set({ validFrom: new Date('2026-03-01T00:00:00.000Z'), validTo: new Date('2026-03-02T10:00:00.000Z') })
      .where(eq(roleAssignments.membershipId, viewer.membershipId));
    const vc = await signedIn(viewer.userId);
    const params = { workspaceId: ws.workspaceId };
    expect((await vc.attempt(projectEndpoints.list, { params, query: {} })).status).toBe(200);
    expect((await vc.attempt(projectEndpoints.list, { params, query: {} })).status).toBe(200);
    clock.advance(61);
    expect((await vc.attempt(projectEndpoints.list, { params, query: {} })).status).not.toBe(200);
  });
});
