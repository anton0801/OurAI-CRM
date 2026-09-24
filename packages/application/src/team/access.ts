import { and, desc, eq, gt, inArray, isNull, or } from 'drizzle-orm';
import {
  PERMISSION_GROUPS,
  explain,
  hasAnywhere,
  isPermission,
  isSensitivePermission,
  type AccessSnapshot,
  type ObjectScope,
} from '@castlane/authorization';
import { accessDenies, directions, memberships, projects, roleAssignments, roles, socialAccounts, users, workspaces, type DbOrTx } from '@castlane/database';
import { AppError, forbidden, newId, notFound } from '@castlane/domain';
import { allowed, loadAccessSnapshot, requirePermission, requireRecentAuth } from '../core/access';
import { audit } from '../core/audit';
import { dbOf, type CommandContext, type QueryContext } from '../core/context';
import { emit } from '../core/events';
import { loadMemberRefs, type MemberRef } from '../core/members';
import { notify } from '../core/notify';
import { assertVersion, lockById, stamp, touch } from '../core/rows';
import { userRequiresMfa } from '../identity/auth';
import { LINK_ACCESS } from '../media/link-access';
import { isWorkspaceOwner } from './members';
import { canManagePattern, canManageRole, expandPermissionPattern, isSensitiveRole, roleNeedsOwner } from './grant-rules';
import {
  assertGrantScopeWithinManager,
  assertNotSelf,
  assertScopeObject,
  authorizeMemberAction,
  bumpAccessRevision,
  canActOnMember,
  loadReadableMember,
  memberVisibility,
  memberVisibilitySql,
  scopeLabeler,
  type MembershipRow,
} from './scope';

type GrantDbRow = typeof roleAssignments.$inferSelect;
type RoleDbRow = typeof roles.$inferSelect;

const matchesPermission = (pattern: string, permission: string): boolean =>
  pattern === '*' || pattern === permission || (pattern.endsWith('.*') && permission.startsWith(pattern.slice(0, -1)));

/** userId → member reference in this workspace (audit columns store user ids). */
export const refsByUser = async (db: DbOrTx, workspaceId: string, userIds: (string | null | undefined)[]): Promise<Map<string, MemberRef>> => {
  const ids = [...new Set(userIds.filter((x): x is string => !!x))];
  const out = new Map<string, MemberRef>();
  if (ids.length === 0) return out;
  const rows = await db
    .select({ id: memberships.id, userId: memberships.userId })
    .from(memberships)
    .where(and(eq(memberships.workspaceId, workspaceId), inArray(memberships.userId, ids)));
  const refs = await loadMemberRefs(db, workspaceId, rows.map((r) => r.id));
  for (const r of rows) {
    const ref = refs.get(r.id);
    if (ref) out.set(r.userId, ref);
  }
  return out;
};

/** Build API grant rows (labels, actors, sensitivity, revocability for the viewer). */
export const toGrantRows = async (ctx: QueryContext | CommandContext, rows: { ra: GrantDbRow; role: RoleDbRow }[]) => {
  const db = dbOf(ctx);
  const label = await scopeLabeler(ctx, rows.map((r) => r.ra));
  const people = await refsByUser(db, ctx.actor.workspaceId, rows.flatMap((r) => [r.ra.createdBy, r.ra.revokedBy]));
  const manageable = new Map<string, boolean>();
  for (const id of new Set(rows.map((r) => r.ra.membershipId))) manageable.set(id, id !== ctx.actor.membershipId && (await canActOnMember(ctx, id, 'access.manage')));
  const at = ctx.app.clock.now();
  return rows.map(({ ra, role }) => ({
    id: ra.id,
    roleId: role.id,
    roleKey: role.key,
    roleName: role.name,
    scopeType: ra.scopeType,
    scopeId: ra.scopeId,
    scopeLabel: label(ra.scopeType, ra.scopeId),
    validFrom: ra.validFrom.toISOString(),
    validTo: ra.validTo?.toISOString() ?? null,
    revokedAt: ra.revokedAt?.toISOString() ?? null,
    revokedBy: ra.revokedBy ? (people.get(ra.revokedBy) ?? null) : null,
    reason: ra.reason,
    grantedBy: ra.createdBy ? (people.get(ra.createdBy) ?? null) : null,
    sensitive: isSensitiveRole(role),
    canRevoke: !ra.revokedAt && (!ra.validTo || ra.validTo > at) && !!manageable.get(ra.membershipId) && canManageRole(ctx.actor.access, role),
    rowVersion: ra.rowVersion,
  }));
};

