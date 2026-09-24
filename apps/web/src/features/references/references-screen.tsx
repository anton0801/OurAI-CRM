'use client';
import { Lightbulb, Plus, SquaresFour, Table } from '@phosphor-icons/react';
import { useState } from 'react';
import { referenceEndpoints, type ReferenceRow } from '@castlane/api-contracts';
import { REFERENCE_TAGS } from '@castlane/domain';
import {
  Avatar,
  Badge,
  Button,
  DataTable,
  EmptyState,
  Input,
  MultiSelect,
  NoResults,
  PageHeader,
  StatusBadge,
  Switch,
  Toolbar,
  formatDate,
  type Column,
} from '@castlane/ui';
import { EntitySelect } from '@/components/common/entity-select';
import { MemberSelect } from '@/components/common/pickers';
import { QueryState } from '@/components/common/query-state';
import { useDebounced } from '@/components/common/use-debounced';
import { useApiInfinite } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useUrlState } from '@/lib/url-state';
import { useCan, useWorkspace } from '@/lib/workspace-context';
import '@/features/accounts/labels';
import { ReferenceDrawer } from './reference-drawer';

type Filters = 'q' | 'tag' | 'projectId' | 'ownerMembershipId' | 'archived' | 'view' | 'open' | 'create' | 'sort' | 'dir';

const Preview = ({ r, className }: { r: ReferenceRow; className: string }) =>
  r.previewUrl ? (
    // User-uploaded preview only (links are never fetched).
    // eslint-disable-next-line @next/next/no-img-element
    <img src={r.previewUrl} alt="" loading="lazy" className={`${className} bg-surface-2 object-cover`} onError={(e) => ((e.target as HTMLImageElement).style.visibility = 'hidden')} />
  ) : (
    <span aria-hidden className={`${className} flex items-center justify-center bg-surface-2 px-3 text-center text-[13px] font-semibold text-fg-muted`}>
      {r.title.slice(0, 40)}
    </span>
  );

