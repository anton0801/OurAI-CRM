import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { taskEndpoints as T, timeEndpoints as TM } from '@castlane/api-contracts';
import {
  ARCHIVE_HANDLERS,
  EXPORT_DATASETS_REGISTRY,
  IMPORT_DATASETS_REGISTRY,
  RESPONSIBILITY_PROVIDERS,
  executeCommand,
  getAppServices,
  loadAccessSnapshot,
  type QueryContext,
} from '@castlane/application';
import { tasks, timeEntries } from '@castlane/database';
import { db, member, newTask, transition, workFixture, type WorkFixture } from './helpers';

const ctxFor = async (f: WorkFixture, userId: string, membershipId: string): Promise<QueryContext> => {
  const app = getAppServices();
  const access = (await loadAccessSnapshot(app.db, f.ws.workspaceId, userId, app.clock.now()))!;
  return {
    app,
    actor: { kind: 'user', userId, membershipId, workspaceId: f.ws.workspaceId, displayName: 'Test', access, timezone: 'Europe/Berlin' },
    request: { requestId: 'test', source: 'import' },
  };
};

describe('import dataset: tasks', () => {
  it('validates references without auto-creating anything and applies rows as tasks', async () => {
    const f = await workFixture();
    const ds = IMPORT_DATASETS_REGISTRY.get('tasks')!;
    const ctx = await ctxFor(f, f.ws.owner.userId, f.ws.owner.membershipId);
    const bad = await ds.validate(ctx, { title: 'Imported task', project: 'No such project', assignee: 'nobody@test.invalid' }, { duplicatePolicy: 'skip', rowNo: 1 });
    expect(bad.errors.map((e) => e.field).sort()).toEqual(['assignee', 'project']);
    const good = await ds.validate(ctx, { title: 'Imported task', project: 'Night Shift', assignee: f.ws.owner.email, due_date: '2026-12-01', estimate_minutes: '' }, { duplicatePolicy: 'skip', rowNo: 2 });
    expect(good.errors).toEqual([]);
    expect(good.warnings.map((w) => w.code)).toContain('UNESTIMATED');
    const id = await executeCommand(ctx, (c) => ds.apply(c, good.normalized, { action: 'create' })).then((r) => r.body);
    const [row] = await db().select().from(tasks).where(eq(tasks.id, id));
    expect(row!.source).toBe('import');
    expect(row!.dueDate).toBe('2026-12-01');
    const dup = await ds.validate(ctx, { title: 'Imported task', project: 'Night Shift' }, { duplicatePolicy: 'error', rowNo: 3 });
    expect(dup.errors.map((e) => e.code)).toContain('DUPLICATE');
    // Undo only while untouched.
    await executeCommand(ctx, (c) => ds.undo!(c, id));
    const [trashed] = await db().select().from(tasks).where(eq(tasks.id, id));
    expect(trashed!.deletedAt).not.toBeNull();
  });
});

describe('export datasets', () => {
  it('exports only tasks and time the requester may read, bounded by the snapshot time', async () => {
    const f = await workFixture();
    const creator = await member(f, 'creator', { projects: [f.projectId] });
    await newTask(f.owner, f, { title: 'In scope', assigneeMembershipId: creator.membershipId });
    await newTask(f.owner, f, { title: 'Out of scope', projectId: f.otherProjectId });
    const ctx = await ctxFor(f, creator.userId, creator.membershipId);
    const rows: Record<string, unknown>[] = [];
    for await (const r of EXPORT_DATASETS_REGISTRY.get('tasks')!.rows(ctx, { filters: {}, boundAt: new Date(Date.now() + 1000), fields: [] })) rows.push(r);
    expect(rows.map((r) => r.title)).toEqual(['In scope']);
    const t = (await creator.client.call(T.list, { params: f.params, query: {} })).items[0]!;
    await creator.client.call(TM.create, { params: f.params, body: { taskId: t.id, durationMinutes: 45 } });
    const time: Record<string, unknown>[] = [];
    for await (const r of EXPORT_DATASETS_REGISTRY.get('time_entries')!.rows(ctx, { filters: {}, boundAt: new Date(Date.now() + 1000), fields: [] })) time.push(r);
    expect(time).toHaveLength(1);
    expect(time[0]!.duration_minutes).toBe(45);
    expect('billable' in time[0]!).toBe(false);
  });
});

