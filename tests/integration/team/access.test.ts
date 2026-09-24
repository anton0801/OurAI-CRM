import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { newIdempotencyKey } from '@castlane/api-client';
import { projectEndpoints, roleEndpoints, setupEndpoints, teamEndpoints } from '@castlane/api-contracts';
import { membershipStillActive } from '@castlane/application';
import { eventStream, memberships, roleAssignments } from '@castlane/database';
import { addMember, assignToProject, createDirection, createProject } from '../../support';
import { db, expireRecentAuth, ownerSetup, signedIn } from './helpers';

describe('role grants and effective access', () => {
  it('grants a scoped role, explains access and applies it on the next request (idempotent replay)', async () => {
    const { ws, owner } = await ownerSetup();
    const dir = await createDirection(db(), ws, 'AI Series');
    const p = await createProject(db(), ws, { directionId: dir, name: 'Night Shift' });
    const viewer = await addMember(db(), ws, { roleKey: 'creator', scopeType: 'assigned_object', name: 'Vera Viewer' });
    const vc = await signedIn(viewer.userId);
    const before = await vc.attempt(projectEndpoints.get, { params: { workspaceId: ws.workspaceId, projectId: p.id } });
    expect(before.status).toBe(404);

    const lead = await ws.roleId('direction_lead');
    const key = newIdempotencyKey();
    const body = { membershipId: viewer.membershipId, roleId: lead, scopeType: 'direction' as const, scopeId: dir, reason: 'Leads the series direction' };
    const g = await owner.call(teamEndpoints.grantRole, { params: { workspaceId: ws.workspaceId }, body }, { idempotencyKey: key });
    expect(g.roleKey).toBe('direction_lead');
    expect(g.scopeLabel).toBe('Direction: AI Series');
    const replay = await owner.call(teamEndpoints.grantRole, { params: { workspaceId: ws.workspaceId }, body }, { idempotencyKey: key });
    expect(replay.id).toBe(g.id);
    const rows = await db().select().from(roleAssignments).where(eq(roleAssignments.membershipId, viewer.membershipId));
    expect(rows).toHaveLength(2);
    const dup = await owner.attempt(teamEndpoints.grantRole, { params: { workspaceId: ws.workspaceId }, body });
    expect(dup.code).toBe('DUPLICATE');

    // The open session of the member sees the change on its very next request.
    expect((await vc.attempt(projectEndpoints.get, { params: { workspaceId: ws.workspaceId, projectId: p.id } })).ok).toBe(true);

    const access = await owner.call(teamEndpoints.access, { params: { workspaceId: ws.workspaceId, membershipId: viewer.membershipId } });
    expect(access.grants.map((x) => x.roleKey).sort()).toEqual(['creator', 'direction_lead']);
    const projectsRead = access.groups.flatMap((x) => x.permissions).find((x) => x.key === 'projects.read')!;
    expect(projectsRead.held).toBe(true);
    expect(projectsRead.via.map((v) => v.scopeLabel)).toContain('Direction: AI Series');
    const financeRead = access.groups.flatMap((x) => x.permissions).find((x) => x.key === 'finance.read')!;
    expect(financeRead.held).toBe(false);
    expect(financeRead.sensitive).toBe(true);

    const ev = await owner.call(teamEndpoints.evaluateAccess, {
      params: { workspaceId: ws.workspaceId },
      body: { membershipId: viewer.membershipId, permissions: ['projects.update', 'finance.read'], object: { type: 'project', id: p.id } },
    });
    expect(ev.object?.label).toBe('Project: Night Shift');
    expect(ev.results[0]).toMatchObject({ permission: 'projects.update', allowed: true, viaRole: 'direction_lead', viaScope: 'direction' });
    expect(ev.results[1]).toMatchObject({ permission: 'finance.read', allowed: false });
  });

  it('role revoked while a tab is open: next reads/writes are refused and the stream is told (T017)', async () => {
    const { ws, owner } = await ownerSetup();
    const viewer = await addMember(db(), ws, { roleKey: 'viewer' });
    const vc = await signedIn(viewer.userId);
    expect((await vc.attempt(projectEndpoints.list, { params: { workspaceId: ws.workspaceId }, query: {} })).ok).toBe(true);
    const [m] = await db().select().from(memberships).where(eq(memberships.id, viewer.membershipId));
    const [grant] = await db().select().from(roleAssignments).where(eq(roleAssignments.membershipId, viewer.membershipId));

    const revoked = await owner.call(teamEndpoints.revokeRole, { params: { workspaceId: ws.workspaceId, assignmentId: grant!.id }, body: { reason: 'Left the project' } }, { ifMatch: grant!.rowVersion });
    expect(revoked.revokedAt).toBeTruthy();

    const after = await vc.attempt(projectEndpoints.list, { params: { workspaceId: ws.workspaceId }, query: {} });
    expect(after.status).toBe(403);
    // The SSE connection re-checks the membership version and disconnects ("access_changed").
    expect(await membershipStillActive(db(), viewer.membershipId, m!.accessRevision)).toBe('changed');
    const events = await db()
      .select()
      .from(eventStream)
      .where(and(eq(eventStream.workspaceId, ws.workspaceId), eq(eventStream.kind, 'access_changed'), eq(eventStream.recipientMembershipId, viewer.membershipId)));
    expect(events.length).toBeGreaterThanOrEqual(1);
    // Stale If-Match on the same grant.
    const stale = await owner.attempt(teamEndpoints.revokeRole, { params: { workspaceId: ws.workspaceId, assignmentId: grant!.id }, body: { reason: 'Again please' } }, { ifMatch: grant!.rowVersion });
    expect(stale.status).toBe(412);
  });

  it('an Admin cannot give themselves Owner or finance rights by any path (T018)', async () => {
    const { ws } = await ownerSetup();
    const admin = await addMember(db(), ws, { roleKey: 'admin' });
    const other = await addMember(db(), ws, { roleKey: 'viewer' });
    const ac = await signedIn(admin.userId);
    const params = { workspaceId: ws.workspaceId };
    const ownerRole = await ws.roleId('owner');
    const finance = await ws.roleId('finance_manager');
    const adminRole = await ws.roleId('admin');

    const selfOwner = await ac.attempt(teamEndpoints.grantRole, { params, body: { membershipId: admin.membershipId, roleId: ownerRole, scopeType: 'workspace', scopeId: null } });
    expect(selfOwner.status).toBe(403);
    const selfFinance = await ac.attempt(teamEndpoints.grantRole, { params, body: { membershipId: admin.membershipId, roleId: finance, scopeType: 'workspace', scopeId: null } });
    expect(selfFinance.status).toBe(403);
    const otherFinance = await ac.attempt(teamEndpoints.grantRole, { params, body: { membershipId: other.membershipId, roleId: finance, scopeType: 'workspace', scopeId: null } });
    expect(otherFinance.status).toBe(403);
    expect(otherFinance.error?.message).toMatch(/Only the workspace Owner/);
    const otherOwner = await ac.attempt(teamEndpoints.grantRole, { params, body: { membershipId: other.membershipId, roleId: ownerRole, scopeType: 'workspace', scopeId: null } });
    expect(otherOwner.status).toBe(403);
    const otherAdmin = await ac.attempt(teamEndpoints.grantRole, { params, body: { membershipId: other.membershipId, roleId: adminRole, scopeType: 'workspace', scopeId: null } });
    expect(otherAdmin.status).toBe(403);

    // Custom role with finance.manage, or editing the Admin role to add it.
    const custom = await ac.attempt(roleEndpoints.create, { params, body: { name: 'Money Admin', permissions: ['members.read', 'finance.manage'], defaultScopeType: 'workspace' } });
    expect(custom.status).toBe(403);
    const adminDetail = await ac.call(roleEndpoints.get, { params: { ...params, roleId: adminRole } });
    expect(adminDetail.canEdit).toBe(false);
    const editAdmin = await ac.attempt(roleEndpoints.update, { params: { ...params, roleId: adminRole }, body: { permissions: [...adminDetail.permissions, 'finance.manage'] } }, { ifMatch: adminDetail.rowVersion });
    expect(editAdmin.status).toBe(403);
    // Invitations cannot smuggle finance roles either.
    const invite = await ac.attempt(teamEndpoints.invite, { params, body: { email: 'money@test.invalid', grants: [{ roleId: finance, scopeType: 'workspace', scopeId: null }] } });
    expect(invite.status).toBe(403);
    // Ownership transfer is Owner-only.
    const own = await ac.attempt(setupEndpoints.progress, { params });
    expect(own.status).toBe(403);
    const grants = await db().select().from(roleAssignments).where(eq(roleAssignments.membershipId, admin.membershipId));
    expect(grants).toHaveLength(1);
  });

  it('permission changes require recent authentication and nobody edits their own access', async () => {
    const { ws, owner } = await ownerSetup();
    const admin = await addMember(db(), ws, { roleKey: 'admin' });
    const target = await addMember(db(), ws, { roleKey: 'viewer' });
    const ac = await signedIn(admin.userId);
    const params = { workspaceId: ws.workspaceId };
    const creator = await ws.roleId('creator');
    const own = await ac.attempt(teamEndpoints.grantRole, { params, body: { membershipId: admin.membershipId, roleId: creator, scopeType: 'assigned_projects', scopeId: null } });
    expect(own.status).toBe(403);
    await expireRecentAuth(admin.userId);
    const stale = await ac.attempt(teamEndpoints.grantRole, { params, body: { membershipId: target.membershipId, roleId: creator, scopeType: 'assigned_projects', scopeId: null } });
    expect(stale.code).toBe('RECENT_AUTH_REQUIRED');
    const okByOwner = await owner.attempt(teamEndpoints.grantRole, { params, body: { membershipId: target.membershipId, roleId: creator, scopeType: 'assigned_projects', scopeId: null } });
    expect(okByOwner.ok).toBe(true);
  });

  it('explicit deny wins over grants and cannot target the Owner', async () => {
    const { ws, owner } = await ownerSetup();
    const dir = await createDirection(db(), ws, 'AI Models');
    const a = await createProject(db(), ws, { directionId: dir, name: 'Alpha' });
    const b = await createProject(db(), ws, { directionId: dir, name: 'Beta' });
    const lead = await addMember(db(), ws, { roleKey: 'project_lead', scopeType: 'assigned_projects' });
    await assignToProject(db(), ws, a.id, lead.membershipId);
    await assignToProject(db(), ws, b.id, lead.membershipId);
    const lc = await signedIn(lead.userId);
    const params = { workspaceId: ws.workspaceId };
    const deny = await owner.call(teamEndpoints.addDeny, { params, body: { membershipId: lead.membershipId, permission: 'projects.read', objectType: 'project', objectId: b.id, reason: 'Confidential pilot' } });
    expect(deny.objectLabel).toBe('Project: Beta');
    const list = await lc.call(projectEndpoints.list, { params, query: {} });
    expect(list.items.map((i) => i.name)).toEqual(['Alpha']);
    expect((await lc.attempt(projectEndpoints.get, { params: { ...params, projectId: b.id } })).status).toBe(404);
    const ownerDeny = await owner.attempt(teamEndpoints.addDeny, { params, body: { membershipId: ws.owner.membershipId, permission: 'projects.read', objectType: null, objectId: null, reason: 'Lock the owner out' } });
    expect(ownerDeny.status).toBe(403);
    const unknown = await owner.attempt(teamEndpoints.addDeny, { params, body: { membershipId: lead.membershipId, permission: 'nope.read', objectType: null, objectId: null, reason: 'Unknown permission' } });
    expect(unknown.status).toBe(422);
    await owner.call(teamEndpoints.revokeDeny, { params: { ...params, denyId: deny.id }, body: {} }, { ifMatch: deny.rowVersion });
    expect((await lc.call(projectEndpoints.list, { params, query: {} })).items).toHaveLength(2);
  });

  it('member access and grant lists are hidden from members without access rights', async () => {
    const { ws } = await ownerSetup();
    const lead = await addMember(db(), ws, { roleKey: 'project_lead', scopeType: 'assigned_projects' });
    const other = await addMember(db(), ws, { roleKey: 'viewer' });
    const lc = await signedIn(lead.userId);
    const params = { workspaceId: ws.workspaceId };
    expect((await lc.attempt(teamEndpoints.listRoleAssignments, { params, query: {} })).status).toBe(403);
    expect((await lc.attempt(roleEndpoints.list, { params, query: {} })).status).toBe(403);
    // Own access is always explainable; other members are not visible to a project lead without shared projects.
    const mine = await lc.call(teamEndpoints.access, { params: { ...params, membershipId: lead.membershipId } });
    expect(mine.canManage).toBe(false);
    expect((await lc.attempt(teamEndpoints.access, { params: { ...params, membershipId: other.membershipId } })).status).toBe(404);
  });
});
