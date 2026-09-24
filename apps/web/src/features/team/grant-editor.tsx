'use client';
import { Plus, Trash } from '@phosphor-icons/react';
import { roleEndpoints, type GrantInput } from '@castlane/api-contracts';
import { isSensitivePermission } from '@castlane/authorization';
import { SCOPE_TYPES, type ScopeType } from '@castlane/domain';
import { Badge, Button, Field, IconButton, Select, Skeleton } from '@castlane/ui';
import { EntitySelect } from '@/components/common/entity-select';
import { DirectionSelect } from '@/components/common/pickers';
import { useApiQuery } from '@/lib/hooks';
import { useWorkspace } from '@/lib/workspace-context';
import { permissionLabel, scopeTypeLabel } from './labels';

export interface GrantDraft {
  key: string;
  roleId: string | null;
  scopeType: ScopeType;
  scopeId: string | null;
}

export const newGrantDraft = (): GrantDraft => ({ key: Math.random().toString(36).slice(2), roleId: null, scopeType: 'workspace', scopeId: null });

export const needsScopeObject = (t: ScopeType) => t === 'direction' || t === 'project' || t === 'account';

export const draftComplete = (g: GrantDraft) => !!g.roleId && (!needsScopeObject(g.scopeType) || !!g.scopeId);

export const toGrantInput = (g: GrantDraft): GrantInput => ({ roleId: g.roleId!, scopeType: g.scopeType, scopeId: needsScopeObject(g.scopeType) ? g.scopeId : null });

export const useGrantableRoles = () => {
  const { workspace } = useWorkspace();
  return useApiQuery(roleEndpoints.grantable, { params: { workspaceId: workspace.id } }, { staleTime: 60_000 });
};

/** Scope picker: scope type plus the direction / project / account it points at. */
export const ScopePicker = ({
  scopeType,
  scopeId,
  onChange,
  idPrefix,
}: {
  scopeType: ScopeType;
  scopeId: string | null;
  onChange: (t: ScopeType, id: string | null) => void;
  idPrefix: string;
}) => (
  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
    <Field label="Scope" required id={`${idPrefix}-scope`}>
      <Select value={scopeType} onChange={(v) => onChange((v ?? 'workspace') as ScopeType, null)} options={SCOPE_TYPES.map((t) => ({ value: t, label: scopeTypeLabel(t) }))} />
    </Field>
    {scopeType === 'direction' ? (
      <Field label="Direction" required id={`${idPrefix}-dir`}>
        <DirectionSelect value={scopeId} onChange={(v) => onChange('direction', v)} />
      </Field>
    ) : scopeType === 'project' ? (
      <Field label="Project" required id={`${idPrefix}-project`}>
        <EntitySelect type="project" value={scopeId} onChange={(v) => onChange('project', v)} />
      </Field>
    ) : scopeType === 'account' ? (
      <Field label="Account" required id={`${idPrefix}-account`}>
        <EntitySelect type="account" value={scopeId} onChange={(v) => onChange('account', v)} />
      </Field>
    ) : null}
  </div>
);

/**
 * Role + scope rows for invitations, grants and restores. Only roles the viewer may grant are
 * offered (the server re-validates: no escalation, Owner-only Admin/finance roles).
 */
export const GrantEditor = ({ value, onChange, max = 10, error }: { value: GrantDraft[]; onChange: (v: GrantDraft[]) => void; max?: number; error?: string | null }) => {
  const roles = useGrantableRoles();
  if (roles.isLoading) return <Skeleton className="h-24 w-full" />;
  const list = roles.data ?? [];
  const update = (i: number, patch: Partial<GrantDraft>) => onChange(value.map((g, j) => (j === i ? { ...g, ...patch } : g)));
  return (
    <div className="flex flex-col gap-3">
      {list.length === 0 ? <p className="text-[13px] text-fg-2">You cannot grant any role. Ask the workspace Owner.</p> : null}
      {value.map((g, i) => {
        const role = list.find((r) => r.id === g.roleId);
        const sensitive = role?.permissions.filter(isSensitivePermission) ?? [];
        return (
          <div key={g.key} className="flex flex-col gap-3 rounded-[8px] border border-line p-3">
            <div className="flex items-end gap-2">
              <Field label="Role" required className="flex-1" id={`grant-${g.key}-role`}>
                <Select
                  value={g.roleId}
                  onChange={(v) => {
                    const r = list.find((x) => x.id === v);
                    update(i, { roleId: v, scopeType: r?.defaultScopeType ?? g.scopeType, scopeId: null });
                  }}
                  options={list.map((r) => ({ value: r.id, label: r.name, description: r.description ?? undefined }))}
                  placeholder="Choose a role"
                />
              </Field>
              <IconButton label="Remove this role" icon={<Trash size={16} />} disabled={value.length === 1} onClick={() => onChange(value.filter((_, j) => j !== i))} />
            </div>
            <ScopePicker idPrefix={`grant-${g.key}`} scopeType={g.scopeType} scopeId={g.scopeId} onChange={(t, id) => update(i, { scopeType: t, scopeId: id })} />
            {role ? (
              <div className="flex flex-wrap items-center gap-2 text-[12px] text-fg-2">
                <Badge>{role.permissions.length} permissions</Badge>
                {sensitive.length ? (
                  <Badge tone="warning" title={sensitive.map(permissionLabel).join(', ')}>
                    Sensitive: {sensitive.slice(0, 3).map(permissionLabel).join(', ')}
                    {sensitive.length > 3 ? ` +${sensitive.length - 3}` : ''}
                  </Badge>
                ) : (
                  <span>No finance, OFM contact, restricted media or export permissions.</span>
                )}
              </div>
            ) : null}
          </div>
        );
      })}
      {error ? <p className="text-[12px] text-danger">{error}</p> : null}
      {value.length < max ? (
        <div>
          <Button size="sm" icon={<Plus size={14} />} onClick={() => onChange([...value, newGrantDraft()])}>
            Add Another Role
          </Button>
        </div>
      ) : null}
    </div>
  );
};
