import { afterEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { newIdempotencyKey } from '@castlane/api-client';
import { publicationEndpoints as P, lookupEndpoints } from '@castlane/api-contracts';
import { assetLinks, contentVersions, metricCheckpoints, notifications, publicationPlanRevisions, publications, socialAccounts, tasks } from '@castlane/database';
import { getAppServices, runPublicationReminders } from '@castlane/application';
import { newId } from '@castlane/domain';
import { resetClock, setClock } from '../../support';
import { T0, at, db, insertContent, memberClient, publish, scheduled, setup } from './support';

afterEach(() => resetClock());

describe('publications: scheduling gates', () => {
  it('blocks scheduling of unapproved or revoked content, while a draft may be saved (T061)', async () => {
    const f = await setup();
    const unapproved = await insertContent(f.ws, f.project.id, { title: 'Still in review', approved: false });
    const draft = await f.owner.call(P.create, {
      params: f.W,
      body: { contentItemId: unapproved.id, accountId: f.accountId, ownerMembershipId: f.ws.owner.membershipId, scheduledAt: at(30), timezone: 'Europe/Berlin' },
    });
    expect(draft.status).toBe('draft');
    expect(draft.contentVersion).toBeNull();
    // No approved version at all → blocked, the placement stays a draft.
    const blocked = await f.owner.attempt(P.schedule, { params: { ...f.W, publicationId: draft.id }, body: { scheduledAt: at(30), timezone: 'Europe/Berlin' } }, { ifMatch: draft.rowVersion });
    expect(blocked.status).toBe(422);
    expect((blocked.error as { fieldErrors: { field: string }[] }).fieldErrors[0]!.field).toBe('contentVersionId');
    // Pinning the unapproved version explicitly → domain block (409) naming the gate.
    const pinned = await f.owner.attempt(
      P.schedule,
      { params: { ...f.W, publicationId: draft.id }, body: { scheduledAt: at(30), timezone: 'Europe/Berlin', contentVersionId: unapproved.unapprovedVersionId } },
      { ifMatch: draft.rowVersion },
    );
    expect(pinned.status).toBe(409);
    expect(pinned.code).toBe('INVALID_STATE');
    expect(JSON.stringify((pinned.error as { details?: unknown }).details)).toContain('VERSION_NOT_APPROVED');
    // The preview explains the same gate without changing anything.
    const preview = await f.owner.call(P.schedulePreview, { params: { ...f.W, publicationId: draft.id }, query: { scheduledAt: at(30), timezone: 'Europe/Berlin', contentVersionId: unapproved.unapprovedVersionId } });
    expect(preview.allowed).toBe(false);
    expect(preview.blockers.map((b) => b.code)).toContain('VERSION_NOT_APPROVED');
    expect((await f.owner.call(P.get, { params: { ...f.W, publicationId: draft.id } })).status).toBe('draft');
    // A newer, not-yet-approved version of approved content cannot be scheduled either.
    const newer = await f.owner.attempt(P.create, {
      params: f.W,
      body: { contentItemId: f.content.id, contentVersionId: f.content.pendingVersionId, accountId: f.accountId, ownerMembershipId: f.ws.owner.membershipId, scheduledAt: at(30), timezone: 'Europe/Berlin', schedule: true },
    });
    expect(newer.status).toBe(409);
    expect(await db().select().from(publications).where(and(eq(publications.workspaceId, f.ws.workspaceId), eq(publications.contentItemId, f.content.id)))).toHaveLength(0);
    // Revoked approval blocks new placements of that version.
    await db().update(contentVersions).set({ approvalRevokedAt: new Date(), approvalRevokedReason: 'Wrong logo' }).where(eq(contentVersions.id, f.content.approvedVersionId!));
    const revoked = await f.owner.attempt(P.create, {
      params: f.W,
      body: { contentItemId: f.content.id, contentVersionId: f.content.approvedVersionId!, accountId: f.accountId, ownerMembershipId: f.ws.owner.membershipId, scheduledAt: at(30), timezone: 'Europe/Berlin', schedule: true },
    });
    expect(revoked.status).toBe(409);
    expect(JSON.stringify((revoked.error as { details?: unknown }).details)).toContain('APPROVAL_REVOKED');
  });

  it('schedules an approved version with a future time and visible zone; past times are rejected', async () => {
    const f = await setup();
    const past = await f.owner.attempt(P.create, {
      params: f.W,
      body: { contentItemId: f.content.id, accountId: f.accountId, ownerMembershipId: f.ws.owner.membershipId, scheduledAt: at(-1), timezone: 'Europe/Berlin', schedule: true },
    });
    expect(past.status).toBe(422);
    expect((past.error as { fieldErrors: { field: string; message: string }[] }).fieldErrors[0]).toMatchObject({ field: 'scheduledAt', message: 'Choose a future date and time.' });
    const p = await scheduled(f.owner, f);
    expect(p.status).toBe('scheduled');
    expect(p.scheduleTimezone).toBe('Europe/Berlin');
    expect(p.contentVersion).toMatchObject({ versionNo: 1, approved: true });
    expect(p.originalScheduledAt).toBe(at(26));
    expect(p.planRevisions).toHaveLength(1);
    expect(p.allowedActions).toEqual(['reschedule', 'markPublished', 'fail', 'cancel']);
    // The approved files are linked to the placement so the publisher can open them.
    const links = await db().select().from(assetLinks).where(and(eq(assetLinks.entityType, 'publication'), eq(assetLinks.entityId, p.id)));
    expect(links).toHaveLength(1);
    expect(links[0]!.holding).toBe(false);
  });

  it('allows a Restricted account only with a lead override and a reason; archived accounts never (T062)', async () => {
    const f = await setup();
    await db().update(socialAccounts).set({ status: 'restricted', statusReason: 'Platform review' }).where(eq(socialAccounts.id, f.accountId));
    const publisher = await memberClient(f.ws, 'publisher', { accounts: [f.accountId] });
    const lead = await memberClient(f.ws, 'project_lead', { projects: [f.project.id] });
    const body = { contentItemId: f.content.id, accountId: f.accountId, ownerMembershipId: publisher.membershipId, scheduledAt: at(26), timezone: 'Europe/Berlin', schedule: true as const };
    const noReason = await lead.client.attempt(P.create, { params: f.W, body });
    expect(noReason.status).toBe(409);
    expect((noReason.error as unknown as { details: { requiresOverride: boolean } }).details.requiresOverride).toBe(true);
    const publisherOverride = await publisher.client.attempt(P.create, { params: f.W, body: { ...body, accountOverrideReason: 'I checked the account manually' } });
    expect(publisherOverride.status).toBe(403);
    const ok = await lead.client.call(P.create, { params: f.W, body: { ...body, accountOverrideReason: 'Restriction lifted on the platform, confirmed by phone' } });
    expect(ok.status).toBe('scheduled');
    expect(ok.overrideReason).toContain('Restriction lifted');
    // The publisher still sees and can confirm it on their account.
    expect((await publisher.client.call(P.get, { params: { ...f.W, publicationId: ok.id } })).permissions.overrideAccountStatus).toBe(false);
    await db().update(socialAccounts).set({ status: 'archived', archivedAt: new Date() }).where(eq(socialAccounts.id, f.accountId));
    const archived = await f.owner.attempt(P.create, { params: f.W, body: { ...body, ownerMembershipId: f.ws.owner.membershipId, accountOverrideReason: 'Owner override attempt' } });
    expect(archived.ok).toBe(false);
    expect([409, 422]).toContain(archived.status);
  });

  it('warns about a second placement within 15 minutes and keeps both only with a reason; reschedule needs a reason and keeps the first promise', async () => {
    const f = await setup();
    const first = await scheduled(f.owner, f, { scheduledAt: at(26) });
    const other = await insertContent(f.ws, f.project.id, { title: 'Evening Story' });
    const clash = await f.owner.attempt(P.create, {
      params: f.W,
      body: { contentItemId: other.id, accountId: f.accountId, ownerMembershipId: f.ws.owner.membershipId, scheduledAt: at(26.1), timezone: 'Europe/Berlin', schedule: true },
    });
    expect(clash.status).toBe(409);
    expect((clash.error as unknown as { details: { conflicts: { publicationId: string }[] } }).details.conflicts[0]!.publicationId).toBe(first.id);
    const kept = await f.owner.call(P.create, {
      params: f.W,
      body: { contentItemId: other.id, accountId: f.accountId, ownerMembershipId: f.ws.owner.membershipId, scheduledAt: at(26.1), timezone: 'Europe/Berlin', schedule: true, conflictOverrideReason: 'Story and reel are allowed together' },
    });
    expect(kept.status).toBe('scheduled');
    // Rescheduling a scheduled placement records a plan revision with a reason.
    const noReason = await f.owner.attempt(P.schedule, { params: { ...f.W, publicationId: first.id }, body: { scheduledAt: at(50), timezone: 'Europe/Berlin' } }, { ifMatch: first.rowVersion });
    expect(noReason.status).toBe(422);
    const moved = await f.owner.call(P.schedule, { params: { ...f.W, publicationId: first.id }, body: { scheduledAt: at(50), timezone: 'Europe/Berlin', reason: 'Client asked to move' } }, { ifMatch: first.rowVersion });
    expect(moved.scheduledAt).toBe(at(50));
    expect(moved.originalScheduledAt).toBe(at(26));
    const revisions = await db().select().from(publicationPlanRevisions).where(eq(publicationPlanRevisions.publicationId, first.id));
    expect(revisions).toHaveLength(2);
    expect(revisions.find((r) => r.reason === 'Client asked to move')).toMatchObject({ fromScheduledAt: new Date(at(26)), toScheduledAt: new Date(at(50)) });
    // Stale and missing If-Match.
    expect((await f.owner.attempt(P.schedule, { params: { ...f.W, publicationId: first.id }, body: { scheduledAt: at(60), timezone: 'Europe/Berlin', reason: 'Again' } }, { ifMatch: first.rowVersion })).status).toBe(412);
    expect((await f.owner.attempt(P.schedule, { params: { ...f.W, publicationId: first.id }, body: { scheduledAt: at(60), timezone: 'Europe/Berlin', reason: 'Again' } })).status).toBe(428);
    // Status is never PATCHed; a scheduled time moves only by Reschedule.
    const patch = await f.owner.attempt(P.update, { params: { ...f.W, publicationId: first.id }, body: { scheduledAt: at(70) } }, { ifMatch: moved.rowVersion });
    expect(patch.status).toBe(422);
  });
});

describe('publications: confirmation', () => {
  it('never becomes Published because time passed; a reminder asks to confirm (T063)', async () => {
    const f = await setup();
    const p = await scheduled(f.owner, f, { scheduledAt: at(2) });
    setClock(at(1.5));
    await runPublicationReminders(getAppServices());
    setClock(at(4));
    await runPublicationReminders(getAppServices());
    await runPublicationReminders(getAppServices());
    const owner = await (await import('./support')).clientAt(f.ws.owner.userId);
    const after = await owner.call(P.get, { params: { ...f.W, publicationId: p.id } });
    expect(after.status).toBe('scheduled');
    expect(after.actualPublishedAt).toBeNull();
    expect(after.awaitingConfirmation).toBe(true);
    expect(await db().select().from(metricCheckpoints).where(eq(metricCheckpoints.publicationId, p.id))).toHaveLength(0);
    const notes = await db().select().from(notifications).where(and(eq(notifications.workspaceId, f.ws.workspaceId), eq(notifications.entityId, p.id)));
    expect(notes.filter((n) => n.eventType === 'publication.due')).toHaveLength(1);
    expect(notes.filter((n) => n.eventType === 'publication.awaiting_confirmation')).toHaveLength(1);
    const due = await owner.call(P.due, { params: f.W, query: {} });
    expect(due.awaitingConfirmation).toBe(1);
    expect(due.items[0]!.id).toBe(p.id);
  });

  it('requires the post URL or a 10–500 character reason (T064)', async () => {
    const f = await setup();
    const p = await scheduled(f.owner, f);
    const none = await publish(f.owner, f, p);
    expect(none.status).toBe(422);
    expect((none.error as { fieldErrors: { field: string }[] }).fieldErrors.map((e) => e.field)).toEqual(['externalUrl', 'noUrlReason']);
    const short = await publish(f.owner, f, p, { noUrlReason: 'too short' });
    expect(short.status).toBe(422);
    const http = await publish(f.owner, f, p, { externalUrl: 'http://instagram.com/p/abc' });
    expect(http.status).toBe(422);
    const future = await publish(f.owner, f, p, { actualPublishedAt: at(1), externalUrl: 'https://www.instagram.com/p/ABC123/' });
    expect(future.status).toBe(422);
    const ok = await publish(f.owner, f, p, { noUrlReason: 'Posted as a story without a permanent link' });
    expect(ok.status).toBe(200);
    expect(ok.data!.status).toBe('published');
    expect(ok.data!.urlMissing).toBe(true);
    const urlTasks = await db().select().from(tasks).where(and(eq(tasks.publicationId, p.id)));
    expect(urlTasks.some((t) => t.title.startsWith('Add the post URL'))).toBe(true);
  });

  it('creates exactly one fact, one set of checkpoints and measurement tasks, even when repeated (T065)', async () => {
    const f = await setup();
    const p = await scheduled(f.owner, f);
    const key = newIdempotencyKey();
    const body = { actualPublishedAt: at(-0.5), externalUrl: 'https://www.instagram.com/p/ABC123/?igsh=xyz' };
    const first = await publish(f.owner, f, p, body, { idempotencyKey: key });
    expect(first.status).toBe(200);
    const replay = await publish(f.owner, f, p, body, { idempotencyKey: key });
    expect(replay.status).toBe(200);
    expect(replay.data!.rowVersion).toBe(first.data!.rowVersion);
    // Another key: the stale version is a conflict (412); with the current version the transition is refused (409).
    expect((await publish(f.owner, f, p, body, { idempotencyKey: newIdempotencyKey() })).status).toBe(412);
    const again = await publish(f.owner, f, { id: p.id, rowVersion: first.data!.rowVersion }, body, { idempotencyKey: newIdempotencyKey() });
    expect(again.status).toBe(409);
    expect(again.code).toBe('INVALID_STATE');
    const cps = await db().select().from(metricCheckpoints).where(eq(metricCheckpoints.publicationId, p.id));
    expect(cps.map((c) => c.checkpointKey).sort()).toEqual(['pub_24h', 'pub_7d']);
    const published = new Date(at(-0.5)).getTime();
    const d24 = cps.find((c) => c.checkpointKey === 'pub_24h')!;
    expect(d24.expectedAt.getTime()).toBe(published + 24 * 3_600_000);
    expect(d24.windowStart.getTime()).toBe(published + 22 * 3_600_000);
    expect(d24.windowEnd.getTime()).toBe(published + 26 * 3_600_000);
    const d7 = cps.find((c) => c.checkpointKey === 'pub_7d')!;
    expect(d7.windowEnd.getTime() - d7.windowStart.getTime()).toBe(24 * 3_600_000);
    expect(cps.every((c) => c.state === 'pending' && c.accountId === f.accountId && c.projectId === f.project.id && c.assigneeMembershipId === f.ws.owner.membershipId)).toBe(true);
    const measure = await db().select().from(tasks).where(eq(tasks.publicationId, p.id));
    expect(measure.map((t) => t.title).sort()).toEqual(['Record 24h metrics: Morning Routine Reel', 'Record 7d metrics: Morning Routine Reel']);
    const detail = first.data!;
    expect(detail.checkpoints.map((c) => c.label)).toEqual(['24h', '7d']);
    expect(detail.externalPostUrl).toBe('https://www.instagram.com/p/ABC123/?igsh=xyz');
    const notes = await db().select().from(notifications).where(and(eq(notifications.entityId, p.id), eq(notifications.eventType, 'publication.checkpoints_created')));
    expect(notes).toHaveLength(1);
    // Published files are held (their exact versions can no longer be deleted).
    const links = await db().select().from(assetLinks).where(and(eq(assetLinks.entityType, 'publication'), eq(assetLinks.entityId, p.id)));
    expect(links.every((l) => l.holding)).toBe(true);
  });

  it('rejects the same post URL on another placement even with another idempotency key (T066)', async () => {
    const f = await setup();
    const a = await scheduled(f.owner, f);
    const other = await insertContent(f.ws, f.project.id, { title: 'Second reel' });
    const b = await scheduled(f.owner, f, { contentItemId: other.id, contentVersionId: other.approvedVersionId!, scheduledAt: at(40) });
    expect((await publish(f.owner, f, a, { externalUrl: 'https://www.instagram.com/p/XYZ/' })).status).toBe(200);
    const dup = await publish(f.owner, f, b, { externalUrl: 'https://instagram.com/p/XYZ?utm_source=story' });
    expect(dup.status).toBe(409);
    expect(dup.code).toBe('DUPLICATE');
    expect((await f.owner.call(P.get, { params: { ...f.W, publicationId: b.id } })).status).toBe('scheduled');
    // The database constraint holds even without the application pre-check (other account, same workspace).
    const [row] = await db().select().from(publications).where(eq(publications.id, a.id));
    await expect(
      db()
        .insert(publications)
        .values({ ...row!, id: newId(), accountId: f.otherAccountId, projectId: f.other.id, createdAt: new Date(), updatedAt: new Date() }),
    ).rejects.toThrow();
  });

  it('records removed/unavailable posts without deleting facts (T069)', async () => {
    const f = await setup();
    const p = await scheduled(f.owner, f);
    const pub = (await publish(f.owner, f, p, { externalUrl: 'https://www.instagram.com/p/REMOVED1/' })).data!;
    const removed = await f.owner.call(P.setAvailability, { params: { ...f.W, publicationId: p.id }, body: { availability: 'removed', reason: 'The platform removed the post' } }, { ifMatch: pub.rowVersion });
    expect(removed.status).toBe('published');
    expect(removed.availability).toBe('removed');
    expect(removed.availabilityReason).toBe('The platform removed the post');
    expect(removed.actualPublishedAt).toBe(pub.actualPublishedAt);
    expect(removed.externalPostUrl).toBe(pub.externalPostUrl);
    expect(removed.checkpoints).toHaveLength(2);
    // Cannot mark a draft/scheduled placement as removed.
    const other = await scheduled(f.owner, f, { scheduledAt: at(80) });
    expect((await f.owner.attempt(P.setAvailability, { params: { ...f.W, publicationId: other.id }, body: { availability: 'removed', reason: 'Nope' } }, { ifMatch: other.rowVersion })).status).toBe(409);
  });

  it('corrects published facts with a reason; pending checkpoints move, completed ones keep their time', async () => {
    const f = await setup();
    const p = await scheduled(f.owner, f);
    const pub = (await publish(f.owner, f, p, { actualPublishedAt: at(-2), externalUrl: 'https://www.instagram.com/p/FIX1/' })).data!;
    const d24 = pub.checkpoints.find((c) => c.key === 'pub_24h')!;
    await db().update(metricCheckpoints).set({ state: 'completed', timing: 'on_time' }).where(eq(metricCheckpoints.id, d24.id));
    const publisher = await memberClient(f.ws, 'publisher', { accounts: [f.accountId] });
    // Publishers confirm but cannot correct history.
    expect((await publisher.client.attempt(P.correct, { params: { ...f.W, publicationId: p.id }, body: { changes: { actualPublishedAt: at(-3) }, reason: 'Typo in time' } }, { ifMatch: pub.rowVersion })).status).toBe(403);
    const unchanged = await f.owner.attempt(P.correct, { params: { ...f.W, publicationId: p.id }, body: { changes: { actualPublishedAt: at(-2) }, reason: 'No change' } }, { ifMatch: pub.rowVersion });
    expect(unchanged.status).toBe(422);
    const fixed = await f.owner.call(
      P.correct,
      { params: { ...f.W, publicationId: p.id }, body: { changes: { actualPublishedAt: at(-3), externalUrl: 'https://www.instagram.com/p/FIX2/' }, reason: 'Time and link taken from the platform', recalculateCheckpoints: true } },
      { ifMatch: pub.rowVersion },
    );
    expect(fixed.actualPublishedAt).toBe(at(-3));
    expect(fixed.corrections).toHaveLength(1);
    expect(fixed.corrections[0]!.before).toMatchObject({ actualPublishedAt: at(-2), externalPostUrl: 'https://www.instagram.com/p/FIX1/' });
    const cps = await db().select().from(metricCheckpoints).where(eq(metricCheckpoints.publicationId, p.id));
    expect(cps.find((c) => c.checkpointKey === 'pub_24h')!.expectedAt.toISOString()).toBe(d24.expectedAt);
    expect(cps.find((c) => c.checkpointKey === 'pub_7d')!.expectedAt.toISOString()).toBe(new Date(new Date(at(-3)).getTime() + 168 * 3_600_000).toISOString());
  });

  it('records a historical placement with a source note and no tasks for elapsed windows; fail and cancel need reasons', async () => {
    const f = await setup();
    const hist = await f.owner.call(P.createHistorical, {
      params: f.W,
      body: {
        contentItemId: f.content.id,
        contentVersionId: f.content.approvedVersionId!,
        accountId: f.accountId,
        ownerMembershipId: f.ws.owner.membershipId,
        actualPublishedAt: at(-24 * 30),
        externalUrl: 'https://www.instagram.com/p/OLD1/',
        sourceNote: 'Copied from the April posting log',
      },
    });
    expect(hist).toMatchObject({ status: 'published', historicalEntry: true, sourceNote: 'Copied from the April posting log' });
    expect(hist.checkpoints).toHaveLength(2);
    expect(await db().select().from(tasks).where(eq(tasks.publicationId, hist.id))).toHaveLength(0);
    const p = await scheduled(f.owner, f);
    expect((await f.owner.attempt(P.fail, { params: { ...f.W, publicationId: p.id }, body: {} as never }, { ifMatch: p.rowVersion })).status).toBe(422);
    const failed = await f.owner.call(P.fail, { params: { ...f.W, publicationId: p.id }, body: { reason: 'Upload rejected by the app' } }, { ifMatch: p.rowVersion });
    expect(failed).toMatchObject({ status: 'failed', failureReason: 'Upload rejected by the app', allowedActions: ['retry', 'cancel'] });
    expect(await db().select().from(metricCheckpoints).where(eq(metricCheckpoints.publicationId, p.id))).toHaveLength(0);
    const retried = await f.owner.call(P.schedule, { params: { ...f.W, publicationId: p.id }, body: { scheduledAt: at(30), timezone: 'Europe/Berlin' } }, { ifMatch: failed.rowVersion });
    expect(retried.status).toBe('scheduled');
    const cancelled = await f.owner.call(P.cancel, { params: { ...f.W, publicationId: p.id }, body: { reason: 'Campaign stopped' } }, { ifMatch: retried.rowVersion });
    expect(cancelled.status).toBe('cancelled');
    expect((await f.owner.attempt(P.markPublished, { params: { ...f.W, publicationId: p.id }, body: { actualPublishedAt: at(0), externalUrl: 'https://www.instagram.com/p/C1/' } }, { ifMatch: cancelled.rowVersion })).status).toBe(409);
  });
});

describe('publications: scope', () => {
  it('scopes lists, details, lookups and commands to the member’s projects and accounts', async () => {
    const f = await setup();
    const mine = await scheduled(f.owner, f);
    const otherContent = await insertContent(f.ws, f.other.id, { title: 'Nova teaser' });
    const theirs = await scheduled(f.owner, f, { accountId: f.otherAccountId, contentItemId: otherContent.id, contentVersionId: otherContent.approvedVersionId! });
    const lead = await memberClient(f.ws, 'project_lead', { projects: [f.other.id] });
    const publisher = await memberClient(f.ws, 'publisher', { accounts: [f.accountId] });
    const leadList = await lead.client.call(P.list, { params: f.W, query: {} });
    expect(leadList.items.map((i) => i.id)).toEqual([theirs.id]);
    expect((await lead.client.attempt(P.get, { params: { ...f.W, publicationId: mine.id } })).status).toBe(404);
    expect((await lead.client.attempt(P.markPublished, { params: { ...f.W, publicationId: mine.id }, body: { actualPublishedAt: at(0), externalUrl: 'https://www.instagram.com/p/NO/' } }, { ifMatch: mine.rowVersion })).status).toBe(404);
    const pubList = await publisher.client.call(P.list, { params: f.W, query: {} });
    expect(pubList.items.map((i) => i.id)).toEqual([mine.id]);
    const lookup = await publisher.client.call(lookupEndpoints.search, { params: { ...f.W, type: 'publication' }, query: {} });
    expect(lookup.items.map((i) => i.id)).toEqual([mine.id]);
    // The publisher confirms on their account; planning on another account is refused.
    expect((await publish(publisher.client, f, mine, { externalUrl: 'https://www.instagram.com/p/PUBL1/' })).status).toBe(200);
    const foreign = await publisher.client.attempt(P.create, {
      params: f.W,
      body: { contentItemId: otherContent.id, accountId: f.otherAccountId, ownerMembershipId: publisher.membershipId, timezone: 'Europe/Berlin' },
    });
    expect(foreign.ok).toBe(false);
    expect([404, 422]).toContain(foreign.status);
    // The content picker for an account lists only that project's content with its approved version.
    const options = await publisher.client.call(P.contentOptions, { params: f.W, query: { accountId: f.accountId } });
    expect(options.map((o) => o.id)).toEqual([f.content.id]);
    expect(options[0]!.approvedVersion?.versionNo).toBe(1);
    // A viewer reads but cannot plan; a member without publications access gets 403 on the module.
    const viewer = await memberClient(f.ws, 'viewer');
    expect((await viewer.client.call(P.list, { params: f.W, query: {} })).items).toHaveLength(2);
    expect((await viewer.client.attempt(P.create, { params: f.W, body: { contentItemId: f.content.id, accountId: f.accountId, ownerMembershipId: viewer.membershipId } })).status).toBe(403);
    const creator = await memberClient(f.ws, 'creator', { projects: [f.project.id] });
    expect((await creator.client.attempt(P.list, { params: f.W, query: {} })).status).toBe(403);
  });

  it('requires an owner who can reach the account', async () => {
    const f = await setup();
    const outsider = await memberClient(f.ws, 'publisher', { accounts: [f.otherAccountId] });
    const r = await f.owner.attempt(P.create, { params: f.W, body: { contentItemId: f.content.id, accountId: f.accountId, ownerMembershipId: outsider.membershipId } });
    expect(r.status).toBe(422);
    expect((r.error as { fieldErrors: { field: string }[] }).fieldErrors[0]!.field).toBe('ownerMembershipId');
    expect(T0).toBeTruthy();
  });
});
