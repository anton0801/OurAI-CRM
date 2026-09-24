import { and, asc, count, desc, eq, gt, ilike, inArray, isNull, lt, lte, or, sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { hasAnywhere, listFilter } from '@castlane/authorization';
import {
  accountAssignments,
  auditEvents,
  directions,
  memberships,
  projectMemberships,
  projects,
  responsibilityAssignments,
  roleAssignments,
  roles,
  socialAccounts,
  tasks,
  userPreferences,
  users,
} from '@castlane/database';
import { AppError, clampPageSize, decodeCursor, encodeCursor, newId, notFound } from '@castlane/domain';
import { ENTITY_ROUTES, entityHref } from '@castlane/api-contracts';
import { allowed, requirePermission, scopePredicate, whereAll } from '../core/access';
import { audit, diffFields } from '../core/audit';
import { all, dbOf, type CommandContext, type QueryContext } from '../core/context';
import { emit } from '../core/events';
import { isActiveMember, loadMemberRefs, refOrUnknown, type MemberRef } from '../core/members';
import { assertVersion, lockById, stamp, touch } from '../core/rows';
import { indexSearchDocument } from '../core/search';
import { createsManagerCycle } from './grant-rules';
import {
  assertScopeObject,
  authorizeMemberAction,
  canActOnMember,
  loadReadableMember,
  memberVisibility,
  memberVisibilitySql,
  scopeLabeler,
  type MembershipRow,
} from './scope';

const OPEN_TASK_STATUSES = ['draft', 'backlog', 'ready', 'in_progress', 'in_review'] as const;

const activeAt = (from: PgColumn, to: PgColumn, at: Date) => and(lte(from, at), or(isNull(to), gt(to, at)));

const avatarUrl = (userId: string, assetId: string | null, anonymized: Date | null) => (assetId && !anonymized ? `/api/v1/avatars/${userId}` : null);

type MemberBase = MembershipRow & { name: string; email: string; avatarAssetId: string | null; anonymizedAt: Date | null; mfaEnabledAt: Date | null; timezone: string | null };

const baseSelect = {
  m: memberships,
  name: users.displayName,
  email: users.displayEmail,
  avatarAssetId: users.avatarAssetId,
  anonymizedAt: users.anonymizedAt,
  mfaEnabledAt: users.mfaEnabledAt,
  timezone: userPreferences.timezone,
};

const flatten = (r: { m: MembershipRow; name: string; email: string; avatarAssetId: string | null; anonymizedAt: Date | null; mfaEnabledAt: Date | null; timezone: string | null }): MemberBase => ({
  ...r.m,
  name: r.name,
  email: r.email,
  avatarAssetId: r.avatarAssetId,
  anonymizedAt: r.anonymizedAt,
  mfaEnabledAt: r.mfaEnabledAt,
  timezone: r.timezone,
});

/** Roles, duties, directions, visible projects and scoped workload for a page of members. */
const memberExtras = async (ctx: QueryContext | CommandContext, rows: MemberBase[]) => {
  const db = dbOf(ctx);
  const ws = ctx.actor.workspaceId;
  const ids = rows.map((r) => r.id);
  const at = ctx.app.clock.now();
  if (ids.length === 0) return null;
  const canReadTasks = hasAnywhere(ctx.actor.access, 'tasks.read');
  const [grantRows, dutyRows, leadRows, projectRows, taskRows, dirRows, managerRefs] = await all(ctx, [
    () =>
      db
        .select({ membershipId: roleAssignments.membershipId, roleId: roles.id, roleKey: roles.key, roleName: roles.name, scopeType: roleAssignments.scopeType, scopeId: roleAssignments.scopeId })
        .from(roleAssignments)
        .innerJoin(roles, and(eq(roles.id, roleAssignments.roleId), eq(roles.workspaceId, roleAssignments.workspaceId)))
        .where(and(eq(roleAssignments.workspaceId, ws), inArray(roleAssignments.membershipId, ids), isNull(roleAssignments.revokedAt), activeAt(roleAssignments.validFrom, roleAssignments.validTo, at)))
        .orderBy(asc(roles.name)),
    () =>
      db
        .select()
        .from(responsibilityAssignments)
        .where(
          and(
            eq(responsibilityAssignments.workspaceId, ws),
            inArray(responsibilityAssignments.membershipId, ids),
            activeAt(responsibilityAssignments.validFrom, responsibilityAssignments.validTo, at),
          ),
        ),
    () => db.select({ id: directions.id, lead: directions.leadMembershipId }).from(directions).where(and(eq(directions.workspaceId, ws), inArray(directions.leadMembershipId, ids), eq(directions.status, 'active'))),
    () =>
      db
        .select({ membershipId: projectMemberships.membershipId, id: projects.id, name: projects.name, directionId: projects.directionId, owner: projects.ownerMembershipId, status: projects.status })
        .from(projectMemberships)
        .innerJoin(projects, and(eq(projects.id, projectMemberships.projectId), eq(projects.workspaceId, projectMemberships.workspaceId)))
        .where(and(eq(projectMemberships.workspaceId, ws), inArray(projectMemberships.membershipId, ids), isNull(projectMemberships.validTo), isNull(projects.deletedAt)))
        .orderBy(asc(projects.name)),
    () =>
      canReadTasks
        ? db
            .select({ membershipId: tasks.assigneeMembershipId, n: count() })
            .from(tasks)
            .where(
              whereAll(
                eq(tasks.workspaceId, ws),
                inArray(tasks.assigneeMembershipId, ids),
                inArray(tasks.status, [...OPEN_TASK_STATUSES]),
                isNull(tasks.deletedAt),
                scopePredicate(ctx, 'tasks.read', { projectId: tasks.projectId, accountId: tasks.accountId, assigned: [tasks.assigneeMembershipId, tasks.reviewerMembershipId] }),
              ),
            )
            .groupBy(tasks.assigneeMembershipId)
        : Promise.resolve([] as { membershipId: string | null; n: number }[]),
    () => db.select({ id: directions.id, name: directions.name, status: directions.status, sortOrder: directions.sortOrder }).from(directions).where(eq(directions.workspaceId, ws)),
    () => loadMemberRefs(db, ws, rows.map((r) => r.managerMembershipId)),
  ] as const);
  const label = await scopeLabeler(ctx, [...grantRows, ...dutyRows]);
  const dirName = new Map(dirRows.map((d) => [d.id, d]));
  const readableDirection = (id: string) => !!dirName.get(id) && allowed(ctx, 'directions.read', { directionId: id });
  const taskCount = new Map(taskRows.map((t) => [t.membershipId, Number(t.n)]));
  return { grantRows, dutyRows, leadRows, projectRows, taskCount, dirName, readableDirection, managerRefs, label, canReadTasks };
};

type Extras = NonNullable<Awaited<ReturnType<typeof memberExtras>>>;

const toRow = (ctx: QueryContext, r: MemberBase, x: Extras) => {
  const grants = x.grantRows.filter((g) => g.membershipId === r.id);
  const duties = x.dutyRows.filter((d) => d.membershipId === r.id);
  const projectsOf = x.projectRows.filter((p) => p.membershipId === r.id);
  const visibleProjects = projectsOf.filter((p) =>
    allowed(ctx, 'projects.read', { objectType: 'project', objectId: p.id, projectId: p.id, directionId: p.directionId, ownerMembershipId: p.owner }),
  );
  const dirIds = new Set<string>();
  for (const g of grants) if (g.scopeType === 'direction' && g.scopeId) dirIds.add(g.scopeId);
  for (const d of duties) if (d.scopeType === 'direction' && d.scopeId) dirIds.add(d.scopeId);
  for (const l of x.leadRows) if (l.lead === r.id) dirIds.add(l.id);
  for (const p of projectsOf) dirIds.add(p.directionId);
  const dirs = [...dirIds]
    .filter(x.readableDirection)
    .map((id) => x.dirName.get(id)!)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
    .map((d) => ({ id: d.id, name: d.name }));
  const deactivated = r.status === 'deactivated';
  return {
    membershipId: r.id,
    displayName: r.anonymizedAt ? 'Former Member' : deactivated ? r.displayNameSnapshot : r.name,
    email: r.anonymizedAt ? null : r.email,
    avatarUrl: avatarUrl(r.userId, r.avatarAssetId, r.anonymizedAt),
    title: r.title,
    status: r.status,
    isOwner: grants.some((g) => g.roleKey === 'owner' && g.scopeType === 'workspace'),
    joinedAt: r.joinedAt.toISOString(),
    suspendedAt: r.suspendedAt?.toISOString() ?? null,
    deactivatedAt: r.deactivatedAt?.toISOString() ?? null,
    roles: grants.map((g) => ({ roleId: g.roleId, roleKey: g.roleKey, roleName: g.roleName, scopeType: g.scopeType, scopeId: g.scopeId, scopeLabel: x.label(g.scopeType, g.scopeId) })),
    responsibilities: duties.map((d) => ({ duty: d.duty, scopeLabel: x.label(d.scopeType, d.scopeId) })),
    manager: refOrUnknown(x.managerRefs, r.managerMembershipId),
    directions: dirs,
    projects: visibleProjects.slice(0, 5).map((p) => ({ id: p.id, name: p.name })),
    projectCount: visibleProjects.length,
    openTasks: x.canReadTasks ? (x.taskCount.get(r.id) ?? 0) : null,
    ...(hasAnywhere(ctx.actor.access, 'access.read') ? { mfaEnabled: !!r.mfaEnabledAt } : {}),
    rowVersion: r.rowVersion,
  };
};

export interface ListMembersInput {
  cursor?: string;
  pageSize?: number;
  q?: string;
  status?: MembershipRow['status'][];
  roleId?: string;
  directionId?: string;
  projectId?: string;
  responsibility?: string;
  sort: 'name' | 'joinedAt' | 'status';
  direction: 'asc' | 'desc';
}

const SORT = { name: users.displayName, joinedAt: memberships.joinedAt, status: memberships.status } as const;

export const listMembers = async (ctx: QueryContext, input: ListMembersInput) => {
  requirePermission(ctx, 'members.read');
  const at = ctx.app.clock.now();
  const size = clampPageSize(input.pageSize);
  const sortCol = SORT[input.sort];
  const cursor = input.cursor ? decodeCursor(input.cursor) : null;
  const cmp = input.direction === 'asc' ? gt : lt;
  let cursorCond: SQL | undefined;
  if (cursor) {
    const v = input.sort === 'joinedAt' ? new Date(String(cursor.v[0])) : cursor.v[0];
    cursorCond = or(cmp(sortCol, v as never), and(eq(sortCol, v as never), cmp(memberships.id, cursor.id)));
  }
  const q = input.q?.trim();
  const like = q ? `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%` : null;
  const statuses = input.status?.length ? input.status : (['active', 'suspended'] as const);
  const dir = input.directionId;
  const where = whereAll(
    eq(memberships.workspaceId, ctx.actor.workspaceId),
    // Scope is part of the SQL: members outside it are never listed or counted.
    memberVisibilitySql(memberVisibility(ctx.actor.access, 'members.read', { includeSelf: true })),
    inArray(memberships.status, [...statuses]),
    like ? or(ilike(users.displayName, like), ilike(users.displayEmail, like), ilike(memberships.title, like)) : undefined,
    input.roleId
      ? sql`EXISTS (SELECT 1 FROM ${roleAssignments} WHERE ${roleAssignments.membershipId} = ${memberships.id} AND ${roleAssignments.roleId} = ${input.roleId} AND ${roleAssignments.revokedAt} IS NULL AND ${roleAssignments.validFrom} <= ${at} AND (${roleAssignments.validTo} IS NULL OR ${roleAssignments.validTo} > ${at}))`
      : undefined,
    input.projectId
      ? sql`EXISTS (SELECT 1 FROM ${projectMemberships} WHERE ${projectMemberships.membershipId} = ${memberships.id} AND ${projectMemberships.projectId} = ${input.projectId} AND ${projectMemberships.validTo} IS NULL)`
      : undefined,
    input.responsibility
      ? sql`EXISTS (SELECT 1 FROM ${responsibilityAssignments} WHERE ${responsibilityAssignments.membershipId} = ${memberships.id} AND ${responsibilityAssignments.duty} = ${input.responsibility} AND ${responsibilityAssignments.validFrom} <= ${at} AND (${responsibilityAssignments.validTo} IS NULL OR ${responsibilityAssignments.validTo} > ${at}))`
      : undefined,
    dir
      ? sql`(EXISTS (SELECT 1 FROM ${roleAssignments} WHERE ${roleAssignments.membershipId} = ${memberships.id} AND ${roleAssignments.revokedAt} IS NULL AND ${roleAssignments.scopeType} = 'direction' AND ${roleAssignments.scopeId} = ${dir})
          OR EXISTS (SELECT 1 FROM ${responsibilityAssignments} WHERE ${responsibilityAssignments.membershipId} = ${memberships.id} AND ${responsibilityAssignments.validTo} IS NULL AND ${responsibilityAssignments.scopeType} = 'direction' AND ${responsibilityAssignments.scopeId} = ${dir})
          OR EXISTS (SELECT 1 FROM ${directions} WHERE ${directions.leadMembershipId} = ${memberships.id} AND ${directions.id} = ${dir})
          OR EXISTS (SELECT 1 FROM ${projectMemberships} JOIN ${projects} ON ${projects.id} = ${projectMemberships.projectId} WHERE ${projectMemberships.membershipId} = ${memberships.id} AND ${projectMemberships.validTo} IS NULL AND ${projects.directionId} = ${dir}))`
      : undefined,
    cursorCond,
  );
  const rows = (
    await ctx.app.db
      .select(baseSelect)
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .leftJoin(userPreferences, eq(userPreferences.userId, users.id))
      .where(where)
      .orderBy(input.direction === 'asc' ? asc(sortCol) : desc(sortCol), input.direction === 'asc' ? asc(memberships.id) : desc(memberships.id))
      .limit(size + 1)
  ).map(flatten);
  const hasMore = rows.length > size;
  const pageRows = hasMore ? rows.slice(0, size) : rows;
  const x = await memberExtras(ctx, pageRows);
  const last = pageRows[pageRows.length - 1];
  const lastValue = last ? (input.sort === 'name' ? last.name : input.sort === 'joinedAt' ? last.joinedAt.toISOString() : last.status) : null;
  return {
    items: x ? pageRows.map((r) => toRow(ctx, r, x)) : [],
    hasMore,
    nextCursor: hasMore && last ? encodeCursor({ v: [lastValue], id: last.id }) : null,
  };
};

const loadBase = async (ctx: QueryContext | CommandContext, membershipId: string): Promise<MemberBase> => {
  const [r] = await dbOf(ctx)
    .select(baseSelect)
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .leftJoin(userPreferences, eq(userPreferences.userId, users.id))
    .where(and(eq(memberships.workspaceId, ctx.actor.workspaceId), eq(memberships.id, membershipId)));
  if (!r) throw notFound('Member');
  return flatten(r);
};

export const isWorkspaceOwner = async (ctx: QueryContext | CommandContext, membershipId: string): Promise<boolean> => {
  const [r] = await dbOf(ctx)
    .select({ id: roleAssignments.id })
    .from(roleAssignments)
    .innerJoin(roles, eq(roles.id, roleAssignments.roleId))
    .where(
      and(
        eq(roleAssignments.workspaceId, ctx.actor.workspaceId),
        eq(roleAssignments.membershipId, membershipId),
        eq(roles.key, 'owner'),
        eq(roleAssignments.scopeType, 'workspace'),
        isNull(roleAssignments.revokedAt),
      ),
    )
    .limit(1);
  return !!r;
};

export const getMember = async (ctx: QueryContext | CommandContext, membershipId: string) => {
  const m = await loadReadableMember(ctx, membershipId);
  const r = await loadBase(ctx, m.id);
  const x = (await memberExtras(ctx, [r]))!;
  const db = dbOf(ctx);
  const [reportsRows, duties] = await all(ctx, [
    () =>
      db
        .select({ id: memberships.id })
        .from(memberships)
        .where(and(eq(memberships.workspaceId, ctx.actor.workspaceId), eq(memberships.managerMembershipId, m.id), eq(memberships.status, 'active'))),
    () =>
      db
        .select()
        .from(responsibilityAssignments)
        .where(and(eq(responsibilityAssignments.workspaceId, ctx.actor.workspaceId), eq(responsibilityAssignments.membershipId, m.id)))
        .orderBy(desc(responsibilityAssignments.validFrom)),
  ] as const);
  const refs = await loadMemberRefs(db, ctx.actor.workspaceId, reportsRows.map((x) => x.id));
  let deactivatedBy: MemberRef | null = null;
  if (m.deactivatedBy) {
    const [byMember] = await db
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.workspaceId, ctx.actor.workspaceId), eq(memberships.userId, m.deactivatedBy)));
    if (byMember) deactivatedBy = (await loadMemberRefs(db, ctx.actor.workspaceId, [byMember.id])).get(byMember.id) ?? null;
  }
  const label = await scopeLabeler(ctx, duties);
  const row = toRow(ctx, r, x);
  const isSelf = ctx.actor.membershipId === m.id;
  const [canUpdate, canSuspend, canManageAccess, canReadAccess, canRevokeSessions, canAudit] = [
    await canActOnMember(ctx, m.id, 'members.update'),
    await canActOnMember(ctx, m.id, 'members.suspend'),
    await canActOnMember(ctx, m.id, 'access.manage'),
    await canActOnMember(ctx, m.id, 'access.read'),
    await canActOnMember(ctx, m.id, 'security.sessions.revoke'),
    hasAnywhere(ctx.actor.access, 'audit.read'),
  ];
  return {
    ...row,
    skills: m.skills,
    timezone: r.timezone,
    restoredAt: m.restoredAt?.toISOString() ?? null,
    deactivatedBy,
    reports: reportsRows.map((x) => refs.get(x.id)).filter((x): x is MemberRef => !!x),
    responsibilityAssignments: duties.map((d) => ({
      id: d.id,
      duty: d.duty,
      scopeType: d.scopeType,
      scopeId: d.scopeId,
      scopeLabel: label(d.scopeType, d.scopeId),
      validFrom: d.validFrom.toISOString(),
      validTo: d.validTo?.toISOString() ?? null,
      rowVersion: d.rowVersion,
    })),
    isSelf,
    permissions: {
      update: canUpdate && m.status !== 'deactivated',
      suspend: canSuspend && !isSelf && !row.isOwner && m.status !== 'deactivated',
      deactivate: canSuspend && !isSelf && !row.isOwner && m.status !== 'deactivated',
      restore: canSuspend && m.status === 'deactivated',
      manageAccess: canManageAccess && !isSelf && m.status === 'active',
      viewAccess: canReadAccess || isSelf,
      revokeSessions: canRevokeSessions && !isSelf && m.status !== 'deactivated',
      transferWork: canUpdate && !isSelf && m.status !== 'deactivated',
      assignProject: hasAnywhere(ctx.actor.access, 'project.members.manage') && m.status === 'active',
      viewActivity: canReadAccess || canAudit || isSelf,
    },
  };
};