const toDenyRows = async (ctx: QueryContext | CommandContext, rows: (typeof accessDenies.$inferSelect)[]) => {
  const db = dbOf(ctx);
  const label = await scopeLabeler(ctx, rows.map((d) => ({ scopeType: d.objectType ?? 'workspace', scopeId: d.objectId })));
  const people = await refsByUser(db, ctx.actor.workspaceId, rows.map((d) => d.createdBy));
  const out = [];
  for (const d of rows) {
    const manage = d.membershipId !== ctx.actor.membershipId && (await canActOnMember(ctx, d.membershipId, 'access.manage')) && canManagePattern(ctx.actor.access, d.permission);
    out.push({
      id: d.id,
      permission: d.permission,
      objectType: (d.objectType as 'project' | 'account' | 'direction' | null) ?? null,
      objectId: d.objectId,
      objectLabel: d.objectType && d.objectId ? label(d.objectType, d.objectId) : null,
      reason: d.reason,
      createdAt: d.createdAt.toISOString(),
      createdBy: d.createdBy ? (people.get(d.createdBy) ?? null) : null,
      canRevoke: manage && !d.revokedAt,
      rowVersion: d.rowVersion,
    });
  }
  return out;
};

const memberSnapshot = async (ctx: QueryContext | CommandContext, m: MembershipRow): Promise<AccessSnapshot> => {
  const s = await loadAccessSnapshot(dbOf(ctx), ctx.actor.workspaceId, m.userId, ctx.app.clock.now());
  if (!s) throw notFound('Member');
  return s;
};

/** Effective access of a member (S62 Access tab / S63 "Explain Access"). */
export const memberAccess = async (ctx: QueryContext, membershipId: string) => {
  const m = await loadReadableMember(ctx, membershipId);
  const isSelf = ctx.actor.membershipId === m.id;
  if (!isSelf && !(await canActOnMember(ctx, m.id, 'access.read'))) throw forbidden('You cannot view this member’s access.');
  const db = ctx.app.db;
  const at = ctx.app.clock.now();
  const snapshot = await memberSnapshot(ctx, m);
  const grantRows = await db
    .select({ ra: roleAssignments, role: roles })
    .from(roleAssignments)
    .innerJoin(roles, and(eq(roles.id, roleAssignments.roleId), eq(roles.workspaceId, roleAssignments.workspaceId)))
    .where(and(eq(roleAssignments.workspaceId, ctx.actor.workspaceId), eq(roleAssignments.membershipId, m.id)))
    .orderBy(desc(roleAssignments.validFrom));
  const current = grantRows.filter((r) => !r.ra.revokedAt && (!r.ra.validTo || r.ra.validTo > at));
  const past = grantRows.filter((r) => r.ra.revokedAt || (r.ra.validTo && r.ra.validTo <= at)).slice(0, 50);
  const denyRows = await db
    .select()
    .from(accessDenies)
    .where(and(eq(accessDenies.workspaceId, ctx.actor.workspaceId), eq(accessDenies.membershipId, m.id), isNull(accessDenies.revokedAt)))
    .orderBy(desc(accessDenies.createdAt));
  const grants = await toGrantRows(ctx, current);
  const history = await toGrantRows(ctx, past);
  const label = await scopeLabeler(ctx, current.map((r) => r.ra));
  const activeGrants = current.filter((r) => r.ra.validFrom <= at);
  const [u] = await db.select({ mfaEnabledAt: users.mfaEnabledAt }).from(users).where(eq(users.id, m.userId));
  const groups = Object.entries(PERMISSION_GROUPS).map(([key, perms]) => ({
    key,
    permissions: perms.map((p) => {
      const via = snapshot.isOwner
        ? [{ roleName: 'Owner', scopeLabel: 'Whole workspace' }]
        : activeGrants.filter((g) => g.role.permissions.includes(p) && !g.role.archivedAt).map((g) => ({ roleName: g.role.name, scopeLabel: label(g.ra.scopeType, g.ra.scopeId) }));
      return {
        key: p,
        held: hasAnywhere(snapshot, p),
        denied: snapshot.denies.some((d) => matchesPermission(d.permission, p) && !d.objectId),
        sensitive: isSensitivePermission(p),
        via,
      };
    }),
  }));
  return {
    membershipId: m.id,
    status: m.status,
    isOwner: snapshot.isOwner,
    accessRevision: m.accessRevision,
    mfa: { enabled: !!u?.mfaEnabledAt, required: await userRequiresMfa(db, m.userId, at) },
    grants,
    history,
    denies: await toDenyRows(ctx, denyRows),
    groups,
    canManage: !isSelf && m.status === 'active' && (await canActOnMember(ctx, m.id, 'access.manage')),
  };
};

