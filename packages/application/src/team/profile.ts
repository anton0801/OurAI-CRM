import { and, count, desc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import {
  assetDerivatives,
  assetVersions,
  assets,
  auditEvents,
  emailChangeRequests,
  memberships,
  notifications,
  recoveryCodes,
  roleAssignments,
  roles,
  sessions,
  userPreferences,
  users,
  withTransaction,
  workspaces,
  type DbOrTx,
} from '@castlane/database';
import { AppError, isEmail, newId, normalizeEmail, notFound } from '@castlane/domain';
import { requireRecentAuth } from '../core/access';
import { audit, auditRaw } from '../core/audit';
import { pgErrorCode } from '@castlane/database';
import type { AppServices, CommandContext, QueryContext } from '../core/context';
import { randomToken, sha256 } from '../core/crypto';
import { emit } from '../core/events';
import { enqueueJob } from '../core/jobs';
import { userRequiresMfa, type AuthRequestMeta } from '../identity/auth';
import { checkBlocked, hitBucket, rateLimited } from '../identity/rate-limit';
import { revokeSession, type SessionRow } from '../identity/sessions';
import { initiateUpload } from '../media/uploads';
import { indexMember } from './members';

const EMAIL_CHANGE_TTL_MS = 60 * 60_000;

type Prefs = typeof userPreferences.$inferSelect;

const ensurePrefs = async (db: DbOrTx, userId: string): Promise<Prefs> => {
  await db.insert(userPreferences).values({ userId }).onConflictDoNothing();
  const [p] = await db.select().from(userPreferences).where(eq(userPreferences.userId, userId));
  return p!;
};

export const getProfile = async (ctx: QueryContext | CommandContext) => {
  const db = 'tx' in ctx ? ctx.tx : ctx.app.db;
  const userId = ctx.actor.userId!;
  const at = ctx.app.clock.now();
  const [u] = await db.select().from(users).where(eq(users.id, userId));
  if (!u) throw notFound('User');
  const p = await ensurePrefs(db, userId);
  const [ws] = await db.select({ tz: workspaces.timezone }).from(workspaces).where(eq(workspaces.id, ctx.actor.workspaceId));
  const [pending] = await db
    .select()
    .from(emailChangeRequests)
    .where(and(eq(emailChangeRequests.userId, userId), isNull(emailChangeRequests.confirmedAt), isNull(emailChangeRequests.cancelledAt), gt(emailChangeRequests.expiresAt, at)))
    .orderBy(desc(emailChangeRequests.createdAt))
    .limit(1);
  const [codes] = u.mfaEnabledAt
    ? await db.select({ n: count() }).from(recoveryCodes).where(and(eq(recoveryCodes.userId, userId), isNull(recoveryCodes.usedAt), isNull(recoveryCodes.revokedAt)))
    : [];
  return {
    user: {
      id: u.id,
      displayName: u.displayName,
      email: u.displayEmail,
      avatarUrl: u.avatarAssetId ? `/api/v1/avatars/${u.id}` : null,
      avatarAssetId: u.avatarAssetId,
      mfaEnabled: !!u.mfaEnabledAt,
      mfaRequired: await userRequiresMfa(db, userId, at),
      recoveryCodesRemaining: u.mfaEnabledAt ? Number(codes?.n ?? 0) : null,
      passwordChangedAt: u.passwordChangedAt?.toISOString() ?? null,
      createdAt: u.createdAt.toISOString(),
    },
    preferences: {
      timezone: p.timezone,
      effectiveTimezone: p.timezone ?? ws?.tz ?? 'UTC',
      locale: p.locale,
      theme: p.theme,
      density: p.density,
      notifications: p.notifications,
      quietHoursStart: p.quietHoursStart,
      quietHoursEnd: p.quietHoursEnd,
    },
    pendingEmailChange: pending ? { newEmail: pending.newEmail, expiresAt: pending.expiresAt.toISOString() } : null,
    recentAuthAt: ctx.actor.recentAuthAt?.toISOString() ?? null,
    rowVersion: p.rowVersion,
  };
};

export interface ProfilePatch {
  displayName?: string;
  avatarAssetId?: string | null;
  timezone?: string | null;
  theme?: Prefs['theme'];
  density?: Prefs['density'];
  notifications?: Prefs['notifications'];
  quietHoursStart?: string;
  quietHoursEnd?: string;
}

/** Personal settings never touch roles; the version is the preferences row version (If-Match). */
export const updateProfile = async (ctx: CommandContext, patch: ProfilePatch) => {
  const userId = ctx.actor.userId!;
  await ensurePrefs(ctx.tx, userId);
  const [p] = await ctx.tx.select().from(userPreferences).where(eq(userPreferences.userId, userId)).for('update');
  const [u] = await ctx.tx.select().from(users).where(eq(users.id, userId)).for('update');
  if (!p || !u) throw notFound('User');
  if (ctx.request.expectedVersion === undefined) throw new AppError('PRECONDITION_REQUIRED', 'This change requires the version of the settings you edited (If-Match).');
  if (ctx.request.expectedVersion !== p.rowVersion) throw new AppError('VERSION_CONFLICT', 'This record changed while you were editing it.', { currentVersion: p.rowVersion });
  const at = ctx.app.clock.now();
  const diff: Record<string, { from?: unknown; to?: unknown }> = {};
  const userPatch: Partial<typeof users.$inferInsert> = {};
  if (patch.displayName !== undefined && patch.displayName.trim() !== u.displayName) {
    userPatch.displayName = patch.displayName.trim();
    diff.displayName = { from: u.displayName, to: userPatch.displayName };
  }
  if (patch.avatarAssetId !== undefined && patch.avatarAssetId !== u.avatarAssetId) {
    if (patch.avatarAssetId) {
      const [a] = await ctx.tx
        .select({ kind: assets.kind, owner: assets.ownerMembershipId, status: assetVersions.status, sensitivity: assets.sensitivity })
        .from(assets)
        .leftJoin(assetVersions, eq(assetVersions.id, assets.currentVersionId))
        .where(and(eq(assets.workspaceId, ctx.actor.workspaceId), eq(assets.id, patch.avatarAssetId)));
      if (!a || a.owner !== ctx.actor.membershipId || a.kind !== 'image' || a.sensitivity === 'restricted')
        throw new AppError('VALIDATION_FAILED', 'Upload your own image to use it as an avatar.', { fieldErrors: [{ field: 'avatarAssetId', code: 'INVALID', message: 'Upload your own image to use it as an avatar.' }] });
      if (a.status !== 'available')
        throw new AppError('INVALID_STATE', 'Your file is being checked and prepared for preview.', { fieldErrors: [{ field: 'avatarAssetId', code: 'PROCESSING', message: 'Your file is being checked and prepared for preview.' }] });
    }
    userPatch.avatarAssetId = patch.avatarAssetId;
    diff.avatar = { from: u.avatarAssetId ? 'set' : 'none', to: patch.avatarAssetId ? 'set' : 'none' };
  }
  if (Object.keys(userPatch).length) {
    await ctx.tx
      .update(users)
      .set({ ...userPatch, updatedAt: at, rowVersion: sql`${users.rowVersion} + 1` })
      .where(eq(users.id, userId));
    if (userPatch.displayName)
      await ctx.tx
        .update(memberships)
        .set({ displayNameSnapshot: userPatch.displayName, updatedAt: at })
        .where(and(eq(memberships.userId, userId), inArray(memberships.status, ['active', 'suspended'])));
  }
  const prefPatch: Partial<typeof userPreferences.$inferInsert> = {};
  const prefKeys = ['timezone', 'theme', 'density', 'notifications', 'quietHoursStart', 'quietHoursEnd'] as const;
  for (const k of prefKeys) {
    if (patch[k] === undefined) continue;
    if (JSON.stringify(patch[k]) === JSON.stringify(p[k])) continue;
    (prefPatch as Record<string, unknown>)[k] = patch[k];
    diff[k] = { from: p[k], to: patch[k] };
  }
  await ctx.tx
    .update(userPreferences)
    .set({ ...prefPatch, updatedAt: at, rowVersion: sql`${userPreferences.rowVersion} + 1` })
    .where(eq(userPreferences.userId, userId));
  if (Object.keys(diff).length) {
    await audit(ctx, { action: 'profile.updated', entityType: 'user_profile', entityId: userId, diff });
    await emit(ctx, { type: 'member.updated', entityType: 'membership', entityId: ctx.actor.membershipId! });
    if (userPatch.displayName) await indexMember(ctx, ctx.actor.membershipId!);
  }
  return getProfile(ctx);
};

// ——— Avatar (media pipeline, purpose "avatar") ———

/**
 * Everyone may upload their own avatar, even without the Library upload permission: the upload is
 * restricted to images ≤ 10 MB with purpose "avatar", no project and normal sensitivity, and runs
 * through the same quarantine → scan → derivatives pipeline. An explicit deny on uploads still wins.
 */
export const initiateAvatarUpload = async (ctx: CommandContext, input: { filename: string; mimeType: string; byteSize: number; checksumSha256?: string }) => {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(input.mimeType))
    throw new AppError('VALIDATION_FAILED', 'Use a JPG, PNG or WebP image.', { fieldErrors: [{ field: 'mimeType', code: 'UNSUPPORTED', message: 'Use a JPG, PNG or WebP image.' }] });
  const selfService: CommandContext = {
    ...ctx,
    actor: {
      ...ctx.actor,
      access: {
        ...ctx.actor.access,
        grants: [...ctx.actor.access.grants, { roleId: 'self-service', roleKey: 'self_service_avatar', permissions: new Set(['assets.upload']), scopeType: 'workspace', scopeId: null }],
      },
    },
  };
  return initiateUpload(selfService, {
    filename: input.filename,
    mimeType: input.mimeType,
    byteSize: input.byteSize,
    checksumSha256: input.checksumSha256,
    purpose: 'avatar',
    projectId: null,
    sensitivity: 'normal',
    note: 'Avatar',
  });
};

