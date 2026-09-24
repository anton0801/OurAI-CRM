import { sql } from 'drizzle-orm';
import { jobs, type DbOrTx } from '@castlane/database';
import { newId } from '@castlane/domain';

export type JobPool = 'light' | 'data' | 'media';

export interface EnqueueJobInput {
  type: string;
  workspaceId: string | null;
  payload?: Record<string, unknown>;
  pool?: JobPool;
  runAt?: Date;
  priority?: number;
  /** Deduplicates enqueues: the same key never creates a second job. */
  idempotencyKey?: string;
  requestedBy?: string | null;
  causation?: { rootEventId?: string; parentEventId?: string; depth?: number };
  maxRetries?: number;
}

/** Enqueue a background job in the caller's transaction (committed together with the change). */
export const enqueueJob = async (db: DbOrTx, input: EnqueueJobInput): Promise<string | null> => {
  const id = newId();
  const rows = await db
    .insert(jobs)
    .values({
      id,
      workspaceId: input.workspaceId,
      type: input.type,
      pool: input.pool ?? 'light',
      payload: input.payload ?? {},
      runAt: input.runAt ?? sql`now()`,
      priority: input.priority ?? 0,
      idempotencyKey: input.idempotencyKey ?? null,
      requestedBy: input.requestedBy ?? null,
      causation: input.causation ?? null,
      maxRetries: input.maxRetries ?? 5,
    })
    .onConflictDoNothing()
    .returning({ id: jobs.id });
  return rows[0]?.id ?? null;
};
