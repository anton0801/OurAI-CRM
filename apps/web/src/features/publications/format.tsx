'use client';
import { Clock, LinkBreak, Warning } from '@phosphor-icons/react';
import type { PublicationRow } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { Badge, StatusBadge, formatDateTime } from '@castlane/ui';
import { label } from '@/lib/labels';
import './labels';

/** One main status plus independent flags next to it (4.5 Badge): availability, URL Missing, awaiting confirmation. */
export const PublicationBadges = ({ p, compact }: { p: Pick<PublicationRow, 'status' | 'availability' | 'urlMissing' | 'awaitingConfirmation' | 'historicalEntry' | 'approvalRevokedAfterPublication'>; compact?: boolean }) => (
  <span className="inline-flex flex-wrap items-center gap-1.5">
    <StatusBadge status={p.status} label={label('publicationStatus', p.status)} />
    {p.availability !== 'available' ? <Badge tone="warning">{label('publicationAvailability', p.availability)}</Badge> : null}
    {p.urlMissing ? (
      <Badge tone="warning" icon={<LinkBreak size={12} aria-hidden />}>
        URL Missing
      </Badge>
    ) : null}
    {p.awaitingConfirmation ? (
      <Badge tone="warning" icon={<Clock size={12} aria-hidden />}>
        Awaiting confirmation
      </Badge>
    ) : null}
    {!compact && p.historicalEntry ? <Badge>Historical entry</Badge> : null}
    {p.approvalRevokedAfterPublication ? (
      <Badge tone="danger" icon={<Warning size={12} aria-hidden />}>
        Approval revoked after publication
      </Badge>
    ) : null}
  </span>
);

/** Actual time when published, otherwise the planned time — with the zone always visible. */
export const whenText = (p: Pick<PublicationRow, 'status' | 'scheduledAt' | 'actualPublishedAt' | 'scheduleTimezone'>, viewerTz: string) => {
  if (p.actualPublishedAt) return `Published ${formatDateTime(p.actualPublishedAt, viewerTz)} (${viewerTz})`;
  if (p.scheduledAt) return `${p.status === 'draft' ? 'Tentative' : 'Planned'} ${formatDateTime(p.scheduledAt, viewerTz)} (${viewerTz})`;
  return 'No time planned';
};

export const WhenText = ({ p, tz }: { p: Pick<PublicationRow, 'status' | 'scheduledAt' | 'actualPublishedAt' | 'scheduleTimezone'>; tz: string }) => (
  <span className="text-[13px] text-fg-2">{whenText(p, tz)}</span>
);

/** Readable error text for inline banners (field errors are mapped separately). */
export const errorText = (e: unknown, fallback: string) =>
  isApiError(e) ? (e.code === 'VERSION_CONFLICT' ? 'This record changed while you were editing it. Compare changes before saving.' : e.message) : fallback;

export interface GateDetails {
  blockers?: { code: string; message: string }[];
  overridable?: { code: string; message: string }[];
  requiresOverride?: boolean;
  conflicts?: { publicationId: string; title: string; scheduledAt: string }[];
}

/** Schedule gates returned in a 409 (INVALID_STATE) response. */
export const gateDetails = (e: unknown): GateDetails | null => (isApiError(e) && e.code === 'INVALID_STATE' && e.details ? (e.details as GateDetails) : null);