export const avatarUploadStatus = async (ctx: QueryContext, assetId: string) => {
  const [a] = await ctx.app.db
    .select({ id: assets.id, owner: assets.ownerMembershipId, status: assetVersions.status, reason: assetVersions.rejectionReason })
    .from(assets)
    .leftJoin(assetVersions, eq(assetVersions.id, assets.currentVersionId))
    .where(and(eq(assets.workspaceId, ctx.actor.workspaceId), eq(assets.id, assetId)));
  if (!a || a.owner !== ctx.actor.membershipId) throw notFound('Upload');
  if (a.status) return { assetId, status: a.status, rejectionReason: a.reason };
  // No current version yet: report the latest version's state.
  const [v] = await ctx.app.db.select({ status: assetVersions.status, reason: assetVersions.rejectionReason }).from(assetVersions).where(eq(assetVersions.assetId, assetId)).orderBy(desc(assetVersions.versionNo)).limit(1);
  return { assetId, status: v?.status ?? 'uploading', rejectionReason: v?.reason ?? null };
};

const pickDerivative = async (db: DbOrTx, assetId: string, size: number) => {
  const [a] = await db.select({ versionId: assets.currentVersionId, sensitivity: assets.sensitivity }).from(assets).where(eq(assets.id, assetId));
  if (!a?.versionId || a.sensitivity === 'restricted') return null;
  const derivs = await db.select().from(assetDerivatives).where(eq(assetDerivatives.assetVersionId, a.versionId));
  const sized = derivs.filter((d) => d.kind.startsWith('thumb_')).sort((x, y) => (x.width ?? 0) - (y.width ?? 0));
  return sized.find((d) => (d.width ?? 0) >= size) ?? sized[sized.length - 1] ?? null;
};

