import { and, asc, eq, gte, inArray, isNull, lte, ne, or, sql } from 'drizzle-orm';
import { hasAnywhere, listFilter } from '@castlane/authorization';
import { absences, capacities, memberships, projectMemberships, projects, shifts, tasks, timeEntries, workloadAllocations, workspaces } from '@castlane/database';
import type { AbsenceView, WorkloadMember } from '@castlane/api-contracts';
import { AppError, DateTime, eachIsoDate, isoDateAddDays, localDate, newId, notFound, weekStartDate } from '@castlane/domain';
import { allowed, requirePermission, scopePredicate, whereAll } from '../core/access';
import { audit, diffFields } from '../core/audit';
import { dbOf, type CommandContext, type QueryContext } from '../core/context';
import { emit } from '../core/events';
import { loadMemberRefs, refOrUnknown } from '../core/members';
import { notify } from '../core/notify';
import { assertVersion, stamp, touch } from '../core/rows';
import { computeWorkload, DEFAULT_CAPACITY_TEMPLATE, type CapacityProfile, type WeekdayMinutes, type WorkloadTask } from './rules/workload';
import { OPEN_TASK_STATUSES } from './rules/task-status';
import { dueViewOf } from './task-read';
import { fieldFail, loadTask, memberCan, projectNames, TASK_SCOPE_COLUMNS, taskScope, type TaskRowDb } from './shared';

type AbsenceRow = typeof absences.$inferSelect;
type CapacityRow = typeof capacities.$inferSelect;

export const WORKLOAD_ALGORITHM =
  'Available capacity = weekly schedule − approved absences. Planned = remaining estimate (estimate minus recorded time) spread evenly over available working days between the start (or today) and the deadline, unless a manager set a daily allocation. Overload = planned − available, when positive. Tasks without an estimate are counted separately and never treated as zero hours. This is a planning aid, not measured working time.';

const activeProjectsOf = async (ctx: QueryContext | CommandContext, membershipId: string) => {
  const now = ctx.app.clock.now();
  const rows = await dbOf(ctx)
    .select({ projectId: projectMemberships.projectId })
    .from(projectMemberships)
    .where(
      and(
        eq(projectMemberships.workspaceId, ctx.actor.workspaceId),
        eq(projectMemberships.membershipId, membershipId),
        lte(projectMemberships.validFrom, now),
        or(isNull(projectMemberships.validTo), sql`${projectMemberships.validTo} > ${now}`),
      ),
    );
  return rows.map((r) => r.projectId);
};

/**
 * May the actor see / manage a colleague's workload? Workspace-wide grants, the member's own manager
 * (holding the permission), or a grant covering one of the member's projects.
 */
export const canForMember = async (ctx: QueryContext | CommandContext, permission: 'workload.read' | 'workload.manage', membershipId: string): Promise<boolean> => {
  if (!hasAnywhere(ctx.actor.access, permission)) return false;
  if (allowed(ctx, permission)) return true;
  const [m] = await dbOf(ctx).select({ manager: memberships.managerMembershipId }).from(memberships).where(and(eq(memberships.workspaceId, ctx.actor.workspaceId), eq(memberships.id, membershipId)));
  if (!m) return false;
  if (m.manager && m.manager === ctx.actor.membershipId) return true;
  const projectIds = await activeProjectsOf(ctx, membershipId);
  return projectIds.some((projectId) => allowed(ctx, permission, { projectId }));
};

const assertMember = async (ctx: QueryContext | CommandContext, membershipId: string) => {
  const [m] = await dbOf(ctx).select().from(memberships).where(and(eq(memberships.workspaceId, ctx.actor.workspaceId), eq(memberships.id, membershipId)));
  if (!m) throw notFound('Member');
  return m;
};

// ——— Capacity ———

const toCapacityViews = async (ctx: QueryContext | CommandContext, rows: CapacityRow[]) => {
  const refs = await loadMemberRefs(dbOf(ctx), ctx.actor.workspaceId, rows.flatMap((r) => [r.membershipId, r.confirmedBy]));
  return rows.map((r) => ({
    id: r.id,
    member: refOrUnknown(refs, r.membershipId)!,
    effectiveFrom: r.effectiveFrom,
    weekdayMinutes: r.weekdayMinutes,
    weeklyMinutes: Object.values(r.weekdayMinutes).reduce((a, b) => a + b, 0),
    confirmedAt: r.confirmedAt?.toISOString() ?? null,
    confirmedBy: refOrUnknown(refs, r.confirmedBy),
    rowVersion: r.rowVersion,
  }));
};

