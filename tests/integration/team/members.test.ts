import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { shellEndpoints, teamEndpoints } from '@castlane/api-contracts';
import { memberships, tasks } from '@castlane/database';
import { newId } from '@castlane/domain';
import { addMember, assignToProject, createDirection, createProject, createWorkspace } from '../../support';
import { db, ownerSetup, signedIn } from './helpers';

describe('team roster (S61)', () => {
  it('lists members in scope with roles, directions, projects and scoped workload; filters work', async () => {
    const { ws, owner } = await ownerSetup();
    const dirA = await createDirection(db(), ws, 'AI Series');
    const dirB = await createDirection(db(), ws, 'AI Models');
    const pa = await createProject(db(), ws, { directionId: dirA, name: 'Alpha' });
    const pb = await createProject(db(), ws, { directionId: dirB, name: 'Beta' });
    const lead = await addMember(db(), ws, { roleKey: 'direction_lead', scopeType: 'direction', scopeId: dirA, name: 'Lena Lead' });
    const creatorA = await addMember(db(), ws, { roleKey: 'creator', scopeType: 'assigned_projects', name: 'Anna Alpha' });
    const creatorB = await addMember(db(), ws, { roleKey: 'creator', scopeType: 'assigned_projects', name: 'Boris Beta' });
    await assignToProject(db(), ws, pa.id, creatorA.membershipId);
    await assignToProject(db(), ws, pb.id, creatorB.membershipId);
    const at = new Date();
    await db().insert(tasks).values({ id: newId(), workspaceId: ws.workspaceId, projectId: pb.id, title: 'Edit teaser', status: 'in_progress', assigneeMembershipId: creatorB.membershipId, createdAt: at, updatedAt: at });

    const params = { workspaceId: ws.workspaceId };
    const all = await owner.call(teamEndpoints.list, { params, query: {} });
    expect(all.items.map((m) => m.displayName).sort()).toEqual(['Anna Alpha', 'Boris Beta', 'Lena Lead', 'Owner']);
    const boris = all.items.find((m) => m.displayName === 'Boris Beta')!;
    expect(boris.openTasks).toBe(1);
    expect(boris.projects.map((p) => p.name)).toEqual(['Beta']);
    expect(boris.directions.map((d) => d.name)).toEqual(['AI Models']);
    expect(boris.roles[0]).toMatchObject({ roleKey: 'creator', scopeLabel: 'Assigned projects' });
    expect(boris.mfaEnabled).toBe(false);
    expect(all.items.find((m) => m.displayName === 'Owner')!.isOwner).toBe(true);

    // Filters: direction (via projects or direction-scoped grants), project, role, responsibility.
    const byDir = await owner.call(teamEndpoints.list, { params, query: { directionId: dirA } });
    expect(byDir.items.map((m) => m.displayName).sort()).toEqual(['Anna Alpha', 'Lena Lead']);
    const byProject = await owner.call(teamEndpoints.list, { params, query: { projectId: pb.id } });
    expect(byProject.items.map((m) => m.displayName)).toEqual(['Boris Beta']);
    const byRole = await owner.call(teamEndpoints.list, { params, query: { roleId: await ws.roleId('direction_lead') } });
    expect(byRole.items.map((m) => m.displayName)).toEqual(['Lena Lead']);
    await owner.call(teamEndpoints.addResponsibility, { params: { ...params, membershipId: creatorA.membershipId }, body: { duty: 'editing', scopeType: 'project', scopeId: pa.id } });
    const byDuty = await owner.call(teamEndpoints.list, { params, query: { responsibility: 'editing' } });
    expect(byDuty.items.map((m) => m.displayName)).toEqual(['Anna Alpha']);
    expect(byDuty.items[0]!.responsibilities[0]).toMatchObject({ duty: 'editing', scopeLabel: 'Project: Alpha' });
    const none = await owner.call(teamEndpoints.list, { params, query: { q: 'zzz-nobody' } });
    expect(none.items).toHaveLength(0);

    // Scope inside SQL: the direction lead sees members of their direction only (and themselves).
    const lc = await signedIn(lead.userId);
    const scoped = await lc.call(teamEndpoints.list, { params, query: {} });
    expect(scoped.items.map((m) => m.displayName).sort()).toEqual(['Anna Alpha', 'Lena Lead']);
    // Workload is counted only within the lead's task scope; Beta's task is invisible, so Anna shows 0 (known).
    expect(scoped.items.find((m) => m.displayName === 'Anna Alpha')!.openTasks).toBe(0);
    expect(scoped.items[0]!.mfaEnabled).toBeUndefined();
    expect((await lc.attempt(teamEndpoints.get, { params: { ...params, membershipId: creatorB.membershipId } })).status).toBe(404);

    // Pagination is stable and never repeats rows.
    const p1 = await owner.call(teamEndpoints.list, { params, query: { pageSize: 2 } });
    const p2 = await owner.call(teamEndpoints.list, { params, query: { pageSize: 2, cursor: p1.nextCursor! } });
    expect(new Set([...p1.items, ...p2.items].map((m) => m.membershipId)).size).toBe(4);
    expect(p2.hasMore).toBe(false);

    // A member without members.read gets 403 for the module, but can open their own member page.
    const cc = await signedIn(creatorB.userId);
    const finance = await addMember(db(), ws, { roleKey: 'finance_manager', name: 'Fiona Finance' });
    const fc = await signedIn(finance.userId);
    // Finance managers read the roster but not tasks: workload is unknown (null), never 0.
    const fin = await fc.call(teamEndpoints.list, { params, query: { q: 'Boris' } });
    expect(fin.items[0]!.openTasks).toBeNull();
    expect((await cc.attempt(teamEndpoints.list, { params, query: {} })).status).toBe(403);
    const self = await cc.call(teamEndpoints.get, { params: { ...params, membershipId: creatorB.membershipId } });
    expect(self.isSelf).toBe(true);
    // Creators read tasks of their assigned projects, so their own workload is known.
    expect(self.openTasks).toBe(1);
    expect(self.permissions.update).toBe(false);
  });

  it('updates title, manager and skills with If-Match; rejects reporting loops; indexes the member for search', async () => {
    const { ws, owner } = await ownerSetup();
    const a = await addMember(db(), ws, { roleKey: 'producer', scopeType: 'assigned_projects', name: 'Pavel Producer' });
    const b = await addMember(db(), ws, { roleKey: 'creator', scopeType: 'assigned_projects', name: 'Cora Creator' });
    const params = { workspaceId: ws.workspaceId };
    const detail = await owner.call(teamEndpoints.get, { params: { ...params, membershipId: b.membershipId } });
    const missing = await owner.attempt(teamEndpoints.update, { params: { ...params, membershipId: b.membershipId }, body: { title: 'Editor' } });
    expect(missing.status).toBe(428);
    const upd = await owner.call(
      teamEndpoints.update,
      { params: { ...params, membershipId: b.membershipId }, body: { title: 'Senior Editor', managerMembershipId: a.membershipId, skills: ['Editing', 'editing', 'Color'] } },
      { ifMatch: detail.rowVersion },
    );
    expect(upd.title).toBe('Senior Editor');
    expect(upd.manager?.displayName).toBe('Pavel Producer');
    expect(upd.skills).toEqual(['Editing', 'Color']);
    const stale = await owner.attempt(teamEndpoints.update, { params: { ...params, membershipId: b.membershipId }, body: { title: 'Other' } }, { ifMatch: detail.rowVersion });
    expect(stale.code).toBe('VERSION_CONFLICT');
    const aDetail = await owner.call(teamEndpoints.get, { params: { ...params, membershipId: a.membershipId } });
    expect(aDetail.reports.map((r) => r.displayName)).toEqual(['Cora Creator']);
    const loop = await owner.attempt(teamEndpoints.update, { params: { ...params, membershipId: a.membershipId }, body: { managerMembershipId: b.membershipId } }, { ifMatch: aDetail.rowVersion });
    expect(loop.status).toBe(422);
    expect(loop.error?.message).toMatch(/reporting loop/);
    const found = await owner.call(shellEndpoints.search, { params, query: { q: 'Cora' } });
    expect(found.results.some((r) => r.entityType === 'member' && r.href.endsWith(`/team/${b.membershipId}`))).toBe(true);
  });

  it('duties never grant permissions; bulk direction assignment reports per member', async () => {
    const { ws, owner } = await ownerSetup();
    const dir = await createDirection(db(), ws, 'AI Influencers');
    const a = await addMember(db(), ws, { roleKey: 'viewer', name: 'Ann' });
    const b = await addMember(db(), ws, { roleKey: 'viewer', name: 'Ben' });
    await db().update(memberships).set({ status: 'suspended' }).where(eq(memberships.id, b.membershipId));
    const params = { workspaceId: ws.workspaceId };
    const r = await owner.call(teamEndpoints.bulkAssignDirection, { params, body: { membershipIds: [a.membershipId, b.membershipId, newId()], directionId: dir, duty: 'publishing' } });
    expect(r.results.map((x) => x.outcome)).toEqual(['assigned', 'not_active', 'not_found']);
    const again = await owner.call(teamEndpoints.bulkAssignDirection, { params, body: { membershipIds: [a.membershipId], directionId: dir, duty: 'publishing' } });
    expect(again.results[0]!.outcome).toBe('already_assigned');
    const detail = await owner.call(teamEndpoints.get, { params: { ...params, membershipId: a.membershipId } });
    expect(detail.directions.map((d) => d.name)).toEqual(['AI Influencers']);
    const duty = detail.responsibilityAssignments[0]!;
    const access = await owner.call(teamEndpoints.access, { params: { ...params, membershipId: a.membershipId } });
    expect(access.grants.map((g) => g.roleKey)).toEqual(['viewer']);
    await owner.call(teamEndpoints.endResponsibility, { params: { ...params, responsibilityId: duty.id }, body: {} }, { ifMatch: duty.rowVersion });
    const ended = await owner.attempt(teamEndpoints.endResponsibility, { params: { ...params, responsibilityId: duty.id }, body: {} }, { ifMatch: duty.rowVersion + 1 });
    expect(ended.status).toBe(409);
  });

  it('cross-workspace member ids are 404 (T015)', async () => {
    const { ws, owner } = await ownerSetup();
    const other = await createWorkspace(db());
    const stranger = await addMember(db(), other, { roleKey: 'viewer' });
    const r = await owner.attempt(teamEndpoints.get, { params: { workspaceId: ws.workspaceId, membershipId: stranger.membershipId } });
    expect(r.status).toBe(404);
    const g = await owner.attempt(teamEndpoints.grantRole, {
      params: { workspaceId: ws.workspaceId },
      body: { membershipId: stranger.membershipId, roleId: await ws.roleId('viewer'), scopeType: 'workspace', scopeId: null },
    });
    expect(g.status).toBe(404);
  });

  it('activity shows membership history to access readers and actions within scope', async () => {
    const { ws, owner } = await ownerSetup();
    const m = await addMember(db(), ws, { roleKey: 'viewer', name: 'Hist' });
    const params = { workspaceId: ws.workspaceId };
    const d = await owner.call(teamEndpoints.get, { params: { ...params, membershipId: m.membershipId } });
    await owner.call(teamEndpoints.update, { params: { ...params, membershipId: m.membershipId }, body: { title: 'Analyst' } }, { ifMatch: d.rowVersion });
    const act = await owner.call(teamEndpoints.activity, { params: { ...params, membershipId: m.membershipId }, query: { kind: 'membership' } });
    expect(act.items[0]).toMatchObject({ action: 'member.updated', actorName: 'Owner' });
    expect(act.items[0]!.changes).toEqual([{ field: 'title', from: null, to: 'Analyst' }]);
  });
});
