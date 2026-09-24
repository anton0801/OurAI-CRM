import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { projectEndpoints, roleEndpoints, teamEndpoints } from '@castlane/api-contracts';
import { memberships } from '@castlane/database';
import { addMember } from '../../support';
import { db, expireRecentAuth, ownerSetup, signedIn } from './helpers';

describe('roles (S63)', () => {
  it('lists presets with sensitive flags; the Owner role is protected', async () => {
    const { ws, owner } = await ownerSetup();
    const params = { workspaceId: ws.workspaceId };
    const list = await owner.call(roleEndpoints.list, { params, query: {} });
    const ownerRole = list.find((r) => r.key === 'owner')!;
    expect(ownerRole.isProtected).toBe(true);
    expect(ownerRole.canEdit).toBe(false);
    expect(ownerRole.canGrant).toBe(false);
    expect(ownerRole.activeAssignments).toBe(1);
    const fin = list.find((r) => r.key === 'finance_manager')!;
    expect(fin.sensitivePermissions).toContain('finance.post');
    const edit = await owner.attempt(roleEndpoints.update, { params: { ...params, roleId: ownerRole.id }, body: { name: 'Boss' } }, { ifMatch: ownerRole.rowVersion });
    expect(edit.status).toBe(403);
  });

  it('clones a preset into a custom role, previews impact, applies it to holders immediately and archives when unused', async () => {
    const { ws, owner } = await ownerSetup();
    const params = { workspaceId: ws.workspaceId };
    const viewerRole = (await owner.call(roleEndpoints.list, { params, query: {} })).find((r) => r.key === 'viewer')!;
    const bogus = await owner.attempt(roleEndpoints.create, { params, body: { name: 'Bogus', permissions: ['projects.read', 'bogus.perm'], defaultScopeType: 'workspace' } });
    expect(bogus.status).toBe(422);
    const custom = await owner.call(roleEndpoints.create, {
      params,
      body: { name: 'Reviewer Lite', description: 'Reads projects only', permissions: ['content.read', 'projects.read', 'projects.read'], defaultScopeType: 'assigned_projects', cloneFromRoleId: viewerRole.id },
    });
    expect(custom.key).toMatch(/^custom_reviewer_lite_/);
    expect(custom.permissions).toEqual(['projects.read', 'content.read']);
    expect(custom.basedOnKey).toBe('viewer');
    const dup = await owner.attempt(roleEndpoints.create, { params, body: { name: 'reviewer lite', permissions: ['projects.read'], defaultScopeType: 'workspace' } });
    expect(dup.status).toBe(409);
    expect(dup.error?.fieldErrors).toEqual([expect.objectContaining({ field: 'name' })]);

    const member = await addMember(db(), ws, { roleKey: 'viewer', name: 'Milo' });
    const mc = await signedIn(member.userId);
    await owner.call(teamEndpoints.grantRole, { params, body: { membershipId: member.membershipId, roleId: custom.id, scopeType: 'workspace', scopeId: null } });
    const [m0] = await db().select().from(memberships).where(eq(memberships.id, member.membershipId));

    const impact = await owner.call(roleEndpoints.previewImpact, { params: { ...params, roleId: custom.id }, body: { permissions: ['projects.read', 'exports.create'] } });
    expect(impact).toMatchObject({ added: ['exports.create'], removed: ['content.read'], sensitiveAdded: ['exports.create'], blocked: null });
    expect(impact.affectedMembers.count).toBe(1);
    expect(impact.affectedMembers.sample[0]!.displayName).toBe('Milo');

    await expireRecentAuth(ws.owner.userId);
    const noAuth = await owner.attempt(roleEndpoints.update, { params: { ...params, roleId: custom.id }, body: { permissions: ['projects.read'] } }, { ifMatch: custom.rowVersion });
    expect(noAuth.code).toBe('RECENT_AUTH_REQUIRED');
    const owner2 = await signedIn(ws.owner.userId);
    const upd = await owner2.call(roleEndpoints.update, { params: { ...params, roleId: custom.id }, body: { permissions: ['projects.read'], name: 'Reviewer Lite 2' } }, { ifMatch: custom.rowVersion });
    expect(upd.permissions).toEqual(['projects.read']);
    const [m1] = await db().select().from(memberships).where(eq(memberships.id, member.membershipId));
    expect(m1!.accessRevision).toBeGreaterThan(m0!.accessRevision);
    const stale = await owner2.attempt(roleEndpoints.update, { params: { ...params, roleId: custom.id }, body: { name: 'Again' } }, { ifMatch: custom.rowVersion });
    expect(stale.status).toBe(412);
    expect((await mc.attempt(projectEndpoints.list, { params, query: {} })).ok).toBe(true);

    // Archive is refused while someone holds the role.
    const held = await owner2.attempt(roleEndpoints.archive, { params: { ...params, roleId: custom.id }, body: {} }, { ifMatch: upd.rowVersion });
    expect(held.status).toBe(409);
    const grant = upd.assignments[0]!;
    const grants = await owner2.call(teamEndpoints.listRoleAssignments, { params, query: { roleId: custom.id } });
    await owner2.call(teamEndpoints.revokeRole, { params: { ...params, assignmentId: grant.id }, body: { reason: 'Role retired' } }, { ifMatch: grants[0]!.rowVersion });
    const archived = await owner2.call(roleEndpoints.archive, { params: { ...params, roleId: custom.id }, body: { reason: 'No longer used' } }, { ifMatch: upd.rowVersion });
    expect(archived.archivedAt).toBeTruthy();
    // Archived role names can be reused.
    const reuse = await owner2.attempt(roleEndpoints.create, { params, body: { name: 'Reviewer Lite 2', permissions: ['projects.read'], defaultScopeType: 'workspace' } });
    expect(reuse.ok).toBe(true);
  });

  it('preset roles can be edited and reset to the catalog', async () => {
    const { ws, owner } = await ownerSetup();
    const params = { workspaceId: ws.workspaceId };
    const creator = (await owner.call(roleEndpoints.list, { params, query: {} })).find((r) => r.key === 'creator')!;
    const upd = await owner.call(roleEndpoints.update, { params: { ...params, roleId: creator.id }, body: { permissions: [...creator.permissions, 'references.write'] } }, { ifMatch: creator.rowVersion });
    expect(upd.presetDiff).toEqual({ added: ['references.write'], removed: [] });
    const reset = await owner.call(roleEndpoints.reset, { params: { ...params, roleId: creator.id } }, { ifMatch: upd.rowVersion });
    expect(reset.presetDiff).toEqual({ added: [], removed: [] });
  });

  it('a non-owner access manager can only build roles from permissions they hold', async () => {
    const { ws } = await ownerSetup();
    const admin = await addMember(db(), ws, { roleKey: 'admin' });
    const ac = await signedIn(admin.userId);
    const params = { workspaceId: ws.workspaceId };
    const ok = await ac.attempt(roleEndpoints.create, { params, body: { name: 'Coordinator', permissions: ['tasks.read', 'tasks.assign'], defaultScopeType: 'assigned_projects' } });
    expect(ok.ok).toBe(true);
    const contacts = await ac.attempt(roleEndpoints.create, { params, body: { name: 'Contact Reader', permissions: ['contacts.read'], defaultScopeType: 'workspace' } });
    expect(contacts.status).toBe(403);
    const blocked = await ac.call(roleEndpoints.previewImpact, { params: { ...params, roleId: ok.data!.id }, body: { permissions: ['tasks.read', 'finance.read'] } });
    expect(blocked.blocked).toMatch(/cannot grant permissions/);
  });
});
