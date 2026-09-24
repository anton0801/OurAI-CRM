import { and, asc, count, desc, eq, gt, inArray, isNull, lt, min, ne, or, sql, type SQL } from 'drizzle-orm';
import {
  accountAssignments,
  accountIdentityHistory,
  accountStatusEvents,
  metricCheckpoints,
  metricObservations,
  ofmAssignments,
  projects,
  publications,
  shifts,
  socialAccounts,
  tasks,
} from '@castlane/database';
import {
  AppError,
  assertTransition,
  newId,
  normalizeProfileUrl,
  notFound,
  type ProfileUrlError,
  type TransitionTable,
} from '@castlane/domain';
import type { ImpactItem } from '@castlane/api-contracts';
import { allowed, authorizeObject, authorizeRead, requirePermission, whereAll } from '../core/access';
import { audit, diffFields } from '../core/audit';
import { all, dbOf, type CommandContext, type QueryContext } from '../core/context';
import { emit } from '../core/events';
import { isActiveMember, loadMemberRefs, refOrUnknown } from '../core/members';
import { notify } from '../core/notify';
import { assertVersion, lockById, stamp, touch } from '../core/rows';
import { indexSearchDocument } from '../core/search';
import { resolveTags } from '../core/tags';
import { linkAsset } from '../media/assets';
import { assertAssetUsable, bumpAccessRevision, finishPage, keysetWhere, likeOf, pageSizeOf, projectNames, thumbUrl, type SortKind } from './helpers';
import { accountScope, accountVisibility, openAssigneeIds, scopeOfAccount, type AccountRow, type AccountStatus } from './scope';

/**
 * Account lifecycle (section 9): Preparing → Active ↔ Paused; Active/Paused → Restricted;
 * Restricted → Active after resolution; any state without blocking obligations → Archived.
 */
export const ACCOUNT_TRANSITIONS: TransitionTable<AccountStatus> = {
  preparing: ['active', 'archived'],
  active: ['paused', 'restricted', 'archived'],
  paused: ['active', 'restricted', 'archived'],
  restricted: ['active', 'archived'],
  archived: [],
};

const PLATFORM_LABEL: Record<string, string> = {
  instagram: 'Instagram',
  tiktok: 'TikTok',
  youtube: 'YouTube',
  x: 'X',
  onlyfans: 'OnlyFans',
  fansly: 'Fansly',
  other: 'Custom',
};

const URL_ERROR_MESSAGE: Record<ProfileUrlError, string> = {
  INVALID_URL: 'Enter a valid profile link (https://…).',
  HTTPS_REQUIRED: 'Use an https:// link.',
  HOST_MISMATCH: 'This link does not belong to the selected platform. Choose Custom for other sites.',
};

// ——— Loading & read models ———

export const loadAccount = async (ctx: QueryContext | CommandContext, id: string, opts: { lock?: boolean } = {}): Promise<AccountRow> => {
  const row =
    opts.lock && 'tx' in ctx
      ? await lockById(ctx, socialAccounts, id, 'Account')
      : (await dbOf(ctx).select().from(socialAccounts).where(and(eq(socialAccounts.workspaceId, ctx.actor.workspaceId), eq(socialAccounts.id, id))))[0];
  if (!row || row.deletedAt) throw notFound('Account');
  return row;
};

const accountLabel = (a: Pick<AccountRow, 'handle' | 'displayName' | 'canonicalUrl'>) => (a.handle ? `@${a.handle}` : (a.displayName ?? a.canonicalUrl));

