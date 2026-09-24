'use client';
import { Flask, Plus } from '@phosphor-icons/react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { experimentEndpoints as X, type ExperimentRow } from '@castlane/api-contracts';
import { EXPERIMENT_STATUSES } from '@castlane/domain';
import { Avatar, Button, DataTable, EmptyState, Input, MultiSelect, NoResults, PageHeader, StatusBadge, Switch, Toolbar, type Column } from '@castlane/ui';
import { EntitySelect } from '@/components/common/entity-select';
import { MemberSelect } from '@/components/common/pickers';
import { QueryState } from '@/components/common/query-state';
import { useDebounced } from '@/components/common/use-debounced';
import { useApiInfinite } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useUrlState } from '@/lib/url-state';
import { useCan, useWorkspace, useWsPath } from '@/lib/workspace-context';
import { ExperimentFormDrawer } from './experiment-form';
import { ORGANIC_CAVEAT, windowText } from './labels';

type Keys = 'q' | 'status' | 'projectId' | 'ownerMembershipId' | 'archived' | 'new' | 'open';

/** S35 Experiments: hypotheses about content formats and the observations that test them. */
export const ExperimentsScreen = () => {
  const { workspace, user } = useWorkspace();
  const can = useCan();
  const wsPath = useWsPath();
  const router = useRouter();
  const { state, set, list } = useUrlState<Keys>();
  const [search, setSearch] = useState(state.q ?? '');
  const q = useDebounced(search, 250);
  // `?open=<id>` (search results, notifications) opens the experiment page.
  useEffect(() => {
    if (state.open) router.replace(wsPath(`/experiments/${state.open}`));
  }, [state.open, router, wsPath]);
  const query = {
    q: q.length >= 2 ? q : undefined,
    status: list('status') as ExperimentRow['status'][],
    projectId: state.projectId,
    ownerMembershipId: state.ownerMembershipId,
    includeArchived: state.archived === '1' ? true : undefined,
  };
  const data = useApiInfinite(X.list, { params: { workspaceId: workspace.id }, query }, { enabled: !state.open });
  const filtered = !!(query.q || query.status.length || query.projectId || query.ownerMembershipId);
  const canCreate = can('experiments.write');

  const columns: Column<ExperimentRow>[] = [
    {
      key: 'hypothesis',
      header: 'Hypothesis',
      sticky: true,
      minWidth: 300,
      cell: (e) => (
        <Link href={wsPath(`/experiments/${e.id}`)} className="line-clamp-2 font-medium text-fg hover:underline" onClick={(ev) => ev.stopPropagation()}>
          {e.hypothesis}
        </Link>
      ),
    },
    { key: 'project', header: 'Project', minWidth: 140, cell: (e) => e.project.name },
    {
      key: 'owner',
      header: 'Owner',
      minWidth: 160,
      cell: (e) => (
        <span className="flex items-center gap-2">
          <Avatar name={e.owner.displayName} src={e.owner.avatarUrl} size={24} decorative />
          <span className="truncate">{e.owner.displayName}</span>
        </span>
      ),
    },
    { key: 'status', header: 'Status', minWidth: 110, cell: (e) => <StatusBadge status={e.status} label={label('experimentStatus', e.status)} /> },
    { key: 'metric', header: 'Primary metric', minWidth: 140, cell: (e) => e.primaryMetricLabel },
    { key: 'window', header: 'Window', minWidth: 120, cell: (e) => windowText(e.observationWindowHours) },
    { key: 'variants', header: 'Variants', minWidth: 180, cell: (e) => e.variants.map((v) => v.name).join(' · ') },
    { key: 'publications', header: 'Linked', align: 'right', minWidth: 80, cell: (e) => e.publicationCount },
  ];

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Experiments"
        description={`Save hypotheses about content formats and the observations that test them. ${ORGANIC_CAVEAT}`}
        crumbs={can('campaigns.read') ? [{ label: 'Campaigns', href: wsPath('/campaigns') }, { label: 'Experiments' }] : undefined}
        actions={
          canCreate ? (
            <Button variant="primary" icon={<Plus size={14} weight="bold" />} onClick={() => set({ new: '1' })}>
              New Experiment
            </Button>
          ) : undefined
        }
      />
      <Toolbar>
        <div className="w-full sm:w-[240px]">
          <Input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              set({ q: e.target.value || null });
            }}
            placeholder="Search hypotheses"
            aria-label="Search hypotheses"
          />
        </div>
        <div className="w-[160px]">
          <MultiSelect
            aria-label="Status"
            placeholder="Status"
            value={list('status')}
            onChange={(v) => set({ status: v.join(',') || null })}
            options={EXPERIMENT_STATUSES.filter((s) => s !== 'archived').map((s) => ({ value: s, label: label('experimentStatus', s) }))}
          />
        </div>
        <div className="w-[180px]">
          <EntitySelect type="project" aria-label="Project" placeholder="Project" value={state.projectId ?? null} onChange={(v) => set({ projectId: v })} clearable />
        </div>
        <div className="w-[180px]">
          <MemberSelect aria-label="Owner" placeholder="Owner" value={state.ownerMembershipId} onChange={(v) => set({ ownerMembershipId: v })} clearable />
        </div>
        <div className="flex items-center gap-2 px-1">
          <Switch label="Show archived" checked={state.archived === '1'} onCheckedChange={(v) => set({ archived: v ? '1' : null })} />
        </div>
      </Toolbar>
      <QueryState query={data}>
        {data.items.length === 0 && !data.isFetching ? (
          filtered ? (
            <NoResults
              onClear={() => {
                setSearch('');
                set({ q: null, status: null, projectId: null, ownerMembershipId: null });
              }}
            />
          ) : (
            <EmptyState
              icon={<Flask size={28} />}
              title="No experiments yet"
              description="Write down a hypothesis, define at least two variants and the metric to compare at the same post age."
              action={canCreate ? <Button variant="primary" onClick={() => set({ new: '1' })}>New Experiment</Button> : undefined}
            />
          )
        ) : (
          <DataTable
            caption="Experiments"
            rows={data.items}
            columns={columns}
            getRowId={(e) => e.id}
            density={user.density}
            onRowClick={(e) => router.push(wsPath(`/experiments/${e.id}`))}
            hasMore={data.hasNextPage}
            loadingMore={data.isFetchingNextPage}
            onLoadMore={() => void data.fetchNextPage()}
          />
        )}
      </QueryState>
      {state.new === '1' ? <ExperimentFormDrawer open onOpenChange={(o) => !o && set({ new: null })} initialProjectId={state.projectId} /> : null}
    </div>
  );
};
