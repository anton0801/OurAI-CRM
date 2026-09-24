import { and, asc, count, desc, eq, gt, gte, ilike, inArray, isNotNull, isNull, lt, lte, ne, notInArray, or, sql, type SQL } from 'drizzle-orm';
import { hasAnywhere } from '@castlane/authorization';
import {
  assetLinks,
  assets,
  assetVersions,
  auditEvents,
  characters,
  characterVersions,
  comments,
  contentCharacters,
  contentFlagIntervals,
  contentItems,
  contentStageEvents,
  contentVersions,
  episodes,
  projects,
  publications,
  referenceLinks,
  references,
  reviews,
  seasons,
  socialAccounts,
  tasks,
  templates,
  templateVersions,
  workspaces,
  type ContentBrief,
} from '@castlane/database';
import { AppError, assertTransition, clampPageSize, decodeCursor, encodeCursor, newId, notFound } from '@castlane/domain';
import { allowed, requirePermission } from '../core/access';
import { audit, diffFields } from '../core/audit';
import { all, dbOf, type CommandContext, type QueryContext } from '../core/context';
import { emit } from '../core/events';
import { isActiveMember, loadMemberRefs, refOrUnknown } from '../core/members';
import { notify } from '../core/notify';
import { assertVersion, stamp, touch } from '../core/rows';
import { indexSearchDocument, removeSearchDocument } from '../core/search';
import { resolveTags } from '../core/tags';
import { canReadAsset } from '../media/assets';
import { assertCustomFieldsComplete } from '../platform/custom-fields';
import { canReadReference } from '../creative/references';
import { memberCan } from '../work/shared';
import { fileThumbnailUrl, loadVersionFiles, primaryFile } from './files';
import {
  CONTENT_TRANSITIONS,
  MANUAL_TRANSITIONS,
  PIPELINE_STAGES,
  deliverableSlotsFor,
  isContentOverdue,
  isManualTransition,
  manualMoveExplanation,
  reviewPolicyVersion,
  reviewSteps,
  stageLabel,
  transitionRequirements,
  type BriefFields,
  type ContentFormat,
  type ContentStage,
  type ProjectReviewPolicy,
} from './rules';
import {
  assertContentWritable,
  authorizeContentAction,
  authorizeContentRead,
  canOnContent,
  contentScope,
  contentVisibility,
  fieldError,
  loadContent,
  loadProjectOf,
  lockContent,
  readableContent,
  type ContentRow,
} from './scope';

const OPEN_TASK_STATUSES = ['draft', 'backlog', 'ready', 'in_progress', 'in_review'] as const;
const ACTIVE_STAGES_AFTER_READY: ContentStage[] = ['ready', 'production', 'review', 'changes_requested', 'approved'];

// ——— Permissions ———

/** Who may request a manual stage change (§10.1 "Кто"): producers/leads, and the owner for starting production. */
export const canMoveContent = (ctx: QueryContext, c: ContentRow, to: ContentStage): boolean => {
  const scope = contentScope(c);
  if (allowed(ctx, 'content.edit', scope)) return true;
  return to === 'production' && c.ownerMembershipId === ctx.actor.membershipId && allowed(ctx, 'content.upload', scope);
};

export const allowedMovesFor = (ctx: QueryContext, c: ContentRow): ContentStage[] =>
  c.archivedAt ? [] : (MANUAL_TRANSITIONS[c.stage] ?? []).filter((to) => canMoveContent(ctx, c, to));

const policyOf = (p: { reviewPolicy: ProjectReviewPolicy | null }): ProjectReviewPolicy => ({
  contentQualityStep: p.reviewPolicy?.contentQualityStep ?? false,
  releaseApprovalStep: p.reviewPolicy?.releaseApprovalStep ?? true,
  allowSelfReview: p.reviewPolicy?.allowSelfReview ?? false,
  eligibleReviewerMembershipIds: p.reviewPolicy?.eligibleReviewerMembershipIds,
});
export const reviewPolicyOfProject = policyOf;

// ——— Read models ———

type Extras = Awaited<ReturnType<typeof summaryExtras>>;

const summaryExtras = async (ctx: QueryContext | CommandContext, rows: ContentRow[]) => {
  const db = dbOf(ctx);
  const ws = ctx.actor.workspaceId;
  const ids = rows.map((r) => r.id);
  if (!ids.length)
    return { projectNames: new Map<string, string>(), refs: new Map(), accounts: new Map<string, string | null>(), versions: new Map<string, { id: string; versionNo: number; revoked: boolean }>(), pubs: new Map<string, number>(), openTasks: new Map<string, number>(), thumbs: new Map<string, string | null>(), entered: new Map<string, Date>() };
  const versionIds = [...new Set(rows.flatMap((r) => [r.currentVersionId, r.approvedVersionId]).filter((x): x is string => !!x))];
  const accountIds = [...new Set(rows.map((r) => r.accountId).filter((x): x is string => !!x))];
  const [projectRows, refs, accountRows, versionRows, pubRows, taskRows, enteredRows] = await all(ctx, [
    () => db.select({ id: projects.id, name: projects.name }).from(projects).where(and(eq(projects.workspaceId, ws), inArray(projects.id, [...new Set(rows.map((r) => r.projectId))]))),
    () => loadMemberRefs(db, ws, rows.flatMap((r) => [r.ownerMembershipId, r.reviewerMembershipId])),
    () => (accountIds.length ? db.select().from(socialAccounts).where(and(eq(socialAccounts.workspaceId, ws), inArray(socialAccounts.id, accountIds))) : Promise.resolve([] as (typeof socialAccounts.$inferSelect)[])),
    () =>
      versionIds.length
        ? db.select({ id: contentVersions.id, versionNo: contentVersions.versionNo, revokedAt: contentVersions.approvalRevokedAt }).from(contentVersions).where(inArray(contentVersions.id, versionIds))
        : Promise.resolve([] as { id: string; versionNo: number; revokedAt: Date | null }[]),
    () =>
      db
        .select({ id: publications.contentItemId, n: count() })
        .from(publications)
        .where(and(eq(publications.workspaceId, ws), inArray(publications.contentItemId, ids), isNull(publications.deletedAt), ne(publications.status, 'cancelled')))
        .groupBy(publications.contentItemId),
    () =>
      db
        .select({ id: tasks.contentItemId, n: count() })
        .from(tasks)
        .where(and(eq(tasks.workspaceId, ws), inArray(tasks.contentItemId, ids), inArray(tasks.status, [...OPEN_TASK_STATUSES]), isNull(tasks.deletedAt)))
        .groupBy(tasks.contentItemId),
    () =>
      db
        .selectDistinctOn([contentStageEvents.contentItemId], { id: contentStageEvents.contentItemId, at: contentStageEvents.occurredAt })
        .from(contentStageEvents)
        .where(and(eq(contentStageEvents.workspaceId, ws), inArray(contentStageEvents.contentItemId, ids)))
        .orderBy(contentStageEvents.contentItemId, desc(contentStageEvents.occurredAt)),
  ] as const);
  const files = await loadVersionFiles(db, ws, versionIds);
  const thumbs = new Map<string, string | null>();
  for (const r of rows) {
    const vid = r.currentVersionId ?? r.approvedVersionId;
    thumbs.set(r.id, vid ? fileThumbnailUrl(ws, primaryFile(files.filter((f) => f.contentVersionId === vid)), 256) : null);
  }
  return {
    projectNames: new Map(projectRows.map((p) => [p.id, p.name])),
    refs,
    accounts: new Map(
      accountRows.map((a) => [
        a.id,
        allowed(ctx, 'accounts.read', { objectType: 'account', objectId: a.id, accountId: a.id, projectId: a.projectId, ownerMembershipId: a.ownerMembershipId }) ? (a.handle ? `@${a.handle}` : (a.displayName ?? a.canonicalUrl)) : null,
      ]),
    ),
    versions: new Map(versionRows.map((v) => [v.id, { id: v.id, versionNo: v.versionNo, revoked: !!v.revokedAt }])),
    pubs: new Map(pubRows.map((p) => [p.id, Number(p.n)])),
    openTasks: new Map(taskRows.filter((t) => t.id).map((t) => [t.id!, Number(t.n)])),
    thumbs,
    entered: new Map(enteredRows.map((e) => [e.id, e.at])),
  };
};

