import {
  calendarEndpoints as CAL,
  campaignEndpoints as C,
  experimentEndpoints as X,
  planBaselineEndpoints as B,
  publicationEndpoints as P,
  sourceReportEndpoints as SR,
  trackingLinkEndpoints as TL,
} from '@castlane/api-contracts';
import {
  allocateCampaignCost,
  archiveCampaign,
  archiveExperiment,
  archivePublication,
  archiveTrackingLink,
  campaignActivity,
  cancelPublication,
  concludeExperiment,
  correctPublication,
  createCampaign,
  createExperiment,
  createHistoricalPublication,
  createPublication,
  createSourceReport,
  createTrackingLink,
  duplicateCampaign,
  duplicateExperiment,
  experimentMetricOptions,
  failPublication,
  freezeCurrentPlanWeek,
  getCalendar,
  getCampaign,
  getCampaignCosts,
  getCampaignResults,
  getExperiment,
  getExperimentResults,
  getPublication,
  getTrackingLink,
  linkCampaignDeal,
  linkExperimentPublications,
  listCampaigns,
  listExperiments,
  listPublications,
  listSourceReports,
  listTrackingLinks,
  markPublicationPublished,
  planBaselineWeekView,
  previewPublicationSchedule,
  previewTrackingLink,
  publicationActivity,
  publicationContentOptions,
  publicationContentVersions,
  publicationsDue,
  requirePermission,
  restoreCampaign,
  schedulePublication,
  setPublicationAvailability,
  startExperiment,
  transitionCampaign,
  unlinkExperimentPublication,
  updateCampaign,
  updateExperiment,
  updatePublication,
  updateSourceReport,
  updateTrackingLink,
} from '@castlane/application';
import { route } from '../http/router';

// ——— Publications (S32) ———
route(P.list, ({ ctx, input }) => listPublications(ctx, input.query));
route(P.due, ({ ctx, input }) => publicationsDue(ctx, input.query));
route(P.contentOptions, ({ ctx, input }) => publicationContentOptions(ctx, input.query));
route(P.contentVersions, ({ ctx, input }) => publicationContentVersions(ctx, input.query));
route(P.get, ({ ctx, input }) => getPublication(ctx, input.params.publicationId));
route(P.schedulePreview, ({ ctx, input }) => previewPublicationSchedule(ctx, input.params.publicationId, input.query));
route(P.activity, ({ ctx, input }) => publicationActivity(ctx, input.params.publicationId, input.query));
// Commands return the fresh read model built inside the same transaction.
route(P.create, ({ run, input }) => run(async (c) => getPublication(c, await createPublication(c, input.body))));
route(P.createHistorical, ({ run, input }) => run(async (c) => getPublication(c, await createHistoricalPublication(c, input.body))));
route(P.update, ({ run, input }) => run(async (c) => getPublication(c, await updatePublication(c, input.params.publicationId, input.body))));
route(P.schedule, ({ run, input }) => run(async (c) => getPublication(c, await schedulePublication(c, input.params.publicationId, input.body))));
route(P.markPublished, ({ run, input }) => run(async (c) => getPublication(c, await markPublicationPublished(c, input.params.publicationId, input.body))));
route(P.fail, ({ run, input }) => run(async (c) => getPublication(c, await failPublication(c, input.params.publicationId, input.body))));
route(P.cancel, ({ run, input }) => run(async (c) => getPublication(c, await cancelPublication(c, input.params.publicationId, input.body))));
route(P.correct, ({ run, input }) => run(async (c) => getPublication(c, await correctPublication(c, input.params.publicationId, input.body))));
route(P.setAvailability, ({ run, input }) => run(async (c) => getPublication(c, await setPublicationAvailability(c, input.params.publicationId, input.body))));
route(P.archive, ({ run, input }) => run(async (c) => getPublication(c, await archivePublication(c, input.params.publicationId, input.body))));

// ——— Calendar & plan baselines (S31) ———
route(CAL.get, ({ ctx, input }) => getCalendar(ctx, input.query));
route(B.week, ({ ctx, input }) => planBaselineWeekView(ctx, input.query));
route(B.freeze, ({ run, input }) => run((c) => freezeCurrentPlanWeek(c, input.body)));

