import { and, asc, count, desc, eq, gt, ilike, inArray, isNull, lt, max, min, or, sql, type SQL } from 'drizzle-orm';
import { can } from '@castlane/authorization';
import {
  auditEvents,
  budgetLines,
  budgetVersions,
  budgets,
  characters,
  contentItems,
  directions,
  financialEntries,
  metricObservations,
  ofmAssignments,
  ofmProfiles,
  projectDecisions,
  projectDirectionHistory,
  projectMemberships,
  projectMilestones,
  projects,
  publications,
  reviews,
  seasons,
  shifts,
  socialAccounts,
  tasks,
} from '@castlane/database';
import {
  AppError,
  assertTransition,
  clampPageSize,
  decodeCursor,
  encodeCursor,
  formatMinor,
  newId,
  type TransitionTable,
} from '@castlane/domain';
import type { ImpactItem } from '@castlane/api-contracts';
import { authorizeObject, authorizeRead, requirePermission, scopePredicate, whereAll, allowed } from '../core/access';
import { defineArchiveHandler } from '../core/archive-registry';
import { defineLinkAccess } from '../media/link-access';
import { audit, diffFields } from '../core/audit';
import { all, dbOf, type CommandContext, type QueryContext } from '../core/context';
import { emit } from '../core/events';
import { isActiveMember, loadMemberRefs, refOrUnknown } from '../core/members';
import { assertVersion, findById, lockById, stamp, touch } from '../core/rows';
import { indexSearchDocument } from '../core/search';
import { resolveTags } from '../core/tags';
import { assertCustomFieldsComplete } from '../platform/custom-fields';

type ProjectRow = typeof projects.$inferSelect;
type ProjectStatus = ProjectRow['status'];

export const PROJECT_TRANSITIONS: TransitionTable<ProjectStatus> = {
  draft: ['active', 'archived'],
  active: ['paused', 'completed'],
  paused: ['active', 'completed'],
  completed: ['archived', 'active'],
  archived: ['completed'],
};

const OPEN_TASK_STATUSES = ['draft', 'backlog', 'ready', 'in_progress', 'in_review'] as const;

/** Object scope of a project for authorization. */
export const projectScope = (p: Pick<ProjectRow, 'id' | 'directionId' | 'ownerMembershipId'>) => ({
  objectType: 'project',
  objectId: p.id,
  projectId: p.id,
  directionId: p.directionId,
  ownerMembershipId: p.ownerMembershipId,
});

// ——— Queries ———

const summaryExtras = async (ctx: QueryContext, rows: ProjectRow[]) => {
  const ids = rows.map((r) => r.id);
  const db = dbOf(ctx);
  const ws = ctx.actor.workspaceId;
  if (ids.length === 0) return { tasksBy: new Map(), pubBy: new Map(), metricsBy: new Map(), budgetBy: new Map(), dirs: new Map(), refs: new Map() };
  const [taskRows, pubRows, metricRows, dirRows, refs] = await all(ctx, [
    () =>
      db
        .select({ projectId: tasks.projectId, n: count() })
        .from(tasks)
        .where(and(eq(tasks.workspaceId, ws), inArray(tasks.projectId, ids), inArray(tasks.status, [...OPEN_TASK_STATUSES]), isNull(tasks.deletedAt)))
        .groupBy(tasks.projectId),
    () =>
      db
        .select({ projectId: publications.projectId, next: min(publications.scheduledAt) })
        .from(publications)
        .where(and(eq(publications.workspaceId, ws), inArray(publications.projectId, ids), eq(publications.status, 'scheduled'), gt(publications.scheduledAt, ctx.app.clock.now())))
        .groupBy(publications.projectId),
    () =>
      db
        .select({ projectId: metricObservations.projectId, last: max(metricObservations.observedAt) })
        .from(metricObservations)
        .where(and(eq(metricObservations.workspaceId, ws), inArray(metricObservations.projectId, ids), sql`${metricObservations.qualityState} NOT IN ('superseded', 'rejected')`))
        .groupBy(metricObservations.projectId),
    () => db.select({ id: directions.id, name: directions.name }).from(directions).where(eq(directions.workspaceId, ws)),
    () => loadMemberRefs(db, ws, rows.map((r) => r.ownerMembershipId)),
  ] as const);
  // Budget is returned only to members with budgets.read on that project; otherwise the field is absent.
  const budgetBy = new Map<string, { planned: { amount: string; currency: string }; periodStart: string; periodEnd: string }>();
  const budgetProjects = rows.filter((r) => can(ctx.actor.access, 'budgets.read', projectScope(r))).map((r) => r.id);
  if (budgetProjects.length) {
    const today = ctx.app.clock.now().toISOString().slice(0, 10);
    const b = await db
      .select({ projectId: budgets.scopeId, currency: budgets.currency, periodStart: budgets.periodStart, periodEnd: budgets.periodEnd, planned: sql<string>`coalesce(sum(${budgetLines.plannedMinor}), 0)::text` })
      .from(budgets)
      .innerJoin(budgetVersions, eq(budgetVersions.id, budgets.approvedVersionId))
      .leftJoin(budgetLines, eq(budgetLines.budgetVersionId, budgetVersions.id))
      .where(and(eq(budgets.workspaceId, ws), eq(budgets.scopeType, 'project'), inArray(budgets.scopeId, budgetProjects), sql`${budgets.periodStart} <= ${today} AND ${budgets.periodEnd} >= ${today}`))
      .groupBy(budgets.scopeId, budgets.currency, budgets.periodStart, budgets.periodEnd);
    for (const r of b)
      if (r.projectId) budgetBy.set(r.projectId, { planned: { amount: formatMinor(BigInt(r.planned), r.currency), currency: r.currency }, periodStart: r.periodStart, periodEnd: r.periodEnd });
  }
  return {
    tasksBy: new Map(taskRows.map((t) => [t.projectId, Number(t.n)])),
    pubBy: new Map(pubRows.map((p) => [p.projectId, p.next])),
    metricsBy: new Map(metricRows.map((m) => [m.projectId, m.last])),
    budgetBy,
    dirs: new Map(dirRows.map((d) => [d.id, d.name])),
    refs,
  };
};

