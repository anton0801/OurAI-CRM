import { characterEndpoints as C, referenceEndpoints as R, seriesEndpoints as S } from '@castlane/api-contracts';
import {
  approveCharacterVersion,
  archiveCharacter,
  archiveEpisode,
  archiveReference,
  archiveScene,
  archiveSeason,
  characterAffectedContent,
  createCharacter,
  createEpisode,
  createReference,
  createScene,
  createSeason,
  getCharacter,
  getEpisode,
  getReference,
  getScene,
  getSeason,
  linkReference,
  listCharacters,
  listEpisodes,
  listReferences,
  listScenes,
  listSeasons,
  moveScene,
  moveSeason,
  newCharacterVersion,
  requestCharacterChanges,
  restoreCharacter,
  restoreEpisode,
  restoreReference,
  restoreSeason,
  sceneView,
  seriesStructure,
  setPrimaryCharacter,
  submitCharacterVersion,
  unlinkReference,
  updateCharacter,
  updateCharacterVersion,
  updateEpisode,
  updateReference,
  updateScene,
  updateSeason,
  useReferenceAsIdea,
} from '@castlane/application';
import { route } from '../http/router';

// ——— Characters (S16) ———
route(C.list, ({ ctx, input }) => listCharacters(ctx, input.params.projectId, input.query));
route(C.get, ({ ctx, input }) => getCharacter(ctx, input.params.characterId));
route(C.create, ({ run, input }) => run(async (c) => getCharacter(c, await createCharacter(c, input.params.projectId, input.body))));
route(C.update, ({ run, input }) => run(async (c) => getCharacter(c, await updateCharacter(c, input.params.characterId, input.body))));
route(C.setPrimary, ({ run, input }) => run(async (c) => getCharacter(c, await setPrimaryCharacter(c, input.params.characterId, input.body))));
route(C.newVersion, ({ run, input }) => run(async (c) => getCharacter(c, await newCharacterVersion(c, input.params.characterId, input.body))));
route(C.updateVersion, ({ run, input }) => run(async (c) => getCharacter(c, await updateCharacterVersion(c, input.params.versionId, input.body))));
route(C.submitVersion, ({ run, input }) => run(async (c) => getCharacter(c, await submitCharacterVersion(c, input.params.versionId, input.body))));
route(C.approveVersion, ({ run, input }) => run(async (c) => getCharacter(c, await approveCharacterVersion(c, input.params.versionId, input.body))));
route(C.requestChanges, ({ run, input }) => run(async (c) => getCharacter(c, await requestCharacterChanges(c, input.params.versionId, input.body))));
route(C.affectedContent, ({ ctx, input }) => characterAffectedContent(ctx, input.params.characterId));
route(C.archive, ({ run, input }) => run(async (c) => getCharacter(c, await archiveCharacter(c, input.params.characterId, input.body))));
route(C.restore, ({ run, input }) => run(async (c) => getCharacter(c, await restoreCharacter(c, input.params.characterId))));

// ——— Series structure (S17) ———
route(S.structure, ({ ctx, input }) => seriesStructure(ctx, input.params.projectId, input.query));
route(S.listSeasons, ({ ctx, input }) => listSeasons(ctx, input.params.projectId, input.query));
route(S.createSeason, ({ run, input }) => run(async (c) => getSeason(c, await createSeason(c, input.params.projectId, input.body))));
route(S.getSeason, ({ ctx, input }) => getSeason(ctx, input.params.seasonId));
route(S.updateSeason, ({ run, input }) => run(async (c) => getSeason(c, await updateSeason(c, input.params.seasonId, input.body))));
route(S.moveSeason, ({ run, input }) => run(async (c) => listSeasons(c, await moveSeason(c, input.params.seasonId, input.body))));
route(S.archiveSeason, ({ run, input }) => run((c) => archiveSeason(c, input.params.seasonId, input.body)));
route(S.restoreSeason, ({ run, input }) => run(async (c) => getSeason(c, await restoreSeason(c, input.params.seasonId))));
route(S.listEpisodes, ({ ctx, input }) => listEpisodes(ctx, input.params.seasonId, input.query));
route(S.createEpisode, ({ run, input }) => run(async (c) => getEpisode(c, await createEpisode(c, input.params.seasonId, input.body))));
route(S.getEpisode, ({ ctx, input }) => getEpisode(ctx, input.params.episodeId, input.query));
route(S.updateEpisode, ({ run, input }) => run(async (c) => getEpisode(c, await updateEpisode(c, input.params.episodeId, input.body))));
route(S.archiveEpisode, ({ run, input }) => run(async (c) => getEpisode(c, await archiveEpisode(c, input.params.episodeId, input.body), { includeArchived: true })));
route(S.restoreEpisode, ({ run, input }) => run(async (c) => getEpisode(c, await restoreEpisode(c, input.params.episodeId))));
route(S.listScenes, ({ ctx, input }) => listScenes(ctx, input.params.episodeId, input.query));
route(S.createScene, ({ run, input }) => run(async (c) => sceneView(c, await createScene(c, input.params.episodeId, input.body))));
route(S.getScene, ({ ctx, input }) => getScene(ctx, input.params.sceneId));
route(S.updateScene, ({ run, input }) => run(async (c) => sceneView(c, await updateScene(c, input.params.sceneId, input.body))));
route(S.moveScene, ({ run, input }) => run(async (c) => (await getEpisode(c, await moveScene(c, input.params.sceneId, input.body))).scenes));
route(S.archiveScene, ({ run, input }) => run((c) => archiveScene(c, input.params.sceneId, input.body)));

// ——— References (S21) ———
route(R.list, ({ ctx, input }) => listReferences(ctx, input.query));
route(R.get, ({ ctx, input }) => getReference(ctx, input.params.referenceId));
route(R.create, ({ run, input }) => run(async (c) => getReference(c, await createReference(c, input.body))));
route(R.update, ({ run, input }) => run(async (c) => getReference(c, await updateReference(c, input.params.referenceId, input.body))));
route(R.link, ({ run, input }) => run(async (c) => getReference(c, await linkReference(c, input.params.referenceId, input.body))));
route(R.unlink, ({ run, input }) => run(async (c) => getReference(c, await unlinkReference(c, input.params.referenceId, input.params.linkId))));
route(R.useAsIdea, ({ run, input }) =>
  run(async (c) => {
    const r = await useReferenceAsIdea(c, input.params.referenceId, input.body);
    return { ...r, reference: await getReference(c, input.params.referenceId) };
  }),
);
route(R.archive, ({ run, input }) => run(async (c) => getReference(c, await archiveReference(c, input.params.referenceId, input.body))));
route(R.restore, ({ run, input }) => run(async (c) => getReference(c, await restoreReference(c, input.params.referenceId))));
