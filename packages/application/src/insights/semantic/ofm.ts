import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import Big from 'big.js';
import { countOf, known, percentValue, unavailable, weightedPercent, type MetricValue } from '@castlane/analytics';
import { handovers, qualityReviews, rubricVersions, shiftBreaks, shifts, socialAccounts } from '@castlane/database';
import { ROUND_HALF_EVEN, shiftNetTime, toBig } from '@castlane/domain';
import { dbOf } from '../../core/context';
import { filterSql, insightWorkspace, memo, type Ctx } from '../common';
import { loadPeriodObservations, usablePeriods, type PeriodObsRec } from './accounts';
import { qKey } from './production';
import { defineInsightMetric, type BaseRec, type InsightQuery } from './registry';
import { asOfOf, dateInWindow, inWindow, localMidnight, minorDecimal, scopeAll, scopeFor } from './sources';

/** OFM metrics (OFM Dashboard: M24–M31, approved shifts, pending reports). */

const PERM = 'analytics.ofm.read';
const OFM_KEYS = [
  'ofm.new_paid_subscribers',
  'ofm.renewals',
  'ofm.eligible_renewals',
  'ofm.cancellations',
  'ofm.starting_active_subscribers',
  'ofm.lost_from_starting_cohort',
  'ofm.purchases',
  'ofm.gross_sales',
  'ofm.refunds',
  'ofm.platform_fees',
];

const loadOfmPeriods = (ctx: Ctx, q: InsightQuery) => loadPeriodObservations(ctx, q, 'ofm_account', OFM_KEYS, PERM);
const periodDrill = {
  readPermission: 'metrics.read',
  ref: (r: PeriodObsRec) => ({ entityType: 'metric_observation', id: r.observationId, projectId: r.projectId ?? null, accountId: r.accountId ?? null, at: r.start, value: null }),
};
const OFM_DIMS = ['period', 'project', 'direction', 'account', 'platform'] as const;

defineInsightMetric<PeriodObsRec>({
  id: 'M24',
  key: 'paid_subscriber_net_change',
  label: 'Paid Subscriber Net Change',
  description: 'Confirmed new paid subscriptions − confirmed cancellations over non-overlapping OFM period observations. It does not replace the change of active subscribers when the source is incomplete.',
  unit: 'count',
  higherIsBetter: true,
  family: 'ofm',
  permission: PERM,
  dimensions: [...OFM_DIMS],
  grains: ['week', 'month', 'quarter'],
  additive: true,
  load: loadOfmPeriods,
  reduce: (rs) => {
    const { included, excluded } = usablePeriods(rs, ['ofm.new_paid_subscribers', 'ofm.cancellations']);
    const partialOnly = rs.filter((r) => r.within && (r.values['ofm.new_paid_subscribers'] == null) !== (r.values['ofm.cancellations'] == null)).length;
    const ex = [...excluded, ...(partialOnly ? [{ count: partialOnly, reason: 'Only one of new subscriptions / cancellations reported' }] : [])];
    if (!included.length) return unavailable(rs.length ? 'not_measured' : 'no_data', 'count', { excluded: ex.length ? ex : undefined });
    const sum = included.reduce((a, r) => a.plus(toBig(r.values['ofm.new_paid_subscribers']!)).minus(toBig(r.values['ofm.cancellations']!)), new Big(0));
    return { status: ex.length ? 'partial' : 'known', value: sum.toString(), unit: 'count', sampleSize: included.length, excluded: ex.length ? ex : undefined };
  },
  drill: periodDrill,
  sourceAt: (r) => r.end,
});

const cohortRate = (rs: PeriodObsRec[], num: string, den: string, missingNote: string): MetricValue => {
  const { included, excluded } = usablePeriods(rs, [num, den]);
  if (!included.length) return unavailable(rs.length ? 'not_measured' : 'no_data', 'percent', { note: rs.length ? missingNote : undefined, excluded: excluded.length ? excluded : undefined });
  const w = weightedPercent(included.map((r) => ({ numerator: r.values[num], denominator: r.values[den] })));
  return excluded.length ? { ...w, excluded: [...(w.excluded ?? []), ...excluded] } : w;
};

