import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  invitationRequests,
  invitations,
  memberships,
  roleAssignments,
  roles,
  users,
  userPreferences,
  withTransaction,
  workspaces,
  type ProposedGrant,
} from '@castlane/database';
import { AppError, LIMITS, isEmail, newId, normalizeEmail } from '@castlane/domain';
import { hasAnywhere } from '@castlane/authorization';
import { audit, auditRaw } from '../core/audit';
import type { AppServices, CommandContext } from '../core/context';
import { randomToken, sha256 } from '../core/crypto';
import { emit } from '../core/events';
import { enqueueJob } from '../core/jobs';
import { notify } from '../core/notify';
import { stamp } from '../core/rows';
import { completePasswordStep, type AuthRequestMeta, type SignInOutcome } from './auth';
import { validateGrants } from './grants';
import { hashPassword, validateNewPassword, verifyPassword } from './passwords';

export const INVITATION_TTL_HOURS = 72;

export type InviteOutcome = 'queued' | 'resent' | 'already_member' | 'invalid_role' | 'invalid_scope';

const queueInvitationMail = async (ctx: CommandContext, invitationId: string, email: string, token: string, expiresAt: Date) => {
  const [ws] = await ctx.tx.select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, ctx.actor.workspaceId));
  await enqueueJob(ctx.tx, {
    type: 'mail.send',
    workspaceId: ctx.actor.workspaceId,
    payload: {
      template: 'invitation',
      to: email,
      vars: {
        workspaceName: ws?.name,
        inviterName: ctx.actor.displayName,
        inviteUrl: `${ctx.app.config.APP_ORIGIN}/auth/invitations/${token}`,
        expiresAt: expiresAt.toUTCString(),
      },
      related: { entityType: 'invitation', entityId: invitationId },
    },
  });
};

/**
 * Invite (or re-invite) an e-mail address. Re-inviting a pending address revokes the old token
 * and issues a new one; an existing active member is reported, not duplicated.
 */
export const inviteMember = async (
  ctx: CommandContext,
  input: { email: string; grants: ProposedGrant[] },
): Promise<{ outcome: InviteOutcome; invitationId: string | null }> => {
  if (!hasAnywhere(ctx.actor.access, 'members.invite')) throw new AppError('FORBIDDEN', 'You cannot invite members.');
  const email = normalizeEmail(input.email);
  if (!isEmail(email)) throw new AppError('VALIDATION_FAILED', 'Enter a valid e-mail address.');
  const valid = await validateGrants(ctx.tx, ctx, input.grants);
  if (!valid.ok) return { outcome: valid.code, invitationId: null };

  const [existingMember] = await ctx.tx
    .select({ id: memberships.id, status: memberships.status })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.workspaceId, ctx.actor.workspaceId), eq(users.normalizedEmail, email)));
  if (existingMember && existingMember.status === 'active') return { outcome: 'already_member', invitationId: null };

  const at = ctx.app.clock.now();
  const token = randomToken(32);
  const expiresAt = new Date(at.getTime() + INVITATION_TTL_HOURS * 3_600_000);
  const [pending] = await ctx.tx
    .select()
    .from(invitations)
    .where(and(eq(invitations.workspaceId, ctx.actor.workspaceId), eq(invitations.emailNormalized, email), eq(invitations.status, 'pending')))
    .for('update');
  if (pending) {
    await ctx.tx
      .update(invitations)
      .set({
        tokenHash: sha256(token),
        expiresAt,
        proposedGrants: input.grants,
        deliveryStatus: 'queued',
        deliveryError: null,
        resendCount: pending.resendCount + 1,
        updatedAt: at,
        updatedBy: ctx.actor.userId,
        rowVersion: sql`${invitations.rowVersion} + 1`,
      })
      .where(eq(invitations.id, pending.id));
    await queueInvitationMail(ctx, pending.id, input.email.trim(), token, expiresAt);
    await audit(ctx, { action: 'invitation.resent', entityType: 'invitation', entityId: pending.id, sensitivity: 'security' });
    return { outcome: 'resent', invitationId: pending.id };
  }
  const id = newId();
  await ctx.tx.insert(invitations).values({
    ...stamp(ctx),
    id,
    emailNormalized: email,
    emailDisplay: input.email.trim(),
    proposedGrants: input.grants,
    tokenHash: sha256(token),
    expiresAt,
    status: 'pending',
    invitedByMembershipId: ctx.actor.membershipId,
    deliveryStatus: 'queued',
  });
  await queueInvitationMail(ctx, id, input.email.trim(), token, expiresAt);
  await audit(ctx, { action: 'invitation.created', entityType: 'invitation', entityId: id, sensitivity: 'security', metadata: { grants: input.grants.length } });
  await emit(ctx, { type: 'invitation.created', entityType: 'invitation', entityId: id });
  return { outcome: 'queued', invitationId: id };
};