const summaryExtras = async (ctx: QueryContext | CommandContext, rows: AccountRow[]) => {
  const ids = rows.map((r) => r.id);
  const db = dbOf(ctx);
  const ws = ctx.actor.workspaceId;
  const now = ctx.app.clock.now();
  if (!ids.length) return { metrics: new Map<string, Date | null>(), next: new Map<string, Date | null>(), missing: new Map<string, number>(), projects: new Map(), refs: new Map() };
  const [metricRows, pubRows, missingRows, projectMap, refs] = await all(ctx, [
    // Latest usable observation per account: one backward probe of metric_observations_account_idx
    // per account instead of aggregating every observation of the page's accounts.
    () =>
      db
        .select({
          accountId: socialAccounts.id,
          last: sql<Date | null>`(SELECT o.observed_at FROM metric_observations o WHERE o.workspace_id = "social_accounts"."workspace_id" AND o.account_id = "social_accounts"."id" AND o.quality_state NOT IN ('superseded', 'rejected') ORDER BY o.observed_at DESC LIMIT 1)`.mapWith(metricObservations.observedAt),
        })
        .from(socialAccounts)
        .where(and(eq(socialAccounts.workspaceId, ws), inArray(socialAccounts.id, ids))),
    () =>
      db
        .select({ accountId: publications.accountId, next: min(publications.scheduledAt) })
        .from(publications)
        .where(and(eq(publications.workspaceId, ws), inArray(publications.accountId, ids), eq(publications.status, 'scheduled'), gt(publications.scheduledAt, now)))
        .groupBy(publications.accountId),
    () =>
      db
        .select({ accountId: metricCheckpoints.accountId, n: count() })
        .from(metricCheckpoints)
        .where(
          and(
            eq(metricCheckpoints.workspaceId, ws),
            inArray(metricCheckpoints.accountId, ids),
            or(eq(metricCheckpoints.state, 'missing'), and(eq(metricCheckpoints.state, 'pending'), lt(metricCheckpoints.windowEnd, now))),
          ),
        )
        .groupBy(metricCheckpoints.accountId),
    () => projectNames(ctx, rows.map((r) => r.projectId)),
    () => loadMemberRefs(db, ws, rows.map((r) => r.ownerMembershipId)),
  ] as const);
  return {
    metrics: new Map(metricRows.map((m) => [m.accountId, m.last])),
    next: new Map(pubRows.map((p) => [p.accountId, p.next])),
    missing: new Map(missingRows.map((m) => [m.accountId, Number(m.n)])),
    projects: projectMap,
    refs,
  };
};

const toSummary = (r: AccountRow, x: Awaited<ReturnType<typeof summaryExtras>>) => {
  const last = x.metrics.get(r.id);
  const next = x.next.get(r.id);
  const p = x.projects.get(r.projectId);
  return {
    id: r.id,
    platform: r.platform,
    handle: r.handle,
    displayName: r.displayName,
    canonicalUrl: r.canonicalUrl,
    originalUrl: r.originalUrl,
    project: { id: r.projectId, name: p?.name ?? 'Unknown project' },
    owner: refOrUnknown(x.refs, r.ownerMembershipId)!,
    status: r.status,
    statusReason: r.statusReason,
    tags: r.tags,
    avatarUrl: thumbUrl(r.workspaceId, r.avatarAssetId, 64),
    lastMetricsAt: last ? last.toISOString() : null,
    nextPublicationAt: next ? next.toISOString() : null,
    missingCheckpoints: x.missing.get(r.id) ?? 0,
    archivedAt: r.archivedAt?.toISOString() ?? null,
    updatedAt: r.updatedAt.toISOString(),
    rowVersion: r.rowVersion,
  };
};

export interface ListAccountsInput {
  cursor?: string;
  pageSize?: number;
  q?: string;
  platform?: AccountRow['platform'][];
  status?: AccountStatus[];
  projectId?: string;
  ownerMembershipId?: string;
  assignedMembershipId?: string;
  tag?: string;
  includeArchived?: boolean;
  sort: 'handle' | 'updatedAt' | 'status' | 'platform';
  direction: 'asc' | 'desc';
}

const SORTS: Record<ListAccountsInput['sort'], { expr: SQL; kind: SortKind; value: (r: AccountRow) => string }> = {
  handle: { expr: sql`lower(coalesce(${socialAccounts.handle}, ${socialAccounts.displayName}, ${socialAccounts.canonicalUrl}))`, kind: 'text', value: (r) => (r.handle ?? r.displayName ?? r.canonicalUrl).toLowerCase() },
  updatedAt: { expr: sql`${socialAccounts.updatedAt}`, kind: 'timestamp', value: (r) => r.updatedAt.toISOString() },
  status: { expr: sql`${socialAccounts.status}`, kind: 'text', value: (r) => r.status },
  platform: { expr: sql`${socialAccounts.platform}`, kind: 'text', value: (r) => r.platform },
};

