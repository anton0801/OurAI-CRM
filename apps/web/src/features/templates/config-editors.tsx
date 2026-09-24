'use client';
import { ArrowDown, ArrowUp, Plus, Trash } from '@phosphor-icons/react';
import { type TemplateConfigInput, type TemplateTaskNodeInput } from '@castlane/api-contracts';
import { CONTENT_FORMATS, CONTENT_SLOTS, RESPONSIBILITIES } from '@castlane/domain';
import { Button, Checkbox, Field, IconButton, Input, MultiSelect, Select, Textarea, cn } from '@castlane/ui';
import { label } from '@/lib/labels';

type Checklist = NonNullable<TemplateConfigInput['checklist']>;
type Rubric = NonNullable<TemplateConfigInput['rubric']>;
type Slots = NonNullable<TemplateConfigInput['deliverableSlots']>;

const move = <T,>(list: T[], from: number, to: number) => {
  if (to < 0 || to >= list.length) return list;
  const next = [...list];
  const [x] = next.splice(from, 1);
  next.splice(to, 0, x!);
  return next;
};

/** "Write the script" → "write-the-script" (unique among existing keys). */
export const slugKey = (title: string, taken: string[]) => {
  const base =
    title
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 34) || 'item';
  let key = /^[a-z0-9]/.test(base) ? base : `k${base}`;
  let n = 2;
  while (taken.includes(key)) key = `${base.slice(0, 34)}-${n++}`;
  return key;
};

const intOrUndefined = (v: string) => (v.trim() === '' ? undefined : Math.max(0, Math.floor(Number(v))) || 0);

const RowTools = ({ index, count, onMove, onRemove, name }: { index: number; count: number; onMove: (to: number) => void; onRemove: () => void; name: string }) => (
  <div className="flex shrink-0 items-center gap-1">
    <IconButton label={`Move ${name} up`} icon={<ArrowUp size={14} />} disabled={index === 0} onClick={() => onMove(index - 1)} />
    <IconButton label={`Move ${name} down`} icon={<ArrowDown size={14} />} disabled={index === count - 1} onClick={() => onMove(index + 1)} />
    <IconButton label={`Remove ${name}`} icon={<Trash size={14} />} onClick={onRemove} />
  </div>
);

