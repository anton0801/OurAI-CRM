import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { commentEndpoints as C } from '@castlane/api-contracts';
import { auditEvents, commentRevisions, notifications } from '@castlane/database';
import { db, member, newTask, workFixture } from './helpers';

describe('comments on tasks', () => {
  it('threads with depth ≤ 2, mentions only members who can read the task, append-only edits, resolve/reopen and soft delete', async () => {
    const f = await workFixture();
    const creator = await member(f, 'creator', { projects: [f.projectId] });
    const outsider = await member(f, 'creator', { projects: [f.otherProjectId] });
    const viewer = await member(f, 'viewer');
    const t = await newTask(f.owner, f, { title: 'Cut the trailer', assigneeMembershipId: creator.membershipId });
    const params = f.params;
    const root = await f.owner.call(C.create, { params, body: { parentType: 'task', parentId: t.id, body: 'Please use the second take @Casey', mentions: [creator.membershipId] } });
    expect(root.depth).toBe(0);
    const [mention] = await db().select().from(notifications).where(and(eq(notifications.recipientMembershipId, creator.membershipId), eq(notifications.eventType, 'comment.mention')));
    expect(mention?.entityType).toBe('task');
    expect(mention?.entityId).toBe(t.id);
    // Mentioning someone who cannot see the task is refused (no leak through the Inbox).
    const leak = await f.owner.attempt(C.create, { params, body: { parentType: 'task', parentId: t.id, body: 'FYI', mentions: [outsider.membershipId] } });
    expect(leak.status).toBe(422);
    const r1 = await creator.client.call(C.create, { params, body: { parentType: 'task', parentId: t.id, body: 'Done, check v2', replyToId: root.id } });
    const r2 = await f.owner.call(C.create, { params, body: { parentType: 'task', parentId: t.id, body: 'Looks good', replyToId: r1.id } });
    expect(r2.depth).toBe(2);
    expect(r2.threadRootId).toBe(root.id);
    const tooDeep = await creator.client.attempt(C.create, { params, body: { parentType: 'task', parentId: t.id, body: 'Too deep', replyToId: r2.id } });
    expect(tooDeep.status).toBe(422);
    // Viewers read but cannot comment; outsiders cannot even read.
    expect((await viewer.client.call(C.list, { params, query: { parentType: 'task', parentId: t.id } })).threads).toHaveLength(1);
    expect((await viewer.client.attempt(C.create, { params, body: { parentType: 'task', parentId: t.id, body: 'hello' } })).status).toBe(403);
    expect((await outsider.client.attempt(C.list, { params, query: { parentType: 'task', parentId: t.id } })).status).toBe(404);
    // Only the author edits; the old text is kept.
    const notMine = await creator.client.attempt(C.update, { params: { ...params, commentId: root.id }, body: { body: 'Hijack' } }, { ifMatch: root.rowVersion });
    expect(notMine.status).toBe(403);
    const edited = await f.owner.call(C.update, { params: { ...params, commentId: root.id }, body: { body: 'Please use the third take' } }, { ifMatch: root.rowVersion });
    expect(edited.editedAt).not.toBeNull();
    const revisions = await db().select().from(commentRevisions).where(eq(commentRevisions.commentId, root.id));
    expect(revisions.map((r) => r.previousBody)).toEqual(['Please use the second take @Casey']);
    const history = await creator.client.call(C.revisions, { params: { ...params, commentId: root.id } });
    expect(history).toHaveLength(1);
    // Replies cannot be resolved; the thread root can; reopening needs a reason.
    expect((await f.owner.attempt(C.resolve, { params: { ...params, commentId: r1.id }, body: {} }, { ifMatch: r1.rowVersion })).status).toBe(409);
    const resolved = await creator.client.call(C.resolve, { params: { ...params, commentId: root.id }, body: { resolutionNote: 'Fixed in v3' } }, { ifMatch: edited.rowVersion });
    expect(resolved.state).toBe('resolved');
    const reopened = await f.owner.call(C.reopen, { params: { ...params, commentId: root.id }, body: { reason: 'The colour is still off' } }, { ifMatch: resolved.rowVersion });
    expect(reopened.state).toBe('reopened');
    // Soft delete: text hidden, fact kept; the audit has no body text.
    const removed = await creator.client.call(C.remove, { params: { ...params, commentId: r1.id }, body: {} }, { ifMatch: r1.rowVersion });
    expect(removed.removed).toBe(true);
    expect(removed.body).toBeNull();
    const list = await f.owner.call(C.list, { params, query: { parentType: 'task', parentId: t.id } });
    expect(list.threads[0]!.replies.find((r) => r.id === r1.id)?.body).toBeNull();
    const audits = await db().select().from(auditEvents).where(and(eq(auditEvents.entityId, t.id), eq(auditEvents.action, 'comment.created')));
    expect(JSON.stringify(audits)).not.toContain('second take');
  });

  it('unknown parent types are rejected; review-only fields are refused on tasks', async () => {
    const f = await workFixture();
    const t = await newTask(f.owner, f);
    const unknown = await f.owner.attempt(C.create, { params: f.params, body: { parentType: 'unknown_thing', parentId: t.id, body: 'x' } });
    expect(unknown.status).toBe(422);
    const blocking = await f.owner.attempt(C.create, { params: f.params, body: { parentType: 'task', parentId: t.id, body: 'x', severity: 'blocking' } });
    expect(blocking.status).toBe(422);
    const annotated = await f.owner.attempt(C.create, { params: f.params, body: { parentType: 'task', parentId: t.id, body: 'x', timecodeMs: 1000 } });
    expect(annotated.status).toBe(422);
  });
});