const toSummary = (ctx: QueryContext, r: ProjectRow, x: Awaited<ReturnType<typeof summaryExtras>>) => {
  const withBudget = can(ctx.actor.access, 'budgets.read', projectScope(r));
  const next = x.pubBy.get(r.id) as Date | null | undefined;
  const metrics = x.metricsBy.get(r.id) as Date | null | undefined;
  return {
    id: r.id,
    name: r.name,
    type: r.type,
    status: r.status,
    direction: { id: r.directionId, name: (x.dirs.get(r.directionId) as string | undefined) ?? 'Unknown direction' },
    owner: refOrUnknown(x.refs, r.ownerMembershipId)!,
    tags: r.tags,
    ofmEnabled: r.ofmEnabled,
    coverUrl: r.coverAssetId ? `/api/v1/workspaces/${r.workspaceId}/assets/${r.coverAssetId}/thumbnail?size=128` : null,
    openTasks: (x.tasksBy.get(r.id) as number | undefined) ?? 0,
    nextPublicationAt: next ? next.toISOString() : null,
    metricsUpdatedAt: metrics ? metrics.toISOString() : null,
    ...(withBudget ? { budget: x.budgetBy.get(r.id) ?? null } : {}),
    archivedAt: r.archivedAt?.toISOString() ?? null,
    updatedAt: r.updatedAt.toISOString(),
    rowVersion: r.rowVersion,
  };
};

export interface ListProjectsInput {
  cursor?: string;
  pageSize?: number;
  q?: string;
  status?: ProjectStatus[];
  type?: ProjectRow['type'][];
  directionId?: string;
  ownerMembershipId?: string;
  tag?: string;
  includeArchived?: boolean;
  sort: 'name' | 'updatedAt' | 'status' | 'type';
  direction: 'asc' | 'desc';
}

const SORT_COLUMNS = { name: projects.name, updatedAt: projects.updatedAt, status: projects.status, type: projects.type } as const;

export const listProjects = async (ctx: QueryContext, input: ListProjectsInput) => {
  requirePermission(ctx, 'projects.read');
  const pageSize = clampPageSize(input.pageSize);
  const sortCol = SORT_COLUMNS[input.sort];
  const cmp = input.direction === 'asc' ? gt : lt;
  const cursor = input.cursor ? decodeCursor(input.cursor) : null;
  let cursorCond: SQL | undefined;
  if (cursor) {
    const v = input.sort === 'updatedAt' ? new Date(String(cursor.v[0])) : cursor.v[0];
    cursorCond = or(cmp(sortCol, v as never), and(eq(sortCol, v as never), cmp(projects.id, cursor.id)));
  }
  const where = whereAll(
    eq(projects.workspaceId, ctx.actor.workspaceId),
    isNull(projects.deletedAt),
    // Scope is part of the SQL: out-of-scope projects are never counted or paged.
    scopePredicate(ctx, 'projects.read', { projectId: projects.id, ownerMembership: projects.ownerMembershipId }),
    input.includeArchived ? undefined : sql`${projects.status} <> 'archived'`,
    input.status?.length ? inArray(projects.status, input.status) : undefined,
    input.type?.length ? inArray(projects.type, input.type) : undefined,
    input.directionId ? eq(projects.directionId, input.directionId) : undefined,
    input.ownerMembershipId ? eq(projects.ownerMembershipId, input.ownerMembershipId) : undefined,
    input.tag ? sql`${input.tag} = ANY(${projects.tags})` : undefined,
    input.q ? ilike(projects.name, `%${input.q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`) : undefined,
    cursorCond,
  );
  const rows = await dbOf(ctx)
    .select()
    .from(projects)
    .where(where)
    .orderBy(input.direction === 'asc' ? asc(sortCol) : desc(sortCol), input.direction === 'asc' ? asc(projects.id) : desc(projects.id))
    .limit(pageSize + 1);
  const hasMore = rows.length > pageSize;
  const pageRows = hasMore ? rows.slice(0, pageSize) : rows;
  const extras = await summaryExtras(ctx, pageRows);
  const last = pageRows[pageRows.length - 1];
  const lastValue = last ? (input.sort === 'updatedAt' ? last.updatedAt.toISOString() : (last[input.sort] as string)) : null;
  return {
    items: pageRows.map((r) => toSummary(ctx, r, extras)),
    hasMore,
    nextCursor: hasMore && last ? encodeCursor({ v: [lastValue], id: last.id }) : null,
  };
};

