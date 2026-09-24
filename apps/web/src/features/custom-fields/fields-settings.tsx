'use client';
import { Plus, Trash } from '@phosphor-icons/react';
import { useEffect, useMemo, useState } from 'react';
import { customFieldEndpoints, type CustomFieldDefinition, type EndpointResponse } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { CUSTOM_FIELD_TYPES } from '@castlane/domain';
import {
  Badge,
  Banner,
  Button,
  Checkbox,
  DataTable,
  Dialog,
  Drawer,
  EmptyState,
  Field,
  IconButton,
  Input,
  Select,
  Switch,
  Toolbar,
  formatNumber,
  type Column,
} from '@castlane/ui';
import { ConflictDialog } from '@/components/common/conflict';
import { changedFields, pickChanged, useEditBase } from '@/lib/edit-base';
import { EntitySelect } from '@/components/common/entity-select';
import { QueryState } from '@/components/common/query-state';
import { useApiMutation, useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useCan, useWorkspace } from '@/lib/workspace-context';
import { slugKey } from '../templates/config-editors';

type FieldType = CustomFieldDefinition['type'];
type Option = CustomFieldDefinition['options'][number];
type Target = EndpointResponse<typeof customFieldEndpoints.targets>[number];
const INVALIDATE = ['customFields.list', 'customFields.targets', 'customFields.get', 'customFields.values'];
const hasOptions = (t: FieldType) => t === 'single_select' || t === 'multi_select';

const fieldKeyFrom = (name: string, taken: string[]) => {
  let k = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 36);
  if (!/^[a-z]/.test(k)) k = `f_${k}`;
  if (k.length < 2) k = `${k}_x`;
  let out = k;
  let n = 2;
  while (taken.includes(out)) out = `${k}_${n++}`;
  return out;
};

/** Custom field definitions per entity type (max 30 active each); `?open=` opens one for editing. */
export const CustomFieldsSettings = ({ openId, onOpen }: { openId: string | null; onOpen: (id: string | null) => void }) => {
  const { workspace, user } = useWorkspace();
  const can = useCan();
  const manage = can('custom-fields.manage');
  const params = { workspaceId: workspace.id };
  const targets = useApiQuery(customFieldEndpoints.targets, { params });
  const [entityType, setEntityType] = useState<string | null>(null);
  const [archived, setArchived] = useState(false);
  const [adding, setAdding] = useState(false);
  const current = entityType ?? targets.data?.[0]?.entityType ?? null;
  const target = targets.data?.find((x) => x.entityType === current);
  const fields = useApiQuery(customFieldEndpoints.list, { params, query: { entityType: current ?? undefined, includeArchived: archived || undefined } }, { enabled: !!current });
  const columns: Column<CustomFieldDefinition>[] = [
    {
      key: 'name',
      header: 'Field',
      sticky: true,
      minWidth: 220,
      cell: (f) => (
        <span className="flex flex-col">
          <span className="font-medium text-fg">{f.name}</span>
          <code className="font-mono text-[12px] text-fg-2">{f.key}</code>
        </span>
      ),
    },
    { key: 'type', header: 'Type', minWidth: 130, cell: (f) => label('customFieldType', f.type) },
    { key: 'scope', header: 'Applies To', minWidth: 160, cell: (f) => f.scopeProject?.name ?? 'All projects' },
    { key: 'required', header: 'Required At Stage', minWidth: 150, cell: (f) => (f.requiredAtStage ? label('stage', f.requiredAtStage) : '—') },
    { key: 'values', header: 'Values', align: 'right', minWidth: 80, cell: (f) => formatNumber(f.valueCount) },
    {
      key: 'status',
      header: 'Status',
      minWidth: 120,
      cell: (f) => (f.archivedAt ? <Badge>{f.replacedById ? 'Replaced' : 'Archived'}</Badge> : <Badge tone="success">Active</Badge>),
    },
  ];
  return (
    <div className="flex flex-col gap-4">
      <p className="max-w-[760px] text-[13px] text-fg-2">
        Custom fields add information to records. They never change statuses, permissions or finance totals. Changing a field’s type creates a replacement field so no history is lost.
      </p>
      <QueryState query={targets}>
        <Toolbar>
          <div className="w-full sm:w-[220px]">
            <Select aria-label="Record type" value={current} onChange={(v) => setEntityType(v)} options={(targets.data ?? []).map((x) => ({ value: x.entityType, label: x.label, description: `${x.activeFields} of ${x.maxActiveFields} fields` }))} />
          </div>
          <Switch label="Show archived fields" checked={archived} onCheckedChange={setArchived} />
          {manage && target ? (
            <Button className="ml-auto" variant="primary" icon={<Plus size={14} weight="bold" />} disabled={target.activeFields >= target.maxActiveFields} onClick={() => setAdding(true)}>
              Add Field
            </Button>
          ) : null}
        </Toolbar>
        {target && target.activeFields >= target.maxActiveFields ? <Banner tone="warning">{target.label} already has {target.maxActiveFields} active fields. Archive one before adding another.</Banner> : null}
        <QueryState query={fields}>
          <DataTable
            caption="Custom fields"
            rows={fields.data ?? []}
            columns={columns}
            getRowId={(f) => f.id}
            density={user.density}
            onRowClick={(f) => onOpen(f.id)}
            selectedRowId={openId}
            empty={<EmptyState title={`No custom fields for ${target?.label.toLowerCase() ?? 'this type'}`} description="Add a field to capture information your team tracks that the standard form does not cover." />}
          />
        </QueryState>
      </QueryState>
      {adding && target ? <FieldDrawer target={target} taken={(fields.data ?? []).map((f) => f.key)} onClose={() => setAdding(false)} /> : null}
      {openId ? <EditFieldLoader fieldId={openId} targets={targets.data ?? []} onClose={() => onOpen(null)} /> : null}
    </div>
  );
};