/** Keep the member in global search (members.read holders only; deactivated members are archived). */
export const indexMember = async (ctx: CommandContext, membershipId: string) => {
  const r = await loadBase(ctx, membershipId);
  await indexSearchDocument(ctx.tx, {
    workspaceId: ctx.actor.workspaceId,
    entityType: 'member',
    entityId: r.id,
    title: r.status === 'deactivated' ? r.displayNameSnapshot : r.name,
    body: [r.title, r.anonymizedAt ? null : r.email, r.skills.join(' ')].filter(Boolean).join('\n'),
    permission: 'members.read',
    ownerMembershipId: r.id,
    archived: r.status === 'deactivated',
    status: r.status,
    at: ctx.app.clock.now(),
  });
};

export const updateMember = async (ctx: CommandContext, membershipId: string, input: { title?: string | null; managerMembershipId?: string | null; skills?: string[] }) => {
  const m = await loadReadableMember(ctx, membershipId, { lock: true });
  await authorizeMemberAction(ctx, m, 'members.update');
  assertVersion(ctx, m);
  if (m.status === 'deactivated') throw new AppError('INVALID_STATE', 'Restore the member before changing their profile.');
  if (input.managerMembershipId !== undefined && input.managerMembershipId !== m.managerMembershipId && input.managerMembershipId) {
    if (!(await isActiveMember(ctx.tx, ctx.actor.workspaceId, input.managerMembershipId)))
      throw new AppError('VALIDATION_FAILED', 'The manager must be an active member.', {
        fieldErrors: [{ field: 'managerMembershipId', code: 'INACTIVE', message: 'The manager must be an active member.' }],
      });
    const chain = await ctx.tx
      .select({ id: memberships.id, manager: memberships.managerMembershipId })
      .from(memberships)
      .where(eq(memberships.workspaceId, ctx.actor.workspaceId));
    if (createsManagerCycle(new Map(chain.map((c) => [c.id, c.manager])), m.id, input.managerMembershipId))
      throw new AppError('VALIDATION_FAILED', 'This manager would create a reporting loop.', {
        fieldErrors: [{ field: 'managerMembershipId', code: 'CYCLE', message: 'This manager would create a reporting loop.' }],
      });
  }
  const patch: Partial<MembershipRow> = {};
  if (input.title !== undefined) patch.title = input.title?.trim() || null;
  if (input.managerMembershipId !== undefined) patch.managerMembershipId = input.managerMembershipId;
  if (input.skills !== undefined) {
    // Case-insensitive de-duplication; the first spelling wins.
    const seen = new Map<string, string>();
    for (const s of input.skills) if (!seen.has(s.trim().toLowerCase())) seen.set(s.trim().toLowerCase(), s.trim());
    patch.skills = [...seen.values()];
  }
  const [row] = await ctx.tx.update(memberships).set({ ...patch, ...touch(ctx, memberships) }).where(eq(memberships.id, m.id)).returning();
  await audit(ctx, { action: 'member.updated', entityType: 'membership', entityId: m.id, diff: diffFields(m, row!, ['title', 'managerMembershipId', 'skills']) });
  await emit(ctx, { type: 'member.updated', entityType: 'membership', entityId: m.id, revision: row!.rowVersion });
  await indexMember(ctx, m.id);
  return m.id;
};

