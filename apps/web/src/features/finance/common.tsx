'use client';
import { CaretLeft, CaretRight } from '@phosphor-icons/react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { authEndpoints, type AnyEndpoint } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { DateTime, SUPPORTED_CURRENCIES, formatMinor, tryParseAmountToMinor, zonedDateTimeToUtc } from '@castlane/domain';
import { Badge, Banner, Button, ConfirmDialog, DateInput, Dialog, Field, IconButton, Input, Select, StatusBadge, Textarea, cn, formatMoney, toast, type SelectOption } from '@castlane/ui';
import { api } from '@/lib/api';
import { useApiMutation, type MutationOptions } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useUrlState } from '@/lib/url-state';
import { useCan, useWorkspace, useWsPath } from '@/lib/workspace-context';
import './labels';

export type MoneyValue = { amount: string; currency: string };

/** Money with currency, tabular figures; negatives explicit; missing shown as "Not provided". */
export const Money = ({ value, className, strong }: { value: MoneyValue | null | undefined; className?: string; strong?: boolean }) => (
  <span className={cn('whitespace-nowrap font-mono tabular-nums', value?.amount.startsWith('-') && 'text-danger', strong && 'font-semibold', !value && 'text-fg-muted', className)}>
    {formatMoney(value?.amount, value?.currency)}
  </span>
);

/** Several currencies are listed side by side; there is never a false converted total. */
export const MoneyList = ({ values, empty = '—' }: { values: MoneyValue[] | undefined; empty?: string }) =>
  !values || values.length === 0 ? (
    <span className="text-fg-muted">{empty}</span>
  ) : (
    <span className="flex flex-col items-end">
      {values.map((v) => (
        <Money key={v.currency} value={v} />
      ))}
    </span>
  );

export const currencyOptions: SelectOption[] = SUPPORTED_CURRENCIES.map((c) => ({ value: c, label: c }));

export const CurrencySelect = ({ value, onChange, disabled, id }: { value: string | null; onChange: (v: string) => void; disabled?: boolean; id?: string }) => (
  <Select id={id} value={value} onChange={(v) => v && onChange(v)} options={currencyOptions} searchable disabled={disabled} placeholder="Currency" />
);

/** Decimal-only input filter: keeps what the user typed as a string (no float conversion). */
export const decimalOk = (v: string, allowNegative = false) => (allowNegative ? /^-?\d*(\.\d*)?$/ : /^\d*(\.\d*)?$/).test(v);

const SECTIONS = [
  { href: '/finance', label: 'Overview & Ledger', anyOf: ['finance.read', 'finance.create'] },
  { href: '/finance/settlements', label: 'Settlements', anyOf: ['finance.read'] },
  { href: '/finance/budgets', label: 'Budgets', anyOf: ['budgets.read'] },
  { href: '/finance/compensation/rules', label: 'Compensation Rules', anyOf: ['compensation.rules.read'] },
  { href: '/finance/compensation/runs', label: 'Compensation Runs', anyOf: ['compensation.runs.read'] },
  { href: '/finance/reconciliation', label: 'Sale Reconciliation', anyOf: ['sale-candidates.review'] },
  { href: '/finance/fx-rates', label: 'FX Rates', anyOf: ['finance.read', 'finance.post'] },
  { href: '/finance/periods', label: 'Periods', anyOf: ['finance.read'] },
  { href: '/finance/categories', label: 'Categories', anyOf: ['finance.read', 'finance.post'] },
];

/** Finance section navigation (links, so each section keeps its own URL state). */
export const FinanceNav = () => {
  const pathname = usePathname();
  const wsPath = useWsPath();
  const can = useCan();
  const items = SECTIONS.filter((s) => can(s.anyOf));
  const active = (href: string) => {
    const full = wsPath(href);
    return href === '/finance' ? pathname === full || pathname.startsWith(`${full}/entries`) : pathname.startsWith(full);
  };
  return (
    <nav aria-label="Finance sections" className="-mt-1 flex h-11 items-stretch gap-1 overflow-x-auto border-b border-line [scrollbar-width:none]">
      {items.map((s) => (
        <Link
          key={s.href}
          href={wsPath(s.href)}
          aria-current={active(s.href) ? 'page' : undefined}
          className={cn(
            'relative inline-flex shrink-0 items-center whitespace-nowrap px-3 text-[13px] font-medium text-fg-2 hover:text-fg focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--c-focus)]',
            active(s.href) && 'text-fg after:absolute after:inset-x-2 after:bottom-[-1px] after:h-[2px] after:rounded-full after:bg-primary',
          )}
        >
          {s.label}
        </Link>
      ))}
    </nav>
  );
};

export const PAYMENT_EXPLANATION = 'This records a payment already made. It does not transfer money.';

export const PaymentNotice = () => <Banner tone="info">{PAYMENT_EXPLANATION}</Banner>;

