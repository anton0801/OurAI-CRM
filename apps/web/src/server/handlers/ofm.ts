import { ofmEndpoints as E } from '@castlane/api-contracts';
import {
  acceptShiftSwap,
  acknowledgeHandover,
  acknowledgeQualityReview,
  addHandoverItem,
  allowShiftEarlyStart,
  approveShiftReport,
  approveShiftSwap,
  archiveOfmContact,
  assignHandoverRecipient,
  assignmentImpact,
  cancelShift,
  cancelShiftSwap,
  changeContactStage,
  checkSaleDuplicate,
  convertHandoverItem,
  correctShiftTime,
  createAssignment,
  createContentRequestBrief,
  createHandover,
  createOfmContact,
  createOfmInteraction,
  createOperation,
  createQualityImprovementTask,
  createQualityReview,
  createRubricVersion,
  createSaleCandidate,
  createShift,
  declineShiftSwap,
  disputeQualityReview,
  endAssignment,
  endShift,
  getAssignment,
  getHandover,
  getOfmContact,
  getOperation,
  getQualityReview,
  getSaleCandidate,
  getShiftDetail,
  getShiftReport,
  getShiftSwap,
  handoverCandidates,
  linkOperationContent,
  listAssignments,
  listHandovers,
  listOfmContacts,
  listOfmInteractions,
  listOfmProfiles,
  listOperations,
  listQualityReviews,
  listQualityRubrics,
  listSaleCandidates,
  listShiftSwaps,
  listShifts,
  markShiftMissed,
  mergeOfmContacts,
  myShifts,
  ofmContactMergePreview,
  ofmOverview,
  pauseShift,
  publishQualityReview,
  publishRubricVersion,
  relateOfmContacts,
  removeHandoverItem,
  requestOfmContactErasure,
  requestShiftReportChanges,
  requestShiftSwap,
  resolveHandoverItem,
  resolveQualityDispute,
  restoreOfmContact,
  resumeShift,
  saveShiftReportDraft,
  setShiftTimeAllocation,
  shiftRepeatApply,
  shiftRepeatPreview,
  startShift,
  submitHandover,
  submitShiftReport,
  transferAssignment,
  transitionOperation,
  updateAssignment,
  updateHandover,
  updateOfmContact,
  updateOfmInteraction,
  updateOfmProfile,
  updateOperation,
  updateQualityReview,
  updateSaleCandidate,
  updateShift,
  validateShift,
} from '@castlane/application';
import { route } from '../http/router';

/**
 * OFM routes. Static paths (impact, duplicate-check, validate, repeat-*, merge-*) are registered
 * before their parameterised siblings. Commands return the fresh read model built in the same
 * transaction so idempotent replays return the same body.
 */

// Overview / profiles
route(E.overview, ({ ctx, input }) => ofmOverview(ctx, input.query));
route(E.myShifts, ({ ctx }) => myShifts(ctx));
route(E.profiles, ({ ctx, input }) => listOfmProfiles(ctx, input.query));
route(E.updateProfile, ({ run, input }) => run((c) => updateOfmProfile(c, input.params.projectId, input.body)));

// Assignments
route(E.assignmentImpact, ({ ctx, input }) => assignmentImpact(ctx, input.query));
route(E.listAssignments, ({ ctx, input }) => listAssignments(ctx, input.query));
route(E.getAssignment, ({ ctx, input }) => getAssignment(ctx, input.params.assignmentId));
route(E.createAssignment, ({ run, input }) => run(async (c) => getAssignment(c, await createAssignment(c, input.body))));
route(E.updateAssignment, ({ run, input }) => run(async (c) => getAssignment(c, await updateAssignment(c, input.params.assignmentId, input.body))));
route(E.endAssignment, ({ run, input }) => run(async (c) => getAssignment(c, await endAssignment(c, input.params.assignmentId, input.body))));
route(E.transferAssignment, ({ run, input }) => run(async (c) => getAssignment(c, await transferAssignment(c, input.params.assignmentId, input.body))));

