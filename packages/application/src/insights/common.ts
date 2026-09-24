import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { comparisonPeriod, resolvePeriod, type Period, type PeriodPreset } from '@castlane/analytics';
import { contentItems, projects, publications, socialAccounts, workspaces, type DbOrTx } from '@castlane/database';
import { AppError, DateTime, toBig, type FieldError } from '@castlane/domain';
import { dbOf, type CommandContext, type QueryContext } from '../core/context';
import type { MetricFilters } from '../core/metric-registry';

/** Filters accepted by dashboards, the semantic query API and report datasets (core MetricFilters). */
export type InsightFilters = MetricFilters;

export type Ctx = QueryContext | CommandContext;

export const fieldFail = (field: string, code: string, message: string) => new AppError('VALIDATION_FAILED', message, { fieldErrors: [{ field, code, message }] });
export const fieldsFail = (errors: FieldError[], message = 'Some fields need attention.') => new AppError('VALIDATION_FAILED', message, { fieldErrors: errors });

// ——— Per-request memo (several metrics share the same source rows) ———

const MEMO = new WeakMap<object, Map<string, Promise<unknown>>>();

export const memo = <T>(ctx: object, key: string, fn: () => Promise<T>): Promise<T> => {
  let m = MEMO.get(ctx);
  if (!m) {
    m = new Map();
    MEMO.set(ctx, m);
  }
  const hit = m.get(key);
  if (hit) return hit as Promise<T>;
  const p = fn();
  m.set(key, p);
  p.catch(() => m!.delete(key));
  return p;
};

// ——— Workspace settings ———

export interface InsightWorkspace {
  timezone: string;
  weekStartsOn: 'monday' | 'sunday';
  baseCurrency: string;
  publicationGraceMinutes: number;
}

export const insightWorkspace = (ctx: Ctx): Promise<InsightWorkspace> =>
  memo(ctx, 'ws', async () => {
    const [w] = await dbOf(ctx)
      .select({ tz: workspaces.timezone, week: workspaces.weekStartsOn, currency: workspaces.baseCurrency, settings: workspaces.settings })
      .from(workspaces)
      .where(eq(workspaces.id, ctx.actor.workspaceId));
    const grace = (w?.settings as { publicationGraceMinutes?: number } | undefined)?.publicationGraceMinutes;
    return {
      timezone: w?.tz ?? 'UTC',
      weekStartsOn: w?.week === 'sunday' ? 'sunday' : 'monday',
      baseCurrency: (w?.currency ?? 'EUR').trim(),
      publicationGraceMinutes: typeof grace === 'number' ? grace : 15,
    };
  });

// ——— Periods ———

export const MAX_PERIOD_DAYS = 400;

export interface ResolvedInsightPeriod {
  preset: PeriodPreset;
  period: Period;
  /** Current window truncated to "now" when the period is unfinished (T117). */
  current: Period;
  previous: Period;
  elapsedOnly: boolean;
}

/** Resolve a period preset (or custom dates) in the member's time zone; boundaries are explicit UTC instants. */
export const resolveInsightPeriod = async (ctx: Ctx, input: { preset: PeriodPreset; from?: string; to?: string }): Promise<ResolvedInsightPeriod> => {
  const ws = await insightWorkspace(ctx);
  const now = ctx.app.clock.now();
  if (input.preset === 'custom' && (!input.from || !input.to)) throw fieldFail(input.from ? 'to' : 'from', 'REQUIRED', 'Choose the start and end dates of the custom period.');
  let period: Period;
  try {
    period = resolvePeriod(input.preset, now, ctx.actor.timezone, input.preset === 'custom' ? { fromDate: input.from!, toDate: input.to! } : undefined, ws.weekStartsOn);
  } catch {
    throw fieldFail('to', 'INVALID_PERIOD', 'The period must end on or after its start.');
  }
  if (period.end.getTime() - period.start.getTime() > MAX_PERIOD_DAYS * 86_400_000) throw fieldFail('to', 'PERIOD_TOO_LONG', `Choose a period of at most ${MAX_PERIOD_DAYS} days.`);
  const c = comparisonPeriod(period, now);
  return { preset: input.preset, period, current: c.current, previous: c.previous, elapsedOnly: c.elapsedOnly };
};

export const periodDto = (r: ResolvedInsightPeriod) => ({
  preset: r.preset,
  fromDate: r.period.fromDate,
  toDate: r.period.toDate,
  start: r.period.start.toISOString(),
  end: r.period.end.toISOString(),
  zone: r.period.zone,
  elapsedOnly: r.elapsedOnly,
});

export const localIsoDate = (at: Date, zone: string) => DateTime.fromJSDate(at, { zone }).toISODate()!;

// ——— SQL helpers ———

