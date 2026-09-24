import { and, eq, inArray, isNull, lte, gte, sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { can, hasAnywhere, listFilter, type ObjectScope } from '@castlane/authorization';
import {
  campaigns,
  contentItems,
  deals,
  financeCategories,
  memberships,
  periodLocks,
  projects,
  roleAssignments,
  roles,
  socialAccounts,
  workspaces,
  type DbOrTx,
} from '@castlane/database';
import { AppError, formatMinor, isSupportedCurrency, tryParseAmountToMinor, type FieldError } from '@castlane/domain';
import { dbOf, type CommandContext, type QueryContext } from '../core/context';
import { hmac, safeEqual, stableStringify } from '../core/crypto';

/** Decimal-string money on the wire. */
export const moneyOf = (minor: bigint, currency: string) => ({ amount: formatMinor(minor, currency), currency });
export const moneyOrNull = (minor: bigint | null | undefined, currency: string) => (minor === null || minor === undefined ? null : moneyOf(minor, currency));

export const isoDateOf = (d: Date) => d.toISOString().slice(0, 10);

export interface WorkspaceFinance {
  baseCurrency: string;
  timezone: string;
  baseCurrencyLockedAt: Date | null;
}

export const workspaceFinance = async (ctx: QueryContext | CommandContext): Promise<WorkspaceFinance> => {
  const [w] = await dbOf(ctx)
    .select({ baseCurrency: workspaces.baseCurrency, timezone: workspaces.timezone, lockedAt: workspaces.baseCurrencyLockedAt })
    .from(workspaces)
    .where(eq(workspaces.id, ctx.actor.workspaceId));
  if (!w) throw new AppError('NOT_FOUND', 'Workspace was not found.');
  return { baseCurrency: w.baseCurrency.trim(), timezone: w.timezone, baseCurrencyLockedAt: w.lockedAt };
};

/** Parse a user amount for a currency; collects a field error instead of guessing or rounding. */
export const parseAmount = (amount: string, currency: string, field: string, errors: FieldError[], opts: { allowNegative?: boolean; allowZero?: boolean } = {}): bigint => {
  if (!isSupportedCurrency(currency)) {
    errors.push({ field, code: 'CURRENCY', message: 'Unsupported currency.' });
    return 0n;
  }
  const v = tryParseAmountToMinor(amount, currency);
  if (v === null) {
    errors.push({ field, code: 'PRECISION', message: `Enter an amount with at most the decimals of ${currency}.` });
    return 0n;
  }
  if (!opts.allowNegative && v < 0n) errors.push({ field, code: 'NEGATIVE', message: 'The amount cannot be negative.' });
  if (!opts.allowZero && v === 0n) errors.push({ field, code: 'ZERO', message: 'The amount must be above zero.' });
  return v;
};

export const throwIfErrors = (errors: FieldError[], message = 'Some fields need attention.') => {
  if (errors.length) throw new AppError('VALIDATION_FAILED', errors.length === 1 ? errors[0]!.message : message, { fieldErrors: errors });
};

// ——— Scope ———

/**
 * Object scopes of a finance record: one per allocated project, or the account (resolves to its
 * project) / workspace when the record is unallocated.
 */
export const financeScopes = (objectType: string, objectId: string, projectIds: (string | null)[], accountId?: string | null): ObjectScope[] => {
  const unique = [...new Set(projectIds.filter((p): p is string => !!p))];
  if (unique.length === 0) return [{ objectType, objectId, accountId: accountId ?? null }];
  return unique.map((projectId) => ({ objectType, objectId, projectId }));
};

/** Readable when any scope is readable. */
export const canAny = (ctx: QueryContext, permission: string, scopes: ObjectScope[]) => scopes.some((s) => can(ctx.actor.access, permission, s));
/** Actions require every scope (a multi-project document is only changed by someone covering all of it). */
export const canAll = (ctx: QueryContext, permission: string, scopes: ObjectScope[]) => scopes.length > 0 && scopes.every((s) => can(ctx.actor.access, permission, s));

/** 404 when unreadable, 403 when readable but the action is not allowed on every scope. */
export const authorizeFinance = (ctx: QueryContext, action: string, scopes: ObjectScope[], read: string[], opts: { ownRecord?: boolean } = {}) => {
  if (canAll(ctx, action, scopes)) return;
  const readable = read.some((p) => canAny(ctx, p, scopes)) || !!opts.ownRecord;
  if (readable) throw new AppError('FORBIDDEN', 'You do not have permission to perform this action.');
  throw new AppError('NOT_FOUND', 'Record was not found.');
};

/**
 * SQL predicate for records visible under a finance permission. `projectExists` receives the
 * scoped project ids and returns an EXISTS clause over the record's allocations.
 */
export const financeScopeSql = (
  ctx: QueryContext,
  permission: string,
  cols: { projectExists?: (projectIds: string[]) => SQL; projectId?: PgColumn; accountId?: PgColumn; createdBy?: PgColumn },
): SQL | undefined => {
  const f = listFilter(ctx.actor.access, permission);
  const own = cols.createdBy && ctx.actor.userId && hasAnywhere(ctx.actor.access, 'finance.create') ? eq(cols.createdBy, ctx.actor.userId) : undefined;
  if (f.kind === 'all') return undefined;
  const parts: SQL[] = [];
  if (f.kind === 'scoped') {
    if (f.projectIds.length) {
      if (cols.projectExists) parts.push(cols.projectExists(f.projectIds));
      if (cols.projectId) parts.push(inArray(cols.projectId, f.projectIds));
    }
    if (f.accountIds.length && cols.accountId) parts.push(inArray(cols.accountId, f.accountIds));
  }
  if (own) parts.push(own);
  if (parts.length === 0) return sql`false`;
  return parts.length === 1 ? parts[0] : sql`(${sql.join(parts, sql` OR `)})`;
};

/** Workspace-level finance capability (e.g. settlements without allocations, compensation). */
export const hasWorkspaceScope = (ctx: QueryContext, permission: string) => can(ctx.actor.access, permission);

// ——— Period locks ———

export const lockedPeriodFor = async (db: DbOrTx, workspaceId: string, date: string) => {
  const [l] = await db
    .select()
    .from(periodLocks)
    .where(and(eq(periodLocks.workspaceId, workspaceId), eq(periodLocks.state, 'locked'), lte(periodLocks.periodStart, date), gte(periodLocks.periodEnd, date)))
    .limit(1);
  return l ?? null;
};

/** Posting into a closed period is blocked; the caller must use the next period or an audited reopen (T136). */
export const assertPeriodOpen = async (ctx: CommandContext, date: string, what = 'post') => {
  const l = await lockedPeriodFor(ctx.tx, ctx.actor.workspaceId, date);
  if (l)
    throw new AppError('INVALID_STATE', `The period ${l.periodStart} – ${l.periodEnd} is closed. Record the correction in an open period or reopen the period with a reason.`, {
      details: { reason: 'period_closed', periodId: l.id, periodStart: l.periodStart, periodEnd: l.periodEnd, action: what },
    });
};

// ——— Maker-checker ———

/** Other active members who could approve finance (hold the permission, or are Owner). */
export const otherApproverExists = async (ctx: CommandContext, permission: string): Promise<boolean> => {
  const rows = await ctx.tx
    .select({ membershipId: roleAssignments.membershipId, perms: roles.permissions, key: roles.key })
    .from(roleAssignments)
    .innerJoin(roles, and(eq(roles.id, roleAssignments.roleId), eq(roles.workspaceId, roleAssignments.workspaceId)))
    .innerJoin(memberships, and(eq(memberships.id, roleAssignments.membershipId), eq(memberships.workspaceId, roleAssignments.workspaceId)))
    .where(
      and(
        eq(roleAssignments.workspaceId, ctx.actor.workspaceId),
        isNull(roleAssignments.revokedAt),
        eq(memberships.status, 'active'),
        sql`${roleAssignments.validFrom} <= now()`,
        sql`(${roleAssignments.validTo} IS NULL OR ${roleAssignments.validTo} > now())`,
      ),
    );
  return rows.some((r) => r.membershipId !== ctx.actor.membershipId && (r.key === 'owner' || r.perms.includes(permission)));
};

/**
 * The actor may not approve what they submitted. The Owner may use the single-owner exception
 * (reason, audited, visible) only when no second approver exists.
 */
export const checkMakerChecker = async (
  ctx: CommandContext,
  submittedBy: string | null,
  permission: string,
  exceptionReason: string | undefined,
  what: string,
): Promise<string | null> => {
  if (!submittedBy || submittedBy !== ctx.actor.userId) return null;
  if (!ctx.actor.access.isOwner)
    throw new AppError('FORBIDDEN', `You submitted this ${what}. Another authorised member must approve it.`, { details: { selfApprovalRequired: true } });
  if (await otherApproverExists(ctx, permission))
    throw new AppError('FORBIDDEN', `You submitted this ${what}. Another finance approver exists and must approve it.`, { details: { selfApprovalRequired: true, otherApprover: true } });
  if (!exceptionReason?.trim())
    throw new AppError('VALIDATION_FAILED', 'Give a reason for approving your own submission (single-owner exception).', {
      fieldErrors: [{ field: 'exceptionReason', code: 'REQUIRED', message: 'Give a reason for approving your own submission.' }],
      details: { selfApprovalRequired: true },
    });
  return exceptionReason.trim();
};

// ——— Signed preview tokens ———

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
const unb64 = (s: string) => Buffer.from(s, 'base64url').toString('utf8');

export const signToken = (ctx: QueryContext, kind: string, payload: Record<string, unknown>, ttlMs = 10 * 60_000) => {
  const exp = ctx.app.clock.now().getTime() + ttlMs;
  const body = b64(stableStringify({ ...payload, kind, ws: ctx.actor.workspaceId, exp }));
  return { token: `${body}.${hmac(ctx.app.config.SESSION_SECRET, `${kind}:${body}`)}`, expiresAt: new Date(exp) };
};

export const verifyToken = <T extends Record<string, unknown>>(ctx: QueryContext, kind: string, token: string): T => {
  const [body, mac] = token.split('.');
  if (!body || !mac || !safeEqual(mac, hmac(ctx.app.config.SESSION_SECRET, `${kind}:${body}`)))
    throw new AppError('VALIDATION_FAILED', 'The preview is not valid. Preview again.', { fieldErrors: [{ field: 'previewToken', code: 'INVALID', message: 'Preview again.' }] });
  const data = JSON.parse(unb64(body)) as T & { exp: number; ws: string; kind: string };
  if (data.kind !== kind || data.ws !== ctx.actor.workspaceId)
    throw new AppError('VALIDATION_FAILED', 'The preview is not valid. Preview again.', { fieldErrors: [{ field: 'previewToken', code: 'INVALID', message: 'Preview again.' }] });
  if (data.exp < ctx.app.clock.now().getTime())
    throw new AppError('INVALID_STATE', 'The preview expired. Preview again.', { details: { reason: 'preview_expired' } });
  return data;
};

// ——— Reference names ———

export const loadNames = async (
  ctx: QueryContext | CommandContext,
  ids: { projects?: (string | null)[]; campaigns?: (string | null)[]; contentItems?: (string | null)[]; accounts?: (string | null)[]; deals?: (string | null)[] },
) => {
  const db = dbOf(ctx);
  const ws = ctx.actor.workspaceId;
  const u = (l?: (string | null)[]) => [...new Set((l ?? []).filter((x): x is string => !!x))];
  const p = u(ids.projects);
  const c = u(ids.campaigns);
  const ci = u(ids.contentItems);
  const a = u(ids.accounts);
  const d = u(ids.deals);
  const out = {
    projects: new Map<string, string>(),
    campaigns: new Map<string, string>(),
    contentItems: new Map<string, string>(),
    accounts: new Map<string, string>(),
    deals: new Map<string, string>(),
  };
  if (p.length) for (const r of await db.select({ id: projects.id, name: projects.name }).from(projects).where(and(eq(projects.workspaceId, ws), inArray(projects.id, p)))) out.projects.set(r.id, r.name);
  if (c.length) for (const r of await db.select({ id: campaigns.id, name: campaigns.name }).from(campaigns).where(and(eq(campaigns.workspaceId, ws), inArray(campaigns.id, c)))) out.campaigns.set(r.id, r.name);
  if (ci.length) for (const r of await db.select({ id: contentItems.id, name: contentItems.title }).from(contentItems).where(and(eq(contentItems.workspaceId, ws), inArray(contentItems.id, ci)))) out.contentItems.set(r.id, r.name);
  if (a.length)
    for (const r of await db.select({ id: socialAccounts.id, handle: socialAccounts.handle, url: socialAccounts.canonicalUrl, platform: socialAccounts.platform }).from(socialAccounts).where(and(eq(socialAccounts.workspaceId, ws), inArray(socialAccounts.id, a))))
      out.accounts.set(r.id, r.handle ? `@${r.handle} · ${r.platform}` : r.url);
  if (d.length) for (const r of await db.select({ id: deals.id, name: deals.title }).from(deals).where(and(eq(deals.workspaceId, ws), inArray(deals.id, d)))) out.deals.set(r.id, r.name);
  return out;
};

export const refFrom = (m: Map<string, string>, id: string | null | undefined) => (id ? { id, name: m.get(id) ?? 'Unavailable record' } : null);

export type FinanceCategoryRow = typeof financeCategories.$inferSelect;

export const loadCategoryMap = async (ctx: QueryContext | CommandContext, ids?: string[]) => {
  const rows = await dbOf(ctx)
    .select()
    .from(financeCategories)
    .where(and(eq(financeCategories.workspaceId, ctx.actor.workspaceId), ids ? inArray(financeCategories.id, ids.length ? ids : ['00000000-0000-0000-0000-000000000000']) : undefined));
  return new Map(rows.map((r) => [r.id, r]));
};

/** Resolve a membership's user id (for notifications to authors). */
export const membershipOfUser = async (db: DbOrTx, workspaceId: string, userId: string | null) => {
  if (!userId) return null;
  const [m] = await db.select({ id: memberships.id }).from(memberships).where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, userId)));
  return m?.id ?? null;
};

export const userMembershipMap = async (db: DbOrTx, workspaceId: string, userIds: (string | null | undefined)[]) => {
  const ids = [...new Set(userIds.filter((x): x is string => !!x))];
  const out = new Map<string, string>();
  if (!ids.length) return out;
  for (const r of await db.select({ id: memberships.id, userId: memberships.userId }).from(memberships).where(and(eq(memberships.workspaceId, workspaceId), inArray(memberships.userId, ids)))) out.set(r.userId, r.id);
  return out;
};
