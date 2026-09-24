import { and, count, desc, eq, gt, inArray, isNull, lt, sql } from 'drizzle-orm';
import { hasAnywhere } from '@castlane/authorization';
import {
  assetVersions,
  assets,
  financialEntries,
  jobs,
  mailMessages,
  mailSettings,
  memberships,
  roleAssignments,
  roles,
  sessions,
  users,
  workspaces,
  type WorkspaceSettings,
} from '@castlane/database';
import { AppError, isEmail, isSupportedCurrency, isValidTimeZone, newId, notFound } from '@castlane/domain';
import { HIDEABLE_MODULES, SETTINGS_BOUNDS, type WorkspaceSettingsPatch } from '@castlane/api-contracts';
import { requirePermission, requireRecentAuth } from '../core/access';
import { audit, diffFields, type Diff } from '../core/audit';
import { secretsKey } from '../core/config';
import { encryptSecret } from '../core/crypto';
import { dbOf, type CommandContext, type QueryContext } from '../core/context';
import { emit } from '../core/events';
import { enqueueJob } from '../core/jobs';
import { DEFAULT_WORKSPACE_SETTINGS } from '../identity/workspace-defaults';
import { MAIL_SETTINGS_ID } from '../platform/mail';

type WorkspaceRow = typeof workspaces.$inferSelect;

/** Defaults per settings group (§31.1, §22.3) — "Restore Defaults" applies one group at a time. */
export const SETTINGS_DEFAULTS = {
  workingTime: { workingDays: [...(DEFAULT_WORKSPACE_SETTINGS.workingDays ?? [])] as ('monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday')[], workingHours: { start: '09:00', end: '18:00' } },
  metrics: { accountDefaultCadence: 'weekly' as const, followerSnapshotDaily: false },
  files: { quotaBytes: DEFAULT_WORKSPACE_SETTINGS.fileQuotaBytes ?? String(500 * 1024 ** 3) },
  retention: { trashDays: 30, auditMonths: 24, financialYears: 7, ofmArchivedNotesDays: 180, exportDays: 7 },
  security: { mfaRequiredForAll: false, mfaRequiredRoleKeys: [] as string[], sessionIdleHours: 12, sessionAbsoluteDays: 7 },
  notifications: {
    mentions: true,
    assignments: true,
    reviewRequests: true,
    dueReminders: true,
    emailImmediate: false,
    dailyDigest: false,
    quietHoursStart: '22:00',
    quietHoursEnd: '08:00',
  },
  modules: { hidden: [] as (typeof HIDEABLE_MODULES)[number][] },
};

const APPROVER_PERMISSIONS = ['finance.post', 'compensation.runs.approve', 'payments.record', 'finance.close-period'];

const groupsOf = (ws: WorkspaceRow) => {
  const s: WorkspaceSettings = ws.settings ?? {};
  const d = SETTINGS_DEFAULTS;
  return {
    workingTime: { workingDays: (s.workingDays as typeof d.workingTime.workingDays | undefined) ?? d.workingTime.workingDays, workingHours: s.workingHours ?? d.workingTime.workingHours },
    metrics: { accountDefaultCadence: s.metricCadences?.accountDefault ?? d.metrics.accountDefaultCadence, followerSnapshotDaily: s.metricCadences?.followerSnapshotDaily ?? false },
    files: { quotaBytes: s.fileQuotaBytes ?? d.files.quotaBytes },
    retention: { ...d.retention, ...(s.retention ?? {}) },
    security: {
      mfaRequiredForAll: s.mfaPolicy?.requiredForAll ?? false,
      mfaRequiredRoleKeys: s.mfaPolicy?.requiredRoleKeys ?? [],
      sessionIdleHours: s.sessionIdleHours ?? d.security.sessionIdleHours,
      sessionAbsoluteDays: s.sessionAbsoluteDays ?? d.security.sessionAbsoluteDays,
    },
    notifications: { ...d.notifications, ...(s.notificationDefaults ?? {}) },
    modules: { hidden: Object.entries(s.moduleVisibility ?? {}).filter(([k, v]) => v === false && (HIDEABLE_MODULES as readonly string[]).includes(k)).map(([k]) => k as (typeof HIDEABLE_MODULES)[number]) },
  };
};

type Groups = ReturnType<typeof groupsOf>;