const typeLockReason = async (ctx: QueryContext, p: ProjectRow): Promise<string | null> => {
  const db = dbOf(ctx);
  const [s] = await db.select({ n: count() }).from(seasons).where(and(eq(seasons.workspaceId, p.workspaceId), eq(seasons.projectId, p.id)));
  if (Number(s?.n ?? 0) > 0) return 'Seasons already exist for this project.';
  const [o] = await db.select({ n: count() }).from(ofmAssignments).where(and(eq(ofmAssignments.workspaceId, p.workspaceId), eq(ofmAssignments.projectId, p.id)));
  const [sh] = await db.select({ n: count() }).from(shifts).where(and(eq(shifts.workspaceId, p.workspaceId), eq(shifts.projectId, p.id)));
  if (Number(o?.n ?? 0) + Number(sh?.n ?? 0) > 0) return 'OFM assignments or shifts already exist for this project.';
  return null;
};

export const getProject = async (ctx: QueryContext, id: string) => {
  const p = await findById(ctx, projects, id, 'Project');
  if (p.deletedAt) throw new AppError('NOT_FOUND', 'Project was not found.');
  const scope = projectScope(p);
  authorizeRead(ctx, 'projects.read', scope);
  const db = dbOf(ctx);
  const ws = ctx.actor.workspaceId;
  const extras = await summaryExtras(ctx, [p]);
  const [team, milestones, decisions, accountsN, contentN, scheduledN, charactersN, lock] = await all(ctx, [
    () => db.select().from(projectMemberships).where(and(eq(projectMemberships.workspaceId, ws), eq(projectMemberships.projectId, id))).orderBy(desc(projectMemberships.validFrom)),
    () => db.select().from(projectMilestones).where(and(eq(projectMilestones.workspaceId, ws), eq(projectMilestones.projectId, id), isNull(projectMilestones.archivedAt))).orderBy(projectMilestones.dueDate),
    () => db.select().from(projectDecisions).where(and(eq(projectDecisions.workspaceId, ws), eq(projectDecisions.projectId, id), isNull(projectDecisions.archivedAt))).orderBy(desc(projectDecisions.decidedAt)).limit(20),
    () => db.select({ n: count() }).from(socialAccounts).where(and(eq(socialAccounts.workspaceId, ws), eq(socialAccounts.projectId, id), isNull(socialAccounts.archivedAt))),
    () => db.select({ n: count() }).from(contentItems).where(and(eq(contentItems.workspaceId, ws), eq(contentItems.projectId, id), isNull(contentItems.archivedAt), isNull(contentItems.deletedAt))),
    () => db.select({ n: count() }).from(publications).where(and(eq(publications.workspaceId, ws), eq(publications.projectId, id), eq(publications.status, 'scheduled'))),
    () => db.select({ n: count() }).from(characters).where(and(eq(characters.workspaceId, ws), eq(characters.projectId, id), isNull(characters.archivedAt))),
    () => typeLockReason(ctx, p),
  ] as const);
  const counts = [accountsN, contentN, scheduledN, charactersN];
  const refs = await loadMemberRefs(db, ws, team.map((t) => t.membershipId));
  return {
    ...toSummary(ctx, p, extras),
    briefSummary: p.briefSummary,
    description: p.description,
    language: p.language,
    targetMarkets: p.targetMarkets,
    audience: p.audience,
    startDate: p.startDate,
    coverAssetId: p.coverAssetId,
    statusReason: p.statusReason,
    completedAt: p.completedAt?.toISOString() ?? null,
    reviewPolicy: p.reviewPolicy,
    counts: {
      accounts: Number(counts[0]?.[0]?.n ?? 0),
      content: Number(counts[1]?.[0]?.n ?? 0),
      openTasks: (extras.tasksBy.get(p.id) as number | undefined) ?? 0,
      scheduledPublications: Number(counts[2]?.[0]?.n ?? 0),
      characters: Number(counts[3]?.[0]?.n ?? 0),
    },
    team: team.map((t) => ({
      id: t.id,
      member: refOrUnknown(refs, t.membershipId)!,
      responsibility: t.responsibility,
      note: t.note,
      validFrom: t.validFrom.toISOString(),
      validTo: t.validTo?.toISOString() ?? null,
    })),
    milestones: milestones.map((m) => ({ id: m.id, title: m.title, dueDate: m.dueDate, completedAt: m.completedAt?.toISOString() ?? null })),
    decisions: decisions.map((d) => ({ id: d.id, title: d.title, body: d.body, version: d.version, pinnedAt: d.pinnedAt?.toISOString() ?? null, decidedAt: d.decidedAt.toISOString() })),
    locked: { type: lock },
    permissions: {
      update: allowed(ctx, 'projects.update', scope) && p.status !== 'archived',
      archive: allowed(ctx, 'projects.archive', scope),
      manageTeam: allowed(ctx, 'project.members.manage', scope) && p.status !== 'archived',
      createContent: allowed(ctx, 'content.create', scope) && p.status !== 'archived',
      createAccount: allowed(ctx, 'accounts.write', scope) && p.status !== 'archived',
      createTask: allowed(ctx, 'tasks.create', scope) && p.status !== 'archived',
    },
  };
};

