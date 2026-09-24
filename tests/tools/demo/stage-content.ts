import { contentEndpoints, contentVersionEndpoints, publicationEndpoints, reviewEndpoints } from '@castlane/api-contracts';
import { getAppServices } from '@castlane/application';
import { sessionFor } from '@castlane/test-fixtures';
import { TestClient } from '../../support/client';
import { uploadFile } from '../../integration/media/helpers';
import type { DemoBase } from './stage-base';
import type { DemoCtx } from './types';
import { at } from './types';

/** Content items across the pipeline; two approved versions with real files; placements, one published. */
export const stageContent = async (c: DemoCtx & { base: DemoBase; png: (w: number, h: number, bg: string) => Promise<Buffer> }) => {
  const { client, workspaceId: W, team, base, tz } = c;
  const params = { workspaceId: W };
  const db = getAppServices().db;
  const clientOf = async (m: { userId: string }) => new TestClient(await sessionFor(db, m.userId, { workspaceId: W })).init();
  const leads = { [base.projects.series]: team.producer, [base.projects.influencer]: team.producer, [base.projects.model]: team.modelLead };

  const create = (projectId: string, title: string, format: 'short_video' | 'image' | 'episode' | 'carousel', extra: Record<string, unknown> = {}) =>
    client.call(contentEndpoints.create, {
      params,
      body: {
        projectId,
        title,
        format,
        ownerMembershipId: team.creator.membershipId,
        reviewerMembershipId: leads[projectId]!.membershipId,
        brief: { summary: `${title}.`, objective: 'Grow watch time and followers.' },
        dueAt: at(24 * 5),
        ...extra,
      } as never,
    });
  const move = async (id: string, stages: string[]) => {
    for (const s of stages) {
      const cur = await client.call(contentEndpoints.get, { params: { ...params, contentId: id } });
      await client.call(contentEndpoints.transition, { params: { ...params, contentId: id }, body: { targetStage: s as never } }, { ifMatch: cur.rowVersion });
    }
  };
  const approveWithFile = async (id: string, projectId: string, colour: string, slot: 'main_video' | 'main_image') => {
    const reviewer = leads[projectId]!;
    const producer = await clientOf(reviewer);
    await move(id, ['brief', 'ready', 'production']);
    const v = await client.call(contentVersionEndpoints.create, { params: { ...params, contentId: id }, body: { note: 'First cut' } });
    const up = await uploadFile(client, W, await c.png(1080, 1350, colour), { filename: 'cover.png', purpose: 'content', projectId: undefined } as never);
    const asset = await client.call(contentVersionEndpoints.attachFile, { params: { ...params, contentId: id, versionId: v.id }, body: { slot, assetVersionId: up.assetVersionId } } as never).catch(async () =>
      client.call(contentVersionEndpoints.attachFile, { params: { ...params, contentId: id, versionId: v.id }, body: { slot: 'main_image', assetVersionId: up.assetVersionId } } as never),
    );
    void asset;
    // Tick the version checklist (as the creator would after checking the files).
    const vd = await client.call(contentVersionEndpoints.get, { params: { ...params, contentId: id, versionId: v.id } });
    await client.call(
      contentVersionEndpoints.update,
      { params: { ...params, contentId: id, versionId: v.id }, body: { checklist: vd.checklist.map((i) => ({ label: i.label, done: true, mandatory: i.mandatory })) } },
      { ifMatch: vd.rowVersion },
    );
    const cur = await client.call(contentEndpoints.get, { params: { ...params, contentId: id } });
    const sub = await client.call(contentVersionEndpoints.submit, { params: { ...params, contentId: id }, body: { versionId: v.id, reviewerMembershipId: reviewer.membershipId } }, { ifMatch: cur.rowVersion });
    void sub;
    const queue = await producer.call(reviewEndpoints.list, { params, query: { scope: 'assigned' } });
    const reviewId = queue.items.find((r) => r.versionId === v.id)?.id;
    if (!reviewId) throw new Error('Review not found after submit');
    const r = await producer.call(reviewEndpoints.get, { params: { ...params, reviewId } });
    await producer.call(reviewEndpoints.approve, { params: { ...params, reviewId }, body: { versionId: v.id, decisionNote: 'Great pacing. Approved.' } } as never, { ifMatch: r.rowVersion });
    return v.id;
  };

  const ep1 = await create(base.projects.series, 'Episode 1 — Last Call', 'episode', { episodeId: base.episodes[0] });
  const teaser = await create(base.projects.series, 'Teaser: the address that burned down', 'short_video', { accountId: base.accounts.seriesTikTok });
  const portrait = await create(base.projects.model, 'Autumn city portrait', 'image', { accountId: base.accounts.miaInstagram });
  const verdict = await create(base.projects.influencer, 'Budget phone verdict (60s)', 'short_video', { accountId: base.accounts.leoX });
  await create(base.projects.series, 'Episode 2 — Blue Hour', 'episode', { episodeId: base.episodes[1] });
  await create(base.projects.model, 'Weekend travel reel idea', 'short_video', { noDeadline: true, dueAt: null });

  const teaserVersion = await approveWithFile(teaser.id, base.projects.series, '#1d3b53', 'main_video');
  const portraitVersion = await approveWithFile(portrait.id, base.projects.model, '#a4553a', 'main_image');
  await move(ep1.id, ['brief', 'ready', 'production']);
  await move(verdict.id, ['brief']);

  // Placements: the teaser is published (URL + real time), the portrait set is scheduled.
  const pub = await client.call(publicationEndpoints.create, {
    params,
    body: { contentItemId: teaser.id, accountId: base.accounts.seriesTikTok, contentVersionId: teaserVersion, ownerMembershipId: team.publisher.membershipId, caption: 'Some calls should never be answered. #NightShift', scheduledAt: at(2), timezone: tz, schedule: true },
  } as never);
  const cur = await client.call(publicationEndpoints.get, { params: { ...params, publicationId: pub.id } } as never) as { rowVersion: number };
  await client.call(
    publicationEndpoints.markPublished,
    { params: { ...params, publicationId: pub.id }, body: { actualPublishedAt: at(-1), externalUrl: 'https://www.tiktok.com/@nightshift.series/video/7400000000000000001' } },
    { ifMatch: cur.rowVersion },
  );
  await client.call(publicationEndpoints.create, {
    params,
    body: { contentItemId: portrait.id, accountId: base.accounts.miaInstagram, contentVersionId: portraitVersion, ownerMembershipId: team.publisher.membershipId, caption: 'Autumn in the city ☕🍂', scheduledAt: at(26), timezone: tz, schedule: true },
  } as never);
  return { content: { ep1: ep1.id, teaser: teaser.id, portrait: portrait.id, verdict: verdict.id }, publications: { teaser: pub.id } };
};
