import { and, asc, count, desc, eq, gt, inArray, isNull, lt, max, sql } from 'drizzle-orm';
import { characters, characterVersions, contentItems, episodes, sceneCharacters, scenes, seasons, type SceneDeliverable } from '@castlane/database';
import { AppError, newId, notFound } from '@castlane/domain';
import { allowed, requirePermission } from '../core/access';
import { audit, diffFields } from '../core/audit';
import { all, dbOf, type CommandContext, type QueryContext } from '../core/context';
import { emit } from '../core/events';
import { assertVersion, lockById, stamp, touch } from '../core/rows';
import { linkAsset } from '../media/assets';
import { assertAssetUsable, thumbUrl } from '../accounts/helpers';
import { assertProjectOpen, loadProjectRow, projectFor, projectScopeOf, type ProjectRow } from './common';

/**
 * Series structure (S17): seasons → episodes → scenes. Episode numbers are unique per season and
 * language (DB constraint, T026); reordering changes only order numbers, never ids (T027).
 */

type SeasonRow = typeof seasons.$inferSelect;
type ContentFormat = (typeof contentItems.$inferSelect)['format'];
type EpisodeRow = typeof episodes.$inferSelect;
type SceneRow = typeof scenes.$inferSelect;

const writeProject = async (ctx: CommandContext, projectId: string) => {
  const p = await projectFor(ctx, projectId, 'series.read', 'series.write');
  if (p.type !== 'series') throw new AppError('INVALID_STATE', 'Seasons, episodes and scenes exist only in Series projects.');
  assertProjectOpen(p, 'series records');
  return p;
};

const loadSeason = async (ctx: QueryContext | CommandContext, id: string, lock = false): Promise<SeasonRow> => {
  if (lock && 'tx' in ctx) return lockById(ctx, seasons, id, 'Season');
  const [s] = await dbOf(ctx).select().from(seasons).where(and(eq(seasons.workspaceId, ctx.actor.workspaceId), eq(seasons.id, id)));
  if (!s) throw notFound('Season');
  return s;
};
const loadEpisode = async (ctx: QueryContext | CommandContext, id: string, lock = false): Promise<EpisodeRow> => {
  if (lock && 'tx' in ctx) return lockById(ctx, episodes, id, 'Episode');
  const [e] = await dbOf(ctx).select().from(episodes).where(and(eq(episodes.workspaceId, ctx.actor.workspaceId), eq(episodes.id, id)));
  if (!e) throw notFound('Episode');
  return e;
};
const loadScene = async (ctx: QueryContext | CommandContext, id: string, lock = false): Promise<SceneRow> => {
  if (lock && 'tx' in ctx) return lockById(ctx, scenes, id, 'Scene');
  const [s] = await dbOf(ctx).select().from(scenes).where(and(eq(scenes.workspaceId, ctx.actor.workspaceId), eq(scenes.id, id)));
  if (!s) throw notFound('Scene');
  return s;
};

// ——— Read models ———

const episodeViews = async (ctx: QueryContext | CommandContext, rows: EpisodeRow[], project: ProjectRow) => {
  if (!rows.length) return [];
  const db = dbOf(ctx);
  const ids = rows.map((r) => r.id);
  const contentIds = rows.map((r) => r.contentItemId).filter((x): x is string => !!x);
  const showContent = allowed(ctx, 'content.read', projectScopeOf(project));
  const [sceneCounts, content] = await all(ctx, [
    () => db.select({ episodeId: scenes.episodeId, n: count() }).from(scenes).where(and(eq(scenes.workspaceId, ctx.actor.workspaceId), inArray(scenes.episodeId, ids), isNull(scenes.archivedAt))).groupBy(scenes.episodeId),
    () =>
      contentIds.length && showContent
        ? db.select({ id: contentItems.id, title: contentItems.title, stage: contentItems.stage }).from(contentItems).where(and(eq(contentItems.workspaceId, ctx.actor.workspaceId), inArray(contentItems.id, contentIds)))
        : Promise.resolve([]),
  ] as const);
  return rows.map((e) => ({
    id: e.id,
    seasonId: e.seasonId,
    projectId: e.projectId,
    number: e.number,
    title: e.title,
    synopsis: e.synopsis,
    targetDurationSeconds: e.targetDurationSeconds,
    language: e.language,
    contentItem: content.find((c) => c.id === e.contentItemId) ?? null,
    thumbnailUrl: thumbUrl(e.workspaceId, e.thumbnailAssetId, 128),
    thumbnailAssetId: e.thumbnailAssetId,
    sceneCount: Number(sceneCounts.find((s) => s.episodeId === e.id)?.n ?? 0),
    archivedAt: e.archivedAt?.toISOString() ?? null,
    rowVersion: e.rowVersion,
  }));
};

