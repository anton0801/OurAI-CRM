import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import Big from 'big.js';
import { listFilter } from '@castlane/authorization';
import { known, percentValue, unavailable, type MetricValue } from '@castlane/analytics';
import { budgets, compensationRuns, saleCandidates, socialAccounts } from '@castlane/database';
import { formatMinor, summarizeLedger, type LedgerLine } from '@castlane/domain';
import { allowed } from '../../core/access';
import { dbOf } from '../../core/context';
import { computeBudget } from '../../finance/budget-figures';
import { runPayables } from '../../finance/payables';
import { filterSql, insightWorkspace, memo, type Ctx } from '../common';
import { qKey } from './production';
import { defineInsightMetric, type BaseRec, type InsightQuery } from './registry';
import { dateBounds, dateInWindow, inWindow, localMidnight, minorDecimal, scopeAll, workspaceWide } from './sources';

/**
 * Finance metrics (Finance Dashboard: M33–M39, M41, M42) from the finance module's posted records:
 * accrual by allocation effective date (frozen base equivalents), cash by settlement date. Drafts
 * never count. Every metric needs analytics.finance.read and finance.read in the same scope.
 */

const PERM = 'analytics.finance.read';
const REQ = ['finance.read'];

/** Allocation scope of both permissions (project grants via allocation, account grants via the entry). */
const allocationScope = (ctx: Ctx): SQL | undefined => {
  const parts: SQL[] = [];
  for (const p of [PERM, 'finance.read']) {
    const f = listFilter(ctx.actor.access, p);
    if (f.kind === 'all') continue;
    if (f.kind === 'none') return sql`false`;
    const or: SQL[] = [];
    if (f.projectIds.length) or.push(sql`fa.project_id IN (${sql.join(f.projectIds.map((x) => sql`${x}::uuid`), sql`, `)})`);
    if (f.accountIds.length) or.push(sql`e.account_id IN (${sql.join(f.accountIds.map((x) => sql`${x}::uuid`), sql`, `)})`);
    parts.push(or.length ? sql`(${sql.join(or, sql` OR `)})` : sql`false`);
  }
  return parts.length ? sql.join(parts, sql` AND `) : undefined;
};

interface LedgerRec extends BaseRec {
  id: string;
  entryId: string;
  cls: LedgerLine['accountingClass'];
  componentsUnknown: boolean;
  fxEffect: 'gain' | 'loss' | null;
  baseMinor: bigint;
}

const loadLedger = (ctx: Ctx, q: InsightQuery) =>
  memo(ctx, `ledger:${qKey(q)}`, async (): Promise<LedgerRec[]> => {
    const ws = ctx.actor.workspaceId;
    const { baseCurrency } = await insightWorkspace(ctx);
    const scope = allocationScope(ctx);
    const filters = filterSql(ctx, q.filters, { projectId: sql`fa.project_id`, accountId: sql`e.account_id`, campaignId: sql`coalesce(fa.campaign_id, e.campaign_id)` });
    const rows = await dbOf(ctx).execute<{ id: string; entry_id: string; project_id: string | null; account_id: string | null; campaign_id: string | null; category_id: string; accounting_class: LedgerLine['accountingClass']; components_unknown: boolean; fx_effect: 'gain' | 'loss' | null; effective_date: string; base: string | null }>(sql`
      SELECT fa.id, fa.entry_id, fa.project_id, e.account_id, coalesce(fa.campaign_id, e.campaign_id) AS campaign_id, l.category_id, l.accounting_class, l.components_unknown, l.fx_effect,
        fa.effective_date::text AS effective_date,
        (CASE WHEN l.is_reversal THEN -coalesce(fa.base_amount_minor, 0) ELSE coalesce(fa.base_amount_minor, 0) END)::text AS base
      FROM financial_allocations fa
      JOIN financial_entry_lines l ON l.id = fa.line_id AND l.workspace_id = fa.workspace_id
      JOIN financial_entries e ON e.id = fa.entry_id AND e.workspace_id = fa.workspace_id
      WHERE fa.workspace_id = ${ws} AND e.state = 'posted' AND ${dateInWindow(sql`fa.effective_date`, q)}
        ${scope ? sql`AND ${scope}` : sql``}
        ${filters.length ? sql`AND ${sql.join(filters, sql` AND `)}` : sql``}`);
    return rows.rows.map((r) => ({
      id: r.id,
      entryId: r.entry_id,
      projectId: r.project_id,
      accountId: r.account_id,
      campaignId: r.campaign_id,
      category: r.category_id,
      currency: baseCurrency,
      at: localMidnight(r.effective_date, q.period.zone),
      cls: r.accounting_class,
      componentsUnknown: r.components_unknown,
      fxEffect: r.fx_effect,
      baseMinor: BigInt(r.base ?? '0'),
    }));
  });

