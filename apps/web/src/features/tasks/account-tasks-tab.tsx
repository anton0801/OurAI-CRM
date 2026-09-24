'use client';
import { CheckSquare, Plus } from '@phosphor-icons/react';
import { useRef } from 'react';
import { taskEndpoints, type TaskRow } from '@castlane/api-contracts';
import { Button, DataTable, EmptyState, Switch, Toolbar, type Column } from '@castlane/ui';
import { QueryState } from '@/components/common/query-state';
import { useApiInfinite } from '@/lib/hooks';
import { useUrlState } from '@/lib/url-state';
import { useCan, useWorkspace } from '@/lib/workspace-context';
import { DueText, Person, PriorityBadge, TaskStatusBadge } from './format';
import { TaskDrawer } from './task-drawer';
import { TaskForm } from './task-form';

/** Account Detail → Tasks (S20): tasks linked to this account, the same records as /tasks. */
export const AccountTasksTab = ({ accountId, projectId }: { accountId: string; projectId: string }) => {
  const { workspace, user } = useWorkspace();
  const can = useCan();
  const { state, set } = useUrlState<'open' | 'create' | 'closed'>();
  const created = useRef<string | null>(null);
  const data = useApiInfinite(taskEndpoints.list, { params: { workspaceId: workspace.id }, query: { accountId, includeClosed: state.closed === '1' ? true : undefined, sort: 'dueAt', direction: 'asc', pageSize: 50 } });
  const columns: Column<TaskRow>[] = [
    { key: 'title', header: 'Title', sticky: true, minWidth: 240, cell: (t) => <span className="font-medium text-fg">{t.title}</span> },
    { key: 'assignee', header: 'Assignee', minWidth: 160, cell: (t) => <Person member={t.assignee} /> },
    { key: 'status', header: 'Status', minWidth: 120, cell: (t) => <TaskStatusBadge status={t.status} /> },
    { key: 'priority', header: 'Priority', minWidth: 100, cell: (t) => <PriorityBadge priority={t.priority} /> },
    { key: 'due', header: 'Due', minWidth: 160, cell: (t) => <DueText due={t.due} tz={user.timezone} overdue={t.overdue} compact /> },
  ];
  return (
    <div className="flex flex-col gap-4">
      <Toolbar>
        <Switch label="Show closed" checked={state.closed === '1'} onCheckedChange={(v) => set({ closed: v ? '1' : null })} />
        {can('tasks.create') ? (
          <Button className="ml-auto" variant="primary" icon={<Plus size={14} />} onClick={() => set({ create: '1' })}>
            New Task
          </Button>
        ) : null}
      </Toolbar>
      <QueryState query={data}>
        {data.items.length === 0 && !data.isFetching ? (
          <EmptyState icon={<CheckSquare size={28} />} title="No open tasks for this account" description="Tasks linked to this account appear here." />
        ) : (
          <DataTable
            caption="Account tasks"
            rows={data.items}
            columns={columns}
            getRowId={(t) => t.id}
            density={user.density}
            onRowClick={(t) => set({ open: t.id })}
            hasMore={data.hasNextPage}
            loadingMore={data.isFetchingNextPage}
            onLoadMore={() => void data.fetchNextPage()}
          />
        )}
      </QueryState>
      <TaskDrawer taskId={state.open} onClose={() => set({ open: null })} />
      <TaskForm
        open={state.create === '1'}
        defaults={{ projectId, accountId }}
        onOpenChange={(o) => {
          if (o) return;
          const id = created.current;
          created.current = null;
          set(id ? { create: null, open: id } : { create: null });
        }}
        onSaved={(id) => (created.current = id)}
      />
    </div>
  );
};
