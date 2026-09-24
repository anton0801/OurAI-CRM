import { registerProjectTab } from '@/lib/project-tabs';
import { ProjectTasksTab } from './project-tasks-tab';

registerProjectTab({ key: 'tasks', label: 'Tasks', order: 40, visible: (_p, can) => can('tasks.read'), component: ProjectTasksTab });
