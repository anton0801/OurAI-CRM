'use client';
import { Plus, Trash } from '@phosphor-icons/react';
import type { AllocationSpecInput } from '@castlane/api-contracts';
import { computeAllocation, formatMinor, tryParseAmountToMinor } from '@castlane/domain';
import { AmountInput, Button, IconButton, Input, Select, cn } from '@castlane/ui';
import { EntitySelect } from '@/components/common/entity-select';
import { decimalOk } from './common';

export type AllocationRowForm = { key: string; target: 'project' | 'unallocated'; projectId: string | null; value: string };
export type AllocationForm = { mode: 'exact' | 'percent' | 'weights'; rows: AllocationRowForm[] };

let seq = 0;
export const rowKey = () => `r${++seq}`;

export const emptyAllocation = (): AllocationForm => ({ mode: 'percent', rows: [{ key: rowKey(), target: 'project', projectId: null, value: '100' }] });

export const allocationFromSpec = (spec: { mode: AllocationForm['mode']; rows: { projectId: string | null; value: string }[] }): AllocationForm => ({
  mode: spec.mode,
  rows: spec.rows.map((r) => ({ key: rowKey(), target: r.projectId ? 'project' : 'unallocated', projectId: r.projectId, value: r.value })),
});

/** Allocation form → API spec. Rows without a chosen project are sent as they are so the server can point at them. */
export const allocationToSpec = (a: AllocationForm): AllocationSpecInput => ({
  mode: a.mode,
  rows: a.rows.map((r) => ({ projectId: r.target === 'unallocated' ? null : r.projectId, value: r.value.trim() || '0' })),
});

const MODE_OPTIONS = [
  { value: 'percent' as const, label: 'Percent' },
  { value: 'exact' as const, label: 'Exact amounts' },
  { value: 'weights' as const, label: 'Weights' },
];

/**
 * Allocation rows to projects or an explicit Unallocated remainder. The preview shows the exact
 * minor-unit split (largest remainder) that the server will apply; nothing is hidden in rounding.
 */
export const AllocationEditor = ({
  value,
  onChange,
  amount,
  currency,
  errors,
  disabled,
}: {
  value: AllocationForm;
  onChange: (v: AllocationForm) => void;
  /** Amount being allocated (for the preview); omit when several lines share this allocation. */
  amount?: string;
  currency: string;
  errors?: Record<string, string>;
  disabled?: boolean;
}) => {
  const set = (i: number, patch: Partial<AllocationRowForm>) => onChange({ ...value, rows: value.rows.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  const total = amount ? tryParseAmountToMinor(amount, currency) : null;
  const complete = value.rows.every((r) => r.target === 'unallocated' || r.projectId);
  const preview = total !== null && total > 0n && complete ? computeAllocation(total, currency, allocationToSpec(value) as never) : null;
  const sumPercent = value.mode === 'percent' ? value.rows.reduce((a, r) => a + (Number(r.value) || 0), 0) : null;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[12px] font-[550] text-fg">Split by</span>
        <div className="w-[170px]">
          <Select aria-label="Allocation mode" value={value.mode} onChange={(m) => m && onChange({ ...value, mode: m })} options={MODE_OPTIONS} disabled={disabled} />
        </div>
        {sumPercent !== null ? <span className={cn('text-[12px]', Math.abs(sumPercent - 100) < 1e-9 ? 'text-fg-2' : 'text-warning')}>Total {sumPercent}% of 100%</span> : null}
      </div>
      {errors?.allocation ? <p className="text-[12px] text-danger">{errors.allocation}</p> : null}
      <ul className="flex flex-col gap-2">
        {value.rows.map((r, i) => {
          const err = errors?.[`allocation.rows.${i}.value`];
          const previewRow = preview?.ok ? preview.rows[i] : undefined;
          return (
            <li key={r.key} className="flex flex-col gap-1 rounded-[8px] border border-line p-2 sm:flex-row sm:items-start sm:gap-2 sm:border-0 sm:p-0">
              <div className="w-full sm:w-[150px]">
                <Select
                  aria-label={`Row ${i + 1} target`}
                  value={r.target}
                  onChange={(t) => t && set(i, { target: t, projectId: t === 'unallocated' ? null : r.projectId })}
                  options={[
                    { value: 'project', label: 'Project' },
                    { value: 'unallocated', label: 'Unallocated' },
                  ]}
                  disabled={disabled}
                />
              </div>
              <div className="min-w-0 flex-1">
                {r.target === 'project' ? (
                  <EntitySelect type="project" aria-label={`Row ${i + 1} project`} value={r.projectId} onChange={(v) => set(i, { projectId: v })} placeholder="Choose a project" disabled={disabled} />
                ) : (
                  <p className="flex h-10 items-center text-[13px] text-fg-2">Kept as an explicit unallocated balance</p>
                )}
              </div>
              <div className="w-full sm:w-[150px]">
                {value.mode === 'exact' ? (
                  <AmountInput currency={currency} aria-label={`Row ${i + 1} amount`} aria-invalid={!!err} value={r.value} onChange={(e) => decimalOk(e.target.value) && set(i, { value: e.target.value })} disabled={disabled} />
                ) : (
                  <div className="relative flex items-center">
                    <Input aria-label={`Row ${i + 1} ${value.mode === 'percent' ? 'percent' : 'weight'}`} aria-invalid={!!err} inputMode="decimal" className="pr-8 text-right font-mono" value={r.value} onChange={(e) => decimalOk(e.target.value) && set(i, { value: e.target.value })} disabled={disabled} />
                    {value.mode === 'percent' ? <span className="pointer-events-none absolute right-3 text-[12px] text-fg-2">%</span> : null}
                  </div>
                )}
                {err ? <p className="mt-1 text-[12px] text-danger">{err}</p> : null}
              </div>
              <div className="flex items-center justify-between gap-2 sm:w-[140px] sm:justify-end">
                <span className="font-mono text-[12px] tabular-nums text-fg-2" aria-label="Allocated amount">
                  {previewRow ? `${formatMinor(previewRow.amountMinor, currency)} ${currency}` : ''}
                </span>
                <IconButton label={`Remove row ${i + 1}`} icon={<Trash size={14} />} disabled={disabled || value.rows.length === 1} onClick={() => onChange({ ...value, rows: value.rows.filter((_, j) => j !== i) })} />
              </div>
            </li>
          );
        })}
      </ul>
      {preview && !preview.ok ? <p className="text-[12px] text-warning">{preview.issues[0]?.message}</p> : null}
      <div>
        <Button size="sm" icon={<Plus size={12} />} disabled={disabled || value.rows.length >= 200} onClick={() => onChange({ ...value, rows: [...value.rows, { key: rowKey(), target: 'project', projectId: null, value: '' }] })}>
          Add Row
        </Button>
      </div>
    </div>
  );
};
