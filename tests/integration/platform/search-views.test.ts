import { describe, expect, it } from 'vitest';
import { projectEndpoints, savedViewEndpoints, searchEndpoints, shellEndpoints } from '@castlane/api-contracts';
import { addMember, assignToProject, clientFor, createDirection, createWorkspace, sessionFor } from '../../support';
import { db } from './helpers';

const setup = async () => {
  const ws = await createWorkspace(db());
  const owner = await clientFor(await sessionFor(db(), ws.owner.userId));
  const directionId = await createDirection(db(), ws, 'AI Series');
  const params = { workspaceId: ws.workspaceId };
  const make = (name: string, briefSummary: string) =>
    owner.call(projectEndpoints.create, { params, body: { name, type: 'series', directionId, ownerMembershipId: ws.owner.membershipId, briefSummary } });
  return { ws, owner, params, make };
};

describe('search page (S11, T159)', () => {
  it('never leaks results, snippets or counts of hidden records', async () => {
    const { ws, params, make } = await setup();
    const visible = await make('Harbor Lights', 'A quiet harbor mystery');
    const hidden = await make('Harbor Secrets', 'Confidential harbor launch plan');
    const lead = await addMember(db(), ws, { roleKey: 'project_lead', scopeType: 'assigned_projects' });
    await assignToProject(db(), ws, visible.id, lead.membershipId);
    const c = await clientFor(await sessionFor(db(), lead.userId));

    const page = await c.call(searchEndpoints.page, { params, query: { q: 'harbor' } });
    expect(page.results.map((r) => r.entityId)).toEqual([visible.id]);
    expect(page.facets).toEqual([{ entityType: 'project', count: 1 }]);
    expect(JSON.stringify(page)).not.toContain('Confidential');

    // Exact id of a hidden record returns nothing (no existence leak).
    const byId = await c.call(searchEndpoints.page, { params, query: { q: hidden.id } });
    expect(byId.results).toHaveLength(0);
    expect(byId.facets).toHaveLength(0);
    const palette = await c.call(shellEndpoints.search, { params, query: { q: 'secrets' } });
    expect(palette.results).toHaveLength(0);
  });

  it('paginates with a cursor and filters by type', async () => {
    const { params, owner, make } = await setup();
    for (let i = 0; i < 5; i++) await make(`Signal ${i}`, 'Signal series');
    const first = await owner.call(searchEndpoints.page, { params, query: { q: 'signal', pageSize: 2 } });
    expect(first.results).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    const second = await owner.call(searchEndpoints.page, { params, query: { q: 'signal', pageSize: 2, cursor: first.nextCursor! } });
    expect(second.results.map((r) => r.entityId)).not.toContain(first.results[0]!.entityId);
    const typed = await owner.call(searchEndpoints.page, { params, query: { q: 'signal', types: ['task'] } });
    expect(typed.results).toHaveLength(0);
    expect(typed.facets).toEqual([{ entityType: 'project', count: 5 }]);
  });
});

describe('saved views (section 21)', () => {
  const ast = { op: 'and' as const, clauses: [{ field: 'status', operator: 'in' as const, value: ['active', 'paused'] }] };

  it('stores personal and shared views; only the author changes them', async () => {
    const { ws, owner, params } = await setup();
    const mine = await owner.call(savedViewEndpoints.create, { params, body: { module: 'projects', name: 'Active work', filterAst: ast, sort: [{ key: 'name', direction: 'asc' }] } });
    const shared = await owner.call(savedViewEndpoints.create, { params, body: { module: 'projects', name: 'Team view', filterAst: ast, shared: true } });
    const lead = await addMember(db(), ws, { roleKey: 'project_lead', scopeType: 'assigned_projects' });
    const c = await clientFor(await sessionFor(db(), lead.userId));
    const seen = await c.call(savedViewEndpoints.list, { params, query: { module: 'projects' } });
    expect(seen.map((v) => v.id)).toEqual([shared.id]);
    expect(seen[0]!.own).toBe(false);
    expect((await c.attempt(savedViewEndpoints.update, { params: { ...params, viewId: shared.id }, body: { name: 'Mine now' } }, { ifMatch: shared.rowVersion })).status).toBe(403);
    expect((await c.attempt(savedViewEndpoints.update, { params: { ...params, viewId: mine.id }, body: { name: 'Mine now' } }, { ifMatch: mine.rowVersion })).status).toBe(404);
    const renamed = await owner.call(savedViewEndpoints.update, { params: { ...params, viewId: mine.id }, body: { name: 'Active now' } }, { ifMatch: mine.rowVersion });
    expect(renamed.name).toBe('Active now');
    const stale = await owner.attempt(savedViewEndpoints.update, { params: { ...params, viewId: mine.id }, body: { name: 'Again' } }, { ifMatch: mine.rowVersion });
    expect(stale.code).toBe('VERSION_CONFLICT');
    await owner.call(savedViewEndpoints.remove, { params: { ...params, viewId: mine.id } }, { ifMatch: renamed.rowVersion });
    expect((await owner.call(savedViewEndpoints.list, { params, query: { module: 'projects' } })).map((v) => v.id)).toEqual([shared.id]);
  });

  it('validates the typed filter AST against the list’s fields (no SQL, ≤ 30 clauses)', async () => {
    const { owner, params } = await setup();
    const unknown = await owner.attempt(savedViewEndpoints.create, { params, body: { module: 'projects', name: 'Bad', filterAst: { op: 'and', clauses: [{ field: 'budget', operator: 'equals', value: '1' }] } } });
    expect(unknown.status).toBe(422);
    const many = await owner.attempt(savedViewEndpoints.create, { params, body: { module: 'projects', name: 'Too many', filterAst: { op: 'and', clauses: Array.from({ length: 30 }, () => ({ field: 'status', operator: 'equals' as const, value: 'draft' })).concat([{ field: 'status', operator: 'equals', value: 'active' }]) } } });
    expect(many.status).toBe(422);
    const sort = await owner.attempt(savedViewEndpoints.create, { params, body: { module: 'projects', name: 'Sort', filterAst: ast, sort: [{ key: 'budget', direction: 'asc' }] } });
    expect(sort.status).toBe(422);
    const module = await owner.attempt(savedViewEndpoints.create, { params, body: { module: 'import-mapping:projects', name: 'Sneaky', filterAst: ast } });
    expect(module.status).toBe(422);
  });
});
