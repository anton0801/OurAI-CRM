import { and, asc, desc, eq, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { can } from '@castlane/authorization';
import {
  compensationAdjustments,
  compensationClaims,
  compensationLines,
  compensationRuleVersions,
  compensationRules,
  compensationRuns,
  financeCategories,
  financialEntries,
  financialEntryLines,
  memberships,
  settlementAllocations,
  settlements,
} from '@castlane/database';
import {
  AppError,
  RUN_TRANSITIONS,
  assertTransition,
  clampPageSize,
  decodeCursor,
  encodeCursor,
  newId,
  recipientTotals,
  type FieldError,
} from '@castlane/domain';
import { requireRecentAuth } from '../core/access';
import { audit } from '../core/audit';
import { dbOf, type CommandContext, type QueryContext } from '../core/context';
import { sha256 } from '../core/crypto';
import { emit } from '../core/events';
import { loadMemberRefs, refOrUnknown } from '../core/members';
import { notify } from '../core/notify';
import { assertVersion, findById, lockById, stamp, touch } from '../core/rows';
import { checkMakerChecker, moneyOf, parseAmount, throwIfErrors, userMembershipMap } from './common';
import { calculateCompensation, digestOf } from './compensation-calc';
import { requireWorkspacePermission } from './compensation-rules';
import { createEntry, postEntryCore } from './entries';
import { runPayables } from './payables';
import { PAYMENT_EXPLANATION, createSettlement, confirmSettlement } from './settlements';

type RunRow = typeof compensationRuns.$inferSelect;
type LineRow = typeof compensationLines.$inferSelect;
type AdjustmentRow = typeof compensationAdjustments.$inferSelect;

const READ = 'compensation.runs.read';

const isApprovedState = (s: RunRow['state']) => s === 'approved' || s === 'partially_paid' || s === 'paid';

const lineView = (l: LineRow, refs: Map<string, { membershipId: string; displayName: string; avatarUrl: string | null }>, ruleNames: Map<string, string>) => ({
  id: l.id,
  recipient: refOrUnknown(refs as never, l.recipientMembershipId)!,
  ruleVersionId: l.ruleVersionId,
  ruleName: l.ruleVersionId ? (ruleNames.get(l.ruleVersionId) ?? null) : null,
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
});

const ruleNamesFor = async (ctx: QueryContext | CommandContext, versionIds: string[]) => {
  const ids = [...new Set(versionIds)];
  const m = new Map<string, string>();
  if (!ids.length) return m;
  const rows = await dbOf(ctx)
    .select({ id: compensationRuleVersions.id, name: compensationRules.name, versionNo: compensationRuleVersions.versionNo })
    .from(compensationRuleVersions)
    .innerJoin(compensationRules, eq(compensationRules.id, compensationRuleVersions.ruleId))
    .where(inArray(compensationRuleVersions.id, ids));
  for (const r of rows) m.set(r.id, `${r.name} v${r.versionNo}`);
  return m;
};

export const adjustmentViews = async (ctx: QueryContext | CommandContext, rows: AdjustmentRow[]) => {
  const db = dbOf(ctx);
  const u2m = await userMembershipMap(db, ctx.actor.workspaceId, rows.flatMap((r) => [r.createdBy, r.approvedBy]));
  const refs = await loadMemberRefs(db, ctx.actor.workspaceId, [...rows.map((r) => r.recipientMembershipId), ...u2m.values()]);
  const m = (u: string | null) => (u && u2m.get(u) ? refOrUnknown(refs, u2m.get(u)) : null);
  return rows.map((a) => ({
    id: a.id,
    recipient: refOrUnknown(refs, a.recipientMembershipId)!,
    amount: moneyOf(a.amountMinor, a.currency.trim()),
    kind: a.kind,
    reason: a.reason,
    state: a.state,
    originalEntitlementKey: a.originalEntitlementKey,
    sourceRunId: a.sourceRunId,
    appliedRunId: a.appliedRunId,
    reversesAdjustmentId: a.reversesAdjustmentId,
    createdBy: m(a.createdBy),
    approvedBy: m(a.approvedBy),
    approvedAt: a.approvedAt?.toISOString() ?? null,
    createdAt: a.createdAt.toISOString(),
  }));
};

const runRowView = (r: RunRow, refs: Map<string, { membershipId: string; displayName: string; avatarUrl: string | null }>) => ({
  id: r.id,
  periodStart: r.periodStart,
  periodEnd: r.periodEnd,
  state: r.state,
  participants: r.participantMembershipIds.map((p) => refOrUnknown(refs as never, p)!),
  calculationVersion: r.calculationVersion,
  totals: r.totals.map((t) => ({ currency: t.currency, amount: moneyOf(BigInt(t.amountMinor), t.currency), paid: moneyOf(BigInt(t.paidMinor), t.currency) })),
  calculatedAt: r.calculatedAt?.toISOString() ?? null,
  approvedAt: r.approvedAt?.toISOString() ?? null,
  createdAt: r.createdAt.toISOString(),
  rowVersion: r.rowVersion,
});

export const listRuns = async (ctx: QueryContext, input: { cursor?: string; pageSize?: number; state?: RunRow['state'][]; from?: string; to?: string }) => {
  requireWorkspacePermission(ctx, READ);
  const size = clampPageSize(input.pageSize);
  const c = input.cursor ? decodeCursor(input.cursor) : null;
  const rows = await dbOf(ctx)
    .select()
    .from(compensationRuns)
    .where(
      and(
        eq(compensationRuns.workspaceId, ctx.actor.workspaceId),
        input.state?.length ? inArray(compensationRuns.state, input.state) : undefined,
        input.from ? sql`${compensationRuns.periodEnd} >= ${input.from}` : undefined,
        input.to ? sql`${compensationRuns.periodStart} <= ${input.to}` : undefined,
        c ? or(lt(compensationRuns.periodStart, String(c.v[0])), and(eq(compensationRuns.periodStart, String(c.v[0])), lt(compensationRuns.id, c.id))) : undefined,
      ),
    )
    .orderBy(desc(compensationRuns.periodStart), desc(compensationRuns.id))
    .limit(size + 1);
  const hasMore = rows.length > size;
  const pageRows = hasMore ? rows.slice(0, size) : rows;
  const refs = await loadMemberRefs(dbOf(ctx), ctx.actor.workspaceId, pageRows.flatMap((r) => r.participantMembershipIds));
  const last = pageRows[pageRows.length - 1];
  return { items: pageRows.map((r) => runRowView(r, refs as never)), hasMore, nextCursor: hasMore && last ? encodeCursor({ v: [last.periodStart], id: last.id }) : null };
};

export const getRun = async (ctx: QueryContext | CommandContext, id: string) => {
  requireWorkspacePermission(ctx, READ);
  const r = await findById(ctx, compensationRuns, id, 'Run');
  const db = dbOf(ctx);
  const ws = ctx.actor.workspaceId;
  const all = await db.select().from(compensationLines).where(and(eq(compensationLines.workspaceId, ws), eq(compensationLines.runId, id))).orderBy(asc(compensationLines.recipientMembershipId), asc(compensationLines.entitlementKey));
  const current = all.filter((l) => l.calculationVersion === r.calculationVersion);
  const previous = all.filter((l) => l.calculationVersion === r.calculationVersion - 1);
  const adjustments = await db
    .select()
    .from(compensationAdjustments)
    .where(and(eq(compensationAdjustments.workspaceId, ws), or(eq(compensationAdjustments.sourceRunId, id), eq(compensationAdjustments.appliedRunId, id))))
    .orderBy(asc(compensationAdjustments.createdAt));
  const payments = await db
    .select({ settlementId: settlements.id, allocationId: settlementAllocations.id, recipient: settlementAllocations.recipientMembershipId, amount: settlementAllocations.documentAmountMinor, currency: settlementAllocations.documentCurrency, paidAt: settlements.paidAt, reference: settlements.paymentReference, reversedAt: settlementAllocations.reversedAt, state: settlements.state })
    .from(settlementAllocations)
    .innerJoin(settlements, eq(settlements.id, settlementAllocations.settlementId))
    .where(and(eq(settlementAllocations.workspaceId, ws), eq(settlementAllocations.targetRunId, id)))
    .orderBy(asc(settlements.paidAt));
  const u2m = await userMembershipMap(db, ws, [r.submittedBy, r.approvedBy]);
  const refs = await loadMemberRefs(db, ws, [...r.participantMembershipIds, ...all.map((l) => l.recipientMembershipId), ...u2m.values(), ...payments.map((p) => p.recipient)]);
  const names = await ruleNamesFor(ctx, all.map((l) => l.ruleVersionId).filter((x): x is string => !!x));
  const payables = isApprovedState(r.state) ? await runPayables(ctx, [id]) : [];
  const totals = recipientTotals(current.map((l) => ({ recipientMembershipId: l.recipientMembershipId, currency: l.currency.trim(), amountMinor: l.amountMinor, excluded: l.excluded })));
  const snap = (r.snapshot ?? {}) as { warnings?: { code: string; message: string; details?: Record<string, unknown> }[]; rules?: { versionId: string; ruleId: string; name: string; type: string; versionNo: number }[] };
  let diff = null;
  if (r.calculationVersion > 1) {
    const prev = new Map(previous.filter((l) => !l.excluded).map((l) => [l.entitlementKey, l]));
    const cur = new Map(current.filter((l) => !l.excluded).map((l) => [l.entitlementKey, l]));
    diff = {
      previousVersion: r.calculationVersion - 1,
      added: [...cur.values()].filter((l) => !prev.has(l.entitlementKey)).map((l) => ({ entitlementKey: l.entitlementKey, amount: moneyOf(l.amountMinor, l.currency.trim()) })),
      removed: [...prev.values()].filter((l) => !cur.has(l.entitlementKey)).map((l) => ({ entitlementKey: l.entitlementKey, amount: moneyOf(l.amountMinor, l.currency.trim()) })),
      changed: [...cur.values()]
        .filter((l) => prev.has(l.entitlementKey) && prev.get(l.entitlementKey)!.amountMinor !== l.amountMinor)
        .map((l) => ({ entitlementKey: l.entitlementKey, from: moneyOf(prev.get(l.entitlementKey)!.amountMinor, l.currency.trim()), to: moneyOf(l.amountMinor, l.currency.trim()) })),
    };
  }
  const calc = can(ctx.actor.access, 'compensation.runs.calculate');
  const approve = can(ctx.actor.access, 'compensation.runs.approve');
  const m = (u: string | null) => (u && u2m.get(u) ? refOrUnknown(refs, u2m.get(u)) : null);
  return {
    ...runRowView(r, refs as never),
    sourceDigest: r.sourceDigest,
    submittedAt: r.submittedAt?.toISOString() ?? null,
    submittedBy: m(r.submittedBy),
    approvedBy: m(r.approvedBy),
    expenseEntryId: r.expenseEntryId,
    cancelReason: r.cancelReason,
    returnReason: r.returnReason,
    lines: current.map((l) => lineView(l, refs as never, names)),
    recipientTotals: totals.map((t) => {
      const p = payables.find((x) => x.recipientMembershipId === t.recipientMembershipId && x.currency === t.currency);
      return {
        recipient: refOrUnknown(refs, t.recipientMembershipId)!,
        currency: t.currency,
        total: moneyOf(t.totalMinor, t.currency),
        payable: moneyOf(t.payableMinor, t.currency),
        carryForward: moneyOf(t.carryForwardMinor, t.currency),
        paid: moneyOf(p?.paidMinor ?? 0n, t.currency),
        outstanding: moneyOf(isApprovedState(r.state) ? (p?.outstandingMinor ?? t.payableMinor) : t.payableMinor, t.currency),
      };
    }),
    diff,
    adjustments: await adjustmentViews(ctx, adjustments),
    payments: payments.map((p) => ({
      settlementId: p.settlementId,
      allocationId: p.allocationId,
      recipient: refOrUnknown(refs, p.recipient)!,
      amount: moneyOf(p.amount, p.currency.trim()),
      paidAt: p.paidAt.toISOString(),
      paymentReference: p.reference,
      reversed: !!p.reversedAt || p.state === 'reversed',
    })),
    warnings: snap.warnings ?? [],
    ruleVersions: (snap.rules ?? []).map((x) => ({ id: x.versionId, ruleId: x.ruleId, name: x.name, type: x.type as never, versionNo: x.versionNo })),
    permissions: {
      update: calc && (r.state === 'draft' || r.state === 'calculated'),
      calculate: calc && (r.state === 'draft' || r.state === 'calculated'),
      submit: calc && r.state === 'calculated' && current.length > 0,
      returnToDraft: approve && (r.state === 'calculated' || r.state === 'submitted'),
      approve: approve && r.state === 'submitted',
      cancel: calc && !isApprovedState(r.state) && r.state !== 'cancelled',
      addAdjustment: calc && (r.state === 'draft' || r.state === 'calculated'),
      recordPayment: (r.state === 'approved' || r.state === 'partially_paid') && can(ctx.actor.access, 'payments.record'),
      selfApprovalRequired: r.state === 'submitted' && !!r.submittedBy && r.submittedBy === ctx.actor.userId,
    },
  };
};

// ——— Commands ———

const validateParticipants = async (ctx: CommandContext, ids: string[]) => {
  const unique = [...new Set(ids)];
  const rows = await ctx.tx.select({ id: memberships.id }).from(memberships).where(and(eq(memberships.workspaceId, ctx.actor.workspaceId), inArray(memberships.id, unique)));
  if (rows.length !== unique.length) throw new AppError('VALIDATION_FAILED', 'A participant was not found.', { fieldErrors: [{ field: 'participantMembershipIds', code: 'NOT_FOUND', message: 'A participant was not found.' }] });
  return unique;
};

const validatePeriod = (start: string, end: string) => {
  if (end < start) throw new AppError('VALIDATION_FAILED', 'The period ends before it starts.', { fieldErrors: [{ field: 'periodEnd', code: 'BEFORE_START', message: 'Choose an end on or after the start.' }] });
};

export const createRun = async (ctx: CommandContext, input: { periodStart: string; periodEnd: string; participantMembershipIds: string[] }) => {
  requireWorkspacePermission(ctx, 'compensation.runs.calculate');
  validatePeriod(input.periodStart, input.periodEnd);
  const participants = await validateParticipants(ctx, input.participantMembershipIds);
  const id = newId();
  await ctx.tx.insert(compensationRuns).values({ ...stamp(ctx), id, periodStart: input.periodStart, periodEnd: input.periodEnd, participantMembershipIds: participants, state: 'draft' });
  await audit(ctx, { action: 'compensation_run.created', entityType: 'compensation_run', entityId: id, sensitivity: 'finance', metadata: { period: [input.periodStart, input.periodEnd], participants: participants.length } });
  await emit(ctx, { type: 'compensation_run.created', entityType: 'compensation_run', entityId: id, revision: 1 });
  return id;
};

const lockRun = async (ctx: CommandContext, id: string, permission: string) => {
  requireWorkspacePermission(ctx, permission);
  const r = await lockById(ctx, compensationRuns, id, 'Run');
  assertVersion(ctx, r);
  return r;
};

export const updateRun = async (ctx: CommandContext, id: string, input: { periodStart?: string; periodEnd?: string; participantMembershipIds?: string[] }) => {
  const r = await lockRun(ctx, id, 'compensation.runs.calculate');
  if (r.state !== 'draft' && r.state !== 'calculated') throw new AppError('INVALID_STATE', 'Only draft or calculated runs can be changed.');
  const start = input.periodStart ?? r.periodStart;
  const end = input.periodEnd ?? r.periodEnd;
  validatePeriod(start, end);
  const participants = input.participantMembershipIds ? await validateParticipants(ctx, input.participantMembershipIds) : r.participantMembershipIds;
  const [row] = await ctx.tx.update(compensationRuns).set({ periodStart: start, periodEnd: end, participantMembershipIds: participants, state: 'draft', ...touch(ctx, compensationRuns) }).where(eq(compensationRuns.id, id)).returning();
  await audit(ctx, { action: 'compensation_run.updated', entityType: 'compensation_run', entityId: id, sensitivity: 'finance', metadata: { period: [start, end], participants: participants.length } });
  await emit(ctx, { type: 'compensation_run.updated', entityType: 'compensation_run', entityId: id, revision: row!.rowVersion });
  return id;
};

/** Calculate / Recalculate with Diff: a new calculation version; earlier versions are kept for the diff. */
export const calculateRun = async (ctx: CommandContext, id: string) => {
  const r = await lockRun(ctx, id, 'compensation.runs.calculate');
  assertTransition(RUN_TRANSITIONS, r.state, 'calculated', 'run');
  const calc = await calculateCompensation(ctx, { runId: id, periodStart: r.periodStart, periodEnd: r.periodEnd, participants: r.participantMembershipIds });
  const version = r.calculationVersion + 1;
  for (const l of calc.lines)
    await ctx.tx.insert(compensationLines).values({
      ...stamp(ctx),
      id: newId(),
      runId: id,
      calculationVersion: version,
      recipientMembershipId: l.recipientMembershipId,
      ruleVersionId: l.ruleVersionId,
      adjustmentId: l.adjustmentId,
      sourceType: l.sourceType,
      sourceId: l.sourceId,
      component: l.component,
      entitlementKey: l.entitlementKey,
      quantity: l.quantity,
      rate: l.rate,
      amountMinor: l.amountMinor,
      currency: l.currency,
      excluded: l.excluded,
      exclusionReason: l.exclusionReason,
      explanation: { ...l.explanation, sourceLabel: l.sourceLabel },
    });
  const totals = recipientTotals(calc.lines);
  const byCurrency = [...new Set(totals.map((t) => t.currency))].map((c) => ({ currency: c, amountMinor: totals.filter((t) => t.currency === c).reduce((a, t) => a + t.totalMinor, 0n).toString(), paidMinor: '0' }));
  const digest = sha256(digestOf(calc.lines));
  const [row] = await ctx.tx
    .update(compensationRuns)
    .set({ state: 'calculated', calculationVersion: version, sourceDigest: digest, calculatedAt: ctx.app.clock.now(), snapshot: calc.snapshot, totals: byCurrency, ...touch(ctx, compensationRuns) })
    .where(eq(compensationRuns.id, id))
    .returning();
  await audit(ctx, { action: 'compensation_run.calculated', entityType: 'compensation_run', entityId: id, sensitivity: 'finance', metadata: { calculationVersion: version, lines: calc.lines.length, digest } });
  await emit(ctx, { type: 'compensation_run.calculated', entityType: 'compensation_run', entityId: id, revision: row!.rowVersion, payload: { calculationVersion: version } });
  return id;
};

export const submitRun = async (ctx: CommandContext, id: string, input: { calculationVersion: number }) => {
  const r = await lockRun(ctx, id, 'compensation.runs.calculate');
  assertTransition(RUN_TRANSITIONS, r.state, 'submitted', 'run');
  if (input.calculationVersion !== r.calculationVersion) throw new AppError('INVALID_STATE', 'A newer calculation exists. Review it before submitting.', { details: { reason: 'stale_calculation', current: r.calculationVersion } });
  const [row] = await ctx.tx.update(compensationRuns).set({ state: 'submitted', submittedAt: ctx.app.clock.now(), submittedBy: ctx.actor.userId, returnReason: null, ...touch(ctx, compensationRuns) }).where(eq(compensationRuns.id, id)).returning();
  await audit(ctx, { action: 'compensation_run.submitted', entityType: 'compensation_run', entityId: id, sensitivity: 'finance', metadata: { calculationVersion: r.calculationVersion } });
  await emit(ctx, { type: 'compensation_run.submitted', entityType: 'compensation_run', entityId: id, revision: row!.rowVersion });
  return id;
};

export const returnRun = async (ctx: CommandContext, id: string, input: { reason: string }) => {
  const r = await lockRun(ctx, id, 'compensation.runs.approve');
  assertTransition(RUN_TRANSITIONS, r.state, 'draft', 'run');
  const [row] = await ctx.tx.update(compensationRuns).set({ state: 'draft', returnReason: input.reason, ...touch(ctx, compensationRuns) }).where(eq(compensationRuns.id, id)).returning();
  await audit(ctx, { action: 'compensation_run.returned', entityType: 'compensation_run', entityId: id, sensitivity: 'finance', reason: input.reason });
  await emit(ctx, { type: 'compensation_run.updated', entityType: 'compensation_run', entityId: id, revision: row!.rowVersion });
  return id;
};

export const cancelRun = async (ctx: CommandContext, id: string, input: { reason: string }) => {
  const r = await lockRun(ctx, id, 'compensation.runs.calculate');
  assertTransition(RUN_TRANSITIONS, r.state, 'cancelled', 'run');
  await ctx.tx
    .update(compensationAdjustments)
    .set({ state: 'reversed', ...touch(ctx, compensationAdjustments) })
    .where(and(eq(compensationAdjustments.sourceRunId, id), eq(compensationAdjustments.state, 'draft')));
  const [row] = await ctx.tx.update(compensationRuns).set({ state: 'cancelled', cancelReason: input.reason, ...touch(ctx, compensationRuns) }).where(eq(compensationRuns.id, id)).returning();
  await audit(ctx, { action: 'compensation_run.cancelled', entityType: 'compensation_run', entityId: id, sensitivity: 'finance', reason: input.reason });
  await emit(ctx, { type: 'compensation_run.cancelled', entityType: 'compensation_run', entityId: id, revision: row!.rowVersion });
  return id;
};

const compensationCategoryId = async (ctx: CommandContext) => {
  const rows = await ctx.tx
    .select()
    .from(financeCategories)
    .where(and(eq(financeCategories.workspaceId, ctx.actor.workspaceId), eq(financeCategories.accountingClass, 'compensation_expense'), isNull(financeCategories.archivedAt)))
    .orderBy(asc(financeCategories.sortOrder));
  const c = rows.find((r) => r.key === 'compensation') ?? rows[0];
  if (!c) throw new AppError('INVALID_STATE', 'Add an active compensation expense category before approving runs.', { details: { reason: 'no_compensation_category' } });
  return c.id;
};

/**
 * Approve (T130): entitlement claims (unique across approved runs) and exactly one linked
 * Compensation expense document from the run lines, frozen with the snapshot. A replay with the
 * same key returns the stored result; a second approval is an invalid transition.
 */
export const approveRun = async (
  ctx: CommandContext,
  id: string,
  input: { calculationVersion: number; sourceDigest: string; exceptionReason?: string; linkExistingEntryId?: string; unrelatedManualEntriesReason?: string },
) => {
  const r = await lockRun(ctx, id, 'compensation.runs.approve');
  if (isApprovedState(r.state)) throw new AppError('INVALID_STATE', 'This run is already approved.', { details: { reason: 'already_approved', expenseEntryId: r.expenseEntryId } });
  assertTransition(RUN_TRANSITIONS, r.state, 'approved', 'run');
  if (input.calculationVersion !== r.calculationVersion || input.sourceDigest !== r.sourceDigest)
    throw new AppError('INVALID_STATE', 'The calculation changed after you reviewed it. Review the current version.', { details: { reason: 'stale_calculation', current: r.calculationVersion } });
  requireRecentAuth(ctx);
  const selfReason = await checkMakerChecker(ctx, r.submittedBy, 'compensation.runs.approve', input.exceptionReason, 'run');

  // Inputs must not have changed since the calculation (another run may have claimed an entitlement).
  const fresh = await calculateCompensation(ctx, { runId: id, periodStart: r.periodStart, periodEnd: r.periodEnd, participants: r.participantMembershipIds });
  if (sha256(digestOf(fresh.lines)) !== r.sourceDigest)
    throw new AppError('INVALID_STATE', 'Source data changed since the calculation (new approvals, corrections or claims). Recalculate and review the diff.', { details: { reason: 'sources_changed' } });

  const lines = await ctx.tx.select().from(compensationLines).where(and(eq(compensationLines.runId, id), eq(compensationLines.calculationVersion, r.calculationVersion)));
  const active = lines.filter((l) => !l.excluded);
  const totals = recipientTotals(active.map((l) => ({ recipientMembershipId: l.recipientMembershipId, currency: l.currency.trim(), amountMinor: l.amountMinor, excluded: false })));

  // A compensation expense recorded by hand must be linked or explicitly declared unrelated.
  const manual = await ctx.tx
    .select({ id: financialEntries.id, title: financialEntries.title, state: financialEntries.state })
    .from(financialEntries)
    .where(
      and(
        eq(financialEntries.workspaceId, ctx.actor.workspaceId),
        isNull(financialEntries.compensationRunId),
        isNull(financialEntries.reversesEntryId),
        isNull(financialEntries.reversedByEntryId),
        ne(financialEntries.state, 'rejected'),
        sql`${financialEntries.recognitionDate} BETWEEN ${r.periodStart} AND ${r.periodEnd}`,
        sql`EXISTS (SELECT 1 FROM financial_entry_lines l WHERE l.entry_id = ${financialEntries.id} AND l.accounting_class = 'compensation_expense')`,
      ),
    );
  let expenseEntryId: string | null = null;
  if (input.linkExistingEntryId) {
    const target = manual.find((m) => m.id === input.linkExistingEntryId);
    if (!target || target.state !== 'posted') throw new AppError('VALIDATION_FAILED', 'Choose a posted compensation expense of this period that is not linked to a run.', { fieldErrors: [{ field: 'linkExistingEntryId', code: 'INVALID', message: 'Choose a posted, unlinked compensation expense.' }] });
    const el = await ctx.tx.select().from(financialEntryLines).where(and(eq(financialEntryLines.entryId, target.id), eq(financialEntryLines.accountingClass, 'compensation_expense')));
    for (const t of totals) {
      const got = el.filter((l) => l.currency.trim() === t.currency).reduce((a, l) => a + (l.isReversal ? -l.amountMinor : l.amountMinor), 0n);
      const want = totals.filter((x) => x.currency === t.currency).reduce((a, x) => a + x.payableMinor, 0n);
      if (got !== want) throw new AppError('INVALID_STATE', `The existing expense (${moneyOf(got, t.currency).amount} ${t.currency}) does not match the run (${moneyOf(want, t.currency).amount} ${t.currency}).`, { details: { reason: 'link_amount_mismatch' } });
    }
    await ctx.tx.update(financialEntries).set({ compensationRunId: id, ...touch(ctx, financialEntries) }).where(eq(financialEntries.id, target.id));
    expenseEntryId = target.id;
  } else if (manual.length && !input.unrelatedManualEntriesReason) {
    throw new AppError('INVALID_STATE', 'Compensation expenses were already recorded manually in this period. Link the existing document, or confirm they are unrelated, to avoid a duplicate expense.', {
      details: { reason: 'manual_compensation_expense', entries: manual },
    });
  }

  // Claims: an entitlement can be claimed by one approved run only.
  const keys = active.map((l) => l.entitlementKey);
  if (keys.length) {
    const taken = await ctx.tx.select({ key: compensationClaims.entitlementKey, runId: compensationClaims.runId }).from(compensationClaims).where(and(eq(compensationClaims.workspaceId, ctx.actor.workspaceId), inArray(compensationClaims.entitlementKey, keys)));
    if (taken.length) throw new AppError('DUPLICATE', 'Some entitlements are already claimed by another approved run. Recalculate.', { details: { reason: 'already_claimed', keys: taken.slice(0, 20) } });
  }
  const at = ctx.app.clock.now();
  for (const l of active) await ctx.tx.insert(compensationClaims).values({ ...stamp(ctx), id: newId(), entitlementKey: l.entitlementKey, runId: id, lineId: l.id, claimedAt: at });

  // Exactly one compensation expense document per run (unique index on compensation_run_id).
  if (!expenseEntryId) {
    const payable = totals.filter((t) => t.payableMinor > 0n);
    if (payable.length) {
      const categoryId = await compensationCategoryId(ctx);
      const refs = await loadMemberRefs(ctx.tx, ctx.actor.workspaceId, payable.map((t) => t.recipientMembershipId));
      const entryLines = payable.map((t) => {
        const mine = active.filter((l) => l.recipientMembershipId === t.recipientMembershipId && l.currency.trim() === t.currency);
        const byProject = new Map<string | null, bigint>();
        for (const l of mine) {
          const p = (l.explanation.projectId as string | null | undefined) ?? null;
          byProject.set(p, (byProject.get(p) ?? 0n) + l.amountMinor);
        }
        const weights = [...byProject.entries()].filter(([, v]) => v > 0n);
        return {
          categoryId,
          amount: moneyOf(t.payableMinor, t.currency).amount,
          currency: t.currency,
          description: `${refs.get(t.recipientMembershipId)?.displayName ?? 'Member'} — compensation ${r.periodStart} – ${r.periodEnd}`.slice(0, 500),
          allocation: weights.length ? { mode: 'weights' as const, rows: weights.map(([p, v]) => ({ projectId: p, value: v.toString() })) } : null,
        };
      });
      expenseEntryId = await createEntry(
        ctx,
        { type: 'expense', title: `Compensation ${r.periodStart} – ${r.periodEnd}`.slice(0, 120), recognitionDate: r.periodEnd, note: `Created by approval of compensation run ${id}.`, lines: entryLines },
        { internal: true, via: 'compensation_run', compensationRunId: id },
      );
      await ctx.tx.update(financialEntries).set({ state: 'submitted', submittedAt: at, submittedBy: r.submittedBy }).where(eq(financialEntries.id, expenseEntryId));
      const [e] = await ctx.tx.select().from(financialEntries).where(eq(financialEntries.id, expenseEntryId)).for('update');
      await postEntryCore(ctx, e!, { selfApprovalReason: selfReason, approverNote: 'Compensation run approval', notifyAuthor: false });
    }
  }

  // Adjustments: included ones are applied here; negative balances carry forward to the next run.
  const includedAdj = active.map((l) => l.adjustmentId).filter((x): x is string => !!x);
  if (includedAdj.length)
    await ctx.tx
      .update(compensationAdjustments)
      .set({ state: 'approved', approvedBy: ctx.actor.userId, approvedAt: at, appliedRunId: id, ...touch(ctx, compensationAdjustments) })
      .where(inArray(compensationAdjustments.id, includedAdj));
  // The carry line (+) brought this run to zero; the same amount (−) is applied in the next run.
  for (const l of active.filter((x) => x.sourceType === 'carry_forward')) {
    await ctx.tx.insert(compensationAdjustments).values({
      ...stamp(ctx),
      id: newId(),
      recipientMembershipId: l.recipientMembershipId,
      amountMinor: -l.amountMinor,
      currency: l.currency,
      reason: `Negative balance carried forward from the run ${r.periodStart} – ${r.periodEnd}`,
      kind: 'carry_forward',
      state: 'approved',
      sourceRunId: id,
      approvedBy: ctx.actor.userId,
      approvedAt: at,
    });
  }

  const byCurrency = [...new Set(totals.map((t) => t.currency))].map((c) => ({ currency: c, amountMinor: totals.filter((t) => t.currency === c).reduce((a, t) => a + t.totalMinor, 0n).toString(), paidMinor: '0' }));
  const [row] = await ctx.tx
    .update(compensationRuns)
    .set({
      state: 'approved',
      approvedAt: at,
      approvedBy: ctx.actor.userId,
      expenseEntryId,
      totals: byCurrency,
      snapshot: { ...((r.snapshot ?? {}) as Record<string, unknown>), approvedAt: at.toISOString(), selfApprovalReason: selfReason, unrelatedManualEntriesReason: input.unrelatedManualEntriesReason ?? null },
      ...touch(ctx, compensationRuns),
    })
    .where(eq(compensationRuns.id, id))
    .returning();
  await audit(ctx, {
    action: 'compensation_run.approved',
    entityType: 'compensation_run',
    entityId: id,
    sensitivity: 'finance',
    reason: selfReason ?? input.unrelatedManualEntriesReason ?? null,
    metadata: { calculationVersion: r.calculationVersion, claims: active.length, expenseEntryId, linked: !!input.linkExistingEntryId },
  });
  await emit(ctx, { type: 'compensation_run.approved', entityType: 'compensation_run', entityId: id, revision: row!.rowVersion, payload: { expenseEntryId } });
  await notify(ctx.tx, {
    workspaceId: ctx.actor.workspaceId,
    recipientMembershipIds: [...new Set(active.map((l) => l.recipientMembershipId))],
    eventType: 'finance.compensation_approved',
    eventKey: `finance.compensation_approved:${id}`,
    kind: 'general',
    title: `Compensation approved for ${r.periodStart} – ${r.periodEnd}`,
    excerpt: 'Your statement is available in your member profile.',
    sensitive: true,
    entityType: 'compensation_run',
    entityId: id,
    actorMembershipId: ctx.actor.membershipId,
    at,
  });
  return id;
};

export const addRunAdjustment = async (
  ctx: CommandContext,
  id: string,
  input: { recipientMembershipId: string; amount: string; currency: string; kind: 'manual_bonus' | 'manual_adjustment'; reason: string; originalEntitlementKey?: string },
) => {
  requireWorkspacePermission(ctx, 'compensation.runs.calculate');
  const r = await lockById(ctx, compensationRuns, id, 'Run');
  if (r.state !== 'draft' && r.state !== 'calculated') throw new AppError('INVALID_STATE', 'Adjustments are added to draft or calculated runs; approved runs are not rewritten.');
  if (!r.participantMembershipIds.includes(input.recipientMembershipId))
    throw new AppError('VALIDATION_FAILED', 'The recipient is not a participant of this run.', { fieldErrors: [{ field: 'recipientMembershipId', code: 'NOT_PARTICIPANT', message: 'Add the member to the run first.' }] });
  const errors: FieldError[] = [];
  const amount = parseAmount(input.amount, input.currency, 'amount', errors, { allowNegative: input.kind === 'manual_adjustment' });
  if (input.kind === 'manual_bonus' && amount < 0n) errors.push({ field: 'amount', code: 'NEGATIVE', message: 'A bonus is positive; use a manual adjustment for deductions.' });
  throwIfErrors(errors);
  const adjId = newId();
  await ctx.tx.insert(compensationAdjustments).values({
    ...stamp(ctx),
    id: adjId,
    recipientMembershipId: input.recipientMembershipId,
    amountMinor: amount,
    currency: input.currency,
    reason: input.reason,
    kind: input.kind,
    state: 'draft',
    originalEntitlementKey: input.originalEntitlementKey ?? null,
    sourceRunId: id,
  });
  const [row] = await ctx.tx.update(compensationRuns).set({ state: 'draft', ...touch(ctx, compensationRuns) }).where(eq(compensationRuns.id, id)).returning();
  await audit(ctx, { action: 'compensation_adjustment.created', entityType: 'compensation_run', entityId: id, sensitivity: 'finance', reason: input.reason, metadata: { adjustmentId: adjId, kind: input.kind } });
  await emit(ctx, { type: 'compensation_run.updated', entityType: 'compensation_run', entityId: id, revision: row!.rowVersion });
  return id;
};

/** Withdraw a draft adjustment, or reverse an approved one through a new adjustment (history kept). */
export const reverseAdjustment = async (ctx: CommandContext, adjustmentId: string, input: { reason: string }) => {
  requireWorkspacePermission(ctx, 'compensation.runs.calculate');
  const a = await lockById(ctx, compensationAdjustments, adjustmentId, 'Adjustment');
  if (a.state === 'reversed') throw new AppError('INVALID_STATE', 'This adjustment is already reversed.');
  const at = ctx.app.clock.now();
  let createdId: string | null = null;
  if (a.state === 'approved' && a.appliedRunId) {
    createdId = newId();
    await ctx.tx.insert(compensationAdjustments).values({
      ...stamp(ctx),
      id: createdId,
      recipientMembershipId: a.recipientMembershipId,
      amountMinor: -a.amountMinor,
      currency: a.currency,
      reason: `Reversal: ${input.reason}`,
      kind: 'reversal',
      state: 'approved',
      reversesAdjustmentId: a.id,
      originalEntitlementKey: `${a.recipientMembershipId}:adjustment:${a.id}`,
      approvedBy: ctx.actor.userId,
      approvedAt: at,
    });
  }
  await ctx.tx.update(compensationAdjustments).set({ state: 'reversed', ...touch(ctx, compensationAdjustments) }).where(eq(compensationAdjustments.id, a.id));
  if (a.state === 'draft' && a.sourceRunId)
    await ctx.tx.update(compensationRuns).set({ state: 'draft', ...touch(ctx, compensationRuns) }).where(and(eq(compensationRuns.id, a.sourceRunId), inArray(compensationRuns.state, ['calculated'])));
  await audit(ctx, { action: 'compensation_adjustment.reversed', entityType: 'compensation_run', entityId: a.sourceRunId ?? a.appliedRunId ?? a.id, sensitivity: 'finance', reason: input.reason, metadata: { adjustmentId: a.id, reversalAdjustmentId: createdId } });
  if (a.sourceRunId) await emit(ctx, { type: 'compensation_run.updated', entityType: 'compensation_run', entityId: a.sourceRunId });
  const [row] = await ctx.tx.select().from(compensationAdjustments).where(eq(compensationAdjustments.id, createdId ?? a.id));
  return (await adjustmentViews(ctx, [row!]))[0]!;
};

/** Record Payment: a confirmed outgoing settlement allocated to the recipient's approved amount (T121). */
export const recordRunPayment = async (
  ctx: CommandContext,
  id: string,
  input: { recipientMembershipId: string; amount: string; currency: string; paidAt: string; paymentReference?: string | null; note?: string | null },
) => {
  requireWorkspacePermission(ctx, 'payments.record');
  const r = await lockById(ctx, compensationRuns, id, 'Run');
  if (r.state !== 'approved' && r.state !== 'partially_paid') throw new AppError('INVALID_STATE', r.state === 'paid' ? 'This run is fully paid.' : 'Only approved runs can be paid.');
  const settlementId = await createSettlement(
    ctx,
    {
      direction: 'out',
      amount: input.amount,
      currency: input.currency,
      paidAt: input.paidAt,
      paymentReference: input.paymentReference ?? null,
      note: [input.note, PAYMENT_EXPLANATION].filter(Boolean).join('\n'),
      duplicateAckReason: input.paymentReference ? null : 'Compensation payout recorded against an approved run.',
    },
    { compensationRunId: id, internal: true },
  );
  const [s] = await ctx.tx.select().from(settlements).where(eq(settlements.id, settlementId));
  await confirmSettlement(
    ctx,
    settlementId,
    { allocationLines: [{ targetType: 'compensation_run', targetRunId: id, recipientMembershipId: input.recipientMembershipId, amount: input.amount, documentCurrency: input.currency }], remainderPolicy: 'none' },
    { internal: true, expectedVersion: s!.rowVersion },
  );
  await audit(ctx, { action: 'compensation_run.payment_recorded', entityType: 'compensation_run', entityId: id, sensitivity: 'finance', metadata: { settlementId, recipientMembershipId: input.recipientMembershipId } });
  return id;
};
