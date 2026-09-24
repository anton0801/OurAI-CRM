import { and, count, eq, gte, inArray, isNull, lte, sql, type SQL } from 'drizzle-orm';
import {
  absences,
  handoverItems,
  handovers,
  memberships,
  ofmContacts,
  operations,
  saleCandidates,
  shiftAccounts,
  shiftBreaks,
  shiftReports,
  shiftReportVersions,
  shifts,
  tasks,
  type DbOrTx,
} from '@castlane/database';
import { formatMinor, lateMinutes, localDate, shiftNetTime, summarizeAllocations, TASK_PRIORITIES } from '@castlane/domain';
import { allowed, scopePredicate } from '../core/access';
import { all, dbOf } from '../core/context';
import { loadMemberRefs, refOrUnknown, type MemberRef } from '../core/members';
import {
  accountRefOr,
  anyOf,
  holds,
  loadAccountInfos,
  loadProjectInfos,
  me,
  memberTimezones,
  projectRefOr,
  type Ctx,
} from './common';

/**
 * Read-model builders and visibility rules shared by every OFM screen. Visibility is decided here
 * once (object checks) and mirrored in SQL predicates (lists), so lists, counts and details agree.
 */

export type ShiftRow = typeof shifts.$inferSelect;
export type HandoverRow = typeof handovers.$inferSelect;
export type OperationRow = typeof operations.$inferSelect;
export type SaleRow = typeof saleCandidates.$inferSelect;
export type ContactRow = typeof ofmContacts.$inferSelect;
export type ReportRow = typeof shiftReports.$inferSelect;
export type VersionRow = typeof shiftReportVersions.$inferSelect;

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/** user id → membership id in this workspace (authors are stored as user ids). */
export const userMemberships = async (db: DbOrTx, workspaceId: string, userIds: (string | null | undefined)[]) => {
  const unique = [...new Set(userIds.filter((x): x is string => !!x))];
  if (!unique.length) return new Map<string, string>();
  const rows = await db
    .select({ id: memberships.id, userId: memberships.userId })
    .from(memberships)
    .where(and(eq(memberships.workspaceId, workspaceId), inArray(memberships.userId, unique)));
  return new Map(rows.map((r) => [r.userId, r.id]));
};

export const authorRefs = async (db: DbOrTx, workspaceId: string, userIds: (string | null | undefined)[]) => {
  const map = await userMemberships(db, workspaceId, userIds);
  const refs = await loadMemberRefs(db, workspaceId, [...map.values()]);
  return (userId: string | null | undefined): MemberRef | null => {
    const m = userId ? map.get(userId) : undefined;
    return m ? (refs.get(m) ?? null) : null;
  };
};

// ——— Shifts ———

export const shiftScope = (s: Pick<ShiftRow, 'id' | 'projectId' | 'primaryAccountId' | 'membershipId' | 'supervisorMembershipId'>) => ({
  objectType: 'shift',
  objectId: s.id,
  projectId: s.projectId,
  accountId: s.primaryAccountId,
  assignedMembershipIds: [s.supervisorMembershipId],
  ownerMembershipId: s.membershipId,
});

/** A shift is readable in the member's shift scope, or when it is their own (shifts.read.own). */
export const canReadShift = (ctx: Ctx, s: ShiftRow) =>
  allowed(ctx, 'shifts.read.scope', shiftScope(s)) || (s.membershipId === me(ctx) && holds(ctx, 'shifts.read.own'));

export const shiftVisibility = (ctx: Ctx): SQL | undefined =>
  anyOf(
    scopePredicate(ctx, 'shifts.read.scope', {
      projectId: shifts.projectId,
      accountId: shifts.primaryAccountId,
      assigned: [shifts.supervisorMembershipId],
      ownerMembership: shifts.membershipId,
    }),
    holds(ctx, 'shifts.read.own') ? eq(shifts.membershipId, me(ctx)) : null,
  );

export const loadShiftAccounts = async (db: DbOrTx, workspaceId: string, shiftIds: string[]) =>
  shiftIds.length
    ? db
        .select()
        .from(shiftAccounts)
        .where(and(eq(shiftAccounts.workspaceId, workspaceId), inArray(shiftAccounts.shiftId, shiftIds)))
    : Promise.resolve([] as (typeof shiftAccounts.$inferSelect)[]);

