import { describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { ofmEndpoints as E } from '@castlane/api-contracts';
import { getAppServices, runContactRetention } from '@castlane/application';
import { auditEvents, deletionTombstones, interactionLogs, notifications, ofmContacts, outboxEvents, saleCandidates, searchDocuments } from '@castlane/database';
import { addMember, clientFor, runQueuedJobs, sessionFor } from '../../support';
import { db, ofmSetup } from './helpers';

const SECRET_NOTE = 'Prefers late-evening chats; mentioned his divorce';

describe('OFM contacts (S45/S46)', () => {
  it('T095: the same alias on two accounts is two contacts; duplicates per account are refused; no cross-account merge', async () => {
    const s = await ofmSetup();
    const a = await s.manager.client.call(E.createContact, { params: s.p, body: { accountId: s.accountA, externalIdentifier: 'user_1001', alias: 'Mike' } });
    const b = await s.manager.client.call(E.createContact, { params: s.p, body: { accountId: s.accountB, externalIdentifier: 'user_1001', alias: 'Mike' } });
    expect(a.id).not.toBe(b.id);
    const dup = await s.manager.client.attempt(E.createContact, { params: s.p, body: { accountId: s.accountA, externalIdentifier: 'user_1001', alias: 'Michael' } });
    expect(dup.status).toBe(409);
    const cross = await s.supervisor.client.attempt(E.mergePreview, { params: s.p, body: { sourceId: a.id, targetId: b.id } });
    expect(cross.status).toBe(409);
    const rows = await db().select().from(ofmContacts).where(eq(ofmContacts.workspaceId, s.ws.workspaceId));
    expect(rows).toHaveLength(2);
    // An explicit pseudonymous relation needs its own permission (Owner holds it; managers do not).
    const denied = await s.manager.client.attempt(E.relateContacts, { params: { ...s.p, contactId: a.id }, body: { relatedContactId: b.id, reason: 'Same writing style' } });
    expect(denied.status).toBe(403);
    const related = await s.owner.call(E.relateContacts, { params: { ...s.p, contactId: a.id }, body: { relatedContactId: b.id, reason: 'Same writing style' } });
    expect(related.relations).toHaveLength(1);
  });

  it('T096: merging same-account contacts keeps every reference and never duplicates sales', async () => {
    const s = await ofmSetup();
    const src = await s.manager.client.call(E.createContact, { params: s.p, body: { accountId: s.accountA, externalIdentifier: 'old_handle', alias: 'Rob', businessNotes: 'Asked for a custom set' } });
    const tgt = await s.manager.client.call(E.createContact, { params: s.p, body: { accountId: s.accountA, externalIdentifier: 'new_handle', alias: 'Robert' } });
    await s.manager.client.call(E.createInteraction, { params: s.p, body: { contactId: src.id, type: 'request', occurredAt: new Date().toISOString(), businessNote: 'Custom set request' } });
    await s.manager.client.call(E.createInteraction, { params: s.p, body: { contactId: tgt.id, type: 'message_summary', occurredAt: new Date().toISOString(), businessNote: 'Thanked for delivery' } });
    await s.manager.client.call(E.createOperation, { params: s.p, body: { type: 'content_request', accountId: s.accountA, contactId: src.id, ownerMembershipId: s.manager.membershipId, title: 'Custom set' } });
    await s.manager.client.call(E.createSaleCandidate, { params: s.p, body: { accountId: s.accountA, sourceNamespace: 'OnlyFans', sourceTransactionId: 'tx-1', occurredAt: new Date().toISOString(), currency: 'EUR', gross: '25.00', contactId: src.id } });
    await s.manager.client.call(E.createSaleCandidate, { params: s.p, body: { accountId: s.accountA, sourceNamespace: 'OnlyFans', sourceTransactionId: 'tx-2', occurredAt: new Date().toISOString(), currency: 'EUR', gross: '10.00', contactId: tgt.id } });
    // Managers cannot merge; the supervisor previews and merges.
    expect((await s.manager.client.attempt(E.mergePreview, { params: s.p, body: { sourceId: src.id, targetId: tgt.id } })).status).toBe(403);
    const preview = await s.supervisor.client.call(E.mergePreview, { params: s.p, body: { sourceId: src.id, targetId: tgt.id } });
    expect(preview.moves).toEqual({ interactions: 1, operations: 1, saleCandidates: 1, relations: 0 });
    expect(preview.saleTransactionRefs.map((r) => r.sourceTransactionId).sort()).toEqual(['tx-1', 'tx-2']);
    const merged = await s.supervisor.client.call(E.merge, { params: s.p, body: { previewToken: preview.previewToken, fieldResolutions: { alias: 'target', managerMembershipId: 'target', stage: 'target', nextFollowUpAt: 'target', businessNotes: 'both' } } });
    expect(merged.id).toBe(tgt.id);
    expect(merged.businessNotes).toContain('Asked for a custom set');
    expect(merged.operations).toHaveLength(1);
    expect(merged.saleCandidates).toHaveLength(2);
    const interactions = await db().select().from(interactionLogs).where(eq(interactionLogs.contactId, tgt.id));
    expect(interactions).toHaveLength(2);
    // Authors are preserved.
    expect(interactions.every((i) => i.membershipId === s.manager.membershipId)).toBe(true);
    // Sales were moved, not duplicated or summed; source ids stay unique.
    const sales = await db().select().from(saleCandidates).where(eq(saleCandidates.workspaceId, s.ws.workspaceId));
    expect(sales).toHaveLength(2);
    expect(sales.every((x) => x.contactId === tgt.id)).toBe(true);
    // The old id redirects.
    const old = await s.supervisor.client.call(E.getContact, { params: { ...s.p, contactId: src.id } });
    expect(old.mergedIntoId).toBe(tgt.id);
    const list = await s.supervisor.client.call(E.listContacts, { params: s.p, query: {} });
    expect(list.items.map((c) => c.id)).toEqual([tgt.id]);
    // The preview token cannot be replayed after the contacts changed.
    const replay = await s.supervisor.client.attempt(E.merge, { params: s.p, body: { previewToken: preview.previewToken } });
    expect(replay.ok).toBe(false);
  });

  it('T171: raw contact notes never reach notifications, audit diffs, search, outbox payloads or job payloads', async () => {
    const s = await ofmSetup();
    const c = await s.supervisor.client.call(E.createContact, {
      params: s.p,
      body: { accountId: s.accountA, externalIdentifier: 'secret_user', alias: 'Secret Alias', businessNotes: SECRET_NOTE, managerMembershipId: s.manager.membershipId },
    });
    await s.manager.client.call(E.createInteraction, { params: s.p, body: { contactId: c.id, type: 'issue', occurredAt: new Date().toISOString(), businessNote: SECRET_NOTE } });
    await s.manager.client.call(E.updateContact, { params: { ...s.p, contactId: c.id }, body: { businessNotes: `${SECRET_NOTE} (updated)` } }, { ifMatch: (await s.manager.client.call(E.getContact, { params: { ...s.p, contactId: c.id } })).rowVersion });
    const serialized = async (q: Promise<unknown[]>) => JSON.stringify(await q);
    const ws = s.ws.workspaceId;
    expect(await serialized(db().select().from(notifications).where(eq(notifications.workspaceId, ws)))).not.toContain('divorce');
    expect(await serialized(db().select().from(notifications).where(eq(notifications.workspaceId, ws)))).not.toContain('Secret Alias');
    expect(await serialized(db().select().from(auditEvents).where(eq(auditEvents.workspaceId, ws)))).not.toContain('divorce');
    expect(await serialized(db().select().from(auditEvents).where(eq(auditEvents.workspaceId, ws)))).not.toContain('Secret Alias');
    expect(await serialized(db().select().from(outboxEvents).where(eq(outboxEvents.workspaceId, ws)))).not.toContain('divorce');
    expect(await serialized(db().select().from(searchDocuments).where(eq(searchDocuments.workspaceId, ws)))).not.toContain('divorce');
    const [job] = (await db().execute(sql`SELECT count(*)::int AS n FROM jobs WHERE payload::text LIKE '%divorce%'`)).rows as { n: number }[];
    expect(job!.n).toBe(0);
    // The assignment notification exists but carries neither alias nor excerpt.
    const note = (await db().select().from(notifications).where(and(eq(notifications.workspaceId, ws), eq(notifications.recipientMembershipId, s.manager.membershipId)))).find((n) => n.entityType === 'ofm_contact');
    expect(note?.excerpt ?? null).toBeNull();
  });

  it('contacts are a separate permission: members without it get 403, managers see only their accounts, restricted contacts stay with their manager', async () => {
    const s = await ofmSetup({ assignManagers: false });
    await s.assignment(s.manager.membershipId, s.accountA);
    await s.assignment(s.manager2.membershipId, s.accountB);
    const onA = await s.owner.call(E.createContact, { params: s.p, body: { accountId: s.accountA, externalIdentifier: 'a1', alias: 'Alpha' } });
    const onB = await s.owner.call(E.createContact, { params: s.p, body: { accountId: s.accountB, externalIdentifier: 'b1', alias: 'Beta' } });
    const listA = await s.manager.client.call(E.listContacts, { params: s.p, query: {} });
    expect(listA.items.map((i) => i.id)).toEqual([onA.id]);
    expect((await s.manager.client.attempt(E.getContact, { params: { ...s.p, contactId: onB.id } })).status).toBe(404);
    // Search is restricted to the visible scope.
    expect((await s.manager.client.call(E.listContacts, { params: s.p, query: { q: 'Beta' } })).items).toHaveLength(0);
    // An Admin does not see contacts without an explicit grant (§7.2).
    const admin = await addMember(db(), s.ws, { roleKey: 'admin' });
    const adminC = await clientFor(await sessionFor(db(), admin.userId));
    expect((await adminC.attempt(E.listContacts, { params: s.p, query: {} })).status).toBe(403);
    // Restricted contact: only its manager and merge holders (supervisor).
    const restricted = await s.owner.call(E.createContact, { params: s.p, body: { accountId: s.accountA, externalIdentifier: 'vip', alias: 'Vip', restricted: true, managerMembershipId: s.supervisor.membershipId } });
    expect((await s.manager.client.attempt(E.getContact, { params: { ...s.p, contactId: restricted.id } })).status).toBe(404);
    expect((await s.supervisor.client.call(E.getContact, { params: { ...s.p, contactId: restricted.id } })).restricted).toBe(true);
    // Operations linked to a contact show it only as restricted to members without contact access.
    const op = await s.owner.call(E.createOperation, { params: s.p, body: { type: 'follow_up', accountId: s.accountA, contactId: onA.id, ownerMembershipId: s.manager.membershipId, title: 'Follow up' } });
    const lead = await addMember(db(), s.ws, { roleKey: 'direction_lead', scopeType: 'workspace' });
    const leadC = await clientFor(await sessionFor(db(), lead.userId));
    const seen = await leadC.call(E.getOperation, { params: { ...s.p, operationId: op.id } });
    expect(seen.contact).toEqual({ id: onA.id, restricted: true });
    // Card numbers and credentials are refused.
    const card = await s.manager.client.attempt(E.createContact, { params: s.p, body: { accountId: s.accountA, externalIdentifier: 'x9', alias: 'Card', businessNotes: 'card 4111 1111 1111 1111' } });
    expect(card.status).toBe(422);
  });

  it('erasure pseudonymises the contact, deletes personal notes and keeps financial links; retention clears archived notes', async () => {
    const s = await ofmSetup();
    const c = await s.owner.call(E.createContact, { params: s.p, body: { accountId: s.accountA, externalIdentifier: 'to_erase', alias: 'Erase Me', businessNotes: SECRET_NOTE } });
    await s.owner.call(E.createInteraction, { params: s.p, body: { contactId: c.id, type: 'request', occurredAt: new Date().toISOString(), businessNote: SECRET_NOTE } });
    await s.owner.call(E.createSaleCandidate, { params: s.p, body: { accountId: s.accountA, sourceNamespace: 'onlyfans', sourceTransactionId: 'tx-erase', occurredAt: new Date().toISOString(), currency: 'EUR', gross: '9.99', contactId: c.id } });
    const denied = await s.supervisor.client.attempt(E.requestErasure, { params: { ...s.p, contactId: c.id }, body: { reason: 'Data subject request' } });
    expect(denied.status).toBe(403);
    const req = await s.owner.call(E.requestErasure, { params: { ...s.p, contactId: c.id }, body: { reason: 'Data subject request' } });
    expect(req.state).toBe('queued');
    const twice = await s.owner.attempt(E.requestErasure, { params: { ...s.p, contactId: c.id }, body: { reason: 'Data subject request' } });
    expect(twice.status).toBe(409);
    await runQueuedJobs(['ofm.contact_erasure']);
    const [row] = await db().select().from(ofmContacts).where(eq(ofmContacts.id, c.id));
    expect(row!.alias).toMatch(/^Erased contact/);
    expect(row!.businessNotes).toBeNull();
    expect(row!.erasedAt).not.toBeNull();
    const logs = await db().select().from(interactionLogs).where(eq(interactionLogs.contactId, c.id));
    expect(logs.every((l) => !l.businessNote.includes('divorce') && l.erasedAt)).toBe(true);
    const [sale] = await db().select().from(saleCandidates).where(eq(saleCandidates.sourceTransactionId, 'tx-erase'));
    expect(sale!.contactId).toBe(c.id);
    expect(await db().select().from(deletionTombstones).where(eq(deletionTombstones.entityId, c.id))).toHaveLength(1);
    const detail = await s.owner.call(E.getContact, { params: { ...s.p, contactId: c.id } });
    expect(detail.erasureRequests[0]!.state).toBe('completed');

    // Retention: an archived contact's notes are removed after the policy period.
    const old = await s.owner.call(E.createContact, { params: s.p, body: { accountId: s.accountA, externalIdentifier: 'old', alias: 'Old', businessNotes: 'Old notes' } });
    await s.owner.call(E.archiveContact, { params: { ...s.p, contactId: old.id }, body: { reason: 'Inactive for a year' } }, { ifMatch: old.rowVersion });
    await db().update(ofmContacts).set({ archivedAt: new Date(Date.now() - 181 * 86_400_000) }).where(eq(ofmContacts.id, old.id));
    await runContactRetention(getAppServices());
    const [aged] = await db().select().from(ofmContacts).where(eq(ofmContacts.id, old.id));
    expect(aged!.businessNotes).toBeNull();
    expect(aged!.alias).toBe('Old');
  });
});
