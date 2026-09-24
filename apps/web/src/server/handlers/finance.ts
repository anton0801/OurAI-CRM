import { financeEndpoints as F } from '@castlane/api-contracts';
import {
  addCompensationAdjustment,
  allocateFinancialEntry,
  approveBudget,
  approveCompensationRule,
  approveCompensationRun,
  archiveFinanceCategory,
  calculateCompensationRun,
  cancelCommitment,
  cancelCompensationRun,
  closeFinancePeriod,
  confirmSaleCandidateToDraft,
  confirmSettlement,
  convertCommitment,
  copyBudget,
  createBudget,
  createCommitment,
  createCompensationRule,
  createCompensationRuleVersion,
  createCompensationRun,
  createFinanceCategory,
  createFinancialEntry,
  createFxRate,
  createSettlement,
  endCompensationRule,
  financePeriodClosePreview,
  financialEntryAllocationPreview,
  getBudget,
  getCampaignFinanceSummary,
  getCommitment,
  getCompensationRule,
  getCompensationRun,
  getDealFinanceSummary,
  getFinanceOverview,
  getFinancePeriodLock,
  getFinancialEntry,
  getFxRate,
  getMemberCompensation,
  getProjectFinanceSummary,
  getSettlement,
  listBudgets,
  listCommitments,
  listCompensationRules,
  listCompensationRuns,
  listFinanceCategories,
  listFinanceOpenItems,
  listFinancePeriods,
  listFinanceSaleCandidates,
  listFinancialEntries,
  listFxRates,
  listSettlements,
  matchSettlement,
  postFinancialEntry,
  recordCompensationPayment,
  rejectFinanceSaleCandidate,
  rejectFinancialEntry,
  reopenFinancePeriod,
  resetBudgetAlert,
  returnCompensationRun,
  reverseCompensationAdjustment,
  reverseFinancialEntry,
  reverseSettlement,
  reverseSettlementAllocation,
  reviseBudget,
  setRevenueAttributions,
  simulateCompensationRule,
  submitBudget,
  submitCompensationRun,
  submitFinancialEntry,
  updateBudget,
  updateCommitment,
  updateCompensationRun,
  updateFinanceCategory,
  updateFinancialEntry,
  updateFxRate,
  updateSettlement,
} from '@castlane/application';
import { route } from '../http/router';

// Categories & FX rates
route(F.categoriesList, ({ ctx, input }) => listFinanceCategories(ctx, input.query));
route(F.categoriesCreate, ({ run, input }) => run((c) => createFinanceCategory(c, input.body)));
route(F.categoriesUpdate, ({ run, input }) => run((c) => updateFinanceCategory(c, input.params.categoryId, input.body)));
route(F.categoriesArchive, ({ run, input }) => run((c) => archiveFinanceCategory(c, input.params.categoryId, input.body)));
route(F.fxRatesList, ({ ctx, input }) => listFxRates(ctx, input.query));
route(F.fxRatesGet, ({ ctx, input }) => getFxRate(ctx, input.params.rateId));
route(F.fxRatesCreate, ({ run, input }) => run(async (c) => getFxRate(c, await createFxRate(c, input.body))));
route(F.fxRatesUpdate, ({ run, input }) => run(async (c) => getFxRate(c, await updateFxRate(c, input.params.rateId, input.body))));

// Entries — commands return the read model built in the same transaction.
route(F.entriesList, ({ ctx, input }) => listFinancialEntries(ctx, input.query));
route(F.entriesGet, ({ ctx, input }) => getFinancialEntry(ctx, input.params.entryId));
route(F.entriesCreate, ({ run, input }) => run(async (c) => getFinancialEntry(c, await createFinancialEntry(c, input.body))));
route(F.entriesUpdate, ({ run, input }) => run(async (c) => getFinancialEntry(c, await updateFinancialEntry(c, input.params.entryId, input.body))));
route(F.entriesSubmit, ({ run, input }) => run(async (c) => getFinancialEntry(c, await submitFinancialEntry(c, input.params.entryId, input.body))));
route(F.entriesPost, ({ run, input }) => run(async (c) => getFinancialEntry(c, await postFinancialEntry(c, input.params.entryId, input.body))));
route(F.entriesReject, ({ run, input }) => run(async (c) => getFinancialEntry(c, await rejectFinancialEntry(c, input.params.entryId, input.body))));
route(F.entriesReverse, ({ run, input }) =>
  run(async (c) => {
    const r = await reverseFinancialEntry(c, input.params.entryId, input.body);
    return { original: await getFinancialEntry(c, r.originalId), reversal: await getFinancialEntry(c, r.reversalId), replacementId: r.replacementId };
  }),
);
route(F.entriesAllocationPreview, ({ ctx, input }) => financialEntryAllocationPreview(ctx, input.params.entryId, input.body));
route(F.entriesAllocate, ({ run, input }) => run(async (c) => getFinancialEntry(c, await allocateFinancialEntry(c, input.params.entryId, input.body))));
route(F.entriesSetAttributions, ({ run, input }) => run(async (c) => getFinancialEntry(c, await setRevenueAttributions(c, input.params.entryId, input.body))));

