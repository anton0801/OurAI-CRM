import { and, asc, count, desc, eq, inArray, isNull, notInArray, or, sql, type SQL } from 'drizzle-orm';
import { hasAnywhere } from '@castlane/authorization';
import {
  assetLinks,
  assets,
  assetVersions,
  campaigns,
  dealProjects,
  dealStageEvents,
  deals,
  deliverables,
  partners,
  projects,
  users,
} from '@castlane/database';
import { AppError, assertTransition, formatMinor, newId, parseAmountToMinor, type TransitionTable } from '@castlane/domain';
import { allowed, requirePermission, whereAll } from '../core/access';
import { audit, diffFields } from '../core/audit';
import { all, dbOf, type CommandContext, type QueryContext } from '../core/context';
import { emit } from '../core/events';
import { isActiveMember, loadMemberRefs, refOrUnknown } from '../core/members';
import { notify } from '../core/notify';
import { assertVersion, stamp, touch } from '../core/rows';
import { indexSearchDocument } from '../core/search';
import { finishPage, keysetWhere, likeOf, pageSizeOf, projectNames, type SortKind } from '../accounts/helpers';
import { projectScopeOf } from '../creative/common';
import { deliverableViews } from './deliverables';
import { interactionsForDeal } from './partners';
import { canDeal, canPartner, canSeeDealAmounts, dealProjectIds, dealVisibility, loadDealRow, partnerDealProjectIds, type DealRow } from './scope';

type DealStage = DealRow['stage'];

/**
 * Deal stages (section 9): Lead → Discussing → Proposal → Negotiation → Won → Delivering →
 * Fulfilled; Lost and Cancelled need a reason. A Won deal is not Paid and never creates income,
 * payments or posted finance (T138) — the finance module records those separately.
 */
export const DEAL_TRANSITIONS: TransitionTable<DealStage> = {
  lead: ['discussing', 'proposal', 'negotiation', 'won', 'lost', 'cancelled'],
  discussing: ['lead', 'proposal', 'negotiation', 'won', 'lost', 'cancelled'],
  proposal: ['discussing', 'negotiation', 'won', 'lost', 'cancelled'],
  negotiation: ['proposal', 'won', 'lost', 'cancelled'],
  won: ['delivering', 'cancelled'],
  delivering: ['fulfilled', 'cancelled'],
  fulfilled: [],
  lost: ['discussing'],
  cancelled: [],
};

const CLOSED: DealStage[] = ['fulfilled', 'lost', 'cancelled'];

const moneyOf = (minor: bigint | null, currency: string | null) => (minor !== null && currency ? { amount: formatMinor(minor, currency), currency } : null);

const parseMoney = (m: { amount: string; currency: string }, field: string) => {
  try {
    return parseAmountToMinor(m.amount, m.currency);
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Enter a valid amount.';
    throw new AppError('VALIDATION_FAILED', message, { fieldErrors: [{ field, code: 'INVALID_AMOUNT', message }] });
  }
};

// ——— Read models ———

