import { and, asc, eq, gt, inArray, isNotNull, isNull, lt, lte, ne, or, sql } from 'drizzle-orm';
import { personalReminders, tasks } from '@castlane/database';
import { entityHref, type ReminderView } from '@castlane/api-contracts';
import { AppError, newId, notFound } from '@castlane/domain';
import { allowed, authorizeRead } from '../core/access';
import { audit } from '../core/audit';
import { dbOf, type CommandContext, type QueryContext } from '../core/context';
import { emit } from '../core/events';
import { defineJob, defineSchedule, memberJobContext, systemJobContext } from '../core/jobs-registry';
import { executeSystemCommand } from '../core/command';
import { notify } from '../core/notify';
import { stamp, touch } from '../core/rows';
import { OPEN_TASK_STATUSES } from './rules/task-status';
import { deadlineRevisions, fieldFail, loadTask, memberCan, taskScope } from './shared';

type ReminderRow = typeof personalReminders.$inferSelect;

/** Thresholds of automatic task due reminders (spec §20: 24 h and 1 h before; overdue at the deadline). */
export const DUE_THRESHOLDS = [
  { key: '24h', beforeMs: 24 * 3_600_000, label: 'Due in 24 hours' },
  { key: '1h', beforeMs: 3_600_000, label: 'Due in 1 hour' },
  { key: 'overdue', beforeMs: 0, label: 'Overdue' },
] as const;

const effectiveAt = (r: Pick<ReminderRow, 'remindAt' | 'snoozedUntil'>) => r.snoozedUntil ?? r.remindAt;

/** Cancel future reminders of a task when it is completed or cancelled. */
export const dismissTaskReminders = async (ctx: CommandContext, taskId: string, reason: string) => {
  await ctx.tx
    .update(personalReminders)
    .set({ dismissedAt: ctx.app.clock.now(), dismissedReason: reason, ...touch(ctx, personalReminders) })
    .where(and(eq(personalReminders.workspaceId, ctx.actor.workspaceId), eq(personalReminders.entityType, 'task'), eq(personalReminders.entityId, taskId), isNull(personalReminders.dismissedAt)));
};

/** A rescheduled deadline makes due reminders of older deadline revisions stale (T143). */
export const dismissStaleDueReminders = async (ctx: CommandContext, taskId: string, currentRevision: number) => {
  await ctx.tx
    .update(personalReminders)
    .set({ dismissedAt: ctx.app.clock.now(), dismissedReason: 'deadline_changed', ...touch(ctx, personalReminders) })
    .where(
      and(
        eq(personalReminders.workspaceId, ctx.actor.workspaceId),
        eq(personalReminders.entityType, 'task'),
        eq(personalReminders.entityId, taskId),
        eq(personalReminders.source, 'due'),
        lt(personalReminders.deadlineRevision, currentRevision),
        isNull(personalReminders.dismissedAt),
      ),
    );
};

export const toReminderViews = async (ctx: QueryContext | CommandContext, rows: ReminderRow[]): Promise<ReminderView[]> => {
  const taskIds = rows.filter((r) => r.entityType === 'task').map((r) => r.entityId);
  const taskRows = taskIds.length
    ? await dbOf(ctx).select().from(tasks).where(and(eq(tasks.workspaceId, ctx.actor.workspaceId), inArray(tasks.id, taskIds)))
    : [];
  const byId = new Map(taskRows.map((t) => [t.id, t]));
  return rows.map((r) => {
    const t = r.entityType === 'task' ? byId.get(r.entityId) : undefined;
    const readable = !!t && !t.deletedAt && allowed(ctx, 'tasks.read', taskScope(t));
    return {
      id: r.id,
      entityType: r.entityType,
      entityId: r.entityId,
      title: readable ? t!.title : null,
      href: readable ? entityHref(ctx.actor.workspaceId, r.entityType, r.entityId) : null,
      source: r.source,
      threshold: r.threshold,
      remindAt: r.remindAt.toISOString(),
      snoozedUntil: r.snoozedUntil?.toISOString() ?? null,
      effectiveAt: effectiveAt(r).toISOString(),
      firedAt: r.firedAt?.toISOString() ?? null,
      note: r.note,
      entityDueAt: readable && t!.dueAt ? t!.dueAt.toISOString() : null,
      rowVersion: r.rowVersion,
    };
  });
};

/** Own active reminders: due now (fired or past) and upcoming within 7 days. */
export const listReminders = async (ctx: QueryContext, input: { entityType?: string; entityId?: string; horizonDays?: number }) => {
  const me = ctx.actor.membershipId;
  if (!me) return [];
  const until = new Date(ctx.app.clock.now().getTime() + (input.horizonDays ?? 7) * 86_400_000);
  const rows = await dbOf(ctx)
    .select()
    .from(personalReminders)
    .where(
      and(
        eq(personalReminders.workspaceId, ctx.actor.workspaceId),
        eq(personalReminders.membershipId, me),
        isNull(personalReminders.dismissedAt),
        input.entityType ? eq(personalReminders.entityType, input.entityType) : undefined,
        input.entityId ? eq(personalReminders.entityId, input.entityId) : undefined,
        input.entityId ? undefined : lte(sql`coalesce(${personalReminders.snoozedUntil}, ${personalReminders.remindAt})`, until),
      ),
    )
    .orderBy(asc(sql`coalesce(${personalReminders.snoozedUntil}, ${personalReminders.remindAt})`))
    .limit(200);
  return (await toReminderViews(ctx, rows)).filter((r) => r.title !== null);
};