const toSummary = (ctx: QueryContext | CommandContext, r: ContentRow, x: Extras) => {
  const current = r.currentVersionId ? x.versions.get(r.currentVersionId) : undefined;
  const approved = r.approvedVersionId ? x.versions.get(r.approvedVersionId) : undefined;
  const entered = x.entered.get(r.id);
  return {
    id: r.id,
    title: r.title,
    project: { id: r.projectId, name: x.projectNames.get(r.projectId) ?? 'Unknown project' },
    format: r.format,
    stage: r.stage,
    owner: refOrUnknown(x.refs, r.ownerMembershipId),
    reviewer: refOrUnknown(x.refs, r.reviewerMembershipId),
    dueAt: r.dueAt?.toISOString() ?? null,
    noDeadline: r.noDeadline,
    overdue: isContentOverdue(r.dueAt, r.stage, ctx.app.clock.now()),
    language: r.language,
    tags: r.tags,
    account: r.accountId ? { id: r.accountId, label: x.accounts.get(r.accountId) ?? null } : null,
    episodeId: r.episodeId,
    blocked: r.blockedAt ? { at: r.blockedAt.toISOString(), reason: r.blockedReason } : null,
    paused: r.pausedAt ? { at: r.pausedAt.toISOString(), reason: r.pausedReason } : null,
    needsConsistencyReview: r.needsConsistencyReview,
    currentVersion: current ? { id: current.id, versionNo: current.versionNo } : null,
    approvedVersion: approved ? { id: approved.id, versionNo: approved.versionNo, revoked: approved.revoked } : null,
    newerVersionAwaitingReview: r.stage === 'review' && !!r.approvedVersionId && !!r.currentVersionId && r.currentVersionId !== r.approvedVersionId,
    publicationCount: x.pubs.get(r.id) ?? 0,
    openTasks: x.openTasks.get(r.id) ?? 0,
    thumbnailUrl: x.thumbs.get(r.id) ?? null,
    allowedMoves: allowedMovesFor(ctx, r),
    stageEnteredAt: entered ? entered.toISOString() : null,
    archivedAt: r.archivedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    rowVersion: r.rowVersion,
  };
};

export const contentSummaries = async (ctx: QueryContext | CommandContext, rows: ContentRow[]) => {
  const x = await summaryExtras(ctx, rows);
  return rows.map((r) => toSummary(ctx, r, x));
};

export interface ContentListFilters {
  q?: string;
  projectId?: string;
  accountId?: string;
  episodeId?: string;
  characterId?: string;
  format?: ContentFormat[];
  stage?: ContentStage[];
  ownerMembershipId?: string;
  reviewerMembershipId?: string;
  mine?: boolean;
  dueFrom?: string;
  dueTo?: string;
  overdue?: boolean;
  noDeadline?: boolean;
  blocked?: boolean;
  tag?: string;
  includeArchived?: boolean;
}

