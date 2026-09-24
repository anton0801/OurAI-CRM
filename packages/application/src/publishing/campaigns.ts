import { and, asc, count, desc, eq, gte, ilike, inArray, isNull, lte, sql } from 'drizzle-orm';
import { can } from '@castlane/authorization';
import {
  budgetLines,
  budgetVersions,
  budgets,
  campaignProjects,
  campaignSourceReports,
  campaigns,
  deals,
  experiments,
  memberships,
  partners,
  projects,
  publications,
  trackingLinks,
} from '@castlane/database';
import { AppError, assertTransition, formatMinor, newId } from '@castlane/domain';
import { loadAccessSnapshot, allowed, requirePermission, whereAll } from '../core/access';
import { audit, diffFields } from '../core/audit';
import { all, dbOf, type CommandContext, type QueryContext } from '../core/context';
import { emit } from '../core/events';
import { loadMemberRefs, refOrUnknown } from '../core/members';
import { notify } from '../core/notify';
import { assertVersion, stamp, touch } from '../core/rows';
import { indexSearchDocument } from '../core/search';
import { resolveTags } from '../core/tags';
import { assertAssetUsable, entityActivity, finishPage, keysetWhere, pageSizeOf, thumbUrl } from '../accounts/helpers';
import { canDeal, canPartner, dealProjectIds, loadDealRow, partnerDealProjectIds } from '../partners/scope';
import { updateDeal } from '../partners/deals';
import { CAMPAIGN_TRANSITIONS, summarizeSources, type CampaignStatus } from './logic';
import { campaignProjectMap, campaignVisibility, canCampaign, canChangeCampaign, loadCampaignRow, publicationVisibility, type CampaignRowDb } from './scope';

/**
 * Campaigns (S33–S34, §12). A campaign links a concrete objective with projects, placements
 * (primary campaign), tracking links, source reports, deals and — through finance allocations —
 * costs. It never creates accounts, metrics, costs or results by itself.
 */

type Ctx = QueryContext | CommandContext;

const fieldFail = (field: string, code: string, message: string) => new AppError('VALIDATION_FAILED', message, { fieldErrors: [{ field, code, message }] });

// ——— Read model ———

const campaignExtras = async (ctx: Ctx, rows: CampaignRowDb[]) => {
  const db = dbOf(ctx);
  const ws = ctx.actor.workspaceId;
  const ids = rows.map((r) => r.id);
  const projectMap = await campaignProjectMap(db, ws, ids);
  const allProjects = [...new Set([...projectMap.values()].flat())];
  const partnerIds = [...new Set(rows.map((r) => r.partnerId).filter((x): x is string => !!x))];
  const [projectRows, partnerRows, refs, pubCounts, reports] = await all(ctx, [
    () => (allProjects.length ? db.select({ id: projects.id, name: projects.name }).from(projects).where(and(eq(projects.workspaceId, ws), inArray(projects.id, allProjects))) : Promise.resolve([])),
    () => (partnerIds.length ? db.select().from(partners).where(and(eq(partners.workspaceId, ws), inArray(partners.id, partnerIds))) : Promise.resolve([])),
    () => loadMemberRefs(db, ws, rows.map((r) => r.ownerMembershipId)),
    () =>
      ids.length
        ? db
            .select({ campaignId: publications.primaryCampaignId, status: publications.status, n: count() })
            .from(publications)
            // Counts include only placements the member may read (no count leakage).
            .where(whereAll(eq(publications.workspaceId, ws), inArray(publications.primaryCampaignId, ids), isNull(publications.deletedAt), publicationVisibility(ctx)))
            .groupBy(publications.primaryCampaignId, publications.status)
        : Promise.resolve([]),
    () => (ids.length ? db.select().from(campaignSourceReports).where(and(eq(campaignSourceReports.workspaceId, ws), inArray(campaignSourceReports.campaignId, ids))) : Promise.resolve([])),
  ] as const);
  // Approved campaign budgets, only for members with budgets.read on one of the campaign's projects.
  const budgetBy = new Map<string, { planned: { amount: string; currency: string }; periodStart: string; periodEnd: string }>();
  const budgetIds = rows.filter((r) => canSeeBudget(ctx, projectMap.get(r.id) ?? [])).map((r) => r.id);
  if (budgetIds.length) {
    const b = await db
      .select({ campaignId: budgets.scopeId, currency: budgets.currency, periodStart: budgets.periodStart, periodEnd: budgets.periodEnd, planned: sql<string>`coalesce(sum(${budgetLines.plannedMinor}), 0)::text` })
      .from(budgets)
      .innerJoin(budgetVersions, eq(budgetVersions.id, budgets.approvedVersionId))
      .leftJoin(budgetLines, eq(budgetLines.budgetVersionId, budgetVersions.id))
      .where(and(eq(budgets.workspaceId, ws), eq(budgets.scopeType, 'campaign'), inArray(budgets.scopeId, budgetIds), isNull(budgets.archivedAt)))
      .groupBy(budgets.scopeId, budgets.currency, budgets.periodStart, budgets.periodEnd);
    for (const r of b) if (r.campaignId) budgetBy.set(r.campaignId, { planned: { amount: formatMinor(BigInt(r.planned), r.currency), currency: r.currency }, periodStart: r.periodStart, periodEnd: r.periodEnd });
  }
  const partnerVia = new Map<string, string[]>();
  for (const p of partnerRows) partnerVia.set(p.id, await partnerDealProjectIds(ctx, p.id));
  return {
    projectMap,
    projectNames: new Map(projectRows.map((p) => [p.id, p.name])),
    partners: new Map(partnerRows.filter((p) => canPartner(ctx, 'partners.read', p, partnerVia.get(p.id) ?? [])).map((p) => [p.id, p.name])),
    refs,
    pubCounts,
    reports,
    budgetBy,
    budgetIds: new Set(budgetIds),
  };
};