export const listCapacities = async (ctx: QueryContext, membershipId: string) => {
  await assertMember(ctx, membershipId);
  const self = membershipId === ctx.actor.membershipId;
  if (!self && !(await canForMember(ctx, 'workload.read', membershipId))) throw notFound('Member');
  const rows = await dbOf(ctx)
    .select()
    .from(capacities)
    .where(and(eq(capacities.workspaceId, ctx.actor.workspaceId), eq(capacities.membershipId, membershipId)))
    .orderBy(asc(capacities.effectiveFrom));
  return { items: await toCapacityViews(ctx, rows), template: DEFAULT_CAPACITY_TEMPLATE, canManage: await canForMember(ctx, 'workload.manage', membershipId) };
};

const validateMinutes = (w: WeekdayMinutes) => {
  if (Object.values(w).some((m) => m < 0 || m > 24 * 60)) throw fieldFail('weekdayMinutes', 'INVALID', 'Each day must be between 0 and 24 hours.');
};

/** Confirm capacity from a date: a new profile version (history is kept; the 8 h template is only a suggestion). */
export const setCapacity = async (ctx: CommandContext, input: { membershipId: string; effectiveFrom: string; weekdayMinutes: WeekdayMinutes }) => {
  requirePermission(ctx, 'workload.manage');
  await assertMember(ctx, input.membershipId);
  if (!(await canForMember(ctx, 'workload.manage', input.membershipId))) throw new AppError('FORBIDDEN', 'You cannot adjust this member’s capacity.');
  validateMinutes(input.weekdayMinutes);
  const at = ctx.app.clock.now();
  const id = newId();
  const [row] = await ctx.tx
    .insert(capacities)
    .values({ ...stamp(ctx), id, membershipId: input.membershipId, effectiveFrom: input.effectiveFrom, weekdayMinutes: input.weekdayMinutes, confirmedAt: at, confirmedBy: ctx.actor.membershipId })
    .returning();
  await audit(ctx, { action: 'capacity.set', entityType: 'membership', entityId: input.membershipId, metadata: { effectiveFrom: input.effectiveFrom, weekdayMinutes: input.weekdayMinutes } });
  await emit(ctx, { type: 'capacity.set', entityType: 'capacity', entityId: id, payload: { membershipId: input.membershipId } });
  return (await toCapacityViews(ctx, [row!]))[0]!;
};

export const updateCapacity = async (ctx: CommandContext, id: string, input: { weekdayMinutes: WeekdayMinutes }) => {
  const [c] = await ctx.tx.select().from(capacities).where(and(eq(capacities.workspaceId, ctx.actor.workspaceId), eq(capacities.id, id))).for('update');
  if (!c) throw notFound('Capacity');
  if (!(await canForMember(ctx, 'workload.manage', c.membershipId))) {
    if (c.membershipId === ctx.actor.membershipId || (await canForMember(ctx, 'workload.read', c.membershipId))) throw new AppError('FORBIDDEN', 'You cannot adjust this member’s capacity.');
    throw notFound('Capacity');
  }
  assertVersion(ctx, c);
  validateMinutes(input.weekdayMinutes);
  const [row] = await ctx.tx
    .update(capacities)
    .set({ weekdayMinutes: input.weekdayMinutes, confirmedAt: ctx.app.clock.now(), confirmedBy: ctx.actor.membershipId, ...touch(ctx, capacities) })
    .where(eq(capacities.id, id))
    .returning();
  await audit(ctx, { action: 'capacity.updated', entityType: 'membership', entityId: c.membershipId, diff: diffFields(c, row!, ['weekdayMinutes']) });
  await emit(ctx, { type: 'capacity.updated', entityType: 'capacity', entityId: id });
  return (await toCapacityViews(ctx, [row!]))[0]!;
};

// ——— Absences ———

const toAbsenceViews = async (ctx: QueryContext | CommandContext, rows: AbsenceRow[]): Promise<AbsenceView[]> => {
  const refs = await loadMemberRefs(dbOf(ctx), ctx.actor.workspaceId, rows.flatMap((r) => [r.membershipId, r.decidedBy]));
  const out: AbsenceView[] = [];
  const cache = new Map<string, { manage: boolean }>();
  for (const r of rows) {
    if (!cache.has(r.membershipId)) cache.set(r.membershipId, { manage: await canForMember(ctx, 'workload.manage', r.membershipId) });
    const manage = cache.get(r.membershipId)!.manage;
    const self = r.membershipId === ctx.actor.membershipId;
    const [m] = await dbOf(ctx).select({ manager: memberships.managerMembershipId }).from(memberships).where(eq(memberships.id, r.membershipId));
    const seesReason = self || manage || m?.manager === ctx.actor.membershipId;
    const open = r.state === 'requested' || r.state === 'approved';
    out.push({
      id: r.id,
      member: refOrUnknown(refs, r.membershipId)!,
      startDate: r.startDate,
      endDate: r.endDate,
      category: r.category,
      state: r.state,
      ...(seesReason ? { privateReason: r.privateReason } : {}),
      decidedBy: refOrUnknown(refs, r.decidedBy),
      canDecide: r.state === 'requested' && manage && (!self || ctx.actor.access.isOwner),
      canEdit: open && ((self && r.state === 'requested') || manage),
      rowVersion: r.rowVersion,
    });
  }
  return out;
};

