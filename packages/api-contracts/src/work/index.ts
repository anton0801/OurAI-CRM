import type { AnyEndpoint } from '../core';
import { commentEndpoints } from './comments';
import { myWorkEndpoints } from './my-work';
import { recurrenceEndpoints, reminderEndpoints, taskEndpoints } from './tasks';
import { timeEndpoints } from './time';
import { workloadEndpoints } from './workload';

export * from './common';
export * from './tasks';
export * from './time';
export * from './workload';
export * from './my-work';
export * from './comments';

/** Endpoint groups of the work module (tasks, time, workload, my work, comments). */
export const workEndpointGroups: Record<string, Record<string, AnyEndpoint>> = {
  tasks: taskEndpoints,
  recurrences: recurrenceEndpoints,
  reminders: reminderEndpoints,
  time: timeEndpoints,
  workload: workloadEndpoints,
  myWork: myWorkEndpoints,
  comments: commentEndpoints,
};
