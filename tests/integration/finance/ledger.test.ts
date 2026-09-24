import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { newIdempotencyKey } from '@castlane/api-client';
import { financeEndpoints as F, projectEndpoints } from '@castlane/api-contracts';
import { financialAllocations, financialEntries, financialEntryLines, fxRates } from '@castlane/database';
import { addMember, assignToProject, clientFor, createProject, createWorkspace, sessionFor } from '../../support';
import { MARCH, db, expenseBody, financeSetup, onProject, postedEntry, statementBody } from './helpers';

describe('financial entries: lifecycle and immutability', () => {
  it('posted entries are immutable; reversal and replacement are offered (T123)', async () => {
    const { owner, fmc, project, p, cat } = await financeSetup();
    const posted = await postedEntry(fmc, owner, p, expenseBody(cat, project.id));
    const edit = await fmc.attempt(F.entriesUpdate, { params: { ...p, entryId: posted.id }, body: { title: 'Changed title' } }, { ifMatch: posted.rowVersion });
    expect(edit.status).toBe(409);
    expect(edit.code).toBe('INVALID_STATE');
    expect((edit.error as { details?: { actions?: string[] } }).details?.actions).toEqual(['reverse', 'reverse_and_replace']);
    // The database refuses a direct change of a posted line as well.
    await expect(db().update(financialEntryLines).set({ amountMinor: 1n }).where(eq(financialEntryLines.entryId, posted.id))).rejects.toThrow();

    const rev = await owner.call(F.entriesReverse, { params: { ...p, entryId: posted.id }, body: { reason: 'Wrong amount', effectiveDate: '2024-03-15', createReplacement: true } }, { ifMatch: posted.rowVersion });
    expect(rev.original.displayState).toBe('reversed');
    expect(rev.original.state).toBe('posted');
    expect(rev.reversal.reversesEntryId).toBe(posted.id);
    expect(rev.reversal.lines.every((l) => l.isReversal)).toBe(true);
    expect(rev.replacementId).toBeTruthy();
    const replacement = await owner.call(F.entriesGet, { params: { ...p, entryId: rev.replacementId! } });
    expect(replacement.state).toBe('draft');
    expect(replacement.replacementOfEntryId).toBe(posted.id);
    const o = await owner.call(F.overview, { params: p, query: MARCH });
    expect(o.accrual.operatingExpenses.amount).toBe('0.00');
    // A second reversal is refused.
    const twice = await owner.attempt(F.entriesReverse, { params: { ...p, entryId: posted.id }, body: { reason: 'Again please', effectiveDate: '2024-03-16' } }, { ifMatch: rev.original.rowVersion });
    expect(twice.status).toBe(409);
  });

  it('enforces transitions, If-Match and maker-checker with a visible owner exception', async () => {
    const { owner, fmc, project, p, cat } = await financeSetup();
    const e = await fmc.call(F.entriesCreate, { params: p, body: expenseBody(cat, project.id) });
    // Draft cannot be posted directly.
    expect((await owner.attempt(F.entriesPost, { params: { ...p, entryId: e.id }, body: {} }, { ifMatch: e.rowVersion })).status).toBe(409);
    // Missing and stale If-Match (T164).
    expect((await fmc.attempt(F.entriesSubmit, { params: { ...p, entryId: e.id }, body: {} })).status).toBe(428);
    const s = await fmc.call(F.entriesSubmit, { params: { ...p, entryId: e.id }, body: {} }, { ifMatch: e.rowVersion });
    expect((await owner.attempt(F.entriesPost, { params: { ...p, entryId: e.id }, body: {} }, { ifMatch: e.rowVersion })).status).toBe(412);
    // The submitter cannot post their own entry.
    const self = await fmc.attempt(F.entriesPost, { params: { ...p, entryId: e.id }, body: {} }, { ifMatch: s.rowVersion });
    expect(self.status).toBe(403);
    // Reject returns it to the author with a reason; after an edit it can be submitted again.
    const rejected = await owner.call(F.entriesReject, { params: { ...p, entryId: e.id }, body: { reason: 'Attach the invoice' } }, { ifMatch: s.rowVersion });
    expect(rejected.state).toBe('rejected');
    const edited = await fmc.call(F.entriesUpdate, { params: { ...p, entryId: e.id }, body: { note: 'Invoice 42' } }, { ifMatch: rejected.rowVersion });
    expect(edited.state).toBe('draft');

    // Owner working alone: the single-owner exception needs a reason and is recorded.
    const solo = await financeSetup();
    const own = await solo.owner.call(F.entriesCreate, { params: solo.p, body: expenseBody(solo.cat, solo.project.id) });
    const ownS = await solo.owner.call(F.entriesSubmit, { params: { ...solo.p, entryId: own.id }, body: {} }, { ifMatch: own.rowVersion });
    // A Finance Manager exists in this workspace, so the exception is refused.
    expect((await solo.owner.attempt(F.entriesPost, { params: { ...solo.p, entryId: own.id }, body: { exceptionReason: 'Month end' } }, { ifMatch: ownS.rowVersion })).status).toBe(403);
    const alone = await createWorkspace(db());
    const ownerAlone = await clientFor(await sessionFor(db(), alone.owner.userId));
    const pa = { workspaceId: alone.workspaceId };
    const cats = await ownerAlone.call(F.categoriesList, { params: pa, query: {} });
    const e2 = await ownerAlone.call(F.entriesCreate, { params: pa, body: { type: 'expense', title: 'Software', recognitionDate: '2024-03-01', lines: [{ categoryId: cats.find((c) => c.key === 'software')!.id, amount: '10.00', currency: 'EUR' }] } });
    const s2 = await ownerAlone.call(F.entriesSubmit, { params: { ...pa, entryId: e2.id }, body: {} }, { ifMatch: e2.rowVersion });
    expect(s2.permissions.selfApprovalRequired).toBe(true);
    const noReason = await ownerAlone.attempt(F.entriesPost, { params: { ...pa, entryId: e2.id }, body: {} }, { ifMatch: s2.rowVersion });
    expect(noReason.status).toBe(422);
    const p2 = await ownerAlone.call(F.entriesPost, { params: { ...pa, entryId: e2.id }, body: { exceptionReason: 'No second finance approver yet' } }, { ifMatch: s2.rowVersion });
    expect(p2.selfApprovalReason).toBe('No second finance approver yet');
  });

  it('create is idempotent; same key with a different body is rejected (T163)', async () => {
    const { fmc, project, p, cat } = await financeSetup();
    const key = newIdempotencyKey();
    const body = expenseBody(cat, project.id);
    const a = await fmc.call(F.entriesCreate, { params: p, body }, { idempotencyKey: key });
    const b = await fmc.call(F.entriesCreate, { params: p, body }, { idempotencyKey: key });
    expect(b.id).toBe(a.id);
    const c = await fmc.attempt(F.entriesCreate, { params: p, body: { ...body, title: 'Different' } }, { idempotencyKey: key });
    expect(c.code).toBe('IDEMPOTENCY_PAYLOAD_MISMATCH');
  });
});

