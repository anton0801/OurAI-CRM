/**
 * Work module contributions to other modules' screens: Member Workspace tabs (Workload, Time) and
 * the Account Detail Tasks tab. Imported once from features/slots.ts.
 */
import { ACCOUNT_TABS, MEMBER_TABS } from '@/lib/slots';
import { MemberTimeTab, MemberWorkloadTab } from '../workload/member-tabs';
import { AccountTasksTab } from './account-tasks-tab';

MEMBER_TABS.register({ key: 'workload', label: 'Workload', order: 30, visible: (_p, can) => can('workload.read'), component: MemberWorkloadTab });
MEMBER_TABS.register({ key: 'time', label: 'Time', order: 40, visible: (_p, can) => can(['time.read.scope', 'time.approve']), component: MemberTimeTab });
ACCOUNT_TABS.register({ key: 'tasks', label: 'Tasks', order: 60, visible: (_p, can) => can('tasks.read'), component: AccountTasksTab });
