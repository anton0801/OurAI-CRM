import { registerLabels } from '@/lib/labels';

/** Labels for Goals (S53, §17). */
registerLabels({
  goalTargetType: { absolute: 'Absolute', increase_by: 'Increase By', decrease_to: 'Decrease To' },
  goalStatus: { active: 'Active', closed: 'Closed', archived: 'Archived' },
  goalScope: { workspace: 'Workspace', direction: 'Direction', project: 'Project', account: 'Account', campaign: 'Campaign' },
  goalSource: { metric: 'Canonical metric', manual: 'Manually recorded', none: 'Not Measured' },
  goalDirection: { increase: 'Increase', decrease: 'Decrease' },
});
