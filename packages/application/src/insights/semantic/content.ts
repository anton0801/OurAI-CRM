import { and, eq, inArray, sql } from 'drizzle-orm';
import Big from 'big.js';
import {
  cumulativeDelta,
  known,
  percentValue,
  pickCheckpointObservation,
  ratioValue,
  sumOfKnown,
  unavailable,
  weightedPercent,
  type CheckpointTiming,
  type MetricValue,
} from '@castlane/analytics';
import { campaignSourceReports, contentItems, metricObservations, metricValues, publications, socialAccounts } from '@castlane/database';
import { toBig } from '@castlane/domain';
import { dbOf } from '../../core/context';
import { activePolicy } from '../catalog';
import { filterSql, memo, type Ctx } from '../common';
import { loadPeriodObservations, usablePeriods } from './accounts';
import { loadPublished, periodKey, qKey, type PubRec } from './production';
import { defineInsightMetric, type BaseRec, type InsightQuery } from './registry';
import { inWindow, preferTotals, scopeFor } from './sources';

/** Content metrics (Content Dashboard: M14–M21, M23) from publication cumulative observations. */

const PERM = 'analytics.content.read';
export const PUB_KEYS = [
  'publication.views',
  'publication.impressions',
  'publication.reach',
  'publication.likes',
  'publication.comments',
  'publication.shares',
  'publication.saves',
  'publication.total_watch_time_seconds',
  'publication.average_watch_time_seconds',
  'publication.completions',
  'publication.clicks',
] as const;

export interface CheckpointObs {
  id: string;
  observedAt: Date;
  timing: CheckpointTiming;
  values: Record<string, string | null>;
}

export interface PubCheckpointRec extends PubRec {
  expectedAt: Date;
  obs: CheckpointObs | null;
  /** Observations outside the checkpoint window (Early/Late): excluded from standard comparisons (T068). */
  outOfWindow: number;
}

const chunk = <T>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

interface PubObservationRow {
  id: string;
  pubId: string;
  observedAt: Date;
  enteredAt: Date;
  quality: string;
  revisionNo: number;
  segment: string;
  /** At least one known value (observations without values are never chosen). */
  hasValue: boolean;
}

/**
 * The period's published cohort and the totals-segment observations of those publications, loaded
 * once per request and shared by every checkpoint (24 h / 7 d) and metric of a dashboard.
 */
const loadCohortObservations = (ctx: Ctx, q: InsightQuery, permission: string) =>
  memo(ctx, `cohortObservations:${permission}:${periodKey(q)}`, async () => {
    const cohort = await loadPublished(ctx, q, permission);
    const db = dbOf(ctx);
    const ws = ctx.actor.workspaceId;
    const o = metricObservations;
    const obsRows: PubObservationRow[] = [];
    for (const ids of chunk(cohort.map((c) => c.id), 5000)) {
      const rows = await db
        .select({
          id: o.id,
          pubId: o.entityId,
          observedAt: o.observedAt,
          enteredAt: o.enteredAt,
          quality: o.qualityState,
          revisionNo: o.revisionNo,
          segment: o.segment,
          // Explicit qualification: drizzle renders selected columns unqualified, which would bind to
          // the subquery's own table.
          hasValue: sql<boolean>`EXISTS (SELECT 1 FROM metric_values mv WHERE mv.observation_id = "metric_observations"."id" AND mv.availability = 'known')`,
        })
        .from(o)
        .where(
          and(
            eq(o.workspaceId, ws),
            eq(o.entityType, 'publication'),
            inArray(o.entityId, ids),
            eq(o.canonical, true),
            sql`${o.qualityState} IN ('unverified', 'reviewed')`,
            inArray(o.segment, ['unknown', 'combined']),
          ),
        );
      for (const r of rows) obsRows.push(r);
    }
    const byPub = new Map<string, PubObservationRow[]>();
    for (const t of preferTotals(obsRows.map((r) => ({ ...r, entityKey: r.pubId })))) {
      const list = byPub.get(t.pubId);
      if (list) list.push(t);
      else byPub.set(t.pubId, [t]);
    }
    return { cohort, byPub };
  });

