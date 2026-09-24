import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { accountAssignments, contentVersionAssets, contentVersions, projects, publications } from '@castlane/database';
import { newId } from '@castlane/domain';
import { createAccount } from '../../support';
import { C, R, V, contentInReview, db, getContent, member, newContent, prodFixture, review, setPolicy, uploadPng } from './helpers';

type Client = Awaited<ReturnType<typeof member>>['client'];
type Fixture = Awaited<ReturnType<typeof prodFixture>>;

const approve = async (c: Client, f: Fixture, reviewId: string, versionId: string) =>
  c.attempt(R.approve, { params: { ...f.params, reviewId }, body: { versionId } }, { ifMatch: (await review(c, f, reviewId)).rowVersion });
const requestChanges = async (c: Client, f: Fixture, reviewId: string, versionId: string) =>
  c.attempt(R.requestChanges, { params: { ...f.params, reviewId }, body: { versionId, summary: 'Needs work', explanation: 'Brighten the shadows.' } }, { ifMatch: (await review(c, f, reviewId)).rowVersion });
/** The database error behind a failed query (drizzle wraps it). */
const dbError = async (q: PromiseLike<unknown>) => {
  try {
    await q;
    return null;
  } catch (e) {
    return String((e as { cause?: { message?: string } }).cause?.message ?? (e as Error).message);
  }
};
const queueRow = async (c: Client, f: Fixture, reviewId: string) => (await c.call(R.list, { params: f.params, query: { scope: 'all' } })).items.find((i) => i.id === reviewId);

describe('production scope regressions', () => {
  it('only live placements give account-scoped members access to content (trashed/cancelled do not)', async () => {
    const f = await prodFixture();
    const accountId = await createAccount(db(), f.ws, { projectId: f.projectId });
    const pub = await member(f, 'publisher', { scopeType: 'assigned_accounts' });
    await db().insert(accountAssignments).values({ id: newId(), workspaceId: f.ws.workspaceId, accountId, membershipId: pub.membershipId, duty: 'publishing', validFrom: new Date(Date.now() - 1000) });
    const c = await newContent(f.owner, f);
    const placementId = newId();
    await db().insert(publications).values({ id: placementId, workspaceId: f.ws.workspaceId, contentItemId: c.id, accountId, projectId: f.projectId, ownerMembershipId: pub.membershipId, status: 'draft' });
    const get = () => pub.client.attempt(C.get, { params: { ...f.params, contentId: c.id } });
    const listed = async () => (await pub.client.call(C.list, { params: f.params, query: {} })).items.map((i) => i.id);
    expect((await get()).status).toBe(200);
    expect(await listed()).toEqual([c.id]);

    // A cancelled placement is history only: the content is indistinguishable from a missing one.
    await db().update(publications).set({ status: 'cancelled', cancelReason: 'Plan changed' }).where(eq(publications.id, placementId));
    expect((await get()).status).toBe(404);
    expect(await listed()).toEqual([]);

    // A trashed placement grants nothing either, whatever its status.
    await db().update(publications).set({ status: 'draft', deletedAt: new Date() }).where(eq(publications.id, placementId));
    expect((await get()).status).toBe(404);
    expect(await listed()).toEqual([]);

    // Restored to a live placement, access comes back.
    await db().update(publications).set({ deletedAt: null }).where(eq(publications.id, placementId));
    expect((await get()).status).toBe(200);
  });
});

