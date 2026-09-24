import { and, desc, eq, ilike, inArray, lt, or, sql } from 'drizzle-orm';
import { entityHref, type EntityPreviewItem } from '@castlane/api-contracts';
import { ALL_PERMISSIONS, hasAnywhere } from '@castlane/authorization';
import { bulkPreviews, memberships, searchDocuments, workspaces } from '@castlane/database';
import { AppError, decodeCursor, encodeCursor, clampPageSize, isAppError, newId } from '@castlane/domain';
import { requirePermission, requireRecentAuth } from '../core/access';
import { allArchiveHandlers, getArchiveHandler, type ArchiveCollision, type ArchiveHandler, type ArchiveListItem } from '../core/archive-registry';
import { audit } from '../core/audit';
import { executeCommand } from '../core/command';
import type { CommandContext, QueryContext } from '../core/context';
import { dbOf } from '../core/context';
import { enqueueJob } from '../core/jobs';
import { defineJob, memberJobContext, systemJobContext } from '../core/jobs-registry';
import { loadMemberRefs, type MemberRef } from '../core/members';
import { stamp } from '../core/rows';
import { removeSearchDocument } from '../core/search';
import { searchPermissionPredicate } from './search';

const PREVIEW_TTL_MS = 10 * 60_000;

/** Finance and audit records are never deleted through the trash (T156). */
const NEVER_PURGE = /^(financ|settlement|budget|compensation|payment|adjustment|period|fx|audit|ledger|entry_line|allocation)/;
export const purgeForbidden = (entityType: string) => NEVER_PURGE.test(entityType);

type Target = { entityType: string; entityId: string; state?: 'archived' | 'trash' };
const refKey = (t: { entityType: string; entityId: string }) => `${t.entityType}:${t.entityId}`;

