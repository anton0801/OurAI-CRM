'use client';
import { ArrowDown, ArrowUp, CheckCircle, Flask, Plus, Trash } from '@phosphor-icons/react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  automationEndpoints,
  peopleEndpoints,
  templateEndpoints,
  type AutomationActionInput,
  type AutomationPersonRef,
  type AutomationRuleConfig,
  type AutomationRuleDetail,
  type LookupType,
} from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { AUTOMATION_LIMITS, AUTOMATION_PERSON_KINDS, AUTOMATION_SCOPE_TYPES, INCIDENT_SEVERITIES, OPERATORS_BY_FIELD_TYPE, OPERATOR_LABELS, TASK_PRIORITIES } from '@castlane/domain';
import { Banner, Button, Field, IconButton, Input, MultiSelect, Panel, RadioGroup, Select, Switch, Textarea } from '@castlane/ui';
import { ConflictDialog } from '@/components/common/conflict';
import { EntitySelect, MultiEntitySelect } from '@/components/common/entity-select';
import { DirectionSelect, MemberSelect, MultiMemberSelect } from '@/components/common/pickers';
import { useApiMutation, useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useUnsavedChangesGuard } from '@/lib/unsaved';
import { useWorkspace } from '@/lib/workspace-context';
import { RuleFlowDiagram } from './flow-diagram';
import { WEEKDAYS } from './labels';
import { actionLabel, defaultAction, defaultTrigger, triggerOf, useAutomationCatalog, type ActionType, type FieldSpec, type RuleDraft, type TriggerSpec } from './model';
import './labels';

type Condition = AutomationRuleConfig['conditions'][number];
type Errors = Record<string, string>;
type UiOperator = Condition['operator'] | 'is_empty' | 'is_not_empty';

const EMPTY_CAPABLE = new Set(['member', 'id', 'enum', 'tags', 'text']);

const uiOperator = (c: Condition): UiOperator => (c.value === null && c.operator === 'equals' ? 'is_empty' : c.value === null && c.operator === 'not_equals' ? 'is_not_empty' : c.operator);

const initialValue = (f: FieldSpec, op: Condition['operator']): Condition['value'] => (op === 'in' ? [] : f.type === 'boolean' ? true : '');

const toErrors = (list: { field: string; message: string }[]): Errors => {
  const out: Errors = {};
  for (const e of list) {
    const k = e.field.replace(/^body\./, '');
    out[k] ??= e.message;
  }
  return out;
};

/** Integer input where an empty box means "not set". */
const IntInput = ({ value, onChange, min, max, invalid, suffix, id }: { value: number | undefined; onChange: (v: number | undefined) => void; min?: number; max?: number; invalid?: boolean; suffix?: string; id?: string }) => (
  <span className="flex items-center gap-2">
    <Input
      id={id}
      type="number"
      inputMode="numeric"
      min={min}
      max={max}
      step={1}
      value={value ?? ''}
      aria-invalid={invalid || undefined}
      onChange={(e) => onChange(e.target.value === '' ? undefined : Math.trunc(Number(e.target.value)))}
    />
    {suffix ? <span className="shrink-0 text-[13px] text-fg-2">{suffix}</span> : null}
  </span>
);

/** Comma- or line-separated list kept as typed (so separators are not swallowed while typing). */
const ListInput = ({ value, onChange, multiline, placeholder }: { value: string[]; onChange: (v: string[]) => void; multiline?: boolean; placeholder?: string }) => {
  const [text, setText] = useState(value.join(multiline ? '\n' : ', '));
  const parse = (t: string) =>
    t
      .split(multiline ? /\n/ : /,/)
      .map((x) => x.trim())
      .filter(Boolean);
  return multiline ? (
    <Textarea
      value={text}
      placeholder={placeholder}
      onChange={(e) => {
        setText(e.target.value);
        onChange(parse(e.target.value));
      }}
    />
  ) : (
    <Input
      value={text}
      placeholder={placeholder}
      onChange={(e) => {
        setText(e.target.value);
        onChange(parse(e.target.value));
      }}
    />
  );
};

const PersonPicker = ({ value, onChange, withRecord, exclude = [], error }: { value: AutomationPersonRef; onChange: (v: AutomationPersonRef) => void; withRecord: boolean; exclude?: string[]; error?: string }) => (
  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
    <Select
      aria-label="Who"
      value={value.kind}
      onChange={(k) => onChange(k === 'member' ? { kind: 'member', membershipId: null } : { kind: (k ?? 'rule_owner') as AutomationPersonRef['kind'] })}
      options={AUTOMATION_PERSON_KINDS.filter((k) => (withRecord || (k !== 'entity_assignee' && k !== 'entity_owner')) && !exclude.includes(k)).map((k) => ({ value: k, label: label('automationPerson', k) }))}
    />
    {value.kind === 'member' ? <MemberSelect aria-invalid={!!error || undefined} placeholder="Choose a member" value={value.membershipId ?? null} onChange={(m) => onChange({ kind: 'member', membershipId: m })} /> : null}
  </div>
);

