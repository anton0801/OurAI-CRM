import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { newIdempotencyKey } from '@castlane/api-client';
import { characterEndpoints as C, lookupEndpoints } from '@castlane/api-contracts';
import { characterVersions, contentCharacters, contentItems, notifications, reviews } from '@castlane/database';
import { newId } from '@castlane/domain';
import { addMember, assignToProject, clientFor, createProject, sessionFor } from '../../support';
import { baseSetup, db, insertContent, insertImageAsset } from '../accounts/support';

const profile = { appearance: 'Auburn hair, green eyes, freckles', personality: 'Warm, curious', adultAgeDeclaration: { declared: true, statedAge: 24 } };

describe('characters', () => {
  it('approved snapshots never change; a new approved version flags dependent content (T025)', async () => {
    const { ws, owner, project, W } = await baseSetup();
    const producer = await addMember(db(), ws, { roleKey: 'producer', scopeType: 'assigned_projects' });
    await assignToProject(db(), ws, project.id, producer.membershipId);
    const prodC = await clientFor(await sessionFor(db(), producer.userId));
    const img = await insertImageAsset(ws, { projectId: project.id });
    let c = await prodC.call(C.create, { params: { ...W, projectId: project.id }, body: { name: 'Emma', role: 'Lead', profile, prompts: [{ title: 'Portrait', text: 'soft light, 85mm' }], referenceAssetVersionIds: [img.versionId] } });
    expect(c.isPrimary).toBe(true); // first character of a Model project
    expect(c.open?.state).toBe('draft');
    expect(c.open?.references).toHaveLength(1);
    const v1 = c.open!;
    c = await prodC.call(C.submitVersion, { params: { ...W, versionId: v1.id }, body: {} }, { ifMatch: v1.rowVersion });
    const reviewId = c.open!.pendingReview!.id;
    // The project owner is asked to review.
    const asked = await db().select().from(notifications).where(and(eq(notifications.recipientMembershipId, ws.owner.membershipId), eq(notifications.eventType, 'character.review_requested')));
    expect(asked).toHaveLength(1);
    // Producers cannot approve (no characters.approve).
    expect((await prodC.attempt(C.approveVersion, { params: { ...W, versionId: v1.id }, body: { reviewId } }, { ifMatch: c.open!.rowVersion })).status).toBe(403);
    c = await owner.call(C.approveVersion, { params: { ...W, versionId: v1.id }, body: { reviewId } }, { ifMatch: c.open!.rowVersion });
    expect(c.approved?.versionNo).toBe(1);
    expect(c.open).toBeNull();

    // Content uses version 1.
    const contentId = await insertContent(ws, project.id);
    await db().insert(contentCharacters).values({ id: newId(), workspaceId: ws.workspaceId, contentItemId: contentId, characterVersionId: v1.id });

    // The approved version is frozen (API and database).
    expect((await prodC.attempt(C.updateVersion, { params: { ...W, versionId: v1.id }, body: { profile: { appearance: 'Changed' } } }, { ifMatch: c.approved!.rowVersion })).status).toBe(409);
    await expect(db().update(characterVersions).set({ profile: { appearance: 'hack' } }).where(eq(characterVersions.id, v1.id))).rejects.toThrow();

    c = await prodC.call(C.newVersion, { params: { ...W, characterId: c.id }, body: { changeNote: 'New hair colour' } });
    const v2 = c.open!;
    expect(v2.versionNo).toBe(2);
    expect(v2.profile.appearance).toBe(profile.appearance);
    // Only one open version at a time.
    expect((await prodC.attempt(C.newVersion, { params: { ...W, characterId: c.id }, body: {} })).status).toBe(409);
    c = await prodC.call(C.updateVersion, { params: { ...W, versionId: v2.id }, body: { profile: { ...profile, appearance: 'Platinum hair, green eyes' } } }, { ifMatch: v2.rowVersion });
    c = await prodC.call(C.submitVersion, { params: { ...W, versionId: v2.id }, body: { reviewerMembershipId: ws.owner.membershipId } }, { ifMatch: c.open!.rowVersion });
    c = await owner.call(C.approveVersion, { params: { ...W, versionId: v2.id }, body: { reviewId: c.open!.pendingReview!.id, note: 'Looks right' } }, { ifMatch: c.open!.rowVersion });
    expect(c.approved?.versionNo).toBe(2);
    expect(c.flaggedContentCount).toBe(1);

    const [old] = await db().select().from(characterVersions).where(eq(characterVersions.id, v1.id));
    expect(old!.state).toBe('superseded');
    expect(old!.profile.appearance).toBe(profile.appearance);
    const [content] = await db().select().from(contentItems).where(eq(contentItems.id, contentId));
    expect(content!.needsConsistencyReview).toBe(true);
    const affected = await owner.call(C.affectedContent, { params: { ...W, characterId: c.id } });
    expect(affected.items).toEqual([expect.objectContaining({ id: contentId, needsConsistencyReview: true, characterVersionNo: 1 })]);
  });

  it('rejects secrets in prompt fields and requires the adult declaration for OFM projects', async () => {
    const { ws, owner, W } = await baseSetup();
    const ofm = await createProject(db(), ws, { name: 'OFM Model', type: 'model', ofmEnabled: true });
    const secret = await owner.attempt(C.create, {
      params: { ...W, projectId: ofm.id },
      body: { name: 'Mia', prompts: [{ title: 'Base', text: `use key ${'sk' + '-proj-'}abcdefghijklmnopqrstuvwxyz0123` }] },
    });
    expect(secret.status).toBe(422);
    expect((secret.error as unknown as { fieldErrors: { field: string }[] }).fieldErrors[0]!.field).toBe('prompts.0.text');
    const tools = await owner.attempt(C.create, { params: { ...W, projectId: ofm.id }, body: { name: 'Mia', profile: { toolsSettings: 'api_key: abcdef1234567890XYZ' } } });
    expect(tools.status).toBe(422);

    let c = await owner.call(C.create, { params: { ...W, projectId: ofm.id }, body: { name: 'Mia', profile: { appearance: 'Dark hair' } } });
    const noDecl = await owner.attempt(C.submitVersion, { params: { ...W, versionId: c.open!.id }, body: {} }, { ifMatch: c.open!.rowVersion });
    expect(noDecl.status).toBe(422);
    const underage = await owner.attempt(C.updateVersion, { params: { ...W, versionId: c.open!.id }, body: { profile: { adultAgeDeclaration: { declared: true, statedAge: 16 } } } }, { ifMatch: c.open!.rowVersion });
    expect(underage.status).toBe(422);
    c = await owner.call(C.updateVersion, { params: { ...W, versionId: c.open!.id }, body: { profile: { appearance: 'Dark hair', adultAgeDeclaration: { declared: true, statedAge: 25 } } } }, { ifMatch: c.open!.rowVersion });
    c = await owner.call(C.submitVersion, { params: { ...W, versionId: c.open!.id }, body: {} }, { ifMatch: c.open!.rowVersion });
    expect(c.open?.state).toBe('submitted');
    // The author cannot approve their own submission (self-review prohibited by default).
    const self = await owner.attempt(C.approveVersion, { params: { ...W, versionId: c.open!.id }, body: { reviewId: c.open!.pendingReview!.id } }, { ifMatch: c.open!.rowVersion });
    expect(self.status).toBe(403);
    // Request changes returns the version to draft; the review keeps its decision.
    const lead = await addMember(db(), ws, { roleKey: 'project_lead', scopeType: 'assigned_projects' });
    await assignToProject(db(), ws, ofm.id, lead.membershipId);
    const leadC = await clientFor(await sessionFor(db(), lead.userId));
    c = await leadC.call(C.requestChanges, { params: { ...W, versionId: c.open!.id }, body: { reviewId: c.open!.pendingReview!.id, summary: 'Add voice description' } }, { ifMatch: c.open!.rowVersion });
    expect(c.open?.state).toBe('draft');
    expect(c.open?.lastDecision?.decision).toBe('changes_requested');
    const [review] = await db().select().from(reviews).where(eq(reviews.subjectId, c.id));
    expect(review!.status).toBe('changes_requested');
  });

  it('keeps one primary character per Model project and none for Series', async () => {
    const { ws, owner, project, W } = await baseSetup();
    const a = await owner.call(C.create, { params: { ...W, projectId: project.id }, body: { name: 'Emma' } });
    const b = await owner.call(C.create, { params: { ...W, projectId: project.id }, body: { name: 'Lina' } });
    expect(a.isPrimary).toBe(true);
    expect(b.isPrimary).toBe(false);
    const bPrimary = await owner.call(C.setPrimary, { params: { ...W, characterId: b.id }, body: { primary: true } }, { ifMatch: b.rowVersion });
    expect(bPrimary.isPrimary).toBe(true);
    const list = await owner.call(C.list, { params: { ...W, projectId: project.id }, query: {} });
    expect(list.filter((x) => x.isPrimary).map((x) => x.id)).toEqual([b.id]);
    const series = await createProject(db(), ws, { name: 'Night Shift', type: 'series' });
    const s = await owner.attempt(C.create, { params: { ...W, projectId: series.id }, body: { name: 'Detective', isPrimary: true } });
    expect(s.status).toBe(422);
  });

  it('is scoped to the project: 404 outside scope, 403 without write, idempotent create', async () => {
    const { ws, owner, project, W } = await baseSetup();
    const other = await createProject(db(), ws, { name: 'Other', type: 'influencer' });
    const key = newIdempotencyKey();
    const c1 = await owner.call(C.create, { params: { ...W, projectId: other.id }, body: { name: 'Zoe' } }, { idempotencyKey: key });
    const c2 = await owner.call(C.create, { params: { ...W, projectId: other.id }, body: { name: 'Zoe' } }, { idempotencyKey: key });
    expect(c2.id).toBe(c1.id);
    const creator = await addMember(db(), ws, { roleKey: 'creator', scopeType: 'assigned_projects' });
    await assignToProject(db(), ws, project.id, creator.membershipId);
    const cc = await clientFor(await sessionFor(db(), creator.userId));
    expect((await cc.attempt(C.get, { params: { ...W, characterId: c1.id } })).status).toBe(404);
    expect((await cc.attempt(C.list, { params: { ...W, projectId: other.id }, query: {} })).status).toBe(404);
    const mine = await owner.call(C.create, { params: { ...W, projectId: project.id }, body: { name: 'Emma' } });
    expect((await cc.call(C.get, { params: { ...W, characterId: mine.id } })).permissions.write).toBe(false);
    expect((await cc.attempt(C.update, { params: { ...W, characterId: mine.id }, body: { name: 'Hacked' } }, { ifMatch: mine.rowVersion })).status).toBe(403);
    const lookup = await cc.call(lookupEndpoints.search, { params: { ...W, type: 'character' }, query: {} });
    expect(lookup.items.map((i) => i.id)).toEqual([mine.id]);
    const stale = await owner.attempt(C.update, { params: { ...W, characterId: mine.id }, body: { name: 'Emma R' } }, { ifMatch: mine.rowVersion + 5 });
    expect(stale.status).toBe(412);
  });
});
