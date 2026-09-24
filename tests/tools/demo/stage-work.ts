import { taskEndpoints } from '@castlane/api-contracts';
import type { DemoBase } from './stage-base';
import type { DemoCtx } from './types';
import { day } from './types';

/** Tasks with realistic states, deadlines and checklists. */
export const stageWork = async (c: DemoCtx & { base: DemoBase }) => {
  const { client, workspaceId: W, team, base, tz } = c;
  const params = { workspaceId: W };
  const task = (projectId: string, title: string, assignee: string | null, dueDays: number | null, extra: Record<string, unknown> = {}) =>
    client.call(taskEndpoints.create, {
      params,
      body: {
        projectId,
        title,
        assigneeMembershipId: assignee,
        status: assignee ? 'ready' : 'backlog',
        due: dueDays === null ? null : { kind: 'date', date: day(dueDays), timezone: tz },
        ...extra,
      } as never,
    });
  const t = {
    script: await task(base.projects.series, 'Write script for episode 2 “Blue Hour”', team.producer.membershipId, 3, {
      estimateMinutes: 240,
      checklist: [
        { label: 'Beat sheet approved', mandatory: true },
        { label: 'Dialogue pass', mandatory: true },
        { label: 'Read-through notes', mandatory: false },
      ],
    }),
    shots: await task(base.projects.series, 'Generate storyboard frames for episode 1', team.creator.membershipId, -1, { estimateMinutes: 180, priority: 'high' }),
    sound: await task(base.projects.series, 'Pick ambient sound for dispatch scenes', null, null),
    shoot: await task(base.projects.model, 'Weekly portrait set — autumn city', team.creator.membershipId, 2, { estimateMinutes: 300 }),
    captions: await task(base.projects.model, 'Write captions for the autumn set', team.modelLead.membershipId, 4, { accountId: base.accounts.miaInstagram }),
    review: await task(base.projects.influencer, 'Research: three budget phones for the verdict video', team.creator.membershipId, 6, { estimateMinutes: 120 }),
  };
  return t;
};
