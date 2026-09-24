import { eq, isNull, sql } from 'drizzle-orm';
import { outboxEvents, withTransaction } from '@castlane/database';
import { OUTBOX_CONSUMERS, type AppServices, type OutboxEventRecord } from '@castlane/application';

/**
 * Transactional outbox dispatcher: reads undispatched events in order (SKIP LOCKED so several
 * workers can run), hands each to every interested consumer inside one transaction and marks it
 * dispatched. Consumers are idempotent, so a crash between steps only causes a harmless replay.
 */
export const dispatchOutboxBatch = async (app: AppServices, limit = 100): Promise<number> =>
  withTransaction(app.db, async (tx) => {
    const rows = await tx
      .select()
      .from(outboxEvents)
      .where(isNull(outboxEvents.dispatchedAt))
      .orderBy(outboxEvents.seq)
      .limit(limit)
      .for('update', { skipLocked: true });
    for (const r of rows) {
      const event: OutboxEventRecord = {
        id: r.id,
        workspaceId: r.workspaceId,
        eventType: r.eventType,
        entityType: r.entityType,
        entityId: r.entityId,
        payload: r.payload,
        actorMembershipId: r.actorMembershipId,
        occurredAt: r.occurredAt,
        rootEventId: r.rootEventId,
        parentEventId: r.parentEventId,
        depth: r.depth,
      };
      try {
        for (const c of OUTBOX_CONSUMERS) {
          if (c.events !== '*' && !c.events.includes(r.eventType)) continue;
          await tx.execute(sql`SAVEPOINT consumer`);
          try {
            await c.handle(tx, event, app);
            await tx.execute(sql`RELEASE SAVEPOINT consumer`);
          } catch (e) {
            await tx.execute(sql`ROLLBACK TO SAVEPOINT consumer`);
            throw Object.assign(e as Error, { consumer: c.name });
          }
        }
        await tx.update(outboxEvents).set({ dispatchedAt: app.clock.now(), dispatchAttempts: r.dispatchAttempts + 1, lastError: null }).where(eq(outboxEvents.id, r.id));
      } catch (e) {
        const msg = `${(e as { consumer?: string }).consumer ?? 'consumer'}: ${(e as Error).message}`.slice(0, 500);
        app.logger.error('outbox_consumer_failed', { eventId: r.id, type: r.eventType, error: msg });
        // Leave undispatched for retry, but stop after 10 attempts to avoid blocking the queue forever.
        await tx
          .update(outboxEvents)
          .set({ dispatchAttempts: r.dispatchAttempts + 1, lastError: msg, dispatchedAt: r.dispatchAttempts + 1 >= 10 ? app.clock.now() : null })
          .where(eq(outboxEvents.id, r.id));
      }
    }
    return rows.length;
  });
