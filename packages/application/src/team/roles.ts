import { and, asc, count, eq, gt, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { ROLE_PRESETS, hasAnywhere, isPermission, isSensitivePermission } from '@castlane/authorization';
import { memberships, roleAssignments, roles } from '@castlane/database';
import { AppError, newId, normalizeKey, notFound } from '@castlane/domain';
import { requireAnyPermission, requirePermission, requireRecentAuth } from '../core/access';
import { audit } from '../core/audit';
import { dbOf, type CommandContext, type QueryContext } from '../core/context';
import { emit } from '../core/events';
import { loadMemberRefs } from '../core/members';
import { assertVersion, lockById, stamp, touch } from '../core/rows';
import { canEditRole, canManageRole, diffPermissions, isProtectedRole, isSensitiveRole, normalizePermissions } from './grant-rules';
import { bumpAccessRevision, memberVisibility, memberVisibilitySql, scopeLabeler } from './scope';

type RoleDb = typeof roles.$inferSelect;
type ScopeTypeValue = RoleDb['defaultScopeType'];

const assertKnownPermissions = (list: string[]) => {
  const unknown = list.filter((p) => !isPermission(p));
  if (unknown.length)
    throw new AppError('VALIDATION_FAILED', `Unknown permissions: ${unknown.slice(0, 5).join(', ')}.`, {
      fieldErrors: [{ field: 'permissions', code: 'UNKNOWN', message: 'Choose permissions from the catalog.' }],
    });
};

const activeGrantWhere = (at: Date) => and(isNull(roleAssignments.revokedAt), or(isNull(roleAssignments.validTo), gt(roleAssignments.validTo, at)));

const toRoleRow = (ctx: QueryContext, r: RoleDb, activeAssignments: number) => {
  const manager = hasAnywhere(ctx.actor.access, 'access.manage');
  return {
    id: r.id,
    key: r.key,
    name: r.name,
    description: r.description,
    isPreset: r.isPreset,
    isProtected: r.isProtected,
    basedOnKey: r.basedOnKey,
    defaultScopeType: r.defaultScopeType,
    permissions: r.permissions,
    sensitivePermissions: r.permissions.filter(isSensitivePermission),
    activeAssignments,
    archivedAt: r.archivedAt?.toISOString() ?? null,
    updatedAt: r.updatedAt.toISOString(),
    rowVersion: r.rowVersion,
    canEdit: manager && !r.archivedAt && canEditRole(ctx.actor.access, r, r.permissions).ok,
    canGrant: manager && !r.archivedAt && canManageRole(ctx.actor.access, r),
  };
};

const assignmentCounts = async (ctx: QueryContext | CommandContext, roleIds: string[]) => {
  if (roleIds.length === 0) return new Map<string, number>();
  const rows = await dbOf(ctx)
    .select({ roleId: roleAssignments.roleId, n: sql<number>`count(DISTINCT ${roleAssignments.membershipId})` })
    .from(roleAssignments)
    .innerJoin(memberships, eq(memberships.id, roleAssignments.membershipId))
    .where(and(eq(roleAssignments.workspaceId, ctx.actor.workspaceId), inArray(roleAssignments.roleId, roleIds), activeGrantWhere(ctx.app.clock.now()), eq(memberships.status, 'active')))
    .groupBy(roleAssignments.roleId);
  return new Map(rows.map((r) => [r.roleId, Number(r.n)]));
};

export const listRoles = async (ctx: QueryContext, input: { includeArchived?: boolean }) => {
  requirePermission(ctx, 'access.read');
  const rows = await ctx.app.db
    .select()
    .from(roles)
    .where(and(eq(roles.workspaceId, ctx.actor.workspaceId), input.includeArchived ? undefined : isNull(roles.archivedAt)))
    .orderBy(sql`${roles.isProtected} DESC`, sql`${roles.isPreset} DESC`, asc(roles.createdAt), asc(roles.name));
  const counts = await assignmentCounts(ctx, rows.map((r) => r.id));
  return rows.map((r) => toRoleRow(ctx, r, counts.get(r.id) ?? 0));
};

/** Roles the viewer may grant (invite drawer, grant dialog, restore). */
export const grantableRoles = async (ctx: QueryContext) => {
  requireAnyPermission(ctx, ['members.invite', 'access.manage', 'members.suspend']);
  const rows = await ctx.app.db
    .select()
    .from(roles)
    .where(and(eq(roles.workspaceId, ctx.actor.workspaceId), isNull(roles.archivedAt)))
    .orderBy(sql`${roles.isPreset} DESC`, asc(roles.createdAt));
  return rows
    .filter((r) => !isProtectedRole(r) && canManageRole(ctx.actor.access, r))
    .map((r) => ({ id: r.id, key: r.key, name: r.name, description: r.description, defaultScopeType: r.defaultScopeType, permissions: r.permissions, sensitive: isSensitiveRole(r) }));
};

export const getRole = async (ctx: QueryContext | CommandContext, roleId: string) => {
  requirePermission(ctx, 'access.read');
  const db = dbOf(ctx);
  const [r] = await db.select().from(roles).where(and(eq(roles.workspaceId, ctx.actor.workspaceId), eq(roles.id, roleId)));
  if (!r) throw notFound('Role');
  const at = ctx.app.clock.now();
  const grants = await db
    .select({ ra: roleAssignments })
    .from(roleAssignments)
    .innerJoin(memberships, eq(memberships.id, roleAssignments.membershipId))
    .where(
      and(
        eq(roleAssignments.workspaceId, ctx.actor.workspaceId),
        eq(roleAssignments.roleId, r.id),
        activeGrantWhere(at),
        eq(memberships.status, 'active'),
        memberVisibilitySql(memberVisibility(ctx.actor.access, 'access.read', { includeSelf: true })),
      ),
    )
    .orderBy(asc(roleAssignments.validFrom))
    .limit(500);
  const refs = await loadMemberRefs(db, ctx.actor.workspaceId, grants.map((g) => g.ra.membershipId));
  const label = await scopeLabeler(ctx, grants.map((g) => g.ra));
  const counts = await assignmentCounts(ctx, [r.id]);
  const preset = r.isPreset ? ROLE_PRESETS.find((p) => p.key === r.key) : undefined;
  const d = preset ? diffPermissions(preset.permissions, r.permissions) : null;
  return {
    ...toRoleRow(ctx, r, counts.get(r.id) ?? 0),
    assignments: grants.map((g) => ({
      id: g.ra.id,
      member: refs.get(g.ra.membershipId)!,
      scopeType: g.ra.scopeType,
      scopeLabel: label(g.ra.scopeType, g.ra.scopeId),
      validFrom: g.ra.validFrom.toISOString(),
      validTo: g.ra.validTo?.toISOString() ?? null,
    })),
    presetDiff: d ? { added: d.added, removed: d.removed } : null,
  };
};

const assertUniqueName = async (ctx: CommandContext, name: string, exceptId?: string) => {
  const [dup] = await ctx.tx
    .select({ id: roles.id })
    .from(roles)
    .where(and(eq(roles.workspaceId, ctx.actor.workspaceId), sql`lower(${roles.name}) = ${name.trim().toLowerCase()}`, isNull(roles.archivedAt), exceptId ? ne(roles.id, exceptId) : undefined));
  if (dup) throw new AppError('DUPLICATE', 'A role with this name already exists.', { fieldErrors: [{ field: 'name', code: 'DUPLICATE', message: 'A role with this name already exists.' }] });
};

const roleKeyFor = (name: string) =>
  `custom_${
    normalizeKey(name)
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40) || 'role'
  }_${newId().slice(0, 6)}`;

/** Members currently holding a role (their access changes when the role changes). */
const holdersOf = async (ctx: CommandContext, roleId: string) => {
  const rows = await ctx.tx
    .select({ membershipId: roleAssignments.membershipId })
    .from(roleAssignments)
    .where(and(eq(roleAssignments.workspaceId, ctx.actor.workspaceId), eq(roleAssignments.roleId, roleId), activeGrantWhere(ctx.app.clock.now())));
  return [...new Set(rows.map((r) => r.membershipId))];
};

export const createRole = async (
  ctx: CommandContext,
  input: { name: string; description?: string | null; permissions: string[]; defaultScopeType: ScopeTypeValue; cloneFromRoleId?: string },
) => {
  requirePermission(ctx, 'access.manage');
  requireRecentAuth(ctx);
  let basedOnKey: string | null = null;
  if (input.cloneFromRoleId) {
    const [src] = await ctx.tx.select().from(roles).where(and(eq(roles.workspaceId, ctx.actor.workspaceId), eq(roles.id, input.cloneFromRoleId)));
    if (!src) throw notFound('Role');
    basedOnKey = src.key;
  }
  assertKnownPermissions(input.permissions);
  const permissions = normalizePermissions(input.permissions);
  const check = canEditRole(ctx.actor.access, { key: 'custom', permissions: [] }, permissions);
  if (!check.ok) throw new AppError('FORBIDDEN', check.reason);
  if (permissions.length === 0)
    throw new AppError('VALIDATION_FAILED', 'Choose at least one permission.', { fieldErrors: [{ field: 'permissions', code: 'REQUIRED', message: 'Choose at least one permission.' }] });
  await assertUniqueName(ctx, input.name);
  const id = newId();
  await ctx.tx.insert(roles).values({
    ...stamp(ctx),
    id,
    key: roleKeyFor(input.name),
    name: input.name.trim(),
    description: input.description?.trim() || null,
    permissions,
    defaultScopeType: input.defaultScopeType,
    isPreset: false,
    isProtected: false,
    basedOnKey,
  });
  await audit(ctx, {
    action: 'role.created',
    entityType: 'role',
    entityId: id,
    sensitivity: 'security',
    diff: { permissions: { from: null, to: permissions }, name: { from: null, to: input.name.trim() } },
    metadata: { clonedFrom: basedOnKey },
  });
  await emit(ctx, { type: 'role.created', entityType: 'role', entityId: id, revision: 1 });
  return id;
};

const applyPermissionChange = async (ctx: CommandContext, r: RoleDb, patch: Partial<RoleDb>, action: string) => {
  const before = r.permissions;
  const after = patch.permissions ?? before;
  const [row] = await ctx.tx.update(roles).set({ ...patch, ...touch(ctx, roles) }).where(eq(roles.id, r.id)).returning();
  const d = diffPermissions(before, after);
  if (d.added.length || d.removed.length) await bumpAccessRevision(ctx, await holdersOf(ctx, r.id));
  const diff: Record<string, { from?: unknown; to?: unknown }> = {};
  if (d.added.length || d.removed.length) diff.permissions = { from: d.removed, to: d.added };
  if (patch.name !== undefined && patch.name !== r.name) diff.name = { from: r.name, to: patch.name };
  if (patch.description !== undefined && patch.description !== r.description) diff.description = { from: r.description, to: patch.description };
  if (patch.defaultScopeType !== undefined && patch.defaultScopeType !== r.defaultScopeType) diff.defaultScopeType = { from: r.defaultScopeType, to: patch.defaultScopeType };
  await audit(ctx, {
    action,
    entityType: 'role',
    entityId: r.id,
    sensitivity: 'security',
    diff,
    metadata: { added: d.added, removed: d.removed, sensitiveAdded: d.sensitiveAdded, sensitiveRemoved: d.sensitiveRemoved },
  });
  await emit(ctx, { type: 'role.updated', entityType: 'role', entityId: r.id, revision: row!.rowVersion });
  return row!;
};

export const updateRole = async (
  ctx: CommandContext,
  roleId: string,
  input: { name?: string; description?: string | null; permissions?: string[]; defaultScopeType?: ScopeTypeValue },
) => {
  requirePermission(ctx, 'access.manage');
  requireRecentAuth(ctx);
  const r = await lockById(ctx, roles, roleId, 'Role');
  assertVersion(ctx, r);
  if (r.archivedAt) throw new AppError('INVALID_STATE', 'Archived roles cannot be changed.');
  if (input.permissions) assertKnownPermissions(input.permissions);
  const permissions = input.permissions ? normalizePermissions(input.permissions) : r.permissions;
  const check = canEditRole(ctx.actor.access, r, permissions);
  if (!check.ok) throw new AppError('FORBIDDEN', check.reason);
  if (input.permissions && permissions.length === 0)
    throw new AppError('VALIDATION_FAILED', 'Choose at least one permission.', { fieldErrors: [{ field: 'permissions', code: 'REQUIRED', message: 'Choose at least one permission.' }] });
  if (input.name && input.name.trim().toLowerCase() !== r.name.toLowerCase()) await assertUniqueName(ctx, input.name, r.id);
  const patch: Partial<RoleDb> = {};
  if (input.name !== undefined) patch.name = input.name.trim();
  if (input.description !== undefined) patch.description = input.description?.trim() || null;
  if (input.permissions !== undefined) patch.permissions = permissions;
  if (input.defaultScopeType !== undefined) patch.defaultScopeType = input.defaultScopeType;
  await applyPermissionChange(ctx, r, patch, 'role.updated');
  return r.id;
};

export const previewRoleImpact = async (ctx: QueryContext, roleId: string, input: { permissions: string[] }) => {
  requirePermission(ctx, 'access.read');
  const [r] = await ctx.app.db.select().from(roles).where(and(eq(roles.workspaceId, ctx.actor.workspaceId), eq(roles.id, roleId)));
  if (!r) throw notFound('Role');
  const after = normalizePermissions(input.permissions);
  const d = diffPermissions(r.permissions, after);
  const at = ctx.app.clock.now();
  const holders = await ctx.app.db
    .select({ membershipId: roleAssignments.membershipId })
    .from(roleAssignments)
    .innerJoin(memberships, eq(memberships.id, roleAssignments.membershipId))
    .where(and(eq(roleAssignments.workspaceId, ctx.actor.workspaceId), eq(roleAssignments.roleId, r.id), activeGrantWhere(at), eq(memberships.status, 'active')));
  const ids = [...new Set(holders.map((h) => h.membershipId))];
  const refs = await loadMemberRefs(ctx.app.db, ctx.actor.workspaceId, ids.slice(0, 10));
  const check = hasAnywhere(ctx.actor.access, 'access.manage') ? canEditRole(ctx.actor.access, r, after) : ({ ok: false, reason: 'You can view roles but not change them.' } as const);
  return {
    ...d,
    affectedMembers: { count: ids.length, sample: ids.slice(0, 10).map((id) => refs.get(id)!).filter(Boolean) },
    blocked: check.ok ? (after.length === 0 ? 'Choose at least one permission.' : null) : check.reason,
  };
};

export const resetRole = async (ctx: CommandContext, roleId: string) => {
  requirePermission(ctx, 'access.manage');
  requireRecentAuth(ctx);
  const r = await lockById(ctx, roles, roleId, 'Role');
  assertVersion(ctx, r);
  const preset = r.isPreset ? ROLE_PRESETS.find((p) => p.key === r.key) : undefined;
  if (!preset) throw new AppError('INVALID_STATE', 'Only preset roles can be reset to the catalog.');
  const permissions = normalizePermissions(preset.permissions);
  const check = canEditRole(ctx.actor.access, r, permissions);
  if (!check.ok) throw new AppError('FORBIDDEN', check.reason);
  await applyPermissionChange(ctx, r, { permissions, description: preset.description, defaultScopeType: preset.defaultScopeType }, 'role.reset_to_preset');
  return r.id;
};

export const archiveRole = async (ctx: CommandContext, roleId: string, reason?: string) => {
  requirePermission(ctx, 'access.manage');
  requireRecentAuth(ctx);
  const r = await lockById(ctx, roles, roleId, 'Role');
  assertVersion(ctx, r);
  if (r.isPreset || r.isProtected) throw new AppError('INVALID_STATE', 'Preset roles cannot be archived; edit or reset them instead.');
  if (r.archivedAt) throw new AppError('INVALID_STATE', 'This role is already archived.');
  const check = canEditRole(ctx.actor.access, r, r.permissions);
  if (!check.ok) throw new AppError('FORBIDDEN', check.reason);
  const [held] = await ctx.tx
    .select({ n: count() })
    .from(roleAssignments)
    .where(and(eq(roleAssignments.roleId, r.id), activeGrantWhere(ctx.app.clock.now())));
  if (Number(held?.n ?? 0) > 0)
    throw new AppError('INVALID_STATE', 'Revoke this role from every member before archiving it.', { details: { activeAssignments: Number(held!.n) } });
  const at = ctx.app.clock.now();
  await ctx.tx.update(roles).set({ archivedAt: at, ...touch(ctx, roles) }).where(eq(roles.id, r.id));
  await audit(ctx, { action: 'role.archived', entityType: 'role', entityId: r.id, reason: reason ?? null, sensitivity: 'security' });
  await emit(ctx, { type: 'role.archived', entityType: 'role', entityId: r.id });
  return r.id;
};
