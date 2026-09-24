'use client';
import Link from 'next/link';
import { Crown, Plus, ShieldCheck } from '@phosphor-icons/react';
import { useState } from 'react';
import { ownershipEndpoints, roleEndpoints, teamEndpoints, type GrantRow, type MemberRef, type OwnershipTransfer, type RoleDetail, type RoleRow } from '@castlane/api-contracts';
import {
  Avatar,
  Badge,
  Banner,
  Button,
  ConfirmDialog,
  DataTable,
  DescriptionList,
  EmptyState,
  Field,
  PageHeader,
  Panel,
  Select,
  Switch,
  TabPanel,
  Tabs,
  Toolbar,
  formatDate,
  formatDateTime,
  type Column,
} from '@castlane/ui';
import { MemberSelect } from '@/components/common/pickers';
import { QueryState } from '@/components/common/query-state';
import { useApiMutation, useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useUrlState } from '@/lib/url-state';
import { useCan, useWorkspace, useWsPath } from '@/lib/workspace-context';
import { ExplainAccess, RevokeGrantDialog } from '@/features/team/member-access-tab';
import { useGrantableRoles } from '@/features/team/grant-editor';
import { reportError, useRecentAuth } from '@/features/team/recent-auth';
import '@/features/team/labels';
import { CreateRoleDialog, RoleDrawer } from './role-editor';

type Keys = 'tab' | 'role' | 'grantRole' | 'grantMember' | 'revoked' | 'archived';

/** S63 Roles and Access: role presets and custom roles, grants, Explain Access and ownership transfer. */
export const AccessScreen = () => {
  const can = useCan();
  const wsPath = useWsPath();
  const { state, set } = useUrlState<Keys>({ tab: 'roles' });
  const tab = state.tab ?? 'roles';
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        crumbs={[{ label: 'Settings', href: wsPath('/settings') }, { label: 'Roles and Access' }]}
        title="Roles and Access"
        description="Roles grant permissions at a scope; responsibilities never do. Changes apply to open sessions on their next request and are audited."
      />
      <Tabs
        label="Access sections"
        value={tab}
        onValueChange={(v) => set({ tab: v })}
        items={[
          { value: 'roles', label: 'Roles' },
          { value: 'grants', label: 'Grants' },
          { value: 'explain', label: 'Explain Access' },
          { value: 'ownership', label: 'Ownership' },
        ]}
      >
        <TabPanel value="roles">{tab === 'roles' ? <RolesTab state={state} set={set} /> : null}</TabPanel>
        <TabPanel value="grants">{tab === 'grants' ? <GrantsTab state={state} set={set} /> : null}</TabPanel>
        <TabPanel value="explain">{tab === 'explain' ? <ExplainAccess allowMemberChoice /> : null}</TabPanel>
        <TabPanel value="ownership">{tab === 'ownership' ? <OwnershipTab canManage={can('access.manage')} /> : null}</TabPanel>
      </Tabs>
    </div>
  );
};

type TabProps = { state: Partial<Record<Keys, string>>; set: (p: Partial<Record<Keys, string | null>>) => void };