// Settlements
route(F.settlementsList, ({ ctx, input }) => listSettlements(ctx, input.query));
route(F.settlementsGet, ({ ctx, input }) => getSettlement(ctx, input.params.settlementId));
route(F.settlementsCreate, ({ run, input }) => run(async (c) => getSettlement(c, await createSettlement(c, input.body))));
route(F.settlementsUpdate, ({ run, input }) => run(async (c) => getSettlement(c, await updateSettlement(c, input.params.settlementId, input.body))));
route(F.settlementsConfirm, ({ run, input }) => run(async (c) => getSettlement(c, await confirmSettlement(c, input.params.settlementId, input.body))));
route(F.settlementsMatch, ({ run, input }) => run(async (c) => getSettlement(c, await matchSettlement(c, input.params.settlementId, input.body))));
route(F.settlementsReverseAllocation, ({ run, input }) =>
  run(async (c) => getSettlement(c, await reverseSettlementAllocation(c, input.params.settlementId, input.params.allocationId, input.body))),
);
route(F.settlementsReverse, ({ run, input }) => run(async (c) => getSettlement(c, await reverseSettlement(c, input.params.settlementId, input.body))));
route(F.openItems, ({ ctx, input }) => listFinanceOpenItems(ctx, input.query));

// Budgets & commitments
route(F.budgetsList, ({ ctx, input }) => listBudgets(ctx, input.query));
route(F.budgetsGet, ({ ctx, input }) => getBudget(ctx, input.params.budgetId));
route(F.budgetsCreate, ({ run, input }) => run(async (c) => getBudget(c, await createBudget(c, input.body))));
route(F.budgetsUpdate, ({ run, input }) => run(async (c) => getBudget(c, await updateBudget(c, input.params.budgetId, input.body))));
route(F.budgetsSubmit, ({ run, input }) => run(async (c) => getBudget(c, await submitBudget(c, input.params.budgetId, input.body))));
route(F.budgetsApprove, ({ run, input }) => run(async (c) => getBudget(c, await approveBudget(c, input.params.budgetId, input.body))));
route(F.budgetsRevise, ({ run, input }) => run(async (c) => getBudget(c, await reviseBudget(c, input.params.budgetId, input.body))));
route(F.budgetsCopy, ({ run, input }) => run(async (c) => getBudget(c, await copyBudget(c, input.params.budgetId, input.body))));
route(F.budgetsResetAlert, ({ run, input }) => run(async (c) => getBudget(c, await resetBudgetAlert(c, input.params.budgetId, input.params.alertId, input.body))));
route(F.commitmentsList, ({ ctx, input }) => listCommitments(ctx, input.query));
route(F.commitmentsGet, ({ ctx, input }) => getCommitment(ctx, input.params.commitmentId));
route(F.commitmentsCreate, ({ run, input }) => run(async (c) => getCommitment(c, await createCommitment(c, input.body))));
route(F.commitmentsUpdate, ({ run, input }) => run(async (c) => getCommitment(c, await updateCommitment(c, input.params.commitmentId, input.body))));
route(F.commitmentsCancel, ({ run, input }) => run(async (c) => getCommitment(c, await cancelCommitment(c, input.params.commitmentId, input.body))));
route(F.commitmentsConvert, ({ run, input }) => run((c) => convertCommitment(c, input.params.commitmentId, input.body)));

