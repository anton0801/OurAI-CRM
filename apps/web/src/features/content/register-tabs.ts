import { registerProjectTab } from '@/lib/project-tabs';
import { ProjectContentTab } from './content-panels';

registerProjectTab({
  key: 'content',
  label: 'Content',
  order: 20,
  visible: (_p, can) => can('content.read'),
  component: ProjectContentTab,
});
