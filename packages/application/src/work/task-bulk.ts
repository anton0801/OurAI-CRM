import { and, asc, eq, inArray } from 'drizzle-orm';
import { bulkPreviews, tasks } from '@castlane/database';
import type { BulkAction, TaskListQuery } from '@castlane/api-contracts';
import { AppError, isAppError, newId } from '@castlane/domain';
import { allowed, requirePermission } from '../core/access';
import { mapDbError } from '../core/command';
import type { CommandContext } from '../core/context';
import { stamp } from '../core/rows';
import { shiftDue } from './rules/due';
import { evaluateTransition, loadTransitionFacts, transitionTask } from './task-transitions';
import { taskFilterSql } from './task-read';
import { updateTask } from './tasks';
import { taskScope, type TaskRowDb } from './shared';

const PREVIEW_TTL_MS = 10 * 60_000;
const MAX_TARGETS = 2000;

type Selection = { ids: string[] } | { filter: Omit<TaskListQuery, 'cursor' | 'pageSize' | 'sort' | 'direction'>; expectedCount: number };
type ItemStatus = 'ok' | 'forbidden' | 'conflict' | 'invalid';

/** Classify one task for a bulk change without writing anything. */
const classify = async (ctx: CommandContext, t: TaskRowDb, change: BulkAction): Promise<{ status: ItemStatus; reason: string | null }> => {
  const scope = taskScope(t);
  if (t.archivedAt) return { status: 'invalid', reason: 'Archived' };
  const closed = t.status === 'done' || t.status === 'cancelled';
  switch (change.action) {
    case 'assign':
      if (!allowed(ctx, 'tasks.assign', scope)) return { status: 'forbidden', reason: 'You cannot assign this task.' };
      if (closed) return { status: 'invalid', reason: 'The task is closed.' };
      if (!change.assigneeMembershipId && (t.status === 'in_progress' || t.status === 'in_review')) return { status: 'invalid', reason: 'Work in progress needs an assignee.' };
      if (change.assigneeMembershipId && change.assigneeMembershipId === t.reviewerMembershipId) return { status: 'invalid', reason: 'The reviewer cannot also be the assignee.' };
      return { status: 'ok', reason: null };
    case 'reschedule':
      if (!allowed(ctx, 'tasks.edit', scope)) return { status: 'forbidden', reason: 'You cannot edit this task.' };
      if (closed) return { status: 'invalid', reason: 'The task is closed.' };
      if (change.shiftDays !== undefined && !t.dueAt) return { status: 'invalid', reason: 'The task has no deadline to move.' };
      return { status: 'ok', reason: null };
    case 'priority':
    case 'add_tags':
      if (!allowed(ctx, 'tasks.edit', scope)) return { status: 'forbidden', reason: 'You cannot edit this task.' };
      if (closed && change.action === 'priority') return { status: 'invalid', reason: 'The task is closed.' };
      return { status: 'ok', reason: null };
    case 'status': {
      if (t.status === change.targetState) return { status: 'invalid', reason: 'Already in this status.' };
      const facts = await loadTransitionFacts(ctx, t);
      const ev = evaluateTransition(ctx, t, change.targetState, facts, { reason: change.reason, successorPolicy: 'keep_blocked' });
      if (!ev.ok) return { status: ev.code === 'FORBIDDEN' ? 'forbidden' : 'invalid', reason: ev.message };
      if (ev.needsReason && !change.reason) return { status: 'invalid', reason: 'A reason is required for this change.' };
      return { status: 'ok', reason: null };
    }
  }
};

/**
 * Dry run: resolve the selection (explicit ids, or every task matching a validated filter snapshot
 * inside the actor's scope), classify each target and store a 10-minute token with the versions.
 */
export const bulkPreview = async (ctx: CommandContext, input: { selection: Selection; change: BulkAction }) => {
  requirePermission(ctx, 'tasks.read');
  let rows: TaskRowDb[];
  if ('ids' in input.selection) {
    rows = await ctx.tx.select().from(tasks).where(and(eq(tasks.workspaceId, ctx.actor.workspaceId), inArray(tasks.id, input.selection.ids)));
    // Ids outside the scope are simply not part of the preview (their existence is not revealed).
    rows = rows.filter((r) => !r.deletedAt && allowed(ctx, 'tasks.read', taskScope(r)));
  } else {
    rows = await ctx.tx
      .select()
      .from(tasks)
      .where(taskFilterSql(ctx, input.selection.filter))
      .orderBy(asc(tasks.id))
      .limit(MAX_TARGETS + 1);
    if (rows.length > MAX_TARGETS) throw new AppError('VALIDATION_FAILED', `Bulk changes are limited to ${MAX_TARGETS} tasks. Narrow the filters.`);
    if (rows.length !== input.selection.expectedCount)
      throw new AppError('CONFLICT', 'The number of matching tasks changed. Review the selection again.', { details: { expected: input.selection.expectedCount, actual: rows.length } });
  }
  const items: { id: string; title: string | null; status: ItemStatus; reason: string | null }[] = [];
  for (const r of rows) {
    const c = await classify(ctx, r, input.change);
    items.push({ id: r.id, title: r.title, ...c });
  }
  const token = newId();
  const expiresAt = new Date(ctx.app.clock.now().getTime() + PREVIEW_TTL_MS);
  await ctx.tx.insert(bulkPreviews).values({
    ...stamp(ctx),
    id: token,
    actorMembershipId: ctx.actor.membershipId!,
    action: `task.bulk.${input.change.action}`,
    params: input.change as unknown as Record<string, unknown>,
    targets: rows.map((r, i) => ({ type: 'task', id: r.id, rowVersion: r.rowVersion, status: items[i]!.status === 'ok' ? 'ok' : items[i]!.status === 'forbidden' ? 'forbidden' : 'conflict' })),
    accessRevision: ctx.actor.access.accessRevision,
    summary: { total: rows.length },
    expiresAt,
  });
  const counts = { ok: 0, forbidden: 0, conflict: 0, invalid: 0 };
  for (const i of items) counts[i.status]++;
  return { token, expiresAt: expiresAt.toISOString(), total: items.length, counts, items };
};

