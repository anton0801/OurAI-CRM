import { and, count, eq, max } from 'drizzle-orm';
import { handoverItems, handovers, ofmAssignments, ofmProfiles, shiftAccounts, shiftReports, shiftReportVersions, shifts } from '@castlane/database';
import { AppError, SHIFT_REPORT_TRANSITIONS, assertTransition, newId, notFound } from '@castlane/domain';
import { allowed } from '../core/access';
import { audit } from '../core/audit';
import type { CommandContext } from '../core/context';
import { emit } from '../core/events';
import { notify } from '../core/notify';
import { assertVersion, lockById, stamp, touch } from '../core/rows';
import { assertAssetsExist, fieldErrs, holds, invalid, me } from './common';
import { submitHandoverInternal } from './handovers';
import { canReadShift, reportDetail, shiftScope, type ShiftRow } from './views';

/**
 * Shift reports (§13.3): Not Started → Draft → Submitted → Changes Requested → Submitted → Approved.
 * Submitted and approved versions are frozen (trigger); approval never touches finance.
 */

type VersionRow = typeof shiftReportVersions.$inferSelect;
type ReportRow = typeof shiftReports.$inferSelect;

const emptyCounts = { conversationsHandled: null, followUpsCompleted: null, contentRequests: null, conversionEvents: null };

/** Who reviews a shift report: the shift supervisor, else the model's OFM supervisor, else the assignment supervisor. */
export const reviewerFor = async (ctx: CommandContext, s: ShiftRow): Promise<string | null> => {
  if (s.supervisorMembershipId) return s.supervisorMembershipId;
  const [p] = await ctx.tx.select({ id: ofmProfiles.supervisorMembershipId }).from(ofmProfiles).where(eq(ofmProfiles.projectId, s.projectId));
  if (p?.id) return p.id;
  const [a] = await ctx.tx
    .select({ id: ofmAssignments.supervisorMembershipId })
    .from(ofmAssignments)
    .where(and(eq(ofmAssignments.workspaceId, ctx.actor.workspaceId), eq(ofmAssignments.accountId, s.primaryAccountId), eq(ofmAssignments.membershipId, s.membershipId)))
    .limit(1);
  return a?.id ?? null;
};

/** End Shift opens the report draft (idempotent). */
export const ensureReportDraft = async (ctx: CommandContext, s: ShiftRow) => {
  const [existing] = await ctx.tx.select().from(shiftReports).where(eq(shiftReports.shiftId, s.id));
  if (existing) return existing.id;
  const reportId = newId();
  const versionId = newId();
  await ctx.tx.insert(shiftReports).values({ ...stamp(ctx), id: reportId, shiftId: s.id, state: 'draft', reviewerMembershipId: await reviewerFor(ctx, s) });
  await ctx.tx.insert(shiftReportVersions).values({ ...stamp(ctx), id: versionId, reportId, versionNo: 1, summary: '', counts: emptyCounts });
  await ctx.tx.update(shiftReports).set({ currentVersionId: versionId }).where(eq(shiftReports.id, reportId));
  await ctx.tx.update(shifts).set({ reportState: 'draft' }).where(eq(shifts.id, s.id));
  return reportId;
};

const loadReport = async (ctx: CommandContext, reportId: string) => {
  const report = await lockById(ctx, shiftReports, reportId, 'Report');
  const s = await lockById(ctx, shifts, report.shiftId, 'Shift');
  if (!canReadShift(ctx, s)) throw notFound('Report');
  const [version] = await ctx.tx.select().from(shiftReportVersions).where(eq(shiftReportVersions.id, report.currentVersionId!)).for('update');
  return { report, s, version: version! };
};

export interface ReportDraftInput {
  summary: string;
  completedWork?: string | null;
  issues?: string | null;
  nextActions?: string | null;
  accountSections: { accountId: string; notes: string }[];
  counts: VersionRow['counts'];
  sourceRefs: { label: string; assetId?: string; note?: string }[];
  noOpenItems: boolean;
  handoverId?: string | null;
}