const sceneViews = async (ctx: QueryContext | CommandContext, rows: SceneRow[]) => {
  if (!rows.length) return [];
  const links = await dbOf(ctx)
    .select({ sceneId: sceneCharacters.sceneId, versionId: characterVersions.id, characterId: characters.id, name: characters.name, versionNo: characterVersions.versionNo, state: characterVersions.state })
    .from(sceneCharacters)
    .innerJoin(characterVersions, eq(characterVersions.id, sceneCharacters.characterVersionId))
    .innerJoin(characters, eq(characters.id, characterVersions.characterId))
    .where(and(eq(sceneCharacters.workspaceId, ctx.actor.workspaceId), inArray(sceneCharacters.sceneId, rows.map((r) => r.id))))
    .orderBy(asc(characters.name));
  return rows.map((s) => ({
    id: s.id,
    episodeId: s.episodeId,
    orderNo: s.orderNo,
    title: s.title,
    script: s.script,
    deliverables: s.deliverables.map((d) => ({ label: d.label, ...(d.format ? { format: d.format as ContentFormat } : {}), ...(d.done !== undefined ? { done: d.done } : {}) })),
    characters: links.filter((l) => l.sceneId === s.id).map((l) => ({ characterVersionId: l.versionId, characterId: l.characterId, name: l.name, versionNo: l.versionNo, state: l.state })),
    thumbnailUrl: thumbUrl(s.workspaceId, s.thumbnailAssetId, 64),
    thumbnailAssetId: s.thumbnailAssetId,
    archivedAt: s.archivedAt?.toISOString() ?? null,
    rowVersion: s.rowVersion,
  }));
};

const seasonViews = async (ctx: QueryContext | CommandContext, rows: SeasonRow[], project: ProjectRow, includeArchived: boolean) => {
  if (!rows.length) return [];
  const eps = await dbOf(ctx)
    .select()
    .from(episodes)
    .where(and(eq(episodes.workspaceId, ctx.actor.workspaceId), inArray(episodes.seasonId, rows.map((r) => r.id)), includeArchived ? undefined : isNull(episodes.archivedAt)))
    .orderBy(asc(episodes.number), asc(episodes.language));
  const views = await episodeViews(ctx, eps, project);
  return rows.map((s) => ({
    id: s.id,
    projectId: s.projectId,
    name: s.name,
    orderNo: s.orderNo,
    archivedAt: s.archivedAt?.toISOString() ?? null,
    rowVersion: s.rowVersion,
    episodes: views.filter((e) => e.seasonId === s.id),
  }));
};

const projectSeasons = (ctx: QueryContext | CommandContext, projectId: string, includeArchived: boolean) =>
  dbOf(ctx)
    .select()
    .from(seasons)
    .where(and(eq(seasons.workspaceId, ctx.actor.workspaceId), eq(seasons.projectId, projectId), includeArchived ? undefined : isNull(seasons.archivedAt)))
    .orderBy(sql`${seasons.archivedAt} IS NOT NULL`, asc(seasons.orderNo), asc(seasons.createdAt));

export const seriesStructure = async (ctx: QueryContext, projectId: string, input: { includeArchived?: boolean } = {}) => {
  requirePermission(ctx, 'series.read');
  const p = await projectFor(ctx, projectId, 'series.read');
  const rows = p.type === 'series' ? await projectSeasons(ctx, projectId, !!input.includeArchived) : [];
  return {
    project: { id: p.id, name: p.name, type: p.type, status: p.status },
    seasons: await seasonViews(ctx, rows, p, !!input.includeArchived),
    permissions: { write: p.type === 'series' && p.status !== 'archived' && allowed(ctx, 'series.write', projectScopeOf(p)) },
  };
};

