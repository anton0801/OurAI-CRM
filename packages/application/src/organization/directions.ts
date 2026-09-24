import { and, count, eq, inArray, ne, sql } from 'drizzle-orm';
import { directions, projects, tasks } from '@castlane/database';
import { AppError, newId, normalizeKey } from '@castlane/domain';
import { requirePermission, scopePredicate, whereAll } from '../core/access';
import { audit, diffFields } from '../core/audit';
import { dbOf, type CommandContext, type QueryContext } from '../core/context';
import { emit } from '../core/events';
import { isActiveMember, loadMemberRefs, refOrUnknown } from '../core/members';
import { assertVersion, lockById, stamp, touch } from '../core/rows';
import { indexSearchDocument } from '../core/search';

type DirectionRowDb = typeof directions.$inferSelect;

const toRow = async (ctx: QueryContext, rows: DirectionRowDb[]) => {
  const ids = rows.map((r) => r.id);
  const refs = await loadMemberRefs(dbOf(ctx), ctx.actor.workspaceId, rows.map((r) => r.leadMembershipId));
  // Counts are computed only over projects the actor can see (scope before aggregation).
  const projectScope = scopePredicate(ctx, 'projects.read', { projectId: projects.id });
  const projectCounts = ids.length
    ? await dbOf(ctx)
        .select({ directionId: projects.directionId, n: count() })
        .from(projects)
        .where(whereAll(eq(projects.workspaceId, ctx.actor.workspaceId), inArray(projects.directionId, ids), inArray(projects.status, ['draft', 'active', 'paused']), projectScope))
        .groupBy(projects.directionId)
    : [];
  const taskScope = scopePredicate(ctx, 'tasks.read', { projectId: tasks.projectId, accountId: tasks.accountId, assigned: [tasks.assigneeMembershipId, tasks.reviewerMembershipId] });
  const taskCounts = ids.length
    ? await dbOf(ctx)
        .select({ directionId: projects.directionId, n: count() })
        .from(tasks)
        .innerJoin(projects, eq(projects.id, tasks.projectId))
        .where(whereAll(eq(tasks.workspaceId, ctx.actor.workspaceId), inArray(projects.directionId, ids), inArray(tasks.status, ['draft', 'backlog', 'ready', 'in_progress', 'in_review']), taskScope))
        .groupBy(projects.directionId)
    : [];
  const pc = new Map(projectCounts.map((c) => [c.directionId, Number(c.n)]));
  const tc = new Map(taskCounts.map((c) => [c.directionId, Number(c.n)]));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    status: r.status,
    lead: refOrUnknown(refs, r.leadMembershipId),
    activeProjects: pc.get(r.id) ?? 0,
    openTasks: tc.get(r.id) ?? 0,
    updatedAt: r.updatedAt.toISOString(),
    rowVersion: r.rowVersion,
  }));
};

export const listDirections = async (ctx: QueryContext, input: { includeArchived?: boolean }) => {
  requirePermission(ctx, 'directions.read');
  const rows = await dbOf(ctx)
    .select()
    .from(directions)
    .where(and(eq(directions.workspaceId, ctx.actor.workspaceId), input.includeArchived ? undefined : eq(directions.status, 'active')))
    .orderBy(directions.sortOrder, directions.name);
  return toRow(ctx, rows);
};

const assertUniqueName = async (ctx: CommandContext, name: string, exceptId?: string) => {
  const [dup] = await ctx.tx
    .select({ id: directions.id })
    .from(directions)
    .where(
      and(
        eq(directions.workspaceId, ctx.actor.workspaceId),
        eq(directions.nameKey, normalizeKey(name)),
        eq(directions.status, 'active'),
        exceptId ? ne(directions.id, exceptId) : undefined,
      ),
    );
  if (dup)
    throw new AppError('DUPLICATE', 'An active direction with this name already exists.', {
      fieldErrors: [{ field: 'name', code: 'DUPLICATE', message: 'An active direction with this name already exists.' }],
    });
};

const assertLead = async (ctx: CommandContext, leadId: string | null | undefined) => {
  if (leadId && !(await isActiveMember(ctx.tx, ctx.actor.workspaceId, leadId)))
    throw new AppError('VALIDATION_FAILED', 'The lead must be an active member.', {
      fieldErrors: [{ field: 'leadMembershipId', code: 'INACTIVE', message: 'The lead must be an active member.' }],
    });
};

