import { and, eq, sql, type SQL } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { AppError, notFound, versionConflict } from '@castlane/domain';
import type { CommandContext, QueryContext } from './context';

type TenantTable = PgTable & {
  id: PgColumn;
  workspaceId: PgColumn;
  rowVersion: PgColumn;
  updatedAt: PgColumn;
  updatedBy: PgColumn;
};

/** Load a row by id inside the actor's workspace; missing (or foreign) → 404. */
export const findById = async <T extends TenantTable>(
  ctx: QueryContext | CommandContext,
  table: T,
  id: string,
  what = 'Record',
): Promise<T['$inferSelect']> => {
  const db = 'tx' in ctx ? ctx.tx : ctx.app.db;
  const rows = await db
    .select()
    .from(table as PgTable)
    .where(and(eq(table.workspaceId, ctx.actor.workspaceId), eq(table.id, id)))
    .limit(1);
  const row = rows[0];
  if (!row) throw notFound(what);
  return row as T['$inferSelect'];
};

/** SELECT … FOR UPDATE within the command transaction (serialises concurrent decisions). */
export const lockById = async <T extends TenantTable>(
  ctx: CommandContext,
  table: T,
  id: string,
  what = 'Record',
): Promise<T['$inferSelect']> => {
  const rows = await ctx.tx
    .select()
    .from(table as PgTable)
    .where(and(eq(table.workspaceId, ctx.actor.workspaceId), eq(table.id, id)))
    .for('update')
    .limit(1);
  const row = rows[0];
  if (!row) throw notFound(what);
  return row as T['$inferSelect'];
};

/**
 * Optimistic concurrency: the If-Match version must be present (428) and equal to the row's
 * current version (412 VERSION_CONFLICT).
 */
export const assertVersion = (ctx: CommandContext, row: { rowVersion: number }): void => {
  const expected = ctx.request.expectedVersion;
  if (expected === undefined) {
    throw new AppError('PRECONDITION_REQUIRED', 'This change requires the version of the record you edited (If-Match).');
  }
  if (expected !== row.rowVersion) throw versionConflict(row.rowVersion);
};

/** Standard mutation stamp: bump row_version and record who changed the row. */
export const touch = (ctx: CommandContext, table: TenantTable): Record<string, unknown> => ({
  rowVersion: sql`${table.rowVersion} + 1`,
  updatedAt: ctx.app.clock.now(),
  updatedBy: ctx.actor.userId,
});

/** Standard creation stamp for tenant rows. */
export const stamp = (ctx: CommandContext) => {
  const at = ctx.app.clock.now();
  return {
    workspaceId: ctx.actor.workspaceId,
    createdAt: at,
    updatedAt: at,
    createdBy: ctx.actor.userId,
    updatedBy: ctx.actor.userId,
    rowVersion: 1,
  };
};

export const inWorkspace = (ctx: QueryContext, table: { workspaceId: PgColumn }): SQL =>
  eq(table.workspaceId, ctx.actor.workspaceId);