export const canSeeBudget = (ctx: Ctx, projectIds: string[]) => ctx.actor.access.isOwner || projectIds.some((p) => allowed(ctx, 'budgets.read', { projectId: p }));
export const canSeeCampaignCosts = (ctx: Ctx, projectIds: string[]) => ctx.actor.access.isOwner || (projectIds.length > 0 && projectIds.every((p) => allowed(ctx, 'finance.read', { projectId: p })));

export const toCampaignRows = async (ctx: Ctx, rows: CampaignRowDb[]) => {
  if (!rows.length) return [];
  const x = await campaignExtras(ctx, rows);
  return rows.map((c) => {
    const pids = x.projectMap.get(c.id) ?? [];
    const counts = x.pubCounts.filter((r) => r.campaignId === c.id);
    const n = (s: string[]) => counts.filter((r) => s.includes(r.status)).reduce((a, r) => a + Number(r.n), 0);
    const summary = summarizeSources(
      x.reports.filter((r) => r.campaignId === c.id).map((r) => ({ id: r.id, sourceName: r.sourceName, attributionLabel: r.attributionLabel, periodStart: r.periodStart, periodEnd: r.periodEnd, clicks: r.clicks, conversions: r.conversions })),
    );
    return {
      id: c.id,
      name: c.name,
      objective: c.objective,
      owner: refOrUnknown(x.refs, c.ownerMembershipId)!,
      startDate: c.startDate,
      endDate: c.endDate,
      status: c.status,
      projects: pids.map((p) => ({ id: p, name: x.projectNames.get(p) ?? 'Project' })),
      partner: c.partnerId && x.partners.get(c.partnerId) ? { id: c.partnerId, name: x.partners.get(c.partnerId)! } : null,
      tags: c.tags,
      coverUrl: thumbUrl(c.workspaceId, c.coverAssetId, 128),
      publications: { planned: n(['draft', 'scheduled']), published: n(['published']) },
      confirmedResults: { clicks: summary.totals.clicks.value, conversions: summary.totals.conversions.value, reports: x.reports.filter((r) => r.campaignId === c.id).length },
      ...(x.budgetIds.has(c.id) ? { budget: x.budgetBy.get(c.id) ?? null } : {}),
      closedAt: c.closedAt?.toISOString() ?? null,
      archivedAt: c.archivedAt?.toISOString() ?? null,
      updatedAt: c.updatedAt.toISOString(),
      rowVersion: c.rowVersion,
    };
  });
};

export interface ListCampaignsInput {
  cursor?: string;
  pageSize?: number;
  q?: string;
  status?: CampaignStatus[];
  projectId?: string;
  ownerMembershipId?: string;
  partnerId?: string;
  activeOn?: string;
  includeArchived?: boolean;
  sort: 'startDate' | 'name' | 'updatedAt';
  direction: 'asc' | 'desc';
}

const SORTS = {
  startDate: { expr: sql`${campaigns.startDate}`, kind: 'date' as const, value: (c: CampaignRowDb) => c.startDate },
  name: { expr: sql`lower(${campaigns.name})`, kind: 'text' as const, value: (c: CampaignRowDb) => c.name.toLowerCase() },
  updatedAt: { expr: sql`${campaigns.updatedAt}`, kind: 'timestamp' as const, value: (c: CampaignRowDb) => c.updatedAt.toISOString() },
};

