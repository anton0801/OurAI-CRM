import { and, eq } from 'drizzle-orm';
import { accountAssignments } from '@castlane/database';
import { AppError, isAppError, newId, notFound } from '@castlane/domain';
import { authorizeObject, requirePermission } from '../core/access';
import { mapDbError } from '../core/command';
import { audit } from '../core/audit';
import type { CommandContext } from '../core/context';
import { emit } from '../core/events';
import { isActiveMember, loadMemberRefs, refOrUnknown } from '../core/members';
import { notify } from '../core/notify';
import { assertVersion, stamp, touch } from '../core/rows';
import { accountLabel, indexAccount, loadAccount } from './accounts';
import { bumpAccessRevision } from './helpers';
import { scopeOfAccount } from './scope';

type Duty = (typeof accountAssignments.$inferSelect)['duty'];

const view = async (ctx: CommandContext, row: typeof accountAssignments.$inferSelect) => {
  const refs = await loadMemberRefs(ctx.tx, ctx.actor.workspaceId, [row.membershipId, row.supervisorMembershipId]);
  return {
    id: row.id,
    member: refOrUnknown(refs, row.membershipId)!,
    duty: row.duty,
    supervisor: refOrUnknown(refs, row.supervisorMembershipId),
    validFrom: row.validFrom.toISOString(),
    validTo: row.validTo?.toISOString() ?? null,
    endedReason: row.endedReason,
    rowVersion: row.rowVersion,
  };
};

/**
 * Assign a member to an account with a duty. The assignment narrows role scopes (assigned
 * accounts) but never grants sensitive permissions; the member's access revision is bumped.
 */
export const assignAccountMember = async (
  ctx: CommandContext,
  accountId: string,
  input: { membershipId: string; duty: Duty; supervisorMembershipId?: string | null },
) => {
  const a = await loadAccount(ctx, accountId, { lock: true });
  authorizeObject(ctx, 'accounts.assign', await scopeOfAccount(ctx, a), 'accounts.read');
  if (a.status === 'archived') throw new AppError('INVALID_STATE', 'Archived accounts cannot get new assignments.');
  if (!(await isActiveMember(ctx.tx, ctx.actor.workspaceId, input.membershipId)))
    throw new AppError('VALIDATION_FAILED', 'Choose an active member.', { fieldErrors: [{ field: 'membershipId', code: 'INACTIVE', message: 'Choose an active member.' }] });
  if (input.supervisorMembershipId && !(await isActiveMember(ctx.tx, ctx.actor.workspaceId, input.supervisorMembershipId)))
    throw new AppError('VALIDATION_FAILED', 'The supervisor must be an active member.', { fieldErrors: [{ field: 'supervisorMembershipId', code: 'INACTIVE', message: 'The supervisor must be an active member.' }] });
  // One open assignment per member and duty (the unique partial index backs this check).
  const open = await ctx.tx
    .select()
    .from(accountAssignments)
    .where(and(eq(accountAssignments.workspaceId, ctx.actor.workspaceId), eq(accountAssignments.accountId, accountId), eq(accountAssignments.membershipId, input.membershipId), eq(accountAssignments.duty, input.duty)));
  if (open.some((r) => r.validTo === null)) throw new AppError('DUPLICATE', 'This member already has this duty on the account.');
  const id = newId();
  const at = ctx.app.clock.now();
  const [row] = await ctx.tx
    .insert(accountAssignments)
    .values({ ...stamp(ctx), id, accountId, membershipId: input.membershipId, duty: input.duty, supervisorMembershipId: input.supervisorMembershipId ?? null, validFrom: at })
    .returning();
  await bumpAccessRevision(ctx.tx, [input.membershipId]);
  await audit(ctx, { action: 'account.member_assigned', entityType: 'account', entityId: accountId, projectId: a.projectId, metadata: { membershipId: input.membershipId, duty: input.duty } });
  await emit(ctx, { type: 'account.member_assigned', entityType: 'account', entityId: accountId, payload: { assignmentId: id } });
  await indexAccount(ctx, a);
  await notify(ctx.tx, {
    workspaceId: ctx.actor.workspaceId,
    recipientMembershipIds: [input.membershipId],
    eventType: 'account.assigned',
    eventKey: `account.assigned:${id}`,
    kind: 'assignment',
    title: `You were assigned to ${accountLabel(a)}`,
    excerpt: `Duty: ${input.duty.replace(/_/g, ' ')}`,
    entityType: 'account',
    entityId: accountId,
    projectId: a.projectId,
    actorMembershipId: ctx.actor.membershipId,
    at,
  });
  return view(ctx, row!);
};

