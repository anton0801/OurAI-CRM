import { z } from 'zod';
import { endpoint } from './core';
import { uuid, wsId } from './common';

/** Endpoints used by the application shell (search palette, inbox counter, live events). */
export const searchResult = z.object({
  entityType: z.string(),
  entityId: uuid,
  title: z.string(),
  snippet: z.string().nullable(),
  status: z.string().nullable(),
  href: z.string(),
  thumbnailUrl: z.string().nullable(),
});
export type SearchResult = z.infer<typeof searchResult>;

export const shellEndpoints = {
  search: endpoint({
    id: 'search.global',
    method: 'GET',
    path: '/workspaces/{workspaceId}/search',
    summary: 'Permission-aware global search (titles, handles, permitted text; exact id supported).',
    tags: ['Search'],
    auth: 'workspace',
    params: wsId({}),
    query: z.object({
      q: z.string().trim().min(2).max(200),
      types: z.string().max(400).optional(),
      projectId: uuid.optional(),
      assigneeMembershipId: uuid.optional(),
      status: z.string().max(40).optional(),
      limit: z.coerce.number().int().min(1).max(50).default(8),
    }),
    response: z.object({ results: z.array(searchResult), hasMore: z.boolean() }),
  }),
  unreadCount: endpoint({
    id: 'notifications.unreadCount',
    method: 'GET',
    path: '/workspaces/{workspaceId}/notifications/unread-count',
    summary: 'Unread in-app notifications for the current member only.',
    tags: ['Notifications'],
    auth: 'workspace',
    params: wsId({}),
    response: z.object({ unread: z.number().int() }),
  }),
  events: endpoint({
    id: 'events.stream',
    method: 'GET',
    path: '/workspaces/{workspaceId}/events',
    summary: 'Server-Sent Events: safe entity ids and revisions only; clients refetch through normal endpoints.',
    tags: ['Realtime'],
    auth: 'workspace',
    params: wsId({}),
    rateLimit: 'none',
    response: z.any(),
  }),
};
