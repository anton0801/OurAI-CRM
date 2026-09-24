import { randomBytes } from 'node:crypto';
import sharp from 'sharp';
import {
  accountEndpoints,
  contentEndpoints,
  contentVersionEndpoints,
  directionEndpoints,
  mediaEndpoints,
  projectEndpoints,
  reviewEndpoints,
} from '@castlane/api-contracts';
import { E2EApi, eventually } from './api';
import { readOwner } from './helpers';
import { createMember, ownerMembershipId, type E2EMember } from './members';

export const uniqueSuffix = () => randomBytes(3).toString('hex');

const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();

/** An active project with the Owner as lead (default direction from the setup wizard). */
export const stageProject = async (owner: E2EApi, input: { name: string; type?: 'series' | 'model' | 'influencer' }) => {
  const params = { workspaceId: readOwner().workspaceId };
  const dirs = await owner.call(directionEndpoints.list, { params, query: {} });
  const directionId = (dirs.find((d) => /series/i.test(d.name)) ?? dirs[0])!.id;
  return owner.call(projectEndpoints.create, {
    params,
    body: {
      name: input.name,
      type: input.type ?? 'series',
      directionId,
      ownerMembershipId: await ownerMembershipId(),
      briefSummary: `${input.name}: short AI thriller episodes for the e2e suite.`,
      activate: true,
    },
  });
};

/** Upload a real PNG through initiate → signed part PUT → complete, then wait for verification. */
export const uploadPng = async (api: E2EApi, projectId: string, colour = '#1d3b53') => {
  const workspaceId = readOwner().workspaceId;
  const body = await sharp({ create: { width: 1080, height: 1350, channels: 3, background: colour } }).png().toBuffer();
  const init = await api.call(mediaEndpoints.initiateUpload, {
    params: { workspaceId },
    body: { filename: 'cover.png', mimeType: 'image/png', byteSize: body.length, purpose: 'content', projectId },
  });
  const parts: { partNumber: number; etag: string }[] = [];
  for (const p of init.parts) {
    const chunk = body.subarray((p.partNumber - 1) * init.partSize, p.partNumber * init.partSize);
    parts.push({ partNumber: p.partNumber, etag: await api.putPart(p.url, chunk, p.headers) });
  }
  await api.call(mediaEndpoints.completeUpload, { params: { workspaceId, uploadId: init.uploadId }, body: { parts } });
  return init;
};

export interface ReviewStage {
  projectId: string;
  projectName: string;
  accountId: string;
  accountHandle: string;
  contentId: string;
  title: string;
  versionId: string;
  reviewId: string;
  creator: E2EMember;
}

/**
 * A realistic review waiting for the Owner: the Owner sets up project, account and content
 * (brief → ready → production); a Creator on the project adds version 1 with a verified image,
 * ticks the checklist and submits it with the Owner as reviewer.
 */
export const stageReview = async (input: { title: string }): Promise<ReviewStage> => {
  const owner = await E2EApi.owner();
  const workspaceId = readOwner().workspaceId;
  const params = { workspaceId };
  const suffix = uniqueSuffix();
  const projectName = `Night Desk ${suffix}`;
  const project = await stageProject(owner, { name: projectName });
  const reviewer = await ownerMembershipId();
  const creator = await createMember({ name: 'Mila Creator', roleKey: 'creator', scopeType: 'assigned_projects' });
  await owner.call(projectEndpoints.addMember, { params: { ...params, projectId: project.id }, body: { membershipId: creator.membershipId, responsibility: 'image_generation' } });
  const accountHandle = `nightdesk_${suffix}`;
  const account = await owner.call(accountEndpoints.create, {
    params,
    body: { projectId: project.id, platform: 'tiktok', profileUrl: `https://www.tiktok.com/@${accountHandle}`, handle: accountHandle, ownerMembershipId: reviewer, status: 'active', metricsCadence: 'weekly' },
  });

  const content = await owner.call(contentEndpoints.create, {
    params,
    body: {
      projectId: project.id,
      title: input.title,
      format: 'image',
      ownerMembershipId: creator.membershipId,
      reviewerMembershipId: reviewer,
      accountId: account.id,
      brief: { summary: 'Cover image for the first episode.', objective: 'Stop the scroll in the first second.' },
      dueAt: inDays(5),
    },
  });
  for (const targetStage of ['brief', 'ready', 'production'] as const) {
    const cur = await owner.call(contentEndpoints.get, { params: { ...params, contentId: content.id } });
    await owner.call(contentEndpoints.transition, { params: { ...params, contentId: content.id }, body: { targetStage } }, { ifMatch: cur.rowVersion });
  }

  // The Creator's part: version, file, checklist, submit.
  const c = creator.api;
  const vParams = { ...params, contentId: content.id };
  const v = await c.call(contentVersionEndpoints.create, { params: vParams, body: { note: 'First cut of the cover.' } });
  const up = await uploadPng(c, project.id);
  await c.call(contentVersionEndpoints.attachFile, { params: { ...vParams, versionId: v.id }, body: { slot: 'main_image', assetVersionId: up.assetVersionId } });
  const ready = await eventually(async () => {
    const d = await c.call(contentVersionEndpoints.get, { params: { ...vParams, versionId: v.id } });
    return d.files.length > 0 && d.files.every((f) => f.status === 'available') ? d : null;
  }, 'the uploaded file to be verified');
  await c.call(
    contentVersionEndpoints.update,
    { params: { ...vParams, versionId: v.id }, body: { checklist: ready.checklist.map((i) => ({ label: i.label, done: true, mandatory: i.mandatory })) } },
    { ifMatch: ready.rowVersion },
  );
  const cur = await c.call(contentEndpoints.get, { params: vParams });
  await c.call(contentVersionEndpoints.submit, { params: vParams, body: { versionId: v.id, reviewerMembershipId: reviewer } }, { ifMatch: cur.rowVersion });

  const queue = await owner.call(reviewEndpoints.list, { params, query: { scope: 'assigned' } });
  const review = queue.items.find((r) => r.versionId === v.id);
  if (!review) throw new Error('The submitted version is not in the Owner’s review queue.');
  return { projectId: project.id, projectName, accountId: account.id, accountHandle, contentId: content.id, title: input.title, versionId: v.id, reviewId: review.id, creator };
};
