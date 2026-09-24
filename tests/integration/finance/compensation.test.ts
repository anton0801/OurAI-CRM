import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { newIdempotencyKey } from '@castlane/api-client';
import { financeEndpoints as F, type EndpointBody } from '@castlane/api-contracts';
import { compensationAdjustments, compensationClaims, compensationLines, financialEntries, shifts, tasks, timeEntries } from '@castlane/database';
import { newId } from '@castlane/domain';
import { addMember, clientFor, createAccount, sessionFor, type TestClient } from '../../support';
import { MARCH, db, financeSetup, onProject, postedEntry } from './helpers';

type RuleBody = EndpointBody<typeof F.rulesCreate>;

const approvedRule = async (maker: TestClient, checker: TestClient, p: { workspaceId: string }, body: RuleBody) => {
  const r = await maker.call(F.rulesCreate, { params: p, body });
  return checker.call(F.rulesApprove, { params: { ...p, ruleId: r.id }, body: { versionId: r.draftVersion!.id } }, { ifMatch: r.rowVersion });
};

/** Create → calculate → submit (maker) → approve (checker). */
const approvedRun = async (maker: TestClient, checker: TestClient, p: { workspaceId: string }, period: { periodStart: string; periodEnd: string }, participants: string[]) => {
  const run = await maker.call(F.runsCreate, { params: p, body: { ...period, participantMembershipIds: participants } });
  const calc = await maker.call(F.runsCalculate, { params: { ...p, runId: run.id }, body: {} }, { ifMatch: run.rowVersion });
  const sub = await maker.call(F.runsSubmit, { params: { ...p, runId: run.id }, body: { calculationVersion: calc.calculationVersion } }, { ifMatch: calc.rowVersion });
  return checker.call(F.runsApprove, { params: { ...p, runId: run.id }, body: { calculationVersion: sub.calculationVersion, sourceDigest: sub.sourceDigest! } }, { ifMatch: sub.rowVersion });
};

const at = (iso: string) => new Date(iso);

