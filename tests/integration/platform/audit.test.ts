import { describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { auditEndpoints, exportEndpoints, projectEndpoints } from '@castlane/api-contracts';
import { auditEvents } from '@castlane/database';
import { newId } from '@castlane/domain';
import { addMember, clientFor, createDirection, createWorkspace, runQueuedJobs, sessionFor } from '../../support';
import { customRole, db, grantRole } from './helpers';

const setup = async () => {
  const ws = await createWorkspace(db());
  const owner = await clientFor(await sessionFor(db(), ws.owner.userId));
  const directionId = await createDirection(db(), ws, 'AI Models');
  const params = { workspaceId: ws.workspaceId };
  const a = await owner.call(projectEndpoints.create, { params, body: { name: 'Model A', type: 'model', directionId, ownerMembershipId: ws.owner.membershipId } });
  const b = await owner.call(projectEndpoints.create, { params, body: { name: 'Model B', type: 'model', directionId, ownerMembershipId: ws.owner.membershipId } });
  await owner.call(projectEndpoints.update, { params: { ...params, projectId: a.id }, body: { description: 'Updated' } }, { ifMatch: a.rowVersion });
  return { ws, owner, params, a, b };
};

describe('Audit Log (S69)', () => {
  it('lists events with filters and entity history; members without audit.read get 403', async () => {
    const { ws, owner, params, a } = await setup();
    const history = await owner.call(auditEndpoints.list, { params, query: { entityType: 'project', entityId: a.id } });
    expect(history.items.map((i) => i.action)).toEqual(['project.updated', 'project.created']);
    expect(history.items[0]!.changes).toContainEqual({ field: 'description', from: null, to: 'Updated' });
    expect(history.items[0]!.href).toBe(`/w/${ws.workspaceId}/projects/${a.id}`);
    const prefix = await owner.call(auditEndpoints.list, { params, query: { action: 'project.' } });
    expect(prefix.items.length).toBeGreaterThanOrEqual(3);
    const none = await owner.call(auditEndpoints.list, { params, query: { source: ['import'] } });
    expect(none.items).toHaveLength(0);
    const future = await owner.call(auditEndpoints.list, { params, query: { from: new Date(Date.now() + 3_600_000).toISOString() } });
    expect(future.items).toHaveLength(0);
    const facets = await owner.call(auditEndpoints.facets, { params });
    expect(facets.actions).toEqual(expect.arrayContaining(['project.created', 'project.updated']));
    const creator = await addMember(db(), ws, { roleKey: 'creator', scopeType: 'assigned_projects' });
    const c = await clientFor(await sessionFor(db(), creator.userId));
    expect((await c.attempt(auditEndpoints.list, { params, query: {} })).status).toBe(403);
  });

  it('applies audit scope in SQL: a project-scoped auditor sees only that project', async () => {
    const { ws, params, a, b } = await setup();
    const auditor = await addMember(db(), ws, { roleKey: 'viewer', scopeType: 'workspace' });
    await grantRole(ws, auditor.membershipId, await customRole(ws, 'project_auditor', ['audit.read']), 'project', a.id);
    const c = await clientFor(await sessionFor(db(), auditor.userId));
    const items = (await c.call(auditEndpoints.list, { params, query: {} })).items;
    expect(new Set(items.map((i) => i.projectId))).toEqual(new Set([a.id]));
    const [other] = await db().select().from(auditEvents).where(eq(auditEvents.entityId, b.id));
    expect((await c.attempt(auditEndpoints.get, { params: { ...params, eventId: other!.id } })).status).toBe(404);
  });

  it('masks sensitive values for viewers without the matching permission', async () => {
    const { ws, owner, params, a } = await setup();
    const id = newId();
    await db().insert(auditEvents).values({ id, workspaceId: ws.workspaceId, actorKind: 'user', actorDisplay: 'Finance', action: 'finance_entry.posted', entityType: 'financial_entry', entityId: newId(), projectId: a.id, source: 'ui', reason: 'Month close', diff: { amount: { from: '10.00', to: '12.00' } }, sensitivity: 'finance' });
    const admin = await addMember(db(), ws, { roleKey: 'admin' });
    const c = await clientFor(await sessionFor(db(), admin.userId));
    const masked = await c.call(auditEndpoints.get, { params: { ...params, eventId: id } });
    expect(masked.masked).toBe(true);
    expect(masked.changes).toEqual([{ field: 'amount', from: '[hidden]', to: '[hidden]' }]);
    expect(masked.reason).toBe('[hidden]');
    const full = await owner.call(auditEndpoints.get, { params: { ...params, eventId: id } });
    expect(full.changes).toEqual([{ field: 'amount', from: '10.00', to: '12.00' }]);
  });

  it('is append-only and exportable as permitted events', async () => {
    const { owner, params, a } = await setup();
    const appendOnly = (e: unknown) => /append-only/.test(String((e as { cause?: { message?: string } }).cause?.message ?? (e as Error).message));
    await expect(db().execute(sql`UPDATE audit_events SET action = 'x' WHERE entity_id = ${a.id}`)).rejects.toSatisfy(appendOnly);
    await expect(db().execute(sql`DELETE FROM audit_events WHERE entity_id = ${a.id}`)).rejects.toSatisfy(appendOnly);
    const req = await owner.call(exportEndpoints.create, { params, body: { dataset: 'audit_events', format: 'csv', fields: ['occurredAt', 'action', 'entityId', 'changes'], filters: { entityType: 'project' } } });
    await runQueuedJobs(['exports.generate']);
    const link = await owner.call(exportEndpoints.download, { params: { ...params, exportId: req.id } });
    const text = await (await owner.raw('GET', link.url.replace('/api/v1', ''))).text();
    expect(text).toContain('project.updated');
    expect(text).toContain(a.id);
  });
});