/** Base currency is fixed once financial records exist (or finance locked it explicitly). */
const currencyLock = async (ctx: QueryContext | CommandContext, ws: WorkspaceRow): Promise<string | null> => {
  if (ws.baseCurrencyLockedAt) return 'The base currency was locked after the first posted financial entry.';
  const [n] = await dbOf(ctx).select({ n: count() }).from(financialEntries).where(eq(financialEntries.workspaceId, ws.id));
  return Number(n?.n ?? 0) > 0 ? 'The base currency cannot change because financial records exist.' : null;
};

const loadWorkspace = async (ctx: QueryContext | CommandContext, lock = false): Promise<WorkspaceRow> => {
  const q = dbOf(ctx).select().from(workspaces).where(eq(workspaces.id, ctx.actor.workspaceId));
  const [ws] = lock && 'tx' in ctx ? await q.for('update') : await q;
  if (!ws) throw notFound('Workspace');
  return ws;
};

const lastMailTest = async (ctx: QueryContext | CommandContext) => {
  const [m] = await dbOf(ctx)
    .select()
    .from(mailMessages)
    .where(and(eq(mailMessages.workspaceId, ctx.actor.workspaceId), eq(mailMessages.template, 'testMessage')))
    .orderBy(desc(mailMessages.createdAt))
    .limit(1);
  return m ? { at: m.createdAt.toISOString(), status: m.status, error: m.error } : null;
};

// ——— Mail server (S67): the password is write-only ———

const HOSTNAME = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;

/** `Name <address>` or a bare address; returns the address or null. */
const fromAddressOf = (from: string) => {
  const m = /^(?:[^<>]{1,200}<([^<>\s]+)>|([^<>\s]+))$/.exec(from.trim());
  const address = m?.[1] ?? m?.[2] ?? '';
  return isEmail(address) ? address : null;
};

const loadMailRow = async (ctx: QueryContext | CommandContext, forUpdate = false) => {
  const q = dbOf(ctx).select().from(mailSettings).where(eq(mailSettings.id, MAIL_SETTINGS_ID));
  const [row] = forUpdate && 'tx' in ctx ? await q.for('update') : await q;
  return row ?? null;
};

/** Mail status for S67: transport, where the server comes from, the saved server without its password. */
export const mailStatusView = async (ctx: QueryContext | CommandContext) => {
  const cfg = ctx.app.config;
  const row = await loadMailRow(ctx);
  const smtp = cfg.MAIL_TRANSPORT === 'smtp';
  const source = !smtp ? ('none' as const) : row ? ('settings' as const) : cfg.SMTP_HOST ? ('environment' as const) : ('none' as const);
  const manage = hasAnywhere(ctx.actor.access, 'workspace.update');
  return {
    transport: cfg.MAIL_TRANSPORT,
    configured: smtp && source !== 'none',
    source,
    from: source === 'settings' ? row!.fromAddress : smtp ? (cfg.SMTP_FROM ?? null) : (row?.fromAddress ?? cfg.SMTP_FROM ?? null),
    saved:
      row && manage
        ? { host: row.host, port: row.port, secure: row.secure, username: row.username, secretSaved: !!row.passwordEnc, from: row.fromAddress, updatedAt: row.updatedAt.toISOString() }
        : null,
    canEdit: manage && ctx.actor.access.isOwner,
    lastTest: await lastMailTest(ctx),
  };
};

const assertMailManager = (ctx: CommandContext) => {
  requirePermission(ctx, 'workspace.update');
  // The mail server serves the whole installation (sign-in e-mails included): Owner only.
  if (!ctx.actor.access.isOwner) throw new AppError('FORBIDDEN', 'Only the Owner can change the mail server.');
  requireRecentAuth(ctx);
};

export interface MailServerInput {
  host: string;
  port: number;
  secure: boolean;
  username?: string | null;
  password?: string;
  clearPassword?: boolean;
  from: string;
}

