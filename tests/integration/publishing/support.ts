import { eq } from 'drizzle-orm';
import { accountAssignments, assetVersions, assets, contentItems, contentVersionAssets, contentVersions } from '@castlane/database';
import { createSession, getAppServices } from '@castlane/application';
import { publicationEndpoints as P } from '@castlane/api-contracts';
import { newId, type ScopeType } from '@castlane/domain';
import {
  TestClient,
  addMember,
  assignToProject,
  createAccount,
  createDirection,
  createProject,
  createWorkspace,
  setClock,
  type TestWorkspace,
} from '../../support';

/**
 * Publishing fixtures. The application clock is fixed to a Monday in the future so plan weeks,
 * checkpoint windows and "future time" checks are deterministic; sessions are created at that clock
 * time. Rows of other modules (content, versions, files) are inserted directly.
 */
export const db = () => getAppServices().db;

/** Monday 2030-06-03 08:00 in Europe/Berlin (06:00 UTC). */
export const T0 = '2030-06-03T06:00:00.000Z';
export const at = (hoursFromT0: number) => new Date(new Date(T0).getTime() + hoursFromT0 * 3_600_000).toISOString();

export const clientAt = async (userId: string) => {
  const s = await createSession(db(), userId, getAppServices().clock.now(), { userAgent: 'vitest' }, { mfaVerified: true });
  return new TestClient(s.token).init();
};

export const insertContent = async (
  ws: TestWorkspace,
  projectId: string,
  input: { title?: string; approved?: boolean; withAsset?: boolean; episodeId?: string } = {},
) => {
  const id = newId();
  const now = new Date();
  const approvedVersionId = newId();
  const draftVersionId = newId();
  await db()
    .insert(contentItems)
    .values({
      id,
      workspaceId: ws.workspaceId,
      projectId,
      title: input.title ?? `Content ${id.slice(0, 4)}`,
      format: 'short_video',
      stage: input.approved === false ? 'review' : 'approved',
      ownerMembershipId: ws.owner.membershipId,
      episodeId: input.episodeId ?? null,
      createdAt: now,
      updatedAt: now,
    });
  // v1 approved (unless approved=false), v2 submitted and still awaiting review. v1 is submitted after its
  // file is attached (the DB refuses files on a submitted version).
  await db()
    .insert(contentVersions)
    .values([
      { id: approvedVersionId, workspaceId: ws.workspaceId, contentItemId: id, versionNo: 1, approvedAt: input.approved === false ? null : now, createdAt: now, updatedAt: now },
      { id: draftVersionId, workspaceId: ws.workspaceId, contentItemId: id, versionNo: 2, submittedAt: now, createdAt: now, updatedAt: now },
    ]);
  if (input.approved !== false)
    await db().update(contentItems).set({ approvedVersionId, currentVersionId: draftVersionId }).where(eq(contentItems.id, id));
  let assetId: string | null = null;
  if (input.withAsset) {
    assetId = newId();
    const assetVersionId = newId();
    await db().insert(assets).values({ id: assetId, workspaceId: ws.workspaceId, name: 'reel.mp4', kind: 'video', projectId, currentVersionId: null, createdAt: now, updatedAt: now });
    await db()
      .insert(assetVersions)
      .values({ id: assetVersionId, workspaceId: ws.workspaceId, assetId, versionNo: 1, status: 'available', originalFilename: 'reel.mp4', storageKey: `test/${assetVersionId}`, createdAt: now, updatedAt: now });
    await db().update(assets).set({ currentVersionId: assetVersionId }).where(eq(assets.id, assetId));
    await db().insert(contentVersionAssets).values({ id: newId(), workspaceId: ws.workspaceId, contentVersionId: approvedVersionId, slot: 'main_video', assetVersionId, createdAt: now, updatedAt: now });
  }
  await db().update(contentVersions).set({ submittedAt: now }).where(eq(contentVersions.id, approvedVersionId));
  return { id, approvedVersionId: input.approved === false ? null : approvedVersionId, pendingVersionId: draftVersionId, unapprovedVersionId: input.approved === false ? approvedVersionId : draftVersionId, assetId };
};

export const assignAccount = async (ws: TestWorkspace, accountId: string, membershipId: string) => {
  const now = new Date();
  await db()
    .insert(accountAssignments)
    .values({ id: newId(), workspaceId: ws.workspaceId, accountId, membershipId, duty: 'publishing', validFrom: new Date(now.getTime() - 1000), createdAt: now, updatedAt: now });
};

export const memberClient = async (
  ws: TestWorkspace,
  roleKey: string,
  opts: { projects?: string[]; accounts?: string[]; scopeType?: ScopeType; name?: string } = {},
) => {
  const scopeType = opts.scopeType ?? (roleKey === 'publisher' ? 'assigned_accounts' : ['project_lead', 'producer', 'creator'].includes(roleKey) ? 'assigned_projects' : 'workspace');
  const m = await addMember(db(), ws, { roleKey, scopeType, name: opts.name });
  for (const p of opts.projects ?? []) await assignToProject(db(), ws, p, m.membershipId);
  for (const a of opts.accounts ?? []) await assignAccount(ws, a, m.membershipId);
  return { ...m, client: await clientAt(m.userId) };
};

export const setup = async () => {
  setClock(T0);
  const ws = await createWorkspace(db(), { timezone: 'Europe/Berlin' });
  const owner = await clientAt(ws.owner.userId);
  const directionId = await createDirection(db(), ws, `Models ${newId().slice(0, 4)}`);
  const project = await createProject(db(), ws, { directionId, name: 'Emma', type: 'model' });
  const other = await createProject(db(), ws, { directionId, name: 'Nova', type: 'influencer' });
  const accountId = await createAccount(db(), ws, { projectId: project.id, url: `https://www.instagram.com/emma_${newId().slice(0, 6)}` });
  const otherAccountId = await createAccount(db(), ws, { projectId: other.id, url: `https://www.tiktok.com/@nova_${newId().slice(0, 6)}`, platform: 'tiktok' });
  const content = await insertContent(ws, project.id, { title: 'Morning Routine Reel', withAsset: true });
  return { ws, owner, W: { workspaceId: ws.workspaceId }, directionId, project, other, accountId, otherAccountId, content };
};

export type Fixture = Awaited<ReturnType<typeof setup>>;

/** Create a draft and schedule it in one request. */
export const scheduled = (c: TestClient, f: Fixture, input: { scheduledAt?: string; accountId?: string; contentItemId?: string; contentVersionId?: string; ownerMembershipId?: string; campaignId?: string } = {}) =>
  c.call(P.create, {
    params: f.W,
    body: {
      contentItemId: input.contentItemId ?? f.content.id,
      contentVersionId: input.contentVersionId ?? f.content.approvedVersionId ?? undefined,
      accountId: input.accountId ?? f.accountId,
      ownerMembershipId: input.ownerMembershipId ?? f.ws.owner.membershipId,
      primaryCampaignId: input.campaignId,
      caption: 'New morning routine ✨',
      scheduledAt: input.scheduledAt ?? at(26),
      timezone: 'Europe/Berlin',
      schedule: true,
    },
  });

export const publish = (c: TestClient, f: Fixture, pub: { id: string; rowVersion: number }, body: { actualPublishedAt?: string; externalUrl?: string; noUrlReason?: string } = {}, opts: { idempotencyKey?: string } = {}) =>
  c.attempt(P.markPublished, { params: { ...f.W, publicationId: pub.id }, body: { actualPublishedAt: body.actualPublishedAt ?? at(0), ...body } }, { ifMatch: pub.rowVersion, ...opts });