/**
 * Known values of observations, cached per request: each observation is read at most once, and
 * concurrent callers (several checkpoints of one dashboard) wait for the same pending read.
 */
const loadObservationValues = async (ctx: Ctx, ids: string[]): Promise<Map<string, Record<string, string | null>>> => {
  const cache = await memo(ctx, 'observationValues', async () => ({ values: new Map<string, Record<string, string | null>>(), pending: new Map<string, Promise<void>>() }));
  const wanted = [...new Set(ids)];
  const missing = wanted.filter((id) => !cache.values.has(id) && !cache.pending.has(id));
  const db = dbOf(ctx);
  for (const part of chunk(missing, 5000)) {
    const load = (async () => {
      const vs = await db
        .select({ id: metricValues.observationId, key: metricValues.metricKey, value: metricValues.value })
        .from(metricValues)
        .where(and(eq(metricValues.workspaceId, ctx.actor.workspaceId), inArray(metricValues.observationId, part), eq(metricValues.availability, 'known')));
      const byId = new Map<string, Record<string, string | null>>(part.map((id) => [id, {}]));
      for (const v of vs) byId.get(v.id)![v.key] = v.value;
      for (const [id, rec] of byId) cache.values.set(id, rec);
    })();
    for (const id of part) cache.pending.set(id, load);
  }
  await Promise.all([...new Set(wanted.map((id) => cache.pending.get(id)).filter((x): x is Promise<void> => !!x))]);
  return cache.values;
};

/**
 * Publications published in the window with their canonical checkpoint observation: the on-time
 * observation closest to the expected time (ties → reviewed, latest revision), totals segment only.
 */
export const loadCheckpointData = (ctx: Ctx, q: InsightQuery, permission = PERM) =>
  memo(ctx, `checkpointData:${permission}:${periodKey(q)}:${q.checkpointKey ?? 'pub_24h'}`, async (): Promise<PubCheckpointRec[]> => {
    const { cohort, byPub } = await loadCohortObservations(ctx, q, permission);
    const policy = await activePolicy(ctx);
    const key = q.checkpointKey ?? 'pub_24h';
    const rule = policy.config.publication.find((r) => r.key === key) ?? { key, offsetHours: key === 'pub_7d' ? 168 : 24, toleranceHours: key === 'pub_7d' ? 12 : 2, requiredMetrics: [] };
    const picks = cohort.map((p) => {
      const expectedAt = new Date(p.at!.getTime() + rule.offsetHours * 3_600_000);
      const tol = rule.toleranceHours * 3_600_000;
      const window = { start: new Date(expectedAt.getTime() - tol), end: new Date(expectedAt.getTime() + tol) };
      const candidates = (byPub.get(p.id) ?? []).map((x) => ({
        id: x.id,
        observedAt: x.observedAt,
        enteredAt: x.enteredAt,
        reviewed: x.quality === 'reviewed',
        revisionNo: x.revisionNo,
        value: x.hasValue ? '1' : null,
      }));
      return { p, expectedAt, pick: pickCheckpointObservation(candidates, expectedAt, window) };
    });
    // Values are read only for the chosen observation of each publication.
    const values = await loadObservationValues(
      ctx,
      picks.flatMap((x) => (x.pick.chosen ? [x.pick.chosen.id] : [])),
    );
    return picks.map(({ p, expectedAt, pick }) => ({
      ...p,
      expectedAt,
      obs: pick.chosen && pick.timing ? { id: pick.chosen.id, observedAt: pick.chosen.observedAt, timing: pick.timing, values: values.get(pick.chosen.id) ?? {} } : null,
      outOfWindow: pick.outOfWindow.length,
    }));
  });

const v = (r: PubCheckpointRec, key: string) => r.obs?.values[`publication.${key}`] ?? null;

