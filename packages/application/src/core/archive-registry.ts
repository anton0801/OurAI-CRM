import { and, desc, eq, ilike, isNotNull, isNull, lt, or, type SQL } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { ImpactItem } from '@castlane/api-contracts';
import type { CommandContext, QueryContext } from './context';

/** One archived or trashed record as shown on the generic Archive / Trash screen (S70). */
export interface ArchiveListItem {
  id: string;
  title: string;
  /** archived_at (Archived tab) or deleted_at (Trash tab). */
  at: Date;
  byUserId: string | null;
  reason: string | null;
  projectId: string | null;
  /** Trash only: end of the grace period. */
  purgeAfter: Date | null;
  thumbnailAssetId?: string | null;
}

export interface ArchiveListInput {
  state: 'archived' | 'trash';
  q?: string;
  projectId?: string;
  /** Keyset: only items strictly older than (at, id), newest first. */
  before?: { at: Date; id: string };
  /** Trash only: items whose grace period ended before this moment (retention purge). */
  purgeDueBefore?: Date;
  limit: number;
}

/**
 * Archive / trash / restore behaviour per entity type. Modules register handlers; the generic
 * `/entities/*` endpoints (Archive screen, bulk actions) delegate to them. Archive never deletes
 * history; trash applies only to eligible drafts; purge is Owner-only and asynchronous.
 */
export interface ArchiveHandler {
  entityType: string;
  label: string;
  /** Open obligations and effects; blocking items prevent archiving until resolved. */
  preview(ctx: QueryContext, id: string): Promise<{ title: string; rowVersion: number; items: ImpactItem[] }>;
  archive(ctx: CommandContext, id: string, input: { reason?: string; resolutions?: Record<string, string> }): Promise<void>;
  restorePreview?(ctx: QueryContext, id: string): Promise<{ title: string; items: ImpactItem[]; collisions?: ArchiveCollision[] }>;
  restore?(ctx: CommandContext, id: string, input: { resolutions?: Record<string, string> }): Promise<void>;
  /** Only drafts that nothing depends on may go to trash. */
  trash?(ctx: CommandContext, id: string, reason: string): Promise<void>;
  /** Restore from trash (within the grace period) with dependency and unique-collision checks. */
  untrashPreview?(ctx: QueryContext, id: string): Promise<{ title: string; items: ImpactItem[]; collisions?: ArchiveCollision[] }>;
  untrash?(ctx: CommandContext, id: string, input: { resolutions?: Record<string, string> }): Promise<void>;
  purge?(ctx: CommandContext, id: string): Promise<void>;
  /**
   * Optional listing for the Archive / Trash screen, scoped like the module list (read permission
   * in SQL). `tableArchiveList` implements it for tables with the standard archivable/trashable columns.
   */
  list?(ctx: QueryContext, input: ArchiveListInput): Promise<ArchiveListItem[]>;
}

/** A unique value that is taken by another record now; restoring needs an explicit choice. */
export interface ArchiveCollision {
  field: string;
  value: string;
  message: string;
  /** Resolution choices; the chosen `value` is passed back in `resolutions[field]`. */
  options: { value: string; label: string }[];
}

export const ARCHIVE_HANDLERS = new Map<string, ArchiveHandler>();
export const defineArchiveHandler = (h: ArchiveHandler) => {
  ARCHIVE_HANDLERS.set(h.entityType, h);
};

/**
 * Capabilities added to another module's handler (e.g. listing or trash for a type whose module
 * does not provide them yet). Explicit handler methods always win over extensions.
 */
export const ARCHIVE_EXTENSIONS = new Map<string, Partial<ArchiveHandler>>();
export const extendArchiveHandler = (entityType: string, ext: Partial<ArchiveHandler>) => {
  ARCHIVE_EXTENSIONS.set(entityType, { ...(ARCHIVE_EXTENSIONS.get(entityType) ?? {}), ...ext });
};