defineInsightMetric<PeriodObsRec>({
  id: 'M25',
  key: 'renewal_rate',
  label: 'Renewal Rate',
  description: 'Confirmed renewals ÷ subscriptions eligible to renew in the same cohort × 100. Without an eligible-to-renew figure from the source → Not Measured.',
  unit: 'percent',
  rate: true,
  higherIsBetter: true,
  family: 'ofm',
  permission: PERM,
  dimensions: [...OFM_DIMS],
  grains: ['month', 'quarter'],
  additive: false,
  load: loadOfmPeriods,
  reduce: (rs) => cohortRate(rs, 'ofm.renewals', 'ofm.eligible_renewals', 'The source does not report subscriptions eligible to renew.'),
  drill: periodDrill,
});

defineInsightMetric<PeriodObsRec>({
  id: 'M26',
  key: 'churn_rate',
  label: 'Churn Rate',
  description: 'Confirmed losses among the starting active cohort ÷ starting active cohort × 100. Without cohort data → Not Measured; cancellations or current subscribers are never substituted.',
  unit: 'percent',
  rate: true,
  higherIsBetter: false,
  family: 'ofm',
  permission: PERM,
  dimensions: [...OFM_DIMS],
  grains: ['month', 'quarter'],
  additive: false,
  load: loadOfmPeriods,
  reduce: (rs) => cohortRate(rs, 'ofm.lost_from_starting_cohort', 'ofm.starting_active_subscribers', 'The source does not report a starting active cohort.'),
  drill: periodDrill,
});

// ——— Revenue (finance-backed; needs finance access) ———

interface RevenueRec extends BaseRec {
  id: string;
  netMinor: bigint;
  contactId: string | null;
}

const NET_REVENUE_SQL = sql`sum((CASE WHEN l.accounting_class = 'revenue' THEN 1 WHEN l.accounting_class IN ('contra_revenue', 'fee') THEN -1 ELSE 0 END) * (CASE WHEN l.is_reversal THEN -1 ELSE 1 END) * coalesce(l.base_amount_minor, 0))`;

