import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  commentEndpoints as C,
  exportEndpoints as X,
  taskEndpoints as T,
  timeEndpoints as TE,
} from '@castlane/api-contracts';
import { getAppServices, setAppServices, type AppServices } from '@castlane/application';
import { createDatabase, type DatabaseHandle } from '@castlane/database';
import { member, newTask, workFixture, type WorkFixture } from './helpers';

/**
 * T170 (load profile): a write transaction must never wait for a second pool connection. Under
 * concurrent writes that pattern exhausts the pool — every connection is held by a transaction
 * that waits for another one — and the web process hangs. The critical writes of the load profile
 * run here with a single-connection pool: any query issued on the pool instead of the open
 * transaction cannot get a connection and fails.
 */
describe('critical writes hold one connection (pool safety, T170)', () => {
  let original: AppServices;
  let single: DatabaseHandle;
  let f: WorkFixture;
  let creator: Awaited<ReturnType<typeof member>>;

  beforeAll(async () => {
    f = await workFixture();
    creator = await member(f, 'creator', { projects: [f.projectId] });
    original = getAppServices();
    single = createDatabase(process.env.DATABASE_URL!, { max: 1, acquireTimeoutMs: 2000 });
    setAppServices({ ...original, db: single.db });
  });

  afterAll(async () => {
    setAppServices(original);
    await single.close();
  });

  it('create/transition a task, comment with watchers, log time and request an export on one connection', async () => {
    const params = f.params;
    // Assignee and reviewer checks (memberCan for another member) run inside the create transaction.
    const task = await newTask(f.owner, f, {
      title: 'Pool safety',
      status: 'ready',
      assigneeMembershipId: creator.membershipId,
      reviewerMembershipId: f.ws.owner.membershipId,
    });
    const started = await creator.client.call(
      T.transition,
      { params: { ...params, taskId: task.id }, body: { targetState: 'in_progress' } },
      { ifMatch: task.rowVersion },
    );
    expect(started.status).toBe('in_progress');
    // Watchers of the task (assignee, reviewer) are checked for read access before they are notified.
    const c = await f.owner.call(C.create, {
      params,
      body: {
        parentType: 'task',
        parentId: task.id,
        body: 'Looks good so far',
        mentions: [creator.membershipId],
      },
    });
    expect(c.id).toBeTruthy();
    const reply = await creator.client.call(C.create, {
      params,
      body: { parentType: 'task', parentId: task.id, body: 'Thanks', replyToId: c.id },
    });
    expect(reply.depth).toBe(1);
    const entry = await creator.client.call(TE.create, {
      params,
      body: { taskId: task.id, durationMinutes: 30 },
    });
    expect(entry.id).toBeTruthy();
    const job = await f.owner.call(X.create, {
      params,
      body: {
        dataset: 'tasks',
        format: 'csv',
        fields: ['id', 'title', 'status'],
        filters: { projectId: f.projectId },
      },
    });
    expect(job.id).toBeTruthy();
    const updated = await f.owner.call(
      T.update,
      {
        params: { ...params, taskId: task.id },
        body: { reviewerMembershipId: null, assigneeMembershipId: f.ws.owner.membershipId },
      },
      { ifMatch: started.rowVersion },
    );
    expect(updated.assignee?.membershipId).toBe(f.ws.owner.membershipId);
  });
});