export const dealSummaries = async (ctx: QueryContext | CommandContext, rows: DealRow[]) => {
  if (!rows.length) return [];
  const db = dbOf(ctx);
  const ws = ctx.actor.workspaceId;
  const ids = rows.map((r) => r.id);
  const projectMap = await dealProjectIds(ctx, ids);
  const [partnerRows, names, deliverableCounts, campaignRows, refs] = await all(ctx, [
    () => db.select({ id: partners.id, name: partners.name }).from(partners).where(and(eq(partners.workspaceId, ws), inArray(partners.id, rows.map((r) => r.partnerId)))),
    () => projectNames(ctx, [...projectMap.values()].flat()),
    () =>
      db
        .select({ dealId: deliverables.dealId, total: count(), open: sql<number>`count(*) FILTER (WHERE ${deliverables.status} IN ('open', 'delivered'))` })
        .from(deliverables)
        .where(and(eq(deliverables.workspaceId, ws), inArray(deliverables.dealId, ids), isNull(deliverables.archivedAt)))
        .groupBy(deliverables.dealId),
    () => {
      const cids = rows.map((r) => r.campaignId).filter((x): x is string => !!x);
      return cids.length ? db.select({ id: campaigns.id, name: campaigns.name }).from(campaigns).where(and(eq(campaigns.workspaceId, ws), inArray(campaigns.id, cids))) : Promise.resolve([]);
    },
    () => loadMemberRefs(db, ws, rows.map((r) => r.ownerMembershipId)),
  ] as const);
  return rows.map((d) => {
    const pids = projectMap.get(d.id) ?? [];
    const dc = deliverableCounts.find((x) => x.dealId === d.id);
    const withAmounts = canSeeDealAmounts(ctx, pids);
    return {
      id: d.id,
      title: d.title,
      partner: partnerRows.find((p) => p.id === d.partnerId) ?? { id: d.partnerId, name: 'Unknown partner' },
      owner: refOrUnknown(refs, d.ownerMembershipId)!,
      stage: d.stage,
      projects: pids.map((id) => ({ id, name: names.get(id)?.name ?? 'Unknown project' })),
      // Omitted (not null) without finance access.
      ...(withAmounts ? { amount: moneyOf(d.amountMinor, d.currency) } : {}),
      expectedCloseDate: d.expectedCloseDate,
      campaign: campaignRows.find((c) => c.id === d.campaignId) ?? null,
      deliverables: { total: Number(dc?.total ?? 0), open: Number(dc?.open ?? 0) },
      closedAt: d.closedAt?.toISOString() ?? null,
      archivedAt: d.archivedAt?.toISOString() ?? null,
      updatedAt: d.updatedAt.toISOString(),
      rowVersion: d.rowVersion,
    };
  });
};

export interface ListDealsInput {
  cursor?: string;
  pageSize?: number;
  q?: string;
  stage?: DealStage[];
  partnerId?: string;
  projectId?: string;
  ownerMembershipId?: string;
  includeArchived?: boolean;
  sort: 'updatedAt' | 'title' | 'stage' | 'expectedCloseDate';
  direction: 'asc' | 'desc';
}

const SORTS: Record<ListDealsInput['sort'], { expr: SQL; kind: SortKind; value: (d: DealRow) => string }> = {
  updatedAt: { expr: sql`${deals.updatedAt}`, kind: 'timestamp', value: (d) => d.updatedAt.toISOString() },
  title: { expr: sql`lower(${deals.title})`, kind: 'text', value: (d) => d.title.toLowerCase() },
  stage: { expr: sql`${deals.stage}`, kind: 'text', value: (d) => d.stage },
  expectedCloseDate: { expr: sql`coalesce(${deals.expectedCloseDate}, '9999-12-31'::date)`, kind: 'date', value: (d) => d.expectedCloseDate ?? '9999-12-31' },
};

export const listDeals = async (ctx: QueryContext, input: ListDealsInput) => {
  requirePermission(ctx, 'deals.read');
  const size = pageSizeOf(input.pageSize);
  const s = SORTS[input.sort];
  const rows = await ctx.app.db
    .select()
    .from(deals)
    .where(
      whereAll(
        eq(deals.workspaceId, ctx.actor.workspaceId),
        dealVisibility(ctx, 'deals.read'),
        input.includeArchived ? undefined : isNull(deals.archivedAt),
        input.stage?.length ? inArray(deals.stage, input.stage) : undefined,
        input.partnerId ? eq(deals.partnerId, input.partnerId) : undefined,
        input.projectId ? sql`EXISTS (SELECT 1 FROM deal_projects dp WHERE dp.deal_id = ${deals.id} AND dp.project_id = ${input.projectId}::uuid)` : undefined,
        input.ownerMembershipId ? eq(deals.ownerMembershipId, input.ownerMembershipId) : undefined,
        input.q ? or(sql`${deals.title} ILIKE ${likeOf(input.q)}`, sql`EXISTS (SELECT 1 FROM partners p WHERE p.id = ${deals.partnerId} AND p.name ILIKE ${likeOf(input.q)})`) : undefined,
        keysetWhere(s.expr, deals.id, input.direction, input.cursor, s.kind),
      ),
    )
    .orderBy(input.direction === 'asc' ? asc(s.expr) : desc(s.expr), input.direction === 'asc' ? asc(deals.id) : desc(deals.id))
    .limit(size + 1);
  return finishPage(rows, size, s.value, (page) => dealSummaries(ctx, page));
};

