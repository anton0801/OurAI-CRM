import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { countOf, durationStats, percentValue, unavailable, type MetricValue } from '@castlane/analytics';
import { comments, contentFlagIntervals, contentItems, planBaselineItems, planBaselines, publications, reviews, socialAccounts, tasks } from '@castlane/database';
import { dbOf } from '../../core/context';
import { filterSql, insightWorkspace, memo, type Ctx } from '../common';
import { defineInsightMetric, type BaseRec, type InsightQuery } from './registry';
import { asOfOf, hoursBetween, inWindow, scopeFor, toDate } from './sources';

/**
 * Production metrics M01–M10 (§16) — publications, content production, reviews, tasks and plan
 * baselines, read directly from the production tables. Scope is part of every query.
 */

const PERM = 'analytics.production.read';
export const qKey = (q: InsightQuery) => JSON.stringify([q.period.start, q.period.end, q.asOf, q.filters, q.checkpointKey ?? null]);
/** Window, as-of and filters only: sources that do not depend on the checkpoint share one load per request. */
export const periodKey = (q: InsightQuery) => JSON.stringify([q.period.start, q.period.end, q.asOf, q.filters]);

// ——— Publications ———

export interface PubRec extends BaseRec {
  id: string;
}

export const loadPublished = (ctx: Ctx, q: InsightQuery, permission = PERM) =>
  memo(ctx, `published:${permission}:${periodKey(q)}`, async (): Promise<PubRec[]> => {
    const p = publications;
    const a = socialAccounts;
    const c = contentItems;
    const format = sql<string>`coalesce(${p.format}, ${c.format})`;
    const rows = await dbOf(ctx)
      .select({ id: p.id, projectId: p.projectId, accountId: p.accountId, platform: a.platform, format, memberId: p.ownerMembershipId, campaignId: p.primaryCampaignId, at: p.actualPublishedAt })
      .from(p)
      .innerJoin(a, and(eq(a.id, p.accountId), eq(a.workspaceId, p.workspaceId)))
      .innerJoin(c, and(eq(c.id, p.contentItemId), eq(c.workspaceId, p.workspaceId)))
      .where(
        and(
          eq(p.workspaceId, ctx.actor.workspaceId),
          eq(p.status, 'published'),
          isNull(p.deletedAt),
          inWindow(p.actualPublishedAt, q),
          scopeFor(ctx, permission, { projectId: p.projectId, accountId: p.accountId }),
          ...filterSql(ctx, q.filters, { projectId: p.projectId, accountId: p.accountId, platform: a.platform, format, memberId: p.ownerMembershipId, campaignId: p.primaryCampaignId }),
        ),
      );
    return rows.map((r) => ({ ...r, publicationId: r.id }));
  });

defineInsightMetric<PubRec>({
  id: 'M01',
  key: 'published_count',
  label: 'Published',
  description: 'Unique publications confirmed as Published with the actual publication time in the period. One material placed on two accounts counts as two publications.',
  unit: 'count',
  higherIsBetter: true,
  family: 'production',
  permission: PERM,
  dimensions: ['period', 'project', 'direction', 'account', 'platform', 'format', 'member', 'campaign'],
  grains: ['day', 'week', 'month', 'quarter'],
  additive: true,
  zeroWhenEmpty: true,
  load: (ctx, q) => loadPublished(ctx, q),
  reduce: (rs) => countOf(rs.length),
  drill: { readPermission: 'publications.read', ref: (r) => ({ entityType: 'publication', id: r.id, projectId: r.projectId ?? null, accountId: r.accountId ?? null, at: r.at ?? null, value: null }) },
  sourceAt: (r) => r.at ?? null,
});

// ——— Content production ———

interface ContentRec extends BaseRec {
  id: string;
  firstApprovedAt: Date | null;
  enteredReadyAt: Date | null;
}

