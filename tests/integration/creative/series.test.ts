import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { characterEndpoints as C, seriesEndpoints as S } from '@castlane/api-contracts';
import { episodes, tasks } from '@castlane/database';
import { newId } from '@castlane/domain';
import { addMember, assignToProject, clientFor, createProject, sessionFor } from '../../support';
import { baseSetup, db } from '../accounts/support';

const seriesSetup = async () => {
  const base = await baseSetup();
  const series = await createProject(db(), base.ws, { name: 'Night Shift', type: 'series' });
  return { ...base, series };
};

describe('series structure', () => {
  it('episode numbers are unique per season and language without losing the original (T026)', async () => {
    const { owner, series, W } = await seriesSetup();
    const season = await owner.call(S.createSeason, { params: { ...W, projectId: series.id }, body: { name: 'Season 1' } });
    expect(season.orderNo).toBe(1);
    const ep1 = await owner.call(S.createEpisode, { params: { ...W, seasonId: season.id }, body: { number: 1, title: 'Pilot', language: 'en' } });
    const dup = await owner.attempt(S.createEpisode, { params: { ...W, seasonId: season.id }, body: { number: 1, title: 'Pilot again', language: 'en' } });
    expect(dup.status).toBe(409);
    expect(dup.code).toBe('DUPLICATE');
    // Same number in another language is a different episode.
    const ru = await owner.call(S.createEpisode, { params: { ...W, seasonId: season.id }, body: { number: 1, title: 'Пилот', language: 'ru' } });
    expect(ru.id).not.toBe(ep1.id);
    const [original] = await db().select().from(episodes).where(eq(episodes.id, ep1.id));
    expect(original!.title).toBe('Pilot');
    // Changing a number onto a taken one is rejected; the database constraint backs it up.
    const ep2 = await owner.call(S.createEpisode, { params: { ...W, seasonId: season.id }, body: { number: 2, title: 'Second' } });
    const clash = await owner.attempt(S.updateEpisode, { params: { ...W, episodeId: ep2.id }, body: { number: 1 } }, { ifMatch: ep2.rowVersion });
    expect(clash.status).toBe(409);
    await expect(db().insert(episodes).values({ id: newId(), workspaceId: W.workspaceId, projectId: series.id, seasonId: season.id, number: 1, title: 'Raw', language: 'en' })).rejects.toThrow();
    // Archived episodes free the number; restoring onto a taken number is a conflict.
    await owner.call(S.archiveEpisode, { params: { ...W, episodeId: ep1.id }, body: { reason: 'Replaced by new cut' } }, { ifMatch: original!.rowVersion });
    await owner.call(S.createEpisode, { params: { ...W, seasonId: season.id }, body: { number: 1, title: 'Pilot (recut)' } });
    const [archived] = await db().select().from(episodes).where(eq(episodes.id, ep1.id));
    const restore = await owner.attempt(S.restoreEpisode, { params: { ...W, episodeId: ep1.id }, body: {} }, { ifMatch: archived!.rowVersion });
    expect(restore.status).toBe(409);
    const structure = await owner.call(S.structure, { params: { ...W, projectId: series.id }, query: {} });
    expect(structure.seasons[0]!.episodes.map((e) => `${e.number}${e.language}`)).toEqual(['1en', '1ru', '2en']);
  });

  it('reordering scenes keeps stable ids and linked tasks (T027)', async () => {
    const { ws, owner, series, W } = await seriesSetup();
    const season = await owner.call(S.createSeason, { params: { ...W, projectId: series.id }, body: { name: 'Season 1' } });
    const ep = await owner.call(S.createEpisode, { params: { ...W, seasonId: season.id }, body: { number: 1, title: 'Pilot' } });
    const character = await owner.call(C.create, { params: { ...W, projectId: series.id }, body: { name: 'Detective' } });
    const a = await owner.call(S.createScene, { params: { ...W, episodeId: ep.id }, body: { title: 'Opening', characterVersionIds: [character.open!.id] } });
    const b = await owner.call(S.createScene, { params: { ...W, episodeId: ep.id }, body: { title: 'Chase' } });
    const c = await owner.call(S.createScene, { params: { ...W, episodeId: ep.id }, body: { title: 'Reveal' } });
    expect([a.orderNo, b.orderNo, c.orderNo]).toEqual([1, 2, 3]);
    expect(a.characters[0]).toMatchObject({ name: 'Detective', versionNo: 1 });
    // A task refers to scene C by its id (tasks reference scenes through their content/episode context).
    const taskId = newId();
    await db().insert(tasks).values({ id: taskId, workspaceId: ws.workspaceId, projectId: series.id, title: `Storyboard ${c.id}`, status: 'ready' });

    const afterUp = await owner.call(S.moveScene, { params: { ...W, sceneId: c.id }, body: { direction: 'up' } }, { ifMatch: c.rowVersion });
    expect(afterUp.map((s) => s.title)).toEqual(['Opening', 'Reveal', 'Chase']);
    const cNow = afterUp.find((s) => s.id === c.id)!;
    const afterFirst = await owner.call(S.moveScene, { params: { ...W, sceneId: c.id }, body: { direction: 'up' } }, { ifMatch: cNow.rowVersion });
    expect(afterFirst.map((s) => s.id)).toEqual([c.id, a.id, b.id]);
    expect(afterFirst.map((s) => s.orderNo)).toEqual([1, 2, 3]);
    const top = afterFirst[0]!;
    const cannot = await owner.attempt(S.moveScene, { params: { ...W, sceneId: c.id }, body: { direction: 'up' } }, { ifMatch: top.rowVersion });
    expect(cannot.status).toBe(409);
    expect(afterFirst.find((s) => s.id === a.id)!.characters).toHaveLength(1);
    const [task] = await db().select().from(tasks).where(eq(tasks.id, taskId));
    expect(task!.title).toContain(c.id);
    // Stale If-Match on a move is a version conflict.
    const stale = await owner.attempt(S.moveScene, { params: { ...W, sceneId: b.id }, body: { direction: 'up' } }, { ifMatch: b.rowVersion });
    expect(stale.status).toBe(412);
  });

  it('seasons reorder, archive with their episodes and exist only in series projects', async () => {
    const { ws, owner, project, series, W } = await seriesSetup();
    const notSeries = await owner.attempt(S.createSeason, { params: { ...W, projectId: project.id }, body: { name: 'Season 1' } });
    expect(notSeries.status).toBe(409);
    const s1 = await owner.call(S.createSeason, { params: { ...W, projectId: series.id }, body: { name: 'Season 1' } });
    const s2 = await owner.call(S.createSeason, { params: { ...W, projectId: series.id }, body: { name: 'Season 2' } });
    const moved = await owner.call(S.moveSeason, { params: { ...W, seasonId: s2.id }, body: { direction: 'up' } }, { ifMatch: s2.rowVersion });
    expect(moved.map((s) => s.name)).toEqual(['Season 2', 'Season 1']);
    const ep = await owner.call(S.createEpisode, { params: { ...W, seasonId: s1.id }, body: { number: 1, title: 'Pilot' } });
    const s1Now = moved.find((s) => s.id === s1.id)!;
    await owner.call(S.archiveSeason, { params: { ...W, seasonId: s1.id }, body: { reason: 'Cancelled season' } }, { ifMatch: s1Now.rowVersion });
    const [e] = await db().select().from(episodes).where(eq(episodes.id, ep.id));
    expect(e!.archivedAt).not.toBeNull();
    const structure = await owner.call(S.structure, { params: { ...W, projectId: series.id }, query: {} });
    expect(structure.seasons.map((s) => s.name)).toEqual(['Season 2']);

    // Creators on the project read the structure but cannot change it; others get 404.
    const creator = await addMember(db(), ws, { roleKey: 'creator', scopeType: 'assigned_projects' });
    await assignToProject(db(), ws, series.id, creator.membershipId);
    const cc = await clientFor(await sessionFor(db(), creator.userId));
    const view = await cc.call(S.structure, { params: { ...W, projectId: series.id }, query: {} });
    expect(view.permissions.write).toBe(false);
    expect((await cc.attempt(S.createSeason, { params: { ...W, projectId: series.id }, body: { name: 'Season 3' } })).status).toBe(403);
    const outsider = await addMember(db(), ws, { roleKey: 'creator', scopeType: 'assigned_projects' });
    const oc = await clientFor(await sessionFor(db(), outsider.userId));
    expect((await oc.attempt(S.structure, { params: { ...W, projectId: series.id }, query: {} })).status).toBe(404);
    expect((await oc.attempt(S.getEpisode, { params: { ...W, episodeId: ep.id }, query: {} })).status).toBe(404);
  });
});