const TemplateVersionSelect = ({ value, onChange, invalid }: { value: string; onChange: (v: string) => void; invalid?: boolean }) => {
  const { workspace } = useWorkspace();
  const q = useApiQuery(templateEndpoints.list, { params: { workspaceId: workspace.id }, query: { kind: 'task' } }, { staleTime: 60_000 });
  const options = (q.data ?? []).filter((t) => t.publishedVersion && !t.disabledAt).map((t) => ({ value: t.publishedVersion!.id, label: `${t.name} · v${t.publishedVersion!.versionNo}`, description: t.description ?? undefined }));
  if (value && !options.some((o) => o.value === value)) options.unshift({ value, label: 'Pinned version (not the latest published)', description: undefined });
  return (
    <Select
      aria-invalid={invalid || undefined}
      value={value || null}
      onChange={(v) => onChange(v ?? '')}
      placeholder={q.isLoading ? 'Loading…' : 'Choose a published task template'}
      emptyText="No published task templates. Publish one in Settings → Templates."
      options={options}
    />
  );
};

const ConditionValueInput = ({ field, condition, onChange, invalid }: { field: FieldSpec; condition: Condition; onChange: (v: Condition['value']) => void; invalid: boolean }) => {
  const op = uiOperator(condition);
  if (op === 'is_empty' || op === 'is_not_empty') return null;
  const v = condition.value;
  const arr = Array.isArray(v) ? v : [];
  const str = typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
  const common = { 'aria-label': `${field.label} value`, 'aria-invalid': invalid || undefined };
  switch (field.type) {
    case 'enum': {
      const options = (field.options ?? []).map((o) => ({ value: o, label: label('automationValue', o) }));
      return op === 'in' ? <MultiSelect {...common} value={arr} onChange={onChange} options={options} placeholder="Choose values" /> : <Select {...common} value={str || null} onChange={(x) => onChange(x ?? '')} options={options} placeholder="Choose a value" />;
    }
    case 'member':
      return op === 'in' ? <MultiMemberSelect {...common} value={arr} onChange={onChange} placeholder="Choose members" /> : <MemberSelect {...common} value={str || null} onChange={(x) => onChange(x ?? '')} placeholder="Choose a member" />;
    case 'id':
      if (field.lookup)
        return op === 'in' ? (
          <MultiEntitySelect {...common} type={field.lookup as LookupType} value={arr} onChange={onChange} placeholder="Choose records" />
        ) : (
          <EntitySelect {...common} type={field.lookup as LookupType} value={str || null} onChange={(x) => onChange(x ?? '')} placeholder="Choose a record" />
        );
      return <Input {...common} value={str} onChange={(e) => onChange(e.target.value)} />;
    case 'tags':
    case 'text':
      return op === 'in' ? <ListInput value={arr} onChange={onChange} placeholder="Comma-separated values" /> : <Input {...common} value={str} maxLength={200} onChange={(e) => onChange(e.target.value)} />;
    case 'boolean':
      return (
        <Select
          {...common}
          value={v === false ? 'false' : 'true'}
          onChange={(x) => onChange(x !== 'false')}
          options={[
            { value: 'true', label: 'Yes' },
            { value: 'false', label: 'No' },
          ]}
        />
      );
    case 'number':
    case 'datetime':
      return (
        <span className="flex items-center gap-2">
          <Input {...common} inputMode="decimal" value={str} onChange={(e) => onChange(e.target.value.trim())} />
          <span className="shrink-0 text-[13px] text-fg-2">{field.type === 'datetime' ? 'hours ago' : field.unit === 'hours' ? 'h' : (field.unit ?? '')}</span>
        </span>
      );
  }
};

