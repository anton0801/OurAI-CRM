/**
 * Insights module (spec §15–§17, S49–S52): metric observations and revisions, checkpoints (Metrics
 * Inbox), the semantic layer M01–M42, analytics dashboards and the report builder. Importing this
 * file registers jobs, schedules, lookups, archive/responsibility handlers and import/export
 * datasets. Only the public use cases are re-exported (helpers stay module-private).
 */
import './semantic';
import './registries';
import './reports/schedules';

export {
  createObservation as createMetricObservation,
  bulkCreateObservations as bulkCreateMetricObservations,
  validateObservation as validateMetricObservation,
  getObservation as getMetricObservation,
  listObservations as listMetricObservations,
  submitCorrection as submitMetricCorrection,
  approveCorrection as approveMetricCorrection,
  rejectCorrection as rejectMetricCorrection,
  markObservationReviewed as markMetricObservationReviewed,
  setObservationCanonical as setMetricObservationCanonical,
  type ObservationCreateInput as MetricObservationCreateInput,
} from './observations';
export {
  listCheckpoints as listMetricCheckpoints,
  getCheckpoint as getMetricCheckpoint,
  markCheckpointMissing as markMetricCheckpointMissing,
  inboxSummary as metricsInboxSummary,
  reviewQueue as metricsReviewQueue,
  myCheckpoints as myMetricCheckpoints,
  ensurePublicationCheckpoints as ensurePublicationMetricCheckpoints,
  cancelPublicationCheckpoints,
  runCheckpointMaintenance as runMetricCheckpointMaintenance,
  accountOccurrences as metricAccountOccurrences,
  accountMetrics as getAccountMetrics,
  publicationMetrics as getPublicationMetrics,
  contentResults as getContentMetricResults,
} from './checkpoints';
export {
  INSIGHT_METRICS,
  availableInsightMetrics,
  computeInsight as evaluateInsightMetric,
  type InsightMetric,
  type InsightQuery,
} from './semantic/registry';
export { metricCatalog, metricFieldDefinition } from './catalog-view';
export { analyticsDashboard, analyticsQuery, analyticsDrillDown, availableTabs as availableAnalyticsTabs } from './dashboards';
export { listReportDatasets, runReport as runReportConfig, validateReportConfig, REPORT_DATASET_SPECS } from './reports/engine';
export {
  listReports as listSavedReports,
  getReport as getSavedReport,
  createReport as createSavedReport,
  updateReport as updateSavedReport,
  listReportVersions as listSavedReportVersions,
  duplicateReport as duplicateSavedReport,
  shareReport as shareSavedReport,
  archiveReport as archiveSavedReport,
  restoreReport as restoreSavedReport,
  runSavedReport,
  previewReport as previewReportConfig,
  createReportSnapshot,
  listReportSnapshots,
  listMySnapshots as listMyReportSnapshots,
  getReportSnapshot,
} from './reports/reports';
export {
  listReportSchedules,
  getReportSchedule,
  createReportSchedule,
  updateReportSchedule,
  pauseReportSchedule,
  resumeReportSchedule,
  runDueReportSchedules,
  nextScheduleRun as nextReportScheduleRun,
} from './reports/schedules';
export { reportSnapshotPdf, renderSnapshotPdf } from './reports/pdf';
