import { describe, expect, it } from 'vitest';
import { lookupEndpoints } from '@castlane/api-contracts';
import { getAppServices } from '@castlane/application';
import { addMember, assignToProject, clientFor, createDirection, createProject, createWorkspace, sessionFor } from '../../support';

const db = () => getAppServices().db;

describe('lookup (entity pickers)', () => {
  it('offers only readable records and resolves selected ids within scope', async () => {
    const ws = await createWorkspace(db());
    const directionId = await createDirection(db(), ws, 'AI Models');
    const { id: visible } = await createProject(db(), ws, { name: 'Visible Model', directionId });
    const { id: hidden } = await createProject(db(), ws, { name: 'Hidden Model', directionId });
    const lead = await addMember(db(), ws, { roleKey: 'project_lead', scopeType: 'assigned_projects' });
    await assignToProject(db(), ws, visible, lead.membershipId);
    const client = await clientFor(await sessionFor(db(), lead.userId));
    const params = { workspaceId: ws.workspaceId, type: 'project' as const };

    const all = await client.call(lookupEndpoints.search, { params, query: { q: 'model' } });
    expect(all.items.map((i) => i.id)).toEqual([visible]);

    const byIds = await client.call(lookupEndpoints.search, { params, query: { ids: [visible, hidden] } });
    expect(byIds.items.map((i) => i.id)).toEqual([visible]);

    const wildcard = await client.call(lookupEndpoints.search, { params, query: { q: '%' } });
    expect(wildcard.items).toHaveLength(0);
  });

  it('returns 403 when the member cannot read the module anywhere', async () => {
    const ws = await createWorkspace(db());
    const contractor = await addMember(db(), ws, { roleKey: 'contractor', scopeType: 'assigned_object' });
    const client = await clientFor(await sessionFor(db(), contractor.userId));
    const r = await client.attempt(lookupEndpoints.search, { params: { workspaceId: ws.workspaceId, type: 'project' }, query: {} });
    expect(r.status).toBe(403);
  });
});
