import { and, asc, desc, eq, gt, inArray, isNull, lt, lte, or, sql, type SQL } from 'drizzle-orm';
import { hasAnywhere, listFilter } from '@castlane/authorization';
import {
  characters,
  characterVersions,
  comments,
  contentItems,
  contentVersions,
  projects,
  publications,
  reviewDecisions,
  reviews,
  type DbOrTx,
} from '@castlane/database';
import type { TaskCreateBody } from '@castlane/api-contracts';
import { AppError, clampPageSize, decodeCursor, encodeCursor, newId, notFound } from '@castlane/domain';
import { allowed, filterToSql, requireAnyPermission } from '../core/access';
import { audit } from '../core/audit';
import { all, dbOf, type CommandContext, type QueryContext } from '../core/context';
import { emit } from '../core/events';
import { loadMemberRefs, refOrUnknown } from '../core/members';
import { notify } from '../core/notify';
import { assertVersion, lockById, stamp, touch } from '../core/rows';
import { createComment } from '../work/comments';
import { createTask } from '../work/tasks';
import { contentBriefView, contentSummaries, indexContent, recordStageEvent, reviewPolicyOfProject } from './content';
import { fileThumbnailUrl, loadVersionFiles, primaryFile } from './files';
import { isContentOverdue, reviewSteps, selfReviewOutcome, waitingHours, type BriefFields, type ProjectReviewPolicy, type ReviewStepKind } from './rules';
import { authorizeContentAction, contentScope, contentVisibility, fieldError, loadContent, lockContent, readableContent, type ContentRow } from './scope';
import { assertEligibleReviewer, contentVersionDetail, listContentVersions, openBlockingCount } from './versions';

type ReviewRow = typeof reviews.$inferSelect;

// ——— Approval state for other modules (publications) ———

/**
 * Whether a content version may be placed (scheduled) now: it must be approved and its approval
 * not revoked (T044). Publications call this before Schedule; published history is never changed.
 */
export const contentVersionPlacement = async (db: DbOrTx, workspaceId: string, versionId: string) => {
  const [v] = await db
    .select({ id: contentVersions.id, versionNo: contentVersions.versionNo, approvedAt: contentVersions.approvedAt, revokedAt: contentVersions.approvalRevokedAt, contentItemId: contentVersions.contentItemId })
    .from(contentVersions)
    .where(and(eq(contentVersions.workspaceId, workspaceId), eq(contentVersions.id, versionId)));
  if (!v) return { placeable: false as const, reason: 'The version was not found.' };
  if (v.revokedAt) return { placeable: false as const, reason: `The approval of version ${v.versionNo} was revoked. Choose an approved version.` };
  if (!v.approvedAt) return { placeable: false as const, reason: `Version ${v.versionNo} is not approved.` };
  return { placeable: true as const, reason: null, contentItemId: v.contentItemId, versionNo: v.versionNo };
};

export const assertContentVersionPlaceable = async (ctx: QueryContext | CommandContext, versionId: string) => {
  const r = await contentVersionPlacement(dbOf(ctx), ctx.actor.workspaceId, versionId);
  if (!r.placeable) throw new AppError('INVALID_STATE', r.reason, { details: { versionId } });
  return r;
};

// ——— Queue (S25) ———

const OPEN_BLOCKING = sql<number>`(SELECT count(*)::int FROM comments cm WHERE cm.workspace_id = ${reviews.workspaceId} AND cm.target_version_id = ${reviews.targetId} AND cm.severity = 'blocking' AND cm.state <> 'resolved' AND cm.deleted_at IS NULL AND cm.reply_to_id IS NULL)`;

/**
 * On the project's eligible-reviewer list (§10.3: each step has a list of eligible reviewers). No list
 * means anyone with content.approve; the workspace Owner is exempt. Applies to both decisions.
 */
const onEligibleList = (ctx: QueryContext | CommandContext, policy: Pick<ProjectReviewPolicy, 'eligibleReviewerMembershipIds'> | null | undefined) => {
  const list = policy?.eligibleReviewerMembershipIds;
  return !list?.length || !ctx.actor.membershipId || ctx.actor.access.isOwner || list.includes(ctx.actor.membershipId);
};

/** Members who approved an earlier step of this review's round: a later step needs another person (two levels of approval). */
const earlierStepApprovers = async (db: DbOrTx, r: ReviewRow) => {
  if (r.stepOrder <= 1) return [] as string[];
  const rows = await db
    .select({ by: reviewDecisions.decidedByMembershipId })
    .from(reviewDecisions)
    .innerJoin(reviews, eq(reviews.id, reviewDecisions.reviewId))
    .where(and(eq(reviews.workspaceId, r.workspaceId), eq(reviews.targetId, r.targetId), eq(reviews.roundNo, r.roundNo), lt(reviews.stepOrder, r.stepOrder), eq(reviewDecisions.decision, 'approved')));
  return rows.map((x) => x.by);
};

const NOT_ELIGIBLE_MESSAGE = 'You are not on the project’s list of eligible reviewers.';
const EARLIER_STEP_MESSAGE = 'You approved an earlier step of this review. Another reviewer must approve this step.';

