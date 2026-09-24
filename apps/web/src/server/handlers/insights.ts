import { analyticsEndpoints as A, metricsEndpoints as M, reportEndpoints as R } from '@castlane/api-contracts';
import {
  servedAnalyticsDashboard,
  analyticsDrillDown,
  analyticsQuery,
  approveMetricCorrection,
  archiveSavedReport,
  bulkCreateMetricObservations,
  createMetricObservation,
  createSavedReport,
  createReportSchedule,
  createReportSnapshot,
  duplicateSavedReport,
  getAccountMetrics,
  getContentMetricResults,
  getMetricCheckpoint,
  getMetricObservation,
  getPublicationMetrics,
  getSavedReport,
  getReportSchedule,
  getReportSnapshot,
  listMetricCheckpoints,
  listMetricObservations,
  listMyReportSnapshots,
  listReportDatasets,
  listReportSchedules,
  listReportSnapshots,
  listSavedReportVersions,
  listSavedReports,
  markMetricCheckpointMissing,
  markMetricObservationReviewed,
  metricCatalog,
  metricFieldDefinition,
  metricsInboxSummary,
  metricsReviewQueue,
  myMetricCheckpoints,
  pauseReportSchedule,
  previewReportConfig,
  rejectMetricCorrection,
  reportSnapshotPdf,
  requirePermission,
  restoreSavedReport,
  resumeReportSchedule,
  runSavedReport,
  setMetricObservationCanonical,
  shareSavedReport,
  submitMetricCorrection,
  updateSavedReport,
  updateReportSchedule,
  validateMetricObservation,
} from '@castlane/application';
import { route } from '../http/router';

// ——— Metrics collection (S49, S50) ———
route(M.catalog, ({ ctx }) => metricCatalog(ctx));
route(M.definition, ({ ctx, input }) => metricFieldDefinition(ctx, input.params.definitionId));
route(M.observations, ({ ctx, input }) => listMetricObservations(ctx, input.query));
route(M.validate, ({ ctx, input }) => validateMetricObservation(ctx, input.body));
route(M.create, ({ run, input }) => run(async (c) => getMetricObservation(c, await createMetricObservation(c, input.body))));
route(M.bulk, ({ run, input }) => run((c) => bulkCreateMetricObservations(c, input.body.rows)));
route(M.get, ({ ctx, input }) => getMetricObservation(ctx, input.params.observationId));
// The corrected record (still in use) is returned with its pending correction.
route(M.revise, ({ run, input }) =>
  run(async (c) => {
    await submitMetricCorrection(c, input.params.observationId, input.body);
    return getMetricObservation(c, input.params.observationId);
  }),
);
route(M.approveRevision, ({ run, input }) => run(async (c) => getMetricObservation(c, await approveMetricCorrection(c, input.params.revisionId, input.body))));
route(M.rejectRevision, ({ run, input }) => run(async (c) => getMetricObservation(c, await rejectMetricCorrection(c, input.params.revisionId, input.body))));
route(M.markReviewed, ({ run, input }) => run(async (c) => getMetricObservation(c, await markMetricObservationReviewed(c, input.params.observationId, input.body))));
route(M.setCanonical, ({ run, input }) => run(async (c) => getMetricObservation(c, await setMetricObservationCanonical(c, input.params.observationId, input.body))));
route(M.checkpoints, ({ ctx, input }) => listMetricCheckpoints(ctx, input.query));
route(M.checkpoint, ({ ctx, input }) => getMetricCheckpoint(ctx, input.params.checkpointId));
route(M.markMissing, ({ run, input }) => run(async (c) => getMetricCheckpoint(c, await markMetricCheckpointMissing(c, input.params.checkpointId, input.body))));
route(M.inboxSummary, ({ ctx, input }) => metricsInboxSummary(ctx, input.query));
route(M.reviewQueue, ({ ctx, input }) => metricsReviewQueue(ctx, input.query));
route(M.myCheckpoints, ({ ctx }) => myMetricCheckpoints(ctx));
route(M.accountMetrics, ({ ctx, input }) => getAccountMetrics(ctx, input.params.accountId, input.query));
route(M.publicationMetrics, ({ ctx, input }) => getPublicationMetrics(ctx, input.params.publicationId));
route(M.contentResults, ({ ctx, input }) => getContentMetricResults(ctx, input.params.contentItemId));