const OptionsEditor = ({ value, onChange, readOnly }: { value: Option[]; onChange: (v: Option[]) => void; readOnly?: boolean }) => {
  const active = value.filter((o) => !o.archivedAt);
  const archivedOpts = value.filter((o) => o.archivedAt);
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-[13px] font-semibold text-fg">Options</legend>
      {active.map((o) => (
        <div key={o.key} className="flex items-center gap-2">
          <Input
            className="flex-1"
            aria-label={`Option ${o.key}`}
            value={o.label}
            readOnly={readOnly}
            maxLength={120}
            onChange={(e) => onChange(value.map((x) => (x.key === o.key ? { ...x, label: e.target.value } : x)))}
          />
          {!readOnly ? <IconButton label={`Remove option ${o.label || o.key}`} icon={<Trash size={14} />} onClick={() => onChange(value.filter((x) => x.key !== o.key))} /> : null}
        </div>
      ))}
      {!readOnly ? (
        <Button
          size="sm"
          variant="ghost"
          className="w-fit"
          icon={<Plus size={14} />}
          disabled={value.length >= 100}
          onClick={() => onChange([...value, { key: slugKey(`option-${value.length + 1}`, value.map((x) => x.key)), label: '' }])}
        >
          Add Option
        </Button>
      ) : null}
      {archivedOpts.length ? <p className="text-[12px] text-fg-2">Archived options (kept on existing records): {archivedOpts.map((o) => o.label).join(', ')}</p> : null}
      {!readOnly ? <p className="text-[12px] text-fg-2">Removing an option archives it: records that use it keep the label.</p> : null}
    </fieldset>
  );
};

