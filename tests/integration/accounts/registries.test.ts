import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { accountEndpoints as A, dealEndpoints as D, partnerEndpoints as P, referenceEndpoints as R, seriesEndpoints as S, lookupEndpoints, shellEndpoints } from '@castlane/api-contracts';
import { accountAssignments, deals, socialAccounts } from '@castlane/database';
import {
  ARCHIVE_HANDLERS,
  EXPORT_DATASETS_REGISTRY,
  IMPORT_DATASETS_REGISTRY,
  RESPONSIBILITY_PROVIDERS,
  executeCommand,
  getAppServices,
  memberJobContext,
} from '@castlane/application';
import { addMember, assignToProject, clientFor, createProject, sessionFor } from '../../support';
import { baseSetup, db, insertPublication } from './support';

const ctxFor = async (workspaceId: string, membershipId: string) => (await memberJobContext(getAppServices(), workspaceId, membershipId, { source: 'import' }))!;

describe('accounts import/export datasets', () => {
  it('validates rows (unknown project, bad URL, duplicates), applies with policies and undoes untouched rows', async () => {
    const { ws, owner, project, W } = await baseSetup();
    const existing = await owner.call(A.create, { params: W, body: { platform: 'instagram', profileUrl: 'https://instagram.com/emma.daily', projectId: project.id, ownerMembershipId: ws.owner.membershipId } });
    const ds = IMPORT_DATASETS_REGISTRY.get('accounts')!;
    const ctx = await ctxFor(ws.workspaceId, ws.owner.membershipId);
    const bad = await ds.validate(ctx, { platform: 'myspace', profile_url: 'ftp://x', project: 'Nope', owner: 'nobody@test.invalid' }, { duplicatePolicy: 'error', rowNo: 1 });
    expect(bad.errors.map((e) => e.field).sort()).toEqual(['owner', 'platform', 'project']);
    const dupError = await ds.validate(ctx, { platform: 'instagram', profile_url: 'https://www.instagram.com/emma.daily/?utm_source=x', project: 'Emma Model', owner: ws.owner.email }, { duplicatePolicy: 'error', rowNo: 2 });
    expect(dupError.errors[0]?.code).toBe('DUPLICATE');
    const revise = await ds.validate(ctx, { platform: 'instagram', profile_url: 'https://instagram.com/emma.daily', project: project.id, owner: ws.owner.email, purpose: 'Main feed' }, { duplicatePolicy: 'revise_existing', rowNo: 3 });
    expect(revise).toMatchObject({ action: 'update', targetId: existing.id, targetRowVersion: existing.rowVersion });
    const fresh = await ds.validate(ctx, { platform: 'tiktok', profile_url: 'https://www.tiktok.com/@emma.daily', project: 'emma model', owner: ws.owner.membershipId, status: 'active', tags: ['beauty'] }, { duplicatePolicy: 'error', rowNo: 4 });
    expect(fresh.errors).toEqual([]);
    const r = await executeCommand(ctx, async (c) => [
      await ds.apply(c, revise.normalized, { action: 'update', targetId: revise.targetId, targetRowVersion: revise.targetRowVersion }),
      await ds.apply(c, fresh.normalized, { action: 'create' }),
    ]);
    const [revised] = await db().select().from(socialAccounts).where(eq(socialAccounts.id, existing.id));
    expect(revised!.purpose).toBe('Main feed');
    const [created] = await db().select().from(socialAccounts).where(eq(socialAccounts.id, r.body[1]!));
    expect(created).toMatchObject({ platform: 'tiktok', status: 'active', handle: 'emma.daily' });
    // Undo is refused once the account has dependent facts; untouched rows are removed from use.
    await insertPublication(ws, { accountId: existing.id, projectId: project.id, status: 'published' });
    await expect(executeCommand(ctx, (c) => ds.undo!(c, existing.id))).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await executeCommand(ctx, (c) => ds.undo!(c, r.body[1]!));
    const list = await owner.call(A.list, { params: W, query: {} });
    expect(list.items.map((i) => i.id)).toEqual([existing.id]);
  });

  it('exports only accounts in the requester’s scope, as of the job boundary', async () => {
    const { ws, owner, project, W } = await baseSetup();
    const other = await createProject(db(), ws, { name: 'Other', type: 'influencer' });
    await owner.call(A.create, { params: W, body: { platform: 'instagram', profileUrl: 'https://instagram.com/mine_1', projectId: project.id, ownerMembershipId: ws.owner.membershipId } });
    await owner.call(A.create, { params: W, body: { platform: 'instagram', profileUrl: 'https://instagram.com/theirs_2', projectId: other.id, ownerMembershipId: ws.owner.membershipId } });
    const lead = await addMember(db(), ws, { roleKey: 'project_lead', scopeType: 'assigned_projects' });
    await assignToProject(db(), ws, project.id, lead.membershipId);
    const ds = EXPORT_DATASETS_REGISTRY.get('accounts')!;
    const rows: Record<string, unknown>[] = [];
    for await (const row of ds.rows(await ctxFor(ws.workspaceId, lead.membershipId), { filters: {}, boundAt: new Date(Date.now() + 60_000), fields: [] })) rows.push(row);
    expect(rows.map((r) => r.handle)).toEqual(['mine_1']);
    const before: Record<string, unknown>[] = [];
    for await (const row of ds.rows(await ctxFor(ws.workspaceId, ws.owner.membershipId), { filters: {}, boundAt: new Date(Date.now() - 3_600_000), fields: [] })) before.push(row);
    expect(before).toHaveLength(0);
  });
});

