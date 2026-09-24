'use client';
import { PencilSimple, WarningCircle } from '@phosphor-icons/react';
import { useState } from 'react';
import { customFieldEndpoints, type CustomFieldValueView } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { DateTime, zonedDateTimeToUtc } from '@castlane/domain';
import { Badge, Banner, Button, Checkbox, DateInput, DateTimeInput, Field, Input, MultiSelect, Panel, Select, Textarea, cn } from '@castlane/ui';
import { ConflictDialog } from '@/components/common/conflict';
import { MemberSelect } from '@/components/common/pickers';
import { useApiMutation, useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useWorkspace } from '@/lib/workspace-context';

type Draft = Record<string, unknown>;

const toLocalInput = (iso: unknown, zone: string) => (typeof iso === 'string' && iso ? DateTime.fromISO(iso, { zone }).toFormat("yyyy-MM-dd'T'HH:mm") : '');
const fromLocalInput = (local: string, zone: string) => {
  const [d, t] = local.split('T');
  return d && t ? zonedDateTimeToUtc(d, t.slice(0, 5), zone).utc.toISOString() : null;
};
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

const ValueInput = ({ f, value, onChange, zone, error }: { f: CustomFieldValueView; value: unknown; onChange: (v: unknown) => void; zone: string; error?: string }) => {
  const d = f.definition;
  const activeOptions = d.options.filter((o) => !o.archivedAt || (Array.isArray(value) ? value.includes(o.key) : value === o.key));
  const optionList = activeOptions.map((o) => ({ value: o.key, label: o.archivedAt ? `${o.label} (archived)` : o.label, disabled: !!o.archivedAt }));
  const helper = f.needsCompletion && f.definition.requiredAtStage ? `Needed before ${label('stage', f.definition.requiredAtStage)}.` : d.unit ? `Unit: ${d.unit}` : undefined;
  const control = (() => {
    switch (d.type) {
      case 'long_text':
        return <Textarea value={(value as string | null) ?? ''} rows={3} maxLength={4000} onChange={(e) => onChange(e.target.value || null)} />;
      case 'number':
        return <Input inputMode="decimal" value={(value as string | null) ?? ''} onChange={(e) => onChange(e.target.value.replace(',', '.').trim() || null)} />;
      case 'date':
        return <DateInput value={(value as string | null) ?? ''} onChange={(e) => onChange(e.target.value || null)} />;
      case 'datetime':
        return <DateTimeInput timezone={zone} value={toLocalInput(value, zone)} onChange={(e) => onChange(e.target.value ? fromLocalInput(e.target.value, zone) : null)} />;
      case 'single_select':
        return <Select value={(value as string | null) ?? null} clearable onChange={(v) => onChange(v)} options={optionList} placeholder="Not set" />;
      case 'multi_select':
        return <MultiSelect value={(value as string[] | null) ?? []} onChange={(v) => onChange(v.length ? v : null)} options={optionList} placeholder="Not set" />;
      case 'checkbox':
        return <Checkbox label={d.name} checked={value === true} onCheckedChange={(c) => onChange(c)} />;
      case 'member_reference':
        return <MemberSelect value={(value as string | null) ?? null} clearable onChange={(v) => onChange(v)} placeholder="Not set" />;
      case 'url':
        return <Input type="url" value={(value as string | null) ?? ''} maxLength={2000} onChange={(e) => onChange(e.target.value.trim() || null)} placeholder="https://" />;
      default:
        return <Input value={(value as string | null) ?? ''} maxLength={500} onChange={(e) => onChange(e.target.value || null)} />;
    }
  })();
  if (d.type === 'checkbox')
    return (
      <div className="flex flex-col gap-1">
        {control}
        {error ? <p className="text-[12px] text-danger">{error}</p> : helper ? <p className="text-[12px] text-fg-2">{helper}</p> : null}
      </div>
    );
  return (
    <Field label={d.name} required={f.required} helper={helper} error={error}>
      {control}
    </Field>
  );
};

/**
 * Reusable Custom Fields panel for any record detail page: shows the values the member may read and,
 * with edit rights, edits them with per-value conflict detection. Renders nothing when the record
 * type has no active fields.
 */