// Shifts
route(E.validateShift, ({ ctx, input }) => validateShift(ctx, input.body));
route(E.repeatPreview, ({ ctx, input }) => shiftRepeatPreview(ctx, input.body));
route(E.repeatApply, ({ run, input }) => run((c) => shiftRepeatApply(c, input.body)));
route(E.listShifts, ({ ctx, input }) => listShifts(ctx, input.query));
route(E.getShift, ({ ctx, input }) => getShiftDetail(ctx, input.params.shiftId));
route(E.createShift, ({ run, input }) =>
  run(async (c) => {
    const id = await createShift(c, input.body);
    return getShiftDetail(c, id!);
  }),
);
route(E.updateShift, ({ run, input }) => run(async (c) => getShiftDetail(c, await updateShift(c, input.params.shiftId, input.body))));
route(E.cancelShift, ({ run, input }) => run(async (c) => getShiftDetail(c, await cancelShift(c, input.params.shiftId, input.body))));
route(E.allowEarlyStart, ({ run, input }) => run(async (c) => getShiftDetail(c, await allowShiftEarlyStart(c, input.params.shiftId, input.body))));
route(E.startShift, ({ run, input }) => run(async (c) => getShiftDetail(c, await startShift(c, input.params.shiftId, input.body))));
route(E.pauseShift, ({ run, input }) => run(async (c) => getShiftDetail(c, await pauseShift(c, input.params.shiftId, input.body))));
route(E.resumeShift, ({ run, input }) => run(async (c) => getShiftDetail(c, await resumeShift(c, input.params.shiftId, input.body))));
route(E.endShift, ({ run, input }) => run(async (c) => getShiftDetail(c, await endShift(c, input.params.shiftId, input.body))));
route(E.correctTime, ({ run, input }) => run(async (c) => getShiftDetail(c, await correctShiftTime(c, input.params.shiftId, input.body))));
route(E.markMissed, ({ run, input }) => run(async (c) => getShiftDetail(c, await markShiftMissed(c, input.params.shiftId, input.body))));
route(E.setTimeAllocation, ({ run, input }) => run(async (c) => getShiftDetail(c, await setShiftTimeAllocation(c, input.params.shiftId, input.body))));
route(E.requestSwap, ({ run, input }) => run(async (c) => getShiftSwap(c, await requestShiftSwap(c, input.params.shiftId, input.body))));
route(E.listSwaps, ({ ctx, input }) => listShiftSwaps(ctx, input.query));
route(E.acceptSwap, ({ run, input }) => run(async (c) => getShiftSwap(c, await acceptShiftSwap(c, input.params.swapId))));
route(E.declineSwap, ({ run, input }) => run(async (c) => getShiftSwap(c, await declineShiftSwap(c, input.params.swapId, input.body))));
route(E.approveSwap, ({ run, input }) => run(async (c) => getShiftSwap(c, await approveShiftSwap(c, input.params.swapId, input.body))));
route(E.cancelSwap, ({ run, input }) => run(async (c) => getShiftSwap(c, await cancelShiftSwap(c, input.params.swapId))));

// Reports
route(E.saveReportDraft, ({ run, input }) => run(async (c) => getShiftReport(c, await saveShiftReportDraft(c, input.params.reportId, input.body))));
route(E.submitReport, ({ run, input }) => run(async (c) => getShiftReport(c, await submitShiftReport(c, input.params.shiftId, input.body))));
route(E.approveReport, ({ run, input }) => run(async (c) => getShiftReport(c, await approveShiftReport(c, input.params.reportId, input.body))));
route(E.requestReportChanges, ({ run, input }) => run(async (c) => getShiftReport(c, await requestShiftReportChanges(c, input.params.reportId, input.body))));

// Handovers
route(E.listHandovers, ({ ctx, input }) => listHandovers(ctx, input.query));
route(E.getHandover, ({ ctx, input }) => getHandover(ctx, input.params.handoverId));
route(E.handoverCandidates, ({ ctx, input }) => handoverCandidates(ctx, input.params.shiftId));
route(E.createHandover, ({ run, input }) => run(async (c) => getHandover(c, await createHandover(c, input.body))));
route(E.updateHandover, ({ run, input }) => run(async (c) => getHandover(c, await updateHandover(c, input.params.handoverId, input.body))));
route(E.addHandoverItem, ({ run, input }) => run(async (c) => getHandover(c, await addHandoverItem(c, input.params.handoverId, input.body))));
route(E.removeHandoverItem, ({ run, input }) => run(async (c) => getHandover(c, await removeHandoverItem(c, input.params.handoverId, input.params.itemId))));
route(E.submitHandover, ({ run, input }) => run(async (c) => getHandover(c, await submitHandover(c, input.params.handoverId, input.body))));
route(E.acknowledgeHandover, ({ run, input }) => run(async (c) => getHandover(c, await acknowledgeHandover(c, input.params.handoverId, input.body))));
route(E.assignHandoverRecipient, ({ run, input }) => run(async (c) => getHandover(c, await assignHandoverRecipient(c, input.params.handoverId, input.body))));
route(E.resolveHandoverItem, ({ run, input }) => run(async (c) => getHandover(c, await resolveHandoverItem(c, input.params.itemId, input.body))));
route(E.convertHandoverItem, ({ run, input }) => run(async (c) => getHandover(c, await convertHandoverItem(c, input.params.itemId, input.body))));

