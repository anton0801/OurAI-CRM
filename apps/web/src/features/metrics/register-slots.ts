import { ACCOUNT_TABS, CONTENT_PANELS, MY_WORK_SECTIONS } from '@/lib/slots';
import { AccountMetricsTab, ContentResultsPanel, MyMetricCheckpointsSection } from './slot-panels';

/** Metrics contributions to other modules' screens (rendered from the metrics endpoints, never copies). */
ACCOUNT_TABS.register({ key: 'metrics', label: 'Metrics', order: 30, visible: (_p, can) => can('metrics.read'), component: AccountMetricsTab });

MY_WORK_SECTIONS.register({ key: 'metric-checkpoints', label: 'Metric Checkpoints', order: 30, visible: (_p, can) => can(['metrics.write', 'metrics.read']), component: MyMetricCheckpointsSection });

// The content detail renders CONTENT_PANELS in its Results tab and passes `tab`.
CONTENT_PANELS.register({ key: 'results', label: 'Results', order: 40, visible: (p, can) => p.tab === 'results' && can('metrics.read'), component: ContentResultsPanel });
