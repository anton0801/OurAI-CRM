import { and, desc, eq, inArray } from 'drizzle-orm';
import { assets, bulkPreviews, folders, projects } from '@castlane/database';
import { AppError, normalizeKey, newId } from '@castlane/domain';
import { allowed, requirePermission } from '../core/access';
import { audit, diffFields } from '../core/audit';
import type { CommandContext } from '../core/context';
import { emit } from '../core/events';
import { stamp, touch } from '../core/rows';
import { resolveTags } from '../core/tags';
import { archiveAsset, assetListWhere, assetScope, canReadAsset, canSeeRestricted, indexAsset, type AssetListFilter } from './assets';
import { canReadFolder } from './folders';

type AssetRow = typeof assets.$inferSelect;
export type BulkAssetAction = 'move' | 'tag' | 'untag' | 'archive';

const PREVIEW_TTL_MS = 10 * 60_000;
const FILTER_LIMIT = 1000;

interface PreviewItem {
  id: string;
  name: string;
  outcome: 'apply' | 'skip' | 'denied' | 'conflict';
  reason: string | null;
  scopeChange: { fromProjectId: string | null; toProjectId: string | null; fromProjectName: string | null; toProjectName: string | null } | null;
}

interface BulkParams {
  folderId?: string | null;
  tags?: string[];
  reason?: string;
}

/** Decide, for one file, what the bulk action would do. Pure with respect to the database. */
const evaluate = (
  ctx: CommandContext,
  a: AssetRow,
  action: BulkAssetAction,
  p: BulkParams,
  target: { folderId: string | null; projectId: string | null | undefined },
): Omit<PreviewItem, 'id' | 'name' | 'scopeChange'> & { toProjectId?: string | null } => {
  const scope = assetScope(a);
  switch (action) {
    case 'move': {
      if (!allowed(ctx, 'assets.upload', scope)) return { outcome: 'denied', reason: 'You cannot move this file.' };
      if (a.archivedAt) return { outcome: 'skip', reason: 'Archived files are not moved.' };
      if ((a.folderId ?? null) === target.folderId) return { outcome: 'skip', reason: 'Already in this folder.' };
      const toProject = target.projectId === undefined ? a.projectId : target.projectId;
      if (toProject !== a.projectId) {
        if (!allowed(ctx, 'assets.upload', { projectId: toProject })) return { outcome: 'denied', reason: 'You cannot add files to the target project.' };
        if (a.sensitivity === 'restricted' && !allowed(ctx, 'assets.restricted.read', { projectId: toProject }))
          return { outcome: 'denied', reason: 'Restricted media needs restricted-media access in the target project.' };
      }
      return { outcome: 'apply', reason: null, toProjectId: toProject };
    }
    case 'tag':
    case 'untag': {
      if (!allowed(ctx, 'assets.upload', scope)) return { outcome: 'denied', reason: 'You cannot edit this file.' };
      if (a.archivedAt) return { outcome: 'skip', reason: 'Archived files are read-only.' };
      const have = new Set(a.tags.map(normalizeKey));
      const wanted = (p.tags ?? []).map(normalizeKey);
      if (action === 'tag' && wanted.every((t) => have.has(t))) return { outcome: 'skip', reason: 'Already tagged.' };
      if (action === 'untag' && !wanted.some((t) => have.has(t))) return { outcome: 'skip', reason: 'None of these tags are on the file.' };
      if (action === 'tag' && new Set([...have, ...wanted]).size > 30) return { outcome: 'conflict', reason: 'A file can have at most 30 tags.' };
      return { outcome: 'apply', reason: null };
    }
    case 'archive': {
      if (!allowed(ctx, 'assets.archive', scope)) return { outcome: 'denied', reason: 'You cannot archive this file.' };
      if (a.archivedAt) return { outcome: 'skip', reason: 'Already archived.' };
      return { outcome: 'apply', reason: null };
    }
  }
};

const resolveTarget = async (ctx: CommandContext, action: BulkAssetAction, p: BulkParams) => {
  if (action !== 'move') return { folderId: null, projectId: undefined as string | null | undefined };
  if (!p.folderId) return { folderId: null, projectId: undefined };
  const [f] = await ctx.tx.select().from(folders).where(and(eq(folders.workspaceId, ctx.actor.workspaceId), eq(folders.id, p.folderId)));
  if (!f || !canReadFolder(ctx, f)) throw new AppError('VALIDATION_FAILED', 'Choose a folder you can access.', { fieldErrors: [{ field: 'folderId', code: 'NOT_FOUND', message: 'Choose a folder you can access.' }] });
  if (f.archivedAt) throw new AppError('VALIDATION_FAILED', 'The target folder is archived.', { fieldErrors: [{ field: 'folderId', code: 'ARCHIVED', message: 'The target folder is archived.' }] });
  // Project folders give their project to the files moved in; workspace folders keep each file's project.
  return { folderId: f.id, projectId: f.projectId ? f.projectId : undefined };
};