const loadFirstApproved = (ctx: Ctx, q: InsightQuery) =>
  memo(ctx, `firstApproved:${qKey(q)}`, async (): Promise<ContentRec[]> => {
    const c = contentItems;
    const rows = await dbOf(ctx)
      .select({ id: c.id, projectId: c.projectId, format: c.format, memberId: c.ownerMembershipId, stage: c.stage, firstApprovedAt: c.firstApprovedAt, enteredReadyAt: c.enteredReadyAt })
      .from(c)
      .where(
        and(
          eq(c.workspaceId, ctx.actor.workspaceId),
          isNull(c.deletedAt),
          inWindow(c.firstApprovedAt, q),
          scopeFor(ctx, PERM, { projectId: c.projectId }),
          ...filterSql(ctx, q.filters, { projectId: c.projectId, format: c.format, memberId: c.ownerMembershipId }),
        ),
      );
    return rows.map((r) => ({ ...r, at: r.firstApprovedAt }));
  });

const contentDrill = { readPermission: 'content.read', ref: (r: ContentRec) => ({ entityType: 'content_item', id: r.id, projectId: r.projectId ?? null, accountId: null, at: r.at ?? null, value: null }) };

defineInsightMetric<ContentRec>({
  id: 'M02',
  key: 'produced_content',
  label: 'Produced Content',
  description: 'Unique content items that received their first approval in the period. Approving a new version of already approved content does not count again.',
  unit: 'count',
  higherIsBetter: true,
  family: 'production',
  permission: PERM,
  dimensions: ['period', 'project', 'direction', 'format', 'member'],
  grains: ['day', 'week', 'month', 'quarter'],
  additive: true,
  zeroWhenEmpty: true,
  load: loadFirstApproved,
  reduce: (rs) => countOf(rs.length),
  drill: contentDrill,
  sourceAt: (r) => r.firstApprovedAt,
});

const WIP_STAGES = ['ready', 'production', 'review', 'changes_requested'];

interface WipRec extends BaseRec {
  id: string;
  blocked: boolean;
}

/** Stage of each content item at the as-of time (stage events; current state when as-of is now). */
const loadWip = (ctx: Ctx, q: InsightQuery) =>
  memo(ctx, `wip:${qKey(q)}`, async (): Promise<WipRec[]> => {
    const asOf = asOfOf(ctx, q);
    const current = ctx.app.clock.now().getTime() - asOf.getTime() < 60_000;
    const c = contentItems;
    const ws = ctx.actor.workspaceId;
    const where = and(
      eq(c.workspaceId, ws),
      isNull(c.deletedAt),
      sql`${c.createdAt} <= ${asOf}`,
      sql`(${c.archivedAt} IS NULL OR ${c.archivedAt} > ${asOf})`,
      scopeFor(ctx, PERM, { projectId: c.projectId }),
      ...filterSql(ctx, q.filters, { projectId: c.projectId, format: c.format, memberId: c.ownerMembershipId }),
    );
    const stageAt = current
      ? sql<string>`${c.stage}`
      : sql<string>`coalesce((SELECT e.to_stage FROM content_stage_events e WHERE e.workspace_id = ${c.workspaceId} AND e.content_item_id = ${c.id} AND e.occurred_at <= ${asOf} ORDER BY e.occurred_at DESC LIMIT 1),
          CASE WHEN EXISTS (SELECT 1 FROM content_stage_events e2 WHERE e2.workspace_id = ${c.workspaceId} AND e2.content_item_id = ${c.id}) THEN 'idea' ELSE ${c.stage} END)`;
    const rows = await dbOf(ctx).select({ id: c.id, projectId: c.projectId, format: c.format, memberId: c.ownerMembershipId, stage: stageAt }).from(c).where(where);
    const wip = rows.filter((r) => WIP_STAGES.includes(r.stage));
    const ids = wip.map((r) => r.id);
    const blocked = new Set<string>();
    if (ids.length) {
      const f = contentFlagIntervals;
      const b = await dbOf(ctx)
        .select({ id: f.contentItemId })
        .from(f)
        .where(and(eq(f.workspaceId, ws), inArray(f.contentItemId, ids), eq(f.flag, 'blocked'), sql`${f.startedAt} <= ${asOf}`, sql`(${f.endedAt} IS NULL OR ${f.endedAt} > ${asOf})`));
      for (const r of b) blocked.add(r.id);
      if (current) {
        const cur = await dbOf(ctx).select({ id: c.id }).from(c).where(and(eq(c.workspaceId, ws), inArray(c.id, ids), sql`${c.blockedAt} IS NOT NULL`));
        for (const r of cur) blocked.add(r.id);
      }
    }
    return wip.map((r) => ({ ...r, blocked: blocked.has(r.id), at: null }));
  });