const ledgerOf = (rs: LedgerRec[]) => summarizeLedger(rs.map((r) => ({ accountingClass: r.cls, amountMinor: r.baseMinor, componentsUnknown: r.componentsUnknown, fxEffect: r.fxEffect })));
const money = (minor: bigint, rs: LedgerRec[], extra: Partial<MetricValue> = {}): MetricValue => {
  const currency = rs[0]?.currency ?? 'EUR';
  return known(formatMinor(minor, currency), 'money', { currency, sampleSize: new Set(rs.map((r) => r.entryId)).size, ...extra });
};
const ledgerDrill = { readPermission: 'finance.read', ref: (r: LedgerRec) => ({ entityType: 'financial_entry', id: r.entryId, projectId: r.projectId ?? null, accountId: r.accountId ?? null, at: r.at ?? null, value: null }) };
const LEDGER_DIMS = ['period', 'project', 'direction', 'account', 'campaign', 'category'] as const;

const defineLedgerMetric = (m: { id: string; key: string; label: string; description: string; unit?: MetricValue['unit']; rate?: boolean; additive: boolean; reduce: (rs: LedgerRec[]) => MetricValue }) =>
  defineInsightMetric<LedgerRec>({
    ...m,
    unit: m.unit ?? 'money',
    higherIsBetter: true,
    family: 'finance',
    permission: PERM,
    requires: REQ,
    dimensions: [...LEDGER_DIMS],
    grains: ['week', 'month', 'quarter'],
    load: loadLedger,
    drill: ledgerDrill,
    sourceAt: (r) => r.at ?? null,
  });

defineLedgerMetric({
  id: 'M33',
  key: 'gross_revenue',
  label: 'Gross Revenue',
  description: 'Sum of posted revenue lines by recognition (allocation effective) date, in frozen base-currency equivalents. Net-only statements without a gross breakdown are excluded and the value is marked incomplete.',
  additive: true,
  reduce: (rs) => {
    if (!rs.length) return unavailable('no_data', 'money');
    const s = ledgerOf(rs);
    const v = money(s.grossRevenue, rs);
    return s.grossIncomplete ? { ...v, status: 'partial', missing: ['gross of net-only statements'], note: 'Incomplete: net-only revenue has no gross breakdown' } : v;
  },
});

defineLedgerMetric({
  id: 'M34',
  key: 'net_revenue',
  label: 'Net Revenue',
  description: 'Gross revenue − posted refunds − posted platform/payment fees (fees counted exactly once), plus verified net-only revenue.',
  additive: true,
  reduce: (rs) => (rs.length ? money(ledgerOf(rs).netRevenue, rs) : unavailable('no_data', 'money')),
});

defineLedgerMetric({
  id: 'M35',
  key: 'operating_result',
  label: 'Operating Result',
  description: 'Net revenue − posted operating expenses (including compensation expense), excluding settlements and fees already subtracted. Not a cash figure.',
  additive: true,
  reduce: (rs) => (rs.length ? money(ledgerOf(rs).operatingResult, rs) : unavailable('no_data', 'money')),
});

defineLedgerMetric({
  id: 'M36',
  key: 'operating_margin',
  label: 'Operating Margin',
  description: 'Operating Result ÷ Gross Revenue × 100. Gross revenue ≤ 0 → Not Defined. The denominator is always gross revenue.',
  unit: 'percent',
  rate: true,
  additive: false,
  reduce: (rs) => {
    if (!rs.length) return unavailable('no_data', 'percent');
    const s = ledgerOf(rs);
    if (s.grossRevenue <= 0n) return unavailable('not_defined', 'percent', { note: 'Gross revenue is zero or negative.' });
    return percentValue(s.operatingResult.toString(), s.grossRevenue.toString());
  },
});