export const campaignFilterSql = (ctx: QueryContext, input: Omit<ListCampaignsInput, 'cursor' | 'pageSize' | 'sort' | 'direction'>) =>
  whereAll(
    eq(campaigns.workspaceId, ctx.actor.workspaceId),
    campaignVisibility(ctx),
    input.includeArchived || input.status?.includes('archived') ? undefined : isNull(campaigns.archivedAt),
    input.status?.length ? inArray(campaigns.status, input.status) : undefined,
    input.projectId ? sql`EXISTS (SELECT 1 FROM campaign_projects cp WHERE cp.campaign_id = ${campaigns.id} AND cp.project_id = ${input.projectId}::uuid)` : undefined,
    input.ownerMembershipId ? eq(campaigns.ownerMembershipId, input.ownerMembershipId) : undefined,
    input.partnerId ? eq(campaigns.partnerId, input.partnerId) : undefined,
    input.activeOn ? and(lte(campaigns.startDate, input.activeOn), gte(campaigns.endDate, input.activeOn)) : undefined,
    input.q ? ilike(campaigns.name, `%${input.q.trim().replace(/[%_\\]/g, (m) => `\\${m}`)}%`) : undefined,
  );

export const listCampaigns = async (ctx: QueryContext, input: ListCampaignsInput) => {
  requirePermission(ctx, 'campaigns.read');
  const size = pageSizeOf(input.pageSize);
  const s = SORTS[input.sort];
  const dir = input.direction === 'asc' ? asc : desc;
  const rows = await dbOf(ctx)
    .select()
    .from(campaigns)
    .where(whereAll(campaignFilterSql(ctx, input), keysetWhere(s.expr, campaigns.id, input.direction, input.cursor, s.kind)))
    .orderBy(dir(s.expr), dir(campaigns.id))
    .limit(size + 1);
  return finishPage(rows, size, s.value, (page) => toCampaignRows(ctx, page));
};

export const getCampaign = async (ctx: Ctx, id: string) => {
  const { campaign: c, projectIds } = await loadCampaignRow(ctx, id);
  const db = dbOf(ctx);
  const ws = ctx.actor.workspaceId;
  const [[row], dealRows, [links], [reports], [exps], dup] = await all(ctx, [
    () => toCampaignRows(ctx, [c]),
    () =>
      db
        .select({ d: deals, partnerName: partners.name })
        .from(deals)
        .innerJoin(partners, and(eq(partners.workspaceId, deals.workspaceId), eq(partners.id, deals.partnerId)))
        .where(and(eq(deals.workspaceId, ws), eq(deals.campaignId, id))),
    () => db.select({ n: count() }).from(trackingLinks).where(and(eq(trackingLinks.workspaceId, ws), eq(trackingLinks.campaignId, id), isNull(trackingLinks.archivedAt))),
    () => db.select({ n: count() }).from(campaignSourceReports).where(and(eq(campaignSourceReports.workspaceId, ws), eq(campaignSourceReports.campaignId, id))),
    () =>
      db
        .select({ n: count() })
        .from(experiments)
        .where(sql`${experiments.workspaceId} = ${ws}::uuid AND EXISTS (SELECT 1 FROM experiment_publications ep JOIN publications p ON p.id = ep.publication_id WHERE ep.experiment_id = ${experiments.id} AND p.primary_campaign_id = ${id}::uuid)`),
    () => (c.duplicatedFromId ? db.select().from(campaigns).where(and(eq(campaigns.workspaceId, ws), eq(campaigns.id, c.duplicatedFromId))) : Promise.resolve([])),
  ] as const);
  const dealProjectMap = await dealProjectIds(ctx, dealRows.map((d) => d.d.id));
  const dupRow = dup[0];
  const dupProjects = dupRow ? ((await campaignProjectMap(db, ws, [dupRow.id])).get(dupRow.id) ?? []) : [];
  const write = canChangeCampaign(ctx, 'campaigns.write', c, projectIds);
  const active = c.status !== 'archived';
  const allocate = projectIds.length > 0 && projectIds.every((p) => allowed(ctx, 'finance.allocate', { projectId: p }));
  return {
    ...row!,
    goals: c.goals,
    closingSummary: c.closingSummary,
    duplicatedFrom: dupRow && canCampaign(ctx, 'campaigns.read', dupRow, dupProjects) ? { id: dupRow.id, name: dupRow.name } : null,
    coverAssetId: c.coverAssetId,
    deals: dealRows
      .filter((d) => canDeal(ctx, 'deals.read', d.d, dealProjectMap.get(d.d.id) ?? []))
      .map((d) => ({ id: d.d.id, title: d.d.title, stage: d.d.stage, partnerName: d.partnerName })),
    counts: { trackingLinks: Number(links?.n ?? 0), sourceReports: Number(reports?.n ?? 0), experiments: Number(exps?.n ?? 0) },
    allowedTransitions: write ? CAMPAIGN_TRANSITIONS[c.status].filter((t) => t !== 'archived') : [],
    permissions: {
      update: write && active,
      transition: write && active,
      manageLinks: write && active,
      manageReports: write && active,
      linkDeal: write && active,
      readCosts: canSeeCampaignCosts(ctx, projectIds),
      allocateCosts: allocate && active,
      createPublication: active && c.status !== 'closed' && projectIds.some((p) => allowed(ctx, 'publications.write', { projectId: p })),
      archive: write && (c.status === 'closed' || c.status === 'planned'),
    },
  };
};

