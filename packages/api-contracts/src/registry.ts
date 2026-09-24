import type { AnyEndpoint } from './core';
import { authEndpoints, setupEndpoints } from './auth';
import { shellEndpoints } from './shell';
import { lookupEndpoints } from './lookup';
import { directionEndpoints, peopleEndpoints, projectEndpoints } from './organization';
import { mediaEndpoints } from './media';
import { folderEndpoints } from './media';
import { knowledgeEndpoints } from './knowledge';

/**
 * Every endpoint group, used by the OpenAPI generator and contract tests.
 * Modules append their groups here.
 */
export const ENDPOINT_GROUPS: Record<string, Record<string, AnyEndpoint>> = {
  auth: authEndpoints,
  setup: setupEndpoints,
  shell: shellEndpoints,
  lookup: lookupEndpoints,
  people: peopleEndpoints,
  directions: directionEndpoints,
  projects: projectEndpoints,
  media: mediaEndpoints,
  folders: folderEndpoints,
  knowledge: knowledgeEndpoints,
};

export const allEndpoints = (): AnyEndpoint[] => Object.values(ENDPOINT_GROUPS).flatMap((g) => Object.values(g));