// ——— Commands ———

const indexProject = (ctx: CommandContext, p: ProjectRow) =>
  indexSearchDocument(ctx.tx, {
    workspaceId: ctx.actor.workspaceId,
    entityType: 'project',
    entityId: p.id,
    title: p.name,
    body: [p.briefSummary, p.description, p.audience, p.tags.join(' ')].filter(Boolean).join('\n'),
    projectId: p.id,
    directionId: p.directionId,
    permission: 'projects.read',
    ownerMembershipId: p.ownerMembershipId,
    archived: p.status === 'archived',
    status: p.status,
    thumbnailAssetId: p.coverAssetId,
    at: ctx.app.clock.now(),
  });

const assertDirection = async (ctx: CommandContext, directionId: string) => {
  const [d] = await ctx.tx
    .select({ id: directions.id, status: directions.status })
    .from(directions)
    .where(and(eq(directions.workspaceId, ctx.actor.workspaceId), eq(directions.id, directionId)));
  if (!d || d.status !== 'active')
    throw new AppError('VALIDATION_FAILED', 'Choose an active direction.', { fieldErrors: [{ field: 'directionId', code: 'INVALID', message: 'Choose an active direction.' }] });
};

const assertOwner = async (ctx: CommandContext, membershipId: string) => {
  if (!(await isActiveMember(ctx.tx, ctx.actor.workspaceId, membershipId)))
    throw new AppError('VALIDATION_FAILED', 'The owner must be an active member.', {
      fieldErrors: [{ field: 'ownerMembershipId', code: 'INACTIVE', message: 'The owner must be an active member.' }],
    });
};

/** Keep the primary owner on the project team so assignment-scoped roles apply to them. */
const ensureTeamMember = async (ctx: CommandContext, projectId: string, membershipId: string, responsibility: 'producing' | 'direction_management' | null = null) => {
  const [existing] = await ctx.tx
    .select({ id: projectMemberships.id })
    .from(projectMemberships)
    .where(and(eq(projectMemberships.projectId, projectId), eq(projectMemberships.membershipId, membershipId), isNull(projectMemberships.validTo)));
  if (existing) return;
  await ctx.tx.insert(projectMemberships).values({ ...stamp(ctx), id: newId(), projectId, membershipId, responsibility, validFrom: ctx.app.clock.now() });
};

const ensureOfmProfile = async (ctx: CommandContext, p: ProjectRow) => {
  if (!p.ofmEnabled) return;
  await ctx.tx
    .insert(ofmProfiles)
    .values({ ...stamp(ctx), id: newId(), projectId: p.id })
    .onConflictDoUpdate({ target: ofmProfiles.projectId, set: { disabledAt: null, updatedAt: ctx.app.clock.now() } });
};

export interface ProjectInput {
  name?: string;
  type?: ProjectRow['type'];
  directionId?: string;
  ownerMembershipId?: string;
  briefSummary?: string | null;
  description?: string | null;
  language?: string | null;
  targetMarkets?: string[];
  audience?: string | null;
  tags?: string[];
  startDate?: string | null;
  coverAssetId?: string | null;
  ofmEnabled?: boolean;
  reviewPolicy?: ProjectRow['reviewPolicy'];
}