const RolesTab = ({ state, set }: TabProps) => {
  const { workspace } = useWorkspace();
  const can = useCan();
  const includeArchived = state.archived === '1';
  const q = useApiQuery(roleEndpoints.list, { params: { workspaceId: workspace.id }, query: { includeArchived: includeArchived || undefined } });
  const [creating, setCreating] = useState(false);
  const [cloneFrom, setCloneFrom] = useState<RoleDetail | RoleRow | null>(null);
  const columns: Column<RoleRow>[] = [
    {
      key: 'name',
      header: 'Role',
      sticky: true,
      minWidth: 220,
      cell: (r) => (
        <span className="flex flex-col">
          <span className="flex flex-wrap items-center gap-1.5 font-medium text-fg">
            {r.name}
            {r.isProtected ? <Badge tone="info">Protected</Badge> : r.isPreset ? <Badge>Preset</Badge> : <Badge tone="primary">Custom</Badge>}
            {r.sensitivePermissions.length ? <Badge tone="warning">Sensitive</Badge> : null}
            {r.archivedAt ? <Badge tone="danger">Archived</Badge> : null}
          </span>
          {r.description ? <span className="line-clamp-1 text-[12px] text-fg-2">{r.description}</span> : null}
        </span>
      ),
    },
    { key: 'scope', header: 'Default Scope', minWidth: 170, cell: (r) => label('scopeType', r.defaultScopeType) },
    { key: 'perms', header: 'Permissions', align: 'right', minWidth: 110, cell: (r) => r.permissions.length },
    { key: 'holders', header: 'Members', align: 'right', minWidth: 100, cell: (r) => r.activeAssignments },
    { key: 'updated', header: 'Updated', minWidth: 130, cell: (r) => formatDate(r.updatedAt, workspace.timezone) },
  ];
  return (
    <div className="flex flex-col gap-4">
      <Toolbar className="justify-between">
        <Switch checked={includeArchived} onCheckedChange={(v) => set({ archived: v ? '1' : null })} label="Show archived roles" />
        {can('access.manage') ? (
          <Button
            variant="primary"
            icon={<Plus size={14} weight="bold" />}
            onClick={() => {
              setCloneFrom(null);
              setCreating(true);
            }}
          >
            New Role
          </Button>
        ) : null}
      </Toolbar>
      <QueryState query={q}>
        <DataTable
          caption="Roles"
          rows={q.data ?? []}
          columns={columns}
          getRowId={(r) => r.id}
          onRowClick={(r) => set({ role: r.id })}
          selectedRowId={state.role ?? null}
          empty={<EmptyState icon={<ShieldCheck size={24} />} title="No roles" />}
        />
      </QueryState>
      <RoleDrawer
        roleId={state.role ?? null}
        onClose={() => set({ role: null })}
        onClone={(r) => {
          setCloneFrom(r);
          set({ role: null });
          setCreating(true);
        }}
      />
      <CreateRoleDialog
        open={creating}
        onOpenChange={setCreating}
        cloneFrom={cloneFrom ? { id: cloneFrom.id, name: cloneFrom.name, permissions: cloneFrom.permissions, defaultScopeType: cloneFrom.defaultScopeType, description: cloneFrom.description } : null}
        onCreated={(id) => set({ role: id })}
      />
    </div>
  );
};

const MemberCell = ({ m }: { m: MemberRef }) => {
  const wsPath = useWsPath();
  return (
    <Link href={wsPath(`/team/${m.membershipId}`)} className="inline-flex items-center gap-2 font-medium hover:underline">
      <Avatar name={m.displayName} src={m.avatarUrl} size={24} decorative />
      {m.displayName}
    </Link>
  );
};