// Compensation rules & runs
route(F.rulesList, ({ ctx, input }) => listCompensationRules(ctx, input.query));
route(F.rulesGet, ({ ctx, input }) => getCompensationRule(ctx, input.params.ruleId));
route(F.rulesCreate, ({ run, input }) => run(async (c) => getCompensationRule(c, await createCompensationRule(c, input.body))));
route(F.rulesCreateVersion, ({ run, input }) => run(async (c) => getCompensationRule(c, await createCompensationRuleVersion(c, input.params.ruleId, input.body))));
route(F.rulesApprove, ({ run, input }) => run(async (c) => getCompensationRule(c, await approveCompensationRule(c, input.params.ruleId, input.body))));
route(F.rulesEnd, ({ run, input }) => run(async (c) => getCompensationRule(c, await endCompensationRule(c, input.params.ruleId, input.body))));
route(F.rulesSimulate, ({ ctx, input }) => simulateCompensationRule(ctx, input.params.ruleId, input.body));
route(F.runsList, ({ ctx, input }) => listCompensationRuns(ctx, input.query));
route(F.runsGet, ({ ctx, input }) => getCompensationRun(ctx, input.params.runId));
route(F.runsCreate, ({ run, input }) => run(async (c) => getCompensationRun(c, await createCompensationRun(c, input.body))));
route(F.runsUpdate, ({ run, input }) => run(async (c) => getCompensationRun(c, await updateCompensationRun(c, input.params.runId, input.body))));
route(F.runsCalculate, ({ run, input }) => run(async (c) => getCompensationRun(c, await calculateCompensationRun(c, input.params.runId))));
route(F.runsSubmit, ({ run, input }) => run(async (c) => getCompensationRun(c, await submitCompensationRun(c, input.params.runId, input.body))));
route(F.runsReturn, ({ run, input }) => run(async (c) => getCompensationRun(c, await returnCompensationRun(c, input.params.runId, input.body))));
route(F.runsApprove, ({ run, input }) => run(async (c) => getCompensationRun(c, await approveCompensationRun(c, input.params.runId, input.body))));
route(F.runsCancel, ({ run, input }) => run(async (c) => getCompensationRun(c, await cancelCompensationRun(c, input.params.runId, input.body))));
route(F.runsAddAdjustment, ({ run, input }) => run(async (c) => getCompensationRun(c, await addCompensationAdjustment(c, input.params.runId, input.body))));
route(F.adjustmentsReverse, ({ run, input }) => run((c) => reverseCompensationAdjustment(c, input.params.adjustmentId, input.body)));
route(F.runsRecordPayment, ({ run, input }) => run(async (c) => getCompensationRun(c, await recordCompensationPayment(c, input.params.runId, input.body))));
route(F.memberCompensation, ({ ctx, input }) => getMemberCompensation(ctx, input.params.membershipId));

// Periods
route(F.periodsList, ({ ctx }) => listFinancePeriods(ctx));
route(F.periodsClosePreview, ({ ctx, input }) => financePeriodClosePreview(ctx, input.query));
route(F.periodsClose, ({ run, input }) => run(async (c) => getFinancePeriodLock(c, await closeFinancePeriod(c, input.body))));
route(F.periodsReopen, ({ run, input }) => run(async (c) => getFinancePeriodLock(c, await reopenFinancePeriod(c, input.body))));

// Sale candidate reconciliation
route(F.saleCandidatesList, ({ ctx, input }) => listFinanceSaleCandidates(ctx, input.query));
route(F.saleCandidatesConfirm, ({ run, input }) => run((c) => confirmSaleCandidateToDraft(c, input.params.candidateId, input.body)));
route(F.saleCandidatesReject, ({ run, input }) => run((c) => rejectFinanceSaleCandidate(c, input.params.candidateId, input.body)));

// Read models
route(F.overview, ({ ctx, input }) => getFinanceOverview(ctx, input.query));
route(F.projectSummary, ({ ctx, input }) => getProjectFinanceSummary(ctx, input.params.projectId, input.query));
route(F.dealSummary, ({ ctx, input }) => getDealFinanceSummary(ctx, input.params.dealId));
route(F.campaignSummary, ({ ctx, input }) => getCampaignFinanceSummary(ctx, input.params.campaignId));