defineLedgerMetric({
  id: 'X08',
  key: 'unallocated_costs',
  label: 'Unallocated Costs',
  description: 'Posted operating and compensation costs recorded on an explicit Unallocated line (no project). Project profitability is incomplete while this is above zero.',
  additive: true,
  reduce: (rs) => {
    const costs = rs.filter((r) => (r.cls === 'operating_expense' || r.cls === 'compensation_expense') && !r.projectId);
    return money(
      costs.reduce((a, r) => a + r.baseMinor, 0n),
      rs.length ? rs : costs,
    );
  },
});

// ——— M37 Cost per produced unit ———

interface UnitRec extends BaseRec {
  id: string;
  costMinor: bigint | null;
}

defineInsightMetric<UnitRec>({
  id: 'M37',
  key: 'cost_per_produced_unit',
  label: 'Cost per Produced Unit',
  description: 'Posted production costs explicitly allocated to content items that got their first approval in the period ÷ number of those unique produced units (per format/cohort). Shared costs count only through an explicit allocation.',
  unit: 'money',
  higherIsBetter: false,
  family: 'finance',
  permission: PERM,
  requires: REQ,
  dimensions: ['period', 'project', 'direction', 'format'],
  grains: ['month', 'quarter'],
  additive: false,
  load: (ctx, q) =>
    memo(ctx, `unitCost:${qKey(q)}`, async () => {
      const ws = ctx.actor.workspaceId;
      const { baseCurrency } = await insightWorkspace(ctx);
      const scope = scopeAll(ctx, [PERM, 'finance.read'], { projectId: sql`c.project_id` as never });
      const filters = filterSql(ctx, q.filters, { projectId: sql`c.project_id`, format: sql`c.format` });
      const rows = await dbOf(ctx).execute<{ id: string; project_id: string; format: string; first_approved_at: Date; cost: string | null }>(sql`
        SELECT c.id, c.project_id, c.format, c.first_approved_at,
          (SELECT sum(CASE WHEN l.is_reversal THEN -coalesce(fa.base_amount_minor, 0) ELSE coalesce(fa.base_amount_minor, 0) END)
             FROM financial_allocations fa
             JOIN financial_entry_lines l ON l.id = fa.line_id AND l.workspace_id = fa.workspace_id
             JOIN financial_entries e ON e.id = fa.entry_id AND e.workspace_id = fa.workspace_id
            WHERE fa.workspace_id = c.workspace_id AND fa.content_item_id = c.id AND e.state = 'posted'
              AND l.accounting_class IN ('operating_expense', 'compensation_expense'))::text AS cost
        FROM content_items c
        WHERE c.workspace_id = ${ws} AND c.deleted_at IS NULL AND ${inWindow(sql`c.first_approved_at`, q)}
          ${scope ? sql`AND ${scope}` : sql``}
          ${filters.length ? sql`AND ${sql.join(filters, sql` AND `)}` : sql``}`);
      return rows.rows.map((r) => ({ id: r.id, projectId: r.project_id, format: r.format, at: r.first_approved_at instanceof Date ? r.first_approved_at : new Date(String(r.first_approved_at)), costMinor: r.cost === null ? null : BigInt(r.cost), currency: baseCurrency }));
    }),
  reduce: (rs) => {
    if (!rs.length) return unavailable('no_data', 'money');
    const withCost = rs.filter((r) => r.costMinor !== null);
    if (!withCost.length) return unavailable('not_measured', 'money', { note: 'No production costs are allocated to these units.', sampleSize: rs.length });
    const total = withCost.reduce((a, r) => a + (r.costMinor ?? 0n), 0n);
    const currency = rs[0]!.currency ?? 'EUR';
    const value = minorDecimal(new Big(total.toString()).div(rs.length), currency);
    return { status: withCost.length < rs.length ? 'partial' : 'known', value, unit: 'money', currency, sampleSize: rs.length, coverage: { usable: withCost.length, expected: rs.length } };
  },
  drill: { readPermission: 'content.read', ref: (r) => ({ entityType: 'content_item', id: r.id, projectId: r.projectId ?? null, accountId: null, at: r.at ?? null, value: null }) },
});

