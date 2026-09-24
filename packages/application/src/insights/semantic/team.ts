import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import Big from 'big.js';
import { countOf, known, percentValue, unavailable } from '@castlane/analytics';
import { absences, capacities, tasks, timeEntries } from '@castlane/database';
import { ROUND_HALF_EVEN, eachIsoDate } from '@castlane/domain';
import { dbOf } from '../../core/context';
import { capacityOn } from '../../work/rules/workload';
import { filterSql, memo, type Ctx } from '../common';
import { loadBaselineCohort, loadReviews, onTimeReduce, qKey, type ReviewRec, type TaskRec } from './production';
import { defineInsightMetric, type BaseRec, type InsightQuery } from './registry';
import { dateBounds, inWindow, localMidnight, scopeFor, toDate } from './sources';

/**
 * Team metrics (Team Dashboard): delivery, reviews, approved time and utilization per member —
 * shown side by side, never combined into one "performance" score across professions.
 */

const PERM = 'analytics.team.read';

defineInsightMetric<TaskRec>({
  id: 'X02',
  key: 'tasks_completed',
  label: 'Tasks Completed',
  description: 'Unique tasks whose last valid Done falls in the period (by the assignee at completion). Reopened tasks are counted separately.',
  unit: 'count',
  higherIsBetter: true,
  family: 'team',
  permission: PERM,
  dimensions: ['period', 'project', 'direction', 'account', 'member', 'priority'],
  grains: ['day', 'week', 'month', 'quarter'],
  additive: true,
  zeroWhenEmpty: true,
  load: (ctx, q) =>
    memo(ctx, `tasksDone:${qKey(q)}`, async () => {
      const t = tasks;
      const member = sql<string | null>`coalesce(${t.assigneeAtCompletion}, ${t.assigneeMembershipId})`;
      const completed = sql<Date>`coalesce(${t.completionEffectiveAt}, ${t.completedAt})`;
      const rows = await dbOf(ctx)
        .select({ id: t.id, projectId: t.projectId, accountId: t.accountId, memberId: member, priority: t.priority, at: completed, reopenCount: t.reopenCount })
        .from(t)
        .where(
          and(
            eq(t.workspaceId, ctx.actor.workspaceId),
            isNull(t.deletedAt),
            eq(t.status, 'done'),
            inWindow(completed, q),
            scopeFor(ctx, PERM, { projectId: t.projectId, accountId: t.accountId }),
            ...filterSql(ctx, q.filters, { projectId: t.projectId, accountId: t.accountId, memberId: member }),
          ),
        );
      return rows.map((r) => ({ id: r.id, projectId: r.projectId, accountId: r.accountId, memberId: r.memberId, priority: r.priority, status: 'done', at: toDate(r.at), onTime: false, cancelled: false, blocked: false, reopened: r.reopenCount > 0 }));
    }),
  reduce: (rs) => {
    const reopened = rs.filter((r) => r.reopened).length;
    return countOf(rs.length, reopened ? { note: `Reopened at least once: ${reopened}` } : {});
  },
  drill: { readPermission: 'tasks.read', ref: (r) => ({ entityType: 'task', id: r.id, projectId: r.projectId ?? null, accountId: r.accountId ?? null, at: r.at ?? null, value: null }) },
  sourceAt: (r) => r.at ?? null,
});

defineInsightMetric<TaskRec>({
  id: 'X09',
  key: 'team_on_time_rate',
  label: 'On-Time Delivery',
  description: 'Task On-Time Rate (M07) for the team view: tasks whose baseline due date is in the period, Done by the baseline ÷ all of them × 100.',
  unit: 'percent',
  rate: true,
  higherIsBetter: true,
  family: 'team',
  permission: PERM,
  dimensions: ['period', 'project', 'direction', 'member', 'priority'],
  grains: ['week', 'month', 'quarter'],
  additive: false,
  load: (ctx, q) => loadBaselineCohort(ctx, q, PERM),
  reduce: onTimeReduce,
  drill: { readPermission: 'tasks.read', ref: (r) => ({ entityType: 'task', id: r.id, projectId: r.projectId ?? null, accountId: r.accountId ?? null, at: r.at ?? null, value: r.onTime ? 'On time' : (r.status ?? null) }) },
});

defineInsightMetric<ReviewRec>({
  id: 'X04',
  key: 'reviews_decided',
  label: 'Reviews Decided',
  description: 'Content review rounds decided (approved or changes requested) in the period, by reviewer.',
  unit: 'count',
  family: 'team',
  permission: PERM,
  dimensions: ['period', 'project', 'direction', 'member', 'format'],
  grains: ['day', 'week', 'month', 'quarter'],
  additive: true,
  zeroWhenEmpty: true,
  load: async (ctx, q) => (await loadReviews(ctx, q, PERM)).filter((r) => !r.pending),
  reduce: (rs) => countOf(rs.length),
});

interface TimeRec extends BaseRec {
  id: string;
  seconds: number;
}