/**
 * Dry run of a bulk Library action (§4.6, §24.3): per-file outcome (apply / skip / denied /
 * conflict) and scope changes, stored as a 10-minute preview token with the target versions and
 * the actor's access revision. Nothing is changed.
 */
export const bulkAssetPreview = async (
  ctx: CommandContext,
  input: { action: BulkAssetAction; assetIds?: string[]; filter?: AssetListFilter; expectedCount?: number; folderId?: string | null; tags?: string[]; reason?: string },
) => {
  requirePermission(ctx, 'assets.read');
  if ((input.action === 'tag' || input.action === 'untag') && !input.tags?.length)
    throw new AppError('VALIDATION_FAILED', 'Choose at least one tag.', { fieldErrors: [{ field: 'tags', code: 'REQUIRED', message: 'Choose at least one tag.' }] });
  if (input.action === 'move' && input.folderId === undefined)
    throw new AppError('VALIDATION_FAILED', 'Choose a target folder.', { fieldErrors: [{ field: 'folderId', code: 'REQUIRED', message: 'Choose a target folder.' }] });
  const params: BulkParams = { folderId: input.folderId ?? null, tags: input.tags, reason: input.reason };
  const target = await resolveTarget(ctx, input.action, params);

  let rows: AssetRow[];
  let truncated = false;
  const missing: string[] = [];
  if (input.assetIds?.length) {
    const ids = [...new Set(input.assetIds)];
    const found = await ctx.tx.select().from(assets).where(and(eq(assets.workspaceId, ctx.actor.workspaceId), inArray(assets.id, ids)));
    const readable: AssetRow[] = [];
    for (const a of found) if (await canReadAsset(ctx, a)) readable.push(a);
    const ok = new Set(readable.map((a) => a.id));
    for (const id of ids) if (!ok.has(id)) missing.push(id);
    rows = readable;
  } else {
    rows = await ctx.tx
      .select()
      .from(assets)
      .where(assetListWhere(ctx, input.filter ?? {}))
      .orderBy(desc(assets.updatedAt), desc(assets.id))
      .limit(FILTER_LIMIT + 1);
    truncated = rows.length > FILTER_LIMIT;
    rows = rows.slice(0, FILTER_LIMIT);
  }

  const projectIds = [...new Set([...rows.map((r) => r.projectId), target.projectId].filter((x): x is string => !!x))];
  const names = projectIds.length
    ? new Map((await ctx.tx.select({ id: projects.id, name: projects.name }).from(projects).where(and(eq(projects.workspaceId, ctx.actor.workspaceId), inArray(projects.id, projectIds)))).map((p) => [p.id, p.name]))
    : new Map<string, string>();
  const nameOf = (id: string | null) => (id && allowed(ctx, 'projects.read', { projectId: id }) ? (names.get(id) ?? null) : null);

  const items: PreviewItem[] = rows.map((a) => {
    const e = evaluate(ctx, a, input.action, params, target);
    const to = e.toProjectId;
    return {
      id: a.id,
      name: a.name,
      outcome: e.outcome,
      reason: e.reason,
      scopeChange: input.action === 'move' && e.outcome === 'apply' && to !== undefined && to !== a.projectId ? { fromProjectId: a.projectId, toProjectId: to, fromProjectName: nameOf(a.projectId), toProjectName: nameOf(to) } : null,
    };
  });
  for (const id of missing) items.push({ id, name: 'Unavailable file', outcome: 'denied', reason: 'This file does not exist or you no longer have access to it.', scopeChange: null });

  const counts = { apply: 0, skip: 0, denied: 0, conflict: 0 };
  for (const i of items) counts[i.outcome]++;
  const token = newId();
  const expiresAt = new Date(ctx.app.clock.now().getTime() + PREVIEW_TTL_MS);
  const byId = new Map(rows.map((r) => [r.id, r]));
  await ctx.tx.insert(bulkPreviews).values({
    ...stamp(ctx),
    id: token,
    actorMembershipId: ctx.actor.membershipId!,
    action: `assets.${input.action}`,
    params: { ...params, targetProjectId: target.projectId === undefined ? '__keep__' : target.projectId },
    targets: items.map((i) => ({
      type: 'asset',
      id: i.id,
      rowVersion: byId.get(i.id)?.rowVersion ?? 0,
      status: i.outcome === 'apply' ? ('ok' as const) : i.outcome === 'denied' ? ('forbidden' as const) : ('conflict' as const),
    })),
    accessRevision: ctx.actor.access.accessRevision,
    summary: { ...counts, truncated, expectedCount: input.expectedCount ?? null },
    expiresAt,
  });
  return { token, expiresAt: expiresAt.toISOString(), action: input.action, items, counts, truncated };
};

const moveOne = async (ctx: CommandContext, a: AssetRow, folderId: string | null, projectId: string | null) => {
  const [row] = await ctx.tx.update(assets).set({ folderId, projectId, ...touch(ctx, assets) }).where(eq(assets.id, a.id)).returning();
  const scopeChanged = projectId !== a.projectId;
  await audit(ctx, {
    action: scopeChanged ? 'asset.moved_scope' : 'asset.moved',
    entityType: 'asset',
    entityId: a.id,
    projectId: projectId ?? a.projectId,
    diff: diffFields(a, row!, ['folderId', 'projectId']),
    sensitivity: scopeChanged ? 'security' : 'normal',
  });
  await emit(ctx, { type: 'asset.moved', entityType: 'asset', entityId: a.id, revision: row!.rowVersion });
  await indexAsset(ctx.tx, row!, ctx.app.clock.now());
};

