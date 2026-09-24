'use client';
import { ArrowsLeftRight, BookmarkSimple, ChartBarHorizontal, CheckSquare, DotsThree, Kanban as KanbanIcon, Table, Trash } from '@phosphor-icons/react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { peopleEndpoints, taskEndpoints, type TaskListQuery, type TaskRow } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { LIMITS, TASK_PRIORITIES, TASK_STATUSES } from '@castlane/domain';
import {
  Badge,
  Button,
  ConfirmDialog,
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
  Select,
  Switch,
  Textarea,
  Toolbar,
  toast,
  type Column,
  type MenuItem,
  type SelectionState,
} from '@castlane/ui';
import { EntitySelect } from '@/components/common/entity-select';
import { QueryState } from '@/components/common/query-state';
import { useDebounced } from '@/components/common/use-debounced';
import { useApiInfinite, useApiMutation, useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useUrlState } from '@/lib/url-state';
import { useCan, useWorkspace, useWsPath } from '@/lib/workspace-context';
import { BulkDialog, type BulkSelection } from './bulk-dialog';
import { DueText, Person, PriorityBadge, TaskStatusBadge, formatMinutes } from './format';
import { TASK_INVALIDATE } from './task-actions';
import { TaskTimeline } from './task-timeline';

export type TaskFilterKey = 'q' | 'status' | 'priority' | 'projectId' | 'assignee' | 'reviewer' | 'following' | 'overdue' | 'blocked' | 'tag' | 'closed' | 'sort' | 'dir' | 'view' | 'group' | 'open' | 'create';
const FILTER_KEYS: TaskFilterKey[] = ['q', 'status', 'priority', 'projectId', 'assignee', 'reviewer', 'following', 'overdue', 'blocked', 'tag', 'closed'];

const BOARD_COLUMNS = ['backlog', 'ready', 'in_progress', 'in_review', 'done'] as const;

const AssigneeFilter = ({ value, onChange, placeholder }: { value: string | undefined; onChange: (v: string | null) => void; placeholder: string }) => {
  const { workspace } = useWorkspace();
  const q = useApiQuery(peopleEndpoints.lookup, { params: { workspaceId: workspace.id }, query: { limit: 200 } }, { staleTime: 60_000 });
  return (
    <Select
      aria-label={placeholder}
      placeholder={placeholder}
      value={value ?? null}
      onChange={onChange}
      clearable
      searchable
      options={[{ value: 'me', label: 'Me' }, { value: 'unassigned', label: 'Unassigned' }, ...(q.data ?? []).map((p) => ({ value: p.membershipId, label: p.displayName }))]}
    />
  );
};

