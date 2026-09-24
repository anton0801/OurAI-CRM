import { and, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { PgTransaction, type PgColumn } from 'drizzle-orm/pg-core';
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
  workspaceAccessRevisions,
  type DbOrTx,
} from '@castlane/database';
import { AppError, forbidden, notFound } from '@castlane/domain';
import type { QueryContext } from './context';

/**
 * Run independent reads concurrently on the pool, one after another inside a transaction: a single
 * connection never runs overlapping queries, and a transaction never waits for a second pool
 * connection (that would exhaust the pool under concurrent writes).
 */
const concurrently = async <T extends readonly (() => Promise<unknown>)[]>(db: DbOrTx, fns: T): Promise<{ -readonly [K in keyof T]: Awaited<ReturnType<T[K]>> }> => {
  if (db instanceof PgTransaction) {
    const out: unknown[] = [];
    for (const f of fns) out.push(await f());
    return out as never;
  }
  return (await Promise.all(fns.map((f) => f()))) as never;
};

type Interval = { validFrom: Date; validTo: Date | null };
const activeAt = (r: Interval, at: Date) => r.validFrom.getTime() <= at.getTime() && (r.validTo === null || r.validTo.getTime() > at.getTime());

/** A member's grant and assignment rows with their validity intervals (filtered per request time). */
interface MemberAccessRows {
  grants: (Interval & { roleId: string; roleKey: string; permissions: string[]; scopeType: AccessSnapshot['grants'][number]['scopeType']; scopeId: string | null })[];
  denies: AccessSnapshot['denies'];
  projects: (Interval & { projectId: string })[];
  accounts: (Interval & { accountId: string })[];
}

interface WorkspaceStructure {
  projectDirection: ReadonlyMap<string, string>;
  accountProject: ReadonlyMap<string, string>;
}

/**
 * Per-process access cache. Entries are keyed by the workspace access revision, which database
 * triggers bump in the same transaction as every change to grants, denies, team/account/OFM
 * assignments, roles and the project/account structure (sql/post/011_access_revision.sql), and by
 * the member's own access_revision. The revision is read on every request before the cached rows
 * are used, so a committed change applies to the very next request; the TTL is only a backstop.
 * Validity intervals are evaluated per request, so time-bounded grants expire on time.
 */
const ACCESS_CACHE_MAX = 10_000;
const accessCacheTtlMs = () => Number(process.env.ACCESS_CACHE_TTL_MS ?? 30_000);
const memberCache = new Map<string, { rows: MemberAccessRows; loadedAt: number }>();
const structureCache = new Map<string, { revision: number; structure: WorkspaceStructure; loadedAt: number }>();

/** Drop every cached snapshot (tests, or after restoring a database under a running process). */
export const clearAccessCache = () => {
  memberCache.clear();
  structureCache.clear();
};

const fresh = (loadedAt: number) => {
  const ttl = accessCacheTtlMs();
  return ttl > 0 && Date.now() - loadedAt < ttl;
};

const loadMemberRows = async (db: DbOrTx, workspaceId: string, membershipId: string): Promise<MemberAccessRows> => {
  const [grantRows, denyRows, projectRows, accountRows, ofmRows] = await concurrently(db, [
    () =>
      db
        .select({
          roleId: roles.id,
          roleKey: roles.key,
          permissions: roles.permissions,
          scopeType: roleAssignments.scopeType,
          scopeId: roleAssignments.scopeId,
          validFrom: roleAssignments.validFrom,
          validTo: roleAssignments.validTo,
        })
        .from(roleAssignments)
        .innerJoin(roles, and(eq(roles.id, roleAssignments.roleId), eq(roles.workspaceId, roleAssignments.workspaceId)))
        .where(
          and(
            eq(roleAssignments.workspaceId, workspaceId),
            eq(roleAssignments.membershipId, membershipId),
            isNull(roleAssignments.revokedAt),
            isNull(roles.archivedAt),
          ),
        ),
    () =>
      db
        .select({ permission: accessDenies.permission, objectType: accessDenies.objectType, objectId: accessDenies.objectId })
        .from(accessDenies)
        .where(and(eq(accessDenies.workspaceId, workspaceId), eq(accessDenies.membershipId, membershipId), isNull(accessDenies.revokedAt))),
    () =>
      db
        .select({ projectId: projectMemberships.projectId, validFrom: projectMemberships.validFrom, validTo: projectMemberships.validTo })
        .from(projectMemberships)
        .where(and(eq(projectMemberships.workspaceId, workspaceId), eq(projectMemberships.membershipId, membershipId))),
    () =>
      db
        .select({ accountId: accountAssignments.accountId, validFrom: accountAssignments.validFrom, validTo: accountAssignments.validTo })
        .from(accountAssignments)
        .where(and(eq(accountAssignments.workspaceId, workspaceId), eq(accountAssignments.membershipId, membershipId))),
    () =>
      db
        .select({ accountId: ofmAssignments.accountId, validFrom: ofmAssignments.validFrom, validTo: ofmAssignments.validTo })
        .from(ofmAssignments)
        .where(and(eq(ofmAssignments.workspaceId, workspaceId), eq(ofmAssignments.membershipId, membershipId), isNull(ofmAssignments.endedAt))),
  ] as const);
  return { grants: grantRows, denies: denyRows, projects: projectRows, accounts: [...accountRows, ...ofmRows] };
};

