import { and, asc, desc, eq, inArray, max, ne, sql } from 'drizzle-orm';
import { operations, qualityDisputes, qualityReviews, rubricVersions, shifts, type QualityScore, type RubricCriterion } from '@castlane/database';
import {
  AppError,
  QUALITY_REVIEW_TRANSITIONS,
  assertTransition,
  negativeScoresWithoutEvidence,
  newId,
  notFound,
  qualityScore,
  validateRubricCriteria,
  validateScores,
} from '@castlane/domain';
import { allowed, requireAnyPermission, scopePredicate } from '../core/access';
import { audit } from '../core/audit';
import { all, dbOf, type CommandContext, type QueryContext } from '../core/context';
import { emit } from '../core/events';
import { loadMemberRefs, refOrUnknown } from '../core/members';
import { notify } from '../core/notify';
import { assertVersion, lockById, stamp, touch } from '../core/rows';
import { anyOf, assertAssetsExist, exprKeyset, fieldErr, fieldErrs, holds, invalid, loadProjectInfos, me, projectRefOr, type Ctx } from './common';
import { createOfmTask } from './tasks-bridge';
import { canReadShift, operationScope, type OperationRow, type ShiftRow } from './views';

/**
 * Quality reviews (S48, §13.6): rubric versions with weighted criteria scored 0–4 or Not Applicable.
 * All N/A → No Score (T100); scores 0/1 need evidence to publish (T101); disputes keep the original
 * score and a resolution history (T102). No hidden person rating, no pay deduction.
 */

type ReviewRow = typeof qualityReviews.$inferSelect;
type RubricRow = typeof rubricVersions.$inferSelect;
type DisputeRow = typeof qualityDisputes.$inferSelect;

const READ_PERMS = ['quality.read.own', 'quality.read.scope', 'quality.write', 'quality.publish'];

const scopeOf = (r: Pick<ReviewRow, 'projectId'>) => ({ objectType: 'quality_review', projectId: r.projectId });

export const canReadReview = (ctx: Ctx, r: ReviewRow) => {
  if (r.reviewerMembershipId === me(ctx)) return true;
  if (r.state === 'draft') return r.subjectMembershipId !== me(ctx) && (allowed(ctx, 'quality.write', scopeOf(r)) || allowed(ctx, 'quality.publish', scopeOf(r)));
  return allowed(ctx, 'quality.read.scope', scopeOf(r)) || (r.subjectMembershipId === me(ctx) && holds(ctx, 'quality.read.own'));
};

const visibility = (ctx: Ctx) =>
  anyOf(
    eq(qualityReviews.reviewerMembershipId, me(ctx)),
    and(ne(qualityReviews.state, 'draft'), scopePredicate(ctx, 'quality.read.scope', { projectId: qualityReviews.projectId }) ?? sql`true`),
    holds(ctx, 'quality.read.own') ? and(ne(qualityReviews.state, 'draft'), eq(qualityReviews.subjectMembershipId, me(ctx))) : null,
    and(eq(qualityReviews.state, 'draft'), ne(qualityReviews.subjectMembershipId, me(ctx)), scopePredicate(ctx, 'quality.write', { projectId: qualityReviews.projectId }) ?? sql`true`),
  );

const rubricView = (r: RubricRow) => ({
  id: r.id,
  name: r.name,
  rubricKey: r.rubricKey,
  versionNo: r.versionNo,
  criteria: r.criteria,
  state: r.state,
  publishedAt: r.publishedAt?.toISOString() ?? null,
  rowVersion: r.rowVersion,
});

