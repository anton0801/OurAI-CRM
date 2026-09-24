import { and, desc, eq, inArray, lt, or, sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { assets, auditEvents, projects, type DbOrTx } from '@castlane/database';
import { AppError, clampPageSize, decodeCursor, encodeCursor, fieldError } from '@castlane/domain';
import { dbOf, type CommandContext, type QueryContext } from '../core/context';
import { hmac, safeEqual } from '../core/crypto';
import { loadReadableAsset } from '../media/assets';

/**
 * Helpers shared by the accounts, creative and partners modules (keyset paging on expressions,
 * short-lived impact tokens, activity feeds, access revision bumps, asset references).
 */

export type SortKind = 'text' | 'timestamp' | 'date' | 'int';

/**
 * Keyset condition on an arbitrary (non-null) sort expression plus id. The cursor stores the sort
 * value of the last row; ties are broken by id so pages never skip or repeat rows.
 */
export const keysetWhere = (expr: SQL | PgColumn, idCol: PgColumn, direction: 'asc' | 'desc', cursor: string | undefined, kind: SortKind): SQL | undefined => {
  if (!cursor) return undefined;
  const c = decodeCursor(cursor);
  if (!c) throw new AppError('MALFORMED_REQUEST', 'The page cursor is invalid. Reload the list.');
  const raw = c.v[0];
  const value =
    raw === null || raw === undefined
      ? sql`NULL`
      : kind === 'timestamp'
        ? sql`${String(raw)}::timestamptz`
        : kind === 'date'
          ? sql`${String(raw)}::date`
          : kind === 'int'
            ? sql`${Number(raw)}::int`
            : sql`${String(raw)}::text`;
  const op = direction === 'asc' ? sql.raw('>') : sql.raw('<');
  return sql`(${expr}, ${idCol}) ${op} (${value}, ${c.id}::uuid)`;
};

export const finishPage = <R extends { id: string }, T>(rows: R[], pageSize: number, sortValue: (r: R) => string | number | null, map: (rows: R[]) => T[] | Promise<T[]>) => {
  const hasMore = rows.length > pageSize;
  const pageRows = hasMore ? rows.slice(0, pageSize) : rows;
  const last = pageRows[pageRows.length - 1];
  return Promise.resolve(map(pageRows)).then((items) => ({
    items,
    hasMore,
    nextCursor: hasMore && last ? encodeCursor({ v: [sortValue(last)], id: last.id }) : null,
  }));
};

export const pageSizeOf = (n?: number) => clampPageSize(n);

// ——— Impact / preview tokens ———

const TOKEN_TTL_MS = 10 * 60_000;

/**
 * Short-lived signed token binding a preview to the exact records/versions and actor it was computed
 * for (transfer impact, merge preview). Expired or mismatching tokens require a new preview.
 */
export const signPreviewToken = (ctx: QueryContext, purpose: string, parts: (string | number)[]) => {
  const expiresAt = ctx.app.clock.now().getTime() + TOKEN_TTL_MS;
  const payload = [purpose, ...parts, expiresAt, ctx.actor.membershipId ?? 'system'].join(':');
  return { token: `${expiresAt}.${hmac(ctx.app.config.SESSION_SECRET, payload)}`, expiresAt: new Date(expiresAt) };
};

export const verifyPreviewToken = (ctx: QueryContext, purpose: string, parts: (string | number)[], token: string) => {
  const [exp, sig] = token.split('.');
  const expiresAt = Number(exp);
  const invalid = () =>
    new AppError('INVALID_STATE', 'The preview is out of date. Review the impact again before confirming.', { details: { reason: 'stale_preview' } });
  if (!Number.isFinite(expiresAt) || !sig) throw invalid();
  if (expiresAt < ctx.app.clock.now().getTime()) throw invalid();
  const payload = [purpose, ...parts, expiresAt, ctx.actor.membershipId ?? 'system'].join(':');
  if (!safeEqual(sig, hmac(ctx.app.config.SESSION_SECRET, payload))) throw invalid();
};

// ——— Activity feeds ———

/** Meaningful history of one entity from the audit log (sensitive categories excluded, masked diffs). */
export const entityActivity = async (
  ctx: QueryContext,
  entityTypes: string[],
  entityId: string,
  input: { cursor?: string; pageSize?: number },
) => {
  const size = clampPageSize(input.pageSize ?? 30);
  const c = input.cursor ? decodeCursor(input.cursor) : null;
  const rows = await ctx.app.db
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.workspaceId, ctx.actor.workspaceId),
        inArray(auditEvents.entityType, entityTypes),
        eq(auditEvents.entityId, entityId),
        eq(auditEvents.sensitivity, 'normal'),
        c ? or(lt(auditEvents.occurredAt, new Date(String(c.v[0]))), and(eq(auditEvents.occurredAt, new Date(String(c.v[0]))), lt(auditEvents.id, c.id))) : undefined,
      ),
    )
    .orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id))
    .limit(size + 1);
  const hasMore = rows.length > size;
  const items = (hasMore ? rows.slice(0, size) : rows).map((r) => ({
    id: r.id,
    action: r.action,
    entityType: r.entityType,
    entityId: r.entityId,
    actorName: r.actorDisplay,
    occurredAt: r.occurredAt.toISOString(),
    reason: r.reason,
    changes: Object.entries(r.diff ?? {}).map(([field, v]) => ({ field, from: v.from, to: v.to })),
  }));
  const last = items[items.length - 1];
  return { items, hasMore, nextCursor: hasMore && last ? encodeCursor({ v: [last.occurredAt], id: last.id }) : null };
};

