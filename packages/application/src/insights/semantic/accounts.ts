import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import Big from 'big.js';
import { growthPercent, known, nonOverlappingSet, periodWithin, snapshotChange, unavailable, weightedPercent, type MetricValue } from '@castlane/analytics';
import { metricObservations, metricValues, socialAccounts } from '@castlane/database';
import { toBig } from '@castlane/domain';
import { dbOf } from '../../core/context';
import { filterSql, memo, type Ctx } from '../common';
import { loadPublished, qKey, type PubRec } from './production';
import { defineInsightMetric, type BaseRec, type InsightQuery } from './registry';
import { inWindow, preferTotals, scopeFor } from './sources';

/** Account metrics (Account Dashboard: M11–M13, M22, Sum of Account Followers, cadence). */

const PERM = 'analytics.accounts.read';
const TOTAL_SEGMENTS = ['unknown', 'combined'] as const;

// ——— Snapshots ———

interface SnapRec extends BaseRec {
  observationId: string | null;
  value: string | null;
  /** Account in scope without a snapshot in the window (coverage). */
  placeholder: boolean;
}

const loadFollowerSnapshots = (ctx: Ctx, q: InsightQuery) =>
  memo(ctx, `followers:${qKey(q)}`, async (): Promise<SnapRec[]> => {
    const o = metricObservations;
    const a = socialAccounts;
    const db = dbOf(ctx);
    const ws = ctx.actor.workspaceId;
    const obs = await db
      .select({ id: o.id, accountId: o.accountId, projectId: o.projectId, platform: a.platform, at: o.observedAt, segment: o.segment, value: metricValues.value })
      .from(o)
      .innerJoin(metricValues, and(eq(metricValues.observationId, o.id), eq(metricValues.metricKey, 'account.followers'), eq(metricValues.availability, 'known')))
      .innerJoin(a, and(eq(a.id, o.accountId), eq(a.workspaceId, o.workspaceId)))
      .where(
        and(
          eq(o.workspaceId, ws),
          eq(o.entityType, 'account'),
          eq(o.kind, 'snapshot'),
          eq(o.canonical, true),
          sql`${o.qualityState} IN ('unverified', 'reviewed')`,
          inArray(o.segment, [...TOTAL_SEGMENTS]),
          inWindow(o.observedAt, q),
          scopeFor(ctx, PERM, { projectId: o.projectId, accountId: o.accountId }),
          ...filterSql(ctx, q.filters, { projectId: o.projectId, accountId: o.accountId, platform: a.platform }),
        ),
      );
    const totals = preferTotals(obs.map((r) => ({ ...r, entityKey: r.accountId })));
    const accounts = await db
      .select({ id: a.id, projectId: a.projectId, platform: a.platform })
      .from(a)
      .where(
        and(
          eq(a.workspaceId, ws),
          isNull(a.deletedAt),
          sql`${a.status} IN ('active', 'paused', 'restricted')`,
          sql`${a.createdAt} < ${q.period.end}`,
          scopeFor(ctx, PERM, { projectId: a.projectId, accountId: a.id }),
          ...filterSql(ctx, q.filters, { projectId: a.projectId, accountId: a.id, platform: a.platform }),
        ),
      );
    const withData = new Set(totals.map((t) => t.accountId));
    return [
      ...totals.map((t) => ({ observationId: t.id, accountId: t.accountId, projectId: t.projectId, platform: t.platform, at: t.at, value: t.value, placeholder: false })),
      ...accounts.filter((x) => !withData.has(x.id)).map((x) => ({ observationId: null, accountId: x.id, projectId: x.projectId, platform: x.platform, at: null, value: null, placeholder: true })),
    ];
  });

const byAccount = (rs: SnapRec[]) => {
  const m = new Map<string, { observedAt: Date; value: string }[]>();
  for (const r of rs) {
    const list = m.get(r.accountId!) ?? [];
    if (!r.placeholder && r.value !== null && r.at) list.push({ observedAt: r.at, value: r.value });
    m.set(r.accountId!, list);
  }
  return m;
};

const platformNote = (rs: BaseRec[], base: string) => {
  const platforms = new Set(rs.map((r) => r.platform).filter(Boolean));
  return platforms.size > 1 ? `${base} · Definitions Differ` : base;
};

const snapDrill = {
  readPermission: 'metrics.read',
  ref: (r: SnapRec) => (r.observationId ? { entityType: 'metric_observation', id: r.observationId, projectId: r.projectId ?? null, accountId: r.accountId ?? null, at: r.at ?? null, value: r.value } : null),
};