const GrantsTab = ({ state, set }: TabProps) => {
  const { workspace } = useWorkspace();
  const roles = useApiQuery(roleEndpoints.list, { params: { workspaceId: workspace.id }, query: { includeArchived: true } }, { staleTime: 60_000 });
  const includeRevoked = state.revoked === '1';
  const q = useApiQuery(teamEndpoints.listRoleAssignments, {
    params: { workspaceId: workspace.id },
    query: { roleId: state.grantRole, membershipId: state.grantMember, includeRevoked: includeRevoked || undefined },
  });
  const { guard, dialog } = useRecentAuth();
  const [revoking, setRevoking] = useState<GrantRow | null>(null);
  type Row = GrantRow & { member: MemberRef };
  const columns: Column<Row>[] = [
    { key: 'member', header: 'Member', sticky: true, minWidth: 200, cell: (g) => <MemberCell m={g.member} /> },
    {
      key: 'role',
      header: 'Role',
      minWidth: 180,
      cell: (g) => (
        <span className="flex flex-wrap items-center gap-1.5">
          {g.roleName}
          {g.sensitive ? <Badge tone="warning">Sensitive</Badge> : null}
        </span>
      ),
    },
    { key: 'scope', header: 'Scope', minWidth: 200, cell: (g) => g.scopeLabel },
    { key: 'from', header: 'Since', minWidth: 110, cell: (g) => formatDate(g.validFrom, workspace.timezone) },
    {
      key: 'to',
      header: 'Until',
      minWidth: 150,
      cell: (g) =>
        g.revokedAt ? (
          <span className="text-fg-2">Revoked {formatDate(g.revokedAt, workspace.timezone)}</span>
        ) : g.validTo ? (
          formatDateTime(g.validTo, workspace.timezone)
        ) : (
          <span className="text-fg-2">No end date</span>
        ),
    },
    { key: 'by', header: 'Granted By', minWidth: 150, cell: (g) => g.grantedBy?.displayName ?? 'System' },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      headerLabel: 'Actions',
      align: 'right',
      minWidth: 100,
      cell: (g) =>
        g.canRevoke && !g.revokedAt ? (
          <Button size="sm" variant="ghost" onClick={() => setRevoking(g)}>
            Revoke
          </Button>
        ) : null,
    },
  ];
  return (
    <div className="flex flex-col gap-4">
      <Toolbar>
        <Field label="Role" className="min-w-[220px]">
          <Select
            value={state.grantRole ?? null}
            onChange={(v) => set({ grantRole: v })}
            clearable
            placeholder="Any role"
            options={(roles.data ?? []).map((r) => ({ value: r.id, label: r.archivedAt ? `${r.name} (archived)` : r.name }))}
          />
        </Field>
        <Field label="Member" className="min-w-[220px]">
          <MemberSelect value={state.grantMember ?? null} onChange={(v) => set({ grantMember: v })} clearable placeholder="Any member" />
        </Field>
        <div className="self-end pb-2">
          <Switch checked={includeRevoked} onCheckedChange={(v) => set({ revoked: v ? '1' : null })} label="Include ended and revoked" />
        </div>
      </Toolbar>
      <QueryState query={q}>
        <DataTable
          caption="Role grants"
          rows={(q.data ?? []) as Row[]}
          columns={columns}
          getRowId={(g) => g.id}
          virtualizeAbove={200}
          rowClassName={(g) => (g.revokedAt ? 'opacity-70' : undefined)}
          empty={<EmptyState icon={<ShieldCheck size={24} />} title="No grants match" description="Change the filters or grant roles from a member's Access tab." />}
        />
        {q.data && q.data.length >= 1000 ? <p className="text-[12px] text-fg-2">Showing the 1,000 most recent grants. Filter by role or member to narrow the list.</p> : null}
      </QueryState>
      {revoking ? <RevokeGrantDialog grant={revoking} guard={guard} onClose={() => setRevoking(null)} /> : null}
      {dialog}
    </div>
  );
};

