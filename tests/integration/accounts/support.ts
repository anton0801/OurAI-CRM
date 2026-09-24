import { eq } from 'drizzle-orm';
import { assets, assetVersions, contentItems, publications, shifts } from '@castlane/database';
import { getAppServices } from '@castlane/application';
import { newId } from '@castlane/domain';
import { clientFor, createDirection, createProject, createWorkspace, sessionFor, type TestWorkspace } from '../../support';

/** Shared fixtures for the accounts / creative / partners suites (direct inserts for other modules' rows). */
export const db = () => getAppServices().db;

export const baseSetup = async () => {
  const ws = await createWorkspace(db());
  const owner = await clientFor(await sessionFor(db(), ws.owner.userId));
  const directionId = await createDirection(db(), ws, `Dir ${newId().slice(0, 4)}`);
  const project = await createProject(db(), ws, { directionId, name: 'Emma Model', type: 'model' });
  return { ws, owner, directionId, project, W: { workspaceId: ws.workspaceId } };
};

export const insertContent = async (ws: TestWorkspace, projectId: string, input: { title?: string; stage?: 'idea' | 'production' | 'approved'; ownerMembershipId?: string } = {}) => {
  const id = newId();
  const at = new Date();
  await db()
    .insert(contentItems)
    .values({ id, workspaceId: ws.workspaceId, projectId, title: input.title ?? `Content ${id.slice(0, 4)}`, format: 'short_video', stage: input.stage ?? 'production', ownerMembershipId: input.ownerMembershipId ?? ws.owner.membershipId, createdAt: at, updatedAt: at });
  return id;
};

export const insertPublication = async (
  ws: TestWorkspace,
  input: { accountId: string; projectId: string; contentItemId?: string; status?: 'draft' | 'scheduled' | 'published'; scheduledAt?: Date },
) => {
  const id = newId();
  const at = new Date();
  const contentItemId = input.contentItemId ?? (await insertContent(ws, input.projectId));
  await db()
    .insert(publications)
    .values({
      id,
      workspaceId: ws.workspaceId,
      contentItemId,
      accountId: input.accountId,
      projectId: input.projectId,
      ownerMembershipId: ws.owner.membershipId,
      status: input.status ?? 'scheduled',
      scheduledAt: input.scheduledAt ?? new Date(Date.now() + 86_400_000),
      createdAt: at,
      updatedAt: at,
    });
  return id;
};

export const insertShift = async (ws: TestWorkspace, input: { projectId: string; accountId: string; membershipId?: string; state?: 'scheduled' | 'active' | 'ended' }) => {
  const id = newId();
  const at = new Date();
  await db()
    .insert(shifts)
    .values({
      id,
      workspaceId: ws.workspaceId,
      projectId: input.projectId,
      primaryAccountId: input.accountId,
      membershipId: input.membershipId ?? ws.owner.membershipId,
      scheduledStart: new Date(at.getTime() - 3_600_000),
      scheduledEnd: new Date(at.getTime() + 3_600_000),
      timezone: 'Europe/Berlin',
      state: input.state ?? 'active',
      actualStart: input.state === 'scheduled' ? null : new Date(at.getTime() - 3_600_000),
      createdAt: at,
      updatedAt: at,
    });
  return id;
};

/** An uploaded, checked image (Library asset with one available version). */
export const insertImageAsset = async (ws: TestWorkspace, input: { projectId?: string | null; name?: string; status?: 'available' | 'checking' } = {}) => {
  const assetId = newId();
  const versionId = newId();
  const at = new Date();
  await db()
    .insert(assets)
    .values({ id: assetId, workspaceId: ws.workspaceId, name: input.name ?? 'portrait.jpg', kind: 'image', projectId: input.projectId ?? null, ownerMembershipId: ws.owner.membershipId, createdAt: at, updatedAt: at });
  await db()
    .insert(assetVersions)
    .values({ id: versionId, workspaceId: ws.workspaceId, assetId, versionNo: 1, status: input.status ?? 'available', originalFilename: input.name ?? 'portrait.jpg', declaredMime: 'image/jpeg', byteSize: 1024, createdAt: at, updatedAt: at });
  await db().update(assets).set({ currentVersionId: versionId }).where(eq(assets.id, assetId));
  return { assetId, versionId };
};