/**
 * Confirmation that needs a reason (3–2000 characters) and optionally a date. Keeps the typed
 * reason on error; the caller closes it only after the server confirmed.
 */
export const ReasonDialog = ({
  open,
  onOpenChange,
  title,
  body,
  confirmLabel,
  destructive,
  loading,
  onConfirm,
  dateLabel,
  defaultDate,
  reasonLabel = 'Reason',
  error,
  children,
  reasonOptional,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  loading?: boolean;
  onConfirm: (reason: string, date: string) => void;
  dateLabel?: string;
  defaultDate?: string;
  reasonLabel?: string;
  error?: string | null;
  children?: ReactNode;
  reasonOptional?: boolean;
}) => {
  const [reason, setReason] = useState('');
  const [date, setDate] = useState(defaultDate ?? '');
  useEffect(() => {
    if (open) {
      setReason('');
      setDate(defaultDate ?? '');
    }
  }, [open, defaultDate]);
  const reasonValid = reasonOptional ? reason.trim().length === 0 || reason.trim().length >= 3 : reason.trim().length >= 3;
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      body={body}
      confirmLabel={confirmLabel}
      destructive={destructive}
      loading={loading}
      confirmDisabled={!reasonValid || (!!dateLabel && !date)}
      onConfirm={() => onConfirm(reason.trim(), date)}
    >
      {children}
      {dateLabel ? (
        <Field label={dateLabel} required>
          <DateInput value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
      ) : null}
      <Field label={reasonLabel} required={!reasonOptional} helper="At least 3 characters." error={error ?? undefined}>
        <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} />
      </Field>
    </ConfirmDialog>
  );
};

/** Current month as a period, and month shifting for the period selector. */
export const monthPeriod = (isoMonth?: string) => {
  const base = isoMonth && /^\d{4}-\d{2}$/.test(isoMonth) ? isoMonth : new Date().toISOString().slice(0, 7);
  const [y, m] = base.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { periodStart: `${base}-01`, periodEnd: `${base}-${String(last).padStart(2, '0')}` };
};

export const shiftMonth = (isoMonth: string, delta: number) => {
  const [y, m] = isoMonth.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
};

