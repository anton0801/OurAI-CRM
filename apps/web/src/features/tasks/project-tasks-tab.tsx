'use client';
import { Plus, Stack } from '@phosphor-icons/react';
import { useRef, useState } from 'react';
import type { ProjectDetail } from '@castlane/api-contracts';
import { Button, Toolbar } from '@castlane/ui';
import { useUrlState } from '@/lib/url-state';
import { ApplyTemplateDialog } from './apply-template-dialog';
import { RecurringView } from './recurring-view';
import { TaskDrawer } from './task-drawer';
import { TaskForm } from './task-form';
import { TaskList } from './task-list';

/** Project workspace tab (S15 → S27): the same task records as /tasks, limited to this project. */
export const ProjectTasksTab = ({ project }: { project: ProjectDetail }) => {
  const { state, set } = useUrlState<'taskView' | 'open' | 'create'>({ taskView: 'tasks' });
  const [templateOpen, setTemplateOpen] = useState(false);
  const created = useRef<string | null>(null);
  const canCreate = project.permissions.createTask && project.status !== 'archived';
  const recurring = state.taskView === 'recurring';
  return (
    <div className="flex flex-col gap-4">
      <Toolbar>
        <div role="group" aria-label="Task view" className="flex items-center gap-1">
          <Button size="sm" variant={!recurring ? 'secondary' : 'ghost'} aria-pressed={!recurring} onClick={() => set({ taskView: 'tasks' })}>
            Tasks
          </Button>
          <Button size="sm" variant={recurring ? 'secondary' : 'ghost'} aria-pressed={recurring} onClick={() => set({ taskView: 'recurring' })}>
            Recurring
          </Button>
        </div>
        {canCreate && !recurring ? (
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Button icon={<Stack size={14} />} onClick={() => setTemplateOpen(true)}>
              Apply Template
            </Button>
            <Button variant="primary" icon={<Plus size={14} />} onClick={() => set({ create: '1' })}>
              New Task
            </Button>
          </div>
        ) : null}
      </Toolbar>
      {recurring ? (
        <RecurringView projectId={project.id} />
      ) : (
        <TaskList fixedProjectId={project.id} onOpen={(id) => set({ open: id })} onCreate={canCreate ? () => set({ create: '1' }) : undefined} />
      )}
      <TaskDrawer taskId={state.open} onClose={() => set({ open: null })} />
      <TaskForm
        open={state.create === '1'}
        defaults={{ projectId: project.id }}
        onOpenChange={(o) => {
          if (o) return;
          const id = created.current;
          created.current = null;
          set(id ? { create: null, open: id } : { create: null });
        }}
        onSaved={(id) => (created.current = id)}
      />
      <ApplyTemplateDialog open={templateOpen} onOpenChange={setTemplateOpen} projectId={project.id} />
    </div>
  );
};
