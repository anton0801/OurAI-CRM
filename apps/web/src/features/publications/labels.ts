import { registerLabels } from '@/lib/labels';

/** English labels for the publishing module's canonical values (section 21 dictionaries). */
registerLabels({
  publicationStatus: { draft: 'Draft', scheduled: 'Scheduled', published: 'Published', failed: 'Failed', cancelled: 'Cancelled' },
  publicationAvailability: { available: 'Available', removed: 'Removed', unavailable: 'Unavailable' },
  campaignStatus: { planned: 'Planned', active: 'Active', closed: 'Closed', archived: 'Archived' },
  experimentStatus: { draft: 'Draft', running: 'Running', concluded: 'Concluded', archived: 'Archived' },
  attribution: { source_reported: 'Source-Reported', manual_assignment: 'Manual Assignment', unattributed: 'Unattributed' },
  checkpointState: { pending: 'Pending', completed: 'Completed', missing: 'Missing', cancelled: 'Cancelled' },
  checkpointTiming: { on_time: 'On time', early: 'Early', late: 'Late' },
  segment: { unknown: 'Unknown', organic: 'Organic', paid: 'Paid', combined: 'Combined' },
  comparableState: {
    comparable: 'Comparable',
    not_published: 'Not published',
    too_young: 'Too young',
    no_observation_in_window: 'Not Comparable (other age)',
    unknown_value: 'Unknown value',
    removed: 'Removed',
  },
  calendarLayer: { publications: 'Publications', tasks: 'Tasks', milestones: 'Milestones', shifts: 'Shifts' },
});

/** §31.2 microcopy. */
export const SCHEDULED_NOTE = 'Planned in Castlane. Publish on the platform, then confirm it here.';
export const NO_INTEGRATION_NOTE = 'Account links do not import statistics or publish content.';
export const ARCHIVE_EXPLANATION = 'Archived records remain available in historical reports.';
export const NO_METRICS = 'No data recorded for this period.';
export const NO_DENOMINATOR = 'This rate cannot be calculated from the available data.';

/** Query-key prefixes refreshed after publication commands. */
export const PUBLICATION_INVALIDATE = ['publications.', 'calendar.', 'planBaselines.', 'campaigns.', 'experiments.', 'myWork.', 'tasks.', 'accounts.', 'assets.'];
