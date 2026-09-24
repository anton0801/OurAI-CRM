'use client';
import type { ProjectDetail } from '@castlane/api-contracts';
import { registerProjectTab } from '@/lib/project-tabs';
import { useCan, useWsPath } from '@/lib/workspace-context';
import { CalendarScreen } from '@/features/calendar/calendar-screen';
import { PublicationTable } from './publication-list';

/** Project workspace tabs (S15) contributed by publishing: the same placements as the calendar, filtered by project. */
const ProjectPublicationsTab = ({ project }: { project: ProjectDetail }) => {
  const can = useCan();
  const wsPath = useWsPath();
  return (
    <PublicationTable
      filters={{ projectId: project.id }}
      caption="Project publications"
      hideProject
      newHref={can('publications.write') ? wsPath(`/publications/new?projectId=${project.id}`) : null}
    />
  );
};

const ProjectCalendarTab = ({ project }: { project: ProjectDetail }) => <CalendarScreen projectId={project.id} embedded />;

registerProjectTab({ key: 'publications', label: 'Publications', order: 25, visible: (_p, can) => can('publications.read'), component: ProjectPublicationsTab });
registerProjectTab({ key: 'calendar', label: 'Calendar', order: 27, visible: (_p, can) => can(['publications.read', 'tasks.read']), component: ProjectCalendarTab });