/** Add Field (no `field`) or edit an existing definition. */
const FieldDrawer = ({ target, taken, field, onClose }: { target: Target; taken: string[]; field?: CustomFieldDefinition; onClose: () => void }) => {
  const { workspace } = useWorkspace();
  const can = useCan();
  const manage = can('custom-fields.manage') && !field?.archivedAt;
  const [name, setName] = useState(field?.name ?? '');
  const [key, setKey] = useState(field?.key ?? '');
  const [keyTouched, setKeyTouched] = useState(false);
  const [type, setType] = useState<FieldType>(field?.type ?? 'short_text');
  const [options, setOptions] = useState<Option[]>(field?.options ?? []);
  const [requiredAtStage, setRequired] = useState<string | null>(field?.requiredAtStage ?? null);
  const [unit, setUnit] = useState(field?.unit ?? '');
  const [precision, setPrecision] = useState<string>(field?.precision !== null && field?.precision !== undefined ? String(field.precision) : '');
  const [scopeProjectId, setScope] = useState<string | null>(field?.scopeProject?.id ?? null);
  const [error, setError] = useState<string | null>(null);
  // Edited against the definition as the drawer opened; live updates no longer remount it (T162).
  const edit = useEditBase(field, {
    onReload: (x) => {
      setName(x.name);
      setOptions(x.options);
      setRequired(x.requiredAtStage);
      setUnit(x.unit ?? '');
      setPrecision(x.precision !== null && x.precision !== undefined ? String(x.precision) : '');
      setScope(x.scopeProject?.id ?? null);
    },
  });
  const s = edit.start ?? field;
  const [dialog, setDialog] = useState<null | 'archive' | 'replace'>(null);
  const create = useApiMutation(customFieldEndpoints.create, { invalidate: INVALIDATE, silentErrors: true, successMessage: 'Field added' });
  const update = useApiMutation(customFieldEndpoints.update, { invalidate: INVALIDATE, silentErrors: true, successMessage: 'Field updated' });
  useEffect(() => {
    if (!field && !keyTouched) setKey(name ? fieldKeyFrom(name, taken) : '');
  }, [name, field, keyTouched, taken]);
  const cleanOptions = options.filter((o) => o.label.trim()).map((o) => ({ ...o, label: o.label.trim() }));
  const body = {
    name: name.trim(),
    options: hasOptions(type) ? cleanOptions : undefined,
    requiredAtStage,
    unit: type === 'number' ? unit.trim() || null : undefined,
    precision: type === 'number' && precision !== '' ? Number(precision) : type === 'number' ? null : undefined,
    scopeProjectId,
  };
  const dirty = s ? JSON.stringify({ n: s.name, o: s.options, r: s.requiredAtStage, u: s.unit ?? '', p: s.precision ?? '', s: s.scopeProject?.id ?? null }) !== JSON.stringify({ n: name, o: options, r: requiredAtStage, u: unit, p: precision === '' ? '' : Number(precision), s: scopeProjectId }) : !!name;
  const valid = name.trim().length >= 2 && (!!field || /^[a-z][a-z0-9_]{1,39}$/.test(key)) && (!hasOptions(type) || cleanOptions.filter((o) => !o.archivedAt).length > 0);
  const submit = async () => {
    setError(null);
    try {
      if (field && s) {
        const before = {
          name: s.name,
          options: hasOptions(s.type) ? s.options : undefined,
          requiredAtStage: s.requiredAtStage,
          unit: s.type === 'number' ? s.unit || null : undefined,
          precision: s.type === 'number' ? (s.precision ?? null) : undefined,
          scopeProjectId: s.scopeProject?.id ?? null,
        };
        await update.run({ params: { workspaceId: workspace.id, fieldId: field.id }, body: pickChanged(body, changedFields(before, body)) }, { ifMatch: edit.version });
      }
      else await create.run({ params: { workspaceId: workspace.id }, body: { ...body, entityType: target.entityType, key, type } });
      onClose();
    } catch (e) {
      if (!edit.catchConflict(e)) setError(isApiError(e) ? (e.fieldErrors[0]?.message ?? e.message) : 'Could not save the field.');
    }
  };
  return (
    <Drawer
      open
      onOpenChange={(o) => !o && onClose()}
      title={field ? field.name : `Add Field to ${target.label}`}
      description={field ? `${label('customFieldType', field.type)} · ${formatNumber(field.valueCount)} stored value${field.valueCount === 1 ? '' : 's'}` : 'Fields appear on every matching record’s Custom Fields panel.'}
      dirty={dirty}
      footer={
        manage ? (
          <>
            {field ? (
              <>
                <Button variant="danger-secondary" className="mr-auto" onClick={() => setDialog('archive')}>
                  Archive Field
                </Button>
                <Button onClick={() => setDialog('replace')}>Change Type</Button>
              </>
            ) : null}
            <Button onClick={onClose} disabled={create.isPending || update.isPending}>
              Cancel
            </Button>
            <Button variant="primary" loading={create.isPending || update.isPending} disabled={!valid || (!!field && !dirty)} onClick={() => void submit()}>
              {field ? 'Save Changes' : 'Add Field'}
            </Button>
          </>
        ) : null
      }
    >
      <div className="flex flex-col gap-4">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        {field?.archivedAt ? <Banner tone="info">{field.replacedById ? 'This field was replaced by a field of another type.' : `Archived${field.archiveReason ? `: ${field.archiveReason}` : ''}.`} Stored values remain visible in history.</Banner> : null}
        <Field label="Name" required>
          <Input value={name} readOnly={!manage} onChange={(e) => setName(e.target.value)} maxLength={120} />
        </Field>
        <Field label="Key" required={!field} helper={field ? 'Keys never change.' : 'Used in imports, exports and the API.'}>
          <Input
            value={key}
            readOnly={!!field || !manage}
            spellCheck={false}
            maxLength={40}
            onChange={(e) => {
              setKeyTouched(true);
              setKey(e.target.value.toLowerCase());
            }}
          />
        </Field>
        <Field label="Type" required helper={field ? 'Use Change Type to switch; values are migrated after a preview.' : undefined}>
          <Select value={type} disabled={!!field || !manage} onChange={(v) => v && setType(v)} options={CUSTOM_FIELD_TYPES.map((t) => ({ value: t, label: label('customFieldType', t) }))} />
        </Field>
        {hasOptions(type) ? <OptionsEditor value={options} onChange={setOptions} readOnly={!manage} /> : null}
        {type === 'number' ? (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Unit">
              <Input value={unit} readOnly={!manage} maxLength={20} onChange={(e) => setUnit(e.target.value)} placeholder="e.g. min, %" />
            </Field>
            <Field label="Decimal Places">
              <Select value={precision === '' ? null : precision} disabled={!manage} clearable onChange={(v) => setPrecision(v ?? '')} placeholder="Any" options={['0', '1', '2', '3', '4', '5', '6'].map((p) => ({ value: p, label: p }))} />
            </Field>
          </div>
        ) : null}
        <Field label="Required At Stage" helper="Records cannot move to this stage (or later) until the field is filled.">
          <Select value={requiredAtStage} disabled={!manage || !target.stages.length} clearable onChange={setRequired} placeholder="Never required" options={target.stages.map((s) => ({ value: s, label: label('stage', s) }))} />
        </Field>
        {target.entityType !== 'account' ? (
          <Field label="Applies To" helper="Limit the field to one project, or leave empty for all projects.">
            <EntitySelect type="project" value={scopeProjectId} disabled={!manage} clearable onChange={setScope} placeholder="All projects" />
          </Field>
        ) : null}
      </div>
      {field && dialog === 'archive' ? <ArchiveFieldDialog field={field} onClose={(done) => (done ? onClose() : setDialog(null))} /> : null}
      {field && dialog === 'replace' ? <ReplaceFieldDialog field={field} onClose={(done) => (done ? onClose() : setDialog(null))} /> : null}
      <ConflictDialog {...edit.conflictDialog} />
    </Drawer>
  );
};