const escapeLike = (q: string) => `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;

export const contentListWhere = (ctx: QueryContext, f: ContentListFilters): SQL | undefined => {
  const now = ctx.app.clock.now();
  const me = ctx.actor.membershipId;
  return and(
    eq(contentItems.workspaceId, ctx.actor.workspaceId),
    isNull(contentItems.deletedAt),
    contentVisibility(ctx),
    f.includeArchived || f.stage?.includes('archived') ? undefined : isNull(contentItems.archivedAt),
    f.stage?.length ? inArray(contentItems.stage, f.stage) : undefined,
    f.format?.length ? inArray(contentItems.format, f.format) : undefined,
    f.projectId ? eq(contentItems.projectId, f.projectId) : undefined,
    f.accountId
      ? or(eq(contentItems.accountId, f.accountId), sql`EXISTS (SELECT 1 FROM publications p WHERE p.workspace_id = ${contentItems.workspaceId} AND p.content_item_id = ${contentItems.id} AND p.account_id = ${f.accountId}::uuid)`)
      : undefined,
    f.episodeId
      ? or(eq(contentItems.episodeId, f.episodeId), sql`EXISTS (SELECT 1 FROM episodes e WHERE e.workspace_id = ${contentItems.workspaceId} AND e.id = ${f.episodeId}::uuid AND e.content_item_id = ${contentItems.id})`)
      : undefined,
    f.characterId
      ? sql`EXISTS (SELECT 1 FROM content_characters cc JOIN character_versions cv ON cv.id = cc.character_version_id WHERE cc.content_item_id = ${contentItems.id} AND cv.character_id = ${f.characterId}::uuid)`
      : undefined,
    f.ownerMembershipId ? eq(contentItems.ownerMembershipId, f.ownerMembershipId) : undefined,
    f.reviewerMembershipId ? eq(contentItems.reviewerMembershipId, f.reviewerMembershipId) : undefined,
    f.mine && me ? or(eq(contentItems.ownerMembershipId, me), eq(contentItems.reviewerMembershipId, me)) : undefined,
    f.dueFrom ? gte(contentItems.dueAt, new Date(f.dueFrom)) : undefined,
    f.dueTo ? lte(contentItems.dueAt, new Date(f.dueTo)) : undefined,
    f.overdue ? and(lt(contentItems.dueAt, now), notInArray(contentItems.stage, ['approved', 'archived'])) : undefined,
    f.noDeadline ? and(isNull(contentItems.dueAt)) : undefined,
    f.blocked ? isNotNull(contentItems.blockedAt) : undefined,
    f.tag ? sql`${f.tag} = ANY(${contentItems.tags})` : undefined,
    f.q ? or(ilike(contentItems.title, escapeLike(f.q)), sql`${contentItems.brief} ->> 'summary' ILIKE ${escapeLike(f.q)}`) : undefined,
  );
};

const SORTS = { updatedAt: contentItems.updatedAt, createdAt: contentItems.createdAt, dueAt: contentItems.dueAt, title: contentItems.title, stage: contentItems.stage } as const;

export const listContent = async (ctx: QueryContext, input: ContentListFilters & { cursor?: string; pageSize?: number; sort: keyof typeof SORTS; direction: 'asc' | 'desc' }) => {
  requirePermission(ctx, 'content.read');
  const size = clampPageSize(input.pageSize);
  const col = SORTS[input.sort];
  const asc_ = input.direction === 'asc';
  const c = input.cursor ? decodeCursor(input.cursor) : null;
  let cursorCond: SQL | undefined;
  if (c) {
    const raw = c.v[0];
    const isDate = input.sort === 'updatedAt' || input.sort === 'createdAt' || input.sort === 'dueAt';
    if (raw === null) {
      // Null sort values (no due date) come last in both directions; continue among them by id.
      cursorCond = and(isNull(col), asc_ ? gt(contentItems.id, c.id) : lt(contentItems.id, c.id));
    } else {
      const v = isDate ? new Date(String(raw)) : raw;
      const cmp = asc_ ? gt : lt;
      cursorCond = or(cmp(col, v as never), and(eq(col, v as never), cmp(contentItems.id, c.id)), input.sort === 'dueAt' ? isNull(col) : undefined);
    }
  }
  const rows = await ctx.app.db
    .select()
    .from(contentItems)
    .where(and(contentListWhere(ctx, input), cursorCond))
    .orderBy(asc_ ? sql`${col} ASC NULLS LAST` : sql`${col} DESC NULLS LAST`, asc_ ? asc(contentItems.id) : desc(contentItems.id))
    .limit(size + 1);
  const hasMore = rows.length > size;
  const pageRows = hasMore ? rows.slice(0, size) : rows;
  const last = pageRows[pageRows.length - 1];
  const lastValue = last ? (last[input.sort] instanceof Date ? (last[input.sort] as Date).toISOString() : ((last[input.sort] as string | null) ?? null)) : null;
  return { items: await contentSummaries(ctx, pageRows), hasMore, nextCursor: hasMore && last ? encodeCursor({ v: [lastValue], id: last.id }) : null };
};

const wipLimitsOf = async (ctx: QueryContext | CommandContext) => {
  const [w] = await dbOf(ctx).select({ settings: workspaces.settings }).from(workspaces).where(eq(workspaces.id, ctx.actor.workspaceId));
  return ((w?.settings as { contentWipLimits?: Record<string, number> } | undefined)?.contentWipLimits ?? {}) as Record<string, number>;
};

/** Pipeline board (S22): counts per canonical stage (WIP) plus the first cards of each column. */
export const contentBoard = async (ctx: QueryContext, input: ContentListFilters & { perStage: number }) => {
  requirePermission(ctx, 'content.read');
  const where = contentListWhere(ctx, { ...input, stage: undefined, includeArchived: false });
  const stages = input.stage?.length ? PIPELINE_STAGES.filter((s) => input.stage!.includes(s)) : PIPELINE_STAGES;
  const counts = await ctx.app.db.select({ stage: contentItems.stage, n: count() }).from(contentItems).where(where).groupBy(contentItems.stage);
  const byStage = new Map(counts.map((c) => [c.stage, Number(c.n)]));
  const limits = await wipLimitsOf(ctx);
  const perStageRows: ContentRow[][] = [];
  for (const s of stages)
    perStageRows.push(
      await ctx.app.db
        .select()
        .from(contentItems)
        .where(and(where, eq(contentItems.stage, s)))
        .orderBy(sql`${contentItems.dueAt} ASC NULLS LAST`, desc(contentItems.updatedAt), desc(contentItems.id))
        .limit(input.perStage),
    );
  const summaries = await contentSummaries(ctx, perStageRows.flat());
  const byId = new Map(summaries.map((s) => [s.id, s]));
  return {
    columns: stages.map((s, i) => ({ stage: s, count: byStage.get(s) ?? 0, wipLimit: limits[s] ?? null, items: perStageRows[i]!.map((r) => byId.get(r.id)!) })),
    canEditWipLimits: allowed(ctx, 'workspace.update'),
  };
};

export const setContentWipLimits = async (ctx: CommandContext, input: { limits: Partial<Record<ContentStage, number | null>> }) => {
  if (!allowed(ctx, 'workspace.update')) throw new AppError('FORBIDDEN', 'Only members who manage workspace settings can change work-in-progress limits.');
  const current = await wipLimitsOf(ctx);
  const next: Record<string, number> = { ...current };
  for (const [stage, v] of Object.entries(input.limits)) {
    if (!PIPELINE_STAGES.includes(stage as ContentStage)) continue;
    if (v === null || v === undefined) delete next[stage];
    else next[stage] = v;
  }
  await ctx.tx.execute(
    sql`UPDATE workspaces SET settings = jsonb_set(settings, '{contentWipLimits}', ${JSON.stringify(next)}::jsonb, true), settings_version = settings_version + 1, updated_at = ${ctx.app.clock.now()} WHERE id = ${ctx.actor.workspaceId}`,
  );
  await audit(ctx, { action: 'content.wip_limits_changed', entityType: 'workspace', entityId: ctx.actor.workspaceId, diff: { contentWipLimits: { from: current, to: next } } });
  await emit(ctx, { type: 'content.wip_limits_changed', entityType: 'content_item', entityId: ctx.actor.workspaceId });
  return { limits: next };
};

const readinessInput = async (ctx: QueryContext | CommandContext, c: ContentRow, projectStatus: string) => {
  const [bt] = await dbOf(ctx)
    .select({ n: count() })
    .from(tasks)
    .where(and(eq(tasks.workspaceId, ctx.actor.workspaceId), eq(tasks.contentItemId, c.id), isNotNull(tasks.blockedAt), inArray(tasks.status, [...OPEN_TASK_STATUSES]), isNull(tasks.deletedAt)));
  return {
    stage: c.stage,
    projectStatus,
    ownerMembershipId: c.ownerMembershipId,
    reviewerMembershipId: c.reviewerMembershipId,
    brief: c.brief as BriefFields,
    dueAt: c.dueAt,
    noDeadline: c.noDeadline,
    blocked: !!c.blockedAt,
    paused: !!c.pausedAt,
    blockedTasks: Number(bt?.n ?? 0),
  };
};

const briefView = (b: BriefFields | null | undefined) => ({
  summary: b?.summary ?? null,
  objective: b?.objective ?? null,
  audience: b?.audience ?? null,
  hook: b?.hook ?? null,
  script: b?.script ?? null,
  captionDraft: b?.captionDraft ?? null,
  cta: b?.cta ?? null,
  notes: b?.notes ?? null,
});
export const contentBriefView = briefView;

/** Deliverable slots of a content item: its template's slots, else the format defaults. */
export const contentDeliverableSlots = async (ctx: QueryContext | CommandContext, c: Pick<ContentRow, 'format' | 'templateVersionId'>) => {
  if (!c.templateVersionId) return deliverableSlotsFor(c.format);
  const [v] = await dbOf(ctx).select({ config: templateVersions.config }).from(templateVersions).where(eq(templateVersions.id, c.templateVersionId));
  return deliverableSlotsFor(c.format, v?.config.deliverableSlots);
};

export const getContent = async (ctx: QueryContext | CommandContext, id: string) => {
  const c = await readableContent(ctx, id);
  const db = dbOf(ctx);
  const ws = ctx.actor.workspaceId;
  const scope = contentScope(c);
  const p = await loadProjectOf(ctx, c.projectId);
  const [summary] = await contentSummaries(ctx, [c]);
  const [charRows, refRows, episodeRows, templateRows, dupRows, draftRows, reviewRows, stageRows, flagRows, versionCount, taskCounts, commentCount, slots, readiness] = await all(ctx, [
    () =>
      db
        .select({ characterId: characters.id, name: characters.name, versionId: characterVersions.id, versionNo: characterVersions.versionNo, state: characterVersions.state, approvedVersionId: characters.approvedVersionId, projectId: characters.projectId })
        .from(contentCharacters)
        .innerJoin(characterVersions, eq(characterVersions.id, contentCharacters.characterVersionId))
        .innerJoin(characters, eq(characters.id, characterVersions.characterId))
        .where(and(eq(contentCharacters.workspaceId, ws), eq(contentCharacters.contentItemId, c.id))),
    () =>
      db
        .select({ link: referenceLinks, ref: references })
        .from(referenceLinks)
        .innerJoin(references, eq(references.id, referenceLinks.referenceId))
        .where(and(eq(referenceLinks.workspaceId, ws), eq(referenceLinks.targetType, 'content_item'), eq(referenceLinks.targetId, c.id)))
        .orderBy(asc(referenceLinks.createdAt)),
    () =>
      c.episodeId
        ? db
            .select({ id: episodes.id, number: episodes.number, title: episodes.title, season: seasons.orderNo, projectId: episodes.projectId })
            .from(episodes)
            .innerJoin(seasons, eq(seasons.id, episodes.seasonId))
            .where(and(eq(episodes.workspaceId, ws), eq(episodes.id, c.episodeId)))
        : Promise.resolve([]),
    () =>
      c.templateVersionId
        ? db
            .select({ templateId: templates.id, name: templates.name, versionNo: templateVersions.versionNo, versionId: templateVersions.id })
            .from(templateVersions)
            .innerJoin(templates, eq(templates.id, templateVersions.templateId))
            .where(eq(templateVersions.id, c.templateVersionId))
        : Promise.resolve([]),
    () => (c.duplicatedFromId ? db.select().from(contentItems).where(and(eq(contentItems.workspaceId, ws), eq(contentItems.id, c.duplicatedFromId))) : Promise.resolve([] as ContentRow[])),
    () => db.select({ id: contentVersions.id, versionNo: contentVersions.versionNo }).from(contentVersions).where(and(eq(contentVersions.contentItemId, c.id), isNull(contentVersions.submittedAt))),
    () =>
      db
        .select()
        .from(reviews)
        .where(and(eq(reviews.workspaceId, ws), eq(reviews.subjectId, c.id), eq(reviews.targetType, 'content_version'), eq(reviews.status, 'pending')))
        .orderBy(desc(reviews.stepOrder))
        .limit(1),
    () => db.select().from(contentStageEvents).where(and(eq(contentStageEvents.workspaceId, ws), eq(contentStageEvents.contentItemId, c.id))).orderBy(desc(contentStageEvents.occurredAt)).limit(50),
    () => db.select().from(contentFlagIntervals).where(and(eq(contentFlagIntervals.workspaceId, ws), eq(contentFlagIntervals.contentItemId, c.id))).orderBy(desc(contentFlagIntervals.startedAt)).limit(20),
    () => db.select({ n: count() }).from(contentVersions).where(eq(contentVersions.contentItemId, c.id)),
    () =>
      db
        .select({ open: sql<number>`count(*) FILTER (WHERE ${tasks.status} IN ('draft','backlog','ready','in_progress','in_review'))::int`, total: sql<number>`count(*)::int` })
        .from(tasks)
        .where(and(eq(tasks.workspaceId, ws), eq(tasks.contentItemId, c.id), isNull(tasks.deletedAt))),
    () => db.select({ n: count() }).from(comments).where(and(eq(comments.workspaceId, ws), eq(comments.parentType, 'content_item'), eq(comments.parentId, c.id), isNull(comments.deletedAt))),
    () => contentDeliverableSlots(ctx, c),
    () => readinessInput(ctx, c, p.status),
  ] as const);
  const refs = await loadMemberRefs(db, ws, [...stageRows.map((s) => s.actorMembershipId), ...reviewRows.map((r) => r.reviewerMembershipId)]);
  const visibleRefs = refRows.filter((r) => canReadReference(ctx, r.ref));
  const policy = policyOf(p);
  const dup = dupRows[0];
  const ep = episodeRows[0];
  const tpl = templateRows[0];
  const review = reviewRows[0];
  const writable = !c.archivedAt && c.stage !== 'archived';
  const can = (perm: string) => allowed(ctx, perm, scope);
  const owner = c.ownerMembershipId === ctx.actor.membershipId;
  return {
    ...summary!,
    brief: briefView(c.brief as BriefFields),
    characters: charRows.map((r) => ({ characterId: r.characterId, name: r.name, versionId: r.versionId, versionNo: r.versionNo, state: r.state, isApproved: r.approvedVersionId === r.versionId })),
    references: visibleRefs.map((r) => ({ id: r.ref.id, title: r.ref.title, linkId: r.link.id })),
    hiddenReferenceCount: refRows.length - visibleRefs.length,
    episode: ep ? { id: ep.id, label: allowed(ctx, 'series.read', { projectId: ep.projectId }) ? `S${ep.season} · E${ep.number} ${ep.title}` : null } : null,
    template: tpl ? { templateId: tpl.templateId, templateVersionId: tpl.versionId, name: tpl.name, versionNo: tpl.versionNo } : null,
    duplicatedFrom: c.duplicatedFromId ? { id: c.duplicatedFromId, title: dup && !dup.deletedAt && (await canOnContent(ctx, 'content.read', dup)) ? dup.title : null } : null,
    deliverableSlots: slots,
    draftVersion: draftRows[0] ? { id: draftRows[0].id, versionNo: draftRows[0].versionNo } : null,
    activeReview: review ? { id: review.id, status: review.status, stepKind: review.stepKind, roundNo: review.roundNo, reviewer: refOrUnknown(refs, review.reviewerMembershipId), versionId: review.targetId, rowVersion: review.rowVersion } : null,
    reviewPolicy: { steps: reviewSteps(policy), allowSelfReview: policy.allowSelfReview, version: reviewPolicyVersion(policy) },
    stageHistory: stageRows.map((s) => ({ id: s.id, from: s.fromStage, to: s.toStage, at: s.occurredAt.toISOString(), actor: refOrUnknown(refs, s.actorMembershipId), reason: s.reason })),
    flagHistory: flagRows.map((f) => ({ id: f.id, flag: f.flag, reason: f.reason, startedAt: f.startedAt.toISOString(), endedAt: f.endedAt?.toISOString() ?? null, resolution: f.resolution })),
    nextStages: (MANUAL_TRANSITIONS[c.stage] ?? []).map((stage) => ({ stage, missing: transitionRequirements(stage, readiness) })),
    counts: {
      versions: Number(versionCount[0]?.n ?? 0),
      openTasks: Number(taskCounts[0]?.open ?? 0),
      tasks: Number(taskCounts[0]?.total ?? 0),
      publications: summary!.publicationCount,
      comments: Number(commentCount[0]?.n ?? 0),
    },
    projectStatus: p.status,
    permissions: {
      edit: writable && can('content.edit'),
      transition: writable && allowedMovesFor(ctx, c).length > 0,
      upload: writable && (can('content.upload') || can('content.edit')),
      submit: writable && can('content.submit'),
      approve: can('content.approve'),
      archive: can('content.archive'),
      duplicate: hasAnywhere(ctx.actor.access, 'content.create'),
      applyTemplate: writable && can('content.edit') && allowed(ctx, 'tasks.create', { projectId: c.projectId }),
      flag: writable && (can('content.edit') || (owner && can('content.upload'))),
      comment: writable && (can('content.read') || (await canOnContent(ctx, 'content.read', c))),
      exportPackage: !!c.approvedVersionId && hasAnywhere(ctx.actor.access, 'exports.create'),
      download: hasAnywhere(ctx.actor.access, 'assets.download'),
    },
  };
};

// ——— Commands ———

export const indexContent = async (ctx: CommandContext, c: ContentRow) => {
  if (c.deletedAt) {
    await removeSearchDocument(ctx.tx, c.workspaceId, 'content_item', c.id);
    return;
  }
  const b = (c.brief ?? {}) as BriefFields;
  const vid = c.approvedVersionId ?? c.currentVersionId;
  const thumb = vid ? primaryFile(await loadVersionFiles(ctx.tx, c.workspaceId, [vid])) : null;
  await indexSearchDocument(ctx.tx, {
    workspaceId: c.workspaceId,
    entityType: 'content_item',
    entityId: c.id,
    title: c.title,
    body: [b.summary, b.objective, b.hook, b.audience, c.tags.join(' ')].filter(Boolean).join('\n'),
    projectId: c.projectId,
    accountId: c.accountId,
    permission: 'content.read',
    ownerMembershipId: c.ownerMembershipId,
    assigneeMembershipIds: [c.ownerMembershipId, c.reviewerMembershipId].filter((x): x is string => !!x),
    archived: !!c.archivedAt,
    status: c.stage,
    thumbnailAssetId: thumb && thumb.sensitivity !== 'restricted' && thumb.hasDerivative ? thumb.assetId : null,
    at: ctx.app.clock.now(),
  });
};

export const recordStageEvent = async (ctx: CommandContext, contentId: string, from: ContentStage | null, to: ContentStage, reason?: string | null) => {
  await ctx.tx.insert(contentStageEvents).values({ ...stamp(ctx), id: newId(), contentItemId: contentId, fromStage: from, toStage: to, occurredAt: ctx.app.clock.now(), reason: reason ?? null, actorMembershipId: ctx.actor.membershipId });
};

const assertMember = async (ctx: CommandContext, field: string, membershipId: string, projectId: string, permission: string, label: string) => {
  if (!(await isActiveMember(ctx.tx, ctx.actor.workspaceId, membershipId))) throw fieldError(field, 'INACTIVE', `The ${label} must be an active member.`);
  const r = await memberCan(ctx.app.db, ctx.actor.workspaceId, membershipId, permission, { projectId, assignedMembershipIds: [membershipId], ownerMembershipId: membershipId }, ctx.app.clock.now());
  if (!r.ok) throw fieldError(field, 'NO_ACCESS', `${r.name ?? 'This member'} cannot ${permission === 'content.approve' ? 'approve content' : 'work on content'} in this project.`);
};

const assertAccount = async (ctx: CommandContext, accountId: string, projectId: string) => {
  const [a] = await ctx.tx.select().from(socialAccounts).where(and(eq(socialAccounts.workspaceId, ctx.actor.workspaceId), eq(socialAccounts.id, accountId)));
  if (!a || a.deletedAt || !allowed(ctx, 'accounts.read', { objectType: 'account', objectId: a.id, accountId: a.id, projectId: a.projectId, ownerMembershipId: a.ownerMembershipId }))
    throw fieldError('accountId', 'NOT_FOUND', 'Choose an account you can access.');
  if (a.projectId !== projectId) throw fieldError('accountId', 'OTHER_PROJECT', 'Choose an account of the same project.');
  if (a.archivedAt) throw fieldError('accountId', 'ARCHIVED', 'The account is archived.');
};

const assertEpisode = async (ctx: CommandContext, episodeId: string, projectId: string) => {
  const [e] = await ctx.tx.select().from(episodes).where(and(eq(episodes.workspaceId, ctx.actor.workspaceId), eq(episodes.id, episodeId)));
  if (!e || e.projectId !== projectId) throw fieldError('episodeId', 'NOT_FOUND', 'Choose an episode of the same project.');
};

const setCharacters = async (ctx: CommandContext, contentId: string, projectId: string, versionIds: string[]) => {
  const unique = [...new Set(versionIds)];
  if (unique.length) {
    const rows = await ctx.tx
      .select({ id: characterVersions.id, projectId: characters.projectId, characterId: characters.id })
      .from(characterVersions)
      .innerJoin(characters, eq(characters.id, characterVersions.characterId))
      .where(and(eq(characterVersions.workspaceId, ctx.actor.workspaceId), inArray(characterVersions.id, unique)));
    if (rows.length !== unique.length || rows.some((r) => r.projectId !== projectId)) throw fieldError('characterVersionIds', 'NOT_FOUND', 'Choose character versions of this project.');
    if (new Set(rows.map((r) => r.characterId)).size !== rows.length) throw fieldError('characterVersionIds', 'DUPLICATE', 'Choose one version per character.');
  }
  const existing = await ctx.tx.select().from(contentCharacters).where(eq(contentCharacters.contentItemId, contentId));
  const keep = new Set(unique);
  for (const e of existing) if (!keep.has(e.characterVersionId)) await ctx.tx.delete(contentCharacters).where(eq(contentCharacters.id, e.id));
  const have = new Set(existing.map((e) => e.characterVersionId));
  for (const v of unique) if (!have.has(v)) await ctx.tx.insert(contentCharacters).values({ ...stamp(ctx), id: newId(), contentItemId: contentId, characterVersionId: v });
};

/** Reference links of the content (kind 'link'); the "Use as Idea" origin link is never removed here. */
const setReferences = async (ctx: CommandContext, contentId: string, referenceIds: string[]) => {
  const unique = [...new Set(referenceIds)];
  if (unique.length) {
    const rows = await ctx.tx.select().from(references).where(and(eq(references.workspaceId, ctx.actor.workspaceId), inArray(references.id, unique)));
    if (rows.length !== unique.length || rows.some((r) => !canReadReference(ctx, r))) throw fieldError('referenceIds', 'NOT_FOUND', 'Choose references you can access.');
  }
  const existing = await ctx.tx.select().from(referenceLinks).where(and(eq(referenceLinks.workspaceId, ctx.actor.workspaceId), eq(referenceLinks.targetType, 'content_item'), eq(referenceLinks.targetId, contentId)));
  const keep = new Set(unique);
  for (const e of existing) if (e.kind === 'link' && !keep.has(e.referenceId)) await ctx.tx.delete(referenceLinks).where(eq(referenceLinks.id, e.id));
  const have = new Set(existing.map((e) => e.referenceId));
  for (const r of unique)
    if (!have.has(r)) await ctx.tx.insert(referenceLinks).values({ ...stamp(ctx), id: newId(), referenceId: r, targetType: 'content_item', targetId: contentId, kind: 'link' }).onConflictDoNothing();
};

const notifyAssigned = async (ctx: CommandContext, c: ContentRow, role: 'owner' | 'reviewer', membershipId: string) =>
  notify(ctx.tx, {
    workspaceId: c.workspaceId,
    recipientMembershipIds: [membershipId],
    eventType: role === 'owner' ? 'content.assigned' : 'content.reviewer_assigned',
    eventKey: `content.${role}:${c.id}:${membershipId}:v${c.rowVersion}`,
    kind: 'assignment',
    title: role === 'owner' ? `You own “${c.title}”` : `You review “${c.title}”`,
    entityType: 'content_item',
    entityId: c.id,
    projectId: c.projectId,
    actorMembershipId: ctx.actor.membershipId,
    at: ctx.app.clock.now(),
  });

export interface ContentInput {
  title?: string;
  format?: ContentFormat;
  ownerMembershipId?: string | null;
  reviewerMembershipId?: string | null;
  brief?: BriefFields;
  language?: string | null;
  dueAt?: string | null;
  noDeadline?: boolean;
  tags?: string[];
  accountId?: string | null;
  episodeId?: string | null;
  characterVersionIds?: string[];
  referenceIds?: string[];
}

const cleanBrief = (b: BriefFields | undefined, base: BriefFields = {}): ContentBrief => {
  const out: BriefFields = { ...base };
  for (const [k, v] of Object.entries(b ?? {})) {
    const t = typeof v === 'string' ? v.trim() : v;
    if (t === null || t === undefined || t === '') delete out[k as keyof BriefFields];
    else out[k as keyof BriefFields] = t as string;
  }
  return out as ContentBrief;
};

const assertDeadline = (dueAt: Date | null, noDeadline: boolean) => {
  if (dueAt && noDeadline) throw fieldError('noDeadline', 'CONFLICT', 'Choose either a due date or No Deadline.');
};

/**
 * Create a content item in stage Idea (minimum: Title, Project, Format). Also used by "Use as
 * Idea" on references (T035) and by Duplicate as New Draft (F11).
 */
export const createContent = async (
  ctx: CommandContext,
  input: ContentInput & { title: string; format: ContentFormat; projectId: string; duplicatedFromId?: string | null },
  opts: { originReferenceId?: string } = {},
): Promise<string> => {
  requirePermission(ctx, 'content.create');
  const p = await loadProjectOf(ctx, input.projectId).catch(() => {
    throw fieldError('projectId', 'NOT_FOUND', 'Choose a project you can access.');
  });
  const pScope = { objectType: 'project', objectId: p.id, projectId: p.id, directionId: p.directionId, ownerMembershipId: p.ownerMembershipId };
  if (p.deletedAt || (!allowed(ctx, 'projects.read', pScope) && !allowed(ctx, 'content.read', pScope) && !allowed(ctx, 'content.create', pScope)))
    throw fieldError('projectId', 'NOT_FOUND', 'Choose a project you can access.');
  if (!allowed(ctx, 'content.create', pScope)) throw new AppError('FORBIDDEN', 'You cannot create content in this project.');
  if (p.status === 'archived') throw fieldError('projectId', 'ARCHIVED', 'Archived projects cannot get new content.');
  const policy = policyOf(p);
  const owner = input.ownerMembershipId === undefined ? (ctx.actor.kind === 'user' ? ctx.actor.membershipId : null) : input.ownerMembershipId;
  if (owner) await assertMember(ctx, 'ownerMembershipId', owner, p.id, 'content.read', 'owner');
  if (input.reviewerMembershipId) {
    await assertMember(ctx, 'reviewerMembershipId', input.reviewerMembershipId, p.id, 'content.approve', 'reviewer');
    if (input.reviewerMembershipId === owner && !policy.allowSelfReview) throw fieldError('reviewerMembershipId', 'SELF_REVIEW', 'Choose a reviewer other than the owner.');
  }
  if (input.accountId) await assertAccount(ctx, input.accountId, p.id);
  if (input.episodeId) await assertEpisode(ctx, input.episodeId, p.id);
  const dueAt = input.dueAt ? new Date(input.dueAt) : null;
  assertDeadline(dueAt, !!input.noDeadline);
  const id = newId();
  const [row] = await ctx.tx
    .insert(contentItems)
    .values({
      ...stamp(ctx),
      id,
      projectId: p.id,
      title: input.title.trim(),
      format: input.format,
      stage: 'idea',
      ownerMembershipId: owner ?? null,
      reviewerMembershipId: input.reviewerMembershipId ?? null,
      brief: cleanBrief(input.brief),
      language: input.language?.trim() || p.language || null,
      dueAt,
      noDeadline: !!input.noDeadline,
      tags: await resolveTags(ctx, input.tags),
      accountId: input.accountId ?? null,
      episodeId: input.episodeId ?? null,
      duplicatedFromId: input.duplicatedFromId ?? null,
    })
    .returning();
  await recordStageEvent(ctx, id, null, 'idea', null);
  if (input.characterVersionIds?.length) await setCharacters(ctx, id, p.id, input.characterVersionIds);
  if (input.referenceIds?.length) await setReferences(ctx, id, input.referenceIds.filter((r) => r !== opts.originReferenceId));
  await audit(ctx, {
    action: 'content.created',
    entityType: 'content_item',
    entityId: id,
    projectId: p.id,
    diff: diffFields(null, row!, ['title', 'format', 'ownerMembershipId', 'reviewerMembershipId', 'dueAt', 'noDeadline']),
    metadata: { stage: 'idea', ...(opts.originReferenceId ? { fromReferenceId: opts.originReferenceId } : {}), ...(input.duplicatedFromId ? { duplicatedFromId: input.duplicatedFromId } : {}) },
  });
  await emit(ctx, { type: 'content_item.created', entityType: 'content_item', entityId: id, revision: 1, payload: { projectId: p.id, format: input.format } });
  await indexContent(ctx, row!);
  if (owner && owner !== ctx.actor.membershipId) await notifyAssigned(ctx, row!, 'owner', owner);
  if (row!.reviewerMembershipId && row!.reviewerMembershipId !== ctx.actor.membershipId) await notifyAssigned(ctx, row!, 'reviewer', row!.reviewerMembershipId);
  return id;
};

export const updateContent = async (ctx: CommandContext, id: string, input: ContentInput) => {
  const c = await lockContent(ctx, id);
  await authorizeContentAction(ctx, c, 'content.edit');
  assertVersion(ctx, c);
  assertContentWritable(c);
  const p = await loadProjectOf(ctx, c.projectId);
  const policy = policyOf(p);
  const patch: Partial<ContentRow> = {};
  if (input.title !== undefined) patch.title = input.title.trim();
  if (input.format !== undefined && input.format !== c.format) {
    if (!['idea', 'brief', 'ready'].includes(c.stage) || c.currentVersionId)
      throw fieldError('format', 'LOCKED', 'The format can no longer change once production has started.');
    patch.format = input.format;
  }
  if (input.ownerMembershipId !== undefined && input.ownerMembershipId !== c.ownerMembershipId) {
    if (input.ownerMembershipId) await assertMember(ctx, 'ownerMembershipId', input.ownerMembershipId, c.projectId, 'content.read', 'owner');
    patch.ownerMembershipId = input.ownerMembershipId;
  }
  if (input.reviewerMembershipId !== undefined && input.reviewerMembershipId !== c.reviewerMembershipId) {
    if (input.reviewerMembershipId) await assertMember(ctx, 'reviewerMembershipId', input.reviewerMembershipId, c.projectId, 'content.approve', 'reviewer');
    patch.reviewerMembershipId = input.reviewerMembershipId;
  }
  const owner = patch.ownerMembershipId !== undefined ? patch.ownerMembershipId : c.ownerMembershipId;
  const reviewer = patch.reviewerMembershipId !== undefined ? patch.reviewerMembershipId : c.reviewerMembershipId;
  if (reviewer && reviewer === owner && !policy.allowSelfReview && (patch.ownerMembershipId !== undefined || patch.reviewerMembershipId !== undefined))
    throw fieldError('reviewerMembershipId', 'SELF_REVIEW', 'Choose a reviewer other than the owner.');
  if (input.brief !== undefined) patch.brief = cleanBrief(input.brief, c.brief as BriefFields);
  if (input.language !== undefined) patch.language = input.language?.trim() || null;
  if (input.dueAt !== undefined) patch.dueAt = input.dueAt ? new Date(input.dueAt) : null;
  if (input.noDeadline !== undefined) patch.noDeadline = input.noDeadline;
  if (patch.dueAt && patch.noDeadline === undefined && c.noDeadline) patch.noDeadline = false;
  assertDeadline(patch.dueAt !== undefined ? patch.dueAt : c.dueAt, patch.noDeadline ?? c.noDeadline);
  if (input.tags !== undefined) patch.tags = await resolveTags(ctx, input.tags);
  if (input.accountId !== undefined && input.accountId !== c.accountId) {
    if (input.accountId) await assertAccount(ctx, input.accountId, c.projectId);
    patch.accountId = input.accountId;
  }
  if (input.episodeId !== undefined && input.episodeId !== c.episodeId) {
    if (input.episodeId) await assertEpisode(ctx, input.episodeId, c.projectId);
    patch.episodeId = input.episodeId;
  }
  // Once Ready, the Ready conditions keep holding (owner, reviewer, summary, objective, deadline).
  if (ACTIVE_STAGES_AFTER_READY.includes(c.stage)) {
    const next = { ...c, ...patch } as ContentRow;
    const missing = transitionRequirements('ready', { ...(await readinessInput(ctx, next, p.status)) });
    if (missing.length) throw new AppError('VALIDATION_FAILED', missing[0]!.message, { fieldErrors: missing });
  }
  const [row] = await ctx.tx.update(contentItems).set({ ...patch, ...touch(ctx, contentItems) }).where(eq(contentItems.id, id)).returning();
  if (input.characterVersionIds !== undefined) await setCharacters(ctx, id, c.projectId, input.characterVersionIds);
  if (input.referenceIds !== undefined) await setReferences(ctx, id, input.referenceIds);
  await audit(ctx, {
    action: 'content.updated',
    entityType: 'content_item',
    entityId: id,
    projectId: c.projectId,
    diff: diffFields(c, row!, ['title', 'format', 'ownerMembershipId', 'reviewerMembershipId', 'language', 'dueAt', 'noDeadline', 'tags', 'accountId', 'episodeId']),
    metadata: { briefChanged: input.brief !== undefined, charactersChanged: input.characterVersionIds !== undefined, referencesChanged: input.referenceIds !== undefined },
  });
  await emit(ctx, { type: 'content_item.updated', entityType: 'content_item', entityId: id, revision: row!.rowVersion });
  await indexContent(ctx, row!);
  if (patch.ownerMembershipId && patch.ownerMembershipId !== ctx.actor.membershipId) await notifyAssigned(ctx, row!, 'owner', patch.ownerMembershipId);
  if (patch.reviewerMembershipId && patch.reviewerMembershipId !== ctx.actor.membershipId) await notifyAssigned(ctx, row!, 'reviewer', patch.reviewerMembershipId);
  return id;
};

/**
 * WIP warnings for a stage (a warning, never a hard stop — the card is never lost). The limits are
 * workspace settings; the count is the content the actor can read, like the board's column count, so
 * the warning never reveals how much out-of-scope content exists (T159).
 */
const wipWarnings = async (ctx: CommandContext, stage: ContentStage) => {
  const limits = await wipLimitsOf(ctx);
  const limit = limits[stage];
  if (!limit) return [];
  const [n] = await ctx.tx
    .select({ n: count() })
    .from(contentItems)
    .where(and(eq(contentItems.workspaceId, ctx.actor.workspaceId), eq(contentItems.stage, stage), isNull(contentItems.archivedAt), isNull(contentItems.deletedAt), contentVisibility(ctx)));
  const total = Number(n?.n ?? 0);
  return total > limit ? [`Work in progress in ${stageLabel(stage)} is above the limit (${total} / ${limit}).`] : [];
};

/**
 * Manual stage change (§10.1). Review-driven stages are refused with an explanation (no bypass of
 * review). Each change records a stage event with actor and reason.
 */
export const transitionContent = async (ctx: CommandContext, id: string, input: { targetStage: ContentStage; reason?: string }, opts: { skipVersion?: boolean } = {}) => {
  const c = await lockContent(ctx, id);
  await authorizeContentRead(ctx, c);
  if (!canMoveContent(ctx, c, input.targetStage)) {
    if (!isManualTransition(c.stage, input.targetStage)) throw new AppError('INVALID_STATE', manualMoveExplanation(c.stage, input.targetStage)!, { details: { from: c.stage, to: input.targetStage } });
    throw new AppError('FORBIDDEN', 'You cannot move this content to that stage.');
  }
  if (!opts.skipVersion) assertVersion(ctx, c);
  assertContentWritable(c);
  if (!isManualTransition(c.stage, input.targetStage))
    throw new AppError('INVALID_STATE', manualMoveExplanation(c.stage, input.targetStage)!, { details: { from: c.stage, to: input.targetStage, allowed: MANUAL_TRANSITIONS[c.stage] } });
  assertTransition(CONTENT_TRANSITIONS, c.stage, input.targetStage, 'content item');
  const newRevision = c.stage === 'approved' && input.targetStage === 'production';
  if (newRevision && !input.reason?.trim()) throw fieldError('reason', 'REQUIRED', 'Give a reason for the new revision.');
  const p = await loadProjectOf(ctx, c.projectId);
  const missing = transitionRequirements(input.targetStage, await readinessInput(ctx, c, p.status));
  if (missing.length)
    throw new AppError('INVALID_STATE', `This content cannot move to ${stageLabel(input.targetStage)} yet: ${missing.map((m) => m.message).join(' ')}`, { details: { missing }, fieldErrors: missing });
  await assertCustomFieldsComplete(ctx, 'content_item', id, input.targetStage, c.projectId);
  const at = ctx.app.clock.now();
  const patch: Partial<ContentRow> = { stage: input.targetStage };
  if (input.targetStage === 'ready' && !c.enteredReadyAt) patch.enteredReadyAt = at;
  const [row] = await ctx.tx.update(contentItems).set({ ...patch, ...touch(ctx, contentItems) }).where(eq(contentItems.id, id)).returning();
  await recordStageEvent(ctx, id, c.stage, input.targetStage, input.reason);
  await audit(ctx, {
    action: newRevision ? 'content.new_revision_started' : 'content.stage_changed',
    entityType: 'content_item',
    entityId: id,
    projectId: c.projectId,
    reason: input.reason ?? null,
    diff: { stage: { from: c.stage, to: input.targetStage } },
    metadata: newRevision ? { pinnedApprovedVersionId: c.approvedVersionId } : undefined,
  });
  await emit(ctx, { type: 'content_item.stage_changed', entityType: 'content_item', entityId: id, revision: row!.rowVersion, payload: { from: c.stage, to: input.targetStage } });
  await indexContent(ctx, row!);
  return { id, warnings: await wipWarnings(ctx, input.targetStage) };
};

/** Blocked / Paused: independent flags with reason, actor, start and end (the stage does not change). */
export const setContentFlag = async (ctx: CommandContext, id: string, input: { flag: 'blocked' | 'paused'; on: boolean; reason?: string; resolution?: string }) => {
  const c = await lockContent(ctx, id);
  const scope = contentScope(c);
  if (!allowed(ctx, 'content.edit', scope) && !(c.ownerMembershipId === ctx.actor.membershipId && allowed(ctx, 'content.upload', scope))) await authorizeContentAction(ctx, c, 'content.edit');
  assertVersion(ctx, c);
  assertContentWritable(c);
  const at = ctx.app.clock.now();
  const isOn = input.flag === 'blocked' ? !!c.blockedAt : !!c.pausedAt;
  if (input.on === isOn) throw new AppError('INVALID_STATE', input.on ? `The content is already ${input.flag}.` : `The content is not ${input.flag}.`);
  let patch: Partial<ContentRow>;
  if (input.on) {
    if (!input.reason?.trim()) throw fieldError('reason', 'REQUIRED', `Give a reason for ${input.flag === 'blocked' ? 'blocking' : 'pausing'} this content.`);
    await ctx.tx.insert(contentFlagIntervals).values({ ...stamp(ctx), id: newId(), contentItemId: id, flag: input.flag, reason: input.reason.trim(), startedAt: at });
    patch = input.flag === 'blocked' ? { blockedAt: at, blockedReason: input.reason.trim() } : { pausedAt: at, pausedReason: input.reason.trim() };
  } else {
    await ctx.tx
      .update(contentFlagIntervals)
      .set({ endedAt: at, resolution: input.resolution?.trim() || null, ...touch(ctx, contentFlagIntervals) })
      .where(and(eq(contentFlagIntervals.contentItemId, id), eq(contentFlagIntervals.flag, input.flag), isNull(contentFlagIntervals.endedAt)));
    patch = input.flag === 'blocked' ? { blockedAt: null, blockedReason: null } : { pausedAt: null, pausedReason: null };
  }
  const [row] = await ctx.tx.update(contentItems).set({ ...patch, ...touch(ctx, contentItems) }).where(eq(contentItems.id, id)).returning();
  await audit(ctx, { action: `content.${input.flag}_${input.on ? 'set' : 'cleared'}`, entityType: 'content_item', entityId: id, projectId: c.projectId, reason: input.on ? input.reason : (input.resolution ?? null) });
  await emit(ctx, { type: 'content_item.flag_changed', entityType: 'content_item', entityId: id, revision: row!.rowVersion, payload: { flag: input.flag, on: input.on } });
  return id;
};

/**
 * Duplicate as New Draft (F11, T047): a new Idea that links to its source and copies only the
 * chosen brief fields/links and attachments. Versions, approvals, reviews, publications, metrics,
 * payouts and tasks are never copied.
 */
export const duplicateContent = async (
  ctx: CommandContext,
  id: string,
  input: { targetProjectId: string; title?: string; format?: ContentFormat; copiedFieldSet: ('brief' | 'characters' | 'references' | 'tags' | 'language' | 'account' | 'episode')[]; attachmentAssetVersionIds?: string[] },
) => {
  const src = await readableContent(ctx, id);
  const sameProject = input.targetProjectId === src.projectId;
  const copy = new Set(input.copiedFieldSet);
  for (const f of ['characters', 'account', 'episode'] as const)
    if (copy.has(f) && !sameProject) throw fieldError('copiedFieldSet', 'OTHER_PROJECT', `${f === 'characters' ? 'Characters' : f === 'account' ? 'The account' : 'The episode'} can only be copied within the same project.`);
  const chars = copy.has('characters')
    ? (await ctx.tx.select({ v: contentCharacters.characterVersionId }).from(contentCharacters).where(eq(contentCharacters.contentItemId, src.id))).map((r) => r.v)
    : [];
  const refs = copy.has('references')
    ? (await ctx.tx.select().from(referenceLinks).where(and(eq(referenceLinks.workspaceId, ctx.actor.workspaceId), eq(referenceLinks.targetType, 'content_item'), eq(referenceLinks.targetId, src.id)))).map((r) => r.referenceId)
    : [];
  const readableRefs: string[] = [];
  if (refs.length) for (const r of await ctx.tx.select().from(references).where(inArray(references.id, refs))) if (canReadReference(ctx, r)) readableRefs.push(r.id);
  const newId_ = await createContent(ctx, {
    projectId: input.targetProjectId,
    title: (input.title ?? `${src.title} (copy)`).slice(0, 200),
    format: input.format ?? src.format,
    brief: copy.has('brief') ? (src.brief as BriefFields) : undefined,
    tags: copy.has('tags') ? src.tags : undefined,
    language: copy.has('language') ? src.language : undefined,
    accountId: copy.has('account') ? src.accountId : undefined,
    episodeId: copy.has('episode') ? src.episodeId : undefined,
    characterVersionIds: chars,
    referenceIds: readableRefs,
    duplicatedFromId: src.id,
  });
  // Selected attachments: file versions of the source's versions or attachments, linked to the new draft only.
  const chosen = [...new Set(input.attachmentAssetVersionIds ?? [])];
  if (chosen.length) {
    const fromVersions = await ctx.tx
      .select({ assetVersionId: assetVersions.id, assetId: assetVersions.assetId })
      .from(assetVersions)
      .where(
        and(
          eq(assetVersions.workspaceId, ctx.actor.workspaceId),
          inArray(assetVersions.id, chosen),
          sql`(EXISTS (SELECT 1 FROM content_version_assets cva JOIN content_versions cv ON cv.id = cva.content_version_id WHERE cva.asset_version_id = ${assetVersions.id} AND cv.content_item_id = ${src.id})
            OR EXISTS (SELECT 1 FROM asset_links al WHERE al.asset_id = ${assetVersions.assetId} AND al.entity_type = 'content_item' AND al.entity_id = ${src.id} AND al.removed_at IS NULL))`,
        ),
      );
    if (fromVersions.length !== chosen.length) throw fieldError('attachmentAssetVersionIds', 'NOT_FOUND', 'Choose attachments of the source content.');
    for (const f of fromVersions) {
      const [a] = await ctx.tx.select().from(assets).where(eq(assets.id, f.assetId));
      if (!a || !(await canReadAsset(ctx, a))) throw fieldError('attachmentAssetVersionIds', 'NOT_FOUND', 'Choose attachments you can access.');
      await ctx.tx.insert(assetLinks).values({ ...stamp(ctx), id: newId(), assetId: f.assetId, assetVersionId: f.assetVersionId, entityType: 'content_item', entityId: newId_, role: 'attachment', projectId: input.targetProjectId });
    }
  }
  await audit(ctx, { action: 'content.duplicated', entityType: 'content_item', entityId: src.id, projectId: src.projectId, metadata: { newContentId: newId_, copied: [...copy], attachments: chosen.length } });
  return newId_;
};

/** Meaningful history of one content item (§33.3); sensitive audit rows are excluded. */
export const contentActivity = async (ctx: QueryContext, id: string, input: { cursor?: string; pageSize?: number }) => {
  await readableContent(ctx, id);
  const size = clampPageSize(input.pageSize ?? 30);
  const c = input.cursor ? decodeCursor(input.cursor) : null;
  const rows = await ctx.app.db
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.workspaceId, ctx.actor.workspaceId),
        eq(auditEvents.entityType, 'content_item'),
        eq(auditEvents.entityId, id),
        eq(auditEvents.sensitivity, 'normal'),
        c ? or(lt(auditEvents.occurredAt, new Date(String(c.v[0]))), and(eq(auditEvents.occurredAt, new Date(String(c.v[0]))), lt(auditEvents.id, c.id))) : undefined,
      ),
    )
    .orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id))
    .limit(size + 1);
  const hasMore = rows.length > size;
  const items = (hasMore ? rows.slice(0, size) : rows).map((r) => ({
    id: r.id,
    action: r.action,
    actorName: r.actorDisplay,
    occurredAt: r.occurredAt.toISOString(),
    reason: r.reason,
    metadata: (r.metadata as Record<string, unknown> | null) ?? null,
    changes: Object.entries(r.diff ?? {}).map(([field, v]) => ({ field, from: v.from, to: v.to })),
  }));
  const last = items[items.length - 1];
  return { items, hasMore, nextCursor: hasMore && last ? encodeCursor({ v: [last.occurredAt], id: last.id }) : null };
};

/** Content of one episode (EPISODE_PANELS): linked items and the episode's main content item. */
export const episodeContent = async (ctx: QueryContext, episodeId: string) => {
  requirePermission(ctx, 'content.read');
  const [e] = await ctx.app.db.select().from(episodes).where(and(eq(episodes.workspaceId, ctx.actor.workspaceId), eq(episodes.id, episodeId)));
  if (!e || !(allowed(ctx, 'series.read', { projectId: e.projectId }) || allowed(ctx, 'content.read', { projectId: e.projectId }))) throw notFound('Episode');
  const base = and(
    eq(contentItems.workspaceId, ctx.actor.workspaceId),
    isNull(contentItems.deletedAt),
    or(eq(contentItems.episodeId, episodeId), e.contentItemId ? eq(contentItems.id, e.contentItemId) : undefined),
  );
  const [total] = await ctx.app.db.select({ n: count() }).from(contentItems).where(base);
  const rows = await ctx.app.db.select().from(contentItems).where(and(base, contentVisibility(ctx))).orderBy(asc(contentItems.createdAt)).limit(200);
  return { items: await contentSummaries(ctx, rows), hiddenCount: Math.max(0, Number(total?.n ?? 0) - rows.length), approvedCount: rows.filter((r) => !!r.approvedVersionId).length };
};