export const listAccounts = async (ctx: QueryContext, input: ListAccountsInput) => {
  requirePermission(ctx, 'accounts.read');
  const size = pageSizeOf(input.pageSize);
  const s = SORTS[input.sort];
  const now = ctx.app.clock.now();
  const where = whereAll(
    eq(socialAccounts.workspaceId, ctx.actor.workspaceId),
    isNull(socialAccounts.deletedAt),
    // Scope is part of the SQL: out-of-scope accounts are never counted or paged.
    accountVisibility(ctx, 'accounts.read'),
    input.includeArchived ? undefined : isNull(socialAccounts.archivedAt),
    input.platform?.length ? inArray(socialAccounts.platform, input.platform) : undefined,
    input.status?.length ? inArray(socialAccounts.status, input.status) : undefined,
    input.projectId ? eq(socialAccounts.projectId, input.projectId) : undefined,
    input.ownerMembershipId ? eq(socialAccounts.ownerMembershipId, input.ownerMembershipId) : undefined,
    input.assignedMembershipId
      ? sql`EXISTS (SELECT 1 FROM account_assignments aa WHERE aa.account_id = ${socialAccounts.id} AND aa.membership_id = ${input.assignedMembershipId}::uuid AND (aa.valid_to IS NULL OR aa.valid_to > ${now}))`
      : undefined,
    input.tag ? sql`lower(${input.tag}) = ANY(SELECT lower(t) FROM unnest(${socialAccounts.tags}) t)` : undefined,
    input.q
      ? or(
          sql`${socialAccounts.handle} ILIKE ${likeOf(input.q)}`,
          sql`${socialAccounts.displayName} ILIKE ${likeOf(input.q)}`,
          sql`${socialAccounts.canonicalUrl} ILIKE ${likeOf(input.q)}`,
        )
      : undefined,
    keysetWhere(s.expr, socialAccounts.id, input.direction, input.cursor, s.kind),
  );
  const rows = await ctx.app.db
    .select()
    .from(socialAccounts)
    .where(where)
    .orderBy(input.direction === 'asc' ? asc(s.expr) : desc(s.expr), input.direction === 'asc' ? asc(socialAccounts.id) : desc(socialAccounts.id))
    .limit(size + 1);
  return finishPage(rows, size, s.value, async (page) => {
    const x = await summaryExtras(ctx, page);
    return page.map((r) => toSummary(r, x));
  });
};

const assignmentView = (a: typeof accountAssignments.$inferSelect, refs: Awaited<ReturnType<typeof loadMemberRefs>>) => ({
  id: a.id,
  member: refOrUnknown(refs, a.membershipId)!,
  duty: a.duty,
  supervisor: refOrUnknown(refs, a.supervisorMembershipId),
  validFrom: a.validFrom.toISOString(),
  validTo: a.validTo?.toISOString() ?? null,
  endedReason: a.endedReason,
  rowVersion: a.rowVersion,
});

export const listAccountAssignments = async (ctx: QueryContext | CommandContext, accountId: string, input: { includeEnded?: boolean } = {}, preloaded?: AccountRow) => {
  const a = preloaded ?? (await loadAccount(ctx, accountId));
  if (!preloaded) authorizeRead(ctx, 'accounts.read', await scopeOfAccount(ctx, a));
  const now = ctx.app.clock.now();
  const db = dbOf(ctx);
  const rows = await db
    .select()
    .from(accountAssignments)
    .where(
      and(
        eq(accountAssignments.workspaceId, ctx.actor.workspaceId),
        eq(accountAssignments.accountId, accountId),
        input.includeEnded ? undefined : or(isNull(accountAssignments.validTo), gt(accountAssignments.validTo, now)),
      ),
    )
    .orderBy(desc(accountAssignments.validFrom));
  const refs = await loadMemberRefs(db, ctx.actor.workspaceId, rows.flatMap((r) => [r.membershipId, r.supervisorMembershipId]));
  return rows.map((r) => assignmentView(r, refs));
};

export const getAccount = async (ctx: QueryContext | CommandContext, id: string) => {
  const a = await loadAccount(ctx, id);
  const scope = await scopeOfAccount(ctx, a);
  authorizeRead(ctx, 'accounts.read', scope);
  const x = await summaryExtras(ctx, [a]);
  const assignments = await listAccountAssignments(ctx, id, {}, a);
  const archived = a.status === 'archived';
  const canWrite = allowed(ctx, 'accounts.write', scope);
  const canArchive = allowed(ctx, 'accounts.archive', scope);
  const allowedTransitions = (ACCOUNT_TRANSITIONS[a.status] ?? []).filter((t) => (t === 'archived' ? canArchive : canWrite));
  return {
    ...toSummary(a, x),
    language: a.language,
    markets: a.markets,
    purpose: a.purpose,
    notes: a.notes,
    avatarAssetId: a.avatarAssetId,
    metricsCadence: a.metricsCadence,
    metricsDayOfWeek: a.metricsDayOfWeek,
    metricsTime: a.metricsTime,
    captionMaxLength: a.captionMaxLength,
    assignments,
    allowedTransitions,
    permissions: {
      update: canWrite && !archived,
      assign: allowed(ctx, 'accounts.assign', scope) && !archived,
      archive: canArchive,
      transfer: canWrite && !archived,
      transition: canWrite || canArchive,
      createPublication: allowed(ctx, 'publications.write', scope) && !archived && a.status !== 'restricted',
      addMetrics: allowed(ctx, 'metrics.write', scope),
    },
  };
};

// ——— URL identity ———

const TRACKING_KEYS = /^(utm_[a-z]+|igsh|igshid|si|fbclid|gclid|ref|ref_src|_t|_r|is_from_webapp|sender_device|feature)$/i;

