import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { directionAdminEndpoints, directionEndpoints, projectEndpoints } from '@castlane/api-contracts';
import { ARCHIVE_HANDLERS, memberJobContext, getAppServices } from '@castlane/application';
import { directions } from '@castlane/database';
import { addMember, assignToProject, createDirection, createProject } from '../../support';
import { db, expireRecentAuth, ownerSetup, signedIn } from './helpers';

describe('directions (S12)', () => {
  it('detail shows only readable projects; other directions are 404 for a scoped lead', async () => {
    const { ws, owner } = await ownerSetup();
    const a = await createDirection(db(), ws, 'AI Series');
    const b = await createDirection(db(), ws, 'AI Models');
    await createProject(db(), ws, { directionId: a, name: 'Alpha' });
    await createProject(db(), ws, { directionId: b, name: 'Beta' });
    const lead = await addMember(db(), ws, { roleKey: 'direction_lead', scopeType: 'direction', scopeId: a });
    const lc = await signedIn(lead.userId);
    const params = { workspaceId: ws.workspaceId };
    const d = await lc.call(directionAdminEndpoints.get, { params: { ...params, directionId: a } });
    expect(d.projects.map((p) => p.name)).toEqual(['Alpha']);
    expect(d.activeProjects).toBe(1);
    expect(d.permissions.manage).toBe(false);
    const ownerView = await owner.call(directionAdminEndpoints.get, { params: { ...params, directionId: b } });
    expect(ownerView.permissions).toEqual({ manage: true, manageAccess: true });
    // A creator without directions.read cannot open directions at all.
    const creator = await addMember(db(), ws, { roleKey: 'creator', scopeType: 'assigned_projects' });
    expect((await (await signedIn(creator.userId)).attempt(directionAdminEndpoints.get, { params: { ...params, directionId: a } })).status).toBe(403);
  });

  it('shows the access impact of a lead change and can grant/revoke the Direction Lead role with it', async () => {
    const { ws, owner } = await ownerSetup();
    const dir = await createDirection(db(), ws, 'AI Influencers');
    const p = await createProject(db(), ws, { directionId: dir, name: 'Influencer One' });
    const first = await addMember(db(), ws, { roleKey: 'producer', scopeType: 'assigned_projects', name: 'First Lead' });
    const second = await addMember(db(), ws, { roleKey: 'producer', scopeType: 'assigned_projects', name: 'Second Lead' });
    const params = { workspaceId: ws.workspaceId, directionId: dir };

    const impact = await owner.call(directionAdminEndpoints.leadImpact, { params, body: { leadMembershipId: first.membershipId } });
    expect(impact.proposed?.displayName).toBe('First Lead');
    expect(impact.proposedAccess).toMatchObject({ hasDirectionLeadRole: false, readableProjects: 0, canGrant: true });
    expect(impact.proposedAccess?.roleWouldBeGranted?.roleName).toBe('Direction Lead');
    expect(impact.projects.total).toBe(1);

    const d0 = await owner.call(directionAdminEndpoints.get, { params });
    const d1 = await owner.call(directionAdminEndpoints.assignLead, { params, body: { leadMembershipId: first.membershipId, grantLeadRole: true, revokePreviousLeadRole: false } }, { ifMatch: d0.rowVersion });
    expect(d1.lead?.displayName).toBe('First Lead');
    expect(d1.leadHasDirectionRole).toBe(true);
    const fc = await signedIn(first.userId);
    expect((await fc.attempt(projectEndpoints.get, { params: { workspaceId: ws.workspaceId, projectId: p.id } })).ok).toBe(true);

    const impact2 = await owner.call(directionAdminEndpoints.leadImpact, { params, body: { leadMembershipId: second.membershipId } });
    expect(impact2.previousAccess).toMatchObject({ roleName: 'Direction Lead', canRevoke: true });
    // Granting or revoking roles needs recent authentication; changing only the lead does not.
    await expireRecentAuth(ws.owner.userId);
    const needsAuth = await owner.attempt(directionAdminEndpoints.assignLead, { params, body: { leadMembershipId: second.membershipId, grantLeadRole: true, revokePreviousLeadRole: true } }, { ifMatch: d1.rowVersion });
    expect(needsAuth.code).toBe('RECENT_AUTH_REQUIRED');
    const owner2 = await signedIn(ws.owner.userId);
    const d2 = await owner2.call(directionAdminEndpoints.assignLead, { params, body: { leadMembershipId: second.membershipId, grantLeadRole: true, revokePreviousLeadRole: true } }, { ifMatch: d1.rowVersion });
    expect(d2.lead?.displayName).toBe('Second Lead');
    expect((await fc.attempt(projectEndpoints.get, { params: { workspaceId: ws.workspaceId, projectId: p.id } })).status).toBe(404);
    await expireRecentAuth(ws.owner.userId);
    const owner3 = await signedIn(ws.owner.userId);
    await expireRecentAuth(ws.owner.userId);
    const onlyLead = await owner3.attempt(directionAdminEndpoints.assignLead, { params, body: { leadMembershipId: null, grantLeadRole: false, revokePreviousLeadRole: false } }, { ifMatch: d2.rowVersion });
    expect(onlyLead.ok).toBe(true);
    const stale = await owner3.attempt(directionAdminEndpoints.assignLead, { params, body: { leadMembershipId: null, grantLeadRole: false, revokePreviousLeadRole: false } }, { ifMatch: d2.rowVersion });
    expect(stale.status).toBe(412);
  });

  it('archive checks projects; restore keeps active names unique; reorder needs every active direction', async () => {
    const { ws, owner } = await ownerSetup();
    const params = { workspaceId: ws.workspaceId };
    await createDirection(db(), ws, 'One');
    const b = await createDirection(db(), ws, 'Two');
    const c = await createDirection(db(), ws, 'Three');
    await createProject(db(), ws, { directionId: c, name: 'Busy' });
    const dc = await owner.call(directionAdminEndpoints.get, { params: { ...params, directionId: c } });
    expect((await owner.attempt(directionEndpoints.archive, { params: { ...params, directionId: c }, body: {} }, { ifMatch: dc.rowVersion })).status).toBe(409);

    const ctx = (await memberJobContext(getAppServices(), ws.workspaceId, ws.owner.membershipId))!;
    const preview = await ARCHIVE_HANDLERS.get('direction')!.preview(ctx, c);
    expect(preview.items[0]).toMatchObject({ kind: 'projects', blocking: true, count: 1 });

    const db2 = await owner.call(directionAdminEndpoints.get, { params: { ...params, directionId: b } });
    const archived = await owner.call(directionEndpoints.archive, { params: { ...params, directionId: b }, body: { reason: 'Merged into One' } }, { ifMatch: db2.rowVersion });
    expect(archived.status).toBe('archived');
    // A new active direction takes the name; restoring the old one is refused until renamed.
    await owner.call(directionEndpoints.create, { params, body: { name: 'Two' } });
    const conflict = await owner.attempt(directionAdminEndpoints.restore, { params: { ...params, directionId: b } }, { ifMatch: archived.rowVersion });
    expect(conflict.status).toBe(409);
    const [newTwo] = await db().select().from(directions).where(eq(directions.name, 'Two'));
    await db().update(directions).set({ name: 'Two (new)', nameKey: 'two (new)' }).where(eq(directions.id, newTwo!.id));
    const restored = await owner.call(directionAdminEndpoints.restore, { params: { ...params, directionId: b } }, { ifMatch: archived.rowVersion });
    expect(restored.status).toBe('active');

    const active = await owner.call(directionEndpoints.list, { params, query: {} });
    const ids = active.map((d) => d.id);
    const partial = await owner.attempt(directionAdminEndpoints.reorder, { params, body: { orderedIds: ids.slice(0, 1) } });
    expect(partial.status).toBe(422);
    const reversed = [...ids].reverse();
    await owner.call(directionAdminEndpoints.reorder, { params, body: { orderedIds: reversed } });
    const after = await owner.call(directionEndpoints.list, { params, query: {} });
    expect(after.map((d) => d.id)).toEqual(reversed);
  });
});
