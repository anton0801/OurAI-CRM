import { and, desc, eq, gt, ilike, inArray, lt, lte, or, type SQL } from 'drizzle-orm';
import { invitationRequests, invitations, memberships, roles, users, type ProposedGrant } from '@castlane/database';
import { AppError, clampPageSize, decodeCursor, encodeCursor, normalizeEmail, notFound } from '@castlane/domain';
import { requirePermission } from '../core/access';
import { audit } from '../core/audit';
import { dbOf, type CommandContext, type QueryContext } from '../core/context';
import { emit } from '../core/events';
import { loadMemberRefs } from '../core/members';
import { touch } from '../core/rows';
import { validateGrants } from '../identity/grants';
import { inviteMember, resendInvitation, revokeInvitation, type InviteOutcome } from '../identity/invitations';
import { assertGrantScopeWithinManager, scopeLabeler } from './scope';

type InvitationDb = typeof invitations.$inferSelect;

const OUTCOME_MESSAGE: Record<InviteOutcome, string> = {
  queued: 'Invitation queued for delivery. Delivery status updates when the mail transport accepts it.',
  resent: 'The previous link was revoked and a new invitation was queued.',
  already_member: 'This person is already an active member.',
  invalid_role: 'You cannot grant the selected role.',
  invalid_scope: 'The selected scope is not valid.',
};

const effectiveStatus = (inv: InvitationDb, at: Date): InvitationDb['status'] =>
  inv.status === 'pending' && inv.expiresAt <= at ? 'expired' : inv.status;

const grantSummaries = async (ctx: QueryContext | CommandContext, grants: ProposedGrant[]) => {
  const ids = [...new Set(grants.map((g) => g.roleId))];
  const roleRows = ids.length
    ? await dbOf(ctx)
        .select({ id: roles.id, key: roles.key, name: roles.name })
        .from(roles)
        .where(and(eq(roles.workspaceId, ctx.actor.workspaceId), inArray(roles.id, ids)))
    : [];
  const byId = new Map(roleRows.map((r) => [r.id, r]));
  const label = await scopeLabeler(ctx, grants);
  return (list: ProposedGrant[]) =>
    list.map((g) => ({
      roleId: g.roleId,
      roleKey: byId.get(g.roleId)?.key ?? 'unknown',
      roleName: byId.get(g.roleId)?.name ?? 'Deleted role',
      scopeType: g.scopeType,
      scopeId: g.scopeId,
      scopeLabel: label(g.scopeType, g.scopeId),
    }));
};

export const listInvitations = async (
  ctx: QueryContext,
  input: { cursor?: string; pageSize?: number; status?: InvitationDb['status'][]; q?: string },
) => {
  requirePermission(ctx, 'members.invite');
  const at = ctx.app.clock.now();
  const size = clampPageSize(input.pageSize);
  const c = input.cursor ? decodeCursor(input.cursor) : null;
  const statusConds: SQL[] = [];
  for (const s of input.status ?? []) {
    if (s === 'pending') statusConds.push(and(eq(invitations.status, 'pending'), gt(invitations.expiresAt, at))!);
    else if (s === 'expired') statusConds.push(or(eq(invitations.status, 'expired'), and(eq(invitations.status, 'pending'), lte(invitations.expiresAt, at)))!);
    else statusConds.push(eq(invitations.status, s));
  }
  const q = input.q?.trim();
  const rows = await ctx.app.db
    .select()
    .from(invitations)
    .where(
      and(
        eq(invitations.workspaceId, ctx.actor.workspaceId),
        statusConds.length ? or(...statusConds) : undefined,
        q ? ilike(invitations.emailDisplay, `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`) : undefined,
        c ? or(lt(invitations.createdAt, new Date(String(c.v[0]))), and(eq(invitations.createdAt, new Date(String(c.v[0]))), lt(invitations.id, c.id))) : undefined,
      ),
    )
    .orderBy(desc(invitations.createdAt), desc(invitations.id))
    .limit(size + 1);
  const hasMore = rows.length > size;
  const page = hasMore ? rows.slice(0, size) : rows;
  const openReq = page.length
    ? await ctx.app.db
        .select({ invitationId: invitationRequests.invitationId })
        .from(invitationRequests)
        .where(and(inArray(invitationRequests.invitationId, page.map((p) => p.id)), eq(invitationRequests.status, 'open')))
    : [];
  const open = new Set(openReq.map((r) => r.invitationId));
  const refs = await loadMemberRefs(ctx.app.db, ctx.actor.workspaceId, page.flatMap((p) => [p.invitedByMembershipId, p.acceptedMembershipId]));
  const summarize = await grantSummaries(ctx, page.flatMap((p) => p.proposedGrants));
  const items = page.map((inv) => ({
    id: inv.id,
    email: inv.emailDisplay,
    status: effectiveStatus(inv, at),
    deliveryStatus: inv.deliveryStatus,
    deliveryError: inv.deliveryError,
    lastSentAt: inv.lastSentAt?.toISOString() ?? null,
    resendCount: inv.resendCount,
    expiresAt: inv.expiresAt.toISOString(),
    createdAt: inv.createdAt.toISOString(),
    invitedBy: inv.invitedByMembershipId ? (refs.get(inv.invitedByMembershipId) ?? null) : null,
    acceptedMember: inv.acceptedMembershipId ? (refs.get(inv.acceptedMembershipId) ?? null) : null,
    grants: summarize(inv.proposedGrants),
    openRequest: open.has(inv.id),
    rowVersion: inv.rowVersion,
  }));
  const last = page[page.length - 1];
  return { items, hasMore, nextCursor: hasMore && last ? encodeCursor({ v: [last.createdAt.toISOString()], id: last.id }) : null };
};

