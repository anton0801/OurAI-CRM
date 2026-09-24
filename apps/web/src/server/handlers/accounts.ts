import { accountEndpoints as E } from '@castlane/api-contracts';
import {
  accountActivity,
  accountArchivePreview,
  accountHistory,
  accountTransferPreview,
  assignAccountMember,
  bulkAssignAccounts,
  createAccount,
  endAccountAssignment,
  getAccount,
  listAccountAssignments,
  listAccounts,
  previewAccountUrl,
  restoreAccount,
  transferAccount,
  transitionAccount,
  updateAccount,
  updateAccountAssignment,
} from '@castlane/application';
import { route } from '../http/router';

route(E.list, ({ ctx, input }) => listAccounts(ctx, input.query));
route(E.get, ({ ctx, input }) => getAccount(ctx, input.params.accountId));
route(E.urlPreview, ({ ctx, input }) => previewAccountUrl(ctx, input.query));
// Commands return the fresh read model built inside the same transaction.
route(E.create, ({ run, input }) => run(async (c) => getAccount(c, await createAccount(c, input.body))));
route(E.update, ({ run, input }) => run(async (c) => getAccount(c, await updateAccount(c, input.params.accountId, input.body))));
route(E.transition, ({ run, input }) => run(async (c) => getAccount(c, await transitionAccount(c, input.params.accountId, input.body))));
route(E.restore, ({ run, input }) => run(async (c) => getAccount(c, await restoreAccount(c, input.params.accountId, input.body))));
route(E.archivePreview, ({ ctx, input }) => accountArchivePreview(ctx, input.params.accountId));
route(E.transferPreview, ({ ctx, input }) => accountTransferPreview(ctx, input.params.accountId, input.query.targetProjectId));
route(E.transfer, ({ run, input }) => run(async (c) => getAccount(c, await transferAccount(c, input.params.accountId, input.body))));
route(E.history, ({ ctx, input }) => accountHistory(ctx, input.params.accountId));
route(E.activity, ({ ctx, input }) => accountActivity(ctx, input.params.accountId, input.query));
route(E.assignments, ({ ctx, input }) => listAccountAssignments(ctx, input.params.accountId, input.query));
route(E.assign, ({ run, input }) => run((c) => assignAccountMember(c, input.params.accountId, input.body)));
route(E.updateAssignment, ({ run, input }) => run((c) => updateAccountAssignment(c, input.params.accountId, input.params.assignmentId, input.body)));
route(E.endAssignment, ({ run, input }) => run((c) => endAccountAssignment(c, input.params.accountId, input.params.assignmentId, input.body.reason)));
route(E.bulkAssign, ({ run, input }) => run((c) => bulkAssignAccounts(c, input.body)));
