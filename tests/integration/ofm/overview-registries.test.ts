import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { lookupEndpoints, ofmEndpoints as E } from '@castlane/api-contracts';
import {
  ARCHIVE_HANDLERS,
  EXPORT_DATASETS_REGISTRY,
  IMPORT_DATASETS_REGISTRY,
  RESPONSIBILITY_PROVIDERS,
  executeCommand,
  getAppServices,
  memberJobContext,
} from '@castlane/application';
import { financialEntries, ofmContacts, saleCandidates, shifts } from '@castlane/database';
import { addMember, clientFor, createProject, mutableClock, resetClock, sessionFor } from '../../support';
import { db, ofmSetup } from './helpers';

afterEach(() => resetClock());

const ctxFor = async (workspaceId: string, membershipId: string) => (await memberJobContext(getAppServices(), workspaceId, membershipId, { source: 'import' }))!;

describe('OFM Overview (S40)', () => {
  it('shows unknown values as null (never 0), hides revenue without finance rights and applies scope before aggregation', async () => {
    const s = await ofmSetup();
    const empty = await s.supervisor.client.call(E.overview, { params: s.p, query: {} });
    expect(empty.kpis.assignedModels).toBe(1);
    expect(empty.kpis.netHours.value).toBeNull();
    expect(empty.kpis.handoverCompletion.percent).toBeNull();
    expect(empty.kpis.quality.average).toBeNull();
    expect('revenue' in empty).toBe(false);
    const ownerView = await s.owner.call(E.overview, { params: s.p, query: {} });
    expect(ownerView.revenue?.confirmed).toEqual([]);
    expect(ownerView.revenue?.source).toMatch(/Posted financial entries/);

    // One ended shift without a handover → Missing Handover 1, net hours known, report pending.
    const shift = await s.schedule(s.manager.membershipId, 1, 3);
    const clock = mutableClock(shift.scheduledStart);
    const started = await s.manager.client.call(E.startShift, { params: { ...s.p, shiftId: shift.id }, body: {} }, { ifMatch: shift.rowVersion });
    clock.advance(90);
    const active = await s.supervisor.client.call(E.overview, { params: s.p, query: {} });
    expect(active.kpis.activeShifts).toBe(1);
    await s.manager.client.call(E.endShift, { params: { ...s.p, shiftId: shift.id }, body: {} }, { ifMatch: started.rowVersion });
    clock.advance(1);
    const after = await s.supervisor.client.call(E.overview, { params: s.p, query: { from: new Date(clock.now().getTime() - 86_400_000).toISOString(), to: clock.now().toISOString() } });
    expect(after.kpis.activeShifts).toBe(0);
    expect(after.kpis.netHours).toMatchObject({ value: '1.50', endedShifts: 1 });
    expect(after.kpis.missingHandover).toEqual({ count: 1, requiredShifts: 1 });
    expect(after.attention.some((a) => a.kind === 'report_pending' && a.entityId === shift.id)).toBe(true);

    // A supervisor of another model sees nothing of this one.
    await createProject(db(), s.ws, { type: 'model', ofmEnabled: true, name: 'Other' });
    const other = await addMember(db(), s.ws, { roleKey: 'ofm_supervisor', scopeType: 'assigned_projects' });
    const otherC = await clientFor(await sessionFor(db(), other.userId));
    const none = await otherC.call(E.overview, { params: s.p, query: {} });
    expect(none.kpis.assignedModels).toBe(0);
    expect(none.kpis.netHours.endedShifts).toBe(0);
    expect(none.attention).toHaveLength(0);
    // Members without the OFM module permission get 403.
    const creator = await addMember(db(), s.ws, { roleKey: 'creator', scopeType: 'assigned_projects' });
    const creatorC = await clientFor(await sessionFor(db(), creator.userId));
    expect((await creatorC.attempt(E.overview, { params: s.p, query: {} })).status).toBe(403);
  });

  it('My Shifts lists upcoming shifts and handovers to acknowledge for the member only', async () => {
    const s = await ofmSetup();
    const mine = await s.schedule(s.manager.membershipId, 2, 4);
    await s.schedule(s.manager2.membershipId, 2, 4);
    const my = await s.manager.client.call(E.myShifts, { params: s.p });
    expect(my.active).toBeNull();
    expect(my.upcoming.map((x) => x.id)).toEqual([mine.id]);
  });
});