// ——— Analytics (S51) ———
route(A.dashboard, ({ ctx, input }) => servedAnalyticsDashboard(ctx, input.params.tab, input.query));
route(A.query, ({ ctx, input }) => analyticsQuery(ctx, input.body));
route(A.drillDown, ({ ctx, input }) => analyticsDrillDown(ctx, input.query));

// ——— Report builder (S52) ———
route(R.datasets, async ({ ctx }) => {
  requirePermission(ctx, 'reports.read');
  return listReportDatasets(ctx);
});
route(R.preview, ({ ctx, input }) => previewReportConfig(ctx, input.body.config));
route(R.list, ({ ctx, input }) => listSavedReports(ctx, input.query));
route(R.create, ({ run, input }) => run(async (c) => getSavedReport(c, await createSavedReport(c, input.body))));
route(R.get, ({ ctx, input }) => getSavedReport(ctx, input.params.reportId));
route(R.update, ({ run, input }) => run(async (c) => getSavedReport(c, await updateSavedReport(c, input.params.reportId, input.body))));
route(R.versions, ({ ctx, input }) => listSavedReportVersions(ctx, input.params.reportId));
route(R.duplicate, ({ run, input }) => run(async (c) => getSavedReport(c, await duplicateSavedReport(c, input.params.reportId, input.body))));
route(R.share, ({ run, input }) => run(async (c) => getSavedReport(c, await shareSavedReport(c, input.params.reportId, input.body))));
route(R.archive, ({ run, input }) => run(async (c) => getSavedReport(c, await archiveSavedReport(c, input.params.reportId, input.body))));
route(R.restore, ({ run, input }) => run(async (c) => getSavedReport(c, await restoreSavedReport(c, input.params.reportId))));
route(R.run, ({ ctx, input }) => runSavedReport(ctx, input.params.reportId, input.body));
route(R.snapshot, ({ run, input }) => run(async (c) => getReportSnapshot(c, await createReportSnapshot(c, input.params.reportId, input.body))));
route(R.reportSnapshots, ({ ctx, input }) => listReportSnapshots(ctx, input.params.reportId));
route(R.snapshots, ({ ctx, input }) => listMyReportSnapshots(ctx, input.query));
route(R.snapshotGet, ({ ctx, input }) => getReportSnapshot(ctx, input.params.snapshotId));
route(R.snapshotPdf, async ({ ctx, input, res }) => {
  const pdf = await reportSnapshotPdf(ctx, input.params.snapshotId);
  const name = pdf.fileName.replace(/[^\w.-]+/g, '_');
  res.raw = new Response(new Uint8Array(pdf.body), {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `attachment; filename="${name}"`,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
    },
  });
  return null;
});
route(R.schedules, ({ ctx, input }) => listReportSchedules(ctx, input.query));
route(R.scheduleCreate, ({ run, input }) => run(async (c) => getReportSchedule(c, await createReportSchedule(c, input.body))));
route(R.scheduleGet, ({ ctx, input }) => getReportSchedule(ctx, input.params.scheduleId));
route(R.scheduleUpdate, ({ run, input }) => run(async (c) => getReportSchedule(c, await updateReportSchedule(c, input.params.scheduleId, input.body))));
route(R.schedulePause, ({ run, input }) => run(async (c) => getReportSchedule(c, await pauseReportSchedule(c, input.params.scheduleId))));
route(R.scheduleResume, ({ run, input }) => run(async (c) => getReportSchedule(c, await resumeReportSchedule(c, input.params.scheduleId))));
