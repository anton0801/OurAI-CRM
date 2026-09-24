import { accountEndpoints, characterEndpoints, directionEndpoints, projectEndpoints, referenceEndpoints, seriesEndpoints } from '@castlane/api-contracts';
import type { DemoCtx } from './types';
import { day } from './types';

/** Projects, team, accounts, characters, series structure and references. */
export const stageBase = async (c: DemoCtx & { png: (w: number, h: number, bg: string) => Promise<Buffer> }) => {
  const { client, workspaceId: W, ownerMembershipId: owner, team } = c;
  const params = { workspaceId: W };
  let dirs = await client.call(directionEndpoints.list, { params, query: {} });
  if (dirs.length === 0) {
    // Workspace setup was skipped: create the three standard directions.
    for (const name of ['AI Series', 'AI Models', 'AI Influencers']) await client.call(directionEndpoints.create, { params, body: { name } });
    dirs = await client.call(directionEndpoints.list, { params, query: {} });
  }
  const dir = (name: RegExp, fallback: number) => dirs.find((d) => name.test(d.name))?.id ?? dirs[fallback]?.id ?? dirs[0]!.id;

  const series = await client.call(projectEndpoints.create, {
    params,
    body: {
      name: 'Night Shift',
      type: 'series',
      directionId: dir(/series/i, 0),
      ownerMembershipId: team.producer.membershipId,
      briefSummary: 'Eight-episode AI thriller about a paramedic working night shifts in a city that never sleeps.',
      audience: 'Adults 18–34 who follow short-form drama.',
      language: 'en',
      targetMarkets: ['US', 'UK'],
      tags: ['thriller', 'season-1'],
      startDate: day(-30),
      activate: true,
    },
  });
  const model = await client.call(projectEndpoints.create, {
    params,
    body: {
      name: 'Mia Nova',
      type: 'model',
      directionId: dir(/model/i, 1),
      ownerMembershipId: team.modelLead.membershipId,
      briefSummary: 'AI model with a warm, playful lifestyle persona; fashion and travel content with an OFM operation.',
      audience: 'Adults interested in fashion and travel.',
      language: 'en',
      targetMarkets: ['US', 'DE'],
      ofmEnabled: true,
      startDate: day(-60),
      activate: true,
    },
  });
  const influencer = await client.call(projectEndpoints.create, {
    params,
    body: {
      name: 'Leo Vale',
      type: 'influencer',
      directionId: dir(/influencer/i, 2),
      ownerMembershipId: team.producer.membershipId,
      briefSummary: 'AI tech reviewer: honest, fast gadget reviews and weekly news recaps.',
      language: 'en',
      startDate: day(-14),
      activate: true,
    },
  });
  const projects = { series: series.id, model: model.id, influencer: influencer.id };

  const add = (projectId: string, membershipId: string, responsibility?: 'producing' | 'writing' | 'image_generation' | 'video_generation' | 'publishing') =>
    client.call(projectEndpoints.addMember, { params: { ...params, projectId }, body: { membershipId, responsibility: responsibility ?? null } }).catch(() => undefined);
  await add(projects.series, team.producer.membershipId, 'producing');
  await add(projects.series, team.creator.membershipId, 'video_generation');
  await add(projects.model, team.modelLead.membershipId, 'producing');
  await add(projects.model, team.creator.membershipId, 'image_generation');
  await add(projects.influencer, team.creator.membershipId, 'writing');
  await add(projects.influencer, team.producer.membershipId, 'producing');
  await add(projects.series, team.publisher.membershipId, 'publishing');
  await add(projects.model, team.publisher.membershipId, 'publishing');

  const account = (projectId: string, platform: 'instagram' | 'tiktok' | 'youtube' | 'onlyfans' | 'x', profileUrl: string, handle: string, ownerId: string) =>
    client.call(accountEndpoints.create, { params, body: { projectId, platform, profileUrl, handle, ownerMembershipId: ownerId, status: 'active', metricsCadence: 'weekly' } });
  const accounts = {
    seriesTikTok: (await account(projects.series, 'tiktok', 'https://www.tiktok.com/@nightshift.series', 'nightshift.series', team.publisher.membershipId)).id,
    seriesYouTube: (await account(projects.series, 'youtube', 'https://www.youtube.com/@NightShiftSeries', 'NightShiftSeries', team.publisher.membershipId)).id,
    miaInstagram: (await account(projects.model, 'instagram', 'https://www.instagram.com/mia.nova.daily/', 'mia.nova.daily', team.modelLead.membershipId)).id,
    miaOnlyFans: (await account(projects.model, 'onlyfans', 'https://onlyfans.com/mianova', 'mianova', team.modelLead.membershipId)).id,
    leoX: (await account(projects.influencer, 'x', 'https://x.com/leovale_tech', 'leovale_tech', owner)).id,
  };

  const mia = await client.call(characterEndpoints.create, {
    params: { ...params, projectId: projects.model },
    body: {
      name: 'Mia Nova',
      role: 'Primary persona',
      isPrimary: true,
      profile: {
        fictionalIdentityNote: 'Fictional AI character. Not a real person.',
        adultAgeDeclaration: { declared: true, statedAge: 26 },
        appearance: 'Shoulder-length copper hair, green eyes, freckles, warm natural light.',
        voice: 'Friendly, curious, light humour.',
        biography: 'Grew up by the sea, travels for fashion weeks, loves film cameras.',
        styleConstraints: 'No logos of real brands; no minors in frame; consistent freckles.',
      },
      prompts: [{ title: 'Base portrait', text: 'portrait of Mia Nova, copper hair, freckles, soft window light, 50mm', tool: 'Image generator' }],
      changeNote: 'Initial profile',
    },
  });
  const nurse = await client.call(characterEndpoints.create, {
    params: { ...params, projectId: projects.series },
    body: {
      name: 'Alex Reed',
      role: 'Lead — night-shift paramedic',
      profile: { fictionalIdentityNote: 'Fictional character.', appearance: 'Early thirties, tired eyes, reflective jacket.', voice: 'Calm, dry humour under pressure.' },
    },
  });

  const season = await client.call(seriesEndpoints.createSeason, { params: { ...params, projectId: projects.series }, body: { name: 'Season 1' } });
  const episodes: string[] = [];
  for (const [n, title, synopsis] of [
    [1, 'Last Call', 'Alex takes a call that should not exist: an address that burned down ten years ago.'],
    [2, 'Blue Hour', 'A patient recognises Alex from a night Alex cannot remember.'],
    [3, 'Dispatch', 'The dispatcher’s voice changes mid-shift.'],
  ] as const) {
    const e = await client.call(seriesEndpoints.createEpisode, { params: { ...params, seasonId: season.id }, body: { number: n, title, synopsis, targetDurationSeconds: 90, language: 'en' } });
    episodes.push(e.id);
  }

  const ref = (title: string, sourceUrl: string, whatToReuse: string, projectId: string | null, tags: ('hook' | 'lighting' | 'story' | 'edit' | 'character' | 'other')[]) =>
    client.call(referenceEndpoints.create, { params, body: { title, sourceUrl, whatToReuse, projectId, tags } });
  const references = [
    (await ref('Cold open with a phone ringing', 'https://example.com/reference/cold-open', 'First two seconds: ringing phone in darkness, then the address on screen.', projects.series, ['hook', 'story'])).id,
    (await ref('Window-light portrait series', 'https://example.com/reference/window-light', 'Soft side light and film grain for the weekly portrait set.', projects.model, ['lighting'])).id,
    (await ref('60-second gadget verdict', 'https://example.com/reference/verdict', 'Verdict in the first 5 seconds, then three quick reasons.', projects.influencer, ['edit', 'story'])).id,
  ];

  return { projects, accounts, characters: { mia: mia.id, alex: nurse.id }, seasonId: season.id, episodes, references };
};
export type DemoBase = Awaited<ReturnType<typeof stageBase>>;