/** Avatar image for people who share an active workspace with the viewer (or the viewer themselves). */
export const loadAvatarDerivative = async (app: AppServices, viewerUserId: string, userId: string, size: number) => {
  const [u] = await app.db.select({ avatar: users.avatarAssetId, anonymizedAt: users.anonymizedAt }).from(users).where(eq(users.id, userId));
  if (!u?.avatar || u.anonymizedAt) throw notFound('Avatar');
  if (viewerUserId !== userId) {
    const shared = await app.db.execute<{ ok: number }>(sql`
      SELECT 1 AS ok FROM ${memberships} a JOIN ${memberships} b ON a.workspace_id = b.workspace_id
      WHERE a.user_id = ${viewerUserId} AND a.status = 'active' AND b.user_id = ${userId} LIMIT 1`);
    if (shared.rows.length === 0) throw notFound('Avatar');
  }
  const d = await pickDerivative(app.db, u.avatar, size);
  if (!d) throw notFound('Avatar');
  return d;
};

export const loadLogoDerivative = async (ctx: QueryContext, size: number) => {
  const [ws] = await ctx.app.db.select({ logo: workspaces.logoAssetId }).from(workspaces).where(eq(workspaces.id, ctx.actor.workspaceId));
  if (!ws?.logo) throw notFound('Logo');
  const d = await pickDerivative(ctx.app.db, ws.logo, size);
  if (!d) throw notFound('Logo');
  return d;
};

