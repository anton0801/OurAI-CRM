'use client';
import { ArrowSquareOut, Plus, UserCircle, UserPlus } from '@phosphor-icons/react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { accountEndpoints, type AccountSummary, type EndpointInput } from '@castlane/api-contracts';
import { ACCOUNT_STATUSES, PLATFORMS, RESPONSIBILITIES, isSafeUrl } from '@castlane/domain';
import {
  Avatar,
  Banner,
  Button,
  DataTable,
  Dialog,
  EmptyState,
  Field,
  Input,
  MultiSelect,
  NoResults,
  PageHeader,
  Select,
  StatusBadge,
  Switch,
  Toolbar,
  formatDate,
  formatDateTime,
  toast,
  type Column,
  type SelectionState,
} from '@castlane/ui';
import { EntitySelect } from '@/components/common/entity-select';
import { MemberSelect } from '@/components/common/pickers';
import { QueryState } from '@/components/common/query-state';
import { useDebounced } from '@/components/common/use-debounced';
import { api } from '@/lib/api';
import { useApiInfinite, useApiMutation } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useUrlState } from '@/lib/url-state';
import { useCan, useWorkspace, useWsPath } from '@/lib/workspace-context';
import { EMPTY_ACCOUNTS, NO_INTEGRATION_NOTE } from './labels';
import { PlatformLabel, accountTitle } from './platform';

type Filters = 'q' | 'platform' | 'status' | 'projectId' | 'ownerMembershipId' | 'mine' | 'tag' | 'archived' | 'sort' | 'dir';
type Sort = 'handle' | 'updatedAt' | 'status' | 'platform';

/**
 * S18 Accounts: responsibility and freshness at a glance. Filters, sort and scope live in the URL.
 * Used standalone and as the project workspace "Accounts" tab (fixed project).
 */
