import { and, asc, eq, ilike, inArray, isNull, lte, sql } from 'drizzle-orm';
import { goals, memberships } from '@castlane/database';
import { AppError, GOAL_STATUSES } from '@castlane/domain';
import { requirePermission } from '../core/access';
import { loadAccessSnapshot } from '../core/access';
import { can } from '@castlane/authorization';
import { audit } from '../core/audit';
import { defineArchiveHandler, tableArchiveList } from '../core/archive-registry';
import { dbOf } from '../core/context';
import { emit } from '../core/events';
import { defineExportDataset } from '../core/export-registry';
import { defineLookup, likePattern } from '../core/lookup-registry';
import { notify } from '../core/notify';
import { defineResponsibilityProvider } from '../core/responsibility-registry';
import { findById, touch } from '../core/rows';
import { archiveGoal, assertGoalWritable, goalCampaignProjects, goalMetricDefinition, goalScopes, goalVisibilitySql, toGoalRows } from './goals';

defineLookup({
  type: 'goal',
  async search(ctx, input) {
    requirePermission(ctx, 'goals.read');
    const rows = await dbOf(ctx)
      .select()
      .from(goals)
      .where(
        and(
          eq(goals.workspaceId, ctx.actor.workspaceId),
          goalVisibilitySql(ctx),
          input.ids?.length ? inArray(goals.id, input.ids) : undefined,
          !input.ids?.length && !input.includeArchived ? isNull(goals.archivedAt) : undefined,
          input.status?.length ? inArray(goals.status, input.status as never[]) : undefined,
          input.projectId ? and(eq(goals.scopeType, 'project'), eq(goals.scopeId, input.projectId)) : undefined,
          input.q ? ilike(goals.name, likePattern(input.q)) : undefined,
        ),
      )
      .orderBy(asc(goals.name))
      .limit(input.ids?.length ? Math.max(input.ids.length, input.limit) : input.limit);
    return rows.map((g) => ({
      id: g.id,
      label: g.name,
      sublabel: `${goalMetricDefinition(g.metricKey)?.label ?? g.metricKey} · ${g.periodStart} – ${g.periodEnd}`,
      status: g.status,
      projectId: g.scopeType === 'project' ? g.scopeId : null,
      archived: !!g.archivedAt,
    }));
  },
});

const scopesOf = async (ctx: Parameters<typeof dbOf>[0], g: typeof goals.$inferSelect) =>
  goalScopes(g, g.scopeType === 'campaign' && g.scopeId ? ((await goalCampaignProjects(dbOf(ctx), ctx.actor.workspaceId, [g.scopeId])).get(g.scopeId) ?? []) : []);

defineArchiveHandler({
  entityType: 'goal',
  label: 'Goal',
  async preview(ctx, id) {
    const g = await findById(ctx, goals, id, 'Goal');
    // The same check as the archive command (an owner still needs goals.write).
    assertGoalWritable(ctx, g, await scopesOf(ctx, g));
    return {
      title: g.name,
      rowVersion: g.rowVersion,
      items: g.status === 'active' ? [{ kind: 'active_goal', label: 'The goal is still active; archiving stops progress tracking (revisions and check-ins are kept)', count: 1, blocking: false }] : [],
    };
  },
  archive: async (ctx, id, input) => {
    await archiveGoal(ctx, id, { reason: input.reason }, { skipVersion: true });
  },
  restorePreview: async (ctx, id) => {
    const g = await findById(ctx, goals, id, 'Goal');
    assertGoalWritable(ctx, g, await scopesOf(ctx, g));
    return { title: g.name, items: [] };
  },
  restore: async (ctx, id) => {
    await archiveGoal(ctx, id, { restore: true }, { skipVersion: true });
  },
  list: (ctx, input) => tableArchiveList(ctx, input, { table: goals, title: goals.name, scope: goalVisibilitySql(ctx) }),
});

