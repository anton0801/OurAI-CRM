import { registerProjectTab } from '@/lib/project-tabs';
import { ProjectFilesTab } from './project-files-tab';

registerProjectTab({ key: 'files', label: 'Files', order: 60, visible: (_p, can) => can('assets.read'), component: ProjectFilesTab });