defineInsightMetric<SnapRec>({
  id: 'X01',
  key: 'sum_of_account_followers',
  label: 'Sum of Account Followers',
  description: 'Latest usable follower snapshot of each account in the period, added up across accounts. This is a Sum of Account Followers, not a count of unique people; accounts without a snapshot are shown as missing coverage.',
  unit: 'count',
  higherIsBetter: true,
  family: 'accounts',
  permission: PERM,
  dimensions: ['period', 'project', 'direction', 'account', 'platform'],
  grains: ['day', 'week', 'month'],
  additive: true,
  load: loadFollowerSnapshots,
  reduce: (rs) => {
    const accounts = byAccount(rs);
    let sum = new Big(0);
    let usable = 0;
    for (const points of accounts.values()) {
      if (!points.length) continue;
      const last = points.reduce((a, b) => (b.observedAt > a.observedAt ? b : a));
      sum = sum.plus(toBig(last.value));
      usable++;
    }
    const coverage = { usable, expected: accounts.size };
    if (!usable) return unavailable('no_data', 'count', { coverage });
    const note = platformNote(rs, 'Sum of Account Followers — not unique audience');
    return usable < accounts.size ? { status: 'partial', value: sum.toString(), unit: 'count', coverage, sampleSize: usable, note, missing: [`${accounts.size - usable} account(s) without a snapshot`] } : known(sum.toString(), 'count', { coverage, sampleSize: usable, note });
  },
  drill: snapDrill,
  sourceAt: (r) => r.at ?? null,
});

defineInsightMetric<SnapRec>({
  id: 'M11',
  measuresChange: true,
  key: 'followers_change',
  label: 'Followers Change',
  description: 'Last usable follower snapshot minus the first usable snapshot inside the period, per account (the real observation times are shown). Fewer than two snapshots → Not Enough Data.',
  unit: 'count',
  higherIsBetter: true,
  family: 'accounts',
  permission: PERM,
  dimensions: ['project', 'direction', 'account', 'platform'],
  grains: [],
  additive: true,
  load: loadFollowerSnapshots,
  reduce: (rs) => {
    const accounts = byAccount(rs);
    if (accounts.size === 1) {
      const [points] = [...accounts.values()];
      const c = snapshotChange(points!);
      return c.first && c.last && c.change.status === 'known'
        ? { ...c.change, note: `${c.first.observedAt.toISOString().slice(0, 10)} → ${c.last.observedAt.toISOString().slice(0, 10)}` }
        : c.change;
    }
    let sum = new Big(0);
    let usable = 0;
    for (const points of accounts.values()) {
      const c = snapshotChange(points);
      if (c.change.status === 'known' && c.change.value !== null) {
        sum = sum.plus(toBig(c.change.value));
        usable++;
      }
    }
    const excluded = accounts.size - usable;
    if (!usable) return unavailable('not_enough_data', 'count', { excluded: excluded ? [{ count: excluded, reason: 'Fewer than two snapshots' }] : undefined });
    return known(sum.toString(), 'count', { sampleSize: usable, excluded: excluded ? [{ count: excluded, reason: 'Fewer than two snapshots' }] : undefined, note: platformNote(rs, 'Sum of account changes') });
  },
  drill: snapDrill,
  sourceAt: (r) => r.at ?? null,
});

defineInsightMetric<SnapRec>({
  id: 'M12',
  key: 'followers_growth',
  label: 'Followers Growth %',
  description: '(last − first) ÷ first × 100 from the first and last usable snapshots in the period; across accounts the changes and first values are added before dividing. A first value of 0 → Not Defined (the absolute change stays available).',
  unit: 'percent',
  rate: true,
  higherIsBetter: true,
  family: 'accounts',
  permission: PERM,
  dimensions: ['project', 'direction', 'account', 'platform'],
  grains: [],
  additive: false,
  load: loadFollowerSnapshots,
  reduce: (rs) => {
    const accounts = byAccount(rs);
    let delta = new Big(0);
    let first = new Big(0);
    let usable = 0;
    for (const points of accounts.values()) {
      const c = snapshotChange(points);
      if (c.first && c.last && c.change.status === 'known') {
        delta = delta.plus(toBig(c.last.value).minus(toBig(c.first.value)));
        first = first.plus(toBig(c.first.value));
        usable++;
      }
    }
    if (!usable) return unavailable('not_enough_data', 'percent');
    if (accounts.size === 1) {
      const c = snapshotChange([...accounts.values()][0]!);
      return c.growth;
    }
    return { ...growthPercent(first.toString(), first.plus(delta).toString()), sampleSize: usable };
  },
  drill: snapDrill,
});

