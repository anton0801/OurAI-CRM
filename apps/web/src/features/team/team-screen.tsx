'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { DotsThree, EnvelopeSimple, UserPlus, UsersThree } from '@phosphor-icons/react';
import { useState } from 'react';
import { roleEndpoints, teamEndpoints, type InvitationRow, type MemberRow } from '@castlane/api-contracts';
import { INVITATION_STATUSES, MEMBERSHIP_STATUSES, RESPONSIBILITIES } from '@castlane/domain';
import {
  Avatar,
  Badge,
  Banner,
  Button,
  ConfirmDialog,
  DataTable,
  Dialog,
  EmptyState,
  Field,
  IconButton,
  Input,
  Menu,
  MultiSelect,
  NoResults,
  PageHeader,
  Select,
  StatusBadge,
  TabPanel,
  Tabs,
  Toolbar,
  formatDate,
  formatDateTime,
  toast,
  type Column,
  type SelectionState,
} from '@castlane/ui';
import { EntitySelect } from '@/components/common/entity-select';
import { DirectionSelect } from '@/components/common/pickers';
import { QueryState } from '@/components/common/query-state';
import { useDebounced } from '@/components/common/use-debounced';
import { useApiInfinite, useApiMutation, useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useUrlState } from '@/lib/url-state';
import { useCan, useWorkspace, useWsPath } from '@/lib/workspace-context';
import { InviteDrawer } from './invite-drawer';
import { dutyLabel } from './labels';

type Filters = 'tab' | 'q' | 'status' | 'roleId' | 'directionId' | 'projectId' | 'responsibility' | 'sort' | 'dir' | 'inv' | 'iq' | 'invite';

const dutyOptions = RESPONSIBILITIES.map((r) => ({ value: r, label: dutyLabel(r) }));

/** S61 Team: roster (filters in the URL), invitations with delivery status, new-invitation requests. */
export const TeamScreen = () => {
  const { workspace } = useWorkspace();
  const can = useCan();
  const router = useRouter();
  const wsPath = useWsPath();
  const { state, set, list } = useUrlState<Filters>({ tab: 'members', sort: 'name', dir: 'asc' });
  const [inviteOpen, setInviteOpen] = useState(state.invite === '1');
  const canInvite = can('members.invite');
  const requests = useApiQuery(teamEndpoints.invitationRequests, { params: { workspaceId: workspace.id }, query: { status: 'open' } }, { enabled: canInvite });
  const openRequests = requests.data?.length ?? 0;
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Team"
        description="People in this workspace, their roles, duties and assignments. Responsibilities describe work; roles grant access."
        actions={
          <>
            {canInvite ? (
              <Button variant="primary" icon={<UserPlus size={14} weight="bold" />} onClick={() => setInviteOpen(true)}>
                Invite
              </Button>
            ) : null}
            <Menu
              label="More team actions"
              trigger={<IconButton label="More team actions" icon={<DotsThree size={18} weight="bold" />} variant="secondary" />}
              items={[
                { label: 'Export Roster', hidden: !can('exports.create'), onSelect: () => router.push(wsPath('/exports?dataset=team_roster')) },
                { label: 'Directions', hidden: !can('directions.read'), onSelect: () => router.push(wsPath('/directions')) },
                { label: 'Roles and Access', hidden: !can('access.read'), onSelect: () => router.push(wsPath('/settings/access')) },
              ]}
            />
          </>
        }
      />
      <Tabs
        label="Team sections"
        value={state.tab ?? 'members'}
        onValueChange={(v) => set({ tab: v })}
        items={[
          { value: 'members', label: 'Members' },
          { value: 'invitations', label: 'Invitations', count: openRequests || undefined, hidden: !canInvite },
        ]}
      >
        <TabPanel value="members">{state.tab !== 'invitations' ? <MembersTab state={state} set={set} list={list} /> : null}</TabPanel>
        {canInvite ? <TabPanel value="invitations">{state.tab === 'invitations' ? <InvitationsTab state={state} set={set} list={list} onInvite={() => setInviteOpen(true)} /> : null}</TabPanel> : null}
      </Tabs>
      <InviteDrawer
        open={inviteOpen}
        onOpenChange={(o) => {
          setInviteOpen(o);
          if (!o && state.invite) set({ invite: null });
        }}
      />
    </div>
  );
};