export type CampaignDetailView = Awaited<ReturnType<typeof getCampaign>>;

// ——— Commands ———

export const indexCampaign = async (ctx: CommandContext, c: CampaignRowDb, projectIds: string[]) => {
  await indexSearchDocument(ctx.tx, {
    workspaceId: ctx.actor.workspaceId,
    entityType: 'campaign',
    entityId: c.id,
    title: c.name,
    body: [c.objective, c.closingSummary, c.tags.join(' ')].filter(Boolean).join('\n'),
    projectId: projectIds[0] ?? null,
    permission: 'campaigns.read',
    ownerMembershipId: c.ownerMembershipId,
    assigneeMembershipIds: [c.ownerMembershipId],
    archived: c.status === 'archived',
    status: c.status,
    thumbnailAssetId: c.coverAssetId,
    at: ctx.app.clock.now(),
  });
};

const assertProjectsWritable = async (ctx: CommandContext, projectIds: string[]) => {
  const unique = [...new Set(projectIds)];
  const rows = unique.length
    ? await ctx.tx.select().from(projects).where(and(eq(projects.workspaceId, ctx.actor.workspaceId), inArray(projects.id, unique)))
    : [];
  for (const id of unique) {
    const p = rows.find((r) => r.id === id);
    const scope = p ? { objectType: 'project', objectId: p.id, projectId: p.id, directionId: p.directionId, ownerMembershipId: p.ownerMembershipId } : null;
    if (!p || p.deletedAt || !scope || !(allowed(ctx, 'campaigns.read', scope) || allowed(ctx, 'projects.read', scope)))
      throw fieldFail('projectIds', 'NOT_FOUND', 'Choose projects you can access.');
    if (!allowed(ctx, 'campaigns.write', scope)) throw new AppError('FORBIDDEN', `You cannot run campaigns for ${p.name}.`);
    if (p.status === 'archived') throw fieldFail('projectIds', 'ARCHIVED', `${p.name} is archived.`);
  }
  return unique;
};

/** Can this member read a campaign of these projects (as owner)? */
export const memberCanOwnCampaign = async (ctx: QueryContext | CommandContext, ownerMembershipId: string, projectIds: string[]) => {
  const [m] = await dbOf(ctx).select({ userId: memberships.userId, status: memberships.status, name: memberships.displayNameSnapshot }).from(memberships).where(and(eq(memberships.workspaceId, ctx.actor.workspaceId), eq(memberships.id, ownerMembershipId)));
  if (!m || m.status !== 'active') return { ok: false, active: false, name: m?.name ?? null };
  const snap = await loadAccessSnapshot(ctx.app.db, ctx.actor.workspaceId, m.userId, ctx.app.clock.now());
  const ok = !!snap && projectIds.some((p) => can(snap, 'campaigns.read', { objectType: 'campaign', projectId: p, ownerMembershipId, assignedMembershipIds: [ownerMembershipId] }));
  return { ok, active: true, name: m.name };
};

/** The owner must be active and able to read the campaign through one of its projects. */
const assertCampaignOwner = async (ctx: CommandContext, ownerMembershipId: string, projectIds: string[]) => {
  const r = await memberCanOwnCampaign(ctx, ownerMembershipId, projectIds);
  if (!r.active) throw fieldFail('ownerMembershipId', 'INACTIVE', 'Choose an active member.');
  if (!r.ok) throw fieldFail('ownerMembershipId', 'NO_ACCESS', `${r.name ?? 'This member'} cannot access campaigns of these projects.`);
};

const assertPartner = async (ctx: CommandContext, partnerId: string) => {
  const [p] = await ctx.tx.select().from(partners).where(and(eq(partners.workspaceId, ctx.actor.workspaceId), eq(partners.id, partnerId)));
  if (!p || !canPartner(ctx, 'partners.read', p, await partnerDealProjectIds(ctx, p.id))) throw fieldFail('partnerId', 'NOT_FOUND', 'Choose a partner you can access.');
  if (p.archivedAt || p.mergedIntoId) throw fieldFail('partnerId', 'ARCHIVED', 'This partner is archived or merged.');
};

export interface CampaignInput {
  name?: string;
  objective?: string;
  ownerMembershipId?: string;
  startDate?: string;
  endDate?: string;
  projectIds?: string[];
  partnerId?: string | null;
  goals?: { metricKey: string; target: string; unit: string }[];
  tags?: string[];
  coverAssetId?: string | null;
}

