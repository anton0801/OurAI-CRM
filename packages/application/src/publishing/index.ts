/**
 * Publishing module (S31–S35, §12): publications (placements), calendar, weekly plan baselines,
 * campaigns (costs through finance allocations, source reports, tracking links) and experiments.
 * Importing this file registers its lookups, link access, archive handlers, responsibility
 * providers, export datasets, jobs and schedules.
 *
 * Helpers for other modules: `createCampaign` (e.g. deals → Create Campaign), `writeCampaignCostAllocations`
 * (single writer of campaign cost allocations, to be swapped for the finance module's command),
 * `publicationScope` / `publicationVisibility` (authorise records that belong to a placement),
 * `activePublicationPolicy` / `createPublicationCheckpoints` (checkpoint rows, see checkpoints.ts).
 */
export {
  PUBLICATION_TRANSITIONS,
  CAMPAIGN_TRANSITIONS,
  EXPERIMENT_TRANSITIONS,
  CONFLICT_WINDOW_MINUTES,
  checkpointWindows,
  checkpointTiming,
  planWeekOf,
  planWeekBounds,
  onTimeAgainstBaseline,
  classifyComparable,
  summarizeComparable,
  splitCostMinor,
  summarizeSources,
} from './logic';
export {
  publicationScope,
  publicationVisibility,
  canPublication,
  loadPublicationRow,
  campaignVisibility,
  canCampaign,
  canChangeCampaign,
  campaignProjectMap,
  loadCampaignRow,
  experimentScope,
  experimentVisibility,
  type PublicationRowDb,
  type CampaignRowDb,
  type ExperimentRowDb,
} from './scope';
export {
  listPublications,
  getPublication,
  publicationsDue,
  publicationActivity,
  publicationContentOptions,
  publicationContentVersions,
  toPublicationRows,
  publicationFilterSql,
  type ListPublicationsInput,
} from './publications';
export {
  createPublication,
  createHistoricalPublication,
  updatePublication,
  previewPublicationSchedule,
  schedulePublication,
  markPublicationPublished,
  failPublication,
  cancelPublication,
  correctPublication,
  setPublicationAvailability,
  archivePublication,
  restorePublication,
  evaluateScheduleGates,
  type PublicationCreateInput,
  type PublicationUpdateInput,
  type ScheduleInput,
} from './publication-commands';
export { activePublicationPolicy, createPublicationCheckpoints, occurrenceKeyOf } from './checkpoints';
export { planBaselineWeekView, freezeCurrentPlanWeek, freezePlanWeek, runPlanFreeze } from './baselines';
export { getCalendar, type CalendarQuery } from './calendar';
export {
  listCampaigns,
  getCampaign,
  createCampaign,
  updateCampaign,
  transitionCampaign,
  archiveCampaign,
  restoreCampaign,
  duplicateCampaign,
  linkCampaignDeal,
  getCampaignResults,
  campaignActivity,
  campaignArchivePreview,
  type ListCampaignsInput,
  type CampaignInput,
} from './campaigns';
export { getCampaignCosts, allocateCampaignCost, writeCampaignCostAllocations } from './campaign-costs';
export {
  listTrackingLinks,
  getTrackingLink,
  previewTrackingLink,
  createTrackingLink,
  updateTrackingLink,
  archiveTrackingLink,
  listSourceReports,
  createSourceReport,
  updateSourceReport,
} from './tracking-links';
export {
  listExperiments,
  getExperiment,
  createExperiment,
  updateExperiment,
  startExperiment,
  concludeExperiment,
  duplicateExperiment,
  linkExperimentPublications,
  unlinkExperimentPublication,
  archiveExperiment,
  getExperimentResults,
  experimentMetricOptions,
  EXPERIMENT_METRICS,
} from './experiments';
export { runPublicationReminders } from './registrations';
import './datasets';
import './registrations';
