import { z } from 'zod';
import { DIRECTION_STATUSES, INVITATION_STATUSES, DELIVERY_STATUSES, LIMITS, MEMBERSHIP_STATUSES, PROJECT_STATUSES, PROJECT_TYPES, RESPONSIBILITIES, SCOPE_TYPES } from '@castlane/domain';
import { endpoint } from './core';
import { boolQuery, csv, isoDateTime, memberRef, okResponse, page, pageQuery, reason, shortName, uuid, wsId } from './common';
import { directionRow } from './organization';

export * from './settings';

/**
 * Team, Access & Ownership (S12 extensions, S61 Team, S62 Member Workspace, S63 Roles and Access).
 * Endpoint ids use the `team.` / `roles.` / `ownership.` / `directions.` prefixes for cache invalidation.
 */

const scopeType = z.enum(SCOPE_TYPES);
const duty = z.enum(RESPONSIBILITIES);
const membershipStatus = z.enum(MEMBERSHIP_STATUSES);

/** A role + scope pair as proposed in invitations, grants and restores. */
export const grantInput = z.object({ roleId: uuid, scopeType, scopeId: uuid.nullable() });
export type GrantInput = z.infer<typeof grantInput>;

export const scopeRef = z.object({
  scopeType,
  scopeId: uuid.nullable(),
  /** Human label ("Whole workspace", "Direction: AI Series"); names of objects outside the viewer's scope are not revealed. */
  scopeLabel: z.string(),
});

export const roleGrantSummary = scopeRef.extend({
  roleId: uuid,
  roleKey: z.string(),
  roleName: z.string(),
});

// ——— Members (S61 / S62) ———

export const memberRow = z.object({
  membershipId: uuid,
  displayName: z.string(),
  email: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  title: z.string().nullable(),
  status: membershipStatus,
  isOwner: z.boolean(),
  joinedAt: isoDateTime,
  suspendedAt: isoDateTime.nullable(),
  deactivatedAt: isoDateTime.nullable(),
  roles: z.array(roleGrantSummary),
  responsibilities: z.array(z.object({ duty, scopeLabel: z.string() })),
  manager: memberRef.nullable(),
  directions: z.array(z.object({ id: uuid, name: z.string() })),
  /** Projects the member is on that the viewer may see (first 5) and the visible total. */
  projects: z.array(z.object({ id: uuid, name: z.string() })),
  projectCount: z.number().int(),
  /** Open tasks assigned to the member, counted only within the viewer's task scope; null when the viewer cannot read tasks (unknown ≠ 0). */
  openTasks: z.number().int().nullable(),
  /** MFA state — present only for members with access.read (never secrets). */
  mfaEnabled: z.boolean().optional(),
  rowVersion: z.number().int(),
});
export type MemberRow = z.infer<typeof memberRow>;

export const responsibilityRow = scopeRef.extend({
  id: uuid,
  duty,
  validFrom: isoDateTime,
  validTo: isoDateTime.nullable(),
  rowVersion: z.number().int(),
});

export const memberDetail = memberRow.extend({
  skills: z.array(z.string()),
  timezone: z.string().nullable(),
  restoredAt: isoDateTime.nullable(),
  deactivatedBy: memberRef.nullable(),
  reports: z.array(memberRef),
  responsibilityAssignments: z.array(responsibilityRow),
  isSelf: z.boolean(),
  permissions: z.object({
    update: z.boolean(),
    suspend: z.boolean(),
    deactivate: z.boolean(),
    restore: z.boolean(),
    manageAccess: z.boolean(),
    viewAccess: z.boolean(),
    revokeSessions: z.boolean(),
    transferWork: z.boolean(),
    assignProject: z.boolean(),
    viewActivity: z.boolean(),
  }),
});
export type MemberDetail = z.infer<typeof memberDetail>;

export const memberSort = z.enum(['name', 'joinedAt', 'status']);

// ——— Effective access (S62 Access tab / S63) ———

export const grantRow = roleGrantSummary.extend({
  id: uuid,
  validFrom: isoDateTime,
  validTo: isoDateTime.nullable(),
  revokedAt: isoDateTime.nullable(),
  revokedBy: memberRef.nullable(),
  reason: z.string().nullable(),
  grantedBy: memberRef.nullable(),
  /** The role contains finance, OFM contact, restricted media or export permissions. */
  sensitive: z.boolean(),
  canRevoke: z.boolean(),
  rowVersion: z.number().int(),
});
export type GrantRow = z.infer<typeof grantRow>;

export const DENY_OBJECT_TYPES = ['project', 'account', 'direction'] as const;

export const denyRow = z.object({
  id: uuid,
  permission: z.string(),
  objectType: z.enum(DENY_OBJECT_TYPES).nullable(),
  objectId: uuid.nullable(),
  objectLabel: z.string().nullable(),
  reason: z.string(),
  createdAt: isoDateTime,
  createdBy: memberRef.nullable(),
  canRevoke: z.boolean(),
  rowVersion: z.number().int(),
});
export type DenyRow = z.infer<typeof denyRow>;