// ——— Period observations ———

export interface PeriodObsRec extends BaseRec {
  id: string;
  observationId: string;
  start: Date;
  end: Date;
  segment: string;
  defset: number;
  entityKey: string;
  within: boolean;
  values: Record<string, string | null>;
}

/** Canonical period observations overlapping the window (totals only), with their known values. */
export const loadPeriodObservations = (ctx: Ctx, q: InsightQuery, entityType: 'account' | 'ofm_account', keys: string[], permission: string) =>
  memo(ctx, `periods:${entityType}:${permission}:${keys.join(',')}:${qKey(q)}`, async (): Promise<PeriodObsRec[]> => {
    const o = metricObservations;
    const a = socialAccounts;
    const db = dbOf(ctx);
    const ws = ctx.actor.workspaceId;
    const rows = await db
      .select({ id: o.id, accountId: o.accountId, projectId: o.projectId, platform: a.platform, start: o.periodStart, end: o.periodEnd, segment: o.segment, defset: o.definitionSetVersion })
      .from(o)
      .innerJoin(a, and(eq(a.id, o.accountId), eq(a.workspaceId, o.workspaceId)))
      .where(
        and(
          eq(o.workspaceId, ws),
          eq(o.entityType, entityType),
          eq(o.kind, 'period'),
          eq(o.canonical, true),
          sql`${o.qualityState} IN ('unverified', 'reviewed')`,
          inArray(o.segment, [...TOTAL_SEGMENTS]),
          sql`${o.periodStart} < ${q.period.end} AND ${o.periodEnd} > ${q.period.start}`,
          scopeFor(ctx, permission, { projectId: o.projectId, accountId: o.accountId }),
          ...filterSql(ctx, q.filters, { projectId: o.projectId, accountId: o.accountId, platform: a.platform }),
        ),
      );
    const totals = preferTotals(rows.map((r) => ({ ...r, entityKey: r.accountId })));
    const values = new Map<string, Record<string, string | null>>();
    for (let i = 0; i < totals.length; i += 5000) {
      const ids = totals.slice(i, i + 5000).map((t) => t.id);
      if (!ids.length) continue;
      const vs = await db
        .select({ id: metricValues.observationId, key: metricValues.metricKey, value: metricValues.value })
        .from(metricValues)
        .where(and(eq(metricValues.workspaceId, ws), inArray(metricValues.observationId, ids), inArray(metricValues.metricKey, keys), eq(metricValues.availability, 'known')));
      for (const v of vs) {
        const m = values.get(v.id) ?? {};
        m[v.key] = v.value;
        values.set(v.id, m);
      }
    }
    return totals.map((t) => ({
      id: t.id,
      observationId: t.id,
      accountId: t.accountId,
      projectId: t.projectId,
      platform: t.platform,
      at: t.start,
      start: t.start!,
      end: t.end!,
      segment: t.segment,
      defset: t.defset,
      entityKey: t.accountId,
      within: periodWithin({ start: t.start!, end: t.end! }, q.period.start, q.period.end),
      values: values.get(t.id) ?? {},
    }));
  });

/**
 * Observations usable for summing one or more keys: fully inside the window, all keys known, and
 * not part of an overlapping cluster (per account, segment and definition set).
 */
