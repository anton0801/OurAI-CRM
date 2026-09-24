import { afterEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { newIdempotencyKey } from '@castlane/api-client';
import { accountEndpoints as A, lookupEndpoints, metricsEndpoints, taskEndpoints } from '@castlane/api-contracts';
import { accountIdentityHistory, memberships, metricObservations, notifications, publications, shifts, socialAccounts, tasks } from '@castlane/database';
import { addMember, assignToProject, clientFor, createProject, sessionFor } from '../../support';
import { baseSetup, db, insertPublication, insertShift } from './support';

afterEach(() => vi.restoreAllMocks());

const createBody = (projectId: string, ownerMembershipId: string, url = 'https://www.instagram.com/emma.daily/?utm_source=ig_web&igshid=abc') => ({
  platform: 'instagram' as const,
  profileUrl: url,
  projectId,
  ownerMembershipId,
});

describe('accounts: link-only registration', () => {
  it('adding an Instagram URL never fetches it and creates no statistics (T033)', async () => {
    const { ws, owner, project, W } = await baseSetup();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const a = await owner.call(A.create, { params: W, body: createBody(project.id, ws.owner.membershipId) });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(a.canonicalUrl).toBe('https://instagram.com/emma.daily');
    expect(a.originalUrl).toContain('utm_source');
    expect(a.handle).toBe('emma.daily');
    expect(a.status).toBe('preparing');
    // Unknown is not zero: no metrics recorded means null, not 0.
    expect(a.lastMetricsAt).toBeNull();
    const obs = await db().select().from(metricObservations).where(eq(metricObservations.accountId, a.id));
    expect(obs).toHaveLength(0);
  });

  it('create is idempotent under replay and rejects a different body with the same key', async () => {
    const { ws, owner, project, W } = await baseSetup();
    const key = newIdempotencyKey();
    const body = createBody(project.id, ws.owner.membershipId);
    const first = await owner.call(A.create, { params: W, body }, { idempotencyKey: key });
    const again = await owner.call(A.create, { params: W, body }, { idempotencyKey: key });
    expect(again.id).toBe(first.id);
    const rows = await db().select().from(socialAccounts).where(eq(socialAccounts.workspaceId, ws.workspaceId));
    expect(rows).toHaveLength(1);
    const mismatch = await owner.attempt(A.create, { params: W, body: { ...body, handle: 'other' } }, { idempotencyKey: key });
    expect(mismatch.code).toBe('IDEMPOTENCY_PAYLOAD_MISMATCH');
  });

  it('duplicate URL with tracking parameters resolves to one canonical identity and shows the permitted record (T028)', async () => {
    const { ws, owner, project, W } = await baseSetup();
    const a = await owner.call(A.create, { params: W, body: createBody(project.id, ws.owner.membershipId, 'https://instagram.com/Emma.Daily') });
    const preview = await owner.call(A.urlPreview, { params: W, query: { platform: 'instagram', url: 'https://m.instagram.com/emma.daily/?igsh=xyz&utm_campaign=x' } });
    expect(preview.ok).toBe(true);
    expect(preview.removedParams.sort()).toEqual(['igsh', 'utm_campaign']);
    expect(preview.duplicate?.account?.id).toBe(a.id);
    const dup = await owner.attempt(A.create, { params: W, body: createBody(project.id, ws.owner.membershipId, 'https://www.instagram.com/emma.daily?utm_source=x') });
    expect(dup.status).toBe(409);
    expect(dup.code).toBe('DUPLICATE');
    expect((dup.error as unknown as { details: { existing: { id: string } } }).details.existing.id).toBe(a.id);

    // A member who cannot read the existing account learns only that a duplicate exists.
    const other = await createProject(db(), ws, { name: 'Other', type: 'influencer' });
    const lead = await addMember(db(), ws, { roleKey: 'project_lead', scopeType: 'assigned_projects' });
    await assignToProject(db(), ws, other.id, lead.membershipId);
    const leadC = await clientFor(await sessionFor(db(), lead.userId));
    const hidden = await leadC.attempt(A.create, { params: W, body: createBody(other.id, lead.membershipId, 'https://instagram.com/emma.daily') });
    expect(hidden.status).toBe(409);
    expect((hidden.error as unknown as { details: { existing: unknown } }).details.existing).toBeNull();
    const rows = await db().select().from(socialAccounts).where(eq(socialAccounts.workspaceId, ws.workspaceId));
    expect(rows).toHaveLength(1);
  });

  it('custom platforms keep case-sensitive paths distinct (T029)', async () => {
    const { ws, owner, project, W } = await baseSetup();
    const body = (url: string) => ({ ...createBody(project.id, ws.owner.membershipId, url), platform: 'other' as const });
    const a = await owner.call(A.create, { params: W, body: body('https://fans.example.com/Studio/Alice') });
    const b = await owner.call(A.create, { params: W, body: body('https://fans.example.com/studio/alice') });
    expect(a.id).not.toBe(b.id);
    expect(a.canonicalUrl).toBe('https://fans.example.com/Studio/Alice');
    const dup = await owner.attempt(A.create, { params: W, body: body('https://www.fans.example.com/Studio/Alice/?utm_medium=bio') });
    expect(dup.code).toBe('DUPLICATE');
    // Host validation per platform.
    const wrongHost = await owner.attempt(A.create, { params: W, body: createBody(project.id, ws.owner.membershipId, 'https://tiktok.com/@emma') });
    expect(wrongHost.status).toBe(422);
    const insecure = await owner.attempt(A.create, { params: W, body: createBody(project.id, ws.owner.membershipId, 'http://instagram.com/emma') });
    expect(insecure.status).toBe(422);
    const script = await owner.attempt(A.create, { params: W, body: { ...body('javascript:alert(1)') } });
    expect(script.status).toBe(422);
  });

  it('rename keeps the handle/URL history and publications stay linked (T030)', async () => {
    const { ws, owner, project, W } = await baseSetup();
    const a = await owner.call(A.create, { params: W, body: createBody(project.id, ws.owner.membershipId, 'https://instagram.com/emma.old') });
    const pubId = await insertPublication(ws, { accountId: a.id, projectId: project.id, status: 'published' });
    const renamed = await owner.call(
      A.update,
      { params: { ...W, accountId: a.id }, body: { profileUrl: 'https://instagram.com/emma.new', identityChangeReason: 'Handle changed on the platform' } },
      { ifMatch: a.rowVersion },
    );
    expect(renamed.handle).toBe('emma.new');
    const history = await owner.call(A.history, { params: { ...W, accountId: a.id } });
    expect(history.identity).toHaveLength(1);
    expect(history.identity[0]).toMatchObject({ oldHandle: 'emma.old', newHandle: 'emma.new', oldUrl: 'https://instagram.com/emma.old', newUrl: 'https://instagram.com/emma.new', reason: 'Handle changed on the platform' });
    const [pub] = await db().select().from(publications).where(eq(publications.id, pubId));
    expect(pub!.accountId).toBe(a.id);
    // The old handle is free again; stale If-Match is rejected.
    const stale = await owner.attempt(A.update, { params: { ...W, accountId: a.id }, body: { displayName: 'Emma' } }, { ifMatch: a.rowVersion });
    expect(stale.status).toBe(412);
    const missing = await owner.attempt(A.update, { params: { ...W, accountId: a.id }, body: { displayName: 'Emma' } });
    expect(missing.status).toBe(428);
    const rows = await db().select().from(accountIdentityHistory).where(eq(accountIdentityHistory.accountId, a.id));
    expect(rows).toHaveLength(1);
  });
});

describe('accounts: lifecycle', () => {
  it('follows the status machine with reasons and archive obligations', async () => {
    const { ws, owner, project, W } = await baseSetup();
    let a = await owner.call(A.create, { params: W, body: { ...createBody(project.id, ws.owner.membershipId), status: 'active' } });
    const P = { ...W, accountId: a.id };
    const noReason = await owner.attempt(A.transition, { params: P, body: { targetState: 'restricted' } }, { ifMatch: a.rowVersion });
    expect(noReason.status).toBe(422);
    a = await owner.call(A.transition, { params: P, body: { targetState: 'restricted', reason: 'Posting limited by the platform' } }, { ifMatch: a.rowVersion });
    expect(a.status).toBe('restricted');
    expect(a.permissions.createPublication).toBe(false);
    const invalid = await owner.attempt(A.transition, { params: P, body: { targetState: 'paused' } }, { ifMatch: a.rowVersion });
    expect(invalid.status).toBe(409);
    expect(invalid.code).toBe('INVALID_STATE');
    const noResolution = await owner.attempt(A.transition, { params: P, body: { targetState: 'active' } }, { ifMatch: a.rowVersion });
    expect(noResolution.status).toBe(422);
    a = await owner.call(A.transition, { params: P, body: { targetState: 'active', reason: 'Appeal accepted' } }, { ifMatch: a.rowVersion });
    a = await owner.call(A.transition, { params: P, body: { targetState: 'paused' } }, { ifMatch: a.rowVersion });
    expect(a.status).toBe('paused');

    await insertPublication(ws, { accountId: a.id, projectId: project.id, status: 'scheduled' });
    const preview = await owner.call(A.archivePreview, { params: P });
    expect(preview.items.find((i) => i.kind === 'scheduled_publications')?.blocking).toBe(true);
    const blocked = await owner.attempt(A.transition, { params: P, body: { targetState: 'archived' } }, { ifMatch: a.rowVersion });
    expect(blocked.status).toBe(409);
    await db().update(publications).set({ status: 'cancelled' }).where(eq(publications.accountId, a.id));
    a = await owner.call(A.transition, { params: P, body: { targetState: 'archived', reason: 'Retired' } }, { ifMatch: a.rowVersion });
    expect(a.status).toBe('archived');
    const list = await owner.call(A.list, { params: W, query: {} });
    expect(list.items.find((i) => i.id === a.id)).toBeUndefined();
    const withArchived = await owner.call(A.list, { params: W, query: { includeArchived: true } });
    expect(withArchived.items.find((i) => i.id === a.id)).toBeDefined();
    const readOnly = await owner.attempt(A.update, { params: P, body: { displayName: 'x' } }, { ifMatch: a.rowVersion });
    expect(readOnly.status).toBe(409);
    a = await owner.call(A.restore, { params: P, body: {} }, { ifMatch: a.rowVersion });
    expect(a.status).toBe('paused');
    const history = await owner.call(A.history, { params: P });
    expect(history.status.map((s) => s.toStatus)).toEqual(['paused', 'archived', 'paused', 'active', 'restricted', 'active']);
  });
});

describe('accounts: transfer between projects', () => {
  it('is blocked while a shift is active (T031); afterwards old facts keep the old project and new facts get the new one (T032)', async () => {
    const { ws, owner, project, W } = await baseSetup();
    const target = await createProject(db(), ws, { name: 'Target', type: 'influencer' });
    const a = await owner.call(A.create, { params: W, body: { ...createBody(project.id, ws.owner.membershipId), status: 'active' } });
    const P = { ...W, accountId: a.id };
    const shiftId = await insertShift(ws, { projectId: project.id, accountId: a.id, state: 'active' });
    const oldPub = await insertPublication(ws, { accountId: a.id, projectId: project.id, status: 'published' });
    const snapshot = (followers: string) =>
      owner.call(metricsEndpoints.create, {
        params: W,
        body: { entityType: 'account', entityId: a.id, kind: 'snapshot', observedAt: new Date().toISOString(), sourceType: 'manual', sourceNote: 'Profile page', values: [{ metricKey: 'account.followers', availability: 'known', value: followers }] },
      });
    const oldObservation = await snapshot('1200');

    const blocked = await owner.call(A.transferPreview, { params: P, query: { targetProjectId: target.id } });
    expect(blocked.blocked).toBe(true);
    expect(blocked.impactToken).toBeNull();
    expect(blocked.items.find((i) => i.kind === 'active_shifts')).toMatchObject({ blocking: true, count: 1 });
    const refused = await owner.attempt(A.transfer, { params: P, body: { targetProjectId: target.id, impactToken: '9999999999999.forged-token', reason: 'Move to target' } }, { ifMatch: a.rowVersion });
    expect(refused.status).toBe(409);

    await db().update(shifts).set({ state: 'ended', actualEnd: new Date() }).where(eq(shifts.id, shiftId));
    const preview = await owner.call(A.transferPreview, { params: P, query: { targetProjectId: target.id } });
    expect(preview.blocked).toBe(false);
    expect(preview.impactToken).toBeTruthy();
    const moved = await owner.call(A.transfer, { params: P, body: { targetProjectId: target.id, impactToken: preview.impactToken!, reason: 'Brand moved' } }, { ifMatch: a.rowVersion });
    expect(moved.project.id).toBe(target.id);
    const [pub] = await db().select().from(publications).where(eq(publications.id, oldPub));
    expect(pub!.projectId).toBe(project.id);
    const [shift] = await db().select().from(shifts).where(eq(shifts.id, shiftId));
    expect(shift!.projectId).toBe(project.id);
    // New facts recorded after the transfer are attributed to the new project; the old ones stay.
    const newObservation = await snapshot('1350');
    const newTask = await owner.call(taskEndpoints.create, { params: W, body: { title: 'Refresh the profile bio', projectId: target.id, accountId: a.id } });
    const wrongProjectTask = await owner.attempt(taskEndpoints.create, { params: W, body: { title: 'Old project work on it', projectId: project.id, accountId: a.id } });
    expect(wrongProjectTask.status).toBe(422);
    const observations = await db().select().from(metricObservations).where(eq(metricObservations.accountId, a.id));
    expect(Object.fromEntries(observations.map((o) => [o.id, o.projectId]))).toEqual({ [oldObservation.id]: project.id, [newObservation.id]: target.id });
    expect((await db().select().from(tasks).where(eq(tasks.id, newTask.id)))[0]?.projectId).toBe(target.id);
    expect((await db().select().from(publications).where(eq(publications.id, oldPub)))[0]?.projectId).toBe(project.id);
    const history = await owner.call(A.history, { params: P });
    expect(history.transfers[0]).toMatchObject({ fromProject: { id: project.id }, toProject: { id: target.id }, reason: 'Brand moved' });
    // A token cannot be replayed against the new version.
    const replay = await owner.attempt(A.transfer, { params: P, body: { targetProjectId: project.id, impactToken: preview.impactToken!, reason: 'Back again' } }, { ifMatch: moved.rowVersion });
    expect(replay.status).toBe(409);
  });
});

describe('accounts: scope and assignments', () => {
  it('scoped roles see only their accounts; out-of-scope is 404, read-only is 403; lists never leak', async () => {
    const { ws, owner, project, W } = await baseSetup();
    const other = await createProject(db(), ws, { name: 'Other', type: 'influencer' });
    const a = await owner.call(A.create, { params: W, body: createBody(project.id, ws.owner.membershipId, 'https://instagram.com/a_one') });
    const b = await owner.call(A.create, { params: W, body: createBody(other.id, ws.owner.membershipId, 'https://instagram.com/b_two') });
    const lead = await addMember(db(), ws, { roleKey: 'project_lead', scopeType: 'assigned_projects' });
    await assignToProject(db(), ws, project.id, lead.membershipId);
    const leadC = await clientFor(await sessionFor(db(), lead.userId));
    const list = await leadC.call(A.list, { params: W, query: {} });
    expect(list.items.map((i) => i.id)).toEqual([a.id]);
    expect((await leadC.attempt(A.get, { params: { ...W, accountId: b.id } })).status).toBe(404);
    expect((await leadC.attempt(A.update, { params: { ...W, accountId: b.id }, body: { displayName: 'x' } }, { ifMatch: 1 })).status).toBe(404);
    const lookup = await leadC.call(lookupEndpoints.search, { params: { ...W, type: 'account' }, query: { q: 'two' } });
    expect(lookup.items).toHaveLength(0);

    const viewer = await addMember(db(), ws, { roleKey: 'viewer' });
    const viewerC = await clientFor(await sessionFor(db(), viewer.userId));
    expect((await viewerC.call(A.get, { params: { ...W, accountId: b.id } })).id).toBe(b.id);
    expect((await viewerC.attempt(A.update, { params: { ...W, accountId: b.id }, body: { displayName: 'x' } }, { ifMatch: b.rowVersion })).status).toBe(403);
    expect((await viewerC.attempt(A.create, { params: W, body: createBody(project.id, viewer.membershipId, 'https://instagram.com/v_iew') })).status).toBe(403);

    // Publisher (assigned accounts) sees only accounts assigned to them.
    const publisher = await addMember(db(), ws, { roleKey: 'publisher', scopeType: 'assigned_accounts' });
    const pubC = await clientFor(await sessionFor(db(), publisher.userId));
    expect((await pubC.call(A.list, { params: W, query: {} })).items).toHaveLength(0);
    const [before] = await db().select({ rev: memberships.accessRevision }).from(memberships).where(eq(memberships.id, publisher.membershipId));
    const assignment = await owner.call(A.assign, { params: { ...W, accountId: b.id }, body: { membershipId: publisher.membershipId, duty: 'publishing' } });
    const [after] = await db().select({ rev: memberships.accessRevision }).from(memberships).where(eq(memberships.id, publisher.membershipId));
    expect(after!.rev).toBe(before!.rev + 1);
    const pubC2 = await clientFor(await sessionFor(db(), publisher.userId));
    expect((await pubC2.call(A.list, { params: W, query: {} })).items.map((i) => i.id)).toEqual([b.id]);
    const notes = await db().select().from(notifications).where(and(eq(notifications.recipientMembershipId, publisher.membershipId), eq(notifications.eventType, 'account.assigned')));
    expect(notes).toHaveLength(1);
    const dup = await owner.attempt(A.assign, { params: { ...W, accountId: b.id }, body: { membershipId: publisher.membershipId, duty: 'publishing' } });
    expect(dup.status).toBe(409);
    await owner.call(A.endAssignment, { params: { ...W, accountId: b.id, assignmentId: assignment.id }, body: { reason: 'Rotation' } });
    const pubC3 = await clientFor(await sessionFor(db(), publisher.userId));
    expect((await pubC3.call(A.list, { params: W, query: {} })).items).toHaveLength(0);
    const all = await owner.call(A.assignments, { params: { ...W, accountId: b.id }, query: { includeEnded: true } });
    expect(all[0]!.validTo).not.toBeNull();
  });

  it('bulk assign reports per-item results and skips accounts outside the actor’s scope', async () => {
    const { ws, project, W } = await baseSetup();
    const other = await createProject(db(), ws, { name: 'Other', type: 'influencer' });
    const owner = await clientFor(await sessionFor(db(), ws.owner.userId));
    const a1 = await owner.call(A.create, { params: W, body: createBody(project.id, ws.owner.membershipId, 'https://instagram.com/one_1') });
    const a2 = await owner.call(A.create, { params: W, body: createBody(project.id, ws.owner.membershipId, 'https://instagram.com/two_2') });
    const a3 = await owner.call(A.create, { params: W, body: createBody(other.id, ws.owner.membershipId, 'https://instagram.com/three_3') });
    const lead = await addMember(db(), ws, { roleKey: 'project_lead', scopeType: 'assigned_projects' });
    await assignToProject(db(), ws, project.id, lead.membershipId);
    const editor = await addMember(db(), ws, { roleKey: 'creator', scopeType: 'assigned_projects' });
    const leadC = await clientFor(await sessionFor(db(), lead.userId));
    const r = await leadC.call(A.bulkAssign, { params: W, body: { accountIds: [a1.id, a2.id, a3.id], membershipId: editor.membershipId, duty: 'editing' } });
    expect(r.succeeded).toBe(2);
    expect(r.failed).toBe(1);
    expect(r.results.find((x) => x.id === a3.id)?.code).toBe('NOT_FOUND');
  });
});
