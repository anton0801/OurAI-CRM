import { afterEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { ofmEndpoints as E } from '@castlane/api-contracts';
import { qualityReviews } from '@castlane/database';
import { mutableClock, resetClock } from '../../support';
import { db, insertAsset, ofmSetup } from './helpers';

afterEach(() => resetClock());

const endedShift = async (s: Awaited<ReturnType<typeof ofmSetup>>) => {
  const shift = await s.schedule(s.manager.membershipId, 1, 3);
  const clock = mutableClock(shift.scheduledStart);
  const started = await s.manager.client.call(E.startShift, { params: { ...s.p, shiftId: shift.id }, body: {} }, { ifMatch: shift.rowVersion });
  clock.advance(120);
  return s.manager.client.call(E.endShift, { params: { ...s.p, shiftId: shift.id }, body: {} }, { ifMatch: started.rowVersion });
};

const rubricOf = async (s: Awaited<ReturnType<typeof ofmSetup>>) => (await s.supervisor.client.call(E.listRubrics, { params: s.p })).find((r) => r.state === 'published')!;

describe('Quality reviews (S48, §13.6)', () => {
  it('T100: all criteria Not Applicable → No Score (never 0 or 100)', async () => {
    const s = await ofmSetup();
    const shift = await endedShift(s);
    const rubric = await rubricOf(s);
    const draft = await s.supervisor.client.call(E.createQuality, {
      params: s.p,
      body: { subjectType: 'shift', subjectId: shift.id, rubricVersionId: rubric.id, scores: rubric.criteria.map((c) => ({ key: c.key, score: null })) },
    });
    expect(draft.totalScore).toBeNull();
    const published = await s.supervisor.client.call(E.publishQuality, { params: { ...s.p, reviewId: draft.id } }, { ifMatch: draft.rowVersion });
    expect(published.state).toBe('published');
    expect(published.totalScore).toBeNull();
    expect(published.applicableCriteria).toBe(0);
    const [row] = await db().select().from(qualityReviews).where(eq(qualityReviews.id, draft.id));
    expect(row!.totalScore).toBeNull();
  });

  it('T101: negative scores need evidence before publishing; every criterion must be answered', async () => {
    const s = await ofmSetup();
    const shift = await endedShift(s);
    const rubric = await rubricOf(s);
    const partial = await s.supervisor.client.call(E.createQuality, {
      params: s.p,
      body: { subjectType: 'shift', subjectId: shift.id, rubricVersionId: rubric.id, scores: [{ key: rubric.criteria[0]!.key, score: 4 }] },
    });
    const incomplete = await s.supervisor.client.attempt(E.publishQuality, { params: { ...s.p, reviewId: partial.id } }, { ifMatch: partial.rowVersion });
    expect(incomplete.status).toBe(422);
    const scores = rubric.criteria.map((c, i) => ({ key: c.key, score: i === 0 ? 1 : 4 }));
    const draft = await s.supervisor.client.call(E.updateQuality, { params: { ...s.p, reviewId: partial.id }, body: { scores } }, { ifMatch: partial.rowVersion });
    const blocked = await s.supervisor.client.attempt(E.publishQuality, { params: { ...s.p, reviewId: draft.id } }, { ifMatch: draft.rowVersion });
    expect(blocked.status).toBe(422);
    expect((blocked.error as { fieldErrors: { code: string }[] }).fieldErrors[0]!.code).toBe('EVIDENCE_REQUIRED');
    const evidence = await insertAsset(s.ws.workspaceId, s.project.id);
    const withEvidence = await s.supervisor.client.call(
      E.updateQuality,
      { params: { ...s.p, reviewId: draft.id }, body: { scores: scores.map((x, i) => (i === 0 ? { ...x, evidenceAssetIds: [evidence], note: 'Handover missed the refund request' } : x)) } },
      { ifMatch: draft.rowVersion },
    );
    const published = await s.supervisor.client.call(E.publishQuality, { params: { ...s.p, reviewId: withEvidence.id } }, { ifMatch: withEvidence.rowVersion });
    // (1/4·25 + 4/4·25·3) / 100 × 100 = 81.25
    expect(published.totalScore).toBe('81.25');
    // Frozen after publishing.
    await expect(db().execute(sql`UPDATE quality_reviews SET scores = '[]'::jsonb WHERE id = ${published.id}`)).rejects.toThrow();
  });

  it('reviewers never review themselves; drafts stay private; the subject sees the published review', async () => {
    const s = await ofmSetup();
    const shift = await endedShift(s);
    const rubric = await rubricOf(s);
    // The supervisor reviews; the manager (subject) cannot see the draft.
    const draft = await s.supervisor.client.call(E.createQuality, { params: s.p, body: { subjectType: 'shift', subjectId: shift.id, rubricVersionId: rubric.id } });
    expect((await s.manager.client.attempt(E.getQuality, { params: { ...s.p, reviewId: draft.id } })).status).toBe(404);
    expect((await s.manager.client.call(E.listQuality, { params: s.p, query: { view: 'mine' } })).items).toHaveLength(0);
    // Another manager cannot see it at all.
    expect((await s.manager2.client.attempt(E.getQuality, { params: { ...s.p, reviewId: draft.id } })).status).toBe(404);
    // Owner cannot review the owner's own work; a manager has no quality.write.
    expect((await s.manager.client.attempt(E.createQuality, { params: s.p, body: { subjectType: 'shift', subjectId: shift.id, rubricVersionId: rubric.id } })).status).toBe(403);
    const full = await s.supervisor.client.call(E.updateQuality, { params: { ...s.p, reviewId: draft.id }, body: { scores: rubric.criteria.map((c) => ({ key: c.key, score: 3 })) } }, { ifMatch: draft.rowVersion });
    const pub = await s.supervisor.client.call(E.publishQuality, { params: { ...s.p, reviewId: draft.id } }, { ifMatch: full.rowVersion });
    const mine = await s.manager.client.call(E.listQuality, { params: s.p, query: { view: 'mine' } });
    expect(mine.items.map((i) => i.id)).toEqual([pub.id]);
    const ack = await s.manager.client.call(E.acknowledgeQuality, { params: { ...s.p, reviewId: pub.id }, body: { response: 'Thanks' } }, { ifMatch: pub.rowVersion });
    expect(ack.acknowledgedAt).not.toBeNull();
  });

  it('T102: a dispute keeps the original score and a resolution history; a revision replaces it', async () => {
    const s = await ofmSetup();
    const shift = await endedShift(s);
    const rubric = await rubricOf(s);
    const evidence = await insertAsset(s.ws.workspaceId, s.project.id);
    const draft = await s.supervisor.client.call(E.createQuality, {
      params: s.p,
      body: { subjectType: 'shift', subjectId: shift.id, rubricVersionId: rubric.id, scores: rubric.criteria.map((c, i) => ({ key: c.key, score: i === 0 ? 0 : 2, evidenceAssetIds: i === 0 ? [evidence] : undefined })) },
    });
    const pub = await s.supervisor.client.call(E.publishQuality, { params: { ...s.p, reviewId: draft.id } }, { ifMatch: draft.rowVersion });
    const originalScore = pub.totalScore;
    expect(originalScore).toBe('37.50');
    // Only the subject can dispute.
    expect((await s.supervisor.client.attempt(E.disputeQuality, { params: { ...s.p, reviewId: pub.id }, body: { reason: 'Not me' } }, { ifMatch: pub.rowVersion })).status).toBe(403);
    const disputed = await s.manager.client.call(E.disputeQuality, { params: { ...s.p, reviewId: pub.id }, body: { reason: 'The handover was written in the shared doc' } }, { ifMatch: pub.rowVersion });
    expect(disputed.state).toBe('disputed');
    const disputeId = disputed.disputes[0]!.id;
    const resolved = await s.owner.call(E.resolveDispute, {
      params: { ...s.p, disputeId },
      body: { decision: 'revised', reason: 'Handover found in the shared doc', replacementScores: rubric.criteria.map((c) => ({ key: c.key, score: c.key === rubric.criteria[0]!.key ? 3 : 2 })) },
    });
    expect(resolved.revisionOfId).toBe(pub.id);
    expect(resolved.state).toBe('published');
    expect(resolved.totalScore).toBe('56.25');
    const original = await s.owner.call(E.getQuality, { params: { ...s.p, reviewId: pub.id } });
    expect(original.totalScore).toBe(originalScore);
    expect(original.state).toBe('resolved');
    expect(original.supersededAt).not.toBeNull();
    expect(original.replacedById).toBe(resolved.id);
    expect(original.disputes[0]).toMatchObject({ state: 'resolved', decision: 'revised', replacementReviewId: resolved.id });
    // Resolved dispute cannot be resolved twice.
    const again = await s.owner.attempt(E.resolveDispute, { params: { ...s.p, disputeId }, body: { decision: 'upheld', reason: 'Duplicate click' } });
    expect(again.status).toBe(409);
  });

  it('rubric versions: weights must total 100; publishing retires the previous version', async () => {
    const s = await ofmSetup();
    const bad = await s.owner.attempt(E.createRubricVersion, { params: s.p, body: { name: 'OFM Quality Rubric', rubricKey: 'ofm_default', criteria: [{ key: 'accuracy', label: 'Accuracy', weight: '60' }] } });
    expect(bad.status).toBe(422);
    const v2 = await s.owner.call(E.createRubricVersion, {
      params: s.p,
      body: { name: 'OFM Quality Rubric', rubricKey: 'ofm_default', criteria: [{ key: 'accuracy', label: 'Accuracy', weight: '60' }, { key: 'handover', label: 'Handover', weight: '40' }] },
    });
    expect(v2.versionNo).toBe(2);
    // Project-scoped supervisors cannot manage workspace rubrics.
    expect((await s.supervisor.client.attempt(E.publishRubricVersion, { params: { ...s.p, rubricVersionId: v2.id } }, { ifMatch: v2.rowVersion })).status).toBe(403);
    const published = await s.owner.call(E.publishRubricVersion, { params: { ...s.p, rubricVersionId: v2.id } }, { ifMatch: v2.rowVersion });
    expect(published.state).toBe('published');
    const all = await s.owner.call(E.listRubrics, { params: s.p });
    expect(all.find((r) => r.versionNo === 1)?.state).toBe('retired');
  });
});
