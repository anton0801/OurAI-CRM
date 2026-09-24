import { and, eq, sql } from 'drizzle-orm';
import { automationEndpoints as A, dealEndpoints as D, partnerEndpoints as P, type AutomationRuleConfig, type AutomationRuleDetail } from '@castlane/api-contracts';
import { getAppServices, runAutomationTick } from '@castlane/application';
import { automationRuns, jobs, tasks } from '@castlane/database';
import { dispatchOutboxBatch } from '../../../apps/worker/src/outbox';
import { addMember, assignToProject, clientFor, createDirection, createProject, createWorkspace, runQueuedJobs, sessionFor, type TestClient, type TestWorkspace } from '../../support';

export const db = () => getAppServices().db;

/** Deliver outbox events to consumers the way the worker does (at-least-once, in order). */
export const dispatchOutbox = async () => {
  for (let i = 0; i < 20; i++) if ((await dispatchOutboxBatch(getAppServices(), 500)) === 0) break;
};

/** Outbox → consumers → queued automation jobs, repeated until quiet. */
export const settle = async () => {
  for (let i = 0; i < 6; i++) {
    await dispatchOutbox();
    const done = await runQueuedJobs(['automation.run', 'automation.revalidate'], 3);
    if (!done.length) break;
  }
};

export const tick = async (workspaceId?: string) => {
  const r = await runAutomationTick(getAppServices(), { workspaceId });
  await settle();
  return r;
};

export interface AutoFixture {
  ws: TestWorkspace;
  owner: TestClient;
  W: { workspaceId: string };
  directionId: string;
  projectId: string;
  otherProjectId: string;
}

export const autoSetup = async (): Promise<AutoFixture> => {
  const ws = await createWorkspace(db());
  const owner = await clientFor(await sessionFor(db(), ws.owner.userId));
  const directionId = await createDirection(db(), ws, `Dir ${Math.random().toString(36).slice(2, 6)}`);
  const project = await createProject(db(), ws, { directionId, name: 'Emma Model', type: 'model' });
  const other = await createProject(db(), ws, { directionId, name: 'Night Shift', type: 'series' });
  await assignToProject(db(), ws, project.id, ws.owner.membershipId);
  return { ws, owner, W: { workspaceId: ws.workspaceId }, directionId, projectId: project.id, otherProjectId: other.id };
};

export const memberClient = async (ws: TestWorkspace, roleKey: string, opts: { projects?: string[]; name?: string } = {}) => {
  const m = await addMember(db(), ws, { roleKey, name: opts.name, scopeType: roleKey === 'project_lead' || roleKey === 'creator' || roleKey === 'producer' ? 'assigned_projects' : 'workspace' });
  for (const p of opts.projects ?? []) await assignToProject(db(), ws, p, m.membershipId);
  return { ...m, client: await clientFor(await sessionFor(db(), m.userId)) };
};

export const dealConfig = (overrides: Partial<AutomationRuleConfig> = {}): AutomationRuleConfig => ({
  trigger: { event: 'deal.stage_changed' },
  conditions: [{ field: 'deal.stage', operator: 'equals', value: 'won' }],
  actions: [{ type: 'create_task', params: { title: 'Kick off: {{entity.title}}', assignee: { kind: 'entity_owner' }, dueInHours: 48, priority: 'high' } }],
  quietHoursPolicy: 'respect',
  ...overrides,
});

export const createRule = (c: TestClient, f: AutoFixture, body: { name?: string; ownerMembershipId?: string | null; scopeType?: 'workspace' | 'direction' | 'project' | 'account'; scopeId?: string | null; config?: AutomationRuleConfig } = {}) =>
  c.call(A.create, {
    params: f.W,
    body: {
      name: body.name ?? 'Deal kickoff',
      ownerMembershipId: body.ownerMembershipId === undefined ? f.ws.owner.membershipId : body.ownerMembershipId,
      scopeType: body.scopeType ?? 'project',
      scopeId: body.scopeType === 'workspace' ? null : (body.scopeId ?? f.projectId),
      config: body.config ?? dealConfig(),
    },
  });

export const enableRule = async (c: TestClient, f: AutoFixture, rule: AutomationRuleDetail) =>
  c.call(A.enable, { params: { ...f.W, ruleId: rule.id }, body: { versionId: rule.currentVersion!.id } }, { ifMatch: rule.rowVersion });

export const newDeal = async (c: TestClient, f: AutoFixture, projectId = f.projectId, title = 'Spring launch') => {
  const partner = await c.call(P.create, { params: f.W, body: { kind: 'organization', name: `Partner ${Math.random().toString(36).slice(2, 6)}`, ownerMembershipId: f.ws.owner.membershipId } });
  return c.call(D.create, { params: f.W, body: { title, partnerId: partner.id, ownerMembershipId: f.ws.owner.membershipId, projectIds: [projectId] } });
};

export const moveDeal = async (c: TestClient, f: AutoFixture, deal: { id: string; rowVersion: number }, stages: ('discussing' | 'proposal' | 'negotiation' | 'won')[]) => {
  let d = deal;
  for (const s of stages) d = await c.call(D.transition, { params: { ...f.W, dealId: deal.id }, body: { targetStage: s } }, { ifMatch: d.rowVersion });
  return d;
};

export const automationTasks = (workspaceId: string) => db().select().from(tasks).where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.source, 'automation')));
export const runsOf = (ruleId: string) => db().select().from(automationRuns).where(eq(automationRuns.ruleId, ruleId)).orderBy(automationRuns.createdAt);
export const tableCount = async (table: string, workspaceId: string) =>
  Number((await db().execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM ${sql.identifier(table)} WHERE workspace_id = ${workspaceId}`)).rows[0]?.n ?? 0);

/** Put a finished automation job back into the queue (simulates a worker losing the result after commit). */
export const requeueRunJobs = (runId: string) =>
  db().update(jobs).set({ state: 'queued', runAt: new Date(0) }).where(and(eq(jobs.type, 'automation.run'), sql`${jobs.payload}->>'runId' = ${runId}`));
