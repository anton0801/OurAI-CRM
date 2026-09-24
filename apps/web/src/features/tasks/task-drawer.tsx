'use client';
import { ArrowsOutSimple } from '@phosphor-icons/react';
import Link from 'next/link';
import { taskEndpoints } from '@castlane/api-contracts';
import { Drawer } from '@castlane/ui';
import { useApiQuery } from '@/lib/hooks';
import { useWorkspace, useWsPath } from '@/lib/workspace-context';
import { TaskDetailView } from './task-detail';

/**
 * Task detail in a 760 px side drawer (Tasks list, project tab, My Work). The same record as the
 * full page; the query is shared with the body so the title costs no extra request.
 */
export const TaskDrawer = ({ taskId, onClose }: { taskId: string | null | undefined; onClose: () => void }) => {
  const { workspace } = useWorkspace();
  const wsPath = useWsPath();
  const q = useApiQuery(taskEndpoints.get, { params: { workspaceId: workspace.id, taskId: taskId ?? '' } }, { enabled: !!taskId });
  return (
    <Drawer
      open={!!taskId}
      onOpenChange={(o) => !o && onClose()}
      width={760}
      title={q.data?.title ?? 'Task'}
      description={q.data ? q.data.project.name : undefined}
      headerActions={
        taskId ? (
          <Link
            href={wsPath(`/tasks/${taskId}`)}
            aria-label="Open full page"
            title="Open full page"
            className="rounded-[8px] p-2 text-fg-2 hover:bg-surface-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-[var(--c-focus)]"
          >
            <ArrowsOutSimple size={18} />
          </Link>
        ) : null
      }
    >
      {taskId ? <TaskDetailView taskId={taskId} variant="drawer" /> : null}
    </Drawer>
  );
};