const dealDocuments = async (ctx: QueryContext | CommandContext, dealId: string) => {
  const rows = await dbOf(ctx)
    .select({ linkId: assetLinks.id, a: assets, status: assetVersions.status, createdAt: assetLinks.createdAt })
    .from(assetLinks)
    .innerJoin(assets, and(eq(assets.workspaceId, assetLinks.workspaceId), eq(assets.id, assetLinks.assetId)))
    .leftJoin(assetVersions, eq(assetVersions.id, assets.currentVersionId))
    .where(and(eq(assetLinks.workspaceId, ctx.actor.workspaceId), eq(assetLinks.entityType, 'deal'), eq(assetLinks.entityId, dealId), isNull(assetLinks.removedAt)))
    .orderBy(desc(assetLinks.createdAt));
  return rows.map((r) => {
    const restricted = r.a.sensitivity === 'restricted';
    const canRestricted = !restricted || allowed(ctx, 'assets.restricted.read', { projectId: r.a.projectId });
    return {
      linkId: r.linkId,
      assetId: r.a.id,
      name: r.a.name,
      restricted,
      status: r.status ?? null,
      createdAt: r.createdAt.toISOString(),
      canDownload: r.status === 'available' && canRestricted && hasAnywhere(ctx.actor.access, 'assets.download'),
    };
  });
};

export const getDeal = async (ctx: QueryContext | CommandContext, id: string) => {
  const { deal: d, projectIds } = await loadDealRow(ctx, id);
  const db = dbOf(ctx);
  const [summary] = await dealSummaries(ctx, [d]);
  const [events, deliverableRows] = await all(ctx, [
    () => db.select().from(dealStageEvents).where(and(eq(dealStageEvents.workspaceId, ctx.actor.workspaceId), eq(dealStageEvents.dealId, id))).orderBy(desc(dealStageEvents.occurredAt), desc(dealStageEvents.createdAt)),
    () => db.select().from(deliverables).where(and(eq(deliverables.workspaceId, ctx.actor.workspaceId), eq(deliverables.dealId, id))).orderBy(asc(deliverables.dueAt), asc(deliverables.createdAt)),
  ] as const);
  const userIds = [...new Set(events.map((e) => e.createdBy).filter((x): x is string => !!x))];
  const names = new Map(userIds.length ? (await db.select({ id: users.id, name: users.displayName }).from(users).where(inArray(users.id, userIds))).map((u) => [u.id, u.name]) : []);
  const canWrite = canDeal(ctx, 'deals.write', d, projectIds);
  const viewAmounts = canSeeDealAmounts(ctx, projectIds);
  const archived = !!d.archivedAt;
  const closed = CLOSED.includes(d.stage);
  return {
    ...summary!,
    stageReason: d.stageReason,
    outcome: d.outcome,
    ...(viewAmounts ? { paymentSchedule: d.paymentSchedule } : {}),
    deliverableItems: await deliverableViews(ctx, deliverableRows, projectIds),
    stageEvents: events.map((e) => ({ id: e.id, fromStage: e.fromStage, toStage: e.toStage, reason: e.reason, occurredAt: e.occurredAt.toISOString(), actorName: e.createdBy ? (names.get(e.createdBy) ?? null) : null })),
    documents: await dealDocuments(ctx, id),
    interactions: await interactionsForDeal(ctx, id),
    allowedTransitions: canWrite && !archived ? [...DEAL_TRANSITIONS[d.stage]] : [],
    permissions: {
      update: canWrite && !archived,
      transition: canWrite && !archived,
      archive: canWrite && (closed || archived),
      viewAmounts,
      editAmounts: viewAmounts && canWrite && !archived,
      manageDeliverables: canWrite && !archived && !closed,
      createCampaign: canWrite && !archived && !d.campaignId && projectIds.every((p) => allowed(ctx, 'campaigns.write', { projectId: p })),
      uploadDocuments: canWrite && !archived && projectIds.some((p) => allowed(ctx, 'assets.restricted.read', { projectId: p }) && (allowed(ctx, 'assets.upload', { projectId: p }) || allowed(ctx, 'assets.link', { projectId: p }))),
      logInteraction: canWrite && !archived,
    },
  };
};

