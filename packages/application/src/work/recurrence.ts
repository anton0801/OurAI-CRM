import { and, asc, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { projects, recurrenceOccurrences, recurrenceRules, tasks, taskStatusEvents, timeEntries, type RecurrenceTaskTemplate } from '@castlane/database';
import type { RecurrenceRuleView, TaskCreateBody } from '@castlane/api-contracts';
import { AppError, isIsoDate, newId, notFound } from '@castlane/domain';
import { allowed, authorizeObject, authorizeRead, requirePermission, scopePredicate, whereAll } from '../core/access';
import { audit, diffFields } from '../core/audit';
import { executeSystemCommand } from '../core/command';
import { dbOf, type CommandContext, type QueryContext } from '../core/context';
import { emit } from '../core/events';
import { defineJob, defineSchedule, systemJobContext } from '../core/jobs-registry';
import { loadMemberRefs, refOrUnknown } from '../core/members';
import { assertVersion, stamp, touch } from '../core/rows';
import { nextAfterCompletion, nextOccurrence, occurrencesBetween, planGeneration, type Occurrence, type RecurrenceSpec } from './rules/recurrence';
import { NOT_STARTED_STATUSES } from './rules/task-status';
import { createTask, recordDueChange } from './tasks';
import { transitionTask } from './task-transitions';
import { fieldFail, indexTask, projectNames } from './shared';

type RuleRow = typeof recurrenceRules.$inferSelect;

/** Template input as received (nullable fields); stored normalised as RecurrenceTaskTemplate. */
export type RecurrenceTemplateInput = Omit<RecurrenceTaskTemplate, 'description'> & { description?: string | null };

const normalizeTemplate = (t: RecurrenceTemplateInput): RecurrenceTaskTemplate => ({
  title: t.title.trim(),
  ...(t.description?.trim() ? { description: t.description.trim() } : {}),
  assigneeMembershipId: t.assigneeMembershipId ?? null,
  reviewerMembershipId: t.reviewerMembershipId ?? null,
  priority: t.priority ?? 'normal',
  estimateMinutes: t.estimateMinutes ?? null,
  checklist: t.checklist ?? [],
  dueOffsetMinutes: t.dueOffsetMinutes ?? 0,
});

export interface RecurrenceInput {
  projectId?: string;
  template?: RecurrenceTemplateInput;
  cadence?: RuleRow['cadence'];
  intervalCount?: number;
  weekdays?: number[];
  monthDay?: number | null;
  monthDayPolicy?: RuleRow['monthDayPolicy'];
  localTime?: string;
  timezone?: string;
  mode?: RuleRow['mode'];
  startsOn?: string;
  endsOn?: string | null;
  horizonDays?: number;
  backfillLimit?: number;
}

const specOf = (r: Pick<RuleRow, 'cadence' | 'intervalCount' | 'weekdays' | 'monthDay' | 'monthDayPolicy' | 'localTime' | 'timezone' | 'startsOn' | 'endsOn'>): RecurrenceSpec => ({
  cadence: r.cadence,
  intervalCount: r.intervalCount,
  weekdays: r.weekdays,
  monthDay: r.monthDay,
  monthDayPolicy: r.monthDayPolicy,
  localTime: r.localTime,
  timezone: r.timezone,
  startsOn: r.startsOn,
  endsOn: r.endsOn,
});

const ruleScope = (r: Pick<RuleRow, 'id' | 'projectId' | 'ownerMembershipId'>) => ({ objectType: 'recurrence_rule', objectId: r.id, projectId: r.projectId, ownerMembershipId: r.ownerMembershipId });

const validateSpec = (s: RecurrenceSpec) => {
  if (s.endsOn && s.endsOn < s.startsOn) throw fieldFail('endsOn', 'BEFORE_START', 'The end date must be on or after the start date.');
  if (s.cadence === 'weekly' && s.weekdays.some((w) => w < 1 || w > 7)) throw fieldFail('weekdays', 'INVALID', 'Choose weekdays Monday–Sunday.');
  if (!isIsoDate(s.startsOn)) throw fieldFail('startsOn', 'INVALID', 'Enter a valid date.');
};

export const toRuleView = async (ctx: QueryContext | CommandContext, rows: RuleRow[]): Promise<RecurrenceRuleView[]> => {
  const db = dbOf(ctx);
  const names = await projectNames(db, ctx.actor.workspaceId, rows.map((r) => r.projectId));
  const refs = await loadMemberRefs(db, ctx.actor.workspaceId, rows.flatMap((r) => [r.ownerMembershipId, r.template.assigneeMembershipId, r.template.reviewerMembershipId]));
  const now = ctx.app.clock.now();
  return rows.map((r) => {
    const next = r.active && !r.archivedAt ? nextOccurrence(specOf(r), now) : null;
    return {
      id: r.id,
      project: { id: r.projectId, name: names.get(r.projectId)?.name ?? 'Unknown project' },
      owner: refOrUnknown(refs, r.ownerMembershipId)!,
      template: {
        ...r.template,
        description: r.template.description ?? null,
        assignee: refOrUnknown(refs, r.template.assigneeMembershipId),
        reviewer: refOrUnknown(refs, r.template.reviewerMembershipId),
      },
      cadence: r.cadence,
      intervalCount: r.intervalCount,
      weekdays: r.weekdays,
      monthDay: r.monthDay,
      monthDayPolicy: r.monthDayPolicy,
      localTime: r.localTime,
      timezone: r.timezone,
      mode: r.mode,
      startsOn: r.startsOn,
      endsOn: r.endsOn,
      horizonDays: r.horizonDays,
      backfillLimit: r.backfillLimit,
      ruleVersion: r.ruleVersion,
      active: r.active,
      lastGeneratedThrough: r.lastGeneratedThrough?.toISOString() ?? null,
      nextOccurrenceAt: next?.scheduledFor.toISOString() ?? null,
      archivedAt: r.archivedAt?.toISOString() ?? null,
      updatedAt: r.updatedAt.toISOString(),
      rowVersion: r.rowVersion,
      canManage: !r.archivedAt && allowed(ctx, 'tasks.create', ruleScope(r)),
    };
  });
};

export const listRecurrences = async (ctx: QueryContext, input: { projectId?: string; includeArchived?: boolean }) => {
  requirePermission(ctx, 'tasks.read');
  const rows = await dbOf(ctx)
    .select()
    .from(recurrenceRules)
    .where(
      whereAll(
        eq(recurrenceRules.workspaceId, ctx.actor.workspaceId),
        scopePredicate(ctx, 'tasks.read', { projectId: recurrenceRules.projectId }),
        input.projectId ? eq(recurrenceRules.projectId, input.projectId) : undefined,
        input.includeArchived ? undefined : isNull(recurrenceRules.archivedAt),
      ),
    )
    .orderBy(asc(recurrenceRules.createdAt))
    .limit(500);
  return toRuleView(ctx, rows);
};

const loadRule = async (ctx: QueryContext | CommandContext, id: string, lock = false) => {
  const q = dbOf(ctx).select().from(recurrenceRules).where(and(eq(recurrenceRules.workspaceId, ctx.actor.workspaceId), eq(recurrenceRules.id, id)));
  const [r] = lock && 'tx' in ctx ? await q.for('update') : await q;
  if (!r) throw notFound('Recurring rule');
  return r;
};

export const getRecurrence = async (ctx: QueryContext | CommandContext, id: string) => {
  const r = await loadRule(ctx, id);
  authorizeRead(ctx, 'tasks.read', ruleScope(r));
  const [view] = await toRuleView(ctx, [r]);
  const occ = await dbOf(ctx)
    .select({ o: recurrenceOccurrences, title: tasks.title, status: tasks.status })
    .from(recurrenceOccurrences)
    .leftJoin(tasks, eq(tasks.id, recurrenceOccurrences.taskId))
    .where(and(eq(recurrenceOccurrences.workspaceId, ctx.actor.workspaceId), eq(recurrenceOccurrences.ruleId, id)))
    .orderBy(desc(recurrenceOccurrences.scheduledFor))
    .limit(60);
  const now = ctx.app.clock.now();
  const upcoming = r.active && !r.archivedAt ? occurrencesBetween(specOf(r), now, new Date(now.getTime() + 60 * 86_400_000), 10) : [];
  return {
    ...view!,
    occurrences: occ.map(({ o, title, status }) => ({
      id: o.id,
      key: o.occurrenceKey,
      scheduledFor: o.scheduledFor.toISOString(),
      state: o.state,
      ruleVersion: o.ruleVersion,
      task: o.taskId ? { id: o.taskId, title: title ?? null, status: status ?? null, readable: true } : null,
      missedDates: o.missedDates,
    })),
    upcoming: upcoming.map((u) => ({ key: u.key, scheduledFor: u.scheduledFor.toISOString(), clampedToMonthEnd: u.clampedToMonthEnd })),
  };
};

export const previewRecurrence = (ctx: QueryContext, input: RecurrenceSpec) => {
  requirePermission(ctx, 'tasks.create');
  validateSpec(input);
  const now = ctx.app.clock.now();
  const occ = occurrencesBetween(input, now, new Date(now.getTime() + 400 * 86_400_000), 12);
  return { occurrences: occ.map((o) => ({ key: o.key, scheduledFor: o.scheduledFor.toISOString(), clampedToMonthEnd: o.clampedToMonthEnd, dstShifted: o.dstShifted })) };
};

const templateTaskBody = (r: RuleRow, o: Occurrence): TaskCreateBody => {
  const dueAt = new Date(o.scheduledFor.getTime() + (r.template.dueOffsetMinutes ?? 0) * 60_000);
  return {
    title: r.template.title,
    projectId: r.projectId,
    description: r.template.description ?? null,
    status: r.template.assigneeMembershipId ? 'ready' : 'backlog',
    priority: r.template.priority ?? 'normal',
    assigneeMembershipId: r.template.assigneeMembershipId ?? null,
    reviewerMembershipId: r.template.reviewerMembershipId ?? null,
    estimateMinutes: r.template.estimateMinutes ?? null,
    due: { kind: 'datetime', at: dueAt.toISOString(), timezone: r.timezone },
    checklist: r.template.checklist?.map((c) => ({ label: c.label, mandatory: c.mandatory })),
  };
};

/**
 * Create the task of one occurrence. The occurrence key is unique per rule (DB constraint), so a
 * retried or concurrent run never creates a second task for the same date (T054). A previously
 * cancelled occurrence (rule change) can be revived for the new version.
 */
const materialize = async (ctx: CommandContext, r: RuleRow, o: Occurrence, missedDates: string[] = []) => {
  const [existing] = await ctx.tx
    .select()
    .from(recurrenceOccurrences)
    .where(and(eq(recurrenceOccurrences.ruleId, r.id), eq(recurrenceOccurrences.occurrenceKey, o.key)))
    .for('update');
  if (existing && existing.state !== 'cancelled') return null;
  const occId = existing?.id ?? newId();
  if (!existing) {
    const inserted = await ctx.tx
      .insert(recurrenceOccurrences)
      .values({ ...stamp(ctx), id: occId, ruleId: r.id, ruleVersion: r.ruleVersion, occurrenceKey: o.key, scheduledFor: o.scheduledFor, state: 'created', missedDates })
      .onConflictDoNothing()
      .returning({ id: recurrenceOccurrences.id });
    if (inserted.length === 0) return null;
  }
  const taskId = await createTask(ctx, templateTaskBody(r, o), { source: 'recurrence', recurrenceOccurrenceId: occId });
  await ctx.tx
    .update(recurrenceOccurrences)
    .set({ taskId, state: 'created', ruleVersion: r.ruleVersion, scheduledFor: o.scheduledFor, missedDates, ...touch(ctx, recurrenceOccurrences) })
    .where(eq(recurrenceOccurrences.id, occId));
  return taskId;
};

/** One generation run for a fixed-schedule rule (idempotent). */
export const generateForRule = async (ctx: CommandContext, ruleId: string) => {
  const r = await loadRule(ctx, ruleId, true);
  if (!r.active || r.archivedAt) return { created: 0, missed: 0 };
  const [p] = await ctx.tx.select({ status: projects.status }).from(projects).where(eq(projects.id, r.projectId));
  if (!p || p.status === 'archived') return { created: 0, missed: 0 };
  const now = ctx.app.clock.now();
  let created = 0;
  let missedCount = 0;
  if (r.mode === 'after_completion') {
    const [any] = await ctx.tx.select({ id: recurrenceOccurrences.id }).from(recurrenceOccurrences).where(eq(recurrenceOccurrences.ruleId, r.id)).limit(1);
    if (!any) {
      const first = nextOccurrence(specOf(r), new Date(Math.max(now.getTime(), r.createdAt.getTime()) - 1));
      if (first && (await materialize(ctx, r, first))) created++;
    }
  } else {
    const plan = planGeneration(specOf(r), { now, lastGeneratedThrough: r.lastGeneratedThrough, horizonDays: r.horizonDays, backfillLimit: r.backfillLimit, ruleCreatedAt: r.createdAt });
    const missedKeys = plan.missed.map((m) => m.key);
    for (const m of plan.missed) {
      const ins = await ctx.tx
        .insert(recurrenceOccurrences)
        .values({ ...stamp(ctx), id: newId(), ruleId: r.id, ruleVersion: r.ruleVersion, occurrenceKey: m.key, scheduledFor: m.scheduledFor, state: 'missed' })
        .onConflictDoNothing()
        .returning({ id: recurrenceOccurrences.id });
      missedCount += ins.length;
    }
    const lastOverdue = plan.create.filter((c) => c.overdue).at(-1);
    for (const o of plan.create) {
      const taskId = await materialize(ctx, r, o, o === lastOverdue ? missedKeys : []);
      if (taskId) created++;
    }
    await ctx.tx.update(recurrenceRules).set({ lastGeneratedThrough: plan.generatedThrough }).where(eq(recurrenceRules.id, r.id));
  }
  if (created || missedCount) {
    await audit(ctx, { action: 'recurrence.generated', entityType: 'recurrence_rule', entityId: r.id, projectId: r.projectId, metadata: { created, missed: missedCount } });
    await emit(ctx, { type: 'recurrence.generated', entityType: 'recurrence_rule', entityId: r.id, payload: { created, missed: missedCount } });
  }
  return { created, missed: missedCount };
};

/** "After completion" rules create the next occurrence when the current task is closed. */
export const onRecurringTaskClosed = async (ctx: CommandContext, t: typeof tasks.$inferSelect) => {
  if (!t.recurrenceOccurrenceId) return;
  const [o] = await ctx.tx.select().from(recurrenceOccurrences).where(eq(recurrenceOccurrences.id, t.recurrenceOccurrenceId));
  if (!o) return;
  const [r] = await ctx.tx.select().from(recurrenceRules).where(eq(recurrenceRules.id, o.ruleId)).for('update');
  if (!r || r.mode !== 'after_completion' || !r.active || r.archivedAt) return;
  const next = nextAfterCompletion(specOf(r), ctx.app.clock.now());
  if (r.endsOn && next.localDate > r.endsOn) return;
  const sys = await systemJobContext(ctx.app, ctx.actor.workspaceId, ['tasks.read', 'tasks.create', 'tasks.assign', 'tasks.edit']);
  await materialize({ ...sys, tx: ctx.tx, emitted: ctx.emitted }, r, next);
};

const ruleValues = (input: RecurrenceInput) => ({
  ...(input.template ? { template: normalizeTemplate(input.template) } : {}),
  ...(input.cadence ? { cadence: input.cadence } : {}),
  ...(input.intervalCount !== undefined ? { intervalCount: input.intervalCount } : {}),
  ...(input.weekdays !== undefined ? { weekdays: [...new Set(input.weekdays)].sort() } : {}),
  ...(input.monthDay !== undefined ? { monthDay: input.monthDay } : {}),
  ...(input.monthDayPolicy ? { monthDayPolicy: input.monthDayPolicy } : {}),
  ...(input.localTime ? { localTime: input.localTime } : {}),
  ...(input.timezone ? { timezone: input.timezone } : {}),
  ...(input.mode ? { mode: input.mode } : {}),
  ...(input.startsOn ? { startsOn: input.startsOn } : {}),
  ...(input.endsOn !== undefined ? { endsOn: input.endsOn } : {}),
  ...(input.horizonDays !== undefined ? { horizonDays: input.horizonDays } : {}),
  ...(input.backfillLimit !== undefined ? { backfillLimit: input.backfillLimit } : {}),
});

export const createRecurrence = async (ctx: CommandContext, input: Required<Pick<RecurrenceInput, 'projectId' | 'template' | 'cadence' | 'localTime' | 'timezone' | 'startsOn'>> & RecurrenceInput) => {
  requirePermission(ctx, 'tasks.create');
  const [p] = await ctx.tx.select().from(projects).where(and(eq(projects.workspaceId, ctx.actor.workspaceId), eq(projects.id, input.projectId)));
  if (!p) throw fieldFail('projectId', 'NOT_FOUND', 'Choose a project you can access.');
  if (!allowed(ctx, 'tasks.create', { projectId: p.id })) throw new AppError('FORBIDDEN', 'You cannot create recurring tasks in this project.');
  if (p.status === 'archived') throw new AppError('INVALID_STATE', 'Archived projects accept no new tasks.');
  const me = ctx.actor.membershipId;
  const t = normalizeTemplate(input.template);
  if (((t.assigneeMembershipId && t.assigneeMembershipId !== me) || (t.reviewerMembershipId && t.reviewerMembershipId !== me)) && !allowed(ctx, 'tasks.assign', { projectId: p.id }))
    throw new AppError('FORBIDDEN', 'You cannot assign recurring tasks to other members.');
  if (t.assigneeMembershipId && t.assigneeMembershipId === t.reviewerMembershipId) throw fieldFail('template.reviewerMembershipId', 'SAME_AS_ASSIGNEE', 'The reviewer must be someone other than the assignee.');
  const id = newId();
  const values = {
    ...stamp(ctx),
    id,
    projectId: p.id,
    ownerMembershipId: me ?? p.ownerMembershipId,
    template: t,
    cadence: input.cadence,
    intervalCount: input.intervalCount ?? 1,
    weekdays: [...new Set(input.weekdays ?? [])].sort(),
    monthDay: input.monthDay ?? null,
    monthDayPolicy: input.monthDayPolicy ?? 'last_day_of_month',
    localTime: input.localTime,
    timezone: input.timezone,
    mode: input.mode ?? 'fixed_schedule',
    startsOn: input.startsOn,
    endsOn: input.endsOn ?? null,
    horizonDays: input.horizonDays ?? 30,
    backfillLimit: input.backfillLimit ?? 0,
  } as const;
  validateSpec(specOf(values as unknown as RuleRow));
  const [row] = await ctx.tx.insert(recurrenceRules).values(values).returning();
  await audit(ctx, { action: 'recurrence.created', entityType: 'recurrence_rule', entityId: id, projectId: p.id, diff: diffFields(null, row!, ['cadence', 'intervalCount', 'weekdays', 'monthDay', 'monthDayPolicy', 'localTime', 'timezone', 'mode', 'startsOn', 'endsOn']) });
  await emit(ctx, { type: 'recurrence.created', entityType: 'recurrence_rule', entityId: id, revision: 1 });
  // Validate the assignee through the first real task creation (access checks live in createTask).
  await generateForRule(ctx, id);
  return id;
};

interface RuleDiff {
  updated: { id: string; title: string | null; status: null; readable: boolean }[];
  cancelled: { id: string; title: string | null; status: null; readable: boolean }[];
  created: { key: string; scheduledFor: string }[];
  startedUnaffected: number;
}

/**
 * Diff of a rule change: future not-started instances whose date stays are updated in place,
 * future not-started instances that no longer match are cancelled, new dates are created. Work
 * already started (or completed) is never touched.
 */
const computeDiff = async (ctx: QueryContext | CommandContext, r: RuleRow, next: RuleRow) => {
  const now = ctx.app.clock.now();
  const future = await dbOf(ctx)
    .select({ o: recurrenceOccurrences, t: tasks })
    .from(recurrenceOccurrences)
    .innerJoin(tasks, eq(tasks.id, recurrenceOccurrences.taskId))
    .where(and(eq(recurrenceOccurrences.ruleId, r.id), eq(recurrenceOccurrences.state, 'created'), gt(recurrenceOccurrences.scheduledFor, now)));
  const logged = future.length
    ? await dbOf(ctx)
        .select({ taskId: timeEntries.taskId })
        .from(timeEntries)
        .where(inArray(timeEntries.taskId, future.map((f) => f.t.id)))
    : [];
  const withTime = new Set(logged.map((l) => l.taskId));
  const notStarted = future.filter((f) => (NOT_STARTED_STATUSES as readonly string[]).includes(f.t.status) && !withTime.has(f.t.id));
  const started = future.length - notStarted.length;
  const horizonEnd = new Date(now.getTime() + Math.min(30, next.horizonDays) * 86_400_000);
  const nextOcc = next.active && next.mode === 'fixed_schedule' ? occurrencesBetween(specOf(next), new Date(now.getTime() + 1), horizonEnd, 500) : [];
  const nextKeys = new Map(nextOcc.map((o) => [o.key, o]));
  const existingKeys = new Set(future.map((f) => f.o.occurrenceKey));
  const updated = notStarted.filter((f) => nextKeys.has(f.o.occurrenceKey));
  const cancelled = notStarted.filter((f) => !nextKeys.has(f.o.occurrenceKey));
  const created = nextOcc.filter((o) => !existingKeys.has(o.key));
  const ref = (t: typeof tasks.$inferSelect) => ({ id: t.id, title: t.title, status: null, readable: true });
  return {
    diff: { updated: updated.map((u) => ref(u.t)), cancelled: cancelled.map((c) => ref(c.t)), created: created.map((c) => ({ key: c.key, scheduledFor: c.scheduledFor.toISOString() })), startedUnaffected: started } as RuleDiff,
    updated,
    cancelled,
    nextKeys,
  };
};

const mergedRule = (r: RuleRow, input: RecurrenceInput): RuleRow => ({ ...r, ...ruleValues(input) }) as RuleRow;

export const previewRecurrenceChange = async (ctx: QueryContext, id: string, input: RecurrenceInput) => {
  const r = await loadRule(ctx, id);
  authorizeObject(ctx, 'tasks.create', ruleScope(r), 'tasks.read');
  const next = mergedRule(r, input);
  validateSpec(specOf(next));
  return (await computeDiff(ctx, r, next)).diff;
};

export const updateRecurrence = async (ctx: CommandContext, id: string, input: RecurrenceInput) => {
  const r = await loadRule(ctx, id, true);
  authorizeObject(ctx, 'tasks.create', ruleScope(r), 'tasks.read');
  assertVersion(ctx, r);
  if (r.archivedAt) throw new AppError('INVALID_STATE', 'Archived rules cannot change.');
  const t = input.template;
  const me = ctx.actor.membershipId;
  if (t && ((t.assigneeMembershipId && t.assigneeMembershipId !== me && t.assigneeMembershipId !== r.template.assigneeMembershipId) || (t.reviewerMembershipId && t.reviewerMembershipId !== me && t.reviewerMembershipId !== r.template.reviewerMembershipId)) && !allowed(ctx, 'tasks.assign', ruleScope(r)))
    throw new AppError('FORBIDDEN', 'You cannot assign recurring tasks to other members.');
  const next = mergedRule(r, input);
  validateSpec(specOf(next));
  const { diff, updated, cancelled, nextKeys } = await computeDiff(ctx, r, next);
  const at = ctx.app.clock.now();
  const [row] = await ctx.tx
    .update(recurrenceRules)
    .set({ ...ruleValues(input), ruleVersion: r.ruleVersion + 1, lastGeneratedThrough: at, ...touch(ctx, recurrenceRules) })
    .where(eq(recurrenceRules.id, id))
    .returning();
  const sys = await systemJobContext(ctx.app, ctx.actor.workspaceId, ['tasks.read', 'tasks.create', 'tasks.assign', 'tasks.edit']);
  const sysCtx: CommandContext = { ...sys, tx: ctx.tx, emitted: ctx.emitted, request: ctx.request };
  for (const u of updated) {
    const o = nextKeys.get(u.o.occurrenceKey)!;
    const body = templateTaskBody(row!, o);
    const dueAt = new Date(body.due!.kind === 'datetime' ? body.due!.at : 0);
    const [task] = await ctx.tx
      .update(tasks)
      .set({
        title: body.title,
        description: body.description ?? null,
        priority: body.priority ?? 'normal',
        assigneeMembershipId: body.assigneeMembershipId ?? null,
        reviewerMembershipId: body.reviewerMembershipId ?? null,
        estimateMinutes: body.estimateMinutes ?? null,
        dueAt,
        dueDate: null,
        dueTimezone: row!.timezone,
        ...touch(ctx, tasks),
      })
      .where(eq(tasks.id, u.t.id))
      .returning();
    if (dueAt.getTime() !== u.t.dueAt?.getTime()) await recordDueChange(ctx, u.t, dueAt, 'Recurring rule changed');
    await ctx.tx.update(recurrenceOccurrences).set({ ruleVersion: row!.ruleVersion, scheduledFor: o.scheduledFor }).where(eq(recurrenceOccurrences.id, u.o.id));
    await indexTask(ctx, task!);
    await emit(ctx, { type: 'task.updated', entityType: 'task', entityId: task!.id, revision: task!.rowVersion });
  }
  for (const c of cancelled) {
    await transitionTask(sysCtx, c.t.id, { targetState: 'cancelled', reason: 'The recurring schedule changed.', successorPolicy: 'keep_blocked' }, { skipVersion: true });
    await ctx.tx.update(recurrenceOccurrences).set({ state: 'cancelled' }).where(eq(recurrenceOccurrences.id, c.o.id));
  }
  await audit(ctx, {
    action: 'recurrence.updated',
    entityType: 'recurrence_rule',
    entityId: id,
    projectId: r.projectId,
    diff: diffFields(r, row!, ['cadence', 'intervalCount', 'weekdays', 'monthDay', 'monthDayPolicy', 'localTime', 'timezone', 'mode', 'startsOn', 'endsOn', 'horizonDays', 'backfillLimit']),
    metadata: { ruleVersion: row!.ruleVersion, updated: diff.updated.length, cancelled: diff.cancelled.length, created: diff.created.length },
  });
  await emit(ctx, { type: 'recurrence.updated', entityType: 'recurrence_rule', entityId: id, revision: row!.rowVersion });
  await generateForRule(ctx, id);
  return { id, diff };
};

export const setRecurrenceActive = async (ctx: CommandContext, id: string, active: boolean) => {
  const r = await loadRule(ctx, id, true);
  authorizeObject(ctx, 'tasks.create', ruleScope(r), 'tasks.read');
  assertVersion(ctx, r);
  if (r.archivedAt) throw new AppError('INVALID_STATE', 'Archived rules cannot be resumed.');
  if (r.active === active) return id;
  const at = ctx.app.clock.now();
  // Resuming never backfills the paused period: generation continues from now.
  await ctx.tx
    .update(recurrenceRules)
    .set({ active, ...(active ? { lastGeneratedThrough: at } : {}), ...touch(ctx, recurrenceRules) })
    .where(eq(recurrenceRules.id, id));
  await audit(ctx, { action: active ? 'recurrence.resumed' : 'recurrence.paused', entityType: 'recurrence_rule', entityId: id, projectId: r.projectId });
  await emit(ctx, { type: 'recurrence.updated', entityType: 'recurrence_rule', entityId: id });
  if (active) await generateForRule(ctx, id);
  return id;
};

export const archiveRecurrence = async (ctx: CommandContext, id: string, input: { cancelFutureInstances?: boolean; reason?: string }) => {
  const r = await loadRule(ctx, id, true);
  authorizeObject(ctx, 'tasks.create', ruleScope(r), 'tasks.read');
  assertVersion(ctx, r);
  if (r.archivedAt) return id;
  const at = ctx.app.clock.now();
  await ctx.tx
    .update(recurrenceRules)
    .set({ archivedAt: at, archivedBy: ctx.actor.userId, archiveReason: input.reason ?? null, active: false, ...touch(ctx, recurrenceRules) })
    .where(eq(recurrenceRules.id, id));
  if (input.cancelFutureInstances) {
    const { cancelled } = await computeDiff(ctx, r, { ...r, active: false });
    const sys = await systemJobContext(ctx.app, ctx.actor.workspaceId, ['tasks.read', 'tasks.create', 'tasks.assign', 'tasks.edit']);
    const sysCtx: CommandContext = { ...sys, tx: ctx.tx, emitted: ctx.emitted, request: ctx.request };
    for (const c of cancelled) {
      await transitionTask(sysCtx, c.t.id, { targetState: 'cancelled', reason: 'The recurring rule was archived.', successorPolicy: 'keep_blocked' }, { skipVersion: true });
      await ctx.tx.update(recurrenceOccurrences).set({ state: 'cancelled' }).where(eq(recurrenceOccurrences.id, c.o.id));
    }
  }
  await audit(ctx, { action: 'recurrence.archived', entityType: 'recurrence_rule', entityId: id, projectId: r.projectId, reason: input.reason });
  await emit(ctx, { type: 'recurrence.archived', entityType: 'recurrence_rule', entityId: id });
  return id;
};

/** Scheduled generation across workspaces; each rule runs in its own transaction. */
export const runRecurrenceGeneration = async (app: QueryContext['app']) => {
  const rules = await app.db
    .select({ id: recurrenceRules.id, workspaceId: recurrenceRules.workspaceId })
    .from(recurrenceRules)
    .where(and(eq(recurrenceRules.active, true), isNull(recurrenceRules.archivedAt)))
    .limit(5000);
  let created = 0;
  let missed = 0;
  for (const r of rules) {
    const base = await systemJobContext(app, r.workspaceId, ['tasks.read', 'tasks.create', 'tasks.assign', 'tasks.edit']);
    try {
      const res = await executeSystemCommand(base, (ctx) => generateForRule(ctx, r.id));
      created += res.created;
      missed += res.missed;
    } catch (e) {
      // One broken rule (e.g. an assignee who lost access) must not stop the others.
      app.logger.warn('recurrence_generation_failed', { ruleId: r.id, error: e instanceof Error ? e.message : 'unknown' });
    }
  }
  return { rules: rules.length, created, missed };
};

defineJob('work.recurrence', 'light', async ({ app }) => runRecurrenceGeneration(app));
defineSchedule({ name: 'work.recurrence', everySeconds: 900, jobType: 'work.recurrence' });