export const listSeasons = async (ctx: QueryContext | CommandContext, projectId: string, input: { includeArchived?: boolean } = {}) => {
  requirePermission(ctx, 'series.read');
  const p = await projectFor(ctx, projectId, 'series.read');
  return seasonViews(ctx, await projectSeasons(ctx, projectId, !!input.includeArchived), p, !!input.includeArchived);
};

export const getSeason = async (ctx: QueryContext | CommandContext, id: string) => {
  const s = await loadSeason(ctx, id);
  const p = await projectFor(ctx, s.projectId, 'series.read');
  return (await seasonViews(ctx, [s], p, !!s.archivedAt))[0]!;
};

export const getEpisode = async (ctx: QueryContext | CommandContext, id: string, input: { includeArchived?: boolean } = {}) => {
  const e = await loadEpisode(ctx, id);
  const p = await projectFor(ctx, e.projectId, 'series.read');
  const sceneRows = await dbOf(ctx)
    .select()
    .from(scenes)
    .where(and(eq(scenes.workspaceId, ctx.actor.workspaceId), eq(scenes.episodeId, id), input.includeArchived ? undefined : isNull(scenes.archivedAt)))
    .orderBy(sql`${scenes.archivedAt} IS NOT NULL`, asc(scenes.orderNo));
  const [view] = await episodeViews(ctx, [e], p);
  return {
    ...view!,
    scenes: await sceneViews(ctx, sceneRows),
    permissions: { write: p.type === 'series' && p.status !== 'archived' && allowed(ctx, 'series.write', projectScopeOf(p)) },
  };
};

export const listEpisodes = async (ctx: QueryContext, seasonId: string, input: { includeArchived?: boolean } = {}) => {
  const s = await loadSeason(ctx, seasonId);
  const p = await projectFor(ctx, s.projectId, 'series.read');
  const rows = await ctx.app.db
    .select()
    .from(episodes)
    .where(and(eq(episodes.workspaceId, ctx.actor.workspaceId), eq(episodes.seasonId, seasonId), input.includeArchived ? undefined : isNull(episodes.archivedAt)))
    .orderBy(asc(episodes.number), asc(episodes.language));
  return episodeViews(ctx, rows, p);
};

export const listScenes = async (ctx: QueryContext, episodeId: string, input: { includeArchived?: boolean } = {}) => (await getEpisode(ctx, episodeId, input)).scenes;

export const getScene = async (ctx: QueryContext, id: string) => {
  const s = await loadScene(ctx, id);
  await projectFor(ctx, s.projectId, 'series.read');
  return (await sceneViews(ctx, [s]))[0]!;
};

// ——— Seasons ———

export const createSeason = async (ctx: CommandContext, projectId: string, input: { name: string; orderNo?: number }) => {
  requirePermission(ctx, 'series.write');
  const p = await writeProject(ctx, projectId);
  const [{ m } = { m: 0 }] = await ctx.tx
    .select({ m: max(seasons.orderNo) })
    .from(seasons)
    .where(and(eq(seasons.workspaceId, ctx.actor.workspaceId), eq(seasons.projectId, projectId), isNull(seasons.archivedAt)));
  const orderNo = input.orderNo ?? Number(m ?? 0) + 1;
  const [taken] = await ctx.tx
    .select({ id: seasons.id })
    .from(seasons)
    .where(and(eq(seasons.projectId, projectId), eq(seasons.orderNo, orderNo), isNull(seasons.archivedAt)));
  if (taken) throw new AppError('DUPLICATE', `Season position ${orderNo} is already used.`, { fieldErrors: [{ field: 'orderNo', code: 'DUPLICATE', message: `Season position ${orderNo} is already used.` }] });
  const id = newId();
  await ctx.tx.insert(seasons).values({ ...stamp(ctx), id, projectId, name: input.name.trim(), orderNo });
  await audit(ctx, { action: 'season.created', entityType: 'season', entityId: id, projectId, metadata: { name: input.name, orderNo } });
  await emit(ctx, { type: 'season.created', entityType: 'season', entityId: id, revision: 1 });
  void p;
  return id;
};

