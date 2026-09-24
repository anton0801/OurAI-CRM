import { goalEndpoints, metricsEndpoints } from '@castlane/api-contracts';
import type { DemoBase } from './stage-base';
import type { DemoCtx } from './types';
import { at, day } from './types';

/** Weekly account snapshots, a 24h publication checkpoint measurement and a follower goal. */
export const stageInsights = async (c: DemoCtx & { base: DemoBase; teaserPublicationId: string }) => {
  const { client, workspaceId: W, team, base } = c;
  const params = { workspaceId: W };
  const known = (metricKey: string, value: string) => ({ metricKey, availability: 'known' as const, value });

  // Six weekly snapshots of Mia Nova's Instagram (entered manually from the platform's insights screen).
  const followers = [11820, 12040, 12310, 12655, 12980, 13420];
  for (let i = 0; i < followers.length; i++) {
    await client.call(metricsEndpoints.create, {
      params,
      body: {
        entityType: 'account',
        entityId: base.accounts.miaInstagram,
        kind: 'snapshot',
        observedAt: at(-24 * 7 * (followers.length - 1 - i) - 3),
        sourceType: 'manual',
        sourceNote: 'Instagram professional dashboard, copied by the account owner.',
        values: [known('account.followers', String(followers[i])), known('account.total_posts', String(180 + i * 4))],
        warningNote: 'Weekly snapshot.',
      },
    });
  }

  // The published teaser's 24h measurement: shares are not shown by the platform yet (unknown, not zero).
  const checkpoints = await client.call(metricsEndpoints.checkpoints, { params, query: { tab: 'all', publicationId: c.teaserPublicationId } } as never).catch(() => null);
  const cp = (checkpoints as { items?: { id: string; checkpointKey?: string; key?: string }[] } | null)?.items?.find((x) => (x.checkpointKey ?? x.key ?? '').includes('24'));
  await client.call(metricsEndpoints.create, {
    params,
    body: {
      entityType: 'publication',
      entityId: c.teaserPublicationId,
      kind: 'cumulative',
      observedAt: at(0),
      sourceType: 'manual',
      sourceNote: 'TikTok analytics for the video, 24 hours after posting.',
      values: [
        known('publication.views', '48210'),
        known('publication.likes', '5120'),
        known('publication.comments', '312'),
        { metricKey: 'publication.shares', availability: 'unknown' },
        known('publication.saves', '890'),
      ],
      checkpointId: cp?.id ?? null,
      warningNote: 'Shares not shown yet.',
    },
  });

  await client.call(goalEndpoints.create, {
    params,
    body: {
      name: 'Mia Nova Instagram: +3,000 followers this quarter',
      ownerMembershipId: team.modelLead.membershipId,
      scopeType: 'account',
      scopeId: base.accounts.miaInstagram,
      metricId: 'M11',
      targetType: 'increase_by',
      targetValue: '3000',
      baselineValue: '11820',
      periodStart: day(-40),
      periodEnd: day(50),
    },
  });
};
