import { afterEach, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { newIdempotencyKey } from '@castlane/api-client';
import { analyticsEndpoints, financeEndpoints, ofmEndpoints as E } from '@castlane/api-contracts';
import { auditEvents, memberships, shiftAccounts, shifts } from '@castlane/database';
import { addMember, clientFor, createAccount, createProject, mutableClock, resetClock, sessionFor } from '../../support';
import { HOUR, at, db, ofmSetup } from './helpers';

afterEach(() => resetClock());

describe('OFM assignments (S41)', () => {
  it('bumps the access revision, never grants finance, keeps history on end', async () => {
    const s = await ofmSetup({ assignManagers: false });
    const [before] = await db().select({ r: memberships.accessRevision }).from(memberships).where(eq(memberships.id, s.manager.membershipId));
    const impact = await s.owner.call(E.assignmentImpact, { params: s.p, query: { membershipId: s.manager.membershipId, accountId: s.accountA } });
    expect(impact.financeAccess).toBe(false);
    expect(impact.gainsAccountAccess).toBe(true);
    const a = await s.assignment(s.manager.membershipId, s.accountA);
    const [after] = await db().select({ r: memberships.accessRevision }).from(memberships).where(eq(memberships.id, s.manager.membershipId));
    expect(after!.r).toBe(before!.r + 1);
    // Overlapping assignment for the same member + account is refused.
    const dup = await s.owner.attempt(E.createAssignment, { params: s.p, body: { accountId: s.accountA, membershipId: s.manager.membershipId, validFrom: new Date().toISOString() } as never });
    expect(dup.status).toBe(409);
    // The manager now sees their own assignment; no finance permission came with it.
    const own = await s.manager.client.call(E.listAssignments, { params: s.p, query: {} });
    expect(own.items.map((i) => i.id)).toContain(a.id);
    const ended = await s.owner.call(E.endAssignment, { params: { ...s.p, assignmentId: a.id }, body: { reason: 'Rotation ended' } }, { ifMatch: a.rowVersion });
    expect(ended.status).toBe('ended');
    const history = await s.owner.call(E.listAssignments, { params: s.p, query: { status: ['ended'] } });
    expect(history.items.map((i) => i.id)).toContain(a.id);
  });

  it('blocks shortening an assignment while scheduled shifts fall outside, and transfer moves future shifts', async () => {
    const s = await ofmSetup();
    const shift = await s.schedule(s.manager.membershipId, 30, 36);
    const list = await s.owner.call(E.listAssignments, { params: s.p, query: { membershipId: s.manager.membershipId, accountId: s.accountA } });
    const a = list.items[0]!;
    const shorten = await s.owner.attempt(E.updateAssignment, { params: { ...s.p, assignmentId: a.id }, body: { validTo: at(10) } }, { ifMatch: a.rowVersion });
    expect(shorten.status).toBe(409);
    const end = await s.owner.attempt(E.endAssignment, { params: { ...s.p, assignmentId: a.id }, body: { reason: 'Leaving the account' } }, { ifMatch: a.rowVersion });
    expect(end.status).toBe(409);
    // Transfer to a new manager (assigned only to A): the shift covers A only, so it moves.
    const newcomer = await addMember(db(), s.ws, { roleKey: 'ofm_manager', scopeType: 'assigned_accounts' });
    const moved = await s.owner.call(E.transferAssignment, { params: { ...s.p, assignmentId: a.id }, body: { toMembershipId: newcomer.membershipId, reason: 'Rotation' } }, { ifMatch: a.rowVersion });
    expect(moved.member.membershipId).toBe(newcomer.membershipId);
    expect(moved.transferredFromId).toBe(a.id);
    const [row] = await db().select().from(shifts).where(eq(shifts.id, shift.id));
    expect(row!.membershipId).toBe(newcomer.membershipId);
    const audit = await db().select().from(auditEvents).where(and(eq(auditEvents.entityId, shift.id), eq(auditEvents.action, 'shift.reassigned')));
    expect(audit).toHaveLength(1);
  });
});

describe('Shift schedule (S42)', () => {
  it('T087: shifts outside the assignment interval are blocked', async () => {
    const s = await ofmSetup({ assignManagers: false });
    await s.assignment(s.manager.membershipId, s.accountA, { validTo: at(20) });
    const inside = await s.owner.attempt(E.createShift, { params: s.p, body: { membershipId: s.manager.membershipId, primaryAccountId: s.accountA, scheduledStart: at(10), scheduledEnd: at(18), timezone: 'UTC' } });
    expect(inside.ok).toBe(true);
    const outside = await s.owner.attempt(E.createShift, { params: s.p, body: { membershipId: s.manager.membershipId, primaryAccountId: s.accountA, scheduledStart: at(19), scheduledEnd: at(23), timezone: 'UTC' } });
    expect(outside.status).toBe(409);
    expect(JSON.stringify(outside.error)).toContain('NO_VALID_ASSIGNMENT');
    // An account without any assignment for the member is blocked as well.
    const other = await s.owner.attempt(E.createShift, { params: s.p, body: { membershipId: s.manager.membershipId, primaryAccountId: s.accountB, scheduledStart: at(2), scheduledEnd: at(6), timezone: 'UTC' } });
    expect(other.status).toBe(409);
  });

  it('T085: a member cannot hold overlapping shifts, except as one multi-account shift', async () => {
    const s = await ofmSetup();
    await s.schedule(s.manager.membershipId, 2, 10);
    const overlap = await s.owner.attempt(E.createShift, { params: s.p, body: { membershipId: s.manager.membershipId, primaryAccountId: s.accountB, scheduledStart: at(8), scheduledEnd: at(12), timezone: 'UTC' } });
    expect(overlap.status).toBe(409);
    expect(JSON.stringify(overlap.error)).toContain('MEMBER_OVERLAP');
    const multi = await s.owner.call(E.createShift, {
      params: s.p,
      body: { membershipId: s.manager.membershipId, primaryAccountId: s.accountA, additionalAccountIds: [s.accountB], scheduledStart: at(12), scheduledEnd: at(20), timezone: 'UTC' },
    });
    expect(multi.accounts).toHaveLength(2);
    expect(multi.accounts.filter((a) => a.isPrimary)).toHaveLength(1);
    const rows = await db().select().from(shifts).where(eq(shifts.membershipId, s.manager.membershipId));
    expect(rows).toHaveLength(2);
  });

  it('T086: a multi-account shift runs one timer, keeps account reports separate and counts its hours once', async () => {
    const s = await ofmSetup();
    const multi = await s.owner.call(E.createShift, {
      params: s.p,
      body: { membershipId: s.manager.membershipId, primaryAccountId: s.accountA, additionalAccountIds: [s.accountB], scheduledStart: at(2), scheduledEnd: at(6), timezone: 'UTC' },
    });
    expect(multi.accounts.map((a) => a.account.id).sort()).toEqual([s.accountA, s.accountB].sort());
    // An approved hourly rule paying shift hours (approved now: approval needs recent authentication).
    const fm = await addMember(db(), s.ws, { roleKey: 'finance_manager' });
    const fmc = await clientFor(await sessionFor(db(), fm.userId));
    const rule = await fmc.call(financeEndpoints.rulesCreate, {
      params: s.p,
      body: { name: 'Chat hours', recipientScopeType: 'member', recipientMembershipId: s.manager.membershipId, componentKey: 'hourly_shift', version: { type: 'hourly', effectiveFrom: '2024-01-01', rate: '20.00', currency: 'EUR', hourlySource: 'shift_hours' } },
    });
    await s.owner.call(financeEndpoints.rulesApprove, { params: { ...s.p, ruleId: rule.id }, body: { versionId: rule.draftVersion!.id } }, { ifMatch: rule.rowVersion });
    const clock = mutableClock(multi.scheduledStart);
    const params = { ...s.p, shiftId: multi.id };

    // One timer: a single start makes the one shift active for both accounts.
    let d = await s.manager.client.call(E.startShift, { params, body: { noHandoverReason: 'First shift on these accounts' } }, { ifMatch: multi.rowVersion });
    expect(d.state).toBe('active');
    expect(d.actualStart).toBe(multi.scheduledStart);
    const running = await db().select().from(shifts).where(and(eq(shifts.membershipId, s.manager.membershipId), inArray(shifts.state, ['active', 'paused'])));
    expect(running.map((r) => r.id)).toEqual([multi.id]);
    expect(await db().select().from(shiftAccounts).where(eq(shiftAccounts.shiftId, multi.id))).toHaveLength(2);
    clock.advance(180);
    d = await s.manager.client.call(E.endShift, { params, body: {} }, { ifMatch: d.rowVersion });
    expect(d.netSeconds).toBe(3 * 3600);

    // Account reports stay separate: one section per account of this shift, no others, no duplicates.
    const counts = { conversationsHandled: null, followUpsCompleted: null, contentRequests: null, conversionEvents: null };
    const save = (accountSections: { accountId: string; notes: string }[], version: { rowVersion: number }) =>
      s.manager.client.attempt(E.saveReportDraft, { params: { ...s.p, reportId: d.report!.id }, body: { summary: 'Evening on both accounts', counts, noOpenItems: true, accountSections } as never }, { ifMatch: version.rowVersion });
    const outsider = await createAccount(db(), s.ws, { projectId: s.project.id });
    const foreign = await save([{ accountId: outsider, notes: 'Not part of this shift' }], d.report!.currentVersion);
    expect(foreign.status).toBe(422);
    expect(JSON.stringify(foreign.error)).toContain('NOT_IN_SHIFT');
    const twice = await save([{ accountId: s.accountA, notes: 'One' }, { accountId: s.accountA, notes: 'Two' }], d.report!.currentVersion);
    expect(twice.status).toBe(422);
    const draft = await save([{ accountId: s.accountA, notes: 'Renewals on A' }, { accountId: s.accountB, notes: 'Two custom requests on B' }], d.report!.currentVersion);
    expect(draft.ok).toBe(true);
    const submitted = await s.manager.client.call(E.submitReport, { params, body: { reportVersionId: draft.data!.currentVersion.id } }, { ifMatch: draft.data!.currentVersion.rowVersion });
    const approved = await s.supervisor.client.call(E.approveReport, { params: { ...s.p, reportId: submitted.id }, body: { versionId: submitted.currentVersion.id } }, { ifMatch: submitted.currentVersion.rowVersion });
    expect(approved.state).toBe('approved');
    expect(approved.currentVersion.accountSections.map((x) => [x.accountId, x.notes]).sort()).toEqual(
      [
        [s.accountA, 'Renewals on A'],
        [s.accountB, 'Two custom requests on B'],
      ].sort(),
    );

    // Time totals: 3 net hours, never 3 × 2 accounts.
    const day = multi.scheduledStart.slice(0, 10);
    const dayOffset = (n: number) => new Date(new Date(`${day}T00:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);
    const q = await s.owner.call(analyticsEndpoints.query, { params: s.p, body: { metrics: ['M28'], period: { preset: 'custom', from: dayOffset(-1), to: dayOffset(1) }, compare: false, filters: {} } });
    expect(q.results.find((r) => r.metricId === 'M28')!.total).toMatchObject({ status: 'known', value: '3.00', sampleSize: 1 });
    // Hourly compensation from shift hours pays the 3 hours once.
    const run = await fmc.call(financeEndpoints.runsCreate, { params: s.p, body: { periodStart: dayOffset(-1), periodEnd: dayOffset(1), participantMembershipIds: [s.manager.membershipId] } });
    const calc = await fmc.call(financeEndpoints.runsCalculate, { params: { ...s.p, runId: run.id }, body: {} }, { ifMatch: run.rowVersion });
    const shiftLines = calc.lines.filter((l) => l.sourceType === 'shift');
    expect(shiftLines.map((l) => [l.sourceId, l.quantity, l.amount.amount])).toEqual([[multi.id, '3.000000', '60.00']]);
    expect(calc.recipientTotals[0]!.total.amount).toBe('60.00');
  });

  it('coverage lanes: the same lane needs explicit parallel coverage, another lane is allowed', async () => {
    const s = await ofmSetup();
    const third = await addMember(db(), s.ws, { roleKey: 'ofm_manager', scopeType: 'assigned_accounts' });
    await s.assignment(third.membershipId, s.accountA);
    await s.schedule(s.manager.membershipId, 2, 10);
    // manager2 is on the Support lane: allowed at the same time.
    await s.schedule(s.manager2.membershipId, 2, 10);
    const samePrimary = await s.owner.attempt(E.createShift, { params: s.p, body: { membershipId: third.membershipId, primaryAccountId: s.accountA, scheduledStart: at(4), scheduledEnd: at(8), timezone: 'UTC' } });
    expect(samePrimary.status).toBe(409);
    expect(JSON.stringify(samePrimary.error)).toContain('LANE_OVERLAP');
    const parallel = await s.owner.call(E.createShift, {
      params: s.p,
      body: { membershipId: third.membershipId, primaryAccountId: s.accountA, scheduledStart: at(4), scheduledEnd: at(8), timezone: 'UTC', parallelCoverage: true },
    });
    expect(parallel.parallelCoverage).toBe(true);
  });

  it('validates duration bounds (15 min – 16 h) and previews DST without writing', async () => {
    const s = await ofmSetup();
    const tooShort = await s.owner.attempt(E.createShift, { params: s.p, body: { membershipId: s.manager.membershipId, primaryAccountId: s.accountA, scheduledStart: at(2), scheduledEnd: at(2, 10), timezone: 'UTC' } });
    expect(tooShort.status).toBe(422);
    const tooLong = await s.owner.attempt(E.createShift, { params: s.p, body: { membershipId: s.manager.membershipId, primaryAccountId: s.accountA, scheduledStart: at(2), scheduledEnd: at(19), timezone: 'UTC' } });
    expect(tooLong.status).toBe(422);
    const v = await s.owner.call(E.validateShift, { params: s.p, body: { membershipId: s.manager.membershipId, primaryAccountId: s.accountA, scheduledStart: at(2), scheduledEnd: at(10), timezone: 'Europe/Berlin' } });
    expect(v.ok).toBe(true);
    expect(v.durationMinutes).toBe(480);
    expect(await db().select().from(shifts).where(eq(shifts.workspaceId, s.ws.workspaceId))).toHaveLength(0);
  });

  it('repeat schedule: preview with conflicts, apply exactly once even with a second key', async () => {
    const s = await ofmSetup();
    const start = new Date(at(24));
    const date = start.toISOString().slice(0, 10);
    const weekday = ((start.getUTCDay() + 6) % 7) + 1;
    // Block the first occurrence with an existing shift.
    await s.owner.call(E.createShift, { params: s.p, body: { membershipId: s.manager.membershipId, primaryAccountId: s.accountA, scheduledStart: `${date}T09:00:00.000Z`, scheduledEnd: `${date}T12:00:00.000Z`, timezone: 'UTC' } });
    const preview = await s.owner.call(E.repeatPreview, {
      params: s.p,
      body: { membershipId: s.manager.membershipId, primaryAccountId: s.accountA, pattern: { startDate: date, weeks: 3, weekdays: [weekday], startTime: '10:00', endTime: '14:00', timezone: 'UTC' } },
    });
    expect(preview.occurrences).toHaveLength(3);
    expect(preview.occurrences[0]!.ok).toBe(false);
    expect(preview.occurrences.slice(1).every((o) => o.ok)).toBe(true);
    const key = newIdempotencyKey();
    const applied = await s.owner.call(E.repeatApply, { params: s.p, body: { previewToken: preview.previewToken, skipConflicting: true } }, { idempotencyKey: key });
    expect(applied.created).toHaveLength(2);
    expect(applied.skipped).toHaveLength(1);
    const replay = await s.owner.call(E.repeatApply, { params: s.p, body: { previewToken: preview.previewToken, skipConflicting: true } }, { idempotencyKey: key });
    expect(replay.created).toEqual(applied.created);
    const again = await s.owner.call(E.repeatApply, { params: s.p, body: { previewToken: preview.previewToken, skipConflicting: true } });
    expect(again.created).toHaveLength(0);
    const rows = await db().select().from(shifts).where(eq(shifts.repeatGroupId, applied.repeatGroupId));
    expect(rows).toHaveLength(2);
  });

  it('swap: proposed member accepts, supervisor approves after re-checking assignment and overlaps; cancel only while scheduled', async () => {
    const s = await ofmSetup();
    const shift = await s.schedule(s.manager.membershipId, 5, 9);
    // Proposed member without an assignment on account A can accept, but approval is refused.
    const outsider = await addMember(db(), s.ws, { roleKey: 'ofm_manager', scopeType: 'assigned_accounts' });
    const outsiderC = await clientFor(await sessionFor(db(), outsider.userId));
    const req1 = await s.manager.client.call(E.requestSwap, { params: { ...s.p, shiftId: shift.id }, body: { proposedMembershipId: outsider.membershipId, reason: 'Doctor visit' } });
    const acc1 = await outsiderC.call(E.acceptSwap, { params: { ...s.p, swapId: req1.id } }, { ifMatch: req1.rowVersion });
    const refused = await s.supervisor.client.attempt(E.approveSwap, { params: { ...s.p, swapId: req1.id }, body: {} }, { ifMatch: acc1.rowVersion });
    expect(refused.status).toBe(409);
    const dec = await s.supervisor.client.call(E.declineSwap, { params: { ...s.p, swapId: req1.id }, body: { reason: 'Not assigned to the account' } }, { ifMatch: acc1.rowVersion });
    expect(dec.state).toBe('declined');
    // manager2 (support lane on A) takes it.
    const req = await s.manager.client.call(E.requestSwap, { params: { ...s.p, shiftId: shift.id }, body: { proposedMembershipId: s.manager2.membershipId, reason: 'Doctor visit' } });
    const accepted = await s.manager2.client.call(E.acceptSwap, { params: { ...s.p, swapId: req.id } }, { ifMatch: req.rowVersion });
    expect(accepted.state).toBe('pending_approval');
    const approved = await s.supervisor.client.call(E.approveSwap, { params: { ...s.p, swapId: req.id }, body: { note: 'OK' } }, { ifMatch: accepted.rowVersion });
    expect(approved.state).toBe('approved');
    const detail = await s.owner.call(E.getShift, { params: { ...s.p, shiftId: shift.id } });
    expect(detail.member.membershipId).toBe(s.manager2.membershipId);
    expect(detail.accounts[0]!.coverageLane).toBe('support');
    const cancelled = await s.owner.call(E.cancelShift, { params: { ...s.p, shiftId: shift.id }, body: { reason: 'Model on holiday' } }, { ifMatch: detail.rowVersion });
    expect(cancelled.state).toBe('cancelled');
  });
});

describe('Shift scope (S42/S43, §7)', () => {
  it('managers see only their own shifts; other models are 404; list counts are scoped', async () => {
    const s = await ofmSetup();
    const mine = await s.schedule(s.manager.membershipId, 2, 6);
    const theirs = await s.schedule(s.manager2.membershipId, 2, 6);
    const list = await s.manager.client.call(E.listShifts, { params: s.p, query: {} });
    expect(list.items.map((i) => i.id)).toEqual([mine.id]);
    const other = await s.manager.client.attempt(E.getShift, { params: { ...s.p, shiftId: theirs.id } });
    expect(other.status).toBe(404);
    const supList = await s.supervisor.client.call(E.listShifts, { params: s.p, query: {} });
    expect(supList.items.map((i) => i.id).sort()).toEqual([mine.id, theirs.id].sort());
    // A supervisor of another model sees none of them.
    const otherProject = await createProject(db(), s.ws, { type: 'model', ofmEnabled: true });
    await createAccount(db(), s.ws, { projectId: otherProject.id });
    const sup2 = await addMember(db(), s.ws, { roleKey: 'ofm_supervisor', scopeType: 'assigned_projects' });
    const sup2C = await clientFor(await sessionFor(db(), sup2.userId));
    expect((await sup2C.call(E.listShifts, { params: s.p, query: {} })).items).toHaveLength(0);
    expect((await sup2C.attempt(E.getShift, { params: { ...s.p, shiftId: mine.id } })).status).toBe(404);
    // A creator without any OFM permission gets 403 on the module.
    const creator = await addMember(db(), s.ws, { roleKey: 'creator', scopeType: 'assigned_projects' });
    const creatorC = await clientFor(await sessionFor(db(), creator.userId));
    expect((await creatorC.attempt(E.listShifts, { params: s.p, query: {} })).status).toBe(403);
    // Managers cannot schedule.
    const sched = await s.manager.client.attempt(E.createShift, { params: s.p, body: { membershipId: s.manager.membershipId, primaryAccountId: s.accountA, scheduledStart: at(40), scheduledEnd: at(44), timezone: 'UTC' } });
    expect(sched.status).toBe(403);
    void HOUR;
  });
});
