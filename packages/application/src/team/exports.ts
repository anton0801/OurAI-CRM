import { MEMBERSHIP_STATUSES, RESPONSIBILITIES } from '@castlane/domain';
import { defineExportDataset } from '../core/export-registry';
import { listMembers, type ListMembersInput } from './members';

/**
 * "Export permitted roster" (S61): the members the requester may see, as of the export boundary.
 * No MFA secrets or compensation; MFA status only for access readers (column permission).
 */
defineExportDataset({
  key: 'team_roster',
  label: 'Team roster',
  permission: 'members.read',
  classification: 'private',
  columns: [
    { key: 'displayName', label: 'Name', type: 'text', default: true },
    { key: 'email', label: 'Email', type: 'text', default: true },
    { key: 'status', label: 'Membership Status', type: 'text', default: true },
    { key: 'title', label: 'Title', type: 'text', default: true },
    { key: 'roles', label: 'Roles', type: 'text', default: true },
    { key: 'responsibilities', label: 'Responsibilities', type: 'text', default: true },
    { key: 'manager', label: 'Manager', type: 'text', default: true },
    { key: 'directions', label: 'Directions', type: 'text', default: true },
    { key: 'projects', label: 'Assigned Projects', type: 'integer', default: true },
    { key: 'joinedAt', label: 'Joined At', type: 'datetime', default: true },
    { key: 'mfaEnabled', label: 'Two-Factor Enabled', type: 'boolean', permission: 'access.read' },
    { key: 'membershipId', label: 'Member ID', type: 'id' },
  ],
  filters: [
    { key: 'status', label: 'Status', type: 'enum', enumValues: MEMBERSHIP_STATUSES },
    { key: 'directionId', label: 'Direction', type: 'reference', lookup: 'direction' },
    { key: 'projectId', label: 'Project', type: 'reference', lookup: 'project' },
    { key: 'responsibility', label: 'Responsibility', type: 'enum', enumValues: RESPONSIBILITIES },
  ],
  async *rows(ctx, { filters, boundAt, fields }) {
    const status = typeof filters.status === 'string' ? [filters.status] : Array.isArray(filters.status) ? filters.status : undefined;
    const base: ListMembersInput = {
      status: status as ListMembersInput['status'],
      directionId: typeof filters.directionId === 'string' ? filters.directionId : undefined,
      projectId: typeof filters.projectId === 'string' ? filters.projectId : undefined,
      responsibility: typeof filters.responsibility === 'string' ? filters.responsibility : undefined,
      sort: 'name',
      direction: 'asc',
      pageSize: 200,
    };
    let cursor: string | undefined;
    do {
      const page = await listMembers(ctx, { ...base, cursor });
      for (const m of page.items) {
        if (new Date(m.joinedAt) > boundAt) continue;
        const row: Record<string, string | number | boolean | null> = {
          displayName: m.displayName,
          email: m.email,
          status: m.status,
          title: m.title,
          roles: m.roles.map((r) => `${r.roleName} (${r.scopeLabel})`).join('; '),
          responsibilities: m.responsibilities.map((r) => `${r.duty} (${r.scopeLabel})`).join('; '),
          manager: m.manager?.displayName ?? null,
          directions: m.directions.map((d) => d.name).join('; '),
          projects: m.projectCount,
          joinedAt: m.joinedAt,
          mfaEnabled: m.mfaEnabled ?? null,
          membershipId: m.membershipId,
        };
        yield Object.fromEntries(Object.entries(row).filter(([k]) => fields.length === 0 || fields.includes(k)));
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
  },
});