export const archiveTypes = (ctx: QueryContext) =>
  allArchiveHandlers()
    .map((h) => ({
      entityType: h.entityType,
      label: h.label,
      trash: !!h.trash,
      purge: !!h.purge && !purgeForbidden(h.entityType) && hasAnywhere(ctx.actor.access, 'trash.purge'),
      listable: !!h.list,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));

/** Archived records of types without their own listing: the permission-aware search projection. */
const searchArchived = async (ctx: QueryContext, h: ArchiveHandler, input: { q?: string; projectId?: string; before?: { at: Date; id: string }; limit: number }): Promise<ArchiveListItem[]> => {
  const perms = searchPermissionPredicate(ctx);
  if (!perms) return [];
  const rows = await ctx.app.db
    .select()
    .from(searchDocuments)
    .where(
      and(
        eq(searchDocuments.workspaceId, ctx.actor.workspaceId),
        eq(searchDocuments.entityType, h.entityType),
        eq(searchDocuments.archived, true),
        perms,
        input.q ? ilike(searchDocuments.title, `%${input.q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`) : undefined,
        input.projectId ? eq(searchDocuments.projectId, input.projectId) : undefined,
        input.before ? or(lt(searchDocuments.updatedAt, input.before.at), and(eq(searchDocuments.updatedAt, input.before.at), lt(searchDocuments.entityId, input.before.id))) : undefined,
      ),
    )
    .orderBy(desc(searchDocuments.updatedAt), desc(searchDocuments.entityId))
    .limit(input.limit);
  return rows.map((r) => ({ id: r.entityId, title: r.title, at: r.updatedAt, byUserId: null, reason: null, projectId: r.projectId, purgeAfter: null, thumbnailAssetId: r.restricted ? null : r.thumbnailAssetId }));
};

const memberRefsByUser = async (ctx: QueryContext, userIds: (string | null)[]) => {
  const ids = [...new Set(userIds.filter((x): x is string => !!x))];
  const out = new Map<string, MemberRef>();
  if (!ids.length) return out;
  const ms = await dbOf(ctx).select({ id: memberships.id, userId: memberships.userId }).from(memberships).where(and(eq(memberships.workspaceId, ctx.actor.workspaceId), inArray(memberships.userId, ids)));
  const refs = await loadMemberRefs(dbOf(ctx), ctx.actor.workspaceId, ms.map((m) => m.id));
  for (const m of ms) {
    const r = refs.get(m.id);
    if (r) out.set(m.userId, r);
  }
  return out;
};

/**
 * Archive / Trash listing across entity types (S70), newest first. Each handler applies its module's
 * read scope in SQL; types without a listing fall back to the permission-aware search projection.
 */
export const listArchive = async (ctx: QueryContext, input: { state: 'archived' | 'trash'; entityType?: string; q?: string; projectId?: string; cursor?: string; pageSize?: number }) => {
  const size = clampPageSize(input.pageSize);
  const c = input.cursor ? decodeCursor(input.cursor) : null;
  const before = c ? { at: new Date(String(c.v[0])), id: c.id } : undefined;
  const handlers = input.entityType ? [getArchiveHandler(input.entityType)].filter((h): h is ArchiveHandler => !!h) : allArchiveHandlers();
  const found: { h: ArchiveHandler; item: ArchiveListItem }[] = [];
  for (const h of handlers) {
    let items: ArchiveListItem[] = [];
    try {
      if (h.list) items = await h.list(ctx, { state: input.state, q: input.q, projectId: input.projectId, before, limit: size + 1 });
      else if (input.state === 'archived') items = await searchArchived(ctx, h, { q: input.q, projectId: input.projectId, before, limit: size + 1 });
    } catch (e) {
      // A type the member cannot read at all simply contributes nothing.
      if (isAppError(e) && (e.code === 'FORBIDDEN' || e.code === 'NOT_FOUND')) continue;
      throw e;
    }
    for (const item of items) found.push({ h, item });
  }
  found.sort((a, b) => b.item.at.getTime() - a.item.at.getTime() || (b.item.id > a.item.id ? 1 : b.item.id < a.item.id ? -1 : 0));
  const page = found.slice(0, size);
  const hasMore = found.length > size;
  const refs = await memberRefsByUser(ctx, page.map((p) => p.item.byUserId));
  const canPurge = hasAnywhere(ctx.actor.access, 'trash.purge');
  const last = page[page.length - 1];
  return {
    items: page.map(({ h, item }) => ({
      entityType: h.entityType,
      entityId: item.id,
      typeLabel: h.label,
      title: item.title,
      state: input.state,
      at: item.at.toISOString(),
      by: item.byUserId ? (refs.get(item.byUserId) ?? null) : null,
      reason: item.reason,
      projectId: item.projectId,
      purgeAfter: item.purgeAfter?.toISOString() ?? null,
      href: entityHref(ctx.actor.workspaceId, h.entityType, item.id, { projectId: item.projectId }),
      thumbnailUrl: item.thumbnailAssetId ? `/api/v1/workspaces/${ctx.actor.workspaceId}/assets/${item.thumbnailAssetId}/thumbnail?size=64` : null,
      canRestore: input.state === 'archived' ? !!h.restore : !!h.untrash,
      canPurge: input.state === 'trash' && canPurge && !!h.purge && !purgeForbidden(h.entityType),
    })),
    hasMore,
    nextCursor: hasMore && last ? encodeCursor({ v: [last.item.at.toISOString()], id: last.item.id }) : null,
  };
};

// ——— Preview tokens ———

const saveToken = async (ctx: QueryContext, action: string, items: (EntityPreviewItem & { rowVersion?: number; state?: string })[], params: Record<string, unknown> = {}) => {
  const expiresAt = new Date(ctx.app.clock.now().getTime() + PREVIEW_TTL_MS);
  const id = newId();
  await executeCommand(ctx, async (c) => {
    await c.tx.insert(bulkPreviews).values({
      ...stamp(c),
      id,
      actorMembershipId: ctx.actor.membershipId!,
      action,
      params: {
        ...params,
        states: Object.fromEntries(items.map((i) => [refKey(i), i.state ?? null])),
        collisions: Object.fromEntries(items.map((i) => [refKey(i), i.collisions.map((x) => x.field)])),
        messages: Object.fromEntries(items.filter((i) => i.status !== 'ok').map((i) => [refKey(i), i.message ?? null])),
      },
      targets: items.map((i) => ({ type: i.entityType, id: i.entityId, rowVersion: i.rowVersion ?? 0, status: i.status === 'ok' ? ('ok' as const) : i.status === 'forbidden' ? ('forbidden' as const) : ('conflict' as const) })),
      accessRevision: ctx.actor.access.accessRevision,
      summary: { ok: items.filter((i) => i.status === 'ok').length, total: items.length },
      expiresAt,
    });
  });
  return { token: id, expiresAt: expiresAt.toISOString() };
};

const consumeToken = async (ctx: CommandContext, token: string, action: string) => {
  const [p] = await ctx.tx.select().from(bulkPreviews).where(and(eq(bulkPreviews.workspaceId, ctx.actor.workspaceId), eq(bulkPreviews.id, token))).for('update');
  if (!p || p.action !== action || p.actorMembershipId !== ctx.actor.membershipId || p.consumedAt || p.expiresAt <= ctx.app.clock.now())
    throw new AppError('INVALID_STATE', 'The preview expired or was already used. Preview again.');
  if (p.accessRevision !== ctx.actor.access.accessRevision) throw new AppError('INVALID_STATE', 'Your access changed after the preview. Preview again.');
  await ctx.tx.update(bulkPreviews).set({ consumedAt: ctx.app.clock.now() }).where(eq(bulkPreviews.id, p.id));
  return p;
};

type TokenParams = { states?: Record<string, string | null>; collisions?: Record<string, string[]>; messages?: Record<string, string | null> };

/** A target the preview did not allow is reported with the preview's reason — never silently dropped. */
const notDone = (verb: string, params: TokenParams, key: string) => {
  const why = params.messages?.[key];
  return why ? `Not ${verb}: ${why}` : `Not ${verb}: the preview did not allow this record. Preview again.`;
};

const outcome = (t: Target, e: unknown, title = 'Record'): EntityPreviewItem => {
  const base = { entityType: t.entityType, entityId: t.entityId, title, items: [], collisions: [] };
  if (isAppError(e)) {
    if (e.code === 'NOT_FOUND') return { ...base, title: 'Unavailable record', status: 'not_found', message: 'The record does not exist or you cannot access it.' };
    if (e.code === 'FORBIDDEN') return { ...base, status: 'forbidden', message: e.message };
    return { ...base, status: 'blocked', message: e.message };
  }
  throw e;
};

/** Run one item inside a savepoint so a failing item never breaks the others (per-item policy, 4.6). */
const perItem = async (ctx: CommandContext, fn: () => Promise<void>): Promise<string | null> => {
  await ctx.tx.execute(sql`SAVEPOINT archive_item`);
  try {
    await fn();
    await ctx.tx.execute(sql`RELEASE SAVEPOINT archive_item`);
    return null;
  } catch (e) {
    await ctx.tx.execute(sql`ROLLBACK TO SAVEPOINT archive_item`);
    if (isAppError(e)) return e.message;
    const code = (e as { code?: string }).code ?? (e as { cause?: { code?: string } }).cause?.code;
    if (code === '23505') return 'Another record already uses the same unique value. Choose a different resolution.';
    if (code === '23503') return 'The record is still referenced by other records.';
    throw e;
  }
};

// ——— Archive ———

export const archivePreview = async (ctx: QueryContext, targets: Target[]) => {
  const items: (EntityPreviewItem & { rowVersion?: number })[] = [];
  for (const t of targets) {
    const h = getArchiveHandler(t.entityType);
    if (!h) {
      items.push({ entityType: t.entityType, entityId: t.entityId, title: 'Record', status: 'not_supported', message: 'This record type cannot be archived here.', items: [], collisions: [] });
      continue;
    }
    try {
      const p = await h.preview(ctx, t.entityId);
      const blocking = p.items.some((i) => i.blocking);
      items.push({ entityType: t.entityType, entityId: t.entityId, title: p.title, status: blocking ? 'blocked' : 'ok', message: blocking ? 'Resolve the blocking obligations first.' : null, items: p.items, collisions: [], rowVersion: p.rowVersion });
    } catch (e) {
      items.push(outcome(t, e));
    }
  }
  const token = await saveToken(ctx, 'entities.archive', items);
  return { ...token, items: items.map(({ rowVersion: _rv, ...i }) => i), eligibleCount: items.filter((i) => i.status === 'ok').length };
};

export const archiveEntities = async (ctx: CommandContext, input: { previewToken: string; reason?: string; resolutions?: Record<string, Record<string, string>> }) => {
  const p = await consumeToken(ctx, input.previewToken, 'entities.archive');
  const params = p.params as TokenParams;
  const done: Target[] = [];
  const failed: (Target & { message: string })[] = [];
  for (const t of p.targets) {
    const ref = { entityType: t.type, entityId: t.id };
    const h = getArchiveHandler(t.type);
    if (t.status !== 'ok' || !h) {
      failed.push({ ...ref, message: notDone('archived', params, refKey(ref)) });
      continue;
    }
    const err = await perItem(ctx, async () => {
      const now = await h.preview(ctx, t.id);
      if (now.rowVersion !== t.rowVersion) throw new AppError('INVALID_STATE', 'The record changed after the preview. Preview again.');
      if (now.items.some((i) => i.blocking)) throw new AppError('INVALID_STATE', 'New blocking obligations appeared. Preview again.');
      await h.archive(ctx, t.id, { reason: input.reason, resolutions: input.resolutions?.[refKey(ref)] });
    });
    if (err) failed.push({ ...ref, message: err });
    else done.push(ref);
  }
  return { done, failed };
};

// ——— Trash ———

export const trashEntities = async (ctx: CommandContext, input: { targets: Target[]; reason: string }) => {
  const done: Target[] = [];
  const failed: (Target & { message: string })[] = [];
  for (const t of input.targets) {
    const ref = { entityType: t.entityType, entityId: t.entityId };
    const h = getArchiveHandler(t.entityType);
    if (!h?.trash) {
      failed.push({ ...ref, message: 'This record type cannot be moved to the trash.' });
      continue;
    }
    const err = await perItem(ctx, () => h.trash!(ctx, t.entityId, input.reason));
    if (err) failed.push({ ...ref, message: err });
    else done.push(ref);
  }
  return { done, failed };
};

// ——— Restore (archived or trashed) ———

export const restorePreview = async (ctx: QueryContext, targets: Target[]) => {
  const items: (EntityPreviewItem & { state?: string })[] = [];
  for (const t of targets) {
    const h = getArchiveHandler(t.entityType);
    const fromTrash = t.state === 'trash';
    const previewFn = fromTrash ? h?.untrashPreview : h?.restorePreview;
    const canRestore = fromTrash ? h?.untrash : h?.restore;
    if (!h || !canRestore) {
      items.push({ entityType: t.entityType, entityId: t.entityId, title: 'Record', status: 'not_supported', message: 'This record cannot be restored here.', items: [], collisions: [], state: t.state });
      continue;
    }
    try {
      const p = previewFn ? await previewFn.call(h, ctx, t.entityId) : { title: 'Record', items: [], collisions: [] as ArchiveCollision[] };
      const blocking = p.items.some((i) => i.blocking);
      const collisions = p.collisions ?? [];
      items.push({
        entityType: t.entityType,
        entityId: t.entityId,
        title: p.title,
        status: blocking ? 'blocked' : 'ok',
        message: blocking ? 'Resolve the blocking items first.' : collisions.length ? 'Choose how to resolve the conflicting values.' : null,
        items: p.items,
        collisions,
        state: t.state,
      });
    } catch (e) {
      items.push({ ...outcome(t, e), state: t.state });
    }
  }
  const token = await saveToken(ctx, 'entities.restore', items);
  return { ...token, items: items.map(({ state: _s, ...i }) => i), eligibleCount: items.filter((i) => i.status === 'ok').length };
};

/** Restore with current authorisation; unique collisions need an explicit resolution (T155). */
export const restoreEntities = async (ctx: CommandContext, input: { previewToken: string; resolutions?: Record<string, Record<string, string>> }) => {
  const p = await consumeToken(ctx, input.previewToken, 'entities.restore');
  const params = p.params as TokenParams;
  const done: Target[] = [];
  const failed: (Target & { message: string })[] = [];
  for (const t of p.targets) {
    const ref = { entityType: t.type, entityId: t.id };
    const key = refKey(ref);
    const h = getArchiveHandler(t.type);
    // Blocked, forbidden or unsupported targets are listed as not restored, with the reason.
    if (t.status !== 'ok' || !h) {
      failed.push({ ...ref, message: notDone('restored', params, key) });
      continue;
    }
    const res = input.resolutions?.[key] ?? {};
    const missing = (params.collisions?.[key] ?? []).filter((f) => !res[f]);
    if (missing.length) {
      failed.push({ ...ref, message: `Choose how to resolve: ${missing.join(', ')}.` });
      continue;
    }
    const fromTrash = params.states?.[key] === 'trash';
    const err = await perItem(ctx, async () => {
      if (fromTrash) await h.untrash!(ctx, t.id, { resolutions: res });
      else await h.restore!(ctx, t.id, { resolutions: res });
    });
    if (err) failed.push({ ...ref, message: err });
    else done.push(ref);
  }
  return { done, failed };
};

// ——— Permanent deletion (Owner, asynchronous) ———

export const purgePreview = async (ctx: QueryContext, targets: Target[]) => {
  requirePermission(ctx, 'trash.purge');
  const items: EntityPreviewItem[] = [];
  for (const t of targets) {
    const h = getArchiveHandler(t.entityType);
    if (purgeForbidden(t.entityType)) {
      items.push({ entityType: t.entityType, entityId: t.entityId, title: 'Record', status: 'forbidden', message: 'Finance and audit records are never deleted from the trash.', items: [], collisions: [] });
      continue;
    }
    if (!h?.purge || !h.untrashPreview) {
      items.push({ entityType: t.entityType, entityId: t.entityId, title: 'Record', status: 'not_supported', message: 'This record type cannot be permanently deleted.', items: [], collisions: [] });
      continue;
    }
    try {
      const p = await h.untrashPreview(ctx, t.entityId);
      items.push({ entityType: t.entityType, entityId: t.entityId, title: p.title, status: 'ok', message: 'Will be permanently deleted with its files and search entries.', items: [], collisions: [] });
    } catch (e) {
      items.push(outcome(t, e));
    }
  }
  const token = await saveToken(ctx, 'entities.purge', items);
  return { ...token, items, eligibleCount: items.filter((i) => i.status === 'ok').length };
};

export const purgeConfirmationText = (count: number) => `DELETE ${count}`;

/** Queue permanent deletion: typed confirmation, recent authentication, eligible trash only. */
export const requestPurge = async (ctx: CommandContext, input: { previewToken: string; confirmation: string }) => {
  requirePermission(ctx, 'trash.purge');
  requireRecentAuth(ctx);
  const p = await consumeToken(ctx, input.previewToken, 'entities.purge');
  const eligible = p.targets.filter((t) => t.status === 'ok' && !purgeForbidden(t.type));
  if (eligible.length === 0) throw new AppError('INVALID_STATE', 'Nothing in the selection can be permanently deleted.');
  if (input.confirmation.trim() !== purgeConfirmationText(eligible.length))
    throw new AppError('VALIDATION_FAILED', `Type “${purgeConfirmationText(eligible.length)}” to confirm.`, { fieldErrors: [{ field: 'confirmation', code: 'MISMATCH', message: `Type “${purgeConfirmationText(eligible.length)}” to confirm.` }] });
  const jobId = await enqueueJob(ctx.tx, {
    type: 'archive.purge',
    pool: 'data',
    workspaceId: ctx.actor.workspaceId,
    payload: { previewId: p.id, actorMembershipId: ctx.actor.membershipId, targets: eligible.map((t) => ({ entityType: t.type, entityId: t.id })) },
    requestedBy: ctx.actor.membershipId,
    idempotencyKey: `archive.purge:${p.id}`,
    maxRetries: 3,
  });
  await audit(ctx, { action: 'entities.purge_requested', entityType: 'bulk_preview', entityId: p.id, metadata: { count: eligible.length, types: [...new Set(eligible.map((t) => t.type))] }, sensitivity: 'security' });
  return { jobId, count: eligible.length };
};

const purgeOne = async (ctx: QueryContext, h: ArchiveHandler, entityId: string, reason: string) =>
  executeCommand(ctx, async (c) => {
    await h.purge!(c, entityId);
    await removeSearchDocument(c.tx, c.actor.workspaceId, h.entityType, entityId);
    await audit(c, { action: 'entity.purged', entityType: h.entityType, entityId, reason, sensitivity: 'security' });
  });

/** Each record is purged in its own transaction as the requesting Owner (re-authorised now). */
defineJob('archive.purge', 'data', async ({ app, job, heartbeat }) => {
  const { actorMembershipId, targets } = job.payload as { actorMembershipId: string; targets: Target[] };
  const ctx = job.workspaceId ? await memberJobContext(app, job.workspaceId, actorMembershipId) : null;
  if (!ctx || !hasAnywhere(ctx.actor.access, 'trash.purge')) return { skipped: 'requester no longer allowed to purge' };
  const results: { entityType: string; entityId: string; ok: boolean; message?: string }[] = [];
  let n = 0;
  for (const t of targets) {
    const h = getArchiveHandler(t.entityType);
    if (!h?.purge || purgeForbidden(t.entityType)) {
      results.push({ ...t, ok: false, message: 'not permitted' });
      continue;
    }
    try {
      await purgeOne(ctx, h, t.entityId, 'Permanently deleted from the trash');
      results.push({ entityType: t.entityType, entityId: t.entityId, ok: true });
    } catch (e) {
      results.push({ entityType: t.entityType, entityId: t.entityId, ok: false, message: isAppError(e) ? e.message : 'error' });
    }
    await heartbeat(Math.round((++n / targets.length) * 95));
  }
  return { purged: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results };
});

/** Retention: trashed records whose grace period ended are purged (never finance/audit). */
export const purgeExpiredTrash = async (app: QueryContext['app']) => {
  const ws = await app.db.select({ id: workspaces.id }).from(workspaces);
  let purged = 0;
  for (const w of ws) {
    const ctx = await systemJobContext(app, w.id, [...ALL_PERMISSIONS]);
    for (const h of allArchiveHandlers()) {
      if (!h.list || !h.purge || purgeForbidden(h.entityType)) continue;
      const due = await h.list(ctx, { state: 'trash', purgeDueBefore: app.clock.now(), limit: 200 });
      for (const item of due) {
        try {
          await purgeOne(ctx, h, item.id, 'Trash grace period ended');
          purged++;
        } catch (e) {
          app.logger.warn('trash_purge_skipped', { workspaceId: w.id, entityType: h.entityType, error: isAppError(e) ? e.code : 'error' });
        }
      }
    }
  }
  return purged;
};
