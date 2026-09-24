import { tasks } from '@castlane/database';
import { newId } from '@castlane/domain';
import { audit } from '../core/audit';
import type { CommandContext } from '../core/context';
import { emit } from '../core/events';
import { notify } from '../core/notify';
import { stamp } from '../core/rows';
import { indexSearchDocument } from '../core/search';

/**
 * INTEGRATION POINT (report to lead): OFM creates tasks by inserting into the tasks table directly —
 * content request briefs (T097), handover "Convert Item to Task" and quality improvement tasks.
 * When the tasks module exposes its own create helper, replace the body of this single function.
 *
 * The description carries only the text the author typed for the task (the permitted brief). OFM
 * contact aliases, business notes and interaction history are never copied into production records.
 */
export const createOfmTask = async (
  ctx: CommandContext,
  input: {
    projectId: string;
    accountId: string | null;
    title: string;
    description: string | null;
    assigneeMembershipId: string | null;
    dueAt: Date | null;
    priority?: 'low' | 'normal' | 'high' | 'urgent';
    shiftId?: string | null;
    operationId?: string | null;
    source: 'manual' | 'handover';
    notifyTitle: string;
  },
): Promise<string> => {
  const id = newId();
  const at = ctx.app.clock.now();
  await ctx.tx.insert(tasks).values({
    ...stamp(ctx),
    id,
    projectId: input.projectId,
    accountId: input.accountId,
    title: input.title.trim(),
    description: input.description,
    status: input.assigneeMembershipId ? 'ready' : 'backlog',
    priority: input.priority ?? 'normal',
    assigneeMembershipId: input.assigneeMembershipId,
    dueAt: input.dueAt,
    baselineDueAt: input.dueAt,
    shiftId: input.shiftId ?? null,
    operationId: input.operationId ?? null,
    source: input.source,
  });
  await audit(ctx, {
    action: 'task.created',
    entityType: 'task',
    entityId: id,
    projectId: input.projectId,
    metadata: { origin: 'ofm', source: input.source, operationId: input.operationId ?? null, shiftId: input.shiftId ?? null },
  });
  await emit(ctx, { type: 'task.created', entityType: 'task', entityId: id, revision: 1, payload: { origin: 'ofm' } });
  await indexSearchDocument(ctx.tx, {
    workspaceId: ctx.actor.workspaceId,
    entityType: 'task',
    entityId: id,
    title: input.title.trim(),
    body: input.description ?? '',
    projectId: input.projectId,
    accountId: input.accountId,
    permission: 'tasks.read',
    assigneeMembershipIds: input.assigneeMembershipId ? [input.assigneeMembershipId] : [],
    status: input.assigneeMembershipId ? 'ready' : 'backlog',
    at,
  });
  if (input.assigneeMembershipId)
    await notify(ctx.tx, {
      workspaceId: ctx.actor.workspaceId,
      recipientMembershipIds: [input.assigneeMembershipId],
      eventType: 'task.assigned',
      eventKey: `task.assigned:${id}:${input.assigneeMembershipId}`,
      kind: 'assignment',
      title: input.notifyTitle,
      excerpt: input.title.trim(),
      entityType: 'task',
      entityId: id,
      projectId: input.projectId,
      actorMembershipId: ctx.actor.membershipId,
      at,
    });
  return id;
};