// ——— Access & references ———

/** Assignments that change what a member can see bump their access revision (conventions §5). */
export const bumpAccessRevision = async (tx: DbOrTx, membershipIds: (string | null | undefined)[]) => {
  const ids = [...new Set(membershipIds.filter((x): x is string => !!x))];
  for (const id of ids) await tx.execute(sql`UPDATE memberships SET access_revision = access_revision + 1 WHERE id = ${id}`);
};

export const thumbUrl = (workspaceId: string, assetId: string | null | undefined, size = 128) =>
  assetId ? `/api/v1/workspaces/${workspaceId}/assets/${assetId}/thumbnail?size=${size}` : null;

/**
 * Validate that an asset exists in the workspace and is readable by the actor (never trust ids
 * from the client). Returns the asset row; maps "not found" to a field error.
 */
export const assertAssetUsable = async (ctx: QueryContext | CommandContext, assetId: string, field: string, opts: { imageOnly?: boolean } = {}) => {
  let a: typeof assets.$inferSelect;
  try {
    a = await loadReadableAsset(ctx, assetId);
  } catch {
    throw fieldError(field, 'NOT_FOUND', 'Choose a file you can access.');
  }
  if (a.archivedAt) throw fieldError(field, 'ARCHIVED', 'This file is archived.');
  if (opts.imageOnly && a.kind !== 'image') throw fieldError(field, 'NOT_IMAGE', 'Choose an uploaded image (JPG, PNG or WebP).');
  return a;
};

export const projectNames = async (ctx: QueryContext | CommandContext, ids: (string | null | undefined)[]) => {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  if (!unique.length) return new Map<string, { id: string; name: string; type: string; status: string; directionId: string; ownerMembershipId: string; ofmEnabled: boolean }>();
  const rows = await dbOf(ctx)
    .select({ id: projects.id, name: projects.name, type: projects.type, status: projects.status, directionId: projects.directionId, ownerMembershipId: projects.ownerMembershipId, ofmEnabled: projects.ofmEnabled })
    .from(projects)
    .where(and(eq(projects.workspaceId, ctx.actor.workspaceId), inArray(projects.id, unique)));
  return new Map(rows.map((r) => [r.id, r]));
};

/** Escape LIKE wildcards in user search input. */
export const likeOf = (q: string) => `%${q.trim().replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