export const normalizeOrThrow = (platform: AccountRow['platform'], url: string, field = 'profileUrl') => {
  const n = normalizeProfileUrl(url, platform);
  if (!n.ok) throw new AppError('VALIDATION_FAILED', URL_ERROR_MESSAGE[n.error], { fieldErrors: [{ field, code: n.error, message: URL_ERROR_MESSAGE[n.error] }] });
  return n.value;
};

/** Existing (non-archived) account with the same canonical identity, if any. */
const findByIdentity = async (ctx: QueryContext | CommandContext, identityKey: string, excludeId?: string) => {
  const [row] = await dbOf(ctx)
    .select()
    .from(socialAccounts)
    .where(
      and(
        eq(socialAccounts.workspaceId, ctx.actor.workspaceId),
        eq(socialAccounts.identityKey, identityKey),
        isNull(socialAccounts.archivedAt),
        isNull(socialAccounts.deletedAt),
        excludeId ? ne(socialAccounts.id, excludeId) : undefined,
      ),
    )
    .limit(1);
  return row ?? null;
};

/** Safe description of a duplicate: details only when the existing account is readable (T028). */
const describeDuplicate = async (ctx: QueryContext | CommandContext, existing: AccountRow) => {
  const readable = allowed(ctx, 'accounts.read', await scopeOfAccount(ctx, existing));
  if (!readable) return { account: null };
  const p = (await projectNames(ctx, [existing.projectId])).get(existing.projectId);
  return { account: { id: existing.id, handle: existing.handle, platform: existing.platform, projectName: p?.name ?? 'Unknown project', status: existing.status } };
};

const duplicateError = async (ctx: QueryContext | CommandContext, existing: AccountRow) => {
  const d = await describeDuplicate(ctx, existing);
  const message = d.account ? 'This account is already registered. Open the existing record instead.' : 'An account with this profile link already exists in the workspace.';
  return new AppError('DUPLICATE', message, { fieldErrors: [{ field: 'profileUrl', code: 'DUPLICATE', message }], details: { existing: d.account } });
};

export const previewAccountUrl = async (ctx: QueryContext, input: { platform: AccountRow['platform']; url: string; excludeAccountId?: string }) => {
  requirePermission(ctx, 'accounts.write');
  const n = normalizeProfileUrl(input.url, input.platform);
  let removed: string[] = [];
  try {
    removed = [...new URL(input.url.trim()).searchParams.keys()].filter((k) => TRACKING_KEYS.test(k));
  } catch {
    removed = [];
  }
  if (!n.ok) return { ok: false, error: n.error, message: URL_ERROR_MESSAGE[n.error], canonicalUrl: null, handle: null, host: null, removedParams: [], duplicate: null };
  const existing = await findByIdentity(ctx, n.value.identityKey, input.excludeAccountId);
  return {
    ok: true,
    error: null,
    message: null,
    canonicalUrl: n.value.canonicalUrl,
    handle: n.value.handle,
    host: n.value.host,
    removedParams: removed,
    duplicate: existing ? await describeDuplicate(ctx, existing) : null,
  };
};

// ——— Commands ———

export const indexAccount = async (ctx: CommandContext, a: AccountRow) => {
  const assignees = await openAssigneeIds(ctx.tx, ctx.actor.workspaceId, a.id, ctx.app.clock.now());
  await indexSearchDocument(ctx.tx, {
    workspaceId: ctx.actor.workspaceId,
    entityType: 'account',
    entityId: a.id,
    title: accountLabel(a),
    body: [a.canonicalUrl, a.handle, a.displayName, PLATFORM_LABEL[a.platform], a.purpose, a.tags.join(' ')].filter(Boolean).join('\n'),
    projectId: a.projectId,
    accountId: a.id,
    permission: 'accounts.read',
    ownerMembershipId: a.ownerMembershipId,
    assigneeMembershipIds: assignees,
    archived: a.status === 'archived' || !!a.deletedAt,
    status: a.status,
    thumbnailAssetId: a.avatarAssetId,
    at: ctx.app.clock.now(),
  });
};

const loadProjectForAccount = async (ctx: CommandContext, projectId: string, field = 'projectId') => {
  const [p] = await ctx.tx.select().from(projects).where(and(eq(projects.workspaceId, ctx.actor.workspaceId), eq(projects.id, projectId)));
  if (!p || p.deletedAt) throw new AppError('VALIDATION_FAILED', 'Choose a project you can access.', { fieldErrors: [{ field, code: 'NOT_FOUND', message: 'Choose a project you can access.' }] });
  const scope = { objectType: 'project', objectId: p.id, projectId: p.id, directionId: p.directionId, ownerMembershipId: p.ownerMembershipId };
  if (!allowed(ctx, 'accounts.write', scope)) {
    if (!allowed(ctx, 'projects.read', scope) && !allowed(ctx, 'accounts.read', scope))
      throw new AppError('VALIDATION_FAILED', 'Choose a project you can access.', { fieldErrors: [{ field, code: 'NOT_FOUND', message: 'Choose a project you can access.' }] });
    throw new AppError('FORBIDDEN', 'You cannot add accounts to this project.');
  }
  if (p.status === 'archived') throw new AppError('INVALID_STATE', 'Archived projects cannot get new accounts.', { fieldErrors: [{ field, code: 'ARCHIVED', message: 'This project is archived.' }] });
  return p;
};

