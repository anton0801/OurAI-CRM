import { and, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import {
  authChallenges,
  memberships,
  passwordResetTokens,
  recoveryCodes,
  roleAssignments,
  roles,
  sessions,
  userPreferences,
  users,
  withTransaction,
  workspaces,
  type Db,
  type DbOrTx,
} from '@castlane/database';
import { AppError, newId, normalizeEmail } from '@castlane/domain';
import { auditRaw } from '../core/audit';
import type { AppServices } from '../core/context';
import { decryptSecret, encryptSecret, randomToken, sha256 } from '../core/crypto';
import { enqueueJob } from '../core/jobs';
import { generateRecoveryCodes, hashRecoveryCode, newTotpSecret, otpauthUrl, qrSvg, verifyTotp } from './mfa';
import { dummyVerify, hashPassword, validateNewPassword, verifyPassword } from './passwords';
import { checkBlocked, clearBucket, hitBucket, progressiveDelay, rateLimited } from './rate-limit';
import { createSession, revokeSession, revokeUserSessions, type SessionRow } from './sessions';

export interface AuthRequestMeta {
  requestId: string;
  ipHash: string | null;
  userAgent: string | null;
}

export type SignInOutcome =
  | { status: 'signed_in'; sessionToken: string; redirectTo: string }
  | { status: 'mfa_required'; challengeToken: string }
  | { status: 'mfa_setup_required'; challengeToken: string };

const CHALLENGE_TTL_MS = 10 * 60_000;
const MAX_CHALLENGE_ATTEMPTS = 5;
const FAIL_LIMIT = 5;
const FAIL_WINDOW_S = 15 * 60;

const invalidCredentials = () => new AppError('UNAUTHENTICATED', 'The e-mail or password is incorrect.');

/** Only same-origin relative paths are accepted as post-login redirect targets. */
export const safeReturnTo = (value: string | null | undefined): string | null => {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\') || value.length > 500) return null;
  if (value.startsWith('/auth/') || value.startsWith('/api/')) return null;
  return value;
};

/** MFA is mandatory for Owner/Admin/finance approvers and when a workspace requires it for everyone. */
export const userRequiresMfa = async (db: DbOrTx, userId: string, at: Date): Promise<boolean> => {
  const rows = await db
    .select({ key: roles.key, permissions: roles.permissions, settings: workspaces.settings })
    .from(memberships)
    .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
    .leftJoin(
      roleAssignments,
      and(
        eq(roleAssignments.membershipId, memberships.id),
        isNull(roleAssignments.revokedAt),
        sql`${roleAssignments.validFrom} <= ${at}`,
        sql`(${roleAssignments.validTo} IS NULL OR ${roleAssignments.validTo} > ${at})`,
      ),
    )
    .leftJoin(roles, eq(roles.id, roleAssignments.roleId))
    .where(and(eq(memberships.userId, userId), eq(memberships.status, 'active')));
  const approverPerms = ['finance.post', 'compensation.runs.approve', 'payments.record', 'finance.close-period'];
  return rows.some(
    (r) =>
      r.settings?.mfaPolicy?.requiredForAll ||
      (!!r.key && !!r.settings?.mfaPolicy?.requiredRoleKeys?.includes(r.key)) ||
      r.key === 'owner' ||
      r.key === 'admin' ||
      (r.permissions ?? []).some((p) => approverPerms.includes(p)),
  );
};

/** Where to send a freshly signed-in user. */
export const landingPath = async (db: DbOrTx, userId: string, returnTo?: string | null): Promise<string> => {
  const rows = await db
    .select({ id: workspaces.id, setupStep: workspaces.setupStep, roleKey: roles.key, permissions: roles.permissions })
    .from(memberships)
    .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
    .leftJoin(roleAssignments, and(eq(roleAssignments.membershipId, memberships.id), isNull(roleAssignments.revokedAt)))
    .leftJoin(roles, eq(roles.id, roleAssignments.roleId))
    .where(and(eq(memberships.userId, userId), eq(memberships.status, 'active')));
  const ownerPending = rows.find((r) => r.roleKey === 'owner' && r.setupStep !== 'completed');
  if (ownerPending) return `/setup/${ownerPending.setupStep === 'workspace' ? 'workspace' : ownerPending.setupStep}?w=${ownerPending.id}`;
  const safe = safeReturnTo(returnTo);
  if (safe) {
    // A workspace route is a destination only while the user is still an active member of that
    // workspace (T011: after an expired session, sign-in returns to a route the user can open;
    // anything else falls back to the default landing instead of a dead end or an existence probe).
    const workspaceId = /^\/w\/([^/?#]+)/.exec(safe)?.[1];
    if (!workspaceId || rows.some((r) => r.id === workspaceId)) return safe;
  }
  const first = rows[0];
  if (!first) return '/auth/no-workspace';
  // Leads (roles that manage a project team or the workspace) land on Overview; staff on My Work (§17).
  const lead = rows.some((r) => r.id === first.id && (r.roleKey === 'owner' || (r.permissions ?? []).includes('project.members.manage')));
  return `/w/${first.id}/${lead ? 'overview' : 'my-work'}`;
};

const createChallenge = async (
  db: DbOrTx,
  userId: string,
  purpose: 'mfa_verify' | 'mfa_setup',
  at: Date,
  returnTo?: string | null,
): Promise<string> => {
  const token = randomToken(32);
  await db.insert(authChallenges).values({
    id: newId(),
    userId,
    tokenHash: sha256(token),
    purpose,
    expiresAt: new Date(at.getTime() + CHALLENGE_TTL_MS),
    returnTo: safeReturnTo(returnTo),
    createdAt: at,
  });
  return token;
};

const loadChallenge = async (db: DbOrTx, token: string, at: Date) => {
  const [c] = await db
    .select()
    .from(authChallenges)
    .where(and(eq(authChallenges.tokenHash, sha256(token)), isNull(authChallenges.consumedAt), gt(authChallenges.expiresAt, at)))
    .limit(1);
  if (!c) throw new AppError('UNAUTHENTICATED', 'This verification step expired. Sign in again.');
  if (c.attempts >= MAX_CHALLENGE_ATTEMPTS) throw new AppError('RATE_LIMITED', 'Too many attempts. Sign in again.', { retryAfterSeconds: 60 });
  return c;
};

/** Finish a password-verified sign-in: MFA verify, MFA setup, or a session. */
export const completePasswordStep = async (
  app: AppServices,
  db: DbOrTx,
  user: typeof users.$inferSelect,
  meta: AuthRequestMeta,
  returnTo?: string | null,
): Promise<SignInOutcome> => {
  const at = app.clock.now();
  if (user.mfaEnabledAt && user.mfaSecretEnc) {
    return { status: 'mfa_required', challengeToken: await createChallenge(db, user.id, 'mfa_verify', at, returnTo) };
  }
  if (user.mustChangePassword) {
    // F01: a temporary password is replaced first; the limited session can only change the password,
    // then MFA setup (when required) happens before any workspace data is reachable.
    const s = await createSession(db, user.id, at, { userAgent: meta.userAgent, ipHash: meta.ipHash }, { mfaVerified: false });
    return { status: 'signed_in', sessionToken: s.token, redirectTo: `/auth/change-password?returnTo=${encodeURIComponent(safeReturnTo(returnTo) ?? '/')}` };
  }
  if (await userRequiresMfa(db, user.id, at)) {
    return { status: 'mfa_setup_required', challengeToken: await createChallenge(db, user.id, 'mfa_setup', at, returnTo) };
  }
  const s = await createSession(db, user.id, at, { userAgent: meta.userAgent, ipHash: meta.ipHash }, { mfaVerified: false });
  await auditRaw(db, { action: 'auth.sign_in', workspaceId: null, actorUserId: user.id, actorKind: 'user', entityType: 'user', entityId: user.id, at, requestId: meta.requestId, ipHash: meta.ipHash });
  return { status: 'signed_in', sessionToken: s.token, redirectTo: await landingPath(db, user.id, returnTo) };
};

export const signIn = async (
  app: AppServices,
  input: { email: string; password: string; returnTo?: string },
  meta: AuthRequestMeta,
): Promise<SignInOutcome> => {
  const db = app.db;
  const at = app.clock.now();
  const email = normalizeEmail(input.email);
  const accountKey = `auth:acct:${sha256(email)}`;
  const ipKey = meta.ipHash ? `auth:ip:${meta.ipHash}` : null;
  const blocked = await checkBlocked(db, [accountKey, ...(ipKey ? [ipKey] : [])], at);
  if (blocked) throw rateLimited(blocked);

  const [user] = await db.select().from(users).where(eq(users.normalizedEmail, email)).limit(1);
  const ok = user ? await verifyPassword(user.passwordHash, input.password) : (await dummyVerify(input.password), false);
  if (!user || !ok || user.status !== 'active') {
    const r = await hitBucket(db, accountKey, { limit: FAIL_LIMIT, windowSeconds: FAIL_WINDOW_S, at });
    if (ipKey) await hitBucket(db, ipKey, { limit: FAIL_LIMIT * 4, windowSeconds: FAIL_WINDOW_S, at });
    await auditRaw(db, {
      action: 'auth.sign_in_failed',
      workspaceId: null,
      actorUserId: user?.id ?? null,
      actorKind: 'anonymous',
      at,
      requestId: meta.requestId,
      ipHash: meta.ipHash,
      metadata: { reason: !user ? 'unknown_account' : !ok ? 'bad_password' : 'disabled' },
    });
    await progressiveDelay(r.count);
    if (r.blockedUntil && r.blockedUntil > at) throw rateLimited(Math.ceil((r.blockedUntil.getTime() - at.getTime()) / 1000));
    throw invalidCredentials();
  }
  await clearBucket(db, accountKey);
  return completePasswordStep(app, db, user, meta, input.returnTo);
};

export const verifyMfa = async (
  app: AppServices,
  input: { challengeToken: string; code: string; kind: 'totp' | 'recovery' },
  meta: AuthRequestMeta,
): Promise<{ sessionToken: string; redirectTo: string }> => {
  const at = app.clock.now();
  // A failed code is committed (attempt counter + audit) before the error is raised: throwing
  // inside the transaction would roll both back and defeat the rate limit.
  const result = await withTransaction(app.db, async (tx): Promise<{ sessionToken: string; redirectTo: string } | { failed: 'totp' | 'recovery' }> => {
    const c = await loadChallenge(tx, input.challengeToken, at);
    if (c.purpose !== 'mfa_verify') throw new AppError('UNAUTHENTICATED', 'This verification step is not valid.');
    const [user] = await tx.select().from(users).where(eq(users.id, c.userId)).for('update');
    if (!user || user.status !== 'active' || !user.mfaSecretEnc) throw new AppError('UNAUTHENTICATED', 'Sign in again.');

    let ok = false;
    if (input.kind === 'recovery') {
      const consumed = await tx
        .update(recoveryCodes)
        .set({ usedAt: at })
        .where(
          and(
            eq(recoveryCodes.userId, user.id),
            eq(recoveryCodes.codeHash, hashRecoveryCode(input.code)),
            isNull(recoveryCodes.usedAt),
            isNull(recoveryCodes.revokedAt),
          ),
        )
        .returning({ id: recoveryCodes.id });
      ok = consumed.length === 1;
    } else {
      const step = verifyTotp(decryptSecret(user.mfaSecretEnc, app.config.MFA_ENCRYPTION_KEY), input.code, at);
      if (step !== null && (user.mfaLastStep === null || step > user.mfaLastStep)) {
        ok = true;
        await tx.update(users).set({ mfaLastStep: step }).where(eq(users.id, user.id));
      }
    }
    if (!ok) {
      await tx.update(authChallenges).set({ attempts: c.attempts + 1 }).where(eq(authChallenges.id, c.id));
      await auditRaw(tx, { action: 'auth.mfa_failed', workspaceId: null, actorUserId: user.id, actorKind: 'user', at, requestId: meta.requestId, ipHash: meta.ipHash, metadata: { kind: input.kind } });
      return { failed: input.kind };
    }
    await tx.update(authChallenges).set({ consumedAt: at }).where(eq(authChallenges.id, c.id));
    const s = await createSession(tx, user.id, at, { userAgent: meta.userAgent, ipHash: meta.ipHash }, { mfaVerified: true });
    await auditRaw(tx, { action: input.kind === 'recovery' ? 'auth.sign_in_recovery_code' : 'auth.sign_in', workspaceId: null, actorUserId: user.id, actorKind: 'user', entityType: 'user', entityId: user.id, at, requestId: meta.requestId, ipHash: meta.ipHash });
    return { sessionToken: s.token, redirectTo: await landingPath(tx, user.id, c.returnTo) };
  });
  if ('failed' in result) throw new AppError('UNAUTHENTICATED', result.failed === 'recovery' ? 'This recovery code is not valid.' : 'The verification code is not valid.');
  return result;
};

/** Begin TOTP setup from a setup challenge, or from an authenticated session with recent auth. */
export const startMfaSetup = async (
  app: AppServices,
  input: { challengeToken?: string; session?: SessionRow },
): Promise<{ challengeToken: string; otpauthUrl: string; secret: string; qrSvg: string }> => {
  const at = app.clock.now();
  return withTransaction(app.db, async (tx) => {
    let userId: string;
    let challengeToken: string;
    if (input.challengeToken) {
      const c = await loadChallenge(tx, input.challengeToken, at);
      if (c.purpose !== 'mfa_setup') throw new AppError('UNAUTHENTICATED', 'This verification step is not valid.');
      userId = c.userId;
      challengeToken = input.challengeToken;
    } else if (input.session) {
      const s = input.session;
      if (!s.recentAuthAt || at.getTime() - s.recentAuthAt.getTime() > 15 * 60_000)
        throw new AppError('RECENT_AUTH_REQUIRED', 'Confirm your password to continue.');
      userId = s.userId;
      challengeToken = await createChallenge(tx, userId, 'mfa_setup', at);
    } else throw new AppError('UNAUTHENTICATED', 'Sign in again.');

    const [user] = await tx.select().from(users).where(eq(users.id, userId));
    if (!user) throw new AppError('UNAUTHENTICATED', 'Sign in again.');
    const secret = newTotpSecret();
    await tx
      .update(authChallenges)
      .set({ pendingSecretEnc: encryptSecret(secret, app.config.MFA_ENCRYPTION_KEY) })
      .where(eq(authChallenges.tokenHash, sha256(challengeToken)));
    const url = otpauthUrl(secret, user.displayEmail);
    return { challengeToken, otpauthUrl: url, secret, qrSvg: await qrSvg(url) };
  });
};

export const confirmMfaSetup = async (
  app: AppServices,
  input: { challengeToken: string; code: string; currentSessionId?: string },
  meta: AuthRequestMeta,
): Promise<{ sessionToken: string; recoveryCodes: string[]; redirectTo: string }> => {
  const at = app.clock.now();
  // As in verifyMfa, the failed attempt is committed before the error is raised.
  const result = await withTransaction(app.db, async (tx): Promise<{ sessionToken: string; recoveryCodes: string[]; redirectTo: string } | { failed: true }> => {
    const c = await loadChallenge(tx, input.challengeToken, at);
    if (c.purpose !== 'mfa_setup' || !c.pendingSecretEnc) throw new AppError('UNAUTHENTICATED', 'Start the setup again.');
    const secret = decryptSecret(c.pendingSecretEnc, app.config.MFA_ENCRYPTION_KEY);
    const step = verifyTotp(secret, input.code, at);
    if (step === null) {
      await tx.update(authChallenges).set({ attempts: c.attempts + 1 }).where(eq(authChallenges.id, c.id));
      await auditRaw(tx, { action: 'auth.mfa_failed', workspaceId: null, actorUserId: c.userId, actorKind: 'user', at, requestId: meta.requestId, ipHash: meta.ipHash, metadata: { kind: 'setup' } });
      return { failed: true };
    }
    await tx
      .update(users)
      .set({ mfaSecretEnc: encryptSecret(secret, app.config.MFA_ENCRYPTION_KEY), mfaEnabledAt: at, mfaLastStep: step, updatedAt: at })
      .where(eq(users.id, c.userId));
    await tx.update(recoveryCodes).set({ revokedAt: at }).where(and(eq(recoveryCodes.userId, c.userId), isNull(recoveryCodes.usedAt), isNull(recoveryCodes.revokedAt)));
    const codes = generateRecoveryCodes();
    const batchId = newId();
    for (const code of codes)
      await tx.insert(recoveryCodes).values({ id: newId(), userId: c.userId, batchId, codeHash: hashRecoveryCode(code), createdAt: at });
    await tx.update(authChallenges).set({ consumedAt: at }).where(eq(authChallenges.id, c.id));
    if (input.currentSessionId) await revokeSession(tx, input.currentSessionId, at, 'mfa_enabled');
    const s = await createSession(tx, c.userId, at, { userAgent: meta.userAgent, ipHash: meta.ipHash }, { mfaVerified: true });
    await auditRaw(tx, { action: 'auth.mfa_enabled', workspaceId: null, actorUserId: c.userId, actorKind: 'user', entityType: 'user', entityId: c.userId, at, requestId: meta.requestId, ipHash: meta.ipHash });
    return { sessionToken: s.token, recoveryCodes: codes, redirectTo: await landingPath(tx, c.userId, c.returnTo) };
  });
  if ('failed' in result)
    throw new AppError('VALIDATION_FAILED', 'The verification code is not valid.', {
      fieldErrors: [{ field: 'code', code: 'INVALID_CODE', message: 'The verification code is not valid.' }],
    });
  return result;
};

export const regenerateRecoveryCodes = async (app: AppServices, session: SessionRow, meta: AuthRequestMeta): Promise<string[]> => {
  const at = app.clock.now();
  if (!session.recentAuthAt || at.getTime() - session.recentAuthAt.getTime() > 15 * 60_000)
    throw new AppError('RECENT_AUTH_REQUIRED', 'Confirm your password to continue.');
  return withTransaction(app.db, async (tx) => {
    const [user] = await tx.select().from(users).where(eq(users.id, session.userId));
    if (!user?.mfaEnabledAt) throw new AppError('INVALID_STATE', 'Two-factor authentication is not enabled.');
    await tx.update(recoveryCodes).set({ revokedAt: at }).where(and(eq(recoveryCodes.userId, user.id), isNull(recoveryCodes.usedAt), isNull(recoveryCodes.revokedAt)));
    const codes = generateRecoveryCodes();
    const batchId = newId();
    for (const code of codes) await tx.insert(recoveryCodes).values({ id: newId(), userId: user.id, batchId, codeHash: hashRecoveryCode(code), createdAt: at });
    await auditRaw(tx, { action: 'auth.recovery_codes_regenerated', workspaceId: null, actorUserId: user.id, actorKind: 'user', at, requestId: meta.requestId, ipHash: meta.ipHash });
    return codes;
  });
};

export const RECOVERY_MESSAGE = 'If an account exists, reset instructions have been sent.';

export const requestPasswordReset = async (app: AppServices, email: string, meta: AuthRequestMeta): Promise<void> => {
  const at = app.clock.now();
  const normalized = normalizeEmail(email);
  const key = `recovery:${sha256(normalized)}`;
  const blocked = await checkBlocked(app.db, [key], at);
  if (blocked) return; // Silently accepted: never reveals account existence or rate state.
  await hitBucket(app.db, key, { limit: 5, windowSeconds: 3600, at });
  await withTransaction(app.db, async (tx) => {
    const [user] = await tx.select().from(users).where(eq(users.normalizedEmail, normalized)).limit(1);
    if (!user || user.status !== 'active') return;
    await tx
      .update(passwordResetTokens)
      .set({ revokedAt: at })
      .where(and(eq(passwordResetTokens.userId, user.id), isNull(passwordResetTokens.usedAt), isNull(passwordResetTokens.revokedAt)));
    const token = randomToken(32);
    await tx.insert(passwordResetTokens).values({
      id: newId(),
      userId: user.id,
      tokenHash: sha256(token),
      expiresAt: new Date(at.getTime() + 30 * 60_000),
      createdAt: at,
    });
    await enqueueJob(tx, {
      type: 'mail.send',
      workspaceId: null,
      payload: {
        template: 'passwordReset',
        to: user.displayEmail,
        vars: { resetUrl: `${app.config.APP_ORIGIN}/auth/reset/${token}` },
        related: { entityType: 'user', entityId: user.id },
      },
    });
    await auditRaw(tx, { action: 'auth.password_reset_requested', workspaceId: null, actorUserId: user.id, actorKind: 'anonymous', at, requestId: meta.requestId, ipHash: meta.ipHash });
  });
};

export const resetPassword = async (app: AppServices, token: string, newPassword: string, meta: AuthRequestMeta): Promise<void> => {
  const at = app.clock.now();
  await withTransaction(app.db, async (tx) => {
    const [row] = await tx
      .select()
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.tokenHash, sha256(token)))
      .for('update')
      .limit(1);
    if (!row || row.usedAt || row.revokedAt || row.expiresAt <= at)
      throw new AppError('INVALID_STATE', 'This reset link is invalid or has already been used. Request a new one.');
    const [user] = await tx.select().from(users).where(eq(users.id, row.userId));
    if (!user || user.status !== 'active') throw new AppError('INVALID_STATE', 'This reset link is invalid.');
    validateNewPassword(newPassword, { email: user.normalizedEmail });
    await tx
      .update(users)
      .set({ passwordHash: await hashPassword(newPassword), passwordChangedAt: at, mustChangePassword: false, updatedAt: at, rowVersion: sql`${users.rowVersion} + 1` })
      .where(eq(users.id, user.id));
    await tx.update(passwordResetTokens).set({ usedAt: at }).where(eq(passwordResetTokens.id, row.id));
    await revokeUserSessions(tx, user.id, at, 'password_reset');
    await enqueueJob(tx, {
      type: 'mail.send',
      workspaceId: null,
      payload: { template: 'securityAlert', to: user.displayEmail, vars: { event: 'Your password was reset', when: at.toISOString() } },
    });
    await auditRaw(tx, { action: 'auth.password_reset', workspaceId: null, actorUserId: user.id, actorKind: 'user', entityType: 'user', entityId: user.id, at, requestId: meta.requestId, ipHash: meta.ipHash });
  });
};

export const changePassword = async (
  app: AppServices,
  session: SessionRow,
  input: { currentPassword: string; newPassword: string },
  meta: AuthRequestMeta,
): Promise<void> => {
  const at = app.clock.now();
  await withTransaction(app.db, async (tx) => {
    const [user] = await tx.select().from(users).where(eq(users.id, session.userId)).for('update');
    if (!user) throw new AppError('UNAUTHENTICATED', 'Sign in again.');
    if (!(await verifyPassword(user.passwordHash, input.currentPassword)))
      throw new AppError('VALIDATION_FAILED', 'The current password is incorrect.', {
        fieldErrors: [{ field: 'currentPassword', code: 'INCORRECT', message: 'The current password is incorrect.' }],
      });
    validateNewPassword(input.newPassword, { email: user.normalizedEmail });
    await tx
      .update(users)
      .set({ passwordHash: await hashPassword(input.newPassword), passwordChangedAt: at, mustChangePassword: false, updatedAt: at, rowVersion: sql`${users.rowVersion} + 1` })
      .where(eq(users.id, user.id));
    await revokeUserSessions(tx, user.id, at, 'password_changed', session.id);
    await tx.update(sessions).set({ recentAuthAt: at }).where(eq(sessions.id, session.id));
    await enqueueJob(tx, {
      type: 'mail.send',
      workspaceId: null,
      payload: { template: 'securityAlert', to: user.displayEmail, vars: { event: 'Your password was changed', when: at.toISOString() } },
    });
    await auditRaw(tx, { action: 'auth.password_changed', workspaceId: null, actorUserId: user.id, actorKind: 'user', entityType: 'user', entityId: user.id, at, requestId: meta.requestId, ipHash: meta.ipHash });
  });
};

export const reauthenticate = async (
  app: AppServices,
  session: SessionRow,
  input: { password: string; code?: string },
  meta: AuthRequestMeta,
): Promise<Date> => {
  const at = app.clock.now();
  const key = `reauth:${session.userId}`;
  const blocked = await checkBlocked(app.db, [key], at);
  if (blocked) throw rateLimited(blocked);
  return withTransaction(app.db, async (tx) => {
    const [user] = await tx.select().from(users).where(eq(users.id, session.userId)).for('update');
    if (!user) throw new AppError('UNAUTHENTICATED', 'Sign in again.');
    let ok = await verifyPassword(user.passwordHash, input.password);
    if (ok && user.mfaEnabledAt && user.mfaSecretEnc) {
      const step = input.code ? verifyTotp(decryptSecret(user.mfaSecretEnc, app.config.MFA_ENCRYPTION_KEY), input.code, at) : null;
      ok = step !== null && (user.mfaLastStep === null || step > user.mfaLastStep);
      if (ok) await tx.update(users).set({ mfaLastStep: step }).where(eq(users.id, user.id));
    }
    if (!ok) {
      await hitBucket(app.db, key, { limit: FAIL_LIMIT, windowSeconds: FAIL_WINDOW_S, at });
      throw new AppError('VALIDATION_FAILED', 'The password or verification code is incorrect.', {
        fieldErrors: [{ field: 'password', code: 'INCORRECT', message: 'The password or verification code is incorrect.' }],
      });
    }
    await tx.update(sessions).set({ recentAuthAt: at, mfaVerifiedAt: user.mfaEnabledAt ? at : session.mfaVerifiedAt }).where(eq(sessions.id, session.id));
    await auditRaw(tx, { action: 'auth.reauthenticated', workspaceId: null, actorUserId: user.id, actorKind: 'user', at, requestId: meta.requestId, ipHash: meta.ipHash });
    return at;
  });
};

export const signOut = async (app: AppServices, session: SessionRow, meta: AuthRequestMeta) => {
  const at = app.clock.now();
  await revokeSession(app.db, session.id, at, 'sign_out');
  await auditRaw(app.db, { action: 'auth.sign_out', workspaceId: null, actorUserId: session.userId, actorKind: 'user', at, requestId: meta.requestId, ipHash: meta.ipHash });
};

export const listOwnSessions = async (db: Db, session: SessionRow, at: Date) => {
  const rows = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.userId, session.userId), isNull(sessions.revokedAt), gt(sessions.absoluteExpiresAt, at), gt(sessions.idleExpiresAt, at)));
  return rows.map((r) => ({
    id: r.id,
    current: r.id === session.id,
    createdAt: r.createdAt.toISOString(),
    lastSeenAt: r.lastSeenAt.toISOString(),
    userAgent: r.userAgent,
  }));
};