defineInsightMetric<WipRec>({
  id: 'M03',
  key: 'current_wip',
  label: 'Current WIP',
  description: 'Content in Ready, Production, Review or Changes Requested at the as-of time (end of the period, or now). Archived content is excluded; blocked items are shown separately.',
  unit: 'count',
  family: 'production',
  permission: PERM,
  dimensions: ['project', 'direction', 'format', 'member', 'stage'],
  grains: [],
  additive: true,
  zeroWhenEmpty: true,
  load: loadWip,
  reduce: (rs) => {
    const blocked = rs.filter((r) => r.blocked).length;
    return countOf(rs.length, blocked ? { note: `Blocked: ${blocked}` } : {});
  },
  drill: { readPermission: 'content.read', ref: (r) => ({ entityType: 'content_item', id: r.id, projectId: r.projectId ?? null, accountId: null, at: null, value: r.stage ?? null }) },
});

const fmtHours = (v: MetricValue) => (v.value === null ? 'n/a' : `${v.value} h`);

defineInsightMetric<ContentRec>({
  id: 'M04',
  key: 'production_lead_time',
  label: 'Production Lead Time',
  description: 'For content approved for the first time in the period: first approval time minus the time it entered Ready. Median with p90 and sample size; items without a Ready event are excluded and counted.',
  unit: 'hours',
  higherIsBetter: false,
  family: 'production',
  permission: PERM,
  dimensions: ['period', 'project', 'direction', 'format', 'member'],
  grains: ['week', 'month', 'quarter'],
  additive: false,
  load: loadFirstApproved,
  reduce: (rs) => {
    const values = rs.filter((r) => r.enteredReadyAt && r.firstApprovedAt && r.firstApprovedAt >= r.enteredReadyAt).map((r) => hoursBetween(r.enteredReadyAt!, r.firstApprovedAt!).toFixed(4));
    const s = durationStats(values, 'hours', 1, rs.length - values.length);
    return s.sampleSize ? { ...s.median, note: `Median · p90 ${fmtHours(s.p90)}` } : s.median;
  },
  drill: contentDrill,
  sourceAt: (r) => r.firstApprovedAt,
});

// ——— Reviews ———

interface ReviewRec extends BaseRec {
  id: string;
  hours: number | null;
  pending: boolean;
}

const loadReviews = (ctx: Ctx, q: InsightQuery, permission = PERM) =>
  memo(ctx, `reviews:${permission}:${qKey(q)}`, async (): Promise<ReviewRec[]> => {
    const r = reviews;
    const asOf = asOfOf(ctx, q);
    const rows = await dbOf(ctx)
      .select({ id: r.id, projectId: r.projectId, memberId: r.reviewerMembershipId, status: r.status, submittedAt: r.submittedAt, decidedAt: r.decidedAt, format: contentItems.format })
      .from(r)
      .innerJoin(contentItems, and(eq(contentItems.id, r.subjectId), eq(contentItems.workspaceId, r.workspaceId)))
      .where(
        and(
          eq(r.workspaceId, ctx.actor.workspaceId),
          eq(r.targetType, 'content_version'),
          sql`((${r.status} IN ('approved', 'changes_requested') AND ${inWindow(r.decidedAt, q)}) OR (${r.status} = 'pending' AND ${r.submittedAt} <= ${asOf}))`,
          scopeFor(ctx, permission, { projectId: r.projectId }),
          ...filterSql(ctx, q.filters, { projectId: r.projectId, memberId: r.reviewerMembershipId, format: contentItems.format }),
        ),
      );
    return rows.map((x) => ({
      id: x.id,
      projectId: x.projectId,
      memberId: x.memberId,
      format: x.format,
      status: x.status,
      pending: x.status === 'pending',
      hours: x.decidedAt ? hoursBetween(x.submittedAt, x.decidedAt) : hoursBetween(x.submittedAt, asOf),
      at: x.decidedAt ?? x.submittedAt,
    }));
  });

