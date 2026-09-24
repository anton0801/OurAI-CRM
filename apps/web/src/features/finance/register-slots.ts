import { CAMPAIGN_TABS, DEAL_PANELS, MEMBER_TABS } from '@/lib/slots';
import { CampaignBudgetTab, DealFinancePanel, MemberCompensationTab } from './slot-panels';

MEMBER_TABS.register({
  key: 'compensation',
  label: 'Compensation',
  order: 50,
  visible: (_p, can) => can(['compensation.own.read', 'compensation.runs.read', 'compensation.rules.read']),
  component: MemberCompensationTab,
});

DEAL_PANELS.register({
  key: 'finance',
  label: 'Finance',
  order: 50,
  visible: (_p, can) => can(['finance.read', 'finance.create', 'deals.read']),
  component: DealFinancePanel,
});

CAMPAIGN_TABS.register({
  key: 'budget',
  label: 'Budget',
  order: 50,
  visible: (_p, can) => can('budgets.read'),
  component: CampaignBudgetTab,
});