/**
 * Invite from Team (S61). Grants are validated against the inviter's own rights (no escalation,
 * Owner-only Admin/finance roles) and a scoped inviter may only invite into their own scope.
 */
export const inviteToWorkspace = async (ctx: CommandContext, input: { email: string; grants: ProposedGrant[] }) => {
  requirePermission(ctx, 'members.invite');
  const email = normalizeEmail(input.email);
  const [existing] = await ctx.tx
    .select({ id: memberships.id, status: memberships.status })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.workspaceId, ctx.actor.workspaceId), eq(users.normalizedEmail, email)));
  if (existing?.status === 'active')
    throw new AppError('DUPLICATE', OUTCOME_MESSAGE.already_member, { fieldErrors: [{ field: 'email', code: 'ALREADY_MEMBER', message: OUTCOME_MESSAGE.already_member }] });
  if (existing?.status === 'suspended')
    throw new AppError('INVALID_STATE', 'This person is suspended. Reactivate them from their member page instead of inviting them again.');
  for (const g of input.grants) await assertGrantScopeWithinManager(ctx, g.scopeType, g.scopeId, 'members.invite');
  const valid = await validateGrants(ctx.tx, ctx, input.grants);
  if (!valid.ok) {
    if (valid.code === 'invalid_scope') throw new AppError('VALIDATION_FAILED', valid.message, { fieldErrors: [{ field: 'grants', code: 'INVALID_SCOPE', message: valid.message }] });
    throw new AppError('FORBIDDEN', valid.message);
  }
  const r = await inviteMember(ctx, { email: input.email, grants: input.grants });
  return { ...r, message: OUTCOME_MESSAGE[r.outcome] };
};

const lockInvitation = async (ctx: CommandContext, invitationId: string) => {
  const [inv] = await ctx.tx
    .select()
    .from(invitations)
    .where(and(eq(invitations.workspaceId, ctx.actor.workspaceId), eq(invitations.id, invitationId)))
    .for('update');
  if (!inv) throw notFound('Invitation');
  return inv;
};

export const resendWorkspaceInvitation = async (ctx: CommandContext, invitationId: string) => {
  requirePermission(ctx, 'members.invite');
  const inv = await lockInvitation(ctx, invitationId);
  const r = await resendInvitation(ctx, inv.id);
  if (r.outcome === 'invalid_role' || r.outcome === 'invalid_scope')
    throw new AppError('FORBIDDEN', `${OUTCOME_MESSAGE[r.outcome]} Create a new invitation with a role you may grant.`);
  if (r.outcome === 'already_member') throw new AppError('INVALID_STATE', OUTCOME_MESSAGE.already_member);
  await emit(ctx, { type: 'invitation.resent', entityType: 'invitation', entityId: inv.id });
  return { ...r, message: OUTCOME_MESSAGE[r.outcome] };
};

