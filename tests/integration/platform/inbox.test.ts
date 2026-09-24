import { afterEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { newIdempotencyKey } from '@castlane/api-client';
import { inboxEndpoints, projectEndpoints, shellEndpoints } from '@castlane/api-contracts';
import { getAppServices } from '@castlane/application';
import { jobs, notifications, projectMemberships } from '@castlane/database';
import { addMember, assignToProject, clientFor, createProject, createWorkspace, resetClock, runQueuedJobs, sessionFor, setClock } from '../../support';
import { db, sendNotification, setPrefs } from './helpers';

const setup = async () => {
  const ws = await createWorkspace(db());
  const { id: projectId } = await createProject(db(), ws, { name: 'Night Shift' });
  const lead = await addMember(db(), ws, { roleKey: 'project_lead', scopeType: 'assigned_projects' });
  await assignToProject(db(), ws, projectId, lead.membershipId);
  const client = await clientFor(await sessionFor(db(), lead.userId));
  return { ws, projectId, lead, client, params: { workspaceId: ws.workspaceId } };
};

const note = (ws: { workspaceId: string }, recipient: string, key: string, extra: Record<string, unknown> = {}) =>
  sendNotification({ workspaceId: ws.workspaceId, recipientMembershipIds: [recipient], eventType: 'review.requested', eventKey: key, kind: 'review_request', title: 'Review requested', excerpt: 'Episode 3 cut is ready', ...extra });

afterEach(() => resetClock());

describe('inbox (S10)', () => {
  it('lists only own notifications per view and never inflates unread on repeated events', async () => {
    const { ws, lead, client, params, projectId } = await setup();
    const other = await addMember(db(), ws, { roleKey: 'creator', scopeType: 'assigned_projects' });
    await note(ws, lead.membershipId, 'review:1', { entityType: 'project', entityId: projectId, projectId });
    await note(ws, lead.membershipId, 'review:1', { entityType: 'project', entityId: projectId, projectId });
    await note(ws, other.membershipId, 'review:2');
    const unread = await client.call(inboxEndpoints.list, { params, query: { view: 'unread' } });
    expect(unread.items).toHaveLength(1);
    expect(unread.items[0]!.excerpt).toBe('Episode 3 cut is ready');
    expect(unread.items[0]!.href).toBe(`/w/${ws.workspaceId}/projects/${projectId}`);
    expect((await client.call(shellEndpoints.unreadCount, { params })).unread).toBe(1);

    // Another member's notification is not found (no existence leak).
    const [foreign] = await db().select().from(notifications).where(eq(notifications.recipientMembershipId, other.membershipId));
    const r = await client.attempt(inboxEndpoints.setRead, { params: { ...params, notificationId: foreign!.id }, body: { read: true } });
    expect(r.status).toBe(404);
  });

  it('marks read/unread and archives; reading does not complete the underlying work', async () => {
    const { ws, lead, client, params } = await setup();
    await note(ws, lead.membershipId, 'review:10');
    const [n] = (await client.call(inboxEndpoints.list, { params, query: {} })).items;
    const key = newIdempotencyKey();
    const read = await client.call(inboxEndpoints.setRead, { params: { ...params, notificationId: n!.id }, body: { read: true } }, { idempotencyKey: key });
    expect(read.readAt).not.toBeNull();
    // Idempotent replay returns the same result.
    const replay = await client.call(inboxEndpoints.setRead, { params: { ...params, notificationId: n!.id }, body: { read: true } }, { idempotencyKey: key });
    expect(replay.readAt).toBe(read.readAt);
    expect((await client.call(inboxEndpoints.list, { params, query: { view: 'unread' } })).items).toHaveLength(0);
    expect((await client.call(inboxEndpoints.list, { params, query: { view: 'all' } })).items).toHaveLength(1);
    await client.call(inboxEndpoints.setRead, { params: { ...params, notificationId: n!.id }, body: { read: false } });
    expect((await client.call(shellEndpoints.unreadCount, { params })).unread).toBe(1);
    const archived = await client.call(inboxEndpoints.setArchived, { params: { ...params, notificationId: n!.id }, body: { archived: true } });
    expect(archived.archivedAt).not.toBeNull();
    expect((await client.call(inboxEndpoints.list, { params, query: { view: 'archived' } })).items.map((i) => i.id)).toEqual([n!.id]);
    expect((await client.call(inboxEndpoints.list, { params, query: { view: 'all' } })).items).toHaveLength(0);
  });

  it('Mark All Read covers the previewed filter only; later arrivals stay unread', async () => {
    const { ws, lead, client, params, projectId } = await setup();
    const t0 = Date.now();
    setClock(new Date(t0));
    await note(ws, lead.membershipId, 'a', { projectId });
    await note(ws, lead.membershipId, 'b', { projectId });
    await sendNotification({ workspaceId: ws.workspaceId, recipientMembershipIds: [lead.membershipId], eventType: 'task.assigned', eventKey: 'c', kind: 'assignment', title: 'Task assigned' });
    const preview = await client.call(inboxEndpoints.markReadPreview, { params, body: { eventType: 'review.requested' } });
    expect(preview.count).toBe(2);
    setClock(new Date(t0 + 5 * 60_000));
    await note(ws, lead.membershipId, 'd', { projectId });
    const done = await client.call(inboxEndpoints.markRead, { params, body: { eventType: 'review.requested', asOf: preview.asOf } });
    expect(done.updated).toBe(2);
    const unread = await client.call(inboxEndpoints.list, { params, query: { view: 'unread' } });
    expect(unread.items.map((i) => i.eventType).sort()).toEqual(['review.requested', 'task.assigned']);
    const facets = await client.call(inboxEndpoints.facets, { params });
    expect(facets.eventTypes.find((f) => f.eventType === 'review.requested')?.unread).toBe(1);
    expect(facets.projects.map((p) => p.id)).toEqual([projectId]);
  });

  it('removes the excerpt when access to the object was revoked', async () => {
    const { ws, lead, client, params, projectId } = await setup();
    await note(ws, lead.membershipId, 'r1', { entityType: 'project', entityId: projectId, projectId });
    await db().delete(projectMemberships).where(and(eq(projectMemberships.projectId, projectId), eq(projectMemberships.membershipId, lead.membershipId)));
    const again = await clientFor(await sessionFor(db(), lead.userId));
    const [item] = (await again.call(inboxEndpoints.list, { params, query: {} })).items;
    expect(item!.accessRevoked).toBe(true);
    expect(item!.excerpt).toBeNull();
    expect(item!.title).toBe('Review requested');
    const facets = await again.call(inboxEndpoints.facets, { params });
    expect(facets.projects).toHaveLength(0);
    void client;
  });

  it('keeps the excerpt of a project-level notice for a member who can read the project', async () => {
    const ws = await createWorkspace(db());
    const owner = await clientFor(await sessionFor(db(), ws.owner.userId));
    const p = await owner.call(projectEndpoints.create, { params: { workspaceId: ws.workspaceId }, body: { name: 'Indexed', type: 'series', directionId: (await createProject(db(), ws, {})).directionId, ownerMembershipId: ws.owner.membershipId } });
    const admin = await addMember(db(), ws, { roleKey: 'admin' });
    await sendNotification({ workspaceId: ws.workspaceId, recipientMembershipIds: [admin.membershipId], eventType: 'project.shared', eventKey: 's1', kind: 'general', title: 'Project shared', excerpt: 'Have a look', entityType: 'project', entityId: p.id, projectId: p.id });
    const c = await clientFor(await sessionFor(db(), admin.userId));
    const [item] = (await c.call(inboxEndpoints.list, { params: { workspaceId: ws.workspaceId }, query: {} })).items;
    expect(item!.excerpt).toBe('Have a look');
    expect(item!.accessRevoked).toBe(false);
  });
});

describe('quiet hours and digest (T144)', () => {
  it('creates the inbox record immediately, defers ordinary e-mail and never defers security alerts', async () => {
    const { ws, lead } = await setup();
    await setPrefs(lead.userId, { timezone: 'Europe/Berlin', notifications: { mentions: true, assignments: true, reviewRequests: true, dueReminders: true, emailImmediate: true, dailyDigest: false } });
    const at = new Date('2026-10-01T21:30:00Z'); // 23:30 in Berlin, inside 22:00–08:00
    await sendNotification({ workspaceId: ws.workspaceId, recipientMembershipIds: [lead.membershipId], eventType: 'task.assigned', eventKey: 'qa1', kind: 'assignment', title: 'Task assigned', at });
    await sendNotification({ workspaceId: ws.workspaceId, recipientMembershipIds: [lead.membershipId], eventType: 'security.new_sign_in', eventKey: 'sec1', kind: 'security', title: 'New sign-in', at });
    const inbox = await db().select().from(notifications).where(eq(notifications.recipientMembershipId, lead.membershipId));
    expect(inbox).toHaveLength(2);
    const mails = await db().select().from(jobs).where(and(eq(jobs.workspaceId, ws.workspaceId), eq(jobs.type, 'mail.notification')));
    const byKey = new Map(mails.map((j) => [j.idempotencyKey, j]));
    expect(byKey.get(`mail.notification:qa1:${lead.membershipId}`)!.runAt.toISOString()).toBe('2026-10-02T06:00:00.000Z');
    expect(byKey.get(`mail.notification:sec1:${lead.membershipId}`)!.runAt.toISOString()).toBe(at.toISOString());
  });

  it('sends the opted-in daily digest once per local day, after quiet hours, with a count only', async () => {
    const { ws, lead } = await setup();
    await setPrefs(lead.userId, { timezone: 'Europe/Berlin', notifications: { mentions: true, assignments: true, reviewRequests: true, dueReminders: true, emailImmediate: false, dailyDigest: true } });
    setClock('2026-10-01T21:00:00Z');
    await note(ws, lead.membershipId, 'dg1');
    await note(ws, lead.membershipId, 'dg2');
    await runQueuedJobs(['__none__']);
    const run = async () => {
      const def = (await import('@castlane/application')).JOB_DEFINITIONS.get('notifications.digest')!;
      return def.handler({ app: getAppServices(), job: { id: 'x', type: 'notifications.digest', workspaceId: null, payload: {}, attempts: 1, causation: null, requestedBy: null }, heartbeat: async () => {}, cancelled: async () => false });
    };
    expect(await run()).toMatchObject({ queued: 0 }); // 23:00 local — quiet hours
    setClock('2026-10-02T06:30:00Z'); // 08:30 local
    expect(await run()).toMatchObject({ queued: 1 });
    expect(await run()).toMatchObject({ queued: 0 });
    const [mail] = await db().select().from(jobs).where(and(eq(jobs.workspaceId, ws.workspaceId), eq(jobs.type, 'mail.send')));
    const payload = mail!.payload as { template: string; vars: Record<string, unknown> };
    expect(payload.template).toBe('digest');
    expect(payload.vars.count).toBe(2);
    expect(JSON.stringify(payload)).not.toContain('Episode 3');
  });
});
