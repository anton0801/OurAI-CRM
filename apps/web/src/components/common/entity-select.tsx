'use client';
import { lookupEndpoints, type LookupItem, type LookupType } from '@castlane/api-contracts';
import { MultiSelect, Select, type SelectOption } from '@castlane/ui';
import { keepPreviousData } from '@tanstack/react-query';
import { useMemo, useRef, useState } from 'react';
import { useApiQuery } from '@/lib/hooks';
import { useWorkspace } from '@/lib/workspace-context';
import { useDebounced } from './use-debounced';

export interface EntityFilters {
  projectId?: string;
  accountId?: string;
  directionId?: string;
  parentId?: string;
  status?: string[];
  includeArchived?: boolean;
}

type Common = {
  type: LookupType;
  filters?: EntityFilters;
  id?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
  'aria-label'?: string;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
};

const toOption = (i: LookupItem): SelectOption => ({
  value: i.id,
  label: i.archived ? `${i.label} (archived)` : i.label,
  description: i.sublabel ?? undefined,
});

/**
 * Server-searched picker for any entity type with a registered lookup provider. Only records the
 * member may read are offered; the labels of already-selected ids are resolved separately so the
 * trigger never shows a raw id.
 */
const useEntityOptions = (type: LookupType, filters: EntityFilters | undefined, selected: string[]) => {
  const { workspace } = useWorkspace();
  const [query, setQuery] = useState('');
  const q = useDebounced(query, 200);
  const params = { workspaceId: workspace.id, type };
  const search = useApiQuery(
    lookupEndpoints.search,
    { params, query: { q: q || undefined, ...filters, limit: 20 } },
    { staleTime: 30_000, placeholderData: keepPreviousData },
  );
  const missing = selected.filter((id) => !search.data?.items.some((i) => i.id === id));
  const resolved = useApiQuery(
    lookupEndpoints.search,
    { params, query: { ids: missing, includeArchived: true, limit: 50 } },
    { enabled: missing.length > 0, staleTime: 60_000 },
  );
  // Remember labels seen so far so selections keep their label when the search changes.
  const seen = useRef(new Map<string, LookupItem>());
  for (const i of search.data?.items ?? []) seen.current.set(i.id, i);
  for (const i of resolved.data?.items ?? []) seen.current.set(i.id, i);
  const options = useMemo(() => {
    const list = [...(search.data?.items ?? [])];
    for (const id of selected) {
      const known = seen.current.get(id);
      if (known && !list.some((i) => i.id === id)) list.unshift(known);
    }
    return list.map(toOption);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.data, resolved.data, selected.join(',')]);
  return { options, setQuery, loading: search.isLoading, error: search.isError };
};

export const EntitySelect = ({
  value,
  onChange,
  clearable,
  ...rest
}: Common & { value: string | null | undefined; onChange: (v: string | null, item?: LookupItem) => void; clearable?: boolean }) => {
  const { options, setQuery, loading, error } = useEntityOptions(rest.type, rest.filters, value ? [value] : []);
  return (
    <Select
      id={rest.id}
      aria-describedby={rest['aria-describedby']}
      aria-invalid={rest['aria-invalid']}
      aria-label={rest['aria-label']}
      className={rest.className}
      disabled={rest.disabled}
      value={value ?? null}
      onChange={(v) => onChange(v)}
      options={options}
      onQueryChange={setQuery}
      clearable={clearable}
      placeholder={loading ? 'Loading…' : (rest.placeholder ?? 'Choose…')}
      emptyText={error ? 'Could not load options.' : 'No matches'}
    />
  );
};

export const MultiEntitySelect = ({
  value,
  onChange,
  max,
  ...rest
}: Common & { value: string[]; onChange: (v: string[]) => void; max?: number }) => {
  const { options, setQuery, loading, error } = useEntityOptions(rest.type, rest.filters, value);
  return (
    <MultiSelect
      id={rest.id}
      aria-describedby={rest['aria-describedby']}
      aria-invalid={rest['aria-invalid']}
      aria-label={rest['aria-label']}
      className={rest.className}
      disabled={rest.disabled}
      value={value}
      onChange={onChange}
      options={options}
      onQueryChange={setQuery}
      max={max}
      placeholder={loading ? 'Loading…' : (rest.placeholder ?? 'Choose…')}
      emptyText={error ? 'Could not load options.' : 'No matches'}
    />
  );
};