const loadStructure = async (db: DbOrTx, workspaceId: string): Promise<WorkspaceStructure> => {
  const [structure, accountsMap] = await concurrently(db, [
    () => db.select({ id: projects.id, directionId: projects.directionId }).from(projects).where(eq(projects.workspaceId, workspaceId)),
    () => db.select({ id: socialAccounts.id, projectId: socialAccounts.projectId }).from(socialAccounts).where(eq(socialAccounts.workspaceId, workspaceId)),
  ] as const);
  return { projectDirection: new Map(structure.map((p) => [p.id, p.directionId])), accountProject: new Map(accountsMap.map((a) => [a.id, a.projectId])) };
};

/**
 * Access snapshot for (workspace, user) at a point in time. The membership row and the workspace
 * access revision are read on every call (one query); grants, assignments and the workspace
 * structure come from the per-process cache when the revisions match. Inside a transaction the
 * cache is bypassed (the transaction may see its own uncommitted changes).
 */
export const loadAccessSnapshot = async (
  db: DbOrTx,
  workspaceId: string,
  userId: string,
  at: Date,
): Promise<AccessSnapshot | null> => {
  // Revision first: rows loaded afterwards are at least as new as the revision they are cached under.
  const [row] = await db
    .select({ m: memberships, revision: workspaceAccessRevisions.revision })
    .from(memberships)
    .leftJoin(workspaceAccessRevisions, eq(workspaceAccessRevisions.workspaceId, memberships.workspaceId))
    .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, userId)))
    .limit(1);
  if (!row) return null;
  const m = row.m;
  const revision = row.revision ?? 0;
  const inTx = db instanceof PgTransaction;

  let rows: MemberAccessRows;
  const memberKey = `${workspaceId}:${m.id}:${m.accessRevision}:${revision}`;
  const cachedRows = inTx ? undefined : memberCache.get(memberKey);
  if (cachedRows && fresh(cachedRows.loadedAt)) {
    rows = cachedRows.rows;
    memberCache.delete(memberKey); // keep recently used entries at the end (LRU eviction order)
    memberCache.set(memberKey, cachedRows);
  } else {
    rows = await loadMemberRows(db, workspaceId, m.id);
    if (!inTx) {
      memberCache.set(memberKey, { rows, loadedAt: Date.now() });
      while (memberCache.size > ACCESS_CACHE_MAX) memberCache.delete(memberCache.keys().next().value!);
    }
  }

  let structure: WorkspaceStructure;
  const cachedStructure = inTx ? undefined : structureCache.get(workspaceId);
  if (cachedStructure && cachedStructure.revision === revision && fresh(cachedStructure.loadedAt)) structure = cachedStructure.structure;
  else {
    structure = await loadStructure(db, workspaceId);
    if (!inTx) {
      structureCache.set(workspaceId, { revision, structure, loadedAt: Date.now() });
      while (structureCache.size > ACCESS_CACHE_MAX) structureCache.delete(structureCache.keys().next().value!);
    }
  }

  const grants = rows.grants
    .filter((g) => activeAt(g, at))
    .map((g) => ({ roleId: g.roleId, roleKey: g.roleKey, permissions: new Set(g.permissions), scopeType: g.scopeType, scopeId: g.scopeId }));
  return {
    workspaceId,
    userId,
    membershipId: m.id,
    membershipStatus: m.status,
    accessRevision: m.accessRevision,
    isOwner: grants.some((g) => g.roleKey === 'owner' && g.scopeType === 'workspace'),
    grants,
    denies: rows.denies,
    assignedProjectIds: new Set(rows.projects.filter((r) => activeAt(r, at)).map((r) => r.projectId)),
    assignedAccountIds: new Set(rows.accounts.filter((r) => activeAt(r, at)).map((r) => r.accountId)),
    projectDirection: structure.projectDirection,
    accountProject: structure.accountProject,
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