const assertHandoverOfShift = async (ctx: CommandContext, handoverId: string, shiftId: string, field: string) => {
  const [h] = await ctx.tx.select().from(handovers).where(and(eq(handovers.workspaceId, ctx.actor.workspaceId), eq(handovers.id, handoverId)));
  if (!h || h.fromShiftId !== shiftId) throw fieldErrs([{ field, code: 'NOT_FROM_SHIFT', message: 'Choose a handover created from this shift.' }]);
  return h;
};

const validateDraft = async (ctx: CommandContext, s: ShiftRow, input: ReportDraftInput) => {
  const links = await ctx.tx.select({ accountId: shiftAccounts.accountId }).from(shiftAccounts).where(eq(shiftAccounts.shiftId, s.id));
  const ids = new Set(links.map((l) => l.accountId));
  const bad = input.accountSections.findIndex((x) => !ids.has(x.accountId));
  if (bad >= 0) throw fieldErrs([{ field: `accountSections.${bad}.accountId`, code: 'NOT_IN_SHIFT', message: 'Account sections must belong to accounts of this shift.' }]);
  if (new Set(input.accountSections.map((x) => x.accountId)).size !== input.accountSections.length)
    throw fieldErrs([{ field: 'accountSections', code: 'DUPLICATE', message: 'One section per account.' }]);
  await assertAssetsExist(ctx, input.sourceRefs.map((r) => r.assetId).filter((x): x is string => !!x), 'sourceRefs');
  if (input.handoverId) await assertHandoverOfShift(ctx, input.handoverId, s.id, 'handoverId');
};

const draftValues = (input: ReportDraftInput) => ({
  summary: input.summary,
  completedWork: input.completedWork ?? null,
  issues: input.issues ?? null,
  nextActions: input.nextActions ?? null,
  accountSections: input.accountSections,
  counts: input.counts,
  sourceRefs: input.sourceRefs,
  noOpenItems: input.noOpenItems,
  handoverId: input.handoverId ?? null,
});

/** Only the shift's member writes the report (supervisors review it). */
const requireAuthor = (ctx: CommandContext, s: ShiftRow) => {
  if (s.membershipId !== me(ctx) || !holds(ctx, 'shifts.end.own')) throw new AppError('FORBIDDEN', 'Only the member who worked the shift edits its report.');
};

export const saveReportDraft = async (ctx: CommandContext, reportId: string, input: ReportDraftInput) => {
  const { report, s, version } = await loadReport(ctx, reportId);
  requireAuthor(ctx, s);
  assertVersion(ctx, version);
  if (version.state === 'submitted' || version.state === 'approved') throw invalid('This report version was submitted and is frozen.');
  await validateDraft(ctx, s, input);
  if (version.state === 'draft') {
    await ctx.tx.update(shiftReportVersions).set({ ...draftValues(input), ...touch(ctx, shiftReportVersions) }).where(eq(shiftReportVersions.id, version.id));
  } else {
    // Changes Requested: the revision is a new version; the reviewed one stays as history.
    const [m] = await ctx.tx.select({ n: max(shiftReportVersions.versionNo) }).from(shiftReportVersions).where(eq(shiftReportVersions.reportId, report.id));
    const id = newId();
    await ctx.tx.insert(shiftReportVersions).values({ ...stamp(ctx), id, reportId: report.id, versionNo: (m?.n ?? 0) + 1, ...draftValues(input) });
    await ctx.tx.update(shiftReports).set({ currentVersionId: id, ...touch(ctx, shiftReports) }).where(eq(shiftReports.id, report.id));
  }
  await ctx.tx.update(shiftReports).set({ ...touch(ctx, shiftReports) }).where(eq(shiftReports.id, report.id));
  await emit(ctx, { type: 'shift_report.saved', entityType: 'shift', entityId: s.id });
  return reportId;
};