export const AccountsScreen = ({ projectId, embedded = false }: { projectId?: string; embedded?: boolean }) => {
  const { workspace, user, membershipId } = useWorkspace();
  const can = useCan();
  const wsPath = useWsPath();
  const router = useRouter();
  const { state, set, list } = useUrlState<Filters>({ sort: 'updatedAt', dir: 'desc' });
  const [search, setSearch] = useState(state.q ?? '');
  const q = useDebounced(search, 250);
  const [selection, setSelection] = useState<SelectionState>({ ids: new Set(), allMatching: false });
  const [assignOpen, setAssignOpen] = useState(false);
  const fixedProject = projectId ?? undefined;
  const query = {
    q: q.length >= 2 ? q : undefined,
    platform: list('platform') as AccountSummary['platform'][],
    status: list('status') as AccountSummary['status'][],
    projectId: fixedProject ?? state.projectId,
    ownerMembershipId: state.ownerMembershipId,
    assignedMembershipId: state.mine === '1' ? membershipId : undefined,
    tag: state.tag || undefined,
    includeArchived: state.archived === '1' ? true : undefined,
    sort: (state.sort ?? 'updatedAt') as Sort,
    direction: (state.dir ?? 'desc') as 'asc' | 'desc',
  };
  const data = useApiInfinite(accountEndpoints.list, { params: { workspaceId: workspace.id }, query });
  const filtered = !!(query.q || query.platform.length || query.status.length || (!fixedProject && query.projectId) || query.ownerMembershipId || query.assignedMembershipId || query.tag);
  const clear = () => {
    setSearch('');
    set({ q: null, platform: null, status: null, projectId: null, ownerMembershipId: null, mine: null, tag: null });
  };
  const newHref = wsPath(`/accounts/new${fixedProject ? `?projectId=${fixedProject}` : ''}`);
  const canAssign = can('accounts.assign');

  const columns: Column<AccountSummary>[] = [
    {
      key: 'handle',
      header: 'Account',
      sortable: true,
      sticky: true,
      minWidth: 240,
      cell: (a) => (
        <span className="flex items-center gap-3">
          <Avatar name={accountTitle(a).replace('@', '')} src={a.avatarUrl} size={32} decorative />
          <span className="flex min-w-0 flex-col">
            <Link href={wsPath(`/accounts/${a.id}`)} className="truncate font-medium text-fg hover:underline" onClick={(e) => e.stopPropagation()}>
              {accountTitle(a)}
            </Link>
            {a.displayName && a.handle ? <span className="truncate text-[12px] text-fg-2">{a.displayName}</span> : null}
          </span>
        </span>
      ),
    },
    { key: 'platform', header: 'Platform', sortable: true, minWidth: 130, cell: (a) => <PlatformLabel platform={a.platform} /> },
    { key: 'project', header: 'Project', minWidth: 150, hidden: !!fixedProject, cell: (a) => a.project.name },
    {
      key: 'owner',
      header: 'Owner',
      minWidth: 160,
      cell: (a) => (
        <span className="flex items-center gap-2">
          <Avatar name={a.owner.displayName} src={a.owner.avatarUrl} size={24} decorative />
          <span className="truncate">{a.owner.displayName}</span>
        </span>
      ),
    },
    { key: 'status', header: 'Status', sortable: true, minWidth: 120, cell: (a) => <StatusBadge status={a.status} label={label('accountStatus', a.status)} /> },
    {
      key: 'lastMetrics',
      header: 'Last Metrics At',
      minWidth: 150,
      cell: (a) => (a.lastMetricsAt ? formatDate(a.lastMetricsAt, user.timezone) : <span className="text-fg-muted">No data recorded</span>),
    },
    {
      key: 'next',
      header: 'Next Publication',
      minWidth: 170,
      cell: (a) => (a.nextPublicationAt ? formatDateTime(a.nextPublicationAt, user.timezone) : <span className="text-fg-muted">None planned</span>),
    },
    { key: 'missing', header: 'Missing Checkpoints', align: 'right', minWidth: 150, cell: (a) => (a.missingCheckpoints > 0 ? <span className="text-warning">{a.missingCheckpoints}</span> : 0) },
    {
      key: 'open',
      header: <span className="sr-only">Open external</span>,
      headerLabel: 'Open external',
      minWidth: 60,
      align: 'center',
      cell: (a) =>
        isSafeUrl(a.canonicalUrl) ? (
          <a
            href={a.canonicalUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            aria-label={`Open ${accountTitle(a)} on ${label('platform', a.platform)} in a new tab`}
            className="inline-flex h-11 w-11 items-center justify-center rounded-[8px] text-fg-2 hover:bg-surface-2 hover:text-fg md:h-8 md:w-8"
          >
            <ArrowSquareOut size={16} />
          </a>
        ) : null,
    },
  ];

  const toolbar = (
    <Toolbar>
      <div className="w-full sm:w-[220px]">
        <Input
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            set({ q: e.target.value || null });
          }}
          placeholder="Search handle or link"
          aria-label="Search accounts"
        />
      </div>
      <div className="w-[150px]">
        <MultiSelect aria-label="Platform" placeholder="Platform" value={list('platform')} onChange={(v) => set({ platform: v.join(',') || null })} options={PLATFORMS.map((p) => ({ value: p, label: label('platform', p) }))} />
      </div>
      <div className="w-[150px]">
        <MultiSelect
          aria-label="Status"
          placeholder="Status"
          value={list('status')}
          onChange={(v) => set({ status: v.join(',') || null })}
          options={ACCOUNT_STATUSES.filter((s) => s !== 'archived').map((s) => ({ value: s, label: label('accountStatus', s) }))}
        />
      </div>
      {!fixedProject ? (
        <div className="w-[180px]">
          <EntitySelect type="project" aria-label="Project" placeholder="Project" value={state.projectId} onChange={(v) => set({ projectId: v })} clearable />
        </div>
      ) : null}
      <div className="w-[170px]">
        <MemberSelect aria-label="Owner" placeholder="Owner" value={state.ownerMembershipId} onChange={(v) => set({ ownerMembershipId: v })} clearable />
      </div>
      <div className="w-[130px]">
        <Input value={state.tag ?? ''} onChange={(e) => set({ tag: e.target.value || null })} placeholder="Tag" aria-label="Tag" />
      </div>
      <div className="flex items-center gap-4 px-1">
        <Switch label="Assigned to me" checked={state.mine === '1'} onCheckedChange={(v) => set({ mine: v ? '1' : null })} />
        <Switch label="Show archived" checked={state.archived === '1'} onCheckedChange={(v) => set({ archived: v ? '1' : null })} />
      </div>
    </Toolbar>
  );

  const selectedCount = selection.allMatching ? null : selection.ids.size;
  return (
    <div className="flex flex-col gap-5">
      {!embedded ? (
        <PageHeader
          title="Accounts"
          description={NO_INTEGRATION_NOTE}
          actions={
            <>
              {canAssign && (selection.allMatching || selection.ids.size > 0) ? (
                <Button icon={<UserPlus size={14} />} onClick={() => setAssignOpen(true)}>
                  Assign{selectedCount ? ` (${selectedCount})` : ''}
                </Button>
              ) : null}
              {can('accounts.write') ? (
                <Button variant="primary" icon={<Plus size={14} weight="bold" />} onClick={() => router.push(newHref)}>
                  Add Account
                </Button>
              ) : null}
            </>
          }
        />
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[13px] text-fg-2">{NO_INTEGRATION_NOTE}</p>
          <div className="flex gap-2">
            {canAssign && (selection.allMatching || selection.ids.size > 0) ? (
              <Button icon={<UserPlus size={14} />} onClick={() => setAssignOpen(true)}>
                Assign{selectedCount ? ` (${selectedCount})` : ''}
              </Button>
            ) : null}
            {can('accounts.write') ? (
              <Button icon={<Plus size={14} />} onClick={() => router.push(newHref)}>
                Add Account
              </Button>
            ) : null}
          </div>
        </div>
      )}
      {toolbar}
      <QueryState query={data}>
        {data.items.length === 0 && !data.isFetching ? (
          filtered ? (
            <NoResults onClear={clear} />
          ) : (
            <EmptyState
              icon={<UserCircle size={28} />}
              title="No accounts yet"
              description={can('accounts.write') ? EMPTY_ACCOUNTS : 'No accounts are shared with you yet. Accounts appear here when you are assigned to them or to their project.'}
              action={can('accounts.write') ? <Button variant="primary" onClick={() => router.push(newHref)}>Add Account</Button> : undefined}
            />
          )
        ) : (
          <DataTable
            caption="Accounts"
            rows={data.items}
            columns={columns}
            getRowId={(a) => a.id}
            density={user.density}
            sort={{ key: query.sort, direction: query.direction }}
            onSortChange={(s) => set({ sort: s.key, dir: s.direction })}
            onRowClick={(a) => router.push(wsPath(`/accounts/${a.id}`))}
            selection={canAssign ? selection : undefined}
            onSelectionChange={canAssign ? setSelection : undefined}
            hasMore={data.hasNextPage}
            loadingMore={data.isFetchingNextPage}
            onLoadMore={() => void data.fetchNextPage()}
          />
        )}
      </QueryState>
      <BulkAssignDialog
        open={assignOpen}
        onOpenChange={setAssignOpen}
        selection={selection}
        query={query}
        onDone={() => setSelection({ ids: new Set(), allMatching: false })}
      />
    </div>
  );
};

