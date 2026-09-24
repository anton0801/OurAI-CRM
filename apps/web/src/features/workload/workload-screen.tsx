'use client';
import { CaretLeft, CaretRight, UsersThree } from '@phosphor-icons/react';
import { useState } from 'react';
import { workloadEndpoints } from '@castlane/api-contracts';
import { DateTime } from '@castlane/domain';
import { Button, EmptyState, IconButton, NoResults, PageHeader, PermissionDenied, Toolbar, formatDate } from '@castlane/ui';
import { EntitySelect } from '@/components/common/entity-select';
import { DirectionSelect, MultiMemberSelect } from '@/components/common/pickers';
import { QueryState } from '@/components/common/query-state';
import { useApiQuery } from '@/lib/hooks';
import { useUrlState } from '@/lib/url-state';
import { useCan, useWorkspace, useWsPath } from '@/lib/workspace-context';
import { TaskDrawer } from '../tasks/task-drawer';
import { AbsencesPanel } from './absences-panel';
import { AbsenceDialog, CapacityDialog } from './workload-dialogs';
import { WorkloadGrid } from './workload-grid';

type Keys = 'period' | 'from' | 'project' | 'direction' | 'members' | 'open';

const move = (from: string, period: 'week' | 'month', dir: 1 | -1) => DateTime.fromISO(from).plus(period === 'week' ? { days: 7 * dir } : { months: dir }).toISODate() as string;

/** S29 Workload: capacity against planned estimates per member; unestimated work is an explicit unknown. */
export const WorkloadScreen = () => {
  const { workspace } = useWorkspace();
  const can = useCan();
  const wsPath = useWsPath();
  const { state, set, list } = useUrlState<Keys>({ period: 'week' });
  const [absenceOpen, setAbsenceOpen] = useState(false);
  const [capacityOpen, setCapacityOpen] = useState(false);
  const period = state.period === 'month' ? 'month' : 'week';
  const members = list('members');
  const q = useApiQuery(
    workloadEndpoints.get,
    { params: { workspaceId: workspace.id }, query: { period, from: state.from, projectId: state.project, directionId: state.direction, membershipIds: members.length ? members : undefined } },
    { enabled: can('workload.read') },
  );
  if (!can('workload.read')) return <PermissionDenied description="Workload is available to leads and managers with workload access." />;
  const d = q.data;
  const filtered = !!(state.project || state.direction || members.length);
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        crumbs={[{ label: 'Team', href: wsPath('/team') }, { label: 'Workload' }]}
        title="Workload"
        description="Planned estimates against confirmed capacity. A planning aid, not measured working time."
        actions={
          <>
            <Button onClick={() => setAbsenceOpen(true)}>Add Absence</Button>
            {d?.permissions.manage ? (
              <Button variant="primary" onClick={() => setCapacityOpen(true)}>
                Adjust Capacity
              </Button>
            ) : null}
          </>
        }
      />
      <Toolbar>
        <div role="group" aria-label="Period" className="flex items-center gap-1">
          <Button size="sm" variant={period === 'week' ? 'secondary' : 'ghost'} aria-pressed={period === 'week'} onClick={() => set({ period: 'week', from: null })}>
            Week
          </Button>
          <Button size="sm" variant={period === 'month' ? 'secondary' : 'ghost'} aria-pressed={period === 'month'} onClick={() => set({ period: 'month', from: null })}>
            Month
          </Button>
        </div>
        <div className="flex items-center gap-1">
          <IconButton label={`Previous ${period}`} icon={<CaretLeft size={16} />} disabled={!d} onClick={() => d && set({ from: move(d.from, period, -1) })} />
          <span className="min-w-[180px] text-center text-[14px] font-medium text-fg" aria-live="polite">
            {d ? `${formatDate(d.from)} – ${formatDate(d.to)}` : '…'}
          </span>
          <IconButton label={`Next ${period}`} icon={<CaretRight size={16} />} disabled={!d} onClick={() => d && set({ from: move(d.from, period, 1) })} />
          {state.from ? (
            <Button size="sm" variant="ghost" onClick={() => set({ from: null })}>
              Today
            </Button>
          ) : null}
        </div>
        <div className="w-[190px]">
          <EntitySelect type="project" aria-label="Project" placeholder="Project" value={state.project} onChange={(v) => set({ project: v })} clearable />
        </div>
        <div className="w-[170px]">
          <DirectionSelect value={state.direction} onChange={(v) => set({ direction: v })} clearable placeholder="Direction" />
        </div>
        <div className="w-[220px]">
          <MultiMemberSelect value={members} onChange={(v) => set({ members: v.join(',') || null })} placeholder="Members" />
        </div>
      </Toolbar>
      <QueryState query={q}>
        {d ? (
          d.members.length === 0 ? (
            filtered ? (
              <NoResults onClear={() => set({ project: null, direction: null, members: null })} />
            ) : (
              <EmptyState icon={<UsersThree size={28} />} title="No members to show" description="Members whose workload you may see appear here." />
            )
          ) : (
            <WorkloadGrid key={`${d.from}-${period}`} members={d.members} from={d.from} period={period} today={d.today} manage={d.permissions.manage} onOpenTask={(id) => set({ open: id })} />
          )
        ) : null}
      </QueryState>
      {d ? (
        <details className="rounded-[12px] border border-line bg-surface px-4 py-3 text-[13px] text-fg-2">
          <summary className="cursor-pointer text-fg">How workload is calculated</summary>
          <p className="mt-2 max-w-[760px]">{d.algorithm}</p>
          <p className="mt-1">Dates are calculated in {d.timezone}.</p>
        </details>
      ) : null}
      {d ? <AbsencesPanel from={d.from} to={d.to} /> : null}
      <TaskDrawer taskId={state.open} onClose={() => set({ open: null })} />
      <AbsenceDialog open={absenceOpen} onOpenChange={setAbsenceOpen} />
      <CapacityDialog open={capacityOpen} onOpenChange={setCapacityOpen} />
    </div>
  );
};
