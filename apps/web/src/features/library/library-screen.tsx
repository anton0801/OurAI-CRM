'use client';
import { DotsThree, FolderSimplePlus, ImagesSquare, LinkSimple, Plus, SquaresFour, Table, UploadSimple } from '@phosphor-icons/react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { folderEndpoints, mediaEndpoints, type AssetFilter, type AssetView, type FolderView } from '@castlane/api-contracts';
import { ASSET_KINDS } from '@castlane/domain';
import { endOfLocalDayUtc, startOfLocalDayUtc } from '@castlane/domain';
import {
  Avatar,
  Badge,
  Banner,
  Button,
  DataTable,
  DateInput,
  EmptyState,
  IconButton,
  Input,
  Menu,
  MultiSelect,
  NoResults,
  PageHeader,
  Select,
  StatusBadge,
  Toolbar,
  formatBytes,
  formatDateTime,
  toast,
  type Column,
  type MenuItem,
} from '@castlane/ui';
import { EntitySelect } from '@/components/common/entity-select';
import { MemberSelect } from '@/components/common/pickers';
import { QueryState } from '@/components/common/query-state';
import { useDebounced } from '@/components/common/use-debounced';
import { useUpload } from '@/components/media/use-upload';
import { api } from '@/lib/api';
import { useApiInfinite, useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useUnsavedChangesGuard } from '@/lib/unsaved';
import { useUrlState } from '@/lib/url-state';
import { useCan, useWorkspace, useWsPath } from '@/lib/workspace-context';
import { AssetCard, AssetTile } from './asset-card';
import { BulkDialog, type BulkAction } from './bulk-dialog';
import { ExternalLinkDialog } from './external-link-dialog';
import { ArchiveFolderDialog, FolderFormDialog, MoveFolderDialog } from './folder-dialogs';
import { FolderTree, type FolderAction } from './folder-tree';
import { LinkDialog } from './link-dialog';
import { effectiveStatus } from './library-utils';
import { UploadDrawer } from './upload-drawer';
import './labels';

type Keys = 'folder' | 'q' | 'kind' | 'status' | 'sensitivity' | 'projectId' | 'accountId' | 'tag' | 'uploader' | 'from' | 'to' | 'archived' | 'view' | 'sort' | 'dir' | 'upload';

const STATUS_OPTIONS = ['available', 'checking', 'processing', 'uploading', 'rejected', 'failed', 'external'] as const;

