import { registerProjectTab } from '@/lib/project-tabs';
import { ProjectActivityTab } from './project-activity-tab';
import { ProjectOverviewTab } from './project-overview-tab';
import { ProjectTeamTab } from './project-team-tab';

registerProjectTab({ key: 'overview', label: 'Overview', order: 0, component: ProjectOverviewTab });
registerProjectTab({ key: 'team', label: 'Team', order: 80, component: ProjectTeamTab });
registerProjectTab({ key: 'activity', label: 'Activity', order: 100, component: ProjectActivityTab });