// ——— Commands ———

export const indexDeal = async (ctx: CommandContext, d: DealRow) => {
  const pids = (await dealProjectIds(ctx, [d.id])).get(d.id) ?? [];
  const [p] = await ctx.tx.select({ name: partners.name }).from(partners).where(eq(partners.id, d.partnerId));
  await indexSearchDocument(ctx.tx, {
    workspaceId: ctx.actor.workspaceId,
    entityType: 'deal',
    entityId: d.id,
    title: d.title,
    body: [p?.name, d.stage, d.outcome].filter(Boolean).join('\n'),
    // Search documents carry one project: the deal's first project (other projects see it via lists).
    projectId: pids[0] ?? null,
    permission: 'deals.read',
    ownerMembershipId: d.ownerMembershipId,
    assigneeMembershipIds: [d.ownerMembershipId],
    archived: !!d.archivedAt,
    status: d.stage,
    at: ctx.app.clock.now(),
  });
};

/** Every project of a deal must be writable by the actor (no linking into foreign scopes). */
const checkProjects = async (ctx: CommandContext, projectIds: string[]) => {
  const unique = [...new Set(projectIds)];
  if (!unique.length) throw new AppError('VALIDATION_FAILED', 'Choose at least one project.', { fieldErrors: [{ field: 'projectIds', code: 'REQUIRED', message: 'Choose at least one project.' }] });
  const rows = await ctx.tx.select().from(projects).where(and(eq(projects.workspaceId, ctx.actor.workspaceId), inArray(projects.id, unique)));
  const bad = unique.filter((id) => {
    const p = rows.find((r) => r.id === id);
    return !p || p.deletedAt || p.status === 'archived' || !allowed(ctx, 'deals.write', projectScopeOf(p));
  });
  if (bad.length)
    throw new AppError('VALIDATION_FAILED', 'Choose active projects where you can manage deals.', { fieldErrors: [{ field: 'projectIds', code: 'INVALID', message: 'Choose active projects where you can manage deals.' }] });
  return unique;
};

const checkPartner = async (ctx: CommandContext, partnerId: string) => {
  const [p] = await ctx.tx.select().from(partners).where(and(eq(partners.workspaceId, ctx.actor.workspaceId), eq(partners.id, partnerId)));
  const via = p ? await partnerDealProjectIds(ctx, partnerId) : [];
  if (!p || !canPartner(ctx, 'partners.read', p, via))
    throw new AppError('VALIDATION_FAILED', 'Choose a partner you can access.', { fieldErrors: [{ field: 'partnerId', code: 'NOT_FOUND', message: 'Choose a partner you can access.' }] });
  if (p.archivedAt) throw new AppError('VALIDATION_FAILED', 'This partner is archived.', { fieldErrors: [{ field: 'partnerId', code: 'ARCHIVED', message: p.mergedIntoId ? 'This partner was merged into another one.' : 'This partner is archived.' }] });
  return p;
};