export const resendInvitation = async (ctx: CommandContext, invitationId: string) => {
  const [inv] = await ctx.tx
    .select()
    .from(invitations)
    .where(and(eq(invitations.workspaceId, ctx.actor.workspaceId), eq(invitations.id, invitationId)))
    .for('update');
  if (!inv) throw new AppError('NOT_FOUND', 'Invitation was not found.');
  if (inv.status === 'accepted') throw new AppError('INVALID_STATE', 'This invitation was already accepted.');
  if (inv.status === 'revoked') throw new AppError('INVALID_STATE', 'This invitation was revoked. Create a new one.');
  return inviteMember(ctx, { email: inv.emailDisplay, grants: inv.proposedGrants });
};

export const revokeInvitation = async (ctx: CommandContext, invitationId: string) => {
  if (!hasAnywhere(ctx.actor.access, 'members.invite')) throw new AppError('FORBIDDEN', 'You cannot manage invitations.');
  const at = ctx.app.clock.now();
  const res = await ctx.tx
    .update(invitations)
    .set({ status: 'revoked', revokedAt: at, updatedAt: at, updatedBy: ctx.actor.userId, rowVersion: sql`${invitations.rowVersion} + 1` })
    .where(and(eq(invitations.workspaceId, ctx.actor.workspaceId), eq(invitations.id, invitationId), eq(invitations.status, 'pending')))
    .returning({ id: invitations.id });
  if (res.length === 0) throw new AppError('INVALID_STATE', 'Only pending invitations can be revoked.');
  await audit(ctx, { action: 'invitation.revoked', entityType: 'invitation', entityId: invitationId, sensitivity: 'security' });
  return { ok: true as const };
};

const loadByToken = async (app: AppServices, token: string) => {
  const [inv] = await app.db.select().from(invitations).where(eq(invitations.tokenHash, sha256(token))).limit(1);
  return inv ?? null;
};

const invitationState = (inv: typeof invitations.$inferSelect, at: Date) =>
  inv.status === 'pending' && inv.expiresAt <= at ? ('expired' as const) : inv.status === 'pending' ? ('valid' as const) : inv.status;

export const describeInvitation = async (app: AppServices, token: string) => {
  const at = app.clock.now();
  const inv = await loadByToken(app, token);
  if (!inv) return { status: 'revoked' as const, workspaceName: null, email: null, existingAccount: false, accessSummary: [], invitationId: null };
  const [ws] = await app.db.select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, inv.workspaceId));
  const roleRows = inv.proposedGrants.length
    ? await app.db.select({ id: roles.id, name: roles.name }).from(roles).where(inArray(roles.id, inv.proposedGrants.map((g) => g.roleId)))
    : [];
  const names = new Map(roleRows.map((r) => [r.id, r.name]));
  const scopeLabel: Record<string, string> = {
    workspace: 'across the workspace',
    direction: 'in one direction',
    project: 'in one project',
    account: 'on one account',
    assigned_projects: 'on projects you are assigned to',
    assigned_accounts: 'on accounts you are assigned to',
    assigned_object: 'on items explicitly assigned to you',
    own_records: 'on your own records',
  };
  const [existing] = await app.db.select({ id: users.id }).from(users).where(eq(users.normalizedEmail, inv.emailNormalized));
  const status = invitationState(inv, at);
  return {
    status,
    workspaceName: ws?.name ?? null,
    email: inv.emailDisplay,
    existingAccount: !!existing,
    accessSummary: inv.proposedGrants.map((g) => `${names.get(g.roleId) ?? 'Role'} ${scopeLabel[g.scopeType] ?? ''}`.trim()),
    invitationId: inv.id,
  };
};

