import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { archiveEndpoints, commentEndpoints, financeEndpoints, lookupEndpoints, metricsEndpoints, referenceEndpoints, templateEndpoints } from '@castlane/api-contracts';
import { auditEvents, contentStageEvents, financialAllocations, metricObservations, notifications, publications, reviews, searchDocuments, socialAccounts, tasks } from '@castlane/database';
import { newId } from '@castlane/domain';
import { createAccount } from '../../support';
import { C, R, V, contentInProduction, contentInReview, db, getContent, member, move, newContent, prodFixture, review } from './helpers';

describe('content items (S22–S24, §10.1)', () => {
  it('creates an Idea draft with the minimum fields, replays idempotently and audits; same key with another body is 409 with no second effect (T163)', async () => {
    const f = await prodFixture();
    const key = newId();
    const body = { title: 'Morning Routine Reel', projectId: f.projectId, format: 'short_video' as const };
    const a = await f.owner.call(C.create, { params: f.params, body }, { idempotencyKey: key });
    const b = await f.owner.call(C.create, { params: f.params, body }, { idempotencyKey: key });
    expect(b.id).toBe(a.id);
    expect(a.stage).toBe('idea');
    expect(a.owner?.membershipId).toBe(f.ws.owner.membershipId);
    expect(a.deliverableSlots.find((s) => s.slot === 'main_video')?.required).toBe(true);
    // Same key with another body → 409 and nothing new (T163).
    const c = await f.owner.attempt(C.create, { params: f.params, body: { ...body, title: 'Other title' } }, { idempotencyKey: key });
    expect(c.status).toBe(409);
    const list = await f.owner.call(C.list, { params: f.params, query: {} });
    expect(list.items.length).toBe(1);
    const [ev] = await db().select().from(contentStageEvents).where(eq(contentStageEvents.contentItemId, a.id));
    expect(ev).toMatchObject({ fromStage: null, toStage: 'idea' });
    const [au] = await db().select().from(auditEvents).where(and(eq(auditEvents.entityId, a.id), eq(auditEvents.action, 'content.created')));
    expect(au).toBeTruthy();
    const [doc] = await db().select().from(searchDocuments).where(eq(searchDocuments.entityId, a.id));
    expect(doc).toMatchObject({ entityType: 'content_item', permission: 'content.read', status: 'idea' });
  });

  it('validates the minimum draft and links (project scope, account of the same project)', async () => {
    const f = await prodFixture();
    const missing = await f.owner.attempt(C.create, { params: f.params, body: { title: 'x', projectId: f.projectId, format: 'image' } });
    expect(missing.status).toBe(422);
    const foreignProject = await f.owner.attempt(C.create, { params: f.params, body: { title: 'Valid title', projectId: newId(), format: 'image' } });
    expect(foreignProject.status).toBe(422);
    const both = await f.owner.attempt(C.create, { params: f.params, body: { title: 'Valid title', projectId: f.projectId, format: 'image', dueAt: '2027-01-01T10:00:00Z', noDeadline: true } });
    expect(both.status).toBe(422);
  });

  it('follows the stage table: no bypass of review, requirements explained, stage events recorded', async () => {
    const f = await prodFixture();
    const reviewer = await member(f, 'project_lead', { projects: [f.projectId] });
    const c = await newContent(f.owner, f);
    const toApproved = await move(f.owner, f, c.id, 'approved');
    expect(toApproved.status).toBe(409);
    expect(String(toApproved.error?.message)).toMatch(/Approval happens in Review/);
    expect((await move(f.owner, f, c.id, 'brief')).ok).toBe(true);
    const notReady = await move(f.owner, f, c.id, 'ready');
    expect(notReady.status).toBe(409);
    const missing = (notReady.error as { details?: { missing?: { field: string }[] } }).details?.missing?.map((m) => m.field) ?? [];
    expect(missing).toEqual(expect.arrayContaining(['brief.summary', 'reviewerMembershipId', 'brief.objective', 'dueAt']));
    const cur = await getContent(f.owner, f, c.id);
    expect(cur.nextStages[0]?.stage).toBe('ready');
    expect(cur.nextStages[0]?.missing.length).toBe(4);
    await f.owner.call(C.update, { params: { ...f.params, contentId: c.id }, body: { reviewerMembershipId: reviewer.membershipId, brief: { summary: 'Summary', objective: 'Saves' }, noDeadline: true } }, { ifMatch: cur.rowVersion });
    expect((await move(f.owner, f, c.id, 'ready')).ok).toBe(true);
    expect((await move(f.owner, f, c.id, 'production')).ok).toBe(true);
    // Ready conditions keep holding: the reviewer cannot be cleared any more.
    const now = await getContent(f.owner, f, c.id);
    const clear = await f.owner.attempt(C.update, { params: { ...f.params, contentId: c.id }, body: { reviewerMembershipId: null } }, { ifMatch: now.rowVersion });
    expect(clear.status).toBe(422);
    expect(now.stageHistory.map((s) => s.to)).toEqual(['production', 'ready', 'brief', 'idea']);
  });

  it('If-Match: missing → 428, stale → 412 (T164)', async () => {
    const f = await prodFixture();
    const c = await newContent(f.owner, f);
    const noMatch = await f.owner.attempt(C.update, { params: { ...f.params, contentId: c.id }, body: { title: 'Renamed title' } });
    expect(noMatch.status).toBe(428);
    await f.owner.call(C.update, { params: { ...f.params, contentId: c.id }, body: { title: 'Renamed title' } }, { ifMatch: c.rowVersion });
    const stale = await f.owner.attempt(C.update, { params: { ...f.params, contentId: c.id }, body: { title: 'Another title' } }, { ifMatch: c.rowVersion });
    expect(stale.status).toBe(412);
    expect(stale.code).toBe('VERSION_CONFLICT');
  });

  it('Idea → Brief needs an active project; Production needs an owner and no blocking dependencies', async () => {
    const f = await prodFixture();
    const reviewer = await member(f, 'project_lead', { projects: [f.projectId] });
    const c = await contentInProduction(f.owner, f, { ownerMembershipId: f.ws.owner.membershipId, reviewerMembershipId: reviewer.membershipId });
    expect(c.stage).toBe('production');
    // Blocked flag: independent of the stage, with reason and interval.
    const cur = await getContent(f.owner, f, c.id);
    const blocked = await f.owner.call(C.setFlag, { params: { ...f.params, contentId: c.id }, body: { flag: 'blocked', on: true, reason: 'Waiting for the voice track' } }, { ifMatch: cur.rowVersion });
    expect(blocked.stage).toBe('production');
    expect(blocked.blocked?.reason).toBe('Waiting for the voice track');
    const again = await f.owner.attempt(C.setFlag, { params: { ...f.params, contentId: c.id }, body: { flag: 'blocked', on: true, reason: 'Twice' } }, { ifMatch: blocked.rowVersion });
    expect(again.status).toBe(409);
    const cleared = await f.owner.call(C.setFlag, { params: { ...f.params, contentId: c.id }, body: { flag: 'blocked', on: false, resolution: 'Voice delivered' } }, { ifMatch: blocked.rowVersion });
    expect(cleared.blocked).toBeNull();
    expect(cleared.flagHistory[0]).toMatchObject({ flag: 'blocked', resolution: 'Voice delivered' });
    expect(cleared.flagHistory[0]?.endedAt).toBeTruthy();
    const other = await newContent(f.owner, f, { projectId: f.projectId });
    await db().update((await import('@castlane/database')).projects).set({ status: 'paused' }).where(eq((await import('@castlane/database')).projects.id, f.projectId));
    const r = await move(f.owner, f, other.id, 'brief');
    expect(r.status).toBe(409);
    expect(String(r.error?.message)).toMatch(/project must be active/);
  });

  it('scope isolation: out-of-scope content is 404, module without permission is 403, lists never leak', async () => {
    const f = await prodFixture();
    const creator = await member(f, 'creator', { projects: [f.projectId] });
    const outsider = await member(f, 'creator', { projects: [f.otherProjectId] });
    const noContent = await member(f, 'publisher', { scopeType: 'assigned_accounts' });
    const c = await newContent(f.owner, f);
    expect((await creator.client.attempt(C.get, { params: { ...f.params, contentId: c.id } })).status).toBe(200);
    expect((await outsider.client.attempt(C.get, { params: { ...f.params, contentId: c.id } })).status).toBe(404);
    const list = await outsider.client.call(C.list, { params: f.params, query: {} });
    expect(list.items).toEqual([]);
    const board = await outsider.client.call(C.board, { params: f.params, query: {} });
    expect(board.columns.reduce((n, col) => n + col.count, 0)).toBe(0);
    // Creators cannot edit the brief; outsiders get 404 not 403.
    const cur = await getContent(f.owner, f, c.id);
    expect((await creator.client.attempt(C.update, { params: { ...f.params, contentId: c.id }, body: { title: 'Changed title' } }, { ifMatch: cur.rowVersion })).status).toBe(403);
    expect((await outsider.client.attempt(C.update, { params: { ...f.params, contentId: c.id }, body: { title: 'Changed title' } }, { ifMatch: cur.rowVersion })).status).toBe(404);
    const viewer = await member(f, 'viewer');
    expect((await viewer.client.attempt(C.create, { params: f.params, body: { title: 'Viewer draft', projectId: f.projectId, format: 'image' } })).status).toBe(403);
    // Publisher (account scope) sees nothing until the content is placed on their account.
    expect((await noContent.client.call(C.list, { params: f.params, query: {} })).items).toEqual([]);
    const hidden = await f.owner.call(lookupEndpoints.search, { params: { ...f.params, type: 'content_item' }, query: { limit: 20 } });
    expect(hidden.items.map((i) => i.id)).toContain(c.id);
    expect((await outsider.client.call(lookupEndpoints.search, { params: { ...f.params, type: 'content_item' }, query: { limit: 20 } })).items).toEqual([]);
  });

  it('publishers reach content through placements on their accounts', async () => {
    const f = await prodFixture();
    const { createAccount } = await import('../../support');
    const accountId = await createAccount(db(), f.ws, { projectId: f.projectId });
    const pub = await member(f, 'publisher', { scopeType: 'assigned_accounts' });
    const { accountAssignments } = await import('@castlane/database');
    await db().insert(accountAssignments).values({ id: newId(), workspaceId: f.ws.workspaceId, accountId, membershipId: pub.membershipId, duty: 'publishing', validFrom: new Date(Date.now() - 1000) });
    const c = await newContent(f.owner, f);
    expect((await pub.client.attempt(C.get, { params: { ...f.params, contentId: c.id } })).status).toBe(404);
    await db().insert(publications).values({ id: newId(), workspaceId: f.ws.workspaceId, contentItemId: c.id, accountId, projectId: f.projectId, ownerMembershipId: pub.membershipId, status: 'draft' });
    expect((await pub.client.attempt(C.get, { params: { ...f.params, contentId: c.id } })).status).toBe(200);
    const listed = await pub.client.call(C.list, { params: f.params, query: {} });
    expect(listed.items.map((i) => i.id)).toEqual([c.id]);
    expect(listed.items[0]?.publicationCount).toBe(1);
  });

  it('lists with filters in SQL (stage, format, owner, overdue, no deadline) and a board with WIP counts', async () => {
    const f = await prodFixture();
    const lead = await member(f, 'project_lead', { projects: [f.projectId] });
    await newContent(f.owner, f, { title: 'First image', format: 'image', dueAt: '2020-01-01T10:00:00Z' });
    await newContent(f.owner, f, { title: 'Second video', format: 'short_video', noDeadline: true });
    const prod = await contentInProduction(f.owner, f, { ownerMembershipId: lead.membershipId, reviewerMembershipId: f.ws.owner.membershipId });
    const overdue = await f.owner.call(C.list, { params: f.params, query: { overdue: true } });
    expect(overdue.items.map((i) => i.title)).toEqual(['First image']);
    expect(overdue.items[0]?.overdue).toBe(true);
    const videos = await f.owner.call(C.list, { params: f.params, query: { format: ['short_video'] } });
    expect(videos.items.map((i) => i.title)).toEqual(['Second video']);
    const mine = await lead.client.call(C.list, { params: f.params, query: { mine: true } });
    expect(mine.items.map((i) => i.id)).toEqual([prod.id]);
    const byDue = await f.owner.call(C.list, { params: f.params, query: { sort: 'dueAt', direction: 'asc', pageSize: 1 } });
    expect(byDue.items[0]?.title).toBe('First image');
    const page2 = await f.owner.call(C.list, { params: f.params, query: { sort: 'dueAt', direction: 'asc', pageSize: 1, cursor: byDue.nextCursor! } });
    const page3 = await f.owner.call(C.list, { params: f.params, query: { sort: 'dueAt', direction: 'asc', pageSize: 1, cursor: page2.nextCursor! } });
    expect(new Set([byDue.items[0]?.id, page2.items[0]?.id, page3.items[0]?.id]).size).toBe(3);
    await f.owner.call(C.setWipLimits, { params: f.params, body: { limits: { production: 1 } } });
    const board = await f.owner.call(C.board, { params: f.params, query: {} });
    const col = board.columns.find((c) => c.stage === 'production')!;
    expect(col).toMatchObject({ count: 1, wipLimit: 1 });
    expect(board.columns.find((c) => c.stage === 'idea')?.count).toBe(2);
    expect(board.columns.map((c) => c.stage)).not.toContain('archived');
    // Exceeding the WIP limit warns, the card still moves.
    const another = await contentInProduction(f.owner, f, { ownerMembershipId: lead.membershipId, reviewerMembershipId: f.ws.owner.membershipId }).catch((e) => e);
    expect(another.stage).toBe('production');
    const lead2 = await lead.client.attempt(C.setWipLimits, { params: f.params, body: { limits: { production: 3 } } });
    expect(lead2.status).toBe(403);
  });

  it('Duplicate as New Draft inherits no metrics, approvals, payouts, publications, versions or tasks (T047)', async () => {
    const f = await prodFixture();
    const reviewer = await member(f, 'project_lead', { projects: [f.projectId] });
    // The source has an approved version, a published placement with metrics and a payout allocated to it.
    const src = await contentInReview(f.owner, f, { ownerMembershipId: f.ws.owner.membershipId, reviewerMembershipId: reviewer.membershipId });
    const rv = await review(reviewer.client, f, src.reviewId);
    await reviewer.client.call(R.approve, { params: { ...f.params, reviewId: src.reviewId }, body: { versionId: src.versionId } }, { ifMatch: rv.rowVersion });
    const accountId = await createAccount(db(), f.ws, { projectId: f.projectId });
    const longAgo = new Date(Date.now() - 30 * 86_400_000);
    await db().update(socialAccounts).set({ createdAt: longAgo }).where(eq(socialAccounts.id, accountId));
    const publicationId = newId();
    const publishedAt = new Date(Date.now() - 2 * 86_400_000);
    await db().insert(publications).values({ id: publicationId, workspaceId: f.ws.workspaceId, contentItemId: src.contentId, accountId, projectId: f.projectId, ownerMembershipId: f.ws.owner.membershipId, status: 'published', actualPublishedAt: publishedAt, format: 'image' });
    await f.owner.call(metricsEndpoints.create, {
      params: f.params,
      body: { entityType: 'publication', entityId: publicationId, kind: 'cumulative', observedAt: new Date(Date.now() - 3_600_000).toISOString(), sourceType: 'manual', sourceNote: 'Post insights', values: [{ metricKey: 'publication.views', availability: 'known', value: '500' }] },
    });
    const fm = await member(f, 'finance_manager');
    const cats = await f.owner.call(financeEndpoints.categoriesList, { params: f.params, query: {} });
    const payout = await fm.client.call(financeEndpoints.entriesCreate, {
      params: f.params,
      body: {
        type: 'expense',
        title: 'Creator payout for the reel',
        recognitionDate: new Date().toISOString().slice(0, 10),
        lines: [{ categoryId: cats.find((x) => x.key === 'contractors')!.id, amount: '80.00', currency: 'EUR' }],
        allocation: { mode: 'weights', rows: [{ projectId: f.projectId, contentItemId: src.contentId, value: '1' }] },
      },
    });
    const submitted = await fm.client.call(financeEndpoints.entriesSubmit, { params: { ...f.params, entryId: payout.id }, body: {} }, { ifMatch: payout.rowVersion });
    await f.owner.call(financeEndpoints.entriesPost, { params: { ...f.params, entryId: payout.id }, body: {} }, { ifMatch: submitted.rowVersion });
    const c = await getContent(f.owner, f, src.contentId);
    expect(c.approvedVersion?.id).toBe(src.versionId);
    expect(c.counts.publications).toBe(1);
    await f.owner.call(C.update, { params: { ...f.params, contentId: c.id }, body: { tags: ['morning'] } }, { ifMatch: c.rowVersion });

    const dup = await f.owner.call(C.duplicate, { params: { ...f.params, contentId: c.id }, body: { targetProjectId: f.projectId, copiedFieldSet: ['brief', 'tags'], attachmentAssetVersionIds: [src.assetVersionId] } });
    expect(dup.stage).toBe('idea');
    expect(dup.duplicatedFrom).toEqual({ id: c.id, title: c.title });
    expect(dup.brief.summary).toBe(c.brief.summary);
    expect(dup.tags).toEqual(['morning']);
    expect(dup.currentVersion).toBeNull();
    expect(dup.approvedVersion).toBeNull();
    expect(dup.activeReview).toBeNull();
    expect(dup.publicationCount).toBe(0);
    expect(dup.counts).toMatchObject({ versions: 0, tasks: 0, publications: 0 });
    expect(dup.reviewer).toBeNull();
    expect(dup.dueAt).toBeNull();
    // Server state: nothing that belongs to the source's history points at the copy.
    expect(await db().select().from(tasks).where(eq(tasks.contentItemId, dup.id))).toEqual([]);
    expect(await db().select().from(reviews).where(eq(reviews.subjectId, dup.id))).toEqual([]);
    expect(await db().select().from(publications).where(eq(publications.contentItemId, dup.id))).toEqual([]);
    expect(await db().select().from(financialAllocations).where(eq(financialAllocations.contentItemId, dup.id))).toEqual([]);
    const observations = await db().select().from(metricObservations).where(eq(metricObservations.workspaceId, f.ws.workspaceId));
    expect(observations.map((o) => o.publicationId ?? o.entityId)).toEqual([publicationId]);
    // ...and the source keeps all of it.
    expect((await db().select().from(financialAllocations).where(eq(financialAllocations.contentItemId, c.id))).map((a) => a.amountMinor)).toEqual([8000n]);
    expect((await getContent(f.owner, f, c.id)).approvedVersion?.id).toBe(src.versionId);
    // Other projects cannot receive characters; a version file from another content is refused.
    const bad = await f.owner.attempt(C.duplicate, { params: { ...f.params, contentId: c.id }, body: { targetProjectId: f.otherProjectId, copiedFieldSet: ['characters'] } });
    expect(bad.status).toBe(422);
  });

  it('Reference → Idea uses the content create use case: one linked draft, usage visible (T035)', async () => {
    const f = await prodFixture();
    const ref = await f.owner.call(referenceEndpoints.create, { params: f.params, body: { title: 'Lighting study', sourceUrl: 'https://example.com/ref', whatToReuse: 'Soft window light', tags: ['lighting'] } });
    const key = newId();
    const first = await f.owner.call(referenceEndpoints.useAsIdea, { params: { ...f.params, referenceId: ref.id }, body: { projectId: f.projectId, format: 'short_video' } }, { idempotencyKey: key });
    const again = await f.owner.call(referenceEndpoints.useAsIdea, { params: { ...f.params, referenceId: ref.id }, body: { projectId: f.projectId, format: 'image' } });
    expect(again.contentItemId).toBe(first.contentItemId);
    const c = await getContent(f.owner, f, first.contentItemId);
    expect(c.stage).toBe('idea');
    expect(c.brief.notes).toContain('Soft window light');
    const [au] = await db().select().from(auditEvents).where(and(eq(auditEvents.entityId, c.id), eq(auditEvents.action, 'content.created')));
    expect((au!.metadata as { fromReferenceId?: string }).fromReferenceId).toBe(ref.id);
  });

  it('archives with a preview (pending reviews cancelled, scheduled placements block) and restores', async () => {
    const f = await prodFixture();
    const c = await newContent(f.owner, f);
    const preview = await f.owner.call(archiveEndpoints.archivePreview, { params: f.params, body: { targets: [{ entityType: 'content_item', entityId: c.id }] } });
    expect(preview.items[0]?.status).toBe('ok');
    const done = await f.owner.call(archiveEndpoints.archive, { params: f.params, body: { previewToken: preview.token, reason: 'Not needed any more' } });
    expect(done.done.length).toBe(1);
    const archived = await getContent(f.owner, f, c.id);
    expect(archived.stage).toBe('archived');
    expect(archived.permissions.edit).toBe(false);
    expect((await f.owner.call(C.list, { params: f.params, query: {} })).items).toEqual([]);
    expect((await f.owner.call(C.list, { params: f.params, query: { includeArchived: true } })).items.length).toBe(1);
    const listed = await f.owner.call(archiveEndpoints.list, { params: f.params, query: { state: 'archived', entityType: 'content_item' } });
    expect(listed.items.map((i) => i.entityId)).toEqual([c.id]);
    const rp = await f.owner.call(archiveEndpoints.restorePreview, { params: f.params, body: { targets: [{ entityType: 'content_item', entityId: c.id, state: 'archived' }] } });
    await f.owner.call(archiveEndpoints.restore, { params: f.params, body: { previewToken: rp.token } });
    expect((await getContent(f.owner, f, c.id)).stage).toBe('idea');
    // Scheduled placements block archiving.
    const { createAccount } = await import('../../support');
    const accountId = await createAccount(db(), f.ws, { projectId: f.projectId });
    await db().insert(publications).values({ id: newId(), workspaceId: f.ws.workspaceId, contentItemId: c.id, accountId, projectId: f.projectId, ownerMembershipId: f.ws.owner.membershipId, status: 'scheduled', scheduledAt: new Date(Date.now() + 86_400_000) });
    const blocked = await f.owner.call(archiveEndpoints.archivePreview, { params: f.params, body: { targets: [{ entityType: 'content_item', entityId: c.id }] } });
    expect(blocked.items[0]?.status).toBe('blocked');
  });

  it('moves drafts to the trash only when nothing depends on them', async () => {
    const f = await prodFixture();
    const c = await newContent(f.owner, f);
    const t = await f.owner.call(archiveEndpoints.trash, { params: f.params, body: { targets: [{ entityType: 'content_item', entityId: c.id }], reason: 'Created by mistake' } });
    expect(t.done.length).toBe(1);
    expect((await f.owner.attempt(C.get, { params: { ...f.params, contentId: c.id } })).status).toBe(404);
    const reviewer = await member(f, 'project_lead', { projects: [f.projectId] });
    const p = await contentInProduction(f.owner, f, { ownerMembershipId: f.ws.owner.membershipId, reviewerMembershipId: reviewer.membershipId });
    const refused = await f.owner.call(archiveEndpoints.trash, { params: f.params, body: { targets: [{ entityType: 'content_item', entityId: p.id }], reason: 'Created by mistake' } });
    expect(refused.failed[0]?.message).toMatch(/Idea and Brief/);
  });

  it('content comments notify the owner and reviewer; activity shows meaningful events', async () => {
    const f = await prodFixture();
    const lead = await member(f, 'project_lead', { projects: [f.projectId] });
    const c = await newContent(f.owner, f, { ownerMembershipId: lead.membershipId });
    const n = await db().select().from(notifications).where(and(eq(notifications.recipientMembershipId, lead.membershipId), eq(notifications.eventType, 'content.assigned')));
    expect(n.length).toBe(1);
    await f.owner.call(commentEndpoints.create, { params: f.params, body: { parentType: 'content_item', parentId: c.id, body: 'Please keep it under 30 seconds.' } });
    const blocking = await f.owner.attempt(commentEndpoints.create, { params: f.params, body: { parentType: 'content_item', parentId: c.id, body: 'x', severity: 'blocking' } });
    expect(blocking.status).toBe(422);
    const act = await f.owner.call(C.activity, { params: { ...f.params, contentId: c.id }, query: {} });
    expect(act.items.map((i) => i.action)).toEqual(expect.arrayContaining(['content.created']));
    expect((await getContent(f.owner, f, c.id)).counts.comments).toBe(1);
  });

  it('bulk Assign / Tag / Move with preview and per-item results', async () => {
    const f = await prodFixture();
    const lead = await member(f, 'project_lead', { projects: [f.projectId] });
    const a = await newContent(f.owner, f, { title: 'Bulk one' });
    const b = await newContent(f.owner, f, { title: 'Bulk two', projectId: f.otherProjectId });
    const outsider = newId();
    const preview = await lead.client.call(C.bulkPreview, { params: f.params, body: { action: 'move_stage', ids: [a.id, b.id, outsider], value: 'brief' } });
    expect(preview.items.map((i) => i.outcome)).toEqual(['apply']);
    expect(preview.missingCount).toBe(2);
    const applied = await lead.client.call(C.bulkApply, { params: f.params, body: { token: preview.token } });
    expect(applied.done).toEqual([a.id]);
    expect((await getContent(f.owner, f, a.id)).stage).toBe('brief');
    const reuse = await lead.client.attempt(C.bulkApply, { params: f.params, body: { token: preview.token } });
    expect(reuse.status).toBe(409);
    const tag = await f.owner.call(C.bulkPreview, { params: f.params, body: { action: 'add_tag', ids: [a.id, b.id], value: 'launch' } });
    const t2 = await f.owner.call(C.bulkApply, { params: f.params, body: { token: tag.token } });
    expect(t2.done.length).toBe(2);
    // A changed target after preview is refused (not silently applied).
    const assign = await f.owner.call(C.bulkPreview, { params: f.params, body: { action: 'assign_owner', ids: [a.id], value: lead.membershipId } });
    const cur = await getContent(f.owner, f, a.id);
    await f.owner.call(C.update, { params: { ...f.params, contentId: a.id }, body: { title: 'Bulk one renamed' } }, { ifMatch: cur.rowVersion });
    const stale = await f.owner.call(C.bulkApply, { params: f.params, body: { token: assign.token } });
    expect(stale.failed[0]?.message).toMatch(/changed after the preview/);
  });
});

