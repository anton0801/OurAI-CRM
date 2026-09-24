import { taskEndpoints, type TaskCreateBody } from '@castlane/api-contracts';
import { getAppServices } from '@castlane/application';
import { addMember, assignToProject, clientFor, createDirection, createProject, createWorkspace, sessionFor, type TestClient } from '../../support';

export const db = () => getAppServices().db;

export interface WorkFixture {
  ws: Awaited<ReturnType<typeof createWorkspace>>;
  owner: TestClient;
  projectId: string;
  otherProjectId: string;
  directionId: string;
  params: { workspaceId: string };
}

/** Workspace with an Owner client and two projects in one direction. */
export const workFixture = async (): Promise<WorkFixture> => {
  const ws = await createWorkspace(db());
  const owner = await clientFor(await sessionFor(db(), ws.owner.userId));
  const directionId = await createDirection(db(), ws, 'AI Series');
  const p = await createProject(db(), ws, { directionId, name: 'Night Shift' });
  const o = await createProject(db(), ws, { directionId, name: 'Other Project' });
  return { ws, owner, projectId: p.id, otherProjectId: o.id, directionId, params: { workspaceId: ws.workspaceId } };
};

/** Add a member with a role, optionally on a project team, and return a signed-in client. */
export const member = async (
  f: WorkFixture,
  roleKey: string,
  opts: { projects?: string[]; scopeType?: Parameters<typeof addMember>[2]['scopeType']; name?: string } = {},
) => {
  const scopeType = opts.scopeType ?? (['creator', 'producer', 'project_lead', 'ofm_supervisor'].includes(roleKey) ? 'assigned_projects' : roleKey === 'contractor' ? 'assigned_object' : 'workspace');
  const m = await addMember(db(), f.ws, { roleKey, scopeType, name: opts.name });
  for (const p of opts.projects ?? []) await assignToProject(db(), f.ws, p, m.membershipId);
  return { ...m, client: await clientFor(await sessionFor(db(), m.userId)) };
};

export const newTask = (c: TestClient, f: WorkFixture, body: Partial<TaskCreateBody> = {}) =>
  c.call(taskEndpoints.create, { params: f.params, body: { title: 'Write the script', projectId: f.projectId, ...body } as TaskCreateBody });

export const transition = (c: TestClient, f: WorkFixture, task: { id: string; rowVersion: number }, targetState: string, extra: Record<string, unknown> = {}) =>
  c.attempt(taskEndpoints.transition, { params: { ...f.params, taskId: task.id }, body: { targetState, ...extra } as never }, { ifMatch: task.rowVersion });

export const getTask = (c: TestClient, f: WorkFixture, id: string) => c.call(taskEndpoints.get, { params: { ...f.params, taskId: id } });
