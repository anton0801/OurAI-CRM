'use client';
import { Plus, Target } from '@phosphor-icons/react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { GOAL_SCOPE_TYPES, goalEndpoints, type GoalRow } from '@castlane/api-contracts';
import { GOAL_STATUSES } from '@castlane/domain';
import { Avatar, Badge, Button, DataTable, EmptyState, Input, MultiSelect, NoResults, PageHeader, Select, StatusBadge, Switch, Toolbar, formatDate, formatNumber, type Column } from '@castlane/ui';
import { EntitySelect } from '@/components/common/entity-select';
import { MemberSelect } from '@/components/common/pickers';
import { QueryState } from '@/components/common/query-state';
import { useDebounced } from '@/components/common/use-debounced';
import { useApiInfinite } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useUrlState } from '@/lib/url-state';
import { useCan, useWorkspace, useWsPath } from '@/lib/workspace-context';
import { GoalFormDrawer } from './goal-form';
import { GoalProgress } from './goal-progress';
import { MeasuredValue } from './measured';
import './labels';

type Filters = 'q' | 'status' | 'ownerMembershipId' | 'projectId' | 'scopeType' | 'archived' | 'new' | 'open';

const targetText = (g: Pick<GoalRow, 'targetType' | 'targetValue' | 'unit'>) => {
  const n = formatNumber(g.targetValue, { maximumFractionDigits: 2 });
  const unit = g.unit === 'percent' ? '%' : g.unit === 'count' || g.unit === 'number' ? '' : ` ${g.unit}`;
  if (g.targetType === 'increase_by') return `+${n}${unit}`;
  if (g.targetType === 'decrease_to') return `↓ ${n}${unit}`;
  return `${n}${unit}`;
};
export { targetText as goalTargetText };

/**
 * S53 Goals: planned results measured by canonical metrics. Filters live in the URL.
 * Used standalone and as the project workspace "Goals" tab (fixed project).
 */
