import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { newIdempotencyKey } from '@castlane/api-client';
import { ofmEndpoints as E } from '@castlane/api-contracts';
import { financialEntries, notifications, operations, saleCandidates, tasks } from '@castlane/database';
import { newId } from '@castlane/domain';
import { addMember, clientFor, mutableClock, resetClock, sessionFor } from '../../support';
import { addToProjectTeam, db, insertAsset, ofmSetup } from './helpers';

describe('Operations Queue (S47)', () => {
  it('transitions need Waiting For + Next Check At, an Outcome or a Reason; completion has no payment effect', async () => {
    const s = await ofmSetup();
    const op = await s.manager.client.call(E.createOperation, { params: s.p, body: { type: 'payment_check', accountId: s.accountA, ownerMembershipId: s.manager.membershipId, title: 'Check tip payout' } });
    expect(op.allowedTransitions).toEqual(expect.arrayContaining(['in_progress', 'waiting', 'completed', 'cancelled']));
    const params = { ...s.p, operationId: op.id };
    const waitMissing = await s.manager.client.attempt(E.transitionOperation, { params, body: { targetState: 'waiting' } }, { ifMatch: op.rowVersion });
    expect(waitMissing.status).toBe(422);
    const waiting = await s.manager.client.call(E.transitionOperation, { params, body: { targetState: 'waiting', waitingFor: 'Platform support reply', nextCheckAt: new Date(Date.now() + 86_400_000).toISOString() } }, { ifMatch: op.rowVersion });
    expect(waiting.status).toBe('waiting');
    const noOutcome = await s.manager.client.attempt(E.transitionOperation, { params, body: { targetState: 'completed' } }, { ifMatch: waiting.rowVersion });
    expect(noOutcome.status).toBe(422);
    const done = await s.manager.client.call(E.transitionOperation, { params, body: { targetState: 'completed', outcome: 'Payout confirmed by support' } }, { ifMatch: waiting.rowVersion });
    expect(done.status).toBe('completed');
    expect(done.completedAt).not.toBeNull();
    const reopen = await s.manager.client.attempt(E.transitionOperation, { params, body: { targetState: 'open' } }, { ifMatch: done.rowVersion });
    expect(reopen.status).toBe(409);
    expect(await db().select().from(financialEntries).where(eq(financialEntries.workspaceId, s.ws.workspaceId))).toHaveLength(0);
    // Stale If-Match → 412.
    const stale = await s.manager.client.attempt(E.updateOperation, { params, body: { title: 'Changed title' } }, { ifMatch: op.rowVersion });
    expect(stale.status).toBe(412);
  });

  it('follow-ups keep the contact’s Next Follow-up in sync', async () => {
    const s = await ofmSetup();
    const c = await s.manager.client.call(E.createContact, { params: s.p, body: { accountId: s.accountA, externalIdentifier: 'f1', alias: 'Follow' } });
    const due = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const op = await s.manager.client.call(E.createOperation, { params: s.p, body: { type: 'follow_up', accountId: s.accountA, contactId: c.id, ownerMembershipId: s.manager.membershipId, title: 'Ask about renewal', dueAt: due } });
    expect((await s.manager.client.call(E.getContact, { params: { ...s.p, contactId: c.id } })).nextFollowUpAt).toBe(due);
    await s.manager.client.call(E.transitionOperation, { params: { ...s.p, operationId: op.id }, body: { targetState: 'cancelled', reason: 'Contact went inactive' } }, { ifMatch: op.rowVersion });
    expect((await s.manager.client.call(E.getContact, { params: { ...s.p, contactId: c.id } })).nextFollowUpAt).toBeNull();
  });

  it('T097: a content request gives the creator a brief task without private contact notes or history', async () => {
    const s = await ofmSetup();
    const creator = await addMember(db(), s.ws, { roleKey: 'creator', scopeType: 'assigned_projects' });
    await addToProjectTeam(s.ws.workspaceId, s.project.id, creator.membershipId);
    const creatorC = await clientFor(await sessionFor(db(), creator.userId));
    const c = await s.manager.client.call(E.createContact, { params: s.p, body: { accountId: s.accountA, externalIdentifier: 'req_user', alias: 'Requester', businessNotes: 'PRIVATE: spends a lot on weekends' } });
    await s.manager.client.call(E.createInteraction, { params: s.p, body: { contactId: c.id, type: 'request', occurredAt: new Date().toISOString(), businessNote: 'PRIVATE: asked for a beach set' } });
    const op = await s.manager.client.call(E.createOperation, { params: s.p, body: { type: 'content_request', accountId: s.accountA, contactId: c.id, ownerMembershipId: s.manager.membershipId, title: 'Beach photo set' } });
    const withBrief = await s.manager.client.call(
      E.createContentBrief,
      { params: { ...s.p, operationId: op.id }, body: { creatorMembershipId: creator.membershipId, title: 'Beach photo set (10 images)', brief: 'Ten daylight beach images in the approved style, square crop.' } },
      { ifMatch: op.rowVersion },
    );
    expect(withBrief.task?.title).toBe('Beach photo set (10 images)');
    const [task] = await db().select().from(tasks).where(eq(tasks.operationId, op.id));
    expect(task!.assigneeMembershipId).toBe(creator.membershipId);
    expect(task!.description).toBe('Ten daylight beach images in the approved style, square crop.');
    expect(JSON.stringify(task)).not.toContain('PRIVATE');
    expect(JSON.stringify(task)).not.toContain('Requester');
    const note = (await db().select().from(notifications).where(eq(notifications.recipientMembershipId, creator.membershipId)))[0];
    expect(JSON.stringify(note)).not.toContain('Requester');
    // The creator cannot open the contact, its interactions or the operation.
    expect((await creatorC.attempt(E.getContact, { params: { ...s.p, contactId: c.id } })).status).toBe(403);
    expect((await creatorC.attempt(E.listInteractions, { params: s.p, query: { contactId: c.id } })).status).toBe(403);
    expect((await creatorC.attempt(E.getOperation, { params: { ...s.p, operationId: op.id } })).status).toBe(403);
    // Only one brief task per request.
    const twice = await s.manager.client.attempt(E.createContentBrief, { params: { ...s.p, operationId: op.id }, body: { creatorMembershipId: creator.membershipId, title: 'Again', brief: 'Again' } }, { ifMatch: withBrief.rowVersion });
    expect(twice.status).toBe(409);
  });
});

