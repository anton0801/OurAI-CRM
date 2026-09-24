import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { can, type ObjectScope } from '@castlane/authorization';
import {
  articles,
  contentItems,
  deals,
  deliverables,
  memberships,
  operations,
  projects,
  publications,
  shifts,
  socialAccounts,
  taskDueRevisions,
  tasks,
  type DbOrTx,
} from '@castlane/database';
import { entityHref, type LinkedRef } from '@castlane/api-contracts';
import { AppError, notFound, type FieldError } from '@castlane/domain';
import { allowed, loadAccessSnapshot } from '../core/access';
import { dbOf, type CommandContext, type QueryContext } from '../core/context';
import { indexSearchDocument, removeSearchDocument } from '../core/search';

export type TaskRowDb = typeof tasks.$inferSelect;

/** Object scope of a task: project/account hierarchy, assignee and reviewer (assigned-object roles), creator (own records). */
export const taskScope = (t: Pick<TaskRowDb, 'id' | 'projectId' | 'accountId' | 'assigneeMembershipId' | 'reviewerMembershipId' | 'createdBy'>): ObjectScope => ({
  objectType: 'task',
  objectId: t.id,
  projectId: t.projectId,
  accountId: t.accountId,
  assignedMembershipIds: [t.assigneeMembershipId, t.reviewerMembershipId],
  createdByUserId: t.createdBy,
});

/** Columns for `scopePredicate(ctx, 'tasks.read', TASK_SCOPE_COLUMNS)`. */
export const TASK_SCOPE_COLUMNS = {
  projectId: tasks.projectId,
  accountId: tasks.accountId,
  assigned: [tasks.assigneeMembershipId, tasks.reviewerMembershipId],
  createdByUser: tasks.createdBy,
};

export const fieldFail = (field: string, code: string, message: string) =>
  new AppError('VALIDATION_FAILED', message, { fieldErrors: [{ field, code, message }] });

export const fieldsFail = (errors: FieldError[], message = 'Some fields need attention.') =>
  new AppError('VALIDATION_FAILED', message, { fieldErrors: errors });

/** Load a task inside the workspace (trashed tasks are not found). */
export const loadTask = async (ctx: QueryContext | CommandContext, id: string, opts: { includeTrashed?: boolean } = {}): Promise<TaskRowDb> => {
  const [t] = await dbOf(ctx)
    .select()
    .from(tasks)
    .where(and(eq(tasks.workspaceId, ctx.actor.workspaceId), eq(tasks.id, id)))
    .limit(1);
  if (!t || (t.deletedAt && !opts.includeTrashed)) throw notFound('Task');
  return t;
};

export const lockTask = async (ctx: CommandContext, id: string, opts: { includeTrashed?: boolean } = {}): Promise<TaskRowDb> => {
  const [t] = await ctx.tx
    .select()
    .from(tasks)
    .where(and(eq(tasks.workspaceId, ctx.actor.workspaceId), eq(tasks.id, id)))
    .for('update')
    .limit(1);
  if (!t || (t.deletedAt && !opts.includeTrashed)) throw notFound('Task');
  return t;
};

export const canReadTask = (ctx: QueryContext, t: TaskRowDb) => allowed(ctx, 'tasks.read', taskScope(t));

/** Would this member be able to read the task (e.g. as a new assignee or a mentioned colleague)? */
export const memberCan = async (
  db: DbOrTx,
  workspaceId: string,
  membershipId: string,
  permission: string | string[],
  scope: ObjectScope,
  at: Date,
): Promise<{ ok: boolean; active: boolean; name: string | null }> => {
  const [m] = await db
    .select({ userId: memberships.userId, status: memberships.status, name: memberships.displayNameSnapshot })
    .from(memberships)
    .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.id, membershipId)));
  if (!m) return { ok: false, active: false, name: null };
  if (m.status !== 'active') return { ok: false, active: false, name: m.name };
  const snap = await loadAccessSnapshot(db, workspaceId, m.userId, at);
  const perms = Array.isArray(permission) ? permission : [permission];
  return { ok: !!snap && perms.some((p) => can(snap, p, scope)), active: true, name: m.name };
};

export const projectNames = async (db: DbOrTx, workspaceId: string, ids: string[]) => {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map<string, { name: string; status: string; ownerMembershipId: string; directionId: string }>();
  const rows = await db
    .select({ id: projects.id, name: projects.name, status: projects.status, ownerMembershipId: projects.ownerMembershipId, directionId: projects.directionId })
    .from(projects)
    .where(and(eq(projects.workspaceId, workspaceId), inArray(projects.id, unique)));
  return new Map(rows.map((r) => [r.id, r]));
};