const retagOne = async (ctx: CommandContext, a: AssetRow, tags: string[], mode: 'tag' | 'untag') => {
  const remove = new Set(tags.map(normalizeKey));
  const next = mode === 'tag' ? await resolveTags(ctx, [...a.tags, ...tags]) : a.tags.filter((t) => !remove.has(normalizeKey(t)));
  const [row] = await ctx.tx.update(assets).set({ tags: next, ...touch(ctx, assets) }).where(eq(assets.id, a.id)).returning();
  await audit(ctx, { action: 'asset.updated', entityType: 'asset', entityId: a.id, projectId: a.projectId, diff: diffFields(a, row!, ['tags']) });
  await emit(ctx, { type: 'asset.updated', entityType: 'asset', entityId: a.id, revision: row!.rowVersion });
  await indexAsset(ctx.tx, row!, ctx.app.clock.now());
};

/**
 * Apply a previewed bulk action. Every file is re-checked (current permissions, restricted
 * access, unchanged row version); each file runs in its own savepoint so one failure never
 * undoes the others, and failures can be retried with `onlyIds`.
 */
export const bulkAssetApply = async (ctx: CommandContext, input: { token: string; onlyIds?: string[] }) => {
  const [p] = await ctx.tx.select().from(bulkPreviews).where(and(eq(bulkPreviews.workspaceId, ctx.actor.workspaceId), eq(bulkPreviews.id, input.token))).for('update');
  if (!p || p.actorMembershipId !== ctx.actor.membershipId || !p.action.startsWith('assets.')) throw new AppError('NOT_FOUND', 'This preview was not found. Preview the change again.');
  if (p.expiresAt <= ctx.app.clock.now()) throw new AppError('INVALID_STATE', 'The preview expired. Preview the change again.');
  if (p.accessRevision !== ctx.actor.access.accessRevision) throw new AppError('INVALID_STATE', 'Your access changed after the preview. Preview the change again.');
  if (p.consumedAt && !input.onlyIds?.length) throw new AppError('INVALID_STATE', 'This preview was already applied.');
  const action = p.action.slice('assets.'.length) as BulkAssetAction;
  const params = p.params as BulkParams & { targetProjectId?: string | null };
  const only = input.onlyIds?.length ? new Set(input.onlyIds) : null;
  const targets = p.targets.filter((t) => t.status === 'ok' && (!only || only.has(t.id)));
  const target = { folderId: params.folderId ?? null, projectId: params.targetProjectId === '__keep__' ? undefined : (params.targetProjectId ?? null) };
  if (action === 'move' && target.folderId) {
    const [f] = await ctx.tx.select({ archivedAt: folders.archivedAt }).from(folders).where(eq(folders.id, target.folderId));
    if (!f || f.archivedAt) throw new AppError('INVALID_STATE', 'The target folder is no longer available. Preview again.');
  }
  const applied: string[] = [];
  const failed: { id: string; reason: string }[] = [];
  for (const t of targets) {
    try {
      await ctx.tx.transaction(async () => {
        const [a] = await ctx.tx.select().from(assets).where(and(eq(assets.workspaceId, ctx.actor.workspaceId), eq(assets.id, t.id))).for('update');
        if (!a || a.deletedAt || !canSeeRestricted(ctx, a) || !(await canReadAsset(ctx, a))) throw new AppError('NOT_FOUND', 'The file is no longer available.');
        if (a.rowVersion !== t.rowVersion) throw new AppError('VERSION_CONFLICT', 'The file changed after the preview.');
        const e = evaluate(ctx, a, action, params, target);
        if (e.outcome !== 'apply') throw new AppError(e.outcome === 'denied' ? 'FORBIDDEN' : 'INVALID_STATE', e.reason ?? 'Not applicable any more.');
        if (action === 'move') await moveOne(ctx, a, target.folderId, e.toProjectId ?? a.projectId);
        else if (action === 'tag' || action === 'untag') await retagOne(ctx, a, params.tags ?? [], action);
        else await archiveAsset(ctx, a.id, params.reason, { skipVersion: true });
      });
      applied.push(t.id);
    } catch (e) {
      failed.push({ id: t.id, reason: e instanceof AppError ? e.message : 'The change could not be applied.' });
    }
  }
  await ctx.tx.update(bulkPreviews).set({ consumedAt: ctx.app.clock.now(), ...touch(ctx, bulkPreviews) }).where(eq(bulkPreviews.id, p.id));
  await audit(ctx, { action: `asset.bulk_${action}`, entityType: 'bulk_preview', entityId: p.id, metadata: { applied: applied.length, failed: failed.length } });
  return { applied, failed, skipped: p.targets.length - targets.length };
};