const reviewViews = async (ctx: Ctx, rows: ReviewRow[]) => {
  if (!rows.length) return [];
  const db = dbOf(ctx);
  const ws = ctx.actor.workspaceId;
  const ids = rows.map((r) => r.id);
  const shiftIds = rows.filter((r) => r.subjectType === 'shift').map((r) => r.subjectId);
  const opIds = rows.filter((r) => r.subjectType === 'operation').map((r) => r.subjectId);
  const [rubrics, disputes, replacements, shiftRows, opRows, projects] = await all(ctx, [
    () => db.select().from(rubricVersions).where(inArray(rubricVersions.id, [...new Set(rows.map((r) => r.rubricVersionId))])),
    () => db.select().from(qualityDisputes).where(and(eq(qualityDisputes.workspaceId, ws), inArray(qualityDisputes.qualityReviewId, ids))).orderBy(asc(qualityDisputes.createdAt)),
    () => db.select({ id: qualityReviews.id, of: qualityReviews.revisionOfId }).from(qualityReviews).where(and(eq(qualityReviews.workspaceId, ws), inArray(qualityReviews.revisionOfId, ids))),
    () => (shiftIds.length ? db.select().from(shifts).where(inArray(shifts.id, shiftIds)) : Promise.resolve([] as ShiftRow[])),
    () => (opIds.length ? db.select().from(operations).where(inArray(operations.id, opIds)) : Promise.resolve([] as OperationRow[])),
    () => loadProjectInfos(db, ws, rows.map((r) => r.projectId)),
  ] as const);
  const refs = await loadMemberRefs(db, ws, [...rows.flatMap((r) => [r.subjectMembershipId, r.reviewerMembershipId]), ...disputes.flatMap((d) => [d.raisedByMembershipId, d.resolvedBy])]);
  return rows.map((r) => {
    const rubric = rubrics.find((x) => x.id === r.rubricVersionId)!;
    const result = qualityScore(rubric.criteria, r.scores);
    const sh = shiftRows.find((s) => s.id === r.subjectId);
    const op = opRows.find((o) => o.id === r.subjectId);
    const subject =
      r.subjectType === 'shift'
        ? { id: r.subjectId, label: sh ? `Shift ${sh.scheduledStart.toISOString().slice(0, 10)}` : 'Shift', at: sh?.scheduledStart.toISOString() ?? null }
        : { id: r.subjectId, label: op ? op.title : 'Operation', at: op?.createdAt.toISOString() ?? null };
    const isSubject = r.subjectMembershipId === me(ctx);
    const publisher = allowed(ctx, 'quality.publish', scopeOf(r)) && !isSubject;
    const openDispute = disputes.some((d) => d.qualityReviewId === r.id && d.state === 'open');
    return {
      id: r.id,
      subjectType: r.subjectType,
      subject,
      subjectMember: refOrUnknown(refs, r.subjectMembershipId)!,
      reviewer: refOrUnknown(refs, r.reviewerMembershipId)!,
      project: projectRefOr(projects, r.projectId),
      rubric: rubricView(rubric),
      scores: r.scores,
      factualNotes: r.factualNotes,
      improvements: r.improvements,
      totalScore: r.state === 'draft' ? result.total : r.totalScore === null ? null : Number(r.totalScore).toFixed(2),
      applicableCriteria: result.applicableCriteria,
      state: r.state,
      publishedAt: r.publishedAt?.toISOString() ?? null,
      acknowledgedAt: r.acknowledgedAt?.toISOString() ?? null,
      employeeResponse: r.employeeResponse,
      revisionOfId: r.revisionOfId,
      supersededAt: r.supersededAt?.toISOString() ?? null,
      replacedById: replacements.find((x) => x.of === r.id)?.id ?? null,
      disputes: disputes
        .filter((d) => d.qualityReviewId === r.id)
        .map((d) => ({
          id: d.id,
          raisedBy: refOrUnknown(refs, d.raisedByMembershipId)!,
          reason: d.reason,
          state: d.state,
          decision: d.decision,
          resolution: d.resolution,
          resolvedBy: refOrUnknown(refs, d.resolvedBy),
          resolvedAt: d.resolvedAt?.toISOString() ?? null,
          replacementReviewId: d.replacementReviewId,
          createdAt: d.createdAt.toISOString(),
        })),
      createdAt: r.createdAt.toISOString(),
      rowVersion: r.rowVersion,
      permissions: {
        edit: r.state === 'draft' && r.reviewerMembershipId === me(ctx),
        publish: r.state === 'draft' && publisher,
        acknowledge: isSubject && r.state !== 'draft' && !r.acknowledgedAt && !r.supersededAt,
        dispute: isSubject && r.state === 'published' && !r.supersededAt && !openDispute,
        resolveDispute: openDispute && publisher,
        createImprovementTask: r.state !== 'draft' && !isSubject && (allowed(ctx, 'quality.write', scopeOf(r)) || publisher) && allowed(ctx, 'tasks.create', { projectId: r.projectId }),
      },
    };
  });
};

