import { registerLabels } from '@/lib/labels';

/** English labels for the work module's canonical values (section 21: dictionary keys, ready for translation). */
registerLabels({
  taskStatus: {
    draft: 'Draft',
    backlog: 'Backlog',
    ready: 'Ready',
    in_progress: 'In Progress',
    in_review: 'In Review',
    done: 'Done',
    cancelled: 'Cancelled',
  },
  taskPriority: { low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent' },
  taskSource: {
    manual: 'Manual',
    template: 'Template',
    automation: 'Automation',
    recurrence: 'Recurring',
    handover: 'Handover',
    import: 'Import',
    deal: 'Deal',
  },
  linkedType: {
    account: 'Account',
    content_item: 'Content',
    publication: 'Publication',
    shift: 'Shift',
    operation: 'Operation',
    deal: 'Deal',
    deliverable: 'Deliverable',
    article: 'Article',
  },
  timeState: {
    running: 'Running',
    draft: 'Draft',
    needs_review: 'Needs Review',
    submitted: 'Submitted',
    approved: 'Approved',
    returned: 'Returned',
  },
  timeSource: { timer: 'Timer', manual: 'Manual' },
  sheetState: { submitted: 'Submitted', approved: 'Approved', returned: 'Returned' },
  absenceCategory: { vacation: 'Vacation', sick: 'Sick Leave', personal: 'Personal', public_holiday: 'Public Holiday', other: 'Other' },
  absenceState: { requested: 'Requested', approved: 'Approved', rejected: 'Rejected', cancelled: 'Cancelled' },
  cadence: { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' },
  recurrenceMode: { fixed_schedule: 'Fixed Schedule', after_completion: 'After Completion' },
  monthDayPolicy: { last_day_of_month: 'Last Day of Month', skip_month: 'Skip That Month' },
  reminderThreshold: { '24h': 'Due in 24 hours', '1h': 'Due in 1 hour', overdue: 'Overdue' },
});

export const PRIORITY_TONE: Record<string, 'neutral' | 'info' | 'warning' | 'danger'> = { low: 'neutral', normal: 'neutral', high: 'warning', urgent: 'danger' };
