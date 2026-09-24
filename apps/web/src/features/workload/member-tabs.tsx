'use client';
import { useState } from 'react';
import { workloadEndpoints } from '@castlane/api-contracts';
import { Button, Toolbar } from '@castlane/ui';
import { QueryState } from '@/components/common/query-state';
import { useApiQuery } from '@/lib/hooks';
import { useUrlState } from '@/lib/url-state';
import { useCan, useWorkspace } from '@/lib/workspace-context';
import { TaskDrawer } from '../tasks/task-drawer';
import { WeekView } from '../time/week-view';
import { AbsencesPanel } from './absences-panel';
import { AbsenceDialog, CapacityDialog } from './workload-dialogs';
import { WorkloadGrid } from './workload-grid';

/** Member Workspace → Workload (S62): this member’s load, capacity profile and leave. */
export const MemberWorkloadTab = ({ membershipId }: { membershipId: string }) => {
  const { workspace, membershipId: me } = useWorkspace();
  const can = useCan();
  const manage = can('workload.manage');
  const { state, set } = useUrlState<'wlPeriod' | 'open'>({ wlPeriod: 'week' });
  const [absenceOpen, setAbsenceOpen] = useState(false);
  const [capacityOpen, setCapacityOpen] = useState(false);
  const period = state.wlPeriod === 'month' ? 'month' : 'week';
  const q = useApiQuery(workloadEndpoints.get, { params: { workspaceId: workspace.id }, query: { period, membershipIds: [membershipId] } });
  const d = q.data;
  return (
    <div className="flex flex-col gap-4">
      <Toolbar>
        <div role="group" aria-label="Period" className="flex items-center gap-1">
          <Button size="sm" variant={period === 'week' ? 'secondary' : 'ghost'} aria-pressed={period === 'week'} onClick={() => set({ wlPeriod: 'week' })}>
            This Week
          </Button>
          <Button size="sm" variant={period === 'month' ? 'secondary' : 'ghost'} aria-pressed={period === 'month'} onClick={() => set({ wlPeriod: 'month' })}>
            This Month
          </Button>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {manage || membershipId === me ? <Button onClick={() => setAbsenceOpen(true)}>Add Leave</Button> : null}
          {manage ? <Button onClick={() => setCapacityOpen(true)}>Edit Capacity</Button> : null}
        </div>
      </Toolbar>
      <QueryState query={q}>
        {d ? (
          d.members.length ? (
            <WorkloadGrid key={`${d.from}-${period}`} members={d.members} from={d.from} period={period} today={d.today} manage={d.permissions.manage} onOpenTask={(id) => set({ open: id })} defaultExpanded />
          ) : (
            <p className="text-[13px] text-fg-2">You cannot see this member’s workload.</p>
          )
        ) : null}
      </QueryState>
      <AbsencesPanel membershipId={membershipId} title="Leave" />
      <TaskDrawer taskId={state.open} onClose={() => set({ open: null })} />
      <AbsenceDialog open={absenceOpen} onOpenChange={setAbsenceOpen} membershipId={membershipId} />
      <CapacityDialog open={capacityOpen} onOpenChange={setCapacityOpen} membershipId={membershipId} />
    </div>
  );
};

/** Member Workspace → Time (S62): the member’s week of time entries and its submission. */
export const MemberTimeTab = ({ membershipId }: { membershipId: string }) => <WeekView membershipId={membershipId} />;
