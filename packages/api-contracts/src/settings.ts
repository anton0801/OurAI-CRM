import { z } from 'zod';
import { DENSITIES, LIMITS, THEMES, WEEKDAYS } from '@castlane/domain';
import { endpoint } from './core';
import { currencyCode, isoDateTime, okResponse, timezone, uuid, wsId } from './common';

/**
 * Workspace Settings (S67) and Personal Settings / Security (S68). Bounds follow §31 defaults:
 * sessions can be made stricter than 12 h idle / 7 d absolute, never looser.
 */
export const SETTINGS_BOUNDS = {
  sessionIdleHours: { min: 1, max: 12 },
  sessionAbsoluteDays: { min: 1, max: 7 },
  retention: {
    trashDays: { min: 7, max: 365 },
    auditMonths: { min: 12, max: 120 },
    financialYears: { min: 1, max: 30 },
    ofmArchivedNotesDays: { min: 30, max: 3650 },
    exportDays: { min: 1, max: 30 },
  },
  /** 1 GB … 100 TB, in bytes. */
  fileQuotaBytes: { min: 1024 ** 3, max: 100 * 1024 ** 4 },
} as const;

/** Modules that can be hidden from navigation (core production modules always stay visible). */
export const HIDEABLE_MODULES = ['ofm', 'campaigns', 'partners', 'references', 'knowledge', 'goals', 'calendar', 'library'] as const;

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use the HH:MM format.');
const intIn = (b: { min: number; max: number }) => z.number().int().min(b.min).max(b.max);

export const notificationPrefs = z.object({
  mentions: z.boolean(),
  assignments: z.boolean(),
  reviewRequests: z.boolean(),
  dueReminders: z.boolean(),
  emailImmediate: z.boolean(),
  dailyDigest: z.boolean(),
});
export type NotificationPrefs = z.infer<typeof notificationPrefs>;

const workingTime = z.object({
  workingDays: z.array(z.enum(WEEKDAYS)).min(1).max(7),
  workingHours: z.object({ start: hhmm, end: hhmm }),
});
const metrics = z.object({ accountDefaultCadence: z.enum(['daily', 'weekly', 'monthly']), followerSnapshotDaily: z.boolean() });
const retention = z.object({
  trashDays: intIn(SETTINGS_BOUNDS.retention.trashDays),
  auditMonths: intIn(SETTINGS_BOUNDS.retention.auditMonths),
  financialYears: intIn(SETTINGS_BOUNDS.retention.financialYears),
  ofmArchivedNotesDays: intIn(SETTINGS_BOUNDS.retention.ofmArchivedNotesDays),
  exportDays: intIn(SETTINGS_BOUNDS.retention.exportDays),
});
const security = z.object({
  mfaRequiredForAll: z.boolean(),
  mfaRequiredRoleKeys: z.array(z.string().min(2).max(80)).max(100),
  sessionIdleHours: intIn(SETTINGS_BOUNDS.sessionIdleHours),
  sessionAbsoluteDays: intIn(SETTINGS_BOUNDS.sessionAbsoluteDays),
});
const notifications = notificationPrefs.extend({ quietHoursStart: hhmm, quietHoursEnd: hhmm });
const modules = z.object({ hidden: z.array(z.enum(HIDEABLE_MODULES)).max(HIDEABLE_MODULES.length) });
const files = z.object({ quotaBytes: z.string().regex(/^\d{1,16}$/, 'Enter a whole number of bytes.') });

export const workspaceSettingsGroups = { workingTime, metrics, retention, security, notifications, modules, files };

/** A mail server saved in Workspace Settings. The password is write-only: only whether one is set. */
export const mailServerView = z.object({
  host: z.string(),
  port: z.number().int(),
  secure: z.boolean(),
  username: z.string().nullable(),
  secretSaved: z.boolean(),
  from: z.string(),
  updatedAt: isoDateTime,
});

export const mailStatus = z.object({
  transport: z.enum(['smtp', 'dev_sink']),
  configured: z.boolean(),
  /** Where the SMTP server comes from: saved here (wins), the server environment, or nowhere. */
  source: z.enum(['settings', 'environment', 'none']),
  from: z.string().nullable(),
  /** Saved server (details only for members who manage workspace settings). */
  saved: mailServerView.nullable(),
  canEdit: z.boolean(),
  lastTest: z.object({ at: isoDateTime, status: z.enum(['queued', 'sent', 'failed']), error: z.string().nullable() }).nullable(),
});
export type MailStatus = z.infer<typeof mailStatus>;