export const ChecklistEditor = ({ value, onChange, readOnly, title = 'Checklist' }: { value: Checklist; onChange: (v: Checklist) => void; readOnly?: boolean; title?: string }) => (
  <fieldset className="flex flex-col gap-2">
    <legend className="mb-1 text-[13px] font-semibold text-fg">{title}</legend>
    {value.length === 0 ? <p className="text-[13px] text-fg-2">No checklist items.</p> : null}
    {value.map((item, i) => (
      <div key={i} className="flex flex-wrap items-center gap-2">
        <Input className="min-w-[200px] flex-1" aria-label={`Checklist item ${i + 1}`} value={item.label} readOnly={readOnly} maxLength={200} onChange={(e) => onChange(value.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
        <Checkbox label="Mandatory" checked={item.mandatory} disabled={readOnly} onCheckedChange={(c) => onChange(value.map((x, j) => (j === i ? { ...x, mandatory: !!c } : x)))} />
        {!readOnly ? <RowTools name={`item ${i + 1}`} index={i} count={value.length} onMove={(to) => onChange(move(value, i, to))} onRemove={() => onChange(value.filter((_, j) => j !== i))} /> : null}
      </div>
    ))}
    {!readOnly ? (
      <Button size="sm" variant="ghost" className="w-fit" icon={<Plus size={14} />} onClick={() => onChange([...value, { label: '', mandatory: true }])} disabled={value.length >= 100}>
        Add Item
      </Button>
    ) : null}
  </fieldset>
);

export const RubricEditor = ({ value, onChange, readOnly }: { value: Rubric; onChange: (v: Rubric) => void; readOnly?: boolean }) => {
  const sum = value.reduce((a, r) => a + (Number.isFinite(Number(r.weight)) ? Number(r.weight) : 0), 0);
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-[13px] font-semibold text-fg">Criteria</legend>
      <p className={cn('text-[12px]', Math.abs(sum - 100) < 1e-9 ? 'text-fg-2' : 'text-danger')}>Weights add up to {Number(sum.toFixed(4))} of 100.</p>
      {value.map((r, i) => (
        <div key={i} className="flex flex-wrap items-end gap-2">
          <Field label="Criterion" className="min-w-[200px] flex-1">
            <Input
              value={r.label}
              readOnly={readOnly}
              maxLength={120}
              onChange={(e) => onChange(value.map((x, j) => (j === i ? { ...x, label: e.target.value, key: x.key || slugKey(e.target.value, value.map((y) => y.key)) } : x)))}
            />
          </Field>
          <Field label="Key" className="w-[150px]">
            <Input value={r.key} readOnly={readOnly} maxLength={40} spellCheck={false} onChange={(e) => onChange(value.map((x, j) => (j === i ? { ...x, key: e.target.value.toLowerCase() } : x)))} />
          </Field>
          <Field label="Weight" className="w-[100px]">
            <Input inputMode="decimal" value={r.weight} readOnly={readOnly} onChange={(e) => onChange(value.map((x, j) => (j === i ? { ...x, weight: e.target.value.replace(',', '.') } : x)))} />
          </Field>
          {!readOnly ? <RowTools name={r.label || `criterion ${i + 1}`} index={i} count={value.length} onMove={(to) => onChange(move(value, i, to))} onRemove={() => onChange(value.filter((_, j) => j !== i))} /> : null}
        </div>
      ))}
      {!readOnly ? (
        <Button size="sm" variant="ghost" className="w-fit" icon={<Plus size={14} />} onClick={() => onChange([...value, { key: '', label: '', weight: '' }])} disabled={value.length >= 30}>
          Add Criterion
        </Button>
      ) : null}
    </fieldset>
  );
};

export const SlotsEditor = ({ value, onChange, readOnly }: { value: Slots; onChange: (v: Slots) => void; readOnly?: boolean }) => (
  <fieldset className="flex flex-col gap-2">
    <legend className="mb-1 text-[13px] font-semibold text-fg">Deliverable Slots</legend>
    {value.map((s, i) => (
      <div key={i} className="flex flex-wrap items-center gap-2">
        <div className="w-[220px]">
          <Select aria-label={`Slot ${i + 1}`} value={s.slot} disabled={readOnly} onChange={(v) => v && onChange(value.map((x, j) => (j === i ? { ...x, slot: v } : x)))} options={CONTENT_SLOTS.map((c) => ({ value: c, label: label('contentSlot', c) }))} />
        </div>
        <Checkbox label="Required" checked={s.required} disabled={readOnly} onCheckedChange={(c) => onChange(value.map((x, j) => (j === i ? { ...x, required: !!c } : x)))} />
        {!readOnly ? <RowTools name={`slot ${i + 1}`} index={i} count={value.length} onMove={(to) => onChange(move(value, i, to))} onRemove={() => onChange(value.filter((_, j) => j !== i))} /> : null}
      </div>
    ))}
    {!readOnly ? (
      <Button size="sm" variant="ghost" className="w-fit" icon={<Plus size={14} />} onClick={() => onChange([...value, { slot: 'main_video', required: true }])} disabled={value.length >= 20}>
        Add Slot
      </Button>
    ) : null}
  </fieldset>
);

/** Task graph editor: key, title, offset/duration in days, estimate, dependencies, checklist, review. */
export const TaskNodesEditor = ({ value, onChange, readOnly, errors }: { value: TemplateTaskNodeInput[]; onChange: (v: TemplateTaskNodeInput[]) => void; readOnly?: boolean; errors?: Record<string, string> }) => {
  const keys = value.map((t) => t.key);
  const patch = (i: number, p: Partial<TemplateTaskNodeInput>) => onChange(value.map((t, j) => (j === i ? { ...t, ...p } : t)));
  const remove = (i: number) => {
    const removed = value[i]!.key;
    onChange(value.filter((_, j) => j !== i).map((t) => ({ ...t, dependsOn: t.dependsOn?.filter((d) => d !== removed) })));
  };
  return (
    <div className="flex flex-col gap-3">
      {value.length === 0 ? <p className="text-[13px] text-fg-2">No tasks yet. Add the first task of the plan.</p> : null}
      {value.map((t, i) => {
        const err = (f: string) => errors?.[`config.tasks.${i}.${f}`];
        return (
          <section key={i} aria-label={`Task ${i + 1}`} className="flex flex-col gap-3 rounded-[12px] border border-line bg-surface p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-[14px] font-semibold text-fg">
                {i + 1}. {t.title || 'Untitled task'}
              </h3>
              {!readOnly ? <RowTools name={t.title || `task ${i + 1}`} index={i} count={value.length} onMove={(to) => onChange(move(value, i, to))} onRemove={() => remove(i)} /> : null}
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_180px]">
              <Field label="Title" required error={err('title')}>
                <Input value={t.title} readOnly={readOnly} maxLength={200} onChange={(e) => patch(i, { title: e.target.value, key: t.key || slugKey(e.target.value, keys) })} />
              </Field>
              <Field label="Key" required helper="Used for dependencies." error={err('key')}>
                <Input
                  value={t.key}
                  readOnly={readOnly}
                  maxLength={40}
                  spellCheck={false}
                  onChange={(e) => {
                    const next = e.target.value.toLowerCase();
                    onChange(value.map((x, j) => (j === i ? { ...x, key: next } : { ...x, dependsOn: x.dependsOn?.map((d) => (d === t.key ? next : d)) })));
                  }}
                />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Field label="Starts After (days)" helper="From the start date.">
                <Input inputMode="numeric" readOnly={readOnly} value={t.offsetDaysFromStart ?? ''} onChange={(e) => patch(i, { offsetDaysFromStart: intOrUndefined(e.target.value) })} />
              </Field>
              <Field label="Duration (days)">
                <Input inputMode="numeric" readOnly={readOnly} value={t.durationDays ?? ''} onChange={(e) => patch(i, { durationDays: intOrUndefined(e.target.value) })} />
              </Field>
              <Field label="Estimate (minutes)">
                <Input inputMode="numeric" readOnly={readOnly} value={t.estimateMinutes ?? ''} onChange={(e) => patch(i, { estimateMinutes: intOrUndefined(e.target.value) })} />
              </Field>
              <Field label="Role Key" helper="Filled when applied.">
                <Input readOnly={readOnly} value={t.defaultRoleKey ?? ''} maxLength={60} spellCheck={false} onChange={(e) => patch(i, { defaultRoleKey: e.target.value.trim() || undefined })} />
              </Field>
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <Field label="Depends On" error={err('dependsOn')}>
                <MultiSelect
                  value={t.dependsOn ?? []}
                  disabled={readOnly}
                  onChange={(v) => patch(i, { dependsOn: v.length ? v : undefined })}
                  placeholder="No dependencies"
                  options={value.filter((x, j) => j !== i && x.key).map((x) => ({ value: x.key, label: x.title || x.key, description: x.key }))}
                />
              </Field>
              <Field label="Responsibility">
                <Select
                  value={t.responsibility ?? null}
                  disabled={readOnly}
                  clearable
                  onChange={(v) => patch(i, { responsibility: v ?? undefined })}
                  placeholder="Any"
                  options={RESPONSIBILITIES.map((r) => ({ value: r, label: label('responsibility', r) }))}
                />
              </Field>
            </div>
            <Field label="Description">
              <Textarea value={t.description ?? ''} readOnly={readOnly} rows={2} maxLength={4000} onChange={(e) => patch(i, { description: e.target.value || undefined })} />
            </Field>
            <Checkbox label="Requires review" description="The task is done only after a reviewer approves it." checked={!!t.requiresReview} disabled={readOnly} onCheckedChange={(c) => patch(i, { requiresReview: !!c || undefined })} />
            <ChecklistEditor title="Task Checklist" value={t.checklist ?? []} readOnly={readOnly} onChange={(c) => patch(i, { checklist: c.length ? c : undefined })} />
          </section>
        );
      })}
      {!readOnly ? (
        <Button className="w-fit" icon={<Plus size={14} />} onClick={() => onChange([...value, { key: '', title: '' }])} disabled={value.length >= 200}>
          Add Task
        </Button>
      ) : null}
    </div>
  );
};

