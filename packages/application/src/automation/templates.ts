import { AUTOMATION_LIMITS, OPERATORS_BY_FIELD_TYPE, OPERATOR_LABELS, AUTOMATION_OPERATORS, type AutomationFieldType } from '@castlane/domain';
import type { AutomationCatalog, AutomationTemplate } from '@castlane/api-contracts';
import { requirePermission } from '../core/access';
import type { QueryContext } from '../core/context';
import { ACTIONS, TRIGGERS } from './catalog';

/** The rule language as data for the editor (S65). */
export const automationCatalog = (ctx: QueryContext): AutomationCatalog => {
  requirePermission(ctx, 'automations.read');
  const fieldTypes = Object.keys(OPERATORS_BY_FIELD_TYPE) as AutomationFieldType[];
  return {
    triggers: TRIGGERS.map((t) => ({
      key: t.key,
      label: t.label,
      description: t.description,
      kind: t.kind,
      entityType: t.entityType,
      thresholdLabel: t.thresholdLabel ?? null,
      defaultThresholdHours: t.defaultThresholdHours ?? null,
      fields: t.fields.map((f) => ({ ...f, options: f.options ? [...f.options] : undefined })),
      actions: t.actions,
    })),
    actions: ACTIONS.map((a) => ({ ...a })),
    operators: AUTOMATION_OPERATORS.map((o) => ({ key: o, label: OPERATOR_LABELS[o], fieldTypes: fieldTypes.filter((t) => OPERATORS_BY_FIELD_TYPE[t].includes(o)) })),
    placeholders: [
      { key: 'entity.title', label: 'Title of the triggering record' },
      { key: 'project.name', label: 'Project name' },
      { key: 'account.label', label: 'Account handle' },
      { key: 'trigger.label', label: 'Trigger name' },
      { key: 'rule.name', label: 'Rule name' },
      { key: 'date', label: 'Today’s date (workspace time zone)' },
    ],
    limits: {
      maxDepth: AUTOMATION_LIMITS.maxDepth,
      maxEffectsPerRoot: AUTOMATION_LIMITS.maxEffectsPerRoot,
      runsPerHour: AUTOMATION_LIMITS.runsPerHour,
      maxConditions: AUTOMATION_LIMITS.maxConditions,
      maxActions: AUTOMATION_LIMITS.maxActions,
    },
  };
};

/** Starter templates — every one uses real, allowed actions and can be enabled after review. */
export const AUTOMATION_TEMPLATES: AutomationTemplate[] = [
  {
    key: 'changes_requested_followup',
    name: 'Follow up on requested changes',
    description: 'When a reviewer requests changes, create a task for the content owner due in 24 hours.',
    config: {
      trigger: { event: 'content.changes_requested' },
      conditions: [],
      actions: [{ type: 'create_task', params: { title: 'Apply requested changes: {{entity.title}}', assignee: { kind: 'entity_owner' }, dueInHours: 24, priority: 'high', linkToRecord: true } }],
      quietHoursPolicy: 'respect',
    },
  },
  {
    key: 'overdue_escalation',
    name: 'Escalate overdue high-priority tasks',
    description: 'When a high or urgent task is 24 hours overdue, notify its assignee and the project owner.',
    config: {
      trigger: { event: 'task.overdue', thresholdHours: 24 },
      conditions: [{ field: 'task.priority', operator: 'in', value: ['high', 'urgent'] }],
      actions: [
        {
          type: 'notify',
          params: { recipients: [{ kind: 'entity_assignee' }, { kind: 'project_owner' }], title: 'Overdue for 24 hours: {{entity.title}}', message: 'Decide on a new deadline, a different assignee or the blocking reason.' },
        },
      ],
      quietHoursPolicy: 'respect',
    },
  },
  {
    key: 'published_checkpoint',
    name: 'Measure results after publishing',
    description: 'When a publication is confirmed, create a 48-hour metrics checkpoint for its account.',
    config: {
      trigger: { event: 'publication.published' },
      conditions: [],
      actions: [{ type: 'create_checkpoint', params: { label: '48h', dueInHours: 48, windowHours: 24 } }],
      quietHoursPolicy: 'respect',
    },
  },
  {
    key: 'report_overdue_reminder',
    name: 'Remind about overdue shift reports',
    description: 'When a shift report is still open 12 hours after the shift ended, notify the shift member and the supervisor.',
    config: {
      trigger: { event: 'shift.report_overdue', thresholdHours: 12 },
      conditions: [],
      actions: [{ type: 'notify', params: { recipients: [{ kind: 'entity_assignee' }, { kind: 'entity_owner' }], title: 'Shift report overdue: {{entity.title}}' } }],
      quietHoursPolicy: 'respect',
    },
  },
  {
    key: 'budget_overspend_review',
    name: 'Review budget overspend',
    description: 'When a budget crosses 100 %, ask the budget owner for an internal review. Nothing in finance changes automatically.',
    config: {
      trigger: { event: 'budget.threshold_crossed' },
      conditions: [{ field: 'budget.threshold', operator: 'gte', value: 100 }],
      actions: [{ type: 'notify', params: { recipients: [{ kind: 'entity_owner' }], title: 'Budget over plan: {{entity.title}}', message: 'Review spending and open commitments.' } }],
      quietHoursPolicy: 'respect',
    },
  },
  {
    key: 'stale_metrics_task',
    name: 'Update stale account metrics',
    description: 'When an active account has no observation for 7 days, create a metrics task for the account owner.',
    config: {
      trigger: { event: 'account.metrics_stale', thresholdHours: 168 },
      conditions: [],
      actions: [{ type: 'create_task', params: { title: 'Record metrics for {{account.label}}', assignee: { kind: 'entity_owner' }, dueInHours: 24, linkToRecord: true } }],
      quietHoursPolicy: 'respect',
    },
  },
  {
    key: 'deal_won_kickoff',
    name: 'Kick off won deals',
    description: 'When a deal moves to Won, create a kickoff task for the deal owner.',
    config: {
      trigger: { event: 'deal.stage_changed' },
      conditions: [{ field: 'deal.stage', operator: 'equals', value: 'won' }],
      actions: [{ type: 'create_task', params: { title: 'Kick off deliverables: {{entity.title}}', assignee: { kind: 'entity_owner' }, dueInHours: 48, linkToRecord: true } }],
      quietHoursPolicy: 'respect',
    },
  },
];

export const listAutomationTemplates = (ctx: QueryContext) => {
  requirePermission(ctx, 'automations.read');
  return AUTOMATION_TEMPLATES;
};
