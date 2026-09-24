import { and, count, eq, gt, isNull, lte } from 'drizzle-orm';
import { hasAnywhere } from '@castlane/authorization';
import { memberships, ownershipTransfers, roleAssignments, roles, users, workspaces } from '@castlane/database';
import { AppError, newId, notFound } from '@castlane/domain';
import { requireRecentAuth } from '../core/access';
import { audit } from '../core/audit';
import { dbOf, type CommandContext, type QueryContext } from '../core/context';
import { emit } from '../core/events';
import { isActiveMember, loadMemberRefs } from '../core/members';
import { notify } from '../core/notify';
import { stamp, touch } from '../core/rows';
import { bumpAccessRevision } from './scope';

export const OWNERSHIP_TRANSFER_TTL_HOURS = 72;

type TransferRow = typeof ownershipTransfers.$inferSelect;

const ownerMembershipId = async (ctx: QueryContext | CommandContext): Promise<string | null> => {
  const [r] = await dbOf(ctx)
    .select({ id: roleAssignments.membershipId })
    .from(roleAssignments)
    .innerJoin(roles, eq(roles.id, roleAssignments.roleId))
    .where(and(eq(roleAssignments.workspaceId, ctx.actor.workspaceId), eq(roles.key, 'owner'), eq(roleAssignments.scopeType, 'workspace'), isNull(roleAssignments.revokedAt)))
    .limit(1);
  return r?.id ?? null;
};

const transferView = async (ctx: QueryContext | CommandContext, t: TransferRow) => {
  const db = dbOf(ctx);
  const refs = await loadMemberRefs(db, ctx.actor.workspaceId, [t.fromMembershipId, t.toMembershipId]);
  const [prevRole] = t.previousOwnerRoleKey === 'none' ? [] : await db.select({ key: roles.key, name: roles.name }).from(roles).where(and(eq(roles.workspaceId, ctx.actor.workspaceId), eq(roles.key, t.previousOwnerRoleKey)));
  const [recipient] = await db
    .select({ mfa: users.mfaEnabledAt })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(eq(memberships.id, t.toMembershipId));
  const pending = t.status === 'pending' && t.expiresAt > ctx.app.clock.now();
  return {
    id: t.id,
    from: refs.get(t.fromMembershipId)!,
    to: refs.get(t.toMembershipId)!,
    status: t.status === 'pending' && !pending ? ('expired' as const) : t.status,
    previousOwnerRole: prevRole ? { key: prevRole.key, name: prevRole.name } : null,
    expiresAt: t.expiresAt.toISOString(),
    createdAt: t.createdAt.toISOString(),
    acceptedAt: t.acceptedAt?.toISOString() ?? null,
    canAccept: pending && ctx.actor.membershipId === t.toMembershipId,
    canCancel: pending && (ctx.actor.membershipId === t.fromMembershipId || ctx.actor.membershipId === t.toMembershipId),
    recipientMfaEnabled: !!recipient?.mfa,
    rowVersion: t.rowVersion,
  };
};

export const currentOwnershipTransfer = async (ctx: QueryContext) => {
  const at = ctx.app.clock.now();
  const [t] = await ctx.app.db
    .select()
    .from(ownershipTransfers)
    .where(and(eq(ownershipTransfers.workspaceId, ctx.actor.workspaceId), eq(ownershipTransfers.status, 'pending'), gt(ownershipTransfers.expiresAt, at)))
    .limit(1);
  const involved = !!t && (t.fromMembershipId === ctx.actor.membershipId || t.toMembershipId === ctx.actor.membershipId);
  const canSee = involved || hasAnywhere(ctx.actor.access, 'access.read');
  const ownerId = await ownerMembershipId(ctx);
  const ownerRef = ownerId && (canSee || hasAnywhere(ctx.actor.access, 'members.read')) ? ((await loadMemberRefs(ctx.app.db, ctx.actor.workspaceId, [ownerId])).get(ownerId) ?? null) : null;
  return { transfer: t && canSee ? await transferView(ctx, t) : null, owner: ownerRef };
};

const workspaceName = async (ctx: CommandContext) => (await ctx.tx.select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, ctx.actor.workspaceId)))[0]?.name ?? 'the workspace';