export const createReminder = async (ctx: CommandContext, input: { entityType: 'task'; entityId: string; remindAt: string; note?: string }) => {
  const me = ctx.actor.membershipId;
  if (!me) throw new AppError('FORBIDDEN', 'Only members can set reminders.');
  const t = await loadTask(ctx, input.entityId);
  authorizeRead(ctx, 'tasks.read', taskScope(t));
  const at = new Date(input.remindAt);
  if (at.getTime() <= ctx.app.clock.now().getTime()) throw fieldFail('remindAt', 'MUST_BE_FUTURE', 'Choose a future date and time.');
  const id = newId();
  const [row] = await ctx.tx
    .insert(personalReminders)
    .values({ ...stamp(ctx), id, membershipId: me, entityType: 'task', entityId: t.id, remindAt: at, note: input.note?.trim() || null, source: 'manual' })
    .returning();
  await emit(ctx, { type: 'personal_reminder.created', entityType: 'personal_reminder', entityId: id });
  return (await toReminderViews(ctx, [row!]))[0]!;
};

const lockOwnReminder = async (ctx: CommandContext, id: string) => {
  const [r] = await ctx.tx
    .select()
    .from(personalReminders)
    .where(and(eq(personalReminders.workspaceId, ctx.actor.workspaceId), eq(personalReminders.id, id)))
    .for('update');
  // Someone else's reminder does not exist for this member.
  if (!r || r.membershipId !== ctx.actor.membershipId) throw notFound('Reminder');
  return r;
};

/** Snooze moves only the member's own reminder; the task deadline is never touched. */
export const snoozeReminder = async (ctx: CommandContext, id: string, until: string) => {
  const r = await lockOwnReminder(ctx, id);
  if (r.dismissedAt) throw new AppError('INVALID_STATE', 'This reminder was dismissed.');
  const u = new Date(until);
  if (u.getTime() <= ctx.app.clock.now().getTime()) throw fieldFail('until', 'MUST_BE_FUTURE', 'Choose a future date and time.');
  const [row] = await ctx.tx.update(personalReminders).set({ snoozedUntil: u, ...touch(ctx, personalReminders) }).where(eq(personalReminders.id, id)).returning();
  await audit(ctx, { action: 'reminder.snoozed', entityType: r.entityType, entityId: r.entityId, metadata: { reminderId: id, until: u.toISOString() } });
  await emit(ctx, { type: 'personal_reminder.snoozed', entityType: 'personal_reminder', entityId: id });
  return (await toReminderViews(ctx, [row!]))[0]!;
};

export const dismissReminder = async (ctx: CommandContext, id: string) => {
  const r = await lockOwnReminder(ctx, id);
  if (!r.dismissedAt)
    await ctx.tx.update(personalReminders).set({ dismissedAt: ctx.app.clock.now(), dismissedReason: 'dismissed', ...touch(ctx, personalReminders) }).where(eq(personalReminders.id, id));
  await emit(ctx, { type: 'personal_reminder.dismissed', entityType: 'personal_reminder', entityId: id });
  return { ok: true as const };
};

// ——— Background work ———

/**
 * Due reminders: for every open, assigned task with a deadline inside the reminder window, only the
 * nearest threshold already reached is sent (a task created 30 min before its deadline gets the
 * 1 h reminder, not the missed 24 h one). Keys include the deadline revision, so a rescheduled
 * deadline makes older reminders stale and they never send (T143).
 */
