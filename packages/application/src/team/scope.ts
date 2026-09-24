import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { listFilter, type AccessSnapshot } from '@castlane/authorization';
import {
  accountAssignments,
  directions,
  memberships,
  projectMemberships,
  projects,
  responsibilityAssignments,
  roleAssignments,
  socialAccounts,
  type DbOrTx,
} from '@castlane/database';
import { AppError, forbidden, notFound, type ScopeType } from '@castlane/domain';
import { allowed } from '../core/access';
import { dbOf, type CommandContext, type QueryContext } from '../core/context';
import { streamEvent } from '../core/events';

/**
 * Which members a permission lets the actor see or act on. A member is "in scope" when they work on
 * a project/account in the actor's scope, hold a role/duty/lead in one of the actor's directions,
 * or (for reads) are the actor themselves.
 */
export type MemberVisibility =
  | { kind: 'all' }
  | { kind: 'none' }
  | { kind: 'scoped'; projectIds: string[]; accountIds: string[]; directionIds: string[]; selfId: string | null };

export const memberVisibility = (access: AccessSnapshot, permission: string, opts: { includeSelf?: boolean } = {}): MemberVisibility => {
  const f = listFilter(access, permission);
  if (f.kind === 'all') return f;
  if (f.kind === 'none') {
    return opts.includeSelf && access.membershipStatus === 'active'
      ? { kind: 'scoped', projectIds: [], accountIds: [], directionIds: [], selfId: access.membershipId }
      : { kind: 'none' };
  }
  const deniedDirections = new Set(access.denies.filter((d) => d.objectType === 'direction' && d.objectId).map((d) => d.objectId!));
  const directionIds = [
    ...new Set(
      access.grants
        .filter((g) => g.permissions.has(permission) && g.scopeType === 'direction' && g.scopeId && !deniedDirections.has(g.scopeId))
        .map((g) => g.scopeId!),
    ),
  ];
  const self = opts.includeSelf || !!f.ownRecordsMembershipId || !!f.assignedToMembershipId;
  return { kind: 'scoped', projectIds: f.projectIds, accountIds: f.accountIds, directionIds, selfId: self ? access.membershipId : null };
};

/** SQL predicate over a membership id column (applied before pagination and counts). */
export const memberVisibilitySql = (v: MemberVisibility, memberId: PgColumn = memberships.id): SQL | undefined => {
  if (v.kind === 'all') return undefined;
  if (v.kind === 'none') return sql`false`;
  const parts: SQL[] = [];
  if (v.selfId) parts.push(sql`${memberId} = ${v.selfId}`);
  if (v.projectIds.length)
    parts.push(sql`EXISTS (SELECT 1 FROM ${projectMemberships} WHERE ${projectMemberships.membershipId} = ${memberId} AND ${projectMemberships.validTo} IS NULL AND ${projectMemberships.projectId} IN ${v.projectIds})`);
  if (v.accountIds.length)
    parts.push(sql`EXISTS (SELECT 1 FROM ${accountAssignments} WHERE ${accountAssignments.membershipId} = ${memberId} AND ${accountAssignments.validTo} IS NULL AND ${accountAssignments.accountId} IN ${v.accountIds})`);
  if (v.directionIds.length) {
    parts.push(sql`EXISTS (SELECT 1 FROM ${roleAssignments} WHERE ${roleAssignments.membershipId} = ${memberId} AND ${roleAssignments.revokedAt} IS NULL AND ${roleAssignments.scopeType} = 'direction' AND ${roleAssignments.scopeId} IN ${v.directionIds})`);
    parts.push(sql`EXISTS (SELECT 1 FROM ${responsibilityAssignments} WHERE ${responsibilityAssignments.membershipId} = ${memberId} AND ${responsibilityAssignments.validTo} IS NULL AND ${responsibilityAssignments.scopeType} = 'direction' AND ${responsibilityAssignments.scopeId} IN ${v.directionIds})`);
    parts.push(sql`EXISTS (SELECT 1 FROM ${directions} WHERE ${directions.leadMembershipId} = ${memberId} AND ${directions.id} IN ${v.directionIds})`);
    parts.push(sql`EXISTS (SELECT 1 FROM ${projectMemberships} JOIN ${projects} ON ${projects.id} = ${projectMemberships.projectId} WHERE ${projectMemberships.membershipId} = ${memberId} AND ${projectMemberships.validTo} IS NULL AND ${projects.directionId} IN ${v.directionIds})`);
  }
  if (parts.length === 0) return sql`false`;
  return parts.length === 1 ? parts[0] : sql`(${sql.join(parts, sql` OR `)})`;
};