defineInsightMetric<ReviewRec>({
  id: 'M05',
  key: 'review_turnaround',
  label: 'Review Turnaround',
  description: 'Completed review rounds in the period: decision time minus submission time. Median with p90; reviews still waiting are shown separately.',
  unit: 'hours',
  higherIsBetter: false,
  family: 'production',
  permission: PERM,
  dimensions: ['period', 'project', 'direction', 'member', 'format'],
  grains: ['week', 'month', 'quarter'],
  additive: false,
  load: (ctx, q) => loadReviews(ctx, q),
  reduce: (rs) => {
    const done = rs.filter((r) => !r.pending && r.hours !== null && r.hours >= 0).map((r) => r.hours!.toFixed(4));
    const waiting = rs.filter((r) => r.pending);
    const s = durationStats(done, 'hours', 1);
    const oldest = waiting.length ? Math.max(...waiting.map((w) => w.hours ?? 0)) : 0;
    const wait = waiting.length ? ` · Waiting now: ${waiting.length} (oldest ${oldest.toFixed(1)} h)` : '';
    return s.sampleSize ? { ...s.median, note: `Median · p90 ${fmtHours(s.p90)}${wait}` } : { ...s.median, note: wait ? wait.slice(3) : undefined };
  },
  drill: { readPermission: 'content.read', ref: () => null },
  sourceAt: (r) => r.at ?? null,
});

interface ReworkRec extends BaseRec {
  id: string;
  decided: boolean;
  changes: boolean;
}

defineInsightMetric<ReworkRec>({
  id: 'M06',
  key: 'rework_rate',
  label: 'Rework Rate',
  description: 'Content first submitted for review in the period: items with at least one Request Changes ÷ items with at least one completed review round × 100. Items still waiting for a first decision are listed separately.',
  unit: 'percent',
  rate: true,
  higherIsBetter: false,
  family: 'production',
  permission: PERM,
  dimensions: ['period', 'project', 'direction', 'format', 'member'],
  grains: ['week', 'month', 'quarter'],
  additive: false,
  load: (ctx, q) =>
    memo(ctx, `rework:${qKey(q)}`, async () => {
      const ws = ctx.actor.workspaceId;
      const scope = scopeFor(ctx, PERM, { projectId: sql`c.project_id` as never });
      const filters = filterSql(ctx, q.filters, { projectId: sql`c.project_id`, format: sql`c.format`, memberId: sql`c.owner_membership_id` });
      const rows = await dbOf(ctx).execute<{ id: string; project_id: string; format: string; owner: string | null; first_submitted: Date; decided: boolean; changes: boolean }>(sql`
        SELECT c.id, c.project_id, c.format, c.owner_membership_id AS owner, x.first_submitted, x.decided, x.changes
        FROM (
          SELECT r.subject_id, min(r.submitted_at) AS first_submitted,
                 bool_or(r.status IN ('approved', 'changes_requested')) AS decided,
                 bool_or(r.status = 'changes_requested') AS changes
          FROM reviews r WHERE r.workspace_id = ${ws} AND r.target_type = 'content_version'
          GROUP BY r.subject_id
        ) x
        JOIN content_items c ON c.id = x.subject_id AND c.workspace_id = ${ws}
        WHERE c.deleted_at IS NULL AND x.first_submitted >= ${q.period.start} AND x.first_submitted < ${q.period.end}
          ${scope ? sql`AND ${scope}` : sql``}
          ${filters.length ? sql`AND ${sql.join(filters, sql` AND `)}` : sql``}`);
      return rows.rows.map((r) => ({ id: r.id, projectId: r.project_id, format: r.format, memberId: r.owner, decided: r.decided, changes: r.changes, at: toDate(r.first_submitted) }));
    }),
  reduce: (rs) => {
    const decided = rs.filter((r) => r.decided);
    const unresolved = rs.length - decided.length;
    if (!rs.length) return unavailable('no_data', 'percent');
    if (!decided.length) return unavailable('pending', 'percent', { note: `Unresolved: ${unresolved}`, sampleSize: 0 });
    const v = percentValue(decided.filter((r) => r.changes).length, decided.length, 2, { sampleSize: decided.length });
    return unresolved ? { ...v, note: `Unresolved: ${unresolved}` } : v;
  },
  drill: { readPermission: 'content.read', ref: (r) => ({ entityType: 'content_item', id: r.id, projectId: r.projectId ?? null, accountId: null, at: r.at ?? null, value: r.changes ? 'Changes requested' : r.decided ? 'Approved' : 'Unresolved' }) },
});

