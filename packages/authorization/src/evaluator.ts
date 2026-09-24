import type { ScopeType } from '@castlane/domain';

export interface AccessGrant {
  roleId: string;
  roleKey: string;
  permissions: ReadonlySet<string>;
  scopeType: ScopeType;
  scopeId: string | null;
}

export interface AccessDeny {
  permission: string;
  objectType: string | null;
  objectId: string | null;
}

/**
 * Everything needed to evaluate access for one member in one workspace. Loaded once per
 * request (fresh membership row + access revision), so revoked grants apply immediately.
 */
export interface AccessSnapshot {
  workspaceId: string;
  userId: string;
  membershipId: string;
  membershipStatus: 'active' | 'suspended' | 'deactivated';
  accessRevision: number;
  isOwner: boolean;
  grants: AccessGrant[];
  denies: AccessDeny[];
  /** Active project memberships (for assigned_projects scopes). */
  assignedProjectIds: ReadonlySet<string>;
  /** Active account assignments incl. OFM assignments (for assigned_accounts scopes). */
  assignedAccountIds: ReadonlySet<string>;
  /** project → direction and account → project maps for hierarchical scope resolution. */
  projectDirection: ReadonlyMap<string, string>;
  accountProject: ReadonlyMap<string, string>;
}

/** The object being accessed, described by its position in the scope hierarchy. */
export interface ObjectScope {
  objectType?: string;
  objectId?: string | null;
  projectId?: string | null;
  accountId?: string | null;
  directionId?: string | null;
  /** Members directly assigned to the object (assignee, reviewer, owner…) — assigned_object scope. */
  assignedMembershipIds?: (string | null | undefined)[];
  /** Author / owner for own_records scope. */
  ownerMembershipId?: string | null;
  createdByUserId?: string | null;
}

const matchesPermission = (pattern: string, permission: string): boolean =>
  pattern === '*' || pattern === permission || (pattern.endsWith('.*') && permission.startsWith(pattern.slice(0, -1)));

const resolveHierarchy = (s: AccessSnapshot, scope: ObjectScope) => {
  const projectId = scope.projectId ?? (scope.accountId ? s.accountProject.get(scope.accountId) : undefined) ?? null;
  const directionId = scope.directionId ?? (projectId ? s.projectDirection.get(projectId) : undefined) ?? null;
  return { projectId, directionId, accountId: scope.accountId ?? null };
};

const isDenied = (s: AccessSnapshot, permission: string, scope?: ObjectScope): boolean =>
  s.denies.some((d) => {
    if (!matchesPermission(d.permission, permission)) return false;
    if (!d.objectType || !d.objectId) return true;
    if (!scope) return false;
    const h = resolveHierarchy(s, scope);
    return (
      (d.objectType === scope.objectType && d.objectId === scope.objectId) ||
      (d.objectType === 'project' && d.objectId === h.projectId) ||
      (d.objectType === 'account' && d.objectId === h.accountId) ||
      (d.objectType === 'direction' && d.objectId === h.directionId)
    );
  });

const grantCovers = (s: AccessSnapshot, g: AccessGrant, scope: ObjectScope): boolean => {
  const h = resolveHierarchy(s, scope);
  switch (g.scopeType) {
    case 'workspace':
      return true;
    case 'direction':
      return !!h.directionId && h.directionId === g.scopeId;
    case 'project':
      return !!h.projectId && h.projectId === g.scopeId;
    case 'account':
      return !!h.accountId && h.accountId === g.scopeId;
    case 'assigned_projects':
      return !!h.projectId && s.assignedProjectIds.has(h.projectId);
    case 'assigned_accounts':
      return !!h.accountId && s.assignedAccountIds.has(h.accountId);
    case 'assigned_object':
      return (
        (scope.assignedMembershipIds ?? []).includes(s.membershipId) || scope.ownerMembershipId === s.membershipId
      );
    case 'own_records':
      return scope.ownerMembershipId === s.membershipId || (!!scope.createdByUserId && scope.createdByUserId === s.userId);
    default:
      return false;
  }
};

/** Object-level decision. Deny entries win; Owner holds every permission. */
export const can = (s: AccessSnapshot, permission: string, scope?: ObjectScope): boolean => {
  if (s.membershipStatus !== 'active') return false;
  if (isDenied(s, permission, scope)) return false;
  if (s.isOwner) return true;
  for (const g of s.grants) {
    if (!g.permissions.has(permission)) continue;
    if (!scope) {
      if (g.scopeType === 'workspace') return true;
      continue;
    }
    if (grantCovers(s, g, scope)) return true;
  }
  return false;
};

