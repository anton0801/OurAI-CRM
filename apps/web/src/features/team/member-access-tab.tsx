'use client';
import { CheckCircle, Prohibit, ShieldCheck, XCircle } from '@phosphor-icons/react';
import { useState } from 'react';
import { teamEndpoints, type DenyRow, type GrantRow, type MemberAccess, type MemberDetail } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { PERMISSION_GROUPS } from '@castlane/authorization';
import {
  Badge,
  Banner,
  Button,
  DataTable,
  DateTimeInput,
  Dialog,
  Field,
  MultiSelect,
  Panel,
  Select,
  Switch,
  Textarea,
  formatDate,
  formatDateTime,
  humanize,
  toast,
} from '@castlane/ui';
import { EntitySelect } from '@/components/common/entity-select';
import { DirectionSelect, MemberSelect } from '@/components/common/pickers';
import { QueryState } from '@/components/common/query-state';
import { useApiMutation, useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useWorkspace } from '@/lib/workspace-context';
import { draftComplete, newGrantDraft, ScopePicker, useGrantableRoles, type GrantDraft } from './grant-editor';
import { permissionLabel } from './labels';
import { reportError, useRecentAuth } from './recent-auth';

const PERMISSION_ONLY = Object.values(PERMISSION_GROUPS)
  .flat()
  .map((p) => ({ value: p as string, label: permissionLabel(p), description: p as string }));
/** Single permissions plus "prefix.*" patterns (e.g. every finance permission). */
const PERMISSION_OPTIONS = [
  ...[...new Set(Object.values(PERMISSION_GROUPS).flat().map((p) => p.split('.')[0]!))].map((prefix) => ({
    value: `${prefix}.*`,
    label: `All ${humanize(prefix.replace(/-/g, '_'))} permissions`,
    description: `${prefix}.*`,
  })),
  ...PERMISSION_ONLY,
];

/** Localise a datetime-local value (browser local time) to ISO. */
const localToIso = (v: string) => (v ? new Date(v).toISOString() : null);

