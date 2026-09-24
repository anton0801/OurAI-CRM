import { describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { ownershipEndpoints, setupEndpoints, teamEndpoints } from '@castlane/api-contracts';
import { roleAssignments, roles } from '@castlane/database';
import { addMember } from '../../support';
import { db, enableMfaFlag, expireRecentAuth, ownerSetup, signedIn } from './helpers';

const ownerGrants = async (workspaceId: string) =>
  db()
    .select({ membershipId: roleAssignments.membershipId })
    .from(roleAssignments)
    .innerJoin(roles, eq(roles.id, roleAssignments.roleId))
    .where(and(eq(roleAssignments.workspaceId, workspaceId), eq(roles.key, 'owner'), isNull(roleAssignments.revokedAt)));

describe('ownership transfer (T013)', () => {
  it('needs the Owner’s recent authentication to propose and the recipient’s MFA-backed recent authentication to accept; swaps atomically', async () => {
    const { ws, owner } = await ownerSetup();
    const params = { workspaceId: ws.workspaceId };
    const heir = await addMember(db(), ws, { roleKey: 'admin', name: 'Hana Heir' });
    const other = await addMember(db(), ws, { roleKey: 'admin', name: 'Oleg Other' });
    const hc = await signedIn(heir.userId);
    const oc = await signedIn(other.userId);
    const adminRole = await ws.roleId('admin');

    // Admins cannot propose; the Owner needs recent authentication.
    expect((await oc.attempt(ownershipEndpoints.propose, { params, body: { toMembershipId: other.membershipId, previousOwnerRoleId: adminRole } })).status).toBe(403);
    await expireRecentAuth(ws.owner.userId);
    const stale = await owner.attempt(ownershipEndpoints.propose, { params, body: { toMembershipId: heir.membershipId, previousOwnerRoleId: adminRole } });
    expect(stale.code).toBe('RECENT_AUTH_REQUIRED');
    const owner2 = await signedIn(ws.owner.userId);
    const t = await owner2.call(ownershipEndpoints.propose, { params, body: { toMembershipId: heir.membershipId, previousOwnerRoleId: adminRole } });
    expect(t.status).toBe('pending');
    expect(t.previousOwnerRole?.key).toBe('admin');
    expect(t.canAccept).toBe(false);
    expect((await owner2.attempt(ownershipEndpoints.propose, { params, body: { toMembershipId: other.membershipId, previousOwnerRoleId: adminRole } })).code).toBe('DUPLICATE');

    // Nothing changed yet: still exactly one Owner.
    expect((await ownerGrants(ws.workspaceId)).map((g) => g.membershipId)).toEqual([ws.owner.membershipId]);
    const cur = await hc.call(ownershipEndpoints.current, { params });
    expect(cur.transfer?.canAccept).toBe(true);
    expect(cur.transfer?.recipientMfaEnabled).toBe(false);

    // Someone else cannot accept; the recipient needs MFA and a recent confirmation.
    expect((await oc.attempt(ownershipEndpoints.accept, { params: { ...params, transferId: t.id } })).status).toBe(403);
    const noMfa = await hc.attempt(ownershipEndpoints.accept, { params: { ...params, transferId: t.id } });
    expect(noMfa.status).toBe(409);
    expect(noMfa.error?.message).toMatch(/two-factor/);
    await enableMfaFlag(heir.userId);
    await expireRecentAuth(heir.userId);
    const noRecent = await hc.attempt(ownershipEndpoints.accept, { params: { ...params, transferId: t.id } });
    expect(noRecent.code).toBe('RECENT_AUTH_REQUIRED');
    const hc2 = await signedIn(heir.userId);
    const done = await hc2.call(ownershipEndpoints.accept, { params: { ...params, transferId: t.id } });
    expect(done.status).toBe('accepted');

    // Atomic swap: exactly one Owner; the previous Owner is Admin.
    expect((await ownerGrants(ws.workspaceId)).map((g) => g.membershipId)).toEqual([heir.membershipId]);
    const prev = await hc2.call(teamEndpoints.get, { params: { ...params, membershipId: ws.owner.membershipId } });
    expect(prev.isOwner).toBe(false);
    expect(prev.roles.map((r) => r.roleKey)).toEqual(['admin']);
    const newOwner = await hc2.call(teamEndpoints.get, { params: { ...params, membershipId: heir.membershipId } });
    expect(newOwner.isOwner).toBe(true);
    // Old Owner's open session reflects the change on its next request (setup is Owner-only).
    expect((await owner2.attempt(setupEndpoints.progress, { params })).status).toBe(403);
    expect((await hc2.attempt(setupEndpoints.progress, { params })).ok).toBe(true);
    // A replay of the acceptance does not transfer twice.
    const again = await hc2.attempt(ownershipEndpoints.accept, { params: { ...params, transferId: t.id } });
    expect(again.status).toBe(409);
  });

  it('the recipient can decline and the Owner can cancel; expired transfers cannot be accepted', async () => {
    const { ws, owner } = await ownerSetup();
    const params = { workspaceId: ws.workspaceId };
    const heir = await addMember(db(), ws, { roleKey: 'viewer' });
    await enableMfaFlag(heir.userId);
    const hc = await signedIn(heir.userId);
    const t = await owner.call(ownershipEndpoints.propose, { params, body: { toMembershipId: heir.membershipId, previousOwnerRoleId: null } });
    const declined = await hc.call(ownershipEndpoints.cancel, { params: { ...params, transferId: t.id }, body: { reason: 'Not ready yet' } });
    expect(declined.status).toBe('cancelled');
    const t2 = await owner.call(ownershipEndpoints.propose, { params, body: { toMembershipId: heir.membershipId, previousOwnerRoleId: null } });
    await db().execute(`UPDATE ownership_transfers SET expires_at = now() - interval '1 minute' WHERE id = '${t2.id}'`);
    const late = await hc.attempt(ownershipEndpoints.accept, { params: { ...params, transferId: t2.id } });
    expect(late.status).toBe(409);
    expect((await ownerGrants(ws.workspaceId)).map((g) => g.membershipId)).toEqual([ws.owner.membershipId]);
    // A new proposal is possible after expiry.
    const t3 = await owner.call(ownershipEndpoints.propose, { params, body: { toMembershipId: heir.membershipId, previousOwnerRoleId: null } });
    expect(t3.status).toBe('pending');
    const cancelled = await owner.call(ownershipEndpoints.cancel, { params: { ...params, transferId: t3.id }, body: {} });
    expect(cancelled.status).toBe('cancelled');
  });
});
