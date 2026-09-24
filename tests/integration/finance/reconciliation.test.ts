import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { financeEndpoints as F } from '@castlane/api-contracts';
import { EXPORT_DATASETS_REGISTRY, IMPORT_DATASETS_REGISTRY, executeCommand, getAppServices, memberJobContext } from '@castlane/application';
import { deals, financialEntries, partners, saleCandidates } from '@castlane/database';
import { newId } from '@castlane/domain';
import { addMember, assignToProject, clientFor, createAccount, createProject, sessionFor } from '../../support';
import { MARCH, db, expenseBody, financeSetup, postedEntry } from './helpers';

const candidate = async (wsId: string, accountId: string, projectId: string, txn: string, amounts: { gross?: bigint | null; fee?: bigint | null; refund?: bigint | null; net?: bigint | null }, claimed: { membershipId: string; sharePercent: string }[] = []) => {
  const id = newId();
  await db()
    .insert(saleCandidates)
    .values({
      id,
      workspaceId: wsId,
      accountId,
      projectId,
      sourceNamespace: 'onlyfans',
      sourceTransactionId: txn,
      occurredAt: new Date('2024-03-14T15:00:00Z'),
      grossMinor: amounts.gross ?? null,
      refundMinor: amounts.refund ?? null,
      feeMinor: amounts.fee ?? null,
      netMinor: amounts.net ?? null,
      currency: 'EUR',
      claimedAllocations: claimed,
    });
  return id;
};

describe('sale candidate reconciliation (T098)', () => {
  it('verifies into a draft, detects duplicates of recorded sources, never posts', async () => {
    const { ws, owner, fmc, project, p, cat } = await financeSetup();
    const accountId = await createAccount(db(), ws, { projectId: project.id, platform: 'onlyfans', url: 'https://onlyfans.com/alpha_candidate' });
    const mgr = await addMember(db(), ws, { roleKey: 'ofm_manager', scopeType: 'assigned_accounts' });
    const c1 = await candidate(ws.workspaceId, accountId, project.id, 'tx-1', { gross: 10000n, fee: 2000n, net: 8000n }, [{ membershipId: mgr.membershipId, sharePercent: '60' }]);
    // tx-2 is already recorded through a posted statement with the same source transaction id.
    await postedEntry(fmc, owner, p, { type: 'revenue', title: 'Imported sale tx-2', recognitionDate: '2024-03-14', sourceNamespace: 'onlyfans', sourceExternalId: 'tx-2', lines: [{ categoryId: cat('content_sales'), amount: '50.00', currency: 'EUR' }] });
    const c2 = await candidate(ws.workspaceId, accountId, project.id, 'tx-2', { net: 5000n });
    const c3 = await candidate(ws.workspaceId, accountId, project.id, 'tx-3', { net: 3000n });

    const queue = await fmc.call(F.saleCandidatesList, { params: p, query: { state: ['pending'] } });
    expect(queue.items).toHaveLength(3);
    expect(queue.items.find((i) => i.id === c2)!.duplicate?.title).toBe('Imported sale tx-2');
    expect(queue.items.find((i) => i.id === c1)!.duplicate).toBeNull();

    const v1 = queue.items.find((i) => i.id === c1)!;
    const res = await fmc.call(F.saleCandidatesConfirm, { params: { ...p, candidateId: c1 }, body: { categoryId: cat('content_sales'), attributions: [{ membershipId: mgr.membershipId, sharePercent: '60' }] } }, { ifMatch: v1.rowVersion });
    expect(res.candidate.state).toBe('verified');
    expect(res.entry.state).toBe('draft');
    expect(res.entry.lines.map((l) => [l.accountingClass, l.amount.amount])).toEqual([
      ['revenue', '100.00'],
      ['fee', '20.00'],
    ]);
    expect(res.entry.attributions[0]!.sharePercent).toBe('60.0000');
    expect(res.entry.source).toEqual({ namespace: 'onlyfans', externalId: 'tx-1' });

    // Duplicate: confirming would double the revenue → refused; reject with a reason instead.
    const v2 = queue.items.find((i) => i.id === c2)!;
    const dup = await fmc.attempt(F.saleCandidatesConfirm, { params: { ...p, candidateId: c2 }, body: { categoryId: cat('content_sales'), attributions: [] } }, { ifMatch: v2.rowVersion });
    expect(dup.status).toBe(409);
    expect(dup.code).toBe('DUPLICATE');
    const rejected = await fmc.call(F.saleCandidatesReject, { params: { ...p, candidateId: c2 }, body: { reason: 'Duplicate of the imported statement' } }, { ifMatch: v2.rowVersion });
    expect(rejected.state).toBe('rejected');
    const rows = await db().select().from(financialEntries).where(eq(financialEntries.sourceExternalId, 'tx-2'));
    expect(rows).toHaveLength(1);

    // Net-only candidate keeps unknown components unknown.
    const v3 = queue.items.find((i) => i.id === c3)!;
    const net = await fmc.call(F.saleCandidatesConfirm, { params: { ...p, candidateId: c3 }, body: { categoryId: cat('tips'), attributions: [] } }, { ifMatch: v3.rowVersion });
    expect(net.entry.netOnly).toBe(true);
    expect(net.entry.lines[0]!.componentsUnknown).toBe(true);
    // Replaying a verification is refused (already verified).
    expect((await fmc.attempt(F.saleCandidatesConfirm, { params: { ...p, candidateId: c3 }, body: { categoryId: cat('tips'), attributions: [] } }, { ifMatch: net.candidate.rowVersion })).status).toBe(409);
    const o = await owner.call(F.overview, { params: p, query: MARCH });
    expect(o.sourceMatch).toMatchObject({ reconciled: 2, eligible: 2, duplicatesRejected: 1, ratePercent: '100.00' });
    // Drafts never enter totals.
    expect(o.accrual.grossRevenue.amount).toBe('50.00');
    expect(o.drafts.count).toBe(2);
  });
});

