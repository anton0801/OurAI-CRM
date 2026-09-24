import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { financeCategories, financialAllocations, financialEntries, financialEntryLines, projects } from '@castlane/database';
import { AppError, allocateLargestRemainder, formatMinor, newId } from '@castlane/domain';
import { allowed, requirePermission } from '../core/access';
import { audit } from '../core/audit';
import { dbOf, type CommandContext, type QueryContext } from '../core/context';
import { emit } from '../core/events';
import { stamp, touch } from '../core/rows';
import { canSeeCampaignCosts } from './campaigns';
import { sharePercent, splitCostMinor, type CostSplitMethod } from './logic';
import { loadCampaignRow } from './scope';
import { assertPeriodOpen } from '../finance/common';

/**
 * Campaign costs (S34 Costs, §12/§18.3, T071). Costs exist only as finance allocations: an expense
 * line of an entry linked to the campaign is split across the campaign's projects so the parts sum
 * exactly to the line amount (largest remainder, deterministic). A campaign total counts each
 * allocation row once; descriptive tags of placements never add costs.
 *
 * Integration note for the finance module: `writeCampaignCostAllocations` is the single place that
 * writes `financial_allocations` for campaigns. When finance exposes its allocation command (preview
 * token, posted-period adjustments), replace the body of this function with a call to it.
 */

const COST_CLASSES = ['operating_expense', 'compensation_expense'] as const;

type LineRow = typeof financialEntryLines.$inferSelect;
type EntryRow = typeof financialEntries.$inferSelect;

type AllocRow = typeof financialAllocations.$inferSelect;

/** Net amount per (project, campaign, content) of one line: finance keeps posted allocations append-only. */
export const netLineAllocations = (rows: AllocRow[]) => {
  const net = new Map<string, { a: AllocRow; amount: bigint; base: bigint | null; last: AllocRow }>();
  for (const a of rows) {
    const k = `${a.projectId}|${a.campaignId}|${a.contentItemId}`;
    const cur = net.get(k) ?? { a, amount: 0n, base: null, last: a };
    cur.amount += a.amountMinor;
    if (a.baseAmountMinor !== null) cur.base = (cur.base ?? 0n) + a.baseAmountMinor;
    if (a.createdAt >= cur.last.createdAt) cur.last = a;
    net.set(k, cur);
  }
  return [...net.values()].filter((n) => n.amount !== 0n || (n.base ?? 0n) !== 0n);
};

/**
 * Re-split one expense line across projects, tagged with the campaign, using the finance model:
 * drafts are replaced; posted entries keep their history — the current split is transferred out with
 * negative adjustment rows and the new split is added (never a second expense, T071). Closed periods
 * are respected (T136).
 */
export const writeCampaignCostAllocations = async (
  ctx: CommandContext,
  input: { line: LineRow; entry: EntryRow; campaignId: string; parts: Map<string, bigint>; method: CostSplitMethod; reason?: string },
) => {
  if (input.entry.state === 'submitted') throw new AppError('INVALID_STATE', 'This entry is waiting for review. Allocate it after it is posted or returned to draft.');
  const at = ctx.app.clock.now();
  const posted = input.entry.state === 'posted';
  const effectiveDate = posted ? at.toISOString().slice(0, 10) : input.entry.recognitionDate;
  if (posted) await assertPeriodOpen(ctx, effectiveDate, 'allocate');
  const existing = await ctx.tx
    .select()
    .from(financialAllocations)
    .where(and(eq(financialAllocations.workspaceId, ctx.actor.workspaceId), eq(financialAllocations.lineId, input.line.id)));
  const entries = [...input.parts.entries()].filter(([, v]) => v !== 0n);
  // Base-currency equivalents are split with the same weights, so they also sum exactly.
  const base =
    input.line.baseAmountMinor !== null && entries.length
      ? allocateLargestRemainder(input.line.baseAmountMinor, entries.map(([k, v]) => ({ key: k, weight: v.toString() })))
      : null;
  const snapshot = { method: input.method, campaignId: input.campaignId, shares: entries.map(([p, v]) => ({ projectId: p, amountMinor: v.toString() })), reason: input.reason ?? null };
  if (posted) {
    for (const n of netLineAllocations(existing))
      await ctx.tx.insert(financialAllocations).values({
        ...stamp(ctx),
        id: newId(),
        lineId: input.line.id,
        entryId: input.entry.id,
        projectId: n.a.projectId,
        campaignId: n.a.campaignId,
        contentItemId: n.a.contentItemId,
        amountMinor: -n.amount,
        baseAmountMinor: n.base === null ? null : -n.base,
        ruleSnapshot: { adjustment: 'transfer_out', campaignId: input.campaignId },
        effectiveDate,
        adjustmentOfId: n.last.id,
      });
  } else if (existing.length) {
    await ctx.tx.delete(financialAllocations).where(and(eq(financialAllocations.workspaceId, ctx.actor.workspaceId), eq(financialAllocations.lineId, input.line.id)));
  }
  for (const [projectId, amountMinor] of entries)
    await ctx.tx.insert(financialAllocations).values({
      ...stamp(ctx),
      id: newId(),
      lineId: input.line.id,
      entryId: input.entry.id,
      projectId,
      campaignId: input.campaignId,
      amountMinor,
      baseAmountMinor: base ? (base.get(projectId) ?? null) : null,
      sharePercent: sharePercent(amountMinor, input.line.amountMinor),
      ruleSnapshot: posted ? { ...snapshot, adjustment: 'transfer_in' } : snapshot,
      effectiveDate,
      // A posted document is re-allocated as an adjustment of its previous split, never a second expense.
      adjustmentOfId: posted ? (existing[existing.length - 1]?.id ?? null) : null,
    });
  await ctx.tx.update(financialEntries).set({ ...touch(ctx, financialEntries) }).where(eq(financialEntries.id, input.entry.id));
  return entries.length;
};