type UrlProps = {
  state: Partial<Record<Filters, string>>;
  set: (p: Partial<Record<Filters, string | null>>) => void;
  list: (k: Filters) => string[];
};

const MembersTab = ({ state, set, list }: UrlProps) => {
  const { workspace, user } = useWorkspace();
  const can = useCan();
  const router = useRouter();
  const wsPath = useWsPath();
  const [search, setSearch] = useState(state.q ?? '');
  const q = useDebounced(search, 250);
  const [selection, setSelection] = useState<SelectionState>({ ids: new Set(), allMatching: false });
  const [bulkOpen, setBulkOpen] = useState(false);
  const roles = useApiQuery(roleEndpoints.list, { params: { workspaceId: workspace.id }, query: {} }, { enabled: can('access.read'), staleTime: 60_000 });
  const query = {
    q: q.length >= 2 ? q : undefined,
    status: list('status') as MemberRow['status'][],
    roleId: state.roleId,
    directionId: state.directionId,
    projectId: state.projectId,
    responsibility: state.responsibility as MemberRow['responsibilities'][number]['duty'] | undefined,
    sort: (state.sort ?? 'name') as 'name' | 'joinedAt' | 'status',
    direction: (state.dir ?? 'asc') as 'asc' | 'desc',
  };
  const data = useApiInfinite(teamEndpoints.list, { params: { workspaceId: workspace.id }, query });
  const filtered = !!(query.q || query.status.length || query.roleId || query.directionId || query.projectId || query.responsibility);
  const clear = () => {
    setSearch('');
    set({ q: null, status: null, roleId: null, directionId: null, projectId: null, responsibility: null });
  };
  const showMfa = data.items.some((m) => m.mfaEnabled !== undefined);
  const columns: Column<MemberRow>[] = [
    {
      key: 'name',
      header: 'Name',
      sortable: true,
      sticky: true,
      minWidth: 220,
      cell: (m) => (
        <span className="flex items-center gap-3">
          <Avatar name={m.displayName} src={m.avatarUrl} size={32} decorative />
          <span className="flex min-w-0 flex-col">
            <Link href={wsPath(`/team/${m.membershipId}`)} className="truncate font-medium text-fg hover:underline" onClick={(e) => e.stopPropagation()}>
              {m.displayName}
            </Link>
            {m.title ? <span className="truncate text-[12px] text-fg-2">{m.title}</span> : null}
          </span>
        </span>
      ),
    },
    { key: 'email', header: 'Email', minWidth: 200, cell: (m) => <span className="text-fg-2">{m.email ?? '—'}</span> },
    {
      key: 'status',
      header: 'Status',
      sortable: true,
      minWidth: 120,
      cell: (m) => (
        <span className="flex flex-wrap gap-1">
          <StatusBadge status={m.status} label={label('membershipStatus', m.status)} />
          {m.isOwner ? <Badge tone="primary">Owner</Badge> : null}
        </span>
      ),
    },
    {
      key: 'roles',
      header: 'Role',
      minWidth: 200,
      cell: (m) =>
        m.roles.length ? (
          <span className="flex flex-col" title={m.roles.map((r) => `${r.roleName} — ${r.scopeLabel}`).join('\n')}>
            <span className="truncate">{m.roles[0]!.roleName}</span>
            <span className="truncate text-[12px] text-fg-2">
              {m.roles[0]!.scopeLabel}
              {m.roles.length > 1 ? ` · +${m.roles.length - 1} more` : ''}
            </span>
          </span>
        ) : (
          <span className="text-fg-muted">No role</span>
        ),
    },
    {
      key: 'duties',
      header: 'Responsibilities',
      minWidth: 180,
      cell: (m) => (m.responsibilities.length ? <span className="line-clamp-2">{[...new Set(m.responsibilities.map((r) => dutyLabel(r.duty)))].join(', ')}</span> : <span className="text-fg-muted">—</span>),
    },
    { key: 'manager', header: 'Manager', minWidth: 150, cell: (m) => m.manager?.displayName ?? <span className="text-fg-muted">—</span> },
    { key: 'directions', header: 'Directions', minWidth: 160, cell: (m) => (m.directions.length ? m.directions.map((d) => d.name).join(', ') : <span className="text-fg-muted">—</span>) },
    {
      key: 'projects',
      header: 'Assigned Projects',
      minWidth: 180,
      cell: (m) =>
        m.projectCount ? (
          <span title={m.projects.map((p) => p.name).join(', ')}>
            {m.projects.slice(0, 2).map((p) => p.name).join(', ')}
            {m.projectCount > 2 ? ` +${m.projectCount - 2}` : ''}
          </span>
        ) : (
          <span className="text-fg-muted">None</span>
        ),
    },
    {
      key: 'workload',
      header: 'Open Tasks',
      align: 'right',
      minWidth: 110,
      cell: (m) => (m.openTasks === null ? <span className="font-sans text-fg-muted" title="You cannot see tasks, so the workload is unknown.">Unknown</span> : m.openTasks),
    },
    { key: 'mfa', header: 'Two-Factor', minWidth: 110, hidden: !showMfa, cell: (m) => (m.mfaEnabled ? <Badge tone="success">On</Badge> : <Badge>Off</Badge>) },
    { key: 'joinedAt', header: 'Joined', sortable: true, minWidth: 120, cell: (m) => formatDate(m.joinedAt, user.timezone) },
  ];
  const selectedIds = [...selection.ids];
  return (
    <div className="flex flex-col gap-4">
      <Toolbar>
        <div className="w-full sm:w-[220px]">
          <Input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              set({ q: e.target.value || null });
            }}
            placeholder="Search name, email, title"
            aria-label="Search members"
          />
        </div>
        <div className="w-[160px]">
          <MultiSelect aria-label="Status" placeholder="Active & suspended" value={list('status')} onChange={(v) => set({ status: v.join(',') || null })} options={MEMBERSHIP_STATUSES.map((s) => ({ value: s, label: label('membershipStatus', s) }))} />
        </div>
        {roles.data ? (
          <div className="w-[170px]">
            <Select aria-label="Role" placeholder="Role" clearable value={state.roleId} onChange={(v) => set({ roleId: v })} options={roles.data.map((r) => ({ value: r.id, label: r.name }))} />
          </div>
        ) : null}
        {can('directions.read') ? (
          <div className="w-[170px]">
            <DirectionSelect aria-label="Direction" placeholder="Direction" clearable value={state.directionId} onChange={(v) => set({ directionId: v })} />
          </div>
        ) : null}
        {can('projects.read') ? (
          <div className="w-[190px]">
            <EntitySelect type="project" aria-label="Project" placeholder="Project" clearable value={state.projectId} onChange={(v) => set({ projectId: v })} />
          </div>
        ) : null}
        <div className="w-[180px]">
          <Select aria-label="Responsibility" placeholder="Responsibility" clearable value={state.responsibility} onChange={(v) => set({ responsibility: v })} options={dutyOptions} />
        </div>
      </Toolbar>
      {selectedIds.length > 0 && can('members.update') ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => setBulkOpen(true)}>
            Assign Direction ({selectedIds.length})
          </Button>
        </div>
      ) : null}
      <QueryState query={data}>
        {data.items.length === 0 && !data.isFetching ? (
          filtered ? (
            <NoResults onClear={clear} />
          ) : (
            <EmptyState icon={<UsersThree size={28} />} title="No members to show" description="Members you can see appear here. Invite people to add them to the workspace." />
          )
        ) : (
          <DataTable
            caption="Team members"
            rows={data.items}
            columns={columns}
            getRowId={(m) => m.membershipId}
            density={user.density}
            sort={{ key: query.sort, direction: query.direction }}
            onSortChange={(s) => set({ sort: s.key === 'joinedAt' || s.key === 'status' ? s.key : 'name', dir: s.direction })}
            onRowClick={(m) => router.push(wsPath(`/team/${m.membershipId}`))}
            selection={can('members.update') ? selection : undefined}
            onSelectionChange={
              can('members.update')
                ? (s) => {
                    if (!s.allMatching) return setSelection(s);
                    // "Select All Matching": load every remaining page so the selection is exactly the filter result.
                    void (async () => {
                      let r = await data.fetchNextPage();
                      while (r.hasNextPage) r = await r.fetchNextPage();
                      const ids = (r.data?.pages ?? []).flatMap((p) => p.items.map((m) => m.membershipId));
                      if (ids.length > 200) toast.info('Bulk actions handle up to 200 members at a time', 'The first 200 matching members are selected.');
                      setSelection({ ids: new Set(ids.slice(0, 200)), allMatching: false });
                    })();
                  }
                : undefined
            }
            hasMore={data.hasNextPage}
            loadingMore={data.isFetchingNextPage}
            onLoadMore={() => void data.fetchNextPage()}
          />
        )}
      </QueryState>
      <BulkDirectionDialog
        open={bulkOpen}
        onOpenChange={setBulkOpen}
        members={data.items.filter((m) => selection.ids.has(m.membershipId))}
        onDone={() => setSelection({ ids: new Set(), allMatching: false })}
      />
    </div>
  );
};