describe('financial arithmetic rules', () => {
  it('one source transaction cannot be recorded twice, even concurrently (T122)', async () => {
    const { owner, fmc, project, p, cat } = await financeSetup();
    const body = statementBody(cat, project.id, { sourceExternalId: 'txn-777' });
    const [x, y] = await Promise.all([fmc.attempt(F.entriesCreate, { params: p, body }), fmc.attempt(F.entriesCreate, { params: p, body })]);
    const ok = [x, y].filter((r) => r.ok);
    expect(ok).toHaveLength(1);
    expect([x, y].find((r) => !r.ok)!.status).toBe(409);
    // Concurrent posts of the same entry with different keys: exactly one economic operation.
    const e = ok[0]!.data!;
    const s = await fmc.call(F.entriesSubmit, { params: { ...p, entryId: e.id }, body: {} }, { ifMatch: e.rowVersion });
    const [p1, p2] = await Promise.all([
      owner.attempt(F.entriesPost, { params: { ...p, entryId: e.id }, body: {} }, { ifMatch: s.rowVersion }),
      owner.attempt(F.entriesPost, { params: { ...p, entryId: e.id }, body: {} }, { ifMatch: s.rowVersion }),
    ]);
    expect([p1, p2].filter((r) => r.ok)).toHaveLength(1);
    const rows = await db().select().from(financialEntries).where(and(eq(financialEntries.sourceNamespace, 'onlyfans'), eq(financialEntries.sourceExternalId, 'txn-777')));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe('posted');
  });

  it('net-only statements: net valid, gross incomplete, no invented fee (T124)', async () => {
    const { owner, fmc, project, p, cat } = await financeSetup();
    const e = await postedEntry(fmc, owner, p, {
      type: 'platform_statement',
      title: 'Net only payout statement',
      recognitionDate: '2024-03-05',
      netOnly: true,
      lines: [{ categoryId: cat('subscriptions'), amount: '720.00', currency: 'EUR' }],
      allocation: onProject(project.id),
    });
    expect(e.lines[0]!.componentsUnknown).toBe(true);
    const o = await owner.call(F.overview, { params: p, query: MARCH });
    expect(o.accrual.netRevenue.amount).toBe('720.00');
    expect(o.accrual.grossRevenue.amount).toBe('0.00');
    expect(o.accrual.fees.amount).toBe('0.00');
    expect(o.accrual.grossIncomplete).toBe(true);
    // Net Only with fee lines is refused.
    const bad = await fmc.attempt(F.entriesCreate, {
      params: p,
      body: { type: 'platform_statement', title: 'Mixed', recognitionDate: '2024-03-05', netOnly: true, lines: [{ categoryId: cat('subscriptions'), amount: '720.00', currency: 'EUR' }, { categoryId: cat('platform_fee'), amount: '1.00', currency: 'EUR' }] },
    });
    expect(bad.status).toBe(422);
  });

  it('header total is a control sum, never a second revenue line (T125)', async () => {
    const { owner, fmc, project, p, cat } = await financeSetup();
    const txn = (ref: string, amount: string) => ({ categoryId: cat('content_sales'), amount, currency: 'EUR', transactionRef: ref });
    const e = await fmc.call(F.entriesCreate, {
      params: p,
      body: { type: 'platform_statement', title: 'Statement with transactions', recognitionDate: '2024-03-08', sourceNamespace: 'fansly', sourceExternalId: 'st-1', controlTotal: { amount: '700.00', currency: 'EUR' }, lines: [txn('t1', '240.00'), txn('t2', '240.00'), txn('t3', '240.00')], allocation: onProject(project.id) },
    });
    expect(e.controlCheck).toEqual({ status: 'mismatch', difference: { amount: '20.00', currency: 'EUR' } });
    const sub = await fmc.attempt(F.entriesSubmit, { params: { ...p, entryId: e.id }, body: {} }, { ifMatch: e.rowVersion });
    expect(sub.status).toBe(409);
    const fixed = await fmc.call(F.entriesUpdate, { params: { ...p, entryId: e.id }, body: { controlTotal: { amount: '720.00', currency: 'EUR' } } }, { ifMatch: e.rowVersion });
    const s = await fmc.call(F.entriesSubmit, { params: { ...p, entryId: e.id }, body: {} }, { ifMatch: fixed.rowVersion });
    await owner.call(F.entriesPost, { params: { ...p, entryId: e.id }, body: {} }, { ifMatch: s.rowVersion });
    const o = await owner.call(F.overview, { params: p, query: MARCH });
    expect(o.accrual.grossRevenue.amount).toBe('720.00');
    // The same transaction id cannot appear in a second statement.
    const dup = await fmc.attempt(F.entriesCreate, { params: p, body: { type: 'revenue', title: 'Again', recognitionDate: '2024-03-09', sourceNamespace: 'fansly', lines: [txn('t2', '240.00')] } });
    expect(dup.status).toBe(409);
  });

  it('missing FX keeps the draft but blocks cross-currency posting (T126); used rates are frozen (T128)', async () => {
    const { owner, fmc, project, p, cat } = await financeSetup();
    const body = { type: 'expense' as const, title: 'US tool subscription', recognitionDate: '2024-03-10', lines: [{ categoryId: cat('ai_tools'), amount: '100.00', currency: 'USD' }], allocation: onProject(project.id) };
    const e = await fmc.call(F.entriesCreate, { params: p, body });
    expect(e.missingFx).toEqual([{ currency: 'USD', date: '2024-03-10' }]);
    expect(e.netBase).toBeNull();
    const s = await fmc.call(F.entriesSubmit, { params: { ...p, entryId: e.id }, body: {} }, { ifMatch: e.rowVersion });
    const blocked = await owner.attempt(F.entriesPost, { params: { ...p, entryId: e.id }, body: {} }, { ifMatch: s.rowVersion });
    expect(blocked.status).toBe(409);
    expect((blocked.error as { details?: { reason?: string } }).details?.reason).toBe('fx_missing');
    const rate = await fmc.call(F.fxRatesCreate, { params: p, body: { fromCurrency: 'USD', toCurrency: 'EUR', rate: '0.9', effectiveDate: '2024-03-01', source: 'Bank statement' } });
    const posted = await owner.call(F.entriesPost, { params: { ...p, entryId: e.id }, body: {} }, { ifMatch: s.rowVersion });
    expect(posted.lines[0]!.baseAmount).toEqual({ amount: '90.00', currency: 'EUR' });
    expect(posted.lines[0]!.fx?.rateId).toBe(rate.id);
    // The used rate is frozen; a corrected rate does not change the historical base (T128).
    const lockedRate = await fmc.call(F.fxRatesGet, { params: { ...p, rateId: rate.id } });
    expect(lockedRate.locked).toBe(true);
    const patch = await fmc.attempt(F.fxRatesUpdate, { params: { ...p, rateId: rate.id }, body: { rate: '0.95' } }, { ifMatch: lockedRate.rowVersion });
    expect(patch.status).toBe(409);
    await fmc.call(F.fxRatesCreate, { params: p, body: { fromCurrency: 'USD', toCurrency: 'EUR', rate: '0.95', effectiveDate: '2024-03-01', source: 'Corrected bank statement' } });
    const after = await owner.call(F.entriesGet, { params: { ...p, entryId: e.id } });
    expect(after.lines[0]!.baseAmount?.amount).toBe('90.00');
    const [raw] = await db().select().from(fxRates).where(eq(fxRates.id, rate.id));
    expect(raw!.rate).toBe('0.9000000000');
  });

  it('allocation rounding conserves minor units exactly (T127) and posted re-allocation is an adjustment', async () => {
    const { ws, owner, fmc, project, p, cat } = await financeSetup();
    const p2 = await createProject(db(), ws, { name: 'Model Beta' });
    const p3 = await createProject(db(), ws, { name: 'Model Gamma' });
    const e = await postedEntry(fmc, owner, p, {
      type: 'expense',
      title: 'Shared AI tool subscription',
      recognitionDate: '2024-03-03',
      lines: [{ categoryId: cat('ai_tools'), amount: '100.00', currency: 'EUR' }],
      allocation: { mode: 'weights', rows: [{ projectId: project.id, value: '1' }, { projectId: p2.id, value: '1' }, { projectId: p3.id, value: '1' }] },
    });
    const amounts = e.lines[0]!.allocations.map((a) => a.amount.amount).sort();
    expect(amounts).toEqual(['33.33', '33.33', '33.34']);
    const rows = await db().select().from(financialAllocations).where(eq(financialAllocations.entryId, e.id));
    expect(rows.reduce((a, r) => a + r.amountMinor, 0n)).toBe(10000n);
    expect(rows.reduce((a, r) => a + (r.baseAmountMinor ?? 0n), 0n)).toBe(10000n);
    // Percent that does not add to 100 is rejected; an explicit Unallocated row is accepted.
    const bad = await fmc.attempt(F.entriesAllocationPreview, { params: { ...p, entryId: e.id }, body: { allocation: { mode: 'percent', rows: [{ projectId: project.id, value: '60' }] } } });
    expect(bad.status).toBe(422);
    const preview = await fmc.call(F.entriesAllocationPreview, {
      params: { ...p, entryId: e.id },
      body: { allocation: { mode: 'percent', rows: [{ projectId: project.id, value: '60' }, { projectId: null, value: '40' }] }, effectiveDate: '2024-03-20' },
    });
    expect(preview.mode).toBe('posted_adjustment');
    const moved = await fmc.call(F.entriesAllocate, { params: { ...p, entryId: e.id }, body: { previewToken: preview.previewToken } }, { ifMatch: e.rowVersion });
    // Append-only: 3 originals + 3 negations + 2 new rows; the expense is not copied.
    expect(moved.lines[0]!.allocations).toHaveLength(8);
    const o = await owner.call(F.overview, { params: p, query: MARCH });
    expect(o.accrual.operatingExpenses.amount).toBe('100.00');
    expect(o.unallocatedCosts.amount).toBe('40.00');
    expect(o.costAllocationCoverage).toBe('60.00');
    // The database keeps posted allocation rows immutable.
    await expect(db().update(financialAllocations).set({ amountMinor: 1n }).where(eq(financialAllocations.entryId, e.id))).rejects.toThrow();
  });

  it('closed periods block posting; audited reopen allows it (T136)', async () => {
    const { owner, fmc, project, p, cat } = await financeSetup();
    const draft = await fmc.call(F.entriesCreate, { params: p, body: expenseBody(cat, project.id) });
    const preview = await owner.call(F.periodsClosePreview, { params: p, query: MARCH });
    expect(preview.issues.map((i) => i.kind)).toContain('unreviewed_entries');
    const refused = await owner.attempt(F.periodsClose, { params: p, body: { ...MARCH, unresolvedAcknowledgements: [] } });
    expect(refused.status).toBe(409);
    const lock = await owner.call(F.periodsClose, { params: p, body: { ...MARCH, unresolvedAcknowledgements: [{ kind: 'unreviewed_entries', note: 'Late invoice, next period' }] } });
    expect(lock.unresolvedItems[0]!.note).toBe('Late invoice, next period');
    const s = await fmc.call(F.entriesSubmit, { params: { ...p, entryId: draft.id }, body: {} }, { ifMatch: draft.rowVersion });
    const blocked = await owner.attempt(F.entriesPost, { params: { ...p, entryId: draft.id }, body: {} }, { ifMatch: s.rowVersion });
    expect(blocked.status).toBe(409);
    expect((blocked.error as { details?: { reason?: string } }).details?.reason).toBe('period_closed');
    // Overlapping close is refused; reopen needs a reason and is recorded.
    expect((await owner.attempt(F.periodsClose, { params: p, body: { periodStart: '2024-03-15', periodEnd: '2024-04-15', unresolvedAcknowledgements: [] } })).status).toBe(409);
    const reopened = await owner.call(F.periodsReopen, { params: p, body: { periodId: lock.id, reason: 'Late supplier invoice' } });
    expect(reopened.state).toBe('reopened');
    const posted = await owner.call(F.entriesPost, { params: { ...p, entryId: draft.id }, body: {} }, { ifMatch: s.rowVersion });
    expect(posted.state).toBe('posted');
    // Members without the close-period right get 403.
    expect((await fmc.attempt(F.periodsClose, { params: p, body: { periodStart: '2024-05-01', periodEnd: '2024-05-31', unresolvedAcknowledgements: [] } })).ok).toBe(true);
    const { ws: ws2, p: p2 } = await financeSetup();
    const viewer = await addMember(db(), ws2, { roleKey: 'viewer' });
    const vc = await clientFor(await sessionFor(db(), viewer.userId));
    expect((await vc.attempt(F.periodsClose, { params: p2, body: { ...MARCH, unresolvedAcknowledgements: [] } })).status).toBe(403);
  });
});

