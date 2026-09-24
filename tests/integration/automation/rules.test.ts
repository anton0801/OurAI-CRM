import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { newIdempotencyKey } from '@castlane/api-client';
import { automationEndpoints as A, lookupEndpoints } from '@castlane/api-contracts';
import { automationRules, automationRuleVersions } from '@castlane/database';
import { autoSetup, createRule, db, dealConfig, enableRule, memberClient } from './helpers';
import { clientFor, createWorkspace, sessionFor } from '../../support';

describe('automation rules (S64/S65)', () => {
  it('creates a disabled first version idempotently and lists it with trigger, scope and owner', async () => {
    const f = await autoSetup();
    const key = newIdempotencyKey();
    const body = { name: 'Deal kickoff', ownerMembershipId: f.ws.owner.membershipId, scopeType: 'project' as const, scopeId: f.projectId, config: dealConfig() };
    const a = await f.owner.call(A.create, { params: f.W, body }, { idempotencyKey: key });
    const b = await f.owner.call(A.create, { params: f.W, body }, { idempotencyKey: key });
    expect(b.id).toBe(a.id);
    expect(a).toMatchObject({ state: 'draft', currentVersionNo: 1, enabledVersionNo: null, needsOwner: false, scope: { type: 'project', label: 'Emma Model' }, trigger: { event: 'deal.stage_changed', kind: 'event' } });
    expect(a.currentVersion?.actions[0]?.type).toBe('create_task');
    const mismatch = await f.owner.attempt(A.create, { params: f.W, body: { ...body, name: 'Other' } }, { idempotencyKey: key });
    expect(mismatch.code).toBe('IDEMPOTENCY_PAYLOAD_MISMATCH');
    const list = await f.owner.call(A.list, { params: f.W, query: {} });
    expect(list.items.map((r) => r.id)).toEqual([a.id]);
    expect((await db().select().from(automationRules).where(eq(automationRules.workspaceId, f.ws.workspaceId))).length).toBe(1);
  });

  it('rejects code-like or incompatible configuration with field errors', async () => {
    const f = await autoSetup();
    const bad = await f.owner.attempt(A.create, {
      params: f.W,
      body: {
        name: 'Bad rule',
        ownerMembershipId: f.ws.owner.membershipId,
        scopeType: 'project',
        scopeId: f.projectId,
        config: dealConfig({
          conditions: [
            { field: 'deal.amount', operator: 'gte', value: 100 },
            { field: 'deal.stage', operator: 'gte', value: 'won' },
          ],
          actions: [
            { type: 'assign_member', params: { assignee: { kind: 'rule_owner' } } },
            { type: 'notify', params: { recipients: [{ kind: 'member' }], title: 'Hello {{process.env}}' } },
          ],
        }),
      },
    });
    expect(bad.status).toBe(422);
    const fields = ((bad.error as { fieldErrors?: { field: string }[] }).fieldErrors ?? []).map((e) => e.field);
    expect(fields).toEqual(
      expect.arrayContaining(['config.conditions.0.field', 'config.conditions.1.operator', 'config.actions.0.type', 'config.actions.1.params.recipients.0.membershipId', 'config.actions.1.params.title']),
    );
    // A schedule trigger needs a schedule, and created tasks need a fixed project.
    const sched = await f.owner.attempt(A.create, {
      params: f.W,
      body: { name: 'Weekly', ownerMembershipId: f.ws.owner.membershipId, scopeType: 'workspace', scopeId: null, config: { trigger: { event: 'schedule.weekly' }, conditions: [], actions: [{ type: 'create_task', params: { title: 'Weekly review' } }], quietHoursPolicy: 'respect' } },
    });
    expect(sched.status).toBe(422);
  });

  it('keeps versions: a config change creates a new version, requires If-Match and never changes the enabled version silently', async () => {
    const f = await autoSetup();
    const rule = await createRule(f.owner, f);
    const noMatch = await f.owner.attempt(A.update, { params: { ...f.W, ruleId: rule.id }, body: { name: 'Renamed' } });
    expect(noMatch.status).toBe(428);
    const renamed = await f.owner.call(A.update, { params: { ...f.W, ruleId: rule.id }, body: { name: 'Renamed' } }, { ifMatch: rule.rowVersion });
    expect(renamed.currentVersionNo).toBe(1);
    const stale = await f.owner.attempt(A.update, { params: { ...f.W, ruleId: rule.id }, body: { name: 'Again' } }, { ifMatch: rule.rowVersion });
    expect(stale.status).toBe(412);
    const enabled = await enableRule(f.owner, f, renamed);
    expect(enabled).toMatchObject({ state: 'enabled', enabledVersionNo: 1 });
    const v2 = await f.owner.call(
      A.update,
      { params: { ...f.W, ruleId: rule.id }, body: { config: dealConfig({ conditions: [{ field: 'deal.stage', operator: 'in', value: ['won', 'delivering'] }] }) } },
      { ifMatch: enabled.rowVersion },
    );
    expect(v2).toMatchObject({ currentVersionNo: 2, enabledVersionNo: 1, hasUnpublishedChanges: true, state: 'enabled' });
    const versions = await db().select().from(automationRuleVersions).where(eq(automationRuleVersions.ruleId, rule.id));
    expect(versions.map((v) => v.versionNo).sort()).toEqual([1, 2]);
    const v1 = versions.find((v) => v.versionNo === 1)!;
    expect(v1.conditions).toEqual([{ field: 'deal.stage', operator: 'equals', value: 'won' }]);
    const reEnabled = await enableRule(f.owner, f, v2);
    expect(reEnabled).toMatchObject({ enabledVersionNo: 2, hasUnpublishedChanges: false });
  });

  it('enforces permissions: members without automation rights get 403/404; other workspaces never see rules', async () => {
    const f = await autoSetup();
    const rule = await createRule(f.owner, f);
    const lead = await memberClient(f.ws, 'project_lead', { projects: [f.projectId] });
    expect((await lead.client.attempt(A.list, { params: f.W, query: {} })).status).toBe(403);
    expect((await lead.client.attempt(A.get, { params: { ...f.W, ruleId: rule.id } })).status).toBe(404);
    expect((await lead.client.attempt(A.create, { params: f.W, body: { name: 'Mine', ownerMembershipId: lead.membershipId, scopeType: 'project', scopeId: f.projectId, config: dealConfig() } })).status).toBe(403);
    const other = await createWorkspace(db());
    const otherOwner = await clientFor(await sessionFor(db(), other.owner.userId));
    expect((await otherOwner.attempt(A.get, { params: { workspaceId: other.workspaceId, ruleId: rule.id } })).status).toBe(404);
    // Admins manage automations; the picker only offers visible rules.
    const admin = await memberClient(f.ws, 'admin');
    const found = await admin.client.call(lookupEndpoints.search, { params: { ...f.W, type: 'automation' }, query: { q: 'kickoff', limit: 20 } });
    expect(found.items.map((i) => i.id)).toEqual([rule.id]);
  });

  it('enabling validates the owner’s authority over the whole scope; rules without an owner Need Owner', async () => {
    const f = await autoSetup();
    const creator = await memberClient(f.ws, 'creator', { projects: [f.projectId] });
    // A creator cannot create tasks for others: the rule would act beyond the owner's rights.
    const rule = await createRule(f.owner, f, { ownerMembershipId: creator.membershipId });
    expect(rule.needsOwner).toBe(false);
    const refused = await f.owner.attempt(A.enable, { params: { ...f.W, ruleId: rule.id }, body: { versionId: rule.currentVersion!.id } }, { ifMatch: rule.rowVersion });
    expect(refused.status).toBe(422);
    expect(((refused.error as { fieldErrors?: { field: string; code: string }[] }).fieldErrors ?? []).map((e) => e.code)).toContain('OWNER_ACCESS');
    const validation = await f.owner.call(A.validate, { params: f.W, body: { name: rule.name, ownerMembershipId: creator.membershipId, scopeType: 'project', scopeId: f.projectId, config: rule.currentVersion! } });
    expect(validation.ok).toBe(false);
    const ownerless = await createRule(f.owner, f, { ownerMembershipId: null, name: 'Ownerless' });
    expect(ownerless.needsOwner).toBe(true);
    const noOwner = await f.owner.attempt(A.enable, { params: { ...f.W, ruleId: ownerless.id }, body: { versionId: ownerless.currentVersion!.id } }, { ifMatch: ownerless.rowVersion });
    expect(noOwner.status).toBe(422);
    // A lead of another project cannot own a rule of this project either (owner ∩ scope).
    const otherLead = await memberClient(f.ws, 'project_lead', { projects: [f.otherProjectId] });
    const foreign = await createRule(f.owner, f, { ownerMembershipId: otherLead.membershipId, name: 'Foreign owner' });
    expect((await f.owner.attempt(A.enable, { params: { ...f.W, ruleId: foreign.id }, body: { versionId: foreign.currentVersion!.id } }, { ifMatch: foreign.rowVersion })).status).toBe(422);
  });

  it('duplicates as Disabled and archives/restores without losing versions', async () => {
    const f = await autoSetup();
    const rule = await enableRule(f.owner, f, await createRule(f.owner, f));
    const copy = await f.owner.call(A.duplicate, { params: { ...f.W, ruleId: rule.id }, body: {} });
    expect(copy).toMatchObject({ state: 'disabled', name: 'Copy of Deal kickoff', currentVersionNo: 1, enabledVersionNo: null });
    expect(copy.currentVersion?.conditions).toEqual(rule.currentVersion?.conditions);
    const archived = await f.owner.call(A.archive, { params: { ...f.W, ruleId: rule.id }, body: { reason: 'Replaced by the copy' } }, { ifMatch: rule.rowVersion });
    expect(archived.archivedAt).not.toBeNull();
    expect(archived.state).toBe('disabled');
    expect((await f.owner.call(A.list, { params: f.W, query: {} })).items.map((r) => r.id)).toEqual([copy.id]);
    const restored = await f.owner.call(A.archive, { params: { ...f.W, ruleId: rule.id }, body: { restore: true } }, { ifMatch: archived.rowVersion });
    expect(restored).toMatchObject({ archivedAt: null, state: 'disabled', currentVersionNo: 1 });
    const catalog = await f.owner.call(A.catalog, { params: f.W });
    expect(catalog.triggers.map((t) => t.key)).toEqual(expect.arrayContaining(['content.submitted', 'task.overdue', 'budget.threshold_crossed', 'schedule.monthly']));
    expect(catalog.actions.map((a) => a.type)).not.toContain('approve');
    const templates = await f.owner.call(A.templates, { params: f.W });
    expect(templates.length).toBeGreaterThanOrEqual(5);
    // Every starter template is a valid configuration.
    for (const t of templates) {
      const v = await f.owner.call(A.validate, { params: f.W, body: { name: t.name, ownerMembershipId: f.ws.owner.membershipId, scopeType: 'project', scopeId: f.projectId, config: t.config } });
      expect(v.errors).toEqual([]);
    }
  });
});
