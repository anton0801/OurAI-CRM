import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { authEndpoints, roleEndpoints, teamEndpoints } from '@castlane/api-contracts';
import { invitations, memberships, notifications, users } from '@castlane/database';
import { addMember, clientFor, createDirection, runQueuedJobs } from '../../support';
import { db, latestInviteToken, ownerSetup, signedIn } from './helpers';

describe('invitations from Team (F02)', () => {
  it('invites with role+scope, tracks delivery separately, accepting twice keeps one user and membership (T004)', async () => {
    const { ws, owner } = await ownerSetup();
    const dir = await createDirection(db(), ws, 'AI Models');
    const params = { workspaceId: ws.workspaceId };
    const grantable = await owner.call(roleEndpoints.grantable, { params });
    expect(grantable.some((r) => r.key === 'owner')).toBe(false);
    const leadRole = grantable.find((r) => r.key === 'direction_lead')!;
    const r = await owner.call(teamEndpoints.invite, { params, body: { email: 'Nina.New@test.invalid', grants: [{ roleId: leadRole.id, scopeType: 'direction', scopeId: dir }] } });
    expect(r.outcome).toBe('queued');
    const list1 = await owner.call(teamEndpoints.invitations, { params, query: {} });
    expect(list1.items[0]).toMatchObject({ email: 'Nina.New@test.invalid', status: 'pending', deliveryStatus: 'queued' });
    expect(list1.items[0]!.grants[0]).toMatchObject({ roleKey: 'direction_lead', scopeLabel: 'Direction: AI Models' });
    // Real delivery status only after the transport accepted the message (T006 "email job has a real status").
    await runQueuedJobs(['mail.send']);
    const list2 = await owner.call(teamEndpoints.invitations, { params, query: {} });
    expect(list2.items[0]!.deliveryStatus).toBe('sent');
    expect(list2.items[0]!.lastSentAt).toBeTruthy();

    const token = await latestInviteToken('Nina.New@test.invalid');
    const anon = await clientFor();
    const a1 = await anon.call(authEndpoints.acceptInvitation, { body: { token, displayName: 'Nina New', password: 'a strong password 1' } });
    expect(a1.status).toBe('signed_in');
    const anon2 = await clientFor();
    const a2 = await anon2.attempt(authEndpoints.acceptInvitation, { body: { token, password: 'a strong password 1' } });
    expect(a2.ok).toBe(true);
    const people = await db().select().from(users).where(eq(users.normalizedEmail, 'nina.new@test.invalid'));
    expect(people).toHaveLength(1);
    const ms = await db().select().from(memberships).where(eq(memberships.userId, people[0]!.id));
    expect(ms).toHaveLength(1);
    const accepted = await owner.call(teamEndpoints.invitations, { params, query: { status: ['accepted'] } });
    expect(accepted.items[0]!.acceptedMember?.displayName).toBe('Nina New');
    // Accepted members are in the roster with exactly the proposed grant.
    const roster = await owner.call(teamEndpoints.list, { params, query: { q: 'Nina' } });
    expect(roster.items[0]!.roles.map((x) => x.roleKey)).toEqual(['direction_lead']);
    // Re-inviting an active member is reported, not duplicated.
    const again = await owner.attempt(teamEndpoints.invite, { params, body: { email: 'nina.new@test.invalid', grants: [{ roleId: leadRole.id, scopeType: 'direction', scopeId: dir }] } });
    expect(again.code).toBe('DUPLICATE');
  });

  it('expired or revoked invitations grant nothing and offer Request New Invitation; admins resolve it (T005)', async () => {
    const { ws, owner } = await ownerSetup();
    const params = { workspaceId: ws.workspaceId };
    const viewer = await ws.roleId('viewer');
    const inv = await owner.call(teamEndpoints.invite, { params, body: { email: 'late@test.invalid', grants: [{ roleId: viewer, scopeType: 'workspace', scopeId: null }] } });
    const token = await latestInviteToken('late@test.invalid');
    await db().update(invitations).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(invitations.id, inv.invitationId!));
    const anon = await clientFor();
    const info = await anon.call(authEndpoints.invitationInfo, { params: { token } });
    expect(info.status).toBe('expired');
    const accept = await anon.attempt(authEndpoints.acceptInvitation, { body: { token, displayName: 'Late Larry', password: 'a strong password 1' } });
    expect(accept.status).toBe(409);
    expect(await db().select().from(users).where(eq(users.normalizedEmail, 'late@test.invalid'))).toHaveLength(0);
    const expired = await owner.call(teamEndpoints.invitations, { params, query: { status: ['expired'] } });
    expect(expired.items.map((i) => i.email)).toEqual(['late@test.invalid']);

    await anon.call(authEndpoints.requestNewInvitation, { body: { token } });
    const n = await db().select().from(notifications).where(eq(notifications.recipientMembershipId, ws.owner.membershipId));
    expect(n.some((x) => x.eventType === 'invitation.new_requested')).toBe(true);
    const reqs = await owner.call(teamEndpoints.invitationRequests, { params, query: {} });
    expect(reqs).toHaveLength(1);
    expect(reqs[0]).toMatchObject({ email: 'late@test.invalid', invitationStatus: 'expired' });
    const listed = await owner.call(teamEndpoints.invitations, { params, query: {} });
    expect(listed.items[0]!.openRequest).toBe(true);

    const res = await owner.call(teamEndpoints.resolveInvitationRequest, { params: { ...params, requestId: reqs[0]!.id }, body: { action: 'resend' } });
    expect(res.status).toBe('resolved');
    expect(res.outcome).toBe('resent');
    const fresh = await latestInviteToken('late@test.invalid');
    expect(fresh).not.toBe(token);
    expect((await anon.call(authEndpoints.invitationInfo, { params: { token: fresh } })).status).toBe('valid');
    const handled = await owner.attempt(teamEndpoints.resolveInvitationRequest, { params: { ...params, requestId: reqs[0]!.id }, body: { action: 'dismiss' } });
    expect(handled.status).toBe(409);

    // Revoked links stop working immediately.
    await owner.call(teamEndpoints.revokeInvitation, { params: { ...params, invitationId: inv.invitationId! } });
    expect((await anon.call(authEndpoints.invitationInfo, { params: { token: fresh } })).status).toBe('revoked');
    const acceptRevoked = await anon.attempt(authEndpoints.acceptInvitation, { body: { token: fresh, displayName: 'Late Larry', password: 'a strong password 1' } });
    expect(acceptRevoked.status).toBe(409);
  });

  it('resend revokes the previous token and queues a new mail (T006)', async () => {
    const { ws, owner } = await ownerSetup();
    const params = { workspaceId: ws.workspaceId };
    const viewer = await ws.roleId('viewer');
    const inv = await owner.call(teamEndpoints.invite, { params, body: { email: 'again@test.invalid', grants: [{ roleId: viewer, scopeType: 'workspace', scopeId: null }] } });
    const t1 = await latestInviteToken('again@test.invalid');
    const r = await owner.call(teamEndpoints.resendInvitation, { params: { ...params, invitationId: inv.invitationId! } });
    expect(r.outcome).toBe('resent');
    const t2 = await latestInviteToken('again@test.invalid');
    expect(t2).not.toBe(t1);
    const anon = await clientFor();
    expect((await anon.call(authEndpoints.invitationInfo, { params: { token: t1 } })).status).toBe('revoked');
    expect((await anon.call(authEndpoints.invitationInfo, { params: { token: t2 } })).status).toBe('valid');
    const [row] = await db().select().from(invitations).where(eq(invitations.id, inv.invitationId!));
    expect(row!.resendCount).toBe(1);
    expect(row!.deliveryStatus).toBe('queued');
  });

  it('invitation management needs members.invite; suspended members are reactivated, not re-invited', async () => {
    const { ws, owner } = await ownerSetup();
    const params = { workspaceId: ws.workspaceId };
    const lead = await addMember(db(), ws, { roleKey: 'project_lead', scopeType: 'assigned_projects' });
    const lc = await signedIn(lead.userId);
    expect((await lc.attempt(teamEndpoints.invitations, { params, query: {} })).status).toBe(403);
    const viewer = await ws.roleId('viewer');
    expect((await lc.attempt(teamEndpoints.invite, { params, body: { email: 'x@test.invalid', grants: [{ roleId: viewer, scopeType: 'workspace', scopeId: null }] } })).status).toBe(403);
    const s = await addMember(db(), ws, { roleKey: 'viewer', email: 'susp@test.invalid' });
    await db().update(memberships).set({ status: 'suspended' }).where(eq(memberships.id, s.membershipId));
    const r = await owner.attempt(teamEndpoints.invite, { params, body: { email: 'susp@test.invalid', grants: [{ roleId: viewer, scopeType: 'workspace', scopeId: null }] } });
    expect(r.status).toBe(409);
    expect(r.error?.message).toMatch(/suspended/);
  });
});
