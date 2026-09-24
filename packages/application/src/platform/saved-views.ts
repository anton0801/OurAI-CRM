import { and, asc, eq, or } from 'drizzle-orm';
import { hasAnywhere } from '@castlane/authorization';
import { savedViews } from '@castlane/database';
import { AppError, PROJECT_STATUSES, PROJECT_TYPES, newId, notFound } from '@castlane/domain';
import { audit } from '../core/audit';
import type { CommandContext, QueryContext } from '../core/context';
import { dbOf } from '../core/context';
import { emit } from '../core/events';
import { loadMemberRefs, refOrUnknown } from '../core/members';
import { assertVersion, stamp, touch } from '../core/rows';
import { validateFilterAst, type FieldKind, type FilterGroup } from './filter-ast';

type ViewRow = typeof savedViews.$inferSelect;

export interface SavedViewModule {
  /** Read permission of the list screen; views of a module are offered only to its readers. */
  permission?: string;
  fields: Record<string, { kind: FieldKind; values?: readonly string[] }>;
  sortKeys: readonly string[];
}

/** List screens that support saved views register their filter fields (the typed allowlist). */
export const SAVED_VIEW_MODULES = new Map<string, SavedViewModule>();
export const defineSavedViewModule = (module: string, def: SavedViewModule) => {
  SAVED_VIEW_MODULES.set(module, def);
};

defineSavedViewModule('projects', {
  permission: 'projects.read',
  fields: {
    q: { kind: 'text' },
    status: { kind: 'enum', values: PROJECT_STATUSES },
    type: { kind: 'enum', values: PROJECT_TYPES },
    directionId: { kind: 'id' },
    ownerMembershipId: { kind: 'id' },
    tag: { kind: 'text' },
    archived: { kind: 'boolean' },
  },
  sortKeys: ['name', 'updatedAt', 'status', 'type'],
});

/** Import mappings are stored in the same table under this reserved prefix (see imports). */
export const IMPORT_MAPPING_MODULE = (dataset: string) => `import-mapping:${dataset}`;

const moduleDef = (ctx: QueryContext, module: string): SavedViewModule => {
  if (module.startsWith('import-mapping:')) throw new AppError('VALIDATION_FAILED', 'This list does not support saved views.');
  const def = SAVED_VIEW_MODULES.get(module);
  if (!def) throw new AppError('VALIDATION_FAILED', 'This list does not support saved views.');
  if (def.permission && !hasAnywhere(ctx.actor.access, def.permission)) throw new AppError('FORBIDDEN', 'You do not have access to this list.');
  return def;
};

const validate = (def: SavedViewModule, input: { filterAst?: unknown; sort?: { key: string; direction: 'asc' | 'desc' }[]; columns?: string[] }) => {
  if (input.filterAst !== undefined) {
    const issues = validateFilterAst(input.filterAst, def.fields);
    if (issues.length)
      throw new AppError('VALIDATION_FAILED', issues[0]!.message, { fieldErrors: issues.map((i) => ({ field: i.path, code: 'INVALID_FILTER', message: i.message })) });
  }
  for (const s of input.sort ?? []) if (!def.sortKeys.includes(s.key)) throw new AppError('VALIDATION_FAILED', `Sorting by "${s.key}" is not supported.`);
};

const toView = (ctx: QueryContext, r: ViewRow, refs: Awaited<ReturnType<typeof loadMemberRefs>>) => ({
  id: r.id,
  module: r.module,
  name: r.name,
  filterAst: r.filterAst as FilterGroup,
  sort: r.sort,
  columns: r.columns,
  shared: r.shared,
  owner: refOrUnknown(refs, r.ownerMembershipId)!,
  own: r.ownerMembershipId === ctx.actor.membershipId,
  updatedAt: r.updatedAt.toISOString(),
  rowVersion: r.rowVersion,
});

export const listSavedViews = async (ctx: QueryContext, module: string) => {
  moduleDef(ctx, module);
  const rows = await dbOf(ctx)
    .select()
    .from(savedViews)
    .where(
      and(
        eq(savedViews.workspaceId, ctx.actor.workspaceId),
        eq(savedViews.module, module),
        or(eq(savedViews.ownerMembershipId, ctx.actor.membershipId ?? '00000000-0000-0000-0000-000000000000'), eq(savedViews.shared, true)),
      ),
    )
    .orderBy(asc(savedViews.name), asc(savedViews.id));
  const refs = await loadMemberRefs(dbOf(ctx), ctx.actor.workspaceId, rows.map((r) => r.ownerMembershipId));
  return rows.map((r) => toView(ctx, r, refs));
};

