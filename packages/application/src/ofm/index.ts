/**
 * OFM operations module (spec §13, S40–S48). Importing this module registers its jobs, schedules,
 * lookups, archive handlers, link access, responsibility providers and import/export datasets.
 * Only the public use cases are re-exported (internal helpers stay module-private to avoid clashes).
 */
import './registries';

export { listOfmProfiles, updateOfmProfile } from './profiles';
export { assignmentImpact, createAssignment, endAssignment, getAssignment, listAssignments, transferAssignment, updateAssignment } from './assignments';
export {
  acceptSwap as acceptShiftSwap,
  allowEarlyStart as allowShiftEarlyStart,
  approveSwap as approveShiftSwap,
  cancelShift,
  cancelSwap as cancelShiftSwap,
  correctShiftTime,
  createShift,
  declineSwap as declineShiftSwap,
  endShift,
  getShiftDetail,
  getSwap as getShiftSwap,
  listShifts,
  listSwaps as listShiftSwaps,
  markMissed as markShiftMissed,
  pauseShift,
  reassignShift,
  repeatApply as shiftRepeatApply,
  repeatPreview as shiftRepeatPreview,
  requestSwap as requestShiftSwap,
  resumeShift,
  setTimeAllocation as setShiftTimeAllocation,
  startShift,
  updateShift,
  validateShift,
} from './shifts';
export {
  approveReport as approveShiftReport,
  getReport as getShiftReport,
  requestReportChanges as requestShiftReportChanges,
  saveReportDraft as saveShiftReportDraft,
  submitReport as submitShiftReport,
} from './reports';
export {
  acknowledgeHandover,
  addHandoverItem,
  assignHandoverRecipient,
  convertHandoverItem,
  createHandover,
  getHandover,
  handoverCandidates,
  listHandovers,
  removeHandoverItem,
  resolveHandoverItem,
  submitHandover,
  updateHandover,
} from './handovers';
export {
  archiveContact as archiveOfmContact,
  changeContactStage,
  createContact as createOfmContact,
  createInteraction as createOfmInteraction,
  getContact as getOfmContact,
  listContacts as listOfmContacts,
  listInteractions as listOfmInteractions,
  mergeContacts as mergeOfmContacts,
  mergePreview as ofmContactMergePreview,
  relateContacts as relateOfmContacts,
  requestErasure as requestOfmContactErasure,
  restoreContact as restoreOfmContact,
  updateContact as updateOfmContact,
  updateInteraction as updateOfmInteraction,
} from './contacts';
export { createContentRequestBrief, createOperation, getOperation, linkOperationContent, listOperations, transitionOperation, updateOperation } from './operations';
export { checkSaleDuplicate, createSaleCandidate, getSaleCandidate, listSaleCandidates, updateSaleCandidate } from './sales';
export {
  acknowledgeQualityReview,
  createImprovementTask as createQualityImprovementTask,
  createQualityReview,
  createRubricVersion,
  disputeQualityReview,
  getQualityReview,
  listQualityReviews,
  listRubrics as listQualityRubrics,
  publishQualityReview,
  publishRubricVersion,
  resolveQualityDispute,
  updateQualityReview,
} from './quality';
export { myShifts, ofmOverview } from './overview';
export { runContactRetention, runShiftMonitor } from './jobs';
export { createOfmTask } from './tasks-bridge';