/** T013: the Owner proposes; nothing changes until the recipient accepts. */
export const proposeOwnershipTransfer = async (ctx: CommandContext, input: { toMembershipId: string; previousOwnerRoleId: string | null }) => {
  if (!ctx.actor.access.isOwner || !hasAnywhere(ctx.actor.access, 'ownership.transfer'))
    throw new AppError('FORBIDDEN', 'Only the workspace Owner can transfer ownership.');
  requireRecentAuth(ctx);
  const at = ctx.app.clock.now();
  if (input.toMembershipId === ctx.actor.membershipId) throw new AppError('VALIDATION_FAILED', 'Choose another member.', { fieldErrors: [{ field: 'toMembershipId', code: 'SELF', message: 'Choose another member.' }] });
  if (!(await isActiveMember(ctx.tx, ctx.actor.workspaceId, input.toMembershipId)))
    throw new AppError('VALIDATION_FAILED', 'The new Owner must be an active member.', { fieldErrors: [{ field: 'toMembershipId', code: 'INACTIVE', message: 'The new Owner must be an active member.' }] });
  let previousKey = 'none';
  if (input.previousOwnerRoleId) {
    const [r] = await ctx.tx.select().from(roles).where(and(eq(roles.workspaceId, ctx.actor.workspaceId), eq(roles.id, input.previousOwnerRoleId)));
    if (!r || r.archivedAt || r.isProtected)
      throw new AppError('VALIDATION_FAILED', 'Choose a role for your access after the transfer.', { fieldErrors: [{ field: 'previousOwnerRoleId', code: 'INVALID', message: 'Choose an active, non-Owner role.' }] });
    previousKey = r.key;
  }
  await ctx.tx
    .update(ownershipTransfers)
    .set({ status: 'expired', ...touch(ctx, ownershipTransfers) })
    .where(and(eq(ownershipTransfers.workspaceId, ctx.actor.workspaceId), eq(ownershipTransfers.status, 'pending'), lte(ownershipTransfers.expiresAt, at)));
  const [pending] = await ctx.tx
    .select({ id: ownershipTransfers.id })
    .from(ownershipTransfers)
    .where(and(eq(ownershipTransfers.workspaceId, ctx.actor.workspaceId), eq(ownershipTransfers.status, 'pending')));
  if (pending) throw new AppError('DUPLICATE', 'An ownership transfer is already pending. Cancel it first.');
  const id = newId();
  const [row] = await ctx.tx
    .insert(ownershipTransfers)
    .values({
      ...stamp(ctx),
      id,
      fromMembershipId: ctx.actor.membershipId!,
      toMembershipId: input.toMembershipId,
      status: 'pending',
      previousOwnerRoleKey: previousKey,
      expiresAt: new Date(at.getTime() + OWNERSHIP_TRANSFER_TTL_HOURS * 3_600_000),
    })
    .returning();
  await audit(ctx, { action: 'ownership.transfer_proposed', entityType: 'ownership_transfer', entityId: id, sensitivity: 'security', metadata: { to: input.toMembershipId, previousOwnerRole: previousKey } });
  await emit(ctx, { type: 'ownership.transfer_proposed', entityType: 'ownership_transfer', entityId: id });
  await notify(ctx.tx, {
    workspaceId: ctx.actor.workspaceId,
    recipientMembershipIds: [input.toMembershipId],
    eventType: 'ownership.transfer_proposed',
    eventKey: `ownership.transfer_proposed:${id}`,
    kind: 'security',
    title: `You were offered ownership of ${await workspaceName(ctx)}`,
    excerpt: 'Review and accept it in Settings → Roles and Access. Accepting requires two-factor authentication.',
    entityType: 'ownership_transfer',
    entityId: id,
    actorMembershipId: ctx.actor.membershipId,
    at,
  });
  return transferView(ctx, row!);
};

const lockTransfer = async (ctx: CommandContext, id: string) => {
  const [t] = await ctx.tx
    .select()
    .from(ownershipTransfers)
    .where(and(eq(ownershipTransfers.workspaceId, ctx.actor.workspaceId), eq(ownershipTransfers.id, id)))
    .for('update');
  const involved = !!t && (t.fromMembershipId === ctx.actor.membershipId || t.toMembershipId === ctx.actor.membershipId);
  if (!t || (!involved && !hasAnywhere(ctx.actor.access, 'access.read'))) throw notFound('Transfer');
  return t;
};