/** S36 Library: folders, grid/table, filters in the URL, bulk actions with preview, upload manager. */
export const LibraryScreen = () => {
  const { workspace, user } = useWorkspace();
  const can = useCan();
  const wsPath = useWsPath();
  const router = useRouter();
  const { state, set, list } = useUrlState<Keys>({ view: 'grid', sort: 'updatedAt', dir: 'desc', archived: 'exclude' });
  const [search, setSearch] = useState(state.q ?? '');
  const q = useDebounced(search, 250);
  const folderId = state.folder ?? null;

  const folders = useApiQuery(folderEndpoints.list, { params: { workspaceId: workspace.id }, query: {} });
  const allFolders = folders.data ?? [];
  const current = allFolders.find((f) => f.id === folderId) ?? null;
  const folderDetail = useApiQuery(folderEndpoints.get, { params: { workspaceId: workspace.id, folderId: folderId ?? '' } }, { enabled: !!folderId });

  const filter: AssetFilter = useMemo(
    () => ({
      q: q.length >= 2 ? q : undefined,
      folderId: folderId ?? undefined,
      kind: list('kind') as AssetFilter['kind'],
      status: list('status') as AssetFilter['status'],
      sensitivity: (state.sensitivity as AssetFilter['sensitivity']) || undefined,
      projectId: state.projectId,
      accountId: state.accountId,
      tag: state.tag ? [state.tag] : undefined,
      uploaderMembershipId: state.uploader,
      updatedFrom: state.from ? startOfLocalDayUtc(state.from, user.timezone).toISOString() : undefined,
      updatedTo: state.to ? endOfLocalDayUtc(state.to, user.timezone).toISOString() : undefined,
      archived: (state.archived as AssetFilter['archived']) ?? 'exclude',
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [q, folderId, state],
  );
  const sort = (state.sort ?? 'updatedAt') as 'updatedAt' | 'createdAt' | 'name';
  const direction = (state.dir ?? 'desc') as 'asc' | 'desc';
  const data = useApiInfinite(mediaEndpoints.list, { params: { workspaceId: workspace.id }, query: { ...filter, sort, direction } });
  const filtered = !!(filter.q || filter.kind?.length || filter.status?.length || filter.sensitivity || filter.projectId || filter.accountId || filter.tag || filter.uploaderMembershipId || filter.updatedFrom || filter.updatedTo || filter.archived !== 'exclude');

  // Selection: explicit ids (Select Visible) or every matching file (Select All Matching).
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [allMatching, setAllMatching] = useState(false);
  useEffect(() => {
    setSelected(new Set());
    setAllMatching(false);
  }, [JSON.stringify(filter)]); // eslint-disable-line react-hooks/exhaustive-deps

  const [bulk, setBulk] = useState<{ action: BulkAction; ids?: string[] } | null>(null);
  const [folderDialog, setFolderDialog] = useState<{ action: FolderAction; folder: FolderView | null } | null>(null);
  const [externalOpen, setExternalOpen] = useState(false);
  const [linkFor, setLinkFor] = useState<AssetView | null>(null);
  const [uploadProject, setUploadProject] = useState<string | null>(state.projectId ?? null);
  const [sensitivity, setSensitivity] = useState<'normal' | 'restricted'>('normal');
  const upload = useUpload({
    workspaceId: workspace.id,
    purpose: 'general',
    folderId,
    projectId: current?.projectId ?? uploadProject,
    sensitivity,
    checkDuplicates: true,
    onUploaded: () => void data.refetch(),
  });
  useUnsavedChangesGuard(upload.active > 0);

  const canUpload = can('assets.upload');
  const canArchive = can('assets.archive');
  const hasSelection = allMatching || selected.size > 0;

  const download = async (a: AssetView) => {
    try {
      const r = await api.call(mediaEndpoints.download, { params: { workspaceId: workspace.id, assetId: a.id }, body: {} });
      window.location.assign(r.url);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const rowMenu = (a: AssetView): MenuItem[] => [
    { label: 'Open', onSelect: () => router.push(wsPath(`/library/assets/${a.id}`)) },
    { label: 'Download', onSelect: () => void download(a), hidden: !a.canDownload },
    { label: 'Open External Link', onSelect: () => window.open(a.externalUrl!, '_blank', 'noopener,noreferrer'), hidden: a.kind !== 'external_link' || !a.externalUrl },
    { label: 'Link to Content', onSelect: () => setLinkFor(a), hidden: !can('assets.link') || !!a.archivedAt },
    { label: 'Move', onSelect: () => setBulk({ action: 'move', ids: [a.id] }), hidden: !canUpload || !!a.archivedAt },
    { label: 'Archive', destructive: true, separatorBefore: true, onSelect: () => setBulk({ action: 'archive', ids: [a.id] }), hidden: !canArchive || !!a.archivedAt },
  ];

  const columns: Column<AssetView>[] = [
    {
      key: 'name',
      header: 'Name',
      sortable: true,
      sticky: true,
      minWidth: 260,
      cell: (a) => (
        <span className="flex items-center gap-3">
          <span className="w-12 shrink-0 overflow-hidden rounded-[6px]">
            <AssetTile a={a} compact />
          </span>
          <Link href={wsPath(`/library/assets/${a.id}`)} className="min-w-0 truncate font-medium text-fg hover:underline" onClick={(e) => e.stopPropagation()}>
            {a.name}
          </Link>
        </span>
      ),
    },
    { key: 'kind', header: 'Type', minWidth: 110, cell: (a) => label('assetKind', a.kind) },
    { key: 'project', header: 'Project', minWidth: 140, cell: (a) => a.projectName ?? (a.projectId ? <span className="text-fg-muted">Another project</span> : <span className="text-fg-muted">Workspace</span>) },
    { key: 'size', header: 'Size', align: 'right', minWidth: 90, cell: (a) => (a.currentVersion?.byteSize ? formatBytes(a.currentVersion.byteSize) : <span className="text-fg-muted">—</span>) },
    {
      key: 'status',
      header: 'Processing',
      minWidth: 130,
      cell: (a) => {
        const s = effectiveStatus(a);
        return <StatusBadge status={s} label={label('assetStatus', s)} />;
      },
    },
    { key: 'sensitivity', header: 'Sensitivity', minWidth: 110, cell: (a) => (a.sensitivity === 'restricted' ? <Badge tone="warning">Restricted</Badge> : <span className="text-fg-2">Normal</span>) },
    { key: 'usage', header: 'Linked', align: 'right', minWidth: 80, cell: (a) => a.usageCount ?? 0 },
    {
      key: 'uploader',
      header: 'Uploader',
      minWidth: 150,
      cell: (a) =>
        a.owner ? (
          <span className="flex items-center gap-2">
            <Avatar name={a.owner.displayName} src={a.owner.avatarUrl} size={24} decorative />
            <span className="truncate">{a.owner.displayName}</span>
          </span>
        ) : (
          '—'
        ),
    },
    { key: 'updatedAt', header: 'Updated', sortable: true, minWidth: 160, cell: (a) => formatDateTime(a.updatedAt, user.timezone) },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      headerLabel: 'Actions',
      minWidth: 56,
      cell: (a) => (
        <span onClick={(e) => e.stopPropagation()}>
          <Menu label={`Actions for ${a.name}`} trigger={<IconButton label={`Actions for ${a.name}`} icon={<DotsThree size={16} weight="bold" />} />} items={rowMenu(a)} />
        </span>
      ),
    },
  ];

  const clearFilters = () => {
    setSearch('');
    set({ q: null, kind: null, status: null, sensitivity: null, projectId: null, accountId: null, tag: null, uploader: null, from: null, to: null, archived: null });
  };

  const path = folderDetail.data?.path ?? [];
  const subfolders = allFolders.filter((f) => f.parentId === folderId);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        crumbs={[{ label: 'Library', href: folderId ? wsPath('/library') : undefined }, ...path.map((p, i) => ({ label: p.name, href: i < path.length - 1 ? wsPath(`/library?folder=${p.id}`) : undefined }))]}
        title={current?.name ?? 'Library'}
        description={current ? (current.projectName ? `Project library · ${current.projectName}` : 'Workspace library') : 'Source files, versions and approved material. Access follows each file’s project; folders only organise.'}
        actions={
          <>
            {canUpload ? (
              <Button variant="primary" icon={<UploadSimple size={14} weight="bold" />} onClick={() => set({ upload: '1' }, { replace: false })}>
                Upload{upload.active ? ` (${upload.active})` : ''}
              </Button>
            ) : null}
            {canUpload ? (
              <Menu
                label="More actions"
                trigger={<IconButton label="More actions" icon={<DotsThree size={18} weight="bold" />} variant="secondary" />}
                items={[
                  { label: 'Add External Link', icon: <LinkSimple size={14} />, onSelect: () => setExternalOpen(true) },
                  { label: current ? 'New Subfolder' : 'New Folder', icon: <FolderSimplePlus size={14} />, onSelect: () => setFolderDialog({ action: 'create', folder: current }), hidden: current ? !current.permissions.create : false },
                  { label: 'Rename Folder', onSelect: () => setFolderDialog({ action: 'rename', folder: current }), hidden: !current?.permissions.update, separatorBefore: true },
                  { label: 'Move Folder', onSelect: () => setFolderDialog({ action: 'move', folder: current }), hidden: !current?.permissions.update },
                  { label: 'Archive Folder', destructive: true, onSelect: () => setFolderDialog({ action: 'archive', folder: current }), hidden: !current?.permissions.archive },
                ]}
              />
            ) : null}
          </>
        }
      />
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[240px_minmax(0,1fr)]">
        <aside className="min-w-0">
          <details className="rounded-[12px] border border-line bg-surface p-2 lg:hidden">
            <summary className="cursor-pointer px-2 py-1.5 text-[13px] font-medium text-fg">Folders</summary>
            <div className="pt-2">
              <QueryState query={folders}>
                <FolderTree folders={allFolders} selectedId={folderId} onSelect={(id) => set({ folder: id }, { replace: false })} onAction={(action, folder) => setFolderDialog({ action, folder })} canCreateRoot={canUpload} />
              </QueryState>
            </div>
          </details>
          <div className="hidden rounded-[12px] border border-line bg-surface p-2 lg:block">
            <QueryState query={folders}>
              <FolderTree folders={allFolders} selectedId={folderId} onSelect={(id) => set({ folder: id }, { replace: false })} onAction={(action, folder) => setFolderDialog({ action, folder })} canCreateRoot={canUpload} />
            </QueryState>
          </div>
        </aside>
        <section className="flex min-w-0 flex-col gap-4" aria-label="Files">
          <Toolbar>
            <div className="w-full sm:w-[220px]">
              <Input
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  set({ q: e.target.value || null });
                }}
                placeholder="Search name, description, tag"
                aria-label="Search files"
              />
            </div>
            <div className="w-[140px]">
              <MultiSelect aria-label="Type" placeholder="Type" value={list('kind')} onChange={(v) => set({ kind: v.join(',') || null })} options={ASSET_KINDS.map((k) => ({ value: k, label: label('assetKind', k) }))} />
            </div>
            <div className="w-[150px]">
              <MultiSelect aria-label="Processing status" placeholder="Status" value={list('status')} onChange={(v) => set({ status: v.join(',') || null })} options={STATUS_OPTIONS.map((s) => ({ value: s, label: label('assetStatus', s) }))} />
            </div>
            <div className="w-[160px]">
              <EntitySelect type="project" aria-label="Project" placeholder="Project" value={state.projectId ?? null} onChange={(v) => set({ projectId: v })} clearable />
            </div>
            <div className="w-[160px]">
              <EntitySelect type="account" aria-label="Account" placeholder="Account" value={state.accountId ?? null} onChange={(v) => set({ accountId: v })} clearable />
            </div>
            <div className="w-[140px]">
              <Input value={state.tag ?? ''} onChange={(e) => set({ tag: e.target.value || null })} placeholder="Tag" aria-label="Tag" />
            </div>
            <div className="w-[160px]">
              <MemberSelect aria-label="Uploader" placeholder="Uploader" value={state.uploader ?? null} onChange={(v) => set({ uploader: v })} clearable />
            </div>
            <div className="w-[140px]">
              <Select
                aria-label="Sensitivity"
                placeholder="Sensitivity"
                value={state.sensitivity ?? null}
                onChange={(v) => set({ sensitivity: v })}
                clearable
                options={[
                  { value: 'normal', label: 'Normal' },
                  { value: 'restricted', label: 'Restricted Media' },
                ]}
              />
            </div>
            <div className="flex items-center gap-1">
              <DateInput aria-label="Updated from" value={state.from ?? ''} onChange={(e) => set({ from: e.target.value || null })} className="w-[150px]" />
              <span className="text-fg-2" aria-hidden>
                –
              </span>
              <DateInput aria-label="Updated to" value={state.to ?? ''} onChange={(e) => set({ to: e.target.value || null })} className="w-[150px]" />
            </div>
            <div className="w-[150px]">
              <Select
                aria-label="Archived files"
                value={state.archived ?? 'exclude'}
                onChange={(v) => set({ archived: v ?? 'exclude' })}
                options={[
                  { value: 'exclude', label: 'Active files' },
                  { value: 'include', label: 'Active and archived' },
                  { value: 'only', label: 'Archived only' },
                ]}
              />
            </div>
            <div className="ml-auto flex items-center gap-1">
              <div className="w-[150px]">
                <Select
                  aria-label="Sort"
                  value={`${sort}:${direction}`}
                  onChange={(v) => {
                    const [s, d] = (v ?? 'updatedAt:desc').split(':');
                    set({ sort: s, dir: d });
                  }}
                  options={[
                    { value: 'updatedAt:desc', label: 'Recently updated' },
                    { value: 'createdAt:desc', label: 'Newest first' },
                    { value: 'name:asc', label: 'Name A–Z' },
                    { value: 'name:desc', label: 'Name Z–A' },
                  ]}
                />
              </div>
              <div className="flex items-center gap-1" role="group" aria-label="View">
                <Button size="sm" variant={state.view !== 'table' ? 'secondary' : 'ghost'} icon={<SquaresFour size={14} />} aria-pressed={state.view !== 'table'} onClick={() => set({ view: 'grid' })}>
                  Grid
                </Button>
                <Button size="sm" variant={state.view === 'table' ? 'secondary' : 'ghost'} icon={<Table size={14} />} aria-pressed={state.view === 'table'} onClick={() => set({ view: 'table' })}>
                  Table
                </Button>
              </div>
            </div>
          </Toolbar>

          {subfolders.length ? (
            <ul className="flex flex-wrap gap-2" aria-label="Subfolders">
              {subfolders.map((f) => (
                <li key={f.id}>
                  <Button size="sm" onClick={() => set({ folder: f.id }, { replace: false })}>
                    {f.name}
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}

          {hasSelection ? (
            <div className="flex flex-wrap items-center gap-2 rounded-[8px] bg-selection px-3 py-2 text-[13px] text-fg" role="status">
              <span>{allMatching ? 'All matching files selected' : `${selected.size} selected`}</span>
              {/* The table has its own Select All Matching / Clear Selection controls. */}
              {state.view !== 'table' && !allMatching && data.hasNextPage ? (
                <Button size="sm" variant="ghost" onClick={() => setAllMatching(true)}>
                  Select All Matching
                </Button>
              ) : null}
              {state.view !== 'table' ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setSelected(new Set());
                    setAllMatching(false);
                  }}
                >
                  Clear Selection
                </Button>
              ) : null}
              <span className="ml-auto flex flex-wrap gap-1">
                {canUpload ? (
                  <>
                    <Button size="sm" onClick={() => setBulk({ action: 'move' })}>
                      Move
                    </Button>
                    <Button size="sm" onClick={() => setBulk({ action: 'tag' })}>
                      Add Tags
                    </Button>
                    <Button size="sm" onClick={() => setBulk({ action: 'untag' })}>
                      Remove Tags
                    </Button>
                  </>
                ) : null}
                {canArchive ? (
                  <Button size="sm" variant="danger-secondary" onClick={() => setBulk({ action: 'archive' })}>
                    Archive
                  </Button>
                ) : null}
              </span>
            </div>
          ) : null}

          <QueryState query={data}>
            {data.items.length === 0 && !data.isFetching ? (
              filtered ? (
                <NoResults onClear={clearFilters} />
              ) : (
                <EmptyState
                  icon={<ImagesSquare size={28} />}
                  title={current ? 'This folder is empty' : 'No files yet'}
                  description={
                    canUpload
                      ? 'Upload source files, versions and approved material, or add an external link. Files are checked before they become available.'
                      : 'Files appear here when they belong to projects you can access. Ask a project lead if you expect to see files here.'
                  }
                  action={
                    canUpload ? (
                      <>
                        <Button variant="primary" icon={<Plus size={14} />} onClick={() => set({ upload: '1' }, { replace: false })}>
                          Upload Files
                        </Button>
                        <Button onClick={() => setExternalOpen(true)}>Add External Link</Button>
                      </>
                    ) : undefined
                  }
                />
              )
            ) : state.view === 'table' ? (
              <DataTable
                caption="Files"
                rows={data.items}
                columns={columns}
                getRowId={(a) => a.id}
                density={user.density}
                sort={sort === 'createdAt' ? null : { key: sort, direction }}
                onSortChange={(s) => set({ sort: s.key, dir: s.direction })}
                onRowClick={(a) => router.push(wsPath(`/library/assets/${a.id}`))}
                selection={{ ids: selected, allMatching }}
                onSelectionChange={(s) => {
                  setSelected(s.ids);
                  setAllMatching(s.allMatching);
                }}
                hasMore={data.hasNextPage}
                loadingMore={data.isFetchingNextPage}
                onLoadMore={() => void data.fetchNextPage()}
              />
            ) : (
              <div className="flex flex-col gap-3">
                {(canUpload || canArchive) && !hasSelection ? (
                  <div>
                    <Button size="sm" variant="ghost" onClick={() => setSelected(new Set(data.items.map((i) => i.id)))}>
                      Select Visible ({data.items.length})
                    </Button>
                  </div>
                ) : null}
                <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-5">
                  {data.items.map((a) => (
                    <li key={a.id} className="relative">
                      <AssetCard
                        a={a}
                        href={wsPath(`/library/assets/${a.id}`)}
                        selectable
                        selected={allMatching || selected.has(a.id)}
                        onSelectedChange={(v) => {
                          const next = new Set(allMatching ? data.items.map((i) => i.id) : selected);
                          if (v) next.add(a.id);
                          else next.delete(a.id);
                          setAllMatching(false);
                          setSelected(next);
                        }}
                      />
                      <div className="absolute right-2 top-2">
                        <Menu label={`Actions for ${a.name}`} trigger={<IconButton label={`Actions for ${a.name}`} icon={<DotsThree size={16} weight="bold" />} variant="secondary" />} items={rowMenu(a)} />
                      </div>
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
        </section>
      </div>

      {upload.items.length && state.upload !== '1' ? (
        <Banner tone="info" action={<Button size="sm" onClick={() => set({ upload: '1' }, { replace: false })}>Show Uploads</Button>}>
          {upload.active ? `${upload.active} upload${upload.active === 1 ? '' : 's'} in progress.` : 'Uploads finished or waiting for checks.'}
        </Banner>
      ) : null}

      <UploadDrawer
        open={state.upload === '1'}
        onOpenChange={(o) => set({ upload: o ? '1' : null })}
        u={upload}
        folder={current ? { ...current, path } : null}
        projectId={uploadProject}
        onProjectChange={setUploadProject}
        sensitivity={sensitivity}
        onSensitivityChange={setSensitivity}
      />
      <ExternalLinkDialog
        open={externalOpen}
        onOpenChange={setExternalOpen}
        folderId={folderId}
        defaultProjectId={current?.projectId ?? state.projectId ?? null}
        projectLocked={!!current?.projectId}
        onCreated={(id) => router.push(wsPath(`/library/assets/${id}`))}
      />
      <FolderFormDialog
        open={folderDialog?.action === 'create' || folderDialog?.action === 'rename'}
        onOpenChange={(o) => !o && setFolderDialog(null)}
        mode={folderDialog?.action === 'rename' ? 'rename' : 'create'}
        parent={folderDialog?.action === 'create' ? folderDialog.folder : null}
        folder={folderDialog?.action === 'rename' ? folderDialog.folder : null}
        defaultProjectId={state.projectId ?? null}
        onSaved={(id) => (folderDialog?.action === 'create' ? set({ folder: id }, { replace: false }) : undefined)}
      />
      <MoveFolderDialog open={folderDialog?.action === 'move'} onOpenChange={(o) => !o && setFolderDialog(null)} folder={folderDialog?.folder ?? null} folders={allFolders} />
      <ArchiveFolderDialog
        open={folderDialog?.action === 'archive'}
        onOpenChange={(o) => !o && setFolderDialog(null)}
        folder={folderDialog?.folder ?? null}
        onArchived={() => {
          if (folderDialog?.folder?.id === folderId) set({ folder: folderDialog?.folder?.parentId ?? null });
        }}
      />
      {bulk ? (
        <BulkDialog
          open
          onOpenChange={(o) => !o && setBulk(null)}
          action={bulk.action}
          folders={allFolders}
          selection={bulk.ids ? { assetIds: bulk.ids } : allMatching ? { filter, expectedCount: null } : { assetIds: [...selected] }}
          onDone={() => {
            setSelected(new Set());
            setAllMatching(false);
            void data.refetch();
          }}
        />
      ) : null}
      <LinkDialog open={!!linkFor} onOpenChange={(o) => !o && setLinkFor(null)} assetId={linkFor?.id ?? null} assetName={linkFor?.name} />
    </div>
  );
};