describe('OFM registries', () => {
  it('lookups: shifts in scope; contacts require the contacts permission', async () => {
    const s = await ofmSetup();
    const mine = await s.schedule(s.manager.membershipId, 2, 4);
    await s.schedule(s.manager2.membershipId, 2, 4);
    const shiftsSeen = await s.manager.client.call(lookupEndpoints.search, { params: { ...s.p, type: 'shift' }, query: {} });
    expect(shiftsSeen.items.map((i) => i.id)).toEqual([mine.id]);
    await s.owner.call(E.createContact, { params: s.p, body: { accountId: s.accountA, externalIdentifier: 'lk1', alias: 'Lookup Lee' } });
    const found = await s.manager.client.call(lookupEndpoints.search, { params: { ...s.p, type: 'ofm_contact' }, query: { q: 'Lee' } });
    expect(found.items.map((i) => i.label)).toEqual(['Lookup Lee']);
    const lead = await addMember(db(), s.ws, { roleKey: 'direction_lead', scopeType: 'workspace' });
    const leadC = await clientFor(await sessionFor(db(), lead.userId));
    expect((await leadC.attempt(lookupEndpoints.search, { params: { ...s.p, type: 'ofm_contact' }, query: {} })).status).toBe(403);
  });

  it('responsibility providers list future shifts and cancel or reassign them on deactivation (F12)', async () => {
    const s = await ofmSetup();
    const a = await s.schedule(s.manager.membershipId, 2, 4);
    const b = await s.schedule(s.manager.membershipId, 6, 8);
    const provider = RESPONSIBILITY_PROVIDERS.get('ofm.shifts')!;
    const ctx = await ctxFor(s.ws.workspaceId, s.ws.owner.membershipId);
    const items = await provider.list(ctx, s.manager.membershipId);
    expect(items.map((i) => i.entityId).sort()).toEqual([a.id, b.id].sort());
    await executeCommand(ctx, (c) => provider.transfer(c, s.manager.membershipId, [{ entityId: a.id, successorMembershipId: s.manager2.membershipId }, { entityId: b.id, successorMembershipId: null }]));
    const [ra] = await db().select().from(shifts).where(eq(shifts.id, a.id));
    const [rb] = await db().select().from(shifts).where(eq(shifts.id, b.id));
    expect(ra!.membershipId).toBe(s.manager2.membershipId);
    expect(rb!.state).toBe('cancelled');
    const assignments = RESPONSIBILITY_PROVIDERS.get('ofm.assignments')!;
    expect((await assignments.list(ctx, s.manager.membershipId)).length).toBe(2);
    await executeCommand(ctx, (c) => assignments.transfer(c, s.manager.membershipId, []));
    expect(await assignments.list(ctx, s.manager.membershipId)).toHaveLength(0);
  });

  it('import datasets: contacts validate references and duplicates; sale candidates never revise or post finance', async () => {
    const s = await ofmSetup();
    const ctx = await ctxFor(s.ws.workspaceId, s.supervisor.membershipId);
    const contacts = IMPORT_DATASETS_REGISTRY.get('ofm_contacts')!;
    const bad = await contacts.validate(ctx, { account: '@nobody', external_identifier: 'x', alias: 'X' }, { duplicatePolicy: 'error', rowNo: 1 });
    expect(bad.errors.map((e) => e.code)).toContain('UNKNOWN_ACCOUNT');
    const good = await contacts.validate(ctx, { account: s.accountA, external_identifier: 'imp_1', alias: 'Imported', stage: 'active' }, { duplicatePolicy: 'skip', rowNo: 2 });
    expect(good.errors).toEqual([]);
    const id = (await executeCommand(ctx, (c) => contacts.apply(c, good.normalized, { action: 'create' }))).body;
    const again = await contacts.validate(ctx, { account: s.accountA, external_identifier: 'imp_1', alias: 'Imported' }, { duplicatePolicy: 'skip', rowNo: 3 });
    expect(again.action).toBe('skip');
    await executeCommand(ctx, (c) => contacts.undo!(c, id));
    expect(await db().select().from(ofmContacts).where(eq(ofmContacts.id, id))).toHaveLength(0);

    const sales = IMPORT_DATASETS_REGISTRY.get('sale_candidates')!;
    expect(sales.duplicatePolicies).not.toContain('revise_existing');
    const row = { account: s.accountA, source_namespace: 'OnlyFans', source_transaction_id: 'IMP-1', occurred_at: new Date().toISOString(), currency: 'EUR', gross: '12.00' };
    const v = await sales.validate(ctx, row, { duplicatePolicy: 'error', rowNo: 1 });
    expect(v.errors).toEqual([]);
    await executeCommand(ctx, (c) => sales.apply(c, v.normalized, { action: 'create' }));
    const dup = await sales.validate(ctx, row, { duplicatePolicy: 'error', rowNo: 2 });
    expect(dup.errors.map((e) => e.code)).toContain('DUPLICATE');
    expect(await db().select().from(saleCandidates).where(eq(saleCandidates.workspaceId, s.ws.workspaceId))).toHaveLength(1);
    expect(await db().select().from(financialEntries).where(eq(financialEntries.workspaceId, s.ws.workspaceId))).toHaveLength(0);
  });

  it('export datasets are scoped to the requester and carry the OFM classification', async () => {
    const s = await ofmSetup();
    await s.schedule(s.manager.membershipId, 2, 4);
    await s.schedule(s.manager2.membershipId, 2, 4);
    const ds = EXPORT_DATASETS_REGISTRY.get('ofm_shifts')!;
    expect(ds.classification).toBe('ofm');
    const collect = async (membershipId: string) => {
      const ctx = await ctxFor(s.ws.workspaceId, membershipId);
      const out: Record<string, unknown>[] = [];
      for await (const r of ds.rows(ctx, { filters: {}, boundAt: new Date(Date.now() + 60_000), fields: [] })) out.push(r);
      return out;
    };
    expect(await collect(s.supervisor.membershipId)).toHaveLength(2);
    const own = await collect(s.manager.membershipId);
    expect(own).toHaveLength(1);
    expect(own[0]!.net_hours).toBeNull();
  });

  it('archive handler refuses open operations and archives closed ones', async () => {
    const s = await ofmSetup();
    const op = await s.manager.client.call(E.createOperation, { params: s.p, body: { type: 'account_check', accountId: s.accountA, ownerMembershipId: s.manager.membershipId, title: 'Check account status' } });
    const handler = ARCHIVE_HANDLERS.get('operation')!;
    const ctx = await ctxFor(s.ws.workspaceId, s.supervisor.membershipId);
    const preview = await handler.preview(ctx, op.id);
    expect(preview.items.some((i) => i.blocking)).toBe(true);
    await s.manager.client.call(E.transitionOperation, { params: { ...s.p, operationId: op.id }, body: { targetState: 'completed', outcome: 'Account healthy' } }, { ifMatch: op.rowVersion });
    await executeCommand(ctx, (c) => handler.archive(c, op.id, { reason: 'Done' }));
    const archived = await s.supervisor.client.call(E.getOperation, { params: { ...s.p, operationId: op.id } });
    expect(archived.archivedAt).not.toBeNull();
    const list = await s.supervisor.client.call(E.listOperations, { params: s.p, query: {} });
    expect(list.items.map((i) => i.id)).not.toContain(op.id);
  });
});