const campaignLines = async (ctx: QueryContext | CommandContext, campaignId: string) => {
  const db = dbOf(ctx);
  const ws = ctx.actor.workspaceId;
  return db
    .select({ line: financialEntryLines, entry: financialEntries, category: financeCategories.name })
    .from(financialEntryLines)
    .innerJoin(financialEntries, and(eq(financialEntries.workspaceId, financialEntryLines.workspaceId), eq(financialEntries.id, financialEntryLines.entryId)))
    .innerJoin(financeCategories, and(eq(financeCategories.workspaceId, financialEntryLines.workspaceId), eq(financeCategories.id, financialEntryLines.categoryId)))
    .where(
      and(
        eq(financialEntryLines.workspaceId, ws),
        eq(financialEntryLines.isReversal, false),
        inArray(financialEntryLines.accountingClass, [...COST_CLASSES]),
        isNull(financialEntries.reversesEntryId),
        isNull(financialEntries.reversedByEntryId),
        sql`${financialEntries.state} <> 'rejected'`,
        or(
          eq(financialEntries.campaignId, campaignId),
          sql`EXISTS (SELECT 1 FROM financial_allocations fa WHERE fa.line_id = ${financialEntryLines.id} AND fa.campaign_id = ${campaignId}::uuid GROUP BY fa.line_id HAVING sum(fa.amount_minor) <> 0)`,
        ),
      ),
    )
    .orderBy(financialEntries.recognitionDate, financialEntryLines.lineNo);
};

export const getCampaignCosts = async (ctx: QueryContext | CommandContext, campaignId: string) => {
  requirePermission(ctx, 'finance.read');
  const { campaign: c, projectIds } = await loadCampaignRow(ctx, campaignId);
  if (!canSeeCampaignCosts(ctx, projectIds)) throw new AppError('FORBIDDEN', 'Campaign costs need finance access to every project of the campaign.');
  const db = dbOf(ctx);
  const ws = ctx.actor.workspaceId;
  const lines = await campaignLines(ctx, campaignId);
  const rawAllocations = lines.length
    ? await db
        .select()
        .from(financialAllocations)
        .where(and(eq(financialAllocations.workspaceId, ws), inArray(financialAllocations.lineId, lines.map((l) => l.line.id))))
    : [];
  // Current split = net of all rows per line and target (posted re-allocations are append-only).
  const allocations = lines.flatMap(({ line }) =>
    netLineAllocations(rawAllocations.filter((a) => a.lineId === line.id)).map((n) => ({
      ...n.last,
      amountMinor: n.amount,
      baseAmountMinor: n.base,
      sharePercent: sharePercent(n.amount, line.amountMinor),
    })),
  );
  const projectIdsAll = [...new Set(allocations.map((a) => a.projectId).filter((x): x is string => !!x))];
  const names = new Map(
    (projectIdsAll.length ? await db.select({ id: projects.id, name: projects.name }).from(projects).where(and(eq(projects.workspaceId, ws), inArray(projects.id, projectIdsAll))) : []).map((p) => [p.id, p.name]),
  );
  const totals = new Map<string, { posted: bigint; pending: bigint }>();
  let incomplete = false;
  const canAllocate = projectIds.length > 0 && projectIds.every((p) => allowed(ctx, 'finance.allocate', { projectId: p })) && c.status !== 'archived';
  const out = lines.map(({ line, entry, category }) => {
    const mine = allocations.filter((a) => a.lineId === line.id);
    const allocated = mine.reduce((s, a) => s + a.amountMinor, 0n);
    const forCampaign = mine.filter((a) => a.campaignId === campaignId).reduce((s, a) => s + a.amountMinor, 0n);
    // Not yet split: the whole line of a campaign-linked entry is the campaign's (Unallocated to projects).
    const campaignMinor = mine.length === 0 && entry.campaignId === campaignId ? line.amountMinor : forCampaign;
    const unallocatedMinor = line.amountMinor - allocated;
    if (unallocatedMinor !== 0n || mine.some((a) => !a.projectId)) incomplete = true;
    const t = totals.get(line.currency) ?? { posted: 0n, pending: 0n };
    if (entry.state === 'posted') t.posted += campaignMinor;
    else t.pending += campaignMinor;
    totals.set(line.currency, t);
    return {
      lineId: line.id,
      entryId: entry.id,
      entryTitle: entry.title,
      entryState: entry.state,
      recognitionDate: entry.recognitionDate,
      category,
      amount: { amount: formatMinor(line.amountMinor, line.currency), currency: line.currency },
      allocations: mine.map((a) => ({
        id: a.id,
        project: a.projectId && allowed(ctx, 'finance.read', { projectId: a.projectId }) ? { id: a.projectId, name: names.get(a.projectId) ?? 'Project' } : null,
        amount: { amount: formatMinor(a.amountMinor, line.currency), currency: line.currency },
        sharePercent: a.sharePercent,
      })),
      campaignAmount: { amount: formatMinor(campaignMinor, line.currency), currency: line.currency },
      unallocated: unallocatedMinor !== 0n ? { amount: formatMinor(unallocatedMinor, line.currency), currency: line.currency } : null,
      canAllocate,
    };
  });
  return {
    totals: [...totals.entries()].map(([currency, t]) => ({ currency, posted: formatMinor(t.posted, currency), pending: formatMinor(t.pending, currency) })),
    lines: out,
    incompleteAllocation: incomplete,
    note: 'Costs come from finance allocations. Each allocation is counted once; descriptive tags never add costs. Pending covers draft and submitted entries.',
  };
};