describe('registries: archive, responsibility, search, lookups', () => {
  it('archive handlers preview obligations and archive/restore accounts, references, partners and deals', async () => {
    const { ws, owner, project, W } = await baseSetup();
    const a = await owner.call(A.create, { params: W, body: { platform: 'instagram', profileUrl: 'https://instagram.com/arch_1', projectId: project.id, ownerMembershipId: ws.owner.membershipId } });
    await insertPublication(ws, { accountId: a.id, projectId: project.id, status: 'scheduled' });
    const ctx = await ctxFor(ws.workspaceId, ws.owner.membershipId);
    const accounts = ARCHIVE_HANDLERS.get('account')!;
    const preview = await accounts.preview(ctx, a.id);
    expect(preview.items.some((i) => i.blocking)).toBe(true);
    await expect(executeCommand(ctx, (c) => accounts.archive(c, a.id, { reason: 'Retired' }))).rejects.toMatchObject({ code: 'INVALID_STATE' });

    const ref = await owner.call(R.create, { params: W, body: { title: 'Rim light', sourceUrl: 'https://example.com/r', whatToReuse: 'Backlight' } });
    await executeCommand(ctx, (c) => ARCHIVE_HANDLERS.get('reference')!.archive(c, ref.id, {}));
    expect((await owner.call(R.get, { params: { ...W, referenceId: ref.id } })).archivedAt).not.toBeNull();
    await executeCommand(ctx, (c) => ARCHIVE_HANDLERS.get('reference')!.restore!(c, ref.id, {}));
    expect((await owner.call(R.get, { params: { ...W, referenceId: ref.id } })).archivedAt).toBeNull();

    const partner = await owner.call(P.create, { params: W, body: { kind: 'person', name: 'Solo Creator', ownerMembershipId: ws.owner.membershipId } });
    const deal = await owner.call(D.create, { params: W, body: { title: 'Collab', partnerId: partner.id, ownerMembershipId: ws.owner.membershipId, projectIds: [project.id] } });
    expect((await ARCHIVE_HANDLERS.get('partner')!.preview(ctx, partner.id)).items[0]?.blocking).toBe(true);
    expect((await ARCHIVE_HANDLERS.get('deal')!.preview(ctx, deal.id)).items[0]?.blocking).toBe(true);
    for (const h of ['account', 'character', 'reference', 'partner', 'deal']) expect(ARCHIVE_HANDLERS.has(h)).toBe(true);
  });

  it('responsibility providers list and transfer account ownership, assignments and deal ownership (F12)', async () => {
    const { ws, owner, project, W } = await baseSetup();
    const leaving = await addMember(db(), ws, { roleKey: 'project_lead', scopeType: 'assigned_projects' });
    const successor = await addMember(db(), ws, { roleKey: 'project_lead', scopeType: 'assigned_projects' });
    const a = await owner.call(A.create, { params: W, body: { platform: 'instagram', profileUrl: 'https://instagram.com/resp_1', projectId: project.id, ownerMembershipId: leaving.membershipId } });
    await owner.call(A.assign, { params: { ...W, accountId: a.id }, body: { membershipId: leaving.membershipId, duty: 'publishing' } });
    const partner = await owner.call(P.create, { params: W, body: { kind: 'organization', name: 'Brand', ownerMembershipId: ws.owner.membershipId } });
    const deal = await owner.call(D.create, { params: W, body: { title: 'Brand deal', partnerId: partner.id, ownerMembershipId: leaving.membershipId, projectIds: [project.id] } });
    const ctx = await ctxFor(ws.workspaceId, ws.owner.membershipId);
    const owners = await RESPONSIBILITY_PROVIDERS.get('accounts.owner')!.list(ctx, leaving.membershipId);
    const assignments = await RESPONSIBILITY_PROVIDERS.get('accounts.assignment')!.list(ctx, leaving.membershipId);
    const dealOwners = await RESPONSIBILITY_PROVIDERS.get('deals.owner')!.list(ctx, leaving.membershipId);
    expect(owners.map((o) => o.entityId)).toEqual([a.id]);
    expect(assignments).toHaveLength(1);
    expect(dealOwners.map((o) => o.entityId)).toEqual([deal.id]);
    await executeCommand(ctx, async (c) => {
      await RESPONSIBILITY_PROVIDERS.get('accounts.owner')!.transfer(c, leaving.membershipId, [{ entityId: a.id, successorMembershipId: successor.membershipId }]);
      await RESPONSIBILITY_PROVIDERS.get('accounts.assignment')!.transfer(c, leaving.membershipId, [{ entityId: assignments[0]!.entityId, successorMembershipId: successor.membershipId }]);
      await RESPONSIBILITY_PROVIDERS.get('deals.owner')!.transfer(c, leaving.membershipId, [{ entityId: deal.id, successorMembershipId: null }]);
    });
    const [acc] = await db().select().from(socialAccounts).where(eq(socialAccounts.id, a.id));
    expect(acc!.ownerMembershipId).toBe(successor.membershipId);
    const rows = await db().select().from(accountAssignments).where(eq(accountAssignments.accountId, a.id));
    expect(rows.find((r) => r.membershipId === leaving.membershipId)!.validTo).not.toBeNull();
    expect(rows.find((r) => r.membershipId === successor.membershipId)!.validTo).toBeNull();
    const [d] = await db().select().from(deals).where(eq(deals.id, deal.id));
    expect(d!.ownerMembershipId).toBe(ws.owner.membershipId);
  });

  it('indexes accounts, references, partners and deals for permission-aware search', async () => {
    const { ws, owner, project, W } = await baseSetup();
    const other = await createProject(db(), ws, { name: 'Other', type: 'influencer' });
    await owner.call(A.create, { params: W, body: { platform: 'instagram', profileUrl: 'https://instagram.com/zephyr_glow', projectId: project.id, ownerMembershipId: ws.owner.membershipId } });
    await owner.call(A.create, { params: W, body: { platform: 'instagram', profileUrl: 'https://instagram.com/zephyr_hidden', projectId: other.id, ownerMembershipId: ws.owner.membershipId } });
    await owner.call(R.create, { params: W, body: { title: 'Zephyr lighting', sourceUrl: 'https://example.com/z', whatToReuse: 'Soft key', projectId: project.id } });
    const partner = await owner.call(P.create, { params: W, body: { kind: 'organization', name: 'Zephyr Labs', ownerMembershipId: ws.owner.membershipId } });
    await owner.call(D.create, { params: W, body: { title: 'Zephyr launch', partnerId: partner.id, ownerMembershipId: ws.owner.membershipId, projectIds: [project.id] } });
    const all = await owner.call(shellEndpoints.search, { params: W, query: { q: 'zephyr', limit: 20 } });
    expect(all.results.map((r) => r.entityType).sort()).toEqual(['account', 'account', 'deal', 'partner', 'reference']);
    const lead = await addMember(db(), ws, { roleKey: 'project_lead', scopeType: 'assigned_projects' });
    await assignToProject(db(), ws, project.id, lead.membershipId);
    const lc = await clientFor(await sessionFor(db(), lead.userId));
    const scoped = await lc.call(shellEndpoints.search, { params: W, query: { q: 'zephyr', limit: 20 } });
    expect(scoped.results.map((r) => r.title).sort()).toEqual(['@zephyr_glow', 'Zephyr launch', 'Zephyr lighting']);
    expect(scoped.results.find((r) => r.entityType === 'account')!.href).toContain('/accounts/');
  });

  it('series lookups follow the series scope', async () => {
    const { ws, owner, W } = await baseSetup();
    const series = await createProject(db(), ws, { name: 'Night Shift', type: 'series' });
    const season = await owner.call(S.createSeason, { params: { ...W, projectId: series.id }, body: { name: 'Season 1' } });
    const ep = await owner.call(S.createEpisode, { params: { ...W, seasonId: season.id }, body: { number: 1, title: 'Pilot' } });
    await owner.call(S.createScene, { params: { ...W, episodeId: ep.id }, body: { title: 'Opening' } });
    for (const type of ['season', 'episode', 'scene'] as const) {
      const r = await owner.call(lookupEndpoints.search, { params: { ...W, type }, query: { projectId: series.id } });
      expect(r.items).toHaveLength(1);
    }
    const outsider = await addMember(db(), ws, { roleKey: 'creator', scopeType: 'assigned_projects' });
    const oc = await clientFor(await sessionFor(db(), outsider.userId));
    expect((await oc.call(lookupEndpoints.search, { params: { ...W, type: 'episode' }, query: {} })).items).toHaveLength(0);
  });
});