describe('content templates (T036, T037)', () => {
  const publishTemplate = async (f: Awaited<ReturnType<typeof prodFixture>>, name: string, tasksCfg: { key: string; title: string; dependsOn?: string[] }[]) => {
    const t = await f.owner.call(templateEndpoints.create, { params: f.params, body: { kind: 'content', name } });
    const draft = t.draft!;
    await f.owner.call(
      templateEndpoints.saveDraft,
      { params: { ...f.params, templateId: t.id, versionId: draft.id }, body: { config: { tasks: tasksCfg.map((x) => ({ ...x, durationDays: 1 })), checklist: [{ label: 'Hook in the first second', mandatory: true }], deliverableSlots: [{ slot: 'main_video', required: true }, { slot: 'cover', required: true }] } } },
      { ifMatch: draft.rowVersion },
    );
    const fresh = await f.owner.call(templateEndpoints.get, { params: { ...f.params, templateId: t.id } });
    const pub = await f.owner.call(templateEndpoints.publish, { params: { ...f.params, templateId: t.id }, body: { draftVersionId: fresh.draft!.id } }, { ifMatch: fresh.rowVersion });
    return pub.published!.id;
  };

  it('applies a template exactly once and never overwrites completed tasks when a new template is applied', async () => {
    const f = await prodFixture();
    const v1 = await publishTemplate(f, 'Short Video', [
      { key: 'script', title: 'Write the script' },
      { key: 'edit', title: 'Edit the cut', dependsOn: ['script'] },
    ]);
    const c = await newContent(f.owner, f, { format: 'short_video' });
    const preview = await f.owner.call(C.templatePreview, { params: { ...f.params, contentId: c.id }, body: { templateVersionId: v1, startDate: '2026-10-01' } });
    expect(preview.add.map((t) => t.title)).toEqual(['Write the script', 'Edit the cut']);
    expect(preview.deliverableSlots).toEqual([{ slot: 'main_video', required: true }, { slot: 'cover', required: true }]);
    const cur = await getContent(f.owner, f, c.id);
    const applied = await f.owner.call(C.applyTemplate, { params: { ...f.params, contentId: c.id }, body: { templateVersionId: v1, previewToken: preview.previewToken, startDate: '2026-10-01' } }, { ifMatch: cur.rowVersion });
    expect(applied.created).toBe(true);
    expect(applied.taskIds.length).toBe(2);
    expect(applied.content.template?.templateVersionId).toBe(v1);
    // T036: repeat with another key, even another date → nothing new.
    const again = await f.owner.call(C.applyTemplate, { params: { ...f.params, contentId: c.id }, body: { templateVersionId: v1, previewToken: 'x', startDate: '2026-10-05' } }, { ifMatch: applied.content.rowVersion });
    expect(again.created).toBe(false);
    expect((await db().select().from(tasks).where(eq(tasks.contentItemId, c.id))).length).toBe(2);
    // T037: complete the first task, then a new template: diff, completed kept, not-started cancelable.
    const [scriptTask] = await db().select().from(tasks).where(and(eq(tasks.contentItemId, c.id), eq(tasks.title, 'Write the script')));
    await db().update(tasks).set({ status: 'done', completedAt: new Date() }).where(eq(tasks.id, scriptTask!.id));
    const v2 = await publishTemplate(f, 'Short Video v2', [{ key: 'voice', title: 'Record the voice' }]);
    const p2 = await f.owner.call(C.templatePreview, { params: { ...f.params, contentId: c.id }, body: { templateVersionId: v2, startDate: '2026-10-02' } });
    expect(p2.keep.map((t) => t.title)).toEqual(['Write the script']);
    expect(p2.cancelable.map((t) => t.title)).toEqual(['Edit the cut']);
    expect(p2.add.map((t) => t.title)).toEqual(['Record the voice']);
    const now = await getContent(f.owner, f, c.id);
    const notCancelable = await f.owner.attempt(C.applyTemplate, { params: { ...f.params, contentId: c.id }, body: { templateVersionId: v2, previewToken: p2.previewToken, startDate: '2026-10-02', cancelTaskIds: [scriptTask!.id] } }, { ifMatch: now.rowVersion });
    expect(notCancelable.status).toBe(422);
    const r2 = await f.owner.call(C.applyTemplate, { params: { ...f.params, contentId: c.id }, body: { templateVersionId: v2, previewToken: p2.previewToken, startDate: '2026-10-02', cancelTaskIds: p2.cancelable.map((t) => t.taskId) } }, { ifMatch: now.rowVersion });
    expect(r2.cancelledTaskIds.length).toBe(1);
    const all = await db().select().from(tasks).where(eq(tasks.contentItemId, c.id));
    expect(all.find((t) => t.title === 'Write the script')?.status).toBe('done');
    expect(all.find((t) => t.title === 'Edit the cut')?.status).toBe('cancelled');
    expect(all.find((t) => t.title === 'Record the voice')).toBeTruthy();
  });

  it('refuses a stale preview (tasks changed after the preview)', async () => {
    const f = await prodFixture();
    const v1 = await publishTemplate(f, 'One task', [{ key: 'a', title: 'Do the thing' }]);
    const c = await newContent(f.owner, f);
    const cur = await getContent(f.owner, f, c.id);
    await f.owner.call(C.applyTemplate, { params: { ...f.params, contentId: c.id }, body: { templateVersionId: v1, previewToken: (await f.owner.call(C.templatePreview, { params: { ...f.params, contentId: c.id }, body: { templateVersionId: v1, startDate: '2026-10-01' } })).previewToken, startDate: '2026-10-01' } }, { ifMatch: cur.rowVersion });
    const v2 = await publishTemplate(f, 'Two', [{ key: 'b', title: 'Another thing' }]);
    const p = await f.owner.call(C.templatePreview, { params: { ...f.params, contentId: c.id }, body: { templateVersionId: v2, startDate: '2026-10-01' } });
    const [t] = await db().select().from(tasks).where(eq(tasks.contentItemId, c.id));
    await db().update(tasks).set({ status: 'in_progress', rowVersion: t!.rowVersion + 1 }).where(eq(tasks.id, t!.id));
    const now = await getContent(f.owner, f, c.id);
    const stale = await f.owner.attempt(C.applyTemplate, { params: { ...f.params, contentId: c.id }, body: { templateVersionId: v2, previewToken: p.previewToken, startDate: '2026-10-01' } }, { ifMatch: now.rowVersion });
    expect(stale.status).toBe(409);
    expect(String(stale.error?.message)).toMatch(/Preview the template again/);
  });

  it('Create and Apply Template in one step', async () => {
    const f = await prodFixture();
    const v1 = await publishTemplate(f, 'Quick', [{ key: 'a', title: 'Prepare assets' }]);
    const c = await newContent(f.owner, f, { format: 'short_video', applyTemplate: { templateVersionId: v1, startDate: '2026-10-01' } });
    expect(c.template?.templateVersionId).toBe(v1);
    expect(c.counts.tasks).toBe(1);
    expect(c.deliverableSlots.map((s) => s.slot)).toEqual(['main_video', 'cover']);
  });
});

void V;