const ConditionRow = ({ t, condition, index, errors, onChange, onRemove }: { t: TriggerSpec; condition: Condition; index: number; errors: Errors; onChange: (c: Condition) => void; onRemove: () => void }) => {
  const field = t.fields.find((f) => f.key === condition.field);
  const at = `config.conditions.${index}`;
  const ops: UiOperator[] = field ? [...OPERATORS_BY_FIELD_TYPE[field.type], ...(EMPTY_CAPABLE.has(field.type) ? (['is_empty', 'is_not_empty'] as const) : [])] : [];
  const opLabel = (o: UiOperator) => (o === 'is_empty' ? 'is empty' : o === 'is_not_empty' ? 'is not empty' : o === 'elapsed_gte' ? 'was at least' : OPERATOR_LABELS[o]);
  const error = errors[`${at}.field`] ?? errors[`${at}.operator`] ?? errors[`${at}.value`] ?? errors[at];
  return (
    <li className="flex flex-col gap-1.5 rounded-[10px] border border-line p-3">
      <div className="grid grid-cols-1 items-start gap-2 md:grid-cols-[minmax(0,1.2fr)_minmax(0,0.9fr)_minmax(0,1.4fr)_auto]">
        <Select
          aria-label={`Condition ${index + 1} field`}
          aria-invalid={!field || undefined}
          value={field ? condition.field : null}
          placeholder={field ? undefined : 'Not available for this trigger'}
          onChange={(k) => {
            const f = t.fields.find((x) => x.key === k);
            if (!f) return;
            const op = OPERATORS_BY_FIELD_TYPE[f.type][0]!;
            onChange({ field: f.key, operator: op, value: initialValue(f, op) });
          }}
          options={t.fields.map((f) => ({ value: f.key, label: f.label }))}
        />
        <Select
          aria-label={`Condition ${index + 1} operator`}
          value={field ? uiOperator(condition) : null}
          disabled={!field}
          onChange={(o) => {
            if (!field || !o) return;
            if (o === 'is_empty') onChange({ ...condition, operator: 'equals', value: null });
            else if (o === 'is_not_empty') onChange({ ...condition, operator: 'not_equals', value: null });
            else {
              const next = o as Condition['operator'];
              const keep = condition.value !== null && (next === 'in') === Array.isArray(condition.value);
              onChange({ field: condition.field, operator: next, value: keep ? condition.value : initialValue(field, next) });
            }
          }}
          options={ops.map((o) => ({ value: o, label: opLabel(o) }))}
        />
        <div className="min-w-0">{field ? <ConditionValueInput field={field} condition={condition} onChange={(value) => onChange({ ...condition, value })} invalid={!!errors[`${at}.value`]} /> : null}</div>
        <IconButton label={`Remove condition ${index + 1}`} icon={<Trash size={16} />} variant="ghost" onClick={onRemove} />
      </div>
      {error ? <p className="text-[12px] text-danger">{error}</p> : null}
    </li>
  );
};

