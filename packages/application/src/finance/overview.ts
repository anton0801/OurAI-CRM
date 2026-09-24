import { and, desc, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { can, hasAnywhere, listFilter } from '@castlane/authorization';
import {
  budgets,
  campaigns,
  commitments,
  compensationAdjustments,
  compensationLines,
  compensationRules,
  compensationRuns,
  deals,
  financialEntries,
  periodLocks,
  projects,
  roleAssignments,
} from '@castlane/database';
import { AppError, Big, ROUND_HALF_EVEN, localDateRangeToUtc, recipientTotals, summarizeLedger, type LedgerLine, type LedgerSummary } from '@castlane/domain';
import { requirePermission } from '../core/access';
import { dbOf, type QueryContext } from '../core/context';
import { loadMemberRefs } from '../core/members';
import { budgetRows, commitmentViews } from './budgets';
import { moneyOf, workspaceFinance } from './common';
import { ruleRows } from './compensation-rules';
import { adjustmentViews } from './compensation-runs';
import { entryRows, entryVisibilitySql } from './entries';
import { LINE_EFFECT_SQL, documentOutstanding, runPayables } from './payables';

/**
 * Allocation-level scope (project / account grants) applied in SQL before aggregation.
 * `entryAlias` names the financial_entries relation in the surrounding query.
 */
const allocationScope = (ctx: QueryContext, entryAlias = 'e', permission = 'finance.read'): SQL | undefined => {
  const f = listFilter(ctx.actor.access, permission);
  if (f.kind === 'all') return undefined;
  if (f.kind === 'none') return sql`false`;
  const parts: SQL[] = [];
  if (f.projectIds.length) parts.push(sql`fa.project_id IN (${sql.join(f.projectIds.map((p) => sql`${p}::uuid`), sql`, `)})`);
  if (f.accountIds.length) parts.push(sql`${sql.raw(`${entryAlias}.account_id`)} IN (${sql.join(f.accountIds.map((p) => sql`${p}::uuid`), sql`, `)})`);
  return parts.length ? sql`(${sql.join(parts, sql` OR `)})` : sql`false`;
};

const add = (m: Map<string, bigint>, k: string, v: bigint) => m.set(k, (m.get(k) ?? 0n) + v);

const accrualSummary = async (ctx: QueryContext, input: { periodStart: string; periodEnd: string; projectId?: string; campaignId?: string }): Promise<LedgerSummary> => {
  const scope = allocationScope(ctx);
  const rows = await dbOf(ctx).execute<{ accounting_class: LedgerLine['accountingClass']; components_unknown: boolean; fx_effect: 'gain' | 'loss' | null; base: string | null }>(sql`
    SELECT l.accounting_class, l.components_unknown, l.fx_effect,
      sum(CASE WHEN l.is_reversal THEN -fa.base_amount_minor ELSE fa.base_amount_minor END)::text AS base
    FROM financial_allocations fa
    JOIN financial_entry_lines l ON l.id = fa.line_id AND l.workspace_id = fa.workspace_id
    JOIN financial_entries e ON e.id = fa.entry_id AND e.workspace_id = fa.workspace_id
    WHERE fa.workspace_id = ${ctx.actor.workspaceId} AND e.state = 'posted'
      AND fa.effective_date >= ${input.periodStart} AND fa.effective_date <= ${input.periodEnd}
      ${input.projectId ? sql`AND fa.project_id = ${input.projectId}` : sql``}
      ${input.campaignId ? sql`AND coalesce(fa.campaign_id, e.campaign_id) = ${input.campaignId}` : sql``}
      ${scope ? sql`AND ${scope}` : sql``}
    GROUP BY l.accounting_class, l.components_unknown, l.fx_effect`);
  return summarizeLedger(rows.rows.map((r) => ({ accountingClass: r.accounting_class, amountMinor: BigInt(r.base ?? '0'), componentsUnknown: r.components_unknown, fxEffect: r.fx_effect })));
};

const accrualView = (s: LedgerSummary, baseCurrency: string) => ({
  grossRevenue: moneyOf(s.grossRevenue, baseCurrency),
  refunds: moneyOf(s.refunds, baseCurrency),
  fees: moneyOf(s.fees, baseCurrency),
  netRevenue: moneyOf(s.netRevenue, baseCurrency),
  operatingExpenses: moneyOf(s.operatingExpenses, baseCurrency),
  compensationExpense: moneyOf(s.compensationExpense, baseCurrency),
  fxDifference: moneyOf(s.fxGain - s.fxLoss, baseCurrency),
  operatingResult: moneyOf(s.operatingResult, baseCurrency),
  // M36: Operating Result / Gross Revenue × 100; Gross ≤ 0 → Not Defined.
  operatingMarginPercent: s.grossRevenue > 0n ? new Big(s.operatingResult.toString()).times(100).div(s.grossRevenue.toString()).round(2, ROUND_HALF_EVEN).toFixed(2) : null,
  grossIncomplete: s.grossIncomplete,
  netOnlyRevenue: moneyOf(s.netOnlyRevenue, baseCurrency),
});

/**
 * Finance Overview (S55, F10): accrual results from posted records by allocation effective date;
 * cash from confirmed settlements by payment date — the two views are never added together.
 * Drafts are shown separately and never enter totals.
 */
export const financeOverview = async (ctx: QueryContext, input: { periodStart: string; periodEnd: string; projectId?: string }) => {
  requirePermission(ctx, 'finance.read');
  if (input.periodEnd < input.periodStart) throw new AppError('VALIDATION_FAILED', 'The period ends before it starts.', { fieldErrors: [{ field: 'periodEnd', code: 'BEFORE_START', message: 'Choose an end on or after the start.' }] });
  if (input.projectId && !can(ctx.actor.access, 'finance.read', { projectId: input.projectId })) throw new AppError('NOT_FOUND', 'Project was not found.');
  const db = dbOf(ctx);
  const ws = ctx.actor.workspaceId;
  const { baseCurrency, timezone } = await workspaceFinance(ctx);
  const workspaceWide = can(ctx.actor.access, 'finance.read') && !input.projectId;
  const scope = allocationScope(ctx);
  const accrual = accrualView(await accrualSummary(ctx, input), baseCurrency);
  const { start, end } = localDateRangeToUtc(input.periodStart, input.periodEnd, timezone);

  // Cash: confirmed inflows/outflows at the payment date; reversals at their effective date.
  const cashRows = workspaceWide
    ? await db.execute<{ currency: string; inflow: string; outflow: string }>(sql`
        SELECT currency,
          (sum(CASE WHEN direction = 'in' AND paid_at >= ${start} AND paid_at < ${end} THEN amount_minor ELSE 0 END)
           - sum(CASE WHEN direction = 'in' AND state = 'reversed' AND reversal_effective_date BETWEEN ${input.periodStart} AND ${input.periodEnd} THEN amount_minor ELSE 0 END))::text AS inflow,
          (sum(CASE WHEN direction = 'out' AND paid_at >= ${start} AND paid_at < ${end} THEN amount_minor ELSE 0 END)
           - sum(CASE WHEN direction = 'out' AND state = 'reversed' AND reversal_effective_date BETWEEN ${input.periodStart} AND ${input.periodEnd} THEN amount_minor ELSE 0 END))::text AS outflow
        FROM settlements WHERE workspace_id = ${ws} AND state IN ('confirmed', 'reversed')
        GROUP BY currency`)
    : await db.execute<{ currency: string; inflow: string; outflow: string }>(sql`
        SELECT s.currency,
          sum(CASE WHEN s.direction = 'in' THEN sa.amount_minor ELSE 0 END)::text AS inflow,
          sum(CASE WHEN s.direction = 'out' THEN sa.amount_minor ELSE 0 END)::text AS outflow
        FROM settlement_allocations sa
        JOIN settlements s ON s.id = sa.settlement_id AND s.workspace_id = sa.workspace_id
        JOIN financial_entries e ON e.id = sa.target_entry_id AND e.workspace_id = sa.workspace_id
        WHERE sa.workspace_id = ${ws} AND sa.reversed_at IS NULL AND s.state = 'confirmed' AND s.paid_at >= ${start} AND s.paid_at < ${end}
          AND EXISTS (SELECT 1 FROM financial_allocations fa WHERE fa.entry_id = e.id AND fa.workspace_id = e.workspace_id
            ${input.projectId ? sql`AND fa.project_id = ${input.projectId}` : sql``} ${scope ? sql`AND ${scope}` : sql``})
        GROUP BY s.currency`);
  const cash = cashRows.rows
    .map((r) => ({ currency: r.currency.trim(), inflows: BigInt(r.inflow ?? '0'), outflows: BigInt(r.outflow ?? '0') }))
    .filter((r) => r.inflows !== 0n || r.outflows !== 0n)
    .map((r) => ({ currency: r.currency, inflows: moneyOf(r.inflows, r.currency), outflows: moneyOf(r.outflows, r.currency), movement: moneyOf(r.inflows - r.outflows, r.currency) }));

  // Drafts: counted and summed separately, never in totals.
  const entryScope = entryVisibilitySql(ctx);
  const draftFilter = sql`financial_entries.workspace_id = ${ws} AND financial_entries.state IN ('draft', 'submitted') AND financial_entries.recognition_date BETWEEN ${input.periodStart} AND ${input.periodEnd}
      ${entryScope ? sql`AND ${entryScope}` : sql``}
      ${input.projectId ? sql`AND EXISTS (SELECT 1 FROM financial_allocations fa WHERE fa.entry_id = financial_entries.id AND fa.project_id = ${input.projectId})` : sql``}`;
  const draftRows = await db.execute<{ state: string; n: string }>(sql`SELECT financial_entries.state, count(*)::text AS n FROM financial_entries WHERE ${draftFilter} GROUP BY financial_entries.state`);
  const draftAmounts = await db.execute<{ currency: string; v: string }>(sql`
    SELECT l.currency, sum(${LINE_EFFECT_SQL('l')})::text AS v
    FROM financial_entry_lines l JOIN financial_entries ON financial_entries.id = l.entry_id AND financial_entries.workspace_id = l.workspace_id
    WHERE ${draftFilter}
    GROUP BY l.currency`);
  const drafts = {
    count: draftRows.rows.reduce((a, r) => a + Number(r.n), 0),
    submitted: Number(draftRows.rows.find((r) => r.state === 'submitted')?.n ?? 0),
    byCurrency: draftAmounts.rows.map((r) => moneyOf(BigInt(r.v ?? '0'), r.currency.trim())),
  };

  // Receivables / payables as of the period end.
  const docScope = input.projectId
    ? sql`EXISTS (SELECT 1 FROM financial_allocations fa WHERE fa.entry_id = financial_entries.id AND fa.project_id = ${input.projectId})`
    : scope
      ? sql`EXISTS (SELECT 1 FROM financial_allocations fa WHERE fa.entry_id = financial_entries.id AND ${allocationScope(ctx, 'financial_entries')})`
      : undefined;
  const outstanding = await documentOutstanding(ctx, { asOf: input.periodEnd, scope: docScope });
  const receivables = new Map<string, bigint>();
  const payables = new Map<string, bigint>();
  for (const o of outstanding) add(o.balanceMinor > 0n ? receivables : payables, o.currency, o.outstandingMinor);

  // Outstanding compensation (M39) — workspace-wide readers with compensation access.
  const outComp = new Map<string, bigint>();
  if (workspaceWide && can(ctx.actor.access, 'compensation.runs.read')) {
    const runs = await db
      .select({ id: compensationRuns.id })
      .from(compensationRuns)
      .where(and(eq(compensationRuns.workspaceId, ws), inArray(compensationRuns.state, ['approved', 'partially_paid', 'paid']), sql`${compensationRuns.periodEnd} <= ${input.periodEnd}`));
    for (const p of await runPayables(ctx, runs.map((r) => r.id), { asOf: input.periodEnd })) add(outComp, p.currency, p.outstandingMinor);
  }

  // Cost allocation coverage: explicit Unallocated remainders mark the result incomplete.
  const cov = await db.execute<{ unallocated: string; total: string }>(sql`
    SELECT coalesce(sum(CASE WHEN fa.project_id IS NULL THEN (CASE WHEN l.is_reversal THEN -fa.base_amount_minor ELSE fa.base_amount_minor END) ELSE 0 END), 0)::text AS unallocated,
           coalesce(sum(CASE WHEN l.is_reversal THEN -fa.base_amount_minor ELSE fa.base_amount_minor END), 0)::text AS total
    FROM financial_allocations fa
    JOIN financial_entry_lines l ON l.id = fa.line_id AND l.workspace_id = fa.workspace_id
    JOIN financial_entries e ON e.id = fa.entry_id AND e.workspace_id = fa.workspace_id
    WHERE fa.workspace_id = ${ws} AND e.state = 'posted' AND l.accounting_class IN ('operating_expense', 'compensation_expense')
      AND fa.effective_date BETWEEN ${input.periodStart} AND ${input.periodEnd}
      ${input.projectId ? sql`AND fa.project_id = ${input.projectId}` : sql``}
      ${scope ? sql`AND ${scope}` : sql``}`);
  const unallocated = BigInt(cov.rows[0]?.unallocated ?? '0');
  const totalCost = BigInt(cov.rows[0]?.total ?? '0');
  const coverage = totalCost > 0n ? new Big((totalCost - unallocated).toString()).times(100).div(totalCost.toString()).round(2, ROUND_HALF_EVEN).toFixed(2) : null;

  // Source match rate (M42): verified candidates / eligible; duplicates rejected shown apart.
  const match =
    workspaceWide || input.projectId
      ? await db.execute<{ reconciled: string; pending: string; dup: string }>(sql`
          SELECT count(*) FILTER (WHERE sc.state = 'verified')::text AS reconciled,
                 count(*) FILTER (WHERE sc.state = 'pending')::text AS pending,
                 count(*) FILTER (WHERE sc.state = 'rejected' AND EXISTS (SELECT 1 FROM financial_entries x WHERE x.workspace_id = sc.workspace_id AND x.source_namespace = sc.source_namespace AND x.source_external_id = sc.source_transaction_id))::text AS dup
          FROM sale_candidates sc
          WHERE sc.workspace_id = ${ws} AND sc.occurred_at >= ${start} AND sc.occurred_at < ${end}
            ${input.projectId ? sql`AND sc.project_id = ${input.projectId}` : sql``}`)
      : null;
  const reconciled = Number(match?.rows[0]?.reconciled ?? 0);
  const eligible = reconciled + Number(match?.rows[0]?.pending ?? 0);

  const unmatched = workspaceWide
    ? Number(
        (await db.execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM settlements WHERE workspace_id = ${ws} AND paid_at >= ${start} AND paid_at < ${end} AND (state = 'draft' OR (state = 'confirmed' AND unallocated_minor > 0))`)).rows[0]?.n ?? 0,
      )
    : 0;
  const [lock] = await db
    .select()
    .from(periodLocks)
    .where(and(eq(periodLocks.workspaceId, ws), eq(periodLocks.state, 'locked'), sql`${periodLocks.periodStart} <= ${input.periodEnd} AND ${periodLocks.periodEnd} >= ${input.periodStart}`))
    .limit(1);

  const byProjectRows = await db.execute<{ project_id: string | null; rev: string; cost: string }>(sql`
    SELECT fa.project_id,
      sum(CASE WHEN l.accounting_class IN ('revenue', 'contra_revenue', 'fee') THEN (CASE WHEN l.accounting_class = 'revenue' THEN 1 ELSE -1 END) * (CASE WHEN l.is_reversal THEN -fa.base_amount_minor ELSE fa.base_amount_minor END) ELSE 0 END)::text AS rev,
      sum(CASE WHEN l.accounting_class IN ('operating_expense', 'compensation_expense') THEN (CASE WHEN l.is_reversal THEN -fa.base_amount_minor ELSE fa.base_amount_minor END) ELSE 0 END)::text AS cost
    FROM financial_allocations fa
    JOIN financial_entry_lines l ON l.id = fa.line_id AND l.workspace_id = fa.workspace_id
    JOIN financial_entries e ON e.id = fa.entry_id AND e.workspace_id = fa.workspace_id
    WHERE fa.workspace_id = ${ws} AND e.state = 'posted' AND fa.effective_date BETWEEN ${input.periodStart} AND ${input.periodEnd}
      ${input.projectId ? sql`AND fa.project_id = ${input.projectId}` : sql``}
      ${scope ? sql`AND ${scope}` : sql``}
    GROUP BY fa.project_id
    ORDER BY abs(sum(CASE WHEN l.is_reversal THEN -fa.base_amount_minor ELSE fa.base_amount_minor END)) DESC NULLS LAST
    LIMIT 50`);
  const pids = byProjectRows.rows.map((r) => r.project_id).filter((p): p is string => !!p);
  const pnames = pids.length ? await db.select({ id: projects.id, name: projects.name }).from(projects).where(and(eq(projects.workspaceId, ws), inArray(projects.id, pids))) : [];

  return {
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    baseCurrency,
    accrual,
    cash,
    drafts,
    receivables: [...receivables.entries()].filter(([, v]) => v !== 0n).map(([c, v]) => moneyOf(v, c)),
    payables: [...payables.entries()].filter(([, v]) => v !== 0n).map(([c, v]) => moneyOf(v, c)),
    outstandingCompensation: [...outComp.entries()].filter(([, v]) => v !== 0n).map(([c, v]) => moneyOf(v, c)),
    unallocatedCosts: moneyOf(unallocated, baseCurrency),
    costAllocationCoverage: coverage,
    sourceMatch: {
      reconciled,
      eligible,
      duplicatesRejected: Number(match?.rows[0]?.dup ?? 0),
      ratePercent: eligible > 0 ? new Big(reconciled).times(100).div(eligible).round(2, ROUND_HALF_EVEN).toFixed(2) : null,
    },
    unmatchedSettlements: unmatched,
    periodLock: lock ? { id: lock.id, periodStart: lock.periodStart, periodEnd: lock.periodEnd } : null,
    byProject: byProjectRows.rows.map((r) => {
      const rev = BigInt(r.rev ?? '0');
      const cost = BigInt(r.cost ?? '0');
      return {
        project: r.project_id ? { id: r.project_id, name: pnames.find((p) => p.id === r.project_id)?.name ?? 'Unavailable project' } : null,
        netRevenue: moneyOf(rev, baseCurrency),
        costs: moneyOf(cost, baseCurrency),
        result: moneyOf(rev - cost, baseCurrency),
      };
    }),
  };
};

/** Project workspace Finance tab: only the parts the member may see (T016: amounts omitted otherwise). */
export const projectFinanceSummary = async (ctx: QueryContext, projectId: string, input: { periodStart: string; periodEnd: string }) => {
  const db = dbOf(ctx);
  const [p] = await db.select().from(projects).where(and(eq(projects.workspaceId, ctx.actor.workspaceId), eq(projects.id, projectId)));
  const scope = p ? { objectType: 'project', objectId: p.id, projectId: p.id, directionId: p.directionId } : null;
  const finance = !!scope && can(ctx.actor.access, 'finance.read', scope);
  const budgetsRead = !!scope && can(ctx.actor.access, 'budgets.read', scope);
  if (!p || !scope || (!finance && !budgetsRead && !can(ctx.actor.access, 'projects.read', scope))) throw new AppError('NOT_FOUND', 'Project was not found.');
  if (!finance && !budgetsRead) throw new AppError('FORBIDDEN', 'Finance for this project needs finance or budget access.');
  const { baseCurrency } = await workspaceFinance(ctx);
  const out: Record<string, unknown> = {
    project: { id: p.id, name: p.name },
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    baseCurrency,
    permissions: { finance, budgets: budgetsRead, createEntry: can(ctx.actor.access, 'finance.create', scope) },
  };
  if (finance) {
    out.accrual = accrualView(await accrualSummary(ctx, { ...input, projectId }), baseCurrency);
    const rows = await db
      .select()
      .from(financialEntries)
      .where(and(eq(financialEntries.workspaceId, ctx.actor.workspaceId), sql`EXISTS (SELECT 1 FROM financial_allocations fa WHERE fa.entry_id = ${financialEntries.id} AND fa.project_id = ${projectId})`))
      .orderBy(desc(financialEntries.recognitionDate), desc(financialEntries.id))
      .limit(10);
    out.recentEntries = await entryRows(ctx, rows);
  }
  if (budgetsRead) {
    const bs = await db
      .select()
      .from(budgets)
      .where(and(eq(budgets.workspaceId, ctx.actor.workspaceId), eq(budgets.scopeType, 'project'), eq(budgets.scopeId, projectId), isNull(budgets.archivedAt)))
      .orderBy(desc(budgets.periodStart))
      .limit(10);
    out.budgets = await budgetRows(ctx, bs);
    const cs = await db
      .select()
      .from(commitments)
      .where(and(eq(commitments.workspaceId, ctx.actor.workspaceId), eq(commitments.projectId, projectId), inArray(commitments.state, ['open', 'partially_consumed'])))
      .orderBy(desc(commitments.createdAt))
      .limit(20);
    out.commitments = await commitmentViews(ctx, cs);
  }
  return out as never;
};

/** Deal panel (T138): only real linked entries; a Won stage never creates income. */
export const dealFinanceSummary = async (ctx: QueryContext, dealId: string) => {
  const db = dbOf(ctx);
  const [d] = await db.select().from(deals).where(and(eq(deals.workspaceId, ctx.actor.workspaceId), eq(deals.id, dealId)));
  const dealScope = d ? { objectType: 'deal', objectId: d.id, ownerMembershipId: d.ownerMembershipId } : null;
  if (!d || !dealScope || !(can(ctx.actor.access, 'deals.read', dealScope) || can(ctx.actor.access, 'finance.read'))) throw new AppError('NOT_FOUND', 'Deal was not found.');
  const rows = await db.select().from(financialEntries).where(and(eq(financialEntries.workspaceId, ctx.actor.workspaceId), eq(financialEntries.dealId, dealId))).orderBy(desc(financialEntries.recognitionDate)).limit(50);
  const out: Record<string, unknown> = {
    dealId,
    entries: await entryRows(ctx, rows),
    explanation: 'A won or fulfilled deal does not create income by itself. Income appears here only when a financial entry linked to the deal is posted; payments appear when a settlement is recorded.',
  };
  if (can(ctx.actor.access, 'finance.read')) {
    const { baseCurrency } = await workspaceFinance(ctx);
    const r = await db.execute<{ v: string | null }>(sql`
      SELECT sum((CASE WHEN l.accounting_class = 'revenue' THEN 1 WHEN l.accounting_class IN ('contra_revenue', 'fee') THEN -1 ELSE 0 END) * (CASE WHEN l.is_reversal THEN -l.base_amount_minor ELSE l.base_amount_minor END))::text AS v
      FROM financial_entry_lines l JOIN financial_entries e ON e.id = l.entry_id
      WHERE e.workspace_id = ${ctx.actor.workspaceId} AND e.state = 'posted' AND e.deal_id = ${dealId}`);
    out.postedIncome = moneyOf(BigInt(r.rows[0]?.v ?? '0'), baseCurrency);
    const rec = await db.execute<{ currency: string; v: string }>(sql`
      SELECT s.currency, sum(sa.amount_minor)::text AS v FROM settlement_allocations sa
      JOIN settlements s ON s.id = sa.settlement_id JOIN financial_entries e ON e.id = sa.target_entry_id
      WHERE sa.workspace_id = ${ctx.actor.workspaceId} AND e.deal_id = ${dealId} AND sa.reversed_at IS NULL AND s.state = 'confirmed' AND s.direction = 'in'
      GROUP BY s.currency`);
    out.received = rec.rows.map((x) => moneyOf(BigInt(x.v), x.currency.trim()));
  }
  return out as never;
};

/** Campaign "Budget" tab: campaign budgets and the costs allocated to the campaign. */
export const campaignFinanceSummary = async (ctx: QueryContext, campaignId: string) => {
  requirePermission(ctx, 'budgets.read');
  const db = dbOf(ctx);
  const [c] = await db.select().from(campaigns).where(and(eq(campaigns.workspaceId, ctx.actor.workspaceId), eq(campaigns.id, campaignId)));
  if (!c) throw new AppError('NOT_FOUND', 'Campaign was not found.');
  const bs = await db.select().from(budgets).where(and(eq(budgets.workspaceId, ctx.actor.workspaceId), eq(budgets.scopeType, 'campaign'), eq(budgets.scopeId, campaignId))).orderBy(desc(budgets.periodStart));
  const visible = bs.filter((b) => can(ctx.actor.access, 'budgets.read', { objectType: 'budget', objectId: b.id, ownerMembershipId: b.ownerMembershipId }));
  const out: Record<string, unknown> = { campaignId, budgets: await budgetRows(ctx, visible) };
  if (can(ctx.actor.access, 'finance.read')) {
    const { baseCurrency } = await workspaceFinance(ctx);
    const s = await accrualSummary(ctx, { periodStart: c.startDate, periodEnd: c.endDate, campaignId });
    out.actual = moneyOf(s.operatingExpenses + s.compensationExpense, baseCurrency);
    const rows = await db
      .select()
      .from(financialEntries)
      .where(
        and(
          eq(financialEntries.workspaceId, ctx.actor.workspaceId),
          or(eq(financialEntries.campaignId, campaignId), sql`EXISTS (SELECT 1 FROM financial_allocations fa WHERE fa.entry_id = ${financialEntries.id} AND fa.campaign_id = ${campaignId})`),
        ),
      )
      .orderBy(desc(financialEntries.recognitionDate))
      .limit(20);
    out.entries = await entryRows(ctx, rows);
  }
  return out as never;
};

/**
 * Member Workspace "Compensation" tab / pay slip: own data with compensation.own.read, anyone's
 * with compensation.runs.read. Other members' lines are never included.
 */
export const memberCompensation = async (ctx: QueryContext, membershipId: string) => {
  const self = ctx.actor.membershipId === membershipId;
  const all = can(ctx.actor.access, 'compensation.runs.read');
  if (!(all || (self && hasAnywhere(ctx.actor.access, 'compensation.own.read')))) {
    if (hasAnywhere(ctx.actor.access, 'compensation.own.read')) throw new AppError('FORBIDDEN', 'You can only see your own compensation.');
    throw new AppError('FORBIDDEN', 'You do not have permission to perform this action.');
  }
  const db = dbOf(ctx);
  const ws = ctx.actor.workspaceId;
  const member = (await loadMemberRefs(db, ws, [membershipId])).get(membershipId);
  if (!member) throw new AppError('NOT_FOUND', 'Member was not found.');
  const roleIds = (await db.select({ roleId: roleAssignments.roleId }).from(roleAssignments).where(and(eq(roleAssignments.workspaceId, ws), eq(roleAssignments.membershipId, membershipId), isNull(roleAssignments.revokedAt)))).map((r) => r.roleId);
  const rules = await db
    .select()
    .from(compensationRules)
    .where(and(eq(compensationRules.workspaceId, ws), isNull(compensationRules.archivedAt), or(eq(compensationRules.recipientMembershipId, membershipId), roleIds.length ? inArray(compensationRules.recipientRoleId, roleIds) : sql`false`)));
  const runIds = (
    await db
      .selectDistinct({ runId: compensationLines.runId })
      .from(compensationLines)
      .innerJoin(compensationRuns, and(eq(compensationRuns.id, compensationLines.runId), eq(compensationRuns.calculationVersion, compensationLines.calculationVersion)))
      .where(and(eq(compensationLines.workspaceId, ws), eq(compensationLines.recipientMembershipId, membershipId), inArray(compensationRuns.state, ['approved', 'partially_paid', 'paid'])))
  ).map((r) => r.runId);
  const runs = runIds.length ? await db.select().from(compensationRuns).where(inArray(compensationRuns.id, runIds)).orderBy(desc(compensationRuns.periodEnd)) : [];
  const lines = runIds.length ? await db.select().from(compensationLines).where(and(eq(compensationLines.workspaceId, ws), inArray(compensationLines.runId, runIds), eq(compensationLines.recipientMembershipId, membershipId))) : [];
  const payables = (await runPayables(ctx, runIds)).filter((p) => p.recipientMembershipId === membershipId);
  const pending = await db
    .select()
    .from(compensationAdjustments)
    .where(
      and(
        eq(compensationAdjustments.workspaceId, ws),
        eq(compensationAdjustments.recipientMembershipId, membershipId),
        or(eq(compensationAdjustments.state, 'draft'), and(eq(compensationAdjustments.state, 'approved'), isNull(compensationAdjustments.appliedRunId))),
      ),
    );
  const outstanding = new Map<string, bigint>();
  for (const p of payables) add(outstanding, p.currency, p.outstandingMinor);
  const carry = new Map<string, bigint>();
  for (const a of pending.filter((x) => x.kind === 'carry_forward' && x.state === 'approved')) add(carry, a.currency.trim(), a.amountMinor);
  return {
    member,
    rules: await ruleRows(ctx, rules),
    runs: runs.map((r) => {
      const mine = lines.filter((l) => l.runId === r.id && l.calculationVersion === r.calculationVersion);
      const totals = recipientTotals(mine.map((l) => ({ recipientMembershipId: l.recipientMembershipId, currency: l.currency.trim(), amountMinor: l.amountMinor, excluded: l.excluded })));
      return {
        run: { id: r.id, periodStart: r.periodStart, periodEnd: r.periodEnd, state: r.state },
        lines: mine.map((l) => ({
          id: l.id,
          recipient: member,
          ruleVersionId: l.ruleVersionId,
          ruleName: null,
          adjustmentId: l.adjustmentId,
          sourceType: l.sourceType,
          sourceId: l.sourceId,
          sourceLabel: (l.explanation.sourceLabel as string | undefined) ?? null,
          component: l.component,
          entitlementKey: l.entitlementKey,
          quantity: l.quantity,
          rate: l.rate,
          amount: moneyOf(l.amountMinor, l.currency.trim()),
          excluded: l.excluded,
          exclusionReason: l.exclusionReason,
          explanation: l.explanation,
        })),
        totals: totals.map((t) => {
          const p = payables.find((x) => x.runId === r.id && x.currency === t.currency);
          return {
            recipient: member,
            currency: t.currency,
            total: moneyOf(t.totalMinor, t.currency),
            payable: moneyOf(t.payableMinor, t.currency),
            carryForward: moneyOf(t.carryForwardMinor, t.currency),
            paid: moneyOf(p?.paidMinor ?? 0n, t.currency),
            outstanding: moneyOf(p?.outstandingMinor ?? t.payableMinor, t.currency),
          };
        }),
      };
    }),
    outstanding: [...outstanding.entries()].filter(([, v]) => v !== 0n).map(([c, v]) => moneyOf(v, c)),
    carryForward: [...carry.entries()].map(([c, v]) => moneyOf(v, c)),
    pendingAdjustments: await adjustmentViews(ctx, pending),
  };
};
