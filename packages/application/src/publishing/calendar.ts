import { and, asc, eq, gte, inArray, isNotNull, isNull, lt, lte, ne, or, sql } from 'drizzle-orm';
import { hasAnywhere } from '@castlane/authorization';
import { projectMilestones, projects, publications, shifts, socialAccounts, tasks } from '@castlane/database';
import { AppError, forbidden } from '@castlane/domain';
import type { CalendarLayer } from '@castlane/api-contracts';
import { allowed, scopePredicate, whereAll } from '../core/access';
import { dbOf, type QueryContext } from '../core/context';
import { loadMemberRefs, refOrUnknown } from '../core/members';
import { accountLabel } from '../accounts/accounts';
import { taskFilterSql } from '../work/task-read';
import { CONFLICT_WINDOW_MINUTES, withinConflictWindow } from './logic';
import { publicationFilterSql, toPublicationRows } from './publications';
import { publicationScope } from './scope';

/**
 * Calendar (S31): publications, task deadlines, project milestones and shifts in one window. Each
 * layer is read from its own table with its own permission scope in SQL; layers the member cannot
 * see are omitted (never shown as empty). Nothing here moves or confirms a publication.
 */

const LAYER_LIMIT = 1500;
const MAX_RANGE_DAYS = 100;

export interface CalendarQuery {
  from: string;
  to: string;
  layers?: CalendarLayer[];
  projectId?: string;
  accountId?: string;
  platform?: string[];
  status?: (typeof publications.$inferSelect)['status'][];
  memberId?: string;
}

const OPEN_TASKS = ['draft', 'backlog', 'ready', 'in_progress', 'in_review'];