export const updateSeason = async (ctx: CommandContext, id: string, input: { name: string }) => {
  const s = await loadSeason(ctx, id, true);
  await writeProject(ctx, s.projectId);
  assertVersion(ctx, s);
  if (s.archivedAt) throw new AppError('INVALID_STATE', 'Restore the season before editing it.');
  const [row] = await ctx.tx.update(seasons).set({ name: input.name.trim(), ...touch(ctx, seasons) }).where(eq(seasons.id, id)).returning();
  await audit(ctx, { action: 'season.updated', entityType: 'season', entityId: id, projectId: s.projectId, diff: diffFields(s, row!, ['name']) });
  await emit(ctx, { type: 'season.updated', entityType: 'season', entityId: id, revision: row!.rowVersion });
  return id;
};

/** Swap two order numbers in two phases so the unique (parent, order) index never sees a duplicate. */
const swapOrder = async <T extends typeof seasons | typeof scenes>(ctx: CommandContext, table: T, a: { id: string; orderNo: number }, b: { id: string; orderNo: number }) => {
  const t = table as typeof seasons;
  await ctx.tx.update(t).set({ orderNo: -a.orderNo - 1_000_000 }).where(eq(t.id, a.id));
  await ctx.tx.update(t).set({ orderNo: a.orderNo, ...touch(ctx, t) }).where(eq(t.id, b.id));
  await ctx.tx.update(t).set({ orderNo: b.orderNo, ...touch(ctx, t) }).where(eq(t.id, a.id));
};

export const moveSeason = async (ctx: CommandContext, id: string, input: { direction: 'up' | 'down' }) => {
  const s = await loadSeason(ctx, id, true);
  await writeProject(ctx, s.projectId);
  assertVersion(ctx, s);
  if (s.archivedAt) throw new AppError('INVALID_STATE', 'Archived seasons have no position.');
  const [neighbour] = await ctx.tx
    .select()
    .from(seasons)
    .where(
      and(
        eq(seasons.workspaceId, ctx.actor.workspaceId),
        eq(seasons.projectId, s.projectId),
        isNull(seasons.archivedAt),
        input.direction === 'up' ? lt(seasons.orderNo, s.orderNo) : gt(seasons.orderNo, s.orderNo),
      ),
    )
    .orderBy(input.direction === 'up' ? desc(seasons.orderNo) : asc(seasons.orderNo))
    .limit(1)
    .for('update');
  if (!neighbour) throw new AppError('INVALID_STATE', input.direction === 'up' ? 'This season is already first.' : 'This season is already last.');
  await swapOrder(ctx, seasons, s, neighbour);
  await audit(ctx, { action: 'season.moved', entityType: 'season', entityId: id, projectId: s.projectId, diff: { orderNo: { from: s.orderNo, to: neighbour.orderNo } } });
  await emit(ctx, { type: 'season.updated', entityType: 'season', entityId: id });
  return s.projectId;
};

export const archiveSeason = async (ctx: CommandContext, id: string, input: { reason?: string }) => {
  const s = await loadSeason(ctx, id, true);
  await projectFor(ctx, s.projectId, 'series.read', 'series.write');
  assertVersion(ctx, s);
  if (s.archivedAt) throw new AppError('INVALID_STATE', 'This season is already archived.');
  const at = ctx.app.clock.now();
  const archivedFields = { archivedAt: at, archivedBy: ctx.actor.userId, archiveReason: input.reason ?? null };
  const eps = await ctx.tx.update(episodes).set({ ...archivedFields, ...touch(ctx, episodes) }).where(and(eq(episodes.seasonId, id), isNull(episodes.archivedAt))).returning({ id: episodes.id });
  if (eps.length)
    await ctx.tx.update(scenes).set({ ...archivedFields, ...touch(ctx, scenes) }).where(and(inArray(scenes.episodeId, eps.map((e) => e.id)), isNull(scenes.archivedAt)));
  await ctx.tx.update(seasons).set({ ...archivedFields, ...touch(ctx, seasons) }).where(eq(seasons.id, id));
  await audit(ctx, { action: 'season.archived', entityType: 'season', entityId: id, projectId: s.projectId, reason: input.reason ?? null, metadata: { episodes: eps.length } });
  await emit(ctx, { type: 'season.archived', entityType: 'season', entityId: id });
  return { ok: true as const };
};

