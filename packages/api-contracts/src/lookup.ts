import { z } from 'zod';
import { endpoint } from './core';
import { boolQuery, csv, uuid, wsId } from './common';

/**
 * Entity types with a generic picker (`EntitySelect`). The owning module registers the server
 * provider with `defineLookup` (packages/application/src/core/lookup-registry.ts).
 */
export const LOOKUP_TYPES = [
  'direction',
  'project',
  'character',
  'season',
  'episode',
  'scene',
  'account',
  'reference',
  'partner',
  'deal',
  'task',
  'asset',
  'folder',
  'article',
  'article_category',
  'template',
  'tag',
  'content_item',
  'publication',
  'campaign',
  'experiment',
  'tracking_link',
  'ofm_contact',
  'shift',
  'metric_definition',
  'goal',
  'saved_report',
  'finance_category',
  'budget',
  'compensation_rule',
  'automation',
] as const;
export type LookupType = (typeof LOOKUP_TYPES)[number];

export const lookupItem = z.object({
  id: uuid,
  label: z.string(),
  /** Secondary line: handle, project name, date… */
  sublabel: z.string().nullable(),
  status: z.string().nullable(),
  projectId: uuid.nullable(),
  archived: z.boolean(),
});
export type LookupItem = z.infer<typeof lookupItem>;

export const lookupEndpoints = {
  search: endpoint({
    id: 'lookup.search',
    method: 'GET',
    path: '/workspaces/{workspaceId}/lookup/{type}',
    summary: 'Picker search for one entity type, limited to records the member may read.',
    tags: ['Shell'],
    auth: 'workspace',
    params: wsId({ type: z.enum(LOOKUP_TYPES) }),
    query: z.object({
      q: z.string().max(100).optional(),
      ids: csv(uuid).optional(),
      projectId: uuid.optional(),
      accountId: uuid.optional(),
      directionId: uuid.optional(),
      parentId: uuid.optional(),
      status: csv(z.string().max(40)).optional(),
      includeArchived: boolQuery.optional(),
      limit: z.coerce.number().int().min(1).max(50).default(20),
    }),
    response: z.object({ items: z.array(lookupItem) }),
  }),
};