const uuidList = (ids: string[]) => sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `);

/**
 * Standard filter predicates for a fact table. Direction and platform filters resolve through
 * projects / accounts in the same workspace; every predicate is part of the SQL before aggregation.
 */
export const filterSql = (
  ctx: Ctx,
  f: InsightFilters,
  cols: { projectId?: PgColumn | SQL; accountId?: PgColumn | SQL; memberId?: PgColumn | SQL; platform?: PgColumn | SQL; format?: PgColumn | SQL; status?: PgColumn | SQL; campaignId?: PgColumn | SQL },
): SQL[] => {
  const out: SQL[] = [];
  const ws = ctx.actor.workspaceId;
  if (f.projectIds?.length && cols.projectId) out.push(sql`${cols.projectId} IN (${uuidList(f.projectIds)})`);
  if (f.directionIds?.length && cols.projectId) out.push(sql`${cols.projectId} IN (SELECT p.id FROM projects p WHERE p.workspace_id = ${ws} AND p.direction_id IN (${uuidList(f.directionIds)}))`);
  if (f.campaignIds?.length && cols.campaignId) out.push(sql`${cols.campaignId} IN (${uuidList(f.campaignIds)})`);
  if (f.accountIds?.length && cols.accountId) out.push(sql`${cols.accountId} IN (${uuidList(f.accountIds)})`);
  if (f.platforms?.length) {
    if (cols.platform) out.push(sql`${cols.platform} IN (${sql.join(f.platforms.map((p) => sql`${p}`), sql`, `)})`);
    else if (cols.accountId)
      out.push(sql`${cols.accountId} IN (SELECT a.id FROM social_accounts a WHERE a.workspace_id = ${ws} AND a.platform IN (${sql.join(f.platforms.map((p) => sql`${p}`), sql`, `)}))`);
  }
  if (f.formats?.length && cols.format) out.push(sql`${cols.format} IN (${sql.join(f.formats.map((p) => sql`${p}`), sql`, `)})`);
  if (f.memberIds?.length && cols.memberId) out.push(sql`${cols.memberId} IN (${uuidList(f.memberIds)})`);
  if (f.statuses?.length && cols.status) out.push(sql`${cols.status} IN (${sql.join(f.statuses.map((p) => sql`${p}`), sql`, `)})`);
  return out;
};

export const andAll = (...parts: (SQL | undefined | null | false)[]): SQL | undefined => {
  const p = parts.filter((x): x is SQL => !!x);
  return p.length ? and(...p) : undefined;
};

// ——— Entity labels ———

export const accountLabelOf = (a: { handle: string | null; displayName: string | null; canonicalUrl: string }) =>
  a.handle ? `@${a.handle.replace(/^@/, '')}` : (a.displayName ?? a.canonicalUrl);

export interface AccountInfo {
  id: string;
  label: string;
  platform: (typeof socialAccounts.$inferSelect)['platform'];
  projectId: string;
  ownerMembershipId: string;
  status: string;
  metricsCadence: 'daily' | 'weekly' | 'monthly';
  metricsDayOfWeek: number;
  metricsTime: string;
  createdAt: Date;
}

export const loadAccounts = async (db: DbOrTx, workspaceId: string, ids: (string | null | undefined)[]): Promise<Map<string, AccountInfo>> => {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  if (!unique.length) return new Map();
  const rows = await db.select().from(socialAccounts).where(and(eq(socialAccounts.workspaceId, workspaceId), inArray(socialAccounts.id, unique)));
  return new Map(
    rows.map((a) => [
      a.id,
      {
        id: a.id,
        label: accountLabelOf(a),
        platform: a.platform,
        projectId: a.projectId,
        ownerMembershipId: a.ownerMembershipId,
        status: a.status,
        metricsCadence: a.metricsCadence,
        metricsDayOfWeek: a.metricsDayOfWeek,
        metricsTime: a.metricsTime,
        createdAt: a.createdAt,
      },
    ]),
  );
};

export interface PublicationInfo {
  id: string;
  title: string;
  accountId: string;
  projectId: string;
  status: string;
  actualPublishedAt: Date | null;
  format: string | null;
  ownerMembershipId: string;
  contentItemId: string;
  campaignId: string | null;
}

export const loadPublications = async (db: DbOrTx, workspaceId: string, ids: (string | null | undefined)[]): Promise<Map<string, PublicationInfo>> => {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  if (!unique.length) return new Map();
  const rows = await db
    .select({
      id: publications.id,
      accountId: publications.accountId,
      projectId: publications.projectId,
      status: publications.status,
      actualPublishedAt: publications.actualPublishedAt,
      format: publications.format,
      contentFormat: contentItems.format,
      title: contentItems.title,
      ownerMembershipId: publications.ownerMembershipId,
      contentItemId: publications.contentItemId,
      campaignId: publications.primaryCampaignId,
    })
    .from(publications)
    .innerJoin(contentItems, and(eq(contentItems.id, publications.contentItemId), eq(contentItems.workspaceId, publications.workspaceId)))
    .where(and(eq(publications.workspaceId, workspaceId), inArray(publications.id, unique)));
  return new Map(rows.map((r) => [r.id, { ...r, format: r.format ?? r.contentFormat, title: r.title }]));
};

export const loadProjectNames = async (db: DbOrTx, workspaceId: string, ids: (string | null | undefined)[]) => {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  if (!unique.length) return new Map<string, { name: string; directionId: string; ofmEnabled: boolean; type: string }>();
  const rows = await db
    .select({ id: projects.id, name: projects.name, directionId: projects.directionId, ofmEnabled: projects.ofmEnabled, type: projects.type })
    .from(projects)
    .where(and(eq(projects.workspaceId, workspaceId), inArray(projects.id, unique)));
  return new Map(rows.map((r) => [r.id, r]));
};

/** project → direction map of the workspace (small; used for the direction dimension). */
export const projectDirections = (ctx: Ctx) =>
  memo(ctx, 'projectDirections', async () => {
    const rows = await dbOf(ctx).select({ id: projects.id, directionId: projects.directionId }).from(projects).where(eq(projects.workspaceId, ctx.actor.workspaceId));
    return new Map(rows.map((r) => [r.id, r.directionId]));
  });

export const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/** A stored decimal without storage padding ("1500.000000" → "1500"); null stays null (never 0). */
export const plainDecimal = (v: string | null | undefined): string | null => (v === null || v === undefined ? null : toBig(v).toFixed());