export const restoreSeason = async (ctx: CommandContext, id: string) => {
  const s = await loadSeason(ctx, id, true);
  await writeProject(ctx, s.projectId);
  assertVersion(ctx, s);
  if (!s.archivedAt) throw new AppError('INVALID_STATE', 'This season is not archived.');
  const [{ m } = { m: 0 }] = await ctx.tx.select({ m: max(seasons.orderNo) }).from(seasons).where(and(eq(seasons.projectId, s.projectId), isNull(seasons.archivedAt)));
  await ctx.tx.update(seasons).set({ archivedAt: null, archivedBy: null, archiveReason: null, orderNo: Number(m ?? 0) + 1, ...touch(ctx, seasons) }).where(eq(seasons.id, id));
  await audit(ctx, { action: 'season.restored', entityType: 'season', entityId: id, projectId: s.projectId });
  await emit(ctx, { type: 'season.restored', entityType: 'season', entityId: id });
  return id;
};

// ——— Episodes ———

export interface EpisodeInput {
  number?: number;
  title?: string;
  synopsis?: string | null;
  targetDurationSeconds?: number | null;
  language?: string;
  contentItemId?: string | null;
  thumbnailAssetId?: string | null;
}

const assertContentInProject = async (ctx: CommandContext, contentItemId: string, projectId: string) => {
  const [c] = await ctx.tx.select({ id: contentItems.id, projectId: contentItems.projectId, deletedAt: contentItems.deletedAt }).from(contentItems).where(and(eq(contentItems.workspaceId, ctx.actor.workspaceId), eq(contentItems.id, contentItemId)));
  if (!c || c.deletedAt || c.projectId !== projectId)
    throw new AppError('VALIDATION_FAILED', 'Choose a content item of this project.', { fieldErrors: [{ field: 'contentItemId', code: 'INVALID', message: 'Choose a content item of this project.' }] });
};

const duplicateEpisode = (number: number, language: string) =>
  new AppError('DUPLICATE', `Episode ${number} (${language}) already exists in this season.`, {
    fieldErrors: [{ field: 'number', code: 'DUPLICATE', message: `Episode ${number} already exists in this season for language ${language}.` }],
  });

const episodeTaken = async (ctx: CommandContext, seasonId: string, number: number, language: string, excludeId?: string) => {
  const rows = await ctx.tx
    .select({ id: episodes.id })
    .from(episodes)
    .where(and(eq(episodes.seasonId, seasonId), eq(episodes.number, number), eq(episodes.language, language), isNull(episodes.archivedAt)));
  return rows.some((r) => r.id !== excludeId);
};

export const createEpisode = async (ctx: CommandContext, seasonId: string, input: EpisodeInput & { number: number; title: string }) => {
  requirePermission(ctx, 'series.write');
  const s = await loadSeason(ctx, seasonId, true);
  const p = await writeProject(ctx, s.projectId);
  if (s.archivedAt) throw new AppError('INVALID_STATE', 'Restore the season before adding episodes.');
  const language = (input.language ?? p.language ?? 'en').trim().toLowerCase();
  if (await episodeTaken(ctx, seasonId, input.number, language)) throw duplicateEpisode(input.number, language);
  if (input.contentItemId) await assertContentInProject(ctx, input.contentItemId, p.id);
  if (input.thumbnailAssetId) await assertAssetUsable(ctx, input.thumbnailAssetId, 'thumbnailAssetId', { imageOnly: true });
  const id = newId();
  await ctx.tx.insert(episodes).values({
    ...stamp(ctx),
    id,
    projectId: p.id,
    seasonId,
    number: input.number,
    title: input.title.trim(),
    synopsis: input.synopsis ?? null,
    targetDurationSeconds: input.targetDurationSeconds ?? null,
    language,
    contentItemId: input.contentItemId ?? null,
    thumbnailAssetId: input.thumbnailAssetId ?? null,
  });
  if (input.thumbnailAssetId) await linkAsset(ctx, input.thumbnailAssetId, { target: { entityType: 'episode', entityId: id, role: 'thumbnail' } });
  await audit(ctx, { action: 'episode.created', entityType: 'episode', entityId: id, projectId: p.id, metadata: { seasonId, number: input.number, language } });
  await emit(ctx, { type: 'episode.created', entityType: 'episode', entityId: id, revision: 1 });
  return id;
};

