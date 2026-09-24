import type { ReactNode } from 'react';
import { cn } from './cn';

export type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'primary';

const tones: Record<Tone, string> = {
  neutral: 'bg-surface-2 text-fg-2 border-line',
  success: 'bg-selection text-primary border-transparent',
  primary: 'bg-selection text-primary border-transparent',
  warning: 'bg-warning-soft text-warning border-transparent',
  danger: 'bg-danger-soft text-danger border-transparent',
  info: 'bg-info-soft text-info border-transparent',
};

/** 22 px badge; status is always text (colour is never the only carrier of meaning). */
export const Badge = ({ tone = 'neutral', children, icon, className, title }: { tone?: Tone; children: ReactNode; icon?: ReactNode; className?: string; title?: string }) => (
  <span
    title={title}
    className={cn(
      'inline-flex h-[22px] max-w-full shrink-0 items-center gap-1 whitespace-nowrap rounded-[6px] border px-2 text-[12px] font-medium leading-[18px]',
      tones[tone],
      className,
    )}
  >
    {icon}
    <span className="truncate">{children}</span>
  </span>
);

/** Human labels for canonical status keys ("changes_requested" → "Changes Requested"). */
export const humanize = (key: string | null | undefined): string =>
  (key ?? '')
    .split('_')
    .filter(Boolean)
    .map((w) => (w.length <= 3 && ['ofm', 'url', 'csv', 'id', 'utm', 'fx'].includes(w) ? w.toUpperCase() : w[0]!.toUpperCase() + w.slice(1)))
    .join(' ');

const STATUS_TONES: Record<string, Tone> = {
  active: 'success',
  approved: 'success',
  published: 'success',
  done: 'success',
  completed: 'success',
  posted: 'success',
  confirmed: 'success',
  paid: 'success',
  verified: 'success',
  available: 'success',
  succeeded: 'success',
  accepted: 'success',
  acknowledged: 'success',
  won: 'success',
  fulfilled: 'success',
  enabled: 'success',
  resolved: 'success',
  reviewed: 'success',
  in_progress: 'info',
  in_review: 'info',
  review: 'info',
  production: 'info',
  scheduled: 'info',
  submitted: 'info',
  running: 'info',
  processing: 'info',
  checking: 'info',
  calculated: 'info',
  delivering: 'info',
  investigating: 'info',
  partially_paid: 'info',
  pending: 'warning',
  paused: 'warning',
  changes_requested: 'warning',
  waiting: 'warning',
  restricted: 'warning',
  preparing: 'neutral',
  needs_review: 'warning',
  needs_revalidation: 'warning',
  overdue: 'warning',
  late: 'warning',
  missing: 'warning',
  disputed: 'warning',
  failed: 'danger',
  rejected: 'danger',
  cancelled: 'neutral',
  dead: 'danger',
  lost: 'neutral',
  missed: 'danger',
  reversed: 'neutral',
  archived: 'neutral',
  draft: 'neutral',
  idea: 'neutral',
  brief: 'neutral',
  ready: 'neutral',
  backlog: 'neutral',
  open: 'neutral',
  queued: 'neutral',
  unverified: 'neutral',
  superseded: 'neutral',
  critical: 'danger',
  high: 'warning',
  urgent: 'danger',
};

export const StatusBadge = ({ status, label, className }: { status: string; label?: string; className?: string }) => (
  <Badge tone={STATUS_TONES[status] ?? 'neutral'} className={className}>
    {label ?? humanize(status)}
  </Badge>
);