const interactionsOf = (r: PubCheckpointRec) => sumOfKnown({ likes: v(r, 'likes'), comments: v(r, 'comments'), shares: v(r, 'shares'), saves: v(r, 'saves') });

const noObservation = (rs: PubCheckpointRec[]) => {
  const none = rs.filter((r) => !r.obs);
  const late = none.filter((r) => r.outOfWindow > 0).length;
  return [
    ...(late ? [{ count: late, reason: 'Recorded outside the target window (Early/Late)' }] : []),
    ...(none.length - late ? [{ count: none.length - late, reason: 'No observation at this checkpoint' }] : []),
  ];
};

const withExcluded = (value: MetricValue, extra: { count: number; reason: string }[]): MetricValue => {
  const all = [...(value.excluded ?? []), ...extra].filter((e) => e.count > 0);
  return all.length ? { ...value, excluded: all } : value;
};

const pubDrill = {
  readPermission: 'publications.read',
  ref: (r: PubCheckpointRec) => ({ entityType: 'publication', id: r.id, projectId: r.projectId ?? null, accountId: r.accountId ?? null, at: r.at ?? null, value: v(r, 'views') }),
};

const CONTENT_DIMS = ['period', 'project', 'direction', 'account', 'platform', 'format', 'member', 'campaign', 'publication'] as const;

const defineCheckpointMetric = (m: {
  id: string;
  key: string;
  label: string;
  description: string;
  unit: MetricValue['unit'];
  rate?: boolean;
  additive: boolean;
  reduce: (rs: PubCheckpointRec[]) => MetricValue;
}) =>
  defineInsightMetric<PubCheckpointRec>({
    ...m,
    higherIsBetter: true,
    family: 'content',
    permission: PERM,
    dimensions: [...CONTENT_DIMS],
    grains: ['week', 'month', 'quarter'],
    load: (ctx, q) => loadCheckpointData(ctx, q),
    drill: pubDrill,
    sourceAt: (r) => r.obs?.observedAt ?? null,
  });

defineCheckpointMetric({
  id: 'M14',
  key: 'views_at_checkpoint',
  label: 'Views at Checkpoint',
  description:
    'Canonical cumulative views of each publication at the checkpoint (24 h by default): the observation inside the target window closest to the expected time; ties go to the reviewed record, then the latest revision. Observations outside the window are excluded. Several publications are added up as Sum of Reported Views.',
  unit: 'count',
  additive: true,
  reduce: (rs) => {
    const ok = rs.filter((r) => v(r, 'views') !== null);
    const missingViews = rs.filter((r) => r.obs && v(r, 'views') === null).length;
    const excluded = [...noObservation(rs), ...(missingViews ? [{ count: missingViews, reason: 'Views not provided' }] : [])];
    if (!ok.length) return unavailable('no_data', 'count', { excluded: excluded.length ? excluded : undefined });
    const sum = ok.reduce((a, r) => a.plus(toBig(v(r, 'views')!)), new Big(0)).toString();
    const platforms = new Set(ok.map((r) => r.platform));
    const note = ok.length === 1 ? `Observed ${ok[0]!.obs!.observedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC` : platforms.size > 1 ? 'Sum of Reported Views · Definitions Differ' : 'Sum of Reported Views';
    return withExcluded(known(sum, 'count', { sampleSize: ok.length, note }), excluded);
  },
});