const checkCampaign = async (ctx: CommandContext, campaignId: string) => {
  const [c] = await ctx.tx.select({ id: campaigns.id }).from(campaigns).where(and(eq(campaigns.workspaceId, ctx.actor.workspaceId), eq(campaigns.id, campaignId)));
  if (!c || !hasAnywhere(ctx.actor.access, 'campaigns.read'))
    throw new AppError('VALIDATION_FAILED', 'Choose a campaign you can access.', { fieldErrors: [{ field: 'campaignId', code: 'NOT_FOUND', message: 'Choose a campaign you can access.' }] });
};

type PaymentItem = { dueDate: string; amount: string; currency: string; note?: string };

const checkPaymentSchedule = (items: PaymentItem[]) =>
  items.map((it, i) => {
    parseMoney({ amount: it.amount, currency: it.currency }, `paymentSchedule.${i}.amount`);
    return { dueDate: it.dueDate, amount: it.amount.trim(), currency: it.currency, ...(it.note?.trim() ? { note: it.note.trim() } : {}) };
  });

export interface DealInput {
  title?: string;
  partnerId?: string;
  ownerMembershipId?: string;
  projectIds?: string[];
  amount?: { amount: string; currency: string } | null;
  expectedCloseDate?: string | null;
  campaignId?: string | null;
  paymentSchedule?: PaymentItem[];
}

const replaceProjects = async (ctx: CommandContext, dealId: string, projectIds: string[]) => {
  const existing = await ctx.tx.select().from(dealProjects).where(eq(dealProjects.dealId, dealId));
  const remove = existing.filter((e) => !projectIds.includes(e.projectId)).map((e) => e.id);
  if (remove.length) await ctx.tx.delete(dealProjects).where(inArray(dealProjects.id, remove));
  for (const p of projectIds.filter((id) => !existing.some((e) => e.projectId === id))) await ctx.tx.insert(dealProjects).values({ ...stamp(ctx), id: newId(), dealId, projectId: p });
};

const notifyOwner = async (ctx: CommandContext, d: DealRow, ownerId: string) =>
  notify(ctx.tx, {
    workspaceId: ctx.actor.workspaceId,
    recipientMembershipIds: [ownerId],
    eventType: 'deal.owner_assigned',
    eventKey: `deal.owner_assigned:${d.id}:${ownerId}:${d.rowVersion}`,
    kind: 'assignment',
    title: `You own the deal ${d.title}`,
    entityType: 'deal',
    entityId: d.id,
    actorMembershipId: ctx.actor.membershipId,
    at: ctx.app.clock.now(),
  });