export const allocateCampaignCost = async (
  ctx: CommandContext,
  campaignId: string,
  input: { lineId: string; method: CostSplitMethod; shares: { projectId: string; weight?: string; amount?: string }[]; reason?: string },
) => {
  requirePermission(ctx, 'finance.allocate');
  const { campaign: c, projectIds } = await loadCampaignRow(ctx, campaignId, { lock: true });
  if (c.status === 'archived') throw new AppError('INVALID_STATE', 'Restore the campaign before allocating costs.');
  const [row] = await ctx.tx
    .select({ line: financialEntryLines, entry: financialEntries })
    .from(financialEntryLines)
    .innerJoin(financialEntries, and(eq(financialEntries.workspaceId, financialEntryLines.workspaceId), eq(financialEntries.id, financialEntryLines.entryId)))
    .where(and(eq(financialEntryLines.workspaceId, ctx.actor.workspaceId), eq(financialEntryLines.id, input.lineId)))
    .for('update');
  const fail = (message: string) => new AppError('VALIDATION_FAILED', message, { fieldErrors: [{ field: 'lineId', code: 'INVALID', message }] });
  if (!row) throw fail('Choose an expense line of this campaign.');
  const { line, entry } = row;
  if (entry.state === 'rejected' || entry.reversesEntryId || entry.reversedByEntryId || line.isReversal) throw fail('Rejected, reversed or reversal documents cannot be allocated.');
  if (!(COST_CLASSES as readonly string[]).includes(line.accountingClass)) throw fail('Only expense lines can be allocated as campaign costs.');
  const lineRows = await ctx.tx.select().from(financialAllocations).where(and(eq(financialAllocations.workspaceId, ctx.actor.workspaceId), eq(financialAllocations.lineId, line.id)));
  const currentSplit = netLineAllocations(lineRows);
  const linked = currentSplit.some((n) => n.a.campaignId === campaignId);
  if (entry.campaignId !== campaignId && !linked) throw fail('Link the financial entry to this campaign in Finance first.');
  const targets = input.shares.map((s) => s.projectId);
  if (targets.some((p) => !projectIds.includes(p)))
    throw new AppError('VALIDATION_FAILED', 'Allocate only to projects of this campaign.', { fieldErrors: [{ field: 'shares', code: 'OTHER_PROJECT', message: 'Allocate only to projects of this campaign.' }] });
  const touched = [...new Set([...targets, ...currentSplit.map((n) => n.a.projectId).filter((x): x is string => !!x)])];
  if (!touched.every((p) => allowed(ctx, 'finance.allocate', { projectId: p }))) throw new AppError('FORBIDDEN', 'You cannot allocate costs to all of these projects.');
  const split = splitCostMinor(line.amountMinor, line.currency, input.method, input.shares);
  if (!split.ok) throw new AppError('VALIDATION_FAILED', split.error, { fieldErrors: [{ field: 'shares', code: 'INVALID_SPLIT', message: split.error }] });
  const n = await writeCampaignCostAllocations(ctx, { line, entry, campaignId, parts: split.parts, method: input.method, reason: input.reason });
  await audit(ctx, {
    action: 'campaign.cost_allocated',
    entityType: 'campaign',
    entityId: campaignId,
    projectId: projectIds[0] ?? null,
    reason: input.reason ?? null,
    sensitivity: 'finance',
    metadata: { lineId: line.id, entryId: entry.id, method: input.method, parts: n },
  });
  await emit(ctx, { type: 'campaign.cost_allocated', entityType: 'campaign', entityId: campaignId, payload: { entryId: entry.id } });
  await emit(ctx, { type: 'financial_entry.allocated', entityType: 'financial_entry', entityId: entry.id });
  return getCampaignCosts(ctx, campaignId);
};
