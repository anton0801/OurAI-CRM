import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { financeEndpoints as F, lookupEndpoints } from '@castlane/api-contracts';
import { RESPONSIBILITY_PROVIDERS, executeCommand, getAppServices, memberJobContext } from '@castlane/application';
import { budgets, notifications } from '@castlane/database';
import { addMember, assignToProject, clientFor, sessionFor } from '../../support';
import { MARCH, db, expenseBody, financeSetup, postedEntry } from './helpers';

const newBudget = (projectId: string, ownerMembershipId: string, cat: (k: string) => string, thresholds?: number[]) => ({
  name: 'Alpha March production',
  scopeType: 'project' as const,
  scopeId: projectId,
  ...MARCH,
  currency: 'EUR',
  ownerMembershipId,
  alertThresholds: thresholds,
  lines: [{ categoryId: cat('production_services'), planned: '1000.00' }],
});

describe('budgets and commitments', () => {
  it('a commitment converted to actual is never counted twice (T129)', async () => {
    const { ws, owner, fmc, fm, project, p, cat } = await financeSetup();
    const b = await fmc.call(F.budgetsCreate, { params: p, body: newBudget(project.id, fm.membershipId, cat) });
    const approved = await owner.call(F.budgetsApprove, { params: { ...p, budgetId: b.id }, body: { versionId: b.versions[0]!.id } }, { ifMatch: b.rowVersion });
    expect(approved.figures).toMatchObject({ planned: { amount: '1000.00' }, actual: { amount: '0.00' }, committed: { amount: '0.00' }, remaining: { amount: '1000.00' } });

    const c = await fmc.call(F.commitmentsCreate, { params: p, body: { projectId: project.id, categoryId: cat('production_services'), amount: '400.00', currency: 'EUR', dueDate: '2024-03-25', description: 'Editing studio booking' } });
    expect(c.state).toBe('open');
    const withCommit = await fmc.call(F.budgetsGet, { params: { ...p, budgetId: b.id } });
    expect(withCommit.figures).toMatchObject({ committed: { amount: '400.00' }, remaining: { amount: '600.00' } });

    // Convert part of it: the draft is linked, posting consumes the commitment.
    const draft = await fmc.call(F.commitmentsConvert, { params: { ...p, commitmentId: c.id }, body: { amount: '150.00', recognitionDate: '2024-03-20' } });
    expect(draft.state).toBe('draft');
    expect(draft.lines[0]!.commitment?.id).toBe(c.id);
    const s = await fmc.call(F.entriesSubmit, { params: { ...p, entryId: draft.id }, body: {} }, { ifMatch: draft.rowVersion });
    await owner.call(F.entriesPost, { params: { ...p, entryId: draft.id }, body: {} }, { ifMatch: s.rowVersion });
    const partly = await fmc.call(F.commitmentsGet, { params: { ...p, commitmentId: c.id } });
    expect(partly).toMatchObject({ state: 'partially_consumed', consumed: { amount: '150.00' }, remaining: { amount: '250.00' } });
    const after = await fmc.call(F.budgetsGet, { params: { ...p, budgetId: b.id } });
    // Actual 150 + committed 250 = 400 consumed; remaining 600 — not 450.
    expect(after.figures).toMatchObject({ actual: { amount: '150.00' }, committed: { amount: '250.00' }, remaining: { amount: '600.00' } });

    // Reversing the expense restores the commitment.
    const posted = await owner.call(F.entriesGet, { params: { ...p, entryId: draft.id } });
    await owner.call(F.entriesReverse, { params: { ...p, entryId: draft.id }, body: { reason: 'Booked twice', effectiveDate: '2024-03-21' } }, { ifMatch: posted.rowVersion });
    const restored = await fmc.call(F.commitmentsGet, { params: { ...p, commitmentId: c.id } });
    expect(restored).toMatchObject({ state: 'open', consumed: { amount: '0.00' } });
    // Amount cannot go below what was consumed; cancel needs a reason.
    const cancelled = await fmc.call(F.commitmentsCancel, { params: { ...p, commitmentId: c.id }, body: { reason: 'Studio cancelled' } }, { ifMatch: restored.rowVersion });
    expect(cancelled.remaining.amount).toBe('0.00');
    void ws;
  });

  it('versions: approved versions are immutable, revisions supersede them; thresholds notify once (§18.5)', async () => {
    const { ws, owner, fmc, fm, project, p, cat } = await financeSetup();
    const b = await fmc.call(F.budgetsCreate, { params: p, body: newBudget(project.id, fm.membershipId, cat, [50, 100]) });
    const v1 = await owner.call(F.budgetsApprove, { params: { ...p, budgetId: b.id }, body: { versionId: b.versions[0]!.id } }, { ifMatch: b.rowVersion });
    const edit = await fmc.attempt(F.budgetsUpdate, { params: { ...p, budgetId: b.id }, body: { lines: [{ categoryId: cat('production_services'), planned: '5.00' }] } }, { ifMatch: v1.rowVersion });
    expect(edit.status).toBe(409);

    await postedEntry(fmc, owner, p, expenseBody(cat, project.id, '600.00'));
    const alerted = await fmc.call(F.budgetsGet, { params: { ...p, budgetId: b.id } });
    expect(alerted.alerts.map((a) => a.threshold)).toEqual([50]);
    await postedEntry(fmc, owner, p, expenseBody(cat, project.id, '10.00'));
    const notes = await db().select().from(notifications).where(and(eq(notifications.workspaceId, ws.workspaceId), eq(notifications.eventType, 'finance.budget_threshold')));
    expect(notes).toHaveLength(1);
    expect(notes[0]!.recipientMembershipId).toBe(fm.membershipId);
    expect(notes[0]!.title).not.toMatch(/\d+\.\d{2}/);
    // Reset is refused while spending is still above the threshold.
    const reset = await fmc.attempt(F.budgetsResetAlert, { params: { ...p, budgetId: b.id, alertId: alerted.alerts[0]!.id }, body: { reason: 'Plan extended' } });
    expect(reset.status).toBe(409);

    // Revise: a new draft version; approving it supersedes v1 and alerts start over for v2.
    const revised = await fmc.call(F.budgetsRevise, { params: { ...p, budgetId: b.id }, body: { lines: [{ categoryId: cat('production_services'), planned: '2000.00' }], reason: 'Extra episode' } }, { ifMatch: alerted.rowVersion });
    const v2 = revised.versions.find((v) => v.state === 'draft')!;
    const approved2 = await owner.call(F.budgetsApprove, { params: { ...p, budgetId: b.id }, body: { versionId: v2.id } }, { ifMatch: revised.rowVersion });
    expect(approved2.versions.find((v) => v.versionNo === 1)!.state).toBe('superseded');
    expect(approved2.figures).toMatchObject({ planned: { amount: '2000.00' }, actual: { amount: '610.00' }, consumedPercent: '30.50' });

    // Copy Budget: a draft for the next period with explicit carry-over.
    const copy = await fmc.call(F.budgetsCopy, { params: { ...p, budgetId: b.id }, body: { name: 'Alpha April production', periodStart: '2024-04-01', periodEnd: '2024-04-30', carryOver: 'add_unused_remaining' } });
    expect(copy.versions[0]!.lines[0]!.planned.amount).toBe('3390.00');
    expect(copy.approvedVersionNo).toBeNull();
    const [row] = await db().select().from(budgets).where(eq(budgets.id, copy.id));
    expect(row!.copiedFromId).toBe(b.id);
  });

  it('budget scope, lookups and ownership transfer on deactivation (F12)', async () => {
    const { ws, fmc, fm, project, p, cat } = await financeSetup();
    // A running budget (period not over) is an open responsibility of its owner.
    const b = await fmc.call(F.budgetsCreate, { params: p, body: { ...newBudget(project.id, fm.membershipId, cat), periodStart: '2024-01-01', periodEnd: '2099-12-31' } });
    await fmc.call(F.budgetsCreate, { params: p, body: { ...newBudget(project.id, fm.membershipId, cat), name: 'Finished budget' } });
    const lead = await addMember(db(), ws, { roleKey: 'project_lead', scopeType: 'assigned_projects' });
    await assignToProject(db(), ws, project.id, lead.membershipId);
    const lc = await clientFor(await sessionFor(db(), lead.userId));
    expect((await lc.attempt(F.budgetsList, { params: p, query: {} })).status).toBe(403);
    expect((await lc.attempt(F.budgetsGet, { params: { ...p, budgetId: b.id } })).status).toBe(404);
    // Pickers: categories filtered by class, budgets in scope.
    const cats = await fmc.call(lookupEndpoints.search, { params: { ...p, type: 'finance_category' }, query: { status: ['fee'] } });
    expect(cats.items.map((i) => i.label).sort()).toEqual(['Payment Processing Fee', 'Platform Fee']);
    const bl = await fmc.call(lookupEndpoints.search, { params: { ...p, type: 'budget' }, query: { q: 'Alpha March' } });
    expect(bl.items.map((i) => i.id)).toEqual([b.id]);
    expect((await lc.attempt(lookupEndpoints.search, { params: { ...p, type: 'budget' }, query: {} })).status).toBe(403);
    // Deactivation lists the budget and transfers it to a successor.
    const provider = RESPONSIBILITY_PROVIDERS.get('finance.budget_owner')!;
    const ctx = (await memberJobContext(getAppServices(), ws.workspaceId, ws.owner.membershipId))!;
    const items = await provider.list(ctx, fm.membershipId);
    expect(items.map((i) => i.entityId)).toEqual([b.id]);
    await executeCommand(ctx, (c) => provider.transfer(c, fm.membershipId, [{ entityId: b.id, successorMembershipId: ws.owner.membershipId }]));
    const [row] = await db().select().from(budgets).where(eq(budgets.id, b.id));
    expect(row!.ownerMembershipId).toBe(ws.owner.membershipId);
  });
});