export const createDeal = async (ctx: CommandContext, input: DealInput & { title: string; partnerId: string; ownerMembershipId: string; projectIds: string[] }) => {
  requirePermission(ctx, 'deals.write');
  const partner = await checkPartner(ctx, input.partnerId);
  const projectIds = await checkProjects(ctx, input.projectIds);
  if (!(await isActiveMember(ctx.tx, ctx.actor.workspaceId, input.ownerMembershipId)))
    throw new AppError('VALIDATION_FAILED', 'The owner must be an active member.', { fieldErrors: [{ field: 'ownerMembershipId', code: 'INACTIVE', message: 'The owner must be an active member.' }] });
  const finance = canSeeDealAmounts(ctx, projectIds);
  if ((input.amount || input.paymentSchedule?.length) && !finance) throw new AppError('FORBIDDEN', 'Deal amounts need finance access to the deal’s projects.');
  if (input.campaignId) await checkCampaign(ctx, input.campaignId);
  const id = newId();
  const at = ctx.app.clock.now();
  const [row] = await ctx.tx
    .insert(deals)
    .values({
      ...stamp(ctx),
      id,
      title: input.title.trim(),
      partnerId: partner.id,
      ownerMembershipId: input.ownerMembershipId,
      stage: 'lead',
      amountMinor: input.amount ? parseMoney(input.amount, 'amount.amount') : null,
      currency: input.amount?.currency ?? null,
      campaignId: input.campaignId ?? null,
      expectedCloseDate: input.expectedCloseDate ?? null,
      paymentSchedule: input.paymentSchedule ? checkPaymentSchedule(input.paymentSchedule) : [],
    })
    .returning();
  await replaceProjects(ctx, id, projectIds);
  await ctx.tx.insert(dealStageEvents).values({ ...stamp(ctx), id: newId(), dealId: id, fromStage: null, toStage: 'lead', occurredAt: at });
  await audit(ctx, { action: 'deal.created', entityType: 'deal', entityId: id, projectId: projectIds[0], diff: diffFields(null, row!, ['title', 'partnerId', 'ownerMembershipId', 'stage']), metadata: { partnerId: partner.id, projectIds } });
  await emit(ctx, { type: 'deal.created', entityType: 'deal', entityId: id, revision: 1, payload: { partnerId: partner.id } });
  await emit(ctx, { type: 'partner.updated', entityType: 'partner', entityId: partner.id });
  await indexDeal(ctx, row!);
  if (input.ownerMembershipId !== ctx.actor.membershipId) await notifyOwner(ctx, row!, input.ownerMembershipId);
  // The creator must still see what they created (owner or project scope); otherwise refuse.
  if (!canDeal(ctx, 'deals.read', row!, projectIds)) throw new AppError('FORBIDDEN', 'You would not be able to see this deal. Choose yourself as owner or one of your projects.');
  return id;
};

export const updateDeal = async (ctx: CommandContext, id: string, input: DealInput) => {
  const { deal: d, projectIds } = await loadDealRow(ctx, id, { lock: true });
  if (!canDeal(ctx, 'deals.write', d, projectIds)) throw new AppError('FORBIDDEN', 'You cannot change this deal.');
  assertVersion(ctx, d);
  if (d.archivedAt) throw new AppError('INVALID_STATE', 'Restore the deal before editing it.');
  const patch: Partial<DealRow> = {};
  if (input.title !== undefined) patch.title = input.title.trim();
  if (input.partnerId !== undefined && input.partnerId !== d.partnerId) patch.partnerId = (await checkPartner(ctx, input.partnerId)).id;
  if (input.ownerMembershipId !== undefined && input.ownerMembershipId !== d.ownerMembershipId) {
    if (!(await isActiveMember(ctx.tx, ctx.actor.workspaceId, input.ownerMembershipId)))
      throw new AppError('VALIDATION_FAILED', 'The owner must be an active member.', { fieldErrors: [{ field: 'ownerMembershipId', code: 'INACTIVE', message: 'The owner must be an active member.' }] });
    patch.ownerMembershipId = input.ownerMembershipId;
  }
  let nextProjects = projectIds;
  if (input.projectIds !== undefined) {
    // Existing projects may stay even if the actor could not add them; new ones must be writable.
    const added = input.projectIds.filter((p) => !projectIds.includes(p));
    if (added.length) await checkProjects(ctx, added);
    nextProjects = [...new Set(input.projectIds)];
    if (!nextProjects.length) throw new AppError('VALIDATION_FAILED', 'Choose at least one project.', { fieldErrors: [{ field: 'projectIds', code: 'REQUIRED', message: 'Choose at least one project.' }] });
  }
  const touchesAmounts = input.amount !== undefined || input.paymentSchedule !== undefined;
  if (touchesAmounts && !canSeeDealAmounts(ctx, nextProjects)) throw new AppError('FORBIDDEN', 'Deal amounts need finance access to the deal’s projects.');
  if (input.amount !== undefined) {
    patch.amountMinor = input.amount ? parseMoney(input.amount, 'amount.amount') : null;
    patch.currency = input.amount?.currency ?? null;
  }
  if (input.paymentSchedule !== undefined) patch.paymentSchedule = checkPaymentSchedule(input.paymentSchedule);
  if (input.expectedCloseDate !== undefined) patch.expectedCloseDate = input.expectedCloseDate;
  if (input.campaignId !== undefined) {
    if (input.campaignId) await checkCampaign(ctx, input.campaignId);
    patch.campaignId = input.campaignId;
  }
  const [row] = await ctx.tx.update(deals).set({ ...patch, ...touch(ctx, deals) }).where(eq(deals.id, id)).returning();
  if (input.projectIds !== undefined) await replaceProjects(ctx, id, nextProjects);
  const diff = diffFields(d, row!, ['title', 'partnerId', 'ownerMembershipId', 'expectedCloseDate', 'campaignId']);
  if (touchesAmounts) diff.amount = { from: '[finance]', to: '[finance]' };
  await audit(ctx, { action: 'deal.updated', entityType: 'deal', entityId: id, projectId: nextProjects[0] ?? null, diff, metadata: input.projectIds ? { projectIds: nextProjects } : undefined });
  await emit(ctx, { type: 'deal.updated', entityType: 'deal', entityId: id, revision: row!.rowVersion });
  await indexDeal(ctx, row!);
  if (patch.ownerMembershipId) await notifyOwner(ctx, row!, patch.ownerMembershipId);
  return id;
};