export const runDueReminders = async (app: QueryContext['app']) => {
  const now = app.clock.now();
  const rows = await app.db
    .select()
    .from(tasks)
    .where(
      and(
        inArray(tasks.status, [...OPEN_TASK_STATUSES]),
        isNotNull(tasks.assigneeMembershipId),
        isNotNull(tasks.dueAt),
        isNull(tasks.deletedAt),
        isNull(tasks.archivedAt),
        lte(tasks.dueAt, new Date(now.getTime() + 24 * 3_600_000)),
        gt(tasks.dueAt, new Date(now.getTime() - 2 * 86_400_000)),
      ),
    )
    .limit(5000);
  const revs = await deadlineRevisions(app.db, rows.map((r) => r.id));
  const candidates = rows.map((task) => ({ task, rev: revs.get(task.id) ?? 0 }));
  const byWs = new Map<string, typeof candidates>();
  for (const c of candidates) byWs.set(c.task.workspaceId, [...(byWs.get(c.task.workspaceId) ?? []), c]);
  let sent = 0;
  for (const [workspaceId, list] of byWs) {
    const base = await systemJobContext(app, workspaceId, ['tasks.read']);
    await executeSystemCommand(base, async (ctx) => {
      for (const { task: t, rev } of list) {
        const due = t.dueAt!.getTime();
        const reached = [...DUE_THRESHOLDS].reverse().find((th) => now.getTime() >= due - th.beforeMs);
        if (!reached) continue;
        const revision = Number(rev);
        const inserted = await ctx.tx
          .insert(personalReminders)
          .values({
            ...stamp(ctx),
            id: newId(),
            membershipId: t.assigneeMembershipId!,
            entityType: 'task',
            entityId: t.id,
            remindAt: new Date(due - reached.beforeMs),
            firedAt: now,
            source: 'due',
            threshold: reached.key,
            deadlineRevision: revision,
          })
          .onConflictDoNothing()
          .returning({ id: personalReminders.id });
        if (inserted.length === 0) continue;
        // Only the nearest reminder stays visible in My Work.
        await ctx.tx
          .update(personalReminders)
          .set({ dismissedAt: now, dismissedReason: 'superseded' })
          .where(
            and(
              eq(personalReminders.entityType, 'task'),
              eq(personalReminders.entityId, t.id),
              eq(personalReminders.membershipId, t.assigneeMembershipId!),
              eq(personalReminders.source, 'due'),
              ne(personalReminders.id, inserted[0]!.id),
              isNull(personalReminders.dismissedAt),
            ),
          );
        const created = await notify(ctx.tx, {
          workspaceId,
          recipientMembershipIds: [t.assigneeMembershipId!],
          eventType: reached.key === 'overdue' ? 'task.overdue' : 'task.due_soon',
          eventKey: `task.due:${t.id}:r${revision}:${reached.key}`,
          kind: 'due_reminder',
          title: `${reached.label}: ${t.title}`,
          entityType: 'task',
          entityId: t.id,
          projectId: t.projectId,
          at: now,
          excludeActor: false,
        });
        sent += created;
        // Automation triggers task.due_soon / task.overdue keyed by deadline revision + threshold.
        await emit(ctx, {
          type: reached.key === 'overdue' ? 'task.overdue' : 'task.due_soon',
          entityType: 'task',
          entityId: t.id,
          payload: { deadlineRevision: revision, threshold: reached.key, projectId: t.projectId, key: `${t.id}:${revision}:${reached.key}` },
        });
      }
    });
  }
  return { candidates: candidates.length, sent };
};

/** Manual and snoozed reminders whose time has come: one in-app notification per effective time. */
export const runPersonalReminders = async (app: QueryContext['app']) => {
  const now = app.clock.now();
  const due = await app.db
    .select()
    .from(personalReminders)
    .where(
      and(
        isNull(personalReminders.dismissedAt),
        lte(sql`coalesce(${personalReminders.snoozedUntil}, ${personalReminders.remindAt})`, now),
        or(isNull(personalReminders.firedAt), lt(personalReminders.firedAt, sql`coalesce(${personalReminders.snoozedUntil}, ${personalReminders.remindAt})`)),
      ),
    )
    .limit(2000);
  let sent = 0;
  for (const r of due) {
    const [t] = await app.db.select().from(tasks).where(and(eq(tasks.workspaceId, r.workspaceId), eq(tasks.id, r.entityId)));
    const closed = !t || !!t.deletedAt || t.status === 'done' || t.status === 'cancelled';
    // The member must still be able to read the task; otherwise the reminder is retired silently.
    const access = t && !closed ? await memberCan(app.db, r.workspaceId, r.membershipId, 'tasks.read', taskScope(t), now) : { ok: false };
    const base = await systemJobContext(app, r.workspaceId, ['tasks.read']);
    await executeSystemCommand(base, async (ctx) => {
      if (closed || !access.ok) {
        await ctx.tx
          .update(personalReminders)
          .set({ dismissedAt: now, dismissedReason: closed ? 'closed' : 'access_revoked' })
          .where(eq(personalReminders.id, r.id));
        return;
      }
      const when = effectiveAt(r);
      sent += await notify(ctx.tx, {
        workspaceId: r.workspaceId,
        recipientMembershipIds: [r.membershipId],
        eventType: 'reminder.due',
        eventKey: `reminder:${r.id}:${when.toISOString()}`,
        kind: 'due_reminder',
        title: `Reminder: ${t!.title}`,
        excerpt: r.note,
        entityType: 'task',
        entityId: t!.id,
        projectId: t!.projectId,
        at: now,
        excludeActor: false,
      });
      await ctx.tx.update(personalReminders).set({ firedAt: now }).where(eq(personalReminders.id, r.id));
    });
  }
  return { due: due.length, sent };
};

defineJob('work.reminders', 'light', async ({ app }) => {
  const a = await runDueReminders(app);
  const b = await runPersonalReminders(app);
  return { ...a, personal: b };
});
defineSchedule({ name: 'work.reminders', everySeconds: 300, jobType: 'work.reminders' });