export const updateEpisode = async (ctx: CommandContext, id: string, input: EpisodeInput) => {
  const e = await loadEpisode(ctx, id, true);
  const p = await writeProject(ctx, e.projectId);
  assertVersion(ctx, e);
  if (e.archivedAt) throw new AppError('INVALID_STATE', 'Restore the episode before editing it.');
  const number = input.number ?? e.number;
  const language = (input.language ?? e.language).trim().toLowerCase();
  if ((number !== e.number || language !== e.language) && (await episodeTaken(ctx, e.seasonId, number, language, id))) throw duplicateEpisode(number, language);
  if (input.contentItemId) await assertContentInProject(ctx, input.contentItemId, p.id);
  if (input.thumbnailAssetId) await assertAssetUsable(ctx, input.thumbnailAssetId, 'thumbnailAssetId', { imageOnly: true });
  const patch: Partial<EpisodeRow> = { number, language };
  if (input.title !== undefined) patch.title = input.title.trim();
  if (input.synopsis !== undefined) patch.synopsis = input.synopsis;
  if (input.targetDurationSeconds !== undefined) patch.targetDurationSeconds = input.targetDurationSeconds;
  if (input.contentItemId !== undefined) patch.contentItemId = input.contentItemId;
  if (input.thumbnailAssetId !== undefined) patch.thumbnailAssetId = input.thumbnailAssetId;
  const [row] = await ctx.tx.update(episodes).set({ ...patch, ...touch(ctx, episodes) }).where(eq(episodes.id, id)).returning();
  if (input.thumbnailAssetId && input.thumbnailAssetId !== e.thumbnailAssetId) await linkAsset(ctx, input.thumbnailAssetId, { target: { entityType: 'episode', entityId: id, role: 'thumbnail' } });
  await audit(ctx, {
    action: 'episode.updated',
    entityType: 'episode',
    entityId: id,
    projectId: e.projectId,
    diff: diffFields(e, row!, ['number', 'title', 'synopsis', 'targetDurationSeconds', 'language', 'contentItemId', 'thumbnailAssetId']),
  });
  await emit(ctx, { type: 'episode.updated', entityType: 'episode', entityId: id, revision: row!.rowVersion });
  return id;
};

export const archiveEpisode = async (ctx: CommandContext, id: string, input: { reason?: string }) => {
  const e = await loadEpisode(ctx, id, true);
  await projectFor(ctx, e.projectId, 'series.read', 'series.write');
  assertVersion(ctx, e);
  if (e.archivedAt) throw new AppError('INVALID_STATE', 'This episode is already archived.');
  const at = ctx.app.clock.now();
  const [row] = await ctx.tx.update(episodes).set({ archivedAt: at, archivedBy: ctx.actor.userId, archiveReason: input.reason ?? null, ...touch(ctx, episodes) }).where(eq(episodes.id, id)).returning();
  await audit(ctx, { action: 'episode.archived', entityType: 'episode', entityId: id, projectId: e.projectId, reason: input.reason ?? null });
  await emit(ctx, { type: 'episode.archived', entityType: 'episode', entityId: id, revision: row!.rowVersion });
  return id;
};

export const restoreEpisode = async (ctx: CommandContext, id: string) => {
  const e = await loadEpisode(ctx, id, true);
  await writeProject(ctx, e.projectId);
  assertVersion(ctx, e);
  if (!e.archivedAt) throw new AppError('INVALID_STATE', 'This episode is not archived.');
  const s = await loadSeason(ctx, e.seasonId);
  if (s.archivedAt) throw new AppError('INVALID_STATE', 'Restore the season first.');
  if (await episodeTaken(ctx, e.seasonId, e.number, e.language, id)) throw duplicateEpisode(e.number, e.language);
  const [row] = await ctx.tx.update(episodes).set({ archivedAt: null, archivedBy: null, archiveReason: null, ...touch(ctx, episodes) }).where(eq(episodes.id, id)).returning();
  await audit(ctx, { action: 'episode.restored', entityType: 'episode', entityId: id, projectId: e.projectId });
  await emit(ctx, { type: 'episode.restored', entityType: 'episode', entityId: id, revision: row!.rowVersion });
  return id;
};