/** Does the member hold this permission in at least one scope? Distinguishes 403 (module) from 404 (object). */
export const hasAnywhere = (s: AccessSnapshot, permission: string): boolean => {
  if (s.membershipStatus !== 'active') return false;
  if (s.isOwner) return !s.denies.some((d) => matchesPermission(d.permission, permission) && !d.objectId);
  if (s.denies.some((d) => matchesPermission(d.permission, permission) && !d.objectId)) return false;
  return s.grants.some((g) => g.permissions.has(permission));
};

/**
 * Set-based filter for list queries. Applied in SQL before pagination and aggregation, so
 * counts and snippets never include records outside the member's scope.
 */
export type AccessFilter =
  | { kind: 'all' }
  | { kind: 'none' }
  | {
      kind: 'scoped';
      projectIds: string[];
      accountIds: string[];
      /** Records where the member is directly assigned (assignee/reviewer/owner). */
      assignedToMembershipId: string | null;
      /** Records owned/created by the member. */
      ownRecordsMembershipId: string | null;
      ownRecordsUserId: string | null;
    };

export const listFilter = (s: AccessSnapshot, permission: string): AccessFilter => {
  if (s.membershipStatus !== 'active') return { kind: 'none' };
  if (s.denies.some((d) => matchesPermission(d.permission, permission) && !d.objectId)) return { kind: 'none' };
  if (s.isOwner) return { kind: 'all' };
  const relevant = s.grants.filter((g) => g.permissions.has(permission));
  if (relevant.length === 0) return { kind: 'none' };
  if (relevant.some((g) => g.scopeType === 'workspace')) return { kind: 'all' };
  const projectIds = new Set<string>();
  const accountIds = new Set<string>();
  let assigned: string | null = null;
  let own = false;
  for (const g of relevant) {
    switch (g.scopeType) {
      case 'direction':
        for (const [projectId, directionId] of s.projectDirection) if (directionId === g.scopeId) projectIds.add(projectId);
        break;
      case 'project':
        if (g.scopeId) projectIds.add(g.scopeId);
        break;
      case 'account':
        if (g.scopeId) accountIds.add(g.scopeId);
        break;
      case 'assigned_projects':
        for (const p of s.assignedProjectIds) projectIds.add(p);
        break;
      case 'assigned_accounts':
        for (const a of s.assignedAccountIds) accountIds.add(a);
        break;
      case 'assigned_object':
        assigned = s.membershipId;
        break;
      case 'own_records':
        own = true;
        break;
    }
  }
  // Object-level denies on projects/accounts remove those ids from the filter.
  for (const d of s.denies) {
    if (!matchesPermission(d.permission, permission) || !d.objectId) continue;
    if (d.objectType === 'project') projectIds.delete(d.objectId);
    if (d.objectType === 'account') accountIds.delete(d.objectId);
  }
  return {
    kind: 'scoped',
    projectIds: [...projectIds],
    accountIds: [...accountIds],
    assignedToMembershipId: assigned,
    ownRecordsMembershipId: own ? s.membershipId : null,
    ownRecordsUserId: own ? s.userId : null,
  };
};

/** All permission keys the member holds in at least one scope (for UI navigation). */
export const effectivePermissionKeys = (s: AccessSnapshot, all: readonly string[]): string[] =>
  all.filter((p) => hasAnywhere(s, p));

/** Human-readable explanation for the access evaluation screen (S63). */
export const explain = (
  s: AccessSnapshot,
  permission: string,
  scope?: ObjectScope,
): { allowed: boolean; reason: string; viaRole?: string; viaScope?: string } => {
  if (s.membershipStatus !== 'active') return { allowed: false, reason: `Membership is ${s.membershipStatus}.` };
  if (isDenied(s, permission, scope)) return { allowed: false, reason: 'An explicit deny entry applies.' };
  if (s.isOwner) return { allowed: true, reason: 'Workspace Owner.', viaRole: 'owner', viaScope: 'workspace' };
  for (const g of s.grants) {
    if (!g.permissions.has(permission)) continue;
    if (!scope ? g.scopeType === 'workspace' : grantCovers(s, g, scope))
      return { allowed: true, reason: `Granted by role ${g.roleKey}.`, viaRole: g.roleKey, viaScope: g.scopeType };
  }
  const holds = s.grants.some((g) => g.permissions.has(permission));
  return {
    allowed: false,
    reason: holds ? 'The permission is held, but not for this object’s scope.' : 'No role grants this permission.',
  };
};
