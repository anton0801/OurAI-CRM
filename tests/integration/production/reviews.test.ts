import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { commentEndpoints } from '@castlane/api-contracts';
import { assertContentVersionPlaceable, contentVersionPlacement } from '@castlane/application';
import { auditEvents, contentVersions, notifications, publications, reviewDecisions, tasks } from '@castlane/database';
import { newId } from '@castlane/domain';
import { createAccount, runQueuedJobs } from '../../support';
import {
  C,
  R,
  V,
  contentInProduction,
  contentInReview,
  db,
  getContent,
  member,
  move,
  prodFixture,
  review,
  setPolicy,
  submit,
  uploadPng,
  uploadVideo,
  versionWithFile,
} from './helpers';

const approve = async (c: Awaited<ReturnType<typeof member>>['client'], f: Awaited<ReturnType<typeof prodFixture>>, reviewId: string, body: { versionId: string; decisionNote?: string; selfReviewException?: { reason: string } }, ifMatch?: number) => {
  const cur = ifMatch ?? (await review(c, f, reviewId)).rowVersion;
  return c.attempt(R.approve, { params: { ...f.params, reviewId }, body }, { ifMatch: cur });
};

describe('versions (§10.3)', () => {
  it('Submit is blocked while a file is still being checked, then allowed once Available (T038)', async () => {
    const f = await prodFixture();
    const creator = await member(f, 'creator', { projects: [f.projectId] });
    const lead = await member(f, 'project_lead', { projects: [f.projectId] });
    const c = await contentInProduction(f.owner, f, { ownerMembershipId: creator.membershipId, reviewerMembershipId: lead.membershipId });
    const up = await uploadPng(creator.client, f, { process: false });
    const v = await creator.client.call(V.create, { params: { ...f.params, contentId: c.id }, body: { note: 'First cut' } });
    expect(v.versionNo).toBe(1);
    expect(v.state).toBe('draft');
    const attached = await creator.client.call(V.attachFile, { params: { ...f.params, contentId: c.id, versionId: v.id }, body: { slot: 'main_image', assetVersionId: up.assetVersionId } });
    expect(attached.files[0]?.status).toBe('checking');
    const ticked = await creator.client.call(V.update, { params: { ...f.params, contentId: c.id, versionId: v.id }, body: { checklist: attached.checklist.map((i) => ({ ...i, done: true })) } }, { ifMatch: attached.rowVersion });
    expect(ticked.submitMissing.map((m) => m.code)).toEqual(['FILE_NOT_AVAILABLE']);
    const blocked = await submit(creator.client, f, c.id, v.id);
    expect(blocked.status).toBe(409);
    expect(String(blocked.error?.message)).toMatch(/still being checked/);
    expect((await getContent(f.owner, f, c.id)).stage).toBe('production');
    await runQueuedJobs(['media.process']);
    const ok = await submit(creator.client, f, c.id, v.id);
    expect(ok.status).toBe(200);
    const after = await getContent(f.owner, f, c.id);
    expect(after.stage).toBe('review');
    expect(after.currentVersion?.id).toBe(v.id);
    expect(after.approvedVersion).toBeNull();
    expect(after.activeReview?.reviewer?.membershipId).toBe(lead.membershipId);
    // The reviewer is notified once (deterministic event key).
    const n = await db().select().from(notifications).where(and(eq(notifications.recipientMembershipId, lead.membershipId), eq(notifications.eventType, 'review.requested')));
    expect(n.length).toBe(1);
  });

  it('requires the mandatory checklist and required slots; one draft at a time; frozen after submission', async () => {
    const f = await prodFixture();
    const lead = await member(f, 'project_lead', { projects: [f.projectId] });
    const c = await contentInProduction(f.owner, f, { ownerMembershipId: f.ws.owner.membershipId, reviewerMembershipId: lead.membershipId, format: 'short_video' });
    const v = await f.owner.call(V.create, { params: { ...f.params, contentId: c.id }, body: {} });
    const second = await f.owner.attempt(V.create, { params: { ...f.params, contentId: c.id }, body: {} });
    expect(second.status).toBe(409);
    const empty = await submit(f.owner, f, c.id, v.id);
    expect(empty.status).toBe(409);
    const missing = ((empty.error as { details?: { missing?: { code: string }[] } }).details?.missing ?? []).map((m) => m.code);
    expect(missing).toEqual(expect.arrayContaining(['MISSING_DELIVERABLE', 'CHECKLIST_INCOMPLETE']));
    // Template/default checklist items cannot be removed or made optional.
    const cur = await f.owner.call(V.get, { params: { ...f.params, contentId: c.id, versionId: v.id } });
    const removeItem = await f.owner.attempt(V.update, { params: { ...f.params, contentId: c.id, versionId: v.id }, body: { checklist: [] } }, { ifMatch: cur.rowVersion });
    expect(removeItem.status).toBe(422);
    const video = await uploadVideo(f.owner, f, 12_000);
    await f.owner.call(V.attachFile, { params: { ...f.params, contentId: c.id, versionId: v.id }, body: { slot: 'main_video', assetVersionId: video.assetVersionId } });
    const cur2 = await f.owner.call(V.get, { params: { ...f.params, contentId: c.id, versionId: v.id } });
    await f.owner.call(V.update, { params: { ...f.params, contentId: c.id, versionId: v.id }, body: { checklist: [...cur2.checklist.map((i) => ({ ...i, done: true })), { label: 'Extra optional check', done: false, mandatory: false }] } }, { ifMatch: cur2.rowVersion });
    expect((await submit(f.owner, f, c.id, v.id)).status).toBe(200);
    // After submission the version is immutable (application refusal + DB trigger).
    const frozen = await f.owner.attempt(V.attachFile, { params: { ...f.params, contentId: c.id, versionId: v.id }, body: { slot: 'cover', assetVersionId: video.assetVersionId } });
    expect(frozen.status).toBe(409);
    await expect(db().update(contentVersions).set({ briefSnapshot: { summary: 'tampered' } }).where(eq(contentVersions.id, v.id))).rejects.toThrow();
    const detail = await f.owner.call(V.get, { params: { ...f.params, contentId: c.id, versionId: v.id } });
    expect(detail.briefSnapshot?.summary).toBe(c.brief.summary);
    expect(detail.state).toBe('submitted');
  });
});