export const memberAccess = z.object({
  membershipId: uuid,
  status: membershipStatus,
  isOwner: z.boolean(),
  accessRevision: z.number().int(),
  mfa: z.object({ enabled: z.boolean(), required: z.boolean() }),
  grants: z.array(grantRow),
  history: z.array(grantRow),
  denies: z.array(denyRow),
  groups: z.array(
    z.object({
      key: z.string(),
      permissions: z.array(
        z.object({
          key: z.string(),
          held: z.boolean(),
          denied: z.boolean(),
          sensitive: z.boolean(),
          via: z.array(z.object({ roleName: z.string(), scopeLabel: z.string() })),
        }),
      ),
    }),
  ),
  canManage: z.boolean(),
});
export type MemberAccess = z.infer<typeof memberAccess>;

export const objectRefInput = z.object({ type: z.string().min(2).max(60), id: uuid });

export const evaluationResult = z.object({
  permission: z.string(),
  allowed: z.boolean(),
  reason: z.string(),
  viaRole: z.string().nullable(),
  viaScope: z.string().nullable(),
});

// ——— Open work / deactivation (F12, T019) ———

export const responsibilityItemView = z.object({
  kind: z.string(),
  entityType: z.string(),
  entityId: uuid,
  title: z.string(),
  projectId: uuid.nullable(),
  dueAt: isoDateTime.nullable(),
  requiresSuccessor: z.boolean(),
  href: z.string().nullable(),
});

export const openWorkGroup = z.object({
  kind: z.string(),
  label: z.string(),
  unassignedBehaviour: z.string(),
  items: z.array(responsibilityItemView),
});

export const resolutionInput = z.object({ kind: z.string().min(1).max(80), entityId: uuid, successorMembershipId: uuid.nullable() });
export type ResolutionInput = z.infer<typeof resolutionInput>;

export const deactivationPreview = z.object({
  member: memberRef,
  rowVersion: z.number().int(),
  groups: z.array(openWorkGroup),
  /** Items that still need a successor before deactivation can be confirmed. */
  missingSuccessors: z.array(z.object({ kind: z.string(), entityId: uuid, title: z.string() })),
  invalidSuccessors: z.array(z.object({ kind: z.string(), entityId: uuid, message: z.string() })),
  effects: z.array(z.object({ kind: z.string(), label: z.string(), count: z.number().int() })),
  blocked: z.string().nullable(),
  /** Binds the reviewed item list and the chosen successors; valid for 10 minutes. */
  impactToken: z.string().nullable(),
  expiresAt: isoDateTime.nullable(),
});
export type DeactivationPreview = z.infer<typeof deactivationPreview>;

export const restorePreview = z.object({
  member: memberRef,
  rowVersion: z.number().int(),
  status: membershipStatus,
  previousGrants: z.array(roleGrantSummary.extend({ sensitive: z.boolean(), grantable: z.boolean(), note: z.string().nullable() })),
  suggestedGrants: z.array(grantInput),
});

// ——— Invitations ———

export const invitationRow = z.object({
  id: uuid,
  email: z.string(),
  /** Acceptance state; delivery is tracked separately (deliveryStatus). */
  status: z.enum(INVITATION_STATUSES),
  deliveryStatus: z.enum(DELIVERY_STATUSES),
  deliveryError: z.string().nullable(),
  lastSentAt: isoDateTime.nullable(),
  resendCount: z.number().int(),
  expiresAt: isoDateTime,
  createdAt: isoDateTime,
  invitedBy: memberRef.nullable(),
  acceptedMember: memberRef.nullable(),
  grants: z.array(roleGrantSummary),
  openRequest: z.boolean(),
  rowVersion: z.number().int(),
});
export type InvitationRow = z.infer<typeof invitationRow>;

export const invitationRequestRow = z.object({
  id: uuid,
  invitationId: uuid,
  email: z.string(),
  status: z.enum(['open', 'resolved', 'dismissed']),
  createdAt: isoDateTime,
  resolvedAt: isoDateTime.nullable(),
  invitationStatus: z.enum(INVITATION_STATUSES),
  grants: z.array(roleGrantSummary),
});

const inviteOutcome = z.enum(['queued', 'resent', 'already_member', 'invalid_role', 'invalid_scope']);