// ——— Tasks ———

interface TaskRec extends BaseRec {
  id: string;
  onTime: boolean;
  cancelled: boolean;
  blocked: boolean;
  reopened?: boolean;
}

const taskDrill = { readPermission: 'tasks.read', ref: (r: TaskRec) => ({ entityType: 'task', id: r.id, projectId: r.projectId ?? null, accountId: r.accountId ?? null, at: r.at ?? null, value: r.status ?? null }) };

export const loadBaselineCohort = (ctx: Ctx, q: InsightQuery, permission = PERM) =>
  memo(ctx, `tasksBaseline:${permission}:${qKey(q)}`, async (): Promise<TaskRec[]> => {
    const t = tasks;
    const rows = await dbOf(ctx)
      .select({
        id: t.id,
        projectId: t.projectId,
        accountId: t.accountId,
        memberId: t.assigneeMembershipId,
        status: t.status,
        priority: t.priority,
        baselineDueAt: t.baselineDueAt,
        completedAt: sql<Date | null>`coalesce(${t.completionEffectiveAt}, ${t.completedAt})`,
        blockedAt: t.blockedAt,
      })
      .from(t)
      .where(
        and(
          eq(t.workspaceId, ctx.actor.workspaceId),
          isNull(t.deletedAt),
          inWindow(t.baselineDueAt, q),
          scopeFor(ctx, permission, { projectId: t.projectId, accountId: t.accountId }),
          ...filterSql(ctx, q.filters, { projectId: t.projectId, accountId: t.accountId, memberId: t.assigneeMembershipId, status: t.status }),
        ),
      );
    return rows.map((r) => {
      const completed = toDate(r.completedAt);
      return {
        id: r.id,
        projectId: r.projectId,
        accountId: r.accountId,
        memberId: r.memberId,
        status: r.status,
        priority: r.priority,
        at: r.baselineDueAt,
        onTime: r.status === 'done' && !!completed && !!r.baselineDueAt && completed <= r.baselineDueAt,
        cancelled: r.status === 'cancelled',
        blocked: !!r.blockedAt,
      };
    });
  });

export const onTimeReduce = (rs: TaskRec[]): MetricValue => {
  if (!rs.length) return unavailable('no_data', 'percent');
  const cancelled = rs.filter((r) => r.cancelled).length;
  const v = percentValue(rs.filter((r) => r.onTime).length, rs.length, 2, { sampleSize: rs.length });
  return cancelled ? { ...v, note: `Includes ${cancelled} cancelled after the baseline` } : v;
};