export const usablePeriods = (rs: PeriodObsRec[], keys: string[]) => {
  const candidates = rs.filter((r) => keys.every((k) => r.values[k] !== undefined && r.values[k] !== null));
  const outside = candidates.filter((r) => !r.within).length;
  const groups = new Map<string, PeriodObsRec[]>();
  for (const r of candidates.filter((x) => x.within)) {
    const k = `${r.entityKey}|${r.segment}|${r.defset}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const included: PeriodObsRec[] = [];
  let conflicting = 0;
  for (const g of groups.values()) {
    const s = nonOverlappingSet(g);
    included.push(...s.included);
    conflicting += s.conflicting.length;
  }
  const excluded = [
    ...(conflicting ? [{ count: conflicting, reason: 'Overlapping periods — choose a consistent set' }] : []),
    ...(outside ? [{ count: outside, reason: 'Period extends beyond the selected range (never split)' }] : []),
  ];
  return { included, excluded };
};

export const sumPeriods = (rs: PeriodObsRec[], key: string, unit: MetricValue['unit'], baseNote?: string): MetricValue => {
  const { included, excluded } = usablePeriods(rs, [key]);
  const note = baseNote ? platformNote(included, baseNote) : undefined;
  if (!included.length) return unavailable('no_data', unit, { excluded: excluded.length ? excluded : undefined });
  const sum = included.reduce((a, r) => a.plus(toBig(r.values[key]!)), new Big(0)).toString();
  return { status: excluded.length ? 'partial' : 'known', value: sum, unit, sampleSize: included.length, excluded: excluded.length ? excluded : undefined, note };
};

const periodDrill = {
  readPermission: 'metrics.read',
  ref: (r: PeriodObsRec) => ({ entityType: 'metric_observation', id: r.observationId, projectId: r.projectId ?? null, accountId: r.accountId ?? null, at: r.start, value: null }),
};

defineInsightMetric<PeriodObsRec>({
  id: 'M13',
  key: 'account_views',
  label: 'Account Views',
  description: 'Sum of non-overlapping period observations of account views (same definition set and segment) inside the period. Lifetime totals from snapshots are never added; views across platforms are labelled Reported Views Across Platforms.',
  unit: 'count',
  higherIsBetter: true,
  family: 'accounts',
  permission: PERM,
  dimensions: ['period', 'project', 'direction', 'account', 'platform'],
  grains: ['week', 'month', 'quarter'],
  additive: true,
  load: (ctx, q) => loadPeriodObservations(ctx, q, 'account', ['account.views', 'account.link_clicks', 'account.impressions', 'account.platform_conversions'], PERM),
  reduce: (rs) => {
    const v = sumPeriods(rs, 'account.views', 'count');
    const platforms = new Set(rs.map((r) => r.platform));
    return platforms.size > 1 && v.value !== null ? { ...v, note: 'Reported Views Across Platforms · Definitions Differ' } : v;
  },
  drill: periodDrill,
  sourceAt: (r) => r.end,
});

defineInsightMetric<PeriodObsRec>({
  id: 'M22',
  key: 'ctr',
  label: 'CTR',
  description: 'Link clicks ÷ impressions × 100 from the same period observations (same scope, period and segment), added up before dividing. Profile visits never replace impressions.',
  unit: 'percent',
  rate: true,
  higherIsBetter: true,
  family: 'accounts',
  permission: PERM,
  dimensions: ['period', 'project', 'direction', 'account', 'platform'],
  grains: ['week', 'month', 'quarter'],
  additive: false,
  load: (ctx, q) => loadPeriodObservations(ctx, q, 'account', ['account.views', 'account.link_clicks', 'account.impressions', 'account.platform_conversions'], PERM),
  reduce: (rs) => {
    const { included, excluded } = usablePeriods(rs, ['account.link_clicks', 'account.impressions']);
    const v = weightedPercent(included.map((r) => ({ numerator: r.values['account.link_clicks'], denominator: r.values['account.impressions'] })));
    if (!included.length) return unavailable('no_data', 'percent', { excluded: excluded.length ? excluded : undefined });
    return excluded.length ? { ...v, excluded: [...(v.excluded ?? []), ...excluded] } : v;
  },
  drill: periodDrill,
});

defineInsightMetric<PubRec>({
  id: 'X05',
  key: 'publications_per_week',
  label: 'Publications per Week',
  description: 'Publications confirmed as Published in the period ÷ number of weeks in the period (publication cadence).',
  unit: 'number',
  higherIsBetter: true,
  family: 'accounts',
  permission: PERM,
  dimensions: ['project', 'direction', 'account', 'platform', 'format'],
  grains: [],
  additive: true,
  load: (ctx, q) => loadPublished(ctx, q, PERM),
  reduce: (rs, q) => {
    const weeks = new Big(q.period.end.getTime() - q.period.start.getTime()).div(7 * 86_400_000);
    if (weeks.lte(0)) return unavailable('not_defined', 'number');
    return known(new Big(rs.length).div(weeks).round(2).toFixed(2), 'number', { sampleSize: rs.length });
  },
  drill: { readPermission: 'publications.read', ref: (r) => ({ entityType: 'publication', id: r.id, projectId: r.projectId ?? null, accountId: r.accountId ?? null, at: r.at ?? null, value: null }) },
  sourceAt: (r) => r.at ?? null,
});

export { loadFollowerSnapshots };