export const saveMailServer = async (ctx: CommandContext, input: MailServerInput) => {
  assertMailManager(ctx);
  const errors: { field: string; code: string; message: string }[] = [];
  const host = input.host.trim().toLowerCase();
  if (!HOSTNAME.test(host)) errors.push({ field: 'host', code: 'INVALID', message: 'Enter a host name such as smtp.example.com.' });
  if (!fromAddressOf(input.from)) errors.push({ field: 'from', code: 'INVALID', message: 'Use an address, or a name with an address: Castlane <no-reply@example.com>.' });
  if (input.password !== undefined && input.clearPassword) errors.push({ field: 'password', code: 'CONFLICT', message: 'Enter a new password or remove the saved one, not both.' });
  if (errors.length) throw new AppError('VALIDATION_FAILED', 'Check the mail server settings.', { fieldErrors: errors });
  const cur = await loadMailRow(ctx, true);
  const at = ctx.app.clock.now();
  const passwordEnc = input.password !== undefined ? encryptSecret(input.password, secretsKey(ctx.app.config)) : input.clearPassword ? null : (cur?.passwordEnc ?? null);
  const next = { host, port: input.port, secure: input.secure, username: input.username?.trim() || null, fromAddress: input.from.trim() };
  await ctx.tx
    .insert(mailSettings)
    .values({ id: MAIL_SETTINGS_ID, ...next, passwordEnc, updatedAt: at, updatedByUserId: ctx.actor.userId, rowVersion: 1 })
    .onConflictDoUpdate({ target: mailSettings.id, set: { ...next, passwordEnc, updatedAt: at, updatedByUserId: ctx.actor.userId, rowVersion: sql`${mailSettings.rowVersion} + 1` } });
  await audit(ctx, {
    action: 'workspace.mail_server_saved',
    entityType: 'workspace',
    entityId: ctx.actor.workspaceId,
    diff: diffFields(cur as Record<string, unknown> | null, next, ['host', 'port', 'secure', 'username', 'fromAddress']),
    metadata: { passwordChanged: input.password !== undefined, passwordRemoved: !!input.clearPassword && !!cur?.passwordEnc },
    sensitivity: 'security',
  });
  await emit(ctx, { type: 'workspace.settings_updated', entityType: 'workspace', entityId: ctx.actor.workspaceId, payload: { groups: ['mail'] } });
  return mailStatusView(ctx);
};

export const removeMailServer = async (ctx: CommandContext) => {
  assertMailManager(ctx);
  const cur = await loadMailRow(ctx, true);
  if (cur) {
    await ctx.tx.delete(mailSettings).where(eq(mailSettings.id, MAIL_SETTINGS_ID));
    await audit(ctx, { action: 'workspace.mail_server_removed', entityType: 'workspace', entityId: ctx.actor.workspaceId, metadata: { host: cur.host }, sensitivity: 'security' });
    await emit(ctx, { type: 'workspace.settings_updated', entityType: 'workspace', entityId: ctx.actor.workspaceId, payload: { groups: ['mail'] } });
  }
  return mailStatusView(ctx);
};

export const getWorkspaceSettings = async (ctx: QueryContext | CommandContext) => {
  requirePermission(ctx, 'workspace.read');
  const ws = await loadWorkspace(ctx);
  const g = groupsOf(ws);
  const lock = await currencyLock(ctx, ws);
  const roleRows = await dbOf(ctx)
    .select({ key: roles.key, name: roles.name, permissions: roles.permissions })
    .from(roles)
    .where(and(eq(roles.workspaceId, ws.id), isNull(roles.archivedAt)))
    .orderBy(roles.createdAt);
  const access = ctx.actor.access;
  const cfg = ctx.app.config;
  const update = hasAnywhere(access, 'workspace.update');
  return {
    general: {
      name: ws.name,
      timezone: ws.timezone,
      baseCurrency: ws.baseCurrency,
      baseCurrencyLocked: !!lock,
      baseCurrencyLockReason: lock,
      weekStartsOn: ws.weekStartsOn,
      logoAssetId: ws.logoAssetId,
      logoUrl: ws.logoAssetId ? `/api/v1/workspaces/${ws.id}/logo` : null,
    },
    workingTime: g.workingTime,
    metrics: g.metrics,
    files: { quotaBytes: g.files.quotaBytes, usedBytes: ws.storageUsedBytes.toString(), reservedBytes: ws.storageReservedBytes.toString() },
    retention: g.retention,
    security: g.security,
    notifications: g.notifications,
    modules: g.modules,
    mail: await mailStatusView(ctx),
    defaults: SETTINGS_DEFAULTS,
    roles: roleRows.map((r) => ({
      key: r.key,
      name: r.name,
      alwaysRequiresMfa: r.key === 'owner' || r.key === 'admin' || r.permissions.some((p) => APPROVER_PERMISSIONS.includes(p)),
    })),
    settingsVersion: ws.settingsVersion,
    rowVersion: ws.rowVersion,
    permissions: {
      update,
      manageSecurity: update && hasAnywhere(access, 'access.manage'),
      manageRetention: update && hasAnywhere(access, 'retention.manage'),
      manageQuota: update && access.isOwner,
      changeCurrency: update && access.isOwner && !lock,
      testMail: update,
    },
  };
};

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

