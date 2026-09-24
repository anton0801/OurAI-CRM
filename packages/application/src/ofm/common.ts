import { and, asc, desc, eq, gt, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { hasAnywhere, type ObjectScope } from '@castlane/authorization';
import {
  assets,
  memberships,
  ofmProfiles,
  projects,
  socialAccounts,
  userPreferences,
  workspaces,
  type DbOrTx,
  type OfmProfileSettings,
} from '@castlane/database';
import { AppError, CONTACT_STAGES, clampPageSize, decodeCursor, encodeCursor, type FieldError } from '@castlane/domain';
import { allowed } from '../core/access';
import { dbOf, type CommandContext, type QueryContext } from '../core/context';
import { hmac, safeEqual } from '../core/crypto';
import { isActiveMember } from '../core/members';

/** Shared OFM helpers: account/project loading, scope objects, preview tokens, validation errors. */

export type Ctx = QueryContext | CommandContext;

export const me = (ctx: Ctx): string => ctx.actor.membershipId ?? '00000000-0000-4000-8000-000000000000';

export const fieldErr = (field: string, code: string, message: string): AppError =>
  new AppError('VALIDATION_FAILED', message, { fieldErrors: [{ field, code, message }] });

export const fieldErrs = (errors: FieldError[], message = 'Some fields need attention.'): AppError =>
  new AppError('VALIDATION_FAILED', errors.length === 1 ? errors[0]!.message : message, { fieldErrors: errors });

export const invalid = (message: string, details?: Record<string, unknown>) => new AppError('INVALID_STATE', message, { details });

// ——— Accounts & projects ———

export interface AccountInfo {
  id: string;
  projectId: string;
  platform: (typeof socialAccounts.$inferSelect)['platform'];
  handle: string | null;
  displayName: string | null;
  canonicalUrl: string;
  status: string;
  archivedAt: Date | null;
  deletedAt: Date | null;
  ownerMembershipId: string;
}

export const loadAccountInfos = async (db: DbOrTx, workspaceId: string, ids: (string | null | undefined)[]): Promise<Map<string, AccountInfo>> => {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  if (!unique.length) return new Map();
  const rows = await db
    .select({
      id: socialAccounts.id,
      projectId: socialAccounts.projectId,
      platform: socialAccounts.platform,
      handle: socialAccounts.handle,
      displayName: socialAccounts.displayName,
      canonicalUrl: socialAccounts.canonicalUrl,
      status: socialAccounts.status,
      archivedAt: socialAccounts.archivedAt,
      deletedAt: socialAccounts.deletedAt,
      ownerMembershipId: socialAccounts.ownerMembershipId,
    })
    .from(socialAccounts)
    .where(and(eq(socialAccounts.workspaceId, workspaceId), inArray(socialAccounts.id, unique)));
  return new Map(rows.map((r) => [r.id, r]));
};

export const accountLabel = (a: Pick<AccountInfo, 'handle' | 'displayName' | 'canonicalUrl'>) =>
  a.handle ? `@${a.handle.replace(/^@/, '')}` : (a.displayName ?? a.canonicalUrl);

export const toAccountRef = (a: AccountInfo) => ({
  id: a.id,
  label: accountLabel(a),
  handle: a.handle,
  platform: a.platform,
  projectId: a.projectId,
  status: a.archivedAt ? 'archived' : a.status,
});

export const accountRefOr = (m: Map<string, AccountInfo>, id: string, projectId: string) => {
  const a = m.get(id);
  return a ? toAccountRef(a) : { id, label: 'Unknown account', handle: null, platform: 'other' as const, projectId, status: 'unknown' };
};

export interface ProjectInfo {
  id: string;
  name: string;
  type: (typeof projects.$inferSelect)['type'];
  status: (typeof projects.$inferSelect)['status'];
  ofmEnabled: boolean;
  directionId: string;
  coverAssetId: string | null;
  ownerMembershipId: string;
}

export const loadProjectInfos = async (db: DbOrTx, workspaceId: string, ids: (string | null | undefined)[]): Promise<Map<string, ProjectInfo>> => {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  if (!unique.length) return new Map();
  const rows = await db
    .select({
      id: projects.id,
      name: projects.name,
      type: projects.type,
      status: projects.status,
      ofmEnabled: projects.ofmEnabled,
      directionId: projects.directionId,
      coverAssetId: projects.coverAssetId,
      ownerMembershipId: projects.ownerMembershipId,
    })
    .from(projects)
    .where(and(eq(projects.workspaceId, workspaceId), inArray(projects.id, unique)));
  return new Map(rows.map((r) => [r.id, r]));
};

export const projectRefOr = (m: Map<string, ProjectInfo>, id: string) => ({ id, name: m.get(id)?.name ?? 'Unknown project' });

export const isOfmProject = (p: Pick<ProjectInfo, 'ofmEnabled' | 'type'>) => p.ofmEnabled && p.type !== 'series';

/**
 * Load an account for an OFM command: it must exist in the workspace, belong to a model/influencer
 * project with OFM enabled and not be archived. Optional row lock serialises schedule changes.
 */
export const requireOfmAccount = async (ctx: CommandContext | QueryContext, accountId: string, field = 'accountId') => {
  const db = dbOf(ctx);
  const accounts = await loadAccountInfos(db, ctx.actor.workspaceId, [accountId]);
  const account = accounts.get(accountId);
  if (!account || account.deletedAt) throw fieldErr(field, 'NOT_FOUND', 'Choose an existing account.');
  const project = (await loadProjectInfos(db, ctx.actor.workspaceId, [account.projectId])).get(account.projectId)!;
  if (!isOfmProject(project)) throw fieldErr(field, 'OFM_NOT_ENABLED', 'OFM is not enabled for this account’s model project.');
  return { account, project };
};

export const assertAccountOpen = (a: AccountInfo, field = 'accountId') => {
  if (a.archivedAt) throw fieldErr(field, 'ARCHIVED', 'This account is archived.');
};

// ——— Profiles / settings ———

export const DEFAULT_STAGE_LABELS: Record<(typeof CONTACT_STAGES)[number], string> = {
  new: 'New',
  active: 'Active',
  follow_up: 'Follow-up',
  inactive: 'Inactive',
  archived: 'Archived',
};

export interface ResolvedSettings {
  handoverRequired: boolean;
  maxShiftAccounts: number;
  contactStageLabels: Record<(typeof CONTACT_STAGES)[number], string>;
}

export const resolveSettings = (s: OfmProfileSettings | null | undefined, workspaceMax?: number): ResolvedSettings => ({
  handoverRequired: s?.handoverRequired ?? true,
  maxShiftAccounts: Math.min(10, Math.max(1, s?.maxShiftAccounts ?? workspaceMax ?? 10)),
  contactStageLabels: { ...DEFAULT_STAGE_LABELS, ...(s?.contactStageLabels ?? {}) } as ResolvedSettings['contactStageLabels'],
});

export const loadProfiles = async (db: DbOrTx, workspaceId: string, projectIds: string[]) => {
  const unique = [...new Set(projectIds)];
  if (!unique.length) return new Map<string, typeof ofmProfiles.$inferSelect>();
  const rows = await db
    .select()
    .from(ofmProfiles)
    .where(and(eq(ofmProfiles.workspaceId, workspaceId), inArray(ofmProfiles.projectId, unique)));
  return new Map(rows.map((r) => [r.projectId, r]));
};

export const workspaceInfo = async (db: DbOrTx, workspaceId: string) => {
  const [w] = await db.select({ timezone: workspaces.timezone, settings: workspaces.settings }).from(workspaces).where(eq(workspaces.id, workspaceId));
  return { timezone: w?.timezone ?? 'UTC', settings: w?.settings ?? {} };
};

/** Personal time zone of members (falls back to the workspace zone). */
export const memberTimezones = async (db: DbOrTx, workspaceId: string, ids: string[]): Promise<Map<string, string>> => {
  const unique = [...new Set(ids.filter(Boolean))];
  const out = new Map<string, string>();
  if (!unique.length) return out;
  const ws = await workspaceInfo(db, workspaceId);
  const rows = await db
    .select({ id: memberships.id, tz: userPreferences.timezone })
    .from(memberships)
    .leftJoin(userPreferences, eq(userPreferences.userId, memberships.userId))
    .where(and(eq(memberships.workspaceId, workspaceId), inArray(memberships.id, unique)));
  for (const r of rows) out.set(r.id, r.tz ?? ws.timezone);
  for (const id of unique) if (!out.has(id)) out.set(id, ws.timezone);
  return out;
};

export const assertActiveMember = async (ctx: CommandContext, membershipId: string, field: string, message = 'Choose an active member.') => {
  if (!(await isActiveMember(ctx.tx, ctx.actor.workspaceId, membershipId))) throw fieldErr(field, 'INACTIVE', message);
};

/** Assignment and role changes change what a member can see: invalidate their cached access. */
export const bumpAccessRevision = async (ctx: CommandContext, membershipIds: (string | null | undefined)[]) => {
  const ids = [...new Set(membershipIds.filter((x): x is string => !!x))];
  for (const id of ids)
    await ctx.tx.execute(sql`UPDATE memberships SET access_revision = access_revision + 1 WHERE id = ${id} AND workspace_id = ${ctx.actor.workspaceId}`);
};

/** Transaction-scoped advisory lock (sorted keys → no deadlocks) for schedule consistency checks. */
export const advisoryLocks = async (ctx: CommandContext, keys: string[]) => {
  for (const k of [...new Set(keys)].sort()) await ctx.tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${k}))`);
};

// ——— Evidence ———

/** Evidence asset ids must exist in the workspace (not deleted). */
export const assertAssetsExist = async (ctx: CommandContext, ids: string[] | undefined, field: string) => {
  const unique = [...new Set(ids ?? [])];
  if (!unique.length) return [];
  const rows = await ctx.tx
    .select({ id: assets.id, deletedAt: assets.deletedAt })
    .from(assets)
    .where(and(eq(assets.workspaceId, ctx.actor.workspaceId), inArray(assets.id, unique)));
  const ok = new Set(rows.filter((r) => !r.deletedAt).map((r) => r.id));
  const missing = unique.filter((id) => !ok.has(id));
  if (missing.length) throw fieldErr(field, 'NOT_FOUND', 'Some evidence files were not found.');
  return unique;
};

// ——— Sensitive text guard (§S45: no passwords, cards or intimate profiles) ———

const luhn = (digits: string) => {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i]);
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
};

/** Rejects text that looks like payment card numbers or credentials. Returns a message or null. */
export const forbiddenContentIssue = (text: string | null | undefined): string | null => {
  if (!text) return null;
  const candidates = text.match(/(?:\d[ -]?){13,19}/g) ?? [];
  for (const c of candidates) {
    const digits = c.replace(/\D/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) return 'Do not store payment card numbers.';
  }
  if (/\b(password|passwd|pwd|passcode|cvv|cvc|pin code)\s*[:=]/i.test(text)) return 'Do not store passwords or card security codes.';
  return null;
};

export const assertNoForbiddenContent = (field: string, text: string | null | undefined) => {
  const issue = forbiddenContentIssue(text);
  if (issue) throw fieldErr(field, 'FORBIDDEN_CONTENT', issue);
};

// ——— Signed preview tokens (merge preview, repeat schedule) ———

export const signToken = (ctx: Ctx, kind: string, payload: Record<string, unknown>, ttlMinutes = 10) => {
  const expiresAt = new Date(ctx.app.clock.now().getTime() + ttlMinutes * 60_000);
  const body = Buffer.from(JSON.stringify({ k: kind, w: ctx.actor.workspaceId, m: ctx.actor.membershipId, exp: expiresAt.toISOString(), p: payload })).toString('base64url');
  return { token: `${body}.${hmac(ctx.app.config.SESSION_SECRET, `ofm:${kind}:${body}`)}`, expiresAt };
};

export const verifyToken = <T>(ctx: Ctx, kind: string, token: string): T => {
  const [body, sig] = token.split('.');
  if (!body || !sig || !safeEqual(sig, hmac(ctx.app.config.SESSION_SECRET, `ofm:${kind}:${body}`)))
    throw fieldErr('previewToken', 'INVALID', 'The preview is not valid. Preview again.');
  const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { k: string; w: string; m: string | null; exp: string; p: T };
  if (data.k !== kind || data.w !== ctx.actor.workspaceId || data.m !== ctx.actor.membershipId)
    throw fieldErr('previewToken', 'INVALID', 'The preview is not valid. Preview again.');
  if (new Date(data.exp).getTime() < ctx.app.clock.now().getTime()) throw fieldErr('previewToken', 'EXPIRED', 'The preview expired. Preview again.');
  return data.p;
};

// ——— Scope helpers ———

export const holds = (ctx: Ctx, permission: string) => hasAnywhere(ctx.actor.access, permission);

export const canAny = (ctx: Ctx, permissions: string[], scope: ObjectScope) => permissions.some((p) => allowed(ctx, p, scope));

/** OR of optional predicates where `undefined` means "unrestricted". */
export const anyOf = (...preds: (SQL | undefined | null | false)[]): SQL | undefined => {
  const list = preds.filter((p): p is SQL | undefined => p !== null && p !== false);
  if (list.some((p) => p === undefined)) return undefined;
  const present = list.filter((p): p is SQL => !!p);
  if (!present.length) return sql`false`;
  return present.length === 1 ? present[0] : or(...present);
};

// ——— Keyset pagination on arbitrary sort expressions ———

export type SortKind = 'timestamp' | 'text' | 'number';

/**
 * Keyset pagination over (expression, id): the expression may be a COALESCE of a nullable column,
 * so rows with unknown values keep a stable place in the order (never dropped or repeated).
 */
export const exprKeyset = (expr: SQL | PgColumn, idCol: PgColumn, kind: SortKind, direction: 'asc' | 'desc', req: { cursor?: string; pageSize?: number }) => {
  const pageSize = clampPageSize(req.pageSize);
  const c = req.cursor ? decodeCursor(req.cursor) : null;
  let where: SQL | undefined;
  if (c) {
    const raw = c.v[0];
    const value = kind === 'timestamp' ? new Date(String(raw)) : kind === 'number' ? Number(raw) : String(raw ?? '');
    const cmp = direction === 'asc' ? gt : lt;
    where = or(cmp(expr as never, value as never), and(sql`${expr} = ${value}`, cmp(idCol, c.id)));
  }
  const orderBy = direction === 'asc' ? [asc(expr as never), asc(idCol)] : [desc(expr as never), desc(idCol)];
  return {
    where,
    orderBy,
    limit: pageSize + 1,
    finish: <T>(rows: T[], sortValue: (r: T) => string | number | Date | null, id: (r: T) => string) => {
      const hasMore = rows.length > pageSize;
      const items = hasMore ? rows.slice(0, pageSize) : rows;
      const last = items[items.length - 1];
      let v: string | number | null = null;
      if (last) {
        const sv = sortValue(last);
        v = sv instanceof Date ? sv.toISOString() : sv;
      }
      return { items, hasMore, nextCursor: hasMore && last ? encodeCursor({ v: [v], id: id(last) }) : null };
    },
  };
};

export const notDeletedAccount = isNull(socialAccounts.deletedAt);
