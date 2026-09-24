import { and, count, eq, gt, isNull, or } from 'drizzle-orm';
import { isSensitivePermission } from '@castlane/authorization';
import {
  accountAssignments,
  invitations,
  memberships,
  ownershipTransfers,
  projectMemberships,
  responsibilityAssignments,
  roleAssignments,
  roles,
  sessions,
  users,
  type ProposedGrant,
} from '@castlane/database';
import { AppError, notFound } from '@castlane/domain';
import { ENTITY_ROUTES, entityHref } from '@castlane/api-contracts';
import { requirePermission, requireRecentAuth } from '../core/access';
import { audit } from '../core/audit';
import { dbOf, type CommandContext, type QueryContext } from '../core/context';
import { hmac, safeEqual, sha256, stableStringify } from '../core/crypto';
import { emit } from '../core/events';
import { enqueueJob } from '../core/jobs';
import { isActiveMember, loadMemberRefs } from '../core/members';
import { notify } from '../core/notify';
import { RESPONSIBILITY_PROVIDERS, inTransferOrder, type ResponsibilityItem, type ResponsibilityResolution } from '../core/responsibility-registry';
import { assertVersion, touch } from '../core/rows';
import { validateGrants } from '../identity/grants';
import { revokeUserSessions } from '../identity/sessions';
import { assertCanGrantRole, insertGrant } from './access';
import { canManageRole, isSensitiveRole } from './grant-rules';
import { indexMember, isWorkspaceOwner } from './members';
import {
  assertGrantScopeWithinManager,
  authorizeMemberAction,
  bumpAccessRevision,
  loadReadableMember,
  scopeLabeler,
  type MembershipRow,
} from './scope';

const IMPACT_TOKEN_TTL_MS = 10 * 60_000;

export interface Resolution {
  kind: string;
  entityId: string;
  successorMembershipId: string | null;
}

interface OpenWorkGroup {
  kind: string;
  label: string;
  unassignedBehaviour: string;
  items: (ResponsibilityItem & { href: string | null })[];
}

/** Everything open the member is responsible for, from every registered provider (F12). */
export const collectOpenWork = async (ctx: QueryContext | CommandContext, membershipId: string): Promise<OpenWorkGroup[]> => {
  const groups: OpenWorkGroup[] = [];
  const providers = [...RESPONSIBILITY_PROVIDERS.values()].sort((a, b) => a.label.localeCompare(b.label));
  for (const p of providers) {
    const items = await p.list(ctx, membershipId);
    if (items.length === 0) continue;
    groups.push({
      kind: p.kind,
      label: p.label,
      unassignedBehaviour: p.unassignedBehaviour,
      items: items.map((i) => ({
        ...i,
        kind: p.kind,
        href: ENTITY_ROUTES[i.entityType] ? entityHref(ctx.actor.workspaceId, i.entityType, i.entityId, { projectId: i.projectId }) : null,
      })),
    });
  }
  return groups;
};

const itemsHash = (groups: OpenWorkGroup[]) =>
  sha256(
    stableStringify(
      groups
        .flatMap((g) => g.items.map((i) => `${g.kind}:${i.entityId}:${i.requiresSuccessor ? 1 : 0}`))
        .sort(),
    ),
  );

const resolutionsHash = (resolutions: Resolution[]) =>
  sha256(
    stableStringify(
      resolutions
        .map((r) => `${r.kind}:${r.entityId}:${r.successorMembershipId ?? '-'}`)
        .sort(),
    ),
  );

