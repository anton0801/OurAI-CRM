import { and, desc, eq, sql } from 'drizzle-orm';
import { can } from '@castlane/authorization';
import { periodLocks } from '@castlane/database';
import { AppError, newId } from '@castlane/domain';
import { requirePermission } from '../core/access';
import { audit } from '../core/audit';
import { dbOf, type CommandContext, type QueryContext } from '../core/context';
import { emit } from '../core/events';
import { loadMemberRefs, refOrUnknown } from '../core/members';
import { lockById, stamp, touch } from '../core/rows';
import { userMembershipMap, workspaceFinance } from './common';

type LockRow = typeof periodLocks.$inferSelect;
export type PeriodIssueKind = 'unreviewed_entries' | 'unmatched_settlements' | 'unallocated_costs' | 'compensation_drafts' | 'missing_fx';

const LABELS: Record<PeriodIssueKind, string> = {
  unreviewed_entries: 'Draft or submitted entries not yet reviewed',
  unmatched_settlements: 'Settlements not confirmed or with an unmatched balance',
  unallocated_costs: 'Posted costs with an Unallocated amount',
  compensation_drafts: 'Compensation runs not yet approved',
  missing_fx: 'Draft lines without an FX rate',
};

const requireWorkspaceClose = (ctx: QueryContext) => {
  requirePermission(ctx, 'finance.close-period');
  if (!can(ctx.actor.access, 'finance.close-period')) throw new AppError('FORBIDDEN', 'Closing periods needs workspace-wide finance rights.');
};

export const periodIssues = async (ctx: QueryContext | CommandContext, periodStart: string, periodEnd: string) => {
  const db = dbOf(ctx);
  const ws = ctx.actor.workspaceId;
  const { baseCurrency } = await workspaceFinance(ctx);
  const count = async (q: ReturnType<typeof sql>) => Number(((await db.execute<{ n: string }>(q)).rows[0]?.n ?? '0') as string);
  const issues: { kind: PeriodIssueKind; label: string; count: number }[] = [
    {
      kind: 'unreviewed_entries',
      label: LABELS.unreviewed_entries,
      count: await count(sql`SELECT count(*)::text AS n FROM financial_entries WHERE workspace_id = ${ws} AND state IN ('draft', 'submitted') AND recognition_date BETWEEN ${periodStart} AND ${periodEnd}`),
    },
    {
      kind: 'unmatched_settlements',
      label: LABELS.unmatched_settlements,
      count: await count(
        sql`SELECT count(*)::text AS n FROM settlements WHERE workspace_id = ${ws} AND paid_at >= ${periodStart}::date AND paid_at < (${periodEnd}::date + 1) AND (state = 'draft' OR (state = 'confirmed' AND unallocated_minor > 0))`,
      ),
    },
    {
      kind: 'unallocated_costs',
      label: LABELS.unallocated_costs,
      count: await count(sql`
        SELECT count(*)::text AS n FROM (
          SELECT fa.line_id FROM financial_allocations fa
          JOIN financial_entry_lines l ON l.id = fa.line_id
          JOIN financial_entries e ON e.id = fa.entry_id
          WHERE fa.workspace_id = ${ws} AND e.state = 'posted' AND fa.project_id IS NULL
            AND l.accounting_class IN ('operating_expense', 'compensation_expense')
            AND fa.effective_date BETWEEN ${periodStart} AND ${periodEnd}
          GROUP BY fa.line_id HAVING sum(fa.amount_minor) <> 0) x`),
    },
    {
      kind: 'compensation_drafts',
      label: LABELS.compensation_drafts,
      count: await count(
        sql`SELECT count(*)::text AS n FROM compensation_runs WHERE workspace_id = ${ws} AND state IN ('draft', 'calculated', 'submitted') AND period_start <= ${periodEnd} AND period_end >= ${periodStart}`,
      ),
    },
    {
      kind: 'missing_fx',
      label: LABELS.missing_fx,
      count: await count(sql`
        SELECT count(*)::text AS n FROM financial_entry_lines l JOIN financial_entries e ON e.id = l.entry_id
        WHERE l.workspace_id = ${ws} AND e.state IN ('draft', 'submitted') AND e.recognition_date BETWEEN ${periodStart} AND ${periodEnd}
          AND l.currency <> ${baseCurrency} AND l.base_amount_minor IS NULL`),
    },
  ];
  return issues.filter((i) => i.count > 0);
};

const overlapping = async (ctx: QueryContext | CommandContext, periodStart: string, periodEnd: string) => {
  const [l] = await dbOf(ctx)
    .select()
    .from(periodLocks)
    .where(and(eq(periodLocks.workspaceId, ctx.actor.workspaceId), eq(periodLocks.state, 'locked'), sql`${periodLocks.periodStart} <= ${periodEnd} AND ${periodLocks.periodEnd} >= ${periodStart}`))
    .limit(1);
  return l ?? null;
};

export const closePreview = async (ctx: QueryContext, input: { periodStart: string; periodEnd: string }) => {
  requireWorkspaceClose(ctx);
  if (input.periodEnd < input.periodStart) throw new AppError('VALIDATION_FAILED', 'The period ends before it starts.', { fieldErrors: [{ field: 'periodEnd', code: 'BEFORE_START', message: 'Choose an end on or after the start.' }] });
  return { ...input, issues: await periodIssues(ctx, input.periodStart, input.periodEnd), overlapsLock: !!(await overlapping(ctx, input.periodStart, input.periodEnd)) };
};