const EditFieldLoader = ({ fieldId, targets, onClose }: { fieldId: string; targets: Target[]; onClose: () => void }) => {
  const { workspace } = useWorkspace();
  const q = useApiQuery(customFieldEndpoints.get, { params: { workspaceId: workspace.id, fieldId } });
  const f = q.data;
  const target = f ? (targets.find((t) => t.entityType === f.entityType) ?? { entityType: f.entityType, label: f.entityType, stages: [], activeFields: 0, maxActiveFields: 30 }) : null;
  if (!f || !target) return null;
  return <FieldDrawer key={f.id} target={target} taken={[]} field={f} onClose={onClose} />;
};

const ArchiveFieldDialog = ({ field, onClose }: { field: CustomFieldDefinition; onClose: (done: boolean) => void }) => {
  const { workspace } = useWorkspace();
  const [reason, setReason] = useState('');
  const edit = useEditBase(field);
  const archive = useApiMutation(customFieldEndpoints.archive, { invalidate: INVALIDATE, successMessage: 'Field archived' });
  return (
    <>
      <Dialog
        open
        size="small"
        onOpenChange={(o) => !o && onClose(false)}
        title={`Archive “${field.name}”?`}
        description={`The field disappears from forms. ${formatNumber(field.valueCount)} stored value${field.valueCount === 1 ? '' : 's'} and their labels are kept.`}
        footer={
          <>
            <Button onClick={() => onClose(false)}>Cancel</Button>
            <Button
              variant="danger"
              loading={archive.isPending}
              disabled={reason.trim().length < 3}
              onClick={() => void archive.run({ params: { workspaceId: workspace.id, fieldId: field.id }, body: { reason: reason.trim() } }, { ifMatch: edit.version }).then(() => onClose(true), (e: unknown) => edit.catchConflict(e))}
            >
              Archive Field
            </Button>
          </>
        }
      >
        <Field label="Reason" required>
          <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
        </Field>
      </Dialog>
      <ConflictDialog {...edit.conflictDialog} />
    </>
  );
};