/** Position of an object in the scope hierarchy, if the viewer may read it (otherwise 404). */
export const resolveObjectScope = async (
  ctx: QueryContext,
  object: { type: string; id: string },
): Promise<{ scope: ObjectScope; label: string }> => {
  const db = dbOf(ctx);
  const ws = ctx.actor.workspaceId;
  if (object.type === 'project') {
    const [p] = await db.select().from(projects).where(and(eq(projects.workspaceId, ws), eq(projects.id, object.id)));
    const scope = p ? { objectType: 'project', objectId: p.id, projectId: p.id, directionId: p.directionId, ownerMembershipId: p.ownerMembershipId } : null;
    if (!p || !scope || !allowed(ctx, 'projects.read', scope)) throw notFound('Object');
    return { scope, label: `Project: ${p.name}` };
  }
  if (object.type === 'account') {
    const [a] = await db.select().from(socialAccounts).where(and(eq(socialAccounts.workspaceId, ws), eq(socialAccounts.id, object.id)));
    const scope = a ? { objectType: 'account', objectId: a.id, accountId: a.id, projectId: a.projectId, ownerMembershipId: a.ownerMembershipId } : null;
    if (!a || !scope || !allowed(ctx, 'accounts.read', scope)) throw notFound('Object');
    return { scope, label: `Account: ${a.displayName ?? (a.handle ? `@${a.handle}` : a.platform)}` };
  }
  if (object.type === 'direction') {
    const [d] = await db.select().from(directions).where(and(eq(directions.workspaceId, ws), eq(directions.id, object.id)));
    if (!d || !allowed(ctx, 'directions.read', { directionId: d.id })) throw notFound('Object');
    return { scope: { objectType: 'direction', objectId: d.id, directionId: d.id }, label: `Direction: ${d.name}` };
  }
  // Other entity types register their scope through the link-access registry (media attachments).
  const r = LINK_ACCESS.get(object.type);
  if (!r) throw new AppError('VALIDATION_FAILED', `Access cannot be evaluated for ${object.type} objects.`);
  const s = await r.scope(ctx, object.id);
  if (!s || !allowed(ctx, r.permission, s)) throw notFound('Object');
  const { label, href, ...scope } = s;
  void href;
  return { scope: { ...scope, objectType: scope.objectType ?? object.type, objectId: scope.objectId ?? object.id }, label: label ?? object.type };
};

export const evaluateAccess = async (ctx: QueryContext, input: { membershipId: string; permissions: string[]; object?: { type: string; id: string } | null }) => {
  requirePermission(ctx, 'access.read');
  const m = await loadReadableMember(ctx, input.membershipId);
  if (ctx.actor.membershipId !== m.id && !(await canActOnMember(ctx, m.id, 'access.read'))) throw forbidden('You cannot view this member’s access.');
  const unknown = input.permissions.filter((p) => !isPermission(p));
  if (unknown.length)
    throw new AppError('VALIDATION_FAILED', `Unknown permissions: ${unknown.join(', ')}.`, { fieldErrors: [{ field: 'permissions', code: 'UNKNOWN', message: 'Choose permissions from the catalog.' }] });
  const snapshot = await memberSnapshot(ctx, m);
  const obj = input.object ? await resolveObjectScope(ctx, input.object) : null;
  const ref = (await loadMemberRefs(ctx.app.db, ctx.actor.workspaceId, [m.id])).get(m.id)!;
  return {
    member: ref,
    object: obj && input.object ? { type: input.object.type, id: input.object.id, label: obj.label } : null,
    results: input.permissions.map((p) => {
      const e = explain(snapshot, p, obj?.scope);
      return { permission: p, allowed: e.allowed, reason: e.reason, viaRole: e.viaRole ?? null, viaScope: e.viaScope ?? null };
    }),
  };
};