const loadOwnView = async (ctx: CommandContext, id: string) => {
  const [v] = await ctx.tx.select().from(savedViews).where(and(eq(savedViews.workspaceId, ctx.actor.workspaceId), eq(savedViews.id, id))).for('update');
  if (!v || v.module.startsWith('import-mapping:')) throw notFound('View');
  if (v.ownerMembershipId !== ctx.actor.membershipId) {
    if (v.shared) throw new AppError('FORBIDDEN', 'Only the author can change a shared view.');
    throw notFound('View');
  }
  return v;
};

export const getSavedView = async (ctx: QueryContext | CommandContext, id: string) => {
  const [v] = await dbOf(ctx).select().from(savedViews).where(and(eq(savedViews.workspaceId, ctx.actor.workspaceId), eq(savedViews.id, id)));
  if (!v || (!v.shared && v.ownerMembershipId !== ctx.actor.membershipId)) throw notFound('View');
  const refs = await loadMemberRefs(dbOf(ctx), ctx.actor.workspaceId, [v.ownerMembershipId]);
  return toView(ctx, v, refs);
};

export const createSavedView = async (
  ctx: CommandContext,
  input: { module: string; name: string; filterAst: unknown; sort: { key: string; direction: 'asc' | 'desc' }[]; columns: string[]; shared: boolean },
) => {
  if (!ctx.actor.membershipId) throw new AppError('FORBIDDEN', 'Only members can save views.');
  const def = moduleDef(ctx, input.module);
  validate(def, input);
  const id = newId();
  await ctx.tx.insert(savedViews).values({
    ...stamp(ctx),
    id,
    ownerMembershipId: ctx.actor.membershipId,
    module: input.module,
    name: input.name.trim(),
    filterAst: input.filterAst,
    sort: input.sort,
    columns: input.columns,
    shared: input.shared,
  });
  await audit(ctx, { action: 'saved_view.created', entityType: 'saved_view', entityId: id, metadata: { module: input.module, shared: input.shared } });
  await emit(ctx, { type: 'saved_view.created', entityType: 'saved_view', entityId: id, revision: 1 });
  return id;
};

export const updateSavedView = async (
  ctx: CommandContext,
  id: string,
  input: { name?: string; filterAst?: unknown; sort?: { key: string; direction: 'asc' | 'desc' }[]; columns?: string[]; shared?: boolean },
) => {
  const v = await loadOwnView(ctx, id);
  assertVersion(ctx, v);
  validate(moduleDef(ctx, v.module), input);
  const patch: Partial<ViewRow> = {};
  if (input.name !== undefined) patch.name = input.name.trim();
  if (input.filterAst !== undefined) patch.filterAst = input.filterAst;
  if (input.sort !== undefined) patch.sort = input.sort;
  if (input.columns !== undefined) patch.columns = input.columns;
  if (input.shared !== undefined) patch.shared = input.shared;
  const [row] = await ctx.tx.update(savedViews).set({ ...patch, ...touch(ctx, savedViews) }).where(eq(savedViews.id, id)).returning();
  await audit(ctx, { action: 'saved_view.updated', entityType: 'saved_view', entityId: id, metadata: { module: v.module, shared: row!.shared } });
  await emit(ctx, { type: 'saved_view.updated', entityType: 'saved_view', entityId: id, revision: row!.rowVersion });
  return id;
};

/** Saved views hold filters only; removing one never touches records. */
export const removeSavedView = async (ctx: CommandContext, id: string) => {
  const v = await loadOwnView(ctx, id);
  assertVersion(ctx, v);
  await ctx.tx.delete(savedViews).where(eq(savedViews.id, id));
  await audit(ctx, { action: 'saved_view.removed', entityType: 'saved_view', entityId: id, metadata: { module: v.module, name: v.name } });
  await emit(ctx, { type: 'saved_view.removed', entityType: 'saved_view', entityId: id });
  return { ok: true as const };
};