/** S21 References: gallery (default) or table; drawer for details, create and edit. */
export const ReferencesScreen = ({ projectId, embedded = false }: { projectId?: string; embedded?: boolean }) => {
  const { workspace, user } = useWorkspace();
  const can = useCan();
  const { state, set, list } = useUrlState<Filters>({ view: 'gallery', sort: 'updatedAt', dir: 'desc' });
  const [search, setSearch] = useState(state.q ?? '');
  const q = useDebounced(search, 250);
  const query = {
    q: q.length >= 2 ? q : undefined,
    tag: list('tag') as ReferenceRow['tags'],
    projectId: projectId ?? state.projectId,
    ownerMembershipId: state.ownerMembershipId,
    includeArchived: state.archived === '1' ? true : undefined,
    sort: (state.sort ?? 'updatedAt') as 'updatedAt' | 'title' | 'createdAt',
    direction: (state.dir ?? 'desc') as 'asc' | 'desc',
  };
  const data = useApiInfinite(referenceEndpoints.list, { params: { workspaceId: workspace.id }, query });
  const filtered = !!(query.q || query.tag.length || (!projectId && query.projectId) || query.ownerMembershipId);
  const canWrite = can('references.write');
  const clear = () => {
    setSearch('');
    set({ q: null, tag: null, projectId: null, ownerMembershipId: null });
  };
  const columns: Column<ReferenceRow>[] = [
    {
      key: 'title',
      header: 'Title',
      sortable: true,
      sticky: true,
      minWidth: 260,
      cell: (r) => (
        <span className="flex items-center gap-3">
          <Preview r={r} className="h-12 w-16 shrink-0 rounded-[8px]" />
          <span className="truncate font-medium">{r.title}</span>
        </span>
      ),
    },
    { key: 'tags', header: 'Tags', minWidth: 160, cell: (r) => <span className="flex flex-wrap gap-1">{r.tags.map((t) => <Badge key={t}>{label('referenceTag', t)}</Badge>)}</span> },
    { key: 'project', header: 'Project', minWidth: 150, hidden: !!projectId, cell: (r) => r.project?.name ?? <span className="text-fg-2">Workspace</span> },
    { key: 'author', header: 'Author', minWidth: 150, cell: (r) => r.author.displayName },
    { key: 'source', header: 'Source', minWidth: 120, cell: (r) => (r.sourceUrl ? 'Link' : r.sourceAsset ? 'File' : '—') },
    { key: 'usage', header: 'Used In', align: 'right', minWidth: 90, cell: (r) => r.usage.content + r.usage.projects + r.usage.characters },
    { key: 'createdAt', header: 'Added', sortable: true, minWidth: 120, cell: (r) => formatDate(r.createdAt, user.timezone) },
  ];

  return (
    <div className="flex flex-col gap-5">
      {!embedded ? (
        <PageHeader
          title="References"
          description="Ideas and techniques worth reusing. Links are kept as notes — nothing is downloaded from them."
          actions={
            canWrite ? (
              <Button variant="primary" icon={<Plus size={14} weight="bold" />} onClick={() => set({ create: '1' })}>
                Add Reference
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="flex justify-end">
          {canWrite ? (
            <Button icon={<Plus size={14} />} onClick={() => set({ create: '1' })}>
              Add Reference
            </Button>
          ) : null}
        </div>
      )}
      <Toolbar>
        <div className="w-full sm:w-[220px]">
          <Input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              set({ q: e.target.value || null });
            }}
            placeholder="Search references"
            aria-label="Search references"
          />
        </div>
        <div className="w-[170px]">
          <MultiSelect aria-label="Tags" placeholder="Tags" value={list('tag')} onChange={(v) => set({ tag: v.join(',') || null })} options={REFERENCE_TAGS.map((t) => ({ value: t, label: label('referenceTag', t) }))} />
        </div>
        {!projectId ? (
          <div className="w-[180px]">
            <EntitySelect type="project" aria-label="Project" placeholder="Project" value={state.projectId} onChange={(v) => set({ projectId: v })} clearable />
          </div>
        ) : null}
        <div className="w-[170px]">
          <MemberSelect aria-label="Author" placeholder="Author" value={state.ownerMembershipId} onChange={(v) => set({ ownerMembershipId: v })} clearable />
        </div>
        <div className="px-1">
          <Switch label="Show archived" checked={state.archived === '1'} onCheckedChange={(v) => set({ archived: v ? '1' : null })} />
        </div>
        <div className="ml-auto flex items-center gap-1" role="group" aria-label="View">
          <Button size="sm" variant={state.view !== 'table' ? 'secondary' : 'ghost'} icon={<SquaresFour size={14} />} aria-pressed={state.view !== 'table'} onClick={() => set({ view: 'gallery' })}>
            Gallery
          </Button>
          <Button size="sm" variant={state.view === 'table' ? 'secondary' : 'ghost'} icon={<Table size={14} />} aria-pressed={state.view === 'table'} onClick={() => set({ view: 'table' })}>
            Table
          </Button>
        </div>
      </Toolbar>
      <QueryState query={data}>
        {data.items.length === 0 && !data.isFetching ? (
          filtered ? (
            <NoResults onClear={clear} />
          ) : (
            <EmptyState
              icon={<Lightbulb size={28} />}
              title="No references yet"
              description={canWrite ? 'Save links or files that show a hook, lighting, story beat or edit worth reusing.' : 'No references are shared with you yet.'}
              action={canWrite ? <Button variant="primary" onClick={() => set({ create: '1' })}>Add Reference</Button> : undefined}
            />
          )
        ) : state.view === 'table' ? (
          <DataTable
            caption="References"
            rows={data.items}
            columns={columns}
            getRowId={(r) => r.id}
            density={user.density}
            sort={{ key: query.sort, direction: query.direction }}
            onSortChange={(s) => set({ sort: s.key, dir: s.direction })}
            onRowClick={(r) => set({ open: r.id }, { replace: false })}
            selectedRowId={state.open ?? null}
            hasMore={data.hasNextPage}
            loadingMore={data.isFetchingNextPage}
            onLoadMore={() => void data.fetchNextPage()}
          />
        ) : (
          <div className="flex flex-col gap-3">
            <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {data.items.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => set({ open: r.id }, { replace: false })}
                    className="flex w-full flex-col overflow-hidden rounded-[12px] border border-line bg-surface text-left hover:border-fg-muted focus-visible:outline-2 focus-visible:outline-[var(--c-focus)]"
                  >
                    <Preview r={r} className="aspect-[4/3] w-full" />
                    <span className="flex flex-col gap-1.5 p-3">
                      <span className="line-clamp-2 font-semibold text-fg">{r.title}</span>
                      <span className="line-clamp-2 text-[13px] text-fg-2">{r.whatToReuse}</span>
                      <span className="flex flex-wrap gap-1">
                        {r.tags.map((t) => (
                          <Badge key={t}>{label('referenceTag', t)}</Badge>
                        ))}
                        {r.archivedAt ? <StatusBadge status="archived" /> : null}
                      </span>
                      <span className="flex items-center gap-1.5 text-[12px] text-fg-2">
                        <Avatar name={r.author.displayName} src={r.author.avatarUrl} size={24} decorative />
                        {r.author.displayName} · {r.project?.name ?? 'Workspace'}
                      </span>
                    </span>
                  </button>
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
        )}
      </QueryState>
      {state.open ? <ReferenceDrawer referenceId={state.open} onClose={() => set({ open: null })} /> : null}
      {state.create === '1' ? <ReferenceDrawer referenceId={null} defaultProjectId={projectId} onClose={() => set({ create: null })} onCreated={(id) => set({ create: null, open: id })} /> : null}
    </div>
  );
};