/** Visible absences: own, and members whose workload the actor may read. */
export const listAbsences = async (ctx: QueryContext, q: { membershipId?: string; from?: string; to?: string; state?: AbsenceRow['state'][] }) => {
  const rows = await dbOf(ctx)
    .select()
    .from(absences)
    .where(
      whereAll(
        eq(absences.workspaceId, ctx.actor.workspaceId),
        q.membershipId ? eq(absences.membershipId, q.membershipId) : undefined,
        q.from ? gte(absences.endDate, q.from) : undefined,
        q.to ? lte(absences.startDate, q.to) : undefined,
        q.state?.length ? inArray(absences.state, q.state) : undefined,
      ),
    )
    .orderBy(asc(absences.startDate))
    .limit(1000);
  const visible: AbsenceRow[] = [];
  const cache = new Map<string, boolean>();
  for (const r of rows) {
    if (!cache.has(r.membershipId)) cache.set(r.membershipId, r.membershipId === ctx.actor.membershipId || (await canForMember(ctx, 'workload.read', r.membershipId)));
    if (cache.get(r.membershipId)) visible.push(r);
  }
  return toAbsenceViews(ctx, visible);
};

const absenceImpact = async (ctx: CommandContext, membershipId: string, startDate: string, endDate: string) => {
  const [ws] = await ctx.tx.select({ tz: workspaces.timezone }).from(workspaces).where(eq(workspaces.id, ctx.actor.workspaceId));
  const tz = ws?.tz ?? 'UTC';
  const from = DateTime.fromISO(startDate, { zone: tz }).startOf('day').toUTC().toJSDate();
  const to = DateTime.fromISO(endDate, { zone: tz }).plus({ days: 1 }).startOf('day').toUTC().toJSDate();
  const [t] = await ctx.tx
    .select({ n: sql<number>`count(*)` })
    .from(tasks)
    .where(and(eq(tasks.workspaceId, ctx.actor.workspaceId), eq(tasks.assigneeMembershipId, membershipId), inArray(tasks.status, [...OPEN_TASK_STATUSES]), gte(tasks.dueAt, from), sql`${tasks.dueAt} < ${to}`, isNull(tasks.deletedAt)));
  const [s] = await ctx.tx
    .select({ n: sql<number>`count(*)` })
    .from(shifts)
    .where(and(eq(shifts.workspaceId, ctx.actor.workspaceId), eq(shifts.membershipId, membershipId), eq(shifts.state, 'scheduled'), sql`${shifts.scheduledStart} < ${to}`, sql`${shifts.scheduledEnd} > ${from}`));
  return { tasksDue: Number(t?.n ?? 0), shiftsScheduled: Number(s?.n ?? 0) };
};

const assertNoOverlap = async (ctx: CommandContext, membershipId: string, startDate: string, endDate: string, exceptId?: string) => {
  const [o] = await ctx.tx
    .select({ id: absences.id })
    .from(absences)
    .where(
      and(
        eq(absences.workspaceId, ctx.actor.workspaceId),
        eq(absences.membershipId, membershipId),
        inArray(absences.state, ['requested', 'approved']),
        lte(absences.startDate, endDate),
        gte(absences.endDate, startDate),
        exceptId ? ne(absences.id, exceptId) : undefined,
      ),
    );
  if (o) throw new AppError('CONFLICT', 'This member already has leave recorded in these dates.', { details: { absenceId: o.id } });
};

/**
 * Request your own leave (Requested) or record leave for a member you manage (Approved). Leave
 * highlights deadlines and shifts in the period — it never cancels them silently.
 */