describe('settlements', () => {
  it('overpayment needs an explicit advance/unallocated balance (T137) and matches later', async () => {
    const { owner, fmc, project, p, cat } = await financeSetup();
    const st = await postedEntry(fmc, owner, p, statementBody(cat, project.id));
    const s = await fmc.call(F.settlementsCreate, { params: p, body: { direction: 'in', amount: '800.00', currency: 'EUR', paidAt: '2024-03-21T08:00:00Z', paymentReference: 'OF-800' } });
    const over = await fmc.attempt(F.settlementsConfirm, { params: { ...p, settlementId: s.id }, body: { allocationLines: [{ targetType: 'entry', targetEntryId: st.id, amount: '800.00' }], remainderPolicy: 'none' } }, { ifMatch: s.rowVersion });
    expect(over.status).toBe(422);
    const noPolicy = await fmc.attempt(F.settlementsConfirm, { params: { ...p, settlementId: s.id }, body: { allocationLines: [{ targetType: 'entry', targetEntryId: st.id, amount: '720.00' }], remainderPolicy: 'none' } }, { ifMatch: s.rowVersion });
    expect(noPolicy.status).toBe(422);
    const ok = await fmc.call(
      F.settlementsConfirm,
      { params: { ...p, settlementId: s.id }, body: { allocationLines: [{ targetType: 'entry', targetEntryId: st.id, amount: '720.00' }], remainderPolicy: 'advance', remainderNote: 'Advance for April' } },
      { ifMatch: s.rowVersion },
    );
    expect(ok.unallocated.amount).toBe('80.00');
    expect(ok.remainderPolicy).toBe('advance');
    const unmatched = await fmc.call(F.settlementsList, { params: p, query: { unmatched: true } });
    expect(unmatched.items.map((i) => i.id)).toEqual([s.id]);
    // The receivable is closed; the advance is matched when the next statement is posted.
    const next = await postedEntry(fmc, owner, p, { ...statementBody(cat, project.id), title: 'April statement', recognitionDate: '2024-03-30', controlTotal: null, lines: [{ categoryId: cat('tips'), amount: '80.00', currency: 'EUR' }] });
    const matched = await fmc.call(F.settlementsMatch, { params: { ...p, settlementId: s.id }, body: { allocationLines: [{ targetType: 'entry', targetEntryId: next.id, amount: '80.00' }] } }, { ifMatch: ok.rowVersion });
    expect(matched.unallocated.amount).toBe('0.00');
    // Reversing an allocation restores the outstanding balance; history is kept.
    const allocationId = matched.allocations.find((a) => a.entry?.id === next.id)!.id;
    const rev = await fmc.call(F.settlementsReverseAllocation, { params: { ...p, settlementId: s.id, allocationId }, body: { reason: 'Matched to the wrong statement' } }, { ifMatch: matched.rowVersion });
    expect(rev.allocations.find((a) => a.id === allocationId)!.reversedAt).toBeTruthy();
    const reopenedDoc = await owner.call(F.entriesGet, { params: { ...p, entryId: next.id } });
    expect(reopenedDoc.outstanding).toEqual([{ amount: '80.00', currency: 'EUR' }]);
  });

  it('same-reference duplicates are blocked; similar manual payments need a reason', async () => {
    const { fmc, p } = await financeSetup();
    await fmc.call(F.settlementsCreate, { params: p, body: { direction: 'out', amount: '50.00', currency: 'EUR', paidAt: '2024-03-10T08:00:00Z', paymentReference: 'INV-1', counterparty: 'Studio' } });
    const dupRef = await fmc.attempt(F.settlementsCreate, { params: p, body: { direction: 'out', amount: '50.00', currency: 'EUR', paidAt: '2024-03-10T08:00:00Z', paymentReference: 'INV-1' } });
    expect(dupRef.status).toBe(409);
    const manual = { direction: 'out' as const, amount: '75.00', currency: 'EUR', paidAt: '2024-03-11T08:00:00Z', counterparty: 'Voice Studio' };
    const first = await fmc.call(F.settlementsCreate, { params: p, body: manual });
    expect(first.manualReference).toBe(true);
    const warn = await fmc.attempt(F.settlementsCreate, { params: p, body: manual });
    expect(warn.status).toBe(409);
    expect((warn.error as { details?: { reason?: string } }).details?.reason).toBe('possible_duplicate');
    const confirmed = await fmc.call(F.settlementsCreate, { params: p, body: { ...manual, duplicateAckReason: 'Second session invoice' } });
    expect(confirmed.duplicateAckReason).toBe('Second session invoice');
  });

  it('cross-currency settlement records both amounts and the realized FX difference', async () => {
    const { owner, fmc, project, p, cat } = await financeSetup();
    await fmc.call(F.fxRatesCreate, { params: p, body: { fromCurrency: 'USD', toCurrency: 'EUR', rate: '0.9', effectiveDate: '2024-03-01', source: 'Bank' } });
    const sale = await postedEntry(fmc, owner, p, { type: 'revenue', title: 'US licensing', recognitionDate: '2024-03-05', lines: [{ categoryId: cat('licensing'), amount: '100.00', currency: 'USD' }], allocation: onProject(project.id) });
    expect(sale.lines[0]!.baseAmount?.amount).toBe('90.00');
    const s = await fmc.call(F.settlementsCreate, { params: p, body: { direction: 'in', amount: '92.00', currency: 'EUR', paidAt: '2024-03-15T08:00:00Z', paymentReference: 'WIRE-92' } });
    const missingDoc = await fmc.attempt(F.settlementsConfirm, { params: { ...p, settlementId: s.id }, body: { allocationLines: [{ targetType: 'entry', targetEntryId: sale.id, amount: '92.00', documentCurrency: 'USD' }], remainderPolicy: 'none' } }, { ifMatch: s.rowVersion });
    expect(missingDoc.status).toBe(422);
    const ok = await fmc.call(
      F.settlementsConfirm,
      { params: { ...p, settlementId: s.id }, body: { allocationLines: [{ targetType: 'entry', targetEntryId: sale.id, amount: '92.00', documentAmount: '100.00', documentCurrency: 'USD' }], remainderPolicy: 'none' } },
      { ifMatch: s.rowVersion },
    );
    expect(ok.allocations[0]!.effectiveFxRate).toBe('0.9200000000');
    const diffId = ok.allocations[0]!.realizedDifferenceEntryId!;
    const diff = await owner.call(F.entriesGet, { params: { ...p, entryId: diffId } });
    expect(diff.lines[0]).toMatchObject({ accountingClass: 'fx_difference', fxEffect: 'gain', amount: { amount: '2.00', currency: 'EUR' } });
    const o = await owner.call(F.overview, { params: p, query: MARCH });
    expect(o.accrual.fxDifference.amount).toBe('2.00');
    expect(o.accrual.operatingResult.amount).toBe('92.00');
  });
});