const signToken = (secret: string, payload: Record<string, unknown>) => {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${hmac(secret, `deactivate:${body}`)}`;
};

const readToken = (secret: string, token: string): Record<string, unknown> | null => {
  const [body, mac] = token.split('.');
  if (!body || !mac || !safeEqual(mac, hmac(secret, `deactivate:${body}`))) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
};

/** Validate proposed successors against the current item list. */
const checkResolutions = async (ctx: QueryContext | CommandContext, m: MembershipRow, groups: OpenWorkGroup[], resolutions: Resolution[]) => {
  const items = new Map(groups.flatMap((g) => g.items.map((i) => [`${g.kind}:${i.entityId}`, i] as const)));
  const byKey = new Map(resolutions.map((r) => [`${r.kind}:${r.entityId}`, r]));
  const invalid: { kind: string; entityId: string; message: string }[] = [];
  const activeCache = new Map<string, boolean>();
  for (const r of resolutions) {
    if (!items.has(`${r.kind}:${r.entityId}`)) {
      invalid.push({ kind: r.kind, entityId: r.entityId, message: 'This item is no longer open for the member.' });
      continue;
    }
    if (!r.successorMembershipId) continue;
    if (r.successorMembershipId === m.id) {
      invalid.push({ kind: r.kind, entityId: r.entityId, message: 'Choose someone other than the departing member.' });
      continue;
    }
    if (!activeCache.has(r.successorMembershipId)) activeCache.set(r.successorMembershipId, await isActiveMember(dbOf(ctx), ctx.actor.workspaceId, r.successorMembershipId));
    if (!activeCache.get(r.successorMembershipId)) invalid.push({ kind: r.kind, entityId: r.entityId, message: 'The successor must be an active member.' });
  }
  const missing = groups.flatMap((g) =>
    g.items.filter((i) => i.requiresSuccessor && !byKey.get(`${g.kind}:${i.entityId}`)?.successorMembershipId).map((i) => ({ kind: g.kind, entityId: i.entityId, title: i.title })),
  );
  return { invalid, missing };
};

const deactivationEffects = async (ctx: QueryContext | CommandContext, m: MembershipRow) => {
  const db = dbOf(ctx);
  const at = ctx.app.clock.now();
  const n = (r: { n: number }[]) => Number(r[0]?.n ?? 0);
  const grants = await db.select({ n: count() }).from(roleAssignments).where(and(eq(roleAssignments.membershipId, m.id), isNull(roleAssignments.revokedAt)));
  const duties = await db
    .select({ n: count() })
    .from(responsibilityAssignments)
    .where(and(eq(responsibilityAssignments.membershipId, m.id), or(isNull(responsibilityAssignments.validTo), gt(responsibilityAssignments.validTo, at))));
  const teams = await db.select({ n: count() }).from(projectMemberships).where(and(eq(projectMemberships.membershipId, m.id), isNull(projectMemberships.validTo)));
  const accounts = await db.select({ n: count() }).from(accountAssignments).where(and(eq(accountAssignments.membershipId, m.id), isNull(accountAssignments.validTo)));
  const invites = await db
    .select({ n: count() })
    .from(invitations)
    .where(and(eq(invitations.workspaceId, ctx.actor.workspaceId), eq(invitations.invitedByMembershipId, m.id), eq(invitations.status, 'pending'), gt(invitations.expiresAt, at)));
  const live = await db
    .select({ n: count() })
    .from(sessions)
    .where(and(eq(sessions.userId, m.userId), isNull(sessions.revokedAt), gt(sessions.absoluteExpiresAt, at), gt(sessions.idleExpiresAt, at)));
  const reports = await db.select({ n: count() }).from(memberships).where(and(eq(memberships.workspaceId, ctx.actor.workspaceId), eq(memberships.managerMembershipId, m.id)));
  return [
    { kind: 'role_grants', label: 'Role grants revoked (history kept)', count: n(grants) },
    { kind: 'duties', label: 'Duties ended', count: n(duties) },
    { kind: 'project_teams', label: 'Project team assignments ended', count: n(teams) },
    { kind: 'account_assignments', label: 'Account assignments ended', count: n(accounts) },
    { kind: 'invitations', label: 'Pending invitations they sent revoked', count: n(invites) },
    { kind: 'sessions', label: 'Active sessions signed out immediately', count: n(live) },
    { kind: 'reports', label: 'Direct reports left without a manager', count: n(reports) },
  ];
};

const deactivationBlock = async (ctx: QueryContext | CommandContext, m: MembershipRow): Promise<string | null> => {
  if (m.status === 'deactivated') return 'This member is already deactivated.';
  if (ctx.actor.membershipId === m.id) return 'You cannot deactivate yourself.';
  if (await isWorkspaceOwner(ctx, m.id)) return 'The workspace Owner cannot be deactivated. Transfer ownership first so the workspace always has an Owner.';
  for (const p of RESPONSIBILITY_PROVIDERS.values()) {
    const message = p.blocker ? await p.blocker(ctx, m.id) : null;
    if (message) return message;
  }
  return null;
};

export const openWork = async (ctx: QueryContext, membershipId: string) => {
  const m = await loadReadableMember(ctx, membershipId);
  await authorizeMemberAction(ctx, m, 'members.update');
  return { groups: await collectOpenWork(ctx, m.id) };
};

export const deactivationPreview = async (ctx: QueryContext, membershipId: string, input: { resolutions: Resolution[] }) => {
  requirePermission(ctx, 'members.suspend');
  const m = await loadReadableMember(ctx, membershipId);
  await authorizeMemberAction(ctx, m, 'members.suspend');
  const groups = await collectOpenWork(ctx, m.id);
  const { invalid, missing } = await checkResolutions(ctx, m, groups, input.resolutions);
  const blocked = await deactivationBlock(ctx, m);
  const ok = !blocked && invalid.length === 0 && missing.length === 0;
  const expiresAt = new Date(ctx.app.clock.now().getTime() + IMPACT_TOKEN_TTL_MS);
  const ref = (await loadMemberRefs(ctx.app.db, ctx.actor.workspaceId, [m.id])).get(m.id)!;
  return {
    member: ref,
    rowVersion: m.rowVersion,
    groups,
    missingSuccessors: missing,
    invalidSuccessors: invalid,
    effects: await deactivationEffects(ctx, m),
    blocked,
    impactToken: ok
      ? signToken(ctx.app.config.SESSION_SECRET, { m: m.id, v: m.rowVersion, i: itemsHash(groups), r: resolutionsHash(input.resolutions), e: expiresAt.getTime(), a: ctx.actor.membershipId })
      : null,
    expiresAt: ok ? expiresAt.toISOString() : null,
  };
};

/** Run provider transfers for the given resolutions (items without a successor go to the provider's unassigned behaviour). */
const runTransfers = async (ctx: CommandContext, m: MembershipRow, groups: OpenWorkGroup[], resolutions: Resolution[], includeUnresolved: boolean) => {
  const byKey = new Map(resolutions.map((r) => [`${r.kind}:${r.entityId}`, r]));
  let transferred = 0;
  for (const g of inTransferOrder(groups)) {
    const provider = RESPONSIBILITY_PROVIDERS.get(g.kind);
    if (!provider) continue;
    const list: ResponsibilityResolution[] = [];
    for (const i of g.items) {
      const r = byKey.get(`${g.kind}:${i.entityId}`);
      if (r) list.push({ entityId: i.entityId, successorMembershipId: r.successorMembershipId });
      else if (includeUnresolved) list.push({ entityId: i.entityId, successorMembershipId: null });
    }
    if (list.length === 0) continue;
    await provider.transfer(ctx, m.id, list);
    transferred += list.filter((x) => x.successorMembershipId).length;
  }
  return transferred;
};

export const transferWork = async (ctx: CommandContext, membershipId: string, input: { resolutions: Resolution[]; reason?: string }) => {
  const m = await loadReadableMember(ctx, membershipId, { lock: true });
  await authorizeMemberAction(ctx, m, 'members.update');
  if (m.status === 'deactivated') throw new AppError('INVALID_STATE', 'Use Restore before changing a deactivated member’s work.');
  if (input.resolutions.some((r) => !r.successorMembershipId))
    throw new AppError('VALIDATION_FAILED', 'Choose a successor for every selected item.', { fieldErrors: [{ field: 'resolutions', code: 'SUCCESSOR_REQUIRED', message: 'Choose a successor for every selected item.' }] });
  const groups = await collectOpenWork(ctx, m.id);
  const { invalid } = await checkResolutions(ctx, m, groups, input.resolutions);
  if (invalid.length) throw new AppError('INVALID_STATE', invalid[0]!.message, { details: { invalid } });
  const selected = new Set(input.resolutions.map((r) => `${r.kind}:${r.entityId}`));
  const onlySelected = groups.map((g) => ({ ...g, items: g.items.filter((i) => selected.has(`${g.kind}:${i.entityId}`)) }));
  const transferred = await runTransfers(ctx, m, onlySelected, input.resolutions, false);
  await audit(ctx, {
    action: 'member.work_transferred',
    entityType: 'membership',
    entityId: m.id,
    reason: input.reason ?? null,
    metadata: { items: input.resolutions.map((r) => ({ kind: r.kind, entityId: r.entityId, successor: r.successorMembershipId })) },
  });
  await emit(ctx, { type: 'member.work_transferred', entityType: 'membership', entityId: m.id });
  return { transferred };
};

export const deactivateMember = async (ctx: CommandContext, membershipId: string, input: { impactToken: string; resolutions: Resolution[]; reason: string }) => {
  requirePermission(ctx, 'members.suspend');
  requireRecentAuth(ctx);
  const m = await loadReadableMember(ctx, membershipId, { lock: true });
  await authorizeMemberAction(ctx, m, 'members.suspend');
  assertVersion(ctx, m);
  const blocked = await deactivationBlock(ctx, m);
  if (blocked) throw new AppError('INVALID_STATE', blocked);
  const at = ctx.app.clock.now();
  const payload = readToken(ctx.app.config.SESSION_SECRET, input.impactToken);
  if (!payload || payload.m !== m.id || payload.a !== ctx.actor.membershipId) throw new AppError('VALIDATION_FAILED', 'The impact preview is not valid. Preview again.');
  if (typeof payload.e !== 'number' || payload.e < at.getTime()) throw new AppError('INVALID_STATE', 'The impact preview expired. Preview again.', { details: { stalePreview: true } });
  if (payload.r !== resolutionsHash(input.resolutions)) throw new AppError('VALIDATION_FAILED', 'The successors differ from the reviewed preview. Preview again.');
  const groups = await collectOpenWork(ctx, m.id);
  if (payload.i !== itemsHash(groups) || payload.v !== m.rowVersion)
    throw new AppError('INVALID_STATE', 'Some responsibilities changed after the preview. Review the impact again.', { details: { stalePreview: true } });
  const { invalid, missing } = await checkResolutions(ctx, m, groups, input.resolutions);
  if (invalid.length || missing.length) throw new AppError('INVALID_STATE', 'Choose valid successors for every required item.', { details: { invalid, missing } });

  // 1. Hand over open work (providers audit and notify like normal reassignments).
  const transferred = await runTransfers(ctx, m, groups, input.resolutions, true);
  // 2. Revoke access; history rows stay (revoked_at), so Restore can show what was removed.
  const revoked = await ctx.tx
    .update(roleAssignments)
    .set({ revokedAt: at, revokedBy: ctx.actor.userId, ...touch(ctx, roleAssignments) })
    .where(and(eq(roleAssignments.workspaceId, ctx.actor.workspaceId), eq(roleAssignments.membershipId, m.id), isNull(roleAssignments.revokedAt)))
    .returning({ id: roleAssignments.id });
  await ctx.tx
    .update(responsibilityAssignments)
    .set({ validTo: at, ...touch(ctx, responsibilityAssignments) })
    .where(and(eq(responsibilityAssignments.membershipId, m.id), or(isNull(responsibilityAssignments.validTo), gt(responsibilityAssignments.validTo, at))));
  const teams = await ctx.tx
    .update(projectMemberships)
    .set({ validTo: at, endedReason: 'Member deactivated', ...touch(ctx, projectMemberships) })
    .where(and(eq(projectMemberships.membershipId, m.id), isNull(projectMemberships.validTo)))
    .returning({ id: projectMemberships.id });
  const accounts = await ctx.tx
    .update(accountAssignments)
    .set({ validTo: at, endedReason: 'Member deactivated', ...touch(ctx, accountAssignments) })
    .where(and(eq(accountAssignments.membershipId, m.id), isNull(accountAssignments.validTo)))
    .returning({ id: accountAssignments.id });
  // 3. Invitations they sent that were not accepted yet are cancelled; pending ownership transfers end.
  const invites = await ctx.tx
    .update(invitations)
    .set({ status: 'revoked', revokedAt: at, ...touch(ctx, invitations) })
    .where(and(eq(invitations.workspaceId, ctx.actor.workspaceId), eq(invitations.invitedByMembershipId, m.id), eq(invitations.status, 'pending')))
    .returning({ id: invitations.id });
  await ctx.tx
    .update(ownershipTransfers)
    .set({ status: 'cancelled', ...touch(ctx, ownershipTransfers) })
    .where(
      and(
        eq(ownershipTransfers.workspaceId, ctx.actor.workspaceId),
        eq(ownershipTransfers.status, 'pending'),
        or(eq(ownershipTransfers.fromMembershipId, m.id), eq(ownershipTransfers.toMembershipId, m.id)),
      ),
    );
  const reports = await ctx.tx
    .update(memberships)
    .set({ managerMembershipId: null, ...touch(ctx, memberships) })
    .where(and(eq(memberships.workspaceId, ctx.actor.workspaceId), eq(memberships.managerMembershipId, m.id)))
    .returning({ id: memberships.id });
  // 4. Membership state; the display snapshot keeps historical authorship readable.
  const [u] = await ctx.tx.select({ name: users.displayName }).from(users).where(eq(users.id, m.userId));
  await ctx.tx
    .update(memberships)
    .set({ status: 'deactivated', deactivatedAt: at, deactivatedBy: ctx.actor.userId, suspendedAt: null, displayNameSnapshot: u?.name ?? m.displayNameSnapshot, ...touch(ctx, memberships) })
    .where(eq(memberships.id, m.id));
  await bumpAccessRevision(ctx, [m.id]);
  // 5. Sessions end immediately (T019).
  const sessionsRevoked = await revokeUserSessions(ctx.tx, m.userId, at, 'member_deactivated');
  await audit(ctx, {
    action: 'member.deactivated',
    entityType: 'membership',
    entityId: m.id,
    reason: input.reason,
    sensitivity: 'security',
    diff: { status: { from: m.status, to: 'deactivated' } },
    metadata: {
      transferred,
      items: input.resolutions.map((r) => ({ kind: r.kind, entityId: r.entityId, successor: r.successorMembershipId })),
      rolesRevoked: revoked.length,
      teamsEnded: teams.length,
      accountAssignmentsEnded: accounts.length,
      invitationsRevoked: invites.length,
      reportsUnassigned: reports.length,
      sessionsRevoked,
    },
  });
  await emit(ctx, { type: 'member.deactivated', entityType: 'membership', entityId: m.id });
  await indexMember(ctx, m.id);
  return m.id;
};

// ——— Suspend / reactivate / sessions ———

export const suspendMember = async (ctx: CommandContext, membershipId: string, reason: string) => {
  requirePermission(ctx, 'members.suspend');
  requireRecentAuth(ctx);
  const m = await loadReadableMember(ctx, membershipId, { lock: true });
  await authorizeMemberAction(ctx, m, 'members.suspend');
  assertVersion(ctx, m);
  if (ctx.actor.membershipId === m.id) throw new AppError('FORBIDDEN', 'You cannot suspend yourself.');
  if (m.status !== 'active') throw new AppError('INVALID_STATE', `Only active members can be suspended (current: ${m.status}).`);
  if (await isWorkspaceOwner(ctx, m.id)) throw new AppError('INVALID_STATE', 'The workspace Owner cannot be suspended.');
  const at = ctx.app.clock.now();
  await ctx.tx.update(memberships).set({ status: 'suspended', suspendedAt: at, ...touch(ctx, memberships) }).where(eq(memberships.id, m.id));
  await bumpAccessRevision(ctx, [m.id]);
  await audit(ctx, { action: 'member.suspended', entityType: 'membership', entityId: m.id, reason, sensitivity: 'security', diff: { status: { from: 'active', to: 'suspended' } } });
  await emit(ctx, { type: 'member.suspended', entityType: 'membership', entityId: m.id });
  await indexMember(ctx, m.id);
  return m.id;
};

export const reactivateMember = async (ctx: CommandContext, membershipId: string, reason?: string) => {
  requirePermission(ctx, 'members.suspend');
  requireRecentAuth(ctx);
  const m = await loadReadableMember(ctx, membershipId, { lock: true });
  await authorizeMemberAction(ctx, m, 'members.suspend');
  assertVersion(ctx, m);
  if (m.status !== 'suspended') throw new AppError('INVALID_STATE', 'Only suspended members can be reactivated. Use Restore for deactivated members.');
  await ctx.tx.update(memberships).set({ status: 'active', suspendedAt: null, ...touch(ctx, memberships) }).where(eq(memberships.id, m.id));
  await bumpAccessRevision(ctx, [m.id]);
  await audit(ctx, { action: 'member.reactivated', entityType: 'membership', entityId: m.id, reason: reason ?? null, sensitivity: 'security', diff: { status: { from: 'suspended', to: 'active' } } });
  await emit(ctx, { type: 'member.reactivated', entityType: 'membership', entityId: m.id });
  await indexMember(ctx, m.id);
  return m.id;
};

export const revokeMemberSessions = async (ctx: CommandContext, membershipId: string, reason: string) => {
  requirePermission(ctx, 'security.sessions.revoke');
  const m = await loadReadableMember(ctx, membershipId, { lock: true });
  await authorizeMemberAction(ctx, m, 'security.sessions.revoke');
  if (ctx.actor.membershipId === m.id) throw new AppError('FORBIDDEN', 'Use Personal Settings → Security to sign out your own sessions.');
  const at = ctx.app.clock.now();
  const revoked = await revokeUserSessions(ctx.tx, m.userId, at, 'revoked_by_admin');
  const [u] = await ctx.tx.select({ email: users.displayEmail }).from(users).where(eq(users.id, m.userId));
  if (u)
    await enqueueJob(ctx.tx, {
      type: 'mail.send',
      workspaceId: ctx.actor.workspaceId,
      payload: { template: 'securityAlert', to: u.email, vars: { event: 'An administrator signed out all your sessions', when: at.toISOString() } },
    });
  await audit(ctx, { action: 'member.sessions_revoked', entityType: 'membership', entityId: m.id, reason, sensitivity: 'security', metadata: { revoked } });
  return { revoked };
};

// ——— Restore (T020) ———

const previousGrants = async (ctx: QueryContext | CommandContext, m: MembershipRow) => {
  if (!m.deactivatedAt) return [];
  return dbOf(ctx)
    .select({ ra: roleAssignments, role: roles })
    .from(roleAssignments)
    .innerJoin(roles, and(eq(roles.id, roleAssignments.roleId), eq(roles.workspaceId, roleAssignments.workspaceId)))
    .where(and(eq(roleAssignments.workspaceId, ctx.actor.workspaceId), eq(roleAssignments.membershipId, m.id), eq(roleAssignments.revokedAt, m.deactivatedAt)));
};

export const restoreMemberPreview = async (ctx: QueryContext, membershipId: string) => {
  requirePermission(ctx, 'members.suspend');
  const m = await loadReadableMember(ctx, membershipId);
  await authorizeMemberAction(ctx, m, 'members.suspend');
  const prev = m.status === 'deactivated' ? await previousGrants(ctx, m) : [];
  const label = await scopeLabeler(ctx, prev.map((p) => p.ra));
  const ref = (await loadMemberRefs(ctx.app.db, ctx.actor.workspaceId, [m.id])).get(m.id)!;
  const view = prev.map(({ ra, role }) => {
    const sensitive = isSensitiveRole(role);
    const grantable = !role.archivedAt && canManageRole(ctx.actor.access, role);
    return {
      roleId: role.id,
      roleKey: role.key,
      roleName: role.name,
      scopeType: ra.scopeType,
      scopeId: ra.scopeId,
      scopeLabel: label(ra.scopeType, ra.scopeId),
      sensitive,
      grantable,
      note: role.archivedAt
        ? 'The role was archived.'
        : sensitive
          ? `Not restored automatically: contains ${role.key === 'admin' ? 'administration' : 'sensitive'} permissions (${role.permissions.filter(isSensitivePermission).slice(0, 3).join(', ') || 'Admin'}). Select it explicitly if still needed.`
          : grantable
            ? null
            : 'You cannot grant this role.',
    };
  });
  return {
    member: ref,
    rowVersion: m.rowVersion,
    status: m.status,
    previousGrants: view,
    suggestedGrants: view.filter((g) => !g.sensitive && g.grantable).map((g) => ({ roleId: g.roleId, scopeType: g.scopeType, scopeId: g.scopeId })),
  };
};

export const restoreMember = async (ctx: CommandContext, membershipId: string, input: { reason: string; grants: ProposedGrant[] }) => {
  requirePermission(ctx, 'members.suspend');
  requireRecentAuth(ctx);
  const m = await loadReadableMember(ctx, membershipId, { lock: true });
  await authorizeMemberAction(ctx, m, 'members.suspend');
  assertVersion(ctx, m);
  if (m.status !== 'deactivated') throw new AppError('INVALID_STATE', 'Only deactivated members can be restored.');
  const [u] = await ctx.tx.select({ status: users.status }).from(users).where(eq(users.id, m.userId));
  if (u?.status !== 'active') throw new AppError('INVALID_STATE', 'The person’s account is disabled and cannot be restored here.');
  const at = ctx.app.clock.now();
  if (input.grants.length) {
    requirePermission(ctx, 'access.manage');
    const valid = await validateGrants(ctx.tx, ctx, input.grants);
    if (!valid.ok) throw new AppError(valid.code === 'invalid_scope' ? 'VALIDATION_FAILED' : 'FORBIDDEN', valid.message);
    for (const g of input.grants) await assertGrantScopeWithinManager(ctx, g.scopeType, g.scopeId);
  }
  const prev = await previousGrants(ctx, m);
  await ctx.tx.update(memberships).set({ status: 'active', restoredAt: at, ...touch(ctx, memberships) }).where(eq(memberships.id, m.id));
  const granted: string[] = [];
  for (const g of input.grants) {
    const [role] = await ctx.tx.select().from(roles).where(and(eq(roles.workspaceId, ctx.actor.workspaceId), eq(roles.id, g.roleId)));
    if (!role) throw notFound('Role');
    assertCanGrantRole(ctx, role);
    const scopeId = ['direction', 'project', 'account'].includes(g.scopeType) ? g.scopeId : null;
    await insertGrant(ctx, { membershipId: m.id, role, scopeType: g.scopeType, scopeId, reason: 'Restored member' });
    granted.push(`${role.key}:${g.scopeType}${scopeId ? `:${scopeId}` : ''}`);
  }
  const grantedKeys = new Set(input.grants.map((g) => `${g.roleId}:${g.scopeType}:${g.scopeId ?? ''}`));
  const notRestored = prev.filter((p) => !grantedKeys.has(`${p.role.id}:${p.ra.scopeType}:${p.ra.scopeId ?? ''}`));
  await bumpAccessRevision(ctx, [m.id]);
  await audit(ctx, {
    action: 'member.restored',
    entityType: 'membership',
    entityId: m.id,
    reason: input.reason,
    sensitivity: 'security',
    diff: { status: { from: 'deactivated', to: 'active' } },
    metadata: {
      granted,
      notRestored: notRestored.map((p) => ({ role: p.role.key, scopeType: p.ra.scopeType, scopeId: p.ra.scopeId, sensitive: isSensitiveRole(p.role) })),
    },
  });
  await emit(ctx, { type: 'member.restored', entityType: 'membership', entityId: m.id });
  await notify(ctx.tx, {
    workspaceId: ctx.actor.workspaceId,
    recipientMembershipIds: [m.id],
    eventType: 'member.restored',
    eventKey: `member.restored:${m.id}:${at.toISOString()}`,
    kind: 'security',
    title: 'Your membership was restored',
    excerpt: granted.length ? 'Access was granted again as chosen by an administrator.' : 'No roles were granted yet; an administrator will assign your access.',
    entityType: 'membership',
    entityId: m.id,
    actorMembershipId: ctx.actor.membershipId,
    at,
  });
  await indexMember(ctx, m.id);
  return m.id;
};