export const transitionDeal = async (ctx: CommandContext, id: string, input: { targetStage: DealStage; reason?: string; outcome?: string }) => {
  const { deal: d, projectIds } = await loadDealRow(ctx, id, { lock: true });
  if (!canDeal(ctx, 'deals.write', d, projectIds)) throw new AppError('FORBIDDEN', 'You cannot change this deal.');
  assertVersion(ctx, d);
  if (d.archivedAt) throw new AppError('INVALID_STATE', 'Restore the deal before changing its stage.');
  assertTransition(DEAL_TRANSITIONS, d.stage, input.targetStage, 'deal');
  const reason = input.reason?.trim();
  const needsReason = input.targetStage === 'lost' || input.targetStage === 'cancelled' || d.stage === 'lost';
  if (needsReason && !reason) {
    const message = input.targetStage === 'lost' ? 'Say why the deal was lost.' : input.targetStage === 'cancelled' ? 'Say why the deal was cancelled.' : 'Say why the deal is reopened.';
    throw new AppError('VALIDATION_FAILED', message, { fieldErrors: [{ field: 'reason', code: 'REQUIRED', message }] });
  }
  if (input.targetStage === 'fulfilled') {
    const [open] = await ctx.tx
      .select({ n: count() })
      .from(deliverables)
      .where(and(eq(deliverables.dealId, id), isNull(deliverables.archivedAt), notInArray(deliverables.status, ['accepted', 'cancelled'])));
    if (Number(open?.n ?? 0) > 0)
      throw new AppError('INVALID_STATE', 'Accept or cancel every deliverable before closing the deal as fulfilled.', {
        details: { items: [{ kind: 'open_deliverables', label: 'Open deliverables', count: Number(open?.n ?? 0), blocking: true }] },
      });
  }
  const at = ctx.app.clock.now();
  const closing = CLOSED.includes(input.targetStage);
  const [row] = await ctx.tx
    .update(deals)
    .set({
      stage: input.targetStage,
      stageReason: reason ?? null,
      ...(input.outcome !== undefined ? { outcome: input.outcome.trim() || null } : {}),
      closedAt: closing ? at : null,
      ...touch(ctx, deals),
    })
    .where(eq(deals.id, id))
    .returning();
  await ctx.tx.insert(dealStageEvents).values({ ...stamp(ctx), id: newId(), dealId: id, fromStage: d.stage, toStage: input.targetStage, reason: reason ?? null, occurredAt: at });
  await audit(ctx, { action: 'deal.stage_changed', entityType: 'deal', entityId: id, projectId: projectIds[0] ?? null, reason: reason ?? null, diff: { stage: { from: d.stage, to: input.targetStage } } });
  // Automation trigger deal.stage_changed (section 19). Payload: ids and stage names only.
  await emit(ctx, { type: 'deal.stage_changed', entityType: 'deal', entityId: id, revision: row!.rowVersion, payload: { from: d.stage, to: input.targetStage, partnerId: d.partnerId } });
  await indexDeal(ctx, row!);
  if (d.ownerMembershipId !== ctx.actor.membershipId)
    await notify(ctx.tx, {
      workspaceId: ctx.actor.workspaceId,
      recipientMembershipIds: [d.ownerMembershipId],
      eventType: 'deal.stage_changed',
      eventKey: `deal.stage_changed:${id}:${row!.rowVersion}`,
      kind: 'general',
      title: `${d.title}: ${d.stage} → ${input.targetStage}`,
      entityType: 'deal',
      entityId: id,
      actorMembershipId: ctx.actor.membershipId,
      at,
    });
  return id;
};