export const teamEndpoints = {
  list: endpoint({
    id: 'team.list',
    method: 'GET',
    path: '/workspaces/{workspaceId}/members',
    summary: 'Team roster in the viewer’s scope (filters: status, role, direction, project, responsibility).',
    tags: ['Team'],
    auth: 'workspace',
    permission: 'members.read',
    params: wsId({}),
    query: pageQuery.extend({
      q: z.string().trim().max(120).optional(),
      status: csv(membershipStatus).optional(),
      roleId: uuid.optional(),
      directionId: uuid.optional(),
      projectId: uuid.optional(),
      responsibility: duty.optional(),
      sort: memberSort.default('name'),
      direction: z.enum(['asc', 'desc']).default('asc'),
    }),
    response: page(memberRow),
  }),
  get: endpoint({
    id: 'team.get',
    method: 'GET',
    path: '/workspaces/{workspaceId}/members/{membershipId}',
    summary: 'Member workspace: profile, manager, roles, responsibilities and allowed actions.',
    tags: ['Team'],
    auth: 'workspace',
    permission: 'members.read',
    params: wsId({ membershipId: uuid }),
    response: memberDetail,
  }),
  update: endpoint({
    id: 'team.update',
    method: 'PATCH',
    path: '/workspaces/{workspaceId}/members/{membershipId}',
    summary: 'Update title, manager and skills. Changing the manager never rewrites historical authorship.',
    tags: ['Team'],
    auth: 'workspace',
    permission: 'members.update',
    ifMatch: true,
    params: wsId({ membershipId: uuid }),
    body: z.object({
      title: z.string().trim().max(120).nullable().optional(),
      managerMembershipId: uuid.nullable().optional(),
      skills: z.array(z.string().trim().min(2).max(40)).max(30).optional(),
    }),
    response: memberDetail,
  }),
  access: endpoint({
    id: 'team.access',
    method: 'GET',
    path: '/workspaces/{workspaceId}/members/{membershipId}/access',
    summary: 'Effective access: role grants with scopes, explicit denies and the permission matrix (Explain Access).',
    tags: ['Team'],
    auth: 'workspace',
    permission: 'access.read',
    params: wsId({ membershipId: uuid }),
    response: memberAccess,
  }),
  assignments: endpoint({
    id: 'team.assignments',
    method: 'GET',
    path: '/workspaces/{workspaceId}/members/{membershipId}/assignments',
    summary: 'Project and account assignments (current and history) limited to what the viewer may read.',
    tags: ['Team'],
    auth: 'workspace',
    permission: 'members.read',
    params: wsId({ membershipId: uuid }),
    response: z.object({
      projects: z.array(
        z.object({
          id: uuid,
          project: z.object({ id: uuid, name: z.string(), status: z.enum(PROJECT_STATUSES), type: z.enum(PROJECT_TYPES) }),
          responsibility: duty.nullable(),
          isOwner: z.boolean(),
          validFrom: isoDateTime,
          validTo: isoDateTime.nullable(),
        }),
      ),
      accounts: z.array(
        z.object({
          id: uuid,
          account: z.object({ id: uuid, label: z.string(), platform: z.string(), projectId: uuid }),
          duty,
          validFrom: isoDateTime,
          validTo: isoDateTime.nullable(),
        }),
      ),
    }),
  }),
  activity: endpoint({
    id: 'team.activity',
    method: 'GET',
    path: '/workspaces/{workspaceId}/members/{membershipId}/activity',
    summary: 'Membership and access history (masked diffs) plus recent actions within the viewer’s scope.',
    tags: ['Team'],
    auth: 'workspace',
    permission: 'members.read',
    params: wsId({ membershipId: uuid }),
    query: pageQuery.extend({ kind: z.enum(['membership', 'actions']).default('membership') }),
    response: page(
      z.object({
        id: uuid,
        action: z.string(),
        entityType: z.string().nullable(),
        entityId: uuid.nullable(),
        actorName: z.string().nullable(),
        occurredAt: isoDateTime,
        reason: z.string().nullable(),
        changes: z.array(z.object({ field: z.string(), from: z.unknown().optional(), to: z.unknown().optional() })),
        href: z.string().nullable(),
      }),
    ),
  }),
  addResponsibility: endpoint({
    id: 'team.addResponsibility',
    method: 'POST',
    path: '/workspaces/{workspaceId}/members/{membershipId}/responsibilities',
    summary: 'Add a work duty (never a source of permissions).',
    tags: ['Team'],
    auth: 'workspace',
    permission: 'members.update',
    idempotent: true,
    params: wsId({ membershipId: uuid }),
    body: z.object({
      duty,
      scopeType: z.enum(['workspace', 'direction', 'project', 'account']),
      scopeId: uuid.nullable(),
      validFrom: isoDateTime.optional(),
      validTo: isoDateTime.nullable().optional(),
    }),
    response: responsibilityRow,
    successStatus: 201,
  }),
  endResponsibility: endpoint({
    id: 'team.endResponsibility',
    method: 'POST',
    path: '/workspaces/{workspaceId}/responsibilities/{responsibilityId}/end',
    summary: 'End a duty assignment (history is kept).',
    tags: ['Team'],
    auth: 'workspace',
    permission: 'members.update',
    idempotent: true,
    ifMatch: true,
    params: wsId({ responsibilityId: uuid }),
    body: z.object({ reason: reason.optional() }),
    response: okResponse,
  }),
  bulkAssignDirection: endpoint({
    id: 'team.bulkAssignDirection',
    method: 'POST',
    path: '/workspaces/{workspaceId}/members-bulk/assign-direction',
    summary: 'Give selected members a duty in a direction (per-member result; no permissions are granted).',
    tags: ['Team'],
    auth: 'workspace',
    permission: 'members.update',
    idempotent: true,
    params: wsId({}),
    body: z.object({ membershipIds: z.array(uuid).min(1).max(200), directionId: uuid, duty }),
    response: z.object({
      results: z.array(z.object({ membershipId: uuid, outcome: z.enum(['assigned', 'already_assigned', 'not_active', 'not_found']) })),
    }),
  }),
  suspend: endpoint({
    id: 'team.suspend',
    method: 'POST',
    path: '/workspaces/{workspaceId}/members/{membershipId}/suspend',
    summary: 'Suspend access temporarily (grants are kept, workspace access stops immediately).',
    tags: ['Team'],
    auth: 'workspace',
    permission: 'members.suspend',
    idempotent: true,
    ifMatch: true,
    params: wsId({ membershipId: uuid }),
    body: z.object({ reason }),
    response: memberDetail,
  }),
  reactivate: endpoint({
    id: 'team.reactivate',
    method: 'POST',
    path: '/workspaces/{workspaceId}/members/{membershipId}/reactivate',
    summary: 'End a suspension.',
    tags: ['Team'],
    auth: 'workspace',
    permission: 'members.suspend',
    idempotent: true,
    ifMatch: true,
    params: wsId({ membershipId: uuid }),
    body: z.object({ reason: reason.optional() }),
    response: memberDetail,
  }),
  revokeSessions: endpoint({
    id: 'team.revokeSessions',
    method: 'POST',
    path: '/workspaces/{workspaceId}/members/{membershipId}/revoke-sessions',
    summary: 'Sign the member out everywhere (they must sign in again).',
    tags: ['Team'],
    auth: 'workspace',
    permission: 'security.sessions.revoke',
    idempotent: true,
    params: wsId({ membershipId: uuid }),
    body: z.object({ reason }),
    response: z.object({ revoked: z.number().int() }),
  }),
  openWork: endpoint({
    id: 'team.openWork',
    method: 'GET',
    path: '/workspaces/{workspaceId}/members/{membershipId}/open-work',
    summary: 'Open responsibilities the member holds, grouped by module (Transfer Work / deactivation).',
    tags: ['Team'],
    auth: 'workspace',
    permission: 'members.update',
    params: wsId({ membershipId: uuid }),
    response: z.object({ groups: z.array(openWorkGroup) }),
  }),
  transferWork: endpoint({
    id: 'team.transferWork',
    method: 'POST',
    path: '/workspaces/{workspaceId}/members/{membershipId}/transfer-work',
    summary: 'Hand selected open items over to successors without deactivating the member.',
    tags: ['Team'],
    auth: 'workspace',
    permission: 'members.update',
    idempotent: true,
    params: wsId({ membershipId: uuid }),
    body: z.object({ resolutions: z.array(resolutionInput).min(1).max(1000), reason: reason.optional() }),
    response: z.object({ transferred: z.number().int() }),
  }),
  deactivationPreview: endpoint({
    id: 'team.deactivationPreview',
    method: 'POST',
    path: '/workspaces/{workspaceId}/members/{membershipId}/deactivation-preview',
    summary: 'Impact preview: open work, proposed successors and effects; returns an impact token.',
    tags: ['Team'],
    auth: 'workspace',
    permission: 'members.suspend',
    params: wsId({ membershipId: uuid }),
    body: z.object({ resolutions: z.array(resolutionInput).max(1000).default([]) }),
    response: deactivationPreview,
  }),
  deactivate: endpoint({
    id: 'team.deactivate',
    method: 'POST',
    path: '/workspaces/{workspaceId}/members/{membershipId}/deactivate',
    summary: 'Transfer work, revoke roles and sessions, cancel their pending invitations and deactivate — one transaction.',
    tags: ['Team'],
    auth: 'workspace',
    permission: 'members.suspend',
    idempotent: true,
    ifMatch: true,
    params: wsId({ membershipId: uuid }),
    body: z.object({ impactToken: z.string().min(20).max(4000), resolutions: z.array(resolutionInput).max(1000), reason }),
    response: memberDetail,
  }),
  restorePreview: endpoint({
    id: 'team.restorePreview',
    method: 'GET',
    path: '/workspaces/{workspaceId}/members/{membershipId}/restore-preview',
    summary: 'Grants removed at deactivation (sensitive ones are never restored silently) and suggested minimal grants.',
    tags: ['Team'],
    auth: 'workspace',
    permission: 'members.suspend',
    params: wsId({ membershipId: uuid }),
    response: restorePreview,
  }),
  restore: endpoint({
    id: 'team.restore',
    method: 'POST',
    path: '/workspaces/{workspaceId}/members/{membershipId}/restore',
    summary: 'Restore a deactivated member with explicitly chosen grants only.',
    tags: ['Team'],
    auth: 'workspace',
    permission: 'members.suspend',
    idempotent: true,
    ifMatch: true,
    params: wsId({ membershipId: uuid }),
    body: z.object({ reason, grants: z.array(grantInput).max(20) }),
    response: memberDetail,
  }),
  grantRole: endpoint({
    id: 'team.grantRole',
    method: 'POST',
    path: '/workspaces/{workspaceId}/role-assignments',
    summary: 'Grant a role at a scope (no escalation; Owner-only for Admin and finance roles; recent authentication).',
    tags: ['Access'],
    auth: 'workspace',
    permission: 'access.manage',
    idempotent: true,
    params: wsId({}),
    body: z.object({
      membershipId: uuid,
      roleId: uuid,
      scopeType,
      scopeId: uuid.nullable(),
      validTo: isoDateTime.nullable().optional(),
      reason: z.string().trim().max(LIMITS.reasonMax).optional(),
    }),
    response: grantRow,
    successStatus: 201,
  }),
  listRoleAssignments: endpoint({
    id: 'team.listRoleAssignments',
    method: 'GET',
    path: '/workspaces/{workspaceId}/role-assignments',
    summary: 'Role grants filtered by member or role.',
    tags: ['Access'],
    auth: 'workspace',
    permission: 'access.read',
    params: wsId({}),
    query: z.object({ membershipId: uuid.optional(), roleId: uuid.optional(), includeRevoked: boolQuery.optional() }),
    response: z.array(grantRow.extend({ member: memberRef })),
  }),
  updateRoleAssignment: endpoint({
    id: 'team.updateRoleAssignment',
    method: 'PATCH',
    path: '/workspaces/{workspaceId}/role-assignments/{assignmentId}',
    summary: 'Change the end of a grant’s validity interval.',
    tags: ['Access'],
    auth: 'workspace',
    permission: 'access.manage',
    ifMatch: true,
    params: wsId({ assignmentId: uuid }),
    body: z.object({ validTo: isoDateTime.nullable(), reason: reason.optional() }),
    response: grantRow,
  }),
  revokeRole: endpoint({
    id: 'team.revokeRole',
    method: 'POST',
    path: '/workspaces/{workspaceId}/role-assignments/{assignmentId}/revoke',
    summary: 'Revoke a grant; open sessions lose the access on their next request.',
    tags: ['Access'],
    auth: 'workspace',
    permission: 'access.manage',
    idempotent: true,
    ifMatch: true,
    params: wsId({ assignmentId: uuid }),
    body: z.object({ reason }),
    response: grantRow,
  }),
  addDeny: endpoint({
    id: 'team.addDeny',
    method: 'POST',
    path: '/workspaces/{workspaceId}/access-denies',
    summary: 'Explicit deny for a member (optionally on one project, account or direction); deny wins over grants.',
    tags: ['Access'],
    auth: 'workspace',
    permission: 'access.manage',
    idempotent: true,
    params: wsId({}),
    body: z.object({
      membershipId: uuid,
      permission: z.string().min(3).max(80),
      objectType: z.enum(DENY_OBJECT_TYPES).nullable(),
      objectId: uuid.nullable(),
      reason,
    }),
    response: denyRow,
    successStatus: 201,
  }),
  revokeDeny: endpoint({
    id: 'team.revokeDeny',
    method: 'POST',
    path: '/workspaces/{workspaceId}/access-denies/{denyId}/revoke',
    summary: 'Remove an explicit deny.',
    tags: ['Access'],
    auth: 'workspace',
    permission: 'access.manage',
    idempotent: true,
    ifMatch: true,
    params: wsId({ denyId: uuid }),
    body: z.object({ reason: reason.optional() }),
    response: okResponse,
  }),
  evaluateAccess: endpoint({
    id: 'team.evaluateAccess',
    method: 'POST',
    path: '/workspaces/{workspaceId}/access/evaluate',
    summary: 'Explain whether a member holds permissions, optionally on one object (safe explanation for access managers).',
    tags: ['Access'],
    auth: 'workspace',
    permission: 'access.read',
    params: wsId({}),
    body: z.object({ membershipId: uuid, permissions: z.array(z.string().min(3).max(80)).min(1).max(60), object: objectRefInput.nullable().optional() }),
    response: z.object({
      member: memberRef,
      object: z.object({ type: z.string(), id: uuid, label: z.string() }).nullable(),
      results: z.array(evaluationResult),
    }),
  }),
  invitations: endpoint({
    id: 'team.invitations',
    method: 'GET',
    path: '/workspaces/{workspaceId}/invitations',
    summary: 'Invitations with acceptance status and separate delivery status.',
    tags: ['Team'],
    auth: 'workspace',
    permission: 'members.invite',
    params: wsId({}),
    query: pageQuery.extend({ status: csv(z.enum(INVITATION_STATUSES)).optional(), q: z.string().trim().max(120).optional() }),
    response: page(invitationRow),
  }),
  invite: endpoint({
    id: 'team.invite',
    method: 'POST',
    path: '/workspaces/{workspaceId}/invitations',
    summary: 'Invite by e-mail with role/scope grants validated against the inviter’s own rights.',
    tags: ['Team'],
    auth: 'workspace',
    permission: 'members.invite',
    idempotent: true,
    params: wsId({}),
    body: z.object({ email: z.string().trim().email().max(254), grants: z.array(grantInput).min(1).max(10) }),
    response: z.object({ outcome: inviteOutcome, invitationId: uuid.nullable(), message: z.string() }),
    successStatus: 201,
  }),
  resendInvitation: endpoint({
    id: 'team.resendInvitation',
    method: 'POST',
    path: '/workspaces/{workspaceId}/invitations/{invitationId}/resend',
    summary: 'Revoke the previous token and send a new one.',
    tags: ['Team'],
    auth: 'workspace',
    permission: 'members.invite',
    idempotent: true,
    params: wsId({ invitationId: uuid }),
    response: z.object({ outcome: inviteOutcome, invitationId: uuid.nullable(), message: z.string() }),
  }),
  revokeInvitation: endpoint({
    id: 'team.revokeInvitation',
    method: 'POST',
    path: '/workspaces/{workspaceId}/invitations/{invitationId}/revoke',
    summary: 'The invitation link stops working immediately.',
    tags: ['Team'],
    auth: 'workspace',
    permission: 'members.invite',
    idempotent: true,
    params: wsId({ invitationId: uuid }),
    response: okResponse,
  }),
  invitationRequests: endpoint({
    id: 'team.invitationRequests',
    method: 'GET',
    path: '/workspaces/{workspaceId}/invitation-requests',
    summary: 'Requests for a new invitation after expiry (F02).',
    tags: ['Team'],
    auth: 'workspace',
    permission: 'members.invite',
    params: wsId({}),
    query: z.object({ status: z.enum(['open', 'resolved', 'dismissed', 'all']).default('open') }),
    response: z.array(invitationRequestRow),
  }),
  resolveInvitationRequest: endpoint({
    id: 'team.resolveInvitationRequest',
    method: 'POST',
    path: '/workspaces/{workspaceId}/invitation-requests/{requestId}/resolve',
    summary: 'Send a new invitation for the request, or dismiss it.',
    tags: ['Team'],
    auth: 'workspace',
    permission: 'members.invite',
    idempotent: true,
    params: wsId({ requestId: uuid }),
    body: z.object({ action: z.enum(['resend', 'dismiss']) }),
    response: z.object({ status: z.enum(['resolved', 'dismissed']), outcome: inviteOutcome.nullable(), message: z.string() }),
  }),
};