export const loadBreaks = async (db: DbOrTx, workspaceId: string, shiftIds: string[]) =>
  shiftIds.length
    ? db
        .select()
        .from(shiftBreaks)
        .where(and(eq(shiftBreaks.workspaceId, workspaceId), inArray(shiftBreaks.shiftId, shiftIds)))
        .orderBy(shiftBreaks.startedAt)
    : Promise.resolve([] as (typeof shiftBreaks.$inferSelect)[]);

export const shiftSummaries = async (ctx: Ctx, rows: ShiftRow[]) => {
  if (!rows.length) return [];
  const db = dbOf(ctx);
  const ws = ctx.actor.workspaceId;
  const ids = rows.map((r) => r.id);
  const [links, breaks, tz] = await all(ctx, [
    () => loadShiftAccounts(db, ws, ids),
    () => loadBreaks(db, ws, ids),
    () => memberTimezones(db, ws, rows.map((r) => r.membershipId)),
  ] as const);
  const accountIds = [...rows.map((r) => r.primaryAccountId), ...links.map((l) => l.accountId)];
  const minStart = new Date(Math.min(...rows.map((r) => r.scheduledStart.getTime())) - 86_400_000).toISOString().slice(0, 10);
  const maxEnd = new Date(Math.max(...rows.map((r) => r.scheduledEnd.getTime())) + 86_400_000).toISOString().slice(0, 10);
  const [accounts, projects, refs, leave] = await all(ctx, [
    () => loadAccountInfos(db, ws, accountIds),
    () => loadProjectInfos(db, ws, rows.map((r) => r.projectId)),
    () => loadMemberRefs(db, ws, rows.flatMap((r) => [r.membershipId, r.supervisorMembershipId])),
    () =>
      db
        .select({ membershipId: absences.membershipId, startDate: absences.startDate, endDate: absences.endDate })
        .from(absences)
        .where(
          and(
            eq(absences.workspaceId, ws),
            inArray(absences.membershipId, [...new Set(rows.map((r) => r.membershipId))]),
            eq(absences.state, 'approved'),
            lte(absences.startDate, maxEnd),
            gte(absences.endDate, minStart),
          ),
        ),
  ] as const);
  const linksBy = new Map<string, typeof links>();
  for (const l of links) linksBy.set(l.shiftId, [...(linksBy.get(l.shiftId) ?? []), l]);
  const breaksBy = new Map<string, typeof breaks>();
  for (const b of breaks) breaksBy.set(b.shiftId, [...(breaksBy.get(b.shiftId) ?? []), b]);
  return rows.map((s) => {
    const own = (linksBy.get(s.id) ?? []).sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));
    const net = shiftNetTime(s.actualStart, s.actualEnd, breaksBy.get(s.id) ?? []);
    const zone = tz.get(s.membershipId) ?? 'UTC';
    const dates = new Set([localDate(s.scheduledStart, zone), localDate(new Date(s.scheduledEnd.getTime() - 1), zone)]);
    const onLeave = leave.some((l) => l.membershipId === s.membershipId && [...dates].some((d) => l.startDate <= d && l.endDate >= d));
    return {
      id: s.id,
      project: projectRefOr(projects, s.projectId),
      member: refOrUnknown(refs, s.membershipId)!,
      supervisor: refOrUnknown(refs, s.supervisorMembershipId),
      accounts: (own.length ? own : [{ accountId: s.primaryAccountId, isPrimary: true, coverageLane: 'primary' as const, coverageLaneLabel: null, timeAllocationShare: null }]).map((l) => ({
        account: accountRefOr(accounts, l.accountId, s.projectId),
        isPrimary: l.isPrimary,
        coverageLane: l.coverageLane,
        coverageLaneLabel: l.coverageLaneLabel,
        timeAllocationShare: l.timeAllocationShare,
      })),
      primaryAccount: accountRefOr(accounts, s.primaryAccountId, s.projectId),
      scheduledStart: s.scheduledStart.toISOString(),
      scheduledEnd: s.scheduledEnd.toISOString(),
      timezone: s.timezone,
      state: s.state,
      reportState: s.reportState,
      actualStart: iso(s.actualStart),
      actualEnd: iso(s.actualEnd),
      netSeconds: net.netSeconds,
      lateMinutes: lateMinutes(s.scheduledStart, s.actualStart),
      needsReview: s.needsReviewReason,
      parallelCoverage: s.parallelCoverage,
      onLeave,
      cancelReason: s.cancelReason,
      repeatGroupId: s.repeatGroupId,
      rowVersion: s.rowVersion,
    };
  });
};