defineInsightMetric<RevenueRec>({
  id: 'M27',
  key: 'revenue_per_payer',
  label: 'Revenue per Payer',
  description: 'Posted net revenue of OFM accounts in the period ÷ unique confirmed paying contacts. Revenue without consistent contact IDs is excluded; with no contact IDs at all → Not Measured.',
  unit: 'money',
  higherIsBetter: true,
  family: 'ofm',
  permission: PERM,
  requires: ['finance.read'],
  dimensions: ['period', 'project', 'direction', 'account', 'platform'],
  grains: ['month', 'quarter'],
  additive: false,
  load: (ctx, q) =>
    memo(ctx, `ofmRevenue:${qKey(q)}`, async () => {
      const ws = ctx.actor.workspaceId;
      const scope = scopeAll(ctx, [PERM, 'finance.read'], { projectId: sql`sa.project_id` as never, accountId: sql`e.account_id` as never });
      const filters = filterSql(ctx, q.filters, { projectId: sql`sa.project_id`, accountId: sql`e.account_id`, platform: sql`sa.platform` });
      const rows = await dbOf(ctx).execute<{ id: string; account_id: string; project_id: string; platform: string; recognition_date: string; net: string | null; contact_id: string | null }>(sql`
        SELECT e.id, e.account_id, sa.project_id, sa.platform, e.recognition_date::text AS recognition_date, ${NET_REVENUE_SQL}::text AS net, sc.contact_id
        FROM financial_entries e
        JOIN financial_entry_lines l ON l.entry_id = e.id AND l.workspace_id = e.workspace_id
        JOIN social_accounts sa ON sa.id = e.account_id AND sa.workspace_id = e.workspace_id
        JOIN projects p ON p.id = sa.project_id AND p.workspace_id = e.workspace_id AND p.ofm_enabled
        LEFT JOIN sale_candidates sc ON sc.id = e.sale_candidate_id AND sc.workspace_id = e.workspace_id
        WHERE e.workspace_id = ${ws} AND e.state = 'posted' AND ${dateInWindow(sql`e.recognition_date`, q)}
          ${scope ? sql`AND ${scope}` : sql``}
          ${filters.length ? sql`AND ${sql.join(filters, sql` AND `)}` : sql``}
        GROUP BY e.id, e.account_id, sa.project_id, sa.platform, e.recognition_date, sc.contact_id`);
      const { baseCurrency } = await insightWorkspace(ctx);
      return rows.rows.map((r) => ({ id: r.id, accountId: r.account_id, projectId: r.project_id, platform: r.platform, at: localMidnight(r.recognition_date, q.period.zone), netMinor: BigInt(r.net ?? '0'), contactId: r.contact_id, currency: baseCurrency }));
    }),
  reduce: (rs) => {
    const withContact = rs.filter((r) => r.contactId);
    const without = rs.length - withContact.length;
    if (!rs.length) return unavailable('no_data', 'money');
    if (!withContact.length) return unavailable('not_measured', 'money', { note: 'Revenue has no consistent contact IDs.' });
    const payers = new Set(withContact.map((r) => r.contactId)).size;
    const total = withContact.reduce((a, r) => a + r.netMinor, 0n);
    const currency = rs[0]!.currency ?? 'EUR';
    const value = minorDecimal(new Big(total.toString()).div(payers), currency);
    return { status: without ? 'partial' : 'known', value, unit: 'money', currency, sampleSize: payers, excluded: without ? [{ count: without, reason: 'Revenue without a contact ID' }] : undefined };
  },
  drill: { readPermission: 'finance.read', ref: (r) => ({ entityType: 'financial_entry', id: r.id, projectId: r.projectId ?? null, accountId: r.accountId ?? null, at: r.at ?? null, value: null }) },
});

// ——— Shifts ———

interface ShiftRec extends BaseRec {
  id: string;
  netSeconds: number | null;
  approved: boolean;
  reportState: string;
  revenueMinor?: bigint | null;
}

const loadShifts = (ctx: Ctx, q: InsightQuery, opts: { approvedOnly?: boolean; withRevenue?: boolean } = {}) =>
  memo(ctx, `shifts:${opts.approvedOnly ? 'a' : ''}${opts.withRevenue ? 'r' : ''}:${qKey(q)}`, async (): Promise<ShiftRec[]> => {
    const s = shifts;
    const a = socialAccounts;
    const db = dbOf(ctx);
    const ws = ctx.actor.workspaceId;
    const rows = await db
      .select({ id: s.id, projectId: s.projectId, accountId: s.primaryAccountId, platform: a.platform, memberId: s.membershipId, actualStart: s.actualStart, actualEnd: s.actualEnd, state: s.state, reportState: s.reportState })
      .from(s)
      .innerJoin(a, and(eq(a.id, s.primaryAccountId), eq(a.workspaceId, s.workspaceId)))
      .where(
        and(
          eq(s.workspaceId, ws),
          isNotNull(s.actualStart),
          inWindow(s.actualStart, q),
          opts.approvedOnly ? eq(s.reportState, 'approved') : undefined,
          scopeFor(ctx, PERM, { projectId: s.projectId, accountId: s.primaryAccountId }),
          ...filterSql(ctx, q.filters, { projectId: s.projectId, accountId: s.primaryAccountId, platform: a.platform, memberId: s.membershipId }),
        ),
      );
    const ids = rows.map((r) => r.id);
    const breaks = ids.length ? await db.select().from(shiftBreaks).where(and(eq(shiftBreaks.workspaceId, ws), inArray(shiftBreaks.shiftId, ids))) : [];
    const revenue = new Map<string, bigint>();
    const { baseCurrency } = await insightWorkspace(ctx);
    if (opts.withRevenue && ids.length) {
      const scope = scopeFor(ctx, 'finance.read', { projectId: sql`e_s.project_id` as never, accountId: sql`e_s.primary_account_id` as never });
      const rev = await db.execute<{ shift_id: string; net: string | null }>(sql`
        SELECT e.shift_id, ${NET_REVENUE_SQL}::text AS net
        FROM financial_entries e
        JOIN financial_entry_lines l ON l.entry_id = e.id AND l.workspace_id = e.workspace_id
        JOIN shifts e_s ON e_s.id = e.shift_id AND e_s.workspace_id = e.workspace_id
        WHERE e.workspace_id = ${ws} AND e.state = 'posted' AND e.shift_id IN (${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)})
          ${scope ? sql`AND ${scope}` : sql``}
        GROUP BY e.shift_id`);
      for (const r of rev.rows) revenue.set(r.shift_id, BigInt(r.net ?? '0'));
    }
    return rows.map((r) => ({
      id: r.id,
      projectId: r.projectId,
      accountId: r.accountId,
      platform: r.platform,
      memberId: r.memberId,
      at: r.actualStart,
      netSeconds: shiftNetTime(r.actualStart, r.actualEnd, breaks.filter((b) => b.shiftId === r.id)).netSeconds,
      approved: r.reportState === 'approved',
      reportState: r.reportState,
      status: r.state,
      revenueMinor: opts.withRevenue ? (revenue.get(r.id) ?? null) : undefined,
      currency: baseCurrency,
    }));
  });