export const listRubrics = async (ctx: QueryContext) => {
  requireAnyPermission(ctx, READ_PERMS);
  const rows = await ctx.app.db
    .select()
    .from(rubricVersions)
    .where(eq(rubricVersions.workspaceId, ctx.actor.workspaceId))
    .orderBy(asc(rubricVersions.rubricKey), desc(rubricVersions.versionNo));
  return rows.map(rubricView);
};

/** Rubrics are workspace-wide: managing them needs quality.publish at workspace scope. */
const requireRubricAdmin = (ctx: Ctx) => {
  if (!allowed(ctx, 'quality.publish')) throw new AppError('FORBIDDEN', 'Managing rubrics needs workspace-wide quality publishing rights.');
};

export const createRubricVersion = async (ctx: CommandContext, input: { name: string; rubricKey: string; criteria: RubricCriterion[] }) => {
  requireRubricAdmin(ctx);
  const issues = validateRubricCriteria(input.criteria);
  if (issues.length) throw fieldErrs(issues, 'Check the rubric criteria.');
  const [m] = await ctx.tx
    .select({ n: max(rubricVersions.versionNo) })
    .from(rubricVersions)
    .where(and(eq(rubricVersions.workspaceId, ctx.actor.workspaceId), eq(rubricVersions.rubricKey, input.rubricKey)));
  const id = newId();
  const [row] = await ctx.tx
    .insert(rubricVersions)
    .values({ ...stamp(ctx), id, name: input.name.trim(), rubricKey: input.rubricKey, versionNo: (m?.n ?? 0) + 1, criteria: input.criteria })
    .returning();
  await audit(ctx, { action: 'rubric.version_created', entityType: 'rubric_version', entityId: id, metadata: { rubricKey: input.rubricKey, versionNo: row!.versionNo } });
  await emit(ctx, { type: 'rubric.version_created', entityType: 'rubric_version', entityId: id });
  return rubricView(row!);
};

export const publishRubricVersion = async (ctx: CommandContext, id: string) => {
  requireRubricAdmin(ctx);
  const r = await lockById(ctx, rubricVersions, id, 'Rubric');
  assertVersion(ctx, r);
  if (r.state !== 'draft') throw invalid('Only draft rubric versions can be published.');
  const at = ctx.app.clock.now();
  await ctx.tx
    .update(rubricVersions)
    .set({ state: 'retired', ...touch(ctx, rubricVersions) })
    .where(and(eq(rubricVersions.workspaceId, ctx.actor.workspaceId), eq(rubricVersions.rubricKey, r.rubricKey), eq(rubricVersions.state, 'published')));
  const [row] = await ctx.tx.update(rubricVersions).set({ state: 'published', publishedAt: at, ...touch(ctx, rubricVersions) }).where(eq(rubricVersions.id, id)).returning();
  await audit(ctx, { action: 'rubric.version_published', entityType: 'rubric_version', entityId: id, metadata: { rubricKey: r.rubricKey, versionNo: r.versionNo } });
  await emit(ctx, { type: 'rubric.version_published', entityType: 'rubric_version', entityId: id });
  return rubricView(row!);
};

export interface ListQualityInput {
  cursor?: string;
  pageSize?: number;
  view: 'mine' | 'reviewing' | 'all';
  state?: ReviewRow['state'][];
  subjectMembershipId?: string;
  projectId?: string;
}

export const listQualityReviews = async (ctx: QueryContext, input: ListQualityInput) => {
  requireAnyPermission(ctx, READ_PERMS);
  const k = exprKeyset(qualityReviews.createdAt, qualityReviews.id, 'timestamp', 'desc', input);
  const rows = await ctx.app.db
    .select()
    .from(qualityReviews)
    .where(
      and(
        eq(qualityReviews.workspaceId, ctx.actor.workspaceId),
        visibility(ctx),
        input.view === 'mine' ? and(eq(qualityReviews.subjectMembershipId, me(ctx)), ne(qualityReviews.state, 'draft')) : undefined,
        input.view === 'reviewing' ? eq(qualityReviews.reviewerMembershipId, me(ctx)) : undefined,
        input.state?.length ? inArray(qualityReviews.state, input.state) : undefined,
        input.subjectMembershipId ? eq(qualityReviews.subjectMembershipId, input.subjectMembershipId) : undefined,
        input.projectId ? eq(qualityReviews.projectId, input.projectId) : undefined,
        k.where,
      ),
    )
    .orderBy(...k.orderBy)
    .limit(k.limit);
  const page = k.finish(rows, (r) => r.createdAt, (r) => r.id);
  return { ...page, items: await reviewViews(ctx, page.items) };
};