// Contacts & interactions
route(E.mergePreview, ({ ctx, input }) => ofmContactMergePreview(ctx, input.body));
route(E.merge, ({ run, input }) => run(async (c) => getOfmContact(c, await mergeOfmContacts(c, input.body))));
route(E.listContacts, ({ ctx, input }) => listOfmContacts(ctx, input.query));
route(E.getContact, ({ ctx, input }) => getOfmContact(ctx, input.params.contactId));
route(E.createContact, ({ run, input }) => run(async (c) => getOfmContact(c, await createOfmContact(c, input.body))));
route(E.updateContact, ({ run, input }) => run(async (c) => getOfmContact(c, await updateOfmContact(c, input.params.contactId, input.body))));
route(E.changeContactStage, ({ run, input }) => run(async (c) => getOfmContact(c, await changeContactStage(c, input.params.contactId, input.body))));
route(E.relateContacts, ({ run, input }) => run(async (c) => getOfmContact(c, await relateOfmContacts(c, input.params.contactId, input.body))));
route(E.archiveContact, ({ run, input }) => run(async (c) => getOfmContact(c, await archiveOfmContact(c, input.params.contactId, input.body))));
route(E.restoreContact, ({ run, input }) => run(async (c) => getOfmContact(c, await restoreOfmContact(c, input.params.contactId))));
route(E.requestErasure, ({ run, input }) => run((c) => requestOfmContactErasure(c, input.params.contactId, input.body)));
route(E.listInteractions, ({ ctx, input }) => listOfmInteractions(ctx, input.query));
route(E.createInteraction, ({ run, input }) => run((c) => createOfmInteraction(c, input.body)));
route(E.updateInteraction, ({ run, input }) => run((c) => updateOfmInteraction(c, input.params.interactionId, input.body)));

// Operations
route(E.listOperations, ({ ctx, input }) => listOperations(ctx, input.query));
route(E.getOperation, ({ ctx, input }) => getOperation(ctx, input.params.operationId));
route(E.createOperation, ({ run, input }) => run(async (c) => getOperation(c, await createOperation(c, input.body))));
route(E.updateOperation, ({ run, input }) => run(async (c) => getOperation(c, await updateOperation(c, input.params.operationId, input.body))));
route(E.transitionOperation, ({ run, input }) => run(async (c) => getOperation(c, await transitionOperation(c, input.params.operationId, input.body))));
route(E.createContentBrief, ({ run, input }) => run(async (c) => getOperation(c, await createContentRequestBrief(c, input.params.operationId, input.body))));
route(E.linkContent, ({ run, input }) => run(async (c) => getOperation(c, await linkOperationContent(c, input.params.operationId, input.body))));

// Sale candidates
route(E.checkSaleDuplicate, ({ ctx, input }) => checkSaleDuplicate(ctx, input.query));
route(E.listSaleCandidates, ({ ctx, input }) => listSaleCandidates(ctx, input.query));
route(E.getSaleCandidate, ({ ctx, input }) => getSaleCandidate(ctx, input.params.candidateId));
route(E.createSaleCandidate, ({ run, input }) => run(async (c) => getSaleCandidate(c, await createSaleCandidate(c, input.body))));
route(E.updateSaleCandidate, ({ run, input }) => run(async (c) => getSaleCandidate(c, await updateSaleCandidate(c, input.params.candidateId, input.body))));

// Quality
route(E.listRubrics, ({ ctx }) => listQualityRubrics(ctx));
route(E.createRubricVersion, ({ run, input }) => run((c) => createRubricVersion(c, input.body)));
route(E.publishRubricVersion, ({ run, input }) => run((c) => publishRubricVersion(c, input.params.rubricVersionId)));
route(E.listQuality, ({ ctx, input }) => listQualityReviews(ctx, input.query));
route(E.getQuality, ({ ctx, input }) => getQualityReview(ctx, input.params.reviewId));
route(E.createQuality, ({ run, input }) => run(async (c) => getQualityReview(c, await createQualityReview(c, input.body))));
route(E.updateQuality, ({ run, input }) => run(async (c) => getQualityReview(c, await updateQualityReview(c, input.params.reviewId, input.body))));
route(E.publishQuality, ({ run, input }) => run(async (c) => getQualityReview(c, await publishQualityReview(c, input.params.reviewId))));
route(E.acknowledgeQuality, ({ run, input }) => run(async (c) => getQualityReview(c, await acknowledgeQualityReview(c, input.params.reviewId, input.body))));
route(E.disputeQuality, ({ run, input }) => run(async (c) => getQualityReview(c, await disputeQualityReview(c, input.params.reviewId, input.body))));
route(E.resolveDispute, ({ run, input }) => run(async (c) => getQualityReview(c, await resolveQualityDispute(c, input.params.disputeId, input.body))));
route(E.createImprovementTask, ({ run, input }) => run((c) => createQualityImprovementTask(c, input.params.reviewId, input.body)));