// ——— Assignments & activity ———

export const memberAssignments = async (ctx: QueryContext, membershipId: string) => {
  const m = await loadReadableMember(ctx, membershipId);
  const db = ctx.app.db;
  const ws = ctx.actor.workspaceId;
  const [pRows, aRows] = await all(ctx, [
    () =>
      db
        .select({ pm: projectMemberships, p: { id: projects.id, name: projects.name, status: projects.status, type: projects.type, directionId: projects.directionId, owner: projects.ownerMembershipId } })
        .from(projectMemberships)
        .innerJoin(projects, and(eq(projects.id, projectMemberships.projectId), eq(projects.workspaceId, projectMemberships.workspaceId)))
        .where(and(eq(projectMemberships.workspaceId, ws), eq(projectMemberships.membershipId, m.id), isNull(projects.deletedAt)))
        .orderBy(sql`${projectMemberships.validTo} IS NOT NULL`, desc(projectMemberships.validFrom)),
    () =>
      db
        .select({ aa: accountAssignments, a: { id: socialAccounts.id, handle: socialAccounts.handle, displayName: socialAccounts.displayName, platform: socialAccounts.platform, projectId: socialAccounts.projectId } })
        .from(accountAssignments)
        .innerJoin(socialAccounts, and(eq(socialAccounts.id, accountAssignments.accountId), eq(socialAccounts.workspaceId, accountAssignments.workspaceId)))
        .where(and(eq(accountAssignments.workspaceId, ws), eq(accountAssignments.membershipId, m.id), isNull(socialAccounts.deletedAt)))
        .orderBy(sql`${accountAssignments.validTo} IS NOT NULL`, desc(accountAssignments.validFrom)),
  ] as const);
  // Assignments outside the viewer's scope are omitted entirely (not even counted).
  const projectsOut = pRows.flatMap((r) => {
    const ok = allowed(ctx, 'projects.read', { objectType: 'project', objectId: r.p.id, projectId: r.p.id, directionId: r.p.directionId, ownerMembershipId: r.p.owner });
    if (!ok) return [];
    return [
      {
        id: r.pm.id,
        project: { id: r.p.id, name: r.p.name, status: r.p.status, type: r.p.type },
        responsibility: r.pm.responsibility,
        isOwner: r.p.owner === m.id && !r.pm.validTo,
        validFrom: r.pm.validFrom.toISOString(),
        validTo: r.pm.validTo?.toISOString() ?? null,
      },
    ];
  });
  const accountsOut = aRows.flatMap((r) => {
    if (!allowed(ctx, 'accounts.read', { accountId: r.a.id, projectId: r.a.projectId })) return [];
    return [
      {
        id: r.aa.id,
        account: { id: r.a.id, label: r.a.displayName ?? (r.a.handle ? `@${r.a.handle}` : r.a.platform), platform: r.a.platform, projectId: r.a.projectId },
        duty: r.aa.duty,
        validFrom: r.aa.validFrom.toISOString(),
        validTo: r.aa.validTo?.toISOString() ?? null,
      },
    ];
  });
  return { projects: projectsOut, accounts: accountsOut };
};