/** Submit (T092): Summary plus either handover items or an explicit No Open Items. */
export const submitReport = async (ctx: CommandContext, shiftId: string, input: { reportVersionId: string; handoverId?: string | null; noOpenItems?: boolean }) => {
  const s0 = await lockById(ctx, shifts, shiftId, 'Shift');
  if (!canReadShift(ctx, s0)) throw notFound('Shift');
  const [reportRow] = await ctx.tx.select().from(shiftReports).where(eq(shiftReports.shiftId, shiftId));
  if (!reportRow) throw invalid('End the shift before submitting its report.');
  const { report, s, version } = await loadReport(ctx, reportRow.id);
  requireAuthor(ctx, s);
  if (version.id !== input.reportVersionId) throw invalid('A newer version of this report exists. Reload and submit the current version.');
  assertVersion(ctx, version);
  if (version.state !== 'draft') throw invalid('Only a draft version can be submitted.');
  assertTransition(SHIFT_REPORT_TRANSITIONS, report.state === 'changes_requested' ? 'changes_requested' : 'draft', 'submitted', 'report');
  const handoverId = input.handoverId !== undefined ? input.handoverId : version.handoverId;
  const noOpenItems = input.noOpenItems ?? version.noOpenItems;
  const errors: { field: string; code: string; message: string }[] = [];
  if (!version.summary.trim()) errors.push({ field: 'summary', code: 'REQUIRED', message: 'Add a summary before submitting.' });
  let itemCount = 0;
  let handover: typeof handovers.$inferSelect | null = null;
  if (handoverId) {
    handover = await assertHandoverOfShift(ctx, handoverId, s.id, 'handoverId');
    const [c] = await ctx.tx.select({ n: count() }).from(handoverItems).where(eq(handoverItems.handoverId, handoverId));
    itemCount = Number(c?.n ?? 0);
  }
  if (itemCount === 0 && !noOpenItems)
    errors.push({ field: 'noOpenItems', code: 'HANDOVER_OR_NO_OPEN_ITEMS', message: 'Hand over the open items or confirm No Open Items.' });
  if (errors.length) throw fieldErrs(errors, 'The report cannot be submitted yet.');
  if (handover && handover.state === 'draft') {
    await submitHandoverInternal(ctx, handover.id, {});
  }
  const at = ctx.app.clock.now();
  await ctx.tx
    .update(shiftReportVersions)
    .set({ handoverId: handoverId ?? null, noOpenItems: itemCount === 0 ? true : noOpenItems, state: 'submitted', submittedAt: at, ...touch(ctx, shiftReportVersions) })
    .where(eq(shiftReportVersions.id, version.id));
  const reviewer = report.reviewerMembershipId ?? (await reviewerFor(ctx, s));
  await ctx.tx.update(shiftReports).set({ state: 'submitted', submittedAt: at, reviewerMembershipId: reviewer, ...touch(ctx, shiftReports) }).where(eq(shiftReports.id, report.id));
  await ctx.tx.update(shifts).set({ reportState: 'submitted', ...touch(ctx, shifts) }).where(eq(shifts.id, s.id));
  await audit(ctx, { action: 'shift_report.submitted', entityType: 'shift', entityId: s.id, projectId: s.projectId, metadata: { versionId: version.id, versionNo: version.versionNo, noOpenItems: itemCount === 0 } });
  await emit(ctx, { type: 'shift_report.submitted', entityType: 'shift', entityId: s.id, payload: { reportId: report.id, versionId: version.id } });
  if (reviewer)
    await notify(ctx.tx, {
      workspaceId: ctx.actor.workspaceId,
      recipientMembershipIds: [reviewer],
      eventType: 'shift_report.submitted',
      eventKey: `shift_report.submitted:${version.id}`,
      kind: 'review_request',
      title: 'Shift report awaiting review',
      entityType: 'shift',
      entityId: s.id,
      projectId: s.projectId,
      actorMembershipId: ctx.actor.membershipId,
      at,
    });
  return report.id;
};

const requireReviewer = (ctx: CommandContext, s: ShiftRow) => {
  if (!allowed(ctx, 'shifts.approve', shiftScope(s))) throw new AppError('FORBIDDEN', 'You cannot review reports of this shift.');
  if (s.membershipId === me(ctx)) throw new AppError('FORBIDDEN', 'You cannot review the report of your own shift.');
};

const lockSubmitted = async (ctx: CommandContext, reportId: string, versionId: string) => {
  const { report, s, version } = await loadReport(ctx, reportId);
  requireReviewer(ctx, s);
  if (version.id !== versionId) throw invalid('This version is no longer current.');
  assertVersion(ctx, version);
  if (version.state !== 'submitted') throw invalid('Only a submitted version can be reviewed.');
  return { report, s, version };
};

