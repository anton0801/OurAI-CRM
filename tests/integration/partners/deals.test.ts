import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { newIdempotencyKey } from '@castlane/api-client';
import { dealEndpoints as D, partnerEndpoints as P, lookupEndpoints } from '@castlane/api-contracts';
import { campaigns, dealStageEvents, financialEntries, notifications, revenueAttributions, settlements } from '@castlane/database';
import { EXPORT_DATASETS_REGISTRY, getAppServices, memberJobContext } from '@castlane/application';
import { addMember, assignToProject, clientFor, createAccount, createProject, sessionFor } from '../../support';
import { baseSetup, db } from '../accounts/support';

const setup = async () => {
  const base = await baseSetup();
  const { owner, W, ws, project } = base;
  const partner = await owner.call(P.create, { params: W, body: { kind: 'organization', name: 'Glow Cosmetics', contactName: 'Anna', businessEmail: 'anna@glow.example', ownerMembershipId: ws.owner.membershipId } });
  const deal = await owner.call(D.create, {
    params: W,
    body: { title: 'Spring launch', partnerId: partner.id, ownerMembershipId: ws.owner.membershipId, projectIds: [project.id], amount: { amount: '2500.00', currency: 'EUR' } },
  });
  return { ...base, partner, deal };
};

describe('deals', () => {
  it('Won never creates paid or posted income (T138)', async () => {
    const { ws, owner, deal, W } = await setup();
    expect(deal.stage).toBe('lead');
    expect(deal.amount).toEqual({ amount: '2500.00', currency: 'EUR' });
    let d = await owner.call(D.transition, { params: { ...W, dealId: deal.id }, body: { targetStage: 'negotiation' } }, { ifMatch: deal.rowVersion });
    d = await owner.call(D.transition, { params: { ...W, dealId: deal.id }, body: { targetStage: 'won', outcome: 'Signed for 3 posts' } }, { ifMatch: d.rowVersion });
    expect(d.stage).toBe('won');
    expect(d.closedAt).toBeNull();
    const entries = await db().select().from(financialEntries).where(eq(financialEntries.workspaceId, ws.workspaceId));
    const cash = await db().select().from(settlements).where(eq(settlements.workspaceId, ws.workspaceId));
    const attributions = await db().select().from(revenueAttributions).where(eq(revenueAttributions.workspaceId, ws.workspaceId));
    expect([entries.length, cash.length, attributions.length]).toEqual([0, 0, 0]);
    const events = await db().select().from(dealStageEvents).where(eq(dealStageEvents.dealId, deal.id));
    expect(events.map((e) => e.toStage).sort()).toEqual(['lead', 'negotiation', 'won']);
    expect(d.stageEvents[0]).toMatchObject({ fromStage: 'negotiation', toStage: 'won' });
    // Won → Delivering → Fulfilled; stale versions and invalid moves are refused.
    expect((await owner.attempt(D.transition, { params: { ...W, dealId: deal.id }, body: { targetStage: 'lead' } }, { ifMatch: d.rowVersion })).status).toBe(409);
    expect((await owner.attempt(D.transition, { params: { ...W, dealId: deal.id }, body: { targetStage: 'delivering' } }, { ifMatch: d.rowVersion - 1 })).status).toBe(412);
    d = await owner.call(D.transition, { params: { ...W, dealId: deal.id }, body: { targetStage: 'delivering' } }, { ifMatch: d.rowVersion });
    const deliverable = await owner.call(D.createDeliverable, { params: { ...W, dealId: deal.id }, body: { title: 'Reel #1', format: 'short_video', acceptanceCriteria: 'Product visible in the first 3 s' } });
    d = await owner.call(D.get, { params: { ...W, dealId: deal.id } });
    const blocked = await owner.attempt(D.transition, { params: { ...W, dealId: deal.id }, body: { targetStage: 'fulfilled' } }, { ifMatch: d.rowVersion });
    expect(blocked.status).toBe(409);
    let dl = await owner.call(D.transitionDeliverable, { params: { ...W, deliverableId: deliverable.id }, body: { targetStatus: 'delivered' } }, { ifMatch: deliverable.rowVersion });
    expect((await owner.attempt(D.transitionDeliverable, { params: { ...W, deliverableId: deliverable.id }, body: { targetStatus: 'open' } }, { ifMatch: dl.rowVersion })).status).toBe(422);
    dl = await owner.call(D.transitionDeliverable, { params: { ...W, deliverableId: deliverable.id }, body: { targetStatus: 'accepted' } }, { ifMatch: dl.rowVersion });
    d = await owner.call(D.transition, { params: { ...W, dealId: deal.id }, body: { targetStage: 'fulfilled' } }, { ifMatch: d.rowVersion });
    expect(d.stage).toBe('fulfilled');
    expect(d.closedAt).not.toBeNull();
    expect((await db().select().from(financialEntries).where(eq(financialEntries.workspaceId, ws.workspaceId))).length).toBe(0);
    const archived = await owner.call(D.archive, { params: { ...W, dealId: deal.id }, body: {} }, { ifMatch: d.rowVersion });
    expect(archived.archivedAt).not.toBeNull();
  });

  it('Lost and Cancelled need a reason; reopening a lost deal needs one too', async () => {
    const { owner, deal, W } = await setup();
    const noReason = await owner.attempt(D.transition, { params: { ...W, dealId: deal.id }, body: { targetStage: 'lost' } }, { ifMatch: deal.rowVersion });
    expect(noReason.status).toBe(422);
    const lost = await owner.call(D.transition, { params: { ...W, dealId: deal.id }, body: { targetStage: 'lost', reason: 'Budget moved to Q3' } }, { ifMatch: deal.rowVersion });
    expect(lost.stageReason).toBe('Budget moved to Q3');
    expect((await owner.attempt(D.transition, { params: { ...W, dealId: deal.id }, body: { targetStage: 'discussing' } }, { ifMatch: lost.rowVersion })).status).toBe(422);
    const reopened = await owner.call(D.transition, { params: { ...W, dealId: deal.id }, body: { targetStage: 'discussing', reason: 'Partner came back' } }, { ifMatch: lost.rowVersion });
    expect(reopened.closedAt).toBeNull();
    // Stage changes are idempotent under replay.
    const key = newIdempotencyKey();
    const a = await owner.call(D.transition, { params: { ...W, dealId: deal.id }, body: { targetStage: 'proposal' } }, { idempotencyKey: key, ifMatch: reopened.rowVersion });
    const b = await owner.call(D.transition, { params: { ...W, dealId: deal.id }, body: { targetStage: 'proposal' } }, { idempotencyKey: key, ifMatch: reopened.rowVersion });
    expect(b.rowVersion).toBe(a.rowVersion);
  });

  it('amounts are finance data: omitted without finance access and not settable', async () => {
    const { ws, deal, project, W } = await setup();
    const lead = await addMember(db(), ws, { roleKey: 'project_lead', scopeType: 'assigned_projects' });
    await assignToProject(db(), ws, project.id, lead.membershipId);
    const lc = await clientFor(await sessionFor(db(), lead.userId));
    const d = await lc.call(D.get, { params: { ...W, dealId: deal.id } });
    expect('amount' in d).toBe(false);
    expect('paymentSchedule' in d).toBe(false);
    expect(d.permissions.viewAmounts).toBe(false);
    const list = await lc.call(D.list, { params: W, query: {} });
    expect('amount' in list.items[0]!).toBe(false);
    const set = await lc.attempt(D.update, { params: { ...W, dealId: deal.id }, body: { amount: { amount: '1.00', currency: 'EUR' } } }, { ifMatch: d.rowVersion });
    expect(set.status).toBe(403);
    // Other edits keep the stored amount untouched.
    await lc.call(D.update, { params: { ...W, dealId: deal.id }, body: { title: 'Spring launch (3 reels)' } }, { ifMatch: d.rowVersion });
    const finance = await addMember(db(), ws, { roleKey: 'finance_manager' });
    const fc = await clientFor(await sessionFor(db(), finance.userId));
    expect((await fc.call(D.get, { params: { ...W, dealId: deal.id } })).amount).toEqual({ amount: '2500.00', currency: 'EUR' });
    // Export: amount column is empty for the lead, filled for finance.
    const ds = EXPORT_DATASETS_REGISTRY.get('deals')!;
    const leadCtx = (await memberJobContext(getAppServices(), ws.workspaceId, lead.membershipId))!;
    const rows: Record<string, unknown>[] = [];
    for await (const r of ds.rows(leadCtx, { filters: {}, boundAt: new Date(Date.now() + 60_000), fields: [] })) rows.push(r);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amount).toBeNull();
    const finCtx = (await memberJobContext(getAppServices(), ws.workspaceId, finance.membershipId))!;
    const frows: Record<string, unknown>[] = [];
    for await (const r of ds.rows(finCtx, { filters: {}, boundAt: new Date(Date.now() + 60_000), fields: [] })) frows.push(r);
    expect(frows[0]!.amount).toBe('2500.00');
  });

  it('scopes deals and partners by project; counts never leak', async () => {
    const { ws, owner, partner, deal, project, W } = await setup();
    const other = await createProject(db(), ws, { name: 'Other', type: 'influencer' });
    const hiddenDeal = await owner.call(D.create, { params: W, body: { title: 'Secret deal', partnerId: partner.id, ownerMembershipId: ws.owner.membershipId, projectIds: [other.id] } });
    const hiddenPartner = await owner.call(P.create, { params: W, body: { kind: 'person', name: 'Private Person', ownerMembershipId: ws.owner.membershipId } });
    const lead = await addMember(db(), ws, { roleKey: 'project_lead', scopeType: 'assigned_projects' });
    await assignToProject(db(), ws, project.id, lead.membershipId);
    const lc = await clientFor(await sessionFor(db(), lead.userId));
    expect((await lc.call(D.list, { params: W, query: {} })).items.map((d) => d.id)).toEqual([deal.id]);
    expect((await lc.attempt(D.get, { params: { ...W, dealId: hiddenDeal.id } })).status).toBe(404);
    const partners = await lc.call(P.list, { params: W, query: {} });
    expect(partners.items.map((p) => p.id)).toEqual([partner.id]);
    expect(partners.items[0]!.activeDeals).toBe(1);
    expect((await lc.attempt(P.get, { params: { ...W, partnerId: hiddenPartner.id } })).status).toBe(404);
    const detail = await lc.call(P.get, { params: { ...W, partnerId: partner.id } });
    expect(detail.deals.map((d) => d.id)).toEqual([deal.id]);
    expect(detail.hiddenDealCount).toBe(1);
    const lookup = await lc.call(lookupEndpoints.search, { params: { ...W, type: 'deal' }, query: {} });
    expect(lookup.items.map((i) => i.id)).toEqual([deal.id]);
    // A lead can create and see partners they own; not deals in projects outside their scope.
    const own = await lc.call(P.create, { params: W, body: { kind: 'person', name: 'Creator Collab', ownerMembershipId: lead.membershipId } });
    expect(own.owner.membershipId).toBe(lead.membershipId);
    const forOthers = await lc.attempt(P.create, { params: W, body: { kind: 'person', name: 'Someone else', ownerMembershipId: ws.owner.membershipId } });
    expect(forOthers.status).toBe(403);
    const outside = await lc.attempt(D.create, { params: W, body: { title: 'Sneaky', partnerId: own.id, ownerMembershipId: lead.membershipId, projectIds: [other.id] } });
    expect(outside.status).toBe(422);
    const viewer = await addMember(db(), ws, { roleKey: 'viewer' });
    const vc = await clientFor(await sessionFor(db(), viewer.userId));
    expect((await vc.attempt(D.transition, { params: { ...W, dealId: deal.id }, body: { targetStage: 'discussing' } }, { ifMatch: deal.rowVersion })).status).toBe(403);
    const creator = await addMember(db(), ws, { roleKey: 'creator', scopeType: 'assigned_projects' });
    const cc = await clientFor(await sessionFor(db(), creator.userId));
    expect((await cc.attempt(D.list, { params: W, query: {} })).status).toBe(403);
  });

  it('deliverables link accounts and content of the deal’s projects only; campaign creation links a planned campaign', async () => {
    const { ws, owner, deal, project, W } = await setup();
    const other = await createProject(db(), ws, { name: 'Other', type: 'influencer' });
    const acc = await createAccount(db(), ws, { projectId: project.id });
    const foreignAcc = await createAccount(db(), ws, { projectId: other.id });
    const ok = await owner.call(D.createDeliverable, { params: { ...W, dealId: deal.id }, body: { title: 'Story set', accountId: acc, dueAt: '2026-10-10T10:00:00Z', agreedAmount: { amount: '500', currency: 'EUR' } } });
    expect(ok.project?.id).toBe(project.id);
    expect(ok.agreedAmount).toEqual({ amount: '500.00', currency: 'EUR' });
    const bad = await owner.attempt(D.createDeliverable, { params: { ...W, dealId: deal.id }, body: { title: 'Wrong account', accountId: foreignAcc } });
    expect(bad.status).toBe(422);
    const withCampaign = await owner.call(D.createCampaign, { params: { ...W, dealId: deal.id }, body: { name: 'Glow Spring', objective: 'Launch awareness', startDate: '2026-10-01', endDate: '2026-10-31' } }, { ifMatch: deal.rowVersion });
    expect(withCampaign.campaign?.name).toBe('Glow Spring');
    const [c] = await db().select().from(campaigns).where(eq(campaigns.id, withCampaign.campaign!.id));
    expect(c).toMatchObject({ status: 'planned', partnerId: deal.partner.id });
    const again = await owner.attempt(D.createCampaign, { params: { ...W, dealId: deal.id }, body: { name: 'Twice', objective: 'Again', startDate: '2026-10-01', endDate: '2026-10-31' } }, { ifMatch: withCampaign.rowVersion });
    expect(again.status).toBe(409);
  });
});

