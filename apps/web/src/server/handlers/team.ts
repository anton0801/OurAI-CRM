import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { directionAdminEndpoints as DA, ownershipEndpoints as O, roleEndpoints as R, settingsEndpoints as S, teamEndpoints as T } from '@castlane/api-contracts';
import {
  acceptOwnershipTransfer,
  addDeny,
  addResponsibility,
  archiveRole,
  assignDirectionLead,
  avatarUploadStatus,
  bulkAssignDirection,
  cancelEmailChange,
  cancelOwnershipTransfer,
  confirmEmailChange,
  createRole,
  currentOwnershipTransfer,
  deactivateMember,
  deactivationPreview,
  directionLeadImpact,
  disableMfa,
  endResponsibility,
  evaluateAccess,
  getDirectionDetail,
  getMember,
  getProfile,
  getRole,
  getWorkspaceSettings,
  grantableRoles,
  grantRole,
  initiateAvatarUpload,
  inviteToWorkspace,
  listInvitationRequests,
  listInvitations,
  listMembers,
  listRoleAssignments,
  listRoles,
  loadAvatarDerivative,
  loadLogoDerivative,
  mailTestStatus,
  memberAccess,
  memberActivity,
  memberAssignments,
  openWork,
  personalData,
  previewRoleImpact,
  previewWorkspaceSettings,
  proposeOwnershipTransfer,
  reactivateMember,
  reorderDirections,
  requestEmailChange,
  resendWorkspaceInvitation,
  resetRole,
  resolveInvitationRequest,
  restoreDirection,
  restoreMember,
  restoreMemberPreview,
  revokeDeny,
  revokeMemberSessions,
  revokeRole,
  revokeWorkspaceInvitation,
  sendTestMail,
  suspendMember,
  transferWork,
  updateMember,
  updateProfile,
  updateRole,
  updateRoleAssignment,
  updateWorkspaceSettings,
  type AppServices,
} from '@castlane/application';
import { AppError } from '@castlane/domain';
import { route, type HttpInfo, type ResponseControl } from '../http/router';

const meta = (http: HttpInfo) => ({ requestId: http.requestId, ipHash: http.ipHash, userAgent: http.userAgent });

/** Stream an image derivative with a private cache (never a shared CDN). */
/**
 * Avatar/logo URLs stay stable when the image changes, so browsers revalidate every time
 * (private, no-cache) and get a cheap 304 while the derivative is unchanged.
 */
const streamImage = async (app: AppServices, res: ResponseControl, d: { storageKey: string; mime: string }, http: HttpInfo) => {
  const etag = `"${createHash('sha256').update(d.storageKey).digest('base64url').slice(0, 27)}"`;
  const headers = { 'cache-control': 'private, no-cache', etag, 'x-content-type-options': 'nosniff' };
  if (http.headers.get('if-none-match') === etag) {
    res.raw = new Response(null, { status: 304, headers });
    return null;
  }
  const obj = await app.storage.getObjectStream(d.storageKey);
  res.raw = new Response(Readable.toWeb(obj.stream) as ReadableStream, { headers: { ...headers, 'content-type': d.mime } });
  return null;
};

// ——— Members ———
route(T.list, ({ ctx, input }) => listMembers(ctx, input.query));
route(T.get, ({ ctx, input }) => getMember(ctx, input.params.membershipId));
route(T.update, ({ run, input }) => run(async (c) => getMember(c, await updateMember(c, input.params.membershipId, input.body))));
route(T.access, ({ ctx, input }) => memberAccess(ctx, input.params.membershipId));
route(T.assignments, ({ ctx, input }) => memberAssignments(ctx, input.params.membershipId));
route(T.activity, ({ ctx, input }) => memberActivity(ctx, input.params.membershipId, input.query));
route(T.addResponsibility, ({ run, input }) => run((c) => addResponsibility(c, input.params.membershipId, input.body)));
route(T.endResponsibility, ({ run, input }) => run((c) => endResponsibility(c, input.params.responsibilityId, input.body.reason)));
route(T.bulkAssignDirection, ({ run, input }) => run((c) => bulkAssignDirection(c, input.body)));
route(T.suspend, ({ run, input }) => run(async (c) => getMember(c, await suspendMember(c, input.params.membershipId, input.body.reason))));
route(T.reactivate, ({ run, input }) => run(async (c) => getMember(c, await reactivateMember(c, input.params.membershipId, input.body.reason))));
route(T.revokeSessions, ({ run, input }) => run((c) => revokeMemberSessions(c, input.params.membershipId, input.body.reason)));
route(T.openWork, ({ ctx, input }) => openWork(ctx, input.params.membershipId));
route(T.transferWork, ({ run, input }) => run((c) => transferWork(c, input.params.membershipId, input.body)));
route(T.deactivationPreview, ({ ctx, input }) => deactivationPreview(ctx, input.params.membershipId, input.body));
route(T.deactivate, ({ run, input }) => run(async (c) => getMember(c, await deactivateMember(c, input.params.membershipId, input.body))));
route(T.restorePreview, ({ ctx, input }) => restoreMemberPreview(ctx, input.params.membershipId));
route(T.restore, ({ run, input }) => run(async (c) => getMember(c, await restoreMember(c, input.params.membershipId, input.body))));

