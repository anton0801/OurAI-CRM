import { and, asc, eq, ilike, inArray, isNull, sql } from 'drizzle-orm';
import { directions, projects } from '@castlane/database';
import { requirePermission, scopePredicate, whereAll } from '../core/access';
import { dbOf } from '../core/context';
import { defineLookup, likePattern } from '../core/lookup-registry';

/** Reference implementation of a picker provider: same scope as the module list, resolved ids, archived hidden by default. */
defineLookup({
  type: 'project',
  async search(ctx, input) {
    requirePermission(ctx, 'projects.read');
    const rows = await dbOf(ctx)
      .select({ id: projects.id, name: projects.name, type: projects.type, status: projects.status, directionName: directions.name })
      .from(projects)
      .leftJoin(directions, and(eq(directions.workspaceId, projects.workspaceId), eq(directions.id, projects.directionId)))
      .where(
        whereAll(
          eq(projects.workspaceId, ctx.actor.workspaceId),
          isNull(projects.deletedAt),
          scopePredicate(ctx, 'projects.read', { projectId: projects.id, ownerMembership: projects.ownerMembershipId }),
          input.ids?.length ? inArray(projects.id, input.ids) : undefined,
          !input.ids?.length && !input.includeArchived ? sql`${projects.status} <> 'archived'` : undefined,
          input.status?.length ? inArray(projects.status, input.status as never[]) : undefined,
          input.directionId ? eq(projects.directionId, input.directionId) : undefined,
          input.q ? ilike(projects.name, likePattern(input.q)) : undefined,
        ),
      )
      .orderBy(asc(projects.name))
      .limit(input.ids?.length ? Math.max(input.ids.length, input.limit) : input.limit);
    return rows.map((r) => ({
      id: r.id,
      label: r.name,
      sublabel: [r.directionName, r.type].filter(Boolean).join(' · ') || null,
      status: r.status,
      projectId: r.id,
      archived: r.status === 'archived',
    }));
  },
});

defineLookup({
  type: 'direction',
  async search(ctx, input) {
    requirePermission(ctx, 'directions.read');
    const rows = await dbOf(ctx)
      .select()
      .from(directions)
      .where(
        whereAll(
          eq(directions.workspaceId, ctx.actor.workspaceId),
          input.ids?.length ? inArray(directions.id, input.ids) : undefined,
          !input.ids?.length && !input.includeArchived ? eq(directions.status, 'active') : undefined,
          input.q ? ilike(directions.name, likePattern(input.q)) : undefined,
        ),
      )
      .orderBy(asc(directions.sortOrder), asc(directions.name))
      .limit(input.limit);
    return rows.map((r) => ({ id: r.id, label: r.name, sublabel: null, status: r.status, projectId: null, archived: r.status !== 'active' }));
  },
});
