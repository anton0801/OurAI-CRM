import { dealEndpoints as D, partnerEndpoints as P } from '@castlane/api-contracts';
import {
  archiveDeal,
  archivePartner,
  createCampaignForDeal,
  createDeal,
  createDeliverable,
  createPartner,
  getDeal,
  getDeliverable,
  getPartner,
  listDeals,
  listDeliverables,
  listPartnerInteractions,
  listPartners,
  logPartnerInteraction,
  mergePartner,
  partnerMergePreview,
  restoreDeal,
  restorePartner,
  transitionDeal,
  transitionDeliverable,
  updateDeal,
  updateDeliverable,
  updatePartner,
} from '@castlane/application';
import { route } from '../http/router';

// ——— Partners (S73) ———
route(P.list, ({ ctx, input }) => listPartners(ctx, input.query));
route(P.get, ({ ctx, input }) => getPartner(ctx, input.params.partnerId));
route(P.create, ({ run, input }) => run(async (c) => getPartner(c, await createPartner(c, input.body))));
route(P.update, ({ run, input }) => run(async (c) => getPartner(c, await updatePartner(c, input.params.partnerId, input.body))));
route(P.archive, ({ run, input }) => run(async (c) => getPartner(c, await archivePartner(c, input.params.partnerId, input.body))));
route(P.restore, ({ run, input }) => run(async (c) => getPartner(c, await restorePartner(c, input.params.partnerId))));
route(P.interactions, ({ ctx, input }) => listPartnerInteractions(ctx, input.params.partnerId, input.query));
route(P.logInteraction, ({ run, input }) => run((c) => logPartnerInteraction(c, input.params.partnerId, input.body)));
route(P.mergePreview, ({ ctx, input }) => partnerMergePreview(ctx, input.params.partnerId, input.query.targetId));
route(P.merge, ({ run, input }) => run(async (c) => getPartner(c, await mergePartner(c, input.params.partnerId, input.body))));

// ——— Deals (S74) ———
route(D.list, ({ ctx, input }) => listDeals(ctx, input.query));
route(D.get, ({ ctx, input }) => getDeal(ctx, input.params.dealId));
route(D.create, ({ run, input }) => run(async (c) => getDeal(c, await createDeal(c, input.body))));
route(D.update, ({ run, input }) => run(async (c) => getDeal(c, await updateDeal(c, input.params.dealId, input.body))));
route(D.transition, ({ run, input }) => run(async (c) => getDeal(c, await transitionDeal(c, input.params.dealId, input.body))));
route(D.archive, ({ run, input }) => run(async (c) => getDeal(c, await archiveDeal(c, input.params.dealId, input.body))));
route(D.restore, ({ run, input }) => run(async (c) => getDeal(c, await restoreDeal(c, input.params.dealId))));
route(D.createCampaign, ({ run, input }) => run(async (c) => getDeal(c, await createCampaignForDeal(c, input.params.dealId, input.body))));
route(D.listDeliverables, ({ ctx, input }) => listDeliverables(ctx, input.params.dealId, input.query));
route(D.createDeliverable, ({ run, input }) => run((c) => createDeliverable(c, input.params.dealId, input.body)));
route(D.getDeliverable, ({ ctx, input }) => getDeliverable(ctx, input.params.deliverableId));
route(D.updateDeliverable, ({ run, input }) => run((c) => updateDeliverable(c, input.params.deliverableId, input.body)));
route(D.transitionDeliverable, ({ run, input }) => run((c) => transitionDeliverable(c, input.params.deliverableId, input.body)));
