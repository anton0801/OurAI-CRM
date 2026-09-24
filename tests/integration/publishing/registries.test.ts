import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { campaignEndpoints as C, experimentEndpoints as X, lookupEndpoints, publicationEndpoints as P, shellEndpoints, trackingLinkEndpoints as TL } from '@castlane/api-contracts';
import {
  ARCHIVE_HANDLERS,
  EXPORT_DATASETS_REGISTRY,
  RESPONSIBILITY_PROVIDERS,
  executeCommand,
  getAppServices,
  loadAccessSnapshot,
  type QueryContext,
} from '@castlane/application';
import { campaigns, publications } from '@castlane/database';
import { resetClock } from '../../support';
import { at, db, insertContent, memberClient, publish, scheduled, setup, type Fixture } from './support';

afterEach(() => resetClock());

const ctxFor = async (f: Fixture, userId: string, membershipId: string): Promise<QueryContext> => {
  const app = getAppServices();
  const access = (await loadAccessSnapshot(app.db, f.ws.workspaceId, userId, app.clock.now()))!;
  return {
    app,
    actor: { kind: 'user', userId, membershipId, workspaceId: f.ws.workspaceId, displayName: 'Test', access, timezone: 'Europe/Berlin' },
    request: { requestId: 'test', source: 'ui' },
  };
};

const collect = async (key: string, ctx: QueryContext, filters: Record<string, unknown> = {}) => {
  const rows: Record<string, unknown>[] = [];
  for await (const r of EXPORT_DATASETS_REGISTRY.get(key)!.rows(ctx, { filters, boundAt: new Date(Date.now() + 10 * 365 * 86_400_000), fields: [] })) rows.push(r);
  return rows;
};