// ——— Roles (S63) ———

export const roleRow = z.object({
  id: uuid,
  key: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  isPreset: z.boolean(),
  isProtected: z.boolean(),
  basedOnKey: z.string().nullable(),
  defaultScopeType: scopeType,
  permissions: z.array(z.string()),
  sensitivePermissions: z.array(z.string()),
  activeAssignments: z.number().int(),
  archivedAt: isoDateTime.nullable(),
  updatedAt: isoDateTime,
  rowVersion: z.number().int(),
  /** The viewer may change this role's permissions / grant it to others. */
  canEdit: z.boolean(),
  canGrant: z.boolean(),
});
export type RoleRow = z.infer<typeof roleRow>;

export const roleDetail = roleRow.extend({
  assignments: z.array(z.object({ id: uuid, member: memberRef, scopeType, scopeLabel: z.string(), validFrom: isoDateTime, validTo: isoDateTime.nullable() })),
  /** Preset roles: difference from the catalog preset (Reset to Preset restores it). */
  presetDiff: z.object({ added: z.array(z.string()), removed: z.array(z.string()) }).nullable(),
});
export type RoleDetail = z.infer<typeof roleDetail>;

export const roleImpact = z.object({
  added: z.array(z.string()),
  removed: z.array(z.string()),
  sensitiveAdded: z.array(z.string()),
  sensitiveRemoved: z.array(z.string()),
  affectedMembers: z.object({ count: z.number().int(), sample: z.array(memberRef) }),
  /** Why the viewer cannot apply this change (null when allowed). */
  blocked: z.string().nullable(),
});
export type RoleImpact = z.infer<typeof roleImpact>;

