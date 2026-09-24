import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { budgetLines, budgets } from '@castlane/database';
import { budgetFigures, type BudgetFigures } from '@castlane/domain';
import { dbOf, type CommandContext, type QueryContext } from '../core/context';

type BudgetRow = typeof budgets.$inferSelect;

export interface BudgetComputation {
  total: BudgetFigures;
  byCategory: Map<string, BudgetFigures>;
  /** Actual amounts in currencies that cannot be compared (budget currency ≠ base currency). */
  excluded: Map<string, bigint>;
}

/** SQL fragment restricting allocations/commitments to the budget scope. */
const scopeClause = (b: BudgetRow, projectCol: SQL, campaignCol?: SQL): SQL => {
  switch (b.scopeType) {
    case 'project':
      return sql`${projectCol} = ${b.scopeId}`;
    case 'direction':
      return sql`${projectCol} IN (SELECT p.id FROM projects p WHERE p.workspace_id = ${b.workspaceId} AND p.direction_id = ${b.scopeId})`;
    case 'campaign':
      return campaignCol ? sql`${campaignCol} = ${b.scopeId}` : sql`false`;
    default:
      return sql`true`;
  }
};

/**
 * Planned (approved version or a given version), actual (posted expense allocations in the budget
 * scope and period) and committed (remaining open commitments) per category (spec §18.5, M38).
 */
export const computeBudget = async (
  ctx: QueryContext | CommandContext,
  b: BudgetRow,
  baseCurrency: string,
  versionId: string | null = b.approvedVersionId,
): Promise<BudgetComputation | null> => {
  if (!versionId) return null;
  const db = dbOf(ctx);
  const lines = await db.select().from(budgetLines).where(and(eq(budgetLines.workspaceId, b.workspaceId), eq(budgetLines.budgetVersionId, versionId)));
  const categoryIds = lines.map((l) => l.categoryId);
  const currency = b.currency.trim();
  const useBase = currency === baseCurrency;
  const actual = new Map<string, bigint>();
  const excluded = new Map<string, bigint>();
  if (categoryIds.length) {
    const rows = await db.execute<{ category_id: string; currency: string; amt: string | null; base: string | null }>(sql`
      SELECT l.category_id, l.currency,
        sum(CASE WHEN l.is_reversal THEN -fa.amount_minor ELSE fa.amount_minor END)::text AS amt,
        sum(CASE WHEN l.is_reversal THEN -fa.base_amount_minor ELSE fa.base_amount_minor END)::text AS base
      FROM financial_allocations fa
      JOIN financial_entry_lines l ON l.id = fa.line_id AND l.workspace_id = fa.workspace_id
      JOIN financial_entries e ON e.id = fa.entry_id AND e.workspace_id = fa.workspace_id
      WHERE fa.workspace_id = ${b.workspaceId}
        AND e.state = 'posted'
        AND fa.effective_date >= ${b.periodStart} AND fa.effective_date <= ${b.periodEnd}
        AND l.category_id IN (${sql.join(categoryIds.map((c) => sql`${c}::uuid`), sql`, `)})
        AND ${scopeClause(b, sql`fa.project_id`, sql`coalesce(fa.campaign_id, e.campaign_id)`)}
      GROUP BY l.category_id, l.currency`);
    for (const r of rows.rows) {
      const cur = r.currency.trim();
      if (useBase) actual.set(r.category_id, (actual.get(r.category_id) ?? 0n) + BigInt(r.base ?? '0'));
      else if (cur === currency) actual.set(r.category_id, (actual.get(r.category_id) ?? 0n) + BigInt(r.amt ?? '0'));
      else excluded.set(cur, (excluded.get(cur) ?? 0n) + BigInt(r.amt ?? '0'));
    }
  }
  const committed = new Map<string, bigint>();
  if (categoryIds.length) {
    const rows = await db.execute<{ category_id: string; remaining: string | null }>(sql`
      SELECT c.category_id, sum(c.amount_minor - c.consumed_minor)::text AS remaining
      FROM commitments c
      WHERE c.workspace_id = ${b.workspaceId}
        AND c.state IN ('open', 'partially_consumed')
        AND c.currency = ${currency}
        AND c.category_id IN (${sql.join(categoryIds.map((c) => sql`${c}::uuid`), sql`, `)})
        AND (c.budget_id IS NULL OR c.budget_id = ${b.id})
        AND (c.due_date IS NULL OR (c.due_date >= ${b.periodStart} AND c.due_date <= ${b.periodEnd}))
        AND ${b.scopeType === 'campaign' ? sql`c.budget_id = ${b.id}` : scopeClause(b, sql`c.project_id`)}
      GROUP BY c.category_id`);
    for (const r of rows.rows) committed.set(r.category_id, BigInt(r.remaining ?? '0'));
  }
  const byCategory = new Map<string, BudgetFigures>();
  let p = 0n;
  let a = 0n;
  let c = 0n;
  for (const l of lines) {
    const act = actual.get(l.categoryId) ?? 0n;
    const com = committed.get(l.categoryId) ?? 0n;
    byCategory.set(l.categoryId, budgetFigures(l.plannedMinor, act, com));
    p += l.plannedMinor;
    a += act;
    c += com;
  }
  return { total: budgetFigures(p, a, c), byCategory, excluded };
};

export const budgetsCovering = async (
  ctx: QueryContext | CommandContext,
  input: { projectIds: string[]; campaignIds: string[]; date: string },
) => {
  const db = dbOf(ctx);
  const ws = ctx.actor.workspaceId;
  const scope: SQL[] = [sql`${budgets.scopeType} = 'workspace'`];
  if (input.projectIds.length) {
    scope.push(sql`(${budgets.scopeType} = 'project' AND ${budgets.scopeId} IN (${sql.join(input.projectIds.map((p) => sql`${p}::uuid`), sql`, `)}))`);
    scope.push(
      sql`(${budgets.scopeType} = 'direction' AND ${budgets.scopeId} IN (SELECT p.direction_id FROM projects p WHERE p.workspace_id = ${ws} AND p.id IN (${sql.join(input.projectIds.map((p) => sql`${p}::uuid`), sql`, `)})))`,
    );
  }
  if (input.campaignIds.length) scope.push(sql`(${budgets.scopeType} = 'campaign' AND ${budgets.scopeId} IN (${sql.join(input.campaignIds.map((p) => sql`${p}::uuid`), sql`, `)}))`);
  return db
    .select()
    .from(budgets)
    .where(
      and(
        eq(budgets.workspaceId, ws),
        sql`${budgets.approvedVersionId} IS NOT NULL`,
        sql`${budgets.archivedAt} IS NULL`,
        sql`${budgets.periodStart} <= ${input.date} AND ${budgets.periodEnd} >= ${input.date}`,
        sql`(${sql.join(scope, sql` OR `)})`,
      ),
    );
};

export const budgetsByIds = (ctx: QueryContext | CommandContext, ids: string[]) =>
  ids.length ? dbOf(ctx).select().from(budgets).where(and(eq(budgets.workspaceId, ctx.actor.workspaceId), inArray(budgets.id, ids))) : Promise.resolve([]);