const shiftDrill = { readPermission: 'shifts.read.scope', ref: (r: ShiftRec) => ({ entityType: 'shift', id: r.id, projectId: r.projectId ?? null, accountId: r.accountId ?? null, at: r.at ?? null, value: r.netSeconds === null ? null : (r.netSeconds / 3600).toFixed(2) }) };

defineInsightMetric<ShiftRec>({
  id: 'M28',
  key: 'shift_net_hours',
  label: 'Shift Net Hours',
  description: '(actual end − actual start − closed breaks) ÷ 3600 for shifts started in the period, including approved time corrections. A shift without an actual end is Pending — never zero or the scheduled end.',
  unit: 'hours',
  family: 'ofm',
  permission: PERM,
  dimensions: ['period', 'project', 'direction', 'account', 'platform', 'member'],
  grains: ['day', 'week', 'month', 'quarter'],
  additive: true,
  load: (ctx, q) => loadShifts(ctx, q),
  reduce: (rs) => {
    const ended = rs.filter((r) => r.netSeconds !== null);
    const pending = rs.length - ended.length;
    if (!rs.length) return unavailable('no_data', 'hours');
    if (!ended.length) return unavailable('pending', 'hours', { note: `${pending} shift(s) without an actual end` });
    const hours = new Big(ended.reduce((a, r) => a + r.netSeconds!, 0)).div(3600).round(2, ROUND_HALF_EVEN).toFixed(2);
    return known(hours, 'hours', { sampleSize: ended.length, note: pending ? `Pending: ${pending} shift(s) without an actual end` : undefined });
  },
  drill: shiftDrill,
  sourceAt: (r) => r.at ?? null,
});

