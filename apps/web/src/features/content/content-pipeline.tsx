'use client';
import { DotsThree, FilmSlate, Kanban as KanbanIcon, Plus, Table } from '@phosphor-icons/react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { contentEndpoints, type ContentSummary } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { CONTENT_FORMATS, CONTENT_STAGES } from '@castlane/domain';
import {
  Banner,
  Button,
  DataTable,
  Dialog,
  EmptyState,
  Field,
  IconButton,
  Input,
  Kanban,
  Menu,
  MultiSelect,
  NoResults,
  PageHeader,
  Switch,
  Textarea,
  Toolbar,
  toast,
  type Column,
  type KanbanColumn,
  type SelectionState,
} from '@castlane/ui';
import { EntitySelect } from '@/components/common/entity-select';
import { MemberSelect } from '@/components/common/pickers';
import { QueryState } from '@/components/common/query-state';
import { useDebounced } from '@/components/common/use-debounced';
import { SavedViewsMenu } from '@/components/saved-views/saved-views-menu';
import { useApiInfinite, useApiMutation, useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useUrlState } from '@/lib/url-state';
import { useCan, useWorkspace, useWsPath } from '@/lib/workspace-context';
import { BulkContentDialog } from './bulk-dialog';
import { ContentFlags, DueText, Person, StageBadge, VersionPointers } from './format';
import './labels';

type Filters =
  | 'q'
  | 'projectId'
  | 'format'
  | 'stage'
  | 'ownerMembershipId'
  | 'reviewerMembershipId'
  | 'mine'
  | 'overdue'
  | 'blocked'
  | 'archived'
  | 'sort'
  | 'dir'
  | 'view';

const PIPELINE = ['idea', 'brief', 'ready', 'production', 'review', 'changes_requested', 'approved'] as const;

/** Columns that are only reached through review commands: dropping there is explained, not attempted. */
const DROP_REASON: Partial<Record<string, string>> = {
  review: 'Submit a version for review from the content page.',
  changes_requested: 'Changes are requested by a reviewer inside the review.',
  approved: 'Approval happens in Review: open the review of the submitted version.',
};

/** Card with a keyboard "Move to" menu (the drag alternative, §28.2). */
const ContentCard = ({
  c,
  onMove,
  compact,
}: {
  c: ContentSummary;
  onMove: (c: ContentSummary, to: string) => void;
  compact: boolean;
}) => {
  const wsPath = useWsPath();
  const { user } = useWorkspace();
  return (
    <div className="flex flex-col gap-2">
      {c.thumbnailUrl && !compact ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={c.thumbnailUrl}
          alt=""
          loading="lazy"
          className="aspect-video w-full rounded-[6px] bg-surface-2 object-cover"
        />
      ) : null}
      <div className="flex items-start gap-2">
        {c.thumbnailUrl && compact ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={c.thumbnailUrl}
            alt=""
            loading="lazy"
            width={32}
            height={32}
            className="h-8 w-8 shrink-0 rounded-[6px] object-cover"
          />
        ) : null}
        <Link
          href={wsPath(`/content/${c.id}`)}
          className="line-clamp-3 min-w-0 flex-1 text-[13px] font-semibold leading-5 text-fg hover:underline"
        >
          {c.title}
        </Link>
        <Menu
          label={`Move ${c.title} to`}
          trigger={
            <IconButton
              label={`Actions for ${c.title}`}
              icon={<DotsThree size={16} weight="bold" />}
              variant="ghost"
            />
          }
          items={[
            ...c.allowedMoves.map((s) => ({
              label: `Move to ${label('contentStage', s)}`,
              onSelect: () => onMove(c, s),
            })),
            { label: 'Open', href: wsPath(`/content/${c.id}`), separatorBefore: c.allowedMoves.length > 0 },
          ]}
        />
      </div>
      <p className="line-clamp-2 text-[12px] leading-[18px] text-fg-2">
        {c.project.name} · {label('contentFormat', c.format)}
      </p>
      <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-fg-2">
        <Person member={c.owner} />
        <DueText c={c} tz={user.timezone} />
      </div>
      <div className="flex flex-wrap gap-1.5">
        <ContentFlags c={c} />
        {c.newerVersionAwaitingReview ? (
          <VersionPointers c={{ ...c, currentVersion: null, approvedVersion: null }} />
        ) : null}
      </div>
    </div>
  );
};

