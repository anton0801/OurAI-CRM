'use client';
import type { GoalRow } from '@castlane/api-contracts';
import { Badge, formatNumber } from '@castlane/ui';
import { UNAVAILABLE_TEXT, SHORT_UNAVAILABLE, hasMeasuredValue } from './measured';

/**
 * Goal progress: the bar fills up to the target, but the number is never clamped — above 100 %
 * the goal is labelled Over Target, below 0 % the metric moved away from the target.
 */
export const GoalProgress = ({ goal, size = 'compact' }: { goal: Pick<GoalRow, 'progress' | 'overTarget' | 'name'>; size?: 'compact' | 'large' }) => {
  const p = goal.progress;
  if (!hasMeasuredValue(p)) {
    return (
      <span className="text-fg-muted" title={UNAVAILABLE_TEXT[p.status]}>
        {size === 'large' ? UNAVAILABLE_TEXT[p.status] : SHORT_UNAVAILABLE[p.status]}
      </span>
    );
  }
  const pct = Number(p.value);
  const width = Math.max(0, Math.min(100, pct));
  const text = `${formatNumber(p.value, { maximumFractionDigits: 1 })}%`;
  return (
    <span className={size === 'large' ? 'flex w-full flex-col gap-2' : 'flex min-w-[150px] items-center gap-2'}>
      <span
        className={`${size === 'large' ? 'h-2.5 w-full' : 'h-1.5 w-[72px] shrink-0'} relative overflow-hidden rounded-full bg-surface-2`}
        role="meter"
        aria-label={`Progress of ${goal.name}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
        aria-valuetext={`${text}${goal.overTarget ? ', over target' : ''}${p.status === 'partial' ? ', partial data' : ''}`}
      >
        <span className={`absolute inset-y-0 left-0 rounded-full ${goal.overTarget ? 'bg-primary' : pct < 0 ? 'bg-warning' : 'bg-primary'}`} style={{ width: `${width}%` }} />
      </span>
      <span className="flex flex-wrap items-center gap-1.5">
        <span className={`tabular-nums ${size === 'large' ? 'text-[20px] font-semibold leading-7' : 'font-medium'} ${pct < 0 ? 'text-warning' : ''}`}>{text}</span>
        {goal.overTarget ? <Badge tone="success">Over Target</Badge> : null}
        {p.status === 'partial' ? (
          <Badge tone="warning" title="Some source records are missing; the value may change.">
            Partial
          </Badge>
        ) : null}
      </span>
    </span>
  );
};