export const mailServerInput = z.object({
  host: z.string().trim().min(1).max(253),
  port: z.number().int().min(1).max(65535),
  secure: z.boolean(),
  username: z.string().trim().max(200).nullable().optional(),
  /** Write-only. Omit to keep the saved password; never returned. */
  password: z.string().min(1).max(500).optional(),
  clearPassword: z.boolean().optional(),
  from: z.string().trim().min(3).max(320),
});

export const workspaceSettingsView = z.object({
  general: z.object({
    name: z.string(),
    timezone: z.string(),
    baseCurrency: z.string(),
    baseCurrencyLocked: z.boolean(),
    baseCurrencyLockReason: z.string().nullable(),
    weekStartsOn: z.enum(['monday', 'sunday']),
    logoAssetId: uuid.nullable(),
    logoUrl: z.string().nullable(),
  }),
  workingTime,
  metrics,
  files: z.object({ quotaBytes: z.string(), usedBytes: z.string(), reservedBytes: z.string() }),
  retention,
  security,
  notifications,
  modules,
  mail: mailStatus,
  defaults: z.object({ workingTime, metrics, files, retention, security, notifications, modules }),
  roles: z.array(z.object({ key: z.string(), name: z.string(), alwaysRequiresMfa: z.boolean() })),
  settingsVersion: z.number().int(),
  rowVersion: z.number().int(),
  permissions: z.object({ update: z.boolean(), manageSecurity: z.boolean(), manageRetention: z.boolean(), manageQuota: z.boolean(), changeCurrency: z.boolean(), testMail: z.boolean() }),
});
export type WorkspaceSettingsView = z.infer<typeof workspaceSettingsView>;

export const workspaceSettingsPatch = z.object({
  general: z
    .object({
      name: z.string().trim().min(2).max(80),
      timezone,
      baseCurrency: currencyCode,
      weekStartsOn: z.enum(['monday', 'sunday']),
      logoAssetId: uuid.nullable(),
    })
    .partial()
    .optional(),
  workingTime: workingTime.optional(),
  metrics: metrics.optional(),
  files: files.optional(),
  retention: retention.optional(),
  security: security.optional(),
  notifications: notifications.optional(),
  modules: modules.optional(),
});
export type WorkspaceSettingsPatch = z.infer<typeof workspaceSettingsPatch>;

export const settingsImpact = z.object({
  impacts: z.array(z.object({ group: z.string(), severity: z.enum(['info', 'warning']), message: z.string(), count: z.number().int().nullable() })),
  blocked: z.array(z.object({ field: z.string(), message: z.string() })),
  requiresRecentAuth: z.boolean(),
  changedGroups: z.array(z.string()),
});
export type SettingsImpact = z.infer<typeof settingsImpact>;

// ——— Personal settings ———

export const profileView = z.object({
  user: z.object({
    id: uuid,
    displayName: z.string(),
    email: z.string(),
    avatarUrl: z.string().nullable(),
    avatarAssetId: uuid.nullable(),
    mfaEnabled: z.boolean(),
    mfaRequired: z.boolean(),
    recoveryCodesRemaining: z.number().int().nullable(),
    passwordChangedAt: isoDateTime.nullable(),
    createdAt: isoDateTime,
  }),
  preferences: z.object({
    timezone: z.string().nullable(),
    effectiveTimezone: z.string(),
    locale: z.string(),
    theme: z.enum(THEMES),
    density: z.enum(DENSITIES),
    notifications: notificationPrefs,
    quietHoursStart: z.string(),
    quietHoursEnd: z.string(),
  }),
  pendingEmailChange: z.object({ newEmail: z.string(), expiresAt: isoDateTime }).nullable(),
  recentAuthAt: isoDateTime.nullable(),
  rowVersion: z.number().int(),
});
export type ProfileView = z.infer<typeof profileView>;

export const profilePatch = z.object({
  displayName: z.string().trim().min(LIMITS.displayNameMin).max(LIMITS.displayNameMax).optional(),
  avatarAssetId: uuid.nullable().optional(),
  timezone: timezone.nullable().optional(),
  theme: z.enum(THEMES).optional(),
  density: z.enum(DENSITIES).optional(),
  notifications: notificationPrefs.optional(),
  quietHoursStart: hhmm.optional(),
  quietHoursEnd: hhmm.optional(),
});