interface Evaluation {
  impacts: { group: string; severity: 'info' | 'warning'; message: string; count: number | null }[];
  blocked: { field: string; message: string }[];
  requiresRecentAuth: boolean;
  changedGroups: string[];
}

/** Validation and impact of a proposed change; shared by preview and save so they never disagree. */
const evaluate = async (ctx: QueryContext | CommandContext, ws: WorkspaceRow, patch: WorkspaceSettingsPatch): Promise<Evaluation> => {
  const db = dbOf(ctx);
  const access = ctx.actor.access;
  const cur = groupsOf(ws);
  const out: Evaluation = { impacts: [], blocked: [], requiresRecentAuth: false, changedGroups: [] };
  const info = (group: string, message: string, n: number | null = null) => out.impacts.push({ group, severity: 'info', message, count: n });
  const warn = (group: string, message: string, n: number | null = null) => out.impacts.push({ group, severity: 'warning', message, count: n });
  const block = (field: string, message: string) => out.blocked.push({ field, message });
  const at = ctx.app.clock.now();

  if (patch.general) {
    const g = patch.general;
    const changed = (k: keyof typeof g, v: unknown) => g[k] !== undefined && !same(g[k], v);
    if (changed('name', ws.name) || changed('timezone', ws.timezone) || changed('baseCurrency', ws.baseCurrency) || changed('weekStartsOn', ws.weekStartsOn) || changed('logoAssetId', ws.logoAssetId))
      out.changedGroups.push('general');
    if (changed('timezone', ws.timezone)) {
      if (!isValidTimeZone(g.timezone)) block('general.timezone', 'Choose a valid time zone.');
      else info('general', `Existing timestamps are not rewritten. Calendar days in reports and schedules will be computed in ${g.timezone}.`);
    }
    if (changed('baseCurrency', ws.baseCurrency)) {
      const lock = await currencyLock(ctx, ws);
      if (!access.isOwner) block('general.baseCurrency', 'Only the workspace Owner can change the base currency.');
      else if (lock) block('general.baseCurrency', lock);
      else if (!isSupportedCurrency(g.baseCurrency!)) block('general.baseCurrency', 'Choose a supported currency.');
      else warn('general', `Budgets, reports and compensation will use ${g.baseCurrency} as the base currency. No financial records exist yet.`);
    }
    if (changed('weekStartsOn', ws.weekStartsOn)) info('general', `Weeks in workload, time sheets and weekly reports will start on ${g.weekStartsOn === 'monday' ? 'Monday' : 'Sunday'}.`);
    if (g.logoAssetId && g.logoAssetId !== ws.logoAssetId) {
      const [a] = await db
        .select({ kind: assets.kind, status: assetVersions.status, sensitivity: assets.sensitivity })
        .from(assets)
        .leftJoin(assetVersions, eq(assetVersions.id, assets.currentVersionId))
        .where(and(eq(assets.workspaceId, ws.id), eq(assets.id, g.logoAssetId)));
      if (!a || a.kind !== 'image' || a.status !== 'available' || a.sensitivity === 'restricted') block('general.logoAssetId', 'Upload a checked image (JPG, PNG or WebP) as the logo.');
    }
  }
  if (patch.workingTime && !same(patch.workingTime, cur.workingTime)) {
    out.changedGroups.push('workingTime');
    if (patch.workingTime.workingHours.end <= patch.workingTime.workingHours.start) block('workingTime.workingHours.end', 'The end of the working day must be after its start.');
    info('workingTime', 'Used for capacity templates and scheduling hints. Existing capacities, shifts and deadlines are not changed.');
  }
  if (patch.metrics && !same(patch.metrics, cur.metrics)) {
    out.changedGroups.push('metrics');
    info('metrics', 'Applies to accounts added from now on; existing account cadences stay as they are.');
  }
  if (patch.files && patch.files.quotaBytes !== cur.files.quotaBytes) {
    out.changedGroups.push('files');
    const q = BigInt(patch.files.quotaBytes);
    if (!access.isOwner) block('files.quotaBytes', 'Only the workspace Owner can change the storage quota.');
    else if (q < BigInt(SETTINGS_BOUNDS.fileQuotaBytes.min) || q > BigInt(SETTINGS_BOUNDS.fileQuotaBytes.max)) block('files.quotaBytes', 'Choose a quota between 1 GB and 100 TB.');
    else if (q < ws.storageUsedBytes + ws.storageReservedBytes)
      warn('files', 'The new quota is below current usage. Existing files are not deleted; new uploads are refused until usage drops below the quota.');
    else if (q < BigInt(cur.files.quotaBytes)) info('files', 'Lowering the quota never deletes files.');
  }
  if (patch.retention && !same(patch.retention, cur.retention)) {
    out.changedGroups.push('retention');
    if (!hasAnywhere(access, 'retention.manage')) block('retention', 'You need the Retention permission to change retention periods.');
    const r = patch.retention;
    if (r.trashDays < cur.retention.trashDays) warn('retention', `Items in the trash are purged after ${r.trashDays} days instead of ${cur.retention.trashDays}.`);
    if (r.auditMonths < cur.retention.auditMonths) warn('retention', `Audit events older than ${r.auditMonths} months become eligible for cleanup.`);
    if (r.financialYears < cur.retention.financialYears)
      warn('retention', `Financial documents older than ${r.financialYears} years become eligible for cleanup. Check your legal retention obligations first.`);
    if (r.ofmArchivedNotesDays < cur.retention.ofmArchivedNotesDays) warn('retention', `Archived OFM contact notes are cleaned up after ${r.ofmArchivedNotesDays} days.`);
    if (r.exportDays < cur.retention.exportDays) info('retention', `Export files expire after ${r.exportDays} days.`);
    info('retention', 'Cleanup runs as a background job; nothing is deleted when you save.');
  }
  if (patch.security && !same(patch.security, cur.security)) {
    out.changedGroups.push('security');
    out.requiresRecentAuth = true;
    if (!hasAnywhere(access, 'access.manage')) block('security', 'You need access management rights to change the security policy.');
    const s = patch.security;
    const knownRoles = await db.select({ key: roles.key }).from(roles).where(eq(roles.workspaceId, ws.id));
    const unknown = s.mfaRequiredRoleKeys.filter((k) => !knownRoles.some((r) => r.key === k));
    if (unknown.length) block('security.mfaRequiredRoleKeys', 'Choose roles that exist in this workspace.');
    const newlyRequired = s.mfaRequiredForAll && !cur.security.mfaRequiredForAll;
    const newRoles = s.mfaRequiredRoleKeys.filter((k) => !cur.security.mfaRequiredRoleKeys.includes(k));
    if (newlyRequired || newRoles.length) {
      const [n] = await db
        .select({ n: sql<number>`count(DISTINCT ${memberships.id})` })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .leftJoin(roleAssignments, and(eq(roleAssignments.membershipId, memberships.id), isNull(roleAssignments.revokedAt)))
        .leftJoin(roles, eq(roles.id, roleAssignments.roleId))
        .where(
          and(
            eq(memberships.workspaceId, ws.id),
            eq(memberships.status, 'active'),
            isNull(users.mfaEnabledAt),
            newlyRequired ? undefined : newRoles.length ? inArray(roles.key, newRoles) : sql`false`,
          ),
        );
      const count = Number(n?.n ?? 0);
      if (count > 0) warn('security', `${count} member${count === 1 ? '' : 's'} without two-factor authentication will have to set it up on their next request.`, count);
    }
    if (s.sessionIdleHours < cur.security.sessionIdleHours) warn('security', `Sessions idle longer than ${s.sessionIdleHours} h will end and require a new sign-in.`);
    if (s.sessionAbsoluteDays < cur.security.sessionAbsoluteDays) {
      const cutoff = new Date(at.getTime() - s.sessionAbsoluteDays * 86_400_000);
      const [n] = await db
        .select({ n: count() })
        .from(sessions)
        .innerJoin(memberships, and(eq(memberships.userId, sessions.userId), eq(memberships.workspaceId, ws.id)))
        .where(and(isNull(sessions.revokedAt), gt(sessions.absoluteExpiresAt, at), lt(sessions.createdAt, cutoff)));
      const c = Number(n?.n ?? 0);
      warn('security', `Sessions older than ${s.sessionAbsoluteDays} days end on their next request${c ? ` (${c} currently)` : ''}.`, c || null);
    }
  }
  if (patch.notifications && !same(patch.notifications, cur.notifications)) {
    out.changedGroups.push('notifications');
    info('notifications', 'Applies to people who join from now on. Existing members keep their personal notification settings.');
  }
  if (patch.modules && !same([...patch.modules.hidden].sort(), [...cur.modules.hidden].sort())) {
    out.changedGroups.push('modules');
    info('modules', 'Hidden modules disappear from navigation for everyone. Records and permissions are unchanged.');
  }
  return out;
};

