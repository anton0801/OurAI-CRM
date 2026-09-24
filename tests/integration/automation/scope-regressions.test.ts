import { describe, expect, it } from 'vitest';
import { automationEndpoints as A } from '@castlane/api-contracts';
import { getAppServices, rulePrincipal } from '@castlane/application';
import { can } from '@castlane/authorization';
import { automationRules, roles } from '@castlane/database';
import { eq } from 'drizzle-orm';
import { newId } from '@castlane/domain';
import { addMember, clientFor, runQueuedJobs, sessionFor, type TestWorkspace } from '../../support';
import { autoSetup, automationTasks, createRule, db, dealConfig, dispatchOutbox, enableRule, moveDeal, newDeal, runsOf, settle } from './helpers';

/** A member holding exactly `permissions` at workspace scope (custom role). */
const memberWith = async (ws: TestWorkspace, key: string, permissions: string[]) => {
  const at = new Date();
  await db().insert(roles).values({ id: newId(), workspaceId: ws.workspaceId, key, name: key, permissions, createdAt: at, updatedAt: at });
  const m = await addMember(db(), ws, { roleKey: key, scopeType: 'workspace' });
  return { ...m, client: await clientFor(await sessionFor(db(), m.userId)) };
};

const fieldCodes = (e: unknown) => ((e as { fieldErrors?: { code: string }[] }).fieldErrors ?? []).map((x) => x.code);

describe('automation principal', () => {
  it('a workspace-scoped rule of the Owner keeps the grants but never the Owner status', async () => {
    const f = await autoSetup();
    const rule = await createRule(f.owner, f, { scopeType: 'workspace' });
    const [row] = await db().select().from(automationRules).where(eq(automationRules.id, rule.id));
    const p = await rulePrincipal(getAppServices(), row!);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.ownerAccess.isOwner).toBe(true);
    expect(p.ctx.actor.access.isOwner).toBe(false);
    // The Owner role grant still covers what the rule needs.
    expect(can(p.ctx.actor.access, 'tasks.create', { projectId: f.projectId })).toBe(true);
    expect(can(p.ctx.actor.access, 'deals.read', { projectId: f.otherProjectId })).toBe(true);
  });
});

describe('automation dry run of unsaved configurations', () => {
  it('readers run only the saved version; drafts need edit rights, full validation and the requester’s own authority', async () => {
    const f = await autoSetup();
    const saved = dealConfig({ conditions: [{ field: 'deal.stage', operator: 'equals', value: 'lead' }] });
    const rule = await createRule(f.owner, f, { config: saved });
    const deal = await newDeal(f.owner, f);
    const sample = { entityType: 'deal', entityId: deal.id };
    const draft = dealConfig({ conditions: [], actions: [{ type: 'create_task', params: { title: 'Changed: {{entity.title}}', assignee: { kind: 'rule_owner' } } }] });
    const dryRun = (c: typeof f.owner, config?: typeof saved) => c.attempt(A.dryRun, { params: { ...f.W, ruleId: rule.id }, body: { sample, ...(config ? { config } : {}) } });

    const reader = await memberWith(f.ws, 'automation_reader', ['automations.read', 'deals.read', 'partners.read', 'projects.read']);
    expect((await dryRun(reader.client)).status).toBe(200);
    // The saved configuration sent back unchanged is still the saved version.
    expect((await dryRun(reader.client, saved)).status).toBe(200);
    const readerDraft = await dryRun(reader.client, draft);
    expect(readerDraft.status).toBe(403);

    // An editor who could not create tasks in the scope cannot preview a draft that creates them as the owner.
    const editor = await memberWith(f.ws, 'automation_editor', ['automations.read', 'automations.edit', 'deals.read', 'partners.read', 'projects.read']);
    expect((await dryRun(editor.client)).status).toBe(200);
    expect((await dryRun(editor.client, draft)).status).toBe(403);

    // Full validation for drafts: a fixed project outside the rule scope is refused before any preview.
    const outside = dealConfig({ actions: [{ type: 'create_task', params: { title: 'Elsewhere', projectId: f.otherProjectId } }] });
    const invalid = await dryRun(f.owner, outside);
    expect(invalid.status).toBe(422);
    expect(fieldCodes(invalid.error)).toContain('OUT_OF_SCOPE');
    const ok = await dryRun(f.owner, draft);
    expect(ok.status).toBe(200);
    expect(ok.data?.actions[0]?.preview).toMatch(/Changed: Spring launch/);
  });
});

describe('automation runs and rule versions', () => {
  it('a run queued for a version that is no longer enabled is skipped, not executed with old or new config', async () => {
    const f = await autoSetup();
    const v1 = await enableRule(f.owner, f, await createRule(f.owner, f));
    const deal = await newDeal(f.owner, f);
    await moveDeal(f.owner, f, deal, ['discussing', 'negotiation', 'won']);
    // Events are dispatched into pending runs, but the runs have not executed yet.
    await dispatchOutbox();
    const queued = (await runsOf(v1.id)).filter((r) => r.state === 'pending');
    expect(queued.length).toBeGreaterThan(0);
    // The rule is edited and version 2 is enabled before the queued runs execute.
    const edited = await f.owner.call(A.update, { params: { ...f.W, ruleId: v1.id }, body: { config: dealConfig({ actions: [{ type: 'create_task', params: { title: 'V2: {{entity.title}}', assignee: { kind: 'rule_owner' } } }] }) } }, { ifMatch: v1.rowVersion });
    const v2 = await f.owner.call(A.enable, { params: { ...f.W, ruleId: v1.id }, body: { versionId: edited.currentVersion!.id } }, { ifMatch: edited.rowVersion });
    expect(v2.enabledVersionNo).toBe(2);
    await runQueuedJobs(['automation.run'], 3);
    await settle();
    const after = await runsOf(v1.id);
    for (const r of after.filter((x) => queued.some((q) => q.id === x.id))) expect([r.state, r.errorCode]).toEqual(['skipped', 'VERSION_CHANGED']);
    expect(await automationTasks(f.ws.workspaceId)).toEqual([]);
  });
});
