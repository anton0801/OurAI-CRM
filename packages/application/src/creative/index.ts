/**
 * Creative module: characters and versioned profiles (S16), series structure (S17), references (S21).
 * `createIdeaDraftFromReference` is the one place that writes a content draft for "Use as Idea".
 */
export {
  MAX_REFERENCES,
  characterScope,
  loadCharacter,
  listCharacters,
  getCharacter,
  createCharacter,
  updateCharacter,
  setPrimaryCharacter,
  newCharacterVersion,
  updateCharacterVersion,
  submitCharacterVersion,
  approveCharacterVersion,
  requestCharacterChanges,
  characterAffectedContent,
  characterArchivePreview,
  archiveCharacter,
  restoreCharacter,
  type CharacterRow,
  type CharacterVersionRow,
} from './characters';
export {
  seriesStructure,
  listSeasons,
  getSeason,
  createSeason,
  updateSeason,
  moveSeason,
  archiveSeason,
  restoreSeason,
  listEpisodes,
  getEpisode,
  createEpisode,
  updateEpisode,
  archiveEpisode,
  restoreEpisode,
  listScenes,
  getScene,
  createScene,
  updateScene,
  moveScene,
  archiveScene,
  sceneView,
} from './series';
export {
  referenceScope,
  canReadReference,
  loadReference,
  listReferences,
  getReference,
  createReference,
  updateReference,
  linkReference,
  unlinkReference,
  useReferenceAsIdea,
  archiveReference,
  restoreReference,
} from './references';
export { createIdeaDraftFromReference } from './reference-idea';
export { findSecretLikeValue } from './secrets';
import './datasets';
import './registrations';