export const GoalsScreen = ({ projectId, embedded = false }: { projectId?: string; embedded?: boolean }) => {
  const { workspace, user } = useWorkspace();
  const can = useCan();
  const wsPath = useWsPath();
  const router = useRouter();
  const { state, set, list } = useUrlState<Filters>();
  const [search, setSearch] = useState(state.q ?? '');
  const q = useDebounced(search, 250);
  const fixedProject = projectId;
  // Deep links from search/notifications (?open=<goalId>) land on the goal page.
  useEffect(() => {
    if (state.open) router.replace(wsPath(`/goals/${state.open}`));
  }, [state.open, router, wsPath]);
  const query = {
    q: q.length >= 2 ? q : undefined,
    status: list('status') as GoalRow['status'][],
    ownerMembershipId: state.ownerMembershipId,
    projectId: fixedProject ?? state.projectId,
    scopeType: state.scopeType as GoalRow['scope']['type'] | undefined,
    includeArchived: state.archived === '1' ? true : undefined,
  };
  const data = useApiInfinite(goalEndpoints.list, { params: { workspaceId: workspace.id }, query });
  const filtered = !!(query.q || query.status.length || query.ownerMembershipId || (!fixedProject && query.projectId) || query.scopeType);
  const clear = () => {
    setSearch('');
    set({ q: null, status: null, ownerMembershipId: null, projectId: null, scopeType: null });
  };
  const canWrite = can('goals.write');
  const openNew = () => set({ new: '1' });
  // After a save the goal page opens; the drawer's close must not rewrite the URL back.
  const navigated = useRef(false);

  const columns: Column<GoalRow>[] = [
    {
      key: 'name',
      header: 'Name',
      sticky: true,
      minWidth: 220,
      cell: (g) => (
        <Link href={wsPath(`/goals/${g.id}`)} className="font-medium text-fg hover:underline" onClick={(e) => e.stopPropagation()}>
          {g.name}
        </Link>
      ),
    },
    {
      key: 'metric',
      header: 'Metric',
      minWidth: 170,
      cell: (g) => (
        <span className="flex flex-col">
          <span>{g.metric.label}</span>
          {!g.metric.available ? <span className="text-[12px] text-fg-muted">Not visible to your role</span> : null}
        </span>
      ),
    },
    {
      key: 'scope',
      header: 'Scope',
      minWidth: 160,
      cell: (g) => (
        <span className="flex flex-col">
          <span className="truncate">{g.scope.label}</span>
          <span className="text-[12px] text-fg-2">{label('goalScope', g.scope.type)}</span>
        </span>
      ),
    },
    {
      key: 'target',
      header: 'Target',
      align: 'right',
      minWidth: 130,
      cell: (g) => (
        <span className="flex flex-col items-end">
          <span className="tabular-nums">{targetText(g)}</span>
          <span className="text-[12px] text-fg-2">{label('goalTargetType', g.targetType)}</span>
        </span>
      ),
    },
    { key: 'period', header: 'Period', minWidth: 190, cell: (g) => `${formatDate(g.periodStart)} – ${formatDate(g.periodEnd)}` },
    {
      key: 'current',
      header: 'Current',
      align: 'right',
      minWidth: 140,
      cell: (g) => (
        <span className="flex flex-col items-end">
          <MeasuredValue value={g.status === 'closed' && g.achievedValue !== null ? { ...g.current.value, status: 'known', value: g.achievedValue } : g.current.value} className="tabular-nums" />
          {g.current.source === 'manual' ? (
            <Badge tone="info" title={g.current.manualSource ?? undefined}>
              Manual
            </Badge>
          ) : null}
        </span>
      ),
    },
    { key: 'progress', header: 'Progress', minWidth: 190, cell: (g) => <GoalProgress goal={g} /> },
    {
      key: 'owner',
      header: 'Owner',
      minWidth: 160,
      cell: (g) => (
        <span className="flex items-center gap-2">
          <Avatar name={g.owner.displayName} src={g.owner.avatarUrl} size={24} decorative />
          <span className="truncate">{g.owner.displayName}</span>
        </span>
      ),
    },
    { key: 'status', header: 'Status', minWidth: 110, cell: (g) => <StatusBadge status={g.status} label={label('goalStatus', g.status)} /> },
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
          placeholder="Search goals"
          aria-label="Search goals"
        />
      </div>
      <div className="w-[160px]">
        <MultiSelect aria-label="Status" placeholder="Status" value={list('status')} onChange={(v) => set({ status: v.join(',') || null })} options={GOAL_STATUSES.map((s) => ({ value: s, label: label('goalStatus', s) }))} />
      </div>
      <div className="w-[180px]">
        <MemberSelect aria-label="Owner" placeholder="Owner" value={state.ownerMembershipId} onChange={(v) => set({ ownerMembershipId: v })} clearable />
      </div>
      {!fixedProject ? (
        <div className="w-[180px]">
          <EntitySelect type="project" aria-label="Project" placeholder="Project" value={state.projectId} onChange={(v) => set({ projectId: v })} clearable />
        </div>
      ) : null}
      <div className="w-[150px]">
        <Select
          aria-label="Scope"
          placeholder="Scope"
          value={state.scopeType ?? null}
          onChange={(v) => set({ scopeType: v })}
          clearable
          options={GOAL_SCOPE_TYPES.map((t) => ({ value: t, label: label('goalScope', t) }))}
        />
      </div>
      <div className="flex items-center gap-4 px-1">
        <Switch label="Show archived" checked={state.archived === '1'} onCheckedChange={(v) => set({ archived: v ? '1' : null })} />
      </div>
    </Toolbar>
  );

  return (
    <div className="flex flex-col gap-5">
      {!embedded ? (
        <PageHeader
          title="Goals"
          description="Planned results measured by canonical metrics. Progress is never rounded up to the target; unavailable data is shown as words, not zeros."
          actions={
            canWrite ? (
              <Button variant="primary" icon={<Plus size={14} weight="bold" />} onClick={openNew}>
                New Goal
              </Button>
            ) : undefined
          }
        />
      ) : canWrite ? (
        <div className="flex justify-end">
          <Button variant="primary" icon={<Plus size={14} weight="bold" />} onClick={openNew}>
            New Goal
          </Button>
        </div>
      ) : null}
      {toolbar}
      <QueryState query={data}>
        {data.items.length === 0 && !data.isFetching ? (
          filtered ? (
            <NoResults onClear={clear} />
          ) : (
            <EmptyState
              icon={<Target size={28} />}
              title="No goals yet"
              description="Set a target for a canonical metric — for example publications per month or on-time rate — and follow progress against it."
              action={canWrite ? <Button variant="primary" onClick={openNew}>New Goal</Button> : undefined}
            />
          )
        ) : (
          <DataTable
            caption="Goals"
            rows={data.items}
            columns={columns}
            getRowId={(g) => g.id}
            density={user.density}
            onRowClick={(g) => router.push(wsPath(`/goals/${g.id}`))}
            hasMore={data.hasNextPage}
            loadingMore={data.isFetchingNextPage}
            onLoadMore={() => void data.fetchNextPage()}
          />
        )}
      </QueryState>
      {canWrite ? (
        <GoalFormDrawer
          open={state.new === '1'}
          onClose={() => {
            if (!navigated.current) set({ new: null });
            navigated.current = false;
          }}
          defaults={fixedProject ? { scopeType: 'project', scopeId: fixedProject } : undefined}
          onSaved={(g) => {
            navigated.current = true;
            router.push(wsPath(`/goals/${g.id}`));
          }}
        />
      ) : null}
    </div>
  );
};