const uploadReservation = z.object({
  uploadId: uuid,
  assetId: uuid,
  assetVersionId: uuid,
  partSize: z.number().int(),
  partCount: z.number().int(),
  parts: z.array(z.object({ partNumber: z.number().int(), url: z.string(), method: z.literal('PUT'), headers: z.record(z.string(), z.string()) })),
  expiresAt: isoDateTime,
});

export const settingsEndpoints = {
  workspace: endpoint({
    id: 'settings.workspace',
    method: 'GET',
    path: '/workspaces/{workspaceId}/settings/workspace',
    summary: 'Workspace settings with defaults per group, mail status (no secrets) and allowed changes.',
    tags: ['Settings'],
    auth: 'workspace',
    permission: 'workspace.read',
    params: wsId({}),
    response: workspaceSettingsView,
  }),
  previewWorkspace: endpoint({
    id: 'settings.previewWorkspace',
    method: 'POST',
    path: '/workspaces/{workspaceId}/settings/workspace/impact-preview',
    summary: 'Impact of a settings change before saving (time zone, currency, quota, retention, security).',
    tags: ['Settings'],
    auth: 'workspace',
    permission: 'workspace.update',
    params: wsId({}),
    body: workspaceSettingsPatch,
    response: settingsImpact,
  }),
  updateWorkspace: endpoint({
    id: 'settings.updateWorkspace',
    method: 'PATCH',
    path: '/workspaces/{workspaceId}/settings/workspace',
    summary: 'Save settings (If-Match with the workspace version). Time zone changes never rewrite timestamps.',
    tags: ['Settings'],
    auth: 'workspace',
    permission: 'workspace.update',
    ifMatch: true,
    params: wsId({}),
    body: workspaceSettingsPatch,
    response: workspaceSettingsView,
  }),
  testMail: endpoint({
    id: 'settings.testMail',
    method: 'POST',
    path: '/workspaces/{workspaceId}/settings/workspace/mail-test',
    summary: 'Send a test message to yourself through the configured transport (no bulk send).',
    tags: ['Settings'],
    auth: 'workspace',
    permission: 'workspace.update',
    idempotent: true,
    params: wsId({}),
    response: z.object({ messageId: uuid, to: z.string() }),
    successStatus: 202,
  }),
  saveMailServer: endpoint({
    id: 'settings.saveMailServer',
    method: 'PUT',
    path: '/workspaces/{workspaceId}/settings/workspace/mail',
    summary: 'Save the outgoing mail server (Owner, recent authentication). The password is write-only and never returned.',
    tags: ['Settings'],
    auth: 'workspace',
    permission: 'workspace.update',
    idempotent: true,
    params: wsId({}),
    body: mailServerInput,
    response: mailStatus,
  }),
  removeMailServer: endpoint({
    id: 'settings.removeMailServer',
    method: 'DELETE',
    path: '/workspaces/{workspaceId}/settings/workspace/mail',
    summary: 'Remove the saved mail server (the SMTP_* environment applies again, if set).',
    tags: ['Settings'],
    auth: 'workspace',
    permission: 'workspace.update',
    idempotent: true,
    params: wsId({}),
    response: mailStatus,
  }),
  mailTest: endpoint({
    id: 'settings.mailTest',
    method: 'GET',
    path: '/workspaces/{workspaceId}/settings/workspace/mail-test/{messageId}',
    summary: 'Real delivery state of a test message.',
    tags: ['Settings'],
    auth: 'workspace',
    permission: 'workspace.update',
    params: wsId({ messageId: uuid }),
    response: z.object({ messageId: uuid, status: z.enum(['queued', 'sent', 'failed']), transport: z.string().nullable(), error: z.string().nullable(), sentAt: isoDateTime.nullable() }),
  }),
  me: endpoint({
    id: 'settings.me',
    method: 'GET',
    path: '/workspaces/{workspaceId}/settings/me',
    summary: 'Own profile and preferences.',
    tags: ['Settings'],
    auth: 'workspace',
    params: wsId({}),
    response: profileView,
  }),
  updateMe: endpoint({
    id: 'settings.updateMe',
    method: 'PATCH',
    path: '/workspaces/{workspaceId}/settings/me',
    summary: 'Update own profile and preferences (never roles).',
    tags: ['Settings'],
    auth: 'workspace',
    ifMatch: true,
    params: wsId({}),
    body: profilePatch,
    response: profileView,
  }),
  avatarUpload: endpoint({
    id: 'settings.avatarUpload',
    method: 'POST',
    path: '/workspaces/{workspaceId}/settings/me/avatar-upload',
    summary: 'Reserve an avatar upload (JPG/PNG/WebP up to 10 MB); complete it with uploads.complete.',
    tags: ['Settings'],
    auth: 'workspace',
    idempotent: true,
    params: wsId({}),
    body: z.object({
      filename: z.string().trim().min(1).max(255),
      mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
      byteSize: z.number().int().positive().max(10 * 1024 * 1024),
      checksumSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    }),
    response: uploadReservation,
    successStatus: 201,
  }),
  avatarStatus: endpoint({
    id: 'settings.avatarStatus',
    method: 'GET',
    path: '/workspaces/{workspaceId}/settings/me/avatar-upload/{assetId}',
    summary: 'Verification state of an own avatar upload.',
    tags: ['Settings'],
    auth: 'workspace',
    params: wsId({ assetId: uuid }),
    response: z.object({ assetId: uuid, status: z.string(), rejectionReason: z.string().nullable() }),
  }),
  emailChange: endpoint({
    id: 'settings.emailChange',
    method: 'POST',
    path: '/workspaces/{workspaceId}/settings/me/email-change',
    summary: 'Request an e-mail change: recent authentication, then confirmation from the new address (60 min).',
    tags: ['Settings'],
    auth: 'workspace',
    idempotent: true,
    params: wsId({}),
    body: z.object({ newEmail: z.string().trim().email().max(254) }),
    response: z.object({ newEmail: z.string(), expiresAt: isoDateTime }),
    successStatus: 202,
  }),
  cancelEmailChange: endpoint({
    id: 'settings.cancelEmailChange',
    method: 'POST',
    path: '/workspaces/{workspaceId}/settings/me/email-change/cancel',
    summary: 'Cancel a pending e-mail change.',
    tags: ['Settings'],
    auth: 'workspace',
    idempotent: true,
    params: wsId({}),
    response: okResponse,
  }),
  confirmEmailChange: endpoint({
    id: 'settings.confirmEmailChange',
    method: 'POST',
    path: '/auth/email-change/confirm',
    summary: 'Confirm a new e-mail address with the one-time link token.',
    tags: ['Auth'],
    auth: 'public',
    body: z.object({ token: z.string().min(20).max(200) }),
    response: z.object({ email: z.string() }),
    rateLimit: 'auth',
  }),
  disableMfa: endpoint({
    id: 'settings.disableMfa',
    method: 'POST',
    path: '/auth/mfa/disable',
    summary: 'Turn off two-factor authentication (recent authentication; refused when a role or policy requires it).',
    tags: ['Auth'],
    auth: 'session',
    response: okResponse,
  }),
  avatarImage: endpoint({
    id: 'settings.avatarImage',
    method: 'GET',
    path: '/avatars/{userId}',
    summary: 'Avatar derivative of a person who shares an active workspace with the viewer (private cache).',
    tags: ['Settings'],
    auth: 'session',
    params: z.object({ userId: uuid }),
    query: z.object({ size: z.coerce.number().int().min(16).max(512).default(128) }),
    rateLimit: 'none',
    response: z.any(),
  }),
  logoImage: endpoint({
    id: 'settings.logoImage',
    method: 'GET',
    path: '/workspaces/{workspaceId}/logo',
    summary: 'Workspace logo derivative for members of the workspace.',
    tags: ['Settings'],
    auth: 'workspace',
    params: wsId({}),
    query: z.object({ size: z.coerce.number().int().min(16).max(512).default(128) }),
    rateLimit: 'none',
    response: z.any(),
  }),
  personalData: endpoint({
    id: 'settings.personalData',
    method: 'GET',
    path: '/workspaces/{workspaceId}/settings/me/data',
    summary: 'Personal data stored about you (account, memberships, preferences, sessions, security events).',
    tags: ['Settings'],
    auth: 'workspace',
    params: wsId({}),
    response: z.object({
      account: z.object({ email: z.string(), displayName: z.string(), createdAt: isoDateTime, passwordChangedAt: isoDateTime.nullable(), mfaEnabledAt: isoDateTime.nullable(), avatarStored: z.boolean() }),
      memberships: z.array(z.object({ workspaceName: z.string(), status: z.string(), joinedAt: isoDateTime, title: z.string().nullable(), roles: z.array(z.string()) })),
      preferences: z.record(z.string(), z.unknown()),
      sessions: z.object({ active: z.number().int() }),
      securityEvents: z.array(z.object({ action: z.string(), occurredAt: isoDateTime })),
      notifications: z.object({ total: z.number().int(), unread: z.number().int() }),
    }),
  }),
};
