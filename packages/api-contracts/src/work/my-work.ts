import { z } from 'zod';
import { endpoint } from '../core';
import { isoDate, wsId } from '../common';
import { taskRow } from './common';
import { reminderView } from './tasks';
import { timerView } from './time';

export const MY_WORK_TASK_SECTIONS = ['today', 'upcoming', 'overdue', 'assigned', 'reviewing', 'following'] as const;

const section = z.object({ items: z.array(taskRow), total: z.number().int() });

export const myWorkEndpoints = {
  get: endpoint({
    id: 'myWork.get',
    method: 'GET',
    path: '/workspaces/{workspaceId}/my-work',
    summary: 'Your actionable tasks by section (Today in your personal time zone), due reminders and running timer.',
    tags: ['My Work'],
    auth: 'workspace',
    params: wsId({}),
    query: z.object({ limit: z.coerce.number().int().min(1).max(100).default(30) }),
    response: z.object({
      timezone: z.string(),
      today: isoDate,
      canReadTasks: z.boolean(),
      sections: z.object({
        today: section,
        upcoming: section,
        overdue: section,
        assigned: section,
        reviewing: section,
        following: section,
      }),
      reminders: z.array(reminderView),
      timer: timerView.nullable(),
    }),
  }),
};