export const createProject = async (ctx: CommandContext, input: ProjectInput & { name: string; type: ProjectRow['type']; directionId: string; ownerMembershipId: string; activate?: boolean }) => {
  requirePermission(ctx, 'projects.create');
  // Direction-scoped creators may only create inside their directions.
  if (!allowed(ctx, 'projects.create', { directionId: input.directionId })) throw new AppError('FORBIDDEN', 'You cannot create projects in this direction.');
  await assertDirection(ctx, input.directionId);
  await assertOwner(ctx, input.ownerMembershipId);
  if (input.ofmEnabled && input.type === 'series') throw new AppError('VALIDATION_FAILED', 'OFM is available for Model and Influencer projects only.');
  const id = newId();
  const values = {
    ...stamp(ctx),
    id,
    type: input.type,
    directionId: input.directionId,
    name: input.name.trim(),
    ownerMembershipId: input.ownerMembershipId,
    status: 'draft' as const,
    briefSummary: input.briefSummary ?? null,
    description: input.description ?? null,
    language: input.language ?? null,
    targetMarkets: input.targetMarkets ?? [],
    audience: input.audience ?? null,
    tags: await resolveTags(ctx, input.tags),
    startDate: input.startDate ?? null,
    coverAssetId: input.coverAssetId ?? null,
    ofmEnabled: !!input.ofmEnabled,
  };
  const [row] = await ctx.tx.insert(projects).values(values).returning();
  await ctx.tx.insert(projectDirectionHistory).values({ ...stamp(ctx), id: newId(), projectId: id, fromDirectionId: null, toDirectionId: input.directionId, effectiveAt: ctx.app.clock.now() });
  await ensureTeamMember(ctx, id, input.ownerMembershipId, null);
  if (ctx.actor.membershipId && ctx.actor.kind === 'user') await ensureTeamMember(ctx, id, ctx.actor.membershipId, null);
  await ensureOfmProfile(ctx, row!);
  await audit(ctx, { action: 'project.created', entityType: 'project', entityId: id, projectId: id, diff: diffFields(null, row!, ['name', 'type', 'directionId', 'ownerMembershipId', 'ofmEnabled']) });
  await emit(ctx, { type: 'project.created', entityType: 'project', entityId: id, revision: 1, payload: { type: row!.type } });
  await indexProject(ctx, row!);
  if (input.activate) await transitionProject(ctx, id, { targetState: 'active' }, { skipVersion: true });
  return id;
};

export const updateProject = async (ctx: CommandContext, id: string, input: ProjectInput) => {
  const p = await lockById(ctx, projects, id, 'Project');
  authorizeObject(ctx, 'projects.update', projectScope(p), 'projects.read');
  assertVersion(ctx, p);
  if (p.status === 'archived') throw new AppError('INVALID_STATE', 'Archived projects are read-only. Restore the project to change it.');
  if (input.type && input.type !== p.type) {
    const reason = await typeLockReason(ctx, p);
    if (reason) throw new AppError('INVALID_STATE', `The project type can no longer change: ${reason}`, { details: { reason } });
  }
  if (input.directionId && input.directionId !== p.directionId)
    throw new AppError('VALIDATION_FAILED', 'Use Transfer Direction to move a project between directions.');
  if (input.ownerMembershipId && input.ownerMembershipId !== p.ownerMembershipId) await assertOwner(ctx, input.ownerMembershipId);
  const type = input.type ?? p.type;
  const ofmEnabled = input.ofmEnabled ?? p.ofmEnabled;
  if (ofmEnabled && type === 'series') throw new AppError('VALIDATION_FAILED', 'OFM is available for Model and Influencer projects only.');
  if (p.status !== 'draft' && input.briefSummary !== undefined && !input.briefSummary?.trim())
    throw new AppError('VALIDATION_FAILED', 'An active project needs a brief summary.', { fieldErrors: [{ field: 'briefSummary', code: 'REQUIRED', message: 'An active project needs a brief summary.' }] });
  const patch: Partial<ProjectRow> = {};
  const keys: (keyof ProjectInput)[] = ['name', 'type', 'ownerMembershipId', 'briefSummary', 'description', 'language', 'targetMarkets', 'audience', 'startDate', 'coverAssetId', 'ofmEnabled', 'reviewPolicy'];
  for (const k of keys) if (input[k] !== undefined) (patch as Record<string, unknown>)[k] = typeof input[k] === 'string' && k === 'name' ? (input[k] as string).trim() : input[k];
  if (input.tags !== undefined) patch.tags = await resolveTags(ctx, input.tags);
  const [row] = await ctx.tx.update(projects).set({ ...patch, ...touch(ctx, projects) }).where(eq(projects.id, id)).returning();
  if (patch.ownerMembershipId) await ensureTeamMember(ctx, id, patch.ownerMembershipId);
  if (row!.ofmEnabled && !p.ofmEnabled) await ensureOfmProfile(ctx, row!);
  if (!row!.ofmEnabled && p.ofmEnabled) await ctx.tx.update(ofmProfiles).set({ disabledAt: ctx.app.clock.now() }).where(eq(ofmProfiles.projectId, id));
  await audit(ctx, {
    action: 'project.updated',
    entityType: 'project',
    entityId: id,
    projectId: id,
    diff: diffFields(p, row!, ['name', 'type', 'ownerMembershipId', 'briefSummary', 'description', 'language', 'targetMarkets', 'audience', 'tags', 'startDate', 'coverAssetId', 'ofmEnabled', 'reviewPolicy']),
  });
  await emit(ctx, { type: 'project.updated', entityType: 'project', entityId: id, revision: row!.rowVersion });
  await indexProject(ctx, row!);
  return id;
};