const assertOwner = async (ctx: CommandContext, membershipId: string) => {
  if (!(await isActiveMember(ctx.tx, ctx.actor.workspaceId, membershipId)))
    throw new AppError('VALIDATION_FAILED', 'The owner must be an active member.', { fieldErrors: [{ field: 'ownerMembershipId', code: 'INACTIVE', message: 'The owner must be an active member.' }] });
};

const cleanHandle = (h: string | null | undefined) => {
  if (h === undefined) return undefined;
  const v = h?.trim().replace(/^@+/, '') ?? '';
  return v || null;
};

const setAvatar = async (ctx: CommandContext, a: AccountRow, assetId: string | null) => {
  if (!assetId) return;
  await assertAssetUsable(ctx, assetId, 'avatarAssetId', { imageOnly: true });
  // The link lets people who can read the account see its avatar (media link access).
  await linkAsset(ctx, assetId, { target: { entityType: 'account', entityId: a.id, role: 'avatar' } });
};

export interface AccountInput {
  platform?: AccountRow['platform'];
  profileUrl?: string;
  ownerMembershipId?: string;
  handle?: string | null;
  displayName?: string | null;
  language?: string | null;
  markets?: string[];
  purpose?: string | null;
  notes?: string | null;
  tags?: string[];
  avatarAssetId?: string | null;
  metricsCadence?: AccountRow['metricsCadence'];
  metricsDayOfWeek?: number;
  metricsTime?: string;
  captionMaxLength?: number | null;
}

export const createAccount = async (
  ctx: CommandContext,
  input: AccountInput & { platform: AccountRow['platform']; profileUrl: string; projectId: string; ownerMembershipId: string; status?: 'preparing' | 'active' },
) => {
  requirePermission(ctx, 'accounts.write');
  const project = await loadProjectForAccount(ctx, input.projectId);
  await assertOwner(ctx, input.ownerMembershipId);
  const n = normalizeOrThrow(input.platform, input.profileUrl);
  const existing = await findByIdentity(ctx, n.identityKey);
  if (existing) throw await duplicateError(ctx, existing);
  const at = ctx.app.clock.now();
  const id = newId();
  const status = input.status ?? 'preparing';
  const [row] = await ctx.tx
    .insert(socialAccounts)
    .values({
      ...stamp(ctx),
      id,
      projectId: project.id,
      platform: input.platform,
      originalUrl: input.profileUrl.trim(),
      canonicalUrl: n.canonicalUrl,
      identityKey: n.identityKey,
      handle: cleanHandle(input.handle) ?? n.handle,
      displayName: input.displayName?.trim() || null,
      ownerMembershipId: input.ownerMembershipId,
      status,
      language: input.language?.trim() || null,
      markets: input.markets ?? [],
      purpose: input.purpose?.trim() || null,
      notes: input.notes ?? null,
      tags: await resolveTags(ctx, input.tags),
      avatarAssetId: input.avatarAssetId ?? null,
      metricsCadence: input.metricsCadence ?? 'weekly',
      metricsDayOfWeek: input.metricsDayOfWeek ?? 1,
      metricsTime: input.metricsTime ?? '10:00',
      captionMaxLength: input.captionMaxLength ?? null,
    })
    .returning();
  await setAvatar(ctx, row!, input.avatarAssetId ?? null);
  await ctx.tx.insert(accountStatusEvents).values({ ...stamp(ctx), id: newId(), accountId: id, fromStatus: null, toStatus: status, occurredAt: at });
  await audit(ctx, {
    action: 'account.created',
    entityType: 'account',
    entityId: id,
    projectId: project.id,
    diff: diffFields(null, row!, ['platform', 'canonicalUrl', 'handle', 'ownerMembershipId', 'status', 'projectId']),
  });
  await emit(ctx, { type: 'account.created', entityType: 'account', entityId: id, revision: 1, payload: { platform: input.platform, projectId: project.id } });
  await indexAccount(ctx, row!);
  await bumpAccessRevision(ctx.tx, [input.ownerMembershipId]);
  if (input.ownerMembershipId !== ctx.actor.membershipId)
    await notify(ctx.tx, {
      workspaceId: ctx.actor.workspaceId,
      recipientMembershipIds: [input.ownerMembershipId],
      eventType: 'account.owner_assigned',
      eventKey: `account.owner_assigned:${id}:${input.ownerMembershipId}:1`,
      kind: 'assignment',
      title: `You own the account ${accountLabel(row!)}`,
      entityType: 'account',
      entityId: id,
      projectId: project.id,
      actorMembershipId: ctx.actor.membershipId,
      at,
    });
  return id;
};

