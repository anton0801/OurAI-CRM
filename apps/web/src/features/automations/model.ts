'use client';
import {
  automationEndpoints,
  type AutomationActionInput,
  type AutomationCatalog,
  type AutomationPersonRef,
  type AutomationRuleConfig,
  type AutomationRuleDetail,
  type AutomationTriggerInput,
} from '@castlane/api-contracts';
import { AUTOMATION_SCOPE_TYPES, OPERATOR_LABELS } from '@castlane/domain';
import { useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useWorkspace } from '@/lib/workspace-context';
import { WEEKDAYS } from './labels';

export type RuleScopeType = (typeof AUTOMATION_SCOPE_TYPES)[number];
export type TriggerSpec = AutomationCatalog['triggers'][number];
export type FieldSpec = TriggerSpec['fields'][number];
export type ActionType = AutomationActionInput['type'];

/** What the editor edits: rule identity plus the versioned configuration. */
export interface RuleDraft {
  name: string;
  ownerMembershipId: string | null;
  scopeType: RuleScopeType;
  scopeId: string | null;
  config: AutomationRuleConfig;
}

export const useAutomationCatalog = () => {
  const { workspace } = useWorkspace();
  return useApiQuery(automationEndpoints.catalog, { params: { workspaceId: workspace.id } }, { staleTime: 5 * 60_000 });
};

export const triggerOf = (catalog: AutomationCatalog | undefined, key: string) => catalog?.triggers.find((t) => t.key === key);
export const actionLabel = (catalog: AutomationCatalog | undefined, type: string) => catalog?.actions.find((a) => a.type === type)?.label ?? label('automationAction', type);

/** Trigger defaults when the trigger changes (threshold for deadlines, a slot for schedules). */
export const defaultTrigger = (t: TriggerSpec): AutomationTriggerInput => {
  if (t.kind === 'deadline') return { event: t.key, thresholdHours: t.defaultThresholdHours ?? 0 };
  if (t.kind === 'schedule') {
    const cadence = t.key.split('.')[1] as 'daily' | 'weekly' | 'monthly';
    return { event: t.key, schedule: { cadence, localTime: '09:00', weekday: cadence === 'weekly' ? 1 : undefined, monthDay: cadence === 'monthly' ? 1 : undefined } };
  }
  return { event: t.key };
};

const owner: AutomationPersonRef = { kind: 'rule_owner' };

/** A new action of a type with sensible starting parameters (validation explains what is missing). */
export const defaultAction = (type: ActionType, t: TriggerSpec | undefined): AutomationActionInput => {
  const hasRecord = !!t?.entityType;
  switch (type) {
    case 'create_task':
      return { type, params: { title: hasRecord ? 'Follow up: {{entity.title}}' : '', assignee: hasRecord ? { kind: 'entity_owner' } : owner, dueInHours: 24, priority: 'normal', linkToRecord: hasRecord || undefined } };
    case 'create_task_from_template':
      return { type, params: { templateVersionId: '', startOffsetDays: 0 } };
    case 'assign_member':
      return { type, params: { assignee: { kind: 'member', membershipId: null }, onlyIfUnassigned: true } };
    case 'add_checklist_item':
      return { type, params: { label: '', mandatory: false } };
    case 'add_tag':
      return { type, params: { tag: '' } };
    case 'set_field':
      return { type, params: { field: 'priority', value: 'high' } };
    case 'create_checkpoint':
      return { type, params: { label: '', dueInHours: 24 } };
    case 'notify':
      return { type, params: { recipients: [owner], title: hasRecord ? '{{trigger.label}}: {{entity.title}}' : '', message: '' } };
    case 'request_internal_approval':
      return { type, params: { approver: owner, title: hasRecord ? 'Approve: {{entity.title}}' : '', dueInHours: 48 } };
    case 'create_incident':
      return { type, params: { severity: 'medium', title: '' } };
  }
};

/** Starting draft for a blank rule once the catalog is known. */
export const blankDraft = (catalog: AutomationCatalog, ownerMembershipId: string): RuleDraft => {
  const t = catalog.triggers.find((x) => x.kind === 'event') ?? catalog.triggers[0]!;
  const first = (t.actions.includes('create_task') ? 'create_task' : t.actions[0]!) as ActionType;
  return {
    name: '',
    ownerMembershipId,
    scopeType: 'workspace',
    scopeId: null,
    config: { trigger: defaultTrigger(t), conditions: [], actions: [defaultAction(first, t)], quietHoursPolicy: 'respect' },
  };
};