export const monthLabel = (isoMonth: string) => new Date(`${isoMonth}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });

export const errorDetails = (e: unknown): Record<string, unknown> | undefined => (e as { details?: Record<string, unknown> } | null)?.details;

/** Human message for a failed request (validation, state and conflict messages come from the server). */
export const apiMessage = (e: unknown, fallback = 'The action could not be completed.') => (isApiError(e) ? (e.network ? 'You are offline. Changes are not being saved.' : e.message) : fallback);

export const useFinanceParams = () => {
  const { workspace } = useWorkspace();
  return { workspaceId: workspace.id };
};

/** Entry status with its canonical label; reversal documents are marked explicitly. */
export const EntryStatus = ({ state, isReversal }: { state: string; isReversal?: boolean }) => (
  <span className="inline-flex flex-wrap items-center gap-1">
    <StatusBadge status={state} label={label('entryState', state)} />
    {isReversal ? <Badge tone="neutral">Reversal</Badge> : null}
  </span>
);

export const SourceText = ({ source }: { source: { namespace: string; externalId: string } | null }) =>
  source ? (
    <span className="font-mono text-[12px] text-fg-2" title={`${source.namespace}:${source.externalId}`}>
      {source.namespace}:{source.externalId}
    </span>
  ) : (
    <span className="text-fg-muted">Manually recorded</span>
  );

type PeriodKeys = 'month' | 'from' | 'to';

/** Reporting period from the URL: a calendar month (default: current) or an explicit from/to range. */
export const usePeriod = () => {
  const { state, set } = useUrlState<PeriodKeys>();
  const current = new Date().toISOString().slice(0, 7);
  const month = state.month && /^\d{4}-\d{2}$/.test(state.month) ? state.month : current;
  const custom = !!state.from && !!state.to && state.from <= state.to;
  const period = custom ? { periodStart: state.from!, periodEnd: state.to! } : monthPeriod(month);
  return {
    period,
    month,
    custom,
    setMonth: (m: string) => set({ month: m === current ? null : m, from: null, to: null }),
    setRange: (from: string, to: string) => set({ from, to }),
    clearRange: () => set({ from: null, to: null }),
  };
};

export const PeriodPicker = () => {
  const p = usePeriod();
  const [open, setOpen] = useState(p.custom);
  const [from, setFrom] = useState(p.custom ? p.period.periodStart : '');
  const [to, setTo] = useState(p.custom ? p.period.periodEnd : '');
  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Period">
      {!p.custom ? (
        <div className="flex items-center gap-1">
          <IconButton label="Previous month" icon={<CaretLeft size={14} />} onClick={() => p.setMonth(shiftMonth(p.month, -1))} />
          <span className="min-w-[128px] text-center text-[13px] font-semibold text-fg" aria-live="polite">
            {monthLabel(p.month)}
          </span>
          <IconButton label="Next month" icon={<CaretRight size={14} />} onClick={() => p.setMonth(shiftMonth(p.month, 1))} />
        </div>
      ) : null}
      {open ? (
        <div className="flex flex-wrap items-center gap-2">
          <DateInput aria-label="From" value={from} onChange={(e) => setFrom(e.target.value)} className="w-[150px]" />
          <span className="text-fg-2">–</span>
          <DateInput aria-label="To" value={to} onChange={(e) => setTo(e.target.value)} className="w-[150px]" />
          <Button size="sm" disabled={!from || !to || from > to} onClick={() => p.setRange(from, to)}>
            Apply
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setOpen(false);
              p.clearRange();
            }}
          >
            Month View
          </Button>
        </div>
      ) : (
        <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
          Custom Range
        </Button>
      )}
    </div>
  );
};

/** Password (and code when two-factor is on) confirmation for critical finance actions. */
export const ReauthDialog = ({ open, onOpenChange, onConfirmed }: { open: boolean; onOpenChange: (o: boolean) => void; onConfirmed: () => void }) => {
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setPassword('');
      setCode('');
      setError(null);
    }
  }, [open]);
  const submit = async () => {
    setPending(true);
    setError(null);
    try {
      await api.call(authEndpoints.reauthenticate, { body: { password, code: code.trim() || undefined } });
      onConfirmed();
    } catch (e) {
      setError(apiMessage(e, 'The password or code is not correct.'));
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="small"
      title="Confirm it’s you"
      description="Posting, approving and reversing financial records needs a recent sign-in confirmation."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button variant="primary" loading={pending} disabled={!password} onClick={() => void submit()}>
            Confirm and Continue
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <Field label="Password" required>
          <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Field label="Verification code" helper="Only when two-factor authentication is on.">
          <Input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} />
        </Field>
        <button type="submit" className="sr-only">
          Confirm
        </button>
      </form>
    </Dialog>
  );
};

/**
 * Runs an action; when the server asks for a recent sign-in confirmation, shows the dialog and
 * re-runs the same action (with the same idempotency key) after confirmation.
 */
export const useGuardedAction = () => {
  const retry = useRef<(() => Promise<void>) | null>(null);
  const [open, setOpen] = useState(false);
  const act = useCallback((fn: () => Promise<void>, onError?: (e: unknown) => void) => {
    const exec = async () => {
      try {
        await fn();
      } catch (e) {
        if (isApiError(e) && e.code === 'RECENT_AUTH_REQUIRED') {
          retry.current = exec;
          setOpen(true);
          return;
        }
        if (onError) onError(e);
        else toast.error(apiMessage(e));
      }
    };
    return exec();
  }, []);
  const dialog = (
    <ReauthDialog
      open={open}
      onOpenChange={setOpen}
      onConfirmed={() => {
        setOpen(false);
        const f = retry.current;
        retry.current = null;
        void f?.();
      }}
    />
  );
  return { act, dialog };
};

export const isConflict = (e: unknown) => isApiError(e) && e.code === 'VERSION_CONFLICT';

/**
 * useApiMutation whose `invalidate` entries are endpoint-id prefixes ('finance.' refreshes every
 * finance read model after a change), matched with a predicate on the query key.
 */
export const useFinanceMutation = <E extends AnyEndpoint>(ep: E, opts: MutationOptions<E> = {}) => {
  const qc = useQueryClient();
  const { invalidate, onSuccess, ...rest } = opts;
  return useApiMutation(ep, {
    ...rest,
    onSuccess: async (data, input) => {
      if (invalidate?.length) await qc.invalidateQueries({ predicate: (q) => invalidate.some((p) => String(q.queryKey[0] ?? '').startsWith(p)) });
      await onSuccess?.(data, input);
    },
  });
};

/** datetime-local value in the member's time zone → UTC ISO string (and back). */
export const localInputToIso = (value: string, zone: string): string | null => {
  const [d, t] = value.split('T');
  if (!d || !t) return null;
  return zonedDateTimeToUtc(d, t.slice(0, 5), zone).utc.toISOString();
};
export const isoToLocalInput = (iso: string, zone: string) => DateTime.fromISO(iso, { zone }).toFormat("yyyy-LL-dd'T'HH:mm");
export const nowLocalInput = (zone: string) => DateTime.now().setZone(zone).toFormat("yyyy-LL-dd'T'HH:mm");

/** Exact decimal helpers on currency minor units (never floats). */
export const minorOf = (amount: string | null | undefined, currency: string): bigint | null => (amount ? tryParseAmountToMinor(amount.replace(/^-/, ''), currency) : null);
export const decimalOf = (minor: bigint, currency: string) => formatMinor(minor, currency);
export const absAmount = (amount: string) => amount.replace(/^-/, '');
export const isZero = (amount: string) => /^-?0(\.0+)?$/.test(amount);
