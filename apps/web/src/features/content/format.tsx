'use client';
import { Pause, Prohibit, Warning } from '@phosphor-icons/react';
import type { ContentSummary, MemberRef } from '@castlane/api-contracts';
import { Avatar, Badge, StatusBadge, formatDate, formatDateTime } from '@castlane/ui';
import { label } from '@/lib/labels';
import './labels';

export const StageBadge = ({ stage }: { stage: string }) => (
  <StatusBadge status={stage} label={label('contentStage', stage)} />
);

/** Independent flags next to the stage (colour is never the only signal). */
export const ContentFlags = ({
  c,
}: {
  c: Pick<ContentSummary, 'blocked' | 'paused' | 'overdue' | 'needsConsistencyReview'>;
}) => (
  <>
    {c.blocked ? (
      <Badge tone="danger" icon={<Prohibit size={12} aria-hidden />} title={c.blocked.reason ?? undefined}>
        Blocked
      </Badge>
    ) : null}
    {c.paused ? (
      <Badge tone="warning" icon={<Pause size={12} aria-hidden />} title={c.paused.reason ?? undefined}>
        Paused
      </Badge>
    ) : null}
    {c.overdue ? <StatusBadge status="overdue" label="Overdue" /> : null}
    {c.needsConsistencyReview ? (
      <Badge tone="warning" icon={<Warning size={12} aria-hidden />}>
        Needs Consistency Review
      </Badge>
    ) : null}
  </>
);

export const Person = ({
  member,
  empty = 'Unassigned',
}: {
  member: MemberRef | null | undefined;
  empty?: string;
}) =>
  member ? (
    <span className="flex min-w-0 items-center gap-2">
      <Avatar name={member.displayName} src={member.avatarUrl ?? null} size={24} decorative />
      <span className="truncate">{member.displayName}</span>
      {member.former ? <span className="text-[12px] text-fg-muted">(former)</span> : null}
    </span>
  ) : (
    <span className="text-fg-muted">{empty}</span>
  );

export const DueText = ({
  c,
  tz,
}: {
  c: Pick<ContentSummary, 'dueAt' | 'noDeadline' | 'overdue'>;
  tz: string;
}) =>
  c.dueAt ? (
    <span className={c.overdue ? 'font-medium text-warning' : undefined}>
      {formatDateTime(c.dueAt, tz)}
      {c.overdue ? <span className="sr-only"> (overdue)</span> : null}
    </span>
  ) : (
    <span className="text-fg-muted">{c.noDeadline ? 'No Deadline' : 'Not set'}</span>
  );

/** "Latest" and "Approved" are separate pointers (S24). */
export const VersionPointers = ({
  c,
}: {
  c: Pick<ContentSummary, 'currentVersion' | 'approvedVersion' | 'newerVersionAwaitingReview'>;
}) => (
  <span className="flex flex-wrap items-center gap-1.5">
    {c.currentVersion ? <Badge>Latest v{c.currentVersion.versionNo}</Badge> : null}
    {c.approvedVersion ? (
      c.approvedVersion.revoked ? (
        <Badge tone="danger">v{c.approvedVersion.versionNo} approval revoked</Badge>
      ) : (
        <StatusBadge status="approved" label={`Approved v${c.approvedVersion.versionNo}`} />
      )
    ) : null}
    {c.newerVersionAwaitingReview ? <Badge tone="info">A newer version is awaiting review.</Badge> : null}
    {!c.currentVersion && !c.approvedVersion ? (
      <span className="text-fg-muted">No submitted version</span>
    ) : null}
  </span>
);

export const formatDay = (iso: string | null | undefined, tz: string) => (iso ? formatDate(iso, tz) : '—');

/** Time-zone aware datetime-local conversion shared with the tasks module. */
export { fromLocalInput, toLocalInput } from '../tasks/format';

export const formatMs = (ms: number | null | undefined) => {
  if (ms === null || ms === undefined) return '';
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
};
