import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { contentItems, deliverables, socialAccounts } from '@castlane/database';
import { AppError, assertTransition, formatMinor, newId, notFound, parseAmountToMinor, type TransitionTable } from '@castlane/domain';
import { allowed } from '../core/access';
import { audit, diffFields } from '../core/audit';
import { dbOf, type CommandContext, type QueryContext } from '../core/context';
import { emit } from '../core/events';
import { assertVersion, stamp, touch } from '../core/rows';
import { projectNames } from '../accounts/helpers';
import { accountScope } from '../accounts/scope';
import { canDeal, canSeeDealAmounts, loadDealRow } from './scope';

type DeliverableRow = typeof deliverables.$inferSelect;
type DeliverableStatus = DeliverableRow['status'];

/** Open → Delivered → Accepted; Delivered → Open (rework); Open/Delivered → Cancelled; Cancelled → Open. */
export const DELIVERABLE_TRANSITIONS: TransitionTable<DeliverableStatus> = {
  open: ['delivered', 'cancelled'],
  delivered: ['accepted', 'open', 'cancelled'],
  accepted: [],
  cancelled: ['open'],
};

const CLOSED_DEAL = ['fulfilled', 'lost', 'cancelled'];

export const deliverableViews = async (ctx: QueryContext | CommandContext, rows: DeliverableRow[], dealProjectIds: string[]) => {
  if (!rows.length) return [];
  const db = dbOf(ctx);
  const ws = ctx.actor.workspaceId;
  const names = await projectNames(ctx, rows.map((r) => r.projectId));
  const accountIds = rows.map((r) => r.accountId).filter((x): x is string => !!x);
  const contentIds = rows.map((r) => r.contentItemId).filter((x): x is string => !!x);
  const accounts = accountIds.length ? await db.select().from(socialAccounts).where(and(eq(socialAccounts.workspaceId, ws), inArray(socialAccounts.id, accountIds))) : [];
  const content = contentIds.length ? await db.select().from(contentItems).where(and(eq(contentItems.workspaceId, ws), inArray(contentItems.id, contentIds))) : [];
  const amounts = canSeeDealAmounts(ctx, dealProjectIds);
  return rows.map((r) => {
    const a = accounts.find((x) => x.id === r.accountId);
    const c = content.find((x) => x.id === r.contentItemId);
    const p = r.projectId ? names.get(r.projectId) : null;
    const contentVisible = c && allowed(ctx, 'content.read', { projectId: c.projectId, assignedMembershipIds: [c.ownerMembershipId, c.reviewerMembershipId], ownerMembershipId: c.ownerMembershipId });
    return {
      id: r.id,
      dealId: r.dealId,
      title: r.title,
      format: r.format,
      project: p ? { id: p.id, name: p.name } : null,
      account: a ? { id: a.id, handle: a.handle, platform: a.platform } : null,
      dueAt: r.dueAt?.toISOString() ?? null,
      acceptanceCriteria: r.acceptanceCriteria,
      contentItem: c && contentVisible ? { id: c.id, title: c.title, stage: c.stage } : null,
      ...(amounts ? { agreedAmount: r.agreedAmountMinor !== null && r.currency ? { amount: formatMinor(r.agreedAmountMinor, r.currency), currency: r.currency } : null } : {}),
      status: r.status,
      archivedAt: r.archivedAt?.toISOString() ?? null,
      updatedAt: r.updatedAt.toISOString(),
      rowVersion: r.rowVersion,
    };
  });
};

export const listDeliverables = async (ctx: QueryContext, dealId: string, input: { includeArchived?: boolean } = {}) => {
  const { projectIds } = await loadDealRow(ctx, dealId);
  const rows = await ctx.app.db
    .select()
    .from(deliverables)
    .where(and(eq(deliverables.workspaceId, ctx.actor.workspaceId), eq(deliverables.dealId, dealId), input.includeArchived ? undefined : isNull(deliverables.archivedAt)))
    .orderBy(asc(deliverables.dueAt), asc(deliverables.createdAt));
  return deliverableViews(ctx, rows, projectIds);
};

const loadDeliverable = async (ctx: QueryContext | CommandContext, id: string, lock = false) => {
  const q = dbOf(ctx).select().from(deliverables).where(and(eq(deliverables.workspaceId, ctx.actor.workspaceId), eq(deliverables.id, id)));
  const [row] = lock && 'tx' in ctx ? await q.for('update') : await q;
  if (!row) throw notFound('Deliverable');
  const deal = await loadDealRow(ctx, row.dealId, { lock });
  return { row, ...deal };
};