export const shiftBriefs = async (ctx: Ctx, rows: ShiftRow[]) => {
  const refs = await loadMemberRefs(dbOf(ctx), ctx.actor.workspaceId, rows.map((r) => r.membershipId));
  return rows.map((s) => ({
    id: s.id,
    scheduledStart: s.scheduledStart.toISOString(),
    scheduledEnd: s.scheduledEnd.toISOString(),
    state: s.state,
    member: refOrUnknown(refs, s.membershipId)!,
    primaryAccountId: s.primaryAccountId,
  }));
};

// ——— Contacts (sensitive) ———

export const contactScope = (c: Pick<ContactRow, 'id' | 'projectId' | 'accountId' | 'managerMembershipId'>) => ({
  objectType: 'ofm_contact',
  objectId: c.id,
  projectId: c.projectId,
  accountId: c.accountId,
  ownerMembershipId: c.managerMembershipId,
  assignedMembershipIds: [c.managerMembershipId],
});

/** Contacts need contacts.read in scope; restricted contacts only their manager or contacts.merge holders. */
export const canReadContact = (ctx: Ctx, c: ContactRow) =>
  allowed(ctx, 'contacts.read', contactScope(c)) && (!c.restricted || c.managerMembershipId === me(ctx) || allowed(ctx, 'contacts.merge', contactScope(c)));

export const contactVisibility = (ctx: Ctx): SQL | undefined => {
  const cols = { projectId: ofmContacts.projectId, accountId: ofmContacts.accountId, ownerMembership: ofmContacts.managerMembershipId, assigned: [ofmContacts.managerMembershipId] };
  const read = scopePredicate(ctx, 'contacts.read', cols);
  const merge = scopePredicate(ctx, 'contacts.merge', cols);
  const restrictedOk = anyOf(eq(ofmContacts.restricted, false), eq(ofmContacts.managerMembershipId, me(ctx)), merge);
  if (read === undefined) return restrictedOk;
  return restrictedOk === undefined ? read : and(read, restrictedOk);
};

export const contactRefs = async (ctx: Ctx, ids: (string | null | undefined)[]) => {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  const out = new Map<string, { id: string; alias: string; restricted: false } | { id: string; restricted: true }>();
  if (!unique.length) return out;
  const rows = await dbOf(ctx)
    .select()
    .from(ofmContacts)
    .where(and(eq(ofmContacts.workspaceId, ctx.actor.workspaceId), inArray(ofmContacts.id, unique)));
  for (const r of rows) out.set(r.id, canReadContact(ctx, r) ? { id: r.id, alias: r.alias, restricted: false } : { id: r.id, restricted: true });
  return out;
};

// ——— Handovers ———

export const handoverScope = (h: Pick<HandoverRow, 'id' | 'accountId' | 'recipientMembershipId' | 'createdBy'>, projectId: string) => ({
  objectType: 'handover',
  objectId: h.id,
  projectId,
  accountId: h.accountId,
  assignedMembershipIds: [h.recipientMembershipId],
  createdByUserId: h.createdBy,
});

export const canReadHandover = (ctx: Ctx, h: HandoverRow, fromShift: ShiftRow) =>
  h.recipientMembershipId === me(ctx) ||
  fromShift.membershipId === me(ctx) ||
  allowed(ctx, 'handovers.read', handoverScope(h, fromShift.projectId));

export const handoverVisibility = (ctx: Ctx): SQL | undefined =>
  anyOf(
    scopePredicate(ctx, 'handovers.read', {
      projectId: shifts.projectId,
      accountId: handovers.accountId,
      assigned: [handovers.recipientMembershipId],
      createdByUser: handovers.createdBy,
    }),
    eq(handovers.recipientMembershipId, me(ctx)),
    eq(shifts.membershipId, me(ctx)),
  );