defineCheckpointMetric({
  id: 'M16',
  key: 'interactions',
  label: 'Interactions',
  description: 'Likes + comments + shares + saves at the checkpoint, only when all four are known; otherwise Partial Interactions with the missing fields listed (never used for a full ER).',
  unit: 'count',
  additive: true,
  reduce: (rs) => {
    const observed = rs.filter((r) => r.obs);
    if (observed.length === 1 && rs.length === 1) return interactionsOf(observed[0]!);
    const complete = observed.filter((r) => interactionsOf(r).status === 'known');
    const partial = observed.length - complete.length;
    const excluded = [...noObservation(rs), ...(partial ? [{ count: partial, reason: 'Partial Interactions (a field is missing)' }] : [])];
    if (!complete.length) return unavailable(partial ? 'not_measured' : 'no_data', 'count', { excluded: excluded.length ? excluded : undefined, note: partial ? 'Partial Interactions' : undefined });
    const sum = complete.reduce((a, r) => a.plus(toBig(interactionsOf(r).value!)), new Big(0)).toString();
    return withExcluded(known(sum, 'count', { sampleSize: complete.length }), excluded);
  },
});

/** Per publication ER; several publications → use the weighted Aggregate ER (M19). */
const erOne = (r: PubCheckpointRec, denominatorKey: 'views' | 'reach'): MetricValue => {
  if (!r.obs) return unavailable('no_data', 'percent', { excluded: noObservation([r]) });
  const inter = interactionsOf(r);
  if (inter.status === 'partial') return unavailable('not_measured', 'percent', { missing: inter.missing, note: 'Partial Interactions — ER is not calculated' });
  if (inter.status !== 'known') return unavailable('no_data', 'percent');
  const den = v(r, denominatorKey);
  if (den === null) return unavailable('no_data', 'percent', { note: `${denominatorKey === 'views' ? 'Views' : 'Reach'} not provided` });
  return percentValue(inter.value, den, 2, { sampleSize: 1 });
};

for (const [id, key, label, den, description] of [
  ['M17', 'er_by_views', 'ER by Views', 'views', 'Interactions ÷ views × 100 for one publication, from the same observation (checkpoint window and segment). Views = 0 → Not Defined. May exceed 100 depending on source definitions; never clamped.'],
  ['M18', 'er_by_reach', 'ER by Reach', 'reach', 'Interactions ÷ reach × 100 for one publication from the same source observation. Kept separate from ER by Views.'],
] as const) {
  defineCheckpointMetric({
    id,
    key,
    label,
    description,
    unit: 'percent',
    rate: true,
    additive: false,
    reduce: (rs) =>
      rs.length === 1 ? erOne(rs[0]!, den) : rs.length === 0 ? unavailable('no_data', 'percent') : unavailable('not_applicable', 'percent', { note: 'Per publication. Use Aggregate ER (M19) for several publications.', sampleSize: rs.length }),
  });
}

defineCheckpointMetric({
  id: 'M19',
  key: 'aggregate_er',
  label: 'Aggregate ER',
  description: 'Sum of eligible interactions ÷ sum of eligible views × 100 across publications at the checkpoint — a weighted ratio, never the average of percentages. Publications with partial interactions, unknown or zero views are excluded and counted.',
  unit: 'percent',
  rate: true,
  additive: false,
  reduce: (rs) => {
    const observed = rs.filter((r) => r.obs);
    const partial = observed.filter((r) => interactionsOf(r).status !== 'known').length;
    const eligible = observed.filter((r) => interactionsOf(r).status === 'known');
    const w = weightedPercent(eligible.map((r) => ({ numerator: interactionsOf(r).value, denominator: v(r, 'views') })));
    const excluded = [...noObservation(rs), ...(partial ? [{ count: partial, reason: 'Partial Interactions' }] : [])];
    if (!rs.length) return unavailable('no_data', 'percent');
    return withExcluded(w.status === 'no_data' && excluded.length ? unavailable('not_measured', 'percent') : w, excluded);
  },
});

