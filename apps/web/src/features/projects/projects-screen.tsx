'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Briefcase, Plus, SquaresFour, Table } from '@phosphor-icons/react';
import { useState } from 'react';
import { projectEndpoints, type ProjectSummary } from '@castlane/api-contracts';
import { PROJECT_STATUSES, PROJECT_TYPES } from '@castlane/domain';
import {
  Avatar,
  Button,
  DataTable,
  EmptyState,
  Input,
  Menu,
  MultiSelect,
  NoResults,
  PageHeader,
  StatusBadge,
  Switch,
  Toolbar,
  formatDate,
  formatDateTime,
  formatMoney,
  humanize,
  type Column,
} from '@castlane/ui';
import { DirectionSelect, MemberSelect } from '@/components/common/pickers';
import { SavedViewsMenu } from '@/components/saved-views/saved-views-menu';
import { QueryState } from '@/components/common/query-state';
import { useDebounced } from '@/components/common/use-debounced';
import { useApiInfinite } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useUrlState } from '@/lib/url-state';
import { useCan, useWorkspace, useWsPath } from '@/lib/workspace-context';

type Filters = 'q' | 'status' | 'type' | 'directionId' | 'ownerMembershipId' | 'archived' | 'sort' | 'dir' | 'view';

/** S13 Projects: table (default) and compact gallery; filters, sort and view live in the URL. */
export const ProjectsScreen = () => {
  const { workspace, user } = useWorkspace();
  const can = useCan();
  const wsPath = useWsPath();
  const router = useRouter();
  const { state, set, list } = useUrlState<Filters>({ sort: 'updatedAt', dir: 'desc', view: 'table' });
  const [search, setSearch] = useState(state.q ?? '');
  const q = useDebounced(search, 250);
  const query = {
    q: q.length >= 2 ? q : undefined,
    status: list('status') as ProjectSummary['status'][],
    type: list('type') as ProjectSummary['type'][],
    directionId: state.directionId,
    ownerMembershipId: state.ownerMembershipId,
    includeArchived: state.archived === '1' ? true : undefined,
    sort: (state.sort ?? 'updatedAt') as 'name' | 'updatedAt' | 'status' | 'type',
    direction: (state.dir ?? 'desc') as 'asc' | 'desc',
  };
  const data = useApiInfinite(projectEndpoints.list, { params: { workspaceId: workspace.id }, query });
  const filtered = !!(query.q || query.status.length || query.type.length || query.directionId || query.ownerMembershipId);
  const showBudget = data.items.some((i) => i.budget !== undefined);

  const columns: Column<ProjectSummary>[] = [
    {
      key: 'name',
      header: 'Name',
      sortable: true,
      sticky: true,
      minWidth: 240,
      cell: (p) => (
        <span className="flex items-center gap-3">
          {p.coverUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={p.coverUrl} alt="" width={40} height={40} className="h-10 w-10 shrink-0 rounded-[8px] object-cover" loading="lazy" />
          ) : (
            <span aria-hidden className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[8px] bg-surface-2 text-[13px] font-semibold text-fg-2">
              {p.name.slice(0, 2).toUpperCase()}
            </span>
          )}
          <Link href={wsPath(`/projects/${p.id}`)} className="font-medium text-fg hover:underline" onClick={(e) => e.stopPropagation()}>
            {p.name}
          </Link>
        </span>
      ),
    },
    { key: 'type', header: 'Type', sortable: true, minWidth: 110, cell: (p) => label('projectType', p.type) },
    { key: 'direction', header: 'Direction', minWidth: 140, cell: (p) => p.direction.name },
    {
      key: 'owner',
      header: 'Owner',
      minWidth: 160,
      cell: (p) => (
        <span className="flex items-center gap-2">
          <Avatar name={p.owner.displayName} src={p.owner.avatarUrl} size={24} decorative />
          <span className="truncate">{p.owner.displayName}</span>
        </span>
      ),
    },
    { key: 'status', header: 'Status', sortable: true, minWidth: 110, cell: (p) => <StatusBadge status={p.status} /> },
    { key: 'openTasks', header: 'Open Tasks', align: 'right', minWidth: 100, cell: (p) => p.openTasks },
    { key: 'next', header: 'Next Publication', minWidth: 170, cell: (p) => (p.nextPublicationAt ? formatDateTime(p.nextPublicationAt, user.timezone) : <span className="text-fg-muted">None planned</span>) },
    { key: 'metrics', header: 'Metrics Updated', minWidth: 150, cell: (p) => (p.metricsUpdatedAt ? formatDate(p.metricsUpdatedAt, user.timezone) : <span className="text-fg-muted">No data recorded</span>) },
    {
      key: 'budget',
      header: 'Budget',
      align: 'right',
      minWidth: 140,
      hidden: !showBudget,
      cell: (p) => (p.budget ? formatMoney(p.budget.planned.amount, p.budget.planned.currency) : <span className="text-fg-muted">No budget</span>),
    },
  ];

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Projects"
        description="Series, models and influencers — with their teams, accounts, content and results."
        actions={
          <>
            {can('projects.create') ? (
              <Button variant="primary" icon={<Plus size={14} weight="bold" />} onClick={() => router.push(wsPath('/projects/new'))}>
                New Project
              </Button>
            ) : null}
            {can(['imports.create', 'exports.create']) ? (
              <Menu
                label="More project actions"
                trigger={<Button variant="ghost">More</Button>}
                items={[
                  { label: 'Import Projects', hidden: !can('imports.create'), onSelect: () => router.push(wsPath('/imports?new=1&dataset=projects')) },
                  { label: 'Export Projects', hidden: !can('exports.create'), onSelect: () => router.push(wsPath('/exports?new=1&dataset=projects')) },
                ]}
              />
            ) : null}
          </>
        }
      />
      <Toolbar>
        <SavedViewsMenu
          module="projects"
          params={{ q: 'text', status: 'list', type: 'list', directionId: 'id', ownerMembershipId: 'id', archived: 'flag' }}
          sort={{ key: 'sort', dir: 'dir' }}
          onApply={(v) => setSearch(v.q ?? '')}
        />
        <div className="w-full sm:w-[240px]">
          <Input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              set({ q: e.target.value || null });
            }}
            placeholder="Search projects"
            aria-label="Search projects"
          />
        </div>
        <div className="w-[160px]">
          <MultiSelect aria-label="Status" placeholder="Status" value={list('status')} onChange={(v) => set({ status: v.join(',') || null })} options={PROJECT_STATUSES.filter((s) => s !== 'archived').map((s) => ({ value: s, label: humanize(s) }))} />
        </div>
        <div className="w-[150px]">
          <MultiSelect aria-label="Type" placeholder="Type" value={list('type')} onChange={(v) => set({ type: v.join(',') || null })} options={PROJECT_TYPES.map((t) => ({ value: t, label: label('projectType', t) }))} />
        </div>
        <div className="w-[180px]">
          <DirectionSelect aria-label="Direction" placeholder="Direction" value={state.directionId} onChange={(v) => set({ directionId: v })} clearable />
        </div>
        <div className="w-[180px]">
          <MemberSelect aria-label="Owner" placeholder="Owner" value={state.ownerMembershipId} onChange={(v) => set({ ownerMembershipId: v })} clearable />
        </div>
        <div className="flex items-center gap-2 px-1">
          <Switch label="Show archived" checked={state.archived === '1'} onCheckedChange={(v) => set({ archived: v ? '1' : null })} />
        </div>
        <div className="ml-auto flex items-center gap-1" role="group" aria-label="View">
          <Button size="sm" variant={state.view !== 'gallery' ? 'secondary' : 'ghost'} icon={<Table size={14} />} aria-pressed={state.view !== 'gallery'} onClick={() => set({ view: 'table' })}>
            Table
          </Button>
          <Button size="sm" variant={state.view === 'gallery' ? 'secondary' : 'ghost'} icon={<SquaresFour size={14} />} aria-pressed={state.view === 'gallery'} onClick={() => set({ view: 'gallery' })}>
            Gallery
          </Button>
        </div>
      </Toolbar>
      <QueryState query={data}>
        {data.items.length === 0 && !data.isFetching ? (
          filtered ? (
            <NoResults onClear={() => { setSearch(''); set({ q: null, status: null, type: null, directionId: null, ownerMembershipId: null }); }} />
          ) : (
            <EmptyState
              icon={<Briefcase size={28} />}
              title="Start your first project"
              description="No projects yet. Create a project to organize its team, accounts, and content."
              action={can('projects.create') ? <Button variant="primary" onClick={() => router.push(wsPath('/projects/new'))}>New Project</Button> : undefined}
            />
          )
        ) : state.view === 'gallery' ? (
          <div className="flex flex-col gap-3">
            <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {data.items.map((p) => (
                <li key={p.id}>
                  <Link href={wsPath(`/projects/${p.id}`)} className="flex flex-col overflow-hidden rounded-[12px] border border-line bg-surface hover:border-fg-muted">
                    {p.coverUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={p.coverUrl} alt="" className="aspect-video w-full object-cover" loading="lazy" />
                    ) : (
                      <span aria-hidden className="flex aspect-video w-full items-center justify-center bg-surface-2 text-[28px] font-semibold text-fg-muted">
                        {p.name.slice(0, 2).toUpperCase()}
                      </span>
                    )}
                    <span className="flex flex-col gap-1 p-3">
                      <span className="truncate font-semibold text-fg">{p.name}</span>
                      <span className="flex items-center gap-2 text-[12px] text-fg-2">
                        {label('projectType', p.type)} · {p.direction.name}
                      </span>
                      <StatusBadge status={p.status} />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
            {data.hasNextPage ? (
              <div className="flex justify-center">
                <Button onClick={() => void data.fetchNextPage()} loading={data.isFetchingNextPage}>
                  Load More
                </Button>
              </div>
            ) : null}
          </div>
        ) : (
          <DataTable
            caption="Projects"
            rows={data.items}
            columns={columns}
            getRowId={(p) => p.id}
            density={user.density}
            sort={{ key: query.sort, direction: query.direction }}
            onSortChange={(s) => set({ sort: s.key, dir: s.direction })}
            onRowClick={(p) => router.push(wsPath(`/projects/${p.id}`))}
            hasMore={data.hasNextPage}
            loadingMore={data.isFetchingNextPage}
            onLoadMore={() => void data.fetchNextPage()}
          />
        )}
      </QueryState>
    </div>
  );
};
