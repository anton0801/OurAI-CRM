import { describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { customFieldEndpoints, lookupEndpoints, projectEndpoints, templateEndpoints } from '@castlane/api-contracts';
import { executeCommand, getAppServices, recordTemplateApplication, systemJobContext } from '@castlane/application';
import { templateApplications } from '@castlane/database';
import { addMember, assignToProject, clientFor, createDirection, createWorkspace, sessionFor } from '../../support';
import { db } from './helpers';

const setup = async () => {
  const ws = await createWorkspace(db());
  const owner = await clientFor(await sessionFor(db(), ws.owner.userId));
  const directionId = await createDirection(db(), ws, 'AI Series');
  return { ws, owner, directionId, params: { workspaceId: ws.workspaceId } };
};

const graph = {
  tasks: [
    { key: 'script', title: 'Write script', offsetDaysFromStart: 0, durationDays: 2, estimateMinutes: 240, defaultRoleKey: 'writer', checklist: [{ label: 'Hook in first 3 s', mandatory: true }] },
    { key: 'video', title: 'Generate video', offsetDaysFromStart: 1, durationDays: 1, dependsOn: ['script'] },
  ],
};

describe('Templates (S72)', () => {
  it('draft → published (immutable) → new version; preview applies dates and roles without creating anything', async () => {
    const { ws, owner, params } = await setup();
    const t = await owner.call(templateEndpoints.create, { params, body: { kind: 'task', name: 'Zephyr clip pipeline' } });
    expect(t.status).toBe('draft');
    const cyc = await owner.call(templateEndpoints.saveDraft, { params: { ...params, templateId: t.id, versionId: t.draft!.id }, body: { config: { tasks: [{ key: 'a', title: 'Task A', dependsOn: ['b'] }, { key: 'b', title: 'Task B', dependsOn: ['a'] }] } } }, { ifMatch: t.draft!.rowVersion });
    const bad = await owner.attempt(templateEndpoints.publish, { params: { ...params, templateId: t.id }, body: { draftVersionId: t.draft!.id } }, { ifMatch: cyc.rowVersion });
    expect(bad.status).toBe(422);
    const saved = await owner.call(templateEndpoints.saveDraft, { params: { ...params, templateId: t.id, versionId: t.draft!.id }, body: { config: graph } }, { ifMatch: cyc.draft!.rowVersion });
    const conflict = await owner.attempt(templateEndpoints.saveDraft, { params: { ...params, templateId: t.id, versionId: t.draft!.id }, body: { config: graph } }, { ifMatch: cyc.draft!.rowVersion });
    expect(conflict.code).toBe('VERSION_CONFLICT');
    const pub = await owner.call(templateEndpoints.publish, { params: { ...params, templateId: t.id }, body: { draftVersionId: t.draft!.id } }, { ifMatch: saved.rowVersion });
    expect(pub).toMatchObject({ status: 'published', draft: null, publishedVersion: { versionNo: 1 } });
    // Published versions are immutable at the database level too.
    await expect(db().execute(sql`UPDATE template_versions SET config = '{}'::jsonb WHERE id = ${pub.published!.id}`)).rejects.toBeTruthy();
    const editPublished = await owner.attempt(templateEndpoints.saveDraft, { params: { ...params, templateId: t.id, versionId: pub.published!.id }, body: { config: graph } }, { ifMatch: 2 });
    expect(editPublished.status).toBe(409);

    const preview = await owner.call(templateEndpoints.previewApplication, { params: { ...params, templateId: t.id }, body: { startDate: '2026-10-05', assignees: { writer: ws.owner.membershipId } } });
    expect(preview.tasks.map((x) => [x.key, x.startDate, x.dueDate])).toEqual([
      ['script', '2026-10-05', '2026-10-07'],
      ['video', '2026-10-07', '2026-10-08'],
    ]);
    expect(preview.tasks[0]!.assignee?.membershipId).toBe(ws.owner.membershipId);
    expect(preview.totalEstimateMinutes).toBe(240);

    const v2 = await owner.call(templateEndpoints.newVersion, { params: { ...params, templateId: t.id }, body: {} });
    expect(v2.draft?.versionNo).toBe(2);
    expect(v2.draft?.config).toEqual(pub.published!.config);
    const lookup = await owner.call(lookupEndpoints.search, { params: { ...params, type: 'template' }, query: { q: 'zephyr' } });
    expect(lookup.items.map((i) => i.id)).toEqual([t.id]);
    const disabled = await owner.call(templateEndpoints.disable, { params: { ...params, templateId: t.id }, body: {} }, { ifMatch: v2.rowVersion });
    expect(disabled.status).toBe('disabled');
    expect((await owner.call(lookupEndpoints.search, { params: { ...params, type: 'template' }, query: { q: 'zephyr' } })).items).toHaveLength(0);
  });

  it('records each application exactly once per application key', async () => {
    const { ws, owner, params } = await setup();
    const t = await owner.call(templateEndpoints.create, { params, body: { kind: 'task', name: 'Once', config: graph } });
    const p = await owner.call(templateEndpoints.publish, { params: { ...params, templateId: t.id }, body: { draftVersionId: t.draft!.id } }, { ifMatch: t.rowVersion });
    const ctx = await systemJobContext(getAppServices(), ws.workspaceId, ['tasks.create']);
    const apply = () => executeCommand(ctx, (c) => recordTemplateApplication(c, { templateVersionId: p.published!.id, targetType: 'content_item', targetId: t.id, applicationKey: `content:${t.id}:${p.published!.id}`, createdTaskIds: [] }));
    expect((await apply()).body.created).toBe(true);
    expect((await apply()).body.created).toBe(false);
    expect(await db().select().from(templateApplications).where(eq(templateApplications.workspaceId, ws.workspaceId))).toHaveLength(1);
  });

  it('only members who manage templates can change them', async () => {
    const { ws, params } = await setup();
    const producer = await addMember(db(), ws, { roleKey: 'producer', scopeType: 'assigned_projects' });
    const c = await clientFor(await sessionFor(db(), producer.userId));
    expect((await c.attempt(templateEndpoints.create, { params, body: { kind: 'checklist', name: 'Nope' } })).status).toBe(403);
  });
});

describe('Custom fields (section 21)', () => {
  it('defines typed fields per entity type, stores values with row versions and keeps historical labels', async () => {
    const { ws, owner, directionId, params } = await setup();
    const reserved = await owner.attempt(customFieldEndpoints.create, { params, body: { entityType: 'project', key: 'status', name: 'Status', type: 'short_text' } });
    expect(reserved.status).toBe(422);
    const tier = await owner.call(customFieldEndpoints.create, { params, body: { entityType: 'project', key: 'tier', name: 'Tier', type: 'single_select', options: [{ key: 'a', label: 'Tier A' }, { key: 'b', label: 'Tier B' }] } });
    const budget = await owner.call(customFieldEndpoints.create, { params, body: { entityType: 'project', key: 'episode_length', name: 'Episode length', type: 'number', unit: 'min', precision: 1 } });
    const p = await owner.call(projectEndpoints.create, { params, body: { name: 'Custom', type: 'series', directionId, ownerMembershipId: ws.owner.membershipId } });
    const invalid = await owner.attempt(customFieldEndpoints.setValues, { params, body: { entityType: 'project', entityId: p.id, values: [{ definitionId: budget.id, value: '12.34' }] } });
    expect(invalid.status).toBe(422);
    const saved = await owner.call(customFieldEndpoints.setValues, { params, body: { entityType: 'project', entityId: p.id, values: [{ definitionId: tier.id, value: 'b' }, { definitionId: budget.id, value: '12.5' }] } });
    const tierValue = saved.fields.find((f) => f.definition.id === tier.id)!;
    expect(tierValue.displayValue).toBe('Tier B');
    expect(saved.fields.find((f) => f.definition.id === budget.id)!.displayValue).toBe('12.5 min');
    // Concurrent edit of the same value → 412.
    const stale = await owner.attempt(customFieldEndpoints.setValues, { params, body: { entityType: 'project', entityId: p.id, values: [{ definitionId: tier.id, value: 'a', rowVersion: 99 }] } });
    expect(stale.code).toBe('VERSION_CONFLICT');
    // Removing an option archives it; the stored value keeps its historical label.
    const def = await owner.call(customFieldEndpoints.get, { params: { ...params, fieldId: tier.id } });
    await owner.call(customFieldEndpoints.update, { params: { ...params, fieldId: tier.id }, body: { options: [{ key: 'a', label: 'Tier A' }] } }, { ifMatch: def.rowVersion });
    const after = await owner.call(customFieldEndpoints.values, { params, query: { entityType: 'project', entityId: p.id } });
    expect(after.fields.find((f) => f.definition.id === tier.id)!.displayValue).toBe('Tier B');
    const reject = await owner.attempt(customFieldEndpoints.setValues, { params, body: { entityType: 'project', entityId: p.id, values: [{ definitionId: tier.id, value: 'b', rowVersion: tierValue.rowVersion }] } });
    expect(reject.status).toBe(422);
    // Scope isolation: a lead without the project cannot read its values.
    const lead = await addMember(db(), ws, { roleKey: 'project_lead', scopeType: 'assigned_projects' });
    const c = await clientFor(await sessionFor(db(), lead.userId));
    expect((await c.attempt(customFieldEndpoints.values, { params, query: { entityType: 'project', entityId: p.id } })).status).toBe(404);
    await assignToProject(db(), ws, p.id, lead.membershipId);
    const c2 = await clientFor(await sessionFor(db(), lead.userId));
    expect((await c2.call(customFieldEndpoints.values, { params, query: { entityType: 'project', entityId: p.id } })).canEdit).toBe(true);
    expect((await c2.attempt(customFieldEndpoints.create, { params, body: { entityType: 'project', key: 'x_field', name: 'Extra field', type: 'checkbox' } })).status).toBe(403);
  });

  it('Required At Stage blocks the transition and marks existing records Needs Completion', async () => {
    const { ws, owner, directionId, params } = await setup();
    const p = await owner.call(projectEndpoints.create, { params, body: { name: 'Staged', type: 'series', directionId, ownerMembershipId: ws.owner.membershipId, briefSummary: 'Brief' } });
    const f = await owner.call(customFieldEndpoints.create, { params, body: { entityType: 'project', key: 'release_window', name: 'Release window', type: 'short_text', requiredAtStage: 'active' } });
    const blocked = await owner.attempt(projectEndpoints.transition, { params: { ...params, projectId: p.id }, body: { targetState: 'active' } }, { ifMatch: p.rowVersion });
    expect(blocked.status).toBe(422);
    expect(JSON.stringify(blocked.error)).toMatch(/Release window/);
    await owner.call(customFieldEndpoints.setValues, { params, body: { entityType: 'project', entityId: p.id, values: [{ definitionId: f.id, value: 'Q4 2026' }] } });
    const active = await owner.call(projectEndpoints.transition, { params: { ...params, projectId: p.id }, body: { targetState: 'active' } }, { ifMatch: p.rowVersion });
    expect(active.status).toBe('active');
    const other = await owner.call(customFieldEndpoints.create, { params, body: { entityType: 'project', key: 'platform_notes', name: 'Platform notes', type: 'long_text', requiredAtStage: 'active' } });
    const values = await owner.call(customFieldEndpoints.values, { params, query: { entityType: 'project', entityId: p.id } });
    expect(values.fields.find((x) => x.definition.id === other.id)).toMatchObject({ required: true, needsCompletion: true });
  });

  it('replaces a used field with a new type after a migration preview; the old one keeps its values', async () => {
    const { ws, owner, directionId, params } = await setup();
    const f = await owner.call(customFieldEndpoints.create, { params, body: { entityType: 'project', key: 'episodes', name: 'Episodes', type: 'short_text' } });
    const p1 = await owner.call(projectEndpoints.create, { params, body: { name: 'P1', type: 'series', directionId, ownerMembershipId: ws.owner.membershipId } });
    const p2 = await owner.call(projectEndpoints.create, { params, body: { name: 'P2', type: 'series', directionId, ownerMembershipId: ws.owner.membershipId } });
    await owner.call(customFieldEndpoints.setValues, { params, body: { entityType: 'project', entityId: p1.id, values: [{ definitionId: f.id, value: '12' }] } });
    await owner.call(customFieldEndpoints.setValues, { params, body: { entityType: 'project', entityId: p2.id, values: [{ definitionId: f.id, value: 'about ten' }] } });
    const preview = await owner.call(customFieldEndpoints.replacePreview, { params: { ...params, fieldId: f.id }, body: { type: 'number', precision: 0 } });
    expect(preview).toMatchObject({ total: 2, convertible: 1, notConvertible: 1 });
    const cur = await owner.call(customFieldEndpoints.get, { params: { ...params, fieldId: f.id } });
    const next = await owner.call(customFieldEndpoints.replace, { params: { ...params, fieldId: f.id }, body: { type: 'number', precision: 0, migrateValues: true } }, { ifMatch: cur.rowVersion });
    expect(next).toMatchObject({ key: 'episodes', type: 'number', valueCount: 1 });
    const old = await owner.call(customFieldEndpoints.get, { params: { ...params, fieldId: f.id } });
    expect(old.archivedAt).not.toBeNull();
    expect(old.replacedById).toBe(next.id);
    expect(old.valueCount).toBe(2);
  });
});