// ——— E-mail change (new address confirms; recent authentication) ———

export const requestEmailChange = async (ctx: CommandContext, input: { newEmail: string }) => {
  requireRecentAuth(ctx);
  const userId = ctx.actor.userId!;
  const at = ctx.app.clock.now();
  const email = normalizeEmail(input.newEmail);
  if (!isEmail(email)) throw new AppError('VALIDATION_FAILED', 'Enter a valid e-mail address.', { fieldErrors: [{ field: 'newEmail', code: 'INVALID', message: 'Enter a valid e-mail address.' }] });
  const key = `email-change:${userId}`;
  const blocked = await checkBlocked(ctx.tx, [key], at);
  if (blocked) throw rateLimited(blocked);
  await hitBucket(ctx.tx, key, { limit: 5, windowSeconds: 3600, at });
  const [u] = await ctx.tx.select().from(users).where(eq(users.id, userId)).for('update');
  if (!u) throw notFound('User');
  if (u.normalizedEmail === email) throw new AppError('VALIDATION_FAILED', 'This is already your e-mail address.', { fieldErrors: [{ field: 'newEmail', code: 'SAME', message: 'This is already your e-mail address.' }] });
  const [taken] = await ctx.tx.select({ id: users.id }).from(users).where(eq(users.normalizedEmail, email));
  if (taken) throw new AppError('VALIDATION_FAILED', 'This address cannot be used.', { fieldErrors: [{ field: 'newEmail', code: 'UNAVAILABLE', message: 'This address cannot be used.' }] });
  await ctx.tx
    .update(emailChangeRequests)
    .set({ cancelledAt: at })
    .where(and(eq(emailChangeRequests.userId, userId), isNull(emailChangeRequests.confirmedAt), isNull(emailChangeRequests.cancelledAt)));
  const token = randomToken(32);
  const expiresAt = new Date(at.getTime() + EMAIL_CHANGE_TTL_MS);
  await ctx.tx.insert(emailChangeRequests).values({ id: newId(), userId, newEmail: input.newEmail.trim(), tokenHash: sha256(token), expiresAt, createdAt: at });
  await enqueueJob(ctx.tx, {
    type: 'mail.send',
    workspaceId: null,
    payload: { template: 'emailChange', to: input.newEmail.trim(), vars: { confirmUrl: `${ctx.app.config.APP_ORIGIN}/auth/email-change/${token}` }, related: { entityType: 'user', entityId: userId } },
  });
  await enqueueJob(ctx.tx, {
    type: 'mail.send',
    workspaceId: null,
    payload: { template: 'securityAlert', to: u.displayEmail, vars: { event: 'A change of your sign-in e-mail address was requested', when: at.toISOString() } },
  });
  await audit(ctx, { action: 'profile.email_change_requested', entityType: 'user_profile', entityId: userId, sensitivity: 'security' });
  return { newEmail: input.newEmail.trim(), expiresAt: expiresAt.toISOString() };
};

export const cancelEmailChange = async (ctx: CommandContext) => {
  const at = ctx.app.clock.now();
  const res = await ctx.tx
    .update(emailChangeRequests)
    .set({ cancelledAt: at })
    .where(and(eq(emailChangeRequests.userId, ctx.actor.userId!), isNull(emailChangeRequests.confirmedAt), isNull(emailChangeRequests.cancelledAt)))
    .returning({ id: emailChangeRequests.id });
  if (res.length) await audit(ctx, { action: 'profile.email_change_cancelled', entityType: 'user_profile', entityId: ctx.actor.userId!, sensitivity: 'security' });
  return { ok: true as const };
};