/**
 * S22 Content Pipeline: board by canonical stage (WIP counts) or table; filters, sort and view in
 * the URL. Embedded in the project workspace (tab "Content") it shows the same records limited to
 * that project.
 */
export const ContentPipeline = ({
  projectId: fixedProjectId,
  embedded = false,
}: { projectId?: string; embedded?: boolean } = {}) => {
  const { workspace, user } = useWorkspace();
  const can = useCan();
  const wsPath = useWsPath();
  const router = useRouter();
  const { state, set, list } = useUrlState<Filters>({ view: 'board', sort: 'updatedAt', dir: 'desc' });
  const [search, setSearch] = useState(state.q ?? '');
  const q = useDebounced(search, 250);
  const params = { workspaceId: workspace.id };
  const filters = {
    q: q.length >= 2 ? q : undefined,
    projectId: fixedProjectId ?? state.projectId,
    format: list('format') as ContentSummary['format'][],
    ownerMembershipId: state.ownerMembershipId,
    reviewerMembershipId: state.reviewerMembershipId,
    mine: state.mine === '1' ? true : undefined,
    overdue: state.overdue === '1' ? true : undefined,
    blocked: state.blocked === '1' ? true : undefined,
  };
  const view = state.view === 'table' ? 'table' : 'board';
  const board = useApiQuery(
    contentEndpoints.board,
    { params, query: { ...filters, perStage: 50 } },
    { enabled: view === 'board' },
  );
  const tableQuery = {
    ...filters,
    stage: list('stage') as ContentSummary['stage'][],
    includeArchived: state.archived === '1' ? true : undefined,
    sort: (state.sort ?? 'updatedAt') as 'updatedAt' | 'createdAt' | 'dueAt' | 'title' | 'stage',
    direction: (state.dir ?? 'desc') as 'asc' | 'desc',
  };
  const table = useApiInfinite(
    contentEndpoints.list,
    { params, query: tableQuery },
    { enabled: view === 'table' },
  );
  const move = useApiMutation(contentEndpoints.transition, { invalidate: ['content.'], silentErrors: true });
  const [revision, setRevision] = useState<ContentSummary | null>(null);
  const [revisionReason, setRevisionReason] = useState('');
  const [selection, setSelection] = useState<SelectionState>({ ids: new Set(), allMatching: false });
  const [bulkOpen, setBulkOpen] = useState(false);
  const [wipOpen, setWipOpen] = useState(false);
  const filtered = !!(
    filters.q ||
    (!fixedProjectId && filters.projectId) ||
    filters.format.length ||
    filters.ownerMembershipId ||
    filters.reviewerMembershipId ||
    filters.mine ||
    filters.overdue ||
    filters.blocked ||
    (view === 'table' && tableQuery.stage.length)
  );
  const clearFilters = () => {
    setSearch('');
    set({
      q: null,
      projectId: null,
      format: null,
      stage: null,
      ownerMembershipId: null,
      reviewerMembershipId: null,
      mine: null,
      overdue: null,
      blocked: null,
    });
  };

  const runMove = async (c: ContentSummary, to: string, reason?: string) => {
    if (!c.allowedMoves.includes(to as never)) {
      toast.error(DROP_REASON[to] ?? `${c.title} cannot move to ${label('contentStage', to)}.`);
      return;
    }
    if (c.stage === 'approved' && to === 'production' && !reason) {
      setRevisionReason('');
      setRevision(c);
      return;
    }
    try {
      const r = await move.run(
        {
          params: { workspaceId: workspace.id, contentId: c.id },
          body: { targetStage: to as ContentSummary['stage'], reason },
        },
        { ifMatch: c.rowVersion },
      );
      toast.success(`${c.title} moved to ${label('contentStage', to)}`);
      for (const w of r.warnings) toast.info(w);
      setRevision(null);
    } catch (e) {
      // The card stays where it was; the server explains the missing conditions.
      toast.error(isApiError(e) ? e.message : 'The content could not be moved.');
    }
  };

  const columns: KanbanColumn[] = (board.data?.columns ?? []).map((col) => ({
    key: col.stage,
    label: `${label('contentStage', col.stage)}${col.count > col.items.length ? ` (${col.items.length} of ${col.count})` : ''}`,
    wipLimit: col.wipLimit ?? undefined,
    dropDisabledReason: DROP_REASON[col.stage],
  }));
  const boardItems = useMemo(() => (board.data?.columns ?? []).flatMap((c) => c.items), [board.data]);
  const boardEmpty = !!board.data && board.data.columns.every((c) => c.count === 0);

  const tableColumns: Column<ContentSummary>[] = [
    {
      key: 'title',
      header: 'Title',
      sortable: true,
      sticky: true,
      minWidth: 260,
      cell: (c) => (
        <span className="flex items-center gap-3">
          {c.thumbnailUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={c.thumbnailUrl}
              alt=""
              width={32}
              height={32}
              loading="lazy"
              className="h-8 w-8 shrink-0 rounded-[6px] object-cover"
            />
          ) : null}
          <Link
            href={wsPath(`/content/${c.id}`)}
            onClick={(e) => e.stopPropagation()}
            className="font-medium text-fg hover:underline"
          >
            {c.title}
          </Link>
        </span>
      ),
    },
    {
      key: 'stage',
      header: 'Stage',
      sortable: true,
      minWidth: 150,
      cell: (c) => (
        <span className="flex flex-wrap gap-1">
          <StageBadge stage={c.stage} />
          <ContentFlags c={c} />
        </span>
      ),
    },
    { key: 'project', header: 'Project', minWidth: 150, cell: (c) => c.project.name },
    { key: 'format', header: 'Format', minWidth: 120, cell: (c) => label('contentFormat', c.format) },
    { key: 'owner', header: 'Owner', minWidth: 160, cell: (c) => <Person member={c.owner} /> },
    {
      key: 'dueAt',
      header: 'Due Date',
      sortable: true,
      minWidth: 160,
      cell: (c) => <DueText c={c} tz={user.timezone} />,
    },
    {
      key: 'reviewer',
      header: 'Reviewer',
      minWidth: 160,
      cell: (c) => <Person member={c.reviewer} empty="Not set" />,
    },
    { key: 'approved', header: 'Approved Version', minWidth: 170, cell: (c) => <VersionPointers c={c} /> },
    {
      key: 'publications',
      header: 'Publications',
      align: 'right',
      minWidth: 110,
      cell: (c) => c.publicationCount,
    },
  ];

  const newButton = can('content.create') ? (
    <Button
      variant="primary"
      icon={<Plus size={14} weight="bold" />}
      onClick={() =>
        router.push(wsPath(fixedProjectId ? `/content/new?projectId=${fixedProjectId}` : '/content/new'))
      }
    >
      New Content
    </Button>
  ) : null;

  return (
    <div className="flex flex-col gap-5">
      {embedded ? (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button onClick={() => router.push(wsPath(`/content?projectId=${fixedProjectId ?? ''}`))}>
            Open Pipeline
          </Button>
          {newButton}
        </div>
      ) : (
        <PageHeader
          title="Content"
          description="Every content item from idea to approved version. Approval happens in review, never by moving a card."
          actions={
            <>
              {newButton}
              <Menu
                label="More content actions"
                trigger={
                  <IconButton
                    label="More content actions"
                    icon={<DotsThree size={18} weight="bold" />}
                    variant="secondary"
                  />
                }
                items={[
                  { label: 'Review Queue', href: wsPath('/reviews') },
                  {
                    label: 'Export Content',
                    hidden: !can('exports.create'),
                    onSelect: () => router.push(wsPath('/exports?new=1&dataset=content_items')),
                  },
                  {
                    label: 'Work-in-Progress Limits',
                    hidden: !board.data?.canEditWipLimits,
                    onSelect: () => setWipOpen(true),
                  },
                ]}
              />
            </>
          }
        />
      )}
      <Toolbar>
        {embedded ? null : (
          <SavedViewsMenu
            module="content"
            params={{
              q: 'text',
              projectId: 'id',
              format: 'list',
              stage: 'list',
              ownerMembershipId: 'id',
              reviewerMembershipId: 'id',
              mine: 'flag',
              overdue: 'flag',
              blocked: 'flag',
              archived: 'flag',
            }}
            sort={{ key: 'sort', dir: 'dir' }}
            onApply={(v) => setSearch(v.q ?? '')}
          />
        )}
        <div className="w-full sm:w-[220px]">
          <Input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              set({ q: e.target.value || null });
            }}
            placeholder="Search content"
            aria-label="Search content"
          />
        </div>
        {fixedProjectId ? null : (
          <div className="w-full sm:w-[200px]">
            <EntitySelect
              type="project"
              aria-label="Project"
              placeholder="Project"
              value={state.projectId}
              onChange={(v) => set({ projectId: v })}
              clearable
            />
          </div>
        )}
        <div className="w-[160px]">
          <MultiSelect
            aria-label="Format"
            placeholder="Format"
            value={list('format')}
            onChange={(v) => set({ format: v.join(',') || null })}
            options={CONTENT_FORMATS.map((f) => ({ value: f, label: label('contentFormat', f) }))}
          />
        </div>
        {view === 'table' ? (
          <div className="w-[170px]">
            <MultiSelect
              aria-label="Stage"
              placeholder="Stage"
              value={list('stage')}
              onChange={(v) => set({ stage: v.join(',') || null })}
              options={CONTENT_STAGES.map((s) => ({ value: s, label: label('contentStage', s) }))}
            />
          </div>
        ) : null}
        <div className="w-[170px]">
          <MemberSelect
            aria-label="Owner"
            placeholder="Owner"
            value={state.ownerMembershipId}
            onChange={(v) => set({ ownerMembershipId: v })}
            clearable
          />
        </div>
        <div className="w-[170px]">
          <MemberSelect
            aria-label="Reviewer"
            placeholder="Reviewer"
            value={state.reviewerMembershipId}
            onChange={(v) => set({ reviewerMembershipId: v })}
            clearable
          />
        </div>
        <div className="flex flex-wrap items-center gap-4 px-1">
          <Switch
            label="Mine"
            checked={state.mine === '1'}
            onCheckedChange={(v) => set({ mine: v ? '1' : null })}
          />
          <Switch
            label="Overdue"
            checked={state.overdue === '1'}
            onCheckedChange={(v) => set({ overdue: v ? '1' : null })}
          />
          <Switch
            label="Blocked"
            checked={state.blocked === '1'}
            onCheckedChange={(v) => set({ blocked: v ? '1' : null })}
          />
          {view === 'table' ? (
            <Switch
              label="Show archived"
              checked={state.archived === '1'}
              onCheckedChange={(v) => set({ archived: v ? '1' : null })}
            />
          ) : null}
        </div>
        <div className="ml-auto flex items-center gap-1" role="group" aria-label="View">
          <Button
            size="sm"
            variant={view === 'board' ? 'secondary' : 'ghost'}
            icon={<KanbanIcon size={14} />}
            aria-pressed={view === 'board'}
            onClick={() => set({ view: 'board' })}
          >
            Board
          </Button>
          <Button
            size="sm"
            variant={view === 'table' ? 'secondary' : 'ghost'}
            icon={<Table size={14} />}
            aria-pressed={view === 'table'}
            onClick={() => set({ view: 'table' })}
          >
            Table
          </Button>
        </div>
      </Toolbar>
      {view === 'board' ? (
        <QueryState query={board}>
          {boardEmpty ? (
            filtered ? (
              <NoResults onClear={clearFilters} />
            ) : (
              <EmptyState
                icon={<FilmSlate size={28} />}
                title="No content yet"
                description={
                  can('content.create')
                    ? 'Create a content item to plan its brief, production tasks, versions and review.'
                    : 'Content of the projects you can access appears here. Ask a project lead for access if you expected to see content.'
                }
                action={newButton ?? undefined}
              />
            )
          ) : (
            <Kanban
              label="Content pipeline"
              columns={columns}
              items={boardItems}
              getId={(c) => c.id}
              getColumn={(c) => c.stage}
              onMove={(c, to) => void runMove(c, to)}
              renderCard={(c) => (
                <ContentCard
                  c={c}
                  onMove={(x, to) => void runMove(x, to)}
                  compact={user.density === 'compact'}
                />
              )}
              emptyColumnText="No content in this stage"
            />
          )}
        </QueryState>
      ) : (
        <QueryState query={table}>
          {table.items.length === 0 && !table.isFetching ? (
            filtered ? (
              <NoResults onClear={clearFilters} />
            ) : (
              <EmptyState
                icon={<FilmSlate size={28} />}
                title="No content yet"
                description="Create a content item to plan its brief, production tasks, versions and review."
                action={newButton ?? undefined}
              />
            )
          ) : (
            <div className="flex flex-col gap-3">
              {selection.ids.size > 0 && can('content.edit') ? (
                <div className="flex flex-wrap items-center gap-2 rounded-[8px] border border-line bg-surface-2 px-3 py-2 text-[13px]">
                  <span>{selection.ids.size} selected</span>
                  <Button size="sm" onClick={() => setBulkOpen(true)}>
                    Bulk Actions
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setSelection({ ids: new Set(), allMatching: false })}
                  >
                    Clear Selection
                  </Button>
                </div>
              ) : null}
              <DataTable
                caption="Content"
                rows={table.items}
                columns={tableColumns}
                getRowId={(c) => c.id}
                density={user.density}
                sort={{ key: tableQuery.sort, direction: tableQuery.direction }}
                onSortChange={(s) => set({ sort: s.key, dir: s.direction })}
                onRowClick={(c) => router.push(wsPath(`/content/${c.id}`))}
                selection={can('content.edit') ? selection : undefined}
                onSelectionChange={
                  can('content.edit') ? (s) => setSelection({ ids: s.ids, allMatching: false }) : undefined
                }
                hasMore={table.hasNextPage}
                loadingMore={table.isFetchingNextPage}
                onLoadMore={() => void table.fetchNextPage()}
              />
            </div>
          )}
        </QueryState>
      )}
      <Dialog
        open={!!revision}
        onOpenChange={(o) => !o && setRevision(null)}
        title="Start a new revision?"
        description="The approved version stays pinned for existing placements. The new version needs its own review."
        size="small"
        dirty={revisionReason.trim().length > 0}
        footer={
          <>
            <Button onClick={() => setRevision(null)}>Cancel</Button>
            <Button
              variant="primary"
              loading={move.isPending}
              disabled={revisionReason.trim().length < 3}
              onClick={() => revision && void runMove(revision, 'production', revisionReason.trim())}
            >
              Start New Revision
            </Button>
          </>
        }
      >
        <Field label="Reason" required>
          <Textarea
            value={revisionReason}
            onChange={(e) => setRevisionReason(e.target.value)}
            maxLength={2000}
          />
        </Field>
      </Dialog>
      <BulkContentDialog
        open={bulkOpen}
        onOpenChange={setBulkOpen}
        ids={[...selection.ids]}
        onDone={() => setSelection({ ids: new Set(), allMatching: false })}
      />
      <WipLimitsDialog
        open={wipOpen}
        onOpenChange={setWipOpen}
        current={Object.fromEntries((board.data?.columns ?? []).map((c) => [c.stage, c.wipLimit]))}
      />
    </div>
  );
};

