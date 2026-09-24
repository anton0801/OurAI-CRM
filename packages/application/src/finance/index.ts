/**
 * Finance module public surface. Names are finance-specific on purpose: the application barrel is
 * shared by every module, so generic names (getRun, listRules, listCategories…) would collide.
 */
import './registrations';
import './datasets';

export {
  listCategories as listFinanceCategories,
  getCategory as getFinanceCategory,
  createCategory as createFinanceCategory,
  updateCategory as updateFinanceCategory,
  archiveCategory as archiveFinanceCategory,
  listFxRates,
  getFxRate,
  createFxRate,
  updateFxRate,
} from './categories';

export {
  listEntries as listFinancialEntries,
  getEntry as getFinancialEntry,
  createEntry as createFinancialEntry,
  updateEntry as updateFinancialEntry,
  submitEntry as submitFinancialEntry,
  postEntry as postFinancialEntry,
  postEntryCore as postFinancialEntryInternal,
  rejectEntry as rejectFinancialEntry,
  reverseEntry as reverseFinancialEntry,
  allocationPreview as financialEntryAllocationPreview,
  allocateEntry as allocateFinancialEntry,
  setAttributions as setRevenueAttributions,
  entryDisplayState as financialEntryDisplayState,
  type EntryInput as FinancialEntryInput,
  type CreateEntryOptions as FinancialEntryCreateOptions,
} from './entries';

export {
  listSettlements,
  getSettlement,
  createSettlement,
  updateSettlement,
  confirmSettlement,
  matchSettlement,
  reverseSettlementAllocation,
  reverseSettlement,
  listOpenItems as listFinanceOpenItems,
  PAYMENT_EXPLANATION,
} from './settlements';

export { documentOutstanding as financeDocumentOutstanding, runPayables as compensationRunPayables } from './payables';

export {
  listBudgets,
  getBudget,
  createBudget,
  updateBudget,
  submitBudget,
  approveBudget,
  reviseBudget,
  copyBudget,
  resetBudgetAlert,
  archiveBudget,
  listCommitments,
  getCommitment,
  createCommitment,
  updateCommitment,
  cancelCommitment,
  convertCommitment,
} from './budgets';
export { evaluateBudgetAlerts } from './alerts';

export {
  listPeriods as listFinancePeriods,
  closePreview as financePeriodClosePreview,
  closePeriod as closeFinancePeriod,
  reopenPeriod as reopenFinancePeriod,
  getPeriodLock as getFinancePeriodLock,
  lockedPeriodFor as financeLockedPeriodFor,
} from './periods-exports';

export {
  listSaleCandidates as listFinanceSaleCandidates,
  getSaleCandidate as getFinanceSaleCandidate,
  confirmSaleCandidate as confirmSaleCandidateToDraft,
  rejectSaleCandidate as rejectFinanceSaleCandidate,
} from './sale-candidates';

export { calculateCompensation } from './compensation-calc';
export {
  listRules as listCompensationRules,
  getRule as getCompensationRule,
  createRule as createCompensationRule,
  createRuleVersion as createCompensationRuleVersion,
  approveRule as approveCompensationRule,
  endRule as endCompensationRule,
  archiveRule as archiveCompensationRule,
  simulateRule as simulateCompensationRule,
} from './compensation-rules';
export {
  listRuns as listCompensationRuns,
  getRun as getCompensationRun,
  createRun as createCompensationRun,
  updateRun as updateCompensationRun,
  calculateRun as calculateCompensationRun,
  submitRun as submitCompensationRun,
  returnRun as returnCompensationRun,
  approveRun as approveCompensationRun,
  cancelRun as cancelCompensationRun,
  addRunAdjustment as addCompensationAdjustment,
  reverseAdjustment as reverseCompensationAdjustment,
  recordRunPayment as recordCompensationPayment,
} from './compensation-runs';

export {
  financeOverview as getFinanceOverview,
  projectFinanceSummary as getProjectFinanceSummary,
  dealFinanceSummary as getDealFinanceSummary,
  campaignFinanceSummary as getCampaignFinanceSummary,
  memberCompensation as getMemberCompensation,
} from './overview';