export const getCalendar = async (ctx: QueryContext, q: CalendarQuery) => {
  const from = new Date(q.from);
  const to = new Date(q.to);
  if (to.getTime() <= from.getTime()) throw new AppError('VALIDATION_FAILED', 'The end of the period must be after its start.', { fieldErrors: [{ field: 'to', code: 'BEFORE_START', message: 'The end of the period must be after its start.' }] });
  if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * 86_400_000)
    throw new AppError('VALIDATION_FAILED', `Choose a period of at most ${MAX_RANGE_DAYS} days.`, { fieldErrors: [{ field: 'to', code: 'RANGE_TOO_LONG', message: `Choose a period of at most ${MAX_RANGE_DAYS} days.` }] });
  const a = ctx.actor.access;
  const perms: Record<CalendarLayer, boolean> = {
    publications: hasAnywhere(a, 'publications.read'),
    tasks: hasAnywhere(a, 'tasks.read'),
    milestones: hasAnywhere(a, 'projects.read'),
    shifts: hasAnywhere(a, 'shifts.read.scope') || hasAnywhere(a, 'shifts.read.own'),
  };
  if (!Object.values(perms).some(Boolean)) throw forbidden();
  const wanted = new Set(q.layers?.length ? q.layers : (['publications', 'tasks', 'milestones', 'shifts'] as CalendarLayer[]));
  const on = (l: CalendarLayer) => perms[l] && wanted.has(l);
  const db = dbOf(ctx);
  const ws = ctx.actor.workspaceId;
  const now = ctx.app.clock.now();
  const href = (p: string) => `/w/${ws}${p}`;
  let truncated = false;
  const events: {
    key: string;
    type: 'publication' | 'task' | 'milestone' | 'shift';
    entityId: string;
    title: string;
    start: string | null;
    end: string | null;
    date: string | null;
    status: string;
    project: { id: string; name: string } | null;
    account: { id: string; label: string; platform: (typeof socialAccounts.$inferSelect)['platform'] } | null;
    member: ReturnType<typeof refOrUnknown>;
    conflict: boolean;
    awaitingConfirmation: boolean;
    overdue: boolean;
    canReschedule: boolean;
    canCorrect: boolean;
    rowVersion: number | null;
    timezone: string | null;
    href: string;
  }[] = [];

  let accountProjectId: string | null = null;
  if (q.accountId) {
    const [acc] = await db.select({ projectId: socialAccounts.projectId }).from(socialAccounts).where(and(eq(socialAccounts.workspaceId, ws), eq(socialAccounts.id, q.accountId)));
    accountProjectId = acc?.projectId ?? null;
  }

  // Publications: planned or actual time inside the window (drafts with a tentative time included).
  if (on('publications')) {
    const whenExpr = sql`coalesce(${publications.actualPublishedAt}, ${publications.scheduledAt})`;
    const rows = await db
      .select()
      .from(publications)
      .where(
        whereAll(
          publicationFilterSql(ctx, { projectId: q.projectId, accountId: q.accountId, status: q.status, platform: q.platform, ownerMembershipId: q.memberId }),
          or(isNotNull(publications.actualPublishedAt), isNotNull(publications.scheduledAt)),
          gte(whenExpr, from),
          lt(whenExpr, to),
        ),
      )
      .orderBy(asc(whenExpr), asc(publications.id))
      .limit(LAYER_LIMIT + 1);
    if (rows.length > LAYER_LIMIT) truncated = true;
    const page = rows.slice(0, LAYER_LIMIT);
    const views = new Map((await toPublicationRows(ctx, page)).map((v) => [v.id, v]));
    // Conflicts: two scheduled/published placements on one account closer than 15 minutes.
    const timed = page.filter((p) => p.status === 'scheduled' || p.status === 'published');
    const conflicted = new Set<string>();
    const byAccount = new Map<string, typeof timed>();
    for (const p of timed) byAccount.set(p.accountId, [...(byAccount.get(p.accountId) ?? []), p]);
    for (const list of byAccount.values())
      for (let i = 0; i < list.length; i++)
        for (let j = i + 1; j < list.length; j++) {
          const ai = (list[i]!.actualPublishedAt ?? list[i]!.scheduledAt)!;
          const aj = (list[j]!.actualPublishedAt ?? list[j]!.scheduledAt)!;
          if (Math.abs(aj.getTime() - ai.getTime()) >= CONFLICT_WINDOW_MINUTES * 60_000) break;
          if (withinConflictWindow(ai, aj)) {
            conflicted.add(list[i]!.id);
            conflicted.add(list[j]!.id);
          }
        }
    for (const p of page) {
      const v = views.get(p.id)!;
      const scope = publicationScope(p);
      const at = p.actualPublishedAt ?? p.scheduledAt!;
      events.push({
        key: `publication:${p.id}`,
        type: 'publication',
        entityId: p.id,
        title: v.title,
        start: at.toISOString(),
        end: null,
        date: null,
        status: p.status,
        project: v.project,
        account: { id: v.account.id, label: v.account.label, platform: v.account.platform },
        member: v.owner,
        conflict: conflicted.has(p.id),
        awaitingConfirmation: v.awaitingConfirmation,
        overdue: v.awaitingConfirmation,
        canReschedule: !p.archivedAt && ['draft', 'scheduled', 'failed'].includes(p.status) && allowed(ctx, 'publications.write', scope),
        canCorrect: !p.archivedAt && p.status === 'published' && allowed(ctx, 'publications.correct', scope),
        rowVersion: p.rowVersion,
        timezone: p.scheduleTimezone,
        href: href(`/publications/${p.id}`),
      });
    }
  }

  // Task deadlines (the tasks module's own scope; cancelled tasks are not shown).
  if (on('tasks')) {
    const rows = await db
      .select()
      .from(tasks)
      .where(
        whereAll(
          taskFilterSql(ctx, { includeClosed: true, projectId: q.projectId, accountId: q.accountId }),
          ne(tasks.status, 'cancelled'),
          q.memberId ? eq(tasks.assigneeMembershipId, q.memberId) : undefined,
          gte(tasks.dueAt, from),
          lt(tasks.dueAt, to),
        ),
      )
      .orderBy(asc(tasks.dueAt), asc(tasks.id))
      .limit(LAYER_LIMIT + 1);
    if (rows.length > LAYER_LIMIT) truncated = true;
    const page = rows.slice(0, LAYER_LIMIT);
    const [refs, names] = [
      await loadMemberRefs(db, ws, page.map((t) => t.assigneeMembershipId)),
      new Map((page.length ? await db.select({ id: projects.id, name: projects.name }).from(projects).where(and(eq(projects.workspaceId, ws), inArray(projects.id, [...new Set(page.map((t) => t.projectId))]))) : []).map((p) => [p.id, p.name])),
    ];
    for (const t of page)
      events.push({
        key: `task:${t.id}`,
        type: 'task',
        entityId: t.id,
        title: t.title,
        start: t.dueDate ? null : t.dueAt!.toISOString(),
        end: null,
        date: t.dueDate,
        status: t.status,
        project: { id: t.projectId, name: names.get(t.projectId) ?? 'Project' },
        account: null,
        member: refOrUnknown(refs, t.assigneeMembershipId),
        conflict: false,
        awaitingConfirmation: false,
        overdue: !!t.dueAt && t.dueAt.getTime() < now.getTime() && OPEN_TASKS.includes(t.status),
        canReschedule: false,
        canCorrect: false,
        rowVersion: t.rowVersion,
        timezone: t.dueTimezone,
        href: href(`/tasks/${t.id}`),
      });
  }

  // Project milestones are calendar days (never shifted by time zones). The window is widened by a day
  // on each side so the client can place days of any zone; it filters by its own local range.
  if (on('milestones') && !q.memberId && !(q.accountId && !accountProjectId)) {
    const fromDay = new Date(from.getTime() - 86_400_000).toISOString().slice(0, 10);
    const toDay = new Date(to.getTime() + 86_400_000).toISOString().slice(0, 10);
    const projectFilter = q.projectId ?? accountProjectId ?? undefined;
    const rows = await db
      .select({ m: projectMilestones, projectName: projects.name, directionId: projects.directionId, owner: projects.ownerMembershipId })
      .from(projectMilestones)
      .innerJoin(projects, and(eq(projects.workspaceId, projectMilestones.workspaceId), eq(projects.id, projectMilestones.projectId)))
      .where(
        whereAll(
          eq(projectMilestones.workspaceId, ws),
          isNull(projectMilestones.archivedAt),
          isNull(projects.deletedAt),
          scopePredicate(ctx, 'projects.read', { projectId: projectMilestones.projectId, ownerMembership: projects.ownerMembershipId }),
          projectFilter ? eq(projectMilestones.projectId, projectFilter) : undefined,
          gte(projectMilestones.dueDate, fromDay),
          lte(projectMilestones.dueDate, toDay),
        ),
      )
      .orderBy(asc(projectMilestones.dueDate), asc(projectMilestones.id))
      .limit(LAYER_LIMIT);
    for (const r of rows)
      events.push({
        key: `milestone:${r.m.id}`,
        type: 'milestone',
        entityId: r.m.id,
        title: r.m.title,
        start: null,
        end: null,
        date: r.m.dueDate,
        status: r.m.completedAt ? 'completed' : 'open',
        project: { id: r.m.projectId, name: r.projectName },
        account: null,
        member: null,
        conflict: false,
        awaitingConfirmation: false,
        overdue: !r.m.completedAt && !!r.m.dueDate && r.m.dueDate < now.toISOString().slice(0, 10),
        canReschedule: false,
        canCorrect: false,
        rowVersion: r.m.rowVersion,
        timezone: null,
        href: href(`/projects/${r.m.projectId}`),
      });
  }

  // Shifts (OFM): scope-level readers see their scope, others only their own shifts. Only time,
  // account and member are shown — never contacts or report content.
  if (on('shifts')) {
    const me = ctx.actor.membershipId;
    const scoped = hasAnywhere(a, 'shifts.read.scope')
      ? scopePredicate(ctx, 'shifts.read.scope', { projectId: shifts.projectId, accountId: shifts.primaryAccountId, assigned: [shifts.membershipId, shifts.supervisorMembershipId] })
      : sql`false`;
    const own = hasAnywhere(a, 'shifts.read.own') && me ? eq(shifts.membershipId, me) : undefined;
    const visible = scoped === undefined ? undefined : own ? or(scoped, own) : scoped;
    const rows = await db
      .select({ s: shifts, account: socialAccounts, projectName: projects.name })
      .from(shifts)
      .innerJoin(socialAccounts, and(eq(socialAccounts.workspaceId, shifts.workspaceId), eq(socialAccounts.id, shifts.primaryAccountId)))
      .innerJoin(projects, and(eq(projects.workspaceId, shifts.workspaceId), eq(projects.id, shifts.projectId)))
      .where(
        whereAll(
          eq(shifts.workspaceId, ws),
          visible,
          ne(shifts.state, 'cancelled'),
          q.projectId ? eq(shifts.projectId, q.projectId) : undefined,
          q.accountId ? eq(shifts.primaryAccountId, q.accountId) : undefined,
          q.memberId ? eq(shifts.membershipId, q.memberId) : undefined,
          q.platform?.length ? inArray(socialAccounts.platform, q.platform as never[]) : undefined,
          lt(shifts.scheduledStart, to),
          gte(shifts.scheduledEnd, from),
        ),
      )
      .orderBy(asc(shifts.scheduledStart), asc(shifts.id))
      .limit(LAYER_LIMIT + 1);
    if (rows.length > LAYER_LIMIT) truncated = true;
    const page = rows.slice(0, LAYER_LIMIT);
    const refs = await loadMemberRefs(db, ws, page.map((r) => r.s.membershipId));
    for (const r of page)
      events.push({
        key: `shift:${r.s.id}`,
        type: 'shift',
        entityId: r.s.id,
        title: `Shift · ${accountLabel(r.account)}`,
        start: (r.s.actualStart ?? r.s.scheduledStart).toISOString(),
        end: (r.s.actualEnd ?? r.s.scheduledEnd).toISOString(),
        date: null,
        status: r.s.state,
        project: { id: r.s.projectId, name: r.projectName },
        account: { id: r.account.id, label: accountLabel(r.account), platform: r.account.platform },
        member: refOrUnknown(refs, r.s.membershipId),
        conflict: false,
        awaitingConfirmation: false,
        overdue: r.s.state === 'scheduled' && r.s.scheduledStart.getTime() < now.getTime(),
        canReschedule: false,
        canCorrect: false,
        rowVersion: r.s.rowVersion,
        timezone: r.s.timezone,
        href: href(`/ofm/shifts/${r.s.id}`),
      });
  }

  const sortKey = (e: (typeof events)[number]) => e.start ?? `${e.date}T00:00:00.000Z`;
  events.sort((x, y) => (sortKey(x) < sortKey(y) ? -1 : sortKey(x) > sortKey(y) ? 1 : x.key < y.key ? -1 : 1));
  return { from: from.toISOString(), to: to.toISOString(), events, layers: perms, truncated };
};