/** Change Type = replace: preview how many values convert, then create the new field and archive the old one. */
const ReplaceFieldDialog = ({ field, onClose }: { field: CustomFieldDefinition; onClose: (done: boolean) => void }) => {
  const { workspace } = useWorkspace();
  const params = { workspaceId: workspace.id, fieldId: field.id };
  const [type, setType] = useState<FieldType>(field.type === 'short_text' ? 'long_text' : 'short_text');
  const [options, setOptions] = useState<Option[]>(field.options.filter((o) => !o.archivedAt));
  const [migrate, setMigrate] = useState(true);
  const [preview, setPreview] = useState<EndpointResponse<typeof customFieldEndpoints.replacePreview> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const edit = useEditBase(field);
  const previewRun = useApiMutation(customFieldEndpoints.replacePreview, { silentErrors: true });
  const replace = useApiMutation(customFieldEndpoints.replace, { invalidate: INVALIDATE, silentErrors: true, successMessage: 'Field replaced' });
  const cleanOptions = useMemo(() => options.filter((o) => o.label.trim()), [options]);
  useEffect(() => {
    setPreview(null);
    setError(null);
    const h = setTimeout(() => {
      previewRun
        .run({ params, body: { type, options: hasOptions(type) ? cleanOptions : undefined } })
        .then(setPreview)
        .catch((e) => setError(isApiError(e) ? e.message : 'Preview failed.'));
    }, 300);
    return () => clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, JSON.stringify(cleanOptions)]);
  const submit = async () => {
    setError(null);
    try {
      await replace.run({ params, body: { type, options: hasOptions(type) ? cleanOptions : undefined, migrateValues: migrate } }, { ifMatch: edit.version });
      onClose(true);
    } catch (e) {
      if (!edit.catchConflict(e)) setError(isApiError(e) ? (e.fieldErrors[0]?.message ?? e.message) : 'Could not replace the field.');
    }
  };
  return (
    <>
      <Dialog
        open
        onOpenChange={(o) => !o && onClose(false)}
        title={`Change type of “${field.name}”`}
        description="A new field replaces this one; the old field is archived with all its values, so nothing is lost."
        footer={
          <>
            <Button onClick={() => onClose(false)}>Cancel</Button>
            <Button variant="primary" loading={replace.isPending} disabled={!preview || type === field.type || (hasOptions(type) && !cleanOptions.length)} onClick={() => void submit()}>
              Replace Field
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {error ? <Banner tone="danger">{error}</Banner> : null}
          <Field label="New Type" required>
            <Select value={type} onChange={(v) => v && setType(v)} options={CUSTOM_FIELD_TYPES.filter((t) => t !== field.type).map((t) => ({ value: t, label: label('customFieldType', t) }))} />
          </Field>
          {hasOptions(type) ? <OptionsEditor value={options} onChange={setOptions} /> : null}
          {preview ? (
            <div className="flex flex-col gap-2 rounded-[10px] border border-line p-3 text-[13px]">
              <p className="text-fg">
                {formatNumber(preview.convertible)} of {formatNumber(preview.total)} stored value{preview.total === 1 ? '' : 's'} can be converted
                {preview.notConvertible ? `; ${formatNumber(preview.notConvertible)} cannot and stay only on the archived field` : ''}.
              </p>
              {preview.samples.length ? (
                <ul className="flex flex-col gap-1 text-fg-2">
                  {preview.samples.map((s, i) => (
                    <li key={i}>
                      “{s.from}” → {s.to === null ? <span className="text-danger">not convertible</span> : `“${s.to}”`}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : (
            <p className="text-[13px] text-fg-2">{previewRun.isPending ? 'Checking stored values…' : null}</p>
          )}
          <Checkbox label="Copy convertible values to the new field" description="Without this, the new field starts empty." checked={migrate} onCheckedChange={setMigrate} />
        </div>
      </Dialog>
      <ConflictDialog {...edit.conflictDialog} />
    </>
  );
};
