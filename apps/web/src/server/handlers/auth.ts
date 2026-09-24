import { authEndpoints as E, setupEndpoints as S } from '@castlane/api-contracts';
import {
  acceptInvitation,
  changePassword,
  confirmMfaSetup,
  describeInvitation,
  describeMe,
  getSetupProgress,
  inviteSetupTeam,
  listOwnSessions,
  randomToken,
  reauthenticate,
  regenerateRecoveryCodes,
  requestNewInvitation,
  requestPasswordReset,
  resetPassword,
  revokeOtherSessions,
  revokeOwnSession,
  saveSetupDirections,
  saveSetupWorkspace,
  setCurrentWorkspace,
  signIn,
  signOut,
  startMfaSetup,
  verifyMfa,
  PRE_CSRF_COOKIE,
  RECOVERY_MESSAGE,
  SESSION_ABSOLUTE_DAYS,
  SESSION_COOKIE,
  type AuthRequestMeta,
  type SignInOutcome,
} from '@castlane/application';
import { AppError } from '@castlane/domain';
import { sessionCsrfToken } from '../http/pipeline';
import { route, type HttpInfo, type ResponseControl } from '../http/router';

const meta = (http: HttpInfo): AuthRequestMeta => ({ requestId: http.requestId, ipHash: http.ipHash, userAgent: http.userAgent });

const setSession = (res: ResponseControl, token: string) => {
  res.cookies.push({ name: SESSION_COOKIE, value: token, maxAgeSeconds: SESSION_ABSOLUTE_DAYS * 86_400 });
};

const outcome = (res: ResponseControl, o: SignInOutcome) => {
  if (o.status === 'signed_in') {
    setSession(res, o.sessionToken);
    return { status: 'signed_in' as const, redirectTo: o.redirectTo };
  }
  return { status: o.status, challengeId: o.challengeToken };
};

route(E.csrf, async ({ http, res }) => {
  const existing = http.cookies.get(PRE_CSRF_COOKIE);
  const token = existing && existing.length >= 20 ? existing : randomToken(24);
  // Readable by the page script (double-submit); carries no authority on its own.
  res.cookies.push({ name: PRE_CSRF_COOKIE, value: token, maxAgeSeconds: 86_400, httpOnly: false });
  return { csrfToken: token };
});

route(E.signIn, async ({ app, input, http, res }) => outcome(res, await signIn(app, input.body, meta(http))));

route(E.mfaVerify, async ({ app, input, http, res }) => {
  const r = await verifyMfa(app, { challengeToken: input.body.challengeId, code: input.body.code, kind: input.body.kind }, meta(http));
  setSession(res, r.sessionToken);
  return { redirectTo: r.redirectTo };
});

route(E.mfaSetupStart, async ({ app, input, session }) => {
  const r = await startMfaSetup(app, { challengeToken: input.body.challengeId, session: input.body.challengeId ? undefined : (session ?? undefined) });
  return { challengeId: r.challengeToken, otpauthUrl: r.otpauthUrl, secret: r.secret, qrSvg: r.qrSvg };
});

route(E.mfaSetupConfirm, async ({ app, input, http, res, session }) => {
  const r = await confirmMfaSetup(app, { challengeToken: input.body.challengeId, code: input.body.code, currentSessionId: session?.id }, meta(http));
  setSession(res, r.sessionToken);
  return { recoveryCodes: r.recoveryCodes, redirectTo: r.redirectTo };
});

route(E.recovery, async ({ app, input, http }) => {
  await requestPasswordReset(app, input.body.email, meta(http));
  return { accepted: true as const, message: RECOVERY_MESSAGE };
});

route(E.reset, async ({ app, input, http }) => {
  await resetPassword(app, input.body.token, input.body.newPassword, meta(http));
  return { ok: true as const };
});

route(E.signOut, async ({ app, session, http, res }) => {
  if (session) await signOut(app, session, meta(http));
  res.cookies.push({ name: SESSION_COOKIE, value: '', expire: true });
  res.headers['clear-site-data'] = '"cache"';
  return { ok: true as const };
});

route(E.me, async ({ app, session }) => {
  if (!session) throw new AppError('UNAUTHENTICATED', 'Sign in again.');
  const me = await describeMe(app, session);
  return { ...me, csrfToken: sessionCsrfToken(app, session) };
});

route(E.reauthenticate, async ({ app, session, input, http }) => {
  const at = await reauthenticate(app, session!, input.body, meta(http));
  return { recentAuthAt: at.toISOString() };
});

route(E.changePassword, async ({ app, session, input, http }) => {
  await changePassword(app, session!, input.body, meta(http));
  return { ok: true as const };
});

route(E.sessions, async ({ app, session }) => listOwnSessions(app.db, session!, app.clock.now()));

route(E.revokeSession, async ({ app, session, input, http }) => {
  await revokeOwnSession(app, session!, input.params.sessionId, meta(http));
  return { ok: true as const };
});

route(E.revokeOtherSessions, async ({ app, session, http }) => ({ revoked: await revokeOtherSessions(app, session!, meta(http)) }));

route(E.regenerateRecoveryCodes, async ({ app, session, http }) => ({ recoveryCodes: await regenerateRecoveryCodes(app, session!, meta(http)) }));

route(E.invitationInfo, async ({ app, input }) => describeInvitation(app, input.params.token));

route(E.acceptInvitation, async ({ app, input, http, res }) => outcome(res, await acceptInvitation(app, input.body, meta(http))));

route(E.requestNewInvitation, async ({ app, input, http }) => {
  await requestNewInvitation(app, input.body.token, meta(http));
  return { accepted: true as const };
});

route(E.switchWorkspace, async ({ app, session, input }) => {
  await setCurrentWorkspace(app, session!, input.body.workspaceId);
  return { ok: true as const };
});

route(S.progress, async ({ ctx }) => getSetupProgress(ctx));
route(S.saveWorkspace, async ({ run, input }) => run((c) => saveSetupWorkspace(c, input.body)));
route(S.saveDirections, async ({ run, input }) => run((c) => saveSetupDirections(c, input.body)));
route(S.inviteTeam, async ({ run, input }) => run((c) => inviteSetupTeam(c, input.body)));