/** T013: Owner proposes, recipient (with MFA) accepts; roles swap atomically. */
const OwnershipTab = ({ canManage }: { canManage: boolean }) => {
  const { workspace, isOwner, membershipId } = useWorkspace();
  const wsPath = useWsPath();
  const q = useApiQuery(ownershipEndpoints.current, { params: { workspaceId: workspace.id } });
  const { guard, dialog } = useRecentAuth();
  const roles = useGrantableRoles();
  const [to, setTo] = useState<string | null>(null);
  const [previousRole, setPreviousRole] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<'propose' | 'accept' | 'cancel' | null>(null);
  const propose = useApiMutation(ownershipEndpoints.propose, { invalidate: ['ownership.'], successMessage: 'Transfer proposed. The recipient has been notified.' });
  const accept = useApiMutation(ownershipEndpoints.accept, {
    invalidate: ['ownership.', 'team.', 'roles.'],
    successMessage: 'You are now the Owner',
    onSuccess: () => window.location.reload(),
  });
  const cancel = useApiMutation(ownershipEndpoints.cancel, { invalidate: ['ownership.'], successMessage: 'Transfer cancelled' });
  const t: OwnershipTransfer | null | undefined = q.data?.transfer;
  const previousRoleName = roles.data?.find((r) => r.id === previousRole)?.name;
  return (
    <QueryState query={q}>
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Panel title="Current Owner">
          {q.data?.owner ? (
            <div className="flex items-center gap-3">
              <Avatar name={q.data.owner.displayName} src={q.data.owner.avatarUrl} size={40} decorative />
              <div className="flex flex-col">
                <span className="flex items-center gap-2 text-[15px] font-semibold text-fg">
                  <Crown size={16} weight="fill" className="text-warning" aria-hidden />
                  {q.data.owner.displayName}
                </span>
                <span className="text-[13px] text-fg-2">Exactly one Owner. The Owner cannot be deactivated, suspended or restricted.</span>
              </div>
            </div>
          ) : (
            <p className="text-[13px] text-fg-2">The Owner is not visible to you.</p>
          )}
        </Panel>
        <Panel title="Ownership Transfer">
          {t && t.status === 'pending' ? (
            <div className="flex flex-col gap-4">
              <DescriptionList
                columns={1}
                items={[
                  { label: 'From', value: t.from.displayName },
                  { label: 'To', value: t.to.displayName },
                  { label: 'Previous Owner Keeps', value: t.previousOwnerRole ? t.previousOwnerRole.name : 'No role' },
                  { label: 'Proposed', value: formatDateTime(t.createdAt, workspace.timezone) },
                  { label: 'Expires', value: formatDateTime(t.expiresAt, workspace.timezone) },
                ]}
              />
              {t.canAccept && !t.recipientMfaEnabled ? (
                <Banner tone="warning" action={<Link href={wsPath('/settings/profile?tab=security')} className="text-[13px] font-semibold text-primary hover:underline">Set Up Two-Factor</Link>}>
                  Turn on two-factor authentication before accepting ownership.
                </Banner>
              ) : null}
              <div className="flex flex-wrap gap-2">
                {t.canAccept ? (
                  <Button variant="primary" disabled={!t.recipientMfaEnabled} onClick={() => setConfirm('accept')}>
                    Accept Ownership
                  </Button>
                ) : null}
                {t.canCancel ? (
                  <Button variant={t.to.membershipId === membershipId ? 'secondary' : 'danger'} onClick={() => setConfirm('cancel')}>
                    {t.to.membershipId === membershipId ? 'Decline' : 'Cancel Transfer'}
                  </Button>
                ) : null}
              </div>
            </div>
          ) : isOwner ? (
            <div className="flex flex-col gap-4">
              <p className="text-[13px] text-fg-2">
                The recipient must accept within 72 hours with two-factor authentication. Until then nothing changes. Afterwards you keep the role you choose below.
              </p>
              <Field label="New Owner" required helper="An active member of this workspace.">
                <MemberSelect value={to} onChange={setTo} />
              </Field>
              <Field label="Your Role Afterwards" helper="Leave empty to keep no role (you stay a member without access).">
                <Select value={previousRole} onChange={setPreviousRole} clearable placeholder="No role" options={(roles.data ?? []).map((r) => ({ value: r.id, label: r.name, description: r.description ?? undefined }))} />
              </Field>
              <div>
                <Button variant="primary" disabled={!to || to === membershipId} onClick={() => setConfirm('propose')}>
                  Propose Transfer
                </Button>
              </div>
            </div>
          ) : (
            <p className="text-[13px] text-fg-2">
              No transfer is pending. Only the Owner can propose one{canManage ? '; access managers see pending transfers here' : ''}.
            </p>
          )}
        </Panel>
      </div>
      <ConfirmDialog
        open={confirm === 'propose'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Propose an ownership transfer?"
        body={`The recipient becomes Owner only after accepting. You will then hold ${previousRoleName ?? 'no role'} instead of Owner.`}
        confirmLabel="Propose Transfer"
        loading={propose.isPending}
        onConfirm={async () => {
          try {
            await guard(() => propose.run({ params: { workspaceId: workspace.id }, body: { toMembershipId: to!, previousOwnerRoleId: previousRole } }));
            setConfirm(null);
          } catch (e) {
            reportError(e);
          }
        }}
      />
      <ConfirmDialog
        open={confirm === 'accept'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Accept ownership?"
        body={`You become the Owner of ${workspace.name}, with every permission including finance and ownership transfer. ${t?.from.displayName ?? 'The current Owner'} keeps ${t?.previousOwnerRole?.name ?? 'no role'}.`}
        confirmLabel="Accept Ownership"
        loading={accept.isPending}
        onConfirm={async () => {
          if (!t) return;
          try {
            await guard(() => accept.run({ params: { workspaceId: workspace.id, transferId: t.id } }));
            setConfirm(null);
          } catch (e) {
            reportError(e);
          }
        }}
      />
      <ConfirmDialog
        open={confirm === 'cancel'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={t?.to.membershipId === membershipId ? 'Decline ownership?' : 'Cancel the transfer?'}
        body="Nothing changes; the current Owner stays Owner."
        confirmLabel={t?.to.membershipId === membershipId ? 'Decline' : 'Cancel Transfer'}
        destructive
        loading={cancel.isPending}
        onConfirm={async () => {
          if (!t) return;
          try {
            await cancel.run({ params: { workspaceId: workspace.id, transferId: t.id }, body: {} });
            setConfirm(null);
          } catch (e) {
            reportError(e);
          }
        }}
      />
      {dialog}
    </QueryState>
  );
};
