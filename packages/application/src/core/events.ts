import { eventStream, outboxEvents, type DbOrTx } from '@castlane/database';
import { newId } from '@castlane/domain';
import type { CommandContext } from './context';

export interface DomainEventInput {
  type: string;
  entityType: string;
  entityId: string;
  /** Row version after the change (for SSE clients to decide whether to refetch). */
  revision?: number;
  /** Safe payload: ids and state names only, never restricted text or amounts. */
  payload?: Record<string, unknown>;
}

/**
 * Emit a domain event: outbox row (consumed at-least-once by the worker) plus a safe change
 * feed row for SSE. Both are written in the caller's transaction.
 */
export const emit = async (ctx: CommandContext, e: DomainEventInput): Promise<string> => {
  const id = newId();
  const causation = ctx.request.causation;
  await ctx.tx.insert(outboxEvents).values({
    id,
    workspaceId: ctx.actor.workspaceId,
    eventType: e.type,
    entityType: e.entityType,
    entityId: e.entityId,
    payload: e.payload ?? {},
    actorMembershipId: ctx.actor.membershipId,
    occurredAt: ctx.app.clock.now(),
    rootEventId: causation?.rootEventId ?? id,
    parentEventId: causation?.parentEventId ?? null,
    depth: causation ? causation.depth + 1 : 0,
  });
  await ctx.tx.insert(eventStream).values({
    workspaceId: ctx.actor.workspaceId,
    kind: 'entity_changed',
    entityType: e.entityType,
    entityId: e.entityId,
    revision: e.revision ?? null,
  });
  ctx.emitted.push({ id, type: e.type });
  return id;
};

/** Low-level stream insert (inbox counters, job progress, access changes). */
export const streamEvent = async (
  db: DbOrTx,
  e: {
    workspaceId: string;
    kind: 'entity_changed' | 'inbox' | 'job_progress' | 'access_changed';
    entityType?: string;
    entityId?: string;
    revision?: number;
    recipientMembershipId?: string;
  },
): Promise<void> => {
  await db.insert(eventStream).values({
    workspaceId: e.workspaceId,
    kind: e.kind,
    entityType: e.entityType ?? null,
    entityId: e.entityId ?? null,
    revision: e.revision ?? null,
    recipientMembershipId: e.recipientMembershipId ?? null,
  });
};