export const projectObligations = async (ctx: QueryContext | CommandContext, p: ProjectRow): Promise<ImpactItem[]> => {
  const db = 'tx' in ctx ? ctx.tx : ctx.app.db;
  const ws = p.workspaceId;
  const [openTasks, blockingTasks, activeShifts, scheduled, pendingReviews, financeDrafts] = await all(ctx, [
    () => db.select({ n: count() }).from(tasks).where(and(eq(tasks.workspaceId, ws), eq(tasks.projectId, p.id), inArray(tasks.status, [...OPEN_TASK_STATUSES]), isNull(tasks.deletedAt))),
    () => db.select({ n: count() }).from(tasks).where(and(eq(tasks.workspaceId, ws), eq(tasks.projectId, p.id), inArray(tasks.status, ['in_progress', 'in_review']), sql`${tasks.priority} IN ('high', 'urgent')`)),
    () => db.select({ n: count() }).from(shifts).where(and(eq(shifts.workspaceId, ws), eq(shifts.projectId, p.id), inArray(shifts.state, ['active', 'paused', 'scheduled']))),
    () => db.select({ n: count() }).from(publications).where(and(eq(publications.workspaceId, ws), eq(publications.projectId, p.id), eq(publications.status, 'scheduled'))),
    () => db.select({ n: count() }).from(reviews).where(and(eq(reviews.workspaceId, ws), eq(reviews.projectId, p.id), eq(reviews.status, 'pending'))),
    () => db
      .select({ n: count() })
      .from(financialEntries)
      .where(and(eq(financialEntries.workspaceId, ws), inArray(financialEntries.state, ['draft', 'submitted']), sql`EXISTS (SELECT 1 FROM financial_allocations fa WHERE fa.entry_id = ${financialEntries.id} AND fa.project_id = ${p.id})`)),
  ] as const);
  const n = (r: { n: number }[]) => Number(r[0]?.n ?? 0);
  return [
    { kind: 'open_tasks', label: 'Open tasks', count: n(openTasks), blocking: n(blockingTasks) > 0, resolution: 'Complete, cancel or move high-priority tasks in progress.' },
    { kind: 'active_shifts', label: 'Scheduled or active OFM shifts', count: n(activeShifts), blocking: n(activeShifts) > 0, resolution: 'End or cancel the shifts.' },
    { kind: 'scheduled_publications', label: 'Scheduled publications', count: n(scheduled), blocking: n(scheduled) > 0, resolution: 'Cancel or move the scheduled placements.' },
    { kind: 'pending_reviews', label: 'Pending reviews', count: n(pendingReviews), blocking: false },
    { kind: 'finance_drafts', label: 'Unposted financial drafts', count: n(financeDrafts), blocking: false, resolution: 'Finance can post or reject them later; history is kept.' },
  ].filter((i) => i.count > 0);
};

export const transitionProject = async (
  ctx: CommandContext,
  id: string,
  input: { targetState: ProjectStatus; reason?: string },
  opts: { skipVersion?: boolean } = {},
) => {
  const p = await lockById(ctx, projects, id, 'Project');
  const action = input.targetState === 'archived' ? 'projects.archive' : 'projects.update';
  authorizeObject(ctx, action, projectScope(p), 'projects.read');
  if (!opts.skipVersion) assertVersion(ctx, p);
  assertTransition(PROJECT_TRANSITIONS, p.status, input.targetState, 'project');
  if (input.targetState === 'active' && p.status === 'draft' && !p.briefSummary?.trim())
    throw new AppError('INVALID_STATE', 'Add a brief summary before activating the project.', { details: { missing: ['briefSummary'] } });
  if (p.status === 'completed' && input.targetState === 'active' && !input.reason)
    throw new AppError('VALIDATION_FAILED', 'Give a reason for reopening the project.', { fieldErrors: [{ field: 'reason', code: 'REQUIRED', message: 'Give a reason for reopening the project.' }] });
  // Custom fields required at the target stage must be filled first (section 21, Required At Stage).
  await assertCustomFieldsComplete(ctx, 'project', id, input.targetState, id);
  if (input.targetState === 'completed' || (input.targetState === 'archived' && p.status === 'draft')) {
    const blocking = (await projectObligations(ctx, p)).filter((i) => i.blocking);
    if (blocking.length) throw new AppError('INVALID_STATE', 'Resolve the open obligations first.', { details: { items: blocking } });
  }
  const at = ctx.app.clock.now();
  const patch: Partial<ProjectRow> = { status: input.targetState, statusReason: input.reason ?? null };
  if (input.targetState === 'completed') patch.completedAt = at;
  if (input.targetState === 'archived') Object.assign(patch, { archivedAt: at, archivedBy: ctx.actor.userId, archiveReason: input.reason ?? null });
  if (p.status === 'archived') Object.assign(patch, { archivedAt: null, archivedBy: null, archiveReason: null });
  const [row] = await ctx.tx.update(projects).set({ ...patch, ...touch(ctx, projects) }).where(eq(projects.id, id)).returning();
  await audit(ctx, { action: `project.${input.targetState === 'archived' ? 'archived' : 'status_changed'}`, entityType: 'project', entityId: id, projectId: id, reason: input.reason, diff: { status: { from: p.status, to: input.targetState } } });
  await emit(ctx, { type: 'project.status_changed', entityType: 'project', entityId: id, revision: row!.rowVersion, payload: { from: p.status, to: input.targetState } });
  await indexProject(ctx, row!);
  return id;
};

