import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { authEndpoints, mediaEndpoints, projectEndpoints, shellEndpoints } from '@castlane/api-contracts';
import { getAppServices } from '@castlane/application';
import { projects } from '@castlane/database';
import { TestClient, addMember, assignToProject, clientFor, createDirection, createProject, createUser, createWorkspace, sessionFor, DEFAULT_TEST_PASSWORD } from '../support';

const db = () => getAppServices().db;

describe('API security', () => {
  it('rejects state changes without CSRF token or from another origin, with zero mutation (T161)', async () => {
    const ws = await createWorkspace(db());
    const owner = await clientFor(await sessionFor(db(), ws.owner.userId));
    const directionId = await createDirection(db(), ws, 'AI Series');
    const path = `/workspaces/${ws.workspaceId}/projects`;
    const body = { name: 'CSRF Probe', type: 'series', directionId, ownerMembershipId: ws.owner.membershipId };
    const idem = () => ({ 'idempotency-key': crypto.randomUUID() });

    const noToken = await owner.raw('POST', path, { body, headers: { ...idem(), 'x-csrf-token': '' } });
    expect(noToken.status).toBe(403);
    expect((await noToken.json()).error.code).toBe('CSRF_REJECTED');

    const wrongToken = await owner.raw('POST', path, { body, headers: { ...idem(), 'x-csrf-token': 'forged' } });
    expect(wrongToken.status).toBe(403);

    const foreign = await owner.raw('POST', path, { body, headers: { ...idem(), origin: 'https://evil.example' } });
    expect(foreign.status).toBe(403);

    const crossSite = await owner.raw('POST', path, { body, headers: { ...idem(), origin: 'none', 'sec-fetch-site': 'cross-site' } });
    expect(crossSite.status).toBe(403);

    const rows = await db().select().from(projects).where(eq(projects.workspaceId, ws.workspaceId));
    expect(rows).toHaveLength(0);
  });

  it('never reveals or links objects of another workspace (T015)', async () => {
    const a = await createWorkspace(db());
    const b = await createWorkspace(db());
    const ownerA = await clientFor(await sessionFor(db(), a.owner.userId));
    const { id: projectB, directionId: directionB } = await createProject(db(), b, { name: 'Secret B' });

    // Object id from B inside A's path → 404 (existence not revealed).
    const read = await ownerA.attempt(projectEndpoints.get, { params: { workspaceId: a.workspaceId, projectId: projectB } });
    expect(read.status).toBe(404);
    // B's workspace path for a non-member → no access.
    const foreignWs = await ownerA.attempt(projectEndpoints.list, { params: { workspaceId: b.workspaceId }, query: {} });
    expect([403, 404]).toContain(foreignWs.status);
    // Referencing B's direction while creating in A → rejected, nothing written in either workspace.
    const link = await ownerA.attempt(projectEndpoints.create, {
      params: { workspaceId: a.workspaceId },
      body: { name: 'Cross link', type: 'series', directionId: directionB, ownerMembershipId: a.owner.membershipId },
    });
    expect(link.ok).toBe(false);
    expect([404, 422]).toContain(link.status);
    expect(await db().select().from(projects).where(eq(projects.workspaceId, a.workspaceId))).toHaveLength(0);
    // Search in A never returns B's records.
    const found = await ownerA.call(shellEndpoints.search, { params: { workspaceId: a.workspaceId }, query: { q: 'Secret' } });
    expect(JSON.stringify(found)).not.toContain(projectB);
  });

  it('search never leaks titles, snippets or counts of out-of-scope objects (T159)', async () => {
    const ws = await createWorkspace(db());
    const directionId = await createDirection(db(), ws, 'AI Models');
    const { id: visible } = await createProject(db(), ws, { name: 'Aurora visible', directionId });
    const { id: hidden } = await createProject(db(), ws, { name: 'Aurora hidden', directionId });
    const lead = await addMember(db(), ws, { roleKey: 'project_lead', scopeType: 'assigned_projects' });
    await assignToProject(db(), ws, visible, lead.membershipId);
    // Index both projects the way the application does (rename through the API as owner).
    const owner = await clientFor(await sessionFor(db(), ws.owner.userId));
    for (const id of [visible, hidden]) {
      const p = await owner.call(projectEndpoints.get, { params: { workspaceId: ws.workspaceId, projectId: id } });
      await owner.call(projectEndpoints.update, { params: { workspaceId: ws.workspaceId, projectId: id }, body: { description: 'indexed' } }, { ifMatch: p.rowVersion });
    }
    const client = await clientFor(await sessionFor(db(), lead.userId));
    const r = await client.call(shellEndpoints.search, { params: { workspaceId: ws.workspaceId }, query: { q: 'Aurora' } });
    const text = JSON.stringify(r);
    expect(text).toContain(visible);
    expect(text).not.toContain(hidden);
    expect(text).not.toContain('Aurora hidden');
  });

  it('rejects javascript:, data: and file: links (T160)', async () => {
    const ws = await createWorkspace(db());
    const owner = await clientFor(await sessionFor(db(), ws.owner.userId));
    for (const url of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'file:///etc/passwd', 'JaVaScRiPt:alert(1)']) {
      const r = await owner.attempt(mediaEndpoints.externalLink, { params: { workspaceId: ws.workspaceId }, body: { url, title: 'Bad link' } });
      expect(r.status, url).toBe(422);
    }
  });

  it('requires a session for workspace data and sets hardened session cookies', async () => {
    const ws = await createWorkspace(db());
    const anonymous = await new TestClient().init();
    const r = await anonymous.attempt(projectEndpoints.list, { params: { workspaceId: ws.workspaceId }, query: {} });
    expect(r.status).toBe(401);

    const user = await createUser(db(), { email: `cookie-${crypto.randomUUID().slice(0, 6)}@test.invalid` });
    const c = await new TestClient().init();
    await c.call(authEndpoints.signIn, { body: { email: user.email, password: DEFAULT_TEST_PASSWORD } });
    const setCookie = c.lastHeaders?.getSetCookie().find((s) => s.startsWith('castlane_session=')) ?? '';
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).toMatch(/Path=\//i);
  });

  it('does not reveal whether an e-mail exists on password recovery (T007)', async () => {
    const user = await createUser(db(), { email: `known-${crypto.randomUUID().slice(0, 6)}@test.invalid` });
    const c = await new TestClient().init();
    const known = await c.attempt(authEndpoints.recovery, { body: { email: user.email } });
    const unknown = await c.attempt(authEndpoints.recovery, { body: { email: `nobody-${crypto.randomUUID().slice(0, 6)}@test.invalid` } });
    expect(known.status).toBe(unknown.status);
    expect(JSON.stringify(known.data)).toBe(JSON.stringify(unknown.data));
  });

  it('keeps the error envelope free of internals for malformed input', async () => {
    const ws = await createWorkspace(db());
    const owner = await clientFor(await sessionFor(db(), ws.owner.userId));
    const res = await owner.raw('GET', `/workspaces/${ws.workspaceId}/projects/not-a-uuid`);
    expect([400, 404, 422]).toContain(res.status);
    const text = await res.text();
    expect(text).not.toMatch(/stack|at .*\.ts|SELECT|postgres/i);
  });
});