/** Create a Planned campaign. Exported for other modules (deals: Create Campaign). */
export const createCampaign = async (
  ctx: CommandContext,
  input: Required<Pick<CampaignInput, 'name' | 'objective' | 'ownerMembershipId' | 'startDate' | 'endDate' | 'projectIds'>> & CampaignInput,
  /** `partnerFromDeal`: the partner comes from a deal the actor may change, so it is not re-checked against partners.read. */
  opts: { source?: { dealId?: string }; partnerFromDeal?: boolean } = {},
) => {
  requirePermission(ctx, 'campaigns.write');
  if (input.endDate < input.startDate) throw fieldFail('endDate', 'BEFORE_START', 'The end date is before the start date.');
  const projectIds = await assertProjectsWritable(ctx, input.projectIds);
  if (!projectIds.length) throw fieldFail('projectIds', 'REQUIRED', 'Choose at least one project.');
  await assertCampaignOwner(ctx, input.ownerMembershipId, projectIds);
  if (input.partnerId && !opts.partnerFromDeal) await assertPartner(ctx, input.partnerId);
  if (input.coverAssetId) await assertAssetUsable(ctx, input.coverAssetId, 'coverAssetId', { imageOnly: true });
  const id = newId();
  const [row] = await ctx.tx
    .insert(campaigns)
    .values({
      ...stamp(ctx),
      id,
      name: input.name.trim(),
      objective: input.objective.trim(),
      ownerMembershipId: input.ownerMembershipId,
      startDate: input.startDate,
      endDate: input.endDate,
      status: 'planned',
      goals: input.goals ?? [],
      partnerId: input.partnerId ?? null,
      coverAssetId: input.coverAssetId ?? null,
      tags: await resolveTags(ctx, input.tags),
    })
    .returning();
  for (const projectId of projectIds) await ctx.tx.insert(campaignProjects).values({ ...stamp(ctx), id: newId(), campaignId: id, projectId });
  await audit(ctx, {
    action: 'campaign.created',
    entityType: 'campaign',
    entityId: id,
    projectId: projectIds[0] ?? null,
    diff: diffFields(null, row!, ['name', 'ownerMembershipId', 'startDate', 'endDate', 'partnerId']),
    metadata: { projectIds, ...(opts.source?.dealId ? { fromDealId: opts.source.dealId } : {}) },
  });
  await emit(ctx, { type: 'campaign.created', entityType: 'campaign', entityId: id, revision: 1, payload: opts.source?.dealId ? { dealId: opts.source.dealId } : {} });
  await indexCampaign(ctx, row!, projectIds);
  if (input.ownerMembershipId !== ctx.actor.membershipId)
    await notify(ctx.tx, {
      workspaceId: ctx.actor.workspaceId,
      recipientMembershipIds: [input.ownerMembershipId],
      eventType: 'campaign.owner_assigned',
      eventKey: `campaign.owner_assigned:${id}:${input.ownerMembershipId}:1`,
      kind: 'assignment',
      title: `You own the campaign ${row!.name}`,
      entityType: 'campaign',
      entityId: id,
      projectId: projectIds[0] ?? null,
      actorMembershipId: ctx.actor.membershipId,
      at: ctx.app.clock.now(),
    });
  return id;
};

const lockCampaignForChange = async (ctx: CommandContext, id: string, opts: { skipVersion?: boolean } = {}) => {
  const { campaign: c, projectIds } = await loadCampaignRow(ctx, id, { lock: true });
  if (!canChangeCampaign(ctx, 'campaigns.write', c, projectIds)) throw new AppError('FORBIDDEN', 'You cannot change this campaign.');
  if (!opts.skipVersion) assertVersion(ctx, c);
  return { c, projectIds };
};

