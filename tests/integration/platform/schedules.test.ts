import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { JOB_DEFINITIONS, SCHEDULES, getAppServices } from '@castlane/application';
import '@castlane/application/register-all';
import { jobs } from '@castlane/database';
import { runSchedulerTick } from '../../../apps/worker/src/scheduler';

describe('scheduled jobs', () => {
  it('enqueues every schedule into the pool its job is defined for (a job in another pool never runs)', async () => {
    const app = getAppServices();
    await runSchedulerTick(app);
    expect(SCHEDULES.length).toBeGreaterThan(0);
    for (const s of SCHEDULES) {
      const def = JOB_DEFINITIONS.get(s.jobType);
      expect(def, s.jobType).toBeDefined();
      const rows = await app.db.select({ pool: jobs.pool }).from(jobs).where(eq(jobs.type, s.jobType));
      expect(rows.length, s.jobType).toBeGreaterThan(0);
      for (const r of rows) expect({ type: s.jobType, pool: r.pool }).toEqual({ type: s.jobType, pool: def!.pool });
    }
  });
});