/** Parameters of one action, by type (only allowed internal effects). */
const ActionParams = ({ action, t, at, errors, onChange, placeholders }: { action: AutomationActionInput; t: TriggerSpec; at: string; errors: Errors; onChange: (a: AutomationActionInput) => void; placeholders: string }) => {
  const e = (k: string) => errors[`${at}.params.${k}`] ?? errors[`${at}.params.${k}.membershipId`] ?? errors[`${at}.params.${k}.kind`];
  const withRecord = !!t.entityType;
  const textHelper = `Plain text. Placeholders: ${placeholders}.`;
  switch (action.type) {
    case 'create_task': {
      const p = action.params;
      const set = (patch: Partial<typeof p>) => onChange({ type: 'create_task', params: { ...p, ...patch } });
      return (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Field label="Task title" required error={e('title')} helper={textHelper}>
              <Input value={p.title} maxLength={200} onChange={(x) => set({ title: x.target.value })} />
            </Field>
          </div>
          <div className="sm:col-span-2">
            <Field label="Description" error={e('description')}>
              <Textarea value={p.description ?? ''} maxLength={2000} onChange={(x) => set({ description: x.target.value || undefined })} />
            </Field>
          </div>
          <Field label="Project" error={e('projectId')} helper={withRecord ? 'Empty = the project of the triggering record.' : 'Required for scheduled rules.'} required={!withRecord}>
            <EntitySelect type="project" value={p.projectId ?? null} onChange={(x) => set({ projectId: x })} clearable placeholder={withRecord ? 'Project of the record' : 'Choose a project'} />
          </Field>
          <Field label="Assignee" error={e('assignee')}>
            <PersonPicker value={p.assignee ?? { kind: 'rule_owner' }} onChange={(assignee) => set({ assignee })} withRecord={withRecord} error={e('assignee')} />
          </Field>
          <Field label="Due in" error={e('dueInHours')} helper="Hours after the run; empty = no due date.">
            <IntInput value={p.dueInHours} onChange={(dueInHours) => set({ dueInHours })} min={0} max={8760} suffix="hours" />
          </Field>
          <Field label="Priority" error={e('priority')}>
            <Select value={p.priority ?? 'normal'} onChange={(x) => set({ priority: (x ?? 'normal') as typeof p.priority })} options={TASK_PRIORITIES.map((x) => ({ value: x, label: label('taskPriority', x) }))} />
          </Field>
          <Field label="Checklist" error={e('checklist')} helper="One item per line (up to 20).">
            <ListInput multiline value={p.checklist ?? []} onChange={(checklist) => set({ checklist: checklist.length ? checklist : undefined })} />
          </Field>
          <Field label="Tags" error={e('tags')} helper="Comma-separated.">
            <ListInput value={p.tags ?? []} onChange={(tags) => set({ tags: tags.length ? tags : undefined })} />
          </Field>
          {withRecord ? (
            <div className="sm:col-span-2">
              <Switch label="Link the task to the triggering record" checked={p.linkToRecord ?? false} onCheckedChange={(v) => set({ linkToRecord: v || undefined })} />
            </div>
          ) : null}
        </div>
      );
    }
    case 'create_task_from_template': {
      const p = action.params;
      const set = (patch: Partial<typeof p>) => onChange({ type: 'create_task_from_template', params: { ...p, ...patch } });
      return (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Field label="Task template" required error={e('templateVersionId')} helper="The rule keeps this exact published version.">
              <TemplateVersionSelect value={p.templateVersionId} onChange={(templateVersionId) => set({ templateVersionId })} invalid={!!e('templateVersionId')} />
            </Field>
          </div>
          <Field label="Project" error={e('projectId')} helper={withRecord ? 'Empty = the project of the triggering record.' : 'Required for scheduled rules.'} required={!withRecord}>
            <EntitySelect type="project" value={p.projectId ?? null} onChange={(x) => set({ projectId: x })} clearable placeholder={withRecord ? 'Project of the record' : 'Choose a project'} />
          </Field>
          <Field label="Start after" error={e('startOffsetDays')}>
            <IntInput value={p.startOffsetDays} onChange={(startOffsetDays) => set({ startOffsetDays })} min={0} max={365} suffix="days" />
          </Field>
        </div>
      );
    }
    case 'assign_member': {
      const p = action.params;
      const set = (patch: Partial<typeof p>) => onChange({ type: 'assign_member', params: { ...p, ...patch } });
      return (
        <div className="flex flex-col gap-3">
          <Field label="Assign to" required error={e('assignee')}>
            <PersonPicker value={p.assignee} onChange={(assignee) => set({ assignee })} withRecord={withRecord} exclude={['entity_assignee']} error={e('assignee')} />
          </Field>
          <Switch label="Only when the record has no assignee" checked={p.onlyIfUnassigned ?? false} onCheckedChange={(v) => set({ onlyIfUnassigned: v || undefined })} />
        </div>
      );
    }
    case 'add_checklist_item': {
      const p = action.params;
      const set = (patch: Partial<typeof p>) => onChange({ type: 'add_checklist_item', params: { ...p, ...patch } });
      return (
        <div className="flex flex-col gap-3">
          <Field label="Checklist item" required error={e('label')}>
            <Input value={p.label} maxLength={200} onChange={(x) => set({ label: x.target.value })} />
          </Field>
          <Switch label="Mandatory before the task can be done" checked={p.mandatory ?? false} onCheckedChange={(v) => set({ mandatory: v || undefined })} />
        </div>
      );
    }
    case 'add_tag':
      return (
        <Field label="Tag" required error={e('tag')}>
          <Input value={action.params.tag} maxLength={40} onChange={(x) => onChange({ type: 'add_tag', params: { tag: x.target.value } })} />
        </Field>
      );
    case 'set_field':
      return (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Field" helper="Only allow-listed fields can be set.">
            <Input value="Priority" readOnly aria-readonly />
          </Field>
          <Field label="Value" required error={e('value')}>
            <Select
              value={action.params.value}
              onChange={(x) => onChange({ type: 'set_field', params: { field: 'priority', value: (x ?? 'normal') as (typeof TASK_PRIORITIES)[number] } })}
              options={TASK_PRIORITIES.map((x) => ({ value: x, label: label('taskPriority', x) }))}
            />
          </Field>
        </div>
      );
    case 'create_checkpoint': {
      const p = action.params;
      const set = (patch: Partial<typeof p>) => onChange({ type: 'create_checkpoint', params: { ...p, ...patch } });
      return (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="Checkpoint label" required error={e('label')} helper="E.g. 24h, 72h, 7d.">
            <Input value={p.label} maxLength={80} onChange={(x) => set({ label: x.target.value })} />
          </Field>
          <Field label="Due after" required error={e('dueInHours')}>
            <IntInput value={p.dueInHours} onChange={(v) => set({ dueInHours: v as number })} min={1} max={720} suffix="hours" />
          </Field>
          <Field label="Window" error={e('windowHours')} helper="Tolerance around the due time.">
            <IntInput value={p.windowHours} onChange={(windowHours) => set({ windowHours })} min={1} max={168} suffix="hours" />
          </Field>
        </div>
      );
    }
    case 'notify': {
      const p = action.params;
      const set = (patch: Partial<typeof p>) => onChange({ type: 'notify', params: { ...p, ...patch } });
      return (
        <div className="flex flex-col gap-3">
          <Field label="Recipients" required error={e('recipients')} helper="Internal Inbox notifications only; nothing is sent outside the workspace.">
            <ul className="flex flex-col gap-2">
              {p.recipients.map((r, k) => (
                <li key={k} className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <PersonPicker value={r} onChange={(nr) => set({ recipients: p.recipients.map((x, j) => (j === k ? nr : x)) })} withRecord={withRecord} error={e(`recipients.${k}`)} />
                    {e(`recipients.${k}`) ? <p className="mt-1 text-[12px] text-danger">{e(`recipients.${k}`)}</p> : null}
                  </div>
                  <IconButton label={`Remove recipient ${k + 1}`} icon={<Trash size={16} />} variant="ghost" disabled={p.recipients.length <= 1} onClick={() => set({ recipients: p.recipients.filter((_, j) => j !== k) })} />
                </li>
              ))}
            </ul>
          </Field>
          {p.recipients.length < 10 ? (
            <div>
              <Button size="sm" icon={<Plus size={12} />} onClick={() => set({ recipients: [...p.recipients, { kind: 'member', membershipId: null }] })}>
                Add Recipient
              </Button>
            </div>
          ) : null}
          <Field label="Title" required error={e('title')} helper={textHelper}>
            <Input value={p.title} maxLength={140} onChange={(x) => set({ title: x.target.value })} />
          </Field>
          <Field label="Message" error={e('message')}>
            <Textarea value={p.message ?? ''} maxLength={500} onChange={(x) => set({ message: x.target.value || undefined })} />
          </Field>
        </div>
      );
    }
    case 'request_internal_approval': {
      const p = action.params;
      const set = (patch: Partial<typeof p>) => onChange({ type: 'request_internal_approval', params: { ...p, ...patch } });
      return (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Field label="Approver" required error={e('approver')} helper="The approver gets a task; the rule never approves anything itself.">
              <PersonPicker value={p.approver} onChange={(approver) => set({ approver })} withRecord={withRecord} error={e('approver')} />
            </Field>
          </div>
          <div className="sm:col-span-2">
            <Field label="Title" required error={e('title')} helper={textHelper}>
              <Input value={p.title} maxLength={200} onChange={(x) => set({ title: x.target.value })} />
            </Field>
          </div>
          <Field label="Note" error={e('note')}>
            <Textarea value={p.note ?? ''} maxLength={2000} onChange={(x) => set({ note: x.target.value || undefined })} />
          </Field>
          <Field label="Due in" error={e('dueInHours')}>
            <IntInput value={p.dueInHours} onChange={(dueInHours) => set({ dueInHours })} min={0} max={8760} suffix="hours" />
          </Field>
        </div>
      );
    }
    case 'create_incident': {
      const p = action.params;
      const set = (patch: Partial<typeof p>) => onChange({ type: 'create_incident', params: { ...p, ...patch } });
      return (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[180px_minmax(0,1fr)]">
          <Field label="Severity" required error={e('severity')}>
            <Select value={p.severity} onChange={(x) => set({ severity: (x ?? 'medium') as typeof p.severity })} options={INCIDENT_SEVERITIES.map((x) => ({ value: x, label: label('incidentSeverity', x) }))} />
          </Field>
          <Field label="Title" required error={e('title')} helper={textHelper}>
            <Input value={p.title} maxLength={200} onChange={(x) => set({ title: x.target.value })} />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Description" error={e('description')}>
              <Textarea value={p.description ?? ''} maxLength={2000} onChange={(x) => set({ description: x.target.value || undefined })} />
            </Field>
          </div>
        </div>
      );
    }
  }
};

