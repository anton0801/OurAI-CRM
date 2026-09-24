import { and, eq } from 'drizzle-orm';
import { ofmEndpoints as E } from '@castlane/api-contracts';
import { getAppServices } from '@castlane/application';
import { assets, notifications, projectMemberships } from '@castlane/database';
import { newId } from '@castlane/domain';
import { addMember, assignToProject, clientFor, createAccount, createProject, createWorkspace, sessionFor, type TestClient } from '../../support';

export const db = () => getAppServices().db;
export const HOUR = 3_600_000;
export const MIN = 60_000;

/** Top of the next hour + `hours`, as ISO (keeps schedules in the future relative to the real clock). */
export const at = (hours: number, minutes = 0) => {
  const base = Math.ceil(Date.now() / HOUR) * HOUR;
  return new Date(base + hours * HOUR + minutes * MIN).toISOString();
};

export interface Member {
  userId: string;
  membershipId: string;
  client: TestClient;
}

const member = async (ws: Awaited<ReturnType<typeof createWorkspace>>, roleKey: string, scopeType: 'assigned_accounts' | 'assigned_projects' | 'workspace', name: string): Promise<Member> => {
  const m = await addMember(db(), ws, { roleKey, scopeType, name });
  return { ...m, client: await clientFor(await sessionFor(db(), m.userId)) };
};

/**
 * One OFM model (project with OFM enabled) with two accounts, a supervisor on the project team and
 * two OFM managers assigned (through the API) to account A (primary lane) — B only for manager 1.
 */
export const ofmSetup = async (opts: { assignManagers?: boolean } = {}) => {
  const ws = await createWorkspace(db());
  const owner = await clientFor(await sessionFor(db(), ws.owner.userId));
  const project = await createProject(db(), ws, { type: 'model', ofmEnabled: true, name: 'Model Mia' });
  const accountA = await createAccount(db(), ws, { projectId: project.id });
  const accountB = await createAccount(db(), ws, { projectId: project.id });
  const supervisor = await member(ws, 'ofm_supervisor', 'assigned_projects', 'Sam Supervisor');
  await assignToProject(db(), ws, project.id, supervisor.membershipId);
  const manager = await member(ws, 'ofm_manager', 'assigned_accounts', 'Mona Manager');
  const manager2 = await member(ws, 'ofm_manager', 'assigned_accounts', 'Nick Manager');
  const p = { workspaceId: ws.workspaceId };
  await owner.call(E.updateProfile, { params: { ...p, projectId: project.id }, body: { supervisorMembershipId: supervisor.membershipId } }, { ifMatch: 0 });
  const assignment = async (membershipId: string, accountId: string, extra: Record<string, unknown> = {}) =>
    owner.call(E.createAssignment, { params: p, body: { accountId, membershipId, validFrom: new Date(Date.now() - 24 * HOUR).toISOString(), ...extra } as never });
  if (opts.assignManagers !== false) {
    await assignment(manager.membershipId, accountA);
    await assignment(manager.membershipId, accountB);
    await assignment(manager2.membershipId, accountA, { coverageLane: 'support' });
  }
  const schedule = (membershipId: string, startH: number, endH: number, extra: Record<string, unknown> = {}) =>
    owner.call(E.createShift, {
      params: p,
      body: { membershipId, primaryAccountId: accountA, scheduledStart: at(startH), scheduledEnd: at(endH), timezone: 'Europe/Berlin', ...extra } as never,
    });
  return { ws, owner, project, accountA, accountB, supervisor, manager, manager2, p, assignment, schedule };
};

export const insertAsset = async (workspaceId: string, projectId: string | null = null) => {
  const id = newId();
  await db().insert(assets).values({ id, workspaceId, name: 'evidence.png', kind: 'image', projectId });
  return id;
};

export const notificationsFor = (workspaceId: string, membershipId: string) =>
  db()
    .select()
    .from(notifications)
    .where(and(eq(notifications.workspaceId, workspaceId), eq(notifications.recipientMembershipId, membershipId)));

export const addToProjectTeam = (workspaceId: string, projectId: string, membershipId: string) =>
  db().insert(projectMemberships).values({ id: newId(), workspaceId, projectId, membershipId, validFrom: new Date(Date.now() - 1000) });