export const projectArchivePreview = async (ctx: QueryContext, id: string) => {
  const p = await findById(ctx, projects, id, 'Project');
  authorizeObject(ctx, 'projects.archive', projectScope(p), 'projects.read');
  return { title: p.name, rowVersion: p.rowVersion, items: await projectObligations(ctx, p) };
};

export const transferProjectDirection = async (ctx: CommandContext, id: string, input: { directionId: string; reason: string }) => {
  const p = await lockById(ctx, projects, id, 'Project');
  authorizeObject(ctx, 'projects.update', projectScope(p), 'projects.read');
  assertVersion(ctx, p);
  if (input.directionId === p.directionId) throw new AppError('VALIDATION_FAILED', 'The project already belongs to this direction.');
  // The actor must be allowed to manage projects in the target direction as well.
  if (!allowed(ctx, 'projects.update', { directionId: input.directionId, projectId: undefined }) && !ctx.actor.access.isOwner && !allowed(ctx, 'projects.create', { directionId: input.directionId }))
    throw new AppError('FORBIDDEN', 'You cannot move projects into that direction.');
  await assertDirection(ctx, input.directionId);
  const [row] = await ctx.tx.update(projects).set({ directionId: input.directionId, ...touch(ctx, projects) }).where(eq(projects.id, id)).returning();
  await ctx.tx.insert(projectDirectionHistory).values({ ...stamp(ctx), id: newId(), projectId: id, fromDirectionId: p.directionId, toDirectionId: input.directionId, effectiveAt: ctx.app.clock.now(), reason: input.reason });
  await audit(ctx, { action: 'project.direction_transferred', entityType: 'project', entityId: id, projectId: id, reason: input.reason, diff: { directionId: { from: p.directionId, to: input.directionId } } });
  await emit(ctx, { type: 'project.direction_transferred', entityType: 'project', entityId: id, revision: row!.rowVersion });
  await indexProject(ctx, row!);
  return id;
};

export const addProjectMember = async (ctx: CommandContext, projectId: string, input: { membershipId: string; responsibility?: string | null; note?: string | null }) => {
  const p = await lockById(ctx, projects, projectId, 'Project');
  authorizeObject(ctx, 'project.members.manage', projectScope(p), 'projects.read');
  if (p.status === 'archived') throw new AppError('INVALID_STATE', 'Archived projects are read-only.');
  if (!(await isActiveMember(ctx.tx, ctx.actor.workspaceId, input.membershipId))) throw new AppError('VALIDATION_FAILED', 'Choose an active member.');
  const [existing] = await ctx.tx
    .select()
    .from(projectMemberships)
    .where(and(eq(projectMemberships.projectId, projectId), eq(projectMemberships.membershipId, input.membershipId), isNull(projectMemberships.validTo)));
  if (existing) throw new AppError('DUPLICATE', 'This member is already on the project team.');
  const id = newId();
  const [row] = await ctx.tx
    .insert(projectMemberships)
    .values({ ...stamp(ctx), id, projectId, membershipId: input.membershipId, responsibility: (input.responsibility as never) ?? null, note: input.note ?? null, validFrom: ctx.app.clock.now() })
    .returning();
  await audit(ctx, { action: 'project.member_added', entityType: 'project', entityId: projectId, projectId, metadata: { membershipId: input.membershipId, responsibility: input.responsibility ?? null }, sensitivity: 'security' });
  await emit(ctx, { type: 'project.member_added', entityType: 'project', entityId: projectId });
  // Assignment changes the member's effective scope: bump their access revision.
  await ctx.tx.execute(sql`UPDATE memberships SET access_revision = access_revision + 1 WHERE id = ${input.membershipId}`);
  const refs = await loadMemberRefs(ctx.tx, ctx.actor.workspaceId, [input.membershipId]);
  return {
    id,
    member: refOrUnknown(refs, input.membershipId)!,
    responsibility: row!.responsibility,
    note: row!.note,
    validFrom: row!.validFrom.toISOString(),
    validTo: null,
  };
};