const loadAssignment = async (ctx: CommandContext, accountId: string, assignmentId: string) => {
  const [row] = await ctx.tx
    .select()
    .from(accountAssignments)
    .where(and(eq(accountAssignments.workspaceId, ctx.actor.workspaceId), eq(accountAssignments.id, assignmentId), eq(accountAssignments.accountId, accountId)))
    .for('update');
  if (!row) throw notFound('Assignment');
  return row;
};

export const updateAccountAssignment = async (ctx: CommandContext, accountId: string, assignmentId: string, input: { supervisorMembershipId: string | null }) => {
  const a = await loadAccount(ctx, accountId, { lock: true });
  authorizeObject(ctx, 'accounts.assign', await scopeOfAccount(ctx, a), 'accounts.read');
  const row = await loadAssignment(ctx, accountId, assignmentId);
  assertVersion(ctx, row);
  if (row.validTo) throw new AppError('INVALID_STATE', 'This assignment has ended.');
  if (input.supervisorMembershipId && !(await isActiveMember(ctx.tx, ctx.actor.workspaceId, input.supervisorMembershipId)))
    throw new AppError('VALIDATION_FAILED', 'The supervisor must be an active member.', { fieldErrors: [{ field: 'supervisorMembershipId', code: 'INACTIVE', message: 'The supervisor must be an active member.' }] });
  const [updated] = await ctx.tx
    .update(accountAssignments)
    .set({ supervisorMembershipId: input.supervisorMembershipId, ...touch(ctx, accountAssignments) })
    .where(eq(accountAssignments.id, assignmentId))
    .returning();
  await audit(ctx, {
    action: 'account.assignment_updated',
    entityType: 'account',
    entityId: accountId,
    projectId: a.projectId,
    diff: { supervisorMembershipId: { from: row.supervisorMembershipId, to: input.supervisorMembershipId } },
  });
  await emit(ctx, { type: 'account.assignment_updated', entityType: 'account', entityId: accountId });
  return view(ctx, updated!);
};

export const endAccountAssignment = async (ctx: CommandContext, accountId: string, assignmentId: string, reason?: string, opts: { skipAuth?: boolean } = {}) => {
  const a = await loadAccount(ctx, accountId, { lock: true });
  if (!opts.skipAuth) authorizeObject(ctx, 'accounts.assign', await scopeOfAccount(ctx, a), 'accounts.read');
  const row = await loadAssignment(ctx, accountId, assignmentId);
  if (row.validTo) throw new AppError('INVALID_STATE', 'This assignment has already ended.');
  await ctx.tx
    .update(accountAssignments)
    .set({ validTo: ctx.app.clock.now(), endedReason: reason ?? null, ...touch(ctx, accountAssignments) })
    .where(eq(accountAssignments.id, assignmentId));
  await bumpAccessRevision(ctx.tx, [row.membershipId]);
  await audit(ctx, { action: 'account.assignment_ended', entityType: 'account', entityId: accountId, projectId: a.projectId, reason: reason ?? null, metadata: { membershipId: row.membershipId, duty: row.duty } });
  await emit(ctx, { type: 'account.assignment_ended', entityType: 'account', entityId: accountId });
  await indexAccount(ctx, a);
  return { ok: true as const };
};

/**
 * Bulk Assign (S18): each account is authorised and applied in its own savepoint; failures are
 * reported per item and never undo the successful ones.
 */
export const bulkAssignAccounts = async (ctx: CommandContext, input: { accountIds: string[]; membershipId: string; duty: Duty }) => {
  requirePermission(ctx, 'accounts.assign');
  const results: { id: string; ok: boolean; code: string | null; message: string | null }[] = [];
  for (const accountId of [...new Set(input.accountIds)]) {
    try {
      await ctx.tx.transaction(async (sp) => {
        await assignAccountMember({ ...ctx, tx: sp }, accountId, { membershipId: input.membershipId, duty: input.duty });
      });
      results.push({ id: accountId, ok: true, code: null, message: null });
    } catch (raw) {
      const e = mapDbError(raw);
      if (!isAppError(e)) throw raw;
      results.push({ id: accountId, ok: false, code: e.code, message: e.message });
    }
  }
  return { results, succeeded: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length };
};