describe('compensation rules and runs', () => {
  it('fixed mid-month proration: Calendar Days and None are reproducible (T132)', async () => {
    const { ws, owner, fmc, p } = await financeSetup();
    const a = await addMember(db(), ws, { roleKey: 'creator', scopeType: 'assigned_projects', name: 'Ana' });
    const b = await addMember(db(), ws, { roleKey: 'creator', scopeType: 'assigned_projects', name: 'Ben' });
    const fixed = (membershipId: string, proration: 'none' | 'calendar_days'): RuleBody => ({
      name: `Retainer ${proration}`,
      recipientScopeType: 'member',
      recipientMembershipId: membershipId,
      componentKey: 'retainer',
      version: { type: 'fixed_period', effectiveFrom: '2024-03-16', rate: '3000.00', currency: 'EUR', proration },
    });
    await approvedRule(fmc, owner, p, fixed(a.membershipId, 'calendar_days'));
    await approvedRule(fmc, owner, p, fixed(b.membershipId, 'none'));
    const run = await fmc.call(F.runsCreate, { params: p, body: { ...MARCH, participantMembershipIds: [a.membershipId, b.membershipId] } });
    const calc = await fmc.call(F.runsCalculate, { params: { ...p, runId: run.id }, body: {} }, { ifMatch: run.rowVersion });
    const byName = (n: string) => calc.lines.find((l) => l.recipient.displayName === n)!;
    // 3000 × 16/31 = 1548.387… → 1548.39 (half-even, once for the month); None pays the full month.
    expect(byName('Ana').amount.amount).toBe('1548.39');
    expect(byName('Ana').explanation).toMatchObject({ eligibleDays: 16, daysInMonth: 31, proration: 'calendar_days' });
    expect(byName('Ben').amount.amount).toBe('3000.00');
    // Recalculating with unchanged inputs produces the same lines and no diff.
    const again = await fmc.call(F.runsCalculate, { params: { ...p, runId: run.id }, body: {} }, { ifMatch: calc.rowVersion });
    expect(again.calculationVersion).toBe(2);
    expect(again.sourceDigest).toBe(calc.sourceDigest);
    expect(again.diff).toEqual({ previousVersion: 1, added: [], removed: [], changed: [] });
  });

  it('hourly TimeEntry and Shift time of the same period is paid once (T133)', async () => {
    const { ws, owner, fmc, project, p } = await financeSetup();
    const h = await addMember(db(), ws, { roleKey: 'ofm_manager', scopeType: 'assigned_accounts', name: 'Hana Hours' });
    const accountId = await createAccount(db(), ws, { projectId: project.id, platform: 'onlyfans', url: 'https://onlyfans.com/alpha_test' });
    const taskId = newId();
    await db().insert(tasks).values({ id: taskId, workspaceId: ws.workspaceId, projectId: project.id, title: 'Chat operations', status: 'done' });
    await db().insert(timeEntries).values({
      id: newId(),
      workspaceId: ws.workspaceId,
      membershipId: h.membershipId,
      taskId,
      projectId: project.id,
      source: 'manual',
      state: 'approved',
      startedAt: at('2024-03-10T10:00:00Z'),
      endedAt: at('2024-03-10T12:00:00Z'),
      durationSeconds: 7200,
      workDate: '2024-03-10',
    });
    await db().insert(shifts).values({
      id: newId(),
      workspaceId: ws.workspaceId,
      projectId: project.id,
      primaryAccountId: accountId,
      membershipId: h.membershipId,
      scheduledStart: at('2024-03-10T11:00:00Z'),
      scheduledEnd: at('2024-03-10T13:00:00Z'),
      timezone: 'Europe/Berlin',
      state: 'ended',
      reportState: 'approved',
      actualStart: at('2024-03-10T11:00:00Z'),
      actualEnd: at('2024-03-10T13:00:00Z'),
    });
    const hourly = (source: 'time_entries' | 'shift_hours', component: string, stackGroup: string | null): RuleBody => ({
      name: `Hourly ${source}`,
      recipientScopeType: 'member',
      recipientMembershipId: h.membershipId,
      componentKey: component,
      stackGroup,
      version: { type: 'hourly', effectiveFrom: '2024-01-01', rate: '20.00', currency: 'EUR', hourlySource: source },
    });
    await approvedRule(fmc, owner, p, hourly('time_entries', 'hourly_time', 'hours'));
    // Without a shared stack group the second rule is blocked (no hidden double accrual).
    const blockedRule = await fmc.call(F.rulesCreate, { params: p, body: hourly('shift_hours', 'hourly_shift', null) });
    const blocked = await owner.attempt(F.rulesApprove, { params: { ...p, ruleId: blockedRule.id }, body: { versionId: blockedRule.draftVersion!.id } }, { ifMatch: blockedRule.rowVersion });
    expect(blocked.status).toBe(409);
    await approvedRule(fmc, owner, p, hourly('shift_hours', 'hourly_shift', 'hours'));
    const run = await fmc.call(F.runsCreate, { params: p, body: { ...MARCH, participantMembershipIds: [h.membershipId] } });
    const calc = await fmc.call(F.runsCalculate, { params: { ...p, runId: run.id }, body: {} }, { ifMatch: run.rowVersion });
    const te = calc.lines.find((l) => l.sourceType === 'time_entry')!;
    const sh = calc.lines.find((l) => l.sourceType === 'shift')!;
    expect(te.amount.amount).toBe('40.00');
    expect(sh.amount.amount).toBe('20.00');
    expect(sh.quantity).toBe('1.000000');
    expect(sh.explanation.overlapSeconds).toBe(3600);
    expect(calc.recipientTotals[0]!.total.amount).toBe('60.00');
  });

  it('overlapping revenue shares: error or explicit stack preview (T134)', async () => {
    const { ws, owner, fmc, p } = await financeSetup();
    const m = await addMember(db(), ws, { roleKey: 'ofm_manager', scopeType: 'assigned_accounts' });
    const share = (component: string, pct: string, stackGroup: string | null): RuleBody => ({
      name: `Share ${component}`,
      recipientScopeType: 'member',
      recipientMembershipId: m.membershipId,
      componentKey: component,
      stackGroup,
      version: { type: 'revenue_share', effectiveFrom: '2024-01-01', ratePercent: pct, revenueBasis: 'net_after_refunds_and_fees', currency: 'EUR' },
    });
    await approvedRule(fmc, owner, p, share('base_share', '60', 'mgr'));
    const same = await fmc.call(F.rulesCreate, { params: p, body: share('base_share', '5', 'mgr') });
    const r1 = await owner.attempt(F.rulesApprove, { params: { ...p, ruleId: same.id }, body: { versionId: same.draftVersion!.id } }, { ifMatch: same.rowVersion });
    expect(r1.status).toBe(409);
    expect((r1.error as { details?: { conflicts?: { code: string }[] } }).details?.conflicts?.[0]!.code).toBe('SAME_COMPONENT');
    const over = await fmc.call(F.rulesCreate, { params: p, body: share('bonus_share', '50', 'mgr') });
    const sim = await fmc.call(F.rulesSimulate, { params: { ...p, ruleId: over.id }, body: { versionId: over.draftVersion!.id, ...MARCH } });
    expect(sim.stack.revenueSharePercent).toBe('110');
    expect(sim.conflicts.map((c) => c.code)).toEqual(['STACK_OVER_100']);
    const r2 = await owner.attempt(F.rulesApprove, { params: { ...p, ruleId: over.id }, body: { versionId: over.draftVersion!.id } }, { ifMatch: over.rowVersion });
    expect(r2.status).toBe(409);
    const ok = await fmc.call(F.rulesCreate, { params: p, body: share('bonus_share2', '10', 'mgr') });
    const approved = await owner.call(F.rulesApprove, { params: { ...p, ruleId: ok.id }, body: { versionId: ok.draftVersion!.id } }, { ifMatch: ok.rowVersion });
    expect(approved.currentVersion?.ratePercent).toBe('10.0000');
    // Simulation accrues nothing.
    expect(await db().select().from(compensationLines).where(eq(compensationLines.workspaceId, ws.workspaceId))).toHaveLength(0);
  });

  it('refund after approval → adjustment in the next run; negative balance carried forward (T131, T135)', async () => {
    const { ws, owner, fmc, project, p, cat } = await financeSetup();
    const m = await addMember(db(), ws, { roleKey: 'ofm_manager', scopeType: 'assigned_accounts', name: 'Rhea' });
    const sale = await postedEntry(fmc, owner, p, { type: 'revenue', title: 'Content sale', recognitionDate: '2024-03-05', lines: [{ categoryId: cat('content_sales'), amount: '1000.00', currency: 'EUR' }], allocation: onProject(project.id) });
    await fmc.call(F.entriesSetAttributions, { params: { ...p, entryId: sale.id }, body: { attributions: [{ membershipId: m.membershipId, sharePercent: '100' }] } }, { ifMatch: sale.rowVersion });
    await approvedRule(fmc, owner, p, {
      name: 'Rhea share',
      recipientScopeType: 'member',
      recipientMembershipId: m.membershipId,
      componentKey: 'revenue_share',
      version: { type: 'revenue_share', effectiveFrom: '2024-01-01', ratePercent: '10', revenueBasis: 'net_after_refunds_and_fees', currency: 'EUR' },
    });
    const march = await approvedRun(fmc, owner, p, MARCH, [m.membershipId]);
    expect(march.lines.map((l) => l.amount.amount)).toEqual(['100.00']);
    await fmc.call(F.runsRecordPayment, { params: { ...p, runId: march.id }, body: { recipientMembershipId: m.membershipId, amount: '100.00', currency: 'EUR', paidAt: '2024-04-01T08:00:00Z' } });

    // A refund of 300 arrives in April, after the March run was approved and paid.
    await postedEntry(fmc, owner, p, {
      type: 'adjustment',
      title: 'Refund of content sale',
      recognitionDate: '2024-04-05',
      refundOfEntryId: sale.id,
      lines: [{ categoryId: cat('refund'), amount: '300.00', currency: 'EUR' }],
      allocation: onProject(project.id),
    });
    const april = await fmc.call(F.runsCreate, { params: p, body: { periodStart: '2024-04-01', periodEnd: '2024-04-30', participantMembershipIds: [m.membershipId] } });
    const aprCalc = await fmc.call(F.runsCalculate, { params: { ...p, runId: april.id }, body: {} }, { ifMatch: april.rowVersion });
    const refundLine = aprCalc.lines.find((l) => l.sourceType === 'financial_entry')!;
    expect(refundLine.amount.amount).toBe('-30.00');
    expect(refundLine.explanation.refundOfEntryId).toBe(sale.id);
    expect(String(refundLine.explanation.linkedEntitlementKey)).toContain(sale.id);
    // T135: the negative total is not collected — payable 0, carried forward.
    const carry = aprCalc.lines.find((l) => l.sourceType === 'carry_forward')!;
    expect(carry.amount.amount).toBe('30.00');
    expect(aprCalc.recipientTotals[0]).toMatchObject({ total: { amount: '0.00' }, payable: { amount: '0.00' } });
    const aprSub = await fmc.call(F.runsSubmit, { params: { ...p, runId: april.id }, body: { calculationVersion: aprCalc.calculationVersion } }, { ifMatch: aprCalc.rowVersion });
    const aprApproved = await owner.call(F.runsApprove, { params: { ...p, runId: april.id }, body: { calculationVersion: aprSub.calculationVersion, sourceDigest: aprSub.sourceDigest! } }, { ifMatch: aprSub.rowVersion });
    expect(aprApproved.expenseEntryId).toBeNull();
    // The past March run is not rewritten.
    const marchAfter = await owner.call(F.runsGet, { params: { ...p, runId: march.id } });
    expect(marchAfter.lines.map((l) => l.amount.amount)).toEqual(['100.00']);
    expect(marchAfter.state).toBe('paid');
    const pending = await db().select().from(compensationAdjustments).where(eq(compensationAdjustments.recipientMembershipId, m.membershipId));
    expect(pending.map((a) => [a.kind, a.amountMinor, a.state])).toEqual([['carry_forward', -3000n, 'approved']]);

    // May: a manual bonus of 50 minus the carried 30 → payable 20.
    const may = await fmc.call(F.runsCreate, { params: p, body: { periodStart: '2024-05-01', periodEnd: '2024-05-31', participantMembershipIds: [m.membershipId] } });
    const withBonus = await fmc.call(F.runsAddAdjustment, { params: { ...p, runId: may.id }, body: { recipientMembershipId: m.membershipId, amount: '50.00', currency: 'EUR', kind: 'manual_bonus', reason: 'Quality bonus for April' } });
    const mayCalc = await fmc.call(F.runsCalculate, { params: { ...p, runId: may.id }, body: {} }, { ifMatch: withBonus.rowVersion });
    expect(mayCalc.lines.map((l) => [l.component, l.amount.amount]).sort()).toEqual([
      ['carry_forward', '-30.00'],
      ['manual_bonus', '50.00'],
    ]);
    expect(mayCalc.recipientTotals[0]!.payable.amount).toBe('20.00');
    const slip = await fmc.call(F.memberCompensation, { params: { ...p, membershipId: m.membershipId } });
    expect(slip.carryForward).toEqual([{ amount: '-30.00', currency: 'EUR' }]);
  });

  it('an entitlement is claimed by one approved run only; a replayed approve adds no document or claim; manual compensation expenses must be reconciled (T130)', async () => {
    const { ws, owner, fmc, p, cat } = await financeSetup();
    const m = await addMember(db(), ws, { roleKey: 'creator', scopeType: 'assigned_projects' });
    await approvedRule(fmc, owner, p, { name: 'Retainer', recipientScopeType: 'member', recipientMembershipId: m.membershipId, componentKey: 'retainer', version: { type: 'fixed_period', effectiveFrom: '2024-01-01', rate: '500.00', currency: 'EUR' } });
    const mk = async () => {
      const run = await fmc.call(F.runsCreate, { params: p, body: { ...MARCH, participantMembershipIds: [m.membershipId] } });
      const calc = await fmc.call(F.runsCalculate, { params: { ...p, runId: run.id }, body: {} }, { ifMatch: run.rowVersion });
      return fmc.call(F.runsSubmit, { params: { ...p, runId: run.id }, body: { calculationVersion: calc.calculationVersion } }, { ifMatch: calc.rowVersion });
    };
    const a = await mk();
    const b = await mk();
    // A manually recorded compensation expense in the period blocks approval until reconciled.
    await postedEntry(owner, fmc, p, { type: 'expense', title: 'Manual retainer', recognitionDate: '2024-03-28', lines: [{ categoryId: cat('compensation'), amount: '500.00', currency: 'EUR' }] });
    const blocked = await owner.attempt(F.runsApprove, { params: { ...p, runId: a.id }, body: { calculationVersion: a.calculationVersion, sourceDigest: a.sourceDigest! } }, { ifMatch: a.rowVersion });
    expect(blocked.status).toBe(409);
    expect((blocked.error as { details?: { reason?: string } }).details?.reason).toBe('manual_compensation_expense');
    const manual = await db().select().from(financialEntries).where(eq(financialEntries.title, 'Manual retainer'));
    const approveKey = newIdempotencyKey();
    const approveBody = { calculationVersion: a.calculationVersion, sourceDigest: a.sourceDigest!, linkExistingEntryId: manual[0]!.id };
    const linked = await owner.call(F.runsApprove, { params: { ...p, runId: a.id }, body: approveBody }, { ifMatch: a.rowVersion, idempotencyKey: approveKey });
    expect(linked.expenseEntryId).toBe(manual[0]!.id);
    // The approval is replayed (lost response): the stored result comes back, nothing is written again.
    const replay = await owner.call(F.runsApprove, { params: { ...p, runId: a.id }, body: approveBody }, { ifMatch: a.rowVersion, idempotencyKey: approveKey });
    expect(replay).toMatchObject({ state: 'approved', expenseEntryId: linked.expenseEntryId, rowVersion: linked.rowVersion });
    const again = await owner.attempt(F.runsApprove, { params: { ...p, runId: a.id }, body: approveBody }, { ifMatch: linked.rowVersion });
    expect(again.status).toBe(409);
    // The second run computed the same entitlement: its approval is refused and nothing is claimed twice.
    const second = await owner.attempt(F.runsApprove, { params: { ...p, runId: b.id }, body: { calculationVersion: b.calculationVersion, sourceDigest: b.sourceDigest! } }, { ifMatch: b.rowVersion });
    expect(second.status).toBe(409);
    // Exactly one expense document (the reconciled manual one) and one entitlement claim.
    const documents = await db().select().from(financialEntries).where(eq(financialEntries.workspaceId, ws.workspaceId));
    expect(documents.map((d) => d.id)).toEqual([manual[0]!.id]);
    const claims = await db().select().from(compensationClaims).where(eq(compensationClaims.workspaceId, ws.workspaceId));
    expect(claims.map((c) => c.runId)).toEqual([a.id]);
    const o = await owner.call(F.overview, { params: p, query: MARCH });
    expect(o.accrual.compensationExpense.amount).toBe('500.00');
    // Cancel is allowed before approval only.
    const cancelled = await fmc.call(F.runsCancel, { params: { ...p, runId: b.id }, body: { reason: 'Duplicate run' } }, { ifMatch: b.rowVersion });
    expect(cancelled.state).toBe('cancelled');
    expect((await fmc.attempt(F.runsCancel, { params: { ...p, runId: a.id }, body: { reason: 'Too late now' } }, { ifMatch: linked.rowVersion })).status).toBe(409);
  });

  it('compensation is workspace-level: members without the permission get 403', async () => {
    const { ws, p } = await financeSetup();
    const lead = await addMember(db(), ws, { roleKey: 'project_lead', scopeType: 'assigned_projects' });
    const lc = await clientFor(await sessionFor(db(), lead.userId));
    expect((await lc.attempt(F.runsList, { params: p, query: {} })).status).toBe(403);
    expect((await lc.attempt(F.rulesList, { params: p, query: {} })).status).toBe(200);
    const own = await lc.call(F.rulesList, { params: p, query: {} });
    expect(own.items).toEqual([]);
  });
});