export const previewWorkspaceSettings = async (ctx: QueryContext, patch: WorkspaceSettingsPatch) => {
  requirePermission(ctx, 'workspace.update');
  const ws = await loadWorkspace(ctx);
  return evaluate(ctx, ws, patch);
};

const flattenForAudit = (before: Groups & { general: Record<string, unknown> }, patch: WorkspaceSettingsPatch): Diff => {
  const d: Diff = {};
  for (const [group, value] of Object.entries(patch)) {
    if (!value) continue;
    for (const [k, v] of Object.entries(value)) {
      const prev = (before as Record<string, Record<string, unknown>>)[group]?.[k];
      if (!same(prev, v)) d[`${group}.${k}`] = { from: prev ?? null, to: v };
    }
  }
  return d;
};

export const updateWorkspaceSettings = async (ctx: CommandContext, patch: WorkspaceSettingsPatch) => {
  requirePermission(ctx, 'workspace.update');
  const ws = await loadWorkspace(ctx, true);
  if (ctx.request.expectedVersion === undefined) throw new AppError('PRECONDITION_REQUIRED', 'This change requires the version of the settings you edited (If-Match).');
  if (ctx.request.expectedVersion !== ws.rowVersion)
    throw new AppError('VERSION_CONFLICT', 'This record changed while you were editing it.', { currentVersion: ws.rowVersion });
  const ev = await evaluate(ctx, ws, patch);
  if (ev.blocked.length)
    throw new AppError(
      ev.blocked.some((b) => /Owner|permission|rights/.test(b.message)) ? 'FORBIDDEN' : 'VALIDATION_FAILED',
      ev.blocked[0]!.message,
      { fieldErrors: ev.blocked.map((b) => ({ field: b.field, code: 'INVALID', message: b.message })) },
    );
  if (ev.requiresRecentAuth) requireRecentAuth(ctx);
  if (ev.changedGroups.length === 0) return getWorkspaceSettings(ctx);
  const cur = groupsOf(ws);
  const s: WorkspaceSettings = { ...(ws.settings ?? {}) };
  if (patch.workingTime) {
    s.workingDays = patch.workingTime.workingDays;
    s.workingHours = patch.workingTime.workingHours;
  }
  if (patch.metrics) s.metricCadences = { accountDefault: patch.metrics.accountDefaultCadence, followerSnapshotDaily: patch.metrics.followerSnapshotDaily };
  if (patch.files) s.fileQuotaBytes = patch.files.quotaBytes;
  if (patch.retention) s.retention = patch.retention;
  if (patch.security) {
    s.mfaPolicy = { requiredForAll: patch.security.mfaRequiredForAll, requiredRoleKeys: [...new Set(patch.security.mfaRequiredRoleKeys)] };
    s.sessionIdleHours = patch.security.sessionIdleHours;
    s.sessionAbsoluteDays = patch.security.sessionAbsoluteDays;
  }
  if (patch.notifications) s.notificationDefaults = patch.notifications;
  if (patch.modules) s.moduleVisibility = Object.fromEntries(HIDEABLE_MODULES.map((m) => [m, !patch.modules!.hidden.includes(m)]));
  const g = patch.general ?? {};
  await ctx.tx
    .update(workspaces)
    .set({
      ...(g.name !== undefined ? { name: g.name.trim() } : {}),
      ...(g.timezone !== undefined ? { timezone: g.timezone } : {}),
      ...(g.baseCurrency !== undefined ? { baseCurrency: g.baseCurrency } : {}),
      ...(g.weekStartsOn !== undefined ? { weekStartsOn: g.weekStartsOn } : {}),
      ...(g.logoAssetId !== undefined ? { logoAssetId: g.logoAssetId } : {}),
      settings: s,
      settingsVersion: sql`${workspaces.settingsVersion} + 1`,
      rowVersion: sql`${workspaces.rowVersion} + 1`,
      updatedAt: ctx.app.clock.now(),
      updatedBy: ctx.actor.userId,
    })
    .where(eq(workspaces.id, ws.id));
  const diff = flattenForAudit(
    { ...cur, general: { name: ws.name, timezone: ws.timezone, baseCurrency: ws.baseCurrency, weekStartsOn: ws.weekStartsOn, logoAssetId: ws.logoAssetId } },
    patch,
  );
  await audit(ctx, {
    action: 'workspace.settings_updated',
    entityType: 'workspace',
    entityId: ws.id,
    diff,
    sensitivity: ev.changedGroups.includes('security') ? 'security' : 'normal',
    metadata: { groups: ev.changedGroups },
  });
  await emit(ctx, { type: 'workspace.settings_updated', entityType: 'workspace', entityId: ws.id, payload: { groups: ev.changedGroups } });
  return getWorkspaceSettings(ctx);
};