describe('publishing registries', () => {
  it('indexes placements and campaigns for search within scope, and serves pickers', async () => {
    const f = await setup();
    const p = await scheduled(f.owner, f);
    await publish(f.owner, f, p, { externalUrl: 'https://www.instagram.com/p/SEARCHME1/' });
    const c = await f.owner.call(C.create, { params: f.W, body: { name: 'Solstice Push', objective: 'Launch the solstice set', ownerMembershipId: f.ws.owner.membershipId, startDate: '2030-06-01', endDate: '2030-06-30', projectIds: [f.project.id] } });
    await f.owner.call(TL.create, { params: { ...f.W, campaignId: c.id }, body: { label: 'Solstice bio', destinationUrl: 'https://shop.example/solstice', utmSource: 'ig' } });
    const e = await f.owner.call(X.create, {
      params: f.W,
      body: { hypothesis: 'Solstice captions with emojis perform better', projectId: f.project.id, ownerMembershipId: f.ws.owner.membershipId, primaryMetricKey: 'publication.likes', observationWindowHours: 24, minimumSample: 1, variants: [{ name: 'Emoji' }, { name: 'Plain' }] },
    });
    const byUrl = await f.owner.call(shellEndpoints.search, { params: f.W, query: { q: 'SEARCHME1' } });
    expect(byUrl.results.map((r) => r.entityId)).toContain(p.id);
    const byTitle = await f.owner.call(shellEndpoints.search, { params: f.W, query: { q: 'Solstice' } });
    expect(byTitle.results.map((r) => r.entityType).sort()).toEqual(expect.arrayContaining(['campaign', 'experiment']));
    const lead = await memberClient(f.ws, 'project_lead', { projects: [f.other.id] });
    const hidden = await lead.client.call(shellEndpoints.search, { params: f.W, query: { q: 'Solstice' } });
    expect(JSON.stringify(hidden)).not.toContain(c.id);
    expect(JSON.stringify(await lead.client.call(shellEndpoints.search, { params: f.W, query: { q: 'SEARCHME1' } }))).not.toContain(p.id);
    for (const type of ['campaign', 'experiment', 'tracking_link'] as const) {
      const own = await f.owner.call(lookupEndpoints.search, { params: { ...f.W, type }, query: {} });
      expect(own.items).toHaveLength(1);
      const other = await lead.client.attempt(lookupEndpoints.search, { params: { ...f.W, type }, query: {} });
      expect(other.ok ? other.data!.items : []).toHaveLength(0);
    }
    expect((await f.owner.call(lookupEndpoints.search, { params: { ...f.W, type: 'experiment' }, query: { ids: [e.id] } })).items[0]!.id).toBe(e.id);
  });

  it('exports publications and campaigns with the member’s scope applied', async () => {
    const f = await setup();
    const mine = await scheduled(f.owner, f);
    const nova = await insertContent(f.ws, f.other.id, { title: 'Nova teaser' });
    const theirs = await scheduled(f.owner, f, { accountId: f.otherAccountId, contentItemId: nova.id, contentVersionId: nova.approvedVersionId! });
    await f.owner.call(C.create, { params: f.W, body: { name: 'Nova only', objective: 'Nova launch', ownerMembershipId: f.ws.owner.membershipId, startDate: '2030-06-01', endDate: '2030-06-30', projectIds: [f.other.id] } });
    const owner = await collect('publications', await ctxFor(f, f.ws.owner.userId, f.ws.owner.membershipId));
    expect(owner.map((r) => r.id).sort()).toEqual([mine.id, theirs.id].sort());
    expect(owner.find((r) => r.id === mine.id)).toMatchObject({ status: 'scheduled', content_title: 'Morning Routine Reel', scheduled_at: at(26), schedule_timezone: 'Europe/Berlin' });
    const lead = await memberClient(f.ws, 'project_lead', { projects: [f.project.id] });
    const leadCtx = await ctxFor(f, lead.userId, lead.membershipId);
    expect((await collect('publications', leadCtx)).map((r) => r.id)).toEqual([mine.id]);
    expect(await collect('campaigns', leadCtx)).toHaveLength(0);
    expect(await collect('campaigns', await ctxFor(f, f.ws.owner.userId, f.ws.owner.membershipId))).toHaveLength(1);
  });

  it('transfers open placements and campaigns of a leaving member only to successors who can reach them', async () => {
    const f = await setup();
    const leaving = await memberClient(f.ws, 'publisher', { accounts: [f.accountId] });
    const p = await scheduled(f.owner, f, { ownerMembershipId: leaving.membershipId });
    const outsider = await memberClient(f.ws, 'publisher', { accounts: [f.otherAccountId] });
    const successor = await memberClient(f.ws, 'publisher', { accounts: [f.accountId] });
    const ctx = await ctxFor(f, f.ws.owner.userId, f.ws.owner.membershipId);
    const provider = RESPONSIBILITY_PROVIDERS.get('publications.owner')!;
    const items = await provider.list(ctx, leaving.membershipId);
    expect(items).toEqual([expect.objectContaining({ entityId: p.id, requiresSuccessor: true, title: 'Morning Routine Reel' })]);
    await expect(executeCommand(ctx, (c) => provider.transfer(c, leaving.membershipId, [{ entityId: p.id, successorMembershipId: outsider.membershipId }]))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await executeCommand(ctx, (c) => provider.transfer(c, leaving.membershipId, [{ entityId: p.id, successorMembershipId: successor.membershipId }]));
    const [row] = await db().select().from(publications).where(eq(publications.id, p.id));
    expect(row!.ownerMembershipId).toBe(successor.membershipId);
    // Without a successor the account owner (here the workspace owner) takes over.
    const p2 = await scheduled(f.owner, f, { ownerMembershipId: leaving.membershipId, scheduledAt: at(60) });
    await executeCommand(ctx, (c) => provider.transfer(c, leaving.membershipId, [{ entityId: p2.id, successorMembershipId: null }]));
    expect((await db().select().from(publications).where(eq(publications.id, p2.id)))[0]!.ownerMembershipId).toBe(f.ws.owner.membershipId);
    // Campaign ownership.
    const lead = await memberClient(f.ws, 'project_lead', { projects: [f.project.id] });
    const c = await f.owner.call(C.create, { params: f.W, body: { name: 'Owned by lead', objective: 'Test ownership', ownerMembershipId: lead.membershipId, startDate: '2030-06-01', endDate: '2030-06-30', projectIds: [f.project.id] } });
    const cp = RESPONSIBILITY_PROVIDERS.get('campaigns.owner')!;
    expect((await cp.list(ctx, lead.membershipId)).map((i) => i.entityId)).toEqual([c.id]);
    const stranger = await memberClient(f.ws, 'project_lead', { projects: [f.other.id] });
    await expect(executeCommand(ctx, (x) => cp.transfer(x, lead.membershipId, [{ entityId: c.id, successorMembershipId: stranger.membershipId }]))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await executeCommand(ctx, (x) => cp.transfer(x, lead.membershipId, [{ entityId: c.id, successorMembershipId: null }]));
    expect((await db().select().from(campaigns).where(eq(campaigns.id, c.id)))[0]!.ownerMembershipId).toBe(f.ws.owner.membershipId);
  });

  it('archives, trashes and restores through the generic Archive screen handlers', async () => {
    const f = await setup();
    const ctx = await ctxFor(f, f.ws.owner.userId, f.ws.owner.membershipId);
    const handler = ARCHIVE_HANDLERS.get('publication')!;
    const s = await scheduled(f.owner, f);
    expect((await handler.preview(ctx, s.id)).items.some((i) => i.blocking)).toBe(true);
    await expect(executeCommand(ctx, (c) => handler.archive(c, s.id, {}))).rejects.toMatchObject({ code: 'INVALID_STATE' });
    const published = (await publish(f.owner, f, s, { externalUrl: 'https://www.instagram.com/p/ARCH1/' })).data!;
    await executeCommand(ctx, (c) => handler.archive(c, published.id, { reason: 'Season wrapped' }));
    expect((await f.owner.call(P.list, { params: f.W, query: {} })).items.map((i) => i.id)).not.toContain(published.id);
    expect((await handler.list!(ctx, { state: 'archived', limit: 10 })).map((i) => i.id)).toEqual([published.id]);
    await executeCommand(ctx, (c) => handler.restore!(c, published.id, {}));
    const draft = await f.owner.call(P.create, { params: f.W, body: { contentItemId: f.content.id, accountId: f.accountId, ownerMembershipId: f.ws.owner.membershipId } });
    await expect(executeCommand(ctx, (c) => handler.trash!(c, published.id, 'Not a draft'))).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await executeCommand(ctx, (c) => handler.trash!(c, draft.id, 'Duplicate plan'));
    expect((await f.owner.attempt(P.get, { params: { ...f.W, publicationId: draft.id } })).status).toBe(404);
    expect((await handler.list!(ctx, { state: 'trash', limit: 10 })).map((i) => i.id)).toEqual([draft.id]);
    await executeCommand(ctx, (c) => handler.untrash!(c, draft.id, {}));
    expect((await f.owner.call(P.get, { params: { ...f.W, publicationId: draft.id } })).status).toBe('draft');
    // Campaign and experiment handlers.
    const c = await f.owner.call(C.create, { params: f.W, body: { name: 'Archive me', objective: 'Short test', ownerMembershipId: f.ws.owner.membershipId, startDate: '2030-06-01', endDate: '2030-06-02', projectIds: [f.project.id] } });
    await executeCommand(ctx, (x) => ARCHIVE_HANDLERS.get('campaign')!.archive(x, c.id, { reason: 'Never ran' }));
    expect((await ARCHIVE_HANDLERS.get('campaign')!.list!(ctx, { state: 'archived', limit: 10 })).map((i) => i.id)).toEqual([c.id]);
    const e = await f.owner.call(X.create, {
      params: f.W,
      body: { hypothesis: 'Archive handler experiment hypothesis', projectId: f.project.id, ownerMembershipId: f.ws.owner.membershipId, primaryMetricKey: 'publication.views', observationWindowHours: 24, minimumSample: 1, variants: [{ name: 'A' }, { name: 'B' }] },
    });
    await executeCommand(ctx, (x) => ARCHIVE_HANDLERS.get('experiment')!.archive(x, e.id, {}));
    await executeCommand(ctx, (x) => ARCHIVE_HANDLERS.get('experiment')!.restore!(x, e.id, {}));
    expect((await f.owner.call(X.get, { params: { ...f.W, experimentId: e.id } })).status).toBe('draft');
  });
});