export const draftOfRule = (r: AutomationRuleDetail): RuleDraft => ({
  name: r.name,
  ownerMembershipId: r.owner?.membershipId ?? null,
  scopeType: r.scope.type,
  scopeId: r.scope.id,
  config: r.currentVersion
    ? { trigger: r.currentVersion.trigger, conditions: r.currentVersion.conditions, actions: r.currentVersion.actions, quietHoursPolicy: r.currentVersion.quietHoursPolicy }
    : { trigger: { event: r.trigger.event }, conditions: [], actions: [], quietHoursPolicy: 'respect' },
});

/** Human sentence for a trigger including threshold or schedule. */
export const triggerSentence = (catalog: AutomationCatalog | undefined, trig: AutomationTriggerInput) => {
  const t = triggerOf(catalog, trig.event);
  const name = t?.label ?? label('automationTrigger', trig.event);
  if (t?.kind === 'deadline' && trig.thresholdHours !== undefined) return `${name} — ${t.thresholdLabel ?? 'threshold'}: ${trig.thresholdHours} h`;
  if (t?.kind === 'schedule' && trig.schedule) {
    const s = trig.schedule;
    const when = s.cadence === 'weekly' ? `every ${WEEKDAYS[(s.weekday ?? 1) - 1]}` : s.cadence === 'monthly' ? `on day ${s.monthDay ?? 1} of each month` : 'every day';
    return `${name} — ${when} at ${s.localTime} (workspace time)`;
  }
  return name;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const valueText = (f: FieldSpec | undefined, v: unknown): string => {
  if (v === null) return 'empty';
  if (Array.isArray(v)) return v.length === 1 ? valueText(f, v[0]) : `any of ${v.length} values`;
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'string' && UUID_RE.test(v)) return f?.type === 'member' ? 'the selected member' : 'the selected record';
  if (f?.type === 'datetime') return `${String(v)} h ago`;
  if (f?.type === 'enum' && typeof v === 'string') return label('automationValue', v);
  return `${String(v)}${f?.unit && f.unit !== 'hours' ? ` ${f.unit}` : f?.unit === 'hours' ? ' h' : ''}`;
};

/** "Hours overdue is at least 24 h" */
export const conditionSentence = (t: TriggerSpec | undefined, c: AutomationRuleConfig['conditions'][number]) => {
  const f = t?.fields.find((x) => x.key === c.field);
  if (c.value === null && (c.operator === 'equals' || c.operator === 'not_equals')) return `${f?.label ?? c.field} ${c.operator === 'equals' ? 'is empty' : 'is not empty'}`;
  const op = c.operator === 'elapsed_gte' ? 'was at least' : (OPERATOR_LABELS[c.operator] ?? c.operator);
  return `${f?.label ?? c.field} ${op} ${valueText(f, c.value)}`;
};

export const personText = (p: AutomationPersonRef | undefined) => (p ? (p.kind === 'member' ? 'a specific member' : label('automationPerson', p.kind).toLowerCase()) : 'nobody');

/** Short description of what an action does, for the flow diagram and lists. */
export const actionSentence = (catalog: AutomationCatalog | undefined, a: AutomationActionInput) => {
  const name = actionLabel(catalog, a.type);
  switch (a.type) {
    case 'create_task':
      return `${name}: “${a.params.title || '…'}” for ${personText(a.params.assignee ?? { kind: 'rule_owner' })}${a.params.dueInHours !== undefined ? `, due in ${a.params.dueInHours} h` : ''}`;
    case 'assign_member':
      return `${name}: ${personText(a.params.assignee)}${a.params.onlyIfUnassigned ? ' (only if unassigned)' : ''}`;
    case 'add_checklist_item':
      return `${name}: “${a.params.label || '…'}”${a.params.mandatory ? ' (mandatory)' : ''}`;
    case 'add_tag':
      return `${name}: ${a.params.tag || '…'}`;
    case 'set_field':
      return `${name}: ${label('automationValue', a.params.field)} → ${label('automationValue', a.params.value)}`;
    case 'create_checkpoint':
      return `${name}: “${a.params.label || '…'}” in ${a.params.dueInHours} h`;
    case 'notify':
      return `${name}: ${a.params.recipients.map(personText).join(', ')}`;
    case 'request_internal_approval':
      return `${name}: ${personText(a.params.approver)}`;
    case 'create_incident':
      return `${name}: ${label('automationValue', a.params.severity)} — “${a.params.title || '…'}”`;
    default:
      return name;
  }
};