const lockView = async (ctx: QueryContext | CommandContext, rows: LockRow[]) => {
  const db = dbOf(ctx);
  const u2m = await userMembershipMap(db, ctx.actor.workspaceId, rows.flatMap((r) => [r.lockedBy, r.reopenedBy]));
  const refs = await loadMemberRefs(db, ctx.actor.workspaceId, [...u2m.values()]);
  const m = (u: string | null) => (u && u2m.get(u) ? refOrUnknown(refs, u2m.get(u)) : null);
  return rows.map((r) => ({
    id: r.id,
    periodStart: r.periodStart,
    periodEnd: r.periodEnd,
    state: r.state,
    lockedAt: r.lockedAt.toISOString(),
    lockedBy: m(r.lockedBy),
    unresolvedItems: r.unresolvedItems,
    reopenedAt: r.reopenedAt?.toISOString() ?? null,
    reopenedBy: m(r.reopenedBy),
    reopenReason: r.reopenReason,
    rowVersion: r.rowVersion,
  }));
};

export const listPeriods = async (ctx: QueryContext) => {
  requirePermission(ctx, 'finance.read');
  const rows = await dbOf(ctx).select().from(periodLocks).where(eq(periodLocks.workspaceId, ctx.actor.workspaceId)).orderBy(desc(periodLocks.periodStart), desc(periodLocks.lockedAt));
  return lockView(ctx, rows);
};

export const getPeriodLock = async (ctx: QueryContext | CommandContext, id: string) => {
  const rows = await dbOf(ctx).select().from(periodLocks).where(and(eq(periodLocks.workspaceId, ctx.actor.workspaceId), eq(periodLocks.id, id)));
  if (!rows.length) throw new AppError('NOT_FOUND', 'Period was not found.');
  return (await lockView(ctx, rows))[0]!;
};

/**
 * Close Period (spec §18.7): issues are shown; each kind of unresolved item must be acknowledged
 * with a note (it goes into the period record). Afterwards posting into the period is blocked.
 */
export const closePeriod = async (
  ctx: CommandContext,
  input: { periodStart: string; periodEnd: string; unresolvedAcknowledgements: { kind: PeriodIssueKind; note: string }[] },
) => {
  requireWorkspaceClose(ctx);
  if (input.periodEnd < input.periodStart) throw new AppError('VALIDATION_FAILED', 'The period ends before it starts.', { fieldErrors: [{ field: 'periodEnd', code: 'BEFORE_START', message: 'Choose an end on or after the start.' }] });
  await ctx.tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`period_lock:${ctx.actor.workspaceId}`}))`);
  const existing = await overlapping(ctx, input.periodStart, input.periodEnd);
  if (existing) throw new AppError('CONFLICT', `The period overlaps the closed period ${existing.periodStart} – ${existing.periodEnd}.`, { details: { reason: 'overlaps_lock', periodId: existing.id } });
  const issues = await periodIssues(ctx, input.periodStart, input.periodEnd);
  const ack = new Map(input.unresolvedAcknowledgements.map((a) => [a.kind, a.note]));
  const missing = issues.filter((i) => !ack.get(i.kind));
  if (missing.length)
    throw new AppError('INVALID_STATE', 'Resolve these items or acknowledge them with a note before closing.', { details: { reason: 'unresolved_items', issues: missing } });
  const id = newId();
  const at = ctx.app.clock.now();
  await ctx.tx.insert(periodLocks).values({
    ...stamp(ctx),
    id,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    state: 'locked',
    lockedAt: at,
    lockedBy: ctx.actor.userId!,
    unresolvedItems: issues.map((i) => ({ kind: i.kind, count: i.count, note: ack.get(i.kind) })),
  });
  await audit(ctx, { action: 'finance.period_closed', entityType: 'period_lock', entityId: id, sensitivity: 'finance', metadata: { periodStart: input.periodStart, periodEnd: input.periodEnd, unresolved: issues } });
  await emit(ctx, { type: 'finance.period_closed', entityType: 'period_lock', entityId: id, revision: 1, payload: { periodStart: input.periodStart, periodEnd: input.periodEnd } });
  return id;
};

/** Explicit audited reopen; reports built on the period receive a stale marker via the outbox event. */
export const reopenPeriod = async (ctx: CommandContext, input: { periodId: string; reason: string }) => {
  requireWorkspaceClose(ctx);
  const l = await lockById(ctx, periodLocks, input.periodId, 'Period');
  if (l.state !== 'locked') throw new AppError('INVALID_STATE', 'This period is not closed.');
  const at = ctx.app.clock.now();
  const [row] = await ctx.tx
    .update(periodLocks)
    .set({ state: 'reopened', reopenedAt: at, reopenedBy: ctx.actor.userId, reopenReason: input.reason, ...touch(ctx, periodLocks) })
    .where(eq(periodLocks.id, l.id))
    .returning();
  await audit(ctx, { action: 'finance.period_reopened', entityType: 'period_lock', entityId: l.id, sensitivity: 'finance', reason: input.reason, metadata: { periodStart: l.periodStart, periodEnd: l.periodEnd } });
  await emit(ctx, {
    type: 'finance.period_reopened',
    entityType: 'period_lock',
    entityId: l.id,
    revision: row!.rowVersion,
    payload: { periodStart: l.periodStart, periodEnd: l.periodEnd, reportsStale: true },
  });
  return l.id;
};