export const endProjectMember = async (ctx: CommandContext, projectId: string, projectMemberId: string, reason?: string) => {
  const p = await lockById(ctx, projects, projectId, 'Project');
  authorizeObject(ctx, 'project.members.manage', projectScope(p), 'projects.read');
  const [pm] = await ctx.tx
    .select()
    .from(projectMemberships)
    .where(and(eq(projectMemberships.workspaceId, ctx.actor.workspaceId), eq(projectMemberships.id, projectMemberId), eq(projectMemberships.projectId, projectId)))
    .for('update');
  if (!pm) throw new AppError('NOT_FOUND', 'Assignment was not found.');
  if (pm.validTo) throw new AppError('INVALID_STATE', 'This assignment has already ended.');
  if (pm.membershipId === p.ownerMembershipId) throw new AppError('INVALID_STATE', 'Choose a new project owner before removing the current owner from the team.');
  await ctx.tx.update(projectMemberships).set({ validTo: ctx.app.clock.now(), endedReason: reason ?? null, ...touch(ctx, projectMemberships) }).where(eq(projectMemberships.id, pm.id));
  await ctx.tx.execute(sql`UPDATE memberships SET access_revision = access_revision + 1 WHERE id = ${pm.membershipId}`);
  await audit(ctx, { action: 'project.member_ended', entityType: 'project', entityId: projectId, projectId, reason, metadata: { membershipId: pm.membershipId }, sensitivity: 'security' });
  await emit(ctx, { type: 'project.member_ended', entityType: 'project', entityId: projectId });
  return { ok: true as const };
};

export const addProjectMilestone = async (ctx: CommandContext, projectId: string, input: { title: string; dueDate?: string | null }) => {
  const p = await lockById(ctx, projects, projectId, 'Project');
  authorizeObject(ctx, 'projects.update', projectScope(p), 'projects.read');
  await ctx.tx.insert(projectMilestones).values({ ...stamp(ctx), id: newId(), projectId, title: input.title.trim(), dueDate: input.dueDate ?? null });
  await audit(ctx, { action: 'project.milestone_added', entityType: 'project', entityId: projectId, projectId, metadata: { title: input.title } });
  await emit(ctx, { type: 'project.updated', entityType: 'project', entityId: projectId });
  return { ok: true as const };
};

export const pinProjectDecision = async (ctx: CommandContext, projectId: string, input: { title: string; body: string }) => {
  const p = await lockById(ctx, projects, projectId, 'Project');
  authorizeObject(ctx, 'projects.update', projectScope(p), 'projects.read');
  const at = ctx.app.clock.now();
  await ctx.tx.insert(projectDecisions).values({ ...stamp(ctx), id: newId(), projectId, title: input.title.trim(), body: input.body.trim(), version: 1, pinnedAt: at, decidedAt: at });
  await audit(ctx, { action: 'project.decision_pinned', entityType: 'project', entityId: projectId, projectId, metadata: { title: input.title } });
  await emit(ctx, { type: 'project.updated', entityType: 'project', entityId: projectId });
  return { ok: true as const };
};

/** Human-meaningful history of a project; sensitive (finance/OFM/security) events are excluded. */
export const projectActivity = async (ctx: QueryContext, projectId: string, input: { cursor?: string; pageSize?: number }) => {
  const p = await findById(ctx, projects, projectId, 'Project');
  authorizeRead(ctx, 'projects.read', projectScope(p));
  const size = clampPageSize(input.pageSize ?? 30);
  const c = input.cursor ? decodeCursor(input.cursor) : null;
  const rows = await ctx.app.db
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.workspaceId, ctx.actor.workspaceId),
        eq(auditEvents.projectId, projectId),
        eq(auditEvents.sensitivity, 'normal'),
        c ? or(lt(auditEvents.occurredAt, new Date(String(c.v[0]))), and(eq(auditEvents.occurredAt, new Date(String(c.v[0]))), lt(auditEvents.id, c.id))) : undefined,
      ),
    )
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
  }));
  const last = items[items.length - 1];
  return { items, hasMore, nextCursor: hasMore && last ? encodeCursor({ v: [last.occurredAt], id: last.id }) : null };
};

defineArchiveHandler({
  entityType: 'project',
  label: 'Project',
  preview: projectArchivePreview,
  archive: async (ctx, id, input) => {
    const p = await lockById(ctx, projects, id, 'Project');
    // Archive always goes through Completed so the completion checks run.
    if (p.status === 'active' || p.status === 'paused') await transitionProject(ctx, id, { targetState: 'completed', reason: input.reason }, { skipVersion: true });
    await transitionProject(ctx, id, { targetState: 'archived', reason: input.reason }, { skipVersion: true });
  },
  restorePreview: async (ctx, id) => {
    const p = await findById(ctx, projects, id, 'Project');
    authorizeObject(ctx, 'projects.archive', projectScope(p), 'projects.read');
    return { title: p.name, items: [] };
  },
  restore: async (ctx, id) => {
    await transitionProject(ctx, id, { targetState: 'completed', reason: 'Restored from archive' }, { skipVersion: true });
  },
});

void min;

// Project covers and project-level attachments authorise through the project.
defineLinkAccess('project', {
  permission: 'projects.read',
  scope: async (ctx, id) => {
    const [p] = await dbOf(ctx).select().from(projects).where(and(eq(projects.workspaceId, ctx.actor.workspaceId), eq(projects.id, id)));
    return p ? { ...projectScope(p), label: p.name, href: `/w/${p.workspaceId}/projects/${p.id}` } : null;
  },
});
