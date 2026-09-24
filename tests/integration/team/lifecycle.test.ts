import { describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { authEndpoints, ofmEndpoints, projectEndpoints, teamEndpoints } from '@castlane/api-contracts';
import { loadMemberRefs } from '@castlane/application';
import { auditEvents, directions, invitations, memberships, ofmAssignments, projectMemberships, projects, roleAssignments, sessions, shifts, tasks } from '@castlane/database';
import { newId } from '@castlane/domain';
import { addMember, assignToProject, createDirection, createProject } from '../../support';
import { at as ofmAt, ofmSetup } from '../ofm/helpers';
import { db, expireRecentAuth, ownerSetup, signedIn } from './helpers';

// Open tasks are handed over by the tasks module's real provider ('tasks.assignee').
const addTask = async (workspaceId: string, projectId: string, assignee: string, title: string, createdBy: string) => {
  const id = newId();
  const at = new Date();
  await db().insert(tasks).values({ id, workspaceId, projectId, title, status: 'in_progress', assigneeMembershipId: assignee, createdAt: at, updatedAt: at, createdBy });
  return id;
};

describe('deactivation (F12)', () => {
  it('the workspace Owner cannot be deactivated or suspended (T012)', async () => {
    const { ws, owner } = await ownerSetup();
    const admin = await addMember(db(), ws, { roleKey: 'admin' });
    const ac = await signedIn(admin.userId);
    const params = { workspaceId: ws.workspaceId, membershipId: ws.owner.membershipId };
    const preview = await ac.call(teamEndpoints.deactivationPreview, { params, body: { resolutions: [] } });
    expect(preview.blocked).toMatch(/Owner cannot be deactivated/);
    expect(preview.impactToken).toBeNull();
    const detail = await ac.call(teamEndpoints.get, { params });
    expect(detail.permissions.deactivate).toBe(false);
    const d = await ac.attempt(teamEndpoints.deactivate, { params, body: { impactToken: 'x'.repeat(40), resolutions: [], reason: 'Trying anyway' } }, { ifMatch: detail.rowVersion });
    expect(d.status).toBe(409);
    const s = await ac.attempt(teamEndpoints.suspend, { params, body: { reason: 'Trying anyway' } }, { ifMatch: detail.rowVersion });
    expect(s.status).toBe(409);
    const self = await owner.call(teamEndpoints.deactivationPreview, { params, body: { resolutions: [] } });
    expect(self.blocked).toBeTruthy();
    const [m] = await db().select().from(memberships).where(eq(memberships.id, ws.owner.membershipId));
    expect(m!.status).toBe('active');
  });

  it('impact preview → chosen successors → transfer, revoke roles and sessions, keep history (T019)', async () => {
    const { ws, owner } = await ownerSetup();
    const dir = await createDirection(db(), ws, 'AI Series');
    const leaving = await addMember(db(), ws, { roleKey: 'project_lead', scopeType: 'assigned_projects', name: 'Leo Leaving' });
    const successor = await addMember(db(), ws, { roleKey: 'project_lead', scopeType: 'assigned_projects', name: 'Sam Successor' });
    const proj = await createProject(db(), ws, { directionId: dir, name: 'Night Shift', ownerMembershipId: leaving.membershipId });
    await assignToProject(db(), ws, proj.id, leaving.membershipId);
    await assignToProject(db(), ws, proj.id, successor.membershipId);
    await db().update(directions).set({ leadMembershipId: leaving.membershipId }).where(eq(directions.id, dir));
    const t1 = await addTask(ws.workspaceId, proj.id, leaving.membershipId, 'Cut episode 3', leaving.userId);
    const t2 = await addTask(ws.workspaceId, proj.id, leaving.membershipId, 'Write episode 4', leaving.userId);
    const at = new Date();
    await db().insert(invitations).values({
      id: newId(),
      workspaceId: ws.workspaceId,
      emailNormalized: 'friend@test.invalid',
      emailDisplay: 'friend@test.invalid',
      tokenHash: newId(),
      expiresAt: new Date(at.getTime() + 3_600_000),
      invitedByMembershipId: leaving.membershipId,
      createdAt: at,
      updatedAt: at,
    });
    const leaverClient = await signedIn(leaving.userId);
    const params = { workspaceId: ws.workspaceId, membershipId: leaving.membershipId };

    // 1. Preview without successors: the project owner item is required.
    const p0 = await owner.call(teamEndpoints.deactivationPreview, { params, body: { resolutions: [] } });
    const kinds = p0.groups.map((g) => g.kind).sort();
    expect(kinds).toEqual(['directions.lead', 'projects.owner', 'tasks.assignee']);
    expect(p0.missingSuccessors.map((m) => m.entityId)).toEqual([proj.id]);
    expect(p0.impactToken).toBeNull();
    expect(p0.effects.find((e) => e.kind === 'invitations')!.count).toBe(1);
    expect(p0.effects.find((e) => e.kind === 'sessions')!.count).toBeGreaterThanOrEqual(1);
    const taskGroup = p0.groups.find((g) => g.kind === 'tasks.assignee')!;
    expect(taskGroup.items[0]!.href).toMatch(/\/tasks\//);

    // 2. Invalid successor (the leaver) is reported; then a valid plan yields a token.
    const bad = await owner.call(teamEndpoints.deactivationPreview, {
      params,
      body: { resolutions: [{ kind: 'projects.owner', entityId: proj.id, successorMembershipId: leaving.membershipId }] },
    });
    expect(bad.invalidSuccessors).toHaveLength(1);
    const resolutions = [
      { kind: 'projects.owner', entityId: proj.id, successorMembershipId: successor.membershipId },
      { kind: 'tasks.assignee', entityId: t1, successorMembershipId: successor.membershipId },
      { kind: 'directions.lead', entityId: dir, successorMembershipId: null },
    ];
    const p1 = await owner.call(teamEndpoints.deactivationPreview, { params, body: { resolutions } });
    expect(p1.impactToken).toBeTruthy();
    const detail = await owner.call(teamEndpoints.get, { params });

    // 3. The token is bound to the reviewed successors and requires recent authentication.
    const mismatch = await owner.attempt(teamEndpoints.deactivate, { params, body: { impactToken: p1.impactToken!, resolutions: resolutions.slice(0, 2), reason: 'Contract ended' } }, { ifMatch: detail.rowVersion });
    expect(mismatch.status).toBe(422);
    await expireRecentAuth(ws.owner.userId);
    const noAuth = await owner.attempt(teamEndpoints.deactivate, { params, body: { impactToken: p1.impactToken!, resolutions, reason: 'Contract ended' } }, { ifMatch: detail.rowVersion });
    expect(noAuth.code).toBe('RECENT_AUTH_REQUIRED');
    const owner2 = await signedIn(ws.owner.userId);

    // 4. A change after the preview makes it stale.
    const t3 = await addTask(ws.workspaceId, proj.id, leaving.membershipId, 'Late extra task', leaving.userId);
    const stale = await owner2.attempt(teamEndpoints.deactivate, { params, body: { impactToken: p1.impactToken!, resolutions, reason: 'Contract ended' } }, { ifMatch: detail.rowVersion });
    expect(stale.status).toBe(409);
    await db().update(tasks).set({ status: 'done' }).where(eq(tasks.id, t3));

    const done = await owner2.call(teamEndpoints.deactivate, { params, body: { impactToken: p1.impactToken!, resolutions, reason: 'Contract ended' } }, { ifMatch: detail.rowVersion });
    expect(done.status).toBe('deactivated');
    expect(done.roles).toHaveLength(0);

    // Work handed over; unassigned item went to the provider's unassigned behaviour.
    const [task1] = await db().select().from(tasks).where(eq(tasks.id, t1));
    const [task2] = await db().select().from(tasks).where(eq(tasks.id, t2));
    expect(task1!.assigneeMembershipId).toBe(successor.membershipId);
    expect(task2!.assigneeMembershipId).toBeNull();
    const [p] = await db().select().from(projects).where(eq(projects.id, proj.id));
    expect(p!.ownerMembershipId).toBe(successor.membershipId);
    const [d] = await db().select().from(directions).where(eq(directions.id, dir));
    expect(d!.leadMembershipId).toBeNull();
    const successorTeam = await db()
      .select()
      .from(projectMemberships)
      .where(and(eq(projectMemberships.projectId, proj.id), eq(projectMemberships.membershipId, successor.membershipId), isNull(projectMemberships.validTo)));
    expect(successorTeam).toHaveLength(1);
    // Roles revoked (history kept), team membership ended, invitation cancelled, sessions revoked.
    const grants = await db().select().from(roleAssignments).where(eq(roleAssignments.membershipId, leaving.membershipId));
    expect(grants.every((g) => g.revokedAt)).toBe(true);
    const open = await db().select().from(projectMemberships).where(and(eq(projectMemberships.membershipId, leaving.membershipId), isNull(projectMemberships.validTo)));
    expect(open).toHaveLength(0);
    const inv = await db().select().from(invitations).where(eq(invitations.invitedByMembershipId, leaving.membershipId));
    expect(inv[0]!.status).toBe('revoked');
    const live = await db().select().from(sessions).where(and(eq(sessions.userId, leaving.userId), isNull(sessions.revokedAt)));
    expect(live).toHaveLength(0);
    expect((await leaverClient.attempt(authEndpoints.sessions, {})).status).toBe(401);
    // Historical authorship is unchanged and shown with the display snapshot.
    expect(task1!.createdBy).toBe(leaving.userId);
    const refs = await loadMemberRefs(db(), ws.workspaceId, [leaving.membershipId]);
    expect(refs.get(leaving.membershipId)).toMatchObject({ displayName: 'Leo Leaving', former: true });
    // The deactivated member stays listed only when asked for.
    const list = await owner2.call(teamEndpoints.list, { params: { workspaceId: ws.workspaceId }, query: {} });
    expect(list.items.some((m) => m.membershipId === leaving.membershipId)).toBe(false);
    const listAll = await owner2.call(teamEndpoints.list, { params: { workspaceId: ws.workspaceId }, query: { status: ['deactivated'] } });
    expect(listAll.items.map((m) => m.displayName)).toEqual(['Leo Leaving']);
    // Deactivated members cannot be picked as project owners or successors any more.
    const pick = await owner2.attempt(projectEndpoints.update, { params: { workspaceId: ws.workspaceId, projectId: proj.id }, body: { ownerMembershipId: leaving.membershipId } }, { ifMatch: p!.rowVersion });
    expect(pick.status).toBe(422);
  });

  it('a member with scheduled OFM shifts: the preview lists them; the chosen successor gets one, the other is cancelled with history (T019)', async () => {
    const s = await ofmSetup();
    // Mona holds assignments on A and B and two scheduled shifts; Nick is assigned to A (support lane).
    const kept = await s.schedule(s.manager.membershipId, 30, 36);
    const dropped = await s.owner.call(ofmEndpoints.createShift, { params: s.p, body: { membershipId: s.manager.membershipId, primaryAccountId: s.accountB, scheduledStart: ofmAt(40), scheduledEnd: ofmAt(44), timezone: 'UTC' } });
    const params = { workspaceId: s.ws.workspaceId, membershipId: s.manager.membershipId };

    const p0 = await s.owner.call(teamEndpoints.deactivationPreview, { params, body: { resolutions: [] } });
    const shiftGroup = p0.groups.find((g) => g.kind === 'ofm.shifts')!;
    expect(shiftGroup.items.map((i) => i.entityId).sort()).toEqual([kept.id, dropped.id].sort());
    expect(shiftGroup.unassignedBehaviour).toMatch(/Cancelled/);
    expect(p0.groups.find((g) => g.kind === 'ofm.assignments')!.items).toHaveLength(2);

    const resolutions = [{ kind: 'ofm.shifts', entityId: kept.id, successorMembershipId: s.manager2.membershipId }];
    const p1 = await s.owner.call(teamEndpoints.deactivationPreview, { params, body: { resolutions } });
    expect(p1.invalidSuccessors).toEqual([]);
    expect(p1.impactToken).toBeTruthy();
    const detail = await s.owner.call(teamEndpoints.get, { params });
    const done = await s.owner.call(teamEndpoints.deactivate, { params, body: { impactToken: p1.impactToken!, resolutions, reason: 'Contract ended' } }, { ifMatch: detail.rowVersion });
    expect(done.status).toBe('deactivated');

    // The chosen shift moved (same id, times and account); the other one is cancelled, not deleted.
    const [moved] = await db().select().from(shifts).where(eq(shifts.id, kept.id));
    expect(moved).toMatchObject({ membershipId: s.manager2.membershipId, state: 'scheduled', primaryAccountId: s.accountA });
    expect(moved!.scheduledStart.toISOString()).toBe(kept.scheduledStart);
    const [cancelled] = await db().select().from(shifts).where(eq(shifts.id, dropped.id));
    expect(cancelled).toMatchObject({ membershipId: s.manager.membershipId, state: 'cancelled' });
    expect(await db().select().from(auditEvents).where(and(eq(auditEvents.entityId, kept.id), eq(auditEvents.action, 'shift.reassigned')))).toHaveLength(1);
    // Assignments without a successor ended; sessions revoked.
    const open = await db().select().from(ofmAssignments).where(and(eq(ofmAssignments.membershipId, s.manager.membershipId), isNull(ofmAssignments.endedAt)));
    expect(open).toEqual([]);
    expect(await db().select().from(sessions).where(and(eq(sessions.userId, s.manager.userId), isNull(sessions.revokedAt)))).toEqual([]);
  });

  it('restore does not silently bring back sensitive grants (T020)', async () => {
    const { ws, owner } = await ownerSetup();
    const m = await addMember(db(), ws, {
      roleKey: 'viewer',
      name: 'Rita Return',
      grants: [
        { roleKey: 'viewer', scopeType: 'workspace' },
        { roleKey: 'finance_manager', scopeType: 'workspace' },
      ],
    });
    const params = { workspaceId: ws.workspaceId, membershipId: m.membershipId };
    const preview = await owner.call(teamEndpoints.deactivationPreview, { params, body: { resolutions: [] } });
    const det = await owner.call(teamEndpoints.get, { params });
    await owner.call(teamEndpoints.deactivate, { params, body: { impactToken: preview.impactToken!, resolutions: [], reason: 'Seasonal contract ended' } }, { ifMatch: det.rowVersion });

    const rp = await owner.call(teamEndpoints.restorePreview, { params });
    expect(rp.status).toBe('deactivated');
    const fin = rp.previousGrants.find((g) => g.roleKey === 'finance_manager')!;
    expect(fin.sensitive).toBe(true);
    expect(fin.note).toMatch(/Not restored automatically/);
    expect(rp.suggestedGrants.map((g) => g.roleId)).toEqual([await ws.roleId('viewer')]);

    // An Admin cannot restore the finance grant (Owner-only), and restoring needs recent auth.
    const admin = await addMember(db(), ws, { roleKey: 'admin' });
    const ac = await signedIn(admin.userId);
    const deact = await owner.call(teamEndpoints.get, { params });
    const adminFinance = await ac.attempt(teamEndpoints.restore, { params, body: { reason: 'Back for Q4', grants: [{ roleId: fin.roleId, scopeType: 'workspace', scopeId: null }] } }, { ifMatch: deact.rowVersion });
    expect(adminFinance.status).toBe(403);

    const restored = await ac.call(teamEndpoints.restore, { params, body: { reason: 'Back for Q4', grants: rp.suggestedGrants } }, { ifMatch: deact.rowVersion });
    expect(restored.status).toBe('active');
    expect(restored.roles.map((r) => r.roleKey)).toEqual(['viewer']);
    const access = await owner.call(teamEndpoints.access, { params });
    expect(access.groups.flatMap((g) => g.permissions).find((p) => p.key === 'finance.read')!.held).toBe(false);
    // The removed grants remain visible in the access history.
    expect(access.history.some((h) => h.roleKey === 'finance_manager' && h.revokedAt)).toBe(true);
    const again = await ac.attempt(teamEndpoints.restore, { params, body: { reason: 'Back for Q4', grants: [] } }, { ifMatch: restored.rowVersion });
    expect(again.status).toBe(409);
  });
});

describe('suspension, sessions and transfer work', () => {
  it('suspend blocks workspace access immediately; reactivate restores it with the same grants', async () => {
    const { ws, owner } = await ownerSetup();
    const m = await addMember(db(), ws, { roleKey: 'viewer' });
    const mc = await signedIn(m.userId);
    const params = { workspaceId: ws.workspaceId, membershipId: m.membershipId };
    const det = await owner.call(teamEndpoints.get, { params });
    const s = await owner.call(teamEndpoints.suspend, { params, body: { reason: 'Security review' } }, { ifMatch: det.rowVersion });
    expect(s.status).toBe('suspended');
    expect((await mc.attempt(projectEndpoints.list, { params: { workspaceId: ws.workspaceId }, query: {} })).status).toBe(404);
    const r = await owner.call(teamEndpoints.reactivate, { params, body: {} }, { ifMatch: s.rowVersion });
    expect(r.status).toBe('active');
    expect(r.roles.map((x) => x.roleKey)).toEqual(['viewer']);
    expect((await mc.attempt(projectEndpoints.list, { params: { workspaceId: ws.workspaceId }, query: {} })).ok).toBe(true);
  });

  it('an administrator can sign a member out everywhere', async () => {
    const { ws, owner } = await ownerSetup();
    const m = await addMember(db(), ws, { roleKey: 'viewer' });
    const mc = await signedIn(m.userId);
    const r = await owner.call(teamEndpoints.revokeSessions, { params: { workspaceId: ws.workspaceId, membershipId: m.membershipId }, body: { reason: 'Lost laptop' } });
    expect(r.revoked).toBeGreaterThanOrEqual(1);
    expect((await mc.attempt(authEndpoints.sessions, {})).status).toBe(401);
  });

  it('Transfer Work hands over selected items without deactivating', async () => {
    const { ws, owner } = await ownerSetup();
    const a = await addMember(db(), ws, { roleKey: 'creator', scopeType: 'assigned_projects' });
    const b = await addMember(db(), ws, { roleKey: 'creator', scopeType: 'assigned_projects' });
    const proj = await createProject(db(), ws, {});
    await assignToProject(db(), ws, proj.id, b.membershipId);
    const t = await addTask(ws.workspaceId, proj.id, a.membershipId, 'Hand me over', a.userId);
    const params = { workspaceId: ws.workspaceId, membershipId: a.membershipId };
    const open = await owner.call(teamEndpoints.openWork, { params });
    expect(open.groups.find((g) => g.kind === 'tasks.assignee')!.items.map((i) => i.entityId)).toEqual([t]);
    const noSuccessor = await owner.attempt(teamEndpoints.transferWork, { params, body: { resolutions: [{ kind: 'tasks.assignee', entityId: t, successorMembershipId: null }] } });
    expect(noSuccessor.status).toBe(422);
    const r = await owner.call(teamEndpoints.transferWork, { params, body: { resolutions: [{ kind: 'tasks.assignee', entityId: t, successorMembershipId: b.membershipId }] } });
    expect(r.transferred).toBe(1);
    const [row] = await db().select().from(tasks).where(eq(tasks.id, t));
    expect(row!.assigneeMembershipId).toBe(b.membershipId);
    const [m] = await db().select().from(memberships).where(eq(memberships.id, a.membershipId));
    expect(m!.status).toBe('active');
  });
});
