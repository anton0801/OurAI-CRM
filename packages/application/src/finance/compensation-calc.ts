import { and, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import {
  compensationAdjustments,
  compensationClaims,
  compensationLines,
  compensationRuleVersions,
  compensationRules,
  compensationRuns,
  financialAllocations,
  financialEntries,
  financialEntryLines,
  projectMemberships,
  revenueAttributions,
  roleAssignments,
  shiftBreaks,
  shifts,
  timeEntries,
} from '@castlane/database';
import {
  Big,
  ROUND_HALF_EVEN,
  baseKeyOf,
  checkRuleStacking,
  dateRangesOverlap,
  deltaKey,
  entitlementKey,
  fixedPeriodEntitlements,
  hourlyAmounts,
  hourlyPayable,
  localDate,
  recipientTotals,
  revenueShareAmount,
  revenueShareBase,
  secondsToHours,
  type HourlyItem,
  type RuleVersionLite,
} from '@castlane/domain';
import { dbOf, type CommandContext, type QueryContext } from '../core/context';
import { workspaceFinance } from './common';

type VersionRow = typeof compensationRuleVersions.$inferSelect;
type RuleRow = typeof compensationRules.$inferSelect;
export interface RuleVersionWithRule {
  v: VersionRow;
  rule: RuleRow;
}

export interface CalcLine {
  recipientMembershipId: string;
  ruleVersionId: string | null;
  adjustmentId: string | null;
  sourceType: string;
  sourceId: string;
  sourceLabel: string;
  component: string;
  entitlementKey: string;
  quantity: string | null;
  rate: string | null;
  amountMinor: bigint;
  currency: string;
  excluded: boolean;
  exclusionReason: string | null;
  explanation: Record<string, unknown>;
}

export interface CalcWarning {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface CalcResult {
  lines: CalcLine[];
  warnings: CalcWarning[];
  versions: RuleVersionWithRule[];
  snapshot: Record<string, unknown>;
}

const inRange = (date: string, from: string, to: string | null, periodEnd: string) => date >= from && (to === null || date < to) && date <= periodEnd;

const monthLabel = (ym: string) => new Date(`${ym}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });

/** Existing claims (approved runs) per base key: summed amount, count and the claimed line data. */
const loadClaims = async (ctx: QueryContext | CommandContext, recipients: string[]) => {
  const out = new Map<string, { sum: bigint; count: number; lines: { amountMinor: bigint; explanation: Record<string, unknown>; sourceType: string; sourceId: string; ruleVersionId: string | null }[] }>();
  if (!recipients.length) return out;
  const rows = await dbOf(ctx)
    .select({ key: compensationClaims.entitlementKey, amount: compensationLines.amountMinor, explanation: compensationLines.explanation, sourceType: compensationLines.sourceType, sourceId: compensationLines.sourceId, ruleVersionId: compensationLines.ruleVersionId })
    .from(compensationClaims)
    .innerJoin(compensationLines, eq(compensationLines.id, compensationClaims.lineId))
    .where(and(eq(compensationClaims.workspaceId, ctx.actor.workspaceId), inArray(compensationLines.recipientMembershipId, recipients)));
  for (const r of rows) {
    const k = baseKeyOf(r.key);
    const cur = out.get(k) ?? { sum: 0n, count: 0, lines: [] };
    cur.sum += r.amount;
    cur.count += 1;
    cur.lines.push({ amountMinor: r.amount, explanation: r.explanation, sourceType: r.sourceType, sourceId: r.sourceId, ruleVersionId: r.ruleVersionId });
    out.set(k, cur);
  }
  return out;
};

export const loadRuleVersions = async (ctx: QueryContext | CommandContext, periodEnd: string, opts: { includeVersionIds?: string[]; onlyVersionIds?: string[] } = {}) => {
  const rows = await dbOf(ctx)
    .select({ v: compensationRuleVersions, rule: compensationRules })
    .from(compensationRuleVersions)
    .innerJoin(compensationRules, eq(compensationRules.id, compensationRuleVersions.ruleId))
    .where(
      and(
        eq(compensationRuleVersions.workspaceId, ctx.actor.workspaceId),
        lte(compensationRuleVersions.effectiveFrom, periodEnd),
        opts.onlyVersionIds?.length
          ? inArray(compensationRuleVersions.id, opts.onlyVersionIds)
          : opts.includeVersionIds?.length
            ? sql`(${compensationRuleVersions.state} IN ('approved', 'ended') OR ${compensationRuleVersions.id} IN (${sql.join(opts.includeVersionIds.map((i) => sql`${i}::uuid`), sql`, `)}))`
            : inArray(compensationRuleVersions.state, ['approved', 'ended']),
      ),
    );
  return rows.sort((a, b) => (a.v.approvedAt?.getTime() ?? Infinity) - (b.v.approvedAt?.getTime() ?? Infinity) || a.v.id.localeCompare(b.v.id));
};

export const liteOf = (x: RuleVersionWithRule, recipientKey?: string): RuleVersionLite => ({
  id: x.v.id,
  ruleId: x.rule.id,
  recipientKey: recipientKey ?? (x.rule.recipientScopeType === 'member' ? `member:${x.rule.recipientMembershipId}` : `role:${x.rule.recipientRoleId}`),
  componentKey: x.rule.componentKey,
  stackGroup: x.rule.stackGroup,
  type: x.v.type,
  effectiveFrom: x.v.effectiveFrom,
  effectiveTo: x.v.effectiveTo,
  ratePercent: x.v.ratePercent,
  revenueBasis: x.v.revenueBasis,
  eligibleProjectIds: x.v.eligibleProjectIds,
  name: x.rule.name,
});

/**
 * Calculate compensation lines for a period and participants. Deterministic for the same inputs:
 * approved rule versions, approved time/shift hours, first approvals of content, posted revenue with
 * attributions, pending adjustments and existing claims. Already claimed entitlements produce only
 * correction deltas; nothing is ever claimed twice.
 */
export const calculateCompensation = async (
  ctx: QueryContext | CommandContext,
  input: { runId: string | null; periodStart: string; periodEnd: string; participants: string[]; onlyVersionIds?: string[]; includeVersionIds?: string[] },
): Promise<CalcResult> => {
  const db = dbOf(ctx);
  const ws = ctx.actor.workspaceId;
  const { baseCurrency, timezone } = await workspaceFinance(ctx);
  const warnings: CalcWarning[] = [];
  const lines: CalcLine[] = [];
  const participants = [...new Set(input.participants)];
  const versions = await loadRuleVersions(ctx, input.periodEnd, { onlyVersionIds: input.onlyVersionIds, includeVersionIds: input.includeVersionIds });

  // Recipients of role-scoped rules: members holding the role during the period.
  const roleIds = [...new Set(versions.filter((x) => x.rule.recipientScopeType === 'role' && x.rule.recipientRoleId).map((x) => x.rule.recipientRoleId!))];
  const roleMembers = new Map<string, Set<string>>();
  if (roleIds.length && participants.length) {
    const ra = await db
      .select({ roleId: roleAssignments.roleId, membershipId: roleAssignments.membershipId })
      .from(roleAssignments)
      .where(
        and(
          eq(roleAssignments.workspaceId, ws),
          inArray(roleAssignments.roleId, roleIds),
          inArray(roleAssignments.membershipId, participants),
          isNull(roleAssignments.revokedAt),
          sql`${roleAssignments.validFrom} < (${input.periodEnd}::date + 1)`,
          sql`(${roleAssignments.validTo} IS NULL OR ${roleAssignments.validTo} > ${input.periodStart}::date)`,
        ),
      );
    for (const r of ra) {
      const s = roleMembers.get(r.roleId) ?? new Set<string>();
      s.add(r.membershipId);
      roleMembers.set(r.roleId, s);
    }
  }
  const recipientsOf = (x: RuleVersionWithRule) =>
    x.rule.recipientScopeType === 'member'
      ? x.rule.recipientMembershipId && participants.includes(x.rule.recipientMembershipId)
        ? [x.rule.recipientMembershipId]
        : []
      : [...(roleMembers.get(x.rule.recipientRoleId ?? '') ?? [])];

  const claims = await loadClaims(ctx, participants);
  const perRecipient = new Map<string, { x: RuleVersionWithRule; conflict: string | null }[]>();
  for (const x of versions) {
    for (const r of recipientsOf(x)) {
      const list = perRecipient.get(r) ?? [];
      const accepted = list.filter((l) => !l.conflict).map((l) => liteOf(l.x, `member:${r}`));
      const check = checkRuleStacking(liteOf(x, `member:${r}`), accepted);
      const conflict = check.conflicts.length ? check.conflicts[0]!.message : null;
      if (conflict) warnings.push({ code: 'rule_conflict', message: `${x.rule.name}: ${conflict}`, details: { ruleId: x.rule.id, versionId: x.v.id, recipientMembershipId: r, conflicts: check.conflicts } });
      list.push({ x, conflict });
      perRecipient.set(r, list);
    }
  }

  /** Register a computed entitlement against existing claims (new line, correction delta, or nothing). */
  const emitLine = (l: Omit<CalcLine, 'entitlementKey'> & { baseKey: string }, opts: { hourlySeconds?: number } = {}) => {
    const c = claims.get(l.baseKey);
    const { baseKey, ...rest } = l;
    if (!c || l.excluded) {
      if (c && l.excluded) return; // already claimed, and now excluded: keep the claim, no silent change
      lines.push({ ...rest, entitlementKey: baseKey });
      return;
    }
    let delta = l.amountMinor - c.sum;
    if (opts.hourlySeconds !== undefined) {
      const old = c.lines.reduce((a, x) => a + Number((x.explanation.payableSeconds as number | undefined) ?? 0), 0);
      if (old === opts.hourlySeconds) return;
      const rate = BigInt(String(l.explanation.rateMinor ?? '0'));
      delta =
        BigInt(new Big(rate.toString()).times(opts.hourlySeconds).div(3600).round(0, ROUND_HALF_EVEN).toFixed(0)) -
        BigInt(new Big(rate.toString()).times(old).div(3600).round(0, ROUND_HALF_EVEN).toFixed(0));
      rest.explanation = { ...rest.explanation, previousPayableSeconds: old };
    }
    if (delta === 0n) return;
    lines.push({
      ...rest,
      component: 'correction',
      amountMinor: delta,
      entitlementKey: deltaKey(baseKey, c.count),
      explanation: { ...rest.explanation, correctionOf: baseKey, claimedMinor: c.sum.toString(), recomputedMinor: l.amountMinor.toString() },
    });
  };

  // ——— Source data (loaded once) ———
  const minFrom = versions.reduce((m, x) => (x.v.effectiveFrom < m ? x.v.effectiveFrom : m), input.periodStart);
  const hourlyRecipients = [...perRecipient.entries()].filter(([, l]) => l.some((e) => e.x.v.type === 'hourly')).map(([r]) => r);
  const teRows = hourlyRecipients.length
    ? await db
        .select()
        .from(timeEntries)
        .where(and(eq(timeEntries.workspaceId, ws), inArray(timeEntries.membershipId, hourlyRecipients), eq(timeEntries.state, 'approved'), isNull(timeEntries.supersededAt), sql`${timeEntries.workDate} >= ${minFrom} AND ${timeEntries.workDate} <= ${input.periodEnd}`))
    : [];
  const shRows = hourlyRecipients.length
    ? await db
        .select()
        .from(shifts)
        .where(
          and(
            eq(shifts.workspaceId, ws),
            inArray(shifts.membershipId, hourlyRecipients),
            eq(shifts.state, 'ended'),
            eq(shifts.reportState, 'approved'),
            sql`${shifts.actualStart} IS NOT NULL AND ${shifts.actualEnd} IS NOT NULL`,
            sql`${shifts.actualStart} < (${input.periodEnd}::date + 2)`,
          ),
        )
    : [];
  const brRows = shRows.length ? await db.select().from(shiftBreaks).where(and(eq(shiftBreaks.workspaceId, ws), inArray(shiftBreaks.shiftId, shRows.map((s) => s.id)))) : [];

  const unitRecipients = [...perRecipient.entries()].filter(([, l]) => l.some((e) => e.x.v.type === 'per_approved_unit')).map(([r]) => r);
  const contentRows = unitRecipients.length
    ? (
        await db.execute<{ id: string; title: string; project_id: string; first_approved_at: Date | string; owner_membership_id: string | null; contributors: string[] | null }>(sql`
          SELECT ci.id, ci.title, ci.project_id, ci.first_approved_at, ci.owner_membership_id,
            array(SELECT DISTINCT coalesce(t.assignee_at_completion, t.assignee_membership_id) FROM tasks t
                  WHERE t.workspace_id = ci.workspace_id AND t.content_item_id = ci.id AND t.status = 'done') AS contributors
          FROM content_items ci
          WHERE ci.workspace_id = ${ws} AND ci.first_approved_at IS NOT NULL AND ci.first_approved_at < (${input.periodEnd}::date + 2)`)
      ).rows
    : [];
  const responsibilityRows = unitRecipients.length
    ? await db.select({ membershipId: projectMemberships.membershipId, projectId: projectMemberships.projectId, responsibility: projectMemberships.responsibility }).from(projectMemberships).where(and(eq(projectMemberships.workspaceId, ws), inArray(projectMemberships.membershipId, unitRecipients)))
    : [];

  const shareRecipients = [...perRecipient.entries()].filter(([, l]) => l.some((e) => e.x.v.type === 'revenue_share')).map(([r]) => r);
  const attrRows = shareRecipients.length
    ? await db
        .select({ entryId: revenueAttributions.entryId, membershipId: revenueAttributions.membershipId, sharePercent: revenueAttributions.sharePercent })
        .from(revenueAttributions)
        .where(and(eq(revenueAttributions.workspaceId, ws), inArray(revenueAttributions.membershipId, shareRecipients), isNull(revenueAttributions.supersededAt)))
    : [];
  const attributedIds = [...new Set(attrRows.map((a) => a.entryId))];
  // Entries previously claimed by these recipients (to detect reversals / removed attribution).
  const claimedEntryIds = [...claims.values()].flatMap((c) => c.lines.filter((l) => l.sourceType === 'financial_entry').map((l) => l.sourceId));
  const entryIds = [...new Set([...attributedIds, ...claimedEntryIds])];
  const entryRows = entryIds.length
    ? await db
        .select()
        .from(financialEntries)
        .where(and(eq(financialEntries.workspaceId, ws), sql`(${financialEntries.id} IN (${sql.join(entryIds.map((i) => sql`${i}::uuid`), sql`, `)}) OR ${financialEntries.refundOfEntryId} IN (${sql.join(entryIds.map((i) => sql`${i}::uuid`), sql`, `)}))`))
    : [];
  const allEntryIds = entryRows.map((e) => e.id);
  const entryLines = allEntryIds.length ? await db.select().from(financialEntryLines).where(and(eq(financialEntryLines.workspaceId, ws), inArray(financialEntryLines.entryId, allEntryIds))) : [];
  const entryAllocs = allEntryIds.length
    ? await db.select({ entryId: financialAllocations.entryId, projectId: financialAllocations.projectId, amount: financialAllocations.amountMinor }).from(financialAllocations).where(and(eq(financialAllocations.workspaceId, ws), inArray(financialAllocations.entryId, allEntryIds)))
    : [];
  const entryProjects = (id: string) => {
    const m = new Map<string | null, bigint>();
    for (const a of entryAllocs.filter((x) => x.entryId === id)) m.set(a.projectId, (m.get(a.projectId) ?? 0n) + a.amount);
    return [...m.entries()].filter(([, v]) => v !== 0n).map(([p]) => p);
  };

  const snapshotSources: Record<string, unknown[]> = { timeEntries: [], shifts: [], contentItems: [], entries: [] };

  for (const [recipient, list] of perRecipient) {
    // ——— Fixed period ———
    for (const { x, conflict } of list.filter((e) => e.x.v.type === 'fixed_period')) {
      const cur = x.v.currency.trim();
      const ents = fixedPeriodEntitlements({ monthlyAmountMinor: x.v.rateMinor ?? 0n, proration: x.v.proration, ruleFrom: x.v.effectiveFrom, ruleTo: x.v.effectiveTo, periodStart: input.periodStart, periodEnd: input.periodEnd });
      for (const f of ents) {
        const baseKey = entitlementKey({ recipientMembershipId: recipient, ruleVersionId: x.v.id, sourceType: 'fixed_month', sourceId: f.month, component: x.rule.componentKey });
        emitLine({
          baseKey,
          recipientMembershipId: recipient,
          ruleVersionId: x.v.id,
          adjustmentId: null,
          sourceType: 'fixed_month',
          sourceId: f.month,
          sourceLabel: monthLabel(f.month),
          component: x.rule.componentKey,
          quantity: x.v.proration === 'calendar_days' ? new Big(f.eligibleDays).div(f.daysInMonth).round(6, ROUND_HALF_EVEN).toFixed(6) : '1',
          rate: x.v.rateMinor?.toString() ?? null,
          amountMinor: f.amountMinor,
          currency: cur,
          excluded: !!conflict,
          exclusionReason: conflict,
          explanation: {
            proration: x.v.proration,
            eligibleDays: f.eligibleDays,
            daysInMonth: f.daysInMonth,
            projectId: x.v.eligibleProjectIds.length === 1 ? x.v.eligibleProjectIds[0] : null,
          },
        });
      }
    }

    // ——— Hourly (one pass per recipient so TimeEntry and Shift time is paid once) ———
    const hourly = list.filter((e) => e.x.v.type === 'hourly');
    if (hourly.length) {
      type Item = HourlyItem & { version: RuleVersionWithRule; conflict: string | null; baseKey: string; claimed: boolean; projectId: string; late: boolean; label: string };
      const items: Item[] = [];
      for (const { x, conflict } of hourly) {
        const eligible = (p: string) => !x.v.eligibleProjectIds.length || x.v.eligibleProjectIds.includes(p);
        if (x.v.hourlySource === 'time_entries') {
          for (const te of teRows.filter((t) => t.membershipId === recipient && eligible(t.projectId) && inRange(t.workDate, x.v.effectiveFrom, x.v.effectiveTo, input.periodEnd))) {
            const root = te.revisionOfId ?? te.id;
            const baseKey = entitlementKey({ recipientMembershipId: recipient, ruleVersionId: x.v.id, sourceType: 'time_entry', sourceId: root, component: x.rule.componentKey });
            const seconds = te.durationSeconds ?? (te.startedAt && te.endedAt ? Math.round((te.endedAt.getTime() - te.startedAt.getTime()) / 1000) : 0);
            items.push({
              key: `${x.v.id}:${te.id}`,
              sourceType: 'time_entry',
              sourceId: root,
              intervals: te.startedAt && te.endedAt ? [{ start: te.startedAt.getTime(), end: te.endedAt.getTime() }] : [],
              seconds,
              date: te.workDate,
              version: x,
              conflict,
              baseKey,
              claimed: claims.has(baseKey),
              projectId: te.projectId,
              late: te.workDate < input.periodStart,
              label: `Time entry ${te.workDate}`,
            });
            (snapshotSources.timeEntries as unknown[]).push({ id: te.id, root, seconds, workDate: te.workDate });
          }
        } else if (x.v.hourlySource === 'shift_hours') {
          for (const s of shRows.filter((t) => t.membershipId === recipient && eligible(t.projectId))) {
            const date = localDate(s.actualStart!, timezone);
            if (!inRange(date, x.v.effectiveFrom, x.v.effectiveTo, input.periodEnd)) continue;
            // Net hours: actual interval minus closed breaks.
            let intervals = [{ start: s.actualStart!.getTime(), end: s.actualEnd!.getTime() }];
            for (const b of brRows.filter((r) => r.shiftId === s.id && r.endedAt)) {
              const bs = b.startedAt.getTime();
              const be = b.endedAt!.getTime();
              intervals = intervals.flatMap((i) => (be <= i.start || bs >= i.end ? [i] : [...(bs > i.start ? [{ start: i.start, end: bs }] : []), ...(be < i.end ? [{ start: be, end: i.end }] : [])]));
            }
            const seconds = Math.round(intervals.reduce((a, i) => a + (i.end - i.start), 0) / 1000);
            const baseKey = entitlementKey({ recipientMembershipId: recipient, ruleVersionId: x.v.id, sourceType: 'shift', sourceId: s.id, component: x.rule.componentKey });
            items.push({ key: `${x.v.id}:${s.id}`, sourceType: 'shift', sourceId: s.id, intervals, seconds, date, version: x, conflict, baseKey, claimed: claims.has(baseKey), projectId: s.projectId, late: date < input.periodStart, label: `Shift ${date}` });
            (snapshotSources.shifts as unknown[]).push({ id: s.id, seconds, date });
          }
        }
      }
      // Paid time first (it cannot be paid again), then new items by rule order and time.
      const order = (i: Item) => [i.claimed ? 0 : 1, hourly.findIndex((h) => h.x.v.id === i.version.v.id), i.intervals[0]?.start ?? 0] as const;
      const active = items.filter((i) => !i.conflict).sort((a, b) => {
        const oa = order(a);
        const ob = order(b);
        return oa[0] - ob[0] || oa[1] - ob[1] || oa[2] - ob[2];
      });
      const results = new Map(hourlyPayable(active).map((r) => [r.key, r]));
      for (const { x } of hourly) {
        const mine = items.filter((i) => i.version.v.id === x.v.id);
        const rate = x.v.rateMinor ?? 0n;
        const fresh = mine.filter((i) => !i.claimed && !i.conflict);
        const { perItem } = hourlyAmounts(rate, fresh.map((i) => ({ key: i.key, payableSeconds: results.get(i.key)?.payableSeconds ?? 0 })));
        for (const i of mine) {
          const r = results.get(i.key);
          const payable = r?.payableSeconds ?? 0;
          const reason = i.conflict ?? (r?.excludedReason === 'overlap' ? 'Time already paid under another item (overlap).' : r?.excludedReason === 'no_interval_on_shift_day' ? 'No start/end time on a day with paid shift time; an overlap cannot be ruled out.' : null);
          emitLine(
            {
              baseKey: i.baseKey,
              recipientMembershipId: recipient,
              ruleVersionId: x.v.id,
              adjustmentId: null,
              sourceType: i.sourceType,
              sourceId: i.sourceId,
              sourceLabel: `${i.label} · ${secondsToHours(payable)} h`,
              component: x.rule.componentKey,
              quantity: secondsToHours(payable),
              rate: rate.toString(),
              amountMinor: i.claimed ? 0n : (perItem.get(i.key) ?? 0n),
              currency: x.v.currency.trim(),
              excluded: !!reason && payable === 0,
              exclusionReason: reason,
              explanation: { payableSeconds: payable, overlapSeconds: r?.overlapSeconds ?? 0, date: i.date, projectId: i.projectId, late: i.late, rateMinor: rate.toString(), source: x.v.hourlySource },
            },
            i.claimed ? { hourlySeconds: payable } : {},
          );
        }
      }
    }

    // ——— Per approved unit ———
    for (const { x, conflict } of list.filter((e) => e.x.v.type === 'per_approved_unit')) {
      const allowedProjects = x.v.contributorResponsibility
        ? new Set(responsibilityRows.filter((r) => r.membershipId === recipient && r.responsibility === x.v.contributorResponsibility).map((r) => r.projectId))
        : null;
      for (const ci of contentRows) {
        const approvedAt = new Date(ci.first_approved_at);
        const date = localDate(approvedAt, timezone);
        if (!inRange(date, x.v.effectiveFrom, x.v.effectiveTo, input.periodEnd)) continue;
        if (x.v.eligibleProjectIds.length && !x.v.eligibleProjectIds.includes(ci.project_id)) continue;
        const contributors = new Set([...(ci.contributors ?? []), ...(ci.owner_membership_id ? [ci.owner_membership_id] : [])]);
        if (!contributors.has(recipient)) continue;
        if (allowedProjects && !allowedProjects.has(ci.project_id)) continue;
        const baseKey = entitlementKey({ recipientMembershipId: recipient, ruleVersionId: x.v.id, sourceType: 'content_item', sourceId: ci.id, component: x.rule.componentKey });
        emitLine({
          baseKey,
          recipientMembershipId: recipient,
          ruleVersionId: x.v.id,
          adjustmentId: null,
          sourceType: 'content_item',
          sourceId: ci.id,
          sourceLabel: ci.title,
          component: x.rule.componentKey,
          quantity: '1',
          rate: (x.v.rateMinor ?? 0n).toString(),
          amountMinor: x.v.rateMinor ?? 0n,
          currency: x.v.currency.trim(),
          excluded: !!conflict,
          exclusionReason: conflict,
          explanation: { firstApprovedAt: approvedAt.toISOString(), projectId: ci.project_id, late: date < input.periodStart },
        });
        (snapshotSources.contentItems as unknown[]).push({ id: ci.id, firstApprovedAt: approvedAt.toISOString() });
      }
    }

    // ——— Revenue share ———
    for (const { x, conflict } of list.filter((e) => e.x.v.type === 'revenue_share')) {
      const cur = x.v.currency.trim();
      const produced = new Set<string>();
      for (const e of entryRows) {
        if (e.state !== 'posted' || e.reversesEntryId) continue;
        const original = e.refundOfEntryId ? entryRows.find((o) => o.id === e.refundOfEntryId) : e;
        if (!original) continue;
        const attr = attrRows.find((a) => a.entryId === original.id && a.membershipId === recipient);
        if (!attr) continue;
        if (!inRange(original.recognitionDate, x.v.effectiveFrom, x.v.effectiveTo, input.periodEnd) || e.recognitionDate > input.periodEnd) continue;
        const projectsOf = entryProjects(original.id);
        if (x.v.eligibleProjectIds.length && !projectsOf.some((p) => p && x.v.eligibleProjectIds.includes(p))) continue;
        const baseKey = entitlementKey({ recipientMembershipId: recipient, ruleVersionId: x.v.id, sourceType: 'financial_entry', sourceId: e.id, component: x.rule.componentKey });
        produced.add(baseKey);
        if (e.reversedByEntryId) continue; // reversed documents carry no entitlement (claimed ones become corrections below)
        const ls = entryLines.filter((l) => l.entryId === e.id);
        const sameCurrency = ls.length > 0 && ls.every((l) => l.currency.trim() === cur);
        const useBase = !sameCurrency && cur === baseCurrency && ls.every((l) => l.baseAmountMinor !== null);
        let exclusion: string | null = conflict;
        let amount = 0n;
        let baseMinor: bigint | null = null;
        if (!sameCurrency && !useBase) exclusion ??= `The revenue is in another currency than the rule (${cur}).`;
        else {
          const b = revenueShareBase(
            ls.map((l) => ({ accountingClass: l.accountingClass, amountMinor: useBase ? l.baseAmountMinor! : l.amountMinor, isReversal: l.isReversal, componentsUnknown: l.componentsUnknown, fxEffect: l.fxEffect })),
            x.v.revenueBasis ?? 'net_after_refunds_and_fees',
          );
          if (!b.ok) exclusion ??= 'Gross is unknown for a Net Only statement; a percentage of an unknown gross is not calculated.';
          else {
            baseMinor = b.baseMinor;
            amount = revenueShareAmount(b.baseMinor, attr.sharePercent, x.v.ratePercent ?? '0');
          }
        }
        emitLine({
          baseKey,
          recipientMembershipId: recipient,
          ruleVersionId: x.v.id,
          adjustmentId: null,
          sourceType: 'financial_entry',
          sourceId: e.id,
          sourceLabel: e.refundOfEntryId ? `Refund: ${e.title}` : e.title,
          component: x.rule.componentKey,
          quantity: attr.sharePercent,
          rate: x.v.ratePercent,
          amountMinor: amount,
          currency: cur,
          excluded: !!exclusion,
          exclusionReason: exclusion,
          explanation: {
            basis: x.v.revenueBasis,
            baseMinor: baseMinor?.toString() ?? null,
            attributionPercent: attr.sharePercent,
            ratePercent: x.v.ratePercent,
            projectId: projectsOf.length === 1 ? projectsOf[0] : null,
            recognitionDate: e.recognitionDate,
            late: e.recognitionDate < input.periodStart,
            ...(e.refundOfEntryId ? { refundOfEntryId: e.refundOfEntryId, linkedEntitlementKey: entitlementKey({ recipientMembershipId: recipient, ruleVersionId: x.v.id, sourceType: 'financial_entry', sourceId: e.refundOfEntryId, component: x.rule.componentKey }) } : {}),
          },
        });
        (snapshotSources.entries as unknown[]).push({ id: e.id, base: baseMinor?.toString() ?? null, attribution: attr.sharePercent });
      }
      // Claimed documents that were reversed or lost the attribution: correction to zero.
      for (const [k, c] of claims) {
        if (!k.startsWith(`${recipient}:${x.v.id}:financial_entry:`) || c.sum === 0n) continue;
        const entryId = k.split(':')[3]!;
        const e = entryRows.find((r) => r.id === entryId);
        const reversed = !!e?.reversedByEntryId;
        if (produced.has(k) && !reversed) continue;
        lines.push({
          recipientMembershipId: recipient,
          ruleVersionId: x.v.id,
          adjustmentId: null,
          sourceType: 'financial_entry',
          sourceId: entryId,
          sourceLabel: `${e?.title ?? 'Revenue entry'} (${reversed ? 'reversed' : 'attribution changed'})`,
          component: 'correction',
          entitlementKey: deltaKey(k, c.count),
          quantity: null,
          rate: x.v.ratePercent,
          amountMinor: -c.sum,
          currency: cur,
          excluded: false,
          exclusionReason: null,
          explanation: { correctionOf: k, claimedMinor: c.sum.toString(), recomputedMinor: '0', reason: reversed ? 'document_reversed' : 'attribution_removed', projectId: e ? (entryProjects(e.id)[0] ?? null) : null },
        });
      }
    }
  }

  // ——— Adjustments (manual, carry-forward, reversals) ———
  if (participants.length) {
    const adj = await db
      .select()
      .from(compensationAdjustments)
      .where(
        and(
          eq(compensationAdjustments.workspaceId, ws),
          inArray(compensationAdjustments.recipientMembershipId, participants),
          input.runId
            ? sql`((${compensationAdjustments.state} = 'draft' AND ${compensationAdjustments.sourceRunId} = ${input.runId}) OR (${compensationAdjustments.state} = 'approved' AND ${compensationAdjustments.appliedRunId} IS NULL AND (${compensationAdjustments.sourceRunId} IS NULL OR ${compensationAdjustments.sourceRunId} <> ${input.runId})))`
            : sql`(${compensationAdjustments.state} = 'approved' AND ${compensationAdjustments.appliedRunId} IS NULL)`,
        ),
      );
    for (const a of adj) {
      const key = `${a.recipientMembershipId}:adjustment:${a.id}`;
      if (claims.has(key)) continue;
      lines.push({
        recipientMembershipId: a.recipientMembershipId,
        ruleVersionId: null,
        adjustmentId: a.id,
        sourceType: 'adjustment',
        sourceId: a.id,
        sourceLabel: a.reason,
        component: a.kind,
        entitlementKey: key,
        quantity: null,
        rate: null,
        amountMinor: a.amountMinor,
        currency: a.currency.trim(),
        excluded: false,
        exclusionReason: null,
        explanation: { kind: a.kind, reason: a.reason, originalEntitlementKey: a.originalEntitlementKey, sourceRunId: a.sourceRunId },
      });
    }
  }

  // ——— Negative balance: carried forward, never collected (T135) ———
  if (input.runId) {
    for (const t of recipientTotals(lines)) {
      if (t.carryForwardMinor >= 0n) continue;
      lines.push({
        recipientMembershipId: t.recipientMembershipId,
        ruleVersionId: null,
        adjustmentId: null,
        sourceType: 'carry_forward',
        sourceId: `${input.runId}:${t.currency}`,
        sourceLabel: 'Negative balance carried forward to the next open run',
        component: 'carry_forward',
        entitlementKey: `${t.recipientMembershipId}:carry_forward:${input.runId}:${t.currency}`,
        quantity: null,
        rate: null,
        amountMinor: -t.carryForwardMinor,
        currency: t.currency,
        excluded: false,
        exclusionReason: null,
        explanation: { carryForwardMinor: t.carryForwardMinor.toString() },
      });
    }
  }

  lines.sort((a, b) => a.recipientMembershipId.localeCompare(b.recipientMembershipId) || (a.ruleVersionId ?? '~').localeCompare(b.ruleVersionId ?? '~') || a.entitlementKey.localeCompare(b.entitlementKey));
  const usedVersions = versions.filter((x) => lines.some((l) => l.ruleVersionId === x.v.id));
  return {
    lines,
    warnings,
    versions: usedVersions,
    snapshot: {
      period: { start: input.periodStart, end: input.periodEnd },
      baseCurrency,
      rules: usedVersions.map((x) => ({
        versionId: x.v.id,
        ruleId: x.rule.id,
        name: x.rule.name,
        versionNo: x.v.versionNo,
        type: x.v.type,
        component: x.rule.componentKey,
        stackGroup: x.rule.stackGroup,
        rateMinor: x.v.rateMinor?.toString() ?? null,
        ratePercent: x.v.ratePercent,
        currency: x.v.currency.trim(),
        basis: x.v.revenueBasis,
        hourlySource: x.v.hourlySource,
        proration: x.v.proration,
        effectiveFrom: x.v.effectiveFrom,
        effectiveTo: x.v.effectiveTo,
        eligibleProjectIds: x.v.eligibleProjectIds,
      })),
      sources: snapshotSources,
      warnings,
    },
  };
};

export const digestOf = (lines: Pick<CalcLine, 'entitlementKey' | 'amountMinor' | 'currency' | 'excluded'>[]) =>
  lines
    .map((l) => `${l.entitlementKey}=${l.amountMinor.toString()}${l.currency}${l.excluded ? 'x' : ''}`)
    .sort()
    .join('\n');

export const currentRunLines = (ctx: QueryContext | CommandContext, runId: string, version: number) =>
  dbOf(ctx).select().from(compensationLines).where(and(eq(compensationLines.workspaceId, ctx.actor.workspaceId), eq(compensationLines.runId, runId), eq(compensationLines.calculationVersion, version)));

export const runRowById = async (ctx: QueryContext | CommandContext, id: string) => {
  const [r] = await dbOf(ctx).select().from(compensationRuns).where(and(eq(compensationRuns.workspaceId, ctx.actor.workspaceId), eq(compensationRuns.id, id)));
  return r ?? null;
};

export { dateRangesOverlap };