export const getDeliverable = async (ctx: QueryContext | CommandContext, id: string) => {
  const { row, projectIds } = await loadDeliverable(ctx, id);
  return (await deliverableViews(ctx, [row], projectIds))[0]!;
};

export interface DeliverableInput {
  title?: string;
  format?: DeliverableRow['format'] | null;
  projectId?: string | null;
  accountId?: string | null;
  dueAt?: string | null;
  acceptanceCriteria?: string | null;
  contentItemId?: string | null;
  agreedAmount?: { amount: string; currency: string } | null;
}

/** Project must be one of the deal's projects; the account and content must belong to it. */
const resolveLinks = async (ctx: CommandContext, projectIds: string[], input: DeliverableInput, current?: DeliverableRow) => {
  let projectId = input.projectId === undefined ? (current?.projectId ?? null) : input.projectId;
  const accountId = input.accountId === undefined ? (current?.accountId ?? null) : input.accountId;
  const contentItemId = input.contentItemId === undefined ? (current?.contentItemId ?? null) : input.contentItemId;
  const invalid = (field: string, message: string) => new AppError('VALIDATION_FAILED', message, { fieldErrors: [{ field, code: 'INVALID', message }] });
  if (accountId) {
    const [a] = await ctx.tx.select().from(socialAccounts).where(and(eq(socialAccounts.workspaceId, ctx.actor.workspaceId), eq(socialAccounts.id, accountId)));
    if (!a || a.deletedAt || !allowed(ctx, 'accounts.read', accountScope(a))) throw invalid('accountId', 'Choose an account you can access.');
    if (!projectIds.includes(a.projectId)) throw invalid('accountId', 'The account must belong to one of the deal’s projects.');
    if (projectId && projectId !== a.projectId) throw invalid('accountId', 'The account belongs to another project than the one selected.');
    projectId = a.projectId;
  }
  if (projectId && !projectIds.includes(projectId)) throw invalid('projectId', 'Choose one of the deal’s projects.');
  if (contentItemId) {
    const [c] = await ctx.tx.select().from(contentItems).where(and(eq(contentItems.workspaceId, ctx.actor.workspaceId), eq(contentItems.id, contentItemId)));
    if (!c || c.deletedAt || !allowed(ctx, 'content.read', { projectId: c.projectId, assignedMembershipIds: [c.ownerMembershipId, c.reviewerMembershipId], ownerMembershipId: c.ownerMembershipId }))
      throw invalid('contentItemId', 'Choose content you can access.');
    if (!projectIds.includes(c.projectId)) throw invalid('contentItemId', 'The content must belong to one of the deal’s projects.');
  }
  return { projectId, accountId, contentItemId };
};

const parseAgreed = (m: { amount: string; currency: string }) => {
  try {
    return parseAmountToMinor(m.amount, m.currency);
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Enter a valid amount.';
    throw new AppError('VALIDATION_FAILED', message, { fieldErrors: [{ field: 'agreedAmount.amount', code: 'INVALID_AMOUNT', message }] });
  }
};

export const createDeliverable = async (ctx: CommandContext, dealId: string, input: DeliverableInput & { title: string }) => {
  const { deal, projectIds } = await loadDealRow(ctx, dealId, { lock: true });
  if (!canDeal(ctx, 'deals.write', deal, projectIds)) throw new AppError('FORBIDDEN', 'You cannot change this deal.');
  if (deal.archivedAt || CLOSED_DEAL.includes(deal.stage)) throw new AppError('INVALID_STATE', 'Closed or archived deals cannot get new deliverables.');
  if (input.agreedAmount && !canSeeDealAmounts(ctx, projectIds)) throw new AppError('FORBIDDEN', 'Agreed amounts need finance access to the deal’s projects.');
  const links = await resolveLinks(ctx, projectIds, input);
  const id = newId();
  const [row] = await ctx.tx
    .insert(deliverables)
    .values({
      ...stamp(ctx),
      id,
      dealId,
      title: input.title.trim(),
      format: input.format ?? null,
      projectId: links.projectId,
      accountId: links.accountId,
      dueAt: input.dueAt ? new Date(input.dueAt) : null,
      acceptanceCriteria: input.acceptanceCriteria?.trim() || null,
      contentItemId: links.contentItemId,
      agreedAmountMinor: input.agreedAmount ? parseAgreed(input.agreedAmount) : null,
      currency: input.agreedAmount?.currency ?? null,
      status: 'open',
    })
    .returning();
  await audit(ctx, { action: 'deal.deliverable_added', entityType: 'deal', entityId: dealId, projectId: links.projectId ?? projectIds[0] ?? null, metadata: { deliverableId: id, title: row!.title } });
  await emit(ctx, { type: 'deal.deliverable_added', entityType: 'deal', entityId: dealId, payload: { deliverableId: id } });
  return (await deliverableViews(ctx, [row!], projectIds))[0]!;
};