defineInsightMetric<TaskRec>({
  id: 'M07',
  key: 'task_on_time_rate',
  label: 'Task On-Time Rate',
  description: 'Tasks whose baseline due date is in the period: Done with completion at or before the baseline ÷ all of them × 100. Unfinished and cancelled-after-baseline tasks stay in the denominator; tasks cancelled before a baseline existed are not in the cohort.',
  unit: 'percent',
  rate: true,
  higherIsBetter: true,
  family: 'production',
  permission: PERM,
  dimensions: ['period', 'project', 'direction', 'account', 'member', 'priority'],
  grains: ['week', 'month', 'quarter'],
  additive: false,
  load: (ctx, q) => loadBaselineCohort(ctx, q),
  reduce: onTimeReduce,
  drill: taskDrill,
  sourceAt: (r) => r.at ?? null,
});

const loadOverdue = (ctx: Ctx, q: InsightQuery) =>
  memo(ctx, `overdue:${qKey(q)}`, async (): Promise<TaskRec[]> => {
    const t = tasks;
    const asOf = asOfOf(ctx, q);
    const rows = await dbOf(ctx)
      .select({ id: t.id, projectId: t.projectId, accountId: t.accountId, memberId: t.assigneeMembershipId, status: t.status, priority: t.priority, dueAt: t.dueAt, blockedAt: t.blockedAt })
      .from(t)
      .where(
        and(
          eq(t.workspaceId, ctx.actor.workspaceId),
          isNull(t.deletedAt),
          sql`${t.dueAt} < ${asOf}`,
          sql`${t.createdAt} <= ${asOf}`,
          sql`(${t.completedAt} IS NULL OR ${t.completedAt} > ${asOf})`,
          sql`(${t.cancelledAt} IS NULL OR ${t.cancelledAt} > ${asOf})`,
          sql`(${t.status} NOT IN ('done', 'cancelled') OR ${t.completedAt} > ${asOf} OR ${t.cancelledAt} > ${asOf})`,
          scopeFor(ctx, PERM, { projectId: t.projectId, accountId: t.accountId }),
          ...filterSql(ctx, q.filters, { projectId: t.projectId, accountId: t.accountId, memberId: t.assigneeMembershipId }),
        ),
      );
    return rows.map((r) => ({ id: r.id, projectId: r.projectId, accountId: r.accountId, memberId: r.memberId, status: r.status, priority: r.priority, at: r.dueAt, onTime: false, cancelled: false, blocked: !!r.blockedAt }));
  });

defineInsightMetric<TaskRec>({
  id: 'M08',
  key: 'overdue_tasks',
  label: 'Overdue Tasks',
  description: 'Open tasks whose deadline is before the as-of time (end of the period, or now), excluding Done and Cancelled. Drill down returns the exact list.',
  unit: 'count',
  higherIsBetter: false,
  family: 'production',
  permission: PERM,
  dimensions: ['project', 'direction', 'account', 'member', 'priority', 'status'],
  grains: [],
  additive: true,
  zeroWhenEmpty: true,
  load: loadOverdue,
  reduce: (rs) => {
    const blocked = rs.filter((r) => r.blocked).length;
    return countOf(rs.length, blocked ? { note: `Blocked: ${blocked}` } : {});
  },
  drill: taskDrill,
});

// ——— Plan completion ———

interface PlanRec extends BaseRec {
  id: string;
  onTime: boolean;
  removed: boolean;
}