const workspaceName = async (ctx: CommandContext) => {
  const [w] = await ctx.tx.select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, ctx.actor.workspaceId));
  return w?.name ?? 'the workspace';
};

const notifyAccessChange = async (ctx: CommandContext, membershipId: string, eventKey: string, excerpt: string) =>
  notify(ctx.tx, {
    workspaceId: ctx.actor.workspaceId,
    recipientMembershipIds: [membershipId],
    eventType: 'member.access_changed',
    eventKey,
    kind: 'security',
    title: `Your access in ${await workspaceName(ctx)} changed`,
    excerpt,
    entityType: 'membership',
    entityId: membershipId,
    actorMembershipId: ctx.actor.membershipId,
    at: ctx.app.clock.now(),
  });

const loadRole = async (ctx: QueryContext | CommandContext, roleId: string) => {
  const [r] = await dbOf(ctx)
    .select()
    .from(roles)
    .where(and(eq(roles.workspaceId, ctx.actor.workspaceId), eq(roles.id, roleId)));
  if (!r || r.archivedAt)
    throw new AppError('VALIDATION_FAILED', 'The selected role does not exist.', { fieldErrors: [{ field: 'roleId', code: 'NOT_FOUND', message: 'The selected role does not exist.' }] });
  return r;
};

export const assertCanGrantRole = (ctx: QueryContext, role: RoleDbRow) => {
  if (role.isProtected || role.key === 'owner') throw new AppError('FORBIDDEN', 'The Owner role can only be passed on through ownership transfer.');
  if (!canManageRole(ctx.actor.access, role))
    throw new AppError(
      'FORBIDDEN',
      roleNeedsOwner(role) ? `Only the workspace Owner can grant the ${role.name} role.` : `You cannot grant permissions you do not hold (${role.name}).`,
    );
};

/** Insert one role grant (shared by grants, restore, lead assignment and ownership transfer). */
export const insertGrant = async (
  ctx: CommandContext,
  input: { membershipId: string; role: RoleDbRow; scopeType: GrantDbRow['scopeType']; scopeId: string | null; validTo?: Date | null; reason?: string | null },
) => {
  const at = ctx.app.clock.now();
  const [dup] = await ctx.tx
    .select({ id: roleAssignments.id })
    .from(roleAssignments)
    .where(
      and(
        eq(roleAssignments.workspaceId, ctx.actor.workspaceId),
        eq(roleAssignments.membershipId, input.membershipId),
        eq(roleAssignments.roleId, input.role.id),
        eq(roleAssignments.scopeType, input.scopeType),
        input.scopeId ? eq(roleAssignments.scopeId, input.scopeId) : isNull(roleAssignments.scopeId),
        isNull(roleAssignments.revokedAt),
        or(isNull(roleAssignments.validTo), gt(roleAssignments.validTo, at)),
      ),
    );
  if (dup) throw new AppError('DUPLICATE', 'The member already holds this role in this scope.');
  const id = newId();
  const [row] = await ctx.tx
    .insert(roleAssignments)
    .values({
      ...stamp(ctx),
      id,
      membershipId: input.membershipId,
      roleId: input.role.id,
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      validFrom: at,
      validTo: input.validTo ?? null,
      reason: input.reason ?? null,
    })
    .returning();
  return row!;
};