/**
 * Accept an invitation atomically. A repeated acceptance does not create a second user or
 * membership; it signs the invitee in (when the password matches).
 */
export const acceptInvitation = async (
  app: AppServices,
  input: { token: string; displayName?: string; password: string },
  meta: AuthRequestMeta,
): Promise<SignInOutcome> => {
  const at = app.clock.now();
  return withTransaction(app.db, async (tx) => {
    const [inv] = await tx.select().from(invitations).where(eq(invitations.tokenHash, sha256(input.token))).for('update').limit(1);
    if (!inv) throw new AppError('INVALID_STATE', 'This invitation link is not valid.');
    const state = invitationState(inv, at);
    if (state === 'revoked') throw new AppError('INVALID_STATE', 'This invitation was revoked. Ask for a new invitation.');
    if (state === 'expired') throw new AppError('INVALID_STATE', 'This invitation has expired. Request a new invitation.', { details: { expired: true } });

    let [user] = await tx.select().from(users).where(eq(users.normalizedEmail, inv.emailNormalized)).for('update');
    if (user) {
      if (!(await verifyPassword(user.passwordHash, input.password)))
        throw new AppError('UNAUTHENTICATED', 'The password is incorrect for this existing account.');
      if (user.status !== 'active') throw new AppError('FORBIDDEN', 'This account is disabled.');
    } else {
      if (state === 'accepted') throw new AppError('INVALID_STATE', 'This invitation was already used.');
      const displayName = input.displayName?.trim() ?? '';
      if (displayName.length < LIMITS.displayNameMin || displayName.length > LIMITS.displayNameMax)
        throw new AppError('VALIDATION_FAILED', 'Enter a display name of 2–80 characters.', {
          fieldErrors: [{ field: 'displayName', code: 'LENGTH', message: 'Enter a display name of 2–80 characters.' }],
        });
      validateNewPassword(input.password, { email: inv.emailNormalized });
      const id = newId();
      await tx.insert(users).values({
        id,
        normalizedEmail: inv.emailNormalized,
        displayEmail: inv.emailDisplay,
        displayName,
        passwordHash: await hashPassword(input.password),
        passwordChangedAt: at,
        createdAt: at,
        updatedAt: at,
      });
      await tx.insert(userPreferences).values({ userId: id }).onConflictDoNothing();
      [user] = await tx.select().from(users).where(eq(users.id, id));
    }
    if (!user) throw new AppError('INTERNAL', 'Account could not be created.');

    const [existingMembership] = await tx
      .select()
      .from(memberships)
      .where(and(eq(memberships.workspaceId, inv.workspaceId), eq(memberships.userId, user.id)));
    if (state === 'valid') {
      let membershipId = existingMembership?.id;
      const base = { workspaceId: inv.workspaceId, createdAt: at, updatedAt: at, createdBy: user.id, updatedBy: user.id };
      if (!existingMembership) {
        membershipId = newId();
        await tx.insert(memberships).values({ ...base, id: membershipId, userId: user.id, displayNameSnapshot: user.displayName, status: 'active', joinedAt: at });
      } else if (existingMembership.status !== 'active') {
        // A restored member gets exactly the newly proposed grants, not their previous rights.
        await tx
          .update(memberships)
          .set({ status: 'active', restoredAt: at, accessRevision: sql`${memberships.accessRevision} + 1`, updatedAt: at })
          .where(eq(memberships.id, existingMembership.id));
      }
      const validRoles = await tx
        .select({ id: roles.id })
        .from(roles)
        .where(and(eq(roles.workspaceId, inv.workspaceId), inArray(roles.id, inv.proposedGrants.map((g) => g.roleId)), isNull(roles.archivedAt)));
      const valid = new Set(validRoles.map((r) => r.id));
      for (const g of inv.proposedGrants) {
        if (!valid.has(g.roleId)) continue;
        await tx.insert(roleAssignments).values({
          ...base,
          id: newId(),
          membershipId: membershipId!,
          roleId: g.roleId,
          scopeType: g.scopeType,
          scopeId: g.scopeId,
          validFrom: at,
          reason: 'Invitation accepted',
        });
      }
      await tx
        .update(invitations)
        .set({ status: 'accepted', acceptedAt: at, acceptedMembershipId: membershipId, updatedAt: at, rowVersion: sql`${invitations.rowVersion} + 1` })
        .where(eq(invitations.id, inv.id));
      await auditRaw(tx, {
        action: 'invitation.accepted',
        workspaceId: inv.workspaceId,
        actorUserId: user.id,
        actorKind: 'user',
        entityType: 'invitation',
        entityId: inv.id,
        at,
        requestId: meta.requestId,
        ipHash: meta.ipHash,
      });
    }
    return completePasswordStep(app, tx, user, meta);
  });
};

