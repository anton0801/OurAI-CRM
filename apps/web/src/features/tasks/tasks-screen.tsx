'use client';
import { DotsThree, Plus } from '@phosphor-icons/react';
import { useRef, useState } from 'react';
import { Button, IconButton, Menu, PageHeader, TabPanel, Tabs, type MenuItem } from '@castlane/ui';
import { useUrlState } from '@/lib/url-state';
import { useCan, useWsPath } from '@/lib/workspace-context';
import { ApplyTemplateDialog } from './apply-template-dialog';
import { RecurringView } from './recurring-view';
import { TaskDrawer } from './task-drawer';
import { TaskForm } from './task-form';
import { TaskList } from './task-list';

type Keys = 'tab' | 'open' | 'create';

/**
 * S27 Tasks: table / board / timeline of every task in the member's scope, recurring rules, and the task drawer
 * (`?open=<id>`, deep-linkable) and create drawer (`?create=1`, used by Quick Create).
 */
export const TasksScreen = () => {
  const can = useCan();
  const wsPath = useWsPath();
  const { state, set } = useUrlState<Keys>({ tab: 'tasks' });
  const [templateOpen, setTemplateOpen] = useState(false);
  // TaskForm reports the new id before it closes; open it in the drawer in the same URL update.
  const created = useRef<string | null>(null);
  const tab = state.tab === 'recurring' ? 'recurring' : 'tasks';
  const more: MenuItem[] = [
    { label: 'Apply Template…', onSelect: () => setTemplateOpen(true), hidden: !can('tasks.create') },
    { label: 'Export Tasks', href: wsPath('/exports?dataset=tasks'), hidden: !can('exports.create') },
    { label: 'Time Entries', href: wsPath('/time'), separatorBefore: true, hidden: !can(['time.read.own', 'time.read.scope']) },
    { label: 'Workload', href: wsPath('/team/workload'), hidden: !can('workload.read') },
  ];
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Tasks"
        description="Plan and track work across the projects you can see. Overdue is calculated from the deadline; it is not a status."
        actions={
          <>
            {can('tasks.create') ? (
              <Button variant="primary" icon={<Plus size={14} />} onClick={() => set({ create: '1' })}>
                New Task
              </Button>
            ) : null}
            {more.some((m) => !m.hidden) ? <Menu label="More" trigger={<IconButton label="More" icon={<DotsThree size={18} weight="bold" />} variant="secondary" />} items={more} /> : null}
          </>
        }
      />
      <Tabs
        label="Task views"
        value={tab}
        onValueChange={(v) => set({ tab: v })}
        items={[
          { value: 'tasks', label: 'Tasks' },
          { value: 'recurring', label: 'Recurring' },
        ]}
      >
        <TabPanel value="tasks">
          <TaskList onOpen={(id) => set({ open: id })} onCreate={() => set({ create: '1' })} />
        </TabPanel>
        <TabPanel value="recurring">
          <RecurringView />
        </TabPanel>
      </Tabs>
      <TaskDrawer taskId={state.open} onClose={() => set({ open: null })} />
      <TaskForm
        open={state.create === '1'}
        onOpenChange={(o) => {
          if (o) return;
          const id = created.current;
          created.current = null;
          set(id ? { create: null, open: id } : { create: null });
        }}
        onSaved={(id) => (created.current = id)}
      />
      <ApplyTemplateDialog open={templateOpen} onOpenChange={setTemplateOpen} />
    </div>
  );
};