/** Recipient accepts with recent MFA-backed authentication; roles swap atomically (never ownerless). */
export const acceptOwnershipTransfer = async (ctx: CommandContext, id: string) => {
  const t = await lockTransfer(ctx, id);
  const at = ctx.app.clock.now();
  if (t.toMembershipId !== ctx.actor.membershipId) throw new AppError('FORBIDDEN', 'Only the proposed new Owner can accept this transfer.');
  if (t.status !== 'pending') throw new AppError('INVALID_STATE', `This transfer is ${t.status}.`);
  if (t.expiresAt <= at) {
    await ctx.tx.update(ownershipTransfers).set({ status: 'expired', ...touch(ctx, ownershipTransfers) }).where(eq(ownershipTransfers.id, t.id));
    throw new AppError('INVALID_STATE', 'This transfer expired. Ask the Owner to propose it again.');
  }
  const [u] = await ctx.tx.select({ mfa: users.mfaEnabledAt }).from(users).where(eq(users.id, ctx.actor.userId!));
  if (!u?.mfa) throw new AppError('INVALID_STATE', 'Set up two-factor authentication before accepting ownership.', { details: { mfaSetupRequired: true } });
  requireRecentAuth(ctx);
  const [from] = await ctx.tx.select().from(memberships).where(eq(memberships.id, t.fromMembershipId)).for('update');
  const [to] = await ctx.tx.select().from(memberships).where(eq(memberships.id, t.toMembershipId)).for('update');
  if (!from || !to || to.status !== 'active') throw new AppError('INVALID_STATE', 'The transfer can no longer be completed.');
  const [ownerRole] = await ctx.tx.select().from(roles).where(and(eq(roles.workspaceId, ctx.actor.workspaceId), eq(roles.key, 'owner')));
  if (!ownerRole) throw new AppError('INTERNAL', 'The Owner role is missing.');
  const currentOwnerGrants = await ctx.tx
    .select()
    .from(roleAssignments)
    .where(and(eq(roleAssignments.workspaceId, ctx.actor.workspaceId), eq(roleAssignments.roleId, ownerRole.id), eq(roleAssignments.membershipId, from.id), isNull(roleAssignments.revokedAt)));
  if (currentOwnerGrants.length === 0) throw new AppError('INVALID_STATE', 'The proposer is no longer the Owner.');
  await ctx.tx
    .update(roleAssignments)
    .set({ revokedAt: at, revokedBy: ctx.actor.userId, ...touch(ctx, roleAssignments) })
    .where(and(eq(roleAssignments.roleId, ownerRole.id), eq(roleAssignments.membershipId, from.id), isNull(roleAssignments.revokedAt)));
  await ctx.tx.insert(roleAssignments).values({ ...stamp(ctx), id: newId(), membershipId: to.id, roleId: ownerRole.id, scopeType: 'workspace', scopeId: null, validFrom: at, reason: 'Ownership transfer accepted' });
  let previousRoleKey: string | null = null;
  if (t.previousOwnerRoleKey !== 'none') {
    const [prev] = await ctx.tx.select().from(roles).where(and(eq(roles.workspaceId, ctx.actor.workspaceId), eq(roles.key, t.previousOwnerRoleKey), isNull(roles.archivedAt)));
    const [fallback] = prev ? [prev] : await ctx.tx.select().from(roles).where(and(eq(roles.workspaceId, ctx.actor.workspaceId), eq(roles.key, 'admin')));
    if (fallback && !fallback.isProtected) {
      await ctx.tx.insert(roleAssignments).values({ ...stamp(ctx), id: newId(), membershipId: from.id, roleId: fallback.id, scopeType: 'workspace', scopeId: null, validFrom: at, reason: 'Previous Owner after ownership transfer' });
      previousRoleKey = fallback.key;
    }
  }
  const [owners] = await ctx.tx
    .select({ n: count() })
    .from(roleAssignments)
    .innerJoin(memberships, eq(memberships.id, roleAssignments.membershipId))
    .where(and(eq(roleAssignments.workspaceId, ctx.actor.workspaceId), eq(roleAssignments.roleId, ownerRole.id), isNull(roleAssignments.revokedAt), eq(memberships.status, 'active')));
  if (Number(owners?.n ?? 0) !== 1) throw new AppError('INTERNAL', 'Ownership transfer would leave the workspace without exactly one Owner.');
  const [row] = await ctx.tx.update(ownershipTransfers).set({ status: 'accepted', acceptedAt: at, ...touch(ctx, ownershipTransfers) }).where(eq(ownershipTransfers.id, t.id)).returning();
  await bumpAccessRevision(ctx, [from.id, to.id]);
  await audit(ctx, {
    action: 'ownership.transferred',
    entityType: 'ownership_transfer',
    entityId: t.id,
    sensitivity: 'security',
    diff: { owner: { from: from.id, to: to.id } },
    metadata: { previousOwnerRole: previousRoleKey },
  });
  await audit(ctx, { action: 'member.role_granted', entityType: 'membership', entityId: to.id, sensitivity: 'security', diff: { roleGrant: { from: null, to: { role: 'owner', scopeType: 'workspace', scopeId: null } } } });
  await audit(ctx, { action: 'member.role_revoked', entityType: 'membership', entityId: from.id, sensitivity: 'security', diff: { roleGrant: { from: { role: 'owner', scopeType: 'workspace', scopeId: null }, to: previousRoleKey ? { role: previousRoleKey, scopeType: 'workspace', scopeId: null } : null } } });
  await emit(ctx, { type: 'ownership.transferred', entityType: 'ownership_transfer', entityId: t.id });
  await emit(ctx, { type: 'member.access_changed', entityType: 'membership', entityId: to.id });
  await emit(ctx, { type: 'member.access_changed', entityType: 'membership', entityId: from.id });
  await notify(ctx.tx, {
    workspaceId: ctx.actor.workspaceId,
    recipientMembershipIds: [from.id],
    eventType: 'ownership.transferred',
    eventKey: `ownership.transferred:${t.id}`,
    kind: 'security',
    title: `Ownership of ${await workspaceName(ctx)} was transferred`,
    excerpt: previousRoleKey ? 'Your access continues with the role you chose.' : 'You no longer hold a role in this workspace.',
    entityType: 'ownership_transfer',
    entityId: t.id,
    actorMembershipId: ctx.actor.membershipId,
    at,
  });
  return transferView(ctx, row!);
};