defineInsightMetric<PlanRec>({
  id: 'M09',
  key: 'plan_completion',
  label: 'Publication Plan Completion',
  description: 'Weekly plan baselines (frozen Monday 00:00): placements with a baseline time in the period published no later than the baseline time + grace ÷ all baseline placements × 100. Placements moved, removed or cancelled after the freeze stay in the denominator.',
  unit: 'percent',
  rate: true,
  higherIsBetter: true,
  family: 'production',
  permission: PERM,
  dimensions: ['period', 'project', 'direction', 'account', 'platform'],
  grains: ['week', 'month', 'quarter'],
  additive: false,
  load: (ctx, q) =>
    memo(ctx, `plan:${qKey(q)}`, async () => {
      const i = planBaselineItems;
      const p = publications;
      const a = socialAccounts;
      const ws = await insightWorkspace(ctx);
      const rows = await dbOf(ctx)
        .select({
          id: i.publicationId,
          projectId: i.projectId,
          accountId: i.accountId,
          platform: a.platform,
          at: i.baselineScheduledAt,
          removedAt: i.removedAfterBaselineAt,
          status: p.status,
          actual: p.actualPublishedAt,
        })
        .from(i)
        .innerJoin(planBaselines, and(eq(planBaselines.id, i.baselineId), eq(planBaselines.workspaceId, i.workspaceId)))
        .innerJoin(p, and(eq(p.id, i.publicationId), eq(p.workspaceId, i.workspaceId)))
        .innerJoin(a, and(eq(a.id, i.accountId), eq(a.workspaceId, i.workspaceId)))
        .where(
          and(
            eq(i.workspaceId, ctx.actor.workspaceId),
            eq(i.addedAfterBaseline, false),
            inWindow(i.baselineScheduledAt, q),
            scopeFor(ctx, PERM, { projectId: i.projectId, accountId: i.accountId }),
            ...filterSql(ctx, q.filters, { projectId: i.projectId, accountId: i.accountId, platform: a.platform }),
          ),
        );
      const grace = ws.publicationGraceMinutes * 60_000;
      return rows.map((r) => ({
        id: r.id,
        projectId: r.projectId,
        accountId: r.accountId,
        platform: r.platform,
        at: r.at,
        onTime: r.status === 'published' && !!r.actual && !!r.at && r.actual.getTime() <= r.at.getTime() + grace,
        removed: !!r.removedAt || r.status === 'cancelled',
      }));
    }),
  reduce: (rs, q) => {
    if (!rs.length) return unavailable('no_data', 'percent', { note: 'No weekly plan baseline covers this period.' });
    const removed = rs.filter((r) => r.removed).length;
    const partialWeek = !isWeekAligned(q);
    const notes = [removed ? `Removed or cancelled after the baseline: ${removed} (kept in the plan)` : null, partialWeek ? 'Partial Week at the period boundary' : null].filter(Boolean);
    const v = percentValue(rs.filter((r) => r.onTime).length, rs.length, 2, { sampleSize: rs.length });
    return notes.length ? { ...v, note: notes.join(' · ') } : v;
  },
  drill: { readPermission: 'publications.read', ref: (r) => ({ entityType: 'publication', id: r.id, projectId: r.projectId ?? null, accountId: r.accountId ?? null, at: r.at ?? null, value: r.onTime ? 'On plan' : r.removed ? 'Removed after baseline' : 'Not on plan' }) },
});

const isWeekAligned = (q: InsightQuery) => {
  const days = (q.period.end.getTime() - q.period.start.getTime()) / 86_400_000;
  const start = new Date(q.period.start);
  const localDow = new Intl.DateTimeFormat('en-US', { timeZone: q.period.zone, weekday: 'short' }).format(start);
  return localDow === 'Mon' && Math.abs(days - Math.round(days / 7) * 7) < 0.05;
};