export const handoverSummaries = async (ctx: Ctx, rows: HandoverRow[]) => {
  if (!rows.length) return [];
  const db = dbOf(ctx);
  const ws = ctx.actor.workspaceId;
  const shiftIds = [...new Set(rows.flatMap((r) => [r.fromShiftId, r.toShiftId]).filter((x): x is string => !!x))];
  const [shiftRows, counts, prio, author] = await all(ctx, [
    () => db.select().from(shifts).where(and(eq(shifts.workspaceId, ws), inArray(shifts.id, shiftIds))),
    () =>
      db
        .select({ handoverId: handoverItems.handoverId, state: handoverItems.state, n: count() })
        .from(handoverItems)
        .where(and(eq(handoverItems.workspaceId, ws), inArray(handoverItems.handoverId, rows.map((r) => r.id))))
        .groupBy(handoverItems.handoverId, handoverItems.state),
    () =>
      db
        .select({ handoverId: handoverItems.handoverId, priority: handoverItems.priority })
        .from(handoverItems)
        .where(and(eq(handoverItems.workspaceId, ws), inArray(handoverItems.handoverId, rows.map((r) => r.id)), sql`${handoverItems.state} <> 'resolved'`)),
    () => authorRefs(db, ws, rows.map((r) => r.createdBy)),
  ] as const);
  const shiftBy = new Map(shiftRows.map((s) => [s.id, s]));
  const [accounts, refs] = await all(ctx, [
    () => loadAccountInfos(db, ws, rows.map((r) => r.accountId)),
    () =>
      loadMemberRefs(db, ws, [
        ...shiftRows.map((s) => s.membershipId),
        ...rows.flatMap((r) => [r.recipientMembershipId, r.acknowledgedBy]),
      ]),
  ] as const);
  return rows.map((h) => {
    const from = shiftBy.get(h.fromShiftId)!;
    const to = h.toShiftId ? shiftBy.get(h.toShiftId) : undefined;
    const c = (state: string) => Number(counts.find((x) => x.handoverId === h.id && x.state === state)?.n ?? 0);
    const priorities = prio.filter((p) => p.handoverId === h.id).map((p) => TASK_PRIORITIES.indexOf(p.priority));
    return {
      id: h.id,
      fromShift: { id: from.id, scheduledStart: from.scheduledStart.toISOString(), scheduledEnd: from.scheduledEnd.toISOString(), member: refOrUnknown(refs, from.membershipId)! },
      toShift: to ? { id: to.id, scheduledStart: to.scheduledStart.toISOString(), member: refOrUnknown(refs, to.membershipId)! } : null,
      recipient: refOrUnknown(refs, h.recipientMembershipId),
      account: accountRefOr(accounts, h.accountId, from.projectId),
      summary: h.summary,
      state: h.state,
      noOpenItems: h.noOpenItems,
      submittedAt: iso(h.submittedAt),
      acknowledgedAt: iso(h.acknowledgedAt),
      acknowledgedBy: refOrUnknown(refs, h.acknowledgedBy),
      itemCounts: { open: c('open'), accepted: c('accepted'), resolved: c('resolved') },
      highestPriority: priorities.length ? TASK_PRIORITIES[Math.max(...priorities)]! : null,
      createdBy: author(h.createdBy),
      createdAt: h.createdAt.toISOString(),
      rowVersion: h.rowVersion,
    };
  });
};

// ——— Operations ———

export const operationScope = (o: Pick<OperationRow, 'id' | 'projectId' | 'accountId' | 'ownerMembershipId'>) => ({
  objectType: 'operation',
  objectId: o.id,
  projectId: o.projectId,
  accountId: o.accountId,
  ownerMembershipId: o.ownerMembershipId,
  assignedMembershipIds: [o.ownerMembershipId],
});

export const operationVisibility = (ctx: Ctx) =>
  scopePredicate(ctx, 'operations.read', {
    projectId: operations.projectId,
    accountId: operations.accountId,
    assigned: [operations.ownerMembershipId],
    ownerMembership: operations.ownerMembershipId,
  });

export const taskRefs = async (ctx: Ctx, ids: (string | null | undefined)[]) => {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  if (!unique.length) return new Map<string, { id: string; title: string; status: (typeof tasks.$inferSelect)['status']; dueAt: string | null }>();
  const rows = await dbOf(ctx)
    .select({ id: tasks.id, title: tasks.title, status: tasks.status, dueAt: tasks.dueAt, projectId: tasks.projectId, accountId: tasks.accountId, assignee: tasks.assigneeMembershipId })
    .from(tasks)
    .where(and(eq(tasks.workspaceId, ctx.actor.workspaceId), inArray(tasks.id, unique), isNull(tasks.deletedAt)));
  return new Map(
    rows
      // Task titles are production data: shown only to members who may read the task.
      .filter((t) => allowed(ctx, 'tasks.read', { projectId: t.projectId, accountId: t.accountId, assignedMembershipIds: [t.assignee] }))
      .map((t) => [t.id, { id: t.id, title: t.title, status: t.status, dueAt: iso(t.dueAt) }]),
  );
};