describe('partners', () => {
  it('logs interactions, notifies new owners and merges partners with a preview token', async () => {
    const { ws, owner, partner, deal, W } = await setup();
    const note = await owner.call(P.logInteraction, { params: { ...W, partnerId: partner.id }, body: { occurredAt: new Date(Date.now() - 3_600_000).toISOString(), kind: 'call', summary: 'Agreed on three reels', dealId: deal.id } });
    expect(note.deal?.id).toBe(deal.id);
    const future = await owner.attempt(P.logInteraction, { params: { ...W, partnerId: partner.id }, body: { occurredAt: new Date(Date.now() + 86_400_000).toISOString(), kind: 'note', summary: 'Not yet' } });
    expect(future.status).toBe(422);
    const list = await owner.call(P.interactions, { params: { ...W, partnerId: partner.id }, query: {} });
    expect(list.items).toHaveLength(1);
    expect((await owner.call(P.get, { params: { ...W, partnerId: partner.id } })).lastInteractionAt).not.toBeNull();

    const colleague = await addMember(db(), ws, { roleKey: 'admin' });
    const dup = await owner.call(P.create, { params: W, body: { kind: 'organization', name: 'Glow Cosmetics GmbH', website: 'https://glow.example', ownerMembershipId: ws.owner.membershipId, tags: ['beauty'] } });
    const moved = await owner.call(P.update, { params: { ...W, partnerId: dup.id }, body: { ownerMembershipId: colleague.membershipId } }, { ifMatch: dup.rowVersion });
    const n = await db().select().from(notifications).where(eq(notifications.recipientMembershipId, colleague.membershipId));
    expect(n.map((x) => x.eventType)).toContain('partner.owner_assigned');

    const preview = await owner.call(P.mergePreview, { params: { ...W, partnerId: partner.id }, query: { targetId: dup.id } });
    expect(preview.moves).toEqual({ deals: 1, interactions: 1 });
    expect(preview.differences.map((d) => d.field)).toContain('Website');
    const forged = await owner.attempt(P.merge, { params: { ...W, partnerId: partner.id }, body: { targetId: dup.id, previewToken: '1.forged-token-value' } }, { ifMatch: partner.rowVersion + 1 });
    expect([409, 412]).toContain(forged.status);
    const current = await owner.call(P.get, { params: { ...W, partnerId: partner.id } });
    const merged = await owner.call(P.merge, { params: { ...W, partnerId: partner.id }, body: { targetId: dup.id, previewToken: preview.previewToken } }, { ifMatch: current.rowVersion });
    expect(merged.id).toBe(dup.id);
    expect(merged.deals.map((d) => d.id)).toEqual([deal.id]);
    expect(merged.contactName).toBe('Anna');
    const source = await owner.call(P.get, { params: { ...W, partnerId: partner.id } });
    expect(source.mergedInto?.id).toBe(dup.id);
    expect(source.archivedAt).not.toBeNull();
    const reuse = await owner.attempt(D.create, { params: W, body: { title: 'New deal', partnerId: partner.id, ownerMembershipId: ws.owner.membershipId, projectIds: [deal.projects[0]!.id] } });
    expect(reuse.status).toBe(422);
    void moved;
  });

  it('archiving is blocked while deals are open', async () => {
    const { owner, partner, W } = await setup();
    const p = await owner.call(P.get, { params: { ...W, partnerId: partner.id } });
    const blocked = await owner.attempt(P.archive, { params: { ...W, partnerId: partner.id }, body: {} }, { ifMatch: p.rowVersion });
    expect(blocked.status).toBe(409);
    const invalidEmail = await owner.attempt(P.update, { params: { ...W, partnerId: partner.id }, body: { businessEmail: 'not-an-email' } }, { ifMatch: p.rowVersion });
    expect(invalidEmail.status).toBe(422);
  });
});