/** Current deadline revision of each task (0 when the deadline was never set). */
export const deadlineRevisions = async (db: DbOrTx, taskIds: string[]): Promise<Map<string, number>> => {
  if (taskIds.length === 0) return new Map();
  const rows = await db
    .select({ taskId: taskDueRevisions.taskId, rev: sql<number>`max(${taskDueRevisions.deadlineRevision})` })
    .from(taskDueRevisions)
    .where(inArray(taskDueRevisions.taskId, taskIds))
    .groupBy(taskDueRevisions.taskId);
  return new Map(rows.map((r) => [r.taskId, Number(r.rev)]));
};

export type LinkType = LinkedRef['type'];
export const LINK_COLUMNS: { type: LinkType; column: keyof TaskRowDb }[] = [
  { type: 'account', column: 'accountId' },
  { type: 'content_item', column: 'contentItemId' },
  { type: 'publication', column: 'publicationId' },
  { type: 'shift', column: 'shiftId' },
  { type: 'operation', column: 'operationId' },
  { type: 'deal', column: 'dealId' },
  { type: 'deliverable', column: 'deliverableId' },
  { type: 'article', column: 'articleId' },
];

export interface LinkedInfo {
  label: string;
  readable: boolean;
  projectId: string | null;
  accountId: string | null;
}

const shiftDate = (d: Date, tz: string) => new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeZone: tz }).format(d);

/**
 * Resolve linked records of other modules with the viewer's own read permission: the label is
 * shown only when the viewer may read the linked record (usage links of foreign scopes stay hidden).
 */
export const loadLinkedInfo = async (ctx: QueryContext | CommandContext, refs: { type: LinkType; id: string }[]): Promise<Map<string, LinkedInfo>> => {
  const db = dbOf(ctx);
  const ws = ctx.actor.workspaceId;
  const out = new Map<string, LinkedInfo>();
  const byType = new Map<LinkType, string[]>();
  for (const r of refs) byType.set(r.type, [...(byType.get(r.type) ?? []), r.id]);
  const key = (type: string, id: string) => `${type}:${id}`;
  for (const [type, idsRaw] of byType) {
    const ids = [...new Set(idsRaw)];
    if (type === 'account') {
      const rows = await db.select().from(socialAccounts).where(and(eq(socialAccounts.workspaceId, ws), inArray(socialAccounts.id, ids)));
      for (const r of rows)
        out.set(key(type, r.id), {
          label: r.handle ? `@${r.handle}` : (r.displayName ?? r.canonicalUrl),
          readable: allowed(ctx, 'accounts.read', { objectType: 'account', objectId: r.id, accountId: r.id, projectId: r.projectId, ownerMembershipId: r.ownerMembershipId }),
          projectId: r.projectId,
          accountId: r.id,
        });
    } else if (type === 'content_item') {
      const rows = await db
        .select({ id: contentItems.id, title: contentItems.title, projectId: contentItems.projectId, owner: contentItems.ownerMembershipId, reviewer: contentItems.reviewerMembershipId, createdBy: contentItems.createdBy })
        .from(contentItems)
        .where(and(eq(contentItems.workspaceId, ws), inArray(contentItems.id, ids)));
      for (const r of rows)
        out.set(key(type, r.id), {
          label: r.title,
          readable: allowed(ctx, 'content.read', { objectType: 'content_item', objectId: r.id, projectId: r.projectId, assignedMembershipIds: [r.owner, r.reviewer], ownerMembershipId: r.owner, createdByUserId: r.createdBy }),
          projectId: r.projectId,
          accountId: null,
        });
    } else if (type === 'publication') {
      const rows = await db
        .select({ id: publications.id, projectId: publications.projectId, accountId: publications.accountId, owner: publications.ownerMembershipId, status: publications.status, title: contentItems.title })
        .from(publications)
        .leftJoin(contentItems, and(eq(contentItems.workspaceId, publications.workspaceId), eq(contentItems.id, publications.contentItemId)))
        .where(and(eq(publications.workspaceId, ws), inArray(publications.id, ids)));
      for (const r of rows)
        out.set(key(type, r.id), {
          label: r.title ? `${r.title} (publication)` : 'Publication',
          readable: allowed(ctx, 'publications.read', { objectType: 'publication', objectId: r.id, projectId: r.projectId, accountId: r.accountId, ownerMembershipId: r.owner }),
          projectId: r.projectId,
          accountId: r.accountId,
        });
    } else if (type === 'shift') {
      const rows = await db
        .select({ id: shifts.id, projectId: shifts.projectId, accountId: shifts.primaryAccountId, member: shifts.membershipId, start: shifts.scheduledStart, tz: shifts.timezone })
        .from(shifts)
        .where(and(eq(shifts.workspaceId, ws), inArray(shifts.id, ids)));
      for (const r of rows) {
        const scope = { objectType: 'shift', objectId: r.id, projectId: r.projectId, accountId: r.accountId, assignedMembershipIds: [r.member], ownerMembershipId: r.member };
        out.set(key(type, r.id), {
          label: `Shift ${shiftDate(r.start, r.tz)}`,
          readable: allowed(ctx, 'shifts.read.scope', scope) || (r.member === ctx.actor.membershipId && allowed(ctx, 'shifts.read.own', scope)),
          projectId: r.projectId,
          accountId: r.accountId,
        });
      }
    } else if (type === 'operation') {
      const rows = await db
        .select({ id: operations.id, title: operations.title, projectId: operations.projectId, accountId: operations.accountId, owner: operations.ownerMembershipId })
        .from(operations)
        .where(and(eq(operations.workspaceId, ws), inArray(operations.id, ids)));
      for (const r of rows)
        out.set(key(type, r.id), {
          label: r.title,
          readable: allowed(ctx, 'operations.read', { objectType: 'operation', objectId: r.id, projectId: r.projectId, accountId: r.accountId, ownerMembershipId: r.owner, assignedMembershipIds: [r.owner] }),
          projectId: r.projectId,
          accountId: r.accountId,
        });
    } else if (type === 'deal') {
      const rows = await db.select({ id: deals.id, title: deals.title, owner: deals.ownerMembershipId }).from(deals).where(and(eq(deals.workspaceId, ws), inArray(deals.id, ids)));
      for (const r of rows)
        out.set(key(type, r.id), { label: r.title, readable: allowed(ctx, 'deals.read', { objectType: 'deal', objectId: r.id, ownerMembershipId: r.owner }), projectId: null, accountId: null });
    } else if (type === 'deliverable') {
      const rows = await db
        .select({ id: deliverables.id, title: deliverables.title, projectId: deliverables.projectId, accountId: deliverables.accountId, owner: deals.ownerMembershipId })
        .from(deliverables)
        .innerJoin(deals, and(eq(deals.workspaceId, deliverables.workspaceId), eq(deals.id, deliverables.dealId)))
        .where(and(eq(deliverables.workspaceId, ws), inArray(deliverables.id, ids)));
      for (const r of rows)
        out.set(key(type, r.id), {
          label: r.title,
          readable: allowed(ctx, 'deals.read', { objectType: 'deliverable', objectId: r.id, projectId: r.projectId, accountId: r.accountId, ownerMembershipId: r.owner }),
          projectId: r.projectId,
          accountId: r.accountId,
        });
    } else if (type === 'article') {
      const rows = await db
        .select({ id: articles.id, title: articles.title, scopeType: articles.scopeType, scopeId: articles.scopeId, owner: articles.ownerMembershipId })
        .from(articles)
        .where(and(eq(articles.workspaceId, ws), inArray(articles.id, ids), isNull(articles.archivedAt)));
      for (const r of rows)
        out.set(key(type, r.id), {
          label: r.title,
          readable: allowed(ctx, 'knowledge.read', {
            objectType: 'article',
            objectId: r.id,
            projectId: r.scopeType === 'project' ? r.scopeId : null,
            directionId: r.scopeType === 'direction' ? r.scopeId : null,
            ownerMembershipId: r.owner,
          }),
          projectId: r.scopeType === 'project' ? r.scopeId : null,
          accountId: null,
        });
    }
  }
  return out;
};