export const cancelOwnershipTransfer = async (ctx: CommandContext, id: string, reason?: string) => {
  const t = await lockTransfer(ctx, id);
  if (t.fromMembershipId !== ctx.actor.membershipId && t.toMembershipId !== ctx.actor.membershipId)
    throw new AppError('FORBIDDEN', 'Only the Owner or the recipient can cancel this transfer.');
  if (t.status !== 'pending') throw new AppError('INVALID_STATE', `This transfer is ${t.status}.`);
  const [row] = await ctx.tx.update(ownershipTransfers).set({ status: 'cancelled', ...touch(ctx, ownershipTransfers) }).where(eq(ownershipTransfers.id, t.id)).returning();
  const declined = t.toMembershipId === ctx.actor.membershipId;
  await audit(ctx, { action: declined ? 'ownership.transfer_declined' : 'ownership.transfer_cancelled', entityType: 'ownership_transfer', entityId: t.id, reason: reason ?? null, sensitivity: 'security' });
  await emit(ctx, { type: 'ownership.transfer_cancelled', entityType: 'ownership_transfer', entityId: t.id });
  await notify(ctx.tx, {
    workspaceId: ctx.actor.workspaceId,
    recipientMembershipIds: [declined ? t.fromMembershipId : t.toMembershipId],
    eventType: 'ownership.transfer_cancelled',
    eventKey: `ownership.transfer_cancelled:${t.id}`,
    kind: 'security',
    title: declined ? 'The ownership transfer was declined' : 'The ownership transfer was cancelled',
    entityType: 'ownership_transfer',
    entityId: t.id,
    actorMembershipId: ctx.actor.membershipId,
    at: ctx.app.clock.now(),
  });
  return transferView(ctx, row!);
};


