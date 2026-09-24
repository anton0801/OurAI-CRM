/**
 * Partners & partnership deals (S73, S74). A Won deal never creates income (T138); finance and
 * task modules contribute "Register Income Draft" / "Generate Deliverable Tasks" via DEAL_PANELS.
 */
export { partnerVisibility, dealVisibility, canDeal, canPartner, canSeeDealAmounts, loadDealRow, type PartnerRow, type DealRow } from './scope';
export {
  listPartners,
  getPartner,
  createPartner,
  updatePartner,
  partnerArchivePreview,
  archivePartner,
  restorePartner,
  listPartnerInteractions,
  logPartnerInteraction,
  partnerMergePreview,
  mergePartner,
} from './partners';
export { DEAL_TRANSITIONS, listDeals, getDeal, createDeal, updateDeal, transitionDeal, dealArchivePreview, archiveDeal, restoreDeal } from './deals';
export { DELIVERABLE_TRANSITIONS, listDeliverables, getDeliverable, createDeliverable, updateDeliverable, transitionDeliverable } from './deliverables';
export { createCampaignForDeal } from './campaign';
import './datasets';
import './registrations';
