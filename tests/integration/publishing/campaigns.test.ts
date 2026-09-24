import { afterEach, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import {
  campaignEndpoints as C,
  dealEndpoints as D,
  lookupEndpoints,
  partnerEndpoints as PT,
  publicationEndpoints as P,
  sourceReportEndpoints as SR,
  trackingLinkEndpoints as TL,
} from '@castlane/api-contracts';
import { campaigns, financeCategories, financialAllocations, financialEntries, financialEntryLines, trackingLinks } from '@castlane/database';
import { newId } from '@castlane/domain';
import { assignToProject, resetClock, type TestWorkspace } from '../../support';
import { at, db, insertContent, memberClient, scheduled, setup, type Fixture } from './support';

afterEach(() => resetClock());

const campaignBody = (f: Fixture, extra: Record<string, unknown> = {}) => ({
  name: 'Summer Glow',
  objective: 'Grow reach of the summer skincare series',
  ownerMembershipId: f.ws.owner.membershipId,
  startDate: '2030-06-01',
  endDate: '2030-06-30',
  projectIds: [f.project.id, f.other.id],
  ...extra,
});

/** An expense document with one line, linked to a campaign (the finance module's rows, inserted directly). */
const insertExpense = async (ws: TestWorkspace, input: { campaignId: string; amountMinor: bigint; state?: 'draft' | 'posted'; categoryKey?: string }) => {
  const [cat] = await db().select().from(financeCategories).where(and(eq(financeCategories.workspaceId, ws.workspaceId), eq(financeCategories.key, input.categoryKey ?? 'advertising')));
  const entryId = newId();
  const lineId = newId();
  const now = new Date();
  await db().insert(financialEntries).values({ id: entryId, workspaceId: ws.workspaceId, type: 'expense', state: 'draft', recognitionDate: '2030-06-02', title: 'Paid promotion', campaignId: input.campaignId, createdAt: now, updatedAt: now });
  await db()
    .insert(financialEntryLines)
    .values({ id: lineId, workspaceId: ws.workspaceId, entryId, lineNo: 1, categoryId: cat!.id, accountingClass: cat!.accountingClass, amountMinor: input.amountMinor, currency: 'EUR', baseCurrency: 'EUR', baseAmountMinor: input.amountMinor, createdAt: now, updatedAt: now });
  if (input.state === 'posted') await db().update(financialEntries).set({ state: 'posted', postedAt: now }).where(eq(financialEntries.id, entryId));
  return { entryId, lineId };
};

describe('campaigns', () => {
  it('runs a multi-project campaign: scope through any project, changes need every project, statuses with summary/reason', async () => {
    const f = await setup();
    const c = await f.owner.call(C.create, { params: f.W, body: campaignBody(f) });
    expect(c).toMatchObject({ status: 'planned', publications: { planned: 0, published: 0 }, confirmedResults: { clicks: null, conversions: null, reports: 0 } });
    expect(c.projects.map((p) => p.id).sort()).toEqual([f.project.id, f.other.id].sort());
    // Budget is omitted (not null) without budgets.read.
    const leadA = await memberClient(f.ws, 'project_lead', { projects: [f.project.id] });
    const seen = await leadA.client.call(C.get, { params: { ...f.W, campaignId: c.id } });
    expect('budget' in seen).toBe(false);
    expect(seen.permissions.update).toBe(false);
    expect((await leadA.client.attempt(C.update, { params: { ...f.W, campaignId: c.id }, body: { name: 'Renamed' } }, { ifMatch: c.rowVersion })).status).toBe(403);
    const leadC = await memberClient(f.ws, 'project_lead', { projects: [] });
    expect((await leadC.client.attempt(C.get, { params: { ...f.W, campaignId: c.id } })).status).toBe(404);
    expect((await leadC.client.call(C.list, { params: f.W, query: {} })).items).toHaveLength(0);
    expect((await leadC.client.call(lookupEndpoints.search, { params: { ...f.W, type: 'campaign' }, query: {} })).items).toHaveLength(0);
    expect((await leadA.client.call(C.list, { params: f.W, query: {} })).items.map((i) => i.id)).toEqual([c.id]);
    // End before start is refused; transitions need a summary/reason.
    expect((await f.owner.attempt(C.create, { params: f.W, body: campaignBody(f, { startDate: '2030-07-01', endDate: '2030-06-01' }) })).status).toBe(422);
    const active = await f.owner.call(C.transition, { params: { ...f.W, campaignId: c.id }, body: { targetStatus: 'active' } }, { ifMatch: c.rowVersion });
    expect((await f.owner.attempt(C.transition, { params: { ...f.W, campaignId: c.id }, body: { targetStatus: 'closed' } }, { ifMatch: active.rowVersion })).status).toBe(422);
    expect((await f.owner.attempt(C.archive, { params: { ...f.W, campaignId: c.id }, body: {} }, { ifMatch: active.rowVersion })).status).toBe(409);
    const closed = await f.owner.call(C.transition, { params: { ...f.W, campaignId: c.id }, body: { targetStatus: 'closed', closingSummary: 'Reach up, costs within plan' } }, { ifMatch: active.rowVersion });
    expect(closed.closingSummary).toBe('Reach up, costs within plan');
    expect((await f.owner.attempt(C.transition, { params: { ...f.W, campaignId: c.id }, body: { targetStatus: 'active' } }, { ifMatch: closed.rowVersion })).status).toBe(422);
    const reopened = await f.owner.call(C.transition, { params: { ...f.W, campaignId: c.id }, body: { targetStatus: 'active', reason: 'Extended by the partner' } }, { ifMatch: closed.rowVersion });
    expect(reopened.status).toBe('active');
    expect((await f.owner.attempt(C.transition, { params: { ...f.W, campaignId: c.id }, body: { targetStatus: 'planned' } }, { ifMatch: reopened.rowVersion })).status).toBe(409);
  });

  it('builds tagged links without clicks; results come only from entered source reports (T070)', async () => {
    const f = await setup();
    const c = await f.owner.call(C.create, { params: f.W, body: campaignBody(f) });
    const preview = await f.owner.call(TL.preview, { params: f.W, query: { destinationUrl: 'https://shop.example/summer?utm_source=newsletter&ref=1', utmSource: 'instagram', utmMedium: 'social', utmCampaign: 'summer glow' } });
    expect(preview.valid).toBe(true);
    expect(preview.url).toBe('https://shop.example/summer?utm_source=newsletter&ref=1&utm_medium=social&utm_campaign=summer+glow');
    expect(preview.conflicts).toEqual([{ key: 'utm_source', existing: 'newsletter', proposed: 'instagram' }]);
    const body = { label: 'Bio link', destinationUrl: 'https://shop.example/summer?utm_source=newsletter', utmSource: 'instagram', utmMedium: 'social', utmCampaign: 'summer glow' };
    const refused = await f.owner.attempt(TL.create, { params: { ...f.W, campaignId: c.id }, body });
    expect(refused.status).toBe(422);
    const link = await f.owner.call(TL.create, { params: { ...f.W, campaignId: c.id }, body: { ...body, overwriteConflicts: true } });
    expect(link.builtUrl).toBe('https://shop.example/summer?utm_source=instagram&utm_medium=social&utm_campaign=summer+glow');
    expect(link.reportedClicks).toBeNull();
    expect((await f.owner.attempt(TL.create, { params: { ...f.W, campaignId: c.id }, body: { label: 'Unsafe', destinationUrl: 'javascript:alert(1)' } })).status).toBe(422);
    let results = await f.owner.call(C.results, { params: { ...f.W, campaignId: c.id } });
    expect(results.totals.clicks.value).toBeNull();
    expect(results.totals.conversions.value).toBeNull();
    expect(results.sources).toHaveLength(0);
    expect(results.trackingLinks).toBe(1);
    // Manual assignments need an explanation; a report with only clicks keeps conversions unknown.
    const manual = await f.owner.attempt(SR.create, { params: { ...f.W, campaignId: c.id }, body: { sourceName: 'Shop analytics', periodStart: at(-24 * 3), periodEnd: at(-24), clicks: 120, attributionLabel: 'manual_assignment' } });
    expect(manual.status).toBe(422);
    expect((await f.owner.attempt(SR.create, { params: { ...f.W, campaignId: c.id }, body: { sourceName: 'Shop analytics', periodStart: at(-24), periodEnd: at(24), clicks: 1, attributionLabel: 'source_reported' } })).status).toBe(422);
    await f.owner.call(SR.create, { params: { ...f.W, campaignId: c.id }, body: { sourceName: 'Shop analytics', periodStart: at(-24 * 3), periodEnd: at(-24), clicks: 120, trackingLinkId: link.id, attributionLabel: 'source_reported' } });
    results = await f.owner.call(C.results, { params: { ...f.W, campaignId: c.id } });
    expect(results.totals.clicks.value).toBe('120');
    expect(results.totals.conversions.value).toBeNull();
    expect(results.sources[0]!.conversionRate.value).toBeNull();
    // A second, overlapping report of the same source is kept but not summed.
    const r2 = await f.owner.call(SR.create, { params: { ...f.W, campaignId: c.id }, body: { sourceName: 'Shop analytics', periodStart: at(-48), periodEnd: at(-2), clicks: 80, conversions: 4, attributionLabel: 'source_reported' } });
    results = await f.owner.call(C.results, { params: { ...f.W, campaignId: c.id } });
    expect(results.sources[0]!.overlapping).toBe(true);
    expect(results.sources[0]!.clicks.value).toBeNull();
    // Correct the period (audited) → both count, conversion rate only when both values are known on every report.
    await f.owner.call(SR.update, { params: { ...f.W, reportId: r2.id }, body: { periodStart: at(-24), periodEnd: at(-2), reason: 'Wrong start date' } }, { ifMatch: r2.rowVersion });
    results = await f.owner.call(C.results, { params: { ...f.W, campaignId: c.id } });
    expect(results.sources[0]).toMatchObject({ overlapping: false, clicks: { value: '200' }, conversions: { value: '4' } });
    expect(results.sources[0]!.conversionRate.value).toBeNull();
    const links = await f.owner.call(TL.list, { params: f.W, query: { campaignId: c.id } });
    expect(links[0]!.reportedClicks).toBe('120');
  });

  it('allocates a shared campaign cost exactly across projects; tags never double count (T071)', async () => {
    const f = await setup();
    const third = (await import('../../support')).createProject;
    const p3 = await third(db(), f.ws, { directionId: f.directionId, name: 'Luna' });
    const c = await f.owner.call(C.create, { params: f.W, body: campaignBody(f, { projectIds: [f.project.id, f.other.id, p3.id] }) });
    const second = await f.owner.call(C.create, { params: f.W, body: campaignBody(f, { name: 'Autumn', projectIds: [f.project.id] }) });
    const { lineId, entryId } = await insertExpense(f.ws, { campaignId: c.id, amountMinor: 10001n, state: 'posted' });
    // Before the split the whole line is the campaign's, marked as not allocated to projects.
    let costs = await f.owner.call(C.costs, { params: { ...f.W, campaignId: c.id } });
    expect(costs.totals).toEqual([{ currency: 'EUR', posted: '100.01', pending: '0.00' }]);
    expect(costs.incompleteAllocation).toBe(true);
    costs = await f.owner.call(C.allocateCost, { params: { ...f.W, campaignId: c.id }, body: { lineId, method: 'equal', shares: [{ projectId: f.project.id }, { projectId: f.other.id }, { projectId: p3.id }] } });
    const parts = costs.lines[0]!.allocations.map((a) => a.amount.amount);
    expect(parts.sort()).toEqual(['33.33', '33.34', '33.34'].sort());
    expect(costs.totals[0]).toMatchObject({ posted: '100.01' });
    expect(costs.incompleteAllocation).toBe(false);
    const rows = await db().select().from(financialAllocations).where(eq(financialAllocations.lineId, lineId));
    expect(rows.reduce((s, r) => s + r.amountMinor, 0n)).toBe(10001n);
    expect(rows.reduce((s, r) => s + (r.baseAmountMinor ?? 0n), 0n)).toBe(10001n);
    const firstIds = new Set(rows.map((r) => r.id));
    // Tagging placements with other campaigns/tags never adds cost; re-allocation supersedes (no second expense).
    await scheduled(f.owner, f, { campaignId: c.id });
    const other = await insertContent(f.ws, f.project.id, { title: 'Tagged' });
    await f.owner.call(P.create, {
      params: f.W,
      body: { contentItemId: other.id, accountId: f.accountId, ownerMembershipId: f.ws.owner.membershipId, primaryCampaignId: second.id, descriptiveTags: ['summer glow', 'skincare'] },
    });
    costs = await f.owner.call(C.allocateCost, {
      params: { ...f.W, campaignId: c.id },
      body: { lineId, method: 'weights', shares: [{ projectId: f.project.id, weight: '2' }, { projectId: f.other.id, weight: '1' }], reason: 'Luna did not run the promotion' },
    });
    expect(costs.totals[0]!.posted).toBe('100.01');
    expect(costs.lines[0]!.allocations.map((a) => a.amount.amount).sort()).toEqual(['33.34', '66.67']);
    // Posted allocations are append-only: the old split is transferred out, the new one added, and the
    // line still totals exactly the source amount (no second expense).
    const all = await db().select().from(financialAllocations).where(eq(financialAllocations.lineId, lineId));
    expect(all.reduce((s, r) => s + r.amountMinor, 0n)).toBe(10001n);
    const adjustments = all.filter((r) => !firstIds.has(r.id));
    expect(adjustments.length).toBeGreaterThan(0);
    expect(adjustments.every((r) => r.adjustmentOfId !== null)).toBe(true);
    const secondCosts = await f.owner.call(C.costs, { params: { ...f.W, campaignId: second.id } });
    expect(secondCosts.lines).toHaveLength(0);
    // Exact amounts must add up; projects outside the campaign are refused.
    expect((await f.owner.attempt(C.allocateCost, { params: { ...f.W, campaignId: c.id }, body: { lineId, method: 'amounts', shares: [{ projectId: f.project.id, amount: '50.00' }, { projectId: f.other.id, amount: '50.00' }] } })).status).toBe(422);
    const outsider = await (await import('../../support')).createProject(db(), f.ws, { directionId: f.directionId, name: 'Outside' });
    expect((await f.owner.attempt(C.allocateCost, { params: { ...f.W, campaignId: c.id }, body: { lineId, method: 'equal', shares: [{ projectId: outsider.id }] } })).status).toBe(422);
    // Finance amounts need finance permissions: a project lead gets 403.
    const lead = await memberClient(f.ws, 'project_lead', { projects: [f.project.id, f.other.id, p3.id] });
    expect((await lead.client.attempt(C.costs, { params: { ...f.W, campaignId: c.id } })).status).toBe(403);
    expect((await lead.client.call(C.get, { params: { ...f.W, campaignId: c.id } })).permissions.readCosts).toBe(false);
    expect(entryId).toBeTruthy();
  });

  it('duplicates the structure only and links deals through the deals module', async () => {
    const f = await setup();
    const c = await f.owner.call(C.create, { params: f.W, body: campaignBody(f, { goals: [{ metricKey: 'publication.views', target: '100000', unit: 'count' }], tags: ['summer'] }) });
    await f.owner.call(TL.create, { params: { ...f.W, campaignId: c.id }, body: { label: 'Bio', destinationUrl: 'https://shop.example/', utmSource: 'ig' } });
    await scheduled(f.owner, f, { campaignId: c.id });
    await f.owner.call(SR.create, { params: { ...f.W, campaignId: c.id }, body: { sourceName: 'Shop', periodStart: at(-48), periodEnd: at(-24), clicks: 5, attributionLabel: 'source_reported' } });
    const copy = await f.owner.call(C.duplicate, { params: { ...f.W, campaignId: c.id }, body: { name: 'Summer Glow 2031', startDate: '2031-06-01', endDate: '2031-06-30', copyTrackingLinks: true } });
    expect(copy).toMatchObject({ status: 'planned', goals: c.goals, tags: ['summer'], publications: { planned: 0, published: 0 }, confirmedResults: { clicks: null, reports: 0 } });
    expect(copy.duplicatedFrom?.id).toBe(c.id);
    expect(await db().select().from(trackingLinks).where(eq(trackingLinks.campaignId, copy.id))).toHaveLength(1);
    // Link a deal from the campaign side (the deal's own command keeps its version and audit).
    const partner = await f.owner.call(PT.create, { params: f.W, body: { kind: 'organization', name: 'Glow Cosmetics', ownerMembershipId: f.ws.owner.membershipId } });
    const deal = await f.owner.call(D.create, { params: f.W, body: { title: 'Glow collab', partnerId: partner.id, ownerMembershipId: f.ws.owner.membershipId, projectIds: [f.project.id] } });
    const linked = await f.owner.call(C.linkDeal, { params: { ...f.W, campaignId: copy.id }, body: { dealId: deal.id } });
    expect(linked.deals.map((d) => d.id)).toEqual([deal.id]);
    expect((await f.owner.call(D.get, { params: { ...f.W, dealId: deal.id } })).campaign?.id).toBe(copy.id);
    expect((await f.owner.attempt(C.linkDeal, { params: { ...f.W, campaignId: c.id }, body: { dealId: deal.id } })).status).toBe(409);
    const unlinked = await f.owner.call(C.linkDeal, { params: { ...f.W, campaignId: copy.id }, body: { dealId: deal.id, unlink: true } });
    expect(unlinked.deals).toHaveLength(0);
    // Deal → Create Campaign goes through the campaigns module (planned, partner and projects copied).
    const d2 = await f.owner.call(D.get, { params: { ...f.W, dealId: deal.id } });
    const withCampaign = await f.owner.call(D.createCampaign, { params: { ...f.W, dealId: deal.id }, body: { name: 'Glow launch', objective: 'Launch awareness', startDate: '2030-06-10', endDate: '2030-06-20' } }, { ifMatch: d2.rowVersion });
    const [row] = await db().select().from(campaigns).where(eq(campaigns.id, withCampaign.campaign!.id));
    expect(row).toMatchObject({ status: 'planned', partnerId: partner.id });
    // Archive a closed campaign; it disappears from the default list but stays readable.
    const closed = await f.owner.call(C.transition, { params: { ...f.W, campaignId: copy.id }, body: { targetStatus: 'closed', closingSummary: 'Not run this year' } }, { ifMatch: unlinked.rowVersion });
    const archived = await f.owner.call(C.archive, { params: { ...f.W, campaignId: copy.id }, body: { reason: 'Cleanup' } }, { ifMatch: closed.rowVersion });
    expect(archived.status).toBe('archived');
    expect((await f.owner.call(C.list, { params: f.W, query: {} })).items.map((i) => i.id)).not.toContain(copy.id);
    const restored = await f.owner.call(C.restore, { params: { ...f.W, campaignId: copy.id } }, { ifMatch: archived.rowVersion });
    expect(restored.status).toBe('closed');
  });

  it('refuses removing a project with placements of the campaign and a primary campaign outside the placement’s project', async () => {
    const f = await setup();
    const c = await f.owner.call(C.create, { params: f.W, body: campaignBody(f, { projectIds: [f.other.id] }) });
    const r = await f.owner.attempt(P.create, { params: f.W, body: { contentItemId: f.content.id, accountId: f.accountId, ownerMembershipId: f.ws.owner.membershipId, primaryCampaignId: c.id } });
    expect(r.status).toBe(422);
    const upd = await f.owner.call(C.update, { params: { ...f.W, campaignId: c.id }, body: { projectIds: [f.other.id, f.project.id] } }, { ifMatch: c.rowVersion });
    await scheduled(f.owner, f, { campaignId: c.id });
    expect((await f.owner.attempt(C.update, { params: { ...f.W, campaignId: c.id }, body: { projectIds: [f.other.id] } }, { ifMatch: upd.rowVersion })).status).toBe(409);
    await assignToProject(db(), f.ws, f.project.id, f.ws.owner.membershipId);
  });
});
