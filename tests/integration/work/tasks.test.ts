import { afterEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { newIdempotencyKey } from '@castlane/api-client';
import { analyticsEndpoints, projectEndpoints, taskEndpoints as T } from '@castlane/api-contracts';
import { auditEvents, notifications, taskDependencies, tasks, taskStatusEvents } from '@castlane/database';
import { resetClock, setClock } from '../../support';
import { db, getTask, member, newTask, transition, workFixture } from './helpers';

afterEach(() => resetClock());

describe('task create/edit', () => {
  it('creates once per Idempotency-Key, defaults priority to Normal and requires If-Match on edits (T163, T164)', async () => {
    const f = await workFixture();
    const key = newIdempotencyKey();
    const body = { title: 'Storyboard episode 1', projectId: f.projectId };
    const a = await f.owner.call(T.create, { params: f.params, body }, { idempotencyKey: key });
    const b = await f.owner.call(T.create, { params: f.params, body }, { idempotencyKey: key });
    expect(b.id).toBe(a.id);
    expect(a.priority).toBe('normal');
    expect(a.status).toBe('backlog');
    expect(a.due).toBeNull();
    const rows = await db().select().from(tasks).where(eq(tasks.workspaceId, f.ws.workspaceId));
    expect(rows).toHaveLength(1);
    const mismatch = await f.owner.attempt(T.create, { params: f.params, body: { ...body, title: 'Different' } }, { idempotencyKey: key });
    expect(mismatch.status).toBe(409);
    expect(mismatch.code).toBe('IDEMPOTENCY_PAYLOAD_MISMATCH');
    // No second effect: still exactly the first task, unchanged.
    const after = await db().select().from(tasks).where(eq(tasks.workspaceId, f.ws.workspaceId));
    expect(after.map((r) => [r.id, r.title])).toEqual([[a.id, 'Storyboard episode 1']]);
    const missing = await f.owner.attempt(T.update, { params: { ...f.params, taskId: a.id }, body: { title: 'Renamed' } });
    expect(missing.status).toBe(428);
    const ok = await f.owner.call(T.update, { params: { ...f.params, taskId: a.id }, body: { title: 'Renamed' } }, { ifMatch: a.rowVersion });
    expect(ok.title).toBe('Renamed');
    const stale = await f.owner.attempt(T.update, { params: { ...f.params, taskId: a.id }, body: { title: 'Again' } }, { ifMatch: a.rowVersion });
    expect(stale.status).toBe(412);
    expect(stale.code).toBe('VERSION_CONFLICT');
  });

  it('validates title length, deadlines, reviewer ≠ assignee and linked records from the same project', async () => {
    const f = await workFixture();
    const short = await f.owner.attempt(T.create, { params: f.params, body: { title: 'ab', projectId: f.projectId } });
    expect(short.status).toBe(422);
    const bad = await f.owner.attempt(T.create, {
      params: f.params,
      body: { title: 'Dates', projectId: f.projectId, startAt: '2026-10-10T10:00:00Z', due: { kind: 'datetime', at: '2026-10-09T10:00:00Z' } },
    });
    expect(bad.status).toBe(422);
    const same = await f.owner.attempt(T.create, {
      params: f.params,
      body: { title: 'Same person', projectId: f.projectId, assigneeMembershipId: f.ws.owner.membershipId, reviewerMembershipId: f.ws.owner.membershipId },
    });
    expect(same.status).toBe(422);
    const other = await newTask(f.owner, f, { projectId: f.otherProjectId, title: 'Other project task' });
    const parentOther = await f.owner.attempt(T.create, { params: f.params, body: { title: 'Child', projectId: f.projectId, parentTaskId: other.id } });
    expect(parentOther.status).toBe(422);
  });

  it('a date-only deadline is the end of that day in the task zone and the same stored moment for everyone (T053)', async () => {
    const f = await workFixture();
    const t = await newTask(f.owner, f, { due: { kind: 'date', date: '2026-10-12', timezone: 'America/New_York' } });
    expect(t.due).toEqual({ at: '2026-10-13T03:59:59.999Z', date: '2026-10-12', timezone: 'America/New_York' });
    const viewer = await member(f, 'viewer');
    const seen = await getTask(viewer.client, f, t.id);
    expect(seen.due).toEqual(t.due);
    // Clearing the deadline is explicit; a task without deadline is never overdue (T052).
    const cleared = await f.owner.call(T.update, { params: { ...f.params, taskId: t.id }, body: { due: null } }, { ifMatch: t.rowVersion });
    expect(cleared.due).toBeNull();
    const soon = new Date(Date.now() + 3_600_000).toISOString();
    const dated = await newTask(f.owner, f, { title: 'Has a deadline', due: { kind: 'datetime', at: soon } });
    setClock(new Date(Date.now() + 2 * 3_600_000));
    const overdue = await f.owner.call(T.list, { params: f.params, query: { overdue: true } });
    expect(overdue.items.map((i) => i.id)).toEqual([dated.id]);
    expect((await getTask(f.owner, f, t.id)).overdue).toBe(false);
    expect((await getTask(f.owner, f, dated.id)).overdue).toBe(true);
  });

  it('keeps the baseline deadline and records revisions on reschedule', async () => {
    const f = await workFixture();
    const t = await newTask(f.owner, f, { status: 'ready', due: { kind: 'datetime', at: '2026-11-01T10:00:00Z' } });
    expect(t.baselineDueAt).toBe('2026-11-01T10:00:00.000Z');
    const moved = await f.owner.call(T.update, { params: { ...f.params, taskId: t.id }, body: { due: { kind: 'datetime', at: '2026-11-05T10:00:00Z' }, dueReason: 'Client delay' } }, { ifMatch: t.rowVersion });
    expect(moved.baselineDueAt).toBe('2026-11-01T10:00:00.000Z');
    expect(moved.due?.at).toBe('2026-11-05T10:00:00.000Z');
    expect(moved.dueRevisions.map((r) => r.revision)).toEqual([2, 1]);
    expect(moved.dueRevisions[0]!.reason).toBe('Client delay');
  });
});

describe('task access scope', () => {
  it('lists, counts and reads only tasks in scope; out-of-scope ids are 404; module without permission is 403', async () => {
    const f = await workFixture();
    const creator = await member(f, 'creator', { projects: [f.projectId] });
    const inScope = await newTask(f.owner, f, { title: 'Visible task' });
    const outScope = await newTask(f.owner, f, { projectId: f.otherProjectId, title: 'Hidden task' });
    const list = await creator.client.call(T.list, { params: f.params, query: {} });
    expect(list.items.map((i) => i.id)).toEqual([inScope.id]);
    const count = await creator.client.call(T.count, { params: f.params, query: {} });
    expect(count.count).toBe(1);
    const hidden = await creator.client.attempt(T.get, { params: { ...f.params, taskId: outScope.id } });
    expect(hidden.status).toBe(404);
    const editHidden = await creator.client.attempt(T.update, { params: { ...f.params, taskId: outScope.id }, body: { title: 'Nope nope' } }, { ifMatch: 1 });
    expect(editHidden.status).toBe(404);
    // Creators cannot assign other people.
    const assign = await creator.client.attempt(T.update, { params: { ...f.params, taskId: inScope.id }, body: { assigneeMembershipId: f.ws.owner.membershipId } }, { ifMatch: inScope.rowVersion });
    expect(assign.status).toBe(403);
    // ...but may take an unassigned task themselves.
    const take = await creator.client.call(T.update, { params: { ...f.params, taskId: inScope.id }, body: { assigneeMembershipId: creator.membershipId } }, { ifMatch: inScope.rowVersion });
    expect(take.assignee?.membershipId).toBe(creator.membershipId);
    const finance = await member(f, 'finance_manager');
    const denied = await finance.client.attempt(T.list, { params: f.params, query: {} });
    expect(denied.status).toBe(403);
  });

  it('a contractor requesting project detail gets no project payload, only the permitted task projection (T014)', async () => {
    const f = await workFixture();
    const contractor = await member(f, 'contractor');
    const mine = await newTask(f.owner, f, { title: 'Edit trailer', assigneeMembershipId: contractor.membershipId });
    await newTask(f.owner, f, { title: 'Internal task' });
    const list = await contractor.client.call(T.list, { params: f.params, query: {} });
    expect(list.items.map((i) => i.title)).toEqual(['Edit trailer']);
    const detail = await getTask(contractor.client, f, mine.id);
    expect(detail.project).toEqual({ id: f.projectId, name: 'Night Shift' });
    // The project of their own task: no detail, no list, no neighbouring project either.
    for (const projectId of [f.projectId, f.otherProjectId]) {
      const direct = await contractor.client.attempt(projectEndpoints.get, { params: { ...f.params, projectId } });
      expect(direct.ok).toBe(false);
      expect([403, 404]).toContain(direct.status);
      expect(direct.data).toBeNull();
    }
    const projectsList = await contractor.client.attempt(projectEndpoints.list, { params: f.params, query: {} });
    expect(projectsList.ok).toBe(false);
    expect(projectsList.status).toBe(403);
    // Control: the Owner's project detail carries the full payload the contractor does not get.
    const full = await f.owner.call(projectEndpoints.get, { params: { ...f.params, projectId: f.projectId } });
    expect(full.briefSummary).toBe('Test brief');
    expect(JSON.stringify(detail)).not.toContain('Test brief');
  });

  it('an assignee must be able to access the project; following never grants access', async () => {
    const f = await workFixture();
    const outsider = await member(f, 'creator', { projects: [f.otherProjectId] });
    const r = await f.owner.attempt(T.create, { params: f.params, body: { title: 'Assign outsider', projectId: f.projectId, assigneeMembershipId: outsider.membershipId } });
    expect(r.status).toBe(422);
    expect((r.error as { fieldErrors?: { field: string }[] } | null)?.fieldErrors?.[0]?.field).toBe('assigneeMembershipId');
    const t = await newTask(f.owner, f, { followerMembershipIds: [outsider.membershipId] });
    const following = await outsider.client.call(T.list, { params: f.params, query: { following: true } });
    expect(following.items.find((i) => i.id === t.id)).toBeUndefined();
    expect((await outsider.client.attempt(T.get, { params: { ...f.params, taskId: t.id } })).status).toBe(404);
  });
});

describe('task lifecycle', () => {
  it('Draft may be unassigned but starting work needs an assignee', async () => {
    const f = await workFixture();
    const t = await newTask(f.owner, f, { status: 'draft' });
    const start = await transition(f.owner, f, t, 'in_progress');
    expect(start.status).toBe(409);
    expect(start.error?.message).toBe('Assign an owner before starting this work.');
    const assigned = await f.owner.call(T.update, { params: { ...f.params, taskId: t.id }, body: { assigneeMembershipId: f.ws.owner.membershipId } }, { ifMatch: t.rowVersion });
    const started = await transition(f.owner, f, assigned, 'in_progress');
    expect(started.ok).toBe(true);
    expect(started.data?.status).toBe('in_progress');
  });

  it('start of a task with an unfinished predecessor is explained, or overridden by a lead with reason and audit (T049)', async () => {
    const f = await workFixture();
    const creator = await member(f, 'creator', { projects: [f.projectId] });
    const pred = await newTask(f.owner, f, { title: 'Write script', assigneeMembershipId: f.ws.owner.membershipId });
    const succ = await newTask(f.owner, f, { title: 'Generate scenes', assigneeMembershipId: creator.membershipId });
    await f.owner.call(T.addDependency, { params: { ...f.params, taskId: succ.id }, body: { predecessorId: pred.id } });
    const s1 = await getTask(creator.client, f, succ.id);
    const blocked = await transition(creator.client, f, s1, 'in_progress');
    expect(blocked.status).toBe(409);
    expect(blocked.error?.message).toContain('Write script');
    const denied = await transition(creator.client, f, s1, 'in_progress', { overrideDependencies: true, reason: 'Urgent client request' });
    expect(denied.status).toBe(403);
    const noReason = await transition(f.owner, f, s1, 'in_progress', { overrideDependencies: true });
    expect(noReason.status).toBe(422);
    const ok = await transition(f.owner, f, s1, 'in_progress', { overrideDependencies: true, reason: 'Urgent client request' });
    expect(ok.data?.status).toBe('in_progress');
    const [dep] = await db().select().from(taskDependencies).where(eq(taskDependencies.successorId, succ.id));
    expect(dep!.overrideReason).toBe('Urgent client request');
    const [a] = await db().select().from(auditEvents).where(and(eq(auditEvents.entityId, succ.id), eq(auditEvents.action, 'task.dependency_overridden')));
    expect(a?.reason).toBe('Urgent client request');
    expect((a?.metadata as { predecessors: { id: string }[] }).predecessors[0]!.id).toBe(pred.id);
  });

  it('rejects self-dependencies and cycles; the graph stays acyclic (T048)', async () => {
    const f = await workFixture();
    const a = await newTask(f.owner, f, { title: 'Task A' });
    const b = await newTask(f.owner, f, { title: 'Task B' });
    const c = await newTask(f.owner, f, { title: 'Task C' });
    const self = await f.owner.attempt(T.addDependency, { params: { ...f.params, taskId: a.id }, body: { predecessorId: a.id } });
    expect(self.status).toBe(422);
    await f.owner.call(T.addDependency, { params: { ...f.params, taskId: b.id }, body: { predecessorId: a.id } });
    await f.owner.call(T.addDependency, { params: { ...f.params, taskId: c.id }, body: { predecessorId: b.id } });
    const cycle = await f.owner.attempt(T.addDependency, { params: { ...f.params, taskId: a.id }, body: { predecessorId: c.id } });
    expect(cycle.status).toBe(409);
    expect(((cycle.error as { details?: unknown } | null)?.details as { cycle: unknown[] }).cycle).toHaveLength(4);
    // Concurrent opposite edges cannot both succeed.
    const d = await newTask(f.owner, f, { title: 'Task D' });
    const e = await newTask(f.owner, f, { title: 'Task E' });
    const [x, y] = await Promise.all([
      f.owner.attempt(T.addDependency, { params: { ...f.params, taskId: e.id }, body: { predecessorId: d.id } }),
      f.owner.attempt(T.addDependency, { params: { ...f.params, taskId: d.id }, body: { predecessorId: e.id } }),
    ]);
    expect([x.ok, y.ok].filter(Boolean)).toHaveLength(1);
    const dup = await f.owner.attempt(T.addDependency, { params: { ...f.params, taskId: b.id }, body: { predecessorId: a.id } });
    expect(dup.status).toBe(409);
  });

  it('completion is rejected while mandatory checklist items are open (T050)', async () => {
    const f = await workFixture();
    const t = await newTask(f.owner, f, { assigneeMembershipId: f.ws.owner.membershipId, checklist: [{ label: 'Upload final file', mandatory: true }, { label: 'Nice to have', mandatory: false }] });
    const started = (await transition(f.owner, f, t, 'in_progress')).data!;
    const done = await transition(f.owner, f, started, 'done');
    expect(done.status).toBe(409);
    expect(done.error?.message).toBe('Complete the mandatory checklist items first.');
    const item = started.checklistItems.find((i) => i.mandatory)!;
    await f.owner.call(T.updateChecklistItem, { params: { ...f.params, taskId: t.id, itemId: item.id }, body: { done: true } }, { ifMatch: item.rowVersion });
    const fresh = await getTask(f.owner, f, t.id);
    const ok = await transition(f.owner, f, fresh, 'done');
    expect(ok.data?.status).toBe('done');
    expect(ok.data?.completedBy?.membershipId).toBe(f.ws.owner.membershipId);
  });

  it('review policy: submit needs a reviewer; only the reviewer completes; the assignee cannot bypass review', async () => {
    const f = await workFixture();
    const creator = await member(f, 'creator', { projects: [f.projectId] });
    const lead = await member(f, 'project_lead', { projects: [f.projectId] });
    const t = await newTask(f.owner, f, { assigneeMembershipId: creator.membershipId, reviewerMembershipId: lead.membershipId });
    const started = (await transition(creator.client, f, t, 'in_progress')).data!;
    const bypass = await transition(creator.client, f, started, 'done');
    expect(bypass.status).toBe(409);
    const submitted = (await transition(creator.client, f, started, 'in_review')).data!;
    const [n] = await db().select().from(notifications).where(and(eq(notifications.recipientMembershipId, lead.membershipId), eq(notifications.eventType, 'task.review_requested')));
    expect(n?.entityId).toBe(t.id);
    const selfDone = await transition(creator.client, f, submitted, 'done');
    expect(selfDone.status).toBe(403);
    const changes = await transition(lead.client, f, submitted, 'in_progress');
    expect(changes.status).toBe(422);
    const approved = await transition(lead.client, f, submitted, 'done');
    expect(approved.data?.status).toBe('done');
  });

  it('reopen creates a new cycle event; the task is not counted again as a produced unit (T051)', async () => {
    const f = await workFixture();
    const t = await newTask(f.owner, f, { assigneeMembershipId: f.ws.owner.membershipId });
    let cur = (await transition(f.owner, f, t, 'in_progress')).data!;
    cur = (await transition(f.owner, f, cur, 'done')).data!;
    const noReason = await transition(f.owner, f, cur, 'in_progress');
    expect(noReason.status).toBe(422);
    cur = (await transition(f.owner, f, cur, 'in_progress', { reason: 'Colour grading was wrong' })).data!;
    expect(cur.reopenCount).toBe(1);
    expect(cur.cycle).toBe(2);
    expect(cur.completedAt).toBeNull();
    cur = (await transition(f.owner, f, cur, 'done')).data!;
    const events = await db().select().from(taskStatusEvents).where(eq(taskStatusEvents.taskId, t.id));
    const dones = events.filter((e) => e.toStatus === 'done');
    expect(dones.map((e) => e.cycle).sort()).toEqual([1, 2]);
    const reopen = events.find((e) => e.fromStatus === 'done');
    expect(reopen?.reason).toBe('Colour grading was wrong');
    expect(reopen?.cycle).toBe(2);

    // Delivery metrics count the task once (its last valid Done), not once per Done event; the
    // reopen is reported next to the count. A second task done once makes the total 2, not 3.
    const other = await newTask(f.owner, f, { title: 'Second deliverable', assigneeMembershipId: f.ws.owner.membershipId });
    let o = (await transition(f.owner, f, other, 'in_progress')).data!;
    o = (await transition(f.owner, f, o, 'done')).data!;
    const q = await f.owner.call(analyticsEndpoints.query, { params: f.params, body: { metrics: ['X02'], period: { preset: 'last_7_days' }, compare: false, filters: {}, groupBy: 'member' } });
    const completed = q.results.find((r) => r.metricId === 'X02')! as unknown as { total: { status: string; value: string | null; note?: string }; groups: { key: string | null; value: { value: string | null } }[] };
    expect(completed.total).toMatchObject({ status: 'known', value: '2', note: 'Reopened at least once: 1' });
    expect(completed.groups.map((g) => [g.key, g.value.value])).toEqual([[f.ws.owner.membershipId, '2']]);
    const doneEvents = await db().select().from(taskStatusEvents).where(and(eq(taskStatusEvents.workspaceId, f.ws.workspaceId), eq(taskStatusEvents.toStatus, 'done')));
    expect(doneEvents).toHaveLength(3);
  });

  it('a parent completes only when required subtasks are done or cancelled with an accepted reason', async () => {
    const f = await workFixture();
    const creator = await member(f, 'creator', { projects: [f.projectId] });
    const parent = await newTask(f.owner, f, { title: 'Episode 1', assigneeMembershipId: f.ws.owner.membershipId });
    const child = await f.owner.call(T.createSubtask, { params: { ...f.params, taskId: parent.id }, body: { title: 'Subtitles' } });
    expect(child.parent?.id).toBe(parent.id);
    let p = (await transition(f.owner, f, parent, 'in_progress')).data!;
    const blocked = await transition(f.owner, f, p, 'done');
    expect(blocked.status).toBe(409);
    // A cancellation by someone who is not a lead is not accepted automatically.
    await f.owner.call(T.update, { params: { ...f.params, taskId: child.id }, body: { assigneeMembershipId: creator.membershipId } }, { ifMatch: child.rowVersion });
    const childNow = await getTask(creator.client, f, child.id);
    const creatorCancel = await transition(creator.client, f, childNow, 'cancelled', { reason: 'Not needed' });
    expect(creatorCancel.status).toBe(403);
    const cancelled = (await transition(f.owner, f, childNow, 'cancelled', { reason: 'Subtitles are burnt in' })).data!;
    expect(cancelled.cancellationAccepted).toBe(true);
    p = await getTask(f.owner, f, parent.id);
    expect((await transition(f.owner, f, p, 'done')).data?.status).toBe('done');
  });

  it('cancelling a predecessor requires a choice for waiting tasks', async () => {
    const f = await workFixture();
    const a = await newTask(f.owner, f, { title: 'Record voice' });
    const b = await newTask(f.owner, f, { title: 'Mix audio' });
    await f.owner.call(T.addDependency, { params: { ...f.params, taskId: b.id }, body: { predecessorId: a.id } });
    const cur = await getTask(f.owner, f, a.id);
    const ask = await transition(f.owner, f, cur, 'cancelled', { reason: 'Voice dropped' });
    expect(ask.status).toBe(409);
    expect(((ask.error as { details?: unknown } | null)?.details as { needsSuccessorPolicy: boolean }).needsSuccessorPolicy).toBe(true);
    const ok = await transition(f.owner, f, cur, 'cancelled', { reason: 'Voice dropped', successorPolicy: 'remove_dependency' });
    expect(ok.data?.status).toBe('cancelled');
    const deps = await f.owner.call(T.dependencies, { params: { ...f.params, taskId: b.id } });
    expect(deps.predecessors).toHaveLength(0);
  });

  it('blocked flag with reason and interval, independent of status', async () => {
    const f = await workFixture();
    const t = await newTask(f.owner, f, { assigneeMembershipId: f.ws.owner.membershipId });
    const started = (await transition(f.owner, f, t, 'in_progress')).data!;
    const blocked = await f.owner.call(T.block, { params: { ...f.params, taskId: t.id }, body: { reason: 'Waiting for the client brief' } }, { ifMatch: started.rowVersion });
    expect(blocked.status).toBe('in_progress');
    expect(blocked.blocked?.reason).toBe('Waiting for the client brief');
    expect((await transition(f.owner, f, blocked, 'done')).status).toBe(409);
    const unblocked = await f.owner.call(T.unblock, { params: { ...f.params, taskId: t.id }, body: { resolution: 'Brief received' } }, { ifMatch: blocked.rowVersion });
    expect(unblocked.blocked).toBeNull();
    expect(unblocked.blockIntervals[0]!.resolution).toBe('Brief received');
  });

  it('reschedule preview pushes dependent tasks and applies atomically; a changed task invalidates the preview', async () => {
    const f = await workFixture();
    const a = await newTask(f.owner, f, { title: 'Script', due: { kind: 'datetime', at: '2026-11-02T17:00:00Z' } });
    const b = await newTask(f.owner, f, { title: 'Shoot', startAt: '2026-11-03T09:00:00Z', due: { kind: 'date', date: '2026-11-04', timezone: 'Europe/Berlin' } });
    await f.owner.call(T.addDependency, { params: { ...f.params, taskId: b.id }, body: { predecessorId: a.id } });
    const preview = await f.owner.call(T.reschedulePreview, { params: { ...f.params, taskId: a.id }, body: { due: { kind: 'datetime', at: '2026-11-05T17:00:00Z' }, propagate: true } });
    const pushed = preview.changes.find((c) => c.task.id === b.id)!;
    // A date-only task moves by whole calendar days (its start keeps the time of day).
    expect(pushed.toStart).toBe('2026-11-06T09:00:00.000Z');
    expect(pushed.toDue).toBe('2026-11-07T22:59:59.999Z');
    const aNow = await getTask(f.owner, f, a.id);
    const applied = await f.owner.call(T.reschedule, { params: { ...f.params, taskId: a.id }, body: { previewToken: preview.token, applyTaskIds: [b.id], reason: 'Script rewrite' } }, { ifMatch: aNow.rowVersion });
    expect(applied.due?.at).toBe('2026-11-05T17:00:00.000Z');
    const bNow = await getTask(f.owner, f, b.id);
    expect(bNow.due?.date).toBe('2026-11-07');
    // Stale preview after a concurrent change.
    const p2 = await f.owner.call(T.reschedulePreview, { params: { ...f.params, taskId: a.id }, body: { due: { kind: 'datetime', at: '2026-11-08T17:00:00Z' }, propagate: true } });
    await f.owner.call(T.update, { params: { ...f.params, taskId: b.id }, body: { title: 'Shoot day' } }, { ifMatch: bNow.rowVersion });
    const a2 = await getTask(f.owner, f, a.id);
    const stale = await f.owner.attempt(T.reschedule, { params: { ...f.params, taskId: a.id }, body: { previewToken: p2.token, applyTaskIds: [b.id] } }, { ifMatch: a2.rowVersion });
    expect(stale.status).toBe(409);
    expect((await getTask(f.owner, f, a.id)).due?.at).toBe('2026-11-05T17:00:00.000Z');
  });
});

describe('bulk actions', () => {
  it('previews per item (Select All Matching with expected count), applies per item and reports failures', async () => {
    const f = await workFixture();
    const lead = await member(f, 'project_lead', { projects: [f.projectId] });
    const t1 = await newTask(f.owner, f, { title: 'Bulk one', tags: ['batch'] });
    const t2 = await newTask(f.owner, f, { title: 'Bulk two', tags: ['batch'] });
    const hidden = await newTask(f.owner, f, { title: 'Bulk hidden', projectId: f.otherProjectId, tags: ['batch'] });
    const wrongCount = await lead.client.attempt(T.bulkPreview, { params: f.params, body: { selection: { filter: { tag: 'batch' }, expectedCount: 3 }, change: { action: 'priority', priority: 'high' } } });
    expect(wrongCount.status).toBe(409);
    const preview = await lead.client.call(T.bulkPreview, { params: f.params, body: { selection: { filter: { tag: 'batch' }, expectedCount: 2 }, change: { action: 'priority', priority: 'high' } } });
    expect(preview.items.map((i) => i.id).sort()).toEqual([t1.id, t2.id].sort());
    expect(preview.items.some((i) => i.id === hidden.id)).toBe(false);
    // One task changes in between: it fails alone, the other succeeds.
    await f.owner.call(T.update, { params: { ...f.params, taskId: t2.id }, body: { title: 'Bulk two changed' } }, { ifMatch: t2.rowVersion });
    const applied = await lead.client.call(T.bulkApply, { params: f.params, body: { previewToken: preview.token } });
    expect(applied.succeeded).toBe(1);
    expect(applied.failed).toBe(1);
    expect(applied.results.find((r) => r.id === t2.id)?.code).toBe('CONFLICT');
    expect((await getTask(f.owner, f, t1.id)).priority).toBe('high');
    expect((await getTask(f.owner, f, t2.id)).priority).toBe('normal');
  });
});

describe('search, lookup and activity', () => {
  it('indexes tasks for permission-aware search and records meaningful history', async () => {
    const f = await workFixture();
    const t = await newTask(f.owner, f, { title: 'Colour grading pass' });
    const creator = await member(f, 'creator', { projects: [f.otherProjectId] });
    const { shellEndpoints, lookupEndpoints } = await import('@castlane/api-contracts');
    const found = await f.owner.call(shellEndpoints.search, { params: f.params, query: { q: 'grading' } });
    expect(found.results.map((r) => r.entityId)).toContain(t.id);
    const notFound = await creator.client.call(shellEndpoints.search, { params: f.params, query: { q: 'grading' } });
    expect(notFound.results).toHaveLength(0);
    const lookup = await f.owner.call(lookupEndpoints.search, { params: { ...f.params, type: 'task' }, query: { q: 'colour' } });
    expect(lookup.items[0]?.id).toBe(t.id);
    const activity = await f.owner.call(T.activity, { params: { ...f.params, taskId: t.id }, query: {} });
    expect(activity.items.map((a) => a.action)).toContain('task.created');
  });
});
