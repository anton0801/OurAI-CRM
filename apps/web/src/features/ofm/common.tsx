'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { AnyEndpoint, MemberRef, OfmAccountRef, OfmShiftSummary } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { DateTime, runningNetSeconds } from '@castlane/domain';
import { Avatar, Badge, Button, Dialog, Field, StatusBadge, Textarea, cn, formatDuration, toast } from '@castlane/ui';
import { useApiMutation, type MutationOptions } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useCan, useWsPath } from '@/lib/workspace-context';
import './labels';

// ——— Time helpers (explicit zones; the API speaks UTC ISO) ———

/** ISO instant → value for <input type="datetime-local"> in a zone. */
export const toLocalInput = (iso: string | null | undefined, zone: string) => (iso ? DateTime.fromISO(iso).setZone(zone).toFormat("yyyy-LL-dd'T'HH:mm") : '');

/** datetime-local value interpreted in a zone → ISO UTC (null when empty/invalid). */
export const fromLocalInput = (value: string, zone: string): string | null => {
  if (!value) return null;
  const d = DateTime.fromISO(value, { zone });
  return d.isValid ? (d.toUTC().toISO() as string) : null;
};

export const fmtTime = (iso: string | null | undefined, zone: string) => (iso ? DateTime.fromISO(iso).setZone(zone).toFormat('HH:mm') : '—');
export const fmtDay = (iso: string, zone: string) => DateTime.fromISO(iso).setZone(zone).toFormat('ccc d LLL');
export const fmtRange = (start: string, end: string, zone: string) => {
  const s = DateTime.fromISO(start).setZone(zone);
  const e = DateTime.fromISO(end).setZone(zone);
  return `${s.toFormat('ccc d LLL, HH:mm')}–${e.toFormat(s.hasSame(e, 'day') ? 'HH:mm' : 'ccc HH:mm')}`;
};

/** Net shift time; unknown stays explicit ("Pending"), never 0. */
export const fmtNet = (seconds: number | null | undefined) => (seconds === null || seconds === undefined ? 'Pending' : formatDuration(seconds));

export const errorMessage = (e: unknown, fallback = 'The action could not be completed.') => (isApiError(e) ? e.message : fallback);

/**
 * Mutation that refreshes every cached OFM query (endpoint ids starting with `ofm.`) and any
 * extra prefixes after success. `invalidate` in useApiMutation matches whole endpoint ids only.
 */
export const useOfmMutation = <EP extends AnyEndpoint>(ep: EP, opts: Omit<MutationOptions<EP>, 'invalidate'> & { also?: string[] } = {}) => {
  const qc = useQueryClient();
  const { also, ...rest } = opts;
  return useApiMutation(ep, {
    silentErrors: true,
    ...rest,
    onSuccess: async (data, input) => {
      const prefixes = ['ofm.', ...(also ?? [])];
      await qc.invalidateQueries({ predicate: (q) => prefixes.some((p) => String(q.queryKey[0] ?? '').startsWith(p)) });
      await rest.onSuccess?.(data, input);
    },
  });
};

// ——— Section navigation ———

const SECTIONS = [
  { href: '/ofm', label: 'Overview', anyOf: ['ofm.overview.read'], exact: true },
  { href: '/ofm/assignments', label: 'Assignments', anyOf: ['ofm.assignments.manage', 'ofm.overview.read'] },
  { href: '/ofm/shifts', label: 'Shifts', anyOf: ['shifts.read.scope', 'shifts.read.own'] },
  { href: '/ofm/handovers', label: 'Handovers', anyOf: ['handovers.read', 'handovers.acknowledge'] },
  { href: '/ofm/contacts', label: 'Contacts', anyOf: ['contacts.read'] },
  { href: '/ofm/operations', label: 'Operations', anyOf: ['operations.read', 'sale-candidates.write', 'sale-candidates.review'] },
  { href: '/ofm/quality', label: 'Quality', anyOf: ['quality.read.own', 'quality.read.scope', 'quality.write', 'quality.publish'] },
];

/** OFM sub-navigation (links, keyboard reachable; scrolls horizontally on phones). */
export const OfmNav = () => {
  const can = useCan();
  const wsPath = useWsPath();
  const pathname = usePathname();
  return (
    <nav aria-label="OFM sections" className="-mt-1 flex h-11 items-stretch gap-1 overflow-x-auto border-b border-line [scrollbar-width:none]">
      {SECTIONS.filter((s) => can(s.anyOf)).map((s) => {
        const href = wsPath(s.href);
        const active = s.exact ? pathname === href : pathname.startsWith(href);
        return (
          <Link
            key={s.href}
            href={href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'relative inline-flex shrink-0 items-center whitespace-nowrap px-3 text-[13px] font-medium text-fg-2 hover:text-fg',
              'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--c-focus)]',
              active && 'text-fg after:absolute after:inset-x-2 after:bottom-[-1px] after:h-[2px] after:rounded-full after:bg-primary',
            )}
          >
            {s.label}
          </Link>
        );
      })}
    </nav>
  );
};

// ——— Display chips ———

