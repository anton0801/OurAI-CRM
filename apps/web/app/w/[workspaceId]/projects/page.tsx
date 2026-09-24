import { Suspense } from 'react';
import { ProjectsScreen } from '@/features/projects/projects-screen';

export const metadata = { title: 'Projects' };

export default function ProjectsPage() {
  return (
    <Suspense>
      <ProjectsScreen />
    </Suspense>
  );
}