// ——— Test mail to self (S67) ———

export const sendTestMail = async (ctx: CommandContext) => {
  requirePermission(ctx, 'workspace.update');
  const at = ctx.app.clock.now();
  const [recent] = await ctx.tx
    .select({ n: count() })
    .from(jobs)
    .where(and(eq(jobs.workspaceId, ctx.actor.workspaceId), eq(jobs.type, 'mail.send'), eq(jobs.requestedBy, ctx.actor.userId!), gt(jobs.createdAt, new Date(at.getTime() - 60_000)), sql`${jobs.idempotencyKey} LIKE 'mail.test:%'`));
  if (Number(recent?.n ?? 0) > 0) throw new AppError('RATE_LIMITED', 'Wait a minute before sending another test message.', { retryAfterSeconds: 60, retryable: true });
  const [u] = await ctx.tx.select({ email: users.displayEmail }).from(users).where(eq(users.id, ctx.actor.userId!));
  const [ws] = await ctx.tx.select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, ctx.actor.workspaceId));
  if (!u) throw notFound('User');
  const messageId = newId();
  await enqueueJob(ctx.tx, {
    type: 'mail.send',
    workspaceId: ctx.actor.workspaceId,
    payload: { template: 'testMessage', to: u.email, vars: { workspaceName: ws?.name }, messageId, related: { entityType: 'workspace', entityId: ctx.actor.workspaceId } },
    idempotencyKey: `mail.test:${messageId}`,
    requestedBy: ctx.actor.userId,
    maxRetries: 1,
  });
  await audit(ctx, { action: 'workspace.mail_test_requested', entityType: 'workspace', entityId: ctx.actor.workspaceId, metadata: { messageId, transport: ctx.app.config.MAIL_TRANSPORT } });
  return { messageId, to: u.email };
};