export const memberActivity = async (ctx: QueryContext, membershipId: string, input: { cursor?: string; pageSize?: number; kind: 'membership' | 'actions' }) => {
  const m = await loadReadableMember(ctx, membershipId);
  const isSelf = ctx.actor.membershipId === m.id;
  const auditAll = listFilter(ctx.actor.access, 'audit.read').kind === 'all';
  const size = clampPageSize(input.pageSize ?? 30);
  const c = input.cursor ? decodeCursor(input.cursor) : null;
  const cursorCond = c
    ? or(lt(auditEvents.occurredAt, new Date(String(c.v[0]))), and(eq(auditEvents.occurredAt, new Date(String(c.v[0]))), lt(auditEvents.id, c.id)))
    : undefined;
  let where: SQL | undefined;
  if (input.kind === 'membership') {
    if (!isSelf && !auditAll && !(await canActOnMember(ctx, m.id, 'access.read'))) throw new AppError('FORBIDDEN', 'You cannot view this member’s access history.');
    where = whereAll(eq(auditEvents.workspaceId, ctx.actor.workspaceId), eq(auditEvents.entityType, 'membership'), eq(auditEvents.entityId, m.id), cursorCond);
  } else {
    // Actions by the member: ordinary (non-sensitive) events inside the viewer's project scope only.
    const projectScope = scopePredicate(ctx, 'projects.read', { projectId: auditEvents.projectId });
    where = whereAll(
      eq(auditEvents.workspaceId, ctx.actor.workspaceId),
      eq(auditEvents.actorMembershipId, m.id),
      eq(auditEvents.sensitivity, 'normal'),
      auditAll ? undefined : whereAll(sql`${auditEvents.projectId} IS NOT NULL`, projectScope),
      cursorCond,
    );
  }
  const rows = await ctx.app.db
    .select()
    .from(auditEvents)
    .where(where)
    .orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id))
    .limit(size + 1);
  const hasMore = rows.length > size;
  const items = (hasMore ? rows.slice(0, size) : rows).map((r) => ({
    id: r.id,
    action: r.action,
    entityType: r.entityType,
    entityId: r.entityId,
    actorName: r.actorDisplay,
    occurredAt: r.occurredAt.toISOString(),
    reason: r.reason,
    changes: Object.entries(r.diff ?? {}).map(([field, v]) => ({ field, from: v.from, to: v.to })),
    href: r.entityType && r.entityId && ENTITY_ROUTES[r.entityType] ? entityHref(ctx.actor.workspaceId, r.entityType, r.entityId, { projectId: r.projectId }) : null,
  }));
  const last = items[items.length - 1];
  return { items, hasMore, nextCursor: hasMore && last ? encodeCursor({ v: [last.occurredAt], id: last.id }) : null };
};