/** Reviews visible to the actor: content reviews through the content scope, profile reviews through characters.read. */
const reviewVisibility = (ctx: QueryContext): SQL => {
  const content = contentVisibility(ctx);
  const chars = filterToSql(listFilter(ctx.actor.access, 'characters.read'), { projectId: reviews.projectId });
  return or(
    and(eq(reviews.targetType, 'content_version'), sql`${contentItems.id} IS NOT NULL`, isNull(contentItems.deletedAt), content),
    and(eq(reviews.targetType, 'character_version'), chars),
  )!;
};

export interface ReviewQueueInput {
  scope: 'assigned' | 'all';
  status?: ReviewRow['status'][];
  targetType?: ReviewRow['targetType'];
  projectId?: string;
  format?: ContentRow['format'][];
  reviewerMembershipId?: string;
  waitingHoursMin?: number;
  overdue?: boolean;
  q?: string;
  sort: 'waiting' | 'due' | 'decided';
  cursor?: string;
  pageSize?: number;
}

export const listReviewQueue = async (ctx: QueryContext, input: ReviewQueueInput) => {
  requireAnyPermission(ctx, ['content.read', 'characters.read']);
  const now = ctx.app.clock.now();
  const size = clampPageSize(input.pageSize);
  const status = input.status?.length ? input.status : (['pending'] as ReviewRow['status'][]);
  const sortCol = input.sort === 'due' ? reviews.dueAt : input.sort === 'decided' ? reviews.decidedAt : reviews.submittedAt;
  const ascending = input.sort !== 'decided';
  const c = input.cursor ? decodeCursor(input.cursor) : null;
  let cursorCond: SQL | undefined;
  if (c) {
    const raw = c.v[0];
    if (raw === null) cursorCond = and(isNull(sortCol), ascending ? gt(reviews.id, c.id) : lt(reviews.id, c.id));
    else {
      const v = new Date(String(raw));
      const cmp = ascending ? gt : lt;
      cursorCond = or(cmp(sortCol, v), and(eq(sortCol, v), cmp(reviews.id, c.id)), isNull(sortCol));
    }
  }
  const escape = (q: string) => `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
  const rows = await ctx.app.db
    .select({
      r: reviews,
      contentTitle: contentItems.title,
      format: contentItems.format,
      contentRow: contentItems,
      versionNo: contentVersions.versionNo,
      characterName: characters.name,
      characterVersionNo: characterVersions.versionNo,
      projectName: projects.name,
      reviewPolicy: projects.reviewPolicy,
      openBlocking: OPEN_BLOCKING,
    })
    .from(reviews)
    .innerJoin(projects, and(eq(projects.workspaceId, reviews.workspaceId), eq(projects.id, reviews.projectId)))
    .leftJoin(contentItems, and(eq(reviews.targetType, 'content_version'), eq(contentItems.workspaceId, reviews.workspaceId), eq(contentItems.id, reviews.subjectId)))
    .leftJoin(contentVersions, and(eq(reviews.targetType, 'content_version'), eq(contentVersions.id, reviews.targetId)))
    .leftJoin(characters, and(eq(reviews.targetType, 'character_version'), eq(characters.id, reviews.subjectId)))
    .leftJoin(characterVersions, and(eq(reviews.targetType, 'character_version'), eq(characterVersions.id, reviews.targetId)))
    .where(
      and(
        eq(reviews.workspaceId, ctx.actor.workspaceId),
        reviewVisibility(ctx),
        inArray(reviews.status, status),
        input.scope === 'assigned' ? eq(reviews.reviewerMembershipId, ctx.actor.membershipId ?? '00000000-0000-4000-8000-000000000000') : undefined,
        input.targetType ? eq(reviews.targetType, input.targetType) : undefined,
        input.projectId ? eq(reviews.projectId, input.projectId) : undefined,
        input.format?.length ? inArray(contentItems.format, input.format) : undefined,
        input.reviewerMembershipId ? eq(reviews.reviewerMembershipId, input.reviewerMembershipId) : undefined,
        input.waitingHoursMin ? lte(reviews.submittedAt, new Date(now.getTime() - input.waitingHoursMin * 3_600_000)) : undefined,
        input.overdue ? and(lt(reviews.dueAt, now), eq(reviews.status, 'pending')) : undefined,
        input.q ? or(sql`${contentItems.title} ILIKE ${escape(input.q)}`, sql`${characters.name} ILIKE ${escape(input.q)}`) : undefined,
        cursorCond,
      ),
    )
    .orderBy(ascending ? sql`${sortCol} ASC NULLS LAST` : sql`${sortCol} DESC NULLS LAST`, ascending ? asc(reviews.id) : desc(reviews.id))
    .limit(size + 1);
  const hasMore = rows.length > size;
  const page = hasMore ? rows.slice(0, size) : rows;
  const refs = await loadMemberRefs(ctx.app.db, ctx.actor.workspaceId, page.flatMap((p) => [p.r.authorMembershipId, p.r.reviewerMembershipId]));
  const contentVersionIds = page.filter((p) => p.r.targetType === 'content_version').map((p) => p.r.targetId);
  const files = await loadVersionFiles(ctx.app.db, ctx.actor.workspaceId, contentVersionIds);
  const ws = ctx.actor.workspaceId;
  const items = page.map((p) => {
    const r = p.r;
    const isContent = r.targetType === 'content_version';
    const content = p.contentRow;
    const decide = isContent && content ? allowed(ctx, 'content.approve', contentScope(content)) && onEligibleList(ctx, p.reviewPolicy) : allowed(ctx, 'characters.approve', { projectId: r.projectId });
    return {
      id: r.id,
      targetType: r.targetType,
      subjectId: r.subjectId,
      title: isContent ? (p.contentTitle ?? 'Content') : `${p.characterName ?? 'Character'} profile`,
      href: isContent ? `/w/${ws}/reviews/${r.id}` : `/w/${ws}/projects/${r.projectId}/characters/${r.subjectId}`,
      project: { id: r.projectId, name: p.projectName },
      format: isContent ? (p.format ?? null) : null,
      versionId: r.targetId,
      versionNo: (isContent ? p.versionNo : p.characterVersionNo) ?? 0,
      roundNo: r.roundNo,
      stepKind: r.stepKind,
      status: r.status,
      author: refOrUnknown(refs, r.authorMembershipId),
      reviewer: refOrUnknown(refs, r.reviewerMembershipId),
      submittedAt: r.submittedAt.toISOString(),
      dueAt: r.dueAt?.toISOString() ?? null,
      overdue: r.status === 'pending' && !!r.dueAt && r.dueAt < now,
      waitingHours: waitingHours(r.submittedAt, r.decidedAt ?? now),
      openBlocking: Number(p.openBlocking ?? 0),
      thumbnailUrl: isContent ? fileThumbnailUrl(ws, primaryFile(files.filter((f) => f.contentVersionId === r.targetId)), 64) : null,
      decidedAt: r.decidedAt?.toISOString() ?? null,
      rowVersion: r.rowVersion,
      permissions: {
        decide: r.status === 'pending' && decide && (r.authorMembershipId !== ctx.actor.membershipId || r.policySnapshot.allowSelfReview || ctx.actor.access.isOwner),
        assign: r.status === 'pending' && isContent && !!content && (allowed(ctx, 'content.approve', contentScope(content)) || allowed(ctx, 'content.edit', contentScope(content))),
      },
    };
  });
  const last = page[page.length - 1];
  const lastVal = last ? (input.sort === 'due' ? last.r.dueAt : input.sort === 'decided' ? last.r.decidedAt : last.r.submittedAt) : null;
  return { items, hasMore, nextCursor: hasMore && last ? encodeCursor({ v: [lastVal ? lastVal.toISOString() : null], id: last.r.id }) : null };
};

// ——— Studio (S26) ———

const loadContentReview = async (ctx: QueryContext | CommandContext, reviewId: string, lock = false): Promise<ReviewRow> => {
  const r = lock && 'tx' in ctx ? await lockById(ctx, reviews, reviewId, 'Review') : (await dbOf(ctx).select().from(reviews).where(and(eq(reviews.workspaceId, ctx.actor.workspaceId), eq(reviews.id, reviewId))))[0];
  if (!r) throw notFound('Review');
  if (r.targetType !== 'content_version') throw notFound('Review');
  return r;
};

/** Why the actor cannot approve this review right now (shown next to Approve Version). */
const approveBlockersOf = async (ctx: QueryContext | CommandContext, r: ReviewRow, c: ContentRow, openBlocking: number) => {
  const out: { field: string; code: string; message: string }[] = [];
  if (r.status !== 'pending') out.push({ field: 'status', code: 'DECIDED', message: 'This review was already decided.' });
  if (c.currentVersionId !== r.targetId) out.push({ field: 'versionId', code: 'STALE', message: 'A newer version was submitted; this review no longer decides the latest version.' });
  if (openBlocking > 0) out.push({ field: 'comments', code: 'OPEN_BLOCKERS', message: `Resolve ${openBlocking} blocking comment${openBlocking === 1 ? '' : 's'} before approving.` });
  const [p] = await dbOf(ctx).select({ reviewPolicy: projects.reviewPolicy }).from(projects).where(eq(projects.id, c.projectId));
  if (!allowed(ctx, 'content.approve', contentScope(c))) out.push({ field: 'permission', code: 'FORBIDDEN', message: 'You do not have approval rights for this content.' });
  else if (!onEligibleList(ctx, p?.reviewPolicy)) out.push({ field: 'permission', code: 'NOT_ELIGIBLE', message: NOT_ELIGIBLE_MESSAGE });
  else if (ctx.actor.membershipId && (await earlierStepApprovers(dbOf(ctx), r)).includes(ctx.actor.membershipId))
    out.push({ field: 'step', code: 'EARLIER_STEP', message: EARLIER_STEP_MESSAGE });
  else if (r.authorMembershipId && r.authorMembershipId === ctx.actor.membershipId)
    out.push({
      field: 'selfReview',
      code: 'SELF_REVIEW',
      message: r.policySnapshot.allowSelfReview || ctx.actor.access.isOwner ? 'You submitted this version. Approving it needs an explicit, audited self-review exception.' : 'You submitted this version and cannot approve it yourself.',
    });
  return out;
};

export const getReview = async (ctx: QueryContext | CommandContext, reviewId: string) => {
  const r = await loadContentReview(ctx, reviewId);
  const c = await readableContent(ctx, r.subjectId);
  const db = dbOf(ctx);
  const [[summary], version, versions, decisions, openBlocking] = await all(ctx, [
    () => contentSummaries(ctx, [c]),
    () => contentVersionDetail(ctx, c, r.targetId),
    () => listContentVersions(ctx, c.id),
    () =>
      db
        .select({ d: reviewDecisions })
        .from(reviewDecisions)
        .innerJoin(reviews, eq(reviews.id, reviewDecisions.reviewId))
        .where(and(eq(reviewDecisions.workspaceId, ctx.actor.workspaceId), eq(reviews.subjectId, c.id), eq(reviews.targetType, 'content_version')))
        .orderBy(desc(reviewDecisions.decidedAt)),
    () => openBlockingCount(db, ctx.actor.workspaceId, r.targetId),
  ] as const);
  const refs = await loadMemberRefs(db, ctx.actor.workspaceId, [r.authorMembershipId, r.reviewerMembershipId, ...decisions.map((d) => d.d.decidedByMembershipId)]);
  const scope = contentScope(c);
  const canApprove = allowed(ctx, 'content.approve', scope);
  const blockers = await approveBlockersOf(ctx, r, c, openBlocking);
  const canDecide = canApprove && !blockers.some((b) => b.code === 'NOT_ELIGIBLE');
  const self = r.authorMembershipId === ctx.actor.membershipId;
  const v = version;
  const exceptionAvailable = r.policySnapshot.allowSelfReview || ctx.actor.access.isOwner;
  return {
    id: r.id,
    status: r.status,
    stepKind: r.stepKind,
    stepOrder: r.stepOrder,
    roundNo: r.roundNo,
    steps: r.policySnapshot.steps as ReviewStepKind[],
    reviewer: refOrUnknown(refs, r.reviewerMembershipId),
    author: refOrUnknown(refs, r.authorMembershipId),
    submittedAt: r.submittedAt.toISOString(),
    dueAt: r.dueAt?.toISOString() ?? null,
    overdue: r.status === 'pending' && isContentOverdue(r.dueAt, 'review', ctx.app.clock.now()),
    decidedAt: r.decidedAt?.toISOString() ?? null,
    selfReviewException: r.selfReviewException,
    policy: { allowSelfReview: r.policySnapshot.allowSelfReview, steps: r.policySnapshot.steps as ReviewStepKind[] },
    decisions: decisions.map(({ d }) => ({ id: d.id, decision: d.decision, summary: d.summary, by: refOrUnknown(refs, d.decidedByMembershipId), at: d.decidedAt.toISOString(), versionId: d.targetVersionId })),
    content: { ...summary!, brief: contentBriefView(c.brief as BriefFields) },
    version: v,
    versions,
    isCurrentTarget: c.currentVersionId === r.targetId,
    openBlocking,
    approveBlockers: blockers,
    rowVersion: r.rowVersion,
    permissions: {
      approve: blockers.every((b) => b.code === 'SELF_REVIEW' && exceptionAvailable),
      requestChanges: r.status === 'pending' && canDecide && c.currentVersionId === r.targetId,
      revoke: r.status === 'approved' && canApprove && !!(await isRevocable(ctx, r)),
      assign: r.status === 'pending' && (canApprove || allowed(ctx, 'content.edit', scope)),
      comment: !c.archivedAt,
      selfReviewException: r.status === 'pending' && canDecide && self && exceptionAvailable,
      download: hasAnywhere(ctx.actor.access, 'assets.download'),
    },
  };
};

const isRevocable = async (ctx: QueryContext | CommandContext, r: ReviewRow) => {
  const [v] = await dbOf(ctx).select({ approvedAt: contentVersions.approvedAt, revokedAt: contentVersions.approvalRevokedAt }).from(contentVersions).where(eq(contentVersions.id, r.targetId));
  // Only the final step of a round approves the version.
  return !!v?.approvedAt && !v.revokedAt && r.stepKind === (r.policySnapshot.steps as ReviewStepKind[])[r.policySnapshot.steps.length - 1];
};

// ——— Decisions ———

/** Lock review + content, check scope, If-Match on the review, the exact target and the pending state. */
const beginDecision = async (ctx: CommandContext, reviewId: string, versionId: string) => {
  const r = await loadContentReview(ctx, reviewId, true);
  const c = await lockContent(ctx, r.subjectId);
  await authorizeContentAction(ctx, c, 'content.approve');
  assertVersion(ctx, r);
  if (r.status !== 'pending') throw new AppError('INVALID_STATE', 'This review was already decided.', { details: { status: r.status } });
  if (versionId !== r.targetId) {
    const [asked] = await ctx.tx.select({ versionNo: contentVersions.versionNo }).from(contentVersions).where(and(eq(contentVersions.id, versionId), eq(contentVersions.contentItemId, c.id)));
    const [target] = await ctx.tx.select({ versionNo: contentVersions.versionNo }).from(contentVersions).where(eq(contentVersions.id, r.targetId));
    throw new AppError('INVALID_STATE', `This review decides version ${target?.versionNo ?? '?'}${asked ? `, not version ${asked.versionNo}` : ''}. Open the review of the version you want to decide.`, {
      details: { reviewVersionId: r.targetId, requestedVersionId: versionId },
    });
  }
  if (c.currentVersionId !== r.targetId) throw new AppError('INVALID_STATE', 'A newer version was submitted; this review no longer decides the latest version.');
  const [p] = await ctx.tx.select().from(projects).where(eq(projects.id, c.projectId));
  if (!onEligibleList(ctx, reviewPolicyOfProject(p!))) throw new AppError('FORBIDDEN', NOT_ELIGIBLE_MESSAGE);
  const [v] = await ctx.tx.select().from(contentVersions).where(eq(contentVersions.id, r.targetId)).for('update');
  if (!v) throw notFound('Version');
  return { r, c, v, p: p! };
};

const recipientsOf = (c: ContentRow, r: ReviewRow) => [...new Set([c.ownerMembershipId, r.authorMembershipId].filter((x): x is string => !!x))];

/**
 * Approve Version (§10.1 Review → Approved): the exact submitted version (never "the latest"
 * implicitly — T042), no unresolved blockers (T040), no self-approval without the policy or the
 * Owner's explicit audited exception (T039). Concurrent decisions serialise on the review row;
 * a stale If-Match gets 412 and a decided review 409 (T041). With two steps, Content Quality
 * approval opens the Release Approval step.
 */
export const approveReview = async (ctx: CommandContext, reviewId: string, input: { versionId: string; decisionNote?: string; selfReviewException?: { reason: string } }) => {
  const { r, c, v, p } = await beginDecision(ctx, reviewId, input.versionId);
  if (ctx.actor.membershipId && (await earlierStepApprovers(ctx.tx, r)).includes(ctx.actor.membershipId)) throw new AppError('FORBIDDEN', EARLIER_STEP_MESSAGE, { details: { earlierStep: true } });
  const self = selfReviewOutcome({
    actorMembershipId: ctx.actor.membershipId,
    authorMembershipId: r.authorMembershipId,
    policyAllowsSelfReview: r.policySnapshot.allowSelfReview,
    actorIsOwner: ctx.actor.access.isOwner,
    exceptionRequested: !!input.selfReviewException,
  });
  if (self === 'forbidden')
    throw new AppError('FORBIDDEN', r.policySnapshot.allowSelfReview || ctx.actor.access.isOwner ? 'You submitted this version. Approve it only with an explicit self-review exception and a reason.' : 'You submitted this version and cannot approve it yourself. Ask an eligible reviewer.', {
      details: { selfReview: true, exceptionAvailable: r.policySnapshot.allowSelfReview || ctx.actor.access.isOwner },
    });
  const blocking = await openBlockingCount(ctx.tx, ctx.actor.workspaceId, v.id);
  if (blocking > 0) throw new AppError('INVALID_STATE', `Resolve ${blocking} blocking comment${blocking === 1 ? '' : 's'} before approving this version.`, { details: { openBlocking: blocking } });
  const at = ctx.app.clock.now();
  const steps = r.policySnapshot.steps as ReviewStepKind[];
  const idx = steps.indexOf(r.stepKind);
  const nextStep = idx >= 0 ? steps[idx + 1] : undefined;
  await ctx.tx
    .update(reviews)
    .set({ status: 'approved', decidedAt: at, selfReviewException: self !== 'not_self', ...touch(ctx, reviews) })
    .where(eq(reviews.id, r.id));
  await ctx.tx.insert(reviewDecisions).values({ ...stamp(ctx), id: newId(), reviewId: r.id, decision: 'approved', summary: input.decisionNote?.trim() || null, decidedByMembershipId: ctx.actor.membershipId!, decidedAt: at, targetVersionId: v.id });
  if (self !== 'not_self')
    await audit(ctx, {
      action: 'review.self_review_exception',
      entityType: 'content_item',
      entityId: c.id,
      projectId: c.projectId,
      reason: input.selfReviewException!.reason,
      metadata: { reviewId: r.id, versionId: v.id, versionNo: v.versionNo, basis: self === 'owner_exception' ? 'owner_exception' : 'project_policy' },
      sensitivity: 'security',
    });
  let nextReviewId: string | null = null;
  if (nextStep) {
    nextReviewId = newId();
    const nextReviewer = c.reviewerMembershipId && c.reviewerMembershipId !== ctx.actor.membershipId && c.reviewerMembershipId !== r.authorMembershipId ? c.reviewerMembershipId : null;
    await ctx.tx.insert(reviews).values({
      ...stamp(ctx),
      id: nextReviewId,
      targetType: 'content_version',
      targetId: v.id,
      subjectId: c.id,
      projectId: c.projectId,
      roundNo: r.roundNo,
      stepKind: nextStep,
      stepOrder: r.stepOrder + 1,
      status: 'pending',
      reviewerMembershipId: nextReviewer,
      authorMembershipId: r.authorMembershipId,
      submittedAt: at,
      dueAt: r.dueAt,
      policySnapshot: r.policySnapshot,
    });
    await emit(ctx, { type: 'review.created', entityType: 'review', entityId: nextReviewId, revision: 1, payload: { contentId: c.id, step: nextStep } });
    await notify(ctx.tx, {
      workspaceId: c.workspaceId,
      recipientMembershipIds: [nextReviewer ?? p.ownerMembershipId],
      eventType: 'review.requested',
      eventKey: `review.requested:${nextReviewId}`,
      kind: 'review_request',
      title: `Release approval requested: ${c.title} v${v.versionNo}`,
      entityType: 'review',
      entityId: nextReviewId,
      projectId: c.projectId,
      actorMembershipId: ctx.actor.membershipId,
      at,
    });
  } else {
    await ctx.tx.update(contentVersions).set({ approvedAt: at, ...touch(ctx, contentVersions) }).where(eq(contentVersions.id, v.id));
    const [row] = await ctx.tx
      .update(contentItems)
      .set({ stage: 'approved', approvedVersionId: v.id, firstApprovedAt: c.firstApprovedAt ?? at, ...touch(ctx, contentItems) })
      .where(eq(contentItems.id, c.id))
      .returning();
    await recordStageEvent(ctx, c.id, 'review', 'approved', `Version ${v.versionNo} approved`);
    await emit(ctx, { type: 'content.approved', entityType: 'content_item', entityId: c.id, revision: row!.rowVersion, payload: { versionId: v.id, reviewId: r.id, previousApprovedVersionId: c.approvedVersionId } });
    await indexContent(ctx, row!);
    await notify(ctx.tx, {
      workspaceId: c.workspaceId,
      recipientMembershipIds: recipientsOf(c, r),
      eventType: 'review.approved',
      eventKey: `review.approved:${r.id}`,
      kind: 'general',
      title: `Approved: ${c.title} v${v.versionNo}`,
      excerpt: input.decisionNote?.slice(0, 160) ?? null,
      entityType: 'content_item',
      entityId: c.id,
      projectId: c.projectId,
      actorMembershipId: ctx.actor.membershipId,
      at,
    });
  }
  await audit(ctx, {
    action: nextStep ? 'review.step_approved' : 'review.approved',
    entityType: 'content_item',
    entityId: c.id,
    projectId: c.projectId,
    metadata: { reviewId: r.id, versionId: v.id, versionNo: v.versionNo, step: r.stepKind, nextReviewId },
  });
  await emit(ctx, { type: 'review.decided', entityType: 'review', entityId: r.id, revision: r.rowVersion + 1, payload: { decision: 'approved', contentId: c.id } });
  return r.id;
};

/**
 * Request Changes (§10.1 Review → Changes Requested): a summary plus at least one concrete comment
 * on the version or an explanation (stored as an Issue comment on the version).
 */
export const requestReviewChanges = async (ctx: CommandContext, reviewId: string, input: { versionId: string; summary: string; explanation?: string }) => {
  const { r, c, v } = await beginDecision(ctx, reviewId, input.versionId);
  const [concrete] = await ctx.tx
    .select({ n: sql<number>`count(*)::int` })
    .from(comments)
    .where(and(eq(comments.workspaceId, ctx.actor.workspaceId), eq(comments.targetVersionId, v.id), isNull(comments.deletedAt), isNull(comments.replyToId), sql`${comments.state} <> 'resolved'`));
  const explanation = input.explanation?.trim();
  if (!Number(concrete?.n ?? 0) && !explanation)
    throw fieldError('explanation', 'REQUIRED', 'Add at least one comment on the version or explain what needs to change.');
  const at = ctx.app.clock.now();
  if (explanation)
    await createComment(ctx, { parentType: 'content_version', parentId: v.id, body: explanation, severity: 'issue', targetVersionId: v.id });
  await ctx.tx.update(reviews).set({ status: 'changes_requested', decidedAt: at, ...touch(ctx, reviews) }).where(eq(reviews.id, r.id));
  await ctx.tx.insert(reviewDecisions).values({ ...stamp(ctx), id: newId(), reviewId: r.id, decision: 'changes_requested', summary: input.summary.trim(), decidedByMembershipId: ctx.actor.membershipId!, decidedAt: at, targetVersionId: v.id });
  const [row] = await ctx.tx.update(contentItems).set({ stage: 'changes_requested', ...touch(ctx, contentItems) }).where(eq(contentItems.id, c.id)).returning();
  await recordStageEvent(ctx, c.id, 'review', 'changes_requested', input.summary.trim());
  await audit(ctx, { action: 'review.changes_requested', entityType: 'content_item', entityId: c.id, projectId: c.projectId, reason: input.summary, metadata: { reviewId: r.id, versionId: v.id, versionNo: v.versionNo, step: r.stepKind } });
  await emit(ctx, { type: 'content.changes_requested', entityType: 'content_item', entityId: c.id, revision: row!.rowVersion, payload: { versionId: v.id, reviewId: r.id } });
  await emit(ctx, { type: 'review.decided', entityType: 'review', entityId: r.id, revision: r.rowVersion + 1, payload: { decision: 'changes_requested', contentId: c.id } });
  await indexContent(ctx, row!);
  await notify(ctx.tx, {
    workspaceId: c.workspaceId,
    recipientMembershipIds: recipientsOf(c, r),
    eventType: 'review.changes_requested',
    eventKey: `review.changes_requested:${r.id}`,
    kind: 'general',
    title: `Changes requested: ${c.title} v${v.versionNo}`,
    excerpt: input.summary.slice(0, 200),
    entityType: 'review',
    entityId: r.id,
    projectId: c.projectId,
    actorMembershipId: ctx.actor.membershipId,
    at,
  });
  return r.id;
};

/** Create follow-up tasks as the actor when allowed, otherwise as the system (the revocation must not fail on task rights). */
const followUpContext = (ctx: CommandContext, projectId: string): CommandContext => {
  if (allowed(ctx, 'tasks.create', { projectId }) && allowed(ctx, 'tasks.assign', { projectId })) return ctx;
  return {
    ...ctx,
    actor: {
      kind: 'system',
      userId: null,
      membershipId: null,
      workspaceId: ctx.actor.workspaceId,
      displayName: 'System',
      timezone: ctx.actor.timezone,
      access: {
        workspaceId: ctx.actor.workspaceId,
        userId: '00000000-0000-4000-8000-000000000000',
        membershipId: '00000000-0000-4000-8000-000000000000',
        membershipStatus: 'active',
        accessRevision: 0,
        isOwner: false,
        grants: [{ roleId: 'system', roleKey: 'system', permissions: new Set(['tasks.create', 'tasks.assign', 'tasks.read', 'publications.read', 'accounts.read', 'content.read']), scopeType: 'workspace', scopeId: null }],
        denies: [],
        assignedProjectIds: new Set(),
        assignedAccountIds: new Set(),
        projectDirection: new Map(),
        accountProject: new Map(),
      },
    },
    request: { ...ctx.request, expectedVersion: undefined, source: 'system' },
  };
};

/**
 * Revoke Approval (§10.3, T044): the version stays immutable; its approval is marked revoked so
 * no new placement can use it. Published placements keep their history and get the flag
 * "Approval Revoked After Publication" plus a task to check the external post; scheduled ones get
 * a task to replace or cancel them. Nothing is deleted or unpublished automatically.
 */
export const revokeReviewApproval = async (ctx: CommandContext, reviewId: string, input: { reason: string }) => {
  const r = await loadContentReview(ctx, reviewId, true);
  const c = await lockContent(ctx, r.subjectId);
  await authorizeContentAction(ctx, c, 'content.approve');
  assertVersion(ctx, r);
  const [v] = await ctx.tx.select().from(contentVersions).where(eq(contentVersions.id, r.targetId)).for('update');
  if (!v) throw notFound('Version');
  if (r.status !== 'approved' || !v.approvedAt) throw new AppError('INVALID_STATE', 'Only an approved version can have its approval revoked.');
  if (v.approvalRevokedAt) throw new AppError('INVALID_STATE', 'The approval of this version was already revoked.');
  if (!(await isRevocable(ctx, r))) throw new AppError('INVALID_STATE', 'Revoke the approval from the final review step of this version.');
  const at = ctx.app.clock.now();
  await ctx.tx.insert(reviewDecisions).values({ ...stamp(ctx), id: newId(), reviewId: r.id, decision: 'revoked', summary: input.reason.trim(), decidedByMembershipId: ctx.actor.membershipId!, decidedAt: at, targetVersionId: v.id });
  await ctx.tx.update(reviews).set({ ...touch(ctx, reviews) }).where(eq(reviews.id, r.id));
  await ctx.tx.update(contentVersions).set({ approvalRevokedAt: at, approvalRevokedReason: input.reason.trim(), ...touch(ctx, contentVersions) }).where(eq(contentVersions.id, v.id));
  const patch: Partial<ContentRow> = {};
  if (c.approvedVersionId === v.id) {
    patch.approvedVersionId = null;
    if (c.stage === 'approved') patch.stage = 'changes_requested';
  }
  const [row] = await ctx.tx.update(contentItems).set({ ...patch, ...touch(ctx, contentItems) }).where(eq(contentItems.id, c.id)).returning();
  if (patch.stage) await recordStageEvent(ctx, c.id, 'approved', 'changes_requested', `Approval of version ${v.versionNo} revoked: ${input.reason.trim()}`);
  // Placements of this version.
  const placements = await ctx.tx.select().from(publications).where(and(eq(publications.workspaceId, ctx.actor.workspaceId), eq(publications.contentVersionId, v.id), isNull(publications.deletedAt)));
  const published = placements.filter((p) => p.status === 'published');
  const scheduled = placements.filter((p) => p.status === 'scheduled' || p.status === 'draft');
  if (published.length)
    await ctx.tx
      .update(publications)
      .set({ approvalRevokedAfterPublication: true, updatedAt: at, rowVersion: sql`${publications.rowVersion} + 1` })
      .where(inArray(publications.id, published.map((p) => p.id)));
  const taskCtx = followUpContext(ctx, c.projectId);
  const zone = ctx.actor.timezone;
  const today = at.toISOString().slice(0, 10);
  for (const p of [...published, ...scheduled]) {
    const isPublished = p.status === 'published';
    await createTask(
      taskCtx,
      {
        title: (isPublished ? `Check the external post of “${c.title}”: approval revoked` : `Replace or cancel the placement of “${c.title}”: approval revoked`).slice(0, 200),
        projectId: p.projectId,
        description: `The approval of version ${v.versionNo} was revoked: ${input.reason.trim()}\n${isPublished ? 'The publication stays in the history. Check the post on the platform and decide what to do.' : 'This version can no longer be placed. Choose an approved version or cancel the placement.'}`,
        status: 'ready',
        priority: 'high',
        assigneeMembershipId: p.ownerMembershipId,
        due: { kind: 'date', date: today, timezone: zone },
        accountId: p.accountId,
        publicationId: p.id,
      } as TaskCreateBody,
      { source: 'manual' },
    );
    await emit(ctx, { type: 'publication.approval_revoked', entityType: 'publication', entityId: p.id, payload: { contentId: c.id, versionId: v.id } });
  }
  await audit(ctx, {
    action: 'review.approval_revoked',
    entityType: 'content_item',
    entityId: c.id,
    projectId: c.projectId,
    reason: input.reason,
    metadata: { reviewId: r.id, versionId: v.id, versionNo: v.versionNo, publishedPlacements: published.length, scheduledPlacements: scheduled.length },
  });
  await emit(ctx, { type: 'content.approval_revoked', entityType: 'content_item', entityId: c.id, revision: row!.rowVersion, payload: { versionId: v.id, reviewId: r.id } });
  await emit(ctx, { type: 'review.decided', entityType: 'review', entityId: r.id, payload: { decision: 'revoked', contentId: c.id } });
  await indexContent(ctx, row!);
  await notify(ctx.tx, {
    workspaceId: c.workspaceId,
    recipientMembershipIds: [...recipientsOf(c, r), ...placements.map((p) => p.ownerMembershipId)],
    eventType: 'review.approval_revoked',
    eventKey: `review.approval_revoked:${r.id}:${v.id}`,
    kind: 'general',
    title: `Approval revoked: ${c.title} v${v.versionNo}`,
    excerpt: input.reason.slice(0, 200),
    entityType: 'content_item',
    entityId: c.id,
    projectId: c.projectId,
    actorMembershipId: ctx.actor.membershipId,
    at,
  });
  return r.id;
};

/** Assign Reviewer: an eligible member; the author only when the policy allows self-review. */
export const assignReviewReviewer = async (ctx: CommandContext, reviewId: string, input: { reviewerMembershipId: string }) => {
  const r = await loadContentReview(ctx, reviewId, true);
  const c = await loadContent(ctx, r.subjectId);
  const scope = contentScope(c);
  if (!allowed(ctx, 'content.approve', scope) && !allowed(ctx, 'content.edit', scope)) await authorizeContentAction(ctx, c, 'content.approve');
  assertVersion(ctx, r);
  if (r.status !== 'pending') throw new AppError('INVALID_STATE', 'Only pending reviews can be reassigned.');
  await assertEligibleReviewer(ctx, c, input.reviewerMembershipId);
  if (input.reviewerMembershipId === r.authorMembershipId && !r.policySnapshot.allowSelfReview)
    throw fieldError('reviewerMembershipId', 'SELF_REVIEW', 'The author of the version cannot review it.');
  if ((await earlierStepApprovers(ctx.tx, r)).includes(input.reviewerMembershipId))
    throw fieldError('reviewerMembershipId', 'EARLIER_STEP', 'This member approved an earlier step of the review. Choose another reviewer.');
  if (input.reviewerMembershipId === r.reviewerMembershipId) return r.id;
  await ctx.tx.update(reviews).set({ reviewerMembershipId: input.reviewerMembershipId, ...touch(ctx, reviews) }).where(eq(reviews.id, r.id));
  await audit(ctx, { action: 'review.reviewer_assigned', entityType: 'content_item', entityId: c.id, projectId: c.projectId, metadata: { reviewId: r.id, from: r.reviewerMembershipId, to: input.reviewerMembershipId } });
  await emit(ctx, { type: 'review.assigned', entityType: 'review', entityId: r.id, revision: r.rowVersion + 1 });
  const [v] = await ctx.tx.select({ versionNo: contentVersions.versionNo }).from(contentVersions).where(eq(contentVersions.id, r.targetId));
  await notify(ctx.tx, {
    workspaceId: c.workspaceId,
    recipientMembershipIds: [input.reviewerMembershipId],
    eventType: 'review.requested',
    eventKey: `review.requested:${r.id}:${input.reviewerMembershipId}`,
    kind: 'review_request',
    title: `Review requested: ${c.title} v${v?.versionNo ?? ''}`.trim(),
    entityType: 'review',
    entityId: r.id,
    projectId: c.projectId,
    actorMembershipId: ctx.actor.membershipId,
    at: ctx.app.clock.now(),
  });
  return r.id;
};

/** Pending content reviews a member is assigned to (My Work "Reviewing", responsibilities). */
export const pendingReviewsOf = (db: DbOrTx, workspaceId: string, membershipId: string) =>
  db
    .select({ r: reviews, title: contentItems.title })
    .from(reviews)
    .innerJoin(contentItems, eq(contentItems.id, reviews.subjectId))
    .where(and(eq(reviews.workspaceId, workspaceId), eq(reviews.targetType, 'content_version'), eq(reviews.status, 'pending'), eq(reviews.reviewerMembershipId, membershipId)))
    .orderBy(asc(reviews.submittedAt));