export const getQualityReview = async (ctx: QueryContext | CommandContext, id: string) => {
  const [r] = await dbOf(ctx).select().from(qualityReviews).where(and(eq(qualityReviews.workspaceId, ctx.actor.workspaceId), eq(qualityReviews.id, id)));
  if (!r || !canReadReview(ctx, r)) throw notFound('Quality review');
  return (await reviewViews(ctx, [r]))[0]!;
};

const loadRubric = async (ctx: CommandContext, id: string, field = 'rubricVersionId', allowRetired = false) => {
  const [r] = await ctx.tx.select().from(rubricVersions).where(and(eq(rubricVersions.workspaceId, ctx.actor.workspaceId), eq(rubricVersions.id, id)));
  if (!r || r.state === 'draft' || (!allowRetired && r.state !== 'published')) throw fieldErr(field, 'NOT_PUBLISHED', 'Choose a published rubric version.');
  return r;
};

const validateEvidence = async (ctx: CommandContext, scores: QualityScore[]) => {
  await assertAssetsExist(ctx, scores.flatMap((s) => s.evidenceAssetIds ?? []), 'scores');
};

const assertPublishable = (rubric: RubricRow, scores: QualityScore[]) => {
  const issues = validateScores(rubric.criteria, scores, { requireAll: true });
  if (issues.length) throw fieldErrs(issues, 'Score every criterion or mark it Not Applicable.');
  const negative = negativeScoresWithoutEvidence(scores);
  if (negative.length)
    throw fieldErrs(
      negative.map((key) => ({ field: `scores.${key}.evidenceAssetIds`, code: 'EVIDENCE_REQUIRED', message: 'A score of 0 or 1 needs evidence.' })),
      'Negative scores need evidence before publishing.',
    );
};

export const createQualityReview = async (
  ctx: CommandContext,
  input: { subjectType: 'shift' | 'operation'; subjectId: string; rubricVersionId: string; scores: QualityScore[]; factualNotes?: string | null; improvements?: string | null },
) => {
  let subjectMember: string;
  let projectId: string;
  if (input.subjectType === 'shift') {
    const [s] = await ctx.tx.select().from(shifts).where(and(eq(shifts.workspaceId, ctx.actor.workspaceId), eq(shifts.id, input.subjectId)));
    if (!s || !canReadShift(ctx, s)) throw fieldErr('subjectId', 'NOT_FOUND', 'Choose a shift you can access.');
    if (s.state !== 'ended') throw fieldErr('subjectId', 'NOT_ENDED', 'Only ended shifts are reviewed.');
    subjectMember = s.membershipId;
    projectId = s.projectId;
  } else {
    const [o] = await ctx.tx.select().from(operations).where(and(eq(operations.workspaceId, ctx.actor.workspaceId), eq(operations.id, input.subjectId)));
    if (!o || !allowed(ctx, 'operations.read', operationScope(o))) throw fieldErr('subjectId', 'NOT_FOUND', 'Choose an operation you can access.');
    if (!['completed', 'cancelled'].includes(o.status)) throw fieldErr('subjectId', 'NOT_CLOSED', 'Only completed or cancelled operations are reviewed.');
    subjectMember = o.ownerMembershipId;
    projectId = o.projectId;
  }
  if (!allowed(ctx, 'quality.write', { projectId })) throw new AppError('FORBIDDEN', 'You cannot review work in this model.');
  if (subjectMember === me(ctx)) throw new AppError('FORBIDDEN', 'You cannot review your own work.');
  const rubric = await loadRubric(ctx, input.rubricVersionId);
  const issues = validateScores(rubric.criteria, input.scores, { requireAll: false });
  if (issues.length) throw fieldErrs(issues);
  await validateEvidence(ctx, input.scores);
  const id = newId();
  await ctx.tx.insert(qualityReviews).values({
    ...stamp(ctx),
    id,
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    subjectMembershipId: subjectMember,
    projectId,
    reviewerMembershipId: me(ctx),
    rubricVersionId: rubric.id,
    scores: input.scores,
    factualNotes: input.factualNotes ?? null,
    improvements: input.improvements ?? null,
    totalScore: qualityScore(rubric.criteria, input.scores).total,
  });
  await audit(ctx, { action: 'quality_review.drafted', entityType: 'quality_review', entityId: id, projectId, metadata: { subjectType: input.subjectType, subjectId: input.subjectId } });
  await emit(ctx, { type: 'quality_review.drafted', entityType: 'quality_review', entityId: id, revision: 1 });
  return id;
};