export const dealArchivePreview = async (ctx: QueryContext | CommandContext, id: string) => {
  const { deal: d, projectIds } = await loadDealRow(ctx, id);
  if (!canDeal(ctx, 'deals.write', d, projectIds)) throw new AppError('FORBIDDEN', 'You cannot archive this deal.');
  const items = CLOSED.includes(d.stage) ? [] : [{ kind: 'open_deal', label: 'The deal is still open', count: 1, blocking: true, resolution: 'Close it as Fulfilled, Lost or Cancelled first.' }];
  return { title: d.title, rowVersion: d.rowVersion, items };
};

export const archiveDeal = async (ctx: CommandContext, id: string, input: { reason?: string }, opts: { skipVersion?: boolean } = {}) => {
  const { deal: d } = await loadDealRow(ctx, id, { lock: true });
  const preview = await dealArchivePreview(ctx, id);
  if (!opts.skipVersion) assertVersion(ctx, d);
  if (d.archivedAt) throw new AppError('INVALID_STATE', 'This deal is already archived.');
  if (preview.items.some((i) => i.blocking)) throw new AppError('INVALID_STATE', 'Close the deal before archiving it.', { details: { items: preview.items } });
  const [row] = await ctx.tx.update(deals).set({ archivedAt: ctx.app.clock.now(), archivedBy: ctx.actor.userId, archiveReason: input.reason ?? null, ...touch(ctx, deals) }).where(eq(deals.id, id)).returning();
  await audit(ctx, { action: 'deal.archived', entityType: 'deal', entityId: id, reason: input.reason ?? null });
  await emit(ctx, { type: 'deal.archived', entityType: 'deal', entityId: id, revision: row!.rowVersion });
  await indexDeal(ctx, row!);
  return id;
};

export const restoreDeal = async (ctx: CommandContext, id: string, opts: { skipVersion?: boolean } = {}) => {
  const { deal: d, projectIds } = await loadDealRow(ctx, id, { lock: true });
  if (!canDeal(ctx, 'deals.write', d, projectIds)) throw new AppError('FORBIDDEN', 'You cannot restore this deal.');
  if (!opts.skipVersion) assertVersion(ctx, d);
  if (!d.archivedAt) throw new AppError('INVALID_STATE', 'This deal is not archived.');
  const [row] = await ctx.tx.update(deals).set({ archivedAt: null, archivedBy: null, archiveReason: null, ...touch(ctx, deals) }).where(eq(deals.id, id)).returning();
  await audit(ctx, { action: 'deal.restored', entityType: 'deal', entityId: id });
  await emit(ctx, { type: 'deal.restored', entityType: 'deal', entityId: id, revision: row!.rowVersion });
  await indexDeal(ctx, row!);
  return id;
};

export { CLOSED as CLOSED_STAGES };