// ——— M38 Budget Remaining ———

interface BudgetRec extends BaseRec {
  id: string;
  remainingMinor: bigint;
}

const sumByCurrency = <T extends BaseRec>(rs: T[], amount: (r: T) => bigint, extra: Partial<MetricValue> = {}): MetricValue => {
  if (!rs.length) return unavailable('no_data', 'money');
  const currencies = [...new Set(rs.map((r) => r.currency ?? ''))];
  if (currencies.length > 1) return unavailable('not_comparable', 'money', { note: `Several currencies (${currencies.join(', ')}) — see the breakdown by currency; no converted total.`, sampleSize: rs.length });
  return known(formatMinor(rs.reduce((a, r) => a + amount(r), 0n), currencies[0]!), 'money', { currency: currencies[0], sampleSize: rs.length, ...extra });
};

defineInsightMetric<BudgetRec>({
  id: 'M38',
  key: 'budget_remaining',
  label: 'Budget Remaining',
  description: 'Approved budget − actual posted costs − outstanding commitments, per budget in its currency (budgets overlapping the period). A negative value is overspend; different currencies are never added together.',
  unit: 'money',
  higherIsBetter: true,
  family: 'finance',
  permission: PERM,
  requires: [...REQ, 'budgets.read'],
  dimensions: ['project', 'direction', 'currency'],
  grains: [],
  additive: true,
  load: (ctx, q) =>
    memo(ctx, `budgets:${qKey(q)}`, async () => {
      const b = dateBounds(q);
      const { baseCurrency } = await insightWorkspace(ctx);
      const rows = await dbOf(ctx)
        .select()
        .from(budgets)
        .where(and(eq(budgets.workspaceId, ctx.actor.workspaceId), sql`${budgets.approvedVersionId} IS NOT NULL`, sql`${budgets.archivedAt} IS NULL`, sql`${budgets.periodStart} <= ${b.to} AND ${budgets.periodEnd} >= ${b.from}`));
      const visible = rows.filter((x) => {
        const scope = x.scopeType === 'project' ? { projectId: x.scopeId } : x.scopeType === 'direction' ? { directionId: x.scopeId } : undefined;
        if (x.scopeType === 'project' && q.filters.projectIds?.length && !q.filters.projectIds.includes(x.scopeId ?? '')) return false;
        if (x.scopeType !== 'project' && q.filters.projectIds?.length) return false;
        return [PERM, 'finance.read', 'budgets.read'].every((p) => allowed(ctx, p, scope ?? undefined));
      });
      const out: BudgetRec[] = [];
      for (const x of visible) {
        const c = await computeBudget(ctx, x, baseCurrency);
        if (c) out.push({ id: x.id, projectId: x.scopeType === 'project' ? x.scopeId : null, currency: x.currency.trim(), remainingMinor: c.total.remainingMinor, at: localMidnight(x.periodStart, q.period.zone) });
      }
      return out;
    }),
  reduce: (rs) => sumByCurrency(rs, (r) => r.remainingMinor),
  drill: { readPermission: 'budgets.read', ref: (r) => ({ entityType: 'budget', id: r.id, projectId: r.projectId ?? null, accountId: null, at: r.at ?? null, value: formatMinor(r.remainingMinor, r.currency ?? 'EUR') }) },
});

// ——— M39 Outstanding Compensation ———

interface PayableRec extends BaseRec {
  id: string;
  outstandingMinor: bigint;
}