defineInsightMetric<PlanRec>({
  id: 'M10',
  key: 'current_plan_completion',
  label: 'Current Plan Completion',
  description: 'Publications currently planned in the period (scheduled time in the period, not cancelled): Published ÷ current plan × 100. Shown next to the baseline plan completion (M09), never instead of it.',
  unit: 'percent',
  rate: true,
  higherIsBetter: true,
  family: 'production',
  permission: PERM,
  dimensions: ['period', 'project', 'direction', 'account', 'platform', 'format', 'member'],
  grains: ['week', 'month', 'quarter'],
  additive: false,
  load: (ctx, q) =>
    memo(ctx, `currentPlan:${qKey(q)}`, async () => {
      const p = publications;
      const a = socialAccounts;
      const c = contentItems;
      const format = sql<string>`coalesce(${p.format}, ${c.format})`;
      const rows = await dbOf(ctx)
        .select({ id: p.id, projectId: p.projectId, accountId: p.accountId, platform: a.platform, format, memberId: p.ownerMembershipId, at: p.scheduledAt, status: p.status })
        .from(p)
        .innerJoin(a, and(eq(a.id, p.accountId), eq(a.workspaceId, p.workspaceId)))
        .innerJoin(c, and(eq(c.id, p.contentItemId), eq(c.workspaceId, p.workspaceId)))
        .where(
          and(
            eq(p.workspaceId, ctx.actor.workspaceId),
            isNull(p.deletedAt),
            inArray(p.status, ['scheduled', 'published', 'failed']),
            inWindow(p.scheduledAt, q),
            scopeFor(ctx, PERM, { projectId: p.projectId, accountId: p.accountId }),
            ...filterSql(ctx, q.filters, { projectId: p.projectId, accountId: p.accountId, platform: a.platform, format, memberId: p.ownerMembershipId }),
          ),
        );
      return rows.map((r) => ({ id: r.id, projectId: r.projectId, accountId: r.accountId, platform: r.platform, format: r.format, memberId: r.memberId, at: r.at, onTime: r.status === 'published', removed: false }));
    }),
  reduce: (rs) => (rs.length ? percentValue(rs.filter((r) => r.onTime).length, rs.length, 2, { sampleSize: rs.length }) : unavailable('no_data', 'percent')),
  drill: { readPermission: 'publications.read', ref: (r) => ({ entityType: 'publication', id: r.id, projectId: r.projectId ?? null, accountId: r.accountId ?? null, at: r.at ?? null, value: r.onTime ? 'Published' : 'Not published' }) },
});

export { loadReviews, loadFirstApproved };
export type { TaskRec, ReviewRec };

// ——— Task comments (report builder: facts reduced per metric, never multiplied by joins — T115) ———

interface CommentRec extends BaseRec {
  id: string;
  taskId: string;
}

defineInsightMetric<CommentRec>({
  id: 'X10',
  key: 'task_comments',
  label: 'Task Comments',
  description: 'Comments written on tasks in the period (removed comments excluded), attributed to the task’s project, assignee, status and priority.',
  unit: 'count',
  family: 'production',
  permission: PERM,
  dimensions: ['period', 'project', 'direction', 'account', 'member', 'priority', 'status'],
  grains: ['day', 'week', 'month', 'quarter'],
  additive: true,
  zeroWhenEmpty: true,
  load: (ctx, q) =>
    memo(ctx, `taskComments:${qKey(q)}`, async () => {
      const t = tasks;
      return dbOf(ctx)
        .select({ id: comments.id, taskId: t.id, projectId: t.projectId, accountId: t.accountId, memberId: t.assigneeMembershipId, status: t.status, priority: t.priority, at: comments.createdAt })
        .from(comments)
        .innerJoin(t, and(eq(t.id, comments.parentId), eq(t.workspaceId, comments.workspaceId)))
        .where(
          and(
            eq(comments.workspaceId, ctx.actor.workspaceId),
            eq(comments.parentType, 'task'),
            isNull(comments.deletedAt),
            isNull(t.deletedAt),
            inWindow(comments.createdAt, q),
            scopeFor(ctx, PERM, { projectId: t.projectId, accountId: t.accountId }),
            ...filterSql(ctx, q.filters, { projectId: t.projectId, accountId: t.accountId, memberId: t.assigneeMembershipId, status: t.status }),
          ),
        );
    }),
  reduce: (rs) => countOf(rs.length),
  drill: { readPermission: 'tasks.read', ref: (r) => ({ entityType: 'task', id: r.taskId, projectId: r.projectId ?? null, accountId: r.accountId ?? null, at: r.at ?? null, value: null }) },
});
