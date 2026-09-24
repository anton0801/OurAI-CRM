import { registerLabels } from '@/lib/labels';

/** Labels for Automations (S64/S65, §19). */
registerLabels({
  automationState: {
    draft: 'Draft',
    enabled: 'Enabled',
    disabled: 'Disabled',
    paused_needs_owner: 'Needs Owner',
    paused_requires_attention: 'Paused — Requires Attention',
  },
  automationRunState: {
    pending: 'Pending',
    running: 'Running',
    succeeded: 'Succeeded',
    failed: 'Failed',
    skipped: 'Skipped',
    throttled: 'Throttled',
    dead: 'Failed permanently',
  },
  automationScope: { workspace: 'Workspace', direction: 'Direction', project: 'Project', account: 'Account' },
  automationPerson: {
    member: 'A specific member',
    entity_assignee: 'Assignee of the record',
    entity_owner: 'Owner of the record',
    rule_owner: 'Rule owner',
    project_owner: 'Project owner',
  },
  automationQuietHours: { respect: 'Respect quiet hours', ignore_for_inbox: 'Inbox only during quiet hours' },
  automationCadence: { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' },
  automationTriggerKind: { event: 'Event', deadline: 'Deadline', schedule: 'Schedule' },
});

/** Status keys for StatusBadge tones (colour is never the only carrier: the label is text). */
export const RULE_STATE_TONE: Record<string, string> = {
  draft: 'draft',
  enabled: 'enabled',
  disabled: 'archived',
  paused_needs_owner: 'paused',
  paused_requires_attention: 'paused',
};
export const RUN_STATE_TONE: Record<string, string> = {
  pending: 'pending',
  running: 'running',
  succeeded: 'succeeded',
  failed: 'failed',
  skipped: 'cancelled',
  throttled: 'waiting',
  dead: 'dead',
};

export const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;
