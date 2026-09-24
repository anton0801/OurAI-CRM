import { beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { archiveEndpoints, projectEndpoints } from '@castlane/api-contracts';
import { authorizeObject, defineArchiveHandler, getAppServices, lockById, runRetention, touch } from '@castlane/application';
import { deletionTombstones, directions, projects, sessions } from '@castlane/database';
import { AppError, normalizeKey } from '@castlane/domain';
import { addMember, clientFor, createDirection, createWorkspace, runQueuedJobs, sessionFor, setClock, resetClock } from '../../support';
import { db } from './helpers';

/**
 * Test handler for directions: restoring an archived direction whose name is now taken by an active
 * one collides with the real unique index (directions_active_name_uq) and needs a rename (T155).
 */
beforeAll(() => {
  defineArchiveHandler({
    entityType: 'direction',
    label: 'Direction',
    preview: async (ctx, id) => {
      const [d] = await ctx.app.db.select().from(directions).where(and(eq(directions.workspaceId, ctx.actor.workspaceId), eq(directions.id, id)));
      if (!d) throw new AppError('NOT_FOUND', 'Direction was not found.');
      return { title: d.name, rowVersion: d.rowVersion, items: [] };
    },
    archive: async (ctx, id) => {
      const d = await lockById(ctx, directions, id, 'Direction');
      authorizeObject(ctx, 'directions.manage', { directionId: d.id }, 'directions.read');
      await ctx.tx.update(directions).set({ status: 'archived', archivedAt: ctx.app.clock.now(), ...touch(ctx, directions) }).where(eq(directions.id, id));
    },
    list: async (ctx, input) =>
      input.state === 'archived'
        ? (await ctx.app.db.select().from(directions).where(and(eq(directions.workspaceId, ctx.actor.workspaceId), eq(directions.status, 'archived')))).map((d) => ({ id: d.id, title: d.name, at: d.archivedAt!, byUserId: null, reason: null, projectId: null, purgeAfter: null }))
        : [],
    restorePreview: async (ctx, id) => {
      const [d] = await ctx.app.db.select().from(directions).where(and(eq(directions.workspaceId, ctx.actor.workspaceId), eq(directions.id, id)));
      if (!d) throw new AppError('NOT_FOUND', 'Direction was not found.');
      const [taken] = await ctx.app.db.select().from(directions).where(and(eq(directions.workspaceId, ctx.actor.workspaceId), eq(directions.nameKey, d.nameKey), eq(directions.status, 'active')));
      return { title: d.name, items: [], collisions: taken ? [{ field: 'name', value: d.name, message: 'Another active direction uses this name.', options: [{ value: `${d.name} (restored)`, label: `Rename to “${d.name} (restored)”` }] }] : [] };
    },
    restore: async (ctx, id, input) => {
      const d = await lockById(ctx, directions, id, 'Direction');
      authorizeObject(ctx, 'directions.manage', { directionId: d.id }, 'directions.read');
      const name = input.resolutions?.name ?? d.name;
      await ctx.tx.update(directions).set({ status: 'active', archivedAt: null, name, nameKey: normalizeKey(name), ...touch(ctx, directions) }).where(eq(directions.id, id));
    },
  });
  defineArchiveHandler({
    entityType: 'financial_entry',
    label: 'Financial entry',
    preview: async () => ({ title: 'Entry', rowVersion: 1, items: [] }),
    archive: async () => undefined,
    untrashPreview: async () => ({ title: 'Draft entry', items: [] }),
    purge: async () => {
      throw new Error('must never be called');
    },
  });
});

const setup = async () => {
  const ws = await createWorkspace(db());
  const owner = await clientFor(await sessionFor(db(), ws.owner.userId));
  const directionId = await createDirection(db(), ws, 'AI Series');
  const params = { workspaceId: ws.workspaceId };
  return { ws, owner, directionId, params };
};

describe('Archive / Trash (S70)', () => {
  it('restore of an archived record with a unique collision needs an explicit resolution (T155)', async () => {
    const { ws, owner, params } = await setup();
    const oldId = await createDirection(db(), ws, 'AI Influencers');
    const ap = await owner.call(archiveEndpoints.archivePreview, { params, body: { targets: [{ entityType: 'direction', entityId: oldId }] } });
    const ar = await owner.call(archiveEndpoints.archive, { params, body: { previewToken: ap.token } });
    expect(ar.done).toHaveLength(1);
    await createDirection(db(), ws, 'AI Influencers'); // name now taken by an active direction
    const list = await owner.call(archiveEndpoints.list, { params, query: { state: 'archived', entityType: 'direction' } });
    expect(list.items.map((i) => i.entityId)).toEqual([oldId]);
    const p1 = await owner.call(archiveEndpoints.restorePreview, { params, body: { targets: [{ entityType: 'direction', entityId: oldId, state: 'archived' }] } });
    expect(p1.items[0]!.collisions[0]!.field).toBe('name');
    const noChoice = await owner.call(archiveEndpoints.restore, { params, body: { previewToken: p1.token } });
    expect(noChoice.failed[0]!.message).toMatch(/Choose how to resolve/);
    const p2 = await owner.call(archiveEndpoints.restorePreview, { params, body: { targets: [{ entityType: 'direction', entityId: oldId, state: 'archived' }] } });
    const key = `direction:${oldId}`;
    const ok = await owner.call(archiveEndpoints.restore, { params, body: { previewToken: p2.token, resolutions: { [key]: { name: 'AI Influencers (restored)' } } } });
    expect(ok.done).toHaveLength(1);
    const [d] = await db().select().from(directions).where(eq(directions.id, oldId));
    expect(d!.status).toBe('active');
    expect(d!.name).toBe('AI Influencers (restored)');
    // A used preview token cannot be replayed with a new key.
    expect((await owner.attempt(archiveEndpoints.restore, { params, body: { previewToken: p2.token } })).status).toBe(409);
  });

  it('moves eligible draft projects to the trash, lists and restores them within the grace period', async () => {
    const { ws, owner, directionId, params } = await setup();
    const draft = await owner.call(projectEndpoints.create, { params, body: { name: 'Scratch Draft', type: 'series', directionId, ownerMembershipId: ws.owner.membershipId } });
    const active = await owner.call(projectEndpoints.create, { params, body: { name: 'Live', type: 'series', directionId, ownerMembershipId: ws.owner.membershipId, briefSummary: 'Brief', activate: true } });
    const t = await owner.call(archiveEndpoints.trash, { params, body: { targets: [{ entityType: 'project', entityId: draft.id }, { entityType: 'project', entityId: active.id }], reason: 'Created by mistake' } });
    expect(t.done.map((d) => d.entityId)).toEqual([draft.id]);
    expect(t.failed[0]!.message).toMatch(/Only draft projects/);
    const trash = await owner.call(archiveEndpoints.list, { params, query: { state: 'trash' } });
    expect(trash.items).toHaveLength(1);
    expect(trash.items[0]).toMatchObject({ entityId: draft.id, canRestore: true, canPurge: true });
    expect(new Date(trash.items[0]!.purgeAfter!).getTime() - Date.now()).toBeGreaterThan(29 * 86_400_000);
    expect((await owner.attempt(projectEndpoints.get, { params: { ...params, projectId: draft.id } })).status).toBe(404);
    const rp = await owner.call(archiveEndpoints.restorePreview, { params, body: { targets: [{ entityType: 'project', entityId: draft.id, state: 'trash' }] } });
    expect(rp.eligibleCount).toBe(1);
    await owner.call(archiveEndpoints.restore, { params, body: { previewToken: rp.token } });
    expect((await owner.call(projectEndpoints.get, { params: { ...params, projectId: draft.id } })).name).toBe('Scratch Draft');
    // A lead cannot trash projects outside their scope (not found).
    const lead = await addMember(db(), ws, { roleKey: 'project_lead', scopeType: 'assigned_projects' });
    const c = await clientFor(await sessionFor(db(), lead.userId));
    const denied = await c.call(archiveEndpoints.trash, { params, body: { targets: [{ entityType: 'project', entityId: draft.id }], reason: 'Not mine' } });
    expect(denied.failed[0]!.message).toMatch(/not found/i);
    expect((await c.call(archiveEndpoints.list, { params, query: { state: 'trash' } })).items).toHaveLength(0);
  });

  it('permanent deletion: Owner with recent authentication, typed confirmation, async job; never finance/audit (T156)', async () => {
    const { ws, owner, directionId, params } = await setup();
    const draft = await owner.call(projectEndpoints.create, { params, body: { name: 'Purge Me', type: 'series', directionId, ownerMembershipId: ws.owner.membershipId } });
    await owner.call(archiveEndpoints.trash, { params, body: { targets: [{ entityType: 'project', entityId: draft.id }], reason: 'Duplicate draft' } });
    const finance = await owner.call(archiveEndpoints.purgePreview, { params, body: { targets: [{ entityType: 'financial_entry', entityId: draft.id }] } });
    expect(finance.items[0]!.status).toBe('forbidden');
    const refused = await owner.attempt(archiveEndpoints.purge, { params, body: { previewToken: finance.token, confirmation: 'DELETE 0' } });
    expect(refused.status).toBe(409);
    expect(refused.error?.message).toMatch(/Nothing in the selection/);
    const pp = await owner.call(archiveEndpoints.purgePreview, { params, body: { targets: [{ entityType: 'project', entityId: draft.id }] } });
    expect(pp.eligibleCount).toBe(1);
    await db().update(sessions).set({ recentAuthAt: new Date() }).where(eq(sessions.userId, ws.owner.userId));
    const wrong = await owner.attempt(archiveEndpoints.purge, { params, body: { previewToken: pp.token, confirmation: 'delete' } });
    expect(wrong.status).toBe(422);
    const pp2 = await owner.call(archiveEndpoints.purgePreview, { params, body: { targets: [{ entityType: 'project', entityId: draft.id }] } });
    const queued = await owner.call(archiveEndpoints.purge, { params, body: { previewToken: pp2.token, confirmation: 'DELETE 1' } });
    expect(queued.count).toBe(1);
    expect(await db().select().from(projects).where(eq(projects.id, draft.id))).toHaveLength(1);
    await runQueuedJobs(['archive.purge']);
    expect(await db().select().from(projects).where(eq(projects.id, draft.id))).toHaveLength(0);
    expect(await db().select().from(deletionTombstones).where(eq(deletionTombstones.entityId, draft.id))).toHaveLength(1);
    // Admins do not hold trash.purge.
    const admin = await addMember(db(), ws, { roleKey: 'admin' });
    const ac = await clientFor(await sessionFor(db(), admin.userId));
    expect((await ac.attempt(archiveEndpoints.purgePreview, { params, body: { targets: [{ entityType: 'project', entityId: draft.id }] } })).status).toBe(403);
  });

  it('purges trash automatically after the grace period (retention)', async () => {
    const { ws, owner, directionId, params } = await setup();
    const draft = await owner.call(projectEndpoints.create, { params, body: { name: 'Old Draft', type: 'series', directionId, ownerMembershipId: ws.owner.membershipId } });
    await owner.call(archiveEndpoints.trash, { params, body: { targets: [{ entityType: 'project', entityId: draft.id }], reason: 'Not needed' } });
    try {
      setClock(new Date(Date.now() + 31 * 86_400_000));
      const out = await runRetention(getAppServices());
      expect(Number(out.trashPurged)).toBeGreaterThanOrEqual(1);
    } finally {
      resetClock();
    }
    expect(await db().select().from(projects).where(eq(projects.id, draft.id))).toHaveLength(0);
  });
});