const lockReview = async (ctx: CommandContext, id: string) => {
  const r = await lockById(ctx, qualityReviews, id, 'Quality review');
  if (!canReadReview(ctx, r)) throw notFound('Quality review');
  return r;
};

export const updateQualityReview = async (ctx: CommandContext, id: string, input: { rubricVersionId?: string; scores?: QualityScore[]; factualNotes?: string | null; improvements?: string | null }) => {
  const r = await lockReview(ctx, id);
  if (r.reviewerMembershipId !== me(ctx)) throw new AppError('FORBIDDEN', 'Only the reviewer edits a draft review.');
  assertVersion(ctx, r);
  if (r.state !== 'draft') throw invalid('Published reviews are corrected through a dispute resolution revision.');
  const rubric = await loadRubric(ctx, input.rubricVersionId ?? r.rubricVersionId, 'rubricVersionId', !input.rubricVersionId);
  const scores = input.scores ?? r.scores;
  const issues = validateScores(rubric.criteria, scores, { requireAll: false });
  if (issues.length) throw fieldErrs(issues);
  await validateEvidence(ctx, scores);
  await ctx.tx
    .update(qualityReviews)
    .set({
      rubricVersionId: rubric.id,
      scores,
      factualNotes: input.factualNotes !== undefined ? input.factualNotes : r.factualNotes,
      improvements: input.improvements !== undefined ? input.improvements : r.improvements,
      totalScore: qualityScore(rubric.criteria, scores).total,
      ...touch(ctx, qualityReviews),
    })
    .where(eq(qualityReviews.id, id));
  await emit(ctx, { type: 'quality_review.updated', entityType: 'quality_review', entityId: id });
  return id;
};

const notifyMember = (ctx: CommandContext, r: ReviewRow, recipient: string, eventKey: string, title: string) =>
  notify(ctx.tx, {
    workspaceId: ctx.actor.workspaceId,
    recipientMembershipIds: [recipient],
    eventType: eventKey.split(':')[0]!,
    eventKey,
    kind: 'general',
    title,
    entityType: 'quality_review',
    entityId: r.id,
    projectId: r.projectId,
    actorMembershipId: ctx.actor.membershipId,
    at: ctx.app.clock.now(),
  });

/** Publish (T100/T101): all criteria answered; evidence for 0/1; total frozen (null = No Score). */
export const publishQualityReview = async (ctx: CommandContext, id: string) => {
  const r = await lockReview(ctx, id);
  if (!allowed(ctx, 'quality.publish', scopeOf(r))) throw new AppError('FORBIDDEN', 'You cannot publish quality reviews in this model.');
  if (r.subjectMembershipId === me(ctx)) throw new AppError('FORBIDDEN', 'You cannot publish a review of your own work.');
  assertVersion(ctx, r);
  assertTransition(QUALITY_REVIEW_TRANSITIONS, r.state, 'published', 'review');
  const rubric = await loadRubric(ctx, r.rubricVersionId, 'rubricVersionId', true);
  assertPublishable(rubric, r.scores);
  const result = qualityScore(rubric.criteria, r.scores);
  const at = ctx.app.clock.now();
  await ctx.tx.update(qualityReviews).set({ state: 'published', publishedAt: at, totalScore: result.total, ...touch(ctx, qualityReviews) }).where(eq(qualityReviews.id, id));
  await audit(ctx, { action: 'quality_review.published', entityType: 'quality_review', entityId: id, projectId: r.projectId, metadata: { rubricVersionId: rubric.id, noScore: result.total === null } });
  await emit(ctx, { type: 'quality_review.published', entityType: 'quality_review', entityId: id });
  await notifyMember(ctx, r, r.subjectMembershipId, `quality_review.published:${id}`, 'A quality review of your work was published');
  return id;
};

