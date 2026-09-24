'use client';
import { DotsThree, Plus } from '@phosphor-icons/react';
import { Button, IconButton, Menu, PageHeader, PermissionDenied, TabPanel, Tabs, type MenuItem } from '@castlane/ui';
import { useUrlState } from '@/lib/url-state';
import { useCan, useWsPath } from '@/lib/workspace-context';
import { ApprovalsView } from './approvals-view';
import { EntriesView } from './entries-view';
import { EntryForm } from './entry-form';
import { RunningTimerPanel } from './timer';
import { WeekView } from './week-view';

type Tab = 'week' | 'entries' | 'approvals';

/** S30 Time Entries: My Week, all visible entries, and approvals. Tracking is voluntary and explicit. */
export const TimeScreen = () => {
  const can = useCan();
  const wsPath = useWsPath();
  const writer = can('time.write.own');
  const approver = can('time.approve');
  const reader = writer || can(['time.read.own', 'time.read.scope']);
  const { state, set } = useUrlState<'tab' | 'add' | 'task'>({ tab: writer ? 'week' : 'entries' });
  const tabs: { value: Tab; label: string; hidden?: boolean }[] = [
    { value: 'week', label: 'My Week', hidden: !writer },
    { value: 'entries', label: 'Entries' },
    { value: 'approvals', label: 'Approvals', hidden: !approver },
  ];
  const visible = tabs.filter((t) => !t.hidden).map((t) => t.value);
  const tab: Tab = visible.includes(state.tab as Tab) ? (state.tab as Tab) : (visible[0] ?? 'entries');
  const more: MenuItem[] = [
    { label: 'Export Time Entries', href: wsPath('/exports?dataset=time_entries'), hidden: !can('exports.create') },
    { label: 'Workload', href: wsPath('/team/workload'), hidden: !can('workload.read') },
    { label: 'My Work', href: wsPath('/my-work') },
  ];
  if (!reader) return <PermissionDenied description="Your role does not include time tracking." />;
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Time Entries"
        description="Explicit time on tasks, from timers or manual entries. Capacity and estimates are plans, not recorded work."
        actions={
          <>
            {writer ? (
              <Button variant="primary" icon={<Plus size={14} />} onClick={() => set({ add: '1' })}>
                Add Entry
              </Button>
            ) : null}
            <Menu label="More" trigger={<IconButton label="More" icon={<DotsThree size={18} weight="bold" />} variant="secondary" />} items={more} />
          </>
        }
      />
      {writer ? <RunningTimerPanel /> : null}
      <Tabs label="Time views" value={tab} onValueChange={(v) => set({ tab: v })} items={tabs}>
        {writer ? (
          <TabPanel value="week">
            <WeekView />
          </TabPanel>
        ) : null}
        <TabPanel value="entries">
          <EntriesView />
        </TabPanel>
        {approver ? (
          <TabPanel value="approvals">
            <ApprovalsView />
          </TabPanel>
        ) : null}
      </Tabs>
      <EntryForm open={state.add === '1'} onOpenChange={(o) => !o && set({ add: null, task: null })} defaultTaskId={state.task} />
    </div>
  );
};
