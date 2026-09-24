import { and, asc, count, desc, eq, gte, ilike, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import { hasAnywhere } from '@castlane/authorization';
import {
  assetLinks,
  assets,
  campaigns,
  contentItems,
  contentVersions,
  experimentPublications,
  experimentVariants,
  experiments,
  metricCheckpoints,
  projects,
  publicationCorrections,
  publicationPlanRevisions,
  publications,
  socialAccounts,
  tasks,
  trackingLinks,
} from '@castlane/database';
import { AppError, notFound } from '@castlane/domain';
import { allowed, requirePermission, whereAll } from '../core/access';
import { all, dbOf, type CommandContext, type QueryContext } from '../core/context';
import { loadMemberRefs, refOrUnknown } from '../core/members';
import { accountLabel } from '../accounts/accounts';
import { entityActivity, finishPage, keysetWhere, pageSizeOf } from '../accounts/helpers';
import { loadUserMemberRefs } from '../media/assets';
import { canReadTask } from '../work/shared';
import { canCampaign, campaignProjectMap, canPublication, experimentScope, loadPublicationRow, publicationScope, publicationVisibility, type PublicationRowDb } from './scope';
import { checkpointLabel } from './logic';

type Ctx = QueryContext | CommandContext;

const likeText = (q: string) => `%${q.trim().replace(/[%_\\]/g, (m) => `\\${m}`)}%`;

/** Batch-load everything a publication row shows (titles, versions, accounts, projects, campaigns, owners, thumbnails). */
const rowExtras = async (ctx: Ctx, rows: PublicationRowDb[]) => {
  const db = dbOf(ctx);
  const ws = ctx.actor.workspaceId;
  const ids = rows.map((r) => r.id);
  const uniq = (xs: (string | null)[]) => [...new Set(xs.filter((x): x is string => !!x))];
  const contentIds = uniq(rows.map((r) => r.contentItemId));
  const versionIds = uniq(rows.map((r) => r.contentVersionId));
  const accountIds = uniq(rows.map((r) => r.accountId));
  const projectIds = uniq(rows.map((r) => r.projectId));
  const campaignIds = uniq(rows.map((r) => r.primaryCampaignId));
  const [content, versions, accts, projs, camps, refs, thumbs] = await all(ctx, [
    () => (contentIds.length ? db.select({ id: contentItems.id, title: contentItems.title, format: contentItems.format }).from(contentItems).where(and(eq(contentItems.workspaceId, ws), inArray(contentItems.id, contentIds))) : Promise.resolve([])),
    () =>
      versionIds.length
        ? db
            .select({ id: contentVersions.id, versionNo: contentVersions.versionNo, approvedAt: contentVersions.approvedAt, revokedAt: contentVersions.approvalRevokedAt })
            .from(contentVersions)
            .where(and(eq(contentVersions.workspaceId, ws), inArray(contentVersions.id, versionIds)))
        : Promise.resolve([]),
    () => (accountIds.length ? db.select().from(socialAccounts).where(and(eq(socialAccounts.workspaceId, ws), inArray(socialAccounts.id, accountIds))) : Promise.resolve([])),
    () => (projectIds.length ? db.select({ id: projects.id, name: projects.name }).from(projects).where(and(eq(projects.workspaceId, ws), inArray(projects.id, projectIds))) : Promise.resolve([])),
    () =>
      campaignIds.length
        ? db.select({ id: campaigns.id, name: campaigns.name, ownerMembershipId: campaigns.ownerMembershipId }).from(campaigns).where(and(eq(campaigns.workspaceId, ws), inArray(campaigns.id, campaignIds)))
        : Promise.resolve([]),
    () => loadMemberRefs(db, ws, rows.map((r) => r.ownerMembershipId)),
    () =>
      ids.length
        ? db
            .selectDistinctOn([assetLinks.entityId], { publicationId: assetLinks.entityId, assetId: assets.id })
            .from(assetLinks)
            .innerJoin(assets, and(eq(assets.workspaceId, assetLinks.workspaceId), eq(assets.id, assetLinks.assetId)))
            .where(
              and(
                eq(assetLinks.workspaceId, ws),
                eq(assetLinks.entityType, 'publication'),
                inArray(assetLinks.entityId, ids),
                isNull(assetLinks.removedAt),
                eq(assets.sensitivity, 'normal'),
                inArray(assets.kind, ['image', 'video']),
                isNull(assets.deletedAt),
              ),
            )
            .orderBy(assetLinks.entityId, asc(assetLinks.createdAt))
        : Promise.resolve([]),
  ] as const);
  const campaignProjects = await campaignProjectMap(db, ws, camps.map((c) => c.id));
  return {
    content: new Map(content.map((c) => [c.id, c])),
    versions: new Map(versions.map((v) => [v.id, v])),
    accounts: new Map(accts.map((a) => [a.id, a])),
    projects: new Map(projs.map((p) => [p.id, p.name])),
    // Campaign names only when the member may read the campaign.
    campaigns: new Map(camps.filter((c) => canCampaign(ctx, 'campaigns.read', c, campaignProjects.get(c.id) ?? [])).map((c) => [c.id, c.name])),
    refs,
    thumbs: new Map(thumbs.map((t) => [t.publicationId, t.assetId])),
  };
};

export const toPublicationRows = async (ctx: Ctx, rows: PublicationRowDb[]) => {
  if (!rows.length) return [];
  const x = await rowExtras(ctx, rows);
  const now = ctx.app.clock.now();
  const ws = ctx.actor.workspaceId;
  return rows.map((r) => {
    const a = x.accounts.get(r.accountId);
    const v = r.contentVersionId ? x.versions.get(r.contentVersionId) : undefined;
    const thumb = x.thumbs.get(r.id);
    const campaignName = r.primaryCampaignId ? x.campaigns.get(r.primaryCampaignId) : undefined;
    return {
      id: r.id,
      title: x.content.get(r.contentItemId)?.title ?? 'Content',
      contentItemId: r.contentItemId,
      contentVersion: v ? { id: v.id, versionNo: v.versionNo, approved: !!v.approvedAt && !v.revokedAt, approvalRevoked: !!v.revokedAt } : null,
      format: r.format ?? x.content.get(r.contentItemId)?.format ?? null,
      account: {
        id: r.accountId,
        label: a ? accountLabel(a) : 'Account',
        platform: a?.platform ?? 'other',
        status: a?.status ?? 'archived',
        url: a?.canonicalUrl ?? '',
      },
      project: { id: r.projectId, name: x.projects.get(r.projectId) ?? 'Project' },
      owner: refOrUnknown(x.refs, r.ownerMembershipId)!,
      status: r.status,
      availability: r.availability,
      scheduledAt: r.scheduledAt?.toISOString() ?? null,
      scheduleTimezone: r.scheduleTimezone,
      actualPublishedAt: r.actualPublishedAt?.toISOString() ?? null,
      externalPostUrl: r.externalPostUrl,
      urlMissing: r.status === 'published' && !r.externalPostUrl,
      awaitingConfirmation: r.status === 'scheduled' && !!r.scheduledAt && r.scheduledAt.getTime() < now.getTime(),
      historicalEntry: r.historicalEntry,
      primaryCampaign: r.primaryCampaignId && campaignName ? { id: r.primaryCampaignId, name: campaignName } : null,
      thumbnailUrl: thumb ? `/api/v1/workspaces/${ws}/assets/${thumb}/thumbnail?size=128` : null,
      approvalRevokedAfterPublication: r.approvalRevokedAfterPublication,
      archivedAt: r.archivedAt?.toISOString() ?? null,
      updatedAt: r.updatedAt.toISOString(),
      rowVersion: r.rowVersion,
    };
  });
};

export type PublicationRowView = Awaited<ReturnType<typeof toPublicationRows>>[number];

// ——— List ———

export interface ListPublicationsInput {
  cursor?: string;
  pageSize?: number;
  q?: string;
  projectId?: string;
  accountId?: string;
  campaignId?: string;
  contentItemId?: string;
  episodeId?: string;
  dealId?: string;
  ownerMembershipId?: string;
  status?: PublicationRowDb['status'][];
  availability?: PublicationRowDb['availability'][];
  platform?: string[];
  from?: string;
  to?: string;
  includeArchived?: boolean;
  sort: 'when' | 'updatedAt';
  direction: 'asc' | 'desc';
}

const whenExpr = sql`coalesce(${publications.actualPublishedAt}, ${publications.scheduledAt}, ${publications.createdAt})`;

/** SQL filters shared by the list, calendar and exports (scope included). */
export const publicationFilterSql = (ctx: QueryContext, input: Omit<ListPublicationsInput, 'cursor' | 'pageSize' | 'sort' | 'direction'>): SQL | undefined =>
  whereAll(
    eq(publications.workspaceId, ctx.actor.workspaceId),
    isNull(publications.deletedAt),
    publicationVisibility(ctx),
    input.includeArchived ? undefined : isNull(publications.archivedAt),
    input.projectId ? eq(publications.projectId, input.projectId) : undefined,
    input.accountId ? eq(publications.accountId, input.accountId) : undefined,
    input.campaignId ? eq(publications.primaryCampaignId, input.campaignId) : undefined,
    input.contentItemId ? eq(publications.contentItemId, input.contentItemId) : undefined,
    input.ownerMembershipId ? eq(publications.ownerMembershipId, input.ownerMembershipId) : undefined,
    input.status?.length ? inArray(publications.status, input.status) : undefined,
    input.availability?.length ? inArray(publications.availability, input.availability) : undefined,
    input.episodeId ? sql`EXISTS (SELECT 1 FROM content_items ci WHERE ci.id = ${publications.contentItemId} AND ci.episode_id = ${input.episodeId}::uuid)` : undefined,
    input.dealId
      ? sql`(${publications.contentItemId} IN (SELECT dl.content_item_id FROM deliverables dl WHERE dl.workspace_id = ${ctx.actor.workspaceId}::uuid AND dl.deal_id = ${input.dealId}::uuid AND dl.content_item_id IS NOT NULL)
          OR ${publications.primaryCampaignId} IN (SELECT d.campaign_id FROM deals d WHERE d.workspace_id = ${ctx.actor.workspaceId}::uuid AND d.id = ${input.dealId}::uuid AND d.campaign_id IS NOT NULL))`
      : undefined,
    input.platform?.length
      ? sql`EXISTS (SELECT 1 FROM social_accounts sa WHERE sa.id = ${publications.accountId} AND sa.platform IN (${sql.join(input.platform.map((p) => sql`${p}`), sql`, `)}))`
      : undefined,
    input.from ? gte(whenExpr, new Date(input.from)) : undefined,
    input.to ? lt(whenExpr, new Date(input.to)) : undefined,
    input.q
      ? or(
          ilike(publications.caption, likeText(input.q)),
          ilike(publications.externalPostUrl, likeText(input.q)),
          sql`EXISTS (SELECT 1 FROM content_items ci WHERE ci.id = ${publications.contentItemId} AND ci.title ILIKE ${likeText(input.q)})`,
        )
      : undefined,
  );

export const listPublications = async (ctx: QueryContext, input: ListPublicationsInput) => {
  requirePermission(ctx, 'publications.read');
  const size = pageSizeOf(input.pageSize);
  const expr = input.sort === 'updatedAt' ? sql`${publications.updatedAt}` : whenExpr;
  const dir = input.direction === 'asc' ? asc : desc;
  const rows = await dbOf(ctx)
    .select()
    .from(publications)
    .where(whereAll(publicationFilterSql(ctx, input), keysetWhere(expr, publications.id, input.direction, input.cursor, 'timestamp')))
    .orderBy(dir(expr), dir(publications.id))
    .limit(size + 1);
  return finishPage(
    rows,
    size,
    (r) => (input.sort === 'updatedAt' ? r.updatedAt : (r.actualPublishedAt ?? r.scheduledAt ?? r.createdAt)).toISOString(),
    (page) => toPublicationRows(ctx, page),
  );
};

/** My Work "Publications Due": the member's scheduled placements (next 7 days + awaiting confirmation). */
export const publicationsDue = async (ctx: QueryContext, input: { limit: number }) => {
  const me = ctx.actor.membershipId;
  if (!me || !hasAnywhere(ctx.actor.access, 'publications.read')) return { items: [], total: 0, awaitingConfirmation: 0, canRead: false };
  const now = ctx.app.clock.now();
  const horizon = new Date(now.getTime() + 7 * 86_400_000);
  const where = whereAll(
    eq(publications.workspaceId, ctx.actor.workspaceId),
    isNull(publications.deletedAt),
    isNull(publications.archivedAt),
    publicationVisibility(ctx),
    eq(publications.ownerMembershipId, me),
    eq(publications.status, 'scheduled'),
    lt(publications.scheduledAt, horizon),
  );
  const db = dbOf(ctx);
  const [rows, [total], [late]] = await all(ctx, [
    () => db.select().from(publications).where(where).orderBy(asc(publications.scheduledAt), asc(publications.id)).limit(input.limit),
    () => db.select({ n: count() }).from(publications).where(where),
    () => db.select({ n: count() }).from(publications).where(and(where, lt(publications.scheduledAt, now))),
  ] as const);
  return { items: await toPublicationRows(ctx, rows), total: Number(total?.n ?? 0), awaitingConfirmation: Number(late?.n ?? 0), canRead: true };
};

// ——— Detail ———

const ACTIONS: Record<PublicationRowDb['status'], ('schedule' | 'reschedule' | 'markPublished' | 'fail' | 'cancel' | 'retry' | 'correct' | 'setAvailability')[]> = {
  draft: ['schedule'],
  scheduled: ['reschedule', 'markPublished', 'fail', 'cancel'],
  failed: ['retry', 'cancel'],
  published: ['correct', 'setAvailability'],
  cancelled: [],
};

export const getPublication = async (ctx: Ctx, id: string) => {
  const p = await loadPublicationRow(ctx, id);
  const scope = publicationScope(p);
  if (!allowed(ctx, 'publications.read', scope)) throw notFound('Publication');
  const db = dbOf(ctx);
  const ws = ctx.actor.workspaceId;
  const [[row], checkpoints, revisions, corrections, links, exps, linkedTasks, [account]] = await all(ctx, [
    () => toPublicationRows(ctx, [p]),
    () => db.select().from(metricCheckpoints).where(and(eq(metricCheckpoints.workspaceId, ws), eq(metricCheckpoints.publicationId, id))).orderBy(asc(metricCheckpoints.expectedAt)),
    () => db.select().from(publicationPlanRevisions).where(and(eq(publicationPlanRevisions.workspaceId, ws), eq(publicationPlanRevisions.publicationId, id))).orderBy(desc(publicationPlanRevisions.changedAt)),
    () => db.select().from(publicationCorrections).where(and(eq(publicationCorrections.workspaceId, ws), eq(publicationCorrections.publicationId, id))).orderBy(desc(publicationCorrections.createdAt)),
    () =>
      db
        .select({ id: trackingLinks.id, label: trackingLinks.label, builtUrl: trackingLinks.builtUrl, campaignId: trackingLinks.campaignId, owner: campaigns.ownerMembershipId })
        .from(trackingLinks)
        .innerJoin(campaigns, and(eq(campaigns.workspaceId, trackingLinks.workspaceId), eq(campaigns.id, trackingLinks.campaignId)))
        .where(and(eq(trackingLinks.workspaceId, ws), eq(trackingLinks.publicationId, id), isNull(trackingLinks.archivedAt))),
    () =>
      db
        .select({ e: experiments, variantName: experimentVariants.name, segment: experimentPublications.segment })
        .from(experimentPublications)
        .innerJoin(experiments, and(eq(experiments.workspaceId, experimentPublications.workspaceId), eq(experiments.id, experimentPublications.experimentId)))
        .innerJoin(experimentVariants, and(eq(experimentVariants.workspaceId, experimentPublications.workspaceId), eq(experimentVariants.id, experimentPublications.variantId)))
        .where(and(eq(experimentPublications.workspaceId, ws), eq(experimentPublications.publicationId, id))),
    () => db.select().from(tasks).where(and(eq(tasks.workspaceId, ws), eq(tasks.publicationId, id), isNull(tasks.deletedAt))).orderBy(asc(tasks.createdAt)),
    () => db.select({ captionMaxLength: socialAccounts.captionMaxLength }).from(socialAccounts).where(and(eq(socialAccounts.workspaceId, ws), eq(socialAccounts.id, p.accountId))),
  ] as const);
  const linkProjects = await campaignProjectMap(db, ws, [...new Set(links.map((l) => l.campaignId))]);
  const visibleTasks = linkedTasks.filter((t) => canReadTask(ctx, t));
  const refs = await loadMemberRefs(db, ws, [...checkpoints.map((c) => c.assigneeMembershipId), ...visibleTasks.map((t) => t.assigneeMembershipId), p.confirmedByMembershipId]);
  const authors = await loadUserMemberRefs(db, ws, [...revisions.map((r) => r.createdBy), ...corrections.map((c) => c.createdBy)]);
  const writable = allowed(ctx, 'publications.write', scope);
  const active = !p.archivedAt;
  return {
    ...row!,
    caption: p.caption,
    cta: p.cta,
    destinationUrl: p.destinationUrl,
    descriptiveTags: p.descriptiveTags,
    originalScheduledAt: p.originalScheduledAt?.toISOString() ?? null,
    noUrlReason: p.noUrlReason,
    sourceNote: p.sourceNote,
    failureReason: p.failureReason,
    cancelReason: p.cancelReason,
    overrideReason: p.overrideReason,
    availabilityChangedAt: p.availabilityChangedAt?.toISOString() ?? null,
    availabilityReason: p.availabilityReason,
    confirmedBy: refOrUnknown(refs, p.confirmedByMembershipId),
    captionLimit: account?.captionMaxLength ?? null,
    checkpoints: checkpoints.map((c) => ({
      id: c.id,
      key: c.checkpointKey,
      label: p.actualPublishedAt ? checkpointLabel(Math.round((c.expectedAt.getTime() - p.actualPublishedAt.getTime()) / 3_600_000)) : c.checkpointKey,
      policyVersion: c.policyVersion,
      expectedAt: c.expectedAt.toISOString(),
      windowStart: c.windowStart.toISOString(),
      windowEnd: c.windowEnd.toISOString(),
      state: c.state,
      timing: c.timing,
      assignee: refOrUnknown(refs, c.assigneeMembershipId),
      missingReason: c.missingReason,
      cancelledReason: c.cancelledReason,
      completedObservationId: c.completedObservationId,
    })),
    planRevisions: revisions.map((r) => ({
      id: r.id,
      fromScheduledAt: r.fromScheduledAt?.toISOString() ?? null,
      toScheduledAt: r.toScheduledAt?.toISOString() ?? null,
      reason: r.reason,
      changedAt: r.changedAt.toISOString(),
      actorName: r.createdBy ? (authors.get(r.createdBy)?.displayName ?? null) : 'System',
    })),
    corrections: corrections.map((c) => ({
      id: c.id,
      before: c.before,
      after: c.after,
      reason: c.reason,
      createdAt: c.createdAt.toISOString(),
      actorName: c.createdBy ? (authors.get(c.createdBy)?.displayName ?? null) : 'System',
    })),
    trackingLinks: links
      .filter((l) => canCampaign(ctx, 'campaigns.read', { id: l.campaignId, ownerMembershipId: l.owner }, linkProjects.get(l.campaignId) ?? []))
      .map((l) => ({ id: l.id, label: l.label, builtUrl: l.builtUrl, campaignId: l.campaignId })),
    experiments: exps.filter((e) => allowed(ctx, 'experiments.read', experimentScope(e.e))).map((e) => ({ id: e.e.id, hypothesis: e.e.hypothesis, variantName: e.variantName, segment: e.segment })),
    tasks: visibleTasks.map((t) => ({ id: t.id, title: t.title, status: t.status, dueAt: t.dueAt?.toISOString() ?? null, assignee: refOrUnknown(refs, t.assigneeMembershipId) })),
    allowedActions: active ? ACTIONS[p.status] : [],
    permissions: {
      update: writable && active && ['draft', 'scheduled', 'failed'].includes(p.status),
      schedule: writable && active,
      confirm: allowed(ctx, 'publications.confirm', scope) && active,
      correct: allowed(ctx, 'publications.correct', scope) && active && p.status === 'published',
      overrideAccountStatus: allowed(ctx, 'publications.correct', scope),
      archive: writable && active && ['published', 'failed', 'cancelled', 'draft'].includes(p.status),
      addMetrics: p.status === 'published' && allowed(ctx, 'metrics.write', scope),
    },
  };
};

export type PublicationDetailView = Awaited<ReturnType<typeof getPublication>>;

export const publicationActivity = async (ctx: QueryContext, id: string, input: { cursor?: string; pageSize?: number }) => {
  const p = await loadPublicationRow(ctx, id);
  if (!canPublication(ctx, 'publications.read', p)) throw notFound('Publication');
  const page = await entityActivity(ctx, ['publication'], id, input);
  return { ...page, items: page.items.map((i) => ({ id: i.id, action: i.action, actorName: i.actorName, occurredAt: i.occurredAt, reason: i.reason, changes: i.changes })) };
};

// ——— Pickers for the editor ———

/** The account the actor wants to plan on, with the publications.write check (404 when not even readable). */
export const accountForPlanning = async (ctx: Ctx, accountId: string, field = 'accountId') => {
  const [a] = await dbOf(ctx).select().from(socialAccounts).where(and(eq(socialAccounts.workspaceId, ctx.actor.workspaceId), eq(socialAccounts.id, accountId)));
  const scope = a ? { objectType: 'account', objectId: a.id, accountId: a.id, projectId: a.projectId, ownerMembershipId: a.ownerMembershipId } : null;
  if (!a || a.deletedAt || !scope) throw new AppError('VALIDATION_FAILED', 'Choose an account you can plan on.', { fieldErrors: [{ field, code: 'NOT_FOUND', message: 'Choose an account you can plan on.' }] });
  if (!allowed(ctx, 'publications.write', scope)) {
    if (allowed(ctx, 'publications.read', scope) || allowed(ctx, 'accounts.read', scope)) throw new AppError('FORBIDDEN', 'You cannot plan publications on this account.');
    throw new AppError('VALIDATION_FAILED', 'Choose an account you can plan on.', { fieldErrors: [{ field, code: 'NOT_FOUND', message: 'Choose an account you can plan on.' }] });
  }
  return a;
};

export const publicationContentOptions = async (ctx: QueryContext, input: { accountId: string; q?: string; ids?: string[]; limit: number }) => {
  requirePermission(ctx, 'publications.write');
  const a = await accountForPlanning(ctx, input.accountId);
  const db = dbOf(ctx);
  const rows = await db
    .select()
    .from(contentItems)
    .where(
      and(
        eq(contentItems.workspaceId, ctx.actor.workspaceId),
        eq(contentItems.projectId, a.projectId),
        isNull(contentItems.deletedAt),
        input.ids?.length ? inArray(contentItems.id, input.ids) : and(isNull(contentItems.archivedAt), sql`${contentItems.stage} <> 'archived'`),
        input.q ? ilike(contentItems.title, likeText(input.q)) : undefined,
      ),
    )
    .orderBy(desc(sql`(${contentItems.approvedVersionId} IS NOT NULL)`), desc(contentItems.updatedAt), asc(contentItems.id))
    .limit(input.ids?.length ? Math.max(input.ids.length, input.limit) : input.limit);
  const approvedIds = rows.map((r) => r.approvedVersionId).filter((x): x is string => !!x);
  const [approved, latest] = await all(ctx, [
    () =>
      approvedIds.length
        ? db.select().from(contentVersions).where(and(eq(contentVersions.workspaceId, ctx.actor.workspaceId), inArray(contentVersions.id, approvedIds)))
        : Promise.resolve([]),
    () =>
      rows.length
        ? db
            .select({ contentItemId: contentVersions.contentItemId, n: sql<number>`max(${contentVersions.versionNo})` })
            .from(contentVersions)
            .where(and(eq(contentVersions.workspaceId, ctx.actor.workspaceId), inArray(contentVersions.contentItemId, rows.map((r) => r.id))))
            .groupBy(contentVersions.contentItemId)
        : Promise.resolve([]),
  ] as const);
  const byId = new Map(approved.map((v) => [v.id, v]));
  const latestBy = new Map(latest.map((l) => [l.contentItemId, Number(l.n)]));
  return rows.map((c) => {
    const v = c.approvedVersionId ? byId.get(c.approvedVersionId) : undefined;
    return {
      id: c.id,
      title: c.title,
      format: c.format,
      stage: c.stage,
      approvedVersion: v && v.approvedAt && !v.approvalRevokedAt ? { id: v.id, versionNo: v.versionNo, approvedAt: v.approvedAt.toISOString() } : null,
      latestVersionNo: latestBy.get(c.id) ?? null,
    };
  });
};

export const publicationContentVersions = async (ctx: QueryContext, input: { contentItemId: string; accountId: string }) => {
  requirePermission(ctx, 'publications.write');
  const a = await accountForPlanning(ctx, input.accountId);
  const [c] = await dbOf(ctx)
    .select()
    .from(contentItems)
    .where(and(eq(contentItems.workspaceId, ctx.actor.workspaceId), eq(contentItems.id, input.contentItemId)));
  if (!c || c.deletedAt || c.projectId !== a.projectId) throw notFound('Content');
  const rows = await dbOf(ctx)
    .select()
    .from(contentVersions)
    .where(and(eq(contentVersions.workspaceId, ctx.actor.workspaceId), eq(contentVersions.contentItemId, c.id)))
    .orderBy(desc(contentVersions.versionNo));
  return rows.map((v) => ({
    id: v.id,
    versionNo: v.versionNo,
    note: v.note,
    submittedAt: v.submittedAt?.toISOString() ?? null,
    approvedAt: v.approvedAt?.toISOString() ?? null,
    approvalRevokedAt: v.approvalRevokedAt?.toISOString() ?? null,
    approved: !!v.approvedAt && !v.approvalRevokedAt,
  }));
};
