import { and, asc, count, desc, eq, gt, gte, inArray, lt, lte, ne, or, sql, type SQL } from 'drizzle-orm';
import { hasAnywhere } from '@castlane/authorization';
import { tasks } from '@castlane/database';
import { localDate, localDateRangeToUtc } from '@castlane/domain';
import type { QueryContext } from '../core/context';
import { dbOf } from '../core/context';
import { OPEN_TASK_STATUSES } from './rules/task-status';
import { listReminders } from './reminders';
import { taskFilterSql, toTaskRows } from './task-read';
import { currentTimer } from './time';

/**
 * My Work (S09): the member's own actionable tasks by section. Today is computed in the member's
 * personal time zone; Following never grants access (the task scope filter applies to every
 * section); an unassigned task never appears in Assigned to Me.
 */
export const getMyWork = async (ctx: QueryContext, input: { limit: number }) => {
  const me = ctx.actor.membershipId;
  const tz = ctx.actor.timezone;
  const now = ctx.app.clock.now();
  const today = localDate(now, tz);
  const { end: endOfToday } = localDateRangeToUtc(today, today, tz);
  const weekAhead = new Date(endOfToday.getTime() + 7 * 86_400_000);
  const canRead = hasAnywhere(ctx.actor.access, 'tasks.read');
  const empty = { items: [], total: 0 };
  const [reminders, timer] = [await listReminders(ctx, {}), hasAnywhere(ctx.actor.access, 'time.write.own') ? (await currentTimer(ctx)).timer : null];
  if (!canRead || !me)
    return { timezone: tz, today, canReadTasks: canRead, sections: { today: empty, upcoming: empty, overdue: empty, assigned: empty, reviewing: empty, following: empty }, reminders, timer };
  const scope = taskFilterSql(ctx, {});
  const open = inArray(tasks.status, [...OPEN_TASK_STATUSES]);
  const mine = eq(tasks.assigneeMembershipId, me);
  const section = async (where: SQL, order: SQL[]) => {
    const cond = and(scope, open, where)!;
    const [rows, [n]] = [
      await dbOf(ctx).select().from(tasks).where(cond).orderBy(...order).limit(input.limit),
      await dbOf(ctx).select({ n: count() }).from(tasks).where(cond),
    ];
    return { items: await toTaskRows(ctx, rows), total: Number(n?.n ?? 0) };
  };
  const byDue = [asc(sql`coalesce(${tasks.dueAt}, 'infinity'::timestamptz)`), asc(tasks.id)];
  return {
    timezone: tz,
    today,
    canReadTasks: true,
    sections: {
      today: await section(and(mine, gte(tasks.dueAt, now), lt(tasks.dueAt, endOfToday))!, byDue),
      upcoming: await section(and(mine, gte(tasks.dueAt, endOfToday), lte(tasks.dueAt, weekAhead))!, byDue),
      overdue: await section(and(mine, lt(tasks.dueAt, now))!, byDue),
      assigned: await section(mine, [desc(sql`(${tasks.status} = 'in_progress')`), ...byDue]),
      reviewing: await section(eq(tasks.reviewerMembershipId, me), [desc(sql`(${tasks.status} = 'in_review')`), ...byDue]),
      following: await section(
        and(sql`${me}::uuid = ANY(${tasks.followerMembershipIds})`, or(ne(tasks.assigneeMembershipId, me), sql`${tasks.assigneeMembershipId} IS NULL`))!,
        [desc(tasks.updatedAt), asc(tasks.id)],
      ),
    },
    reminders,
    timer,
  };
};