export const updateAccount = async (ctx: CommandContext, id: string, input: AccountInput & { identityChangeReason?: string }) => {
  const a = await loadAccount(ctx, id, { lock: true });
  const scope = await scopeOfAccount(ctx, a);
  authorizeObject(ctx, 'accounts.write', scope, 'accounts.read');
  assertVersion(ctx, a);
  if (a.status === 'archived') throw new AppError('INVALID_STATE', 'Archived accounts are read-only. Restore the account to change it.');
  const patch: Partial<AccountRow> = {};
  const platform = input.platform ?? a.platform;
  if (input.platform !== undefined || input.profileUrl !== undefined) {
    const url = input.profileUrl ?? a.originalUrl;
    const n = normalizeOrThrow(platform, url);
    if (n.identityKey !== a.identityKey) {
      const existing = await findByIdentity(ctx, n.identityKey, a.id);
      if (existing) throw await duplicateError(ctx, existing);
    }
    patch.platform = platform;
    patch.originalUrl = url.trim();
    patch.canonicalUrl = n.canonicalUrl;
    patch.identityKey = n.identityKey;
    // A new URL implies a new derived handle unless one was given explicitly.
    if (input.handle === undefined && n.canonicalUrl !== a.canonicalUrl && n.handle) patch.handle = n.handle;
  }
  const h = cleanHandle(input.handle);
  if (h !== undefined) patch.handle = h;
  if (input.ownerMembershipId && input.ownerMembershipId !== a.ownerMembershipId) {
    await assertOwner(ctx, input.ownerMembershipId);
    patch.ownerMembershipId = input.ownerMembershipId;
  }
  if (input.displayName !== undefined) patch.displayName = input.displayName?.trim() || null;
  if (input.language !== undefined) patch.language = input.language?.trim() || null;
  if (input.markets !== undefined) patch.markets = input.markets;
  if (input.purpose !== undefined) patch.purpose = input.purpose?.trim() || null;
  if (input.notes !== undefined) patch.notes = input.notes;
  if (input.tags !== undefined) patch.tags = await resolveTags(ctx, input.tags);
  if (input.avatarAssetId !== undefined) patch.avatarAssetId = input.avatarAssetId;
  if (input.metricsCadence !== undefined) patch.metricsCadence = input.metricsCadence;
  if (input.metricsDayOfWeek !== undefined) patch.metricsDayOfWeek = input.metricsDayOfWeek;
  if (input.metricsTime !== undefined) patch.metricsTime = input.metricsTime;
  if (input.captionMaxLength !== undefined) patch.captionMaxLength = input.captionMaxLength;
  const [row] = await ctx.tx.update(socialAccounts).set({ ...patch, ...touch(ctx, socialAccounts) }).where(eq(socialAccounts.id, id)).returning();
  if (patch.avatarAssetId && patch.avatarAssetId !== a.avatarAssetId) await setAvatar(ctx, row!, patch.avatarAssetId);
  const at = ctx.app.clock.now();
  const handleChanged = (row!.handle ?? null) !== (a.handle ?? null);
  const urlChanged = row!.canonicalUrl !== a.canonicalUrl;
  // Rename keeps the handle/URL history; publications keep pointing at the same account (T030).
  if (handleChanged || urlChanged)
    await ctx.tx.insert(accountIdentityHistory).values({
      ...stamp(ctx),
      id: newId(),
      accountId: id,
      oldHandle: handleChanged ? a.handle : null,
      newHandle: handleChanged ? row!.handle : null,
      oldUrl: urlChanged ? a.canonicalUrl : null,
      newUrl: urlChanged ? row!.canonicalUrl : null,
      effectiveAt: at,
      reason: input.identityChangeReason?.trim() || null,
    });
  await audit(ctx, {
    action: handleChanged || urlChanged ? 'account.identity_changed' : 'account.updated',
    entityType: 'account',
    entityId: id,
    projectId: a.projectId,
    reason: input.identityChangeReason ?? null,
    diff: diffFields(a, row!, [
      'platform',
      'canonicalUrl',
      'handle',
      'displayName',
      'ownerMembershipId',
      'language',
      'markets',
      'purpose',
      'tags',
      'avatarAssetId',
      'metricsCadence',
      'metricsDayOfWeek',
      'metricsTime',
      'captionMaxLength',
    ]),
  });
  await emit(ctx, { type: 'account.updated', entityType: 'account', entityId: id, revision: row!.rowVersion });
  await indexAccount(ctx, row!);
  if (patch.ownerMembershipId) {
    await bumpAccessRevision(ctx.tx, [a.ownerMembershipId, patch.ownerMembershipId]);
    await notify(ctx.tx, {
      workspaceId: ctx.actor.workspaceId,
      recipientMembershipIds: [patch.ownerMembershipId],
      eventType: 'account.owner_assigned',
      eventKey: `account.owner_assigned:${id}:${patch.ownerMembershipId}:${row!.rowVersion}`,
      kind: 'assignment',
      title: `You own the account ${accountLabel(row!)}`,
      entityType: 'account',
      entityId: id,
      projectId: a.projectId,
      actorMembershipId: ctx.actor.membershipId,
      at,
    });
  }
  return id;
};