const WipLimitsDialog = ({
  open,
  onOpenChange,
  current,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  current: Record<string, number | null>;
}) => {
  const { workspace } = useWorkspace();
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const save = useApiMutation(contentEndpoints.setWipLimits, {
    invalidate: ['content.board'],
    successMessage: 'Work-in-progress limits saved',
    silentErrors: true,
  });
  const val = (s: string) => values[s] ?? (current[s] ? String(current[s]) : '');
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setValues({});
        onOpenChange(o);
      }}
      title="Work-in-Progress Limits"
      description="A limit warns when a stage holds more items; cards are never blocked or hidden. Leave empty for no limit."
      size="small"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="primary"
            loading={save.isPending}
            onClick={async () => {
              setError(null);
              const limits: Record<string, number | null> = {};
              for (const s of PIPELINE) {
                const raw = val(s).trim();
                if (!raw) limits[s] = null;
                else if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 999) {
                  setError(`${label('contentStage', s)}: enter a whole number from 1 to 999.`);
                  return;
                } else limits[s] = Number(raw);
              }
              try {
                await save.run({ params: { workspaceId: workspace.id }, body: { limits } });
                onOpenChange(false);
              } catch (e) {
                setError(isApiError(e) ? e.message : 'The limits could not be saved.');
              }
            }}
          >
            Save Limits
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        {error ? (
          <div className="col-span-2">
            <Banner tone="danger">{error}</Banner>
          </div>
        ) : null}
        {PIPELINE.map((s) => (
          <Field key={s} label={label('contentStage', s)}>
            <Input
              inputMode="numeric"
              value={val(s)}
              onChange={(e) => setValues((v) => ({ ...v, [s]: e.target.value }))}
            />
          </Field>
        ))}
      </div>
    </Dialog>
  );
};
