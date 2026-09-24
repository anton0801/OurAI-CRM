import { Suspense } from 'react';
import { TaskPage } from '@/features/tasks/task-detail';

export const metadata = { title: 'Task' };

export default async function TaskDetailPage({ params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params;
  return (
    <Suspense>
      <TaskPage taskId={taskId} />
    </Suspense>
  );
}