/** Open obligations of an account (archive preview). Blocking items prevent archiving. */
export const accountObligations = async (ctx: QueryContext | CommandContext, a: AccountRow): Promise<ImpactItem[]> => {
  const db = dbOf(ctx);
  const ws = a.workspaceId;
  const now = ctx.app.clock.now();
  const shiftOnAccount = or(eq(shifts.primaryAccountId, a.id), sql`EXISTS (SELECT 1 FROM shift_accounts sa WHERE sa.shift_id = ${shifts.id} AND sa.account_id = ${a.id})`);
  const [scheduled, activeShifts, futureShifts, ofm, openTasks, pendingCheckpoints] = await all(ctx, [
    () => db.select({ n: count() }).from(publications).where(and(eq(publications.workspaceId, ws), eq(publications.accountId, a.id), eq(publications.status, 'scheduled'))),
    () => db.select({ n: count() }).from(shifts).where(and(eq(shifts.workspaceId, ws), shiftOnAccount, inArray(shifts.state, ['active', 'paused']))),
    () => db.select({ n: count() }).from(shifts).where(and(eq(shifts.workspaceId, ws), shiftOnAccount, eq(shifts.state, 'scheduled'))),
    () =>
      db
        .select({ n: count() })
        .from(ofmAssignments)
        .where(and(eq(ofmAssignments.workspaceId, ws), eq(ofmAssignments.accountId, a.id), isNull(ofmAssignments.endedAt), or(isNull(ofmAssignments.validTo), gt(ofmAssignments.validTo, now)))),
    () => db.select({ n: count() }).from(tasks).where(and(eq(tasks.workspaceId, ws), eq(tasks.accountId, a.id), inArray(tasks.status, ['draft', 'backlog', 'ready', 'in_progress', 'in_review']), isNull(tasks.deletedAt))),
    () => db.select({ n: count() }).from(metricCheckpoints).where(and(eq(metricCheckpoints.workspaceId, ws), eq(metricCheckpoints.accountId, a.id), eq(metricCheckpoints.state, 'pending'))),
  ] as const);
  const n = (r: { n: number }[]) => Number(r[0]?.n ?? 0);
  return [
    { kind: 'scheduled_publications', label: 'Scheduled publications', count: n(scheduled), blocking: n(scheduled) > 0, resolution: 'Cancel or move the scheduled publications.' },
    { kind: 'active_shifts', label: 'Active OFM shifts', count: n(activeShifts), blocking: n(activeShifts) > 0, resolution: 'End the active shifts.' },
    { kind: 'scheduled_shifts', label: 'Scheduled OFM shifts', count: n(futureShifts), blocking: n(futureShifts) > 0, resolution: 'Cancel or reassign the scheduled shifts.' },
    { kind: 'ofm_assignments', label: 'Open OFM assignments', count: n(ofm), blocking: n(ofm) > 0, resolution: 'End the OFM assignments for this account.' },
    { kind: 'open_tasks', label: 'Open tasks linked to the account', count: n(openTasks), blocking: false, resolution: 'Tasks stay linked for history.' },
    { kind: 'pending_checkpoints', label: 'Pending metric checkpoints', count: n(pendingCheckpoints), blocking: false, resolution: 'They can still be recorded or marked missing.' },
  ].filter((i) => i.count > 0);
};

export const accountArchivePreview = async (ctx: QueryContext, id: string) => {
  const a = await loadAccount(ctx, id);
  authorizeObject(ctx, 'accounts.archive', await scopeOfAccount(ctx, a), 'accounts.read');
  return { title: accountLabel(a), rowVersion: a.rowVersion, items: await accountObligations(ctx, a) };
};

const REASON_REQUIRED: Partial<Record<AccountStatus, string>> = {
  restricted: 'Describe the restriction (what the platform limited and since when).',
};