defineCheckpointMetric({
  id: 'M20',
  key: 'completion_rate',
  label: 'Completion Rate',
  description: 'Confirmed completed views ÷ views × 100 when the source provides both for the same observation (added up before dividing). Never derived from the duration of the video.',
  unit: 'percent',
  rate: true,
  additive: false,
  reduce: (rs) => {
    const observed = rs.filter((r) => r.obs);
    const eligible = observed.filter((r) => v(r, 'completions') !== null && v(r, 'views') !== null);
    const notProvided = observed.length - eligible.length;
    const w = weightedPercent(eligible.map((r) => ({ numerator: v(r, 'completions'), denominator: v(r, 'views') })));
    if (!rs.length) return unavailable('no_data', 'percent');
    const excluded = [...noObservation(rs), ...(notProvided ? [{ count: notProvided, reason: 'Completions or views not provided' }] : [])];
    return withExcluded(w.status === 'no_data' && observed.length ? unavailable('not_measured', 'percent') : w, excluded);
  },
});

defineCheckpointMetric({
  id: 'M21',
  key: 'average_watch_time',
  label: 'Average Watch Time',
  description: 'Total watch time ÷ views for publications where the source gives both; a source-reported average is shown only on its own (labelled) and is never mixed with computed values in one series.',
  unit: 'seconds',
  additive: false,
  reduce: (rs) => {
    const observed = rs.filter((r) => r.obs);
    const computed = observed.filter((r) => v(r, 'total_watch_time_seconds') !== null && v(r, 'views') !== null && !toBig(v(r, 'views')!).eq(0));
    const reportedOnly = observed.filter((r) => !computed.includes(r) && v(r, 'average_watch_time_seconds') !== null);
    if (rs.length === 1 && reportedOnly.length === 1) return known(toBig(v(reportedOnly[0]!, 'average_watch_time_seconds')!).toFixed(1), 'seconds', { note: 'Source-reported average', sampleSize: 1 });
    if (!computed.length) return unavailable(observed.length ? 'not_measured' : 'no_data', 'seconds', { excluded: noObservation(rs) });
    const watch = computed.reduce((a, r) => a.plus(toBig(v(r, 'total_watch_time_seconds')!)), new Big(0));
    const views = computed.reduce((a, r) => a.plus(toBig(v(r, 'views')!)), new Big(0));
    const value = ratioValue(watch, views, 'seconds', 1, { sampleSize: computed.length, note: 'Total watch time ÷ views' });
    return withExcluded(value, [...noObservation(rs), ...(reportedOnly.length ? [{ count: reportedOnly.length, reason: 'Only a source-reported average (not combined)' }] : [])]);
  },
});

// ——— M15 Period Views Delta ———

interface DeltaRec extends BaseRec {
  id: string;
  first: { at: Date; value: string } | null;
  last: { at: Date; value: string } | null;
  count: number;
}