export const operationSummaries = async (ctx: Ctx, rows: OperationRow[]) => {
  if (!rows.length) return [];
  const db = dbOf(ctx);
  const ws = ctx.actor.workspaceId;
  const now = ctx.app.clock.now();
  const shiftIds = rows.map((r) => r.shiftId).filter((x): x is string => !!x);
  const [accounts, projects, refs, contacts, taskMap, shiftRows] = await all(ctx, [
    () => loadAccountInfos(db, ws, rows.map((r) => r.accountId)),
    () => loadProjectInfos(db, ws, rows.map((r) => r.projectId)),
    () => loadMemberRefs(db, ws, rows.map((r) => r.ownerMembershipId)),
    () => contactRefs(ctx, rows.map((r) => r.contactId)),
    () => taskRefs(ctx, rows.map((r) => r.taskId)),
    () => (shiftIds.length ? db.select({ id: shifts.id, scheduledStart: shifts.scheduledStart }).from(shifts).where(and(eq(shifts.workspaceId, ws), inArray(shifts.id, shiftIds))) : Promise.resolve([])),
  ] as const);
  const shiftBy = new Map(shiftRows.map((s) => [s.id, s]));
  return rows.map((o) => ({
    id: o.id,
    type: o.type,
    title: o.title,
    account: accountRefOr(accounts, o.accountId, o.projectId),
    project: projectRefOr(projects, o.projectId),
    contact: o.contactId ? (contacts.get(o.contactId) ?? { id: o.contactId, restricted: true as const }) : null,
    owner: refOrUnknown(refs, o.ownerMembershipId)!,
    dueAt: iso(o.dueAt),
    priority: o.priority,
    status: o.status,
    waitingFor: o.waitingFor,
    nextCheckAt: iso(o.nextCheckAt),
    outcome: o.outcome,
    cancelReason: o.cancelReason,
    shift: o.shiftId && shiftBy.get(o.shiftId) ? { id: o.shiftId, scheduledStart: shiftBy.get(o.shiftId)!.scheduledStart.toISOString() } : null,
    task: o.taskId ? (taskMap.get(o.taskId) ?? null) : null,
    contentItemId: o.contentItemId,
    promisedDeliverable: o.promisedDeliverable,
    evidenceAssetIds: o.evidenceAssetIds,
    completedAt: iso(o.completedAt),
    overdue: !!o.dueAt && o.dueAt.getTime() < now.getTime() && !['completed', 'cancelled'].includes(o.status),
    archivedAt: iso(o.archivedAt),
    createdAt: o.createdAt.toISOString(),
    updatedAt: o.updatedAt.toISOString(),
    rowVersion: o.rowVersion,
  }));
};

// ——— Sale candidates ———

export const saleScope = (s: Pick<SaleRow, 'id' | 'projectId' | 'accountId' | 'createdBy'>) => ({
  objectType: 'sale_candidate',
  objectId: s.id,
  projectId: s.projectId,
  accountId: s.accountId,
  createdByUserId: s.createdBy,
});

export const canReadSale = (ctx: Ctx, s: SaleRow) =>
  allowed(ctx, 'sale-candidates.write', saleScope(s)) || allowed(ctx, 'sale-candidates.review', saleScope(s)) || allowed(ctx, 'finance.read', { projectId: s.projectId });

export const saleVisibility = (ctx: Ctx) => {
  const cols = { projectId: saleCandidates.projectId, accountId: saleCandidates.accountId, createdByUser: saleCandidates.createdBy };
  return anyOf(
    scopePredicate(ctx, 'sale-candidates.write', cols),
    scopePredicate(ctx, 'sale-candidates.review', cols),
    scopePredicate(ctx, 'finance.read', { projectId: saleCandidates.projectId }),
  );
};

const m = (v: bigint | null, currency: string) => (v === null ? null : formatMinor(v, currency));

