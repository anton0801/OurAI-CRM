import { and, asc, count, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { listFilter } from '@castlane/authorization';
import { assets, folders, projects } from '@castlane/database';
import { AppError, normalizeKey, newId, notFound } from '@castlane/domain';
import type { ImpactItem } from '@castlane/api-contracts';
import { allowed, authorizeObject, requirePermission } from '../core/access';
import { audit, diffFields } from '../core/audit';
import { dbOf, type CommandContext, type QueryContext } from '../core/context';
import { emit } from '../core/events';
import { assertVersion, lockById, stamp, touch } from '../core/rows';
import { assetListWhere, folderPath } from './assets';
import { checkFolderMove, MAX_FOLDER_DEPTH } from './folder-rules';

type FolderRow = typeof folders.$inferSelect;

/**
 * Folders are logical: they never change a file's access by themselves. A folder belongs to one
 * scope (a project, or the workspace library when projectId is null); subfolders share their
 * parent's scope. Project folders are visible with assets.read on the project; workspace folders
 * to members who browse the Library at project level or wider.
 */
export const folderScope = (f: Pick<FolderRow, 'id' | 'projectId'>) => ({ objectType: 'folder', objectId: f.id, projectId: f.projectId });

export const folderVisibility = (ctx: QueryContext): SQL | undefined => {
  const f = listFilter(ctx.actor.access, 'assets.read');
  if (f.kind === 'all') return undefined;
  if (f.kind === 'none') return sql`false`;
  const parts: SQL[] = [];
  if (f.projectIds.length) parts.push(inArray(folders.projectId, f.projectIds));
  if (f.projectIds.length || f.accountIds.length) parts.push(isNull(folders.projectId));
  return parts.length ? or(...parts) : sql`false`;
};

export const canReadFolder = (ctx: QueryContext, f: FolderRow) => {
  if (f.projectId) return allowed(ctx, 'assets.read', folderScope(f));
  const lf = listFilter(ctx.actor.access, 'assets.read');
  return lf.kind === 'all' || (lf.kind === 'scoped' && (lf.projectIds.length > 0 || lf.accountIds.length > 0));
};

const permissionsOf = (ctx: QueryContext, f: FolderRow) => ({
  create: allowed(ctx, 'assets.upload', folderScope(f)) && !f.archivedAt && f.depth < MAX_FOLDER_DEPTH,
  update: allowed(ctx, 'assets.upload', folderScope(f)) && !f.archivedAt,
  archive: allowed(ctx, 'assets.archive', folderScope(f)),
});

const projectNames = async (ctx: QueryContext, rows: FolderRow[]) => {
  const ids = [...new Set(rows.map((r) => r.projectId).filter((x): x is string => !!x))];
  if (!ids.length) return new Map<string, string>();
  const ps = await dbOf(ctx).select({ id: projects.id, name: projects.name }).from(projects).where(and(eq(projects.workspaceId, ctx.actor.workspaceId), inArray(projects.id, ids)));
  return new Map(ps.map((p) => [p.id, p.name]));
};

const toView = (ctx: QueryContext, f: FolderRow, names: Map<string, string>) => ({
  id: f.id,
  name: f.name,
  parentId: f.parentId,
  projectId: f.projectId,
  projectName: f.projectId && allowed(ctx, 'projects.read', { projectId: f.projectId }) ? (names.get(f.projectId) ?? null) : null,
  depth: f.depth,
  archivedAt: f.archivedAt?.toISOString() ?? null,
  updatedAt: f.updatedAt.toISOString(),
  rowVersion: f.rowVersion,
  permissions: permissionsOf(ctx, f),
});

export const listFolders = async (ctx: QueryContext, input: { includeArchived?: boolean; projectId?: string }) => {
  requirePermission(ctx, 'assets.read');
  const rows = await dbOf(ctx)
    .select()
    .from(folders)
    .where(
      and(
        eq(folders.workspaceId, ctx.actor.workspaceId),
        folderVisibility(ctx),
        input.includeArchived ? undefined : isNull(folders.archivedAt),
        input.projectId ? or(eq(folders.projectId, input.projectId), isNull(folders.projectId)) : undefined,
      ),
    )
    .orderBy(asc(folders.depth), asc(folders.nameKey))
    .limit(5000);
  const names = await projectNames(ctx, rows);
  return rows.map((f) => toView(ctx, f, names));
};

const loadReadableFolder = async (ctx: QueryContext | CommandContext, id: string, lock = false): Promise<FolderRow> => {
  const f = lock && 'tx' in ctx ? await lockById(ctx, folders, id, 'Folder') : (await dbOf(ctx).select().from(folders).where(and(eq(folders.workspaceId, ctx.actor.workspaceId), eq(folders.id, id))))[0];
  if (!f || !canReadFolder(ctx, f)) throw notFound('Folder');
  return f;
};

export const getFolder = async (ctx: QueryContext, id: string) => {
  requirePermission(ctx, 'assets.read');
  const f = await loadReadableFolder(ctx, id);
  const db = dbOf(ctx);
  const [sub] = await db
    .select({ n: count() })
    .from(folders)
    .where(and(eq(folders.workspaceId, ctx.actor.workspaceId), eq(folders.parentId, f.id), isNull(folders.archivedAt), folderVisibility(ctx)));
  const [files] = await db.select({ n: count() }).from(assets).where(assetListWhere(ctx, { folderId: f.id }));
  const names = await projectNames(ctx, [f]);
  return {
    ...toView(ctx, f, names),
    path: await folderPath(ctx, f.id),
    counts: { subfolders: Number(sub?.n ?? 0), assets: Number(files?.n ?? 0) },
  };
};

const nameTaken = async (ctx: CommandContext, parentId: string | null, nameKey: string, exceptId?: string) => {
  const [dup] = await ctx.tx
    .select({ id: folders.id })
    .from(folders)
    .where(
      and(
        eq(folders.workspaceId, ctx.actor.workspaceId),
        parentId ? eq(folders.parentId, parentId) : isNull(folders.parentId),
        eq(folders.nameKey, nameKey),
        isNull(folders.archivedAt),
        exceptId ? sql`${folders.id} <> ${exceptId}` : undefined,
      ),
    );
  return !!dup;
};

const duplicateName = () =>
  new AppError('VALIDATION_FAILED', 'A folder with this name already exists here.', {
    fieldErrors: [{ field: 'name', code: 'DUPLICATE', message: 'A folder with this name already exists here.' }],
  });

export const createFolder = async (ctx: CommandContext, input: { name: string; parentId?: string | null; projectId?: string | null }) => {
  requirePermission(ctx, 'assets.upload');
  let projectId = input.projectId ?? null;
  let depth = 0;
  if (input.parentId) {
    const parent = await loadReadableFolder(ctx, input.parentId, true);
    if (parent.archivedAt) throw new AppError('INVALID_STATE', 'The parent folder is archived.');
    if (input.projectId !== undefined && input.projectId !== parent.projectId)
      throw new AppError('VALIDATION_FAILED', 'Subfolders belong to the same project as their parent folder.', {
        fieldErrors: [{ field: 'projectId', code: 'SCOPE_MISMATCH', message: 'Subfolders belong to the same project as their parent folder.' }],
      });
    projectId = parent.projectId;
    depth = parent.depth + 1;
    if (depth > MAX_FOLDER_DEPTH) throw new AppError('VALIDATION_FAILED', `Folders can be nested at most ${MAX_FOLDER_DEPTH + 1} levels deep.`);
  } else if (projectId) {
    const [p] = await ctx.tx.select({ id: projects.id }).from(projects).where(and(eq(projects.workspaceId, ctx.actor.workspaceId), eq(projects.id, projectId)));
    if (!p || !allowed(ctx, 'assets.read', { projectId })) throw new AppError('VALIDATION_FAILED', 'Choose a project you can access.', { fieldErrors: [{ field: 'projectId', code: 'NOT_FOUND', message: 'Choose a project you can access.' }] });
  }
  if (!allowed(ctx, 'assets.upload', { projectId })) throw new AppError('FORBIDDEN', projectId ? 'You cannot create folders in this project.' : 'Only members with workspace-wide file access can create workspace folders.');
  const name = input.name.trim();
  const nameKey = normalizeKey(name);
  if (await nameTaken(ctx, input.parentId ?? null, nameKey)) throw duplicateName();
  const id = newId();
  const [row] = await ctx.tx.insert(folders).values({ ...stamp(ctx), id, name, nameKey, parentId: input.parentId ?? null, projectId, depth }).returning();
  await audit(ctx, { action: 'folder.created', entityType: 'folder', entityId: id, projectId, diff: diffFields(null, row!, ['name', 'parentId', 'projectId']) });
  await emit(ctx, { type: 'folder.created', entityType: 'folder', entityId: id, revision: 1 });
  return id;
};

export const renameFolder = async (ctx: CommandContext, id: string, input: { name: string }) => {
  const f = await loadReadableFolder(ctx, id, true);
  authorizeObject(ctx, 'assets.upload', folderScope(f), 'assets.read');
  assertVersion(ctx, f);
  if (f.archivedAt) throw new AppError('INVALID_STATE', 'Archived folders are read-only. Restore the folder to rename it.');
  const name = input.name.trim();
  const nameKey = normalizeKey(name);
  if (nameKey !== f.nameKey && (await nameTaken(ctx, f.parentId, nameKey, f.id))) throw duplicateName();
  const [row] = await ctx.tx.update(folders).set({ name, nameKey, ...touch(ctx, folders) }).where(eq(folders.id, id)).returning();
  await audit(ctx, { action: 'folder.renamed', entityType: 'folder', entityId: id, projectId: f.projectId, diff: diffFields(f, row!, ['name']) });
  await emit(ctx, { type: 'folder.updated', entityType: 'folder', entityId: id, revision: row!.rowVersion });
  return id;
};

/**
 * Move a folder (and its subtree) under another folder of the same scope or to the library root.
 * Cycles and nesting deeper than six levels are refused; descendants' depths are updated.
 */
export const moveFolder = async (ctx: CommandContext, id: string, input: { parentId: string | null }) => {
  const f = await loadReadableFolder(ctx, id, true);
  authorizeObject(ctx, 'assets.upload', folderScope(f), 'assets.read');
  assertVersion(ctx, f);
  if (f.archivedAt) throw new AppError('INVALID_STATE', 'Archived folders cannot be moved.');
  let parentDepth: number | null = null;
  if (input.parentId) {
    const parent = await loadReadableFolder(ctx, input.parentId, true);
    if (parent.archivedAt) throw new AppError('INVALID_STATE', 'The target folder is archived.');
    if (parent.projectId !== f.projectId)
      throw new AppError('VALIDATION_FAILED', 'Folders can only move within the same project library. Move the files instead — a change of project is previewed per file.', {
        fieldErrors: [{ field: 'parentId', code: 'SCOPE_MISMATCH', message: 'Choose a folder of the same project.' }],
      });
    if (!allowed(ctx, 'assets.upload', folderScope(parent))) throw new AppError('FORBIDDEN', 'You cannot add folders there.');
    parentDepth = parent.depth;
  }
  const nodes = await ctx.tx
    .select({ id: folders.id, parentId: folders.parentId })
    .from(folders)
    .where(and(eq(folders.workspaceId, ctx.actor.workspaceId), f.projectId ? eq(folders.projectId, f.projectId) : isNull(folders.projectId)));
  const check = checkFolderMove(nodes, f.id, input.parentId, parentDepth);
  if (!check.ok) throw new AppError(check.code === 'SAME_PARENT' ? 'INVALID_STATE' : 'VALIDATION_FAILED', check.message, { fieldErrors: [{ field: 'parentId', code: check.code, message: check.message }] });
  if (await nameTaken(ctx, input.parentId, f.nameKey, f.id)) throw new AppError('VALIDATION_FAILED', 'A folder with this name already exists in the target folder. Rename it first.', { fieldErrors: [{ field: 'parentId', code: 'DUPLICATE', message: 'A folder with this name already exists there.' }] });
  const delta = check.newDepth - f.depth;
  const [row] = await ctx.tx.update(folders).set({ parentId: input.parentId, depth: check.newDepth, ...touch(ctx, folders) }).where(eq(folders.id, id)).returning();
  if (delta !== 0)
    await ctx.tx.execute(sql`
      WITH RECURSIVE sub AS (
        SELECT id FROM folders WHERE workspace_id = ${ctx.actor.workspaceId} AND parent_id = ${id}
        UNION ALL SELECT c.id FROM folders c JOIN sub s ON c.parent_id = s.id WHERE c.workspace_id = ${ctx.actor.workspaceId}
      ) UPDATE folders SET depth = depth + ${delta}, updated_at = ${ctx.app.clock.now()} WHERE id IN (SELECT id FROM sub)`);
  await audit(ctx, { action: 'folder.moved', entityType: 'folder', entityId: id, projectId: f.projectId, diff: diffFields(f, row!, ['parentId']) });
  await emit(ctx, { type: 'folder.moved', entityType: 'folder', entityId: id, revision: row!.rowVersion });
  return id;
};

export const folderArchiveItems = async (ctx: QueryContext | CommandContext, f: FolderRow): Promise<ImpactItem[]> => {
  const db = dbOf(ctx);
  const [sub] = await db.select({ n: count() }).from(folders).where(and(eq(folders.workspaceId, ctx.actor.workspaceId), eq(folders.parentId, f.id), isNull(folders.archivedAt)));
  const [files] = await db
    .select({ n: count(), restricted: sql<number>`count(*) FILTER (WHERE ${assets.sensitivity} = 'restricted')` })
    .from(assets)
    .where(and(eq(assets.workspaceId, ctx.actor.workspaceId), eq(assets.folderId, f.id), isNull(assets.archivedAt), isNull(assets.deletedAt)));
  const items: ImpactItem[] = [];
  if (Number(sub?.n ?? 0) > 0) items.push({ kind: 'subfolders', label: 'Active subfolders', count: Number(sub!.n), blocking: true, resolution: 'Move or archive the subfolders first.' });
  const normal = Number(files?.n ?? 0) - Number(files?.restricted ?? 0);
  if (normal > 0) items.push({ kind: 'files', label: 'Files in this folder', count: normal, blocking: true, resolution: 'Move or archive the files first.' });
  if (Number(files?.restricted ?? 0) > 0)
    items.push({ kind: 'restricted_files', label: 'Restricted files (visible with restricted-media access)', count: Number(files!.restricted), blocking: true, resolution: 'A member with restricted-media access must move or archive them.' });
  return items;
};

export const folderArchivePreview = async (ctx: QueryContext, id: string) => {
  const f = await loadReadableFolder(ctx, id);
  authorizeObject(ctx, 'assets.archive', folderScope(f), 'assets.read');
  return { title: f.name, rowVersion: f.rowVersion, items: await folderArchiveItems(ctx, f) };
};

export const archiveFolder = async (ctx: CommandContext, id: string, input: { reason?: string }, opts: { skipVersion?: boolean } = {}) => {
  const f = await loadReadableFolder(ctx, id, true);
  authorizeObject(ctx, 'assets.archive', folderScope(f), 'assets.read');
  if (!opts.skipVersion) assertVersion(ctx, f);
  if (f.archivedAt) return id;
  const blocking = (await folderArchiveItems(ctx, f)).filter((i) => i.blocking);
  if (blocking.length) throw new AppError('INVALID_STATE', 'Move or archive the folder’s contents first.', { details: { items: blocking } });
  const [row] = await ctx.tx
    .update(folders)
    .set({ archivedAt: ctx.app.clock.now(), archivedBy: ctx.actor.userId, archiveReason: input.reason ?? null, ...touch(ctx, folders) })
    .where(eq(folders.id, id))
    .returning();
  await audit(ctx, { action: 'folder.archived', entityType: 'folder', entityId: id, projectId: f.projectId, reason: input.reason });
  await emit(ctx, { type: 'folder.archived', entityType: 'folder', entityId: id, revision: row!.rowVersion });
  return id;
};

export const restoreFolder = async (ctx: CommandContext, id: string, opts: { skipVersion?: boolean } = {}) => {
  const f = await loadReadableFolder(ctx, id, true);
  authorizeObject(ctx, 'assets.archive', folderScope(f), 'assets.read');
  if (!opts.skipVersion) assertVersion(ctx, f);
  if (!f.archivedAt) throw new AppError('INVALID_STATE', 'This folder is not archived.');
  if (f.parentId) {
    const [p] = await ctx.tx.select({ archivedAt: folders.archivedAt }).from(folders).where(eq(folders.id, f.parentId));
    if (!p || p.archivedAt) throw new AppError('INVALID_STATE', 'Restore the parent folder first.');
  }
  if (await nameTaken(ctx, f.parentId, f.nameKey, f.id)) throw new AppError('DUPLICATE', 'An active folder with the same name exists in the same place. Rename it first.');
  const [row] = await ctx.tx.update(folders).set({ archivedAt: null, archivedBy: null, archiveReason: null, ...touch(ctx, folders) }).where(eq(folders.id, id)).returning();
  await audit(ctx, { action: 'folder.restored', entityType: 'folder', entityId: id, projectId: f.projectId });
  await emit(ctx, { type: 'folder.restored', entityType: 'folder', entityId: id, revision: row!.rowVersion });
  return id;
};
