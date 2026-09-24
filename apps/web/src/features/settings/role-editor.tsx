'use client';
import Link from 'next/link';
import { DotsThree } from '@phosphor-icons/react';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { roleEndpoints, type MemberRef, type RoleDetail, type RoleImpact } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { SCOPE_TYPES } from '@castlane/domain';
import {
  Avatar,
  Badge,
  Banner,
  Button,
  ConfirmDialog,
  DataTable,
  Dialog,
  Drawer,
  Field,
  IconButton,
  Input,
  Menu,
  Select,
  Skeleton,
  Textarea,
  formatDate,
  formatDateTime,
} from '@castlane/ui';
import { ConflictDialog } from '@/components/common/conflict';
import { keyFor, useApiMutation, useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useWorkspace, useWsPath } from '@/lib/workspace-context';
import { permissionLabel } from '@/features/team/labels';
import { reportError, useRecentAuth } from '@/features/team/recent-auth';
import { PermissionMatrix } from './permission-matrix';

const scopeOptions = SCOPE_TYPES.map((s) => ({ value: s, label: label('scopeType', s) }));
type ScopeTypeValue = (typeof SCOPE_TYPES)[number];

const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>) => a.size === b.size && [...a].every((x) => b.has(x));

const PermList = ({ title, items, tone }: { title: string; items: string[]; tone: 'primary' | 'danger' | 'warning' }) =>
  items.length ? (
    <div className="flex flex-col gap-1">
      <h3 className="text-[13px] font-semibold text-fg">
        {title} ({items.length})
      </h3>
      <ul className="flex flex-wrap gap-1">
        {items.map((p) => (
          <li key={p}>
            <Badge tone={tone} title={p}>
              {permissionLabel(p)}
            </Badge>
          </li>
        ))}
      </ul>
    </div>
  ) : null;

/** Impact of a permission change: what is added/removed, sensitive changes, who is affected. */
const ImpactSummary = ({ impact }: { impact: RoleImpact }) => (
  <div className="flex flex-col gap-3">
    {impact.blocked ? <Banner tone="danger">{impact.blocked}</Banner> : null}
    {impact.sensitiveAdded.length ? (
      <Banner tone="warning">
        This change adds sensitive permissions ({impact.sensitiveAdded.map(permissionLabel).join(', ')}). Holders gain them immediately.
      </Banner>
    ) : null}
    <PermList title="Added" items={impact.added} tone="primary" />
    <PermList title="Removed" items={impact.removed} tone="danger" />
    {!impact.added.length && !impact.removed.length ? <p className="text-[13px] text-fg-2">No permission changes.</p> : null}
    <div className="flex flex-col gap-1">
      <h3 className="text-[13px] font-semibold text-fg">Affected members ({impact.affectedMembers.count})</h3>
      {impact.affectedMembers.count ? (
        <p className="text-[13px] text-fg-2">
          {impact.affectedMembers.sample.map((m) => m.displayName).join(', ')}
          {impact.affectedMembers.count > impact.affectedMembers.sample.length ? ` and ${impact.affectedMembers.count - impact.affectedMembers.sample.length} more` : ''}. Their open sessions
          pick up the change on the next request.
        </p>
      ) : (
        <p className="text-[13px] text-fg-2">Nobody holds this role right now.</p>
      )}
    </div>
  </div>
);

