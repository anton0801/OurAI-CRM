import { goalProgress, hasValue, known, unavailable, type GoalTargetType, type MetricUnit, type MetricValue } from '@castlane/analytics';
import { Big, ROUND_HALF_EVEN, toBig } from '@castlane/domain';

/**
 * Goal current value and progress (§17, S53) — pure. The canonical metric wins; a manual check-in
 * is used only when the metric has no usable value and is labelled Manual; without either the goal
 * is Not Measured. Progress is never clamped: above 100 % is labelled Over Target.
 */

export interface GoalCurrent {
  value: MetricValue;
  source: 'metric' | 'manual' | 'none';
  manualSource: string | null;
}

export const GOAL_METRIC_UNITS = new Set(['count', 'percent', 'hours', 'seconds', 'money', 'ratio', 'score', 'number']);

export const goalMetricUnit = (unit: string): MetricUnit => (GOAL_METRIC_UNITS.has(unit) ? (unit as MetricUnit) : 'number');

export const goalCurrentValue = (metric: MetricValue | null, manual: { value: string; source: string | null } | null, unit: string): GoalCurrent => {
  if (metric && hasValue(metric)) return { value: metric, source: 'metric', manualSource: null };
  if (manual) return { value: known(manual.value, goalMetricUnit(unit), { note: 'Manual' }), source: 'manual', manualSource: manual.source };
  return { value: unavailable('not_measured', goalMetricUnit(unit), { note: metric ? `Metric: ${metric.status.replace(/_/g, ' ')}` : undefined }), source: 'none', manualSource: null };
};

export const goalProgressOf = (targetType: GoalTargetType, current: GoalCurrent, target: string, baseline: string | null): { progress: MetricValue; overTarget: boolean } => {
  if (current.source === 'none') return { progress: unavailable('not_measured', 'percent'), overTarget: false };
  const progress = goalProgress(targetType, { current: current.value.value, target, baseline });
  const overTarget = hasValue(progress) && toBig(progress.value).gt(100);
  return { progress: overTarget ? { ...progress, note: 'Over Target' } : progress, overTarget };
};

/** Source completeness % from the metric's coverage (usable / expected inputs); null when unknown. */
export const goalCompleteness = (v: MetricValue, source: GoalCurrent['source']): string | null => {
  if (source !== 'metric' || !v.coverage) return null;
  if (v.coverage.expected === 0) return null;
  return new Big(v.coverage.usable).times(100).div(v.coverage.expected).round(4, ROUND_HALF_EVEN).toFixed(4);
};