export const CustomFieldsPanel = ({ entityType, entityId, title = 'Custom Fields', className }: { entityType: string; entityId: string; title?: string; className?: string }) => {
  const { workspace, user } = useWorkspace();
  const zone = user.timezone;
  const q = useApiQuery(customFieldEndpoints.values, { params: { workspaceId: workspace.id }, query: { entityType, entityId } });
  const save = useApiMutation(customFieldEndpoints.setValues, { invalidate: ['customFields.values'], silentErrors: true, successMessage: 'Custom fields saved' });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const data = q.data;
  if (!data || (data.fields.length === 0 && !q.isError)) return null;
  const visible = data.fields.filter((f) => !f.definition.archivedAt || f.value !== null);
  if (visible.length === 0) return null;
  const missing = visible.filter((f) => f.needsCompletion);
  const start = () => {
    setDraft(Object.fromEntries(visible.map((f) => [f.definition.id, f.value])));
    setErrors({});
    setError(null);
    setEditing(true);
  };
  const changed = visible.filter((f) => !f.definition.archivedAt && !same(draft[f.definition.id], f.value));
  const submit = async () => {
    if (!changed.length) return setEditing(false);
    setErrors({});
    setError(null);
    try {
      await save.run({
        params: { workspaceId: workspace.id },
        body: { entityType, entityId, values: changed.map((f) => ({ definitionId: f.definition.id, value: draft[f.definition.id] ?? null, rowVersion: f.rowVersion })) },
      });
      setEditing(false);
    } catch (e) {
      if (isApiError(e) && (e.code === 'VERSION_CONFLICT' || e.status === 412)) setConflict(true);
      else if (isApiError(e) && e.fieldErrors.length) setErrors(Object.fromEntries(e.fieldErrors.map((x) => [x.field.replace(/^(body\.)?values\./, ''), x.message])));
      else setError(isApiError(e) ? e.message : 'Could not save custom fields.');
    }
  };

  return (
    <Panel
      title={title}
      className={className}
      description={missing.length ? `${missing.length} field${missing.length === 1 ? '' : 's'} needed before the next stage` : undefined}
      actions={
        data.canEdit && !editing ? (
          <Button size="sm" variant="ghost" icon={<PencilSimple size={14} />} onClick={start}>
            Edit
          </Button>
        ) : undefined
      }
    >
      {editing ? (
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {error ? <Banner tone="danger">{error}</Banner> : null}
          {visible
            .filter((f) => !f.definition.archivedAt)
            .map((f) => (
              <ValueInput key={f.definition.id} f={f} zone={zone} value={draft[f.definition.id]} error={errors[f.definition.id]} onChange={(v) => setDraft((cur) => ({ ...cur, [f.definition.id]: v }))} />
            ))}
          <div className="flex justify-end gap-2">
            <Button onClick={() => setEditing(false)} disabled={save.isPending}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={save.isPending} disabled={!changed.length}>
              Save
            </Button>
          </div>
        </form>
      ) : (
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
          {visible.map((f) => (
            <div key={f.definition.id} className="min-w-0">
              <dt className="flex items-center gap-1.5 text-[12px] font-[550] leading-[18px] text-fg-2">
                {f.definition.name}
                {f.definition.archivedAt ? <Badge>Archived field</Badge> : null}
                {f.needsCompletion ? (
                  <Badge tone="warning" icon={<WarningCircle size={12} aria-hidden />}>
                    Needed{f.definition.requiredAtStage ? ` for ${label('stage', f.definition.requiredAtStage)}` : ''}
                  </Badge>
                ) : null}
              </dt>
              <dd className={cn('mt-0.5 break-words text-[14px] leading-[22px]', f.displayValue ? 'text-fg' : 'text-fg-muted')}>
                {f.definition.type === 'url' && typeof f.value === 'string' ? (
                  <a href={f.value} target="_blank" rel="noopener noreferrer nofollow" className="text-primary hover:underline">
                    {f.displayValue}
                  </a>
                ) : (
                  (f.displayValue ?? 'Not set')
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}
      <ConflictDialog
        open={conflict}
        onOpenChange={setConflict}
        onReload={() => {
          setConflict(false);
          setEditing(false);
          void q.refetch();
        }}
      />
    </Panel>
  );
};
