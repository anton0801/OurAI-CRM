import { describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { archiveEndpoints, directionAdminEndpoints, financeEndpoints as F, folderEndpoints, projectEndpoints } from '@castlane/api-contracts';
import { enqueueJob, getAppServices, runRetention } from '@castlane/application';
import { auditEvents, deletionTombstones, directions, financialEntries, folders, projects, sessions } from '@castlane/database';
import { normalizeKey } from '@castlane/domain';
import { addMember, clientFor, createDirection, createWorkspace, runQueuedJobs, sessionFor, setClock, resetClock } from '../../support';
import { db } from './helpers';

// Every test below runs the production archive handlers (no test doubles).

const setup = async () => {
  const ws = await createWorkspace(db());
  const owner = await clientFor(await sessionFor(db(), ws.owner.userId));
  const directionId = await createDirection(db(), ws, 'AI Series');
  const params = { workspaceId: ws.workspaceId };
  return { ws, owner, directionId, params };
};

describe('Archive / Trash (S70)', () => {
  it('restoring an archived direction whose name is taken needs an explicit rename: previewed, refused without it, never skipped (T155)', async () => {
    const { ws, owner, directionId, params } = await setup();
    const oldId = await createDirection(db(), ws, 'AI Influencers');
    const ap = await owner.call(archiveEndpoints.archivePreview, { params, body: { targets: [{ entityType: 'direction', entityId: oldId }] } });
    const ar = await owner.call(archiveEndpoints.archive, { params, body: { previewToken: ap.token, reason: 'Merged into models' } });
    expect(ar).toEqual({ done: [{ entityType: 'direction', entityId: oldId }], failed: [] });
    const newId = await createDirection(db(), ws, 'AI Influencers'); // the name is now taken by an active direction
    const list = await owner.call(archiveEndpoints.list, { params, query: { state: 'archived', entityType: 'direction' } });
    expect(list.items.map((i) => i.entityId)).toEqual([oldId]);
    const target = [{ entityType: 'direction', entityId: oldId, state: 'archived' as const }];
    const current = async () => (await db().select().from(directions).where(eq(directions.id, oldId)))[0]!;

    // Preview: the collision is reported with a free rename option.
    const p1 = await owner.call(archiveEndpoints.restorePreview, { params, body: { targets: target } });
    expect(p1.items[0]).toMatchObject({ status: 'ok', message: 'Choose how to resolve the conflicting values.' });
    expect(p1.items[0]!.collisions).toEqual([
      { field: 'name', value: 'AI Influencers', message: expect.stringMatching(/Another active direction uses this name/), options: [{ value: 'AI Influencers (restored)', label: 'Rename to “AI Influencers (restored)”' }] },
    ]);
    // Without a resolution the restore is refused, and says why.
    const noChoice = await owner.call(archiveEndpoints.restore, { params, body: { previewToken: p1.token } });
    expect(noChoice.done).toEqual([]);
    expect(noChoice.failed).toEqual([{ entityType: 'direction', entityId: oldId, message: 'Choose how to resolve: name.' }]);
    expect((await current()).status).toBe('archived');
    // A new name that is also taken is refused by the production handler.
    const p2 = await owner.call(archiveEndpoints.restorePreview, { params, body: { targets: target } });
    const taken = await owner.call(archiveEndpoints.restore, { params, body: { previewToken: p2.token, resolutions: { [`direction:${oldId}`]: { name: 'ai series' } } } });
    expect(taken.done).toEqual([]);
    expect(taken.failed[0]!.message).toMatch(/already uses this name/);
    expect(await current()).toMatchObject({ status: 'archived', name: 'AI Influencers' });
    // The direct Restore on the direction page is refused the same way (no silent merge).
    const direct = await owner.attempt(directionAdminEndpoints.restore, { params: { ...params, directionId: oldId } }, { ifMatch: (await current()).rowVersion });
    expect(direct.status).toBe(409);
    // With the chosen rename it is restored; the other direction is untouched; the unique index holds.
    const p3 = await owner.call(archiveEndpoints.restorePreview, { params, body: { targets: target } });
    const ok = await owner.call(archiveEndpoints.restore, { params, body: { previewToken: p3.token, resolutions: { [`direction:${oldId}`]: { name: p3.items[0]!.collisions[0]!.options[0]!.value } } } });
    expect(ok).toEqual({ done: [{ entityType: 'direction', entityId: oldId }], failed: [] });
    expect(await current()).toMatchObject({ status: 'active', name: 'AI Influencers (restored)', nameKey: normalizeKey('AI Influencers (restored)') });
    expect((await db().select().from(directions).where(eq(directions.id, newId)))[0]).toMatchObject({ status: 'active', name: 'AI Influencers' });
    const active = await db().select().from(directions).where(and(eq(directions.workspaceId, ws.workspaceId), eq(directions.status, 'active')));
    expect(active.map((d) => d.name).sort()).toEqual(['AI Influencers', 'AI Influencers (restored)', 'AI Series']);
    const [trail] = await db().select().from(auditEvents).where(and(eq(auditEvents.entityId, oldId), eq(auditEvents.action, 'direction.restored')));
    expect(trail!.diff).toEqual({ name: { from: 'AI Influencers', to: 'AI Influencers (restored)' } });
    // A used preview token cannot be replayed with a new key.
    expect((await owner.attempt(archiveEndpoints.restore, { params, body: { previewToken: p3.token } })).status).toBe(409);

    // A collision that appears after the preview is refused by the handler, not skipped; a target the
    // preview did not allow (not archived) is reported as not restored.
    const laterId = await createDirection(db(), ws, 'AI Models');
    const lp = await owner.call(archiveEndpoints.archivePreview, { params, body: { targets: [{ entityType: 'direction', entityId: laterId }] } });
    await owner.call(archiveEndpoints.archive, { params, body: { previewToken: lp.token } });
    const clean = await owner.call(archiveEndpoints.restorePreview, {
      params,
      body: {
        targets: [
          { entityType: 'direction', entityId: laterId, state: 'archived' },
          { entityType: 'direction', entityId: directionId, state: 'archived' },
        ],
      },
    });
    expect(clean.items.map((i) => [i.entityId, i.status, i.collisions.length])).toEqual([
      [laterId, 'ok', 0],
      [directionId, 'blocked', 0],
    ]);
    await createDirection(db(), ws, 'AI Models');
    const raced = await owner.call(archiveEndpoints.restore, { params, body: { previewToken: clean.token } });
    expect(raced.done).toEqual([]);
    expect(raced.failed).toEqual([
      { entityType: 'direction', entityId: laterId, message: expect.stringMatching(/same name exists/) },
      { entityType: 'direction', entityId: directionId, message: 'Not restored: This direction is not archived.' },
    ]);
    expect((await db().select().from(directions).where(eq(directions.id, laterId)))[0]!.status).toBe('archived');
  });

  it('restoring an archived folder next to a same-named active folder needs an explicit rename (T155)', async () => {
    const { owner, params } = await setup();
    const first = await owner.call(folderEndpoints.create, { params, body: { name: 'Stills' } });
    const ap = await owner.call(archiveEndpoints.archivePreview, { params, body: { targets: [{ entityType: 'folder', entityId: first.id }] } });
    expect((await owner.call(archiveEndpoints.archive, { params, body: { previewToken: ap.token } })).done).toHaveLength(1);
    const second = await owner.call(folderEndpoints.create, { params, body: { name: 'stills' } });
    const target = [{ entityType: 'folder', entityId: first.id, state: 'archived' as const }];
    const p1 = await owner.call(archiveEndpoints.restorePreview, { params, body: { targets: target } });
    expect(p1.items[0]!.collisions.map((c) => [c.field, c.options.map((o) => o.value)])).toEqual([['name', ['Stills (restored)']]]);
    const refused = await owner.call(archiveEndpoints.restore, { params, body: { previewToken: p1.token } });
    expect(refused.failed[0]!.message).toBe('Choose how to resolve: name.');
    expect((await db().select().from(folders).where(eq(folders.id, first.id)))[0]!.archivedAt).not.toBeNull();
    const p2 = await owner.call(archiveEndpoints.restorePreview, { params, body: { targets: target } });
    const ok = await owner.call(archiveEndpoints.restore, { params, body: { previewToken: p2.token, resolutions: { [`folder:${first.id}`]: { name: 'Stills (restored)' } } } });
    expect(ok.done).toHaveLength(1);
    const rows = await db().select().from(folders).where(eq(folders.workspaceId, params.workspaceId));
    expect(Object.fromEntries(rows.map((f) => [f.id, [f.name, f.archivedAt]]))).toEqual({ [first.id]: ['Stills (restored)', null], [second.id]: ['stills', null] });
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

  it('permanent deletion: Owner with recent authentication, typed confirmation, async job', async () => {
    const { ws, owner, directionId, params } = await setup();
    const draft = await owner.call(projectEndpoints.create, { params, body: { name: 'Purge Me', type: 'series', directionId, ownerMembershipId: ws.owner.membershipId } });
    await owner.call(archiveEndpoints.trash, { params, body: { targets: [{ entityType: 'project', entityId: draft.id }], reason: 'Duplicate draft' } });
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

  it('finance and audit records can never be purged through the trash, even by the Owner (T156)', async () => {
    const { ws, owner, params } = await setup();
    await db().update(sessions).set({ recentAuthAt: new Date() }).where(eq(sessions.userId, ws.owner.userId));
    const cats = await owner.call(F.categoriesList, { params, query: {} });
    const entry = await owner.call(F.entriesCreate, {
      params,
      body: { type: 'expense', title: 'Draft invoice', recognitionDate: '2024-03-01', lines: [{ categoryId: cats.find((c) => c.key === 'software')!.id, amount: '10.00', currency: 'EUR' }] },
    });
    const [auditRow] = await db().select().from(auditEvents).where(eq(auditEvents.workspaceId, ws.workspaceId)).limit(1);
    expect(auditRow).toBeTruthy();
    const targets = [
      { entityType: 'financial_entry', entityId: entry.id },
      { entityType: 'finance_category', entityId: cats[0]!.id },
      { entityType: 'audit_event', entityId: auditRow!.id },
    ];
    // Not offered on the Archive screen…
    const types = await owner.call(archiveEndpoints.types, { params });
    expect(types.filter((t) => /financ|budget|compensation|audit/.test(t.entityType) && t.purge)).toEqual([]);
    // …refused in the preview and in the purge request…
    const preview = await owner.call(archiveEndpoints.purgePreview, { params, body: { targets } });
    expect(preview.items.map((i) => [i.entityType, i.status])).toEqual(targets.map((t) => [t.entityType, 'forbidden']));
    expect(preview.items[0]!.message).toMatch(/never deleted/);
    const refused = await owner.attempt(archiveEndpoints.purge, { params, body: { previewToken: preview.token, confirmation: 'DELETE 3' } });
    expect(refused.status).toBe(409);
    expect(refused.error?.message).toMatch(/Nothing in the selection/);
    // …and neither the trash nor a forged purge job touches them.
    const trash = await owner.call(archiveEndpoints.trash, { params, body: { targets, reason: 'Clean up the books' } });
    expect(trash.done).toEqual([]);
    expect(trash.failed).toHaveLength(3);
    await enqueueJob(db(), { type: 'archive.purge', workspaceId: ws.workspaceId, payload: { actorMembershipId: ws.owner.membershipId, targets } });
    const [run] = await runQueuedJobs(['archive.purge']);
    expect(run!.result).toMatchObject({ purged: 0, failed: 3 });
    expect(await db().select().from(financialEntries).where(eq(financialEntries.id, entry.id))).toHaveLength(1);
    expect(await db().select().from(auditEvents).where(eq(auditEvents.id, auditRow!.id))).toHaveLength(1);
    // The audit table itself is append-only below the application.
    await expect(db().execute(sql`DELETE FROM audit_events WHERE id = ${auditRow!.id}`)).rejects.toThrow();
    expect(await db().select().from(auditEvents).where(eq(auditEvents.id, auditRow!.id))).toHaveLength(1);
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