/** The config editor for a template kind (only the parts that kind uses). */
export const TemplateConfigEditor = ({
  kind,
  value,
  onChange,
  readOnly,
  errors,
}: {
  kind: 'task' | 'content' | 'checklist' | 'quality_rubric';
  value: TemplateConfigInput;
  onChange: (v: TemplateConfigInput) => void;
  readOnly?: boolean;
  errors?: Record<string, string>;
}) => {
  const set = <K extends keyof TemplateConfigInput>(k: K, v: TemplateConfigInput[K]) => onChange({ ...value, [k]: v });
  if (kind === 'checklist') return <ChecklistEditor value={value.checklist ?? []} onChange={(v) => set('checklist', v)} readOnly={readOnly} />;
  if (kind === 'quality_rubric') return <RubricEditor value={value.rubric ?? []} onChange={(v) => set('rubric', v)} readOnly={readOnly} />;
  if (kind === 'task') return <TaskNodesEditor value={value.tasks ?? []} onChange={(v) => set('tasks', v)} readOnly={readOnly} errors={errors} />;
  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Field label="Format">
          <Select value={value.format ?? null} disabled={readOnly} clearable onChange={(v) => set('format', v ?? undefined)} placeholder="Any format" options={CONTENT_FORMATS.map((f) => ({ value: f, label: label('contentFormat', f) }))} />
        </Field>
        <Field label="Reviewer Role Key" helper="Who reviews content made from this template.">
          <Input value={value.reviewerRoleKey ?? ''} readOnly={readOnly} maxLength={60} onChange={(e) => set('reviewerRoleKey', e.target.value.trim() || undefined)} />
        </Field>
      </div>
      <SlotsEditor value={value.deliverableSlots ?? []} onChange={(v) => set('deliverableSlots', v)} readOnly={readOnly} />
      <ChecklistEditor value={value.checklist ?? []} onChange={(v) => set('checklist', v)} readOnly={readOnly} />
      <div className="flex flex-col gap-2">
        <h3 className="text-[13px] font-semibold text-fg">Production Tasks</h3>
        <TaskNodesEditor value={value.tasks ?? []} onChange={(v) => set('tasks', v)} readOnly={readOnly} errors={errors} />
      </div>
    </div>
  );
};