export const grantRole = async (
  ctx: CommandContext,
  input: { membershipId: string; roleId: string; scopeType: GrantDbRow['scopeType']; scopeId: string | null; validTo?: string | null; reason?: string },
) => {
  requirePermission(ctx, 'access.manage');
  requireRecentAuth(ctx);
  const m = await loadReadableMember(ctx, input.membershipId, { lock: true });
  await authorizeMemberAction(ctx, m, 'access.manage');
  assertNotSelf(ctx, m.id);
  if (m.status !== 'active') throw new AppError('INVALID_STATE', 'Access can only be granted to active members. Restore the member first.');
  const role = await loadRole(ctx, input.roleId);
  assertCanGrantRole(ctx, role);
  const scopeId = ['direction', 'project', 'account'].includes(input.scopeType) ? input.scopeId : null;
  await assertScopeObject(ctx.tx, ctx.actor.workspaceId, input.scopeType, scopeId);
  await assertGrantScopeWithinManager(ctx, input.scopeType, scopeId);
  const validTo = input.validTo ? new Date(input.validTo) : null;
  if (validTo && validTo <= ctx.app.clock.now())
    throw new AppError('VALIDATION_FAILED', 'The end of the grant must be in the future.', { fieldErrors: [{ field: 'validTo', code: 'MUST_BE_FUTURE', message: 'Choose a future date and time.' }] });
  const row = await insertGrant(ctx, { membershipId: m.id, role, scopeType: input.scopeType, scopeId, validTo, reason: input.reason?.trim() || null });
  await bumpAccessRevision(ctx, [m.id]);
  const label = await scopeLabeler(ctx, [row]);
  await audit(ctx, {
    action: 'member.role_granted',
    entityType: 'membership',
    entityId: m.id,
    reason: input.reason ?? null,
    sensitivity: 'security',
    diff: { roleGrant: { from: null, to: { role: role.key, scopeType: row.scopeType, scopeId: row.scopeId, validTo: row.validTo?.toISOString() ?? null } } },
    metadata: { roleAssignmentId: row.id, roleId: role.id },
  });
  await emit(ctx, { type: 'member.access_changed', entityType: 'membership', entityId: m.id, payload: { change: 'role_granted' } });
  await notifyAccessChange(ctx, m.id, `access.role_granted:${row.id}`, `${role.name} granted (${label(row.scopeType, row.scopeId)}).`);
  return (await toGrantRows(ctx, [{ ra: row, role }]))[0]!;
};

const loadGrantForChange = async (ctx: CommandContext, assignmentId: string) => {
  const ra = await lockById(ctx, roleAssignments, assignmentId, 'Grant');
  const m = await loadReadableMember(ctx, ra.membershipId, { lock: true });
  await authorizeMemberAction(ctx, m, 'access.manage');
  const [role] = await ctx.tx.select().from(roles).where(eq(roles.id, ra.roleId));
  if (!role) throw notFound('Grant');
  return { ra, m, role };
};

export const revokeRole = async (ctx: CommandContext, assignmentId: string, reason: string) => {
  requirePermission(ctx, 'access.manage');
  requireRecentAuth(ctx);
  const { ra, m, role } = await loadGrantForChange(ctx, assignmentId);
  assertNotSelf(ctx, m.id);
  assertVersion(ctx, ra);
  if (role.key === 'owner') throw new AppError('INVALID_STATE', 'The Owner role changes only through Transfer Ownership.');
  assertCanGrantRole(ctx, role);
  if (ra.revokedAt) throw new AppError('INVALID_STATE', 'This grant was already revoked.');
  const at = ctx.app.clock.now();
  const [row] = await ctx.tx
    .update(roleAssignments)
    .set({ revokedAt: at, revokedBy: ctx.actor.userId, ...touch(ctx, roleAssignments) })
    .where(eq(roleAssignments.id, ra.id))
    .returning();
  await bumpAccessRevision(ctx, [m.id]);
  const label = await scopeLabeler(ctx, [ra]);
  await audit(ctx, {
    action: 'member.role_revoked',
    entityType: 'membership',
    entityId: m.id,
    reason,
    sensitivity: 'security',
    diff: { roleGrant: { from: { role: role.key, scopeType: ra.scopeType, scopeId: ra.scopeId }, to: null } },
    metadata: { roleAssignmentId: ra.id, roleId: role.id },
  });
  await emit(ctx, { type: 'member.access_changed', entityType: 'membership', entityId: m.id, payload: { change: 'role_revoked' } });
  await notifyAccessChange(ctx, m.id, `access.role_revoked:${ra.id}`, `${role.name} removed (${label(ra.scopeType, ra.scopeId)}).`);
  return (await toGrantRows(ctx, [{ ra: row!, role }]))[0]!;
};

