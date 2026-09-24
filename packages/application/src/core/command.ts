import { and, eq, sql } from 'drizzle-orm';
import { hasAnywhere } from '@castlane/authorization';
import { idempotencyRecords, memberships, pgConstraint, pgErrorCode, withTransaction, type Tx } from '@castlane/database';
import { AppError, isAppError, newId } from '@castlane/domain';
import type { CommandContext, QueryContext } from './context';

export interface IdempotencyOptions {
  /** Stable route identifier (e.g. endpoint id). */
  routeKey: string;
  /** Client-provided Idempotency-Key (UUID). */
  key: string;
  /** Hash of the normalised request (params + body). */
  requestHash: string;
  /** Permission that must still be held to replay a stored response. */
  replayPermission?: string;
}

export interface CommandResult<T> {
  status: number;
  body: T;
  replayed: boolean;
}

const IDEMPOTENCY_TTL_MS = 7 * 24 * 3_600_000;

/**
 * Translate well-known database constraint violations into domain errors. Uniqueness is always
 * enforced by the database, so two concurrent requests with different keys still cannot
 * create two economic facts.
 */
export const mapDbError = (e: unknown): unknown => {
  if (isAppError(e)) return e;
  const code = pgErrorCode(e);
  const constraint = pgConstraint(e);
  if (code === '23505') return new AppError('DUPLICATE', 'A record with the same unique identity already exists.', { details: { constraint } });
  if (code === '23503') return new AppError('CONFLICT', 'A referenced record does not exist or belongs to another workspace.', { details: { constraint } });
  if (code === '23514') return new AppError('VALIDATION_FAILED', 'The change violates a data rule.', { details: { constraint } });
  if (code === '55P03') return new AppError('OPERATION_IN_PROGRESS', 'The record is being changed by another operation. Try again.', { retryable: true, retryAfterSeconds: 2 });
  return e;
};

/**
 * Run a write use case in one transaction:
 *   authorize (done by caller) → idempotency lookup/insert → use case (If-Match, invariants,
 *   domain writes, audit, outbox) → store response → commit.
 * A retried request with the same key and body returns the original result; the same key with a
 * different body is rejected. Serialization failures retry the whole transaction.
 */
export const executeCommand = async <T>(
  base: QueryContext,
  fn: (ctx: CommandContext) => Promise<T>,
  opts: { idempotency?: IdempotencyOptions; successStatus?: number; isolationLevel?: 'read committed' | 'repeatable read' | 'serializable' } = {},
): Promise<CommandResult<T>> => {
  const status = opts.successStatus ?? 200;
  try {
    return await withTransaction(
      base.app.db,
      async (tx: Tx) => {
        const ctx: CommandContext = { ...base, tx, emitted: [] };
        // Lock the actor's membership row: a concurrent revocation serialises with this command,
        // and a deactivated membership cannot commit writes.
        if (base.actor.kind === 'user' && base.actor.membershipId) {
          const [m] = await tx
            .select({ status: memberships.status, accessRevision: memberships.accessRevision })
            .from(memberships)
            .where(eq(memberships.id, base.actor.membershipId))
            .for('share');
          if (!m || m.status !== 'active') throw new AppError('FORBIDDEN', 'Your access to this workspace has changed.');
          if (m.accessRevision !== base.actor.access.accessRevision)
            throw new AppError('FORBIDDEN', 'Your access to this item has changed. Reload and try again.', { retryable: true });
        }

        const idem = opts.idempotency;
        let recordId: string | null = null;
        if (idem) {
          const scopeKey = `${base.actor.workspaceId}:${base.actor.userId ?? base.actor.kind}:${idem.routeKey}:${idem.key}`;
          await tx.execute(sql`SET LOCAL lock_timeout = '3s'`);
          const inserted = await tx
            .insert(idempotencyRecords)
            .values({
              id: newId(),
              scopeKey,
              workspaceId: base.actor.workspaceId,
              actorUserId: base.actor.userId,
              routeKey: idem.routeKey,
              idempotencyKey: idem.key,
              requestHash: idem.requestHash,
              state: 'pending',
              expiresAt: new Date(base.app.clock.now().getTime() + IDEMPOTENCY_TTL_MS),
            })
            .onConflictDoNothing()
            .returning({ id: idempotencyRecords.id });
          await tx.execute(sql`SET LOCAL lock_timeout = '0'`);
          if (inserted.length === 0) {
            const [existing] = await tx.select().from(idempotencyRecords).where(eq(idempotencyRecords.scopeKey, scopeKey));
            if (!existing) throw new AppError('OPERATION_IN_PROGRESS', 'The same operation is still running.', { retryAfterSeconds: 2 });
            if (existing.requestHash !== idem.requestHash)
              throw new AppError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'This Idempotency-Key was already used with a different request.');
            if (existing.state !== 'completed')
              throw new AppError('OPERATION_IN_PROGRESS', 'The same operation is still running.', { retryAfterSeconds: 2 });
            if (idem.replayPermission && !hasAnywhere(base.actor.access, idem.replayPermission))
              throw new AppError('FORBIDDEN', 'You no longer have permission to view this result.');
            return { status: existing.responseStatus ?? status, body: existing.responseBody as T, replayed: true };
          }
          recordId = inserted[0]!.id;
        }

        const body = await fn(ctx);

        if (recordId) {
          await tx
            .update(idempotencyRecords)
            .set({ state: 'completed', responseStatus: status, responseBody: body as unknown, completedAt: base.app.clock.now() })
            .where(and(eq(idempotencyRecords.id, recordId)));
        }
        return { status, body, replayed: false };
      },
      { isolationLevel: opts.isolationLevel },
    );
  } catch (e) {
    if (pgErrorCode(e) === '55P03' && opts.idempotency)
      throw new AppError('OPERATION_IN_PROGRESS', 'The same operation is still running.', { retryAfterSeconds: 2 });
    throw mapDbError(e);
  }
};

/** Run a system/worker command without idempotency bookkeeping (jobs have their own keys). */
export const executeSystemCommand = <T>(base: QueryContext, fn: (ctx: CommandContext) => Promise<T>) =>
  executeCommand(base, fn).then((r) => r.body);