defineInsightMetric<DeltaRec>({
  id: 'M15',
  measuresChange: true,
  key: 'period_views_delta',
  label: 'Period Views Delta',
  description: 'Cumulative views at the last observation minus the first observation of the same publication inside the period (same definition set and segment; real observation times shown). A negative delta is flagged Source Correction and is never shown as negative consumption.',
  unit: 'count',
  higherIsBetter: true,
  family: 'content',
  permission: PERM,
  dimensions: ['project', 'direction', 'account', 'platform', 'format', 'member', 'campaign', 'publication'],
  grains: [],
  additive: true,
  load: (ctx, q) =>
    memo(ctx, `viewsDelta:${qKey(q)}`, async () => {
      const o = metricObservations;
      const p = publications;
      const a = socialAccounts;
      const c = contentItems;
      const format = sql<string>`coalesce(${p.format}, ${c.format})`;
      const rows = await dbOf(ctx)
        .select({
          pubId: p.id,
          projectId: p.projectId,
          accountId: p.accountId,
          platform: a.platform,
          format,
          memberId: p.ownerMembershipId,
          campaignId: p.primaryCampaignId,
          publishedAt: p.actualPublishedAt,
          observedAt: o.observedAt,
          segment: o.segment,
          defset: o.definitionSetVersion,
          value: metricValues.value,
        })
        .from(o)
        .innerJoin(metricValues, and(eq(metricValues.observationId, o.id), eq(metricValues.metricKey, 'publication.views'), eq(metricValues.availability, 'known')))
        .innerJoin(p, and(eq(p.id, o.entityId), eq(p.workspaceId, o.workspaceId)))
        .innerJoin(a, and(eq(a.id, p.accountId), eq(a.workspaceId, p.workspaceId)))
        .innerJoin(c, and(eq(c.id, p.contentItemId), eq(c.workspaceId, p.workspaceId)))
        .where(
          and(
            eq(o.workspaceId, ctx.actor.workspaceId),
            eq(o.entityType, 'publication'),
            eq(o.canonical, true),
            sql`${o.qualityState} IN ('unverified', 'reviewed')`,
            inArray(o.segment, ['unknown', 'combined']),
            inWindow(o.observedAt, q),
            scopeFor(ctx, PERM, { projectId: p.projectId, accountId: p.accountId }),
            ...filterSql(ctx, q.filters, { projectId: p.projectId, accountId: p.accountId, platform: a.platform, format, memberId: p.ownerMembershipId, campaignId: p.primaryCampaignId }),
          ),
        );
      const totals = preferTotals(rows.map((r) => ({ ...r, entityKey: r.pubId })));
      const by = new Map<string, typeof totals>();
      for (const r of totals) {
        const k = `${r.pubId}|${r.defset}`;
        by.set(k, [...(by.get(k) ?? []), r]);
      }
      const out: DeltaRec[] = [];
      for (const list of by.values()) {
        const s = [...list].sort((x, y) => x.observedAt.getTime() - y.observedAt.getTime());
        const f = s[0]!;
        const l = s[s.length - 1]!;
        out.push({
          id: f.pubId,
          publicationId: f.pubId,
          projectId: f.projectId,
          accountId: f.accountId,
          platform: f.platform,
          format: f.format,
          memberId: f.memberId,
          campaignId: f.campaignId,
          at: f.publishedAt,
          first: { at: f.observedAt, value: f.value! },
          last: { at: l.observedAt, value: l.value! },
          count: s.length,
        });
      }
      return out;
    }),
  reduce: (rs) => {
    if (rs.length === 1) {
      const r = rs[0]!;
      if (r.count < 2) return unavailable('not_enough_data', 'count', { sampleSize: r.count });
      const d = cumulativeDelta(r.first!.value, r.last!.value);
      return { ...d, note: `${d.note ? `${d.note}: the source reported a lower total · ` : ''}${r.first!.at.toISOString().slice(0, 16).replace('T', ' ')} → ${r.last!.at.toISOString().slice(0, 16).replace('T', ' ')} UTC` };
    }
    let sum = new Big(0);
    let used = 0;
    let negative = 0;
    let few = 0;
    for (const r of rs) {
      if (r.count < 2) {
        few++;
        continue;
      }
      const d = toBig(r.last!.value).minus(toBig(r.first!.value));
      if (d.lt(0)) negative++;
      else {
        sum = sum.plus(d);
        used++;
      }
    }
    const excluded = [...(negative ? [{ count: negative, reason: 'Source Correction (lower cumulative total)' }] : []), ...(few ? [{ count: few, reason: 'Fewer than two observations in the period' }] : [])];
    if (!used) return unavailable(rs.length ? 'not_enough_data' : 'no_data', 'count', { excluded: excluded.length ? excluded : undefined });
    return known(sum.toString(), 'count', { sampleSize: used, excluded: excluded.length ? excluded : undefined });
  },
  drill: { readPermission: 'publications.read', ref: (r) => ({ entityType: 'publication', id: r.id, projectId: r.projectId ?? null, accountId: r.accountId ?? null, at: r.last?.at ?? null, value: r.first && r.last ? toBig(r.last.value).minus(toBig(r.first.value)).toString() : null }) },
  sourceAt: (r) => r.last?.at ?? null,
});

// ——— M23 Conversion Rate ———

interface ConvRec extends BaseRec {
  id: string;
  entityType: 'campaign_report' | 'metric_observation';
  clicks: string | null;
  conversions: string | null;
}