export const revokeOwnSession = async (app: AppServices, session: SessionRow, sessionId: string, meta: AuthRequestMeta) => {
  const at = app.clock.now();
  const [target] = await app.db.select().from(sessions).where(and(eq(sessions.id, sessionId), eq(sessions.userId, session.userId)));
  if (!target) throw new AppError('NOT_FOUND', 'Session was not found.');
  await revokeSession(app.db, sessionId, at, 'revoked_by_user');
  await auditRaw(app.db, { action: 'auth.session_revoked', workspaceId: null, actorUserId: session.userId, actorKind: 'user', entityType: 'session', entityId: sessionId, at, requestId: meta.requestId, ipHash: meta.ipHash });
};

export const revokeOtherSessions = async (app: AppServices, session: SessionRow, meta: AuthRequestMeta) => {
  const at = app.clock.now();
  const n = await revokeUserSessions(app.db, session.userId, at, 'revoked_by_user', session.id);
  await auditRaw(app.db, { action: 'auth.other_sessions_revoked', workspaceId: null, actorUserId: session.userId, actorKind: 'user', at, requestId: meta.requestId, ipHash: meta.ipHash, metadata: { count: n } });
  return n;
};

/** Current user, their workspaces and the session CSRF token. */
export const describeMe = async (app: AppServices, session: SessionRow) => {
  const db = app.db;
  const [user] = await db.select().from(users).where(eq(users.id, session.userId));
  if (!user) throw new AppError('UNAUTHENTICATED', 'Sign in again.');
  const [pref] = await db.select().from(userPreferences).where(eq(userPreferences.userId, user.id));
  const ws = await db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      timezone: workspaces.timezone,
      baseCurrency: workspaces.baseCurrency,
      setupStep: workspaces.setupStep,
      membershipId: memberships.id,
      membershipStatus: memberships.status,
      logoAssetId: workspaces.logoAssetId,
    })
    .from(memberships)
    .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
    .where(and(eq(memberships.userId, user.id), inArray(memberships.status, ['active'])));
  const mfaRequired = await userRequiresMfa(db, user.id, app.clock.now());
  return {
    user: {
      id: user.id,
      email: user.displayEmail,
      displayName: user.displayName,
      avatarUrl: user.avatarAssetId ? `/api/v1/avatars/${user.id}` : null,
      mfaEnabled: !!user.mfaEnabledAt,
      mustChangePassword: user.mustChangePassword,
      timezone: pref?.timezone ?? null,
      theme: pref?.theme ?? 'system',
      density: pref?.density ?? 'comfortable',
    },
    workspaces: ws.map((w) => ({
      id: w.id,
      name: w.name,
      timezone: w.timezone,
      baseCurrency: w.baseCurrency,
      setupStep: w.setupStep,
      membershipId: w.membershipId,
      membershipStatus: w.membershipStatus,
      logoUrl: w.logoAssetId ? `/api/v1/workspaces/${w.id}/logo` : null,
    })),
    currentWorkspaceId: session.currentWorkspaceId ?? ws[0]?.id ?? null,
    mfaVerified: !!session.mfaVerifiedAt,
    mfaRequired,
  };
};

export const setCurrentWorkspace = async (app: AppServices, session: SessionRow, workspaceId: string) => {
  const [m] = await app.db
    .select({ id: memberships.id })
    .from(memberships)
    .where(and(eq(memberships.userId, session.userId), eq(memberships.workspaceId, workspaceId), eq(memberships.status, 'active')));
  if (!m) throw new AppError('NOT_FOUND', 'Workspace was not found.');
  await app.db.update(sessions).set({ currentWorkspaceId: workspaceId }).where(eq(sessions.id, session.id));
};
