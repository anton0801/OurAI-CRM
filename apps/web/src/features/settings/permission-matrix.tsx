'use client';
import { useMemo, useState } from 'react';
import { OWNER_ONLY_GRANTABLE, PERMISSION_GROUPS, isFinancePermission, isSensitivePermission } from '@castlane/authorization';
import { Badge, Checkbox, Input, Switch, cn } from '@castlane/ui';
import { label } from '@/lib/labels';
import { useWorkspace } from '@/lib/workspace-context';
import { permissionLabel } from '@/features/team/labels';

export const isOwnerOnlyPermission = (p: string) => isFinancePermission(p) || OWNER_ONLY_GRANTABLE.includes(p);

/**
 * Mirrors the server's no-escalation rule for display: a permission can be toggled only by the
 * Owner, or by someone who holds it and it is not finance/owner-only. The server re-checks.
 */
export const useManageablePermission = () => {
  const { permissions, isOwner } = useWorkspace();
  const held = useMemo(() => new Set(permissions), [permissions]);
  return (p: string) => isOwner || (!isOwnerOnlyPermission(p) && held.has(p));
};

/** Permission matrix grouped by PERMISSION_GROUPS; sensitive and Owner-only permissions are flagged. */
export const PermissionMatrix = ({
  value,
  onChange,
  editable,
  original,
}: {
  value: ReadonlySet<string>;
  onChange: (next: Set<string>) => void;
  editable: boolean;
  /** Saved permission set; changes against it are marked Added / Removed. */
  original?: ReadonlySet<string>;
}) => {
  const manageable = useManageablePermission();
  const [search, setSearch] = useState('');
  const [onlySelected, setOnlySelected] = useState(false);
  const term = search.trim().toLowerCase();
  const groups = (Object.entries(PERMISSION_GROUPS) as [string, readonly string[]][]).map(([key, perms]) => ({
    key,
    all: perms,
    shown: perms.filter((p) => (!onlySelected || value.has(p)) && (!term || p.includes(term) || permissionLabel(p).toLowerCase().includes(term))),
  }));
  const toggle = (p: string, on: boolean) => {
    const next = new Set(value);
    if (on) next.add(p);
    else next.delete(p);
    onChange(next);
  };
  const toggleGroup = (perms: readonly string[], on: boolean) => {
    const next = new Set(value);
    for (const p of perms) {
      if (!manageable(p)) continue;
      if (on) next.add(p);
      else next.delete(p);
    }
    onChange(next);
  };
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search permissions" aria-label="Search permissions" className="md:max-w-[280px]" />
        <Switch checked={onlySelected} onCheckedChange={setOnlySelected} label="Only granted permissions" />
      </div>
      <p className="text-[12px] text-fg-2">
        {value.size} permission{value.size === 1 ? '' : 's'} selected. <Badge tone="warning">Sensitive</Badge> permissions are never implied by broader grants;{' '}
        <Badge tone="info">Owner only</Badge> permissions can only be changed by the Owner.
      </p>
      {groups.map((g) =>
        g.shown.length === 0 ? null : (
          <fieldset key={g.key} className="rounded-[12px] border border-line">
            <legend className="sr-only">{label('permissionGroup', g.key)}</legend>
            <div className="flex items-center justify-between gap-2 border-b border-line bg-surface-2 px-4 py-2">
              {editable ? (
                <Checkbox
                  checked={g.all.every((p) => value.has(p)) ? true : g.all.some((p) => value.has(p)) ? 'indeterminate' : false}
                  onCheckedChange={(on) => toggleGroup(g.all, on)}
                  disabled={!g.all.some(manageable)}
                  label={<span className="font-semibold">{label('permissionGroup', g.key)}</span>}
                />
              ) : (
                <span className="text-[14px] font-semibold text-fg">{label('permissionGroup', g.key)}</span>
              )}
              <span className="text-[12px] text-fg-2">
                {g.all.filter((p) => value.has(p)).length} / {g.all.length}
              </span>
            </div>
            <ul className="grid grid-cols-1 gap-x-6 gap-y-1 px-4 py-3 md:grid-cols-2">
              {g.shown.map((p) => {
                const on = value.has(p);
                const changed = original ? original.has(p) !== on : false;
                const tags = (
                  <span className="flex flex-wrap items-center gap-1">
                    <span>{permissionLabel(p)}</span>
                    {isSensitivePermission(p) ? <Badge tone="warning">Sensitive</Badge> : null}
                    {isOwnerOnlyPermission(p) ? <Badge tone="info">Owner only</Badge> : null}
                    {changed ? <Badge tone={on ? 'primary' : 'danger'}>{on ? 'Added' : 'Removed'}</Badge> : null}
                  </span>
                );
                return (
                  <li key={p} className={cn('py-1', changed && 'rounded-[6px] bg-selection/40')}>
                    {editable ? (
                      <Checkbox
                        checked={on}
                        onCheckedChange={(v) => toggle(p, v)}
                        disabled={!manageable(p)}
                        label={tags}
                        description={<span className="font-mono">{p}{!manageable(p) ? ' · you cannot grant this permission' : ''}</span>}
                      />
                    ) : (
                      <div className={cn('flex flex-col text-[14px]', !on && 'text-fg-2 line-through decoration-fg-muted/40')}>
                        <span className="flex items-center gap-2">
                          <span aria-hidden>{on ? '✓' : '–'}</span>
                          {tags}
                        </span>
                        <span className="sr-only">{on ? 'Granted' : 'Not granted'}</span>
                        <span className="pl-5 font-mono text-[12px] text-fg-2">{p}</span>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </fieldset>
        ),
      )}
      {groups.every((g) => g.shown.length === 0) ? <p className="text-[13px] text-fg-2">No permissions match.</p> : null}
    </div>
  );
};