const Section = ({ title, description, children, actions }: { title: string; description?: string; children: ReactNode; actions?: ReactNode }) => (
  <Panel title={title} description={description} actions={actions}>
    {children}
  </Panel>
);

/**
 * S65 rule editor: name, owner, scope, trigger, conditions, actions and quiet hours, with Validate,
 * Dry Run (saved rules) and Save. Saving an existing rule creates a new version; an enabled rule
 * keeps running its enabled version until the new one is enabled.
 */
export const RuleEditor = ({
  initial,
  rule,
  readOnly = false,
  onSaved,
  onDirtyChange,
  onDryRun,
}: {
  initial: RuleDraft;
  rule?: AutomationRuleDetail;
  readOnly?: boolean;
  onSaved?: (r: AutomationRuleDetail) => void;
  onDirtyChange?: (dirty: boolean) => void;
  onDryRun?: (config: AutomationRuleConfig) => void;
}) => {
  const { workspace } = useWorkspace();
  const params = { workspaceId: workspace.id };
  const catalog = useAutomationCatalog();
  const people = useApiQuery(peopleEndpoints.lookup, { params, query: { limit: 200 } }, { staleTime: 60_000 });
  const [draft, setDraft] = useState<RuleDraft>(initial);
  const [errors, setErrors] = useState<Errors>({});
  const [validation, setValidation] = useState<{ ok: boolean; warnings: string[]; messages: string[] } | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(initial), [draft, initial]);
  const configDirty = useMemo(() => JSON.stringify(draft.config) !== JSON.stringify(initial.config), [draft.config, initial.config]);
  useUnsavedChangesGuard(dirty && !readOnly);
  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);

  const validate = useApiMutation(automationEndpoints.validate, { silentErrors: true });
  const create = useApiMutation(automationEndpoints.create, { invalidate: ['automations.'], successMessage: 'Rule saved as disabled', silentErrors: true });
  const update = useApiMutation(automationEndpoints.update, { invalidate: ['automations.'], successMessage: (r) => (r.hasUnpublishedChanges ? `Version ${r.currentVersionNo} saved — enable it to use it` : 'Rule saved'), silentErrors: true });

  const cat = catalog.data;
  const t = triggerOf(cat, draft.config.trigger.event);
  const setConfig = (patch: Partial<AutomationRuleConfig>) => setDraft((d) => ({ ...d, config: { ...d.config, ...patch } }));
  const body = () => ({ ...draft, scopeId: draft.scopeType === 'workspace' ? null : draft.scopeId });
  const placeholders = (cat?.placeholders ?? []).map((p) => `{{${p.key}}}`).join(', ');
  const ownerName = draft.ownerMembershipId ? (people.data?.find((p) => p.membershipId === draft.ownerMembershipId)?.displayName ?? rule?.owner?.displayName ?? 'The owner') : null;
  const scopeLabel = draft.scopeType === 'workspace' ? 'the whole workspace' : rule && rule.scope.type === draft.scopeType && rule.scope.id === draft.scopeId ? `${label('automationScope', draft.scopeType)} ${rule.scope.label}` : `the selected ${label('automationScope', draft.scopeType).toLowerCase()}`;

  const applyApiError = (e: unknown, fallback: string) => {
    if (isApiError(e) && e.code === 'VERSION_CONFLICT') {
      setConflict(true);
      return;
    }
    if (isApiError(e) && e.fieldErrors.length) {
      const map = toErrors(e.fieldErrors);
      setErrors(map);
      setValidation({ ok: false, warnings: [], messages: e.fieldErrors.map((x) => x.message) });
    }
    setSaveError(isApiError(e) ? e.message : fallback);
  };

  const runValidate = () => {
    setSaveError(null);
    void validate
      .run({ params, body: { ...body(), ruleId: rule?.id } })
      .then((r) => {
        setErrors(toErrors(r.errors));
        setValidation({ ok: r.ok, warnings: r.warnings, messages: r.errors.map((x) => x.message) });
      })
      .catch((e) => applyApiError(e, 'The rule could not be validated.'));
  };

  const save = () => {
    setSaveError(null);
    const p = rule ? update.run({ params: { ...params, ruleId: rule.id }, body: body() }, { ifMatch: rule.rowVersion }) : create.run({ params, body: body() });
    void p
      .then((r) => {
        setErrors({});
        setValidation(null);
        onSaved?.(r);
      })
      .catch((e) => applyApiError(e, 'The rule could not be saved.'));
  };

  const changeTrigger = (key: string | null) => {
    const next = triggerOf(cat, key ?? '');
    if (!next) return;
    setConfig({
      trigger: defaultTrigger(next),
      // Conditions over fields the new trigger does not have are shown as invalid rather than dropped silently.
      conditions: next.kind === 'schedule' ? [] : draft.config.conditions,
    });
  };

  const moveAction = (i: number, dir: -1 | 1) => {
    const list = [...draft.config.actions];
    const j = i + dir;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j]!, list[i]!];
    setConfig({ actions: list });
  };

  const pending = create.isPending || update.isPending;
  const unmapped = Object.entries(errors).filter(([k]) => !/^(name|ownerMembershipId|scopeId|config\.(trigger|conditions|actions)\.)/.test(k));
  const nextVersion = rule ? (rule.currentVersionNo ?? 0) + 1 : 1;

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
      <fieldset disabled={readOnly} className="flex min-w-0 flex-col gap-5">
        <legend className="sr-only">Rule</legend>
        {saveError ? <Banner tone="danger">{saveError}</Banner> : null}
        {readOnly ? <Banner tone="info">You can view this rule but not change it.</Banner> : null}
        <Section title="Rule">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <Field label="Name" required error={errors.name}>
                <Input value={draft.name} maxLength={120} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} />
              </Field>
            </div>
            <Field label="Owner" required error={errors.ownerMembershipId} helper="The rule acts with the owner’s current rights, limited to its scope.">
              <MemberSelect value={draft.ownerMembershipId} onChange={(v) => setDraft((d) => ({ ...d, ownerMembershipId: v }))} clearable placeholder="Needs Owner" />
            </Field>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <Field label="Scope" required>
                <Select
                  value={draft.scopeType}
                  onChange={(v) => setDraft((d) => ({ ...d, scopeType: (v ?? 'workspace') as RuleDraft['scopeType'], scopeId: null }))}
                  options={AUTOMATION_SCOPE_TYPES.map((s) => ({ value: s, label: label('automationScope', s) }))}
                />
              </Field>
              <Field label="Scope record" required={draft.scopeType !== 'workspace'} error={errors.scopeId}>
                {draft.scopeType === 'direction' ? (
                  <DirectionSelect value={draft.scopeId} onChange={(v) => setDraft((d) => ({ ...d, scopeId: v }))} />
                ) : draft.scopeType === 'project' ? (
                  <EntitySelect type="project" value={draft.scopeId} onChange={(v) => setDraft((d) => ({ ...d, scopeId: v }))} />
                ) : draft.scopeType === 'account' ? (
                  <EntitySelect type="account" value={draft.scopeId} onChange={(v) => setDraft((d) => ({ ...d, scopeId: v }))} />
                ) : (
                  <Input value="Whole workspace" readOnly aria-readonly />
                )}
              </Field>
            </div>
          </div>
        </Section>

        <Section title="Trigger" description="Events come from records changing; deadlines are checked every minute; schedules run at a local time.">
          <div className="flex flex-col gap-4">
            <Field label="When" required error={errors['config.trigger.event']} helper={t?.description}>
              <Select
                value={draft.config.trigger.event}
                onChange={changeTrigger}
                searchable
                placeholder={catalog.isLoading ? 'Loading…' : 'Choose a trigger'}
                options={(cat?.triggers ?? []).map((x) => ({ value: x.key, label: x.label, description: label('automationTriggerKind', x.kind) }))}
              />
            </Field>
            {t?.kind === 'deadline' ? (
              <Field label={t.thresholdLabel ?? 'Threshold'} required error={errors['config.trigger.thresholdHours']}>
                <IntInput value={draft.config.trigger.thresholdHours} onChange={(thresholdHours) => setConfig({ trigger: { ...draft.config.trigger, thresholdHours } })} min={0} max={AUTOMATION_LIMITS.maxThresholdHours} suffix="hours" />
              </Field>
            ) : null}
            {t?.kind === 'schedule' && draft.config.trigger.schedule ? (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <Field label="Time" required error={errors['config.trigger.schedule.localTime']} helper={`Workspace time zone (${workspace.timezone}).`}>
                  <Input type="time" value={draft.config.trigger.schedule.localTime} onChange={(e) => setConfig({ trigger: { ...draft.config.trigger, schedule: { ...draft.config.trigger.schedule!, localTime: e.target.value } } })} />
                </Field>
                {draft.config.trigger.schedule.cadence === 'weekly' ? (
                  <Field label="Day of week" required error={errors['config.trigger.schedule.weekday']}>
                    <Select
                      value={String(draft.config.trigger.schedule.weekday ?? 1)}
                      onChange={(v) => setConfig({ trigger: { ...draft.config.trigger, schedule: { ...draft.config.trigger.schedule!, weekday: Number(v ?? 1) } } })}
                      options={WEEKDAYS.map((d, i) => ({ value: String(i + 1), label: d }))}
                    />
                  </Field>
                ) : null}
                {draft.config.trigger.schedule.cadence === 'monthly' ? (
                  <Field label="Day of month" required error={errors['config.trigger.schedule.monthDay']} helper="Shorter months use their last day.">
                    <IntInput value={draft.config.trigger.schedule.monthDay} onChange={(monthDay) => setConfig({ trigger: { ...draft.config.trigger, schedule: { ...draft.config.trigger.schedule!, monthDay } } })} min={1} max={31} />
                  </Field>
                ) : null}
              </div>
            ) : null}
          </div>
        </Section>

        {t && t.kind !== 'schedule' ? (
          <Section
            title="Conditions"
            description="All conditions must match. Unknown numbers and dates never count as 0."
            actions={
              draft.config.conditions.length < AUTOMATION_LIMITS.maxConditions ? (
                <Button
                  size="sm"
                  icon={<Plus size={12} />}
                  onClick={() => {
                    const f = t.fields[0];
                    if (!f) return;
                    const op = OPERATORS_BY_FIELD_TYPE[f.type][0]!;
                    setConfig({ conditions: [...draft.config.conditions, { field: f.key, operator: op, value: initialValue(f, op) }] });
                  }}
                >
                  Add Condition
                </Button>
              ) : undefined
            }
          >
            {errors['config.conditions'] ? <p className="mb-2 text-[12px] text-danger">{errors['config.conditions']}</p> : null}
            {draft.config.conditions.length === 0 ? (
              <p className="text-[13px] text-fg-2">No conditions: the rule runs for every “{t.label}” event inside its scope.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {draft.config.conditions.map((c, i) => (
                  <ConditionRow
                    key={i}
                    t={t}
                    index={i}
                    condition={c}
                    errors={errors}
                    onChange={(nc) => setConfig({ conditions: draft.config.conditions.map((x, j) => (j === i ? nc : x)) })}
                    onRemove={() => setConfig({ conditions: draft.config.conditions.filter((_, j) => j !== i) })}
                  />
                ))}
              </ul>
            )}
          </Section>
        ) : null}

        <Section title="Actions" description="Internal effects only, executed in order. There is no code, SQL or webhook action.">
          <div className="flex flex-col gap-3">
            {errors['config.actions'] ? <p className="text-[12px] text-danger">{errors['config.actions']}</p> : null}
            <ol className="flex flex-col gap-3">
              {draft.config.actions.map((a, i) => {
                const at = `config.actions.${i}`;
                const allowed = !t || t.actions.includes(a.type);
                return (
                  <li key={i} className="rounded-[10px] border border-line p-3">
                    <div className="mb-3 flex flex-wrap items-center gap-2">
                      <span className="text-[13px] font-semibold tabular-nums text-fg-2">{i + 1}.</span>
                      <div className="w-full min-w-0 flex-1 sm:w-auto">
                        <Select
                          aria-label={`Action ${i + 1} type`}
                          aria-invalid={!allowed || !!errors[`${at}.type`] || undefined}
                          value={a.type}
                          onChange={(v) => v && v !== a.type && setConfig({ actions: draft.config.actions.map((x, j) => (j === i ? defaultAction(v as ActionType, t) : x)) })}
                          options={(cat?.actions ?? []).map((x) => ({ value: x.type, label: x.label, description: x.description, disabled: !!t && !t.actions.includes(x.type) }))}
                        />
                      </div>
                      <IconButton label={`Move action ${i + 1} up`} icon={<ArrowUp size={16} />} variant="ghost" disabled={i === 0} onClick={() => moveAction(i, -1)} />
                      <IconButton label={`Move action ${i + 1} down`} icon={<ArrowDown size={16} />} variant="ghost" disabled={i === draft.config.actions.length - 1} onClick={() => moveAction(i, 1)} />
                      <IconButton label={`Remove action ${i + 1}`} icon={<Trash size={16} />} variant="ghost" disabled={draft.config.actions.length <= 1} onClick={() => setConfig({ actions: draft.config.actions.filter((_, j) => j !== i) })} />
                    </div>
                    {!allowed || errors[`${at}.type`] ? <p className="mb-2 text-[12px] text-danger">{errors[`${at}.type`] ?? `${actionLabel(cat, a.type)} is not available for this trigger.`}</p> : null}
                    {t ? <ActionParams action={a} t={t} at={at} errors={errors} placeholders={placeholders} onChange={(na) => setConfig({ actions: draft.config.actions.map((x, j) => (j === i ? na : x)) })} /> : null}
                  </li>
                );
              })}
            </ol>
            {t && draft.config.actions.length < AUTOMATION_LIMITS.maxActions ? (
              <div>
                <Button
                  size="sm"
                  icon={<Plus size={12} />}
                  onClick={() => setConfig({ actions: [...draft.config.actions, defaultAction((t.actions.includes('notify') ? 'notify' : t.actions[0]!) as ActionType, t)] })}
                >
                  Add Action
                </Button>
              </div>
            ) : null}
          </div>
        </Section>

        <Section title="Notifications" description="How Inbox notifications and mail from this rule treat each recipient’s quiet hours.">
          <RadioGroup
            label="Quiet hours policy"
            value={draft.config.quietHoursPolicy}
            onValueChange={(v) => setConfig({ quietHoursPolicy: v as AutomationRuleConfig['quietHoursPolicy'] })}
            options={[
              { value: 'respect', label: label('automationQuietHours', 'respect'), description: 'Mail waits until quiet hours end; the Inbox entry appears immediately.' },
              { value: 'ignore_for_inbox', label: label('automationQuietHours', 'ignore_for_inbox'), description: 'Only an Inbox entry is created — no mail — so nobody is disturbed.' },
            ]}
          />
        </Section>
      </fieldset>

      <aside className="flex min-w-0 flex-col gap-5 lg:sticky lg:top-4 lg:self-start">
        <Panel title="Rule Flow">
          <RuleFlowDiagram draft={draft} catalog={cat} ownerName={ownerName} scopeLabel={scopeLabel} />
        </Panel>
        {validation ? (
          <Panel title="Validation">
            <div className="flex flex-col gap-2 text-[13px]">
              {validation.ok ? (
                <p className="flex items-center gap-1.5 text-primary">
                  <CheckCircle size={16} weight="fill" aria-hidden /> The rule is valid{validation.warnings.length ? ', with warnings.' : '.'}
                </p>
              ) : (
                <>
                  <p className="text-danger">Fix these before saving or enabling:</p>
                  <ul className="list-disc pl-5 text-danger">
                    {[...new Set(validation.messages)].map((m) => (
                      <li key={m}>{m}</li>
                    ))}
                  </ul>
                </>
              )}
              {validation.warnings.length ? (
                <ul className="list-disc pl-5 text-warning">
                  {validation.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              ) : null}
              {unmapped.length && validation.ok === false ? <p className="text-fg-2">Some problems refer to settings not shown above; see the list.</p> : null}
            </div>
          </Panel>
        ) : null}
        {!readOnly ? (
          <div className="flex flex-col gap-2 rounded-[12px] border border-line bg-surface p-4">
            <p className="text-[13px] text-fg-2">
              {rule
                ? dirty && !configDirty
                  ? 'Name, owner and scope changes apply without a new version; owner and scope are re-checked.'
                  : dirty
                  ? rule.enabledVersionNo
                    ? `Saving creates version ${nextVersion}. The rule keeps running version ${rule.enabledVersionNo} until you enable the new one.`
                    : `Saving creates version ${nextVersion}. The rule stays disabled.`
                  : 'No unsaved changes.'
                : 'New rules are saved disabled. Validate and try a Dry Run before enabling.'}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button onClick={runValidate} loading={validate.isPending} disabled={!cat}>
                Validate
              </Button>
              {onDryRun ? (
                <Button icon={<Flask size={14} />} onClick={() => onDryRun(draft.config)}>
                  Dry Run
                </Button>
              ) : null}
              {rule && dirty ? (
                <Button
                  variant="ghost"
                  onClick={() => {
                    setDraft(initial);
                    setErrors({});
                    setValidation(null);
                  }}
                >
                  Discard Changes
                </Button>
              ) : null}
              <Button variant="primary" loading={pending} disabled={!cat || (!!rule && !dirty)} onClick={save}>
                {rule ? (configDirty ? 'Save New Version' : 'Save Changes') : 'Save Disabled'}
              </Button>
            </div>
          </div>
        ) : null}
      </aside>
      <ConflictDialog open={conflict} onOpenChange={setConflict} onReload={() => window.location.reload()} />
    </div>
  );
};