/** Approve (T093): freezes the version; never creates, posts or changes financial entries. */
export const approveReport = async (ctx: CommandContext, reportId: string, input: { versionId: string }) => {
  const { report, s, version } = await lockSubmitted(ctx, reportId, input.versionId);
  assertTransition(SHIFT_REPORT_TRANSITIONS, report.state, 'approved', 'report');
  const at = ctx.app.clock.now();
  await ctx.tx.update(shiftReportVersions).set({ state: 'approved', ...touch(ctx, shiftReportVersions) }).where(eq(shiftReportVersions.id, version.id));
  await ctx.tx
    .update(shiftReports)
    .set({ state: 'approved', approvedVersionId: version.id, approvedAt: at, reviewerMembershipId: ctx.actor.membershipId, ...touch(ctx, shiftReports) })
    .where(eq(shiftReports.id, report.id));
  await ctx.tx.update(shifts).set({ reportState: 'approved', ...touch(ctx, shifts) }).where(eq(shifts.id, s.id));
  await audit(ctx, { action: 'shift_report.approved', entityType: 'shift', entityId: s.id, projectId: s.projectId, metadata: { versionId: version.id, versionNo: version.versionNo } });
  await emit(ctx, { type: 'shift_report.approved', entityType: 'shift', entityId: s.id, payload: { reportId: report.id, versionId: version.id } });
  await notify(ctx.tx, {
    workspaceId: ctx.actor.workspaceId,
    recipientMembershipIds: [s.membershipId],
    eventType: 'shift_report.approved',
    eventKey: `shift_report.approved:${version.id}`,
    kind: 'general',
    title: 'Your shift report was approved',
    entityType: 'shift',
    entityId: s.id,
    projectId: s.projectId,
    actorMembershipId: ctx.actor.membershipId,
    at,
  });
  return report.id;
};

export const requestReportChanges = async (ctx: CommandContext, reportId: string, input: { versionId: string; summary: string }) => {
  const { report, s, version } = await lockSubmitted(ctx, reportId, input.versionId);
  assertTransition(SHIFT_REPORT_TRANSITIONS, report.state, 'changes_requested', 'report');
  const at = ctx.app.clock.now();
  await ctx.tx.update(shiftReportVersions).set({ state: 'changes_requested', reviewSummary: input.summary, ...touch(ctx, shiftReportVersions) }).where(eq(shiftReportVersions.id, version.id));
  await ctx.tx.update(shiftReports).set({ state: 'changes_requested', reviewerMembershipId: ctx.actor.membershipId, ...touch(ctx, shiftReports) }).where(eq(shiftReports.id, report.id));
  await ctx.tx.update(shifts).set({ reportState: 'changes_requested', ...touch(ctx, shifts) }).where(eq(shifts.id, s.id));
  await audit(ctx, { action: 'shift_report.changes_requested', entityType: 'shift', entityId: s.id, projectId: s.projectId, reason: input.summary, metadata: { versionId: version.id } });
  await emit(ctx, { type: 'shift_report.changes_requested', entityType: 'shift', entityId: s.id, payload: { reportId: report.id, versionId: version.id } });
  await notify(ctx.tx, {
    workspaceId: ctx.actor.workspaceId,
    recipientMembershipIds: [s.membershipId],
    eventType: 'shift_report.changes_requested',
    eventKey: `shift_report.changes_requested:${version.id}`,
    kind: 'review_request',
    title: 'Changes requested on your shift report',
    excerpt: input.summary,
    entityType: 'shift',
    entityId: s.id,
    projectId: s.projectId,
    actorMembershipId: ctx.actor.membershipId,
    at,
  });
  return report.id;
};

export const getReport = async (ctx: CommandContext, reportId: string) => {
  const [report] = await ctx.tx.select().from(shiftReports).where(and(eq(shiftReports.workspaceId, ctx.actor.workspaceId), eq(shiftReports.id, reportId)));
  if (!report) throw notFound('Report');
  const [s] = await ctx.tx.select().from(shifts).where(eq(shifts.id, report.shiftId));
  if (!s || !canReadShift(ctx, s)) throw notFound('Report');
  return reportDetail(ctx, s, report as ReportRow);
};
