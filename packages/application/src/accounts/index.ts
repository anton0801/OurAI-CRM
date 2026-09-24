/**
 * Accounts module (S18–S20). Other modules may use `accountScope` / `scopeOfAccount` /
 * `accountVisibility` to authorise records that belong to an account, and `loadAccount` to read one.
 */
export { accountScope, scopeOfAccount, accountVisibility, openAssigneeIds, type AccountRow, type AccountStatus } from './scope';
export {
  ACCOUNT_TRANSITIONS,
  loadAccount,
  listAccounts,
  getAccount,
  listAccountAssignments,
  previewAccountUrl,
  createAccount,
  updateAccount,
  transitionAccount,
  restoreAccount,
  accountArchivePreview,
  accountObligations,
  accountLabel,
  type ListAccountsInput,
  type AccountInput,
} from './accounts';
export { assignAccountMember, updateAccountAssignment, endAccountAssignment, bulkAssignAccounts } from './assignments';
export { accountTransferPreview, transferAccount, accountHistory, accountActivity } from './transfer';
import './datasets';
import './registrations';