const loadApprovedTime = (ctx: Ctx, q: InsightQuery) =>
  memo(ctx, `approvedTime:${qKey(q)}`, async (): Promise<TimeRec[]> => {
    const t = timeEntries;
    const b = dateBounds(q);
    const rows = await dbOf(ctx)
      .select({ id: t.id, projectId: t.projectId, memberId: t.membershipId, workDate: t.workDate, seconds: t.durationSeconds })
      .from(t)
      .where(
        and(
          eq(t.workspaceId, ctx.actor.workspaceId),
          eq(t.state, 'approved'),
          isNull(t.supersededAt),
          sql`${t.workDate} >= ${b.from} AND ${t.workDate} <= ${b.to}`,
          scopeFor(ctx, PERM, { projectId: t.projectId }),
          ...filterSql(ctx, q.filters, { projectId: t.projectId, memberId: t.membershipId }),
        ),
      );
    return rows.map((r) => ({ id: r.id, projectId: r.projectId, memberId: r.memberId, at: localMidnight(r.workDate, q.period.zone), seconds: r.seconds ?? 0 }));
  });

defineInsightMetric<TimeRec>({
  id: 'X03',
  key: 'approved_hours',
  label: 'Approved Hours',
  description: 'Approved time entries by work date in the period (tracked time only; no screenshots or activity monitoring).',
  unit: 'hours',
  family: 'team',
  permission: PERM,
  dimensions: ['period', 'project', 'direction', 'member'],
  grains: ['day', 'week', 'month', 'quarter'],
  additive: true,
  zeroWhenEmpty: true,
  load: loadApprovedTime,
  reduce: (rs) => known(new Big(rs.reduce((a, r) => a + r.seconds, 0)).div(3600).round(2, ROUND_HALF_EVEN).toFixed(2), 'hours', { sampleSize: rs.length }),
  drill: { readPermission: ['time.read.scope', 'time.approve'], ref: (r) => ({ entityType: 'time_entry', id: r.id, projectId: r.projectId ?? null, accountId: null, at: r.at ?? null, value: (r.seconds / 3600).toFixed(2) }) },
});

interface DayRec extends BaseRec {
  seconds: number;
  /** Available minutes that day (schedule − approved absence); null when no capacity profile is set. */
  availableMinutes: number | null;
}

defineInsightMetric<DayRec>({
  id: 'M32',
  key: 'utilization',
  label: 'Utilization',
  description: 'Approved tracked hours ÷ available capacity hours × 100 per member (capacity = confirmed weekly schedule − approved absences). Not a productivity score; may exceed 100. Members without a capacity schedule are excluded, never counted as zero.',
  unit: 'percent',
  rate: true,
  family: 'team',
  permission: PERM,
  dimensions: ['period', 'member'],
  grains: ['week', 'month', 'quarter'],
  additive: false,
  load: (ctx, q) =>
    memo(ctx, `utilization:${qKey(q)}`, async (): Promise<DayRec[]> => {
      const entries = await loadApprovedTime(ctx, q);
      const members = [...new Set(entries.map((e) => e.memberId).filter((m): m is string => !!m))];
      if (!members.length) return [];
      const b = dateBounds(q);
      const db = dbOf(ctx);
      const ws = ctx.actor.workspaceId;
      const [profiles, abs] = [
        await db.select().from(capacities).where(and(eq(capacities.workspaceId, ws), inArray(capacities.membershipId, members))),
        await db
          .select()
          .from(absences)
          .where(and(eq(absences.workspaceId, ws), inArray(absences.membershipId, members), eq(absences.state, 'approved'), sql`${absences.startDate} <= ${b.to} AND ${absences.endDate} >= ${b.from}`)),
      ];
      const dates = eachIsoDate(b.from, b.to);
      const out: DayRec[] = [];
      for (const m of members) {
        const prof = profiles.filter((p) => p.membershipId === m).map((p) => ({ effectiveFrom: p.effectiveFrom, weekdayMinutes: p.weekdayMinutes }));
        const absent = new Set(abs.filter((a) => a.membershipId === m).flatMap((a) => eachIsoDate(a.startDate < b.from ? b.from : a.startDate, a.endDate > b.to ? b.to : a.endDate)));
        const secondsBy = new Map<string, number>();
        for (const e of entries.filter((x) => x.memberId === m)) {
          const k = e.at!.toISOString();
          secondsBy.set(k, (secondsBy.get(k) ?? 0) + e.seconds);
        }
        for (const d of dates) {
          const at = localMidnight(d, q.period.zone);
          const cap = capacityOn(prof, d);
          out.push({ memberId: m, at, seconds: secondsBy.get(at.toISOString()) ?? 0, availableMinutes: cap === null ? null : absent.has(d) ? 0 : cap });
        }
      }
      return out;
    }),
  reduce: (rs) => {
    if (!rs.length) return unavailable('no_data', 'percent');
    const members = new Set(rs.map((r) => r.memberId));
    const withCapacity = rs.filter((r) => r.availableMinutes !== null);
    const missingMembers = [...members].filter((m) => !withCapacity.some((r) => r.memberId === m)).length;
    const excluded = missingMembers ? [{ count: missingMembers, reason: 'No capacity schedule' }] : undefined;
    if (!withCapacity.length) return unavailable('not_measured', 'percent', { excluded, note: 'No capacity schedule is set for these members.' });
    const seconds = withCapacity.reduce((a, r) => a + r.seconds, 0);
    const minutes = withCapacity.reduce((a, r) => a + (r.availableMinutes ?? 0), 0);
    return { ...percentValue(new Big(seconds).div(60), minutes, 1, { sampleSize: members.size - missingMembers }), excluded };
  },
});