const permissionList = z.array(z.string().min(3).max(80)).max(300);

export const roleEndpoints = {
  list: endpoint({
    id: 'roles.list',
    method: 'GET',
    path: '/workspaces/{workspaceId}/roles',
    summary: 'Role presets and custom roles with permission sets and active grant counts.',
    tags: ['Access'],
    auth: 'workspace',
    permission: 'access.read',
    params: wsId({}),
    query: z.object({ includeArchived: boolQuery.optional() }),
    response: z.array(roleRow),
  }),
  grantable: endpoint({
    id: 'roles.grantable',
    method: 'GET',
    path: '/workspaces/{workspaceId}/roles-grantable',
    summary: 'Roles the viewer may grant (invitations, grants, restores); Owner is never listed.',
    tags: ['Access'],
    auth: 'workspace',
    params: wsId({}),
    response: z.array(z.object({ id: uuid, key: z.string(), name: z.string(), description: z.string().nullable(), defaultScopeType: scopeType, permissions: z.array(z.string()), sensitive: z.boolean() })),
  }),
  get: endpoint({
    id: 'roles.get',
    method: 'GET',
    path: '/workspaces/{workspaceId}/roles/{roleId}',
    summary: 'Role with its permission matrix and the members holding it.',
    tags: ['Access'],
    auth: 'workspace',
    permission: 'access.read',
    params: wsId({ roleId: uuid }),
    response: roleDetail,
  }),
  create: endpoint({
    id: 'roles.create',
    method: 'POST',
    path: '/workspaces/{workspaceId}/roles',
    summary: 'Create a custom role (optionally cloned). Recent authentication; no permissions beyond the creator’s own.',
    tags: ['Access'],
    auth: 'workspace',
    permission: 'access.manage',
    idempotent: true,
    params: wsId({}),
    body: z.object({
      name: shortName,
      description: z.string().trim().max(1000).nullable().optional(),
      permissions: permissionList,
      defaultScopeType: scopeType,
      cloneFromRoleId: uuid.optional(),
    }),
    response: roleDetail,
    successStatus: 201,
  }),
  update: endpoint({
    id: 'roles.update',
    method: 'PATCH',
    path: '/workspaces/{workspaceId}/roles/{roleId}',
    summary: 'Edit a role (Owner is protected). Members holding it see the change on their next request.',
    tags: ['Access'],
    auth: 'workspace',
    permission: 'access.manage',
    ifMatch: true,
    params: wsId({ roleId: uuid }),
    body: z.object({
      name: shortName.optional(),
      description: z.string().trim().max(1000).nullable().optional(),
      permissions: permissionList.optional(),
      defaultScopeType: scopeType.optional(),
    }),
    response: roleDetail,
  }),
  previewImpact: endpoint({
    id: 'roles.previewImpact',
    method: 'POST',
    path: '/workspaces/{workspaceId}/roles/{roleId}/impact-preview',
    summary: 'Permissions added/removed, sensitive changes and affected members before applying.',
    tags: ['Access'],
    auth: 'workspace',
    permission: 'access.read',
    params: wsId({ roleId: uuid }),
    body: z.object({ permissions: permissionList }),
    response: roleImpact,
  }),
  reset: endpoint({
    id: 'roles.reset',
    method: 'POST',
    path: '/workspaces/{workspaceId}/roles/{roleId}/reset',
    summary: 'Reset a preset role to the catalog permission set.',
    tags: ['Access'],
    auth: 'workspace',
    permission: 'access.manage',
    idempotent: true,
    ifMatch: true,
    params: wsId({ roleId: uuid }),
    response: roleDetail,
  }),
  archive: endpoint({
    id: 'roles.archive',
    method: 'POST',
    path: '/workspaces/{workspaceId}/roles/{roleId}/archive',
    summary: 'Archive a custom role that nobody holds any more.',
    tags: ['Access'],
    auth: 'workspace',
    permission: 'access.manage',
    idempotent: true,
    ifMatch: true,
    params: wsId({ roleId: uuid }),
    body: z.object({ reason: reason.optional() }),
    response: roleDetail,
  }),
};

