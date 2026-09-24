import { sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { listFilter } from '@castlane/authorization';
import Big from 'big.js';
import { DateTime, ROUND_HALF_EVEN, formatMinor } from '@castlane/domain';
import { scopePredicate, type ScopeColumns } from '../../core/access';
import type { Ctx } from '../common';
import type { InsightQuery } from './registry';

/** Scope of an analytics permission in SQL, before aggregation (404/leak-free counts). */
export const scopeFor = (ctx: Ctx, permission: string, cols: ScopeColumns): SQL | undefined => scopePredicate(ctx, permission, cols);

/** Several permissions must all cover a row (e.g. analytics.finance.read and finance.read). */
export const scopeAll = (ctx: Ctx, permissions: string[], cols: ScopeColumns): SQL | undefined => {
  const parts = permissions.map((p) => scopePredicate(ctx, p, cols)).filter((x): x is SQL => !!x);
  return parts.length ? sql.join(parts, sql` AND `) : undefined;
};

/** Timestamp column inside the query window [start, end). */
export const inWindow = (col: PgColumn | SQL, q: InsightQuery): SQL => sql`${col} >= ${q.period.start} AND ${col} < ${q.period.end}`;

/** Local calendar bounds of the (possibly truncated) window for date columns. */
export const dateBounds = (q: InsightQuery) => ({
  from: DateTime.fromJSDate(q.period.start, { zone: q.period.zone }).toISODate()!,
  to: DateTime.fromJSDate(new Date(q.period.end.getTime() - 1), { zone: q.period.zone }).toISODate()!,
});

export const dateInWindow = (col: PgColumn | SQL, q: InsightQuery): SQL => {
  const b = dateBounds(q);
  return sql`${col} >= ${b.from} AND ${col} <= ${b.to}`;
};

/** A calendar date as the instant of its local midnight (for period buckets). */
export const localMidnight = (isoDate: string, zone: string): Date => DateTime.fromISO(isoDate, { zone }).startOf('day').toUTC().toJSDate();

/** As-of instant of the query (end of the window, never after now). */
export const asOfOf = (ctx: Ctx, q: InsightQuery) => new Date(Math.min(q.asOf.getTime(), q.period.end.getTime(), ctx.app.clock.now().getTime()));

/** True when the member sees the permission workspace-wide (no scope restriction). */
export const workspaceWide = (ctx: Ctx, permission: string) => listFilter(ctx.actor.access, permission).kind === 'all';

export const toDate = (v: unknown): Date | null => (v === null || v === undefined ? null : v instanceof Date ? v : new Date(String(v)));

export const hoursBetween = (a: Date, b: Date) => (b.getTime() - a.getTime()) / 3_600_000;

/** Prefer 'combined' totals over 'unknown' for one entity; organic/paid breakdowns are never summed with totals. */
export const preferTotals = <T extends { segment: string; entityKey: string }>(rows: T[]): T[] => {
  const hasCombined = new Set(rows.filter((r) => r.segment === 'combined').map((r) => r.entityKey));
  return rows.filter((r) => (r.segment === 'combined' ? true : r.segment === 'unknown' ? !hasCombined.has(r.entityKey) : false));
};

/** A (fractional) amount in minor units as a decimal string of the currency (half-even to whole minor units). */
export const minorDecimal = (minor: Big | bigint, currency: string): string =>
  formatMinor(BigInt((minor instanceof Big ? minor : new Big(minor.toString())).round(0, ROUND_HALF_EVEN).toFixed(0)), currency);