describe('finance access (T016, scope isolation)', () => {
  it('leads without finance rights get 403 on finance and no amounts elsewhere', async () => {
    const { ws, owner, fmc, project, p, cat } = await financeSetup();
    const e = await postedEntry(fmc, owner, p, statementBody(cat, project.id));
    const lead = await addMember(db(), ws, { roleKey: 'project_lead', scopeType: 'assigned_projects' });
    await assignToProject(db(), ws, project.id, lead.membershipId);
    const lc = await clientFor(await sessionFor(db(), lead.userId));
    expect((await lc.attempt(F.entriesList, { params: p, query: {} })).status).toBe(403);
    expect((await lc.attempt(F.overview, { params: p, query: MARCH })).status).toBe(403);
    expect((await lc.attempt(F.entriesGet, { params: { ...p, entryId: e.id } })).status).toBe(404);
    expect((await lc.attempt(F.projectSummary, { params: { ...p, projectId: project.id }, query: MARCH })).status).toBe(403);
    expect((await lc.attempt(F.settlementsList, { params: p, query: {} })).status).toBe(403);
    expect((await lc.attempt(F.runsList, { params: p, query: {} })).status).toBe(403);
    const pd = await lc.call(projectEndpoints.get, { params: { ...p, projectId: project.id } });
    expect('budget' in pd).toBe(false);
  });

  it('project-scoped finance readers see only their projects, in lists and aggregates', async () => {
    const { ws, owner, fmc, project, p, cat } = await financeSetup();
    const other = await createProject(db(), ws, { name: 'Other Model' });
    await postedEntry(fmc, owner, p, expenseBody(cat, project.id, '10.00'));
    const hidden = await postedEntry(fmc, owner, p, expenseBody(cat, other.id, '99.00'));
    const scoped = await addMember(db(), ws, { roleKey: 'finance_manager', scopeType: 'assigned_projects' });
    await assignToProject(db(), ws, project.id, scoped.membershipId);
    const sc = await clientFor(await sessionFor(db(), scoped.userId));
    const list = await sc.call(F.entriesList, { params: p, query: {} });
    expect(list.items).toHaveLength(1);
    expect((await sc.attempt(F.entriesGet, { params: { ...p, entryId: hidden.id } })).status).toBe(404);
    const o = await sc.call(F.overview, { params: p, query: MARCH });
    expect(o.accrual.operatingExpenses.amount).toBe('10.00');
    expect((await sc.attempt(F.overview, { params: p, query: { ...MARCH, projectId: other.id } })).status).toBe(404);
  });

  it('a foreign workspace id is 404 and cross-workspace references are refused (T015)', async () => {
    const { fmc, p, cat } = await financeSetup();
    const other = await financeSetup();
    expect((await fmc.attempt(F.entriesList, { params: { workspaceId: other.ws.workspaceId }, query: {} })).status).toBe(404);
    const bad = await fmc.attempt(F.entriesCreate, { params: p, body: expenseBody(cat, other.project.id) });
    expect(bad.status).toBe(422);
  });
});