// ——— Ownership transfer (T013) ———

export const ownershipTransfer = z.object({
  id: uuid,
  from: memberRef,
  to: memberRef,
  status: z.enum(['pending', 'accepted', 'cancelled', 'expired']),
  previousOwnerRole: z.object({ key: z.string(), name: z.string() }).nullable(),
  expiresAt: isoDateTime,
  createdAt: isoDateTime,
  acceptedAt: isoDateTime.nullable(),
  canAccept: z.boolean(),
  canCancel: z.boolean(),
  /** Acceptance needs two-factor authentication on the recipient's account. */
  recipientMfaEnabled: z.boolean(),
  rowVersion: z.number().int(),
});
export type OwnershipTransfer = z.infer<typeof ownershipTransfer>;

export const ownershipEndpoints = {
  current: endpoint({
    id: 'ownership.current',
    method: 'GET',
    path: '/workspaces/{workspaceId}/ownership/transfers/current',
    summary: 'The pending ownership transfer visible to the Owner, the recipient and access managers.',
    tags: ['Access'],
    auth: 'workspace',
    params: wsId({}),
    response: z.object({ transfer: ownershipTransfer.nullable(), owner: memberRef.nullable() }),
  }),
  propose: endpoint({
    id: 'ownership.propose',
    method: 'POST',
    path: '/workspaces/{workspaceId}/ownership/transfers',
    summary: 'Owner proposes a transfer (recent authentication); nothing changes until the recipient accepts.',
    tags: ['Access'],
    auth: 'workspace',
    permission: 'ownership.transfer',
    idempotent: true,
    params: wsId({}),
    body: z.object({ toMembershipId: uuid, previousOwnerRoleId: uuid.nullable() }),
    response: ownershipTransfer,
    successStatus: 201,
  }),
  accept: endpoint({
    id: 'ownership.accept',
    method: 'POST',
    path: '/workspaces/{workspaceId}/ownership/transfers/{transferId}/accept',
    summary: 'Recipient accepts (recent authentication with MFA); roles swap atomically.',
    tags: ['Access'],
    auth: 'workspace',
    idempotent: true,
    params: wsId({ transferId: uuid }),
    response: ownershipTransfer,
  }),
  cancel: endpoint({
    id: 'ownership.cancel',
    method: 'POST',
    path: '/workspaces/{workspaceId}/ownership/transfers/{transferId}/cancel',
    summary: 'Owner cancels or recipient declines a pending transfer.',
    tags: ['Access'],
    auth: 'workspace',
    idempotent: true,
    params: wsId({ transferId: uuid }),
    body: z.object({ reason: reason.optional() }),
    response: ownershipTransfer,
  }),
};