export const acknowledgeQualityReview = async (ctx: CommandContext, id: string, input: { response?: string }) => {
  const r = await lockReview(ctx, id);
  if (r.subjectMembershipId !== me(ctx)) throw new AppError('FORBIDDEN', 'Only the reviewed member acknowledges a review.');
  assertVersion(ctx, r);
  if (r.state === 'draft' || r.acknowledgedAt || r.supersededAt) throw invalid('This review cannot be acknowledged.');
  await ctx.tx
    .update(qualityReviews)
    .set({ acknowledgedAt: ctx.app.clock.now(), employeeResponse: input.response ?? r.employeeResponse, ...touch(ctx, qualityReviews) })
    .where(eq(qualityReviews.id, id));
  await audit(ctx, { action: 'quality_review.acknowledged', entityType: 'quality_review', entityId: id, projectId: r.projectId });
  await emit(ctx, { type: 'quality_review.acknowledged', entityType: 'quality_review', entityId: id });
  return id;
};

export const disputeQualityReview = async (ctx: CommandContext, id: string, input: { reason: string }) => {
  const r = await lockReview(ctx, id);
  if (r.subjectMembershipId !== me(ctx)) throw new AppError('FORBIDDEN', 'Only the reviewed member can dispute a review.');
  assertVersion(ctx, r);
  if (r.supersededAt) throw invalid('This review was replaced by a revision.');
  assertTransition(QUALITY_REVIEW_TRANSITIONS, r.state, 'disputed', 'review');
  const disputeId = newId();
  await ctx.tx.insert(qualityDisputes).values({ ...stamp(ctx), id: disputeId, qualityReviewId: id, raisedByMembershipId: me(ctx), reason: input.reason });
  await ctx.tx.update(qualityReviews).set({ state: 'disputed', employeeResponse: r.employeeResponse ?? input.reason, ...touch(ctx, qualityReviews) }).where(eq(qualityReviews.id, id));
  await audit(ctx, { action: 'quality_review.disputed', entityType: 'quality_review', entityId: id, projectId: r.projectId, reason: input.reason, metadata: { disputeId } });
  await emit(ctx, { type: 'quality_review.disputed', entityType: 'quality_review', entityId: id });
  await notifyMember(ctx, r, r.reviewerMembershipId, `quality_review.disputed:${disputeId}`, 'A quality review was disputed');
  return id;
};

/**
 * Resolve (T102): the original review and its score are never overwritten. Revised → a replacement
 * revision is published and the original is marked superseded; Withdrawn → the original is superseded
 * without replacement; Upheld → the original stands.
 */
export const resolveQualityDispute = async (
  ctx: CommandContext,
  disputeId: string,
  input: { decision: 'upheld' | 'revised' | 'withdrawn'; reason: string; replacementScores?: QualityScore[]; replacementFactualNotes?: string | null },
) => {
  const d = (await lockById(ctx, qualityDisputes, disputeId, 'Dispute')) as DisputeRow;
  const r = await lockReview(ctx, d.qualityReviewId);
  if (!allowed(ctx, 'quality.publish', scopeOf(r))) throw new AppError('FORBIDDEN', 'You cannot resolve quality disputes in this model.');
  if (r.subjectMembershipId === me(ctx)) throw new AppError('FORBIDDEN', 'You cannot resolve a dispute about your own work.');
  if (d.state !== 'open') throw invalid('This dispute is already resolved.');
  assertTransition(QUALITY_REVIEW_TRANSITIONS, r.state, 'resolved', 'review');
  const at = ctx.app.clock.now();
  let replacementId: string | null = null;
  if (input.decision === 'revised') {
    if (!input.replacementScores) throw fieldErr('replacementScores', 'REQUIRED', 'Enter the revised scores.');
    const rubric = await loadRubric(ctx, r.rubricVersionId, 'rubricVersionId', true);
    assertPublishable(rubric, input.replacementScores);
    await validateEvidence(ctx, input.replacementScores);
    replacementId = newId();
    await ctx.tx.insert(qualityReviews).values({
      ...stamp(ctx),
      id: replacementId,
      subjectType: r.subjectType,
      subjectId: r.subjectId,
      subjectMembershipId: r.subjectMembershipId,
      projectId: r.projectId,
      reviewerMembershipId: me(ctx),
      rubricVersionId: r.rubricVersionId,
      scores: input.replacementScores,
      factualNotes: input.replacementFactualNotes !== undefined ? input.replacementFactualNotes : r.factualNotes,
      improvements: r.improvements,
      totalScore: qualityScore(rubric.criteria, input.replacementScores).total,
      state: 'published',
      publishedAt: at,
      revisionOfId: r.id,
    });
  }
  await ctx.tx
    .update(qualityDisputes)
    .set({ state: 'resolved', decision: input.decision, resolution: input.reason, resolvedBy: me(ctx), resolvedAt: at, replacementReviewId: replacementId, ...touch(ctx, qualityDisputes) })
    .where(eq(qualityDisputes.id, disputeId));
  await ctx.tx
    .update(qualityReviews)
    .set({ state: 'resolved', ...(input.decision === 'upheld' ? {} : { supersededAt: at }), ...touch(ctx, qualityReviews) })
    .where(eq(qualityReviews.id, r.id));
  await audit(ctx, {
    action: 'quality_review.dispute_resolved',
    entityType: 'quality_review',
    entityId: r.id,
    projectId: r.projectId,
    reason: input.reason,
    metadata: { disputeId, decision: input.decision, replacementReviewId: replacementId },
  });
  await emit(ctx, { type: 'quality_review.dispute_resolved', entityType: 'quality_review', entityId: r.id, payload: { decision: input.decision } });
  await notifyMember(ctx, r, r.subjectMembershipId, `quality_review.dispute_resolved:${disputeId}`, 'Your quality review dispute was resolved');
  return replacementId ?? r.id;
};