export const updateDeliverable = async (ctx: CommandContext, id: string, input: DeliverableInput) => {
  const { row, deal, projectIds } = await loadDeliverable(ctx, id, true);
  if (!canDeal(ctx, 'deals.write', deal, projectIds)) throw new AppError('FORBIDDEN', 'You cannot change this deal.');
  assertVersion(ctx, row);
  if (deal.archivedAt) throw new AppError('INVALID_STATE', 'Archived deals are read-only.');
  if (row.status === 'accepted' || row.status === 'cancelled') throw new AppError('INVALID_STATE', 'Reopen the deliverable before editing it.');
  if (input.agreedAmount !== undefined && !canSeeDealAmounts(ctx, projectIds)) throw new AppError('FORBIDDEN', 'Agreed amounts need finance access to the deal’s projects.');
  const links = await resolveLinks(ctx, projectIds, input, row);
  const patch: Partial<DeliverableRow> = { ...links };
  if (input.title !== undefined) patch.title = input.title.trim();
  if (input.format !== undefined) patch.format = input.format;
  if (input.dueAt !== undefined) patch.dueAt = input.dueAt ? new Date(input.dueAt) : null;
  if (input.acceptanceCriteria !== undefined) patch.acceptanceCriteria = input.acceptanceCriteria?.trim() || null;
  if (input.agreedAmount !== undefined) {
    patch.agreedAmountMinor = input.agreedAmount ? parseAgreed(input.agreedAmount) : null;
    patch.currency = input.agreedAmount?.currency ?? null;
  }
  const [updated] = await ctx.tx.update(deliverables).set({ ...patch, ...touch(ctx, deliverables) }).where(eq(deliverables.id, id)).returning();
  const diff = diffFields(row, updated!, ['title', 'format', 'projectId', 'accountId', 'dueAt', 'acceptanceCriteria', 'contentItemId']);
  if (input.agreedAmount !== undefined) diff.agreedAmount = { from: '[finance]', to: '[finance]' };
  await audit(ctx, { action: 'deal.deliverable_updated', entityType: 'deal', entityId: deal.id, projectId: updated!.projectId ?? projectIds[0] ?? null, diff, metadata: { deliverableId: id } });
  await emit(ctx, { type: 'deal.deliverable_updated', entityType: 'deal', entityId: deal.id, payload: { deliverableId: id } });
  return (await deliverableViews(ctx, [updated!], projectIds))[0]!;
};

export const transitionDeliverable = async (ctx: CommandContext, id: string, input: { targetStatus: DeliverableStatus; reason?: string }) => {
  const { row, deal, projectIds } = await loadDeliverable(ctx, id, true);
  if (!canDeal(ctx, 'deals.write', deal, projectIds)) throw new AppError('FORBIDDEN', 'You cannot change this deal.');
  assertVersion(ctx, row);
  if (deal.archivedAt) throw new AppError('INVALID_STATE', 'Archived deals are read-only.');
  assertTransition(DELIVERABLE_TRANSITIONS, row.status, input.targetStatus, 'deliverable');
  const reason = input.reason?.trim();
  const needsReason = input.targetStatus === 'cancelled' || input.targetStatus === 'open';
  if (needsReason && !reason) {
    const message = input.targetStatus === 'cancelled' ? 'Say why the deliverable is cancelled.' : 'Say what needs to be reworked.';
    throw new AppError('VALIDATION_FAILED', message, { fieldErrors: [{ field: 'reason', code: 'REQUIRED', message }] });
  }
  const [updated] = await ctx.tx.update(deliverables).set({ status: input.targetStatus, ...touch(ctx, deliverables) }).where(eq(deliverables.id, id)).returning();
  await audit(ctx, {
    action: 'deal.deliverable_status_changed',
    entityType: 'deal',
    entityId: deal.id,
    projectId: row.projectId ?? projectIds[0] ?? null,
    reason: reason ?? null,
    diff: { status: { from: row.status, to: input.targetStatus } },
    metadata: { deliverableId: id, title: row.title },
  });
  await emit(ctx, { type: 'deal.deliverable_status_changed', entityType: 'deal', entityId: deal.id, payload: { deliverableId: id, from: row.status, to: input.targetStatus } });
  return (await deliverableViews(ctx, [updated!], projectIds))[0]!;
};
