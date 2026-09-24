import { eq } from 'drizzle-orm';
import { contentEndpoints, contentVersionEndpoints, mediaEndpoints, reviewEndpoints, type EndpointBody } from '@castlane/api-contracts';
import { getAppServices } from '@castlane/application';
import { assetVersions, projects } from '@castlane/database';
import { addMember, assignToProject, clientFor, createDirection, createProject, createWorkspace, runQueuedJobs, sessionFor, type TestClient } from '../../support';
import { png, putParts } from '../media/helpers';

export const db = () => getAppServices().db;

export const C = contentEndpoints;
export const V = contentVersionEndpoints;
export const R = reviewEndpoints;

export interface ProdFixture {
  ws: Awaited<ReturnType<typeof createWorkspace>>;
  owner: TestClient;
  projectId: string;
  otherProjectId: string;
  params: { workspaceId: string };
}

/** Workspace with an Owner client and two active projects. */
export const prodFixture = async (): Promise<ProdFixture> => {
  const ws = await createWorkspace(db());
  const owner = await clientFor(await sessionFor(db(), ws.owner.userId));
  const directionId = await createDirection(db(), ws, 'AI Series');
  const p = await createProject(db(), ws, { directionId, name: 'Night Shift' });
  const o = await createProject(db(), ws, { directionId, name: 'Other Project' });
  return { ws, owner, projectId: p.id, otherProjectId: o.id, params: { workspaceId: ws.workspaceId } };
};

export const member = async (f: ProdFixture, roleKey: string, opts: { projects?: string[]; name?: string; scopeType?: 'workspace' | 'assigned_projects' | 'assigned_object' | 'assigned_accounts' } = {}) => {
  const scopeType = opts.scopeType ?? (['creator', 'producer', 'project_lead'].includes(roleKey) ? 'assigned_projects' : roleKey === 'contractor' ? 'assigned_object' : 'workspace');
  const m = await addMember(db(), f.ws, { roleKey, scopeType, name: opts.name });
  for (const p of opts.projects ?? []) await assignToProject(db(), f.ws, p, m.membershipId);
  return { ...m, client: await clientFor(await sessionFor(db(), m.userId)) };
};

export const setPolicy = async (projectId: string, policy: { contentQualityStep?: boolean; releaseApprovalStep?: boolean; allowSelfReview?: boolean }) =>
  db()
    .update(projects)
    .set({ reviewPolicy: { contentQualityStep: false, releaseApprovalStep: true, allowSelfReview: false, ...policy } })
    .where(eq(projects.id, projectId));

type CreateBody = EndpointBody<typeof contentEndpoints.create>;

export const newContent = (c: TestClient, f: ProdFixture, body: Partial<CreateBody> = {}) =>
  c.call(C.create, { params: f.params, body: { title: 'Morning Routine Reel', projectId: f.projectId, format: 'image', ...body } as CreateBody });

export const getContent = (c: TestClient, f: ProdFixture, id: string) => c.call(C.get, { params: { ...f.params, contentId: id } });

export const move = async (c: TestClient, f: ProdFixture, id: string, targetStage: string, reason?: string) => {
  const cur = await getContent(c, f, id);
  return c.attempt(C.transition, { params: { ...f.params, contentId: id }, body: { targetStage: targetStage as never, ...(reason ? { reason } : {}) } }, { ifMatch: cur.rowVersion });
};

/** Create content and bring it to Production with owner and reviewer. */
export const contentInProduction = async (c: TestClient, f: ProdFixture, input: { ownerMembershipId: string; reviewerMembershipId: string; format?: CreateBody['format']; projectId?: string }) => {
  const created = await newContent(c, f, {
    format: input.format ?? 'image',
    projectId: input.projectId ?? f.projectId,
    ownerMembershipId: input.ownerMembershipId,
    reviewerMembershipId: input.reviewerMembershipId,
    brief: { summary: 'A calm morning routine for the model account.', objective: 'Grow saves' },
    noDeadline: true,
  });
  for (const s of ['brief', 'ready', 'production']) {
    const r = await move(c, f, created.id, s);
    if (!r.ok) throw new Error(`Move to ${s} failed: ${r.code} ${JSON.stringify(r.error)}`);
  }
  return getContent(c, f, created.id);
};