defineInsightMetric<ShiftRec>({
  id: 'M29',
  key: 'revenue_per_shift_hour',
  label: 'Confirmed Revenue per Shift Hour',
  description: 'Verified attributed net revenue (posted entries linked to the shift) ÷ approved net hours, for shifts with an approved report. Shifts without attributed revenue → Not Attributable; no hours → Not Defined.',
  unit: 'money',
  higherIsBetter: true,
  family: 'ofm',
  permission: PERM,
  requires: ['finance.read'],
  dimensions: ['period', 'project', 'direction', 'account', 'platform', 'member'],
  grains: ['month', 'quarter'],
  additive: false,
  load: (ctx, q) => loadShifts(ctx, q, { approvedOnly: true, withRevenue: true }),
  reduce: (rs) => {
    if (!rs.length) return unavailable('no_data', 'money');
    const attributed = rs.filter((r) => r.revenueMinor !== null && r.revenueMinor !== undefined);
    const excluded = rs.length - attributed.length;
    if (!attributed.length) return unavailable('not_attributable', 'money', { note: 'No verified revenue is attributed to these shifts.', sampleSize: rs.length });
    const seconds = attributed.reduce((a, r) => a + (r.netSeconds ?? 0), 0);
    if (seconds === 0) return unavailable('not_defined', 'money');
    const total = attributed.reduce((a, r) => a + (r.revenueMinor ?? 0n), 0n);
    const currency = rs[0]!.currency ?? 'EUR';
    const value = minorDecimal(new Big(total.toString()).times(3600).div(seconds), currency);
    return known(value, 'money', { currency, sampleSize: attributed.length, note: 'per net hour', excluded: excluded ? [{ count: excluded, reason: 'Approved shifts without attributed revenue' }] : undefined });
  },
  drill: shiftDrill,
});

interface HandoverRec extends BaseRec {
  id: string;
  acknowledged: boolean;
}

defineInsightMetric<HandoverRec>({
  id: 'M30',
  key: 'handover_completion',
  label: 'Handover Completion',
  description: 'Required handovers acknowledged ÷ required handovers × 100 (required = submitted handovers with open items from shifts ended in the period; deadline policy: acknowledged by the as-of time). No required handovers → Not Applicable.',
  unit: 'percent',
  rate: true,
  higherIsBetter: true,
  family: 'ofm',
  permission: PERM,
  dimensions: ['period', 'project', 'direction', 'account', 'member'],
  grains: ['week', 'month', 'quarter'],
  additive: false,
  load: (ctx, q) =>
    memo(ctx, `handovers:${qKey(q)}`, async () => {
      const h = handovers;
      const s = shifts;
      const asOf = asOfOf(ctx, q);
      const rows = await dbOf(ctx)
        .select({ id: h.id, projectId: s.projectId, accountId: h.accountId, memberId: s.membershipId, at: s.actualEnd, state: h.state, acknowledgedAt: h.acknowledgedAt })
        .from(h)
        .innerJoin(s, and(eq(s.id, h.fromShiftId), eq(s.workspaceId, h.workspaceId)))
        .where(
          and(
            eq(h.workspaceId, ctx.actor.workspaceId),
            inArray(h.state, ['submitted', 'acknowledged']),
            eq(h.noOpenItems, false),
            inWindow(s.actualEnd, q),
            scopeFor(ctx, PERM, { projectId: s.projectId, accountId: h.accountId }),
            ...filterSql(ctx, q.filters, { projectId: s.projectId, accountId: h.accountId, memberId: s.membershipId }),
          ),
        );
      return rows.map((r) => ({ id: r.id, projectId: r.projectId, accountId: r.accountId, memberId: r.memberId, at: r.at, acknowledged: r.state === 'acknowledged' && !!r.acknowledgedAt && r.acknowledgedAt <= asOf }));
    }),
  reduce: (rs) => (rs.length ? percentValue(rs.filter((r) => r.acknowledged).length, rs.length, 2, { sampleSize: rs.length }) : unavailable('not_applicable', 'percent', { note: 'No required handovers in this period.' })),
  drill: { readPermission: 'handovers.read', ref: (r) => ({ entityType: 'handover', id: r.id, projectId: r.projectId ?? null, accountId: r.accountId ?? null, at: r.at ?? null, value: r.acknowledged ? 'Acknowledged' : 'Not acknowledged' }) },
});

interface QualityRec extends BaseRec {
  id: string;
  score: string | null;
  rubric: string;
}