// ——— Campaigns (S33–S34) ———
route(C.list, ({ ctx, input }) => listCampaigns(ctx, input.query));
route(C.get, ({ ctx, input }) => getCampaign(ctx, input.params.campaignId));
route(C.create, ({ run, input }) => run(async (c) => getCampaign(c, await createCampaign(c, input.body))));
route(C.update, ({ run, input }) => run(async (c) => getCampaign(c, await updateCampaign(c, input.params.campaignId, input.body))));
route(C.transition, ({ run, input }) => run(async (c) => getCampaign(c, await transitionCampaign(c, input.params.campaignId, input.body))));
route(C.duplicate, ({ run, input }) => run(async (c) => getCampaign(c, await duplicateCampaign(c, input.params.campaignId, input.body))));
route(C.linkDeal, ({ run, input }) => run(async (c) => getCampaign(c, await linkCampaignDeal(c, input.params.campaignId, input.body))));
route(C.results, ({ ctx, input }) => getCampaignResults(ctx, input.params.campaignId));
route(C.costs, ({ ctx, input }) => getCampaignCosts(ctx, input.params.campaignId));
route(C.allocateCost, ({ run, input }) => run((c) => allocateCampaignCost(c, input.params.campaignId, input.body)));
route(C.activity, ({ ctx, input }) => campaignActivity(ctx, input.params.campaignId, input.query));
route(C.archive, ({ run, input }) => run(async (c) => getCampaign(c, await archiveCampaign(c, input.params.campaignId, input.body))));
route(C.restore, ({ run, input }) => run(async (c) => getCampaign(c, await restoreCampaign(c, input.params.campaignId))));

route(SR.list, ({ ctx, input }) => listSourceReports(ctx, input.params.campaignId));
route(SR.create, ({ run, input }) => run((c) => createSourceReport(c, input.params.campaignId, input.body)));
route(SR.update, ({ run, input }) => run((c) => updateSourceReport(c, input.params.reportId, input.body)));

route(TL.list, ({ ctx, input }) => listTrackingLinks(ctx, input.query));
route(TL.get, ({ ctx, input }) => getTrackingLink(ctx, input.params.linkId));
route(TL.preview, async ({ ctx, input }) => {
  requirePermission(ctx, 'campaigns.read');
  const { destinationUrl, ...utm } = input.query;
  return previewTrackingLink(destinationUrl, utm);
});
route(TL.create, ({ run, input }) => run(async (c) => getTrackingLink(c, await createTrackingLink(c, input.params.campaignId, input.body))));
route(TL.update, ({ run, input }) => run(async (c) => getTrackingLink(c, await updateTrackingLink(c, input.params.linkId, input.body))));
route(TL.archive, ({ run, input }) => run(async (c) => getTrackingLink(c, await archiveTrackingLink(c, input.params.linkId, input.body))));

// ——— Experiments (S35) ———
route(X.list, ({ ctx, input }) => listExperiments(ctx, input.query));
route(X.metrics, async ({ ctx }) => experimentMetricOptions(ctx));
route(X.get, ({ ctx, input }) => getExperiment(ctx, input.params.experimentId));
route(X.create, ({ run, input }) => run(async (c) => getExperiment(c, await createExperiment(c, input.body))));
route(X.update, ({ run, input }) => run(async (c) => getExperiment(c, await updateExperiment(c, input.params.experimentId, input.body))));
route(X.start, ({ run, input }) => run(async (c) => getExperiment(c, await startExperiment(c, input.params.experimentId, input.body))));
route(X.conclude, ({ run, input }) => run(async (c) => getExperiment(c, await concludeExperiment(c, input.params.experimentId, input.body))));
route(X.duplicate, ({ run, input }) => run(async (c) => getExperiment(c, await duplicateExperiment(c, input.params.experimentId, input.body))));
route(X.linkPublications, ({ run, input }) => run(async (c) => getExperiment(c, await linkExperimentPublications(c, input.params.experimentId, input.body))));
route(X.unlinkPublication, ({ run, input }) => run(async (c) => getExperiment(c, await unlinkExperimentPublication(c, input.params.experimentId, input.params.linkId, input.body))));
route(X.results, ({ ctx, input }) => getExperimentResults(ctx, input.params.experimentId));
route(X.archive, ({ run, input }) => run(async (c) => getExperiment(c, await archiveExperiment(c, input.params.experimentId, input.body))));
