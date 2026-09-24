import {
  ALL_PERMISSIONS,
  OWNER_ONLY_GRANTABLE,
  hasAnywhere,
  isFinancePermission,
  isPermission,
  isSensitivePermission,
  type AccessSnapshot,
} from '@castlane/authorization';

/**
 * Pure rules for managing access (section 7.1). They never look at role names except the protected
 * Owner and the Admin preset whose assignment is Owner-only by specification.
 */

export interface RoleLike {
  key: string;
  permissions: readonly string[];
  isProtected?: boolean;
}

/** Owner-only: the Admin preset and every role containing finance or owner-only permissions. */
export const roleNeedsOwner = (role: RoleLike): boolean =>
  role.key === 'admin' || role.permissions.some((p) => isFinancePermission(p) || OWNER_ONLY_GRANTABLE.includes(p));

export const isProtectedRole = (role: RoleLike): boolean => !!role.isProtected || role.key === 'owner';

/** A role is "sensitive" when it carries finance, OFM contact, restricted media or export permissions. */
export const isSensitiveRole = (role: RoleLike): boolean => role.key === 'admin' || role.permissions.some(isSensitivePermission);

/** May the actor manage (grant, revoke, edit) a single permission? */
export const canManagePermission = (access: AccessSnapshot, permission: string): boolean => {
  if (access.isOwner) return true;
  if (isFinancePermission(permission) || OWNER_ONLY_GRANTABLE.includes(permission)) return false;
  return hasAnywhere(access, permission);
};

/** Catalog permissions matched by a deny pattern (exact key or `prefix.*`). */
export const expandPermissionPattern = (pattern: string): string[] => {
  if (pattern.endsWith('.*')) {
    const prefix = pattern.slice(0, -1);
    return ALL_PERMISSIONS.filter((p) => p.startsWith(prefix));
  }
  return isPermission(pattern) ? [pattern] : [];
};

export const canManagePattern = (access: AccessSnapshot, pattern: string): boolean => {
  const expanded = expandPermissionPattern(pattern);
  return expanded.length > 0 && expanded.every((p) => canManagePermission(access, p));
};

/** May the actor grant or revoke this role (no escalation; Owner-only roles; Owner is never granted directly)? */
export const canManageRole = (access: AccessSnapshot, role: RoleLike): boolean => {
  if (isProtectedRole(role)) return false;
  if (access.isOwner) return true;
  if (roleNeedsOwner(role)) return false;
  return role.permissions.every((p) => hasAnywhere(access, p));
};

/**
 * May the actor change a role's permission set from `before` to `after`? Both the current and the
 * resulting role must be manageable, so nobody can edit themselves into rights they cannot manage.
 */
export const canEditRole = (access: AccessSnapshot, role: RoleLike, after: readonly string[]): { ok: true } | { ok: false; reason: string } => {
  if (isProtectedRole(role)) return { ok: false, reason: 'The Owner role is protected and cannot be edited.' };
  const unknown = after.filter((p) => !isPermission(p));
  if (unknown.length) return { ok: false, reason: `Unknown permissions: ${unknown.join(', ')}.` };
  if (access.isOwner) return { ok: true };
  if (roleNeedsOwner(role)) return { ok: false, reason: `Only the workspace Owner can change the ${role.key === 'admin' ? 'Admin role' : 'roles that contain finance or owner-only permissions'}.` };
  const blocked = after.filter((p) => !canManagePermission(access, p));
  if (blocked.length) return { ok: false, reason: `You cannot grant permissions you do not manage: ${blocked.slice(0, 5).join(', ')}${blocked.length > 5 ? '…' : ''}.` };
  return { ok: true };
};

export const diffPermissions = (before: readonly string[], after: readonly string[]) => {
  const b = new Set(before);
  const a = new Set(after);
  const added = [...a].filter((p) => !b.has(p)).sort();
  const removed = [...b].filter((p) => !a.has(p)).sort();
  return {
    added,
    removed,
    sensitiveAdded: added.filter(isSensitivePermission),
    sensitiveRemoved: removed.filter(isSensitivePermission),
  };
};

/** Canonical, de-duplicated permission list in catalog order. */
export const normalizePermissions = (list: readonly string[]): string[] => {
  const set = new Set(list);
  return ALL_PERMISSIONS.filter((p) => set.has(p));
};

/**
 * Manager hierarchy must stay acyclic: setting `managerId` as the manager of `memberId` is invalid
 * when `memberId` already appears in the manager chain above `managerId`.
 */
export const createsManagerCycle = (managerOf: ReadonlyMap<string, string | null>, memberId: string, managerId: string | null): boolean => {
  if (!managerId) return false;
  if (managerId === memberId) return true;
  const seen = new Set<string>();
  let cur: string | null | undefined = managerId;
  while (cur) {
    if (cur === memberId) return true;
    if (seen.has(cur)) return false; // pre-existing cycle elsewhere; not introduced by this change
    seen.add(cur);
    cur = managerOf.get(cur) ?? null;
  }
  return false;
};