/** Upload a PNG (optionally without running the verification job). */
export const uploadPng = async (c: TestClient, f: ProdFixture, opts: { process?: boolean; projectId?: string; width?: number } = {}) => {
  const body = await png(opts.width ?? 600, 400);
  const init = await c.call(mediaEndpoints.initiateUpload, {
    params: f.params,
    body: { filename: 'frame.png', mimeType: 'image/png', byteSize: body.length, purpose: 'content', projectId: opts.projectId ?? f.projectId },
  });
  const etags = await putParts(init.parts, body, init.partSize);
  await c.call(mediaEndpoints.completeUpload, { params: { ...f.params, uploadId: init.uploadId }, body: { parts: etags } });
  if (opts.process !== false) await runQueuedJobs(['media.process']);
  return init;
};

/** A minimal MP4 container header (sniffed as video/mp4); the duration is set like ffprobe would. */
export const uploadVideo = async (c: TestClient, f: ProdFixture, durationMs: number | null) => {
  const body = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(12, 0), Buffer.from('moov'), Buffer.alloc(200, 1)]);
  const init = await c.call(mediaEndpoints.initiateUpload, { params: f.params, body: { filename: 'cut.mp4', mimeType: 'video/mp4', byteSize: body.length, purpose: 'content', projectId: f.projectId } });
  const etags = await putParts(init.parts, body, init.partSize);
  await c.call(mediaEndpoints.completeUpload, { params: { ...f.params, uploadId: init.uploadId }, body: { parts: etags } });
  await runQueuedJobs(['media.process']);
  if (durationMs !== null) await db().update(assetVersions).set({ durationMs }).where(eq(assetVersions.id, init.assetVersionId));
  return init;
};

/** New draft version with one file in `slot`, checklist ticked. */
export const versionWithFile = async (c: TestClient, f: ProdFixture, contentId: string, assetVersionId: string, slot: EndpointBody<typeof contentVersionEndpoints.attachFile>['slot'] = 'main_image') => {
  const v = await c.call(V.create, { params: { ...f.params, contentId }, body: {} });
  await c.call(V.attachFile, { params: { ...f.params, contentId, versionId: v.id }, body: { slot, assetVersionId } });
  const cur = await c.call(V.get, { params: { ...f.params, contentId, versionId: v.id } });
  return c.call(V.update, { params: { ...f.params, contentId, versionId: v.id }, body: { checklist: cur.checklist.map((i) => ({ label: i.label, mandatory: i.mandatory, done: true })) } }, { ifMatch: cur.rowVersion });
};

export const submit = async (c: TestClient, f: ProdFixture, contentId: string, versionId: string, extra: Partial<EndpointBody<typeof contentVersionEndpoints.submit>> = {}) => {
  const cur = await getContent(c, f, contentId);
  return c.attempt(V.submit, { params: { ...f.params, contentId }, body: { versionId, ...extra } }, { ifMatch: cur.rowVersion });
};

/** Content in review with one approved-able image version; returns ids. */
export const contentInReview = async (author: TestClient, f: ProdFixture, input: { ownerMembershipId: string; reviewerMembershipId: string; creator?: TestClient }) => {
  const lead = input.creator ?? author;
  const content = await contentInProduction(lead, f, input);
  const up = await uploadPng(author, f);
  const v = await versionWithFile(author, f, content.id, up.assetVersionId);
  const s = await submit(author, f, content.id, v.id);
  if (!s.ok) throw new Error(`submit failed: ${s.code} ${JSON.stringify(s.error)}`);
  const detail = await getContent(lead, f, content.id);
  return { contentId: content.id, versionId: v.id, reviewId: detail.activeReview!.id, assetVersionId: up.assetVersionId, assetId: up.assetId };
};

export const review = (c: TestClient, f: ProdFixture, reviewId: string) => c.call(R.get, { params: { ...f.params, reviewId } });