// ——— Scenes ———

export interface SceneInput {
  title?: string;
  script?: string | null;
  deliverables?: SceneDeliverable[];
  characterVersionIds?: string[];
  thumbnailAssetId?: string | null;
}

/** Scene character links point at frozen character versions of the same project. */
const resolveCharacterVersions = async (ctx: CommandContext, ids: string[], projectId: string) => {
  const unique = [...new Set(ids)];
  if (!unique.length) return [];
  const rows = await ctx.tx
    .select({ id: characterVersions.id, projectId: characters.projectId })
    .from(characterVersions)
    .innerJoin(characters, eq(characters.id, characterVersions.characterId))
    .where(and(eq(characterVersions.workspaceId, ctx.actor.workspaceId), inArray(characterVersions.id, unique)));
  if (rows.length !== unique.length || rows.some((r) => r.projectId !== projectId))
    throw new AppError('VALIDATION_FAILED', 'Choose character versions of this project.', { fieldErrors: [{ field: 'characterVersionIds', code: 'INVALID', message: 'Choose character versions of this project.' }] });
  return unique;
};

const replaceSceneCharacters = async (ctx: CommandContext, sceneId: string, versionIds: string[]) => {
  const existing = await ctx.tx.select().from(sceneCharacters).where(eq(sceneCharacters.sceneId, sceneId));
  const remove = existing.filter((e) => !versionIds.includes(e.characterVersionId)).map((e) => e.id);
  if (remove.length) await ctx.tx.delete(sceneCharacters).where(inArray(sceneCharacters.id, remove));
  for (const v of versionIds.filter((id) => !existing.some((e) => e.characterVersionId === id)))
    await ctx.tx.insert(sceneCharacters).values({ ...stamp(ctx), id: newId(), sceneId, characterVersionId: v });
  return { added: versionIds.filter((id) => !existing.some((e) => e.characterVersionId === id)).length, removed: remove.length };
};

export const createScene = async (ctx: CommandContext, episodeId: string, input: SceneInput & { title: string }) => {
  requirePermission(ctx, 'series.write');
  const e = await loadEpisode(ctx, episodeId, true);
  const p = await writeProject(ctx, e.projectId);
  if (e.archivedAt) throw new AppError('INVALID_STATE', 'Restore the episode before adding scenes.');
  const versionIds = await resolveCharacterVersions(ctx, input.characterVersionIds ?? [], p.id);
  if (input.thumbnailAssetId) await assertAssetUsable(ctx, input.thumbnailAssetId, 'thumbnailAssetId', { imageOnly: true });
  const [{ m } = { m: 0 }] = await ctx.tx.select({ m: max(scenes.orderNo) }).from(scenes).where(and(eq(scenes.episodeId, episodeId), isNull(scenes.archivedAt)));
  const id = newId();
  const [row] = await ctx.tx
    .insert(scenes)
    .values({
      ...stamp(ctx),
      id,
      projectId: p.id,
      episodeId,
      orderNo: Number(m ?? 0) + 1,
      title: input.title.trim(),
      script: input.script ?? null,
      deliverables: input.deliverables ?? [],
      thumbnailAssetId: input.thumbnailAssetId ?? null,
    })
    .returning();
  await replaceSceneCharacters(ctx, id, versionIds);
  if (input.thumbnailAssetId) await linkAsset(ctx, input.thumbnailAssetId, { target: { entityType: 'scene', entityId: id, role: 'thumbnail' } });
  await audit(ctx, { action: 'scene.created', entityType: 'scene', entityId: id, projectId: p.id, metadata: { episodeId, orderNo: row!.orderNo } });
  await emit(ctx, { type: 'scene.created', entityType: 'scene', entityId: id, revision: 1 });
  return row!;
};