/** Role editor (S63): name, description, default scope and the permission matrix, with impact preview. */
export const RoleDrawer = ({ roleId, onClose, onClone }: { roleId: string | null; onClose: () => void; onClone: (r: RoleDetail) => void }) => {
  const { workspace } = useWorkspace();
  const q = useApiQuery(roleEndpoints.get, { params: { workspaceId: workspace.id, roleId: roleId ?? '00000000-0000-0000-0000-000000000000' } }, { enabled: !!roleId });
  const r = q.data;
  const { guard, dialog } = useRecentAuth();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [scope, setScope] = useState<ScopeTypeValue>('workspace');
  const [perms, setPerms] = useState<Set<string>>(new Set());
  const [baseVersion, setBaseVersion] = useState<number | null>(null);
  const [loadedId, setLoadedId] = useState<string | null>(null);
  const qc = useQueryClient();
  const [impact, setImpact] = useState<RoleImpact | null>(null);
  const [conflict, setConflict] = useState(false);
  const [confirm, setConfirm] = useState<'reset' | 'archive' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const original = useMemo(() => new Set(r?.permissions ?? []), [r]);

  const load = (d: RoleDetail) => {
    setName(d.name);
    setDescription(d.description ?? '');
    setScope(d.defaultScopeType);
    setPerms(new Set(d.permissions));
    setBaseVersion(d.rowVersion);
    setLoadedId(d.id);
    setError(null);
  };
  useEffect(() => {
    // Initialise once per opened role; later refreshes never overwrite edits in progress
    // (a concurrent change surfaces as a version conflict on save).
    if (r && r.id !== loadedId) load(r);
    if (!roleId && loadedId) setLoadedId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [r, roleId]);
  const loaded = (d: RoleDetail) => {
    // Show the saved role at once instead of waiting for the refetch.
    qc.setQueryData(keyFor(roleEndpoints.get, { params: { workspaceId: workspace.id, roleId: d.id } }), d);
    load(d);
  };

  const dirty = !!r && (name.trim() !== r.name || (description.trim() || null) !== (r.description ?? null) || scope !== r.defaultScopeType || !sameSet(perms, original));
  const permsChanged = !!r && !sameSet(perms, original);
  const preview = useApiMutation(roleEndpoints.previewImpact, { silentErrors: true });
  const update = useApiMutation(roleEndpoints.update, { invalidate: ['roles.', 'team.'], successMessage: 'Role saved', silentErrors: true });
  const reset = useApiMutation(roleEndpoints.reset, { invalidate: ['roles.', 'team.'], successMessage: 'Role reset to the preset', silentErrors: true });
  const archive = useApiMutation(roleEndpoints.archive, { invalidate: ['roles.', 'team.'], successMessage: 'Role archived', silentErrors: true });
  const params = { workspaceId: workspace.id, roleId: roleId ?? '' };

  const save = async () => {
    if (!r) return;
    setError(null);
    try {
      const saved = await guard(() =>
        update.run(
          {
            params,
            body: {
              ...(name.trim() !== r.name ? { name: name.trim() } : {}),
              ...((description.trim() || null) !== (r.description ?? null) ? { description: description.trim() || null } : {}),
              ...(scope !== r.defaultScopeType ? { defaultScopeType: scope } : {}),
              ...(permsChanged ? { permissions: [...perms] } : {}),
            },
          },
          { ifMatch: baseVersion ?? r.rowVersion },
        ),
      );
      setImpact(null);
      loaded(saved);
    } catch (e) {
      if (isApiError(e) && e.code === 'VERSION_CONFLICT') {
        setImpact(null);
        setConflict(true);
      } else if (isApiError(e) && e.fieldErrors.length) setError(e.fieldErrors.map((f) => f.message).join(' '));
      else if (isApiError(e)) setError(e.message);
      else reportError(e);
    }
  };

  const review = async () => {
    if (!r) return;
    if (!permsChanged) return save();
    try {
      setImpact(await preview.run({ params, body: { permissions: [...perms] } }));
    } catch (e) {
      reportError(e, 'The impact could not be calculated.');
    }
  };

  return (
    <>
      <Drawer
        open={!!roleId}
        onOpenChange={(o) => !o && onClose()}
        width={760}
        dirty={dirty}
        title={r ? r.name : 'Role'}
        description={r ? (r.isPreset ? 'Preset role' : 'Custom role') + (r.basedOnKey && !r.isPreset ? ` · based on ${r.basedOnKey}` : '') : undefined}
        headerActions={
          r ? (
            <Menu
              label="Role actions"
              trigger={<IconButton label="Role actions" icon={<DotsThree size={18} weight="bold" />} variant="ghost" />}
              items={[
                { label: 'Clone Role', hidden: r.isProtected, onSelect: () => onClone(r) },
                { label: 'Reset to Preset', hidden: !r.isPreset || !r.presetDiff || !r.canEdit, onSelect: () => setConfirm('reset') },
                { label: 'Archive Role', hidden: r.isPreset || !!r.archivedAt || !r.canEdit, onSelect: () => setConfirm('archive'), destructive: true },
              ]}
            />
          ) : undefined
        }
        footer={
          r && r.canEdit && !r.archivedAt ? (
            <>
              <Button onClick={() => (r ? load(r) : undefined)} disabled={!dirty || update.isPending}>
                Discard Changes
              </Button>
              <Button variant="primary" disabled={!dirty || perms.size === 0 || name.trim().length < 2} loading={preview.isPending || update.isPending} onClick={() => void review()}>
                {permsChanged ? 'Review Changes' : 'Save Changes'}
              </Button>
            </>
          ) : (
            <Button onClick={onClose}>Close</Button>
          )
        }
      >
        {q.isLoading || !r ? (
          q.error ? (
            <Banner tone="danger">{q.error.status === 404 ? 'This role no longer exists.' : q.error.message}</Banner>
          ) : (
            <div className="flex flex-col gap-3" role="status" aria-label="Loading">
              <Skeleton className="h-8 w-1/2" />
              <Skeleton className="h-64 w-full" />
            </div>
          )
        ) : (
          <div className="flex flex-col gap-5">
            {r.isProtected ? <Banner tone="info">The Owner role is protected: it always holds every permission and changes only through ownership transfer.</Banner> : null}
            {r.archivedAt ? <Banner tone="warning">Archived on {formatDate(r.archivedAt, workspace.timezone)}. Archived roles cannot be granted or changed.</Banner> : null}
            {!r.canEdit && !r.isProtected && !r.archivedAt ? (
              <Banner tone="info">You can view this role but not change it: it contains permissions you cannot grant, or only the Owner may edit it.</Banner>
            ) : null}
            {r.presetDiff && (r.presetDiff.added.length || r.presetDiff.removed.length) ? (
              <Banner tone="info">
                Differs from the catalog preset: {r.presetDiff.added.length} added, {r.presetDiff.removed.length} removed.
                {r.canEdit ? ' Reset to Preset restores the catalog set.' : ''}
              </Banner>
            ) : null}
            {error ? <Banner tone="danger">{error}</Banner> : null}
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Field label="Name" required>
                <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} disabled={!r.canEdit || !!r.archivedAt} />
              </Field>
              <Field label="Default Scope" helper="Suggested when this role is granted; each grant sets its own scope.">
                <Select value={scope} onChange={(v) => setScope((v ?? 'workspace') as ScopeTypeValue)} options={scopeOptions} disabled={!r.canEdit || !!r.archivedAt} />
              </Field>
              <Field label="Description" className="md:col-span-2">
                <Textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={1000} rows={2} disabled={!r.canEdit || !!r.archivedAt} />
              </Field>
            </div>
            <section className="flex flex-col gap-2">
              <h3 className="text-[16px] font-semibold text-fg">Permissions</h3>
              <PermissionMatrix value={perms} onChange={setPerms} editable={r.canEdit && !r.archivedAt} original={original} />
            </section>
            <section className="flex flex-col gap-2">
              <h3 className="text-[16px] font-semibold text-fg">Members holding this role ({r.activeAssignments})</h3>
              {r.assignments.length ? (
                <DataTable
                  caption="Members holding this role"
                  density="compact"
                  rows={r.assignments}
                  getRowId={(a) => a.id}
                  columns={[
                    {
                      key: 'member',
                      header: 'Member',
                      sticky: true,
                      minWidth: 200,
                      cell: (a) => <MemberLink m={a.member} />,
                    },
                    { key: 'scope', header: 'Scope', minWidth: 180, cell: (a) => a.scopeLabel },
                    { key: 'from', header: 'Since', minWidth: 110, cell: (a) => formatDate(a.validFrom, workspace.timezone) },
                    { key: 'to', header: 'Until', minWidth: 110, cell: (a) => (a.validTo ? formatDateTime(a.validTo, workspace.timezone) : 'No end date') },
                  ]}
                />
              ) : (
                <p className="text-[13px] text-fg-2">Nobody holds this role.</p>
              )}
            </section>
          </div>
        )}
      </Drawer>
      <Dialog
        open={!!impact}
        onOpenChange={(o) => !o && setImpact(null)}
        title={`Apply changes to ${r?.name ?? 'role'}?`}
        description="Review what changes before applying. The change is audited."
        footer={
          <>
            <Button onClick={() => setImpact(null)} disabled={update.isPending}>
              Keep Editing
            </Button>
            <Button variant="primary" disabled={!!impact?.blocked} loading={update.isPending} onClick={() => void save()}>
              Apply Changes
            </Button>
          </>
        }
      >
        {impact ? <ImpactSummary impact={impact} /> : null}
      </Dialog>
      <ConfirmDialog
        open={confirm === 'reset'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Reset to the preset?"
        body={
          r?.presetDiff ? (
            <span>
              Restores the catalog permissions: {r.presetDiff.added.length} permission(s) you added are removed and {r.presetDiff.removed.length} removed permission(s) come back.{' '}
              {r.activeAssignments} member(s) holding this role are affected.
            </span>
          ) : (
            ''
          )
        }
        confirmLabel="Reset to Preset"
        loading={reset.isPending}
        onConfirm={async () => {
          if (!r) return;
          try {
            const d = await guard(() => reset.run({ params }, { ifMatch: baseVersion ?? r.rowVersion }));
            loaded(d);
            setConfirm(null);
          } catch (e) {
            if (isApiError(e) && e.code === 'VERSION_CONFLICT') {
              setConfirm(null);
              setConflict(true);
            } else reportError(e);
          }
        }}
      />
      <ConfirmDialog
        open={confirm === 'archive'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Archive this role?"
        destructive
        body={
          r && r.activeAssignments > 0
            ? `${r.activeAssignments} member(s) still hold this role. Revoke it from everyone first.`
            : 'The role can no longer be granted. Its history stays in the audit log.'
        }
        confirmDisabled={!!r && r.activeAssignments > 0}
        confirmLabel="Archive Role"
        loading={archive.isPending}
        onConfirm={async () => {
          if (!r) return;
          try {
            await guard(() => archive.run({ params, body: {} }, { ifMatch: baseVersion ?? r.rowVersion }));
            setConfirm(null);
            onClose();
          } catch (e) {
            reportError(e);
          }
        }}
      />
      <ConflictDialog
        open={conflict}
        onOpenChange={(o) => {
          setConflict(o);
          // Keep editing: compare against the newest version; the matrix marks what differs from it.
          if (!o) void q.refetch().then((res) => res.data && setBaseVersion(res.data.rowVersion));
        }}
        onReload={() => {
          setConflict(false);
          void q.refetch().then((res) => res.data && load(res.data));
        }}
      />
      {dialog}
    </>
  );
};

const MemberLink = ({ m }: { m: MemberRef }) => {
  const wsPath = useWsPath();
  return (
    <Link href={wsPath(`/team/${m.membershipId}`)} className="inline-flex items-center gap-2 hover:underline">
      <Avatar name={m.displayName} src={m.avatarUrl} size={24} decorative />
      {m.displayName}
    </Link>
  );
};

/** New custom role, optionally cloned from an existing role (permissions are copied and editable). */
export const CreateRoleDialog = ({
  open,
  onOpenChange,
  cloneFrom,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  cloneFrom: { id: string; name: string; permissions: string[]; defaultScopeType: ScopeTypeValue; description: string | null } | null;
  onCreated: (id: string) => void;
}) => {
  const { workspace } = useWorkspace();
  const { guard, dialog } = useRecentAuth();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [scope, setScope] = useState<ScopeTypeValue>('workspace');
  const [perms, setPerms] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const create = useApiMutation(roleEndpoints.create, { invalidate: ['roles.'], successMessage: 'Role created', silentErrors: true });
  useEffect(() => {
    if (!open) return;
    setName(cloneFrom ? `${cloneFrom.name} (copy)` : '');
    setDescription(cloneFrom?.description ?? '');
    setScope(cloneFrom?.defaultScopeType ?? 'workspace');
    setPerms(new Set(cloneFrom?.permissions ?? []));
    setErrors({});
    setError(null);
    // Only when the drawer opens (the clone source object is rebuilt on every parent render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, cloneFrom?.id]);
  return (
    <>
      <Drawer
        open={open}
        onOpenChange={onOpenChange}
        width={760}
        dirty={name.trim().length > 0 || perms.size > 0}
        title={cloneFrom ? `Clone ${cloneFrom.name}` : 'New Role'}
        description="Custom roles cannot include permissions you do not hold yourself. Finance permissions need the Owner."
        footer={
          <>
            <Button onClick={() => onOpenChange(false)} disabled={create.isPending}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={name.trim().length < 2 || perms.size === 0}
              loading={create.isPending}
              onClick={async () => {
                setErrors({});
                setError(null);
                try {
                  const r = await guard(() =>
                    create.run({
                      params: { workspaceId: workspace.id },
                      body: { name: name.trim(), description: description.trim() || null, defaultScopeType: scope, permissions: [...perms], cloneFromRoleId: cloneFrom?.id },
                    }),
                  );
                  onOpenChange(false);
                  onCreated(r.id);
                } catch (e) {
                  if (isApiError(e) && e.fieldErrors.length) setErrors(Object.fromEntries(e.fieldErrors.map((f) => [f.field.replace(/^body\./, ''), f.message])));
                  else if (isApiError(e)) setError(e.message);
                  else reportError(e);
                }
              }}
            >
              Create Role
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-5">
          {error ? <Banner tone="danger">{error}</Banner> : null}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Field label="Name" required error={errors.name}>
              <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus />
            </Field>
            <Field label="Default Scope" error={errors.defaultScopeType}>
              <Select value={scope} onChange={(v) => setScope((v ?? 'workspace') as ScopeTypeValue)} options={scopeOptions} />
            </Field>
            <Field label="Description" className="md:col-span-2" error={errors.description}>
              <Textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={1000} rows={2} />
            </Field>
          </div>
          {errors.permissions ? <Banner tone="danger">{errors.permissions}</Banner> : null}
          <PermissionMatrix value={perms} onChange={setPerms} editable />
        </div>
      </Drawer>
      {dialog}
    </>
  );
};