/** Apply one target inside a savepoint so each task succeeds or fails on its own. */
const applyOne = async (ctx: CommandContext, id: string, expectedVersion: number, change: BulkAction) => {
  const sub: CommandContext = { ...ctx, request: { ...ctx.request, expectedVersion } };
  switch (change.action) {
    case 'assign':
      await updateTask(sub, id, { assigneeMembershipId: change.assigneeMembershipId });
      return;
    case 'priority':
      await updateTask(sub, id, { priority: change.priority });
      return;
    case 'add_tags': {
      const [t] = await ctx.tx.select({ tags: tasks.tags }).from(tasks).where(eq(tasks.id, id));
      await updateTask(sub, id, { tags: [...new Set([...(t?.tags ?? []), ...change.tags])] });
      return;
    }
    case 'reschedule': {
      if (change.due !== undefined) {
        await updateTask(sub, id, { due: change.due, dueReason: 'Bulk reschedule' });
        return;
      }
      const [t] = await ctx.tx.select().from(tasks).where(eq(tasks.id, id));
      if (!t?.dueAt) throw new AppError('INVALID_STATE', 'The task has no deadline to move.');
      const moved = shiftDue({ dueAt: t.dueAt, dueDate: t.dueDate, dueTimezone: t.dueTimezone }, change.shiftDays ?? 0);
      await updateTask(sub, id, {
        due: moved.dueDate ? { kind: 'date', date: moved.dueDate, timezone: moved.dueTimezone! } : { kind: 'datetime', at: moved.dueAt.toISOString(), timezone: moved.dueTimezone },
        startAt: t.startAt ? new Date(t.startAt.getTime() + (change.shiftDays ?? 0) * 86_400_000).toISOString() : undefined,
        dueReason: `Bulk reschedule (${change.shiftDays ?? 0} days)`,
      });
      return;
    }
    case 'status':
      await transitionTask(sub, id, { targetState: change.targetState, reason: change.reason, successorPolicy: 'keep_blocked' });
      return;
  }
};

export const bulkApply = async (ctx: CommandContext, input: { previewToken: string; onlyIds?: string[] }) => {
  const [p] = await ctx.tx.select().from(bulkPreviews).where(and(eq(bulkPreviews.workspaceId, ctx.actor.workspaceId), eq(bulkPreviews.id, input.previewToken))).for('update');
  if (!p || p.actorMembershipId !== ctx.actor.membershipId || !p.action.startsWith('task.bulk.')) throw new AppError('VALIDATION_FAILED', 'Preview the bulk change again.');
  if (p.expiresAt.getTime() < ctx.app.clock.now().getTime()) throw new AppError('INVALID_STATE', 'The preview expired. Preview the bulk change again.');
  if (p.accessRevision !== ctx.actor.access.accessRevision) throw new AppError('CONFLICT', 'Your access changed since the preview. Preview again.');
  const change = p.params as unknown as BulkAction;
  const only = input.onlyIds ? new Set(input.onlyIds) : null;
  const targets = p.targets.filter((t) => t.status === 'ok' && (!only || only.has(t.id)));
  const results: { id: string; ok: boolean; code: string | null; message: string | null }[] = [];
  for (const target of targets) {
    try {
      await ctx.tx.transaction(async (sp) => {
        await applyOne({ ...ctx, tx: sp as unknown as CommandContext['tx'] }, target.id, target.rowVersion, change);
      });
      results.push({ id: target.id, ok: true, code: null, message: null });
    } catch (e) {
      const err = mapDbError(e);
      results.push({
        id: target.id,
        ok: false,
        code: isAppError(err) ? (err.code === 'VERSION_CONFLICT' ? 'CONFLICT' : err.code) : 'INTERNAL',
        message: isAppError(err) ? (err.code === 'VERSION_CONFLICT' ? 'The task changed after the preview.' : err.message) : 'The change could not be applied.',
      });
    }
  }
  // The token may be re-used for "Retry Failures" with the same targets until it expires.
  return { succeeded: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results };
};