export const saleViews = async (ctx: Ctx, rows: SaleRow[]) => {
  if (!rows.length) return [];
  const db = dbOf(ctx);
  const ws = ctx.actor.workspaceId;
  const shiftIds = rows.map((r) => r.shiftId).filter((x): x is string => !!x);
  const [accounts, projects, contacts, shiftRows, author] = await all(ctx, [
    () => loadAccountInfos(db, ws, rows.map((r) => r.accountId)),
    () => loadProjectInfos(db, ws, rows.map((r) => r.projectId)),
    () => contactRefs(ctx, rows.map((r) => r.contactId)),
    () => (shiftIds.length ? db.select().from(shifts).where(and(eq(shifts.workspaceId, ws), inArray(shifts.id, shiftIds))) : Promise.resolve([] as ShiftRow[])),
    () => authorRefs(db, ws, rows.map((r) => r.createdBy)),
  ] as const);
  const refs = await loadMemberRefs(db, ws, [
    ...rows.flatMap((r) => r.claimedAllocations.map((a) => a.membershipId)),
    ...rows.map((r) => r.reviewedBy),
    ...shiftRows.map((s) => s.membershipId),
  ]);
  const shiftBy = new Map(shiftRows.map((s) => [s.id, s]));
  return rows.map((s) => {
    const alloc = summarizeAllocations(s.claimedAllocations);
    const sh = s.shiftId ? shiftBy.get(s.shiftId) : undefined;
    const pending = s.state === 'pending';
    return {
      id: s.id,
      account: accountRefOr(accounts, s.accountId, s.projectId),
      project: projectRefOr(projects, s.projectId),
      sourceNamespace: s.sourceNamespace,
      sourceTransactionId: s.sourceTransactionId,
      manualReference: s.manualReference,
      contact: s.contactId ? (contacts.get(s.contactId) ?? { id: s.contactId, restricted: true as const }) : null,
      shift: sh ? { id: sh.id, scheduledStart: sh.scheduledStart.toISOString(), member: refOrUnknown(refs, sh.membershipId)! } : null,
      operationId: s.operationId,
      occurredAt: s.occurredAt.toISOString(),
      ...(canReadSale(ctx, s)
        ? { money: { gross: m(s.grossMinor, s.currency), refund: m(s.refundMinor, s.currency), fee: m(s.feeMinor, s.currency), net: m(s.netMinor, s.currency), currency: s.currency } }
        : {}),
      currency: s.currency,
      sourceNote: s.sourceNote,
      evidenceAssetIds: s.evidenceAssetIds,
      claimedAllocations: s.claimedAllocations.map((a) => ({ member: refOrUnknown(refs, a.membershipId)!, sharePercent: a.sharePercent })),
      unassignedPercent: alloc.unassignedPercent,
      attributionStatus: alloc.status,
      state: s.state,
      reviewNote: s.reviewNote,
      reviewedBy: refOrUnknown(refs, s.reviewedBy),
      reviewedAt: iso(s.reviewedAt),
      financialEntryId: s.financialEntryId,
      duplicateWarning: s.duplicateWarning,
      createdBy: author(s.createdBy),
      createdAt: s.createdAt.toISOString(),
      rowVersion: s.rowVersion,
      permissions: {
        update:
          pending &&
          (allowed(ctx, 'sale-candidates.review', saleScope(s)) || (allowed(ctx, 'sale-candidates.write', saleScope(s)) && s.createdBy === ctx.actor.userId)),
      },
    };
  });
};

/**
 * Confirmed sales = posted finance entries linked to the given candidates (net: revenue − refunds −
 * fees, reversals subtracted), grouped by currency. Pending candidates are never included.
 */
export const confirmedSales = async (db: DbOrTx, workspaceId: string, candidateFilter: SQL) => {
  const res = await db.execute<{ currency: string; total: string }>(sql`
    SELECT l.currency, SUM(
      (CASE WHEN l.accounting_class = 'revenue' THEN 1 WHEN l.accounting_class IN ('contra_revenue', 'fee') THEN -1 ELSE 0 END)
      * (CASE WHEN l.is_reversal THEN -1 ELSE 1 END) * l.amount_minor)::text AS total
    FROM financial_entry_lines l
    JOIN financial_entries e ON e.id = l.entry_id AND e.workspace_id = l.workspace_id
    WHERE e.workspace_id = ${workspaceId} AND e.state = 'posted'
      AND (e.sale_candidate_id IN (SELECT sc.id FROM sale_candidates sc WHERE sc.workspace_id = ${workspaceId} AND ${candidateFilter})
        OR e.reverses_entry_id IN (SELECT e2.id FROM financial_entries e2 WHERE e2.workspace_id = ${workspaceId} AND e2.sale_candidate_id IN
          (SELECT sc.id FROM sale_candidates sc WHERE sc.workspace_id = ${workspaceId} AND ${candidateFilter})))
    GROUP BY l.currency ORDER BY l.currency`);
  return res.rows.filter((r) => r.total !== null).map((r) => ({ amount: formatMinor(BigInt(r.total), r.currency), currency: r.currency }));
};