export const updateScene = async (ctx: CommandContext, id: string, input: SceneInput) => {
  const s = await loadScene(ctx, id, true);
  const p = await writeProject(ctx, s.projectId);
  assertVersion(ctx, s);
  if (s.archivedAt) throw new AppError('INVALID_STATE', 'Archived scenes are read-only.');
  const versionIds = input.characterVersionIds ? await resolveCharacterVersions(ctx, input.characterVersionIds, p.id) : null;
  if (input.thumbnailAssetId) await assertAssetUsable(ctx, input.thumbnailAssetId, 'thumbnailAssetId', { imageOnly: true });
  const patch: Partial<SceneRow> = {};
  if (input.title !== undefined) patch.title = input.title.trim();
  if (input.script !== undefined) patch.script = input.script;
  if (input.deliverables !== undefined) patch.deliverables = input.deliverables;
  if (input.thumbnailAssetId !== undefined) patch.thumbnailAssetId = input.thumbnailAssetId;
  const [row] = await ctx.tx.update(scenes).set({ ...patch, ...touch(ctx, scenes) }).where(eq(scenes.id, id)).returning();
  const links = versionIds ? await replaceSceneCharacters(ctx, id, versionIds) : null;
  if (input.thumbnailAssetId && input.thumbnailAssetId !== s.thumbnailAssetId) await linkAsset(ctx, input.thumbnailAssetId, { target: { entityType: 'scene', entityId: id, role: 'thumbnail' } });
  await audit(ctx, { action: 'scene.updated', entityType: 'scene', entityId: id, projectId: s.projectId, diff: diffFields(s, row!, ['title', 'deliverables', 'thumbnailAssetId']), metadata: links ?? undefined });
  await emit(ctx, { type: 'scene.updated', entityType: 'scene', entityId: id, revision: row!.rowVersion });
  return row!;
};

export const moveScene = async (ctx: CommandContext, id: string, input: { direction: 'up' | 'down' }) => {
  const s = await loadScene(ctx, id, true);
  await writeProject(ctx, s.projectId);
  assertVersion(ctx, s);
  if (s.archivedAt) throw new AppError('INVALID_STATE', 'Archived scenes have no position.');
  const [neighbour] = await ctx.tx
    .select()
    .from(scenes)
    .where(and(eq(scenes.episodeId, s.episodeId), isNull(scenes.archivedAt), input.direction === 'up' ? lt(scenes.orderNo, s.orderNo) : gt(scenes.orderNo, s.orderNo)))
    .orderBy(input.direction === 'up' ? desc(scenes.orderNo) : asc(scenes.orderNo))
    .limit(1)
    .for('update');
  if (!neighbour) throw new AppError('INVALID_STATE', input.direction === 'up' ? 'This scene is already first.' : 'This scene is already last.');
  await swapOrder(ctx, scenes, s, neighbour);
  await audit(ctx, { action: 'scene.moved', entityType: 'scene', entityId: id, projectId: s.projectId, diff: { orderNo: { from: s.orderNo, to: neighbour.orderNo } } });
  await emit(ctx, { type: 'scene.updated', entityType: 'scene', entityId: id });
  await emit(ctx, { type: 'scene.updated', entityType: 'scene', entityId: neighbour.id });
  return s.episodeId;
};

export const archiveScene = async (ctx: CommandContext, id: string, input: { reason?: string }) => {
  const s = await loadScene(ctx, id, true);
  await projectFor(ctx, s.projectId, 'series.read', 'series.write');
  assertVersion(ctx, s);
  if (s.archivedAt) throw new AppError('INVALID_STATE', 'This scene is already archived.');
  await ctx.tx.update(scenes).set({ archivedAt: ctx.app.clock.now(), archivedBy: ctx.actor.userId, archiveReason: input.reason ?? null, ...touch(ctx, scenes) }).where(eq(scenes.id, id));
  await audit(ctx, { action: 'scene.archived', entityType: 'scene', entityId: id, projectId: s.projectId, reason: input.reason ?? null });
  await emit(ctx, { type: 'scene.archived', entityType: 'scene', entityId: id });
  return { ok: true as const };
};

export const sceneView = async (ctx: QueryContext | CommandContext, row: SceneRow) => (await sceneViews(ctx, [row]))[0]!;

export { loadEpisode, loadScene, loadSeason, loadProjectRow };