export const createAbsence = async (ctx: CommandContext, input: { membershipId: string; startDate: string; endDate: string; category: AbsenceRow['category']; privateReason?: string | null }) => {
  await assertMember(ctx, input.membershipId);
  const self = input.membershipId === ctx.actor.membershipId;
  const manage = await canForMember(ctx, 'workload.manage', input.membershipId);
  if (!self && !manage) throw new AppError('FORBIDDEN', 'You can record leave only for yourself or members you manage.');
  if (input.endDate < input.startDate) throw fieldFail('endDate', 'BEFORE_START', 'The end date must be on or after the start date.');
  await assertNoOverlap(ctx, input.membershipId, input.startDate, input.endDate);
  const state = self && !ctx.actor.access.isOwner ? 'requested' : 'approved';
  const id = newId();
  const [row] = await ctx.tx
    .insert(absences)
    .values({
      ...stamp(ctx),
      id,
      membershipId: input.membershipId,
      startDate: input.startDate,
      endDate: input.endDate,
      category: input.category,
      privateReason: input.privateReason?.trim() || null,
      state,
      decidedBy: state === 'approved' ? ctx.actor.membershipId : null,
    })
    .returning();
  await audit(ctx, { action: `absence.${state}`, entityType: 'membership', entityId: input.membershipId, metadata: { absenceId: id, startDate: input.startDate, endDate: input.endDate, category: input.category } });
  await emit(ctx, { type: 'absence.created', entityType: 'absence', entityId: id, payload: { membershipId: input.membershipId, state } });
  if (state === 'requested') {
    const [m] = await ctx.tx.select({ manager: memberships.managerMembershipId }).from(memberships).where(eq(memberships.id, input.membershipId));
    if (m?.manager)
      await notify(ctx.tx, {
        workspaceId: ctx.actor.workspaceId,
        recipientMembershipIds: [m.manager],
        eventType: 'absence.requested',
        eventKey: `absence.requested:${id}`,
        kind: 'review_request',
        title: `Leave request: ${ctx.actor.displayName}, ${input.startDate} – ${input.endDate}`,
        entityType: 'absence',
        entityId: id,
        actorMembershipId: ctx.actor.membershipId,
        at: ctx.app.clock.now(),
      });
  }
  const [view] = await toAbsenceViews(ctx, [row!]);
  return { ...view!, affected: await absenceImpact(ctx, input.membershipId, input.startDate, input.endDate) };
};

const lockAbsence = async (ctx: CommandContext, id: string) => {
  const [a] = await ctx.tx.select().from(absences).where(and(eq(absences.workspaceId, ctx.actor.workspaceId), eq(absences.id, id))).for('update');
  if (!a) throw notFound('Absence');
  const self = a.membershipId === ctx.actor.membershipId;
  const manage = await canForMember(ctx, 'workload.manage', a.membershipId);
  if (!self && !manage && !(await canForMember(ctx, 'workload.read', a.membershipId))) throw notFound('Absence');
  return { a, self, manage };
};

export const updateAbsence = async (ctx: CommandContext, id: string, input: { startDate?: string; endDate?: string; category?: AbsenceRow['category']; privateReason?: string | null }) => {
  const { a, self, manage } = await lockAbsence(ctx, id);
  assertVersion(ctx, a);
  if (a.state === 'rejected' || a.state === 'cancelled') throw new AppError('INVALID_STATE', 'Rejected or cancelled leave cannot change.');
  if (!manage && !(self && a.state === 'requested')) throw new AppError('FORBIDDEN', 'Approved leave can be changed by a manager only.');
  const startDate = input.startDate ?? a.startDate;
  const endDate = input.endDate ?? a.endDate;
  if (endDate < startDate) throw fieldFail('endDate', 'BEFORE_START', 'The end date must be on or after the start date.');
  if (startDate !== a.startDate || endDate !== a.endDate) await assertNoOverlap(ctx, a.membershipId, startDate, endDate, a.id);
  const [row] = await ctx.tx
    .update(absences)
    .set({
      startDate,
      endDate,
      ...(input.category ? { category: input.category } : {}),
      ...(input.privateReason !== undefined ? { privateReason: input.privateReason?.trim() || null } : {}),
      ...touch(ctx, absences),
    })
    .where(eq(absences.id, id))
    .returning();
  await audit(ctx, { action: 'absence.updated', entityType: 'membership', entityId: a.membershipId, diff: diffFields(a, row!, ['startDate', 'endDate', 'category', 'privateReason'], ['privateReason']) });
  await emit(ctx, { type: 'absence.updated', entityType: 'absence', entityId: id });
  return (await toAbsenceViews(ctx, [row!]))[0]!;
};