export const MemberChip = ({ member, size = 24 }: { member: MemberRef | null | undefined; size?: 24 | 28 }) =>
  member ? (
    <span className="inline-flex min-w-0 items-center gap-2">
      <Avatar name={member.displayName} src={member.avatarUrl} size={size} decorative />
      <span className="truncate">{member.displayName}</span>
      {member.former ? <Badge>Former Member</Badge> : null}
    </span>
  ) : (
    <span className="text-fg-muted">Unassigned</span>
  );

export const AccountChip = ({ account }: { account: OfmAccountRef }) => (
  <span className="inline-flex min-w-0 items-center gap-1.5">
    <span className="truncate font-medium">{account.label}</span>
    <span className="shrink-0 text-[12px] text-fg-2">{label('platform', account.platform)}</span>
  </span>
);

/** Shift and report state shown side by side (e.g. "Ended / Report Pending"), plus independent flags. */
export const ShiftBadges = ({ shift }: { shift: Pick<OfmShiftSummary, 'state' | 'reportState' | 'needsReview' | 'onLeave' | 'parallelCoverage'> }) => (
  <span className="inline-flex flex-wrap items-center gap-1.5">
    <StatusBadge status={shift.state} label={label('shiftState', shift.state)} />
    {shift.state === 'ended' ? <StatusBadge status={shift.reportState === 'draft' ? 'pending' : shift.reportState} label={label('reportState', shift.reportState)} /> : null}
    {shift.needsReview ? <Badge tone="warning">Needs Review: {label('needsReview', shift.needsReview)}</Badge> : null}
    {shift.onLeave ? <Badge tone="warning">On Leave</Badge> : null}
    {shift.parallelCoverage ? <Badge tone="info">Parallel Coverage</Badge> : null}
  </span>
);

// ——— Server timer (refresh never resets it) ———

export const ShiftTimer = ({
  actualStart,
  actualEnd,
  breaks,
  serverNow,
  running,
}: {
  actualStart: string | null;
  actualEnd: string | null;
  breaks: { startedAt: string; endedAt: string | null }[];
  serverNow: string;
  running: boolean;
}) => {
  // Offset between this device and the server, measured when the data arrived.
  const offset = useMemo(() => new Date(serverNow).getTime() - Date.now(), [serverNow]);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [running]);
  void tick;
  if (!actualStart) return <span className="font-mono tabular-nums text-fg-muted">Not started</span>;
  const end = actualEnd ? new Date(actualEnd) : new Date(Date.now() + offset);
  const secs = runningNetSeconds(
    new Date(actualStart),
    end,
    breaks.map((b) => ({ startedAt: new Date(b.startedAt), endedAt: b.endedAt ? new Date(b.endedAt) : null })),
  );
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return (
    <span className="font-mono text-[28px] font-semibold leading-9 tabular-nums text-fg" role="timer" aria-live="off" aria-label={`Net time ${h} hours ${m} minutes`}>
      {String(h).padStart(2, '0')}:{String(m).padStart(2, '0')}:{String(s).padStart(2, '0')}
    </span>
  );
};

// ——— Reason dialog (cancel, decline, end assignment…) ———

export const ReasonDialog = ({
  open,
  onOpenChange,
  title,
  body,
  confirmLabel,
  destructive,
  reasonLabel = 'Reason',
  required = true,
  onConfirm,
  children,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  body?: ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  reasonLabel?: string;
  required?: boolean;
  onConfirm: (reason: string) => Promise<unknown>;
  children?: ReactNode;
}) => {
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = !required || reason.trim().length >= 3;
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          setReason('');
          setError(null);
        }
        onOpenChange(o);
      }}
      title={title}
      size="small"
      dirty={reason.length > 0 && !pending}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant={destructive ? 'danger' : 'primary'}
            loading={pending}
            disabled={!valid}
            onClick={async () => {
              setPending(true);
              setError(null);
              try {
                await onConfirm(reason.trim());
                setReason('');
                onOpenChange(false);
              } catch (e) {
                setError(errorMessage(e));
              } finally {
                setPending(false);
              }
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4 text-[14px] leading-[22px] text-fg">
        {body ? <div className="text-fg-2">{body}</div> : null}
        {children}
        <Field label={reasonLabel} required={required} error={error} helper={required ? 'At least 3 characters.' : undefined}>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} />
        </Field>
      </div>
    </Dialog>
  );
};

/**
 * Run a one-click mutation (no form) and show any error as a toast. OFM mutations are created
 * with silent errors, so this is the single place that reports them.
 */
export const runAction = async (fn: () => Promise<unknown>, success?: string) => {
  try {
    await fn();
    if (success) toast.success(success);
    return true;
  } catch (e) {
    if (isApiError(e) && e.network) toast.error('You are offline', 'Nothing was saved. Retry when the connection is back.');
    else if (isApiError(e) && e.code === 'VERSION_CONFLICT') toast.error('This record changed in the meantime.', 'The latest version is loaded; review it and try again.');
    else toast.error(errorMessage(e));
    return false;
  }
};

export const TIME_ZONE_NOTE = 'Time recorded in Castlane; external platform activity is not monitored.';