/** Is one specific member covered by the visibility? */
export const memberInScope = async (db: DbOrTx, workspaceId: string, v: MemberVisibility, membershipId: string): Promise<boolean> => {
  if (v.kind === 'all') return true;
  if (v.kind === 'none') return false;
  if (v.selfId === membershipId) return true;
  const pred = memberVisibilitySql(v);
  const rows = await db
    .select({ id: memberships.id })
    .from(memberships)
    .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.id, membershipId), pred))
    .limit(1);
  return rows.length > 0;
};

export type MembershipRow = typeof memberships.$inferSelect;

/** Load a member the actor may read (members.read in scope, or self); otherwise 404. */
export const loadReadableMember = async (ctx: QueryContext | CommandContext, membershipId: string, opts: { lock?: boolean } = {}): Promise<MembershipRow> => {
  const db = dbOf(ctx);
  const q = db
    .select()
    .from(memberships)
    .where(and(eq(memberships.workspaceId, ctx.actor.workspaceId), eq(memberships.id, membershipId)))
    .limit(1);
  const [m] = opts.lock && 'tx' in ctx ? await q.for('update') : await q;
  if (!m) throw notFound('Member');
  const v = memberVisibility(ctx.actor.access, 'members.read', { includeSelf: true });
  if (!(await memberInScope(db, ctx.actor.workspaceId, v, m.id))) throw notFound('Member');
  return m;
};

/** Member actions: 404 when the member is not readable, 403 when readable but the action is not allowed. */
export const authorizeMemberAction = async (ctx: QueryContext | CommandContext, m: MembershipRow, permission: string): Promise<void> => {
  const v = memberVisibility(ctx.actor.access, permission);
  if (await memberInScope(dbOf(ctx), ctx.actor.workspaceId, v, m.id)) return;
  throw forbidden();
};

export const canActOnMember = async (ctx: QueryContext | CommandContext, membershipId: string, permission: string): Promise<boolean> =>
  memberInScope(dbOf(ctx), ctx.actor.workspaceId, memberVisibility(ctx.actor.access, permission), membershipId);

/** Nobody changes their own access; another administrator (or the Owner) must do it. */
export const assertNotSelf = (ctx: QueryContext, membershipId: string, message = 'You cannot change your own access. Ask another administrator.') => {
  if (ctx.actor.membershipId === membershipId) throw new AppError('FORBIDDEN', message);
};

/**
 * Access changed for these members: bump their access revision (open sessions re-evaluate on the
 * next request, running commands fail) and push an `access_changed` event to their live streams.
 */
export const bumpAccessRevision = async (ctx: CommandContext, membershipIds: (string | null | undefined)[]) => {
  const ids = [...new Set(membershipIds.filter((x): x is string => !!x))];
  for (const id of ids) {
    await ctx.tx
      .update(memberships)
      .set({ accessRevision: sql`${memberships.accessRevision} + 1` })
      .where(and(eq(memberships.workspaceId, ctx.actor.workspaceId), eq(memberships.id, id)));
    await streamEvent(ctx.tx, { workspaceId: ctx.actor.workspaceId, kind: 'access_changed', entityType: 'membership', entityId: id, recipientMembershipId: id });
  }
};

// ——— Scope labels ———

const RELATIVE_LABELS: Record<string, string> = {
  workspace: 'Whole workspace',
  assigned_projects: 'Assigned projects',
  assigned_accounts: 'Assigned accounts',
  assigned_object: 'Assigned items only',
  own_records: 'Own records',
};

export type ScopeLabeler = (scopeType: ScopeType | string, scopeId: string | null) => string;

/**
 * Resolve scope labels in one round trip per type. Names of objects the viewer cannot read are not
 * revealed ("Project (restricted)").
 */
