import { and, asc, count, desc, eq, gte, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { handovers, operations, projects, qualityDisputes, qualityReviews, saleCandidates, shiftBreaks, shifts } from '@castlane/database';
import { handoverCompletionPercent, netHoursString, shiftNetTime } from '@castlane/domain';
import { allowed, requirePermission, scopePredicate } from '../core/access';
import { all, type QueryContext } from '../core/context';
import { loadMemberRefs, refOrUnknown } from '../core/members';
import { anyOf, me } from './common';
import { listSwaps } from './shifts';
import { profileRows, projectIdsFor } from './profiles';
import { canReadReview } from './quality';
import { confirmedSales, handoverSummaries, handoverVisibility, operationVisibility, pendingSales, saleVisibility, shiftSummaries, shiftVisibility } from './views';

/**
 * OFM Overview (S40): KPIs computed from real records inside the actor's scope (scope applied in SQL
 * before aggregation). Unknown values stay null with their coverage — never 0. "Active" means a CRM
 * shift timer is running, not that anyone is online on an external platform.
 */

const DAY = 86_400_000;

export const ofmOverview = async (ctx: QueryContext, input: { projectId?: string; from?: string; to?: string }) => {
  requirePermission(ctx, 'ofm.overview.read');
  const db = ctx.app.db;
  const ws = ctx.actor.workspaceId;
  const now = ctx.app.clock.now();
  const to = input.to ? new Date(input.to) : now;
  const from = input.from ? new Date(input.from) : new Date(to.getTime() - 7 * DAY);
  const shiftVis = shiftVisibility(ctx);
  const projectCond = input.projectId ? eq(shifts.projectId, input.projectId) : undefined;
  const visibleProjects = projectIdsFor(ctx, 'ofm.overview.read');
  const modelsRows = await db
    .select()
    .from(projects)
    .where(
      and(
        eq(projects.workspaceId, ws),
        eq(projects.ofmEnabled, true),
        sql`${projects.type} <> 'series'`,
        isNull(projects.deletedAt),
        sql`${projects.status} <> 'archived'`,
        visibleProjects.all ? undefined : visibleProjects.ids.size ? inArray(projects.id, [...visibleProjects.ids]) : sql`false`,
        input.projectId ? eq(projects.id, input.projectId) : undefined,
      ),
    )
    .orderBy(asc(projects.name))
    .limit(50);

  const ended = and(eq(shifts.workspaceId, ws), shiftVis, projectCond, eq(shifts.state, 'ended'), gte(shifts.actualEnd, from), lt(shifts.actualEnd, to));
  const [active, reportsToReview, endedShifts, pendingEnd, followUps, handoverStats] = await all(ctx, [
    () => db.select({ n: count() }).from(shifts).where(and(eq(shifts.workspaceId, ws), shiftVis, projectCond, inArray(shifts.state, ['active', 'paused']))),
    () => db.select({ n: count() }).from(shifts).where(and(eq(shifts.workspaceId, ws), shiftVis, projectCond, eq(shifts.reportState, 'submitted'))),
    () => db.select().from(shifts).where(ended),
    () =>
      // Shifts whose scheduled end is inside the period but that still have no actual end → Pending (not 0 hours).
      db
        .select({ n: count() })
        .from(shifts)
        .where(and(eq(shifts.workspaceId, ws), shiftVis, projectCond, inArray(shifts.state, ['active', 'paused']), lt(shifts.scheduledEnd, to))),
    () =>
      db
        .select({ n: count() })
        .from(operations)
        .where(
          and(
            eq(operations.workspaceId, ws),
            operationVisibility(ctx),
            input.projectId ? eq(operations.projectId, input.projectId) : undefined,
            eq(operations.type, 'follow_up'),
            inArray(operations.status, ['open', 'in_progress', 'waiting']),
            isNull(operations.archivedAt),
          ),
        ),
    () =>
      // Handover requirement per ended shift comes from the member's assignment on the primary account.
      db
        .select({
          id: shifts.id,
          required: sql<boolean>`COALESCE((SELECT a.handover_required FROM ofm_assignments a WHERE a.account_id = shifts.primary_account_id AND a.membership_id = shifts.membership_id ORDER BY a.valid_from DESC LIMIT 1), true)`,
          submitted: sql<boolean>`EXISTS (SELECT 1 FROM handovers h WHERE h.from_shift_id = shifts.id AND h.state IN ('submitted', 'acknowledged'))`,
          acknowledged: sql<boolean>`EXISTS (SELECT 1 FROM handovers h WHERE h.from_shift_id = shifts.id AND h.state = 'acknowledged')`,
          noOpenItems: sql<boolean>`EXISTS (SELECT 1 FROM shift_report_versions v JOIN shift_reports r ON r.id = v.report_id WHERE r.shift_id = shifts.id AND v.no_open_items AND v.state <> 'draft')
            OR EXISTS (SELECT 1 FROM handovers h WHERE h.from_shift_id = shifts.id AND h.no_open_items AND h.state <> 'draft')`,
        })
        .from(shifts)
        .where(ended),
  ] as const);

  const breaks = endedShifts.length
    ? await db.select().from(shiftBreaks).where(inArray(shiftBreaks.shiftId, endedShifts.map((s) => s.id)))
    : [];
  let netSeconds = 0;
  for (const s of endedShifts) netSeconds += shiftNetTime(s.actualStart, s.actualEnd, breaks.filter((b) => b.shiftId === s.id)).netSeconds ?? 0;
  const required = handoverStats.filter((h) => h.required);
  const missing = required.filter((h) => !h.submitted && !h.noOpenItems).length;
  const needingHandover = required.filter((h) => !h.noOpenItems);
  const acknowledged = needingHandover.filter((h) => h.acknowledged).length;

  const qualityCond = and(
    eq(qualityReviews.workspaceId, ws),
    inArray(qualityReviews.state, ['published', 'disputed', 'resolved']),
    isNull(qualityReviews.supersededAt),
    gte(qualityReviews.publishedAt, from),
    lt(qualityReviews.publishedAt, to),
    input.projectId ? eq(qualityReviews.projectId, input.projectId) : undefined,
    anyOf(scopePredicate(ctx, 'quality.read.scope', { projectId: qualityReviews.projectId }), eq(qualityReviews.subjectMembershipId, me(ctx)), eq(qualityReviews.reviewerMembershipId, me(ctx))),
  );
  const [quality] = await db
    .select({
      avg: sql<string | null>`AVG(${qualityReviews.totalScore})::text`,
      n: sql<string>`count(${qualityReviews.totalScore})::text`,
      noScore: sql<string>`count(*) FILTER (WHERE ${qualityReviews.totalScore} IS NULL)::text`,
    })
    .from(qualityReviews)
    .where(qualityCond);

  // Revenue summary: only with finance rights, from posted entries linked to verified candidates.
  let revenue: { source: string; confirmed: { amount: string; currency: string }[]; pendingVerification: { count: number; amounts: { amount: string; currency: string }[] } } | undefined;
  const financeAll = allowed(ctx, 'finance.read');
  const financeProject = input.projectId ? allowed(ctx, 'finance.read', { projectId: input.projectId }) : false;
  if (financeAll || financeProject) {
    const candFilter = and(
      gte(saleCandidates.occurredAt, from),
      lt(saleCandidates.occurredAt, to),
      input.projectId ? eq(saleCandidates.projectId, input.projectId) : undefined,
      saleVisibility(ctx),
    )!;
    const pend = await pendingSales(db, ws, candFilter);
    const confirmed = await confirmedSales(
      db,
      ws,
      sql`sc.occurred_at >= ${from} AND sc.occurred_at < ${to} ${input.projectId ? sql`AND sc.project_id = ${input.projectId}` : sql``}`,
    );
    revenue = { source: 'Posted financial entries created from verified sale candidates (net of refunds and fees); pending candidates are not revenue.', confirmed, pendingVerification: pend };
  }

  // Attention list.
  const grace = new Date(now.getTime() - 30 * 60_000);
  const [forgotten, notStarted, overlaps, unack, pendingReports, toReview, disputes, overdueOps] = await all(ctx, [
    () => db.select().from(shifts).where(and(eq(shifts.workspaceId, ws), shiftVis, projectCond, inArray(shifts.state, ['active', 'paused']), lt(shifts.scheduledEnd, grace))).limit(20),
    () => db.select().from(shifts).where(and(eq(shifts.workspaceId, ws), shiftVis, projectCond, eq(shifts.state, 'scheduled'), lt(shifts.scheduledEnd, now))).limit(20),
    () => db.select().from(shifts).where(and(eq(shifts.workspaceId, ws), shiftVis, projectCond, eq(shifts.needsReviewReason, 'actual_overlap'))).limit(20),
    () =>
      db
        .select({ h: handovers })
        .from(handovers)
        .innerJoin(shifts, eq(shifts.id, handovers.fromShiftId))
        .where(
          and(
            eq(handovers.workspaceId, ws),
            handoverVisibility(ctx),
            projectCond,
            or(
              eq(handovers.state, 'submitted'),
              and(eq(handovers.state, 'acknowledged'), sql`EXISTS (SELECT 1 FROM handover_items hi WHERE hi.handover_id = ${handovers.id} AND hi.state = 'open')`),
            ),
          ),
        )
        .orderBy(asc(handovers.submittedAt))
        .limit(20),
    () =>
      db
        .select()
        .from(shifts)
        .where(and(eq(shifts.workspaceId, ws), shiftVis, projectCond, eq(shifts.state, 'ended'), inArray(shifts.reportState, ['draft', 'changes_requested'])))
        .orderBy(asc(shifts.actualEnd))
        .limit(20),
    () => db.select().from(shifts).where(and(eq(shifts.workspaceId, ws), shiftVis, projectCond, eq(shifts.reportState, 'submitted'))).orderBy(asc(shifts.actualEnd)).limit(20),
    () =>
      db
        .select({ d: qualityDisputes, r: qualityReviews })
        .from(qualityDisputes)
        .innerJoin(qualityReviews, eq(qualityReviews.id, qualityDisputes.qualityReviewId))
        .where(and(eq(qualityDisputes.workspaceId, ws), eq(qualityDisputes.state, 'open'), input.projectId ? eq(qualityReviews.projectId, input.projectId) : undefined))
        .limit(20),
    () =>
      db
        .select()
        .from(operations)
        .where(
          and(
            eq(operations.workspaceId, ws),
            operationVisibility(ctx),
            input.projectId ? eq(operations.projectId, input.projectId) : undefined,
            inArray(operations.status, ['open', 'in_progress', 'waiting']),
            lt(operations.dueAt, now),
            isNull(operations.archivedAt),
          ),
        )
        .orderBy(asc(operations.dueAt))
        .limit(20),
  ] as const);
  const refs = await loadMemberRefs(db, ws, [
    ...forgotten.map((s) => s.membershipId),
    ...notStarted.map((s) => s.membershipId),
    ...overlaps.map((s) => s.membershipId),
    ...pendingReports.map((s) => s.membershipId),
    ...toReview.map((s) => s.membershipId),
    ...unack.map((u) => u.h.recipientMembershipId),
    ...disputes.map((d) => d.r.subjectMembershipId),
    ...overdueOps.map((o) => o.ownerMembershipId),
  ]);
  const attention = [
    ...forgotten.map((s) => ({ kind: 'forgotten_end' as const, title: 'Shift not ended after its scheduled end', entityType: 'shift' as const, entityId: s.id, at: s.scheduledEnd.toISOString(), member: refOrUnknown(refs, s.membershipId) })),
    ...notStarted.map((s) => ({ kind: 'not_started' as const, title: 'Scheduled shift was not started — Needs Review', entityType: 'shift' as const, entityId: s.id, at: s.scheduledEnd.toISOString(), member: refOrUnknown(refs, s.membershipId) })),
    ...overlaps.map((s) => ({ kind: 'actual_overlap' as const, title: 'Overlapping actual shift time needs review', entityType: 'shift' as const, entityId: s.id, at: s.actualStart?.toISOString() ?? null, member: refOrUnknown(refs, s.membershipId) })),
    ...unack.map((u) => ({
      kind: 'unacknowledged_handover' as const,
      title: u.h.state === 'submitted' ? 'Handover not acknowledged' : 'Handover items not accepted',
      entityType: 'handover' as const,
      entityId: u.h.id,
      at: u.h.submittedAt?.toISOString() ?? null,
      member: refOrUnknown(refs, u.h.recipientMembershipId),
    })),
    ...pendingReports.map((s) => ({ kind: 'report_pending' as const, title: s.reportState === 'changes_requested' ? 'Report changes requested' : 'Shift report not submitted', entityType: 'shift' as const, entityId: s.id, at: s.actualEnd?.toISOString() ?? null, member: refOrUnknown(refs, s.membershipId) })),
    ...toReview.map((s) => ({ kind: 'report_to_review' as const, title: 'Shift report awaiting review', entityType: 'shift' as const, entityId: s.id, at: s.actualEnd?.toISOString() ?? null, member: refOrUnknown(refs, s.membershipId) })),
    ...disputes
      .filter((d) => canReadReview(ctx, d.r))
      .map((d) => ({ kind: 'dispute_open' as const, title: 'Quality review disputed', entityType: 'quality_review' as const, entityId: d.r.id, at: d.d.createdAt.toISOString(), member: refOrUnknown(refs, d.r.subjectMembershipId) })),
    ...overdueOps.map((o) => ({ kind: 'operation_overdue' as const, title: `Overdue: ${o.title}`, entityType: 'operation' as const, entityId: o.id, at: o.dueAt?.toISOString() ?? null, member: refOrUnknown(refs, o.ownerMembershipId) })),
  ];

  return {
    period: { from: from.toISOString(), to: to.toISOString() },
    kpis: {
      assignedModels: modelsRows.length,
      activeShifts: Number(active[0]?.n ?? 0),
      missingHandover: { count: missing, requiredShifts: required.length },
      reportsToReview: Number(reportsToReview[0]?.n ?? 0),
      openFollowUps: Number(followUps[0]?.n ?? 0),
      netHours: { value: endedShifts.length ? netHoursString(netSeconds) : null, endedShifts: endedShifts.length, pendingShifts: Number(pendingEnd[0]?.n ?? 0) },
      handoverCompletion: { percent: handoverCompletionPercent(acknowledged, needingHandover.length), acknowledged, required: needingHandover.length },
      quality: { average: quality?.avg ? Number(quality.avg).toFixed(2) : null, sample: Number(quality?.n ?? 0), noScore: Number(quality?.noScore ?? 0) },
    },
    ...(revenue ? { revenue } : {}),
    models: await profileRows(ctx, modelsRows),
    attention,
  };
};

/** My Shifts (My Work section and the Shift Schedule "mine" view). */
export const myShifts = async (ctx: QueryContext) => {
  const db = ctx.app.db;
  const ws = ctx.actor.workspaceId;
  const meId = me(ctx);
  const now = ctx.app.clock.now();
  const [activeRows, upcomingRows, pendingRows, handoverRows] = await all(ctx, [
    () => db.select().from(shifts).where(and(eq(shifts.workspaceId, ws), eq(shifts.membershipId, meId), inArray(shifts.state, ['active', 'paused']))).limit(1),
    () =>
      db
        .select()
        .from(shifts)
        .where(and(eq(shifts.workspaceId, ws), eq(shifts.membershipId, meId), eq(shifts.state, 'scheduled'), gte(shifts.scheduledEnd, now), lt(shifts.scheduledStart, new Date(now.getTime() + 14 * DAY))))
        .orderBy(asc(shifts.scheduledStart))
        .limit(20),
    () =>
      db
        .select()
        .from(shifts)
        .where(and(eq(shifts.workspaceId, ws), eq(shifts.membershipId, meId), eq(shifts.state, 'ended'), inArray(shifts.reportState, ['draft', 'changes_requested'])))
        .orderBy(desc(shifts.actualEnd))
        .limit(20),
    () =>
      db
        .select()
        .from(handovers)
        .where(and(eq(handovers.workspaceId, ws), eq(handovers.recipientMembershipId, meId), eq(handovers.state, 'submitted')))
        .orderBy(asc(handovers.submittedAt))
        .limit(20),
  ] as const);
  const [active] = await shiftSummaries(ctx, activeRows);
  const swaps = await listSwaps(ctx, { state: ['pending_acceptance', 'pending_approval'] });
  return {
    active: active ?? null,
    upcoming: await shiftSummaries(ctx, upcomingRows),
    reportsPending: await shiftSummaries(ctx, pendingRows),
    handoversToAcknowledge: await handoverSummaries(ctx, handoverRows),
    swapRequests: swaps.filter((s) => s.permissions.accept || s.permissions.approve),
  };
};