describe('deals and campaign panels (T138, T016)', () => {
  it('a won deal creates no income; members without finance rights see no amounts', async () => {
    const { ws, owner, fmc, project, p, cat } = await financeSetup();
    const partnerId = newId();
    await db().insert(partners).values({ id: partnerId, workspaceId: ws.workspaceId, kind: 'organization', name: 'Brand Co', ownerMembershipId: ws.owner.membershipId });
    const dealId = newId();
    await db().insert(deals).values({ id: dealId, workspaceId: ws.workspaceId, title: 'Spring sponsorship', partnerId, ownerMembershipId: ws.owner.membershipId, stage: 'won', amountMinor: 500000n, currency: 'EUR' });
    const won = await owner.call(F.dealSummary, { params: { ...p, dealId } });
    expect(won.entries).toEqual([]);
    expect(won.postedIncome).toEqual({ amount: '0.00', currency: 'EUR' });
    // Only a posted entry linked to the deal is income.
    await postedEntry(fmc, owner, p, { type: 'revenue', title: 'Sponsorship invoice', recognitionDate: '2024-03-18', dealId, lines: [{ categoryId: cat('sponsorship'), amount: '2500.00', currency: 'EUR' }] });
    const withIncome = await owner.call(F.dealSummary, { params: { ...p, dealId } });
    expect(withIncome.postedIncome?.amount).toBe('2500.00');
    const lead = await addMember(db(), ws, { roleKey: 'project_lead', scopeType: 'workspace' });
    const lc = await clientFor(await sessionFor(db(), lead.userId));
    const noAmounts = await lc.call(F.dealSummary, { params: { ...p, dealId } });
    expect(noAmounts.entries).toHaveLength(1);
    expect('postedIncome' in noAmounts).toBe(false);
    expect('netBase' in noAmounts.entries[0]!).toBe(false);
    expect('balances' in noAmounts.entries[0]!).toBe(false);
    void project;
  });
});