export const createImprovementTask = async (ctx: CommandContext, id: string, input: { title: string; description?: string; dueAt?: string | null }) => {
  const r = await lockReview(ctx, id);
  if (r.state === 'draft') throw invalid('Publish the review first.');
  if (r.subjectMembershipId === me(ctx)) throw new AppError('FORBIDDEN', 'Improvement tasks are created by reviewers.');
  if (!(allowed(ctx, 'quality.write', scopeOf(r)) || allowed(ctx, 'quality.publish', scopeOf(r))) || !allowed(ctx, 'tasks.create', { projectId: r.projectId }))
    throw new AppError('FORBIDDEN', 'You cannot create improvement tasks here.');
  const [o] = r.subjectType === 'operation' ? await ctx.tx.select({ accountId: operations.accountId }).from(operations).where(eq(operations.id, r.subjectId)) : [];
  const [s] = r.subjectType === 'shift' ? await ctx.tx.select({ accountId: shifts.primaryAccountId }).from(shifts).where(eq(shifts.id, r.subjectId)) : [];
  const taskId = await createOfmTask(ctx, {
    projectId: r.projectId,
    accountId: o?.accountId ?? s?.accountId ?? null,
    title: input.title,
    description: input.description ?? r.improvements,
    assigneeMembershipId: r.subjectMembershipId,
    dueAt: input.dueAt ? new Date(input.dueAt) : null,
    shiftId: r.subjectType === 'shift' ? r.subjectId : null,
    operationId: r.subjectType === 'operation' ? r.subjectId : null,
    source: 'manual',
    notifyTitle: 'Improvement task assigned to you',
  });
  await audit(ctx, { action: 'quality_review.improvement_task_created', entityType: 'quality_review', entityId: id, projectId: r.projectId, metadata: { taskId } });
  return { taskId };
};

export const qualityAverageFor = async (ctx: Ctx, cond = sql`true`) => {
  const [r] = await dbOf(ctx)
    .select({
      avg: sql<string | null>`AVG(${qualityReviews.totalScore})::text`,
      n: sql<string>`count(${qualityReviews.totalScore})::text`,
      noScore: sql<string>`count(*) FILTER (WHERE ${qualityReviews.totalScore} IS NULL)::text`,
    })
    .from(qualityReviews)
    .where(and(eq(qualityReviews.workspaceId, ctx.actor.workspaceId), inArray(qualityReviews.state, ['published', 'disputed', 'resolved']), sql`${qualityReviews.supersededAt} IS NULL`, cond));
  return { average: r?.avg ? Number(r.avg).toFixed(2) : null, sample: Number(r?.n ?? 0), noScore: Number(r?.noScore ?? 0) };
};