export const confirmEmailChange = async (app: AppServices, token: string, meta: AuthRequestMeta) => {
  const at = app.clock.now();
  try {
    return await withTransaction(app.db, async (tx) => {
      const [r] = await tx.select().from(emailChangeRequests).where(eq(emailChangeRequests.tokenHash, sha256(token))).for('update');
      if (!r || r.confirmedAt || r.cancelledAt || r.expiresAt <= at) throw new AppError('INVALID_STATE', 'This confirmation link is invalid or expired. Request the change again from Personal Settings.');
      const [u] = await tx.select().from(users).where(eq(users.id, r.userId)).for('update');
      if (!u || u.status !== 'active') throw new AppError('INVALID_STATE', 'This confirmation link is invalid.');
      const oldEmail = u.displayEmail;
      await tx
        .update(users)
        .set({ normalizedEmail: normalizeEmail(r.newEmail), displayEmail: r.newEmail, updatedAt: at, rowVersion: sql`${users.rowVersion} + 1` })
        .where(eq(users.id, u.id));
      await tx.update(emailChangeRequests).set({ confirmedAt: at }).where(eq(emailChangeRequests.id, r.id));
      await enqueueJob(tx, {
        type: 'mail.send',
        workspaceId: null,
        payload: { template: 'securityAlert', to: oldEmail, vars: { event: `Your sign-in e-mail address was changed to ${r.newEmail}`, when: at.toISOString() } },
      });
      await auditRaw(tx, {
        action: 'profile.email_changed',
        workspaceId: null,
        actorUserId: u.id,
        actorKind: 'user',
        entityType: 'user',
        entityId: u.id,
        at,
        requestId: meta.requestId,
        ipHash: meta.ipHash,
      });
      return { email: r.newEmail };
    });
  } catch (e) {
    if (pgErrorCode(e) === '23505') throw new AppError('INVALID_STATE', 'This address is already in use by another account.');
    throw e;
  }
};

// ——— MFA off switch (only when no role or policy requires it) ———

export const disableMfa = async (app: AppServices, session: SessionRow, meta: AuthRequestMeta) => {
  const at = app.clock.now();
  if (!session.recentAuthAt || at.getTime() - session.recentAuthAt.getTime() > 15 * 60_000)
    throw new AppError('RECENT_AUTH_REQUIRED', 'Confirm your password and verification code to continue.');
  await withTransaction(app.db, async (tx) => {
    const [u] = await tx.select().from(users).where(eq(users.id, session.userId)).for('update');
    if (!u) throw new AppError('UNAUTHENTICATED', 'Sign in again.');
    if (!u.mfaEnabledAt) throw new AppError('INVALID_STATE', 'Two-factor authentication is not enabled.');
    if (await userRequiresMfa(tx, u.id, at)) throw new AppError('INVALID_STATE', 'Your role or a workspace policy requires two-factor authentication, so it cannot be turned off.');
    await tx.update(users).set({ mfaSecretEnc: null, mfaEnabledAt: null, mfaLastStep: null, updatedAt: at }).where(eq(users.id, u.id));
    await tx.update(recoveryCodes).set({ revokedAt: at }).where(and(eq(recoveryCodes.userId, u.id), isNull(recoveryCodes.usedAt), isNull(recoveryCodes.revokedAt)));
    await enqueueJob(tx, { type: 'mail.send', workspaceId: null, payload: { template: 'securityAlert', to: u.displayEmail, vars: { event: 'Two-factor authentication was turned off', when: at.toISOString() } } });
    await auditRaw(tx, { action: 'auth.mfa_disabled', workspaceId: null, actorUserId: u.id, actorKind: 'user', entityType: 'user', entityId: u.id, at, requestId: meta.requestId, ipHash: meta.ipHash });
  });
  return { ok: true as const };
};

// ——— Personal data view ———