export const decideAbsence = async (ctx: CommandContext, id: string, input: { decision: 'approve' | 'reject'; reason?: string }) => {
  const { a, self, manage } = await lockAbsence(ctx, id);
  if (!manage) throw new AppError('FORBIDDEN', 'Only a manager can decide on leave.');
  if (self && !ctx.actor.access.isOwner) throw new AppError('FORBIDDEN', 'You cannot approve your own leave.');
  assertVersion(ctx, a);
  if (a.state !== 'requested') throw new AppError('INVALID_STATE', 'Only requested leave can be decided.');
  const state = input.decision === 'approve' ? 'approved' : 'rejected';
  const [row] = await ctx.tx.update(absences).set({ state, decidedBy: ctx.actor.membershipId, ...touch(ctx, absences) }).where(eq(absences.id, id)).returning();
  await audit(ctx, { action: `absence.${state}`, entityType: 'membership', entityId: a.membershipId, reason: input.reason ?? null, metadata: { absenceId: id } });
  await emit(ctx, { type: 'absence.decided', entityType: 'absence', entityId: id });
  await notify(ctx.tx, {
    workspaceId: ctx.actor.workspaceId,
    recipientMembershipIds: [a.membershipId],
    eventType: `absence.${state}`,
    eventKey: `absence.${state}:${id}`,
    kind: 'general',
    title: `Leave ${state}: ${a.startDate} – ${a.endDate}`,
    excerpt: input.reason ?? null,
    entityType: 'absence',
    entityId: id,
    actorMembershipId: ctx.actor.membershipId,
    at: ctx.app.clock.now(),
  });
  return (await toAbsenceViews(ctx, [row!]))[0]!;
};

export const cancelAbsence = async (ctx: CommandContext, id: string, input: { reason?: string }) => {
  const { a, self, manage } = await lockAbsence(ctx, id);
  if (!self && !manage) throw new AppError('FORBIDDEN', 'You cannot cancel this leave.');
  assertVersion(ctx, a);
  if (a.state === 'cancelled' || a.state === 'rejected') throw new AppError('INVALID_STATE', 'This leave is no longer active.');
  const [row] = await ctx.tx.update(absences).set({ state: 'cancelled', ...touch(ctx, absences) }).where(eq(absences.id, id)).returning();
  await audit(ctx, { action: 'absence.cancelled', entityType: 'membership', entityId: a.membershipId, reason: input.reason ?? null, metadata: { absenceId: id } });
  await emit(ctx, { type: 'absence.cancelled', entityType: 'absence', entityId: id });
  return (await toAbsenceViews(ctx, [row!]))[0]!;
};

// ——— Workload read model ———

const periodOf = (from: string, period: 'week' | 'month') => {
  if (period === 'month') {
    const start = DateTime.fromISO(from, { zone: 'UTC' }).startOf('month');
    return { from: start.toISODate() as string, to: start.endOf('month').toISODate() as string };
  }
  return { from, to: isoDateAddDays(from, 6) };
};

interface MemberInput {
  membershipId: string;
  profiles: CapacityProfile[];
  absent: Set<string>;
  absenceRows: AbsenceRow[];
  tasks: (TaskRowDb & { loggedMinutes: number })[];
  manual: Map<string, Map<string, number>>;
}

const localDay = (d: Date | null, tz: string) => (d ? localDate(d, tz) : null);
const taskDueDate = (t: TaskRowDb, tz: string) => t.dueDate ?? localDay(t.dueAt, tz);

const toWorkloadTasks = (m: MemberInput, tz: string): WorkloadTask[] =>
  m.tasks.map((t) => ({
    id: t.id,
    remainingMinutes: t.estimateMinutes === null ? null : Math.max(0, t.estimateMinutes - t.loggedMinutes),
    startDate: localDay(t.startAt, tz),
    dueDate: taskDueDate(t, tz),
  }));

