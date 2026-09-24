import { beforeAll, describe, expect, it } from 'vitest';
import { countValue } from '@castlane/analytics';
import { goalEndpoints as G } from '@castlane/api-contracts';
import { ARCHIVE_HANDLERS, defineMetric, executeCommand, getAppServices, memberJobContext } from '@castlane/application';
import { DateTime } from '@castlane/domain';
import { addMember, clientFor, createDirection, createProject, createWorkspace, sessionFor } from '../../support';

const db = () => getAppServices().db;

/** A metric readable with tasks.read that additionally needs finance.read (like the revenue metrics). */
beforeAll(() => {
  defineMetric({
    id: 'TGF',
    key: 'test_finance_gated',
    label: 'Gated Revenue Units',
    description: 'Needs finance.read on top of tasks.read.',
    unit: 'count',
    permission: 'tasks.read',
    requires: ['finance.read'],
    dimensions: ['project'],
    grains: ['month'],
    definitionVersion: 1,
    async compute() {
      return { total: countValue(7) };
    },
  });
});

const fieldsOf = (e: unknown) => ((e as { fieldErrors?: { field: string; code: string }[] }).fieldErrors ?? []).map((x) => `${x.field}:${x.code}`);

describe('goal metrics with sensitive requirements', () => {
  it('are neither offered nor accepted without the extra permission; existing goals show them as unavailable', async () => {
    const ws = await createWorkspace(db());
    const owner = await clientFor(await sessionFor(db(), ws.owner.userId));
    const directionId = await createDirection(db(), ws, 'AI Models');
    const project = await createProject(db(), ws, { directionId, name: 'Emma Model', type: 'model' });
    const W = { workspaceId: ws.workspaceId };
    // Direction Lead: goals.write, tasks.read and analytics.ofm.read, but no finance.read.
    const m = await addMember(db(), ws, { roleKey: 'direction_lead', scopeType: 'direction', scopeId: directionId });
    const lead = await clientFor(await sessionFor(db(), m.userId));
    const today = DateTime.fromJSDate(new Date(), { zone: 'Europe/Berlin' });
    const period = { periodStart: today.startOf('month').toISODate()!, periodEnd: today.endOf('month').toISODate()! };
    const body = (metricId: string) => ({ name: 'Gated goal', ownerMembershipId: m.membershipId, scopeType: 'project' as const, scopeId: project.id, metricId, targetType: 'absolute' as const, targetValue: '10', ...period });

    const ownerOptions = (await owner.call(G.metricOptions, { params: W })).map((o) => o.id);
    expect(ownerOptions).toEqual(expect.arrayContaining(['TGF', 'M27', 'M33']));
    const leadOptions = (await lead.call(G.metricOptions, { params: W })).map((o) => o.id);
    expect(leadOptions).toEqual(expect.arrayContaining(['M08']));
    // M27 (Revenue per Payer) needs finance.read on top of analytics.ofm.read.
    for (const id of ['TGF', 'M27', 'M33']) expect(leadOptions).not.toContain(id);

    for (const id of ['TGF', 'M27']) {
      const refused = await lead.attempt(G.create, { params: W, body: body(id) });
      expect(refused.status).toBe(422);
      expect(fieldsOf(refused.error)).toContain('metricId:UNAVAILABLE');
    }

    // A goal the Owner set up on the gated metric: measured for the Owner, unavailable (not silently empty) for the lead.
    const goal = await owner.call(G.create, { params: W, body: body('TGF') });
    expect(goal.metric.available).toBe(true);
    expect(goal.current).toMatchObject({ source: 'metric', value: { status: 'known', value: '7' } });
    const seen = await lead.call(G.get, { params: { ...W, goalId: goal.id } });
    expect(seen.metric.available).toBe(false);
    expect(seen.current.source).toBe('none');
    const edit = await lead.attempt(G.update, { params: { ...W, goalId: goal.id }, body: { targetValue: '12' } }, { ifMatch: goal.rowVersion });
    expect(edit.status).toBe(422);
    expect(fieldsOf(edit.error)).toContain('metricId:UNAVAILABLE');
  });
});

describe('goal archive preview', () => {
  it('refuses the goal owner without goals.write, like the archive command', async () => {
    const ws = await createWorkspace(db());
    const owner = await clientFor(await sessionFor(db(), ws.owner.userId));
    const directionId = await createDirection(db(), ws, 'AI Models');
    const project = await createProject(db(), ws, { directionId, name: 'Emma Model', type: 'model' });
    const W = { workspaceId: ws.workspaceId };
    // A viewer (goals.read, no goals.write) who owns the goal.
    const viewer = await addMember(db(), ws, { roleKey: 'viewer', scopeType: 'workspace' });
    const today = DateTime.fromJSDate(new Date(), { zone: 'Europe/Berlin' });
    const goal = await owner.call(G.create, {
      params: W,
      body: { name: 'Owned by a viewer', ownerMembershipId: viewer.membershipId, scopeType: 'project', scopeId: project.id, metricId: 'M08', targetType: 'absolute', targetValue: '0', periodStart: today.startOf('month').toISODate()!, periodEnd: today.endOf('month').toISODate()! },
    });
    const handler = ARCHIVE_HANDLERS.get('goal')!;
    const vctx = (await memberJobContext(getAppServices(), ws.workspaceId, viewer.membershipId))!;
    await expect(handler.preview(vctx, goal.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(executeCommand(vctx, (c) => handler.archive(c, goal.id, { reason: 'Done' } as never))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(handler.restorePreview!(vctx, goal.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // Someone without any access to the goal gets 404 from the preview.
    const outsider = await addMember(db(), ws, { roleKey: 'creator', scopeType: 'assigned_projects' });
    const octx = (await memberJobContext(getAppServices(), ws.workspaceId, outsider.membershipId))!;
    await expect(handler.preview(octx, goal.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // The Owner may.
    const octxOwner = (await memberJobContext(getAppServices(), ws.workspaceId, ws.owner.membershipId))!;
    expect((await handler.preview(octxOwner, goal.id)).title).toBe('Owned by a viewer');
  });
});