export const scopeLabeler = async (ctx: QueryContext | CommandContext, refs: { scopeType: string; scopeId: string | null }[]): Promise<ScopeLabeler> => {
  const db = dbOf(ctx);
  const ws = ctx.actor.workspaceId;
  const ids = (t: string) => [...new Set(refs.filter((r) => r.scopeType === t && r.scopeId).map((r) => r.scopeId!))];
  const dirIds = ids('direction');
  const projIds = ids('project');
  const accIds = ids('account');
  const dirRows = dirIds.length ? await db.select({ id: directions.id, name: directions.name }).from(directions).where(and(eq(directions.workspaceId, ws), inArray(directions.id, dirIds))) : [];
  const projRows = projIds.length
    ? await db.select({ id: projects.id, name: projects.name, directionId: projects.directionId, owner: projects.ownerMembershipId }).from(projects).where(and(eq(projects.workspaceId, ws), inArray(projects.id, projIds)))
    : [];
  const accRows = accIds.length
    ? await db
        .select({ id: socialAccounts.id, handle: socialAccounts.handle, displayName: socialAccounts.displayName, platform: socialAccounts.platform, projectId: socialAccounts.projectId })
        .from(socialAccounts)
        .where(and(eq(socialAccounts.workspaceId, ws), inArray(socialAccounts.id, accIds)))
    : [];
  const dirs = new Map(dirRows.map((d) => [d.id, d]));
  const projs = new Map(projRows.map((p) => [p.id, p]));
  const accs = new Map(accRows.map((a) => [a.id, a]));
  return (scopeType, scopeId) => {
    if (RELATIVE_LABELS[scopeType]) return RELATIVE_LABELS[scopeType]!;
    if (!scopeId) return 'Scope not set';
    if (scopeType === 'direction') {
      const d = dirs.get(scopeId);
      return d && allowed(ctx, 'directions.read', { directionId: d.id }) ? `Direction: ${d.name}` : 'Direction (restricted)';
    }
    if (scopeType === 'project') {
      const p = projs.get(scopeId);
      return p && allowed(ctx, 'projects.read', { objectType: 'project', objectId: p.id, projectId: p.id, directionId: p.directionId, ownerMembershipId: p.owner })
        ? `Project: ${p.name}`
        : 'Project (restricted)';
    }
    if (scopeType === 'account') {
      const a = accs.get(scopeId);
      return a && allowed(ctx, 'accounts.read', { accountId: a.id, projectId: a.projectId }) ? `Account: ${a.displayName ?? (a.handle ? `@${a.handle}` : a.platform)}` : 'Account (restricted)';
    }
    return scopeType;
  };
};

/** Whether a scope object exists in this workspace (grants, duties, denies never reference foreign rows). */
export const assertScopeObject = async (db: DbOrTx, workspaceId: string, scopeType: string, scopeId: string | null, field = 'scopeId') => {
  const needsId = scopeType === 'direction' || scopeType === 'project' || scopeType === 'account';
  if (needsId !== !!scopeId)
    throw new AppError('VALIDATION_FAILED', 'The selected scope is incomplete.', { fieldErrors: [{ field, code: 'SCOPE_INCOMPLETE', message: 'Choose the object for this scope.' }] });
  if (!scopeId) return;
  const table = scopeType === 'direction' ? directions : scopeType === 'project' ? projects : socialAccounts;
  const [row] = await db
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.workspaceId, workspaceId), eq(table.id, scopeId)))
    .limit(1);
  if (!row) throw new AppError('VALIDATION_FAILED', `The selected ${scopeType} does not exist.`, { fieldErrors: [{ field, code: 'NOT_FOUND', message: `The selected ${scopeType} does not exist.` }] });
};

/**
 * Scoped access managers (e.g. a custom role with access.manage for one direction) may only grant
 * inside their own scope; workspace-level managers may grant anywhere.
 */
export const assertGrantScopeWithinManager = async (ctx: QueryContext | CommandContext, scopeType: string, scopeId: string | null, permission = 'access.manage') => {
  const f = listFilter(ctx.actor.access, permission);
  if (f.kind === 'all') return;
  if (f.kind === 'none') throw forbidden();
  const v = memberVisibility(ctx.actor.access, permission);
  const ok =
    v.kind === 'scoped' &&
    ((scopeType === 'direction' && !!scopeId && v.directionIds.includes(scopeId)) ||
      (scopeType === 'project' && !!scopeId && v.projectIds.includes(scopeId)) ||
      (scopeType === 'account' && !!scopeId && v.accountIds.includes(scopeId)));
  if (!ok) throw new AppError('FORBIDDEN', 'You can only grant access inside the scope you manage.');
};