/** Saved views: typed URL filters (never SQL), own or shared. */
const SavedViews = ({ current, apply }: { current: Record<string, string>; apply: (f: Record<string, string>) => void }) => {
  const { workspace } = useWorkspace();
  const can = useCan();
  const views = useApiQuery(taskEndpoints.views, { params: { workspaceId: workspace.id } });
  const [saveOpen, setSaveOpen] = useState(false);
  const [name, setName] = useState('');
  const [deleting, setDeleting] = useState<{ id: string; name: string } | null>(null);
  const save = useApiMutation(taskEndpoints.saveView, { invalidate: ['tasks.views'], successMessage: 'View saved' });
  const del = useApiMutation(taskEndpoints.deleteView, { invalidate: ['tasks.views'], successMessage: 'View deleted' });
  const items: MenuItem[] = [
    ...(views.data ?? []).map((v) => ({ label: v.name, description: v.shared ? `Shared${v.owner ? ` by ${v.owner.displayName}` : ''}` : 'Only you', onSelect: () => apply(v.filters) })),
    { label: 'Save Current View…', icon: <BookmarkSimple size={14} />, onSelect: () => setSaveOpen(true), separatorBefore: (views.data ?? []).length > 0 },
    ...(views.data ?? []).filter((v) => v.mine).map((v, i) => ({ label: `Delete “${v.name}”`, icon: <Trash size={14} />, destructive: true, separatorBefore: i === 0, onSelect: () => setDeleting({ id: v.id, name: v.name }) })),
  ];
  const [shared, setShared] = useState(false);
  return (
    <>
      <Menu label="Saved views" align="start" trigger={<Button size="sm" icon={<BookmarkSimple size={14} />}>Views</Button>} items={items} />
      <Dialog
        open={saveOpen}
        onOpenChange={setSaveOpen}
        size="small"
        title="Save view"
        description="Saves the current filters, sort and layout."
        footer={
          <>
            <Button onClick={() => setSaveOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={name.trim().length < 2}
              loading={save.isPending}
              onClick={async () => {
                await save.run({ params: { workspaceId: workspace.id }, body: { name: name.trim(), filters: current, shared } });
                setSaveOpen(false);
                setName('');
              }}
            >
              Save View
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <Field label="Name" required>
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus />
          </Field>
          {can('tasks.assign') ? <Switch label="Share with the workspace" checked={shared} onCheckedChange={setShared} /> : null}
        </div>
      </Dialog>
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Delete saved view?"
        body={`“${deleting?.name ?? ''}” is removed from your views. No tasks are changed.`}
        confirmLabel="Delete View"
        destructive
        loading={del.isPending}
        onConfirm={async () => {
          await del.run({ params: { workspaceId: workspace.id, viewId: deleting!.id }, body: {} });
          setDeleting(null);
        }}
      />
    </>
  );
};

/** Keyboard alternative for the board: every card has a Move to menu; the server validates each move. */
const useBoardMove = () => {
  const { workspace } = useWorkspace();
  const [needsReason, setNeedsReason] = useState<{ task: TaskRow; to: string; message: string } | null>(null);
  const [reason, setReason] = useState('');
  const m = useApiMutation(taskEndpoints.transition, { invalidate: TASK_INVALIDATE, silentErrors: true });
  const move = async (task: TaskRow, to: string, why?: string) => {
    try {
      await m.run({ params: { workspaceId: workspace.id, taskId: task.id }, body: { targetState: to as never, reason: why } }, { ifMatch: task.rowVersion });
      toast.success(`Moved to ${label('taskStatus', to)}`);
      setNeedsReason(null);
      setReason('');
    } catch (e) {
      if (isApiError(e) && e.fieldErrors.some((f) => f.field === 'reason')) setNeedsReason({ task, to, message: e.fieldErrors[0]!.message });
      else toast.error(isApiError(e) ? e.message : 'The task was not moved.', isApiError(e) && e.details?.predecessors ? 'Open the task to see its predecessors or override as a lead.' : undefined);
    }
  };
  const dialog = (
    <ConfirmDialog
      open={!!needsReason}
      onOpenChange={(o) => !o && setNeedsReason(null)}
      title={`Move to ${label('taskStatus', needsReason?.to)}?`}
      body={needsReason?.message ?? ''}
      confirmLabel="Move"
      loading={m.isPending}
      confirmDisabled={reason.trim().length < 3}
      onConfirm={() => void move(needsReason!.task, needsReason!.to, reason.trim())}
    >
      <Field label="Reason" required>
        <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={LIMITS.reasonMax} />
      </Field>
    </ConfirmDialog>
  );
  return { move, dialog };
};

export interface TaskListProps {
  /** Project workspace tab: the list is limited to one project. */
  fixedProjectId?: string;
  onOpen: (id: string) => void;
  onCreate?: () => void;
}

/** Tasks table / board / timeline with URL filters, Select Visible / Select All Matching and bulk actions (S27). */
export const TaskList = ({ fixedProjectId, onOpen, onCreate }: TaskListProps) => {
  const { workspace, user } = useWorkspace();
  const can = useCan();
  const wsPath = useWsPath();
  const { state, set, list } = useUrlState<TaskFilterKey>({ sort: 'dueAt', dir: 'asc', view: 'table', group: 'none' });
  const [search, setSearch] = useState(state.q ?? '');
  const q = useDebounced(search, 250);
  const [selection, setSelection] = useState<SelectionState>({ ids: new Set(), allMatching: false });
  const [bulkOpen, setBulkOpen] = useState(false);
  const board = state.view === 'board';
  const timeline = state.view === 'timeline';
  const filter: Omit<TaskListQuery, 'cursor' | 'pageSize' | 'sort' | 'direction'> = {
    q: q.length >= 2 ? q : undefined,
    status: list('status') as TaskListQuery['status'],
    priority: list('priority') as TaskListQuery['priority'],
    projectId: fixedProjectId ?? state.projectId,
    assignee: state.assignee,
    reviewer: state.reviewer,
    following: state.following === '1' ? true : undefined,
    overdue: state.overdue === '1' ? true : undefined,
    blocked: state.blocked === '1' ? true : undefined,
    tag: state.tag || undefined,
    includeClosed: state.closed === '1' || board ? true : undefined,
  };
  const query = { ...filter, sort: (state.sort ?? 'dueAt') as TaskListQuery['sort'], direction: (state.dir ?? 'asc') as 'asc' | 'desc', pageSize: board || timeline ? 200 : 50 };
  const data = useApiInfinite(taskEndpoints.list, { params: { workspaceId: workspace.id }, query });
  const count = useApiQuery(taskEndpoints.count, { params: { workspaceId: workspace.id }, query: filter }, { enabled: selection.allMatching || selection.ids.size > 0 });
  const filtered = FILTER_KEYS.some((k) => k !== 'closed' && state[k]) || (!!q && q.length >= 2);
  const clear = () => {
    setSearch('');
    set(Object.fromEntries(FILTER_KEYS.map((k) => [k, null])) as never);
  };
  const { move, dialog: moveDialog } = useBoardMove();
  const bulkSelection: BulkSelection = selection.allMatching ? { filter, expectedCount: count.data?.count ?? 0 } : { ids: [...selection.ids] };
  const canBulk = can('tasks.edit');

  const columns: Column<TaskRow>[] = [
    {
      key: 'title',
      header: 'Title',
      sticky: true,
      minWidth: 260,
      sortable: true,
      cell: (t) => (
        <span className="flex min-w-0 flex-col">
          <Link href={wsPath(`/tasks/${t.id}`)} className="truncate font-medium text-fg hover:underline" onClick={(e) => { e.preventDefault(); e.stopPropagation(); onOpen(t.id); }}>
            {t.title}
          </Link>
          {t.parent ? <span className="truncate text-[12px] text-fg-2">Subtask of {t.parent.title ?? 'a task you cannot view'}</span> : null}
        </span>
      ),
    },
    { key: 'project', header: 'Project', minWidth: 150, hidden: !!fixedProjectId, cell: (t) => t.project.name },
    {
      key: 'linked',
      header: 'Linked Object',
      minWidth: 170,
      cell: (t) =>
        t.linked.length ? (
          <span className="flex flex-col text-[12px]">
            {t.linked.slice(0, 2).map((l) => (
              <span key={l.id} className="truncate">
                {label('linkedType', l.type)}: {l.label ?? 'restricted'}
              </span>
            ))}
          </span>
        ) : (
          <span className="text-fg-muted">—</span>
        ),
    },
    { key: 'assignee', header: 'Assignee', minWidth: 160, cell: (t) => <Person member={t.assignee} /> },
    { key: 'reviewer', header: 'Reviewer', minWidth: 150, cell: (t) => <Person member={t.reviewer} empty="—" /> },
    { key: 'status', header: 'Status', minWidth: 120, cell: (t) => <TaskStatusBadge status={t.status} /> },
    { key: 'priority', header: 'Priority', minWidth: 100, cell: (t) => <PriorityBadge priority={t.priority} /> },
    { key: 'start', header: 'Start', minWidth: 120, cell: (t) => (t.startAt ? new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeZone: user.timezone }).format(new Date(t.startAt)) : <span className="text-fg-muted">—</span>) },
    { key: 'dueAt', header: 'Due', minWidth: 170, sortable: true, cell: (t) => <DueText due={t.due} tz={user.timezone} overdue={t.overdue} compact /> },
    { key: 'estimate', header: 'Estimate', minWidth: 110, align: 'right', cell: (t) => (t.estimateMinutes === null ? <span className="font-sans text-fg-muted">Not estimated</span> : formatMinutes(t.estimateMinutes)) },
    {
      key: 'deps',
      header: 'Dependencies',
      minWidth: 120,
      cell: (t) => (t.dependencies.total ? `${t.dependencies.openPredecessors} open of ${t.dependencies.total}` : <span className="text-fg-muted">—</span>),
    },
    {
      key: 'blocked',
      header: 'Blocked reason',
      minWidth: 180,
      cell: (t) => (t.blocked ? <span className="text-warning">{t.blocked.reason}</span> : <span className="text-fg-muted">—</span>),
    },
    { key: 'updatedAt', header: 'Updated', minWidth: 120, sortable: true, hidden: true, cell: () => null },
  ];

  const groupBy = state.group ?? 'none';
  const groups = useMemo(() => {
    if (groupBy === 'none') return null;
    const keyOf = (t: TaskRow) =>
      groupBy === 'status' ? label('taskStatus', t.status) : groupBy === 'project' ? t.project.name : groupBy === 'priority' ? label('taskPriority', t.priority) : (t.assignee?.displayName ?? 'Unassigned');
    const m = new Map<string, TaskRow[]>();
    for (const t of data.items) m.set(keyOf(t), [...(m.get(keyOf(t)) ?? []), t]);
    return [...m.entries()];
  }, [data.items, groupBy]);

  const selectedCount = selection.allMatching ? (count.data?.count ?? 0) : selection.ids.size;
  const table = (rows: TaskRow[], caption: string) => (
    <DataTable
      caption={caption}
      rows={rows}
      columns={columns}
      getRowId={(t) => t.id}
      density={user.density}
      sort={{ key: query.sort, direction: query.direction }}
      onSortChange={(s) => set({ sort: s.key, dir: s.direction })}
      onRowClick={(t) => onOpen(t.id)}
      selection={canBulk ? selection : undefined}
      onSelectionChange={canBulk ? setSelection : undefined}
      totalMatching={count.data?.count ?? null}
      hasMore={data.hasNextPage}
      loadingMore={data.isFetchingNextPage}
      onLoadMore={() => void data.fetchNextPage()}
    />
  );

  return (
    <div className="flex flex-col gap-4">
      <Toolbar>
        <div className="w-full sm:w-[220px]">
          <Input value={search} onChange={(e) => { setSearch(e.target.value); set({ q: e.target.value || null }); }} placeholder="Search tasks" aria-label="Search tasks" />
        </div>
        <div className="w-[150px]">
          <MultiSelect aria-label="Status" placeholder="Status" value={list('status')} onChange={(v) => set({ status: v.join(',') || null })} options={TASK_STATUSES.map((s) => ({ value: s, label: label('taskStatus', s) }))} />
        </div>
        <div className="w-[140px]">
          <MultiSelect aria-label="Priority" placeholder="Priority" value={list('priority')} onChange={(v) => set({ priority: v.join(',') || null })} options={TASK_PRIORITIES.map((p) => ({ value: p, label: label('taskPriority', p) }))} />
        </div>
        {!fixedProjectId ? (
          <div className="w-[190px]">
            <EntitySelect type="project" aria-label="Project" placeholder="Project" value={state.projectId} onChange={(v) => set({ projectId: v })} clearable />
          </div>
        ) : null}
        <div className="w-[170px]">
          <AssigneeFilter value={state.assignee} onChange={(v) => set({ assignee: v })} placeholder="Assignee" />
        </div>
        <div className="w-[130px]">
          <Input value={state.tag ?? ''} onChange={(e) => set({ tag: e.target.value || null })} placeholder="Tag" aria-label="Tag" />
        </div>
        <Switch label="Overdue" checked={state.overdue === '1'} onCheckedChange={(v) => set({ overdue: v ? '1' : null })} />
        <Switch label="Blocked" checked={state.blocked === '1'} onCheckedChange={(v) => set({ blocked: v ? '1' : null })} />
        <Switch label="Following" checked={state.following === '1'} onCheckedChange={(v) => set({ following: v ? '1' : null })} />
        {!board ? <Switch label="Show closed" checked={state.closed === '1'} onCheckedChange={(v) => set({ closed: v ? '1' : null })} /> : null}
        <div className="ml-auto flex flex-wrap items-center gap-1">
          {!board && !timeline ? (
            <div className="w-[150px]">
              <Select
                aria-label="Group by"
                value={groupBy}
                onChange={(v) => set({ group: v ?? 'none' })}
                options={[
                  { value: 'none', label: 'No grouping' },
                  { value: 'status', label: 'Group by status' },
                  { value: 'project', label: 'Group by project' },
                  { value: 'assignee', label: 'Group by assignee' },
                  { value: 'priority', label: 'Group by priority' },
                ]}
              />
            </div>
          ) : null}
          <SavedViews current={Object.fromEntries(Object.entries(state).filter(([k, v]) => v && !['open', 'create'].includes(k))) as Record<string, string>} apply={(f) => set({ ...Object.fromEntries(FILTER_KEYS.map((k) => [k, null])), ...f } as never)} />
          <div role="group" aria-label="Layout" className="flex items-center gap-1">
            <Button size="sm" variant={!board && !timeline ? 'secondary' : 'ghost'} icon={<Table size={14} />} aria-pressed={!board && !timeline} onClick={() => set({ view: 'table' })}>
              Table
            </Button>
            <Button size="sm" variant={board ? 'secondary' : 'ghost'} icon={<KanbanIcon size={14} />} aria-pressed={board} onClick={() => set({ view: 'board' })}>
              Board
            </Button>
            <Button size="sm" variant={timeline ? 'secondary' : 'ghost'} icon={<ChartBarHorizontal size={14} />} aria-pressed={timeline} onClick={() => set({ view: 'timeline' })}>
              Timeline
            </Button>
          </div>
        </div>
      </Toolbar>
      {canBulk && selectedCount > 0 ? (
        <div className="flex flex-wrap items-center gap-2 rounded-[8px] border border-line bg-surface px-3 py-2" role="region" aria-label="Bulk actions">
          <span className="text-[13px] text-fg">{selection.allMatching ? `All ${selectedCount} matching tasks` : `${selectedCount} selected`}</span>
          <Button size="sm" icon={<ArrowsLeftRight size={14} />} onClick={() => setBulkOpen(true)}>
            Bulk Change…
          </Button>
        </div>
      ) : null}
      <QueryState query={data}>
        {data.items.length === 0 && !data.isFetching ? (
          filtered ? (
            <NoResults onClear={clear} />
          ) : (
            <EmptyState
              icon={<CheckSquare size={28} />}
              title={fixedProjectId ? 'No tasks in this project yet' : 'No open tasks'}
              description={can('tasks.create') ? 'Create a task, or apply a template to plan the work.' : 'Tasks assigned to you or in your projects appear here. Ask a lead if you expect to see work.'}
              action={can('tasks.create') && onCreate ? <Button variant="primary" onClick={onCreate}>New Task</Button> : undefined}
            />
          )
        ) : timeline ? (
          <TaskTimeline
            items={data.items}
            tz={user.timezone}
            canEdit={can('tasks.edit')}
            showProject={!fixedProjectId}
            onOpen={onOpen}
            hasMore={!!data.hasNextPage}
            loadingMore={data.isFetchingNextPage}
            onLoadMore={() => void data.fetchNextPage()}
          />
        ) : board ? (
          <Kanban
            label="Task board"
            columns={BOARD_COLUMNS.map((c) => ({ key: c, label: label('taskStatus', c) }))}
            items={data.items.filter((t) => (BOARD_COLUMNS as readonly string[]).includes(t.status))}
            getId={(t) => t.id}
            getColumn={(t) => t.status}
            onMove={(t, to) => void move(t, to)}
            renderCard={(t) => (
              <div className="flex flex-col gap-2">
                <div className="flex items-start justify-between gap-2">
                  <button type="button" className="line-clamp-3 text-left text-[13px] font-medium text-fg hover:underline" onClick={() => onOpen(t.id)}>
                    {t.title}
                  </button>
                  <Menu
                    label={`Move ${t.title}`}
                    trigger={<IconButton label={`Move “${t.title}” to…`} icon={<DotsThree size={16} weight="bold" />} />}
                    items={BOARD_COLUMNS.filter((c) => c !== t.status).map((c) => ({ label: `Move to ${label('taskStatus', c)}`, onSelect: () => void move(t, c) }))}
                  />
                </div>
                <div className="flex flex-wrap items-center gap-2 text-[12px] text-fg-2">
                  {!fixedProjectId ? <span className="truncate">{t.project.name}</span> : null}
                  <PriorityBadge priority={t.priority} />
                  {t.blocked ? <Badge tone="warning">Blocked</Badge> : null}
                </div>
                <div className="flex items-center justify-between gap-2 text-[12px]">
                  <Person member={t.assignee} />
                  <DueText due={t.due} tz={user.timezone} overdue={t.overdue} compact />
                </div>
              </div>
            )}
          />
        ) : groups ? (
          <div className="flex flex-col gap-4">
            {groups.map(([g, rows]) => (
              <section key={g} aria-label={g} className="flex flex-col gap-2">
                <h3 className="text-[14px] font-semibold text-fg">
                  {g} <span className="font-normal text-fg-2">{rows.length}</span>
                </h3>
                {table(rows, `Tasks: ${g}`)}
              </section>
            ))}
          </div>
        ) : (
          table(data.items, 'Tasks')
        )}
      </QueryState>
      {moveDialog}
      <BulkDialog
        open={bulkOpen}
        onOpenChange={setBulkOpen}
        selection={bulkSelection}
        onDone={() => {
          setBulkOpen(false);
          setSelection({ ids: new Set(), allMatching: false });
          toast.success('Bulk change applied');
        }}
      />
    </div>
  );
};
