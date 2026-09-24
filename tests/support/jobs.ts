import { and, eq, inArray, lte } from 'drizzle-orm';
import { jobs } from '@castlane/database';
import { JOB_DEFINITIONS, getAppServices } from '@castlane/application';

/**
 * Run queued jobs in-process (the worker's handler registry), for deterministic integration tests.
 * Returns results by job type. Failing handlers throw so tests see the real error.
 */
export const runQueuedJobs = async (types?: string[], maxRounds = 5) => {
  const app = getAppServices();
  const results: { type: string; result: unknown }[] = [];
  for (let round = 0; round < maxRounds; round++) {
    const due = await app.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.state, 'queued'), lte(jobs.runAt, app.clock.now()), types ? inArray(jobs.type, types) : undefined));
    if (due.length === 0) break;
    for (const j of due) {
      const def = JOB_DEFINITIONS.get(j.type);
      if (!def) continue;
      await app.db.update(jobs).set({ state: 'running', attempts: j.attempts + 1 }).where(eq(jobs.id, j.id));
      const result = await def.handler({
        app,
        job: { id: j.id, type: j.type, workspaceId: j.workspaceId, payload: j.payload, attempts: j.attempts + 1, causation: j.causation, requestedBy: j.requestedBy },
        heartbeat: async () => {},
        cancelled: async () => false,
      });
      await app.db.update(jobs).set({ state: 'succeeded', result: (result ?? null) as never, finishedAt: app.clock.now() }).where(eq(jobs.id, j.id));
      results.push({ type: j.type, result });
    }
  }
  return results;
};