export const MemberAccessTab = ({ m }: { m: MemberDetail }) => {
  const { workspace, user } = useWorkspace();
  const q = useApiQuery(teamEndpoints.access, { params: { workspaceId: workspace.id, membershipId: m.membershipId } });
  const { guard, dialog } = useRecentAuth();
  const [granting, setGranting] = useState(false);
  const [denying, setDenying] = useState(false);
  const [revoking, setRevoking] = useState<GrantRow | null>(null);
  const [removingDeny, setRemovingDeny] = useState<DenyRow | null>(null);
  const [onlyHeld, setOnlyHeld] = useState(true);
  return (
    <QueryState query={q}>
      {q.data ? (
        (() => {
          const a: MemberAccess = q.data;
          const grantCols = [
            {
              key: 'role',
              header: 'Role',
              sticky: true,
              minWidth: 180,
              cell: (g: GrantRow) => (
                <span className="flex flex-wrap items-center gap-1">
                  {g.roleName}
                  {g.sensitive ? <Badge tone="warning">Sensitive</Badge> : null}
                </span>
              ),
            },
            { key: 'scope', header: 'Scope', minWidth: 200, cell: (g: GrantRow) => g.scopeLabel },
            { key: 'from', header: 'Since', minWidth: 120, cell: (g: GrantRow) => formatDate(g.validFrom, user.timezone) },
            { key: 'to', header: 'Until', minWidth: 140, cell: (g: GrantRow) => (g.revokedAt ? `Revoked ${formatDate(g.revokedAt, user.timezone)}` : g.validTo ? formatDateTime(g.validTo, user.timezone) : 'No end') },
            { key: 'by', header: 'Granted By', minWidth: 140, cell: (g: GrantRow) => g.grantedBy?.displayName ?? (g.reason ?? '—') },
            {
              key: 'actions',
              header: <span className="sr-only">Actions</span>,
              align: 'right' as const,
              minWidth: 100,
              cell: (g: GrantRow) =>
                g.canRevoke ? (
                  <Button size="sm" variant="danger-secondary" className="font-sans" onClick={() => setRevoking(g)}>
                    Revoke
                  </Button>
                ) : null,
            },
          ];
          const perms = a.groups.flatMap((g) => g.permissions.map((p) => ({ ...p, group: g.key })));
          return (
            <div className="flex flex-col gap-5">
              <div className="flex flex-wrap items-center gap-2 text-[13px]">
                {a.isOwner ? <Badge tone="primary">Workspace Owner — holds every permission</Badge> : null}
                <Badge tone={a.mfa.enabled ? 'success' : a.mfa.required ? 'danger' : 'neutral'} icon={<ShieldCheck size={12} aria-hidden />}>
                  Two-factor {a.mfa.enabled ? 'on' : 'off'}
                  {a.mfa.required ? ' · required' : ''}
                </Badge>
                <span className="text-fg-2">Changes apply on the member’s next request; open pages reload.</span>
              </div>
              <Panel
                title="Role grants"
                actions={
                  a.canManage ? (
                    <Button size="sm" onClick={() => setGranting(true)}>
                      Grant Role
                    </Button>
                  ) : undefined
                }
                bodyClassName="p-4"
              >
                {a.grants.length ? <DataTable caption="Role grants" rows={a.grants} columns={grantCols} getRowId={(g) => g.id} density="compact" /> : <p className="text-[13px] text-fg-2">No role grants. The member cannot see workspace data until a role is granted.</p>}
              </Panel>
              <Panel
                title="Explicit denies"
                description="A deny wins over every grant."
                actions={
                  a.canManage && !a.isOwner ? (
                    <Button size="sm" icon={<Prohibit size={14} />} onClick={() => setDenying(true)}>
                      Add Deny
                    </Button>
                  ) : undefined
                }
              >
                {a.denies.length ? (
                  <ul className="flex flex-col divide-y divide-line">
                    {a.denies.map((d) => (
                      <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                        <span className="flex min-w-0 flex-col">
                          <span className="font-medium text-fg">
                            {d.permission.endsWith('.*') ? `All ${d.permission.slice(0, -2)} permissions` : permissionLabel(d.permission)}
                            {d.objectLabel ? ` — ${d.objectLabel}` : ' — everywhere'}
                          </span>
                          <span className="text-[12px] text-fg-2">
                            {d.reason} · {d.createdBy?.displayName ?? 'Unknown'} · {formatDate(d.createdAt, user.timezone)}
                          </span>
                        </span>
                        {d.canRevoke ? (
                          <Button size="sm" onClick={() => setRemovingDeny(d)}>
                            Remove Deny
                          </Button>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-[13px] text-fg-2">No explicit denies.</p>
                )}
              </Panel>
              <Panel
                title="Effective permissions"
                description="Held in at least one scope. Sensitive permissions are never implied by broader grants."
                actions={<Switch label="Only held" checked={onlyHeld} onCheckedChange={setOnlyHeld} />}
              >
                <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                  {a.groups.map((g) => {
                    const items = g.permissions.filter((p) => !onlyHeld || p.held || p.denied);
                    if (items.length === 0) return null;
                    return (
                      <section key={g.key} className="min-w-0">
                        <h3 className="mb-1 text-[13px] font-semibold text-fg">{label('permissionGroup', g.key)}</h3>
                        <ul className="flex flex-col gap-1">
                          {items.map((p) => (
                            <li key={p.key} className="flex items-start gap-2 text-[13px]">
                              {p.denied ? (
                                <XCircle size={16} className="mt-0.5 shrink-0 text-danger" aria-label="Denied" />
                              ) : p.held ? (
                                <CheckCircle size={16} weight="fill" className="mt-0.5 shrink-0 text-primary" aria-label="Held" />
                              ) : (
                                <XCircle size={16} className="mt-0.5 shrink-0 text-fg-muted" aria-label="Not held" />
                              )}
                              <span className="min-w-0">
                                <span className={p.held && !p.denied ? 'text-fg' : 'text-fg-2'}>{permissionLabel(p.key)}</span>
                                {p.sensitive ? <Badge tone="warning" className="ml-1">Sensitive</Badge> : null}
                                {p.denied ? <span className="ml-1 text-danger">Denied</span> : null}
                                {p.via.length ? <span className="block text-[12px] text-fg-2">{p.via.map((v) => `${v.roleName} · ${v.scopeLabel}`).join('; ')}</span> : null}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </section>
                    );
                  })}
                </div>
                {onlyHeld && perms.every((p) => !p.held && !p.denied) ? <p className="text-[13px] text-fg-2">No permissions are held.</p> : null}
              </Panel>
              <ExplainAccess membershipId={m.membershipId} />
              {a.history.length ? (
                <Panel title="Access history" description="Revoked and expired grants (kept for the record).">
                  <DataTable caption="Access history" rows={a.history} columns={grantCols.filter((c) => c.key !== 'actions')} getRowId={(g) => g.id} density="compact" />
                </Panel>
              ) : null}
              {granting ? <GrantRoleDialog m={m} guard={guard} onClose={() => setGranting(false)} /> : null}
              {denying ? <AddDenyDialog m={m} guard={guard} onClose={() => setDenying(false)} /> : null}
              {revoking ? <RevokeGrantDialog grant={revoking} guard={guard} onClose={() => setRevoking(null)} /> : null}
              {removingDeny ? <RemoveDenyDialog deny={removingDeny} guard={guard} onClose={() => setRemovingDeny(null)} /> : null}
              {dialog}
            </div>
          );
        })()
      ) : null}
    </QueryState>
  );
};

export type Guard = <T>(fn: () => Promise<T>) => Promise<T>;

const GrantRoleDialog = ({ m, guard, onClose }: { m: MemberDetail; guard: Guard; onClose: () => void }) => {
  const { workspace } = useWorkspace();
  const roles = useGrantableRoles();
  const [draft, setDraft] = useState<GrantDraft>(newGrantDraft());
  const [validTo, setValidTo] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const grant = useApiMutation(teamEndpoints.grantRole, { invalidate: ['team.', 'roles.'], silentErrors: true });
  const role = roles.data?.find((r) => r.id === draft.roleId);
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      dirty={!!draft.roleId}
      title={`Grant a role to ${m.displayName}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!draftComplete(draft)}
            loading={grant.isPending}
            onClick={async () => {
              setError(null);
              try {
                await guard(() =>
                  grant.run({
                    params: { workspaceId: workspace.id },
                    body: { membershipId: m.membershipId, roleId: draft.roleId!, scopeType: draft.scopeType, scopeId: draft.scopeId, validTo: localToIso(validTo), reason: reason.trim() || undefined },
                  }),
                );
                toast.success('Role granted', 'The member sees the change on their next request.');
                onClose();
              } catch (e) {
                if (isApiError(e) && e.code !== 'RECENT_AUTH_REQUIRED') setError(e.fieldErrors[0]?.message ?? e.message);
                else reportError(e);
              }
            }}
          >
            Grant Role
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <Field label="Role" required>
          <Select
            value={draft.roleId}
            onChange={(v) => setDraft({ ...draft, roleId: v, scopeType: roles.data?.find((r) => r.id === v)?.defaultScopeType ?? draft.scopeType, scopeId: null })}
            options={(roles.data ?? []).map((r) => ({ value: r.id, label: r.name, description: r.sensitive ? 'Contains sensitive permissions' : (r.description ?? undefined) }))}
            placeholder={roles.isLoading ? 'Loading…' : 'Choose a role'}
          />
        </Field>
        <ScopePicker idPrefix="grant-dialog" scopeType={draft.scopeType} scopeId={draft.scopeId} onChange={(t, id) => setDraft({ ...draft, scopeType: t, scopeId: id })} />
        {role?.sensitive ? <Banner tone="warning">This role includes sensitive permissions (finance, OFM contacts, restricted media or exports).</Banner> : null}
        <Field label="Ends" helper="Optional. Leave empty for no end date.">
          <DateTimeInput timezone={Intl.DateTimeFormat().resolvedOptions().timeZone} value={validTo} onChange={(e) => setValidTo(e.target.value)} />
        </Field>
        <Field label="Reason" helper="Recorded in the audit log.">
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} />
        </Field>
      </div>
    </Dialog>
  );
};

export const RevokeGrantDialog = ({ grant, guard, onClose }: { grant: GrantRow; guard: Guard; onClose: () => void }) => {
  const { workspace } = useWorkspace();
  const [reason, setReason] = useState('');
  const revoke = useApiMutation(teamEndpoints.revokeRole, { invalidate: ['team.', 'roles.'], silentErrors: true });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="small"
      title={`Revoke ${grant.roleName}?`}
      description={`${grant.scopeLabel}. Open sessions lose this access on their next request. Files already downloaded cannot be recalled.`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="danger"
            disabled={reason.trim().length < 3}
            loading={revoke.isPending}
            onClick={async () => {
              try {
                await guard(() => revoke.run({ params: { workspaceId: workspace.id, assignmentId: grant.id }, body: { reason: reason.trim() } }, { ifMatch: grant.rowVersion }));
                toast.success('Role revoked');
                onClose();
              } catch (e) {
                reportError(e);
                // Stale snapshot: close so it can be reopened from the refreshed list.
                if (isApiError(e) && e.code === 'VERSION_CONFLICT') onClose();
              }
            }}
          >
            Revoke Role
          </Button>
        </>
      }
    >
      <Field label="Reason" required>
        <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} />
      </Field>
    </Dialog>
  );
};

const AddDenyDialog = ({ m, guard, onClose }: { m: MemberDetail; guard: Guard; onClose: () => void }) => {
  const { workspace } = useWorkspace();
  const [permission, setPermission] = useState<string | null>(null);
  const [objectType, setObjectType] = useState<'none' | 'project' | 'account' | 'direction'>('none');
  const [objectId, setObjectId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const add = useApiMutation(teamEndpoints.addDeny, { invalidate: ['team.'], silentErrors: true });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      dirty={!!permission}
      title={`Restrict ${m.displayName}`}
      description="An explicit deny overrides every role grant for the chosen permission."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="danger"
            disabled={!permission || reason.trim().length < 3 || (objectType !== 'none' && !objectId)}
            loading={add.isPending}
            onClick={async () => {
              setError(null);
              try {
                await guard(() =>
                  add.run({
                    params: { workspaceId: workspace.id },
                    body: { membershipId: m.membershipId, permission: permission!, objectType: objectType === 'none' ? null : objectType, objectId: objectType === 'none' ? null : objectId, reason: reason.trim() },
                  }),
                );
                toast.success('Deny added');
                onClose();
              } catch (e) {
                if (isApiError(e) && e.code !== 'RECENT_AUTH_REQUIRED') setError(e.message);
                else reportError(e);
              }
            }}
          >
            Add Deny
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <Field label="Permission" required>
          <Select value={permission} onChange={setPermission} options={PERMISSION_OPTIONS} searchable />
        </Field>
        <Field label="Applies to" required>
          <Select
            value={objectType}
            onChange={(v) => {
              setObjectType((v ?? 'none') as typeof objectType);
              setObjectId(null);
            }}
            options={[
              { value: 'none', label: 'Everywhere' },
              { value: 'direction', label: 'One direction' },
              { value: 'project', label: 'One project' },
              { value: 'account', label: 'One account' },
            ]}
          />
        </Field>
        {objectType === 'direction' ? (
          <Field label="Direction" required>
            <DirectionSelect value={objectId} onChange={setObjectId} />
          </Field>
        ) : objectType === 'project' ? (
          <Field label="Project" required>
            <EntitySelect type="project" value={objectId} onChange={setObjectId} />
          </Field>
        ) : objectType === 'account' ? (
          <Field label="Account" required>
            <EntitySelect type="account" value={objectId} onChange={setObjectId} />
          </Field>
        ) : null}
        <Field label="Reason" required>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} />
        </Field>
      </div>
    </Dialog>
  );
};

const RemoveDenyDialog = ({ deny, guard, onClose }: { deny: DenyRow; guard: Guard; onClose: () => void }) => {
  const { workspace } = useWorkspace();
  const remove = useApiMutation(teamEndpoints.revokeDeny, { invalidate: ['team.'], silentErrors: true });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="small"
      title="Remove this deny?"
      description="Role grants apply again for this permission."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={remove.isPending}
            onClick={async () => {
              try {
                await guard(() => remove.run({ params: { workspaceId: workspace.id, denyId: deny.id }, body: {} }, { ifMatch: deny.rowVersion }));
                toast.success('Deny removed');
                onClose();
              } catch (e) {
                reportError(e);
                // Stale snapshot: close so it can be reopened from the refreshed list.
                if (isApiError(e) && e.code === 'VERSION_CONFLICT') onClose();
              }
            }}
          >
            Remove Deny
          </Button>
        </>
      }
    >
      <p className="text-[14px]">{permissionLabel(deny.permission)}{deny.objectLabel ? ` — ${deny.objectLabel}` : ''}</p>
    </Dialog>
  );
};

/** "Explain Access": does this member hold these permissions, optionally on one object? */
export const ExplainAccess = ({ membershipId, allowMemberChoice = false }: { membershipId?: string; allowMemberChoice?: boolean }) => {
  const { workspace } = useWorkspace();
  const [member, setMember] = useState<string | null>(membershipId ?? null);
  const [permissions, setPermissions] = useState<string[]>(['projects.read']);
  const [objectType, setObjectType] = useState<'none' | 'project' | 'account' | 'direction'>('none');
  const [objectId, setObjectId] = useState<string | null>(null);
  const evaluate = useApiMutation(teamEndpoints.evaluateAccess, { silentErrors: true });
  const result = evaluate.data;
  return (
    <Panel title="Explain Access" description="Why a member can or cannot do something, optionally on one project, account or direction.">
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {allowMemberChoice ? (
            <Field label="Member" required>
              <MemberSelect value={member} onChange={setMember} />
            </Field>
          ) : null}
          <Field label="Permissions" required>
            <MultiSelect value={permissions} onChange={setPermissions} options={PERMISSION_ONLY} max={20} searchable />
          </Field>
          <Field label="Object">
            <Select
              value={objectType}
              onChange={(v) => {
                setObjectType((v ?? 'none') as typeof objectType);
                setObjectId(null);
              }}
              options={[
                { value: 'none', label: 'Anywhere in the workspace' },
                { value: 'project', label: 'A project' },
                { value: 'account', label: 'An account' },
                { value: 'direction', label: 'A direction' },
              ]}
            />
          </Field>
          {objectType === 'project' ? (
            <Field label="Project" required>
              <EntitySelect type="project" value={objectId} onChange={setObjectId} />
            </Field>
          ) : objectType === 'account' ? (
            <Field label="Account" required>
              <EntitySelect type="account" value={objectId} onChange={setObjectId} />
            </Field>
          ) : objectType === 'direction' ? (
            <Field label="Direction" required>
              <DirectionSelect value={objectId} onChange={setObjectId} />
            </Field>
          ) : null}
        </div>
        <div>
          <Button
            variant="primary"
            disabled={!member || permissions.length === 0 || (objectType !== 'none' && !objectId)}
            loading={evaluate.isPending}
            onClick={() =>
              void evaluate
                .run({
                  params: { workspaceId: workspace.id },
                  body: { membershipId: member!, permissions, object: objectType === 'none' ? null : { type: objectType, id: objectId! } },
                })
                .catch((e) => reportError(e, 'Access could not be evaluated.'))
            }
          >
            Explain
          </Button>
        </div>
        {result ? (
          <div className="flex flex-col gap-2" aria-live="polite">
            <p className="text-[13px] text-fg-2">
              {result.member.displayName}
              {result.object ? ` · ${result.object.label}` : ' · anywhere'}
            </p>
            <ul className="flex flex-col divide-y divide-line rounded-[8px] border border-line">
              {result.results.map((r) => (
                <li key={r.permission} className="flex items-start gap-2 px-3 py-2 text-[13px]">
                  {r.allowed ? <CheckCircle size={16} weight="fill" className="mt-0.5 shrink-0 text-primary" aria-hidden /> : <XCircle size={16} className="mt-0.5 shrink-0 text-danger" aria-hidden />}
                  <span>
                    <span className="font-medium">{permissionLabel(r.permission)}</span> — {r.allowed ? 'Allowed' : 'Not allowed'}. {r.reason}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </Panel>
  );
};