/** Load everything needed for the members' workload in [from, to]; tasks restricted to the viewer's scope. */
const loadMemberInputs = async (ctx: QueryContext, memberIds: string[], from: string, to: string, extraTasks: TaskRowDb[] = []): Promise<Map<string, MemberInput>> => {
  const db = dbOf(ctx);
  const ws = ctx.actor.workspaceId;
  const out = new Map<string, MemberInput>();
  if (memberIds.length === 0) return out;
  const [caps, abs, openTasks] = [
    await db.select().from(capacities).where(and(eq(capacities.workspaceId, ws), inArray(capacities.membershipId, memberIds))),
    await db
      .select()
      .from(absences)
      .where(and(eq(absences.workspaceId, ws), inArray(absences.membershipId, memberIds), inArray(absences.state, ['approved', 'requested']), lte(absences.startDate, to), gte(absences.endDate, from))),
    await db
      .select()
      .from(tasks)
      .where(
        whereAll(
          eq(tasks.workspaceId, ws),
          inArray(tasks.assigneeMembershipId, memberIds),
          inArray(tasks.status, [...OPEN_TASK_STATUSES]),
          isNull(tasks.deletedAt),
          isNull(tasks.archivedAt),
          // Only work the viewer may see is summed (no leakage of other projects' effort).
          scopePredicate(ctx, 'tasks.read', TASK_SCOPE_COLUMNS),
        ),
      )
      .limit(5000),
  ];
  const all = [...openTasks, ...extraTasks.filter((e) => !openTasks.some((t) => t.id === e.id))];
  const ids = all.map((t) => t.id);
  const logged = ids.length
    ? await db
        .select({ taskId: timeEntries.taskId, s: sql<number>`coalesce(sum(${timeEntries.durationSeconds}), 0)` })
        .from(timeEntries)
        .where(and(inArray(timeEntries.taskId, ids), ne(timeEntries.state, 'running'), isNull(timeEntries.supersededAt)))
        .groupBy(timeEntries.taskId)
    : [];
  const loggedBy = new Map(logged.map((l) => [l.taskId, Math.floor(Number(l.s) / 60)]));
  const allocs = ids.length ? await db.select().from(workloadAllocations).where(and(eq(workloadAllocations.workspaceId, ws), inArray(workloadAllocations.taskId, ids))) : [];
  for (const id of memberIds) {
    const absRows = abs.filter((a) => a.membershipId === id);
    const absent = new Set<string>();
    for (const a of absRows.filter((x) => x.state === 'approved')) for (const d of eachIsoDate(a.startDate > from ? a.startDate : from, a.endDate < to ? a.endDate : to)) absent.add(d);
    const manual = new Map<string, Map<string, number>>();
    for (const al of allocs.filter((x) => x.membershipId === id)) {
      const m = manual.get(al.taskId) ?? new Map<string, number>();
      m.set(al.workDate, al.minutes);
      manual.set(al.taskId, m);
    }
    out.set(id, {
      membershipId: id,
      profiles: caps.filter((c) => c.membershipId === id).map((c) => ({ effectiveFrom: c.effectiveFrom, weekdayMinutes: c.weekdayMinutes })),
      absent,
      absenceRows: absRows,
      tasks: all.filter((t) => t.assigneeMembershipId === id).map((t) => ({ ...t, loggedMinutes: loggedBy.get(t.id) ?? 0 })),
      manual,
    });
  }
  return out;
};

/** Members whose workload the viewer may see (scope before aggregation). */
const visibleMembers = async (ctx: QueryContext, q: { membershipIds?: string[]; projectId?: string; directionId?: string }) => {
  const db = dbOf(ctx);
  const ws = ctx.actor.workspaceId;
  const now = ctx.app.clock.now();
  const f = listFilter(ctx.actor.access, 'workload.read');
  let projectIds: string[] | null = null;
  if (q.projectId) projectIds = [q.projectId];
  else if (q.directionId) projectIds = (await db.select({ id: projects.id }).from(projects).where(and(eq(projects.workspaceId, ws), eq(projects.directionId, q.directionId)))).map((p) => p.id);
  let ids: string[];
  const teamOf = async (pids: string[]) =>
    pids.length
      ? (
          await db
            .selectDistinct({ id: projectMemberships.membershipId })
            .from(projectMemberships)
            .where(and(eq(projectMemberships.workspaceId, ws), inArray(projectMemberships.projectId, pids), lte(projectMemberships.validFrom, now), or(isNull(projectMemberships.validTo), sql`${projectMemberships.validTo} > ${now}`)))
        ).map((r) => r.id)
      : [];
  if (f.kind === 'all') {
    ids = projectIds ? await teamOf(projectIds) : (await db.select({ id: memberships.id }).from(memberships).where(and(eq(memberships.workspaceId, ws), eq(memberships.status, 'active')))).map((r) => r.id);
  } else if (f.kind === 'scoped') {
    const allowedProjects = projectIds ? projectIds.filter((p) => f.projectIds.includes(p)) : f.projectIds;
    ids = await teamOf(allowedProjects);
    const reports = (await db.select({ id: memberships.id }).from(memberships).where(and(eq(memberships.workspaceId, ws), eq(memberships.managerMembershipId, ctx.actor.membershipId ?? '00000000-0000-0000-0000-000000000000')))).map((r) => r.id);
    ids = [...new Set([...ids, ...(projectIds ? [] : reports), ...(projectIds || !ctx.actor.membershipId ? [] : [ctx.actor.membershipId])])];
  } else ids = ctx.actor.membershipId ? [ctx.actor.membershipId] : [];
  if (q.membershipIds?.length) ids = ids.filter((i) => q.membershipIds!.includes(i));
  const active = ids.length
    ? (await db.select({ id: memberships.id }).from(memberships).where(and(eq(memberships.workspaceId, ws), inArray(memberships.id, ids), eq(memberships.status, 'active')))).map((r) => r.id)
    : [];
  return active;
};