// ——— Grants, denies, evaluation ———
route(T.grantRole, ({ run, input }) => run((c) => grantRole(c, input.body)));
route(T.listRoleAssignments, ({ ctx, input }) => listRoleAssignments(ctx, input.query));
route(T.updateRoleAssignment, ({ run, input }) => run((c) => updateRoleAssignment(c, input.params.assignmentId, input.body)));
route(T.revokeRole, ({ run, input }) => run((c) => revokeRole(c, input.params.assignmentId, input.body.reason)));
route(T.addDeny, ({ run, input }) => run((c) => addDeny(c, input.body)));
route(T.revokeDeny, ({ run, input }) => run((c) => revokeDeny(c, input.params.denyId, input.body.reason)));
route(T.evaluateAccess, ({ ctx, input }) => evaluateAccess(ctx, input.body));

// ——— Invitations ———
route(T.invitations, ({ ctx, input }) => listInvitations(ctx, input.query));
route(T.invite, ({ run, input }) => run((c) => inviteToWorkspace(c, input.body)));
route(T.resendInvitation, ({ run, input }) => run((c) => resendWorkspaceInvitation(c, input.params.invitationId)));
route(T.revokeInvitation, ({ run, input }) => run((c) => revokeWorkspaceInvitation(c, input.params.invitationId)));
route(T.invitationRequests, ({ ctx, input }) => listInvitationRequests(ctx, input.query));
route(T.resolveInvitationRequest, ({ run, input }) => run((c) => resolveInvitationRequest(c, input.params.requestId, input.body)));

// ——— Roles ———
route(R.list, ({ ctx, input }) => listRoles(ctx, input.query));
route(R.grantable, ({ ctx }) => grantableRoles(ctx));
route(R.get, ({ ctx, input }) => getRole(ctx, input.params.roleId));
route(R.create, ({ run, input }) => run(async (c) => getRole(c, await createRole(c, input.body))));
route(R.update, ({ run, input }) => run(async (c) => getRole(c, await updateRole(c, input.params.roleId, input.body))));
route(R.previewImpact, ({ ctx, input }) => previewRoleImpact(ctx, input.params.roleId, input.body));
route(R.reset, ({ run, input }) => run(async (c) => getRole(c, await resetRole(c, input.params.roleId))));
route(R.archive, ({ run, input }) => run(async (c) => getRole(c, await archiveRole(c, input.params.roleId, input.body.reason))));

// ——— Ownership ———
route(O.current, ({ ctx }) => currentOwnershipTransfer(ctx));
route(O.propose, ({ run, input }) => run((c) => proposeOwnershipTransfer(c, input.body)));
route(O.accept, ({ run, input }) => run((c) => acceptOwnershipTransfer(c, input.params.transferId)));
route(O.cancel, ({ run, input }) => run((c) => cancelOwnershipTransfer(c, input.params.transferId, input.body.reason)));

// ——— Directions (S12 extensions) ———
route(DA.get, ({ ctx, input }) => getDirectionDetail(ctx, input.params.directionId));
route(DA.leadImpact, ({ ctx, input }) => directionLeadImpact(ctx, input.params.directionId, input.body));
route(DA.assignLead, ({ run, input }) => run(async (c) => getDirectionDetail(c, await assignDirectionLead(c, input.params.directionId, input.body))));
route(DA.restore, ({ run, input }) => run(async (c) => getDirectionDetail(c, await restoreDirection(c, input.params.directionId))));
route(DA.reorder, ({ run, input }) => run((c) => reorderDirections(c, input.body)));

// ——— Workspace settings ———
route(S.workspace, ({ ctx }) => getWorkspaceSettings(ctx));
route(S.previewWorkspace, ({ ctx, input }) => previewWorkspaceSettings(ctx, input.body));
route(S.updateWorkspace, ({ run, input }) => run((c) => updateWorkspaceSettings(c, input.body)));
route(S.testMail, ({ run }) => run((c) => sendTestMail(c)));
route(S.mailTest, ({ ctx, input }) => mailTestStatus(ctx, input.params.messageId));
route(S.logoImage, async ({ ctx, input, res, http }) => streamImage(ctx.app, res, await loadLogoDerivative(ctx, input.query.size), http));

// ——— Personal settings ———
route(S.me, ({ ctx }) => getProfile(ctx));
route(S.updateMe, ({ run, input }) => run((c) => updateProfile(c, input.body)));
route(S.avatarUpload, ({ run, input }) => run((c) => initiateAvatarUpload(c, input.body)));
route(S.avatarStatus, ({ ctx, input }) => avatarUploadStatus(ctx, input.params.assetId));
route(S.emailChange, ({ run, input }) => run((c) => requestEmailChange(c, input.body)));
route(S.cancelEmailChange, ({ run }) => run((c) => cancelEmailChange(c)));
route(S.confirmEmailChange, ({ app, input, http }) => confirmEmailChange(app, input.body.token, meta(http)));
route(S.disableMfa, async ({ app, session, http }) => {
  if (!session) throw new AppError('UNAUTHENTICATED', 'Sign in again.');
  return disableMfa(app, session, meta(http));
});
route(S.personalData, ({ ctx }) => personalData(ctx));
route(S.avatarImage, async ({ app, session, input, res, http }) => {
  if (!session) throw new AppError('UNAUTHENTICATED', 'Sign in again.');
  return streamImage(app, res, await loadAvatarDerivative(app, session.userId, input.params.userId, input.query.size), http);
});
