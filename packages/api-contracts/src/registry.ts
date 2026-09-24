import type { AnyEndpoint } from './core';
import { authEndpoints, setupEndpoints } from './auth';
import { shellEndpoints } from './shell';
import { lookupEndpoints } from './lookup';
import { directionEndpoints, peopleEndpoints, projectEndpoints } from './organization';
import { mediaEndpoints } from './media';
import { folderEndpoints } from './media';
import { knowledgeEndpoints } from './knowledge';
import { accountEndpoints } from './accounts';
import { characterEndpoints, referenceEndpoints, seriesEndpoints } from './creative';
import { dealEndpoints, partnerEndpoints } from './partners';
import { workEndpointGroups } from './work';
import { PLATFORM_ENDPOINT_GROUPS } from './platform';

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
  accounts: accountEndpoints,
  characters: characterEndpoints,
  series: seriesEndpoints,
  references: referenceEndpoints,
  partners: partnerEndpoints,
  deals: dealEndpoints,
  ...workEndpointGroups,
  ...PLATFORM_ENDPOINT_GROUPS,
};

export const allEndpoints = (): AnyEndpoint[] => Object.values(ENDPOINT_GROUPS).flatMap((g) => Object.values(g));
