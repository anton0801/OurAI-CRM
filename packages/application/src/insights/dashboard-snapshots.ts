import { and, asc, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import type { AccessSnapshot } from '@castlane/authorization';
import { analyticsDashboardSnapshots } from '@castlane/database';
import type { AnalyticsDashboard } from '@castlane/api-contracts';
import { ANALYTICS_TABS, forbidden, newId, type EnumValue } from '@castlane/domain';
import { sha256, stableHash } from '../core/crypto';
import type { AppServices, QueryContext } from '../core/context';
import { defineConsumer, defineJob, defineSchedule, memberJobContext } from '../core/jobs-registry';
import { resolveInsightPeriod } from './common';
import { analyticsDashboard, availableTabs, type DashboardInput } from './dashboards';

/**
 * Dashboard read model (spec §28.3: "standard 90-day analytics p95 ≤ 2 s after warmed read
 * models"). A dashboard is computed from raw facts, which takes seconds on large workspaces; the
 * result for one tab, input, access scope and time zone is kept in `analytics_dashboard_snapshots`
 * and served while its period is current:
 *
 * - The key contains a signature of the member's effective access (grants, denies, assignments and
 *   the projects a direction grant resolves to) and time zone, so a snapshot is only ever served to
 *   members who would compute exactly the same figures; permission checks run before serving.
 * - Any domain event of the workspace marks its snapshots stale (outbox consumer). The worker
 *   recomputes stale snapshots that members still use, at most every
 *   ANALYTICS_SNAPSHOT_MIN_REFRESH_SECONDS (default 300), and every snapshot at least every
 *   ANALYTICS_SNAPSHOT_MAX_AGE_SECONDS (default 21600), or when the period rolls over.
 * - Served figures carry `snapshot.computedAt` (the age members see) and `refreshPending`. The
 *   payload is the unmodified output of the live computation, so availability semantics (no_data,
 *   partial, gaps instead of zeros) are the same by construction.
 * - A request that has no current snapshot computes live and stores the result (the next request
 *   is warm).
 */

type Tab = EnumValue<typeof ANALYTICS_TABS>;

const minRefreshSeconds = () => Number(process.env.ANALYTICS_SNAPSHOT_MIN_REFRESH_SECONDS ?? 300);
const maxAgeSeconds = () => Number(process.env.ANALYTICS_SNAPSHOT_MAX_AGE_SECONDS ?? 21_600);
/** Snapshots nobody requested for this long are not refreshed any more (and deleted after a week). */
const ACTIVE_WINDOW_MS = 24 * 3_600_000;
const RETENTION_MS = 7 * 24 * 3_600_000;
/** Throttle of the last-requested bookkeeping write on the serving path. */
const TOUCH_AFTER_MS = 5 * 60_000;

/** Effective access that can change dashboard figures, independent of who the member is. */
export const dashboardScopeSignature = (a: AccessSnapshot): string => {
  const directions = new Set(
    a.grants.filter((g) => g.scopeType === 'direction' && g.scopeId).map((g) => g.scopeId!),
  );
  const directionProjects = [...a.projectDirection]
    .filter(([, d]) => directions.has(d))
    .map(([p, d]) => `${d}:${p}`);
  return sha256(
    JSON.stringify({
      status: a.membershipStatus,
      owner: a.isOwner,
      grants: a.grants
        .map((g) => [g.roleKey, [...g.permissions].sort().join(','), g.scopeType, g.scopeId])
        .sort(),
      denies: a.denies.map((d) => [d.permission, d.objectType, d.objectId]).sort(),
      projects: [...a.assignedProjectIds].sort(),
      accounts: [...a.assignedAccountIds].sort(),
      directionProjects: directionProjects.sort(),
      ownRecords: a.grants.some((g) => g.scopeType === 'own_records' || g.scopeType === 'assigned_object')
        ? a.membershipId
        : null,
    }),
  );
};

const normalizeInput = (i: DashboardInput): DashboardInput => {
  const list = (xs?: string[]) => (xs?.length ? [...new Set(xs)].sort() : undefined);
  return {
    preset: i.preset,
    from: i.from,
    to: i.to,
    compare: i.compare === false ? false : undefined,
    directionId: i.directionId,
    projectIds: list(i.projectIds),
    accountIds: list(i.accountIds),
    platforms: list(i.platforms),
    formats: list(i.formats),
    memberIds: list(i.memberIds),
    grain: i.grain,
    chartMetric: i.chartMetric,
  };
};

const keyOf = (tab: Tab, input: DashboardInput, signature: string, timezone: string) =>
  stableHash({ tab, input, signature, timezone });

type Stored = AnalyticsDashboard & { snapshot?: unknown };

const store = async (
  ctx: QueryContext,
  tab: Tab,
  input: DashboardInput,
  signature: string,
  payload: AnalyticsDashboard,
  computeMs: number,
  requested: boolean,
) => {
  const now = ctx.app.clock.now();
  const cacheKey = keyOf(tab, input, signature, ctx.actor.timezone);
  const row = {
    id: newId(),
    workspaceId: ctx.actor.workspaceId,
    tab,
    cacheKey,
    input: input as unknown as Record<string, unknown>,
    scopeSignature: signature,
    timezone: ctx.actor.timezone,
    membershipId: ctx.actor.membershipId!,
    payload: payload as unknown as Record<string, unknown>,
    computedAt: new Date(payload.asOf),
    computeMs,
    stale: false,
    lastRequestedAt: now,
    createdAt: now,
    updatedAt: now,
  };
  await ctx.app.db
    .insert(analyticsDashboardSnapshots)
    .values(row)
    .onConflictDoUpdate({
      target: [analyticsDashboardSnapshots.workspaceId, analyticsDashboardSnapshots.cacheKey],
      set: {
        payload: row.payload,
        computedAt: row.computedAt,
        computeMs,
        stale: false,
        membershipId: row.membershipId,
        updatedAt: now,
        ...(requested ? { lastRequestedAt: now } : {}),
        rowVersion: sql`${analyticsDashboardSnapshots.rowVersion} + 1`,
      },
    });
  return cacheKey;
};

const withMeta = (
  payload: AnalyticsDashboard,
  now: Date,
  meta: { refreshPending: boolean; live: boolean },
): AnalyticsDashboard => ({
  ...payload,
  snapshot: {
    computedAt: payload.asOf,
    ageSeconds: Math.max(0, Math.round((now.getTime() - new Date(payload.asOf).getTime()) / 1000)),
    refreshPending: meta.refreshPending,
    live: meta.live,
  },
});

/** GET /analytics/dashboards/{tab}: served from the read model when a current snapshot exists. */
export const servedAnalyticsDashboard = async (
  ctx: QueryContext,
  tab: Tab,
  raw: DashboardInput & { refresh?: boolean },
): Promise<AnalyticsDashboard> => {
  const tabs = availableTabs(ctx);
  if (!tabs.includes(tab))
    throw forbidden(
      tabs.length ? 'You do not have access to this dashboard.' : 'You do not have access to analytics.',
    );
  if (!ctx.actor.membershipId) return analyticsDashboard(ctx, tab, raw);
  const input = normalizeInput(raw);
  const signature = dashboardScopeSignature(ctx.actor.access);
  const cacheKey = keyOf(tab, input, signature, ctx.actor.timezone);
  const now = ctx.app.clock.now();
  const [row] = raw.refresh
    ? []
    : await ctx.app.db
        .select({
          id: analyticsDashboardSnapshots.id,
          payload: analyticsDashboardSnapshots.payload,
          stale: analyticsDashboardSnapshots.stale,
          lastRequestedAt: analyticsDashboardSnapshots.lastRequestedAt,
        })
        .from(analyticsDashboardSnapshots)
        .where(
          and(
            eq(analyticsDashboardSnapshots.workspaceId, ctx.actor.workspaceId),
            eq(analyticsDashboardSnapshots.cacheKey, cacheKey),
          ),
        );
  if (row) {
    const payload = row.payload as unknown as Stored;
    const period = await resolveInsightPeriod(ctx, { preset: input.preset, from: input.from, to: input.to });
    if (
      payload.period.fromDate === period.period.fromDate &&
      payload.period.toDate === period.period.toDate
    ) {
      if (now.getTime() - row.lastRequestedAt.getTime() > TOUCH_AFTER_MS)
        await ctx.app.db
          .update(analyticsDashboardSnapshots)
          .set({ lastRequestedAt: now })
          .where(eq(analyticsDashboardSnapshots.id, row.id));
      const { snapshot: _ignored, ...figures } = payload;
      void _ignored;
      const age = now.getTime() - new Date(figures.asOf).getTime();
      return withMeta(figures, now, {
        refreshPending: row.stale || age > maxAgeSeconds() * 1000,
        live: false,
      });
    }
  }
  const t0 = Date.now();
  const payload = await analyticsDashboard(ctx, tab, input);
  await store(ctx, tab, input, signature, payload, Date.now() - t0, true);
  return withMeta(payload, ctx.app.clock.now(), { refreshPending: false, live: true });
};

/**
 * Refresh snapshots that are stale (after the minimum interval), too old, or whose period rolled
 * over, most recently requested first, within a time budget. The member's access is re-read: a
 * snapshot whose member lost the tab or changed scope is replaced under the new key or deleted.
 */
export const refreshDashboardSnapshots = async (
  app: AppServices,
  opts: { budgetMs?: number; limit?: number; workspaceId?: string } = {},
) => {
  const now = app.clock.now();
  const budgetMs = opts.budgetMs ?? 45_000;
  const started = Date.now();
  await app.db
    .delete(analyticsDashboardSnapshots)
    .where(lt(analyticsDashboardSnapshots.lastRequestedAt, new Date(now.getTime() - RETENTION_MS)));
  const candidates = await app.db
    .select({
      id: analyticsDashboardSnapshots.id,
      workspaceId: analyticsDashboardSnapshots.workspaceId,
      tab: analyticsDashboardSnapshots.tab,
      input: analyticsDashboardSnapshots.input,
      timezone: analyticsDashboardSnapshots.timezone,
      membershipId: analyticsDashboardSnapshots.membershipId,
      cacheKey: analyticsDashboardSnapshots.cacheKey,
      computedAt: analyticsDashboardSnapshots.computedAt,
      stale: analyticsDashboardSnapshots.stale,
      fromDate: sql<string>`${analyticsDashboardSnapshots.payload} #>> '{period,fromDate}'`,
      toDate: sql<string>`${analyticsDashboardSnapshots.payload} #>> '{period,toDate}'`,
    })
    .from(analyticsDashboardSnapshots)
    .where(
      and(
        gte(analyticsDashboardSnapshots.lastRequestedAt, new Date(now.getTime() - ACTIVE_WINDOW_MS)),
        opts.workspaceId ? eq(analyticsDashboardSnapshots.workspaceId, opts.workspaceId) : undefined,
      ),
    )
    .orderBy(desc(analyticsDashboardSnapshots.lastRequestedAt), asc(analyticsDashboardSnapshots.computedAt))
    .limit(500);
  let refreshed = 0;
  let removed = 0;
  for (const c of candidates) {
    if (Date.now() - started > budgetMs || refreshed >= (opts.limit ?? 50)) break;
    const age = now.getTime() - c.computedAt.getTime();
    const ctx = await memberJobContext(app, c.workspaceId, c.membershipId, { source: 'system' });
    if (!ctx) {
      await app.db.delete(analyticsDashboardSnapshots).where(eq(analyticsDashboardSnapshots.id, c.id));
      removed++;
      continue;
    }
    ctx.actor.timezone = c.timezone;
    const input = c.input as unknown as DashboardInput;
    const tab = c.tab as Tab;
    if (!availableTabs(ctx).includes(tab)) {
      await app.db.delete(analyticsDashboardSnapshots).where(eq(analyticsDashboardSnapshots.id, c.id));
      removed++;
      continue;
    }
    const period = await resolveInsightPeriod(ctx, { preset: input.preset, from: input.from, to: input.to });
    const rolled = period.period.fromDate !== c.fromDate || period.period.toDate !== c.toDate;
    const due = rolled || age > maxAgeSeconds() * 1000 || (c.stale && age > minRefreshSeconds() * 1000);
    if (!due) continue;
    const t0 = Date.now();
    const payload = await analyticsDashboard(ctx, tab, input);
    const key = await store(
      ctx,
      tab,
      input,
      dashboardScopeSignature(ctx.actor.access),
      payload,
      Date.now() - t0,
      false,
    );
    if (key !== c.cacheKey)
      await app.db.delete(analyticsDashboardSnapshots).where(eq(analyticsDashboardSnapshots.id, c.id));
    refreshed++;
  }
  return { candidates: candidates.length, refreshed, removed, ms: Date.now() - started };
};

defineJob('analytics.refreshSnapshots', 'data', async ({ app }) => refreshDashboardSnapshots(app), {
  leaseSeconds: 120,
});
defineSchedule({
  name: 'analytics.refreshSnapshots',
  everySeconds: 60,
  jobType: 'analytics.refreshSnapshots',
  pool: 'data',
});

/**
 * A change committed after a snapshot was computed can be missing from it. The margin covers
 * transactions that emitted their event before the computation started but committed after it.
 */
const STALE_MARGIN_MS = 2 * 60_000;

/** Any change in a workspace can move dashboard figures: mark its snapshots stale (cheap no-op when already stale). */
defineConsumer({
  name: 'analytics.snapshotsStale',
  events: '*',
  handle: async (tx, event) => {
    if (!event.workspaceId) return;
    await tx
      .update(analyticsDashboardSnapshots)
      .set({ stale: true })
      .where(
        and(
          eq(analyticsDashboardSnapshots.workspaceId, event.workspaceId),
          eq(analyticsDashboardSnapshots.stale, false),
          lt(analyticsDashboardSnapshots.computedAt, new Date(event.occurredAt.getTime() + STALE_MARGIN_MS)),
        ),
      );
  },
});

/** Test/ops helper: mark snapshots of the given workspaces stale without an event. */
export const markDashboardSnapshotsStale = (app: AppServices, workspaceIds: string[]) =>
  app.db
    .update(analyticsDashboardSnapshots)
    .set({ stale: true })
    .where(inArray(analyticsDashboardSnapshots.workspaceId, workspaceIds));
