import { humanize } from '@castlane/ui';
import { label, registerLabels } from '@/lib/labels';

registerLabels({
  membershipStatus: { active: 'Active', suspended: 'Suspended', deactivated: 'Deactivated' },
  directionStatus: { active: 'Active', archived: 'Archived' },
  responsibility: {
    direction_management: 'Direction Management',
    producing: 'Producing',
    writing: 'Writing',
    image_generation: 'Image Generation',
    video_generation: 'Video Generation',
    voice: 'Voice',
    editing: 'Editing',
    quality_review: 'Quality Review',
    publishing: 'Publishing',
    analytics: 'Analytics',
    ofm_operations: 'OFM Operations',
    finance: 'Finance',
  },
  scopeType: {
    workspace: 'Whole workspace',
    direction: 'One direction',
    project: 'One project',
    account: 'One account',
    assigned_projects: 'Projects they are assigned to',
    assigned_accounts: 'Accounts they are assigned to',
    assigned_object: 'Only items assigned to them',
    own_records: 'Only their own records',
  },
  invitationStatus: { pending: 'Pending', accepted: 'Accepted', revoked: 'Revoked', expired: 'Expired' },
  deliveryStatus: { queued: 'Delivery queued', sent: 'Delivered to mail server', failed: 'Delivery failed', suppressed: 'Not sent' },
  permissionGroup: {
    identity: 'Identity & Team',
    production: 'Production',
    media: 'Media & Knowledge',
    ofm: 'OFM',
    insights: 'Insights',
    finance: 'Finance',
    automation: 'Automation & System',
  },
  auditAction: {
    'member.updated': 'Profile updated',
    'member.role_granted': 'Role granted',
    'member.role_revoked': 'Role revoked',
    'member.role_interval_changed': 'Grant end date changed',
    'member.deny_added': 'Access restriction added',
    'member.deny_removed': 'Access restriction removed',
    'member.duty_added': 'Duty added',
    'member.duty_ended': 'Duty ended',
    'member.suspended': 'Suspended',
    'member.reactivated': 'Reactivated',
    'member.deactivated': 'Deactivated',
    'member.restored': 'Restored',
    'member.sessions_revoked': 'Signed out everywhere',
    'member.work_transferred': 'Work transferred',
  },
  module: {
    ofm: 'OFM',
    campaigns: 'Campaigns',
    partners: 'Partners',
    references: 'References',
    knowledge: 'Knowledge',
    goals: 'Goals',
    calendar: 'Calendar',
    library: 'Library',
  },
});

/** "projects.read" → "Projects: Read", "time.read.own" → "Time: Read Own". */
export const permissionLabel = (key: string): string => {
  const [subject, ...rest] = key.split('.');
  const action = rest.join('_').replace(/-/g, '_');
  return `${humanize((subject ?? '').replace(/-/g, '_'))}: ${humanize(action || 'all')}`;
};

export const actionLabel = (action: string): string => {
  const known = label('auditAction', action);
  if (known !== humanize(action)) return known;
  const [entity, verb] = action.split('.');
  return `${humanize(entity)}: ${humanize(verb ?? '')}`;
};

export const scopeTypeLabel = (t: string) => label('scopeType', t);
export const dutyLabel = (d: string) => label('responsibility', d);