export const pendingSales = async (db: DbOrTx, workspaceId: string, filter: SQL) => {
  const rows = await db
    .select({ currency: saleCandidates.currency, n: count(), gross: sql<string | null>`SUM(COALESCE(${saleCandidates.netMinor}, ${saleCandidates.grossMinor}))::text` })
    .from(saleCandidates)
    .where(and(eq(saleCandidates.workspaceId, workspaceId), eq(saleCandidates.state, 'pending'), filter))
    .groupBy(saleCandidates.currency);
  return {
    count: rows.reduce((a, r) => a + Number(r.n), 0),
    amounts: rows.filter((r) => r.gross !== null).map((r) => ({ amount: formatMinor(BigInt(r.gross!), r.currency), currency: r.currency })),
  };
};

// ——— Reports ———

export const versionView = (v: VersionRow, refFor: (userId: string | null) => MemberRef | null) => ({
  id: v.id,
  versionNo: v.versionNo,
  state: v.state,
  summary: v.summary,
  completedWork: v.completedWork,
  issues: v.issues,
  nextActions: v.nextActions,
  accountSections: v.accountSections,
  counts: v.counts,
  sourceRefs: v.sourceRefs,
  noOpenItems: v.noOpenItems,
  handoverId: v.handoverId,
  reviewSummary: v.reviewSummary,
  submittedAt: iso(v.submittedAt),
  createdAt: v.createdAt.toISOString(),
  createdBy: refFor(v.createdBy),
  rowVersion: v.rowVersion,
});

export const reportDetail = async (ctx: Ctx, shift: ShiftRow, report: ReportRow) => {
  const db = dbOf(ctx);
  const ws = ctx.actor.workspaceId;
  const versions = await db
    .select()
    .from(shiftReportVersions)
    .where(and(eq(shiftReportVersions.workspaceId, ws), eq(shiftReportVersions.reportId, report.id)))
    .orderBy(shiftReportVersions.versionNo);
  const current = versions.find((v) => v.id === report.currentVersionId) ?? versions[versions.length - 1]!;
  const [refs, author] = await all(ctx, [() => loadMemberRefs(db, ws, [report.reviewerMembershipId]), () => authorRefs(db, ws, versions.map((v) => v.createdBy))] as const);
  const salesVisible =
    allowed(ctx, 'sale-candidates.write', { projectId: shift.projectId, accountId: shift.primaryAccountId }) ||
    allowed(ctx, 'sale-candidates.review', { projectId: shift.projectId, accountId: shift.primaryAccountId }) ||
    allowed(ctx, 'finance.read', { projectId: shift.projectId });
  let sales: { pendingVerification: { count: number; amounts?: { amount: string; currency: string }[] }; confirmed?: { amount: string; currency: string }[] } | undefined;
  if (salesVisible) {
    const filter = sql`${saleCandidates.shiftId} = ${shift.id}`;
    const pending = await pendingSales(db, ws, filter);
    sales = { pendingVerification: pending };
    if (allowed(ctx, 'finance.read', { projectId: shift.projectId })) sales.confirmed = await confirmedSales(db, ws, sql`sc.shift_id = ${shift.id}`);
  }
  return {
    id: report.id,
    shiftId: shift.id,
    state: report.state,
    reviewer: refOrUnknown(refs, report.reviewerMembershipId),
    submittedAt: iso(report.submittedAt),
    approvedAt: iso(report.approvedAt),
    approvedVersionId: report.approvedVersionId,
    currentVersion: versionView(current, author),
    versions: versions.map((v) => ({ id: v.id, versionNo: v.versionNo, state: v.state, submittedAt: iso(v.submittedAt), reviewSummary: v.reviewSummary, createdAt: v.createdAt.toISOString() })),
    ...(sales ? { sales } : {}),
    rowVersion: report.rowVersion,
  };
};
