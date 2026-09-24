import { and, eq, inArray, sql } from 'drizzle-orm';
import { checkpointCoverage } from '@castlane/analytics';
import { metricCheckpoints, metricValues, socialAccounts } from '@castlane/database';
import { dbOf } from '../../core/context';
import { activePolicy, requiredMetricsFor } from '../catalog';
import { filterSql, memo, type Ctx } from '../common';
import { qKey } from './production';
import { defineInsightMetric, type BaseRec, type InsightQuery } from './registry';
import { asOfOf, scopeFor } from './sources';

/**
 * M40 Data Coverage (T114): usable required checkpoints ÷ expected required checkpoints × 100 in
 * scope and period. A checkpoint closed as Missing is expected but never usable; a closed request
 * is not data. Checkpoints whose window has not ended yet are not expected yet.
 */

interface CoverageRec extends BaseRec {
  id: string;
  state: 'pending' | 'completed' | 'missing' | 'cancelled';
  usable: boolean;
  key: string;
}

const load = (ctx: Ctx, q: InsightQuery) =>
  memo(ctx, `coverage:${qKey(q)}`, async (): Promise<CoverageRec[]> => {
    const c = metricCheckpoints;
    const a = socialAccounts;
    const asOf = asOfOf(ctx, q);
    const rows = await dbOf(ctx)
      .select({ id: c.id, projectId: c.projectId, accountId: c.accountId, platform: a.platform, at: c.expectedAt, state: c.state, windowEnd: c.windowEnd, key: c.checkpointKey, observationId: c.completedObservationId, entityType: c.entityType })
      .from(c)
      .innerJoin(a, and(eq(a.id, c.accountId), eq(a.workspaceId, c.workspaceId)))
      .where(
        and(
          eq(c.workspaceId, ctx.actor.workspaceId),
          sql`${c.expectedAt} >= ${q.period.start} AND ${c.expectedAt} < ${q.period.end}`,
          sql`(${c.state} <> 'pending' OR ${c.windowEnd} <= ${asOf})`,
          sql`${c.state} <> 'cancelled'`,
          q.filters.statuses?.length ? inArray(c.entityType, q.filters.statuses as ('account' | 'publication')[]) : undefined,
          scopeFor(ctx, 'metrics.read', { projectId: c.projectId, accountId: c.accountId }),
          ...filterSql(ctx, q.filters, { projectId: c.projectId, accountId: c.accountId, platform: a.platform }),
        ),
      );
    const policy = await activePolicy(ctx);
    const obsIds = rows.map((r) => r.observationId).filter((x): x is string => !!x);
    const known = new Map<string, Set<string>>();
    for (let i = 0; i < obsIds.length; i += 5000) {
      const ids = obsIds.slice(i, i + 5000);
      const vs = await dbOf(ctx)
        .select({ id: metricValues.observationId, key: metricValues.metricKey })
        .from(metricValues)
        .where(and(eq(metricValues.workspaceId, ctx.actor.workspaceId), inArray(metricValues.observationId, ids), eq(metricValues.availability, 'known')));
      for (const v of vs) known.set(v.id, new Set([...(known.get(v.id) ?? []), v.key]));
    }
    return rows.map((r) => {
      const required = requiredMetricsFor(r.key, policy.config);
      const have = r.observationId ? (known.get(r.observationId) ?? new Set<string>()) : new Set<string>();
      return {
        id: r.id,
        projectId: r.projectId,
        accountId: r.accountId,
        platform: r.platform,
        at: r.at,
        state: r.state,
        key: r.key,
        status: r.entityType,
        usable: r.state === 'completed' && (required.length === 0 ? have.size > 0 : required.some((k) => have.has(k))),
      };
    });
  });

defineInsightMetric<CoverageRec>({
  id: 'M40',
  key: 'data_coverage',
  label: 'Data Coverage',
  description: 'Usable required checkpoints ÷ expected required checkpoints × 100 in scope and period (a checkpoint is expected once its window has ended). Missing checkpoints are expected but never usable.',
  unit: 'percent',
  rate: true,
  higherIsBetter: true,
  family: 'coverage',
  permission: 'metrics.read',
  dimensions: ['period', 'project', 'direction', 'account', 'platform'],
  grains: ['week', 'month', 'quarter'],
  additive: false,
  load,
  reduce: (rs) => checkpointCoverage(rs),
  drill: { readPermission: 'metrics.read', ref: (r) => ({ entityType: 'metric_checkpoint', id: r.id, projectId: r.projectId ?? null, accountId: r.accountId ?? null, at: r.at ?? null, value: r.state }) },
});