// ——— Responsibilities (duties; never a source of permissions) ———

export const addResponsibility = async (
  ctx: CommandContext,
  membershipId: string,
  input: { duty: string; scopeType: 'workspace' | 'direction' | 'project' | 'account'; scopeId: string | null; validFrom?: string; validTo?: string | null },
) => {
  const m = await loadReadableMember(ctx, membershipId, { lock: true });
  await authorizeMemberAction(ctx, m, 'members.update');
  if (m.status !== 'active') throw new AppError('INVALID_STATE', 'Only active members can take on duties.');
  await assertScopeObject(ctx.tx, ctx.actor.workspaceId, input.scopeType, input.scopeType === 'workspace' ? null : input.scopeId);
  const at = ctx.app.clock.now();
  const validFrom = input.validFrom ? new Date(input.validFrom) : at;
  const validTo = input.validTo ? new Date(input.validTo) : null;
  if (validTo && validTo <= validFrom)
    throw new AppError('VALIDATION_FAILED', 'The end must be after the start.', { fieldErrors: [{ field: 'validTo', code: 'BEFORE_START', message: 'The end must be after the start.' }] });
  const scopeId = input.scopeType === 'workspace' ? null : input.scopeId;
  const [dup] = await ctx.tx
    .select({ id: responsibilityAssignments.id })
    .from(responsibilityAssignments)
    .where(
      and(
        eq(responsibilityAssignments.workspaceId, ctx.actor.workspaceId),
        eq(responsibilityAssignments.membershipId, m.id),
        eq(responsibilityAssignments.duty, input.duty as never),
        eq(responsibilityAssignments.scopeType, input.scopeType),
        scopeId ? eq(responsibilityAssignments.scopeId, scopeId) : isNull(responsibilityAssignments.scopeId),
        or(isNull(responsibilityAssignments.validTo), gt(responsibilityAssignments.validTo, at)),
      ),
    );
  if (dup) throw new AppError('DUPLICATE', 'The member already has this duty in this scope.');
  const id = newId();
  const [row] = await ctx.tx
    .insert(responsibilityAssignments)
    .values({ ...stamp(ctx), id, membershipId: m.id, duty: input.duty as never, scopeType: input.scopeType, scopeId, validFrom, validTo })
    .returning();
  const label = await scopeLabeler(ctx, [row!]);
  await audit(ctx, { action: 'member.duty_added', entityType: 'membership', entityId: m.id, metadata: { responsibilityId: id, duty: input.duty, scopeType: input.scopeType, scopeId } });
  await emit(ctx, { type: 'member.updated', entityType: 'membership', entityId: m.id });
  return {
    id,
    duty: row!.duty,
    scopeType: row!.scopeType,
    scopeId: row!.scopeId,
    scopeLabel: label(row!.scopeType, row!.scopeId),
    validFrom: row!.validFrom.toISOString(),
    validTo: row!.validTo?.toISOString() ?? null,
    rowVersion: row!.rowVersion,
  };
};

