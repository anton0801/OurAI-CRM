import { afterEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { ofmEndpoints as E, type OfmShiftDetail } from '@castlane/api-contracts';
import { financialEntries, handoverItems, saleCandidates, shiftReportVersions, tasks } from '@castlane/database';
import { newId } from '@castlane/domain';
import { mutableClock, resetClock } from '../../support';
import { MIN, db, notificationsFor, ofmSetup } from './helpers';

afterEach(() => resetClock());

/** Run a shift from start to end for its member; returns the ended shift detail. */
const workShift = async (s: Awaited<ReturnType<typeof ofmSetup>>, who: 'manager' | 'manager2', startH: number, endH: number) => {
  const m = s[who];
  const shift = await s.schedule(m.membershipId, startH, endH);
  const clock = mutableClock(shift.scheduledStart);
  const params = { ...s.p, shiftId: shift.id };
  const started = await m.client.call(E.startShift, { params, body: { noHandoverReason: 'First shift on this account' } }, { ifMatch: shift.rowVersion });
  clock.advance((endH - startH) * 60);
  const ended = await m.client.call(E.endShift, { params, body: {} }, { ifMatch: started.rowVersion });
  return { shift: ended, clock };
};

const saveDraft = (s: Awaited<ReturnType<typeof ofmSetup>>, d: OfmShiftDetail, body: Record<string, unknown>) =>
  s.manager.client.call(
    E.saveReportDraft,
    {
      params: { ...s.p, reportId: d.report!.id },
      body: {
        summary: '',
        counts: { conversationsHandled: null, followUpsCompleted: null, contentRequests: null, conversionEvents: null },
        ...body,
      } as never,
    },
    { ifMatch: d.report!.currentVersion.rowVersion },
  );

describe('Shift reports (§13.3)', () => {
  it('T092: submit requires a summary and handover items or an explicit No Open Items', async () => {
    const s = await ofmSetup();
    const { shift } = await workShift(s, 'manager', 1, 4);
    const params = { ...s.p, shiftId: shift.id };
    const noSummary = await s.manager.client.attempt(E.submitReport, { params, body: { reportVersionId: shift.report!.currentVersion.id } }, { ifMatch: shift.report!.currentVersion.rowVersion });
    expect(noSummary.status).toBe(422);
    const fields = (noSummary.error as { fieldErrors: { field: string }[] }).fieldErrors.map((f) => f.field);
    expect(fields).toEqual(expect.arrayContaining(['summary', 'noOpenItems']));
    const r1 = await saveDraft(s, shift, { summary: 'Handled renewals and two content requests.', counts: { conversationsHandled: 14, followUpsCompleted: null, contentRequests: 2, conversionEvents: null } });
    // Unknown counts stay null (never coerced to 0).
    expect(r1.currentVersion.counts.followUpsCompleted).toBeNull();
    const stillNoItems = await s.manager.client.attempt(E.submitReport, { params, body: { reportVersionId: r1.currentVersion.id } }, { ifMatch: r1.currentVersion.rowVersion });
    expect(stillNoItems.status).toBe(422);
    expect((stillNoItems.error as { fieldErrors: { field: string; code: string }[] }).fieldErrors[0]).toMatchObject({ field: 'noOpenItems', code: 'HANDOVER_OR_NO_OPEN_ITEMS' });
    const submitted = await s.manager.client.call(E.submitReport, { params, body: { reportVersionId: r1.currentVersion.id, noOpenItems: true } }, { ifMatch: r1.currentVersion.rowVersion });
    expect(submitted.state).toBe('submitted');
    const note = (await notificationsFor(s.ws.workspaceId, s.supervisor.membershipId)).find((n) => n.eventKey === `shift_report.submitted:${r1.currentVersion.id}`);
    expect(note?.title).toBe('Shift report awaiting review');
  });

  it('T093: approval freezes the version and never posts finance; changes requested produce a new version', async () => {
    const s = await ofmSetup();
    const { shift } = await workShift(s, 'manager', 1, 4);
    await db().insert(saleCandidates).values({
      id: newId(),
      workspaceId: s.ws.workspaceId,
      accountId: s.accountA,
      projectId: s.project.id,
      sourceNamespace: 'onlyfans',
      sourceTransactionId: 'tx-approve-1',
      shiftId: shift.id,
      occurredAt: new Date(shift.actualStart!),
      grossMinor: 5000n,
      currency: 'EUR',
    });
    const params = { ...s.p, shiftId: shift.id };
    const r1 = await saveDraft(s, shift, { summary: 'Evening shift summary', noOpenItems: true });
    const sub1 = await s.manager.client.call(E.submitReport, { params, body: { reportVersionId: r1.currentVersion.id } }, { ifMatch: r1.currentVersion.rowVersion });
    // The member cannot approve their own report; the supervisor asks for changes.
    const self = await s.manager.client.attempt(E.approveReport, { params: { ...s.p, reportId: sub1.id }, body: { versionId: sub1.currentVersion.id } }, { ifMatch: sub1.currentVersion.rowVersion });
    expect(self.status).toBe(403);
    const changes = await s.supervisor.client.call(E.requestReportChanges, { params: { ...s.p, reportId: sub1.id }, body: { versionId: sub1.currentVersion.id, summary: 'Add the account notes' } }, { ifMatch: sub1.currentVersion.rowVersion });
    expect(changes.state).toBe('changes_requested');
    expect((await notificationsFor(s.ws.workspaceId, s.manager.membershipId)).some((n) => n.eventKey === `shift_report.changes_requested:${sub1.currentVersion.id}`)).toBe(true);
    const detail = await s.manager.client.call(E.getShift, { params });
    const r2 = await saveDraft(s, detail, { summary: 'Evening shift summary (revised)', noOpenItems: true, accountSections: [{ accountId: s.accountA, notes: 'Two renewals' }] });
    expect(r2.currentVersion.versionNo).toBe(2);
    expect(r2.versions.find((v) => v.versionNo === 1)?.state).toBe('changes_requested');
    const sub2 = await s.manager.client.call(E.submitReport, { params, body: { reportVersionId: r2.currentVersion.id } }, { ifMatch: r2.currentVersion.rowVersion });
    expect(sub2.state).toBe('submitted');
    const approved = await s.supervisor.client.call(E.approveReport, { params: { ...s.p, reportId: sub2.id }, body: { versionId: sub2.currentVersion.id } }, { ifMatch: sub2.currentVersion.rowVersion });
    expect(approved.state).toBe('approved');
    expect(approved.approvedVersionId).toBe(sub2.currentVersion.id);
    // Frozen at the database level.
    await expect(db().execute(sql`UPDATE shift_report_versions SET summary = 'tampered' WHERE id = ${sub2.currentVersion.id}`)).rejects.toThrow();
    const [v] = await db().select().from(shiftReportVersions).where(eq(shiftReportVersions.id, sub2.currentVersion.id));
    expect(v!.summary).toBe('Evening shift summary (revised)');
    // No finance was created or posted; the sale stays a pending candidate.
    expect(await db().select().from(financialEntries).where(eq(financialEntries.workspaceId, s.ws.workspaceId))).toHaveLength(0);
    const [sc] = await db().select().from(saleCandidates).where(eq(saleCandidates.sourceTransactionId, 'tx-approve-1'));
    expect(sc!.state).toBe('pending');
    // Pending sales show separately from confirmed ones (none).
    expect(approved.sales?.pendingVerification.count).toBe(1);
    const saveApproved = await s.manager.client.attempt(E.saveReportDraft, { params: { ...s.p, reportId: approved.id }, body: { summary: 'x', counts: { conversationsHandled: null, followUpsCompleted: null, contentRequests: null, conversionEvents: null } } }, { ifMatch: approved.currentVersion.rowVersion });
    expect(saveApproved.status).toBe(409);
  });
});

describe('Handovers (S44)', () => {
  it('routes to the next shift, requires acknowledgement at start, and acknowledgement never completes or clones tasks (T094)', async () => {
    const s = await ofmSetup();
    const next = await s.schedule(s.manager2.membershipId, 5, 9);
    const { shift, clock } = await workShift(s, 'manager', 1, 4);
    // Existing task and operation are referenced by id.
    const taskId = newId();
    await db().insert(tasks).values({ id: taskId, workspaceId: s.ws.workspaceId, projectId: s.project.id, accountId: s.accountA, title: 'Prepare custom set', status: 'in_progress', assigneeMembershipId: s.manager.membershipId });
    const op = await s.manager.client.call(E.createOperation, { params: s.p, body: { type: 'follow_up', accountId: s.accountA, ownerMembershipId: s.manager.membershipId, title: 'Check renewal status' } });
    const h = await s.manager.client.call(E.createHandover, {
      params: s.p,
      body: {
        fromShiftId: shift.id,
        summary: 'Two open matters',
        items: [
          { title: 'Custom set due tomorrow', taskId, priority: 'high' },
          { title: 'Renewal check', operationId: op.id },
        ],
      },
    });
    expect(h.items).toHaveLength(2);
    const taskItem = h.items.find((i) => i.task?.id === taskId)!;
    const opItem = h.items.find((i) => i.operation?.id === op.id)!;
    // The same operation cannot be in two open items.
    const dupItem = await s.manager.client.attempt(E.addHandoverItem, { params: { ...s.p, handoverId: h.id }, body: { title: 'Again', operationId: op.id } });
    expect(dupItem.status).toBe(409);
    const submitted = await s.manager.client.call(E.submitHandover, { params: { ...s.p, handoverId: h.id }, body: {} }, { ifMatch: h.rowVersion });
    expect(submitted.recipient?.membershipId).toBe(s.manager2.membershipId);
    expect(submitted.toShift?.id).toBe(next.id);
    expect((await notificationsFor(s.ws.workspaceId, s.manager2.membershipId)).some((n) => n.title === 'Handover waiting for you')).toBe(true);
    // Report can now be submitted with the handover.
    const r = await saveDraft(s, shift, { summary: 'Shift done', handoverId: h.id });
    const rep = await s.manager.client.call(E.submitReport, { params: { ...s.p, shiftId: shift.id }, body: { reportVersionId: r.currentVersion.id } }, { ifMatch: r.currentVersion.rowVersion });
    expect(rep.state).toBe('submitted');
    // Next member cannot start without acknowledging (or explaining).
    clock.set(new Date(new Date(next.scheduledStart).getTime() - 5 * MIN).toISOString());
    const blocked = await s.manager2.client.attempt(E.startShift, { params: { ...s.p, shiftId: next.id }, body: {} }, { ifMatch: next.rowVersion });
    expect(blocked.status).toBe(422);
    const [taskBefore] = await db().select().from(tasks).where(eq(tasks.id, taskId));
    const ack = await s.manager2.client.call(E.acknowledgeHandover, { params: { ...s.p, handoverId: h.id }, body: { acceptedItemIds: [taskItem.id] } }, { ifMatch: submitted.rowVersion });
    expect(ack.state).toBe('acknowledged');
    expect(ack.acknowledgedBy?.membershipId).toBe(s.manager2.membershipId);
    expect(ack.items.find((i) => i.id === taskItem.id)?.state).toBe('accepted');
    expect(ack.items.find((i) => i.id === opItem.id)?.state).toBe('open');
    // T094: nothing was completed or cloned.
    const [taskAfter] = await db().select().from(tasks).where(eq(tasks.id, taskId));
    expect(taskAfter!.status).toBe(taskBefore!.status);
    expect(await db().select().from(tasks).where(eq(tasks.workspaceId, s.ws.workspaceId))).toHaveLength(1);
    const opAfter = await s.owner.call(E.getOperation, { params: { ...s.p, operationId: op.id } });
    expect(opAfter.status).toBe('open');
    expect(ack.items.every((i) => i.state !== 'resolved')).toBe(true);
    // The not-accepted item stays visible to the supervisor.
    const box = await s.supervisor.client.call(E.listHandovers, { params: s.p, query: { box: 'unacknowledged' } });
    expect(box.items.map((i) => i.id)).toContain(h.id);
    const start = await s.manager2.client.call(E.startShift, { params: { ...s.p, shiftId: next.id }, body: { handoverAcknowledgementId: h.id } }, { ifMatch: next.rowVersion });
    expect(start.state).toBe('active');
    expect(start.acknowledgedHandoverId).toBe(h.id);
    // Converting an item creates exactly one task linked by id.
    const conv = await s.manager2.client.call(E.convertHandoverItem, { params: { ...s.p, itemId: opItem.id }, body: {} }, { ifMatch: ack.items.find((i) => i.id === opItem.id)!.rowVersion });
    const converted = conv.items.find((i) => i.id === opItem.id)!;
    expect(converted.task).not.toBeNull();
    const again = await s.manager2.client.attempt(E.convertHandoverItem, { params: { ...s.p, itemId: opItem.id }, body: {} }, { ifMatch: converted.rowVersion });
    expect(again.status).toBe(409);
    const items = await db().select().from(handoverItems).where(eq(handoverItems.handoverId, h.id));
    expect(items).toHaveLength(2);
  });

  it('without a next shift the recipient is the supervisor; starting with a reason notifies the supervisor', async () => {
    const s = await ofmSetup();
    const { shift } = await workShift(s, 'manager', 1, 3);
    const h = await s.manager.client.call(E.createHandover, { params: s.p, body: { fromShiftId: shift.id, summary: 'One matter', items: [{ title: 'Follow up on refund question' }] } });
    const sub = await s.manager.client.call(E.submitHandover, { params: { ...s.p, handoverId: h.id }, body: {} }, { ifMatch: h.rowVersion });
    expect(sub.recipient?.membershipId).toBe(s.supervisor.membershipId);
    expect(sub.toShift).toBeNull();
    // Supervisor re-routes it to manager2, who starts a shift without acknowledging but with a reason.
    const rerouted = await s.supervisor.client.call(E.assignHandoverRecipient, { params: { ...s.p, handoverId: h.id }, body: { recipientMembershipId: s.manager2.membershipId, reason: 'Covers tomorrow' } }, { ifMatch: sub.rowVersion });
    expect(rerouted.recipient?.membershipId).toBe(s.manager2.membershipId);
    const next = await s.schedule(s.manager2.membershipId, 4, 6);
    mutableClock(next.scheduledStart);
    const started = await s.manager2.client.call(E.startShift, { params: { ...s.p, shiftId: next.id }, body: { noHandoverReason: 'Handover arrived after I planned the day' } }, { ifMatch: next.rowVersion });
    expect(started.noHandoverReason).toMatch(/Handover arrived/);
    expect((await notificationsFor(s.ws.workspaceId, s.supervisor.membershipId)).some((n) => n.eventKey === `handover.unacknowledged:${h.id}`)).toBe(true);
    // Only the recipient acknowledges.
    const notRecipient = await s.manager.client.attempt(E.acknowledgeHandover, { params: { ...s.p, handoverId: h.id }, body: {} }, { ifMatch: rerouted.rowVersion });
    expect(notRecipient.status).toBe(403);
    void and;
  });
});
