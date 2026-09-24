import { and, asc, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import {
  accountAssignments,
  memberships,
  metricObservations,
  projects,
  publications,
  shifts,
  socialAccounts,
  users,
  type DbOrTx,
} from '@castlane/database';
import { ACCOUNT_STATUSES, AppError, isUuid, normalizeEmail, normalizeKey, normalizeProfileUrl, PLATFORMS } from '@castlane/domain';
import { allowed } from '../core/access';
import { audit } from '../core/audit';
import { dbOf, type CommandContext, type QueryContext } from '../core/context';
import { emit } from '../core/events';
import { defineExportDataset } from '../core/export-registry';
import { defineImportDataset, type ImportIssue } from '../core/import-registry';
import { loadMemberRefs } from '../core/members';
import { removeSearchDocument } from '../core/search';
import { createAccount, loadAccount, updateAccount } from './accounts';
import { accountVisibility } from './scope';

/**
 * Import Center dataset "accounts" (section 22.1) and Export Center dataset "accounts" (22.2).
 * Referenced projects/owners must already exist (stable id or unambiguous name/e-mail) — nothing is
 * auto-created; duplicates are detected by canonical profile identity.
 */

export const asList = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(String).map((s) => s.trim()).filter(Boolean) : typeof v === 'string' ? v.split(/[,;]/).map((s) => s.trim()).filter(Boolean) : [];

export const asText = (v: unknown): string | null => (v === null || v === undefined ? null : String(v).trim() || null);

/** Resolve a project by stable id or unambiguous name among projects the actor can read. */
export const resolveProjectRef = async (ctx: QueryContext, value: unknown, permission: string): Promise<{ id?: string; error?: ImportIssue }> => {
  const raw = asText(value);
  if (!raw) return { error: { field: 'project', code: 'REQUIRED', message: 'Project is required.' } };
  const db = dbOf(ctx);
  const rows = isUuid(raw)
    ? await db.select().from(projects).where(and(eq(projects.workspaceId, ctx.actor.workspaceId), eq(projects.id, raw), isNull(projects.deletedAt)))
    : await db
        .select()
        .from(projects)
        .where(and(eq(projects.workspaceId, ctx.actor.workspaceId), isNull(projects.deletedAt), sql`lower(${projects.name}) = ${normalizeKey(raw)}`));
  const readable = rows.filter((p) => allowed(ctx, 'projects.read', { projectId: p.id, directionId: p.directionId, ownerMembershipId: p.ownerMembershipId }) || allowed(ctx, permission, { projectId: p.id }));
  if (readable.length === 0) return { error: { field: 'project', code: 'UNKNOWN_PROJECT', message: `Project "${raw}" was not found.` } };
  if (readable.length > 1) return { error: { field: 'project', code: 'AMBIGUOUS', message: `Several projects are named "${raw}". Use the project id.` } };
  const p = readable[0]!;
  if (p.status === 'archived') return { error: { field: 'project', code: 'ARCHIVED', message: `Project "${p.name}" is archived.` } };
  if (!allowed(ctx, permission, { projectId: p.id, directionId: p.directionId })) return { error: { field: 'project', code: 'FORBIDDEN', message: `You cannot add records to "${p.name}".` } };
  return { id: p.id };
};

/** Resolve an active member by membership id or e-mail address. */
export const resolveMemberRef = async (ctx: QueryContext, value: unknown, field: string): Promise<{ id?: string; error?: ImportIssue }> => {
  const raw = asText(value);
  if (!raw) return { error: { field, code: 'REQUIRED', message: 'A member is required.' } };
  const db = dbOf(ctx);
  const rows = isUuid(raw)
    ? await db.select({ id: memberships.id, status: memberships.status }).from(memberships).where(and(eq(memberships.workspaceId, ctx.actor.workspaceId), eq(memberships.id, raw)))
    : await db
        .select({ id: memberships.id, status: memberships.status })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(and(eq(memberships.workspaceId, ctx.actor.workspaceId), eq(users.normalizedEmail, normalizeEmail(raw))));
  const m = rows[0];
  if (!m) return { error: { field, code: 'UNKNOWN_MEMBER', message: `Member "${raw}" was not found.` } };
  if (m.status !== 'active') return { error: { field, code: 'INACTIVE', message: `Member "${raw}" is not active.` } };
  return { id: m.id };
};

interface AccountImportRow {
  platform: (typeof PLATFORMS)[number];
  profileUrl: string;
  projectId: string;
  ownerMembershipId: string;
  handle: string | null;
  displayName: string | null;
  language: string | null;
  markets: string[];
  purpose: string | null;
  status: 'preparing' | 'active';
  notes: string | null;
  tags: string[];
  metricsCadence: 'daily' | 'weekly' | 'monthly' | null;
}

const withVersion = (ctx: CommandContext, version: number | undefined): CommandContext => ({ ...ctx, request: { ...ctx.request, expectedVersion: version } });

defineImportDataset<AccountImportRow>({
  key: 'accounts',
  label: 'Accounts',
  permission: 'accounts.write',
  duplicatePolicies: ['skip', 'revise_existing', 'error'],
  columns: [
    { key: 'platform', label: 'Platform', type: 'enum', required: true, enumValues: PLATFORMS, aliases: ['network', 'site'] },
    { key: 'profile_url', label: 'Profile URL', type: 'url', required: true, aliases: ['url', 'link', 'profile'] },
    { key: 'project', label: 'Project', type: 'reference', required: true, description: 'Project id or exact project name.' },
    { key: 'owner', label: 'Owner', type: 'reference', required: true, description: 'Membership id or the member’s e-mail.', aliases: ['owner_email'] },
    { key: 'handle', label: 'Handle', type: 'text' },
    { key: 'display_name', label: 'Display Name', type: 'text', aliases: ['name'] },
    { key: 'language', label: 'Language', type: 'text' },
    { key: 'markets', label: 'Markets', type: 'text', description: 'Comma-separated market codes.' },
    { key: 'purpose', label: 'Purpose', type: 'long_text' },
    { key: 'status', label: 'Status', type: 'enum', enumValues: ['preparing', 'active'] },
    { key: 'notes', label: 'Notes', type: 'long_text' },
    { key: 'tags', label: 'Tags', type: 'tags' },
    { key: 'metrics_cadence', label: 'Metrics Cadence', type: 'enum', enumValues: ['daily', 'weekly', 'monthly'] },
  ],
  async validate(ctx, row, opts) {
    const errors: ImportIssue[] = [];
    const warnings: ImportIssue[] = [];
    const platform = asText(row.platform)?.toLowerCase() as AccountImportRow['platform'] | undefined;
    if (!platform || !(PLATFORMS as readonly string[]).includes(platform)) errors.push({ field: 'platform', code: 'INVALID', message: 'Unknown platform.' });
    const url = asText(row.profile_url);
    let identityKey: string | undefined;
    if (!url) errors.push({ field: 'profile_url', code: 'REQUIRED', message: 'Profile URL is required.' });
    else if (platform && (PLATFORMS as readonly string[]).includes(platform)) {
      const n = normalizeProfileUrl(url, platform);
      if (!n.ok) errors.push({ field: 'profile_url', code: n.error, message: n.error === 'HOST_MISMATCH' ? 'The link does not match the platform.' : 'Enter a valid https profile link.' });
      else identityKey = n.value.identityKey;
    }
    const project = await resolveProjectRef(ctx, row.project, 'accounts.write');
    if (project.error) errors.push(project.error);
    const owner = await resolveMemberRef(ctx, row.owner, 'owner');
    if (owner.error) errors.push(owner.error);
    const status = (asText(row.status) ?? 'preparing').toLowerCase();
    if (status !== 'preparing' && status !== 'active') errors.push({ field: 'status', code: 'INVALID', message: 'Status must be Preparing or Active.' });
    const cadence = asText(row.metrics_cadence)?.toLowerCase() ?? null;
    if (cadence && !['daily', 'weekly', 'monthly'].includes(cadence)) errors.push({ field: 'metrics_cadence', code: 'INVALID', message: 'Cadence must be daily, weekly or monthly.' });
    const tags = asList(row.tags);
    if (tags.length > 30) errors.push({ field: 'tags', code: 'TOO_MANY', message: 'Use at most 30 tags.' });
    const normalized: AccountImportRow = {
      platform: platform ?? 'other',
      profileUrl: url ?? '',
      projectId: project.id ?? '',
      ownerMembershipId: owner.id ?? '',
      handle: asText(row.handle),
      displayName: asText(row.display_name),
      language: asText(row.language),
      markets: asList(row.markets),
      purpose: asText(row.purpose),
      status: status === 'active' ? 'active' : 'preparing',
      notes: asText(row.notes),
      tags,
      metricsCadence: (cadence as AccountImportRow['metricsCadence']) ?? null,
    };
    if (errors.length || !identityKey) return { action: 'create', normalized, errors, warnings, dedupeKey: identityKey };
    const [existing] = await dbOf(ctx)
      .select()
      .from(socialAccounts)
      .where(and(eq(socialAccounts.workspaceId, ctx.actor.workspaceId), eq(socialAccounts.identityKey, identityKey), isNull(socialAccounts.archivedAt), isNull(socialAccounts.deletedAt)));
    if (!existing) return { action: 'create', normalized, errors, warnings, dedupeKey: identityKey };
    if (opts.duplicatePolicy === 'skip') {
      warnings.push({ field: 'profile_url', code: 'DUPLICATE', message: 'An account with this profile link already exists; the row is skipped.' });
      return { action: 'skip', normalized, errors, warnings, dedupeKey: identityKey, targetId: existing.id };
    }
    if (opts.duplicatePolicy === 'error') {
      errors.push({ field: 'profile_url', code: 'DUPLICATE', message: 'An account with this profile link already exists.' });
      return { action: 'create', normalized, errors, warnings, dedupeKey: identityKey };
    }
    if (!allowed(ctx, 'accounts.write', { projectId: existing.projectId, accountId: existing.id, ownerMembershipId: existing.ownerMembershipId }))
      errors.push({ field: 'profile_url', code: 'FORBIDDEN', message: 'The existing account is outside your scope.' });
    if (existing.projectId !== normalized.projectId)
      warnings.push({ field: 'project', code: 'PROJECT_UNCHANGED', message: 'Revising keeps the existing project; use Transfer to move the account.' });
    if (existing.status === 'archived') errors.push({ field: 'profile_url', code: 'ARCHIVED', message: 'The existing account is archived.' });
    return { action: 'update', normalized, errors, warnings, dedupeKey: identityKey, targetId: existing.id, targetRowVersion: existing.rowVersion };
  },
  async apply(ctx, row, v) {
    const c: CommandContext = { ...ctx, request: { ...ctx.request, source: 'import' } };
    if (v.action === 'update' && v.targetId) {
      // Revise Existing changes only editable descriptive fields (never project, platform or URL).
      await updateAccount(withVersion(c, v.targetRowVersion), v.targetId, {
        handle: row.handle ?? undefined,
        displayName: row.displayName ?? undefined,
        ownerMembershipId: row.ownerMembershipId || undefined,
        language: row.language ?? undefined,
        markets: row.markets.length ? row.markets : undefined,
        purpose: row.purpose ?? undefined,
        notes: row.notes ?? undefined,
        tags: row.tags.length ? row.tags : undefined,
        metricsCadence: row.metricsCadence ?? undefined,
      });
      return v.targetId;
    }
    return createAccount(c, {
      platform: row.platform,
      profileUrl: row.profileUrl,
      projectId: row.projectId,
      ownerMembershipId: row.ownerMembershipId,
      handle: row.handle,
      displayName: row.displayName,
      language: row.language,
      markets: row.markets,
      purpose: row.purpose,
      status: row.status,
      notes: row.notes,
      tags: row.tags,
      metricsCadence: row.metricsCadence ?? undefined,
    });
  },
  async undo(ctx, entityId) {
    const a = await loadAccount(ctx, entityId, { lock: true });
    const obstacles = await accountDependents(ctx.tx, a.workspaceId, a.id);
    if (a.rowVersion > 1) obstacles.push('The account was edited after the import.');
    if (obstacles.length) throw new AppError('INVALID_STATE', 'This account can no longer be removed automatically.', { details: { obstacles } });
    const at = ctx.app.clock.now();
    await ctx.tx.update(socialAccounts).set({ deletedAt: at, deletedBy: ctx.actor.userId, rowVersion: sql`${socialAccounts.rowVersion} + 1`, updatedAt: at }).where(eq(socialAccounts.id, a.id));
    await removeSearchDocument(ctx.tx, a.workspaceId, 'account', a.id);
    await audit(ctx, { action: 'account.import_undone', entityType: 'account', entityId: a.id, projectId: a.projectId });
    await emit(ctx, { type: 'account.deleted', entityType: 'account', entityId: a.id });
  },
});

const accountDependents = async (db: DbOrTx, workspaceId: string, accountId: string) => {
  const out: string[] = [];
  const [pubs] = await db.select({ n: sql<number>`count(*)::int` }).from(publications).where(and(eq(publications.workspaceId, workspaceId), eq(publications.accountId, accountId)));
  if (Number(pubs?.n ?? 0) > 0) out.push('Publications exist for the account.');
  const [obs] = await db.select({ n: sql<number>`count(*)::int` }).from(metricObservations).where(and(eq(metricObservations.workspaceId, workspaceId), eq(metricObservations.accountId, accountId)));
  if (Number(obs?.n ?? 0) > 0) out.push('Metrics were recorded for the account.');
  const [asg] = await db.select({ n: sql<number>`count(*)::int` }).from(accountAssignments).where(and(eq(accountAssignments.workspaceId, workspaceId), eq(accountAssignments.accountId, accountId)));
  if (Number(asg?.n ?? 0) > 0) out.push('Members were assigned to the account.');
  const [sh] = await db.select({ n: sql<number>`count(*)::int` }).from(shifts).where(and(eq(shifts.workspaceId, workspaceId), eq(shifts.primaryAccountId, accountId)));
  if (Number(sh?.n ?? 0) > 0) out.push('OFM shifts exist for the account.');
  return out;
};

// ——— Export ———

defineExportDataset({
  key: 'accounts',
  label: 'Accounts',
  permission: 'accounts.read',
  classification: 'normal',
  columns: [
    { key: 'id', label: 'Account ID', type: 'id', default: true },
    { key: 'platform', label: 'Platform', type: 'text', default: true },
    { key: 'handle', label: 'Handle', type: 'text', default: true },
    { key: 'display_name', label: 'Display Name', type: 'text', default: true },
    { key: 'canonical_url', label: 'Profile URL', type: 'text', default: true },
    { key: 'original_url', label: 'Original URL', type: 'text' },
    { key: 'project_id', label: 'Project ID', type: 'id' },
    { key: 'project_name', label: 'Project', type: 'text', default: true },
    { key: 'owner', label: 'Owner', type: 'text', default: true },
    { key: 'status', label: 'Status', type: 'text', default: true },
    { key: 'status_reason', label: 'Status Reason', type: 'text' },
    { key: 'language', label: 'Language', type: 'text' },
    { key: 'markets', label: 'Markets', type: 'text' },
    { key: 'purpose', label: 'Purpose', type: 'text' },
    { key: 'tags', label: 'Tags', type: 'text' },
    { key: 'metrics_cadence', label: 'Metrics Cadence', type: 'text' },
    { key: 'created_at', label: 'Created At', type: 'datetime', default: true },
    { key: 'updated_at', label: 'Updated At', type: 'datetime' },
    { key: 'archived_at', label: 'Archived At', type: 'datetime' },
  ],
  filters: [
    { key: 'projectId', label: 'Project', type: 'reference', lookup: 'project' },
    { key: 'status', label: 'Status', type: 'enum', enumValues: ACCOUNT_STATUSES },
    { key: 'platform', label: 'Platform', type: 'enum', enumValues: PLATFORMS },
  ],
  async *rows(ctx, input) {
    const f = input.filters as { projectId?: string; status?: string | string[]; platform?: string | string[]; includeArchived?: boolean };
    const status = asList(f.status);
    const platform = asList(f.platform);
    let cursor: { createdAt: Date; id: string } | null = null;
    for (;;) {
      const page: (typeof socialAccounts.$inferSelect)[] = await ctx.app.db
        .select()
        .from(socialAccounts)
        .where(
          and(
            eq(socialAccounts.workspaceId, ctx.actor.workspaceId),
            isNull(socialAccounts.deletedAt),
            accountVisibility(ctx, 'accounts.read'),
            lte(socialAccounts.createdAt, input.boundAt),
            f.projectId ? eq(socialAccounts.projectId, f.projectId) : undefined,
            status.length ? inArray(socialAccounts.status, status as never[]) : undefined,
            platform.length ? inArray(socialAccounts.platform, platform as never[]) : undefined,
            f.includeArchived || status.includes('archived') ? undefined : isNull(socialAccounts.archivedAt),
            cursor ? sql`(${socialAccounts.createdAt}, ${socialAccounts.id}) > (${cursor.createdAt}, ${cursor.id}::uuid)` : undefined,
          ),
        )
        .orderBy(asc(socialAccounts.createdAt), asc(socialAccounts.id))
        .limit(500);
      if (!page.length) return;
      const refs = await loadMemberRefs(ctx.app.db, ctx.actor.workspaceId, page.map((a) => a.ownerMembershipId));
      const names = new Map(
        (await ctx.app.db.select({ id: projects.id, name: projects.name }).from(projects).where(and(eq(projects.workspaceId, ctx.actor.workspaceId), inArray(projects.id, [...new Set(page.map((a) => a.projectId))])))).map((p) => [p.id, p.name]),
      );
      for (const a of page)
        yield {
          id: a.id,
          platform: a.platform,
          handle: a.handle,
          display_name: a.displayName,
          canonical_url: a.canonicalUrl,
          original_url: a.originalUrl,
          project_id: a.projectId,
          project_name: names.get(a.projectId) ?? null,
          owner: refs.get(a.ownerMembershipId)?.displayName ?? null,
          status: a.status,
          status_reason: a.statusReason,
          language: a.language,
          markets: a.markets.join(', '),
          purpose: a.purpose,
          tags: a.tags.join(', '),
          metrics_cadence: a.metricsCadence,
          created_at: a.createdAt.toISOString(),
          updated_at: a.updatedAt.toISOString(),
          archived_at: a.archivedAt?.toISOString() ?? null,
        };
      const last = page[page.length - 1]!;
      cursor = { createdAt: last.createdAt, id: last.id };
      if (page.length < 500) return;
    }
  },
});