export const revokeWorkspaceInvitation = async (ctx: CommandContext, invitationId: string) => {
  requirePermission(ctx, 'members.invite');
  const inv = await lockInvitation(ctx, invitationId);
  await revokeInvitation(ctx, inv.id);
  // Open "request new invitation" entries for this invitation are closed with it.
  await ctx.tx
    .update(invitationRequests)
    .set({ status: 'dismissed', resolvedAt: ctx.app.clock.now(), ...touch(ctx, invitationRequests) })
    .where(and(eq(invitationRequests.invitationId, inv.id), eq(invitationRequests.status, 'open')));
  await emit(ctx, { type: 'invitation.revoked', entityType: 'invitation', entityId: inv.id });
  return { ok: true as const };
};

export const listInvitationRequests = async (ctx: QueryContext, input: { status: 'open' | 'resolved' | 'dismissed' | 'all' }) => {
  requirePermission(ctx, 'members.invite');
  const at = ctx.app.clock.now();
  const rows = await ctx.app.db
    .select({ r: invitationRequests, inv: invitations })
    .from(invitationRequests)
    .innerJoin(invitations, eq(invitations.id, invitationRequests.invitationId))
    .where(and(eq(invitationRequests.workspaceId, ctx.actor.workspaceId), input.status === 'all' ? undefined : eq(invitationRequests.status, input.status)))
    .orderBy(desc(invitationRequests.createdAt))
    .limit(200);
  const summarize = await grantSummaries(ctx, rows.flatMap((r) => r.inv.proposedGrants));
  return rows.map(({ r, inv }) => ({
    id: r.id,
    invitationId: inv.id,
    email: inv.emailDisplay,
    status: r.status,
    createdAt: r.createdAt.toISOString(),
    resolvedAt: r.resolvedAt?.toISOString() ?? null,
    invitationStatus: effectiveStatus(inv, at),
    grants: summarize(inv.proposedGrants),
  }));
};

export const resolveInvitationRequest = async (ctx: CommandContext, requestId: string, input: { action: 'resend' | 'dismiss' }) => {
  requirePermission(ctx, 'members.invite');
  const [req] = await ctx.tx
    .select()
    .from(invitationRequests)
    .where(and(eq(invitationRequests.workspaceId, ctx.actor.workspaceId), eq(invitationRequests.id, requestId)))
    .for('update');
  if (!req) throw notFound('Request');
  if (req.status !== 'open') throw new AppError('INVALID_STATE', 'This request was already handled.');
  const inv = await lockInvitation(ctx, req.invitationId);
  const at = ctx.app.clock.now();
  let outcome: InviteOutcome | null = null;
  if (input.action === 'resend') {
    if (inv.status === 'accepted') throw new AppError('INVALID_STATE', 'This invitation was already accepted.');
    const r = inv.status === 'revoked' ? await inviteMember(ctx, { email: inv.emailDisplay, grants: inv.proposedGrants }) : await resendInvitation(ctx, inv.id);
    if (r.outcome === 'invalid_role' || r.outcome === 'invalid_scope')
      throw new AppError('FORBIDDEN', `${OUTCOME_MESSAGE[r.outcome]} Invite the person again with a role you may grant.`);
    outcome = r.outcome;
  }
  const status = input.action === 'resend' ? 'resolved' : 'dismissed';
  await ctx.tx.update(invitationRequests).set({ status, resolvedAt: at, ...touch(ctx, invitationRequests) }).where(eq(invitationRequests.id, req.id));
  await audit(ctx, { action: `invitation.request_${status}`, entityType: 'invitation', entityId: inv.id, sensitivity: 'security', metadata: { requestId: req.id } });
  await emit(ctx, { type: 'invitation.request_resolved', entityType: 'invitation', entityId: inv.id });
  return {
    status: status as 'resolved' | 'dismissed',
    outcome,
    message: outcome ? OUTCOME_MESSAGE[outcome] : 'The request was dismissed. No invitation was sent.',
  };
};