export const updateRoleAssignment = async (ctx: CommandContext, assignmentId: string, input: { validTo: string | null; reason?: string }) => {
  requirePermission(ctx, 'access.manage');
  requireRecentAuth(ctx);
  const { ra, m, role } = await loadGrantForChange(ctx, assignmentId);
  assertNotSelf(ctx, m.id);
  assertVersion(ctx, ra);
  if (role.key === 'owner') throw new AppError('INVALID_STATE', 'The Owner role changes only through Transfer Ownership.');
  assertCanGrantRole(ctx, role);
  if (ra.revokedAt) throw new AppError('INVALID_STATE', 'This grant was revoked.');
  const at = ctx.app.clock.now();
  const validTo = input.validTo ? new Date(input.validTo) : null;
  if (validTo && validTo <= at)
    throw new AppError('VALIDATION_FAILED', 'Choose a future date and time, or revoke the grant.', { fieldErrors: [{ field: 'validTo', code: 'MUST_BE_FUTURE', message: 'Choose a future date and time.' }] });
  const [row] = await ctx.tx.update(roleAssignments).set({ validTo, ...touch(ctx, roleAssignments) }).where(eq(roleAssignments.id, ra.id)).returning();
  await bumpAccessRevision(ctx, [m.id]);
  await audit(ctx, {
    action: 'member.role_interval_changed',
    entityType: 'membership',
    entityId: m.id,
    reason: input.reason ?? null,
    sensitivity: 'security',
    diff: { validTo: { from: ra.validTo?.toISOString() ?? null, to: validTo?.toISOString() ?? null } },
    metadata: { roleAssignmentId: ra.id, roleId: role.id },
  });
  await emit(ctx, { type: 'member.access_changed', entityType: 'membership', entityId: m.id });
  return (await toGrantRows(ctx, [{ ra: row!, role }]))[0]!;
};

export const listRoleAssignments = async (ctx: QueryContext, input: { membershipId?: string; roleId?: string; includeRevoked?: boolean }) => {
  requirePermission(ctx, 'access.read');
  const at = ctx.app.clock.now();
  const rows = await ctx.app.db
    .select({ ra: roleAssignments, role: roles })
    .from(roleAssignments)
    .innerJoin(roles, and(eq(roles.id, roleAssignments.roleId), eq(roles.workspaceId, roleAssignments.workspaceId)))
    .innerJoin(memberships, eq(memberships.id, roleAssignments.membershipId))
    .where(
      and(
        eq(roleAssignments.workspaceId, ctx.actor.workspaceId),
        memberVisibilitySql(memberVisibility(ctx.actor.access, 'access.read', { includeSelf: true })),
        input.membershipId ? eq(roleAssignments.membershipId, input.membershipId) : undefined,
        input.roleId ? eq(roleAssignments.roleId, input.roleId) : undefined,
        input.includeRevoked ? undefined : and(isNull(roleAssignments.revokedAt), or(isNull(roleAssignments.validTo), gt(roleAssignments.validTo, at))),
      ),
    )
    .orderBy(desc(roleAssignments.validFrom))
    .limit(1000);
  const grants = await toGrantRows(ctx, rows);
  const refs = await loadMemberRefs(ctx.app.db, ctx.actor.workspaceId, rows.map((r) => r.ra.membershipId));
  return grants.map((g, i) => ({ ...g, member: refs.get(rows[i]!.ra.membershipId)! }));
};

// ——— Explicit denies ———

