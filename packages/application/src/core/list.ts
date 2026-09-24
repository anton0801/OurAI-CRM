import { and, asc, desc, eq, gt, lt, or, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { clampPageSize, decodeCursor, encodeCursor } from '@castlane/domain';

export interface PageRequest {
  cursor?: string | null;
  pageSize?: number;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

/**
 * Keyset pagination on (sortColumn, id). Stable ordering: ties broken by id so no row is
 * skipped or repeated between pages.
 */
export const keyset = (
  sortCol: PgColumn,
  idCol: PgColumn,
  direction: 'asc' | 'desc',
  req: PageRequest,
  toCursorValue: (v: unknown) => string | number | null = (v) => (v instanceof Date ? v.toISOString() : (v as string | number | null)),
) => {
  const pageSize = clampPageSize(req.pageSize);
  let where: SQL | undefined;
  const c = req.cursor ? decodeCursor(req.cursor) : null;
  if (c) {
    const raw = c.v[0];
    const value = raw !== null && typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(raw) ? new Date(raw) : raw;
    const cmp = direction === 'asc' ? gt : lt;
    where =
      value === null
        ? cmp(idCol, c.id)
        : or(cmp(sortCol, value as never), and(eq(sortCol, value as never), cmp(idCol, c.id)));
  }
  const orderBy = direction === 'asc' ? [asc(sortCol), asc(idCol)] : [desc(sortCol), desc(idCol)];
  return {
    where,
    orderBy,
    limit: pageSize + 1,
    finish: <T extends Record<string, unknown>>(rows: T[], sortKey: keyof T, idKey: keyof T = 'id' as keyof T): Page<T> => {
      const hasMore = rows.length > pageSize;
      const items = hasMore ? rows.slice(0, pageSize) : rows;
      const last = items[items.length - 1];
      return {
        items,
        hasMore,
        nextCursor: hasMore && last ? encodeCursor({ v: [toCursorValue(last[sortKey])], id: String(last[idKey]) }) : null,
      };
    },
  };
};
