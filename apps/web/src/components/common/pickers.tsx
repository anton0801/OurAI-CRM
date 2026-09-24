'use client';
import { directionEndpoints, peopleEndpoints } from '@castlane/api-contracts';
import { MultiSelect, Select } from '@castlane/ui';
import { useApiQuery } from '@/lib/hooks';
import { useWorkspace } from '@/lib/workspace-context';

type Common = { id?: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean; disabled?: boolean; placeholder?: string; clearable?: boolean };

/** Member picker. With projectId + permission it lists only people who would hold that permission there. */
export const MemberSelect = ({
  value,
  onChange,
  projectId,
  permission,
  ...rest
}: Common & { value: string | null | undefined; onChange: (v: string | null) => void; projectId?: string; permission?: string }) => {
  const { workspace } = useWorkspace();
  const q = useApiQuery(peopleEndpoints.lookup, { params: { workspaceId: workspace.id }, query: { projectId, permission, limit: 200 } }, { staleTime: 60_000 });
  return (
    <Select
      value={value ?? null}
      onChange={onChange}
      options={(q.data ?? []).map((p) => ({ value: p.membershipId, label: p.displayName, description: p.title ?? p.email ?? undefined }))}
      placeholder={q.isLoading ? 'Loading…' : (rest.placeholder ?? 'Choose a member')}
      {...rest}
    />
  );
};

export const MultiMemberSelect = ({ value, onChange, ...rest }: Common & { value: string[]; onChange: (v: string[]) => void }) => {
  const { workspace } = useWorkspace();
  const q = useApiQuery(peopleEndpoints.lookup, { params: { workspaceId: workspace.id }, query: { limit: 200 } }, { staleTime: 60_000 });
  return <MultiSelect value={value} onChange={onChange} options={(q.data ?? []).map((p) => ({ value: p.membershipId, label: p.displayName }))} {...rest} />;
};

export const DirectionSelect = ({ value, onChange, ...rest }: Common & { value: string | null | undefined; onChange: (v: string | null) => void }) => {
  const { workspace } = useWorkspace();
  const q = useApiQuery(directionEndpoints.list, { params: { workspaceId: workspace.id }, query: {} }, { staleTime: 60_000 });
  return (
    <Select
      value={value ?? null}
      onChange={onChange}
      options={(q.data ?? []).map((d) => ({ value: d.id, label: d.name }))}
      placeholder={q.isLoading ? 'Loading…' : (rest.placeholder ?? 'Choose a direction')}
      {...rest}
    />
  );
};
