'use client';
import { ofmEndpoints as E, type OfmProfileRow } from '@castlane/api-contracts';
import { MultiSelect, Select } from '@castlane/ui';
import { useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useWorkspace } from '@/lib/workspace-context';

type Common = { id?: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean; 'aria-label'?: string; disabled?: boolean; placeholder?: string; clearable?: boolean };

/** OFM models (projects with OFM enabled) and their accounts, limited to the member's OFM scope. */
export const useOfmModels = () => {
  const { workspace } = useWorkspace();
  return useApiQuery(E.profiles, { params: { workspaceId: workspace.id }, query: {} }, { staleTime: 60_000 });
};

export const accountOptions = (models: OfmProfileRow[] | undefined, projectId?: string | null) =>
  (models ?? [])
    .filter((m) => !projectId || m.projectId === projectId)
    .flatMap((m) => m.accounts.map((a) => ({ value: a.id, label: a.label, description: `${m.project.name} · ${label('platform', a.platform)}` })));

export const OfmModelSelect = ({ value, onChange, ...rest }: Common & { value: string | null | undefined; onChange: (v: string | null) => void }) => {
  const q = useOfmModels();
  return (
    <Select
      value={value ?? null}
      onChange={onChange}
      options={(q.data ?? []).map((m) => ({ value: m.projectId, label: m.project.name, description: `${m.accounts.length} account(s)` }))}
      placeholder={q.isLoading ? 'Loading…' : (rest.placeholder ?? 'Choose a model')}
      emptyText={q.isError ? 'Could not load models.' : 'No OFM models in your scope'}
      {...rest}
    />
  );
};

export const OfmAccountSelect = ({
  value,
  onChange,
  projectId,
  ...rest
}: Common & { value: string | null | undefined; onChange: (v: string | null) => void; projectId?: string | null }) => {
  const q = useOfmModels();
  return (
    <Select
      value={value ?? null}
      onChange={onChange}
      options={accountOptions(q.data, projectId)}
      placeholder={q.isLoading ? 'Loading…' : (rest.placeholder ?? 'Choose an account')}
      emptyText={q.isError ? 'Could not load accounts.' : 'No OFM accounts in your scope'}
      {...rest}
    />
  );
};

export const OfmAccountMultiSelect = ({
  value,
  onChange,
  projectId,
  exclude,
  max,
  ...rest
}: Common & { value: string[]; onChange: (v: string[]) => void; projectId?: string | null; exclude?: string[]; max?: number }) => {
  const q = useOfmModels();
  return (
    <MultiSelect
      value={value}
      onChange={onChange}
      max={max}
      options={accountOptions(q.data, projectId).filter((o) => !exclude?.includes(o.value))}
      placeholder={q.isLoading ? 'Loading…' : (rest.placeholder ?? 'Add accounts')}
      {...rest}
    />
  );
};

export const projectOfAccount = (models: OfmProfileRow[] | undefined, accountId: string | null | undefined) =>
  accountId ? (models ?? []).find((m) => m.accounts.some((a) => a.id === accountId))?.projectId ?? null : null;

const zoneList = (): string[] => {
  try {
    return (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf('timeZone');
  } catch {
    return [];
  }
};

/** IANA time zone picker (the shift's zone drives DST handling and local-time display). */
export const TimeZoneSelect = ({ value, onChange, ...rest }: Common & { value: string; onChange: (v: string) => void }) => {
  const zones = zoneList();
  const options = (zones.includes(value) || !value ? zones : [value, ...zones]).map((z) => ({ value: z, label: z.replace(/_/g, ' ') }));
  return <Select value={value || null} onChange={(v) => v && onChange(v)} options={options} searchable placeholder="Choose a time zone" {...rest} />;
};