export const addDeny = async (
  ctx: CommandContext,
  input: { membershipId: string; permission: string; objectType: 'project' | 'account' | 'direction' | null; objectId: string | null; reason: string },
) => {
  requirePermission(ctx, 'access.manage');
  requireRecentAuth(ctx);
  const m = await loadReadableMember(ctx, input.membershipId, { lock: true });
  await authorizeMemberAction(ctx, m, 'access.manage');
  assertNotSelf(ctx, m.id);
  if (m.status !== 'active') throw new AppError('INVALID_STATE', 'Denies apply to active members only.');
  if (await isWorkspaceOwner(ctx, m.id)) throw new AppError('FORBIDDEN', 'The workspace Owner cannot be restricted with a deny entry.');
  if (expandPermissionPattern(input.permission).length === 0)
    throw new AppError('VALIDATION_FAILED', 'Choose a permission from the catalog.', { fieldErrors: [{ field: 'permission', code: 'UNKNOWN', message: 'Choose a permission from the catalog.' }] });
  if (!canManagePattern(ctx.actor.access, input.permission)) throw new AppError('FORBIDDEN', 'You cannot manage this permission.');
  if (!!input.objectType !== !!input.objectId)
    throw new AppError('VALIDATION_FAILED', 'Choose the object for this deny, or none.', { fieldErrors: [{ field: 'objectId', code: 'INCOMPLETE', message: 'Choose the object.' }] });
  if (input.objectType) await assertScopeObject(ctx.tx, ctx.actor.workspaceId, input.objectType, input.objectId, 'objectId');
  const [dup] = await ctx.tx
    .select({ id: accessDenies.id })
    .from(accessDenies)
    .where(
      and(
        eq(accessDenies.membershipId, m.id),
        eq(accessDenies.permission, input.permission),
        input.objectId ? eq(accessDenies.objectId, input.objectId) : isNull(accessDenies.objectId),
        isNull(accessDenies.revokedAt),
      ),
    );
  if (dup) throw new AppError('DUPLICATE', 'This deny already exists.');
  const id = newId();
  const [row] = await ctx.tx
    .insert(accessDenies)
    .values({ ...stamp(ctx), id, membershipId: m.id, permission: input.permission, objectType: input.objectType, objectId: input.objectId, reason: input.reason.trim() })
    .returning();
  await bumpAccessRevision(ctx, [m.id]);
  await audit(ctx, {
    action: 'member.deny_added',
    entityType: 'membership',
    entityId: m.id,
    reason: input.reason,
    sensitivity: 'security',
    diff: { deny: { from: null, to: { permission: input.permission, objectType: input.objectType, objectId: input.objectId } } },
    metadata: { denyId: id },
  });
  await emit(ctx, { type: 'member.access_changed', entityType: 'membership', entityId: m.id, payload: { change: 'deny_added' } });
  await notifyAccessChange(ctx, m.id, `access.deny_added:${id}`, 'An access restriction was added.');
  return (await toDenyRows(ctx, [row!]))[0]!;
};

export const revokeDeny = async (ctx: CommandContext, denyId: string, reason?: string) => {
  requirePermission(ctx, 'access.manage');
  requireRecentAuth(ctx);
  const d = await lockById(ctx, accessDenies, denyId, 'Deny');
  const m = await loadReadableMember(ctx, d.membershipId, { lock: true });
  await authorizeMemberAction(ctx, m, 'access.manage');
  assertNotSelf(ctx, m.id);
  assertVersion(ctx, d);
  if (d.revokedAt) throw new AppError('INVALID_STATE', 'This deny was already removed.');
  if (!canManagePattern(ctx.actor.access, d.permission)) throw new AppError('FORBIDDEN', 'You cannot manage this permission.');
  await ctx.tx.update(accessDenies).set({ revokedAt: ctx.app.clock.now(), ...touch(ctx, accessDenies) }).where(eq(accessDenies.id, d.id));
  await bumpAccessRevision(ctx, [m.id]);
  await audit(ctx, {
    action: 'member.deny_removed',
    entityType: 'membership',
    entityId: m.id,
    reason: reason ?? null,
    sensitivity: 'security',
    diff: { deny: { from: { permission: d.permission, objectType: d.objectType, objectId: d.objectId }, to: null } },
    metadata: { denyId: d.id },
  });
  await emit(ctx, { type: 'member.access_changed', entityType: 'membership', entityId: m.id, payload: { change: 'deny_removed' } });
  await notifyAccessChange(ctx, m.id, `access.deny_removed:${d.id}`, 'An access restriction was removed.');
  return { ok: true as const };
};