describe('review decisions regressions', () => {
  it('the eligible-reviewer list governs the queue and studio flags and both decisions', async () => {
    const f = await prodFixture();
    const creator = await member(f, 'creator', { projects: [f.projectId] });
    const listed = await member(f, 'project_lead', { projects: [f.projectId] });
    const unlisted = await member(f, 'project_lead', { projects: [f.projectId] });
    const r = await contentInReview(creator.client, f, { ownerMembershipId: creator.membershipId, reviewerMembershipId: listed.membershipId, creator: f.owner });
    await db()
      .update(projects)
      .set({ reviewPolicy: { contentQualityStep: false, releaseApprovalStep: true, allowSelfReview: false, eligibleReviewerMembershipIds: [listed.membershipId] } })
      .where(eq(projects.id, f.projectId));

    // Not on the list: no Approve / Request Changes offered, and the commands refuse.
    expect((await queueRow(unlisted.client, f, r.reviewId))?.permissions.decide).toBe(false);
    const studio = await review(unlisted.client, f, r.reviewId);
    expect(studio.permissions).toMatchObject({ approve: false, requestChanges: false });
    expect(studio.approveBlockers.map((b) => b.code)).toContain('NOT_ELIGIBLE');
    expect((await approve(unlisted.client, f, r.reviewId, r.versionId)).status).toBe(403);
    expect((await requestChanges(unlisted.client, f, r.reviewId, r.versionId)).status).toBe(403);
    expect((await getContent(f.owner, f, r.contentId)).stage).toBe('review');

    // On the list: the flags match what the command accepts.
    expect((await queueRow(listed.client, f, r.reviewId))?.permissions.decide).toBe(true);
    const ok = await review(listed.client, f, r.reviewId);
    expect(ok.permissions).toMatchObject({ approve: true, requestChanges: true });
    expect((await approve(listed.client, f, r.reviewId, r.versionId)).status).toBe(200);
  });

  it('two-step review: the member who approved the first step cannot approve the second', async () => {
    const f = await prodFixture();
    await setPolicy(f.projectId, { contentQualityStep: true, releaseApprovalStep: true });
    const creator = await member(f, 'creator', { projects: [f.projectId] });
    const lead = await member(f, 'project_lead', { projects: [f.projectId] });
    const lead2 = await member(f, 'project_lead', { projects: [f.projectId] });
    const r = await contentInReview(creator.client, f, { ownerMembershipId: creator.membershipId, reviewerMembershipId: lead.membershipId, creator: f.owner });
    expect((await approve(lead.client, f, r.reviewId, r.versionId)).status).toBe(200);
    const step2 = (await getContent(f.owner, f, r.contentId)).activeReview!;
    expect(step2.stepKind).toBe('release_approval');

    const studio = await review(lead.client, f, step2.id);
    expect(studio.permissions.approve).toBe(false);
    expect(studio.approveBlockers.map((b) => b.code)).toContain('EARLIER_STEP');
    const again = await approve(lead.client, f, step2.id, r.versionId);
    expect(again.status).toBe(403);
    expect((again.error as { details?: { earlierStep?: boolean } }).details?.earlierStep).toBe(true);
    // Nor can that member be assigned to the second step.
    const assign = await lead2.client.attempt(R.assign, { params: { ...f.params, reviewId: step2.id }, body: { reviewerMembershipId: lead.membershipId } }, { ifMatch: (await review(lead2.client, f, step2.id)).rowVersion });
    expect(assign.status).toBe(422);
    expect((await getContent(f.owner, f, r.contentId)).approvedVersion).toBeNull();

    // Another eligible member approves the release step.
    expect((await review(lead2.client, f, step2.id)).permissions.approve).toBe(true);
    expect((await approve(lead2.client, f, step2.id, r.versionId)).status).toBe(200);
    expect((await getContent(f.owner, f, r.contentId)).stage).toBe('approved');
  });
});

describe('version immutability in the database', () => {
  it('a submitted version takes no new files and keeps its checklist and note; approval columns still change', async () => {
    const f = await prodFixture();
    const lead = await member(f, 'project_lead', { projects: [f.projectId] });
    const r = await contentInReview(f.owner, f, { ownerMembershipId: f.ws.owner.membershipId, reviewerMembershipId: lead.membershipId });
    const extra = await uploadPng(f.owner, f);
    const now = new Date();
    // Adding a file behind the application's back is refused by the trigger.
    expect(
      await dbError(db().insert(contentVersionAssets).values({ id: newId(), workspaceId: f.ws.workspaceId, contentVersionId: r.versionId, slot: 'cover', assetVersionId: extra.assetVersionId, createdAt: now, updatedAt: now })),
    ).toMatch(/immutable/);
    expect(await dbError(db().update(contentVersions).set({ checklist: [] }).where(eq(contentVersions.id, r.versionId)))).toMatch(/immutable/);
    expect(await dbError(db().update(contentVersions).set({ note: 'rewritten' }).where(eq(contentVersions.id, r.versionId)))).toMatch(/immutable/);
    // A file cannot be moved from a draft into the submitted version either.
    const draft = await f.owner.call(V.create, { params: { ...f.params, contentId: r.contentId }, body: {} });
    await f.owner.call(V.attachFile, { params: { ...f.params, contentId: r.contentId, versionId: draft.id }, body: { slot: 'main_image', assetVersionId: extra.assetVersionId } });
    expect(await dbError(db().update(contentVersionAssets).set({ contentVersionId: r.versionId }).where(eq(contentVersionAssets.contentVersionId, draft.id)))).toMatch(/immutable/);
    // Draft versions stay editable; the approval columns of the submitted one too.
    await db().update(contentVersions).set({ note: 'draft note' }).where(eq(contentVersions.id, draft.id));
    await db().update(contentVersions).set({ approvedAt: now }).where(eq(contentVersions.id, r.versionId));
    const files = await db().select().from(contentVersionAssets).where(eq(contentVersionAssets.contentVersionId, r.versionId));
    expect(files.map((x) => x.slot)).toEqual(['main_image']);
  });
});