const OUTCOME: Record<string, string> = { assigned: 'Assigned', already_assigned: 'Already had this duty', not_active: 'Not active — skipped', not_found: 'Not available — skipped' };

const BulkDirectionDialog = ({ open, onOpenChange, members, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; members: MemberRow[]; onDone: () => void }) => {
  const { workspace } = useWorkspace();
  const [directionId, setDirectionId] = useState<string | null>(null);
  const [duty, setDuty] = useState<string | null>(null);
  const [results, setResults] = useState<{ membershipId: string; outcome: string }[] | null>(null);
  const bulk = useApiMutation(teamEndpoints.bulkAssignDirection, { invalidate: ['team.'] });
  const close = () => {
    onOpenChange(false);
    setResults(null);
    setDirectionId(null);
    setDuty(null);
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => (o ? onOpenChange(o) : close())}
      title="Assign direction"
      description="Adds a duty in the direction to each selected member. Duties describe work — they never grant permissions."
      footer={
        results ? (
          <Button variant="primary" onClick={close}>
            Done
          </Button>
        ) : (
          <>
            <Button onClick={close}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!directionId || !duty || members.length === 0}
              loading={bulk.isPending}
              onClick={async () => {
                const r = await bulk.run({ params: { workspaceId: workspace.id }, body: { membershipIds: members.map((m) => m.membershipId), directionId: directionId!, duty: duty as never } });
                setResults(r.results);
                onDone();
                const n = r.results.filter((x) => x.outcome === 'assigned').length;
                toast.success(`${n} of ${r.results.length} members assigned`);
              }}
            >
              Assign to {members.length} member{members.length === 1 ? '' : 's'}
            </Button>
          </>
        )
      }
    >
      {results ? (
        <ul className="flex flex-col gap-1 text-[13px]" aria-live="polite">
          {results.map((r) => (
            <li key={r.membershipId} className="flex items-center justify-between gap-2">
              <span className="truncate">{members.find((m) => m.membershipId === r.membershipId)?.displayName ?? 'Member'}</span>
              <Badge tone={r.outcome === 'assigned' ? 'success' : r.outcome === 'already_assigned' ? 'neutral' : 'warning'}>{OUTCOME[r.outcome]}</Badge>
            </li>
          ))}
        </ul>
      ) : (
        <div className="flex flex-col gap-4">
          <Field label="Direction" required>
            <DirectionSelect value={directionId} onChange={setDirectionId} />
          </Field>
          <Field label="Responsibility" required>
            <Select value={duty} onChange={setDuty} options={dutyOptions} />
          </Field>
          <p className="text-[12px] text-fg-2">Selected: {members.map((m) => m.displayName).join(', ')}</p>
        </div>
      )}
    </Dialog>
  );
};