/** After expiry the invitee can ask for a new invitation; administrators get an in-app notice. */
export const requestNewInvitation = async (app: AppServices, token: string, meta: AuthRequestMeta) => {
  const at = app.clock.now();
  await withTransaction(app.db, async (tx) => {
    const [inv] = await tx.select().from(invitations).where(eq(invitations.tokenHash, sha256(token))).limit(1);
    if (!inv || inv.status === 'accepted') return;
    const inserted = await tx
      .insert(invitationRequests)
      .values({
        id: newId(),
        workspaceId: inv.workspaceId,
        createdAt: at,
        updatedAt: at,
        invitationId: inv.id,
        emailNormalized: inv.emailNormalized,
        status: 'open',
      })
      .onConflictDoNothing()
      .returning({ id: invitationRequests.id });
    if (inserted.length === 0) return;
    const admins = await tx
      .select({ id: memberships.id, permissions: roles.permissions, key: roles.key })
      .from(memberships)
      .innerJoin(roleAssignments, and(eq(roleAssignments.membershipId, memberships.id), isNull(roleAssignments.revokedAt)))
      .innerJoin(roles, eq(roles.id, roleAssignments.roleId))
      .where(and(eq(memberships.workspaceId, inv.workspaceId), eq(memberships.status, 'active'), eq(roleAssignments.scopeType, 'workspace')));
    const recipients = [...new Set(admins.filter((a) => a.key === 'owner' || a.permissions.includes('members.invite')).map((a) => a.id))];
    await notify(tx, {
      workspaceId: inv.workspaceId,
      recipientMembershipIds: recipients,
      eventType: 'invitation.new_requested',
      eventKey: `invitation.new_requested:${inserted[0]!.id}`,
      kind: 'general',
      title: `New invitation requested by ${inv.emailDisplay}`,
      excerpt: 'The previous invitation expired. Review it in Team → Invitations.',
      entityType: 'invitation',
      entityId: inv.id,
      at,
    });
    await auditRaw(tx, { action: 'invitation.new_requested', workspaceId: inv.workspaceId, actorUserId: null, actorKind: 'anonymous', entityType: 'invitation', entityId: inv.id, at, requestId: meta.requestId, ipHash: meta.ipHash });
  });
};