type ListQuery = NonNullable<EndpointInput<typeof accountEndpoints.list>['query']>;

/** Bulk Assign: one member + duty on every selected account; each account is authorised separately. */
const BulkAssignDialog = ({
  open,
  onOpenChange,
  selection,
  query,
  onDone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  selection: SelectionState;
  query: ListQuery;
  onDone: () => void;
}) => {
  const { workspace } = useWorkspace();
  const [member, setMember] = useState<string | null>(null);
  const [duty, setDuty] = useState<string | null>('publishing');
  const [collecting, setCollecting] = useState(false);
  const [result, setResult] = useState<{ succeeded: number; failed: { id: string; message: string | null }[] } | null>(null);
  const bulk = useApiMutation(accountEndpoints.bulkAssign, { invalidate: ['accounts.'] });

  const collectIds = async (): Promise<string[]> => {
    if (!selection.allMatching) return [...selection.ids];
    // "Select All Matching": resolve the ids of every record that matches the current filters.
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await api.call(accountEndpoints.list, { params: { workspaceId: workspace.id }, query: { ...query, cursor, pageSize: 200 } });
      ids.push(...page.items.map((i) => i.id));
      cursor = page.hasMore ? (page.nextCursor ?? undefined) : undefined;
    } while (cursor && ids.length < 5000);
    return ids;
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setResult(null);
        onOpenChange(o);
      }}
      title="Assign a member to accounts"
      description={selection.allMatching ? 'All accounts matching the current filters.' : `${selection.ids.size} selected account(s).`}
      size="small"
      footer={
        result ? (
          <Button
            variant="primary"
            onClick={() => {
              setResult(null);
              onOpenChange(false);
              onDone();
            }}
          >
            Done
          </Button>
        ) : (
          <>
            <Button onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!member || !duty}
              loading={bulk.isPending || collecting}
              onClick={async () => {
                try {
                  setCollecting(true);
                  const ids = await collectIds();
                  setCollecting(false);
                  let succeeded = 0;
                  const failed: { id: string; message: string | null }[] = [];
                  for (let i = 0; i < ids.length; i += 200) {
                    const r = await bulk.run({ params: { workspaceId: workspace.id }, body: { accountIds: ids.slice(i, i + 200), membershipId: member!, duty: duty as never } });
                    succeeded += r.succeeded;
                    failed.push(...r.results.filter((x) => !x.ok).map((x) => ({ id: x.id, message: x.message })));
                  }
                  setResult({ succeeded, failed });
                  if (!failed.length) toast.success(`Assigned to ${succeeded} account(s)`);
                } catch {
                  setCollecting(false);
                }
              }}
            >
              Assign
            </Button>
          </>
        )
      }
    >
      {result ? (
        <div className="flex flex-col gap-3 text-[14px]">
          <p>
            Assigned to {result.succeeded} account(s).{result.failed.length ? ` ${result.failed.length} could not be assigned.` : ''}
          </p>
          {result.failed.length ? (
            <Banner tone="warning">
              <ul className="flex flex-col gap-1">
                {result.failed.slice(0, 10).map((f) => (
                  <li key={f.id}>{f.message ?? 'Not allowed'}</li>
                ))}
              </ul>
            </Banner>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <Field label="Member" required>
            <MemberSelect value={member} onChange={setMember} />
          </Field>
          <Field label="Duty" required>
            <Select value={duty} onChange={setDuty} options={RESPONSIBILITIES.map((r) => ({ value: r, label: label('responsibility', r) }))} />
          </Field>
          <p className="text-[12px] text-fg-2">Assignments limit what the member’s role covers; they grant no finance, OFM contact or restricted-media access.</p>
        </div>
      )}
    </Dialog>
  );
};

