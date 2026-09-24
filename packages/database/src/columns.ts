import { sql, type SQL } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  check,
  date,
  foreignKey,
  integer,
  jsonb,
  numeric,
  text,
  timestamp,
  uuid,
  customType,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { workspaces } from './schema/identity';

/** timestamptz in UTC, surfaced as JS Date. */
export const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
/** Calendar date (YYYY-MM-DD string). */
export const day = (name: string) => date(name, { mode: 'string' });
/** Money amount in minor units. */
export const minor = (name: string) => bigint(name, { mode: 'bigint' });
export const currency = (name: string) => char(name, { length: 3 });
/** Exact decimal (rates, percentages, quantities). */
export const dec = (name: string, precision = 24, scale = 10) => numeric(name, { precision, scale });
export const enumText = <const T extends readonly [string, ...string[]]>(name: string, values: T) => text(name, { enum: values });
export const json = <T>(name: string) => jsonb(name).$type<T>();

export const tsvector = customType<{ data: string }>({
  dataType() {
    return 'tsvector';
  },
});

/** Columns shared by every workspace-owned table (section 8.1). */
export const tenantBase = () => ({
  id: uuid('id').primaryKey(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
  createdBy: uuid('created_by'),
  updatedBy: uuid('updated_by'),
  rowVersion: bigint('row_version', { mode: 'number' }).notNull().default(1),
});

export const archivable = () => ({
  archivedAt: ts('archived_at'),
  archivedBy: uuid('archived_by'),
  archiveReason: text('archive_reason'),
});

export const trashable = () => ({
  deletedAt: ts('deleted_at'),
  deletedBy: uuid('deleted_by'),
  purgeAfter: ts('purge_after'),
});

interface TenantRef {
  workspaceId: AnyPgColumn;
  id: AnyPgColumn;
}

/**
 * Composite tenant foreign key (workspace_id, ref_id) → (workspace_id, id) so rows can never
 * link across workspaces. Names are explicit to stay below PostgreSQL's 63-char limit.
 */
export const tfk = (name: string, workspaceCol: AnyPgColumn, refCol: AnyPgColumn, target: TenantRef) =>
  foreignKey({ name: name.slice(0, 63), columns: [workspaceCol, refCol], foreignColumns: [target.workspaceId, target.id] });

/** CHECK (col IN (...)) generated from a canonical enum array. */
export const enumCheck = (name: string, column: string, values: readonly string[], nullable = false) => {
  const list = values.map((v) => `'${v.replace(/'/g, "''")}'`).join(', ');
  const expr = nullable ? `("${column}" IS NULL OR "${column}" IN (${list}))` : `"${column}" IN (${list})`;
  return check(name.slice(0, 63), sql.raw(expr));
};

export const rawCheck = (name: string, expr: string) => check(name.slice(0, 63), sql.raw(expr));

export { bigint, boolean, integer, jsonb, numeric, text, uuid, sql, type SQL };