describe('responsibilities (F12)', () => {
  it('lists open assignments, reviews, pending sheet approvals and running timers; transfer reassigns without rewriting history', async () => {
    const f = await workFixture();
    const leaving = await member(f, 'creator', { projects: [f.projectId] });
    const successor = await member(f, 'creator', { projects: [f.projectId] });
    const inProgress = await newTask(f.owner, f, { title: 'Half done', assigneeMembershipId: leaving.membershipId });
    const started = (await transition(leaving.client, f, inProgress, 'in_progress')).data!;
    const other = await newTask(f.owner, f, { title: 'Not started', assigneeMembershipId: leaving.membershipId });
    await leaving.client.call(TM.startTimer, { params: f.params, body: { taskId: other.id } });
    const ctx = await ctxFor(f, f.ws.owner.userId, f.ws.owner.membershipId);
    const assigned = await RESPONSIBILITY_PROVIDERS.get('tasks.assignee')!.list(ctx, leaving.membershipId);
    expect(assigned.map((a) => a.title).sort()).toEqual(['Half done', 'Not started']);
    const timers = await RESPONSIBILITY_PROVIDERS.get('time.running_timer')!.list(ctx, leaving.membershipId);
    expect(timers).toHaveLength(1);
    await executeCommand(ctx, async (c) => {
      await RESPONSIBILITY_PROVIDERS.get('tasks.assignee')!.transfer(c, leaving.membershipId, [
        { entityId: started.id, successorMembershipId: null },
        { entityId: other.id, successorMembershipId: successor.membershipId },
      ]);
      await RESPONSIBILITY_PROVIDERS.get('time.running_timer')!.transfer(c, leaving.membershipId, timers.map((t) => ({ entityId: t.entityId, successorMembershipId: null })));
    });
    const [a] = await db().select().from(tasks).where(eq(tasks.id, started.id));
    expect(a!.assigneeMembershipId).toBeNull();
    expect(a!.status).toBe('ready');
    const [b] = await db().select().from(tasks).where(eq(tasks.id, other.id));
    expect(b!.assigneeMembershipId).toBe(successor.membershipId);
    const entries = await db().select().from(timeEntries).where(eq(timeEntries.membershipId, leaving.membershipId));
    expect(entries[0]!.state).toBe('needs_review');
  });
});

describe('archive and trash', () => {
  it('only closed tasks are archived; only untouched drafts go to the trash', async () => {
    const f = await workFixture();
    const handler = ARCHIVE_HANDLERS.get('task')!;
    const ctx = await ctxFor(f, f.ws.owner.userId, f.ws.owner.membershipId);
    const open = await newTask(f.owner, f, { title: 'Open task', assigneeMembershipId: f.ws.owner.membershipId });
    const preview = await handler.preview(ctx, open.id);
    expect(preview.items.find((i) => i.kind === 'open_task')?.blocking).toBe(true);
    await expect(executeCommand(ctx, (c) => handler.archive(c, open.id, {}))).rejects.toMatchObject({ code: 'INVALID_STATE' });
    const s = (await transition(f.owner, f, open, 'in_progress')).data!;
    await transition(f.owner, f, s, 'done');
    await executeCommand(ctx, (c) => handler.archive(c, open.id, { reason: 'Season wrapped' }));
    const list = await f.owner.call(T.list, { params: f.params, query: { includeClosed: true } });
    expect(list.items.some((i) => i.id === open.id)).toBe(false);
    const draft = await newTask(f.owner, f, { title: 'Draft idea', status: 'draft' });
    await executeCommand(ctx, (c) => handler.trash!(c, draft.id, 'Duplicate idea'));
    expect((await f.owner.attempt(T.get, { params: { ...f.params, taskId: draft.id } })).status).toBe(404);
    await executeCommand(ctx, (c) => handler.restore!(c, draft.id, {}));
    expect((await f.owner.call(T.get, { params: { ...f.params, taskId: draft.id } })).title).toBe('Draft idea');
  });
});
