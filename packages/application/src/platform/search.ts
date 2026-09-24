import { and, count, eq, ilike, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { entityHref } from '@castlane/api-contracts';
import { listFilter } from '@castlane/authorization';
import { searchDocuments } from '@castlane/database';
import { isUuid } from '@castlane/domain';
import { filterToSql } from '../core/access';
import type { QueryContext } from '../core/context';
import { audienceOf } from '../knowledge/access';

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

export interface SearchInput {
  q: string;
  types?: string | string[];
  projectId?: string;
  assigneeMembershipId?: string;
  status?: string;
}

/**
 * The permission predicate over the search projection: for each read permission, the member's
 * scope (projects, accounts, assigned/own records) is part of the SQL. Returns null when nothing is
 * visible at all.
 */
export const searchPermissionPredicate = (ctx: QueryContext): SQL | null => {
  const perms: SQL[] = [];
  for (const p of SEARCHABLE_PERMISSIONS) {
    if (p === 'knowledge.read') {
      // Knowledge articles have their own audience (§14): workspace-wide articles are read by anyone
      // holding knowledge.read anywhere; direction articles by members covering the direction.
      const aud = audienceOf(ctx.actor.access, p, 'read');
      if (aud.none) continue;
      const scope = aud.all
        ? sql`true`
        : or(
            and(isNull(searchDocuments.projectId), isNull(searchDocuments.directionId)),
            aud.projectIds.length ? inArray(searchDocuments.projectId, aud.projectIds) : undefined,
            aud.directionIds.length ? and(isNull(searchDocuments.projectId), inArray(searchDocuments.directionId, aud.directionIds)) : undefined,
          )!;
      perms.push(and(eq(searchDocuments.permission, p), scope)!);
      continue;
    }
    const f = listFilter(ctx.actor.access, p);
    if (f.kind === 'none') continue;
    const pred = filterToSql(f, {
      projectId: searchDocuments.projectId,
      accountId: searchDocuments.accountId,
      assigned: [],
      ownerMembership: searchDocuments.ownerMembershipId,
    });
    const assignedPred =
      f.kind === 'scoped' && f.assignedToMembershipId ? sql`${f.assignedToMembershipId}::uuid = ANY(${searchDocuments.assigneeMembershipIds})` : undefined;
    const scope = pred === undefined ? sql`true` : assignedPred ? or(pred, assignedPred)! : pred;
    perms.push(and(eq(searchDocuments.permission, p), scope)!);
  }
  return perms.length ? or(...perms)! : null;
};

const buildWhere = (ctx: QueryContext, input: SearchInput, opts: { withTypes: boolean }): SQL | null => {
  const perms = searchPermissionPredicate(ctx);
  if (!perms) return null;
  const q = input.q.trim();
  const canRestricted = listFilter(ctx.actor.access, 'assets.restricted.read').kind !== 'none';
  const types = (Array.isArray(input.types) ? input.types : input.types?.split(','))?.filter(Boolean);
  const text = or(
    sql`${searchDocuments.tsv} @@ plainto_tsquery('simple', ${q})`,
    ilike(searchDocuments.title, `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`),
    isUuid(q) ? eq(searchDocuments.entityId, q) : undefined,
  );
  return and(
    eq(searchDocuments.workspaceId, ctx.actor.workspaceId),
    eq(searchDocuments.archived, false),
    text,
    perms,
    canRestricted ? undefined : eq(searchDocuments.restricted, false),
    opts.withTypes && types?.length ? inArray(searchDocuments.entityType, types) : undefined,
    input.projectId ? eq(searchDocuments.projectId, input.projectId) : undefined,
    input.assigneeMembershipId ? sql`${input.assigneeMembershipId}::uuid = ANY(${searchDocuments.assigneeMembershipIds})` : undefined,
    input.status ? eq(searchDocuments.status, input.status) : undefined,
  )!;
};

const relevance = (q: string) => [
  sql`(${searchDocuments.entityId}::text = ${q}) DESC`,
  sql`similarity(${searchDocuments.title}, ${q}) DESC`,
  sql`${searchDocuments.updatedAt} DESC`,
  sql`${searchDocuments.entityId} ASC`,
];

/** Snippets are built only from the indexed (already permitted) text of documents the member can read. */
const toResult = (ctx: QueryContext, q: string) => (r: typeof searchDocuments.$inferSelect) => {
  const lower = q.toLowerCase();
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
};

/**
 * Permission-aware search (palette): the scope predicate of every read permission is part of the
 * SQL, so result sets, snippets and "has more" never include records outside the actor's scope.
 */
export const globalSearch = async (ctx: QueryContext, input: SearchInput & { limit: number }) => {
  const where = buildWhere(ctx, input, { withTypes: true });
  if (!where) return { results: [], hasMore: false };
  const q = input.q.trim();
  const rows = await ctx.app.db
    .select()
    .from(searchDocuments)
    .where(where)
    .orderBy(...relevance(q))
    .limit(input.limit + 1);
  return { hasMore: rows.length > input.limit, results: rows.slice(0, input.limit).map(toResult(ctx, q)) };
};

const decodeOffset = (cursor?: string) => {
  if (!cursor) return 0;
  const n = Number(Buffer.from(cursor, 'base64url').toString('utf8'));
  return Number.isInteger(n) && n > 0 && n < 10_000 ? n : 0;
};

/**
 * Full search page (S11): results with type facets and pagination. Facet counts come from the same
 * permission-filtered SQL, so they never reveal the existence of hidden records (T159).
 */
export const searchPage = async (ctx: QueryContext, input: SearchInput & { cursor?: string; pageSize: number }) => {
  const where = buildWhere(ctx, input, { withTypes: true });
  const facetWhere = buildWhere(ctx, input, { withTypes: false });
  if (!where || !facetWhere) return { results: [], hasMore: false, nextCursor: null, facets: [] };
  const q = input.q.trim();
  const offset = decodeOffset(input.cursor);
  const rows = await ctx.app.db
    .select()
    .from(searchDocuments)
    .where(where)
    .orderBy(...relevance(q))
    .offset(offset)
    .limit(input.pageSize + 1);
  const facets = await ctx.app.db
    .select({ entityType: searchDocuments.entityType, count: count() })
    .from(searchDocuments)
    .where(facetWhere)
    .groupBy(searchDocuments.entityType)
    .orderBy(searchDocuments.entityType);
  const hasMore = rows.length > input.pageSize;
  return {
    results: rows.slice(0, input.pageSize).map(toResult(ctx, q)),
    hasMore,
    nextCursor: hasMore ? Buffer.from(String(offset + input.pageSize), 'utf8').toString('base64url') : null,
    facets: facets.map((f) => ({ entityType: f.entityType, count: Number(f.count) })),
  };
};
