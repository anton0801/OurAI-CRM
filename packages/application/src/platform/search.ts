import { and, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import { entityHref } from '@castlane/api-contracts';
import { listFilter } from '@castlane/authorization';
import { searchDocuments } from '@castlane/database';
import { isUuid } from '@castlane/domain';
import { filterToSql } from '../core/access';
import type { QueryContext } from '../core/context';

/** Read permissions whose documents appear in global search (contacts, finance and audit are separate datasets). */
export const SEARCHABLE_PERMISSIONS = [
  'projects.read',
  'directions.read',
  'characters.read',
  'accounts.read',
  'references.read',
  'content.read',
  'tasks.read',
  'publications.read',
  'campaigns.read',
  'experiments.read',
  'assets.read',
  'knowledge.read',
  'partners.read',
  'deals.read',
  'reports.read',
  'goals.read',
  'members.read',
] as const;

/**
 * Permission-aware search: the scope predicate of every read permission is part of the SQL,
 * so result sets, snippets and "has more" never include records outside the actor's scope.
 */
export const globalSearch = async (
  ctx: QueryContext,
  input: { q: string; types?: string; projectId?: string; assigneeMembershipId?: string; status?: string; limit: number },
) => {
  const q = input.q.trim();
  const perms: SQL[] = [];
  for (const p of SEARCHABLE_PERMISSIONS) {
    const pred = filterToSql(listFilter(ctx.actor.access, p), {
      projectId: searchDocuments.projectId,
      accountId: searchDocuments.accountId,
      assigned: [],
      ownerMembership: searchDocuments.ownerMembershipId,
    });
    const assigned = listFilter(ctx.actor.access, p);
    const assignedPred =
      assigned.kind === 'scoped' && assigned.assignedToMembershipId
        ? sql`${assigned.assignedToMembershipId}::uuid = ANY(${searchDocuments.assigneeMembershipIds})`
        : undefined;
    if (assigned.kind === 'none') continue;
    const scope = pred === undefined ? sql`true` : assignedPred ? or(pred, assignedPred)! : pred;
    perms.push(and(eq(searchDocuments.permission, p), scope)!);
  }
  if (perms.length === 0) return { results: [], hasMore: false };
  const canRestricted = listFilter(ctx.actor.access, 'assets.restricted.read').kind !== 'none';
  const types = input.types?.split(',').filter(Boolean);
  const text = or(
    sql`${searchDocuments.tsv} @@ plainto_tsquery('simple', ${q})`,
    ilike(searchDocuments.title, `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`),
    isUuid(q) ? eq(searchDocuments.entityId, q) : undefined,
  );
  const rows = await ctx.app.db
    .select()
    .from(searchDocuments)
    .where(
      and(
        eq(searchDocuments.workspaceId, ctx.actor.workspaceId),
        eq(searchDocuments.archived, false),
        text,
        or(...perms),
        canRestricted ? undefined : eq(searchDocuments.restricted, false),
        types?.length ? inArray(searchDocuments.entityType, types) : undefined,
        input.projectId ? eq(searchDocuments.projectId, input.projectId) : undefined,
        input.assigneeMembershipId ? sql`${input.assigneeMembershipId}::uuid = ANY(${searchDocuments.assigneeMembershipIds})` : undefined,
        input.status ? eq(searchDocuments.status, input.status) : undefined,
      ),
    )
    .orderBy(
      sql`(${searchDocuments.entityId}::text = ${q}) DESC`,
      sql`similarity(${searchDocuments.title}, ${q}) DESC`,
      sql`${searchDocuments.updatedAt} DESC`,
    )
    .limit(input.limit + 1);
  const hasMore = rows.length > input.limit;
  const lower = q.toLowerCase();
  return {
    hasMore,
    results: rows.slice(0, input.limit).map((r) => {
      let snippet: string | null = null;
      if (r.body) {
        const idx = r.body.toLowerCase().indexOf(lower);
        snippet = idx >= 0 ? `${idx > 40 ? '…' : ''}${r.body.slice(Math.max(0, idx - 40), idx + 100)}${idx + 100 < r.body.length ? '…' : ''}` : r.body.slice(0, 140);
      }
      return {
        entityType: r.entityType,
        entityId: r.entityId,
        title: r.title,
        snippet,
        status: r.status,
        href: entityHref(ctx.actor.workspaceId, r.entityType, r.entityId, { projectId: r.projectId }),
        thumbnailUrl: r.thumbnailAssetId && !r.restricted ? `/api/v1/workspaces/${ctx.actor.workspaceId}/assets/${r.thumbnailAssetId}/thumbnail?size=64` : null,
      };
    }),
  };
};
