import { and, eq, gt, inArray, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import {
  can,
  hasAnywhere,
  listFilter,
  type AccessFilter,
  type AccessSnapshot,
  type ObjectScope,
} from '@castlane/authorization';
import {
  accessDenies,
  accountAssignments,
  memberships,
  ofmAssignments,
  projectMemberships,
  projects,
  roleAssignments,
  roles,
  socialAccounts,
  type DbOrTx,
} from '@castlane/database';
import { AppError, forbidden, notFound } from '@castlane/domain';
import type { QueryContext } from './context';

/**
 * Build a fresh access snapshot for (workspace, user). Called on every request so a revoked
 * role or membership takes effect on the next API call.
 */
export const loadAccessSnapshot = async (
  db: DbOrTx,
  workspaceId: string,
  userId: string,
  at: Date,
): Promise<AccessSnapshot | null> => {
  const [m] = await db
    .select()
    .from(memberships)
    .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, userId)))
    .limit(1);
  if (!m) return null;

  const activeInterval = (from: PgColumn, to: PgColumn) => and(lte(from, at), or(isNull(to), gt(to, at)));

  const [grantRows, denyRows, projectRows, accountRows, ofmRows, structure, accountsMap] = await Promise.all([
    db
      .select({
        roleId: roles.id,
        roleKey: roles.key,
        permissions: roles.permissions,
        scopeType: roleAssignments.scopeType,
        scopeId: roleAssignments.scopeId,
      })
      .from(roleAssignments)
      .innerJoin(roles, and(eq(roles.id, roleAssignments.roleId), eq(roles.workspaceId, roleAssignments.workspaceId)))
      .where(
        and(
          eq(roleAssignments.workspaceId, workspaceId),
          eq(roleAssignments.membershipId, m.id),
          isNull(roleAssignments.revokedAt),
          isNull(roles.archivedAt),
          activeInterval(roleAssignments.validFrom, roleAssignments.validTo),
        ),
      ),
    db
      .select({ permission: accessDenies.permission, objectType: accessDenies.objectType, objectId: accessDenies.objectId })
      .from(accessDenies)
      .where(and(eq(accessDenies.workspaceId, workspaceId), eq(accessDenies.membershipId, m.id), isNull(accessDenies.revokedAt))),
    db
      .select({ projectId: projectMemberships.projectId })
      .from(projectMemberships)
      .where(
        and(
          eq(projectMemberships.workspaceId, workspaceId),
          eq(projectMemberships.membershipId, m.id),
          activeInterval(projectMemberships.validFrom, projectMemberships.validTo),
        ),
      ),
    db
      .select({ accountId: accountAssignments.accountId })
      .from(accountAssignments)
      .where(
        and(
          eq(accountAssignments.workspaceId, workspaceId),
          eq(accountAssignments.membershipId, m.id),
          activeInterval(accountAssignments.validFrom, accountAssignments.validTo),
        ),
      ),
    db
      .select({ accountId: ofmAssignments.accountId })
      .from(ofmAssignments)
      .where(
        and(
          eq(ofmAssignments.workspaceId, workspaceId),
          eq(ofmAssignments.membershipId, m.id),
          isNull(ofmAssignments.endedAt),
          activeInterval(ofmAssignments.validFrom, ofmAssignments.validTo),
        ),
      ),
    db.select({ id: projects.id, directionId: projects.directionId }).from(projects).where(eq(projects.workspaceId, workspaceId)),
    db
      .select({ id: socialAccounts.id, projectId: socialAccounts.projectId })
      .from(socialAccounts)
      .where(eq(socialAccounts.workspaceId, workspaceId)),
  ]);

  const grants = grantRows.map((g) => ({
    roleId: g.roleId,
    roleKey: g.roleKey,
    permissions: new Set(g.permissions),
    scopeType: g.scopeType,
    scopeId: g.scopeId,
  }));
  return {
    workspaceId,
    userId,
    membershipId: m.id,
    membershipStatus: m.status,
    accessRevision: m.accessRevision,
    isOwner: grants.some((g) => g.roleKey === 'owner' && g.scopeType === 'workspace'),
    grants,
    denies: denyRows,
    assignedProjectIds: new Set(projectRows.map((r) => r.projectId)),
    assignedAccountIds: new Set([...accountRows.map((r) => r.accountId), ...ofmRows.map((r) => r.accountId)]),
    projectDirection: new Map(structure.map((p) => [p.id, p.directionId])),
    accountProject: new Map(accountsMap.map((a) => [a.id, a.projectId])),
  };
};