// ——— Directions (S12) — extensions of directions.* ———

export const directionDetail = directionRow.extend({
  presetKind: z.string().nullable(),
  sortOrder: z.number().int(),
  archivedAt: isoDateTime.nullable(),
  archiveReason: z.string().nullable(),
  /** Projects of the direction the viewer may read (others are not revealed, not even as a count). */
  projects: z.array(z.object({ id: uuid, name: z.string(), status: z.enum(PROJECT_STATUSES), type: z.enum(PROJECT_TYPES), owner: memberRef })),
  leadHasDirectionRole: z.boolean(),
  permissions: z.object({ manage: z.boolean(), manageAccess: z.boolean() }),
});
export type DirectionDetail = z.infer<typeof directionDetail>;

export const leadImpact = z.object({
  direction: z.object({ id: uuid, name: z.string(), status: z.enum(DIRECTION_STATUSES) }),
  current: memberRef.nullable(),
  proposed: memberRef.nullable(),
  projects: z.object({ total: z.number().int(), active: z.number().int() }),
  proposedAccess: z
    .object({
      hasDirectionLeadRole: z.boolean(),
      /** Direction projects the proposed lead can already read. */
      readableProjects: z.number().int(),
      roleWouldBeGranted: z.object({ roleId: uuid, roleName: z.string(), permissions: z.number().int() }).nullable(),
      canGrant: z.boolean(),
    })
    .nullable(),
  previousAccess: z.object({ grantId: uuid.nullable(), roleName: z.string().nullable(), canRevoke: z.boolean() }).nullable(),
  notes: z.array(z.string()),
});
export type LeadImpact = z.infer<typeof leadImpact>;