const InvitationsTab = ({ state, set, list, onInvite }: UrlProps & { onInvite: () => void }) => {
  const { workspace, user } = useWorkspace();
  const [search, setSearch] = useState(state.iq ?? '');
  const q = useDebounced(search, 250);
  const query = { status: list('inv') as InvitationRow['status'][], q: q.length >= 2 ? q : undefined };
  const data = useApiInfinite(teamEndpoints.invitations, { params: { workspaceId: workspace.id }, query });
  const requests = useApiQuery(teamEndpoints.invitationRequests, { params: { workspaceId: workspace.id }, query: { status: 'open' } });
  const resend = useApiMutation(teamEndpoints.resendInvitation, { invalidate: ['team.'], successMessage: (r) => r.message });
  const revoke = useApiMutation(teamEndpoints.revokeInvitation, { invalidate: ['team.'], successMessage: 'Invitation revoked. The link no longer works.' });
  const resolve = useApiMutation(teamEndpoints.resolveInvitationRequest, { invalidate: ['team.'], successMessage: (r) => r.message });
  const [revoking, setRevoking] = useState<InvitationRow | null>(null);
  const filtered = !!(query.status.length || query.q);
  const columns: Column<InvitationRow>[] = [
    { key: 'email', header: 'Email', sticky: true, minWidth: 220, cell: (i) => <span className="font-medium">{i.email}</span> },
    {
      key: 'status',
      header: 'Status',
      minWidth: 170,
      cell: (i) => (
        <span className="flex flex-wrap gap-1">
          <StatusBadge status={i.status} label={label('invitationStatus', i.status)} />
          {i.openRequest ? <Badge tone="warning">New invitation requested</Badge> : null}
        </span>
      ),
    },
    {
      key: 'delivery',
      header: 'Delivery',
      minWidth: 190,
      cell: (i) => (
        <span className="flex flex-col">
          <Badge tone={i.deliveryStatus === 'sent' ? 'success' : i.deliveryStatus === 'failed' ? 'danger' : 'neutral'}>{label('deliveryStatus', i.deliveryStatus)}</Badge>
          {i.deliveryError ? <span className="mt-0.5 text-[12px] text-danger">{i.deliveryError}</span> : null}
        </span>
      ),
    },
    { key: 'roles', header: 'Access', minWidth: 220, cell: (i) => i.grants.map((g) => `${g.roleName} (${g.scopeLabel})`).join(', ') },
    { key: 'by', header: 'Invited By', minWidth: 140, cell: (i) => i.invitedBy?.displayName ?? '—' },
    {
      key: 'when',
      header: 'Sent / Expires',
      minWidth: 190,
      cell: (i) => (
        <span className="flex flex-col text-[12px]">
          <span>{i.lastSentAt ? `Sent ${formatDateTime(i.lastSentAt, user.timezone)}` : `Created ${formatDateTime(i.createdAt, user.timezone)}`}</span>
          <span className="text-fg-2">{i.status === 'accepted' ? `Accepted by ${i.acceptedMember?.displayName ?? 'member'}` : `Expires ${formatDateTime(i.expiresAt, user.timezone)}`}</span>
        </span>
      ),
    },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      minWidth: 190,
      cell: (i) =>
        i.status === 'pending' || i.status === 'expired' ? (
          <span className="flex justify-end gap-1 font-sans">
            <Button size="sm" icon={<EnvelopeSimple size={14} />} loading={resend.isPending && resend.variables?.input.params?.invitationId === i.id} onClick={() => void resend.run({ params: { workspaceId: workspace.id, invitationId: i.id } })}>
              Resend
            </Button>
            <Button size="sm" variant="danger-secondary" onClick={() => setRevoking(i)}>
              Revoke
            </Button>
          </span>
        ) : null,
    },
  ];
  return (
    <div className="flex flex-col gap-4">
      {requests.data && requests.data.length > 0 ? (
        <section aria-labelledby="inv-requests" className="flex flex-col gap-2 rounded-[12px] border border-line bg-surface p-4">
          <h2 id="inv-requests" className="text-[14px] font-semibold text-fg">
            Requests for a new invitation
          </h2>
          <p className="text-[12px] text-fg-2">These people opened an expired or revoked link and asked for a new one.</p>
          <ul className="flex flex-col divide-y divide-line">
            {requests.data.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="flex min-w-0 flex-col">
                  <span className="font-medium text-fg">{r.email}</span>
                  <span className="text-[12px] text-fg-2">
                    Requested {formatDateTime(r.createdAt, user.timezone)} · {r.grants.map((g) => g.roleName).join(', ') || 'No role'}
                  </span>
                </span>
                <span className="flex gap-1">
                  <Button size="sm" variant="primary" onClick={() => void resolve.run({ params: { workspaceId: workspace.id, requestId: r.id }, body: { action: 'resend' } })}>
                    Send New Invitation
                  </Button>
                  <Button size="sm" onClick={() => void resolve.run({ params: { workspaceId: workspace.id, requestId: r.id }, body: { action: 'dismiss' } })}>
                    Dismiss
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <Toolbar>
        <div className="w-full sm:w-[220px]">
          <Input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              set({ iq: e.target.value || null });
            }}
            placeholder="Search email"
            aria-label="Search invitations"
          />
        </div>
        <div className="w-[170px]">
          <MultiSelect aria-label="Invitation status" placeholder="All statuses" value={list('inv')} onChange={(v) => set({ inv: v.join(',') || null })} options={INVITATION_STATUSES.map((s) => ({ value: s, label: label('invitationStatus', s) }))} />
        </div>
      </Toolbar>
      <Banner tone="info">Delivery status shows whether the mail server accepted the message. It is separate from acceptance.</Banner>
      <QueryState query={data}>
        {data.items.length === 0 && !data.isFetching ? (
          filtered ? (
            <NoResults
              onClear={() => {
                setSearch('');
                set({ iq: null, inv: null });
              }}
            />
          ) : (
            <EmptyState icon={<EnvelopeSimple size={28} />} title="No invitations yet" description="Invite people by e-mail with a role and scope." action={<Button variant="primary" onClick={onInvite}>Invite</Button>} />
          )
        ) : (
          <DataTable
            caption="Invitations"
            rows={data.items}
            columns={columns}
            getRowId={(i) => i.id}
            density={user.density}
            hasMore={data.hasNextPage}
            loadingMore={data.isFetchingNextPage}
            onLoadMore={() => void data.fetchNextPage()}
          />
        )}
      </QueryState>
      <ConfirmDialog
        open={!!revoking}
        onOpenChange={(o) => !o && setRevoking(null)}
        title="Revoke invitation?"
        body={`The link sent to ${revoking?.email ?? ''} stops working immediately. You can invite the address again later.`}
        confirmLabel="Revoke Invitation"
        destructive
        loading={revoke.isPending}
        onConfirm={async () => {
          if (!revoking) return;
          await revoke.run({ params: { workspaceId: workspace.id, invitationId: revoking.id } });
          setRevoking(null);
        }}
      />
    </div>
  );
};