/** Module-level gate: no grant anywhere → 403 (the module is known, the action is not allowed). */
export const requirePermission = (ctx: QueryContext, permission: string): void => {
  if (!hasAnywhere(ctx.actor.access, permission)) throw forbidden();
};

/** Any of the permissions anywhere. */
export const requireAnyPermission = (ctx: QueryContext, permissions: string[]): void => {
  if (!permissions.some((p) => hasAnywhere(ctx.actor.access, p))) throw forbidden();
};

export const allowed = (ctx: QueryContext, permission: string, scope?: ObjectScope): boolean =>
  can(ctx.actor.access, permission, scope);

/**
 * Object-level gate. If the actor cannot even read the object the response is 404 (no
 * existence leak); if they can read it but not perform the action it is 403.
 */
export const authorizeObject = (
  ctx: QueryContext,
  action: string,
  scope: ObjectScope,
  readPermission: string | string[],
): void => {
  if (can(ctx.actor.access, action, scope)) return;
  const reads = Array.isArray(readPermission) ? readPermission : [readPermission];
  if (reads.some((p) => can(ctx.actor.access, p, scope))) throw forbidden();
  throw notFound();
};

/** Read gate for detail endpoints: out of scope → 404. */
export const authorizeRead = (ctx: QueryContext, readPermission: string | string[], scope: ObjectScope): void => {
  const reads = Array.isArray(readPermission) ? readPermission : [readPermission];
  if (!reads.some((p) => can(ctx.actor.access, p, scope))) throw notFound();
};

export const requireRecentAuth = (ctx: QueryContext, maxAgeMinutes = 15): void => {
  const at = ctx.actor.recentAuthAt;
  if (!at || ctx.app.clock.now().getTime() - at.getTime() > maxAgeMinutes * 60_000) {
    throw new AppError('RECENT_AUTH_REQUIRED', 'Confirm your password and verification code to continue.');
  }
};

export interface ScopeColumns {
  projectId?: PgColumn;
  accountId?: PgColumn;
  /** Columns holding membership ids for assigned_object scope (assignee, reviewer, owner…). */
  assigned?: PgColumn[];
  /** Author/owner membership column for own_records. */
  ownerMembership?: PgColumn;
  createdByUser?: PgColumn;
}

/**
 * Translate the actor's scope for a permission into a SQL predicate. Returns `undefined` for
 * unrestricted access and a FALSE predicate when nothing is visible. Always applied before
 * pagination/aggregation.
 */
export const scopePredicate = (ctx: QueryContext, permission: string, cols: ScopeColumns): SQL | undefined =>
  filterToSql(listFilter(ctx.actor.access, permission), cols);

export const filterToSql = (f: AccessFilter, cols: ScopeColumns): SQL | undefined => {
  if (f.kind === 'all') return undefined;
  if (f.kind === 'none') return sql`false`;
  const parts: SQL[] = [];
  if (cols.projectId && f.projectIds.length) parts.push(inArray(cols.projectId, f.projectIds));
  if (cols.accountId && f.accountIds.length) parts.push(inArray(cols.accountId, f.accountIds));
  if (!cols.accountId && cols.projectId && f.accountIds.length) {
    // Account-scoped grants still reveal project-level rows only via the account; nothing to add here.
  }
  if (f.assignedToMembershipId && cols.assigned?.length)
    for (const c of cols.assigned) parts.push(eq(c, f.assignedToMembershipId));
  if (f.ownRecordsMembershipId && cols.ownerMembership) parts.push(eq(cols.ownerMembership, f.ownRecordsMembershipId));
  if (f.ownRecordsUserId && cols.createdByUser) parts.push(eq(cols.createdByUser, f.ownRecordsUserId));
  if (parts.length === 0) return sql`false`;
  return parts.length === 1 ? parts[0] : or(...parts);
};

/** Combine a scope predicate with other conditions, skipping undefined. */
export const whereAll = (...conds: (SQL | undefined)[]): SQL | undefined => {
  const present = conds.filter((c): c is SQL => !!c);
  if (present.length === 0) return undefined;
  return present.length === 1 ? present[0] : and(...present);
};