export const getWorkload = async (ctx: QueryContext, q: { from?: string; period: 'week' | 'month'; membershipIds?: string[]; projectId?: string; directionId?: string }) => {
  requirePermission(ctx, 'workload.read');
  const db = dbOf(ctx);
  const [ws] = await db.select({ tz: workspaces.timezone, weekStartsOn: workspaces.weekStartsOn }).from(workspaces).where(eq(workspaces.id, ctx.actor.workspaceId));
  const tz = ws?.tz ?? 'UTC';
  const now = ctx.app.clock.now();
  const today = localDate(now, tz);
  const anchor = q.from ?? (q.period === 'month' ? today : weekStartDate(now, tz, ws?.weekStartsOn ?? 'monday'));
  const { from, to } = periodOf(anchor, q.period);
  const memberIds = await visibleMembers(ctx, q);
  const inputs = await loadMemberInputs(ctx, memberIds, from, to);
  const refs = await loadMemberRefs(db, ctx.actor.workspaceId, [...memberIds, ...[...inputs.values()].flatMap((i) => i.absenceRows.map((a) => a.decidedBy))]);
  const names = await projectNames(db, ctx.actor.workspaceId, [...inputs.values()].flatMap((i) => i.tasks.map((t) => t.projectId)));
  const members: WorkloadMember[] = [];
  for (const id of memberIds) {
    const input = inputs.get(id)!;
    const r = computeWorkload({ from, to, today, profiles: input.profiles, absentDates: input.absent, tasks: toWorkloadTasks(input, tz), manual: input.manual });
    const planned = new Map(r.perTask.map((p) => [p.id, p]));
    const absenceViews = await toAbsenceViews(ctx, input.absenceRows);
    members.push({
      member: refOrUnknown(refs, id)!,
      capacityCoverage: r.capacityCoverage,
      capacityMinutes: r.capacityMinutes,
      availableMinutes: r.availableMinutes,
      plannedMinutes: r.plannedMinutes,
      overloadMinutes: r.overloadMinutes,
      dailyOverloadMinutes: r.dailyOverloadMinutes,
      unestimatedCount: r.unestimatedCount,
      unscheduledCount: r.unscheduledCount,
      unscheduledMinutes: r.unscheduledMinutes,
      overdueCount: r.overdueCount,
      overdueMinutes: r.overdueMinutes,
      days: r.days,
      absences: absenceViews,
      tasks: input.tasks
        .map((t) => {
          const remaining = t.estimateMinutes === null ? null : Math.max(0, t.estimateMinutes - t.loggedMinutes);
          const due = taskDueDate(t, tz);
          const p = planned.get(t.id);
          const method: WorkloadMember['tasks'][number]['method'] =
            remaining === null ? 'unestimated' : !due ? 'unscheduled' : due < today ? 'overdue' : (p?.method ?? 'even');
          return {
            id: t.id,
            title: t.title,
            project: { id: t.projectId, name: names.get(t.projectId)?.name ?? 'Unknown project' },
            status: t.status,
            due: dueViewOf(t),
            startAt: t.startAt?.toISOString() ?? null,
            estimateMinutes: t.estimateMinutes,
            loggedMinutes: t.loggedMinutes,
            remainingMinutes: remaining,
            plannedInPeriod: p ? p.plannedInPeriod : null,
            method,
            rowVersion: t.rowVersion,
          };
        })
        .filter((t) => t.method !== 'even' || (t.plannedInPeriod ?? 0) > 0 || (t.due && t.due.at >= from)),
    });
  }
  return { from, to, today, timezone: tz, algorithm: WORKLOAD_ALGORITHM, members, permissions: { manage: hasAnywhere(ctx.actor.access, 'workload.manage') } };
};