/** F12: active goals of a deactivated member need a successor who can read the goal scope. */
defineResponsibilityProvider({
  kind: 'goals.owner',
  label: 'Goal ownership',
  unassignedBehaviour: 'Every active goal needs an owner: choose a successor for each goal.',
  async list(ctx, membershipId) {
    const rows = await dbOf(ctx)
      .select()
      .from(goals)
      .where(and(eq(goals.workspaceId, ctx.actor.workspaceId), eq(goals.ownerMembershipId, membershipId), eq(goals.status, 'active'), isNull(goals.archivedAt)))
      .orderBy(asc(goals.name));
    return rows.map((g) => ({ kind: 'goals.owner', entityType: 'goal', entityId: g.id, title: `Goal “${g.name}”`, projectId: g.scopeType === 'project' ? g.scopeId : null, dueAt: null, requiresSuccessor: true }));
  },
  async transfer(ctx, fromMembershipId, resolutions) {
    for (const r of resolutions) {
      const [g] = await ctx.tx.select().from(goals).where(and(eq(goals.workspaceId, ctx.actor.workspaceId), eq(goals.id, r.entityId))).for('update');
      if (!g || g.ownerMembershipId !== fromMembershipId) continue;
      if (!r.successorMembershipId) throw new AppError('INVALID_STATE', `Choose a new owner for the goal “${g.name}”.`);
      const [m] = await ctx.tx.select({ userId: memberships.userId, status: memberships.status }).from(memberships).where(and(eq(memberships.workspaceId, ctx.actor.workspaceId), eq(memberships.id, r.successorMembershipId)));
      if (!m || m.status !== 'active') throw new AppError('INVALID_STATE', 'The new goal owner must be an active member.');
      const access = await loadAccessSnapshot(ctx.app.db, ctx.actor.workspaceId, m.userId, ctx.app.clock.now());
      const scopes = await scopesOf(ctx, g);
      if (!access || !scopes.some((s) => can(access, 'goals.read', { ...s, ownerMembershipId: null, assignedMembershipIds: [] })))
        throw new AppError('INVALID_STATE', `The new owner cannot see the scope of the goal “${g.name}”.`);
      const [row] = await ctx.tx.update(goals).set({ ownerMembershipId: r.successorMembershipId, ...touch(ctx, goals) }).where(eq(goals.id, g.id)).returning();
      await audit(ctx, { action: 'goal.owner_changed', entityType: 'goal', entityId: g.id, diff: { ownerMembershipId: { from: fromMembershipId, to: r.successorMembershipId } }, metadata: { handover: true } });
      await emit(ctx, { type: 'goal.updated', entityType: 'goal', entityId: g.id, revision: row!.rowVersion });
      await notify(ctx.tx, {
        workspaceId: ctx.actor.workspaceId,
        recipientMembershipIds: [r.successorMembershipId],
        eventType: 'goal.owner_assigned',
        eventKey: `goal.owner_assigned:${g.id}:${r.successorMembershipId}:${row!.rowVersion}`,
        kind: 'assignment',
        title: `You own the goal “${g.name}”`,
        entityType: 'goal',
        entityId: g.id,
        actorMembershipId: ctx.actor.membershipId,
        at: ctx.app.clock.now(),
      });
    }
  },
});

/** Export Center: goals with their current value and progress, evaluated in the requester's scope. */
defineExportDataset({
  key: 'goals',
  label: 'Goals',
  permission: 'goals.read',
  classification: 'normal',
  columns: [
    { key: 'id', label: 'Goal ID', type: 'id', default: true },
    { key: 'name', label: 'Name', type: 'text', default: true },
    { key: 'owner', label: 'Owner', type: 'text', default: true },
    { key: 'scope', label: 'Scope', type: 'text', default: true },
    { key: 'metric', label: 'Metric', type: 'text', default: true },
    { key: 'target_type', label: 'Target Type', type: 'text', default: true },
    { key: 'target', label: 'Target', type: 'decimal', default: true },
    { key: 'unit', label: 'Unit', type: 'text', default: true },
    { key: 'baseline', label: 'Baseline', type: 'decimal', default: true },
    { key: 'period_start', label: 'Period Start', type: 'date', default: true },
    { key: 'period_end', label: 'Period End', type: 'date', default: true },
    { key: 'status', label: 'Status', type: 'text', default: true },
    { key: 'current_value', label: 'Current Value', type: 'decimal', default: true },
    { key: 'current_source', label: 'Current Value Source', type: 'text', default: true },
    { key: 'progress_percent', label: 'Progress %', type: 'decimal', default: true },
    { key: 'progress_status', label: 'Progress Status', type: 'text' },
    { key: 'completeness_percent', label: 'Source Completeness %', type: 'decimal' },
    { key: 'achieved_value', label: 'Achieved Value', type: 'decimal' },
    { key: 'closed_at', label: 'Closed At', type: 'datetime' },
    { key: 'revision', label: 'Revision', type: 'integer' },
  ],
  filters: [{ key: 'status', label: 'Status', type: 'enum', enumValues: GOAL_STATUSES }],
  async *rows(ctx, input) {
    const f = input.filters as { status?: string | string[] };
    const statuses = (Array.isArray(f.status) ? f.status : f.status ? [f.status] : []) as (typeof GOAL_STATUSES)[number][];
    let cursor: { createdAt: Date; id: string } | null = null;
    for (;;) {
      const page: (typeof goals.$inferSelect)[] = await ctx.app.db
        .select()
        .from(goals)
        .where(
          and(
            eq(goals.workspaceId, ctx.actor.workspaceId),
            goalVisibilitySql(ctx),
            lte(goals.createdAt, input.boundAt),
            statuses.length ? inArray(goals.status, statuses) : undefined,
            cursor ? sql`(${goals.createdAt}, ${goals.id}) > (${cursor.createdAt}, ${cursor.id}::uuid)` : undefined,
          ),
        )
        .orderBy(asc(goals.createdAt), asc(goals.id))
        .limit(200);
      if (!page.length) return;
      for (const { row } of await toGoalRows(ctx, page))
        yield {
          id: row.id,
          name: row.name,
          owner: row.owner.displayName,
          scope: row.scope.label,
          metric: row.metric.label,
          target_type: row.targetType,
          target: row.targetValue,
          unit: row.unit,
          baseline: row.baselineValue,
          period_start: row.periodStart,
          period_end: row.periodEnd,
          status: row.status,
          current_value: row.current.value.value,
          current_source: row.current.source === 'manual' ? 'Manually recorded' : row.current.source === 'metric' ? 'Metric' : 'Not Measured',
          progress_percent: row.progress.value,
          progress_status: row.progress.status,
          completeness_percent: row.completeness,
          achieved_value: row.achievedValue,
          closed_at: row.closedAt,
          revision: row.revisionNo,
        };
      const last = page[page.length - 1]!;
      cursor = { createdAt: last.createdAt, id: last.id };
      if (page.length < 200) return;
    }
  },
});