describe('Sale candidates (§13.5)', () => {
  it('T098: a duplicate source transaction is detected against candidates and finance; revenue is never doubled', async () => {
    const s = await ofmSetup();
    const body = { accountId: s.accountA, sourceNamespace: 'OnlyFans', sourceTransactionId: 'TX-777', occurredAt: new Date().toISOString(), currency: 'EUR', gross: '50.00', fee: '10.00' };
    const key = newIdempotencyKey();
    const first = await s.manager.client.call(E.createSaleCandidate, { params: s.p, body }, { idempotencyKey: key });
    expect(first.state).toBe('pending');
    expect(first.money?.gross).toBe('50.00');
    // Idempotent replay returns the same candidate.
    const replay = await s.manager.client.call(E.createSaleCandidate, { params: s.p, body }, { idempotencyKey: key });
    expect(replay.id).toBe(first.id);
    const dup = await s.manager2.client.attempt(E.createSaleCandidate, { params: s.p, body: { ...body, sourceNamespace: 'onlyfans' } });
    expect(dup.status).toBe(409);
    const check = await s.manager.client.call(E.checkSaleDuplicate, { params: s.p, query: { sourceNamespace: 'onlyfans', sourceTransactionId: 'TX-777' } });
    expect(check.duplicate).toBe(true);
    // A transaction already recorded in finance is refused as well.
    await db().insert(financialEntries).values({ id: newId(), workspaceId: s.ws.workspaceId, type: 'revenue', state: 'posted', recognitionDate: '2026-09-01', title: 'Statement', sourceNamespace: 'onlyfans', sourceExternalId: 'TX-888' });
    const inFinance = await s.manager.client.attempt(E.createSaleCandidate, { params: s.p, body: { ...body, sourceTransactionId: 'TX-888' } });
    expect(inFinance.status).toBe(409);
    expect((inFinance.error as { details?: { alreadyInFinance?: boolean } }).details?.alreadyInFinance).toBe(true);
    // Concurrent registration with different keys: the DB constraint keeps one.
    const both = await Promise.all([
      s.manager.client.attempt(E.createSaleCandidate, { params: s.p, body: { ...body, sourceTransactionId: 'TX-999' } }),
      s.manager2.client.attempt(E.createSaleCandidate, { params: s.p, body: { ...body, sourceTransactionId: 'TX-999' } }),
    ]);
    expect(both.filter((r) => r.ok)).toHaveLength(1);
    const rows = await db().select().from(saleCandidates).where(eq(saleCandidates.workspaceId, s.ws.workspaceId));
    expect(rows.map((r) => r.sourceTransactionId).sort()).toEqual(['TX-777', 'TX-999']);
    expect(await db().select().from(financialEntries).where(eq(financialEntries.workspaceId, s.ws.workspaceId))).toHaveLength(1);
    // Manual references need evidence.
    const manual = await s.manager.client.attempt(E.createSaleCandidate, { params: s.p, body: { ...body, sourceTransactionId: undefined, manualReference: true } });
    expect(manual.status).toBe(422);
    const evidence = await insertAsset(s.ws.workspaceId, s.project.id);
    const manualOk = await s.manager.client.call(E.createSaleCandidate, { params: s.p, body: { ...body, sourceTransactionId: undefined, manualReference: true, evidenceAssetIds: [evidence] } });
    expect(manualOk.sourceTransactionId).toMatch(/^manual-/);
  });

  it('T099: a sale during a shift stays Unassigned without an explicit allocation; shares never exceed 100%', async () => {
    const s = await ofmSetup();
    const shift = await s.schedule(s.manager.membershipId, 1, 5);
    const clock = mutableClock(shift.scheduledStart);
    try {
      await s.manager.client.call(E.startShift, { params: { ...s.p, shiftId: shift.id }, body: {} }, { ifMatch: shift.rowVersion });
      clock.advance(60);
      // Occurs inside the running shift, but no shift link and no allocation are inferred.
      const sale = await s.manager.client.call(E.createSaleCandidate, { params: s.p, body: { accountId: s.accountA, sourceNamespace: 'onlyfans', sourceTransactionId: 'in-shift', occurredAt: clock.now().toISOString(), currency: 'EUR', gross: '20.00' } });
      expect(sale.shift).toBeNull();
      expect(sale.attributionStatus).toBe('unassigned');
      expect(sale.unassignedPercent).toBe('100');
      const over = await s.manager.client.attempt(E.createSaleCandidate, {
        params: s.p,
        body: { accountId: s.accountA, sourceNamespace: 'onlyfans', sourceTransactionId: 'split', occurredAt: clock.now().toISOString(), currency: 'EUR', gross: '20.00', shiftId: shift.id, claimedAllocations: [{ membershipId: s.manager.membershipId, sharePercent: '70' }, { membershipId: s.manager2.membershipId, sharePercent: '40' }] },
      });
      expect(over.status).toBe(422);
      const split = await s.manager.client.call(E.createSaleCandidate, {
        params: s.p,
        body: { accountId: s.accountA, sourceNamespace: 'onlyfans', sourceTransactionId: 'split', occurredAt: clock.now().toISOString(), currency: 'EUR', gross: '20.00', shiftId: shift.id, claimedAllocations: [{ membershipId: s.manager.membershipId, sharePercent: '60' }] },
      });
      expect(split.shift?.id).toBe(shift.id);
      expect(split.attributionStatus).toBe('partial');
      expect(split.unassignedPercent).toBe('40');
      // Amount precision is validated per currency (no silent rounding).
      const precise = await s.manager.client.attempt(E.createSaleCandidate, { params: s.p, body: { accountId: s.accountA, sourceNamespace: 'onlyfans', sourceTransactionId: 'bad-amount', occurredAt: clock.now().toISOString(), currency: 'EUR', gross: '10.005' } });
      expect(precise.status).toBe(422);
      const detail = await s.manager.client.call(E.getShift, { params: { ...s.p, shiftId: shift.id } });
      expect(detail.saleCandidates?.map((x) => x.id)).toEqual([split.id]);
    } finally {
      resetClock();
    }
    void operations;
  });
});
