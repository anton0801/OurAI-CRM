import { Suspense } from 'react';
import { TasksScreen } from '@/features/tasks/tasks-screen';

export const metadata = { title: 'Tasks' };

export default function TasksPage() {
  return (
    <Suspense>
      <TasksScreen />
    </Suspense>
  );
}
