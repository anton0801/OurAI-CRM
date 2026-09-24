'use client';
import { Warning } from '@phosphor-icons/react';
import { Avatar, Badge, StatusBadge, cn, formatDate, formatDateTime } from '@castlane/ui';
import { DateTime, zonedDateTimeToUtc } from '@castlane/domain';
import type { MemberRef } from '@castlane/api-contracts';
import { label } from '@/lib/labels';
import { PRIORITY_TONE } from './labels';
import './labels';

/** `YYYY-MM-DDTHH:mm` for a datetime-local input showing the moment in `tz`. */
export const toLocalInput = (isoValue: string | null | undefined, tz: string) =>
  isoValue ? (DateTime.fromISO(isoValue, { zone: tz }).toFormat("yyyy-LL-dd'T'HH:mm") as string) : '';

/** UTC ISO of a datetime-local value interpreted in `tz` (the zone is always shown next to the input). */
export const fromLocalInput = (value: string, tz: string): string | null => {
  if (!value) return null;
  const [date, time] = value.split('T');
  if (!date || !time) return null;
  return zonedDateTimeToUtc(date, time.slice(0, 5), tz).utc.toISOString();
};

export const todayIn = (tz: string) => DateTime.now().setZone(tz).toISODate() as string;

export const formatMinutes = (m: number | null | undefined) => {
  if (m === null || m === undefined) return 'Not estimated';
  const h = Math.floor(m / 60);
  const min = m % 60;
  if (h === 0) return `${min} min`;
  return min ? `${h} h ${min} min` : `${h} h`;
};

export const formatSeconds = (s: number | null | undefined) => (s === null || s === undefined ? '—' : formatMinutes(Math.round(s / 60)));

export const formatElapsed = (s: number) => {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
};

export const timezones = (): string[] => {
  try {
    return (Intl as unknown as { supportedValuesOf: (k: string) => string[] }).supportedValuesOf('timeZone');
  } catch {
    return ['UTC'];
  }
};

type Due = { at: string; date: string | null; timezone: string | null } | null;

/**
 * Deadline text. Date-only deadlines read "Due by end of day" on their own calendar date (with the
 * task zone when it differs from the viewer's); exact deadlines show in the viewer's zone.
 */
export const DueText = ({ due, tz, overdue, compact }: { due: Due; tz: string; overdue?: boolean; compact?: boolean }) => {
  if (!due) return <span className="text-fg-muted">No Deadline</span>;
  const text = due.date
    ? `${compact ? '' : 'Due by end of day, '}${formatDate(due.date)}${due.timezone && due.timezone !== tz ? ` (${due.timezone})` : ''}`
    : `${compact ? '' : 'Due '}${formatDateTime(due.at, tz)}`;
  return (
    <span className={cn('inline-flex items-center gap-1', overdue && 'font-medium text-warning')} title={overdue ? 'Overdue' : undefined}>
      {overdue ? <Warning size={14} aria-hidden /> : null}
      {text}
      {overdue ? <span className="sr-only"> (overdue)</span> : null}
    </span>
  );
};

export const PriorityBadge = ({ priority }: { priority: string }) =>
  priority === 'normal' ? <span className="text-[13px] text-fg-2">Normal</span> : <Badge tone={PRIORITY_TONE[priority] ?? 'neutral'}>{label('taskPriority', priority)}</Badge>;

export const TaskStatusBadge = ({ status }: { status: string }) => <StatusBadge status={status} label={label('taskStatus', status)} />;

export const Person = ({ member, empty = 'Unassigned', size = 24 }: { member: MemberRef | null | undefined; empty?: string; size?: 24 | 28 }) =>
  member ? (
    <span className="flex min-w-0 items-center gap-2">
      <Avatar name={member.displayName} src={member.avatarUrl} size={size} decorative />
      <span className="truncate">
        {member.displayName}
        {member.former ? ' (former)' : ''}
      </span>
    </span>
  ) : (
    <span className="text-fg-muted">{empty}</span>
  );