/** Before/after planned load of both members for a proposed reassignment (conflicting reassign → refresh preview). */
export const reassignPreview = async (ctx: QueryContext, input: { taskId: string; toMembershipId: string; from: string; period: 'week' | 'month' }) => {
  const t = await loadTask(ctx, input.taskId);
  const scope = taskScope(t);
  if (!allowed(ctx, 'tasks.read', scope)) throw notFound('Task');
  if (!allowed(ctx, 'tasks.assign', scope)) throw new AppError('FORBIDDEN', 'You cannot reassign this task.');
  const target = await assertMember(ctx, input.toMembershipId);
  if (target.status !== 'active') throw fieldFail('toMembershipId', 'INACTIVE', 'Choose an active member.');
  const [ws] = await dbOf(ctx).select({ tz: workspaces.timezone }).from(workspaces).where(eq(workspaces.id, ctx.actor.workspaceId));
  const tz = ws?.tz ?? 'UTC';
  const today = localDate(ctx.app.clock.now(), tz);
  const { from, to } = periodOf(input.from, input.period);
  const ids = [...new Set([input.toMembershipId, ...(t.assigneeMembershipId ? [t.assigneeMembershipId] : [])])];
  const inputs = await loadMemberInputs(ctx, ids, from, to, [t]);
  const load = (m: MemberInput, withTask: boolean) => {
    const base = { ...m, tasks: m.tasks.filter((x) => x.id !== t.id) };
    if (withTask) {
      const own = inputs.get(t.assigneeMembershipId ?? '')?.tasks.find((x) => x.id === t.id) ?? { ...t, loggedMinutes: 0 };
      base.tasks = [...base.tasks, own];
    }
    return computeWorkload({ from, to, today, profiles: m.profiles, absentDates: m.absent, tasks: toWorkloadTasks(base, tz), manual: m.manual });
  };
  const refs = await loadMemberRefs(dbOf(ctx), ctx.actor.workspaceId, ids);
  const toInput = inputs.get(input.toMembershipId)!;
  const beforeTo = load(toInput, toInput.tasks.some((x) => x.id === t.id));
  const afterTo = load(toInput, true);
  const access = await memberCan(ctx.app.db, ctx.actor.workspaceId, input.toMembershipId, 'tasks.read', { ...scope, assignedMembershipIds: [input.toMembershipId] }, ctx.app.clock.now());
  let fromView = null;
  if (t.assigneeMembershipId && t.assigneeMembershipId !== input.toMembershipId) {
    const fromInput = inputs.get(t.assigneeMembershipId)!;
    const before = load(fromInput, true);
    const after = load(fromInput, false);
    fromView = { member: refOrUnknown(refs, t.assigneeMembershipId), plannedBefore: before.plannedMinutes, plannedAfter: after.plannedMinutes, availableMinutes: before.availableMinutes };
  }
  return {
    task: { id: t.id, title: t.title, status: t.status, readable: true, rowVersion: t.rowVersion, estimateMinutes: t.estimateMinutes },
    from: fromView,
    to: { member: refOrUnknown(refs, input.toMembershipId)!, plannedBefore: beforeTo.plannedMinutes, plannedAfter: afterTo.plannedMinutes, availableMinutes: afterTo.availableMinutes, canAccessTask: access.ok },
  };
};

/** Replace the manual daily allocation of a task for its assignee (empty = back to the even split). */
export const setAllocation = async (ctx: CommandContext, input: { taskId: string; allocations: { date: string; minutes: number }[] }) => {
  requirePermission(ctx, 'workload.manage');
  const t = await loadTask(ctx, input.taskId);
  if (!allowed(ctx, 'tasks.read', taskScope(t))) throw notFound('Task');
  if (!t.assigneeMembershipId) throw new AppError('INVALID_STATE', 'Assign the task before planning its days.');
  if (!(await canForMember(ctx, 'workload.manage', t.assigneeMembershipId))) throw new AppError('FORBIDDEN', 'You cannot plan this member’s workload.');
  const dates = input.allocations.map((a) => a.date);
  if (new Set(dates).size !== dates.length) throw fieldFail('allocations', 'DUPLICATE_DATE', 'Each day can appear only once.');
  await ctx.tx.delete(workloadAllocations).where(and(eq(workloadAllocations.taskId, t.id), eq(workloadAllocations.membershipId, t.assigneeMembershipId)));
  if (input.allocations.length)
    await ctx.tx
      .insert(workloadAllocations)
      .values(input.allocations.map((a) => ({ ...stamp(ctx), id: newId(), taskId: t.id, membershipId: t.assigneeMembershipId!, workDate: a.date, minutes: a.minutes })));
  await audit(ctx, { action: 'workload.allocation_set', entityType: 'task', entityId: t.id, projectId: t.projectId, metadata: { days: input.allocations.length, minutes: input.allocations.reduce((a, b) => a + b.minutes, 0) } });
  await emit(ctx, { type: 'task.updated', entityType: 'task', entityId: t.id });
  return { taskId: t.id, allocations: input.allocations };
};
