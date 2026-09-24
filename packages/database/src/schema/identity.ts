import { index, pgTable, primaryKey, unique, uniqueIndex } from 'drizzle-orm/pg-core';
import {
  DELIVERY_STATUSES,
  INVITATION_STATUSES,
  MEMBERSHIP_STATUSES,
  RESPONSIBILITIES,
  SCOPE_TYPES,
  SETUP_STEPS,
  THEMES,
  DENSITIES,
  USER_STATUSES,
} from '@castlane/domain';
import {
  bigint,
  boolean,
  currency,
  enumCheck,
  enumText,
  integer,
  json,
  sql,
  tenantBase,
  text,
  tfk,
  ts,
  uuid,
} from '../columns';

/** Global identity used for sign-in. Workspace participation lives in `memberships`. */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey(),
    normalizedEmail: text('normalized_email').notNull(),
    displayEmail: text('display_email').notNull(),
    displayName: text('display_name').notNull(),
    passwordHash: text('password_hash').notNull(),
    status: enumText('status', USER_STATUSES).notNull().default('active'),
    /** TOTP secret encrypted with MFA_ENCRYPTION_KEY (never the password hash key). */
    mfaSecretEnc: text('mfa_secret_enc'),
    mfaEnabledAt: ts('mfa_enabled_at'),
    /** Last accepted TOTP time-step, prevents replay of the same code. */
    mfaLastStep: bigint('mfa_last_step', { mode: 'number' }),
    passwordChangedAt: ts('password_changed_at'),
    mustChangePassword: boolean('must_change_password').notNull().default(false),
    avatarAssetId: uuid('avatar_asset_id'),
    anonymizedAt: ts('anonymized_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    rowVersion: bigint('row_version', { mode: 'number' }).notNull().default(1),
  },
  (t) => [uniqueIndex('users_normalized_email_uq').on(t.normalizedEmail), enumCheck('users_status_ck', 'status', USER_STATUSES)],
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey(),
    tokenHash: text('token_hash').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    csrfSecret: text('csrf_secret').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
    lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
    idleExpiresAt: ts('idle_expires_at').notNull(),
    absoluteExpiresAt: ts('absolute_expires_at').notNull(),
    mfaVerifiedAt: ts('mfa_verified_at'),
    recentAuthAt: ts('recent_auth_at'),
    revokedAt: ts('revoked_at'),
    revokeReason: text('revoke_reason'),
    userAgent: text('user_agent'),
    ipHash: text('ip_hash'),
    currentWorkspaceId: uuid('current_workspace_id'),
  },
  (t) => [uniqueIndex('sessions_token_hash_uq').on(t.tokenHash), index('sessions_user_idx').on(t.userId, t.revokedAt)],
);

/** Short-lived step between password verification and a full session (MFA verify/setup). */
export const authChallenges = pgTable(
  'auth_challenges',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    tokenHash: text('token_hash').notNull(),
    purpose: text('purpose', { enum: ['mfa_verify', 'mfa_setup'] }).notNull(),
    pendingSecretEnc: text('pending_secret_enc'),
    attempts: integer('attempts').notNull().default(0),
    expiresAt: ts('expires_at').notNull(),
    consumedAt: ts('consumed_at'),
    returnTo: text('return_to'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('auth_challenges_token_uq').on(t.tokenHash)],
);