export const directionAdminEndpoints = {
  get: endpoint({
    id: 'directions.get',
    method: 'GET',
    path: '/workspaces/{workspaceId}/directions/{directionId}',
    summary: 'Direction with lead, scoped counts and projects the viewer may read.',
    tags: ['Directions'],
    auth: 'workspace',
    permission: 'directions.read',
    params: wsId({ directionId: uuid }),
    response: directionDetail,
  }),
  leadImpact: endpoint({
    id: 'directions.leadImpact',
    method: 'POST',
    path: '/workspaces/{workspaceId}/directions/{directionId}/lead-impact',
    summary: 'Access changes of a lead change, shown before applying.',
    tags: ['Directions'],
    auth: 'workspace',
    permission: 'directions.manage',
    params: wsId({ directionId: uuid }),
    body: z.object({ leadMembershipId: uuid.nullable() }),
    response: leadImpact,
  }),
  assignLead: endpoint({
    id: 'directions.assignLead',
    method: 'POST',
    path: '/workspaces/{workspaceId}/directions/{directionId}/assign-lead',
    summary: 'Change the lead; optionally grant the Direction Lead role for this direction and revoke it from the previous lead.',
    tags: ['Directions'],
    auth: 'workspace',
    permission: 'directions.manage',
    idempotent: true,
    ifMatch: true,
    params: wsId({ directionId: uuid }),
    body: z.object({ leadMembershipId: uuid.nullable(), grantLeadRole: z.boolean().default(false), revokePreviousLeadRole: z.boolean().default(false) }),
    response: directionDetail,
  }),
  restore: endpoint({
    id: 'directions.restore',
    method: 'POST',
    path: '/workspaces/{workspaceId}/directions/{directionId}/restore',
    summary: 'Restore an archived direction (active names stay unique).',
    tags: ['Directions'],
    auth: 'workspace',
    permission: 'directions.manage',
    idempotent: true,
    ifMatch: true,
    params: wsId({ directionId: uuid }),
    response: directionDetail,
  }),
  reorder: endpoint({
    id: 'directions.reorder',
    method: 'POST',
    path: '/workspaces/{workspaceId}/directions/reorder',
    summary: 'Set the display order of active directions.',
    tags: ['Directions'],
    auth: 'workspace',
    permission: 'directions.manage',
    idempotent: true,
    params: wsId({}),
    body: z.object({ orderedIds: z.array(uuid).min(1).max(200) }),
    response: okResponse,
  }),
};
