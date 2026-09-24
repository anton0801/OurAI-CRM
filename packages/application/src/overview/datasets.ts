import { and, asc, count, eq, inArray, isNull, lt, lte, max, ne, sql } from 'drizzle-orm';
import { directions, projectMilestones, projects, publications, reviews, tasks } from '@castlane/database';
import { scopePredicate } from '../core/access';
import { defineExportDataset } from '../core/export-registry';
import { loadMemberRefs } from '../core/members';

const OPEN = ['draft', 'backlog', 'ready', 'in_progress', 'in_review'] as const;

/**
 * Export View of the Overview (S08 → S54): the projects table with its operational counts, for the
 * same direction/project filters, limited to the requester's scope as of the export boundary.
 */
defineExportDataset({
  key: 'overview_projects',
  label: 'Overview — Projects',
  permission: 'projects.read',
  classification: 'normal',
  columns: [
    { key: 'project_id', label: 'Project ID', type: 'id', default: true },
    { key: 'project', label: 'Project', type: 'text', default: true },
    { key: 'type', label: 'Type', type: 'text', default: true },
    { key: 'status', label: 'Status', type: 'text', default: true },
    { key: 'direction', label: 'Direction', type: 'text', default: true },
    { key: 'owner', label: 'Owner', type: 'text', default: true },
    { key: 'open_tasks', label: 'Open Tasks', type: 'integer', default: true },
    { key: 'overdue_tasks', label: 'Overdue Tasks', type: 'integer', default: true },
    { key: 'pending_reviews', label: 'Pending Reviews', type: 'integer', default: true },
    { key: 'next_milestone', label: 'Next Milestone', type: 'text', default: true },
    { key: 'next_milestone_due', label: 'Next Milestone Due', type: 'date', default: true },
    { key: 'last_publication_at', label: 'Last Publication At', type: 'datetime', default: true },
  ],
  filters: [
    { key: 'directionId', label: 'Direction', type: 'reference', lookup: 'direction' },
    { key: 'projectId', label: 'Project', type: 'reference', lookup: 'project' },
  ],
  async *rows(ctx, input) {
    const f = input.filters as { directionId?: string; projectId?: string };
    const db = ctx.app.db;
    const ws = ctx.actor.workspaceId;
    const now = input.boundAt;
    let after: string | null = null;
    for (;;) {
      const page = await db
        .select({ p: projects, directionName: directions.name })
        .from(projects)
        .innerJoin(directions, eq(directions.id, projects.directionId))
        .where(
          and(
            eq(projects.workspaceId, ws),
            isNull(projects.deletedAt),
            ne(projects.status, 'archived'),
            lte(projects.createdAt, input.boundAt),
            scopePredicate(ctx, 'projects.read', { projectId: projects.id, ownerMembership: projects.ownerMembershipId }),
            typeof f.projectId === 'string' ? eq(projects.id, f.projectId) : undefined,
            typeof f.directionId === 'string' ? eq(projects.directionId, f.directionId) : undefined,
            after ? sql`${projects.id} > ${after}::uuid` : undefined,
          ),
        )
        .orderBy(asc(projects.id))
        .limit(200);
      if (!page.length) return;
      const ids = page.map((r) => r.p.id);
      const [open, overdue, pending, milestones, lastPub, refs] = [
        await db.select({ id: tasks.projectId, n: count() }).from(tasks).where(and(eq(tasks.workspaceId, ws), inArray(tasks.projectId, ids), inArray(tasks.status, [...OPEN]), isNull(tasks.deletedAt))).groupBy(tasks.projectId),
        await db.select({ id: tasks.projectId, n: count() }).from(tasks).where(and(eq(tasks.workspaceId, ws), inArray(tasks.projectId, ids), inArray(tasks.status, [...OPEN]), isNull(tasks.deletedAt), lt(tasks.dueAt, now))).groupBy(tasks.projectId),
        await db.select({ id: reviews.projectId, n: count() }).from(reviews).where(and(eq(reviews.workspaceId, ws), inArray(reviews.projectId, ids), eq(reviews.status, 'pending'))).groupBy(reviews.projectId),
        await db
          .selectDistinctOn([projectMilestones.projectId], { id: projectMilestones.projectId, title: projectMilestones.title, dueDate: projectMilestones.dueDate })
          .from(projectMilestones)
          .where(and(eq(projectMilestones.workspaceId, ws), inArray(projectMilestones.projectId, ids), isNull(projectMilestones.completedAt), isNull(projectMilestones.archivedAt)))
          .orderBy(projectMilestones.projectId, sql`${projectMilestones.dueDate} ASC NULLS LAST`),
        await db.select({ id: publications.projectId, last: max(publications.actualPublishedAt) }).from(publications).where(and(eq(publications.workspaceId, ws), inArray(publications.projectId, ids), eq(publications.status, 'published'))).groupBy(publications.projectId),
        await loadMemberRefs(db, ws, page.map((r) => r.p.ownerMembershipId)),
      ];
      for (const { p, directionName } of page) {
        const m = milestones.find((x) => x.id === p.id);
        const last = lastPub.find((x) => x.id === p.id)?.last;
        yield {
          project_id: p.id,
          project: p.name,
          type: p.type,
          status: p.status,
          direction: directionName,
          owner: refs.get(p.ownerMembershipId)?.displayName ?? null,
          open_tasks: Number(open.find((x) => x.id === p.id)?.n ?? 0),
          overdue_tasks: Number(overdue.find((x) => x.id === p.id)?.n ?? 0),
          pending_reviews: Number(pending.find((x) => x.id === p.id)?.n ?? 0),
          next_milestone: m?.title ?? null,
          next_milestone_due: m?.dueDate ?? null,
          last_publication_at: last ? new Date(last).toISOString() : null,
        };
      }
      after = page[page.length - 1]!.p.id;
      if (page.length < 200) return;
    }
  },
});
