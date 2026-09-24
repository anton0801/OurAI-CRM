import { and, count, desc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import {
  accountIdentityHistory,
  accountStatusEvents,
  accountTransfers,
  auditEvents,
  ofmAssignments,
  projects,
  publications,
  reviews,
  shifts,
  socialAccounts,
  tasks,
} from '@castlane/database';
import { AppError, newId } from '@castlane/domain';
import type { ImpactItem } from '@castlane/api-contracts';
import { allowed, authorizeObject, authorizeRead } from '../core/access';
import { audit } from '../core/audit';
import { all, dbOf, type CommandContext, type QueryContext } from '../core/context';
import { emit } from '../core/events';
import { assertVersion, stamp, touch } from '../core/rows';
import { indexAccount, loadAccount } from './accounts';
import { entityActivity, projectNames, signPreviewToken, verifyPreviewToken } from './helpers';
import { scopeOfAccount, type AccountRow } from './scope';

/**
 * Transfer an account to another project (section 9). Account history stays single; existing
 * publications, tasks, metrics and finance keep their project at creation (T032), new records
 * get the new project. Active shifts and pending reviews on the account block the move (T031).
 */
const transferObligations = async (ctx: QueryContext | CommandContext, a: AccountRow): Promise<ImpactItem[]> => {
  const db = dbOf(ctx);
  const ws = a.workspaceId;
  const now = ctx.app.clock.now();
  const shiftOnAccount = or(eq(shifts.primaryAccountId, a.id), sql`EXISTS (SELECT 1 FROM shift_accounts sa WHERE sa.shift_id = ${shifts.id} AND sa.account_id = ${a.id})`);
  const [active, scheduledShifts, pendingContentReviews, pendingShiftReports, scheduledPubs, ofm, openTasks] = await all(ctx, [
    () => db.select({ n: count() }).from(shifts).where(and(eq(shifts.workspaceId, ws), shiftOnAccount, inArray(shifts.state, ['active', 'paused']))),
    () => db.select({ n: count() }).from(shifts).where(and(eq(shifts.workspaceId, ws), shiftOnAccount, eq(shifts.state, 'scheduled'))),
    // Content reviews awaiting a decision whose placements are planned on this account.
    () =>
      db
        .select({ n: count() })
        .from(reviews)
        .where(
          and(
            eq(reviews.workspaceId, ws),
            eq(reviews.status, 'pending'),
            eq(reviews.targetType, 'content_version'),
            sql`EXISTS (SELECT 1 FROM publications p WHERE p.content_item_id = ${reviews.subjectId} AND p.account_id = ${a.id} AND p.status IN ('draft', 'scheduled'))`,
          ),
        ),
    () => db.select({ n: count() }).from(shifts).where(and(eq(shifts.workspaceId, ws), shiftOnAccount, eq(shifts.reportState, 'submitted'))),
    () => db.select({ n: count() }).from(publications).where(and(eq(publications.workspaceId, ws), eq(publications.accountId, a.id), eq(publications.status, 'scheduled'))),
    () =>
      db
        .select({ n: count() })
        .from(ofmAssignments)
        .where(and(eq(ofmAssignments.workspaceId, ws), eq(ofmAssignments.accountId, a.id), isNull(ofmAssignments.endedAt), or(isNull(ofmAssignments.validTo), gt(ofmAssignments.validTo, now)))),
    () => db.select({ n: count() }).from(tasks).where(and(eq(tasks.workspaceId, ws), eq(tasks.accountId, a.id), inArray(tasks.status, ['draft', 'backlog', 'ready', 'in_progress', 'in_review']), isNull(tasks.deletedAt))),
  ] as const);
  const n = (r: { n: number }[]) => Number(r[0]?.n ?? 0);
  return [
    { kind: 'active_shifts', label: 'Active OFM shifts on this account', count: n(active), blocking: n(active) > 0, resolution: 'End the active shifts first.' },
    { kind: 'scheduled_shifts', label: 'Scheduled OFM shifts', count: n(scheduledShifts), blocking: n(scheduledShifts) > 0, resolution: 'Cancel or reassign the scheduled shifts.' },
    { kind: 'pending_content_reviews', label: 'Pending reviews of content planned on this account', count: n(pendingContentReviews), blocking: n(pendingContentReviews) > 0, resolution: 'Decide or cancel the reviews first.' },
    { kind: 'pending_shift_reports', label: 'Shift reports awaiting review', count: n(pendingShiftReports), blocking: n(pendingShiftReports) > 0, resolution: 'Approve or return the shift reports first.' },
    { kind: 'scheduled_publications', label: 'Scheduled publications', count: n(scheduledPubs), blocking: false, resolution: 'They keep their current project attribution.' },
    { kind: 'ofm_assignments', label: 'Open OFM assignments', count: n(ofm), blocking: false, resolution: 'They stay with the current project; review them after the move.' },
    { kind: 'open_tasks', label: 'Open tasks linked to the account', count: n(openTasks), blocking: false, resolution: 'Existing tasks keep their project.' },
  ].filter((i) => i.count > 0);
};

const loadTargetProject = async (ctx: QueryContext | CommandContext, targetProjectId: string, current: AccountRow) => {
  const [p] = await dbOf(ctx).select().from(projects).where(and(eq(projects.workspaceId, ctx.actor.workspaceId), eq(projects.id, targetProjectId)));
  const invalid = (message: string) => new AppError('VALIDATION_FAILED', message, { fieldErrors: [{ field: 'targetProjectId', code: 'INVALID', message }] });
  if (!p || p.deletedAt) throw invalid('Choose a project you can access.');
  const scope = { objectType: 'project', objectId: p.id, projectId: p.id, directionId: p.directionId, ownerMembershipId: p.ownerMembershipId };
  if (!allowed(ctx, 'accounts.write', scope)) {
    if (!allowed(ctx, 'projects.read', scope)) throw invalid('Choose a project you can access.');
    throw new AppError('FORBIDDEN', 'You cannot move accounts into this project.');
  }
  if (p.id === current.projectId) throw invalid('The account already belongs to this project.');
  if (p.status === 'archived') throw invalid('Archived projects cannot receive accounts.');
  return p;
};

export const accountTransferPreview = async (ctx: QueryContext, accountId: string, targetProjectId: string) => {
  const a = await loadAccount(ctx, accountId);
  authorizeObject(ctx, 'accounts.write', await scopeOfAccount(ctx, a), 'accounts.read');
  if (a.status === 'archived') throw new AppError('INVALID_STATE', 'Archived accounts cannot be transferred.');
  const target = await loadTargetProject(ctx, targetProjectId, a);
  const from = (await projectNames(ctx, [a.projectId])).get(a.projectId);
  const items = await transferObligations(ctx, a);
  const blocked = items.some((i) => i.blocking);
  const token = blocked ? null : signPreviewToken(ctx, 'account.transfer', [a.id, target.id, a.rowVersion]);
  return {
    account: { id: a.id, handle: a.handle, rowVersion: a.rowVersion },
    fromProject: { id: a.projectId, name: from?.name ?? 'Unknown project' },
    toProject: { id: target.id, name: target.name },
    items,
    blocked,
    impactToken: token?.token ?? null,
    expiresAt: token ? token.expiresAt.toISOString() : null,
  };
};

export const transferAccount = async (ctx: CommandContext, accountId: string, input: { targetProjectId: string; impactToken: string; reason: string }) => {
  const a = await loadAccount(ctx, accountId, { lock: true });
  authorizeObject(ctx, 'accounts.write', await scopeOfAccount(ctx, a), 'accounts.read');
  assertVersion(ctx, a);
  if (a.status === 'archived') throw new AppError('INVALID_STATE', 'Archived accounts cannot be transferred.');
  const target = await loadTargetProject(ctx, input.targetProjectId, a);
  verifyPreviewToken(ctx, 'account.transfer', [a.id, target.id, a.rowVersion], input.impactToken);
  // Re-check under the row lock: obligations may have appeared since the preview.
  const blocking = (await transferObligations(ctx, a)).filter((i) => i.blocking);
  if (blocking.length) throw new AppError('INVALID_STATE', 'Resolve the open obligations before transferring this account.', { details: { items: blocking } });
  const at = ctx.app.clock.now();
  const [row] = await ctx.tx.update(socialAccounts).set({ projectId: target.id, ...touch(ctx, socialAccounts) }).where(eq(socialAccounts.id, accountId)).returning();
  await ctx.tx.insert(accountTransfers).values({ ...stamp(ctx), id: newId(), accountId, fromProjectId: a.projectId, toProjectId: target.id, transferredAt: at, reason: input.reason.trim() });
  await audit(ctx, {
    action: 'account.transferred',
    entityType: 'account',
    entityId: accountId,
    projectId: target.id,
    reason: input.reason,
    diff: { projectId: { from: a.projectId, to: target.id } },
  });
  // The previous project's history shows the move too.
  await audit(ctx, { action: 'project.account_transferred_out', entityType: 'project', entityId: a.projectId, projectId: a.projectId, reason: input.reason, metadata: { accountId, toProjectId: target.id } });
  await emit(ctx, { type: 'account.transferred', entityType: 'account', entityId: accountId, revision: row!.rowVersion, payload: { fromProjectId: a.projectId, toProjectId: target.id } });
  await indexAccount(ctx, row!);
  return accountId;
};

// ——— History & activity ———

export const accountHistory = async (ctx: QueryContext, accountId: string) => {
  const a = await loadAccount(ctx, accountId);
  authorizeRead(ctx, 'accounts.read', await scopeOfAccount(ctx, a));
  const db = ctx.app.db;
  const ws = ctx.actor.workspaceId;
  const [identity, status, transfers, actors] = await all(ctx, [
    () => db.select().from(accountIdentityHistory).where(and(eq(accountIdentityHistory.workspaceId, ws), eq(accountIdentityHistory.accountId, accountId))).orderBy(desc(accountIdentityHistory.effectiveAt)),
    () => db.select().from(accountStatusEvents).where(and(eq(accountStatusEvents.workspaceId, ws), eq(accountStatusEvents.accountId, accountId))).orderBy(desc(accountStatusEvents.occurredAt), desc(accountStatusEvents.createdAt)),
    () => db.select().from(accountTransfers).where(and(eq(accountTransfers.workspaceId, ws), eq(accountTransfers.accountId, accountId))).orderBy(desc(accountTransfers.transferredAt)),
    () =>
      db
        .select({ userId: auditEvents.actorUserId, name: auditEvents.actorDisplay })
        .from(auditEvents)
        .where(and(eq(auditEvents.workspaceId, ws), eq(auditEvents.entityType, 'account'), eq(auditEvents.entityId, accountId)))
        .limit(500),
  ] as const);
  const nameByUser = new Map(actors.filter((x) => x.userId).map((x) => [x.userId!, x.name]));
  const names = await projectNames(ctx, transfers.flatMap((t) => [t.fromProjectId, t.toProjectId]));
  // Project names are shown only where the actor can read that project (no cross-project leak).
  const projectRef = (id: string) => {
    const p = names.get(id);
    if (!p) return null;
    const readable = allowed(ctx, 'projects.read', { projectId: p.id, directionId: p.directionId, ownerMembershipId: p.ownerMembershipId }) || allowed(ctx, 'accounts.read', { projectId: p.id });
    return readable ? { id: p.id, name: p.name } : null;
  };
  return {
    identity: identity.map((h) => ({
      id: h.id,
      oldHandle: h.oldHandle,
      newHandle: h.newHandle,
      oldUrl: h.oldUrl,
      newUrl: h.newUrl,
      effectiveAt: h.effectiveAt.toISOString(),
      reason: h.reason,
      actorName: h.createdBy ? (nameByUser.get(h.createdBy) ?? null) : null,
    })),
    status: status.map((s) => ({
      id: s.id,
      fromStatus: s.fromStatus,
      toStatus: s.toStatus,
      reason: s.reason,
      occurredAt: s.occurredAt.toISOString(),
      actorName: s.createdBy ? (nameByUser.get(s.createdBy) ?? null) : null,
    })),
    transfers: transfers.map((t) => ({
      id: t.id,
      fromProject: projectRef(t.fromProjectId),
      toProject: projectRef(t.toProjectId),
      transferredAt: t.transferredAt.toISOString(),
      reason: t.reason,
      actorName: t.createdBy ? (nameByUser.get(t.createdBy) ?? null) : null,
    })),
  };
};

export const accountActivity = async (ctx: QueryContext, accountId: string, input: { cursor?: string; pageSize?: number }) => {
  const a = await loadAccount(ctx, accountId);
  authorizeRead(ctx, 'accounts.read', await scopeOfAccount(ctx, a));
  return entityActivity(ctx, ['account'], accountId, input);
};