describe('reviews (S25, S26)', () => {
  it('forbids self-approval; the Owner exception is explicit and audited separately (T039)', async () => {
    const f = await prodFixture();
    const producer = await member(f, 'producer', { projects: [f.projectId] });
    const lead = await member(f, 'project_lead', { projects: [f.projectId] });
    // A lead who submitted cannot approve their own version.
    const own = await contentInReview(lead.client, f, { ownerMembershipId: lead.membershipId, reviewerMembershipId: f.ws.owner.membershipId, creator: f.owner });
    const selfTry = await approve(lead.client, f, own.reviewId, { versionId: own.versionId });
    expect(selfTry.status).toBe(403);
    const withException = await approve(lead.client, f, own.reviewId, { versionId: own.versionId, selfReviewException: { reason: 'Nobody else is available today' } });
    expect(withException.status).toBe(403);
    // Producers hold no approval permission at all.
    expect((await approve(producer.client, f, own.reviewId, { versionId: own.versionId })).status).toBe(403);
    // The Owner may use an explicit, audited exception on their own submission.
    const byOwner = await contentInReview(f.owner, f, { ownerMembershipId: f.ws.owner.membershipId, reviewerMembershipId: lead.membershipId });
    const plain = await approve(f.owner, f, byOwner.reviewId, { versionId: byOwner.versionId });
    expect(plain.status).toBe(403);
    expect((plain.error as { details?: { exceptionAvailable?: boolean } }).details?.exceptionAvailable).toBe(true);
    const excepted = await approve(f.owner, f, byOwner.reviewId, { versionId: byOwner.versionId, selfReviewException: { reason: 'Launch deadline, reviewer on leave' } });
    expect(excepted.status).toBe(200);
    expect(excepted.data?.selfReviewException).toBe(true);
    const [au] = await db().select().from(auditEvents).where(and(eq(auditEvents.entityId, byOwner.contentId), eq(auditEvents.action, 'review.self_review_exception')));
    expect(au).toMatchObject({ reason: 'Launch deadline, reviewer on leave', sensitivity: 'security' });
    // A project policy may allow self-review; it still needs the explicit exception.
    await setPolicy(f.projectId, { allowSelfReview: true });
    const allowed = await contentInReview(lead.client, f, { ownerMembershipId: lead.membershipId, reviewerMembershipId: lead.membershipId, creator: f.owner });
    expect((await approve(lead.client, f, allowed.reviewId, { versionId: allowed.versionId })).status).toBe(403);
    expect((await approve(lead.client, f, allowed.reviewId, { versionId: allowed.versionId, selfReviewException: { reason: 'Policy allows it' } })).status).toBe(200);
  });

  it('unresolved blocking comments block approval until resolved; reviewer can reopen (T040)', async () => {
    const f = await prodFixture();
    const creator = await member(f, 'creator', { projects: [f.projectId] });
    const lead = await member(f, 'project_lead', { projects: [f.projectId] });
    const r = await contentInReview(creator.client, f, { ownerMembershipId: creator.membershipId, reviewerMembershipId: lead.membershipId, creator: f.owner });
    const blocker = await lead.client.call(commentEndpoints.create, { params: f.params, body: { parentType: 'content_version', parentId: r.versionId, body: 'The logo is cut off.', severity: 'blocking', assetVersionId: r.assetVersionId, pointX: '0.9', pointY: '0.1' } });
    expect(blocker.targetVersionId).toBe(r.versionId);
    const studio = await review(lead.client, f, r.reviewId);
    expect(studio.openBlocking).toBe(1);
    expect(studio.approveBlockers.map((b) => b.code)).toEqual(['OPEN_BLOCKERS']);
    expect(studio.permissions.approve).toBe(false);
    const refused = await approve(lead.client, f, r.reviewId, { versionId: r.versionId });
    expect(refused.status).toBe(409);
    expect(String(refused.error?.message)).toMatch(/blocking comment/);
    // The creator claims it fixed (resolve); the reviewer can reopen with a reason.
    const resolved = await creator.client.call(commentEndpoints.resolve, { params: { ...f.params, commentId: blocker.id }, body: { resolutionNote: 'Moved the logo' } }, { ifMatch: blocker.rowVersion });
    const reopened = await lead.client.call(commentEndpoints.reopen, { params: { ...f.params, commentId: blocker.id }, body: { reason: 'Still cut on mobile' } }, { ifMatch: resolved.rowVersion });
    expect((await approve(lead.client, f, r.reviewId, { versionId: r.versionId })).status).toBe(409);
    await lead.client.call(commentEndpoints.resolve, { params: { ...f.params, commentId: blocker.id }, body: {} }, { ifMatch: reopened.rowVersion });
    const ok = await approve(lead.client, f, r.reviewId, { versionId: r.versionId, decisionNote: 'Looks good' });
    expect(ok.status).toBe(200);
    const c = await getContent(f.owner, f, r.contentId);
    expect(c.stage).toBe('approved');
    expect(c.approvedVersion?.id).toBe(r.versionId);
  });

  it('concurrent approve / request changes: one decision, the other 412 or 409 (T041)', async () => {
    const f = await prodFixture();
    const creator = await member(f, 'creator', { projects: [f.projectId] });
    const lead = await member(f, 'project_lead', { projects: [f.projectId] });
    const lead2 = await member(f, 'project_lead', { projects: [f.projectId] });
    const r = await contentInReview(creator.client, f, { ownerMembershipId: creator.membershipId, reviewerMembershipId: lead.membershipId, creator: f.owner });
    await lead2.client.call(commentEndpoints.create, { params: f.params, body: { parentType: 'content_version', parentId: r.versionId, body: 'Colour grade is off', severity: 'issue' } });
    const rv = (await review(lead.client, f, r.reviewId)).rowVersion;
    const [a, b] = await Promise.all([
      lead.client.attempt(R.approve, { params: { ...f.params, reviewId: r.reviewId }, body: { versionId: r.versionId } }, { ifMatch: rv }),
      lead2.client.attempt(R.requestChanges, { params: { ...f.params, reviewId: r.reviewId }, body: { versionId: r.versionId, summary: 'Fix the colour grade' } }, { ifMatch: rv }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses[0]).toBe(200);
    expect([409, 412]).toContain(statuses[1]);
    const decisions = await db().select().from(reviewDecisions).where(eq(reviewDecisions.reviewId, r.reviewId));
    expect(decisions.length).toBe(1);
    // With the fresh version the decided review is 409 INVALID_STATE.
    const fresh = await review(lead.client, f, r.reviewId);
    const late = await lead.client.attempt(R.approve, { params: { ...f.params, reviewId: r.reviewId }, body: { versionId: r.versionId } }, { ifMatch: fresh.rowVersion });
    expect(late.status).toBe(409);
  });

  it('approving a version other than the reviewed one never approves the latest (T042)', async () => {
    const f = await prodFixture();
    const creator = await member(f, 'creator', { projects: [f.projectId] });
    const lead = await member(f, 'project_lead', { projects: [f.projectId] });
    const r = await contentInReview(creator.client, f, { ownerMembershipId: creator.membershipId, reviewerMembershipId: lead.membershipId, creator: f.owner });
    const wrong = await approve(lead.client, f, r.reviewId, { versionId: newId() });
    expect(wrong.status).toBe(409);
    const c = await getContent(f.owner, f, r.contentId);
    expect(c.stage).toBe('review');
    expect(c.approvedVersion).toBeNull();
    // Changes requested need a summary plus a comment or an explanation.
    const noExplanation = await lead.client.attempt(R.requestChanges, { params: { ...f.params, reviewId: r.reviewId }, body: { versionId: r.versionId, summary: 'Needs work' } }, { ifMatch: (await review(lead.client, f, r.reviewId)).rowVersion });
    expect(noExplanation.status).toBe(422);
    expect(noExplanation.code).toBe('VALIDATION_FAILED');
    const requested = await lead.client.call(R.requestChanges, { params: { ...f.params, reviewId: r.reviewId }, body: { versionId: r.versionId, summary: 'Needs work', explanation: 'Crop tighter on the face and brighten the shadows.' } }, { ifMatch: (await review(lead.client, f, r.reviewId)).rowVersion });
    expect(requested.status).toBe('changes_requested');
    const after = await getContent(f.owner, f, r.contentId);
    expect(after.stage).toBe('changes_requested');
    const n = await db().select().from(notifications).where(and(eq(notifications.recipientMembershipId, creator.membershipId), eq(notifications.eventType, 'review.changes_requested')));
    expect(n.length).toBe(1);
    // The author uploads a new version and submits again: v2 gets a new round, v1's review stays.
    const up = await uploadPng(creator.client, f, { width: 640 });
    const v2 = await versionWithFile(creator.client, f, r.contentId, up.assetVersionId);
    expect(v2.versionNo).toBe(2);
    expect((await submit(creator.client, f, r.contentId, v2.id)).status).toBe(200);
    const again = await getContent(f.owner, f, r.contentId);
    expect(again.stage).toBe('review');
    expect(again.activeReview?.versionId).toBe(v2.id);
    expect(again.activeReview?.roundNo).toBe(2);
    // The old review cannot approve the new version implicitly.
    const oldReview = await approve(lead.client, f, r.reviewId, { versionId: v2.id });
    expect(oldReview.status).toBe(409);
  });

  it('a new revision after approval keeps the approved version pinned; the new version needs review (T043)', async () => {
    const f = await prodFixture();
    const creator = await member(f, 'creator', { projects: [f.projectId] });
    const lead = await member(f, 'project_lead', { projects: [f.projectId] });
    const r = await contentInReview(creator.client, f, { ownerMembershipId: creator.membershipId, reviewerMembershipId: lead.membershipId, creator: f.owner });
    expect((await approve(lead.client, f, r.reviewId, { versionId: r.versionId })).status).toBe(200);
    const accountId = await createAccount(db(), f.ws, { projectId: f.projectId });
    const pubId = newId();
    await db().insert(publications).values({ id: pubId, workspaceId: f.ws.workspaceId, contentItemId: r.contentId, contentVersionId: r.versionId, accountId, projectId: f.projectId, ownerMembershipId: f.ws.owner.membershipId, status: 'published', actualPublishedAt: new Date() });
    // Creators cannot upload a new version into approved content without a New Revision.
    expect((await creator.client.attempt(V.create, { params: { ...f.params, contentId: r.contentId }, body: {} })).status).toBe(409);
    const noReason = await move(lead.client, f, r.contentId, 'production');
    expect(noReason.status).toBe(422);
    expect((await move(lead.client, f, r.contentId, 'production', 'Caption typo found')).ok).toBe(true);
    const up = await uploadPng(creator.client, f, { width: 700 });
    const v2 = await versionWithFile(creator.client, f, r.contentId, up.assetVersionId);
    expect((await submit(creator.client, f, r.contentId, v2.id)).status).toBe(200);
    const c = await getContent(f.owner, f, r.contentId);
    expect(c.currentVersion?.id).toBe(v2.id);
    expect(c.approvedVersion?.id).toBe(r.versionId);
    expect(c.newerVersionAwaitingReview).toBe(true);
    const [pub] = await db().select().from(publications).where(eq(publications.id, pubId));
    expect(pub!.contentVersionId).toBe(r.versionId);
    expect((await contentVersionPlacement(db(), f.ws.workspaceId, v2.id)).placeable).toBe(false);
    expect((await contentVersionPlacement(db(), f.ws.workspaceId, r.versionId)).placeable).toBe(true);
    const versions = await f.owner.call(V.list, { params: { ...f.params, contentId: r.contentId } });
    expect(versions.map((v) => [v.versionNo, v.state, v.isLatest, v.isApproved])).toEqual([
      [2, 'submitted', true, false],
      [1, 'approved', false, true],
    ]);
  });

  it('revoking approval blocks new placements and keeps published history with a flag and a check task (T044)', async () => {
    const f = await prodFixture();
    const creator = await member(f, 'creator', { projects: [f.projectId] });
    const lead = await member(f, 'project_lead', { projects: [f.projectId] });
    const r = await contentInReview(creator.client, f, { ownerMembershipId: creator.membershipId, reviewerMembershipId: lead.membershipId, creator: f.owner });
    await approve(lead.client, f, r.reviewId, { versionId: r.versionId });
    const accountId = await createAccount(db(), f.ws, { projectId: f.projectId });
    const published = newId();
    const scheduled = newId();
    await db().insert(publications).values([
      { id: published, workspaceId: f.ws.workspaceId, contentItemId: r.contentId, contentVersionId: r.versionId, accountId, projectId: f.projectId, ownerMembershipId: f.ws.owner.membershipId, status: 'published', actualPublishedAt: new Date() },
      { id: scheduled, workspaceId: f.ws.workspaceId, contentItemId: r.contentId, contentVersionId: r.versionId, accountId, projectId: f.projectId, ownerMembershipId: f.ws.owner.membershipId, status: 'scheduled', scheduledAt: new Date(Date.now() + 86_400_000) },
    ]);
    const creatorTry = await creator.client.attempt(R.revoke, { params: { ...f.params, reviewId: r.reviewId }, body: { reason: 'Wrong logo' } }, { ifMatch: (await review(lead.client, f, r.reviewId)).rowVersion });
    expect(creatorTry.status).toBe(403);
    const revoked = await lead.client.call(R.revoke, { params: { ...f.params, reviewId: r.reviewId }, body: { reason: 'Wrong logo version used' } }, { ifMatch: (await review(lead.client, f, r.reviewId)).rowVersion });
    expect(revoked.version.state).toBe('revoked');
    expect(revoked.permissions.revoke).toBe(false);
    const c = await getContent(f.owner, f, r.contentId);
    expect(c.approvedVersion).toBeNull();
    expect(c.stage).toBe('changes_requested');
    await expect(assertContentVersionPlaceable({ app: (await import('@castlane/application')).getAppServices(), actor: { workspaceId: f.ws.workspaceId } } as never, r.versionId)).rejects.toThrow(/revoked/);
    const [p1] = await db().select().from(publications).where(eq(publications.id, published));
    expect(p1).toMatchObject({ status: 'published', approvalRevokedAfterPublication: true, contentVersionId: r.versionId });
    const [p2] = await db().select().from(publications).where(eq(publications.id, scheduled));
    expect(p2!.status).toBe('scheduled');
    const checkTasks = await db().select().from(tasks).where(eq(tasks.contentItemId, r.contentId));
    const pubTasks = await db().select().from(tasks).where(eq(tasks.publicationId, published));
    expect(pubTasks.length).toBe(1);
    expect(pubTasks[0]?.title).toMatch(/Check the external post/);
    expect(checkTasks.length).toBe(0);
    const again = await lead.client.attempt(R.revoke, { params: { ...f.params, reviewId: r.reviewId }, body: { reason: 'Twice' } }, { ifMatch: revoked.rowVersion });
    expect(again.status).toBe(409);
  });

  it('video timecodes are validated against the duration (T045) and image points stay on their version (T046)', async () => {
    const f = await prodFixture();
    const creator = await member(f, 'creator', { projects: [f.projectId] });
    const lead = await member(f, 'project_lead', { projects: [f.projectId] });
    const c = await contentInProduction(f.owner, f, { ownerMembershipId: creator.membershipId, reviewerMembershipId: lead.membershipId, format: 'short_video' });
    const video = await uploadVideo(creator.client, f, 30_000);
    const v1 = await versionWithFile(creator.client, f, c.id, video.assetVersionId, 'main_video');
    const cover = await uploadPng(creator.client, f);
    await creator.client.call(V.attachFile, { params: { ...f.params, contentId: c.id, versionId: v1.id }, body: { slot: 'cover', assetVersionId: cover.assetVersionId } });
    expect((await submit(creator.client, f, c.id, v1.id)).status).toBe(200);
    const base = { parentType: 'content_version', parentId: v1.id, body: 'Jump cut here' };
    const outside = await lead.client.attempt(commentEndpoints.create, { params: f.params, body: { ...base, assetVersionId: video.assetVersionId, timecodeMs: 45_000 } });
    expect(outside.status).toBe(422);
    expect((outside.error as { fieldErrors?: { field: string }[] }).fieldErrors?.[0]?.field).toBe('timecodeMs');
    const inside = await lead.client.call(commentEndpoints.create, { params: f.params, body: { ...base, assetVersionId: video.assetVersionId, timecodeMs: 12_500 } });
    expect(inside.timecodeMs).toBe(12_500);
    const pointOnVideo = await lead.client.attempt(commentEndpoints.create, { params: f.params, body: { ...base, assetVersionId: video.assetVersionId, pointX: '0.5', pointY: '0.5' } });
    expect(pointOnVideo.status).toBe(422);
    const point = await lead.client.call(commentEndpoints.create, { params: f.params, body: { ...base, body: 'Crop the cover', assetVersionId: cover.assetVersionId, pointX: '0.25', pointY: '0.75' } });
    const otherVersionFile = await lead.client.attempt(commentEndpoints.create, { params: f.params, body: { ...base, assetVersionId: newId(), timecodeMs: 1 } });
    expect(otherVersionFile.status).toBe(422);
    // Changes requested → v2 with a new cover: the old point stays bound to v1 and its file.
    await lead.client.call(R.requestChanges, { params: { ...f.params, reviewId: (await getContent(f.owner, f, c.id)).activeReview!.id }, body: { versionId: v1.id, summary: 'Fix cover and cut' } }, { ifMatch: (await getContent(f.owner, f, c.id)).activeReview!.rowVersion });
    const newCover = await uploadPng(creator.client, f, { width: 900 });
    const v2 = await creator.client.call(V.create, { params: { ...f.params, contentId: c.id }, body: { copyFilesFromVersionId: v1.id, fixesClaimed: 'New cover, cut fixed' } });
    const replaced = await creator.client.call(V.attachFile, { params: { ...f.params, contentId: c.id, versionId: v2.id }, body: { slot: 'cover', assetVersionId: newCover.assetVersionId } });
    expect(replaced.files.filter((x) => x.slot === 'cover').map((x) => x.assetVersionId)).toEqual([newCover.assetVersionId]);
    const v1Comments = await lead.client.call(commentEndpoints.list, { params: f.params, query: { parentType: 'content_version', parentId: v1.id } });
    const moved = v1Comments.threads.find((t) => t.id === point.id)!;
    expect(moved).toMatchObject({ targetVersionId: v1.id, assetVersionId: cover.assetVersionId, pointX: '0.25000', pointY: '0.75000' });
    const v2Comments = await lead.client.call(commentEndpoints.list, { params: f.params, query: { parentType: 'content_version', parentId: v2.id } });
    expect(v2Comments.threads).toEqual([]);
    // A comment cannot claim another version.
    const cross = await lead.client.attempt(commentEndpoints.create, { params: f.params, body: { ...base, parentId: v2.id, targetVersionId: v1.id } });
    expect(cross.status).toBe(422);
    void inside;
  });

  it('two-step policy: Content Quality approval opens Release Approval; policy changes are detected on submit', async () => {
    const f = await prodFixture();
    await setPolicy(f.projectId, { contentQualityStep: true, releaseApprovalStep: true });
    const creator = await member(f, 'creator', { projects: [f.projectId] });
    const lead = await member(f, 'project_lead', { projects: [f.projectId] });
    const lead2 = await member(f, 'project_lead', { projects: [f.projectId] });
    const content = await contentInProduction(f.owner, f, { ownerMembershipId: creator.membershipId, reviewerMembershipId: lead.membershipId });
    const up = await uploadPng(creator.client, f);
    const v = await versionWithFile(creator.client, f, content.id, up.assetVersionId);
    const stale = await submit(creator.client, f, content.id, v.id, { reviewPolicyVersion: 'p00000000' });
    expect(stale.status).toBe(409);
    const detail = await getContent(creator.client, f, content.id);
    expect(detail.reviewPolicy.steps).toEqual(['content_quality', 'release_approval']);
    expect((await submit(creator.client, f, content.id, v.id, { reviewPolicyVersion: detail.reviewPolicy.version })).status).toBe(200);
    const step1 = (await getContent(f.owner, f, content.id)).activeReview!;
    expect(step1.stepKind).toBe('content_quality');
    await approve(lead.client, f, step1.id, { versionId: v.id });
    const mid = await getContent(f.owner, f, content.id);
    expect(mid.stage).toBe('review');
    expect(mid.activeReview?.stepKind).toBe('release_approval');
    expect(mid.approvedVersion).toBeNull();
    const step2 = mid.activeReview!;
    // The release reviewer is someone other than the quality reviewer; lead2 decides.
    expect(step2.reviewer?.membershipId ?? null).not.toBe(lead.membershipId);
    expect((await approve(lead2.client, f, step2.id, { versionId: v.id })).status).toBe(200);
    const done = await getContent(f.owner, f, content.id);
    expect(done.stage).toBe('approved');
    const round = await f.owner.call(V.get, { params: { ...f.params, contentId: content.id, versionId: v.id } });
    expect(round.reviews.map((x) => [x.stepKind, x.status])).toEqual([
      ['content_quality', 'approved'],
      ['release_approval', 'approved'],
    ]);
  });

  it('review queue: Assigned to Me / All Permitted, filters, scope isolation, assign reviewer', async () => {
    const f = await prodFixture();
    const creator = await member(f, 'creator', { projects: [f.projectId] });
    const lead = await member(f, 'project_lead', { projects: [f.projectId] });
    const lead2 = await member(f, 'project_lead', { projects: [f.projectId] });
    const outsider = await member(f, 'project_lead', { projects: [f.otherProjectId] });
    const r = await contentInReview(creator.client, f, { ownerMembershipId: creator.membershipId, reviewerMembershipId: lead.membershipId, creator: f.owner });
    const mine = await lead.client.call(R.list, { params: f.params, query: { scope: 'assigned' } });
    expect(mine.items.map((i) => i.id)).toEqual([r.reviewId]);
    expect(mine.items[0]).toMatchObject({ targetType: 'content_version', versionNo: 1, roundNo: 1, openBlocking: 0, permissions: { decide: true, assign: true } });
    expect(mine.items[0]?.thumbnailUrl).toMatch(/thumbnail/);
    expect((await lead2.client.call(R.list, { params: f.params, query: { scope: 'assigned' } })).items).toEqual([]);
    expect((await lead2.client.call(R.list, { params: f.params, query: { scope: 'all' } })).items.length).toBe(1);
    expect((await outsider.client.call(R.list, { params: f.params, query: { scope: 'all' } })).items).toEqual([]);
    expect((await outsider.client.attempt(R.get, { params: { ...f.params, reviewId: r.reviewId } })).status).toBe(404);
    expect((await lead.client.call(R.list, { params: f.params, query: { scope: 'all', waitingHoursMin: 48 } })).items).toEqual([]);
    expect((await lead.client.call(R.list, { params: f.params, query: { scope: 'all', format: ['short_video'] } })).items).toEqual([]);
    // Assign Reviewer: eligible only; the author never.
    const cur = await review(lead.client, f, r.reviewId);
    const toAuthor = await lead.client.attempt(R.assign, { params: { ...f.params, reviewId: r.reviewId }, body: { reviewerMembershipId: creator.membershipId } }, { ifMatch: cur.rowVersion });
    expect(toAuthor.status).toBe(422);
    const toOutsider = await lead.client.attempt(R.assign, { params: { ...f.params, reviewId: r.reviewId }, body: { reviewerMembershipId: outsider.membershipId } }, { ifMatch: cur.rowVersion });
    expect(toOutsider.status).toBe(422);
    const reassigned = await lead.client.call(R.assign, { params: { ...f.params, reviewId: r.reviewId }, body: { reviewerMembershipId: lead2.membershipId } }, { ifMatch: cur.rowVersion });
    expect(reassigned.reviewer?.membershipId).toBe(lead2.membershipId);
    expect((await lead2.client.call(R.list, { params: f.params, query: { scope: 'assigned' } })).items.length).toBe(1);
    const viewer = await member(f, 'viewer');
    expect((await viewer.client.call(R.list, { params: f.params, query: { scope: 'all' } })).items.length).toBe(1);
    const contractor = await member(f, 'contractor');
    expect((await contractor.client.attempt(R.list, { params: f.params, query: { scope: 'all' } })).status).toBe(403);
    void C;
  });

  it('version links resolve to their content and review within scope; drafts have no review; outsiders get 404', async () => {
    const f = await prodFixture();
    const creator = await member(f, 'creator', { projects: [f.projectId] });
    const lead = await member(f, 'project_lead', { projects: [f.projectId] });
    const outsider = await member(f, 'project_lead', { projects: [f.otherProjectId] });
    const r = await contentInReview(creator.client, f, { ownerMembershipId: creator.membershipId, reviewerMembershipId: lead.membershipId, creator: f.owner });
    const resolved = await lead.client.call(V.resolve, { params: { ...f.params, versionId: r.versionId } });
    expect(resolved).toEqual({ contentId: r.contentId, versionNo: 1, reviewId: r.reviewId });
    expect((await outsider.client.attempt(V.resolve, { params: { ...f.params, versionId: r.versionId } })).status).toBe(404);
    expect((await lead.client.attempt(V.resolve, { params: { ...f.params, versionId: newId() } })).status).toBe(404);
    // After changes are requested, the next draft resolves without a review.
    await lead.client.call(R.requestChanges, { params: { ...f.params, reviewId: r.reviewId }, body: { versionId: r.versionId, summary: 'Brighter please', explanation: 'Lift the shadows.' } }, { ifMatch: (await review(lead.client, f, r.reviewId)).rowVersion });
    const draft = await creator.client.call(V.create, { params: { ...f.params, contentId: r.contentId }, body: { note: 'Second pass' } });
    expect(await creator.client.call(V.resolve, { params: { ...f.params, versionId: draft.id } })).toEqual({ contentId: r.contentId, versionNo: 2, reviewId: null });
    // The decided review stays reachable from its version, with the decision in the studio history.
    const studio = await review(lead.client, f, r.reviewId);
    expect(studio.status).toBe('changes_requested');
    expect(studio.decisions.map((d) => d.decision)).toEqual(['changes_requested']);
    expect(studio.permissions).toMatchObject({ approve: false, requestChanges: false });
  });
});
