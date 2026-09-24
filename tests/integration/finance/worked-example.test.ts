import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { newIdempotencyKey } from '@castlane/api-client';
import { financeEndpoints as F } from '@castlane/api-contracts';
import { compensationClaims, financialEntries } from '@castlane/database';
import { addMember, clientFor, sessionFor } from '../../support';
import { MARCH, db, expenseBody, financeSetup, postedEntry, statementBody } from './helpers';

/**
 * §18.7 control example end to end through the API (T119, T120, T121, T130 and the payout replay):
 * Gross 1000, Refund 100, Platform Fee 180 → Net 720; Production 200; manager 10 % of net = 72;
 * Operating Result 448; payout 720 does not change 448; paying 30 leaves 42 outstanding; after the
 * production expense is paid Cash Movement = 720 − 200 − 30 = 490.
 */
describe('finance control example (§18.7)', () => {
  it('reproduces 720 / 448 / 42 / 490 and keeps values on replay (T119, T120, T121)', async () => {
    const { ws, owner, fmc, project, p, cat } = await financeSetup();
    const manager = await addMember(db(), ws, { roleKey: 'ofm_manager', scopeType: 'assigned_accounts', name: 'Mara Manager' });

    // 1. Platform statement: three typed lines of one document, header total is only a control sum.
    const statement = await postedEntry(fmc, owner, p, statementBody(cat, project.id));
    expect(statement.state).toBe('posted');
    expect(statement.summary?.netRevenue.amount).toBe('720.00');
    expect(statement.controlCheck.status).toBe('match');
    expect(statement.outstanding).toEqual([{ amount: '720.00', currency: 'EUR' }]);

    // 2. Production expense 200.
    const expense = await postedEntry(fmc, owner, p, expenseBody(cat, project.id));
    expect(expense.outstanding).toEqual([{ amount: '-200.00', currency: 'EUR' }]);

    // 3. Manager attribution (explicit, 100 %) and a 10 % net revenue share rule.
    const attributed = await fmc.call(F.entriesSetAttributions, { params: { ...p, entryId: statement.id }, body: { attributions: [{ membershipId: manager.membershipId, sharePercent: '100' }] } }, { ifMatch: statement.rowVersion });
    expect(attributed.attributions).toHaveLength(1);
    const rule = await fmc.call(F.rulesCreate, {
      params: p,
      body: {
        name: 'Mara revenue share',
        recipientScopeType: 'member',
        recipientMembershipId: manager.membershipId,
        componentKey: 'revenue_share',
        version: { type: 'revenue_share', effectiveFrom: '2024-01-01', ratePercent: '10', revenueBasis: 'net_after_refunds_and_fees', currency: 'EUR' },
      },
    });
    const approvedRule = await owner.call(F.rulesApprove, { params: { ...p, ruleId: rule.id }, body: { versionId: rule.draftVersion!.id } }, { ifMatch: rule.rowVersion });
    expect(approvedRule.currentVersion?.state).toBe('approved');

    // 4. Compensation run: calculate → submit → approve (creates exactly one expense document).
    const run = await fmc.call(F.runsCreate, { params: p, body: { ...MARCH, participantMembershipIds: [manager.membershipId] } });
    const calc = await fmc.call(F.runsCalculate, { params: { ...p, runId: run.id }, body: {} }, { ifMatch: run.rowVersion });
    expect(calc.lines.filter((l) => !l.excluded).map((l) => l.amount.amount)).toEqual(['72.00']);
    const submitted = await fmc.call(F.runsSubmit, { params: { ...p, runId: run.id }, body: { calculationVersion: calc.calculationVersion } }, { ifMatch: calc.rowVersion });
    const approveKey = newIdempotencyKey();
    const approveBody = { calculationVersion: submitted.calculationVersion, sourceDigest: submitted.sourceDigest! };
    const approved = await owner.call(F.runsApprove, { params: { ...p, runId: run.id }, body: approveBody }, { ifMatch: submitted.rowVersion, idempotencyKey: approveKey });
    expect(approved.state).toBe('approved');
    expect(approved.expenseEntryId).toBeTruthy();

    // T130: replaying the approval (same key) returns the stored result; a new key is an invalid transition.
    const replay = await owner.call(F.runsApprove, { params: { ...p, runId: run.id }, body: approveBody }, { ifMatch: submitted.rowVersion, idempotencyKey: approveKey });
    expect(replay.expenseEntryId).toBe(approved.expenseEntryId);
    const again = await owner.attempt(F.runsApprove, { params: { ...p, runId: run.id }, body: approveBody }, { ifMatch: approved.rowVersion });
    expect(again.status).toBe(409);
    const docs = await db().select().from(financialEntries).where(eq(financialEntries.compensationRunId, run.id));
    expect(docs).toHaveLength(1);
    const claims = await db().select().from(compensationClaims).where(eq(compensationClaims.runId, run.id));
    expect(claims).toHaveLength(1);

    // T119: Net 720, result 448.
    const o1 = await owner.call(F.overview, { params: p, query: MARCH });
    expect(o1.accrual.grossRevenue.amount).toBe('1000.00');
    expect(o1.accrual.refunds.amount).toBe('100.00');
    expect(o1.accrual.fees.amount).toBe('180.00');
    expect(o1.accrual.netRevenue.amount).toBe('720.00');
    expect(o1.accrual.operatingExpenses.amount).toBe('200.00');
    expect(o1.accrual.compensationExpense.amount).toBe('72.00');
    expect(o1.accrual.operatingResult.amount).toBe('448.00');
    expect(o1.cash).toEqual([]);

    // T120: platform payout 720 settles the receivable; revenue/result unchanged, cash +720.
    const payout = await fmc.call(F.settlementsCreate, { params: p, body: { direction: 'in', amount: '720.00', currency: 'EUR', paidAt: '2024-03-20T10:00:00Z', paymentSourceNamespace: 'onlyfans', paymentReference: 'PAYOUT-0320' } });
    const confirmKey = newIdempotencyKey();
    const confirmBody = { allocationLines: [{ targetType: 'entry' as const, targetEntryId: statement.id, amount: '720.00' }], remainderPolicy: 'none' as const };
    const confirmed = await fmc.call(F.settlementsConfirm, { params: { ...p, settlementId: payout.id }, body: confirmBody }, { ifMatch: payout.rowVersion, idempotencyKey: confirmKey });
    expect(confirmed.state).toBe('confirmed');
    expect(confirmed.unallocated.amount).toBe('0.00');
    const o2 = await owner.call(F.overview, { params: p, query: MARCH });
    expect(o2.accrual.netRevenue.amount).toBe('720.00');
    expect(o2.accrual.operatingResult.amount).toBe('448.00');
    expect(o2.cash).toEqual([{ currency: 'EUR', inflows: { amount: '720.00', currency: 'EUR' }, outflows: { amount: '0.00', currency: 'EUR' }, movement: { amount: '720.00', currency: 'EUR' } }]);
    const settledStatement = await owner.call(F.entriesGet, { params: { ...p, entryId: statement.id } });
    expect(settledStatement.outstanding).toEqual([]);

    // T121: partial manager payout 30 → outstanding 42; no second compensation expense.
    const paid = await fmc.call(F.runsRecordPayment, {
      params: { ...p, runId: run.id },
      body: { recipientMembershipId: manager.membershipId, amount: '30.00', currency: 'EUR', paidAt: '2024-03-25T09:00:00Z', paymentReference: 'BANK-30' },
    });
    expect(paid.state).toBe('partially_paid');
    expect(paid.recipientTotals[0]!.outstanding.amount).toBe('42.00');
    expect(paid.recipientTotals[0]!.paid.amount).toBe('30.00');
    const o3 = await owner.call(F.overview, { params: p, query: MARCH });
    expect(o3.accrual.compensationExpense.amount).toBe('72.00');
    expect(o3.outstandingCompensation).toEqual([{ amount: '42.00', currency: 'EUR' }]);

    // Production expense paid: Cash Movement = 720 − 200 − 30 = 490; the result stays 448.
    const pay200 = await fmc.call(F.settlementsCreate, { params: p, body: { direction: 'out', amount: '200.00', currency: 'EUR', paidAt: '2024-03-26T09:00:00Z', paymentReference: 'BANK-200' } });
    await fmc.call(F.settlementsConfirm, { params: { ...p, settlementId: pay200.id }, body: { allocationLines: [{ targetType: 'entry', targetEntryId: expense.id, amount: '200.00' }], remainderPolicy: 'none' } }, { ifMatch: pay200.rowVersion });
    const o4 = await owner.call(F.overview, { params: p, query: MARCH });
    expect(o4.cash[0]!.movement.amount).toBe('490.00');
    expect(o4.accrual.operatingResult.amount).toBe('448.00');
    expect(o4.receivables).toEqual([]);
    expect(o4.payables).toEqual([]);

    // Replaying the payout confirmation with the same key keeps every value.
    const replayConfirm = await fmc.call(F.settlementsConfirm, { params: { ...p, settlementId: payout.id }, body: confirmBody }, { ifMatch: payout.rowVersion, idempotencyKey: confirmKey });
    expect(replayConfirm.id).toBe(payout.id);
    const o5 = await owner.call(F.overview, { params: p, query: MARCH });
    expect(o5).toEqual(o4);

    // The manager sees their own pay slip, not other members' data.
    const mc = await clientFor(await sessionFor(db(), manager.userId));
    const slip = await mc.call(F.memberCompensation, { params: { ...p, membershipId: manager.membershipId } });
    expect(slip.outstanding).toEqual([{ amount: '42.00', currency: 'EUR' }]);
    expect(slip.runs[0]!.lines.map((l) => l.amount.amount)).toEqual(['72.00']);
    const foreign = await mc.attempt(F.memberCompensation, { params: { ...p, membershipId: ws.owner.membershipId } });
    expect(foreign.status).toBe(403);
  });
});