export const recoveryCodes = pgTable(
  'recovery_codes',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    batchId: uuid('batch_id').notNull(),
    codeHash: text('code_hash').notNull(),
    usedAt: ts('used_at'),
    revokedAt: ts('revoked_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('recovery_codes_user_idx').on(t.userId)],
);

export const passwordResetTokens = pgTable(
  'password_reset_tokens',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    tokenHash: text('token_hash').notNull(),
    expiresAt: ts('expires_at').notNull(),
    usedAt: ts('used_at'),
    revokedAt: ts('revoked_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('password_reset_tokens_hash_uq').on(t.tokenHash)],
);

export const emailChangeRequests = pgTable('email_change_requests', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  newEmail: text('new_email').notNull(),
  tokenHash: text('token_hash').notNull().unique('email_change_token_uq'),
  expiresAt: ts('expires_at').notNull(),
  confirmedAt: ts('confirmed_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

/** Fixed-window counters for brute-force and API rate limiting. */
export const rateLimitBuckets = pgTable('rate_limit_buckets', {
  key: text('key').primaryKey(),
  windowStart: ts('window_start').notNull(),
  count: integer('count').notNull().default(0),
  blockedUntil: ts('blocked_until'),
});

export interface WorkspaceSettings {
  workingDays?: string[];
  metricCadences?: { accountDefault: 'daily' | 'weekly' | 'monthly'; followerSnapshotDaily?: boolean };
  fileQuotaBytes?: string;
  retention?: {
    trashDays: number;
    auditMonths: number;
    financialYears: number;
    ofmArchivedNotesDays: number;
    exportDays: number;
  };
  mfaPolicy?: { requiredForAll: boolean };
  moduleVisibility?: Record<string, boolean>;
  sessionIdleHours?: number;
  sessionAbsoluteDays?: number;
  publicationGraceMinutes?: number;
  maxShiftAccounts?: number;
  reviewPolicy?: { releaseApproval: boolean; contentQuality: boolean; selfReviewAllowed: boolean };
  smtp?: { configured: boolean; lastTestAt?: string; lastTestResult?: string };
}

export const workspaces = pgTable(
  'workspaces',
  {
    id: uuid('id').primaryKey(),
    name: text('name').notNull(),
    timezone: text('timezone').notNull(),
    baseCurrency: currency('base_currency').notNull(),
    baseCurrencyLockedAt: ts('base_currency_locked_at'),
    weekStartsOn: text('week_starts_on', { enum: ['monday', 'sunday'] })
      .notNull()
      .default('monday'),
    logoAssetId: uuid('logo_asset_id'),
    settings: json<WorkspaceSettings>('settings').notNull().default({}),
    settingsVersion: integer('settings_version').notNull().default(1),
    setupStep: enumText('setup_step', SETUP_STEPS).notNull().default('workspace'),
    setupCompletedAt: ts('setup_completed_at'),
    storageUsedBytes: bigint('storage_used_bytes', { mode: 'bigint' }).notNull().default(sql`0`),
    storageReservedBytes: bigint('storage_reserved_bytes', { mode: 'bigint' }).notNull().default(sql`0`),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    createdBy: uuid('created_by'),
    updatedBy: uuid('updated_by'),
    rowVersion: bigint('row_version', { mode: 'number' }).notNull().default(1),
  },
  (t) => [enumCheck('workspaces_setup_step_ck', 'setup_step', SETUP_STEPS)],
);

/** Tenant-owned table config helper: every tenant table exposes (workspace_id, id) as unique. */
export const tenantUnique = (table: string, t: { workspaceId: any; id: any }) =>
  unique(`${table}_ws_id_uq`.slice(0, 63)).on(t.workspaceId, t.id);

export const memberships = pgTable(
  'memberships',
  {
    ...tenantBase(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    status: enumText('status', MEMBERSHIP_STATUSES).notNull().default('active'),
    /** Display snapshot kept for history after anonymisation ("Former Member"). */
    displayNameSnapshot: text('display_name_snapshot').notNull(),
    title: text('title'),
    managerMembershipId: uuid('manager_membership_id'),
    skills: text('skills').array().notNull().default(sql`'{}'::text[]`),
    /** Bumped on every access change; requests compare it to invalidate permission caches. */
    accessRevision: integer('access_revision').notNull().default(1),
    joinedAt: ts('joined_at').notNull().defaultNow(),
    suspendedAt: ts('suspended_at'),
    deactivatedAt: ts('deactivated_at'),
    deactivatedBy: uuid('deactivated_by'),
    restoredAt: ts('restored_at'),
  },
  (t) => [
    tenantUnique('memberships', t),
    uniqueIndex('memberships_ws_user_uq').on(t.workspaceId, t.userId),
    tfk('memberships_manager_fk', t.workspaceId, t.managerMembershipId, t),
    index('memberships_ws_status_idx').on(t.workspaceId, t.status),
    enumCheck('memberships_status_ck', 'status', MEMBERSHIP_STATUSES),
  ],
);

export const roles = pgTable(
  'roles',
  {
    ...tenantBase(),
    key: text('key').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    permissions: text('permissions').array().notNull().default(sql`'{}'::text[]`),
    defaultScopeType: enumText('default_scope_type', SCOPE_TYPES).notNull().default('workspace'),
    isProtected: boolean('is_protected').notNull().default(false),
    isPreset: boolean('is_preset').notNull().default(false),
    basedOnKey: text('based_on_key'),
    archivedAt: ts('archived_at'),
  },
  (t) => [tenantUnique('roles', t), uniqueIndex('roles_ws_key_uq').on(t.workspaceId, t.key)],
);

export const roleAssignments = pgTable(
  'role_assignments',
  {
    ...tenantBase(),
    membershipId: uuid('membership_id').notNull(),
    roleId: uuid('role_id').notNull(),
    scopeType: enumText('scope_type', SCOPE_TYPES).notNull(),
    /** Null for workspace / assigned_* / own_records scopes. */
    scopeId: uuid('scope_id'),
    validFrom: ts('valid_from').notNull().defaultNow(),
    validTo: ts('valid_to'),
    revokedAt: ts('revoked_at'),
    revokedBy: uuid('revoked_by'),
    reason: text('reason'),
  },
  (t) => [
    tenantUnique('role_assignments', t),
    tfk('role_assignments_membership_fk', t.workspaceId, t.membershipId, memberships),
    tfk('role_assignments_role_fk', t.workspaceId, t.roleId, roles),
    index('role_assignments_member_idx').on(t.workspaceId, t.membershipId, t.revokedAt),
    enumCheck('role_assignments_scope_ck', 'scope_type', SCOPE_TYPES),
  ],
);

/** Work duties. Explicitly NOT a source of permissions. */
export const responsibilityAssignments = pgTable(
  'responsibility_assignments',
  {
    ...tenantBase(),
    membershipId: uuid('membership_id').notNull(),
    duty: enumText('duty', RESPONSIBILITIES).notNull(),
    scopeType: enumText('scope_type', SCOPE_TYPES).notNull().default('workspace'),
    scopeId: uuid('scope_id'),
    validFrom: ts('valid_from').notNull().defaultNow(),
    validTo: ts('valid_to'),
  },
  (t) => [
    tenantUnique('responsibility_assignments', t),
    tfk('responsibility_assignments_member_fk', t.workspaceId, t.membershipId, memberships),
    enumCheck('responsibility_assignments_duty_ck', 'duty', RESPONSIBILITIES),
  ],
);

/** Explicit deny entries; they take precedence over any grant. */
export const accessDenies = pgTable(
  'access_denies',
  {
    ...tenantBase(),
    membershipId: uuid('membership_id').notNull(),
    permission: text('permission').notNull(),
    objectType: text('object_type'),
    objectId: uuid('object_id'),
    reason: text('reason').notNull(),
    revokedAt: ts('revoked_at'),
  },
  (t) => [tenantUnique('access_denies', t), tfk('access_denies_member_fk', t.workspaceId, t.membershipId, memberships)],
);

export interface ProposedGrant {
  roleId: string;
  scopeType: (typeof SCOPE_TYPES)[number];
  scopeId: string | null;
}

export const invitations = pgTable(
  'invitations',
  {
    ...tenantBase(),
    emailNormalized: text('email_normalized').notNull(),
    emailDisplay: text('email_display').notNull(),
    proposedGrants: json<ProposedGrant[]>('proposed_grants').notNull().default([]),
    tokenHash: text('token_hash').notNull(),
    expiresAt: ts('expires_at').notNull(),
    status: enumText('status', INVITATION_STATUSES).notNull().default('pending'),
    acceptedAt: ts('accepted_at'),
    acceptedMembershipId: uuid('accepted_membership_id'),
    revokedAt: ts('revoked_at'),
    invitedByMembershipId: uuid('invited_by_membership_id'),
    deliveryStatus: enumText('delivery_status', DELIVERY_STATUSES).notNull().default('queued'),
    deliveryError: text('delivery_error'),
    lastSentAt: ts('last_sent_at'),
    resendCount: integer('resend_count').notNull().default(0),
  },
  (t) => [
    tenantUnique('invitations', t),
    uniqueIndex('invitations_token_uq').on(t.tokenHash),
    index('invitations_ws_email_idx').on(t.workspaceId, t.emailNormalized),
    enumCheck('invitations_status_ck', 'status', INVITATION_STATUSES),
  ],
);

export const invitationRequests = pgTable(
  'invitation_requests',
  {
    ...tenantBase(),
    invitationId: uuid('invitation_id').notNull(),
    emailNormalized: text('email_normalized').notNull(),
    status: text('status', { enum: ['open', 'resolved', 'dismissed'] })
      .notNull()
      .default('open'),
    resolvedAt: ts('resolved_at'),
  },
  (t) => [
    tenantUnique('invitation_requests', t),
    tfk('invitation_requests_inv_fk', t.workspaceId, t.invitationId, invitations),
    uniqueIndex('invitation_requests_open_uq').on(t.invitationId).where(sql`status = 'open'`),
  ],
);

export const ownershipTransfers = pgTable(
  'ownership_transfers',
  {
    ...tenantBase(),
    fromMembershipId: uuid('from_membership_id').notNull(),
    toMembershipId: uuid('to_membership_id').notNull(),
    status: text('status', { enum: ['pending', 'accepted', 'cancelled', 'expired'] })
      .notNull()
      .default('pending'),
    previousOwnerRoleKey: text('previous_owner_role_key').notNull().default('admin'),
    expiresAt: ts('expires_at').notNull(),
    acceptedAt: ts('accepted_at'),
  },
  (t) => [
    tenantUnique('ownership_transfers', t),
    tfk('ownership_transfers_from_fk', t.workspaceId, t.fromMembershipId, memberships),
    tfk('ownership_transfers_to_fk', t.workspaceId, t.toMembershipId, memberships),
    uniqueIndex('ownership_transfers_pending_uq').on(t.workspaceId).where(sql`status = 'pending'`),
  ],
);

export interface NotificationPreferenceMap {
  mentions: boolean;
  assignments: boolean;
  reviewRequests: boolean;
  dueReminders: boolean;
  emailImmediate: boolean;
  dailyDigest: boolean;
}

export const userPreferences = pgTable('user_preferences', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id),
  timezone: text('timezone'),
  locale: text('locale').notNull().default('en-US'),
  theme: enumText('theme', THEMES).notNull().default('system'),
  density: enumText('density', DENSITIES).notNull().default('comfortable'),
  notifications: json<NotificationPreferenceMap>('notifications')
    .notNull()
    .default({ mentions: true, assignments: true, reviewRequests: true, dueReminders: true, emailImmediate: false, dailyDigest: false }),
  quietHoursStart: text('quiet_hours_start').notNull().default('22:00'),
  quietHoursEnd: text('quiet_hours_end').notNull().default('08:00'),
  ui: json<Record<string, unknown>>('ui').notNull().default({}),
  updatedAt: ts('updated_at').notNull().defaultNow(),
  rowVersion: bigint('row_version', { mode: 'number' }).notNull().default(1),
});

/** One-time bootstrap marker: bootstrap is refused once a row exists. */
export const systemState = pgTable(
  'system_state',
  {
    key: text('key').notNull(),
    value: json<Record<string, unknown>>('value').notNull(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ name: 'system_state_pk', columns: [t.key] })],
);