export const transitionAccount = async (
  ctx: CommandContext,
  id: string,
  input: { targetState: AccountStatus; reason?: string },
  opts: { skipVersion?: boolean } = {},
) => {
  const a = await loadAccount(ctx, id, { lock: true });
  const scope = await scopeOfAccount(ctx, a);
  authorizeObject(ctx, input.targetState === 'archived' ? 'accounts.archive' : 'accounts.write', scope, 'accounts.read');
  if (!opts.skipVersion) assertVersion(ctx, a);
  assertTransition(ACCOUNT_TRANSITIONS, a.status, input.targetState, 'account');
  const reason = input.reason?.trim();
  if (REASON_REQUIRED[input.targetState] && !reason)
    throw new AppError('VALIDATION_FAILED', REASON_REQUIRED[input.targetState]!, { fieldErrors: [{ field: 'reason', code: 'REQUIRED', message: REASON_REQUIRED[input.targetState]! }] });
  if (a.status === 'restricted' && input.targetState === 'active' && !reason)
    throw new AppError('VALIDATION_FAILED', 'Describe how the restriction was resolved.', { fieldErrors: [{ field: 'reason', code: 'REQUIRED', message: 'Describe how the restriction was resolved.' }] });
  if (input.targetState === 'archived') {
    const blocking = (await accountObligations(ctx, a)).filter((i) => i.blocking);
    if (blocking.length) throw new AppError('INVALID_STATE', 'Resolve the open obligations before archiving this account.', { details: { items: blocking } });
  }
  const at = ctx.app.clock.now();
  const patch: Partial<AccountRow> = { status: input.targetState, statusReason: reason ?? null };
  if (input.targetState === 'archived') Object.assign(patch, { archivedAt: at, archivedBy: ctx.actor.userId, archiveReason: reason ?? null });
  const [row] = await ctx.tx.update(socialAccounts).set({ ...patch, ...touch(ctx, socialAccounts) }).where(eq(socialAccounts.id, id)).returning();
  await ctx.tx.insert(accountStatusEvents).values({ ...stamp(ctx), id: newId(), accountId: id, fromStatus: a.status, toStatus: input.targetState, reason: reason ?? null, occurredAt: at });
  await audit(ctx, {
    action: input.targetState === 'archived' ? 'account.archived' : 'account.status_changed',
    entityType: 'account',
    entityId: id,
    projectId: a.projectId,
    reason: reason ?? null,
    diff: { status: { from: a.status, to: input.targetState } },
  });
  await emit(ctx, { type: 'account.status_changed', entityType: 'account', entityId: id, revision: row!.rowVersion, payload: { from: a.status, to: input.targetState } });
  await indexAccount(ctx, row!);
  return id;
};

export const restoreAccount = async (ctx: CommandContext, id: string, input: { reason?: string } = {}, opts: { skipVersion?: boolean } = {}) => {
  const a = await loadAccount(ctx, id, { lock: true });
  const scope = await scopeOfAccount(ctx, a);
  authorizeObject(ctx, 'accounts.archive', scope, 'accounts.read');
  if (!opts.skipVersion) assertVersion(ctx, a);
  if (a.status !== 'archived') throw new AppError('INVALID_STATE', 'Only archived accounts can be restored.');
  const existing = await findByIdentity(ctx, a.identityKey, a.id);
  if (existing) throw await duplicateError(ctx, existing);
  const [lastArchive] = await ctx.tx
    .select()
    .from(accountStatusEvents)
    .where(and(eq(accountStatusEvents.workspaceId, ctx.actor.workspaceId), eq(accountStatusEvents.accountId, id), eq(accountStatusEvents.toStatus, 'archived')))
    .orderBy(desc(accountStatusEvents.occurredAt))
    .limit(1);
  const target: AccountStatus = lastArchive?.fromStatus && lastArchive.fromStatus !== 'archived' ? lastArchive.fromStatus : 'paused';
  const at = ctx.app.clock.now();
  const [row] = await ctx.tx
    .update(socialAccounts)
    .set({ status: target, statusReason: input.reason ?? null, archivedAt: null, archivedBy: null, archiveReason: null, ...touch(ctx, socialAccounts) })
    .where(eq(socialAccounts.id, id))
    .returning();
  await ctx.tx.insert(accountStatusEvents).values({ ...stamp(ctx), id: newId(), accountId: id, fromStatus: 'archived', toStatus: target, reason: input.reason ?? 'Restored from archive', occurredAt: at });
  await audit(ctx, { action: 'account.restored', entityType: 'account', entityId: id, projectId: a.projectId, reason: input.reason ?? null, diff: { status: { from: 'archived', to: target } } });
  await emit(ctx, { type: 'account.status_changed', entityType: 'account', entityId: id, revision: row!.rowVersion, payload: { from: 'archived', to: target } });
  await indexAccount(ctx, row!);
  return id;
};

export { accountScope, accountLabel };