export const mailTestStatus = async (ctx: QueryContext, messageId: string) => {
  requirePermission(ctx, 'workspace.update');
  const [u] = await ctx.app.db.select({ email: users.displayEmail }).from(users).where(eq(users.id, ctx.actor.userId!));
  const [m] = await ctx.app.db
    .select()
    .from(mailMessages)
    .where(and(eq(mailMessages.id, messageId), eq(mailMessages.workspaceId, ctx.actor.workspaceId), eq(mailMessages.template, 'testMessage')));
  if (m) {
    if (m.toAddress !== u?.email) throw notFound('Test message');
    return { messageId, status: m.status, transport: m.transport, error: m.error, sentAt: m.sentAt?.toISOString() ?? null };
  }
  const [j] = await ctx.app.db
    .select({ state: jobs.state, error: jobs.lastErrorMessage, requestedBy: jobs.requestedBy })
    .from(jobs)
    .where(and(eq(jobs.idempotencyKey, `mail.test:${messageId}`), eq(jobs.workspaceId, ctx.actor.workspaceId)));
  if (!j || j.requestedBy !== ctx.actor.userId) throw notFound('Test message');
  return { messageId, status: j.state === 'failed' || j.state === 'dead' ? ('failed' as const) : ('queued' as const), transport: null, error: j.error, sentAt: null };
};
