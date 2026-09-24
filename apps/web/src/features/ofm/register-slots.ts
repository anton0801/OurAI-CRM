import { registerProjectTab } from '@/lib/project-tabs';
import { ACCOUNT_TABS, MEMBER_TABS, MY_WORK_SECTIONS } from '@/lib/slots';
import { AccountOfmTab, MemberShiftsTab, MyShiftsSection, ProjectOperationsTab } from './slot-panels';

/** OFM contributions to other modules' screens (rendered from OFM endpoints, never copies). */
MY_WORK_SECTIONS.register({
  key: 'my-shifts',
  label: 'My Shifts',
  order: 50,
  visible: (_p, can) => can(['shifts.read.own', 'shifts.read.scope']),
  component: MyShiftsSection,
});

ACCOUNT_TABS.register({
  key: 'ofm',
  label: 'OFM',
  order: 40,
  visible: (_p, can) => can(['ofm.overview.read', 'shifts.read.scope', 'operations.read']),
  component: AccountOfmTab,
});

MEMBER_TABS.register({
  key: 'shifts',
  label: 'Shifts',
  order: 40,
  visible: (_p, can) => can(['shifts.read.scope', 'ofm.assignments.manage']),
  component: MemberShiftsTab,
});

registerProjectTab({
  key: 'operations',
  label: 'Operations',
  order: 60,
  visible: (p, can) => p.ofmEnabled && can(['ofm.overview.read', 'operations.read', 'shifts.read.scope']),
  component: ProjectOperationsTab,
});