describe('import and export datasets', () => {
  it('financial import creates drafts only — never posted — validates references and duplicates, undo removes untouched drafts (T148)', async () => {
    const { ws, fm, fmc, owner, project, p } = await financeSetup();
    const app = getAppServices();
    const ctx = (await memberJobContext(app, ws.workspaceId, fm.membershipId, { source: 'import' }))!;
    const ds = IMPORT_DATASETS_REGISTRY.get('financial_drafts')!;
    const row = { type: 'expense', title: 'Imported voice session', recognition_date: '2024-03-02', category: 'voice', amount: '120.50', currency: 'EUR', project: 'Model Alpha', source_namespace: 'bank', source_external_id: 'B-1' };
    const v = await ds.validate(ctx, row, { duplicatePolicy: 'error', rowNo: 1 });
    expect(v.errors).toEqual([]);
    expect(v.action).toBe('create');
    const id = await executeCommand(ctx, (c) => ds.apply(c, v.normalized, { action: 'create' })).then((r) => r.body as string);
    const e = await fmc.call(F.entriesGet, { params: { ...p, entryId: id } });
    expect(e.state).toBe('draft');
    expect(e.projects.map((x) => x.id)).toEqual([project.id]);
    // Nothing was posted: no posted row, no ledger effect.
    expect((await db().select().from(financialEntries).where(eq(financialEntries.workspaceId, ws.workspaceId))).map((r) => [r.id, r.state, r.postedAt])).toEqual([[id, 'draft', null]]);
    expect((await owner.call(F.overview, { params: p, query: { periodStart: '2024-03-01', periodEnd: '2024-03-31' } })).accrual.operatingExpenses.amount).toBe('0.00');
    // Ambiguous decimals / unknown references / duplicates are blocking errors.
    const bad = await ds.validate(ctx, { ...row, amount: '1,234', project: 'Nope', source_external_id: 'B-2' }, { duplicatePolicy: 'error', rowNo: 2 });
    expect(bad.errors.map((x) => x.field).sort()).toEqual(['amount', 'project']);
    const dupErr = await ds.validate(ctx, row, { duplicatePolicy: 'error', rowNo: 3 });
    expect(dupErr.errors.map((x) => x.code)).toEqual(['DUPLICATE']);
    const dupSkip = await ds.validate(ctx, row, { duplicatePolicy: 'skip', rowNo: 3 });
    expect(dupSkip.action).toBe('skip');
    const revise = await ds.validate(ctx, { ...row, amount: '130.00' }, { duplicatePolicy: 'revise_existing', rowNo: 3 });
    expect(revise.action).toBe('update');
    // Undo removes an untouched draft; after an edit it is kept.
    await executeCommand(ctx, (c) => ds.undo!(c, id));
    expect(await db().select().from(financialEntries).where(eq(financialEntries.id, id))).toHaveLength(0);
    const id2 = await executeCommand(ctx, (c) => ds.apply(c, v.normalized, { action: 'create' })).then((r) => r.body as string);
    const e2 = await fmc.call(F.entriesGet, { params: { ...p, entryId: id2 } });
    await fmc.call(F.entriesUpdate, { params: { ...p, entryId: id2 }, body: { note: 'checked' } }, { ifMatch: e2.rowVersion });
    await expect(executeCommand(ctx, (c) => ds.undo!(c, id2))).rejects.toThrow(/changed after the import/);

    // FX rates dataset.
    const fx = IMPORT_DATASETS_REGISTRY.get('fx_rates')!;
    const fxOk = await fx.validate(ctx, { from_currency: 'usd', to_currency: 'EUR', rate: '0.91', effective_date: '2024-03-01', source: 'ECB table' }, { duplicatePolicy: 'error', rowNo: 1 });
    expect(fxOk.errors).toEqual([]);
    await executeCommand(ctx, (c) => fx.apply(c, fxOk.normalized, { action: 'create' }));
    const fxDup = await fx.validate(ctx, { from_currency: 'USD', to_currency: 'EUR', rate: '0.92', effective_date: '2024-03-01', source: 'ECB table' }, { duplicatePolicy: 'error', rowNo: 2 });
    expect(fxDup.errors.map((x) => x.code)).toEqual(['DUPLICATE']);
    const fxBad = await fx.validate(ctx, { from_currency: 'EUR', to_currency: 'EUR', rate: '0,9', effective_date: '1.3.2024', source: 'x' }, { duplicatePolicy: 'error', rowNo: 3 });
    expect(fxBad.errors.length).toBeGreaterThanOrEqual(3);
  });

  it('ledger export is finance-classified and scope-filtered; compensation export needs workspace access', async () => {
    const { ws, owner, fmc, project, p, cat } = await financeSetup();
    const other = await createProject(db(), ws, { name: 'Other' });
    await postedEntry(fmc, owner, p, expenseBody(cat, project.id, '10.00'));
    await postedEntry(fmc, owner, p, expenseBody(cat, other.id, '20.00'));
    const ds = EXPORT_DATASETS_REGISTRY.get('finance_ledger_lines')!;
    expect(ds.classification).toBe('finance');
    const collect = async (membershipId: string) => {
      const ctx = (await memberJobContext(getAppServices(), ws.workspaceId, membershipId))!;
      const out: Record<string, unknown>[] = [];
      for await (const r of ds.rows(ctx, { filters: {}, boundAt: new Date(Date.now() + 60_000), fields: [] })) out.push(r);
      return out;
    };
    const all = await collect(ws.owner.membershipId);
    expect(all.map((r) => r.amount).sort()).toEqual(['10.00', '20.00']);
    const scoped = await addMember(db(), ws, { roleKey: 'finance_manager', scopeType: 'assigned_projects' });
    await assignToProject(db(), ws, project.id, scoped.membershipId);
    const mine = await collect(scoped.membershipId);
    expect(mine.map((r) => r.project)).toEqual(['Model Alpha']);
    const comp = EXPORT_DATASETS_REGISTRY.get('compensation_lines')!;
    const sctx = (await memberJobContext(getAppServices(), ws.workspaceId, scoped.membershipId))!;
    await expect((async () => {
      for await (const r of comp.rows(sctx, { filters: {}, boundAt: new Date(), fields: [] })) void r;
    })()).rejects.toThrow();
  });
});