export const personalData = async (ctx: QueryContext) => {
  const db = ctx.app.db;
  const userId = ctx.actor.userId!;
  const at = ctx.app.clock.now();
  const [u] = await db.select().from(users).where(eq(users.id, userId));
  if (!u) throw notFound('User');
  const [prefs] = await db.select().from(userPreferences).where(eq(userPreferences.userId, userId));
  const ms = await db
    .select({ id: memberships.id, status: memberships.status, joinedAt: memberships.joinedAt, title: memberships.title, workspaceName: workspaces.name })
    .from(memberships)
    .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
    .where(eq(memberships.userId, userId));
  const grantRows = ms.length
    ? await db
        .select({ membershipId: roleAssignments.membershipId, name: roles.name })
        .from(roleAssignments)
        .innerJoin(roles, eq(roles.id, roleAssignments.roleId))
        .where(and(inArray(roleAssignments.membershipId, ms.map((m) => m.id)), isNull(roleAssignments.revokedAt), or(isNull(roleAssignments.validTo), gt(roleAssignments.validTo, at))))
    : [];
  const [live] = await db
    .select({ n: count() })
    .from(sessions)
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt), gt(sessions.absoluteExpiresAt, at), gt(sessions.idleExpiresAt, at)));
  const events = await db
    .select({ action: auditEvents.action, occurredAt: auditEvents.occurredAt })
    .from(auditEvents)
    .where(and(eq(auditEvents.actorUserId, userId), eq(auditEvents.sensitivity, 'security')))
    .orderBy(desc(auditEvents.occurredAt))
    .limit(50);
  const [notes] = await db
    .select({ total: count(), unread: sql<number>`count(*) FILTER (WHERE ${notifications.readAt} IS NULL)` })
    .from(notifications)
    .where(and(eq(notifications.workspaceId, ctx.actor.workspaceId), eq(notifications.recipientMembershipId, ctx.actor.membershipId!)));
  return {
    account: {
      email: u.displayEmail,
      displayName: u.displayName,
      createdAt: u.createdAt.toISOString(),
      passwordChangedAt: u.passwordChangedAt?.toISOString() ?? null,
      mfaEnabledAt: u.mfaEnabledAt?.toISOString() ?? null,
      avatarStored: !!u.avatarAssetId,
    },
    memberships: ms.map((m) => ({
      workspaceName: m.workspaceName,
      status: m.status,
      joinedAt: m.joinedAt.toISOString(),
      title: m.title,
      roles: grantRows.filter((g) => g.membershipId === m.id).map((g) => g.name),
    })),
    preferences: prefs
      ? { timezone: prefs.timezone, locale: prefs.locale, theme: prefs.theme, density: prefs.density, notifications: prefs.notifications, quietHoursStart: prefs.quietHoursStart, quietHoursEnd: prefs.quietHoursEnd }
      : {},
    sessions: { active: Number(live?.n ?? 0) },
    securityEvents: events.map((e) => ({ action: e.action, occurredAt: e.occurredAt.toISOString() })),
    notifications: { total: Number(notes?.total ?? 0), unread: Number(notes?.unread ?? 0) },
  };
};

// ——— Session policy (S67 security policy, §31: at most 12 h idle / 7 d absolute) ———

/**
 * The session is one per user, so the strictest policy of the user's active workspaces applies.
 * Violating sessions are revoked; `previousSeenAt` is the activity before the current request.
 */
export const checkSessionPolicy = async (db: DbOrTx, session: SessionRow & { previousSeenAt?: Date }, at: Date): Promise<'ok' | 'idle' | 'absolute'> => {
  const rows = await db
    .select({ settings: workspaces.settings })
    .from(memberships)
    .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
    .where(and(eq(memberships.userId, session.userId), eq(memberships.status, 'active')));
  if (rows.length === 0) return 'ok';
  const idleHours = Math.min(...rows.map((r) => Math.min(12, Math.max(1, r.settings?.sessionIdleHours ?? 12))));
  const absoluteDays = Math.min(...rows.map((r) => Math.min(7, Math.max(1, r.settings?.sessionAbsoluteDays ?? 7))));
  let verdict: 'ok' | 'idle' | 'absolute' = 'ok';
  if (at.getTime() - session.createdAt.getTime() > absoluteDays * 86_400_000) verdict = 'absolute';
  else if (at.getTime() - (session.previousSeenAt ?? session.lastSeenAt).getTime() > idleHours * 3_600_000) verdict = 'idle';
  if (verdict !== 'ok') await revokeSession(db, session.id, at, `workspace_policy_${verdict}`);
  return verdict;
};