export const updateCampaign = async (ctx: CommandContext, id: string, input: CampaignInput) => {
  const { c, projectIds } = await lockCampaignForChange(ctx, id);
  if (c.status === 'archived') throw new AppError('INVALID_STATE', 'Restore the campaign before editing it.');
  const patch: Partial<CampaignRowDb> = {};
  for (const k of ['name', 'objective', 'startDate', 'endDate'] as const) if (input[k] !== undefined) patch[k] = k === 'name' || k === 'objective' ? input[k]!.trim() : input[k]!;
  const start = patch.startDate ?? c.startDate;
  const end = patch.endDate ?? c.endDate;
  if (end < start) throw fieldFail('endDate', 'BEFORE_START', 'The end date is before the start date.');
  let nextProjects = projectIds;
  if (input.projectIds) {
    const wanted = [...new Set(input.projectIds)];
    if (!wanted.length) throw fieldFail('projectIds', 'REQUIRED', 'Choose at least one project.');
    const added = wanted.filter((p) => !projectIds.includes(p));
    const removed = projectIds.filter((p) => !wanted.includes(p));
    if (added.length) await assertProjectsWritable(ctx, added);
    for (const p of removed) {
      const [pubs] = await ctx.tx.select({ n: count() }).from(publications).where(and(eq(publications.workspaceId, ctx.actor.workspaceId), eq(publications.primaryCampaignId, id), eq(publications.projectId, p), isNull(publications.deletedAt)));
      const alloc = await ctx.tx.execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM (SELECT line_id FROM financial_allocations WHERE workspace_id = ${ctx.actor.workspaceId}::uuid AND campaign_id = ${id}::uuid AND project_id = ${p}::uuid GROUP BY line_id HAVING sum(amount_minor) <> 0) net`);
      if (Number(pubs?.n ?? 0) > 0 || Number(alloc.rows[0]?.n ?? 0) > 0)
        throw new AppError('INVALID_STATE', 'A project with placements or cost allocations of this campaign cannot be removed.', { details: { projectId: p } });
    }
    for (const p of removed) await ctx.tx.delete(campaignProjects).where(and(eq(campaignProjects.campaignId, id), eq(campaignProjects.projectId, p)));
    for (const p of added) await ctx.tx.insert(campaignProjects).values({ ...stamp(ctx), id: newId(), campaignId: id, projectId: p });
    nextProjects = [...projectIds.filter((p) => !removed.includes(p)), ...added];
  }
  if (input.ownerMembershipId && input.ownerMembershipId !== c.ownerMembershipId) {
    await assertCampaignOwner(ctx, input.ownerMembershipId, nextProjects);
    patch.ownerMembershipId = input.ownerMembershipId;
  }
  if (input.partnerId !== undefined && input.partnerId !== c.partnerId) {
    if (input.partnerId) await assertPartner(ctx, input.partnerId);
    patch.partnerId = input.partnerId;
  }
  if (input.goals !== undefined) patch.goals = input.goals;
  if (input.tags !== undefined) patch.tags = await resolveTags(ctx, input.tags);
  if (input.coverAssetId !== undefined && input.coverAssetId !== c.coverAssetId) {
    if (input.coverAssetId) await assertAssetUsable(ctx, input.coverAssetId, 'coverAssetId', { imageOnly: true });
    patch.coverAssetId = input.coverAssetId;
  }
  const [row] = await ctx.tx.update(campaigns).set({ ...patch, ...touch(ctx, campaigns) }).where(eq(campaigns.id, id)).returning();
  await audit(ctx, {
    action: 'campaign.updated',
    entityType: 'campaign',
    entityId: id,
    projectId: nextProjects[0] ?? null,
    diff: { ...diffFields(c, row!, ['name', 'objective', 'ownerMembershipId', 'startDate', 'endDate', 'partnerId', 'goals', 'tags', 'coverAssetId']), ...(input.projectIds ? { projectIds: { from: projectIds, to: nextProjects } } : {}) },
  });
  await emit(ctx, { type: 'campaign.updated', entityType: 'campaign', entityId: id, revision: row!.rowVersion });
  await indexCampaign(ctx, row!, nextProjects);
  if (patch.ownerMembershipId)
    await notify(ctx.tx, {
      workspaceId: ctx.actor.workspaceId,
      recipientMembershipIds: [patch.ownerMembershipId],
      eventType: 'campaign.owner_assigned',
      eventKey: `campaign.owner_assigned:${id}:${patch.ownerMembershipId}:${row!.rowVersion}`,
      kind: 'assignment',
      title: `You own the campaign ${row!.name}`,
      entityType: 'campaign',
      entityId: id,
      projectId: nextProjects[0] ?? null,
      actorMembershipId: ctx.actor.membershipId,
      at: ctx.app.clock.now(),
    });
  return id;
};

export const transitionCampaign = async (ctx: CommandContext, id: string, input: { targetStatus: CampaignStatus; closingSummary?: string; reason?: string }, opts: { skipVersion?: boolean } = {}) => {
  const { c, projectIds } = await lockCampaignForChange(ctx, id, opts);
  if (input.targetStatus === 'archived' && !opts.skipVersion) throw new AppError('VALIDATION_FAILED', 'Use Archive to archive a campaign.');
  assertTransition(CAMPAIGN_TRANSITIONS, c.status, input.targetStatus, 'campaign');
  const patch: Partial<CampaignRowDb> = { status: input.targetStatus };
  const at = ctx.app.clock.now();
  if (input.targetStatus === 'closed' && c.status !== 'archived') {
    const summary = input.closingSummary?.trim();
    if (!summary) throw fieldFail('closingSummary', 'REQUIRED', 'Summarise the campaign result before closing it.');
    Object.assign(patch, { closingSummary: summary, closedAt: at });
  }
  if (c.status === 'closed' && input.targetStatus === 'active') {
    if (!input.reason) throw fieldFail('reason', 'REQUIRED', 'Give a reason for reopening the campaign.');
    patch.closedAt = null;
  }
  if (input.targetStatus === 'archived') Object.assign(patch, { archivedAt: at, archivedBy: ctx.actor.userId, archiveReason: input.reason ?? null });
  if (c.status === 'archived') Object.assign(patch, { archivedAt: null, archivedBy: null, archiveReason: null });
  const [row] = await ctx.tx.update(campaigns).set({ ...patch, ...touch(ctx, campaigns) }).where(eq(campaigns.id, id)).returning();
  const action = input.targetStatus === 'archived' ? 'campaign.archived' : c.status === 'archived' ? 'campaign.restored' : 'campaign.status_changed';
  await audit(ctx, { action, entityType: 'campaign', entityId: id, projectId: projectIds[0] ?? null, reason: input.reason ?? input.closingSummary ?? null, diff: { status: { from: c.status, to: input.targetStatus } } });
  await emit(ctx, { type: 'campaign.status_changed', entityType: 'campaign', entityId: id, revision: row!.rowVersion, payload: { from: c.status, to: input.targetStatus } });
  await indexCampaign(ctx, row!, projectIds);
  return id;
};

export const campaignArchivePreview = async (ctx: Ctx, id: string) => {
  const { campaign: c, projectIds } = await loadCampaignRow(ctx, id);
  if (!canChangeCampaign(ctx, 'campaigns.write', c, projectIds)) throw new AppError('FORBIDDEN', 'You cannot archive this campaign.');
  const db = dbOf(ctx);
  const [[scheduled]] = await all(ctx, [
    () => db.select({ n: count() }).from(publications).where(and(eq(publications.workspaceId, ctx.actor.workspaceId), eq(publications.primaryCampaignId, id), eq(publications.status, 'scheduled'), isNull(publications.deletedAt))),
  ] as const);
  const items = [];
  if (c.status === 'active') items.push({ kind: 'active', label: 'The campaign is active', count: 1, blocking: true, resolution: 'Close the campaign with a summary first.' });
  if (Number(scheduled?.n ?? 0) > 0) items.push({ kind: 'scheduled_publications', label: 'Scheduled placements of this campaign', count: Number(scheduled!.n), blocking: false, resolution: 'They keep their campaign; the archive only hides the campaign from active lists.' });
  items.push({ kind: 'history', label: 'Archived records remain available in historical reports.', count: 1, blocking: false });
  return { title: c.name, rowVersion: c.rowVersion, items };
};

export const archiveCampaign = async (ctx: CommandContext, id: string, input: { reason?: string }, opts: { skipVersion?: boolean } = {}) => {
  const { c } = await lockCampaignForChange(ctx, id, opts);
  if (c.status === 'active') throw new AppError('INVALID_STATE', 'Close the campaign with a summary before archiving it.');
  if (c.status === 'archived') throw new AppError('INVALID_STATE', 'The campaign is already archived.');
  if (c.status === 'planned') await transitionCampaign(ctx, id, { targetStatus: 'closed', closingSummary: input.reason ?? 'Archived before it started.' }, { skipVersion: true });
  await transitionCampaign(ctx, id, { targetStatus: 'archived', reason: input.reason }, { skipVersion: true });
  return id;
};

export const restoreCampaign = async (ctx: CommandContext, id: string, opts: { skipVersion?: boolean } = {}) => {
  await transitionCampaign(ctx, id, { targetStatus: 'closed' }, opts);
  return id;
};

/** Duplicate Structure (S33): objective, projects, partner, goals and tags — never costs, income, placements or results. */
export const duplicateCampaign = async (ctx: CommandContext, id: string, input: { name: string; startDate: string; endDate: string; copyTrackingLinks?: boolean }) => {
  const { campaign: c, projectIds } = await loadCampaignRow(ctx, id);
  // The original owner keeps the copy when they can still reach its projects; otherwise the actor owns it.
  const keepOwner = (await memberCanOwnCampaign(ctx, c.ownerMembershipId, projectIds)).ok;
  const owner = keepOwner ? c.ownerMembershipId : ctx.actor.membershipId;
  if (!owner) throw new AppError('VALIDATION_FAILED', 'Choose an owner for the copy.');
  const newId_ = await createCampaign(ctx, {
    name: input.name,
    objective: c.objective,
    ownerMembershipId: owner,
    startDate: input.startDate,
    endDate: input.endDate,
    projectIds,
    partnerId: c.partnerId,
    goals: c.goals,
    tags: c.tags,
    coverAssetId: null,
  });
  await ctx.tx.update(campaigns).set({ duplicatedFromId: c.id }).where(eq(campaigns.id, newId_));
  if (input.copyTrackingLinks) {
    const links = await ctx.tx.select().from(trackingLinks).where(and(eq(trackingLinks.workspaceId, ctx.actor.workspaceId), eq(trackingLinks.campaignId, id), isNull(trackingLinks.archivedAt)));
    for (const l of links)
      await ctx.tx.insert(trackingLinks).values({
        ...stamp(ctx),
        id: newId(),
        campaignId: newId_,
        label: l.label,
        destinationUrl: l.destinationUrl,
        utmSource: l.utmSource,
        utmMedium: l.utmMedium,
        utmCampaign: l.utmCampaign,
        utmContent: l.utmContent,
        utmTerm: l.utmTerm,
        builtUrl: l.builtUrl,
        publicationId: null,
      });
  }
  await audit(ctx, { action: 'campaign.duplicated', entityType: 'campaign', entityId: newId_, projectId: projectIds[0] ?? null, metadata: { from: id, trackingLinksCopied: !!input.copyTrackingLinks } });
  return newId_;
};

/** Link Deal: an explicit relation set on the deal through the deals module's own command. */
export const linkCampaignDeal = async (ctx: CommandContext, id: string, input: { dealId: string; unlink?: boolean }) => {
  const { c, projectIds } = await lockCampaignForChange(ctx, id, { skipVersion: true });
  if (c.status === 'archived') throw new AppError('INVALID_STATE', 'Restore the campaign before linking deals.');
  const { deal, projectIds: dealProjects } = await loadDealRow(ctx, input.dealId, { lock: true });
  if (!canDeal(ctx, 'deals.write', deal, dealProjects)) throw new AppError('FORBIDDEN', 'You cannot change this deal.');
  if (input.unlink) {
    if (deal.campaignId !== id) throw new AppError('INVALID_STATE', 'This deal is not linked to the campaign.');
  } else if (deal.campaignId === id) throw new AppError('INVALID_STATE', 'This deal is already linked to the campaign.');
  else if (deal.campaignId) throw new AppError('INVALID_STATE', 'This deal is linked to another campaign. Unlink it there first.');
  await updateDeal({ ...ctx, request: { ...ctx.request, expectedVersion: deal.rowVersion } }, deal.id, { campaignId: input.unlink ? null : id });
  await audit(ctx, { action: input.unlink ? 'campaign.deal_unlinked' : 'campaign.deal_linked', entityType: 'campaign', entityId: id, projectId: projectIds[0] ?? null, metadata: { dealId: deal.id } });
  await emit(ctx, { type: 'campaign.updated', entityType: 'campaign', entityId: id });
  return id;
};

// ——— Results & activity ———

export const getCampaignResults = async (ctx: QueryContext, id: string) => {
  const { campaign: c } = await loadCampaignRow(ctx, id);
  const db = dbOf(ctx);
  const ws = ctx.actor.workspaceId;
  const [statusRows, [removed], reports, [links]] = await all(ctx, [
    () =>
      db
        .select({ status: publications.status, n: count() })
        .from(publications)
        .where(whereAll(eq(publications.workspaceId, ws), eq(publications.primaryCampaignId, id), isNull(publications.deletedAt), publicationVisibility(ctx)))
        .groupBy(publications.status),
    () =>
      db
        .select({ n: count() })
        .from(publications)
        .where(whereAll(eq(publications.workspaceId, ws), eq(publications.primaryCampaignId, id), isNull(publications.deletedAt), publicationVisibility(ctx), sql`${publications.availability} <> 'available'`)),
    () => db.select().from(campaignSourceReports).where(and(eq(campaignSourceReports.workspaceId, ws), eq(campaignSourceReports.campaignId, id))),
    () => db.select({ n: count() }).from(trackingLinks).where(and(eq(trackingLinks.workspaceId, ws), eq(trackingLinks.campaignId, id), isNull(trackingLinks.archivedAt))),
  ] as const);
  const summary = summarizeSources(reports.map((r) => ({ id: r.id, sourceName: r.sourceName, attributionLabel: r.attributionLabel, periodStart: r.periodStart, periodEnd: r.periodEnd, clicks: r.clicks, conversions: r.conversions })));
  const byStatus = { draft: 0, scheduled: 0, published: 0, failed: 0, cancelled: 0 };
  for (const r of statusRows) byStatus[r.status] = Number(r.n);
  return {
    publications: byStatus,
    removedOrUnavailable: Number(removed?.n ?? 0),
    sources: summary.sources.map((s) => ({ ...s, attributionLabel: s.attributionLabel as 'source_reported' | 'manual_assignment' | 'unattributed', periodStart: s.periodStart.toISOString(), periodEnd: s.periodEnd.toISOString() })),
    totals: summary.totals,
    goals: c.goals,
    trackingLinks: Number(links?.n ?? 0),
  };
};

export const campaignActivity = async (ctx: QueryContext, id: string, input: { cursor?: string; pageSize?: number }) => {
  await loadCampaignRow(ctx, id);
  const page = await entityActivity(ctx, ['campaign'], id, input);
  return { ...page, items: page.items.map((i) => ({ id: i.id, action: i.action, actorName: i.actorName, occurredAt: i.occurredAt, reason: i.reason, changes: i.changes })) };
};
