import { registerProjectTab } from '@/lib/project-tabs';
import { ProjectFinanceTab } from './slot-panels';

registerProjectTab({
  key: 'finance',
  label: 'Finance',
  order: 70,
  visible: (_p, can) => can(['finance.read', 'budgets.read']),
  component: ProjectFinanceTab,
});