defineInsightMetric<ConvRec>({
  id: 'M23',
  key: 'conversion_rate',
  label: 'Conversion Rate',
  description: 'Source-attributed conversions ÷ source-linked clicks × 100 when both come from the same source report and window (campaign source reports, or one account period observation). Without such a pair → Not Attributable; tracking links alone never create clicks.',
  unit: 'percent',
  rate: true,
  higherIsBetter: true,
  family: 'content',
  permission: PERM,
  dimensions: ['period', 'campaign', 'account', 'project'],
  grains: ['week', 'month', 'quarter'],
  additive: false,
  load: (ctx, q) =>
    memo(ctx, `conversion:${qKey(q)}`, async () => {
      const r = campaignSourceReports;
      const scope = scopeFor(ctx, PERM, { projectId: sql`cp.project_id` as never });
      const campaignFilter = q.filters.campaignIds?.length ? inArray(r.campaignId, q.filters.campaignIds) : undefined;
      const projectFilter = q.filters.projectIds?.length ? sql`EXISTS (SELECT 1 FROM campaign_projects cp2 WHERE cp2.workspace_id = ${r.workspaceId} AND cp2.campaign_id = ${r.campaignId} AND cp2.project_id IN (${sql.join(q.filters.projectIds.map((x) => sql`${x}::uuid`), sql`, `)}))` : undefined;
      const reports = await dbOf(ctx)
        .select({ id: r.id, campaignId: r.campaignId, at: r.periodStart, clicks: r.clicks, conversions: r.conversions })
        .from(r)
        .where(
          and(
            eq(r.workspaceId, ctx.actor.workspaceId),
            sql`${r.periodStart} >= ${q.period.start} AND ${r.periodEnd} <= ${q.period.end}`,
            sql`EXISTS (SELECT 1 FROM campaign_projects cp WHERE cp.workspace_id = ${r.workspaceId} AND cp.campaign_id = ${r.campaignId} ${scope ? sql`AND ${scope}` : sql``})`,
            campaignFilter,
            projectFilter,
            q.filters.accountIds?.length || q.filters.platforms?.length ? sql`false` : undefined,
          ),
        );
      const periods = await loadPeriodObservations(ctx, q, 'account', ['account.views', 'account.link_clicks', 'account.impressions', 'account.platform_conversions'], PERM);
      const { included } = usablePeriods(periods, ['account.link_clicks', 'account.platform_conversions']);
      return [
        ...reports.map((x) => ({ id: x.id, entityType: 'campaign_report' as const, campaignId: x.campaignId, at: x.at, clicks: x.clicks === null ? null : String(x.clicks), conversions: x.conversions === null ? null : String(x.conversions) })),
        ...(q.filters.campaignIds?.length
          ? []
          : included.map((p) => ({ id: p.observationId, entityType: 'metric_observation' as const, accountId: p.accountId, projectId: p.projectId, platform: p.platform, at: p.start, clicks: p.values['account.link_clicks'] ?? null, conversions: p.values['account.platform_conversions'] ?? null }))),
      ];
    }),
  reduce: (rs) => {
    const pairs = rs.filter((r) => r.clicks !== null && r.conversions !== null);
    if (!pairs.length) return unavailable('not_attributable', 'percent', { note: 'No source reports conversions together with the linked clicks.' });
    const w = weightedPercent(pairs.map((r) => ({ numerator: r.conversions, denominator: r.clicks })));
    const unpaired = rs.length - pairs.length;
    return unpaired ? { ...w, excluded: [...(w.excluded ?? []), { count: unpaired, reason: 'Clicks or conversions not reported' }] } : w;
  },
  drill: { readPermission: ['metrics.read', 'campaigns.read'], ref: (r) => (r.entityType === 'metric_observation' ? { entityType: 'metric_observation', id: r.id, projectId: r.projectId ?? null, accountId: r.accountId ?? null, at: r.at ?? null, value: null } : null) },
});

export { interactionsOf, erOne };