defineInsightMetric<PayableRec>({
  id: 'M39',
  key: 'outstanding_compensation',
  label: 'Outstanding Compensation',
  description: 'Approved compensation accruals + adjustments − confirmed allocated payouts − reversals, per currency, for approved runs ending by the end of the period.',
  unit: 'money',
  higherIsBetter: false,
  family: 'finance',
  permission: PERM,
  requires: [...REQ, 'compensation.runs.read'],
  dimensions: ['currency', 'member'],
  grains: [],
  additive: true,
  load: (ctx, q) =>
    memo(ctx, `payables:${qKey(q)}`, async () => {
      // Compensation is workspace-level data: only members with workspace-wide compensation access.
      if (!workspaceWide(ctx, 'compensation.runs.read') || !workspaceWide(ctx, 'finance.read')) return [];
      const b = dateBounds(q);
      const runs = await dbOf(ctx)
        .select({ id: compensationRuns.id, periodEnd: compensationRuns.periodEnd })
        .from(compensationRuns)
        .where(and(eq(compensationRuns.workspaceId, ctx.actor.workspaceId), inArray(compensationRuns.state, ['approved', 'partially_paid', 'paid']), sql`${compensationRuns.periodEnd} <= ${b.to}`));
      const payables = await runPayables(ctx, runs.map((r) => r.id), { asOf: b.to });
      return payables.map((p) => ({ id: p.runId, memberId: p.recipientMembershipId, currency: p.currency, outstandingMinor: p.outstandingMinor, at: localMidnight(runs.find((r) => r.id === p.runId)!.periodEnd, q.period.zone) }));
    }),
  reduce: (rs) => (rs.length ? sumByCurrency(rs, (r) => r.outstandingMinor) : known('0', 'money', { sampleSize: 0, note: 'No approved compensation runs' })),
  drill: { readPermission: 'compensation.runs.read', ref: (r) => ({ entityType: 'compensation_run', id: r.id, projectId: null, accountId: null, at: r.at ?? null, value: formatMinor(r.outstandingMinor, r.currency ?? 'EUR') }) },
});

// ——— M41 Cash Movement ———

interface CashRec extends BaseRec {
  id: string;
  signedMinor: bigint;
}

defineInsightMetric<CashRec>({
  id: 'M41',
  key: 'cash_movement',
  label: 'Cash Movement',
  description: 'Confirmed cash inflows − confirmed cash outflows by settlement (payment) date, per currency; reversals count at their effective date. This is not the operating result.',
  unit: 'money',
  family: 'finance',
  permission: PERM,
  requires: REQ,
  dimensions: ['period', 'currency'],
  grains: ['week', 'month', 'quarter'],
  additive: true,
  load: (ctx, q) =>
    memo(ctx, `cash:${qKey(q)}`, async () => {
      const ws = ctx.actor.workspaceId;
      const b = dateBounds(q);
      if (workspaceWide(ctx, PERM) && workspaceWide(ctx, 'finance.read') && !q.filters.projectIds?.length && !q.filters.accountIds?.length) {
        const rows = await dbOf(ctx).execute<{ id: string; currency: string; direction: string; amount: string; paid_at: Date; state: string; reversal_effective_date: string | null }>(sql`
          SELECT id, currency, direction, amount_minor::text AS amount, paid_at, state, reversal_effective_date::text AS reversal_effective_date
          FROM settlements WHERE workspace_id = ${ws} AND state IN ('confirmed', 'reversed')
            AND ((paid_at >= ${q.period.start} AND paid_at < ${q.period.end}) OR (state = 'reversed' AND reversal_effective_date BETWEEN ${b.from} AND ${b.to}))`);
        const out: CashRec[] = [];
        for (const r of rows.rows) {
          const sign = r.direction === 'in' ? 1n : -1n;
          const paid = r.paid_at instanceof Date ? r.paid_at : new Date(String(r.paid_at));
          if (paid >= q.period.start && paid < q.period.end) out.push({ id: r.id, currency: r.currency.trim(), signedMinor: sign * BigInt(r.amount), at: paid });
          if (r.state === 'reversed' && r.reversal_effective_date && r.reversal_effective_date >= b.from && r.reversal_effective_date <= b.to)
            out.push({ id: r.id, currency: r.currency.trim(), signedMinor: -sign * BigInt(r.amount), at: localMidnight(r.reversal_effective_date, q.period.zone) });
        }
        return out;
      }
      // Scoped members: only settlement allocations to documents allocated in their scope.
      const scope = allocationScope(ctx);
      const filters = filterSql(ctx, q.filters, { projectId: sql`fa.project_id`, accountId: sql`e.account_id` });
      const rows = await dbOf(ctx).execute<{ id: string; currency: string; direction: string; amount: string; paid_at: Date }>(sql`
        SELECT s.id, s.currency, s.direction, sum(sa.amount_minor)::text AS amount, s.paid_at
        FROM settlement_allocations sa
        JOIN settlements s ON s.id = sa.settlement_id AND s.workspace_id = sa.workspace_id
        JOIN financial_entries e ON e.id = sa.target_entry_id AND e.workspace_id = sa.workspace_id
        WHERE sa.workspace_id = ${ws} AND sa.reversed_at IS NULL AND s.state = 'confirmed' AND s.paid_at >= ${q.period.start} AND s.paid_at < ${q.period.end}
          AND EXISTS (SELECT 1 FROM financial_allocations fa WHERE fa.entry_id = e.id AND fa.workspace_id = e.workspace_id
            ${scope ? sql`AND ${scope}` : sql``} ${filters.length ? sql`AND ${sql.join(filters, sql` AND `)}` : sql``})
        GROUP BY s.id, s.currency, s.direction, s.paid_at`);
      return rows.rows.map((r) => ({ id: r.id, currency: r.currency.trim(), signedMinor: (r.direction === 'in' ? 1n : -1n) * BigInt(r.amount), at: r.paid_at instanceof Date ? r.paid_at : new Date(String(r.paid_at)) }));
    }),
  reduce: (rs) => sumByCurrency(rs, (r) => r.signedMinor),
  drill: { readPermission: 'finance.read', ref: (r) => ({ entityType: 'settlement', id: r.id, projectId: null, accountId: null, at: r.at ?? null, value: formatMinor(r.signedMinor, r.currency ?? 'EUR') }) },
  sourceAt: (r) => r.at ?? null,
});