defineInsightMetric<QualityRec>({
  id: 'M31',
  key: 'quality_score',
  label: 'Quality Score',
  description: 'Published quality reviews in the period scored with the rubric of §13.6: Σ(score ÷ 4 × weight) ÷ Σ applicable weights × 100 per review; the value is the mean of review scores with the rubric version shown. Reviews with all criteria N/A have No Score; disputed reviews wait for resolution.',
  unit: 'score',
  higherIsBetter: true,
  family: 'ofm',
  permission: PERM,
  dimensions: ['period', 'project', 'direction'],
  grains: ['month', 'quarter'],
  additive: false,
  load: (ctx, q) =>
    memo(ctx, `quality:${qKey(q)}`, async () => {
      const r = qualityReviews;
      const rows = await dbOf(ctx)
        .select({ id: r.id, projectId: r.projectId, at: r.publishedAt, score: r.totalScore, state: r.state, rubric: sql<string>`${rubricVersions.name} || ' v' || ${rubricVersions.versionNo}` })
        .from(r)
        .innerJoin(rubricVersions, and(eq(rubricVersions.id, r.rubricVersionId), eq(rubricVersions.workspaceId, r.workspaceId)))
        .where(
          and(
            eq(r.workspaceId, ctx.actor.workspaceId),
            inArray(r.state, ['published', 'resolved', 'disputed']),
            isNull(r.supersededAt),
            inWindow(r.publishedAt, q),
            scopeFor(ctx, PERM, { projectId: r.projectId }),
            ...filterSql(ctx, q.filters, { projectId: r.projectId }),
          ),
        );
      return rows.map((x) => ({ id: x.id, projectId: x.projectId, at: x.at, score: x.state === 'disputed' ? null : x.score, status: x.state, rubric: x.rubric }));
    }),
  reduce: (rs) => {
    const disputed = rs.filter((r) => r.status === 'disputed').length;
    const scored = rs.filter((r) => r.score !== null);
    const noScore = rs.length - scored.length - disputed;
    const excluded = [...(noScore ? [{ count: noScore, reason: 'No Score (all criteria N/A)' }] : []), ...(disputed ? [{ count: disputed, reason: 'Under dispute' }] : [])];
    if (!scored.length) return unavailable('no_data', 'score', { excluded: excluded.length ? excluded : undefined });
    const mean = scored.reduce((a, r) => a.plus(toBig(r.score!)), new Big(0)).div(scored.length).round(1, ROUND_HALF_EVEN).toFixed(1);
    const rubrics = [...new Set(scored.map((r) => r.rubric))].join(', ');
    return known(mean, 'score', { sampleSize: scored.length, excluded: excluded.length ? excluded : undefined, note: `Mean of review scores · ${rubrics}` });
  },
  drill: { readPermission: 'quality.read.scope', ref: (r) => ({ entityType: 'quality_review', id: r.id, projectId: r.projectId ?? null, accountId: null, at: r.at ?? null, value: r.score }) },
});

defineInsightMetric<ShiftRec>({
  id: 'X07',
  key: 'approved_shifts',
  label: 'Approved Shifts',
  description: 'Shifts started in the period whose shift report is approved.',
  unit: 'count',
  family: 'ofm',
  permission: PERM,
  dimensions: ['period', 'project', 'direction', 'account', 'platform', 'member'],
  grains: ['day', 'week', 'month', 'quarter'],
  additive: true,
  zeroWhenEmpty: true,
  load: (ctx, q) => loadShifts(ctx, q, { approvedOnly: true }),
  reduce: (rs) => countOf(rs.length),
  drill: shiftDrill,
});

defineInsightMetric<ShiftRec>({
  id: 'X06',
  key: 'pending_shift_reports',
  label: 'Pending Shift Reports',
  description: 'Shifts started in the period that have ended but whose report is not approved yet (not started, draft, submitted or changes requested).',
  unit: 'count',
  higherIsBetter: false,
  family: 'ofm',
  permission: PERM,
  dimensions: ['project', 'direction', 'account', 'platform', 'member'],
  grains: [],
  additive: true,
  zeroWhenEmpty: true,
  load: async (ctx, q) => (await loadShifts(ctx, q)).filter((r) => r.netSeconds !== null && !r.approved),
  reduce: (rs) => countOf(rs.length),
  drill: shiftDrill,
});

export { loadShifts };