const index = (ctx: CommandContext, d: DirectionRowDb) =>
  indexSearchDocument(ctx.tx, {
    workspaceId: ctx.actor.workspaceId,
    entityType: 'direction',
    entityId: d.id,
    title: d.name,
    body: d.description ?? '',
    permission: 'directions.read',
    directionId: d.id,
    archived: d.status === 'archived',
    at: ctx.app.clock.now(),
  });

export const createDirection = async (ctx: CommandContext, input: { name: string; description?: string | null; leadMembershipId?: string | null }) => {
  requirePermission(ctx, 'directions.manage');
  await assertUniqueName(ctx, input.name);
  await assertLead(ctx, input.leadMembershipId);
  const id = newId();
  const [row] = await ctx.tx
    .insert(directions)
    .values({ ...stamp(ctx), id, name: input.name.trim(), nameKey: normalizeKey(input.name), description: input.description ?? null, leadMembershipId: input.leadMembershipId ?? null })
    .returning();
  await audit(ctx, { action: 'direction.created', entityType: 'direction', entityId: id, diff: diffFields(null, row!, ['name', 'leadMembershipId']) });
  await emit(ctx, { type: 'direction.created', entityType: 'direction', entityId: id, revision: 1 });
  await index(ctx, row!);
  return (await toRow(ctx, [row!]))[0]!;
};

export const updateDirection = async (
  ctx: CommandContext,
  id: string,
  input: { name?: string; description?: string | null; leadMembershipId?: string | null },
) => {
  requirePermission(ctx, 'directions.manage');
  const d = await lockById(ctx, directions, id, 'Direction');
  assertVersion(ctx, d);
  if (input.name) await assertUniqueName(ctx, input.name, id);
  if (input.leadMembershipId !== undefined) await assertLead(ctx, input.leadMembershipId);
  const patch = {
    ...(input.name ? { name: input.name.trim(), nameKey: normalizeKey(input.name) } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.leadMembershipId !== undefined ? { leadMembershipId: input.leadMembershipId } : {}),
  };
  const [row] = await ctx.tx.update(directions).set({ ...patch, ...touch(ctx, directions) }).where(eq(directions.id, id)).returning();
  await audit(ctx, { action: 'direction.updated', entityType: 'direction', entityId: id, diff: diffFields(d, row!, ['name', 'description', 'leadMembershipId']) });
  await emit(ctx, { type: 'direction.updated', entityType: 'direction', entityId: id, revision: row!.rowVersion });
  await index(ctx, row!);
  return (await toRow(ctx, [row!]))[0]!;
};

export const archiveDirection = async (ctx: CommandContext, id: string, reason?: string) => {
  requirePermission(ctx, 'directions.manage');
  const d = await lockById(ctx, directions, id, 'Direction');
  assertVersion(ctx, d);
  if (d.status === 'archived') throw new AppError('INVALID_STATE', 'This direction is already archived.');
  const [active] = await ctx.tx
    .select({ n: count() })
    .from(projects)
    .where(and(eq(projects.workspaceId, ctx.actor.workspaceId), eq(projects.directionId, id), inArray(projects.status, ['draft', 'active', 'paused', 'completed'])));
  if (Number(active?.n ?? 0) > 0)
    throw new AppError('INVALID_STATE', 'Move or archive the projects of this direction before archiving it.', {
      details: { activeProjects: Number(active!.n) },
    });
  const at = ctx.app.clock.now();
  const [row] = await ctx.tx
    .update(directions)
    .set({ status: 'archived', archivedAt: at, archivedBy: ctx.actor.userId, archiveReason: reason ?? null, ...touch(ctx, directions) })
    .where(eq(directions.id, id))
    .returning();
  await audit(ctx, { action: 'direction.archived', entityType: 'direction', entityId: id, reason });
  await emit(ctx, { type: 'direction.archived', entityType: 'direction', entityId: id, revision: row!.rowVersion });
  await index(ctx, row!);
  return (await toRow(ctx, [row!]))[0]!;
};

void sql;