// ——— M42 Source Match Rate ———

interface MatchRec extends BaseRec {
  id: string;
  state: string;
  duplicate: boolean;
}

defineInsightMetric<MatchRec>({
  id: 'M42',
  key: 'source_match_rate',
  label: 'Source Match Rate',
  description: 'Reconciled (verified) source transaction rows ÷ imported eligible rows (verified + pending) × 100. Rejected duplicates are shown separately.',
  unit: 'percent',
  rate: true,
  higherIsBetter: true,
  family: 'finance',
  permission: PERM,
  requires: REQ,
  dimensions: ['period', 'project', 'direction', 'account', 'platform'],
  grains: ['week', 'month', 'quarter'],
  additive: false,
  load: (ctx, q) =>
    memo(ctx, `match:${qKey(q)}`, async () => {
      const s = saleCandidates;
      const a = socialAccounts;
      const rows = await dbOf(ctx)
        .select({
          id: s.id,
          projectId: s.projectId,
          accountId: s.accountId,
          platform: a.platform,
          at: s.occurredAt,
          state: s.state,
          duplicate: sql<boolean>`${s.state} = 'rejected' AND EXISTS (SELECT 1 FROM financial_entries x WHERE x.workspace_id = ${s.workspaceId} AND x.source_namespace = ${s.sourceNamespace} AND x.source_external_id = ${s.sourceTransactionId})`,
        })
        .from(s)
        .innerJoin(a, and(eq(a.id, s.accountId), eq(a.workspaceId, s.workspaceId)))
        .where(
          and(
            eq(s.workspaceId, ctx.actor.workspaceId),
            inWindow(s.occurredAt, q),
            scopeAll(ctx, [PERM, 'finance.read'], { projectId: s.projectId, accountId: s.accountId }),
            ...filterSql(ctx, q.filters, { projectId: s.projectId, accountId: s.accountId, platform: a.platform }),
          ),
        );
      return rows.map((r) => ({ ...r, status: r.state }));
    }),
  reduce: (rs) => {
    const verified = rs.filter((r) => r.state === 'verified').length;
    const eligible = verified + rs.filter((r) => r.state === 'pending').length;
    const dup = rs.filter((r) => r.duplicate).length;
    if (!eligible) return unavailable(rs.length ? 'not_applicable' : 'no_data', 'percent', { note: dup ? `Duplicates rejected: ${dup}` : undefined });
    const v = percentValue(verified, eligible, 2, { sampleSize: eligible });
    return dup ? { ...v, note: `Duplicates rejected: ${dup}` } : v;
  },
  drill: { readPermission: ['sale-candidates.review', 'finance.read'], ref: (r) => ({ entityType: 'sale_candidate', id: r.id, projectId: r.projectId ?? null, accountId: r.accountId ?? null, at: r.at ?? null, value: r.state }) },
});