export const linkedRefsOf = (t: TaskRowDb, info: Map<string, LinkedInfo>, workspaceId: string): LinkedRef[] => {
  const out: LinkedRef[] = [];
  for (const l of LINK_COLUMNS) {
    const id = t[l.column] as string | null;
    if (!id) continue;
    const i = info.get(`${l.type}:${id}`);
    const readable = !!i?.readable;
    out.push({ type: l.type, id, label: readable ? (i?.label ?? null) : null, href: readable ? entityHref(workspaceId, l.type, id, { projectId: i?.projectId }) : null });
  }
  return out;
};

/** Search projection of a task (permission tasks.read; assignee/reviewer for assigned-object scopes). */
export const indexTask = async (ctx: CommandContext, t: TaskRowDb) => {
  if (t.deletedAt) {
    await removeSearchDocument(ctx.tx, t.workspaceId, 'task', t.id);
    return;
  }
  await indexSearchDocument(ctx.tx, {
    workspaceId: t.workspaceId,
    entityType: 'task',
    entityId: t.id,
    title: t.title,
    body: [t.description, t.tags.join(' ')].filter(Boolean).join('\n'),
    projectId: t.projectId,
    accountId: t.accountId,
    permission: 'tasks.read',
    assigneeMembershipIds: [t.assigneeMembershipId, t.reviewerMembershipId].filter((x): x is string => !!x),
    archived: !!t.archivedAt,
    status: t.status,
    at: ctx.app.clock.now(),
  });
};
