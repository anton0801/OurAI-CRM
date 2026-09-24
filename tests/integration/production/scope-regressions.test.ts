import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { accountAssignments, publications } from '@castlane/database';
import { newId } from '@castlane/domain';
import { createAccount } from '../../support';
import { C, db, member, newContent, prodFixture } from './helpers';

describe('production scope regressions', () => {
  it('only live placements give account-scoped members access to content (trashed/cancelled do not)', async () => {
    const f = await prodFixture();
    const accountId = await createAccount(db(), f.ws, { projectId: f.projectId });
    const pub = await member(f, 'publisher', { scopeType: 'assigned_accounts' });
    await db().insert(accountAssignments).values({ id: newId(), workspaceId: f.ws.workspaceId, accountId, membershipId: pub.membershipId, duty: 'publishing', validFrom: new Date(Date.now() - 1000) });
    const c = await newContent(f.owner, f);
    const placementId = newId();
    await db().insert(publications).values({ id: placementId, workspaceId: f.ws.workspaceId, contentItemId: c.id, accountId, projectId: f.projectId, ownerMembershipId: pub.membershipId, status: 'draft' });
    const get = () => pub.client.attempt(C.get, { params: { ...f.params, contentId: c.id } });
    const listed = async () => (await pub.client.call(C.list, { params: f.params, query: {} })).items.map((i) => i.id);
    expect((await get()).status).toBe(200);
    expect(await listed()).toEqual([c.id]);

    // A cancelled placement is history only: the content is indistinguishable from a missing one.
    await db().update(publications).set({ status: 'cancelled', cancelReason: 'Plan changed' }).where(eq(publications.id, placementId));
    expect((await get()).status).toBe(404);
    expect(await listed()).toEqual([]);

    // A trashed placement grants nothing either, whatever its status.
    await db().update(publications).set({ status: 'draft', deletedAt: new Date() }).where(eq(publications.id, placementId));
    expect((await get()).status).toBe(404);
    expect(await listed()).toEqual([]);

    // Restored to a live placement, access comes back.
    await db().update(publications).set({ deletedAt: null }).where(eq(publications.id, placementId));
    expect((await get()).status).toBe(200);
  });
});