export const endResponsibility = async (ctx: CommandContext, responsibilityId: string, reason?: string) => {
  const r = await lockById(ctx, responsibilityAssignments, responsibilityId, 'Duty');
  const m = await loadReadableMember(ctx, r.membershipId);
  await authorizeMemberAction(ctx, m, 'members.update');
  assertVersion(ctx, r);
  const at = ctx.app.clock.now();
  if (r.validTo && r.validTo <= at) throw new AppError('INVALID_STATE', 'This duty has already ended.');
  await ctx.tx.update(responsibilityAssignments).set({ validTo: at, ...touch(ctx, responsibilityAssignments) }).where(eq(responsibilityAssignments.id, r.id));
  await audit(ctx, { action: 'member.duty_ended', entityType: 'membership', entityId: m.id, reason, metadata: { responsibilityId: r.id, duty: r.duty } });
  await emit(ctx, { type: 'member.updated', entityType: 'membership', entityId: m.id });
  return { ok: true as const };
};

export const bulkAssignDirection = async (ctx: CommandContext, input: { membershipIds: string[]; directionId: string; duty: string }) => {
  requirePermission(ctx, 'members.update');
  const [d] = await ctx.tx
    .select()
    .from(directions)
    .where(and(eq(directions.workspaceId, ctx.actor.workspaceId), eq(directions.id, input.directionId)));
  if (!d || d.status !== 'active' || !allowed(ctx, 'directions.read', { directionId: d.id }))
    throw new AppError('VALIDATION_FAILED', 'Choose an active direction.', { fieldErrors: [{ field: 'directionId', code: 'INVALID', message: 'Choose an active direction.' }] });
  const at = ctx.app.clock.now();
  const v = memberVisibility(ctx.actor.access, 'members.update');
  const results: { membershipId: string; outcome: 'assigned' | 'already_assigned' | 'not_active' | 'not_found' }[] = [];
  for (const id of [...new Set(input.membershipIds)]) {
    const [m] = await ctx.tx
      .select()
      .from(memberships)
      .where(and(eq(memberships.workspaceId, ctx.actor.workspaceId), eq(memberships.id, id), memberVisibilitySql(v)))
      .for('update');
    if (!m) {
      results.push({ membershipId: id, outcome: 'not_found' });
      continue;
    }
    if (m.status !== 'active') {
      results.push({ membershipId: id, outcome: 'not_active' });
      continue;
    }
    const [dup] = await ctx.tx
      .select({ id: responsibilityAssignments.id })
      .from(responsibilityAssignments)
      .where(
        and(
          eq(responsibilityAssignments.membershipId, m.id),
          eq(responsibilityAssignments.duty, input.duty as never),
          eq(responsibilityAssignments.scopeType, 'direction'),
          eq(responsibilityAssignments.scopeId, d.id),
          or(isNull(responsibilityAssignments.validTo), gt(responsibilityAssignments.validTo, at)),
        ),
      );
    if (dup) {
      results.push({ membershipId: id, outcome: 'already_assigned' });
      continue;
    }
    const rid = newId();
    await ctx.tx.insert(responsibilityAssignments).values({ ...stamp(ctx), id: rid, membershipId: m.id, duty: input.duty as never, scopeType: 'direction', scopeId: d.id, validFrom: at });
    await audit(ctx, { action: 'member.duty_added', entityType: 'membership', entityId: m.id, metadata: { responsibilityId: rid, duty: input.duty, scopeType: 'direction', scopeId: d.id, bulk: true } });
    await emit(ctx, { type: 'member.updated', entityType: 'membership', entityId: m.id });
    results.push({ membershipId: id, outcome: 'assigned' });
  }
  return { results };
};