/** Effective handler for a type (registered handler plus extensions), or undefined. */
export const getArchiveHandler = (entityType: string): ArchiveHandler | undefined => {
  const base = ARCHIVE_HANDLERS.get(entityType);
  if (!base) return undefined;
  const ext = ARCHIVE_EXTENSIONS.get(entityType);
  if (!ext) return base;
  const merged: ArchiveHandler = { ...ext, ...base } as ArchiveHandler;
  for (const [k, v] of Object.entries(ext)) if ((base as unknown as Record<string, unknown>)[k] === undefined) (merged as unknown as Record<string, unknown>)[k] = v;
  return merged;
};

export const allArchiveHandlers = (): ArchiveHandler[] => [...ARCHIVE_HANDLERS.keys()].map((t) => getArchiveHandler(t)!).filter(Boolean);

type ArchivableTable = PgTable & {
  id: PgColumn;
  workspaceId: PgColumn;
  archivedAt: PgColumn;
  archivedBy: PgColumn;
  archiveReason: PgColumn;
};
type TrashableTable = { deletedAt: PgColumn; deletedBy: PgColumn; purgeAfter: PgColumn };

/**
 * Generic `list` implementation over a table with the standard archivable/trashable columns.
 * `scope` must be the module's read scope predicate (scopePredicate(ctx, 'x.read', …)).
 */
export const tableArchiveList = async (
  ctx: QueryContext,
  input: ArchiveListInput,
  cfg: {
    table: ArchivableTable & Partial<TrashableTable>;
    title: PgColumn;
    projectId?: PgColumn;
    scope: SQL | undefined;
    /** Extra condition for the Archived tab when a status column is authoritative (e.g. status = 'archived'). */
    archivedWhere?: SQL;
    thumbnail?: PgColumn;
  },
): Promise<ArchiveListItem[]> => {
  const t = cfg.table;
  const trash = input.state === 'trash';
  if (trash && !t.deletedAt) return [];
  const atCol = trash ? t.deletedAt! : t.archivedAt;
  const where = and(
    eq(t.workspaceId, ctx.actor.workspaceId),
    cfg.scope,
    trash ? isNotNull(t.deletedAt!) : and(isNotNull(t.archivedAt), cfg.archivedWhere, t.deletedAt ? isNull(t.deletedAt) : undefined),
    input.q ? ilike(cfg.title, `%${input.q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`) : undefined,
    input.projectId && cfg.projectId ? eq(cfg.projectId, input.projectId) : undefined,
    input.purgeDueBefore && t.purgeAfter ? lt(t.purgeAfter, input.purgeDueBefore) : undefined,
    input.before ? or(lt(atCol, input.before.at), and(eq(atCol, input.before.at), lt(t.id, input.before.id))) : undefined,
  );
  const db = 'tx' in ctx ? (ctx as CommandContext).tx : ctx.app.db;
  const rows = (await db
    .select({
      id: t.id,
      title: cfg.title,
      at: atCol,
      by: trash ? t.deletedBy! : t.archivedBy,
      reason: t.archiveReason,
      projectId: cfg.projectId ?? t.id,
      purgeAfter: t.purgeAfter ?? t.archivedAt,
      thumb: cfg.thumbnail ?? t.id,
    })
    .from(t as PgTable)
    .where(where)
    .orderBy(desc(atCol), desc(t.id))
    .limit(input.limit)) as { id: string; title: string; at: Date; by: string | null; reason: string | null; projectId: string | null; purgeAfter: Date | null; thumb: string | null }[];
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    at: r.at,
    byUserId: r.by,
    reason: trash ? null : r.reason,
    projectId: cfg.projectId ? r.projectId : null,
    purgeAfter: trash && t.purgeAfter ? r.purgeAfter : null,
    thumbnailAssetId: cfg.thumbnail ? r.thumb : null,
  }));
};
