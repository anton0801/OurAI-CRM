'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { CalendarBlank, CalendarPlus, CaretLeft, CaretRight, DotsThree, Repeat } from '@phosphor-icons/react';
import { useMemo, useState } from 'react';
import { ofmEndpoints as E, type OfmShiftSummary } from '@castlane/api-contracts';
import { DateTime, SHIFT_REPORT_STATES, SHIFT_STATES } from '@castlane/domain';
import { Badge, Button, DataTable, EmptyState, IconButton, Menu, MultiSelect, NoResults, PageHeader, Switch, Toolbar, cn, type Column, type MenuItem } from '@castlane/ui';
import { MemberSelect } from '@/components/common/pickers';
import { QueryState } from '@/components/common/query-state';
import { useApiInfinite, useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useUrlState } from '@/lib/url-state';
import { useCan, useWorkspace, useWsPath } from '@/lib/workspace-context';
import { AccountChip, MemberChip, OfmNav, ShiftBadges, TIME_ZONE_NOTE, fmtNet, fmtRange, fmtTime } from './common';
import { OfmAccountSelect, OfmModelSelect } from './pickers';
import { CancelShiftDialog, RepeatScheduleDialog, ScheduleShiftDrawer, SwapList, SwapRequestDialog } from './shift-dialogs';

type Keys = 'view' | 'date' | 'projectId' | 'accountId' | 'membershipId' | 'state' | 'needsReview' | 'schedule' | 'repeat' | 'edit' | 'range' | 'reportState';
type View = 'week' | 'day' | 'list';

const weekStart = (d: DateTime, startsOn: 'monday' | 'sunday') => {
  const day = d.startOf('day');
  return startsOn === 'monday' ? day.minus({ days: day.weekday - 1 }) : day.minus({ days: day.weekday % 7 });
};

const laneText = (s: OfmShiftSummary) => {
  const p = s.accounts.find((a) => a.isPrimary);
  if (!p) return null;
  return p.coverageLane === 'custom' ? (p.coverageLaneLabel ?? 'Custom') : label('coverageLane', p.coverageLane);
};

/** S42 Shift Schedule: Week / Day / List with conflicts checked server-side, swaps and repeat schedules. */
export const ShiftScheduleScreen = () => {
  const { workspace, user, membershipId } = useWorkspace();
  const can = useCan();
  const router = useRouter();
  const wsPath = useWsPath();
  const { state, set, list } = useUrlState<Keys>({ view: 'week' });
  const zone = user.timezone;
  const view = (['week', 'day', 'list'].includes(state.view ?? '') ? state.view : 'week') as View;
  const anchor = useMemo(() => {
    const d = state.date ? DateTime.fromISO(state.date, { zone }) : DateTime.now().setZone(zone);
    return d.isValid ? d : DateTime.now().setZone(zone);
  }, [state.date, zone]);
  const start = view === 'day' ? anchor.startOf('day') : weekStart(anchor, workspace.weekStartsOn);
  const end = view === 'day' ? start.plus({ days: 1 }) : start.plus({ weeks: 1 });
  const states = list('state') as OfmShiftSummary['state'][];
  const reportStates = list('reportState') as OfmShiftSummary['reportState'][];
  // "All dates" is only offered in the List view; Week and Day always show their period.
  const allTime = view === 'list' && state.range === 'all';
  const scope = can('shifts.read.scope');
  const schedule = can('shifts.schedule');
  const query = {
    from: allTime ? undefined : (start.toUTC().toISO() ?? undefined),
    to: allTime ? undefined : (end.toUTC().toISO() ?? undefined),
    projectId: state.projectId,
    accountId: state.accountId,
    membershipId: state.membershipId,
    state: states.length ? states : undefined,
    needsReview: state.needsReview === '1' ? true : undefined,
    reportState: reportStates.length ? reportStates : undefined,
    pageSize: 200,
    direction: 'asc' as const,
  };
  const data = useApiInfinite(E.listShifts, { params: { workspaceId: workspace.id }, query });
  const swaps = useApiQuery(E.listSwaps, { params: { workspaceId: workspace.id }, query: { state: ['pending_acceptance', 'pending_approval'] } });
  const filtered = !!(state.projectId || state.accountId || state.membershipId || states.length || reportStates.length || state.needsReview);
  const [cancelling, setCancelling] = useState<OfmShiftSummary | null>(null);
  const [swapFor, setSwapFor] = useState<OfmShiftSummary | null>(null);

  const move = (dir: -1 | 1) => set({ date: (view === 'day' ? anchor.plus({ days: dir }) : anchor.plus({ weeks: dir })).toISODate() });
  const periodLabel = view === 'day' ? start.toFormat('cccc d LLLL yyyy') : `${start.toFormat('d LLL')} – ${end.minus({ days: 1 }).toFormat('d LLL yyyy')}`;

  const actionsFor = (s: OfmShiftSummary): MenuItem[] => [
    { label: 'Open Shift', onSelect: () => router.push(wsPath(`/ofm/shifts/${s.id}`)) },
    { label: 'Edit Schedule', onSelect: () => set({ edit: s.id }), hidden: !schedule || s.state !== 'scheduled' },
    { label: 'Request Swap', onSelect: () => setSwapFor(s), hidden: s.state !== 'scheduled' || (s.member.membershipId !== membershipId && !schedule) },
    { label: 'Cancel Shift', destructive: true, separatorBefore: true, onSelect: () => setCancelling(s), hidden: !schedule || s.state !== 'scheduled' },
  ];

  // Scheduled hours per member in the loaded period (capacity indicator; cancelled/missed excluded).
  const capacity = useMemo(() => {
    const m = new Map<string, { name: string; minutes: number; leave: boolean }>();
    for (const s of data.items) {
      if (s.state === 'cancelled' || s.state === 'missed') continue;
      const cur = m.get(s.member.membershipId) ?? { name: s.member.displayName, minutes: 0, leave: false };
      cur.minutes += Math.round((Date.parse(s.scheduledEnd) - Date.parse(s.scheduledStart)) / 60_000);
      cur.leave ||= s.onLeave;
      m.set(s.member.membershipId, cur);
    }
    return [...m.entries()].sort((a, b) => b[1].minutes - a[1].minutes);
  }, [data.items]);

  const columns: Column<OfmShiftSummary>[] = [
    { key: 'when', header: 'Scheduled', sticky: true, minWidth: 200, cell: (s) => fmtRange(s.scheduledStart, s.scheduledEnd, zone) },
    { key: 'member', header: 'Member', minWidth: 180, cell: (s) => <MemberChip member={s.member} /> },
    {
      key: 'account',
      header: 'Accounts',
      minWidth: 200,
      cell: (s) => (
        <span className="inline-flex items-center gap-1.5">
          <AccountChip account={s.primaryAccount} />
          {s.accounts.length > 1 ? <Badge>+{s.accounts.length - 1}</Badge> : null}
        </span>
      ),
    },
    { key: 'model', header: 'Model', minWidth: 130, cell: (s) => s.project.name },
    { key: 'lane', header: 'Coverage Lane', minWidth: 120, cell: (s) => laneText(s) },
    { key: 'tz', header: 'Time Zone', minWidth: 140, cell: (s) => s.timezone },
    { key: 'supervisor', header: 'Supervisor', minWidth: 160, cell: (s) => <MemberChip member={s.supervisor} /> },
    { key: 'status', header: 'Status', minWidth: 220, cell: (s) => <ShiftBadges shift={s} /> },
    { key: 'net', header: 'Net Time', align: 'right', minWidth: 100, cell: (s) => (s.state === 'scheduled' || s.state === 'cancelled' || s.state === 'missed' ? '—' : fmtNet(s.netSeconds)) },
    {
      key: 'actions',
      header: '',
      headerLabel: 'Actions',
      width: 48,
      cell: (s) => (
        <span onClick={(e) => e.stopPropagation()}>
          <Menu label="Shift actions" trigger={<IconButton label="Shift actions" icon={<DotsThree size={18} weight="bold" />} />} items={actionsFor(s)} />
        </span>
      ),
    },
  ];

  const empty = data.items.length === 0 && !data.isFetching;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Shift Schedule"
        crumbs={[{ label: 'OFM', href: wsPath('/ofm') }, { label: 'Shifts' }]}
        description={`Shifts are shown in your time zone (${zone}). ${TIME_ZONE_NOTE}`}
        actions={
          schedule ? (
            <>
              <Button variant="primary" icon={<CalendarPlus size={14} />} onClick={() => set({ schedule: '1' })}>
                Schedule
              </Button>
              <Button icon={<Repeat size={14} />} onClick={() => set({ repeat: '1' })}>
                Repeat Schedule
              </Button>
            </>
          ) : undefined
        }
      />
      <OfmNav />
      {swaps.data?.length ? <SwapList swaps={swaps.data} /> : null}
      <Toolbar>
        <div role="group" aria-label="View" className="inline-flex rounded-[10px] border border-line p-0.5">
          {(['week', 'day', 'list'] as const).map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={view === v}
              onClick={() => set({ view: v })}
              className={cn(
                'h-8 rounded-[8px] px-3 text-[13px] font-medium text-fg-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-[var(--c-focus)]',
                view === v && 'bg-surface-2 text-fg',
              )}
            >
              {v === 'week' ? 'Week' : v === 'day' ? 'Day' : 'List'}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <IconButton label={view === 'day' ? 'Previous day' : 'Previous week'} icon={<CaretLeft size={16} />} onClick={() => move(-1)} />
          <Button size="sm" onClick={() => set({ date: null })}>
            Today
          </Button>
          <IconButton label={view === 'day' ? 'Next day' : 'Next week'} icon={<CaretRight size={16} />} onClick={() => move(1)} />
          <span className="ml-1 text-[14px] font-medium text-fg" aria-live="polite">
            {allTime ? 'All dates' : periodLabel}
          </span>
        </div>
      </Toolbar>
      <Toolbar>
        <div className="w-full sm:w-[190px]">
          <OfmModelSelect aria-label="Model" placeholder="All models" value={state.projectId} onChange={(v) => set({ projectId: v, accountId: null })} clearable />
        </div>
        <div className="w-full sm:w-[190px]">
          <OfmAccountSelect aria-label="Account" placeholder="All accounts" projectId={state.projectId} value={state.accountId} onChange={(v) => set({ accountId: v })} clearable />
        </div>
        {scope ? (
          <div className="w-full sm:w-[190px]">
            <MemberSelect aria-label="Member" placeholder="All members" value={state.membershipId} onChange={(v) => set({ membershipId: v })} clearable />
          </div>
        ) : null}
        <div className="w-full sm:w-[210px]">
          <MultiSelect aria-label="Status" placeholder="Any status" value={states} onChange={(v) => set({ state: v.join(',') || null })} options={SHIFT_STATES.map((s) => ({ value: s, label: label('shiftState', s) }))} />
        </div>
        <div className="w-full sm:w-[210px]">
          <MultiSelect
            aria-label="Report status"
            placeholder="Any report status"
            value={reportStates}
            onChange={(v) => set({ reportState: v.join(',') || null })}
            options={SHIFT_REPORT_STATES.map((s) => ({ value: s, label: label('reportState', s) }))}
          />
        </div>
        <Switch label="Needs Review" checked={state.needsReview === '1'} onCheckedChange={(c) => set({ needsReview: c ? '1' : null })} />
        {view === 'list' ? <Switch label="All dates" checked={allTime} onCheckedChange={(c) => set({ range: c ? 'all' : null })} /> : null}
      </Toolbar>
      {capacity.length && view !== 'list' ? (
        <div className="flex flex-wrap gap-2" aria-label="Scheduled hours in this period">
          {capacity.map(([id, c]) => (
            <Badge key={id} tone={c.leave ? 'warning' : 'neutral'} title={c.leave ? 'Has approved leave on a scheduled day' : undefined}>
              {c.name} · {Math.floor(c.minutes / 60)} h{c.minutes % 60 ? ` ${c.minutes % 60} min` : ''}
              {c.leave ? ' · On Leave' : ''}
            </Badge>
          ))}
        </div>
      ) : null}
      <QueryState query={data}>
        {empty ? (
          filtered ? (
            <NoResults onClear={() => set({ projectId: null, accountId: null, membershipId: null, state: null, reportState: null, needsReview: null })} />
          ) : (
            <EmptyState
              icon={<CalendarBlank size={28} />}
              title={view === 'day' ? 'No shifts on this day' : 'No shifts in this week'}
              description={schedule ? 'Schedule shifts for assigned managers. Conflicts are checked before saving.' : 'Your supervisor schedules shifts; they appear here and in My Work.'}
              action={schedule ? <Button variant="primary" onClick={() => set({ schedule: '1' })}>Schedule</Button> : undefined}
            />
          )
        ) : view === 'list' ? (
          <DataTable
            caption="Shifts"
            rows={data.items}
            columns={columns}
            getRowId={(s) => s.id}
            density={user.density}
            onRowClick={(s) => router.push(wsPath(`/ofm/shifts/${s.id}`))}
            hasMore={data.hasNextPage}
            loadingMore={data.isFetchingNextPage}
            onLoadMore={() => void data.fetchNextPage()}
          />
        ) : view === 'day' ? (
          <DayView shifts={data.items} dayStart={start} zone={zone} actionsFor={actionsFor} />
        ) : (
          <WeekView shifts={data.items} start={start} zone={zone} actionsFor={actionsFor} />
        )}
        {view !== 'list' && data.hasNextPage ? (
          <div className="flex justify-center">
            <Button loading={data.isFetchingNextPage} onClick={() => void data.fetchNextPage()}>
              Load More
            </Button>
          </div>
        ) : null}
      </QueryState>
      {state.schedule === '1' ? <ScheduleShiftDrawer preset={{ projectId: state.projectId, accountId: state.accountId, membershipId: state.membershipId }} onClose={() => set({ schedule: null })} /> : null}
      {state.repeat === '1' ? <RepeatScheduleDialog onClose={() => set({ repeat: null })} /> : null}
      {state.edit ? <EditShiftLoader shiftId={state.edit} fallback={data.items.find((s) => s.id === state.edit)} onClose={() => set({ edit: null })} /> : null}
      {cancelling ? <CancelShiftDialog shift={cancelling} open onOpenChange={(o) => !o && setCancelling(null)} /> : null}
      {swapFor ? <SwapRequestDialog shift={swapFor} onClose={() => setSwapFor(null)} /> : null}
    </div>
  );
};

const EditShiftLoader = ({ shiftId, fallback, onClose }: { shiftId: string; fallback?: OfmShiftSummary; onClose: () => void }) => {
  const { workspace } = useWorkspace();
  const q = useApiQuery(E.getShift, { params: { workspaceId: workspace.id, shiftId } }, { enabled: !fallback });
  const shift = fallback ?? q.data;
  return shift ? <ScheduleShiftDrawer shift={shift} onClose={onClose} /> : null;
};

const ShiftCard = ({ s, zone, actions, compact }: { s: OfmShiftSummary; zone: string; actions: MenuItem[]; compact?: boolean }) => {
  const wsPath = useWsPath();
  return (
    <div
      className={cn(
        'relative flex flex-col gap-1 rounded-[10px] border border-line bg-surface p-2 pr-9 text-[12px] leading-[18px]',
        s.state === 'active' && 'border-primary',
        (s.state === 'cancelled' || s.state === 'missed') && 'opacity-70',
      )}
    >
      <Link href={wsPath(`/ofm/shifts/${s.id}`)} className="font-mono font-semibold tabular-nums text-fg hover:underline">
        {fmtTime(s.scheduledStart, zone)}–{fmtTime(s.scheduledEnd, zone)}
      </Link>
      <MemberChip member={s.member} />
      <span className="truncate text-fg-2">
        {s.primaryAccount.label}
        {s.accounts.length > 1 ? ` +${s.accounts.length - 1}` : ''}
        {laneText(s) ? ` · ${laneText(s)}` : ''}
      </span>
      {!compact || s.state !== 'scheduled' || s.needsReview || s.onLeave || s.parallelCoverage ? <ShiftBadges shift={s} /> : null}
      <div className="absolute right-1 top-1">
        <Menu label="Shift actions" trigger={<IconButton label="Shift actions" icon={<DotsThree size={16} weight="bold" />} />} items={actions} />
      </div>
    </div>
  );
};

const WeekView = ({ shifts, start, zone, actionsFor }: { shifts: OfmShiftSummary[]; start: DateTime; zone: string; actionsFor: (s: OfmShiftSummary) => MenuItem[] }) => {
  const today = DateTime.now().setZone(zone);
  const days = Array.from({ length: 7 }, (_, i) => start.plus({ days: i }));
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-7">
      {days.map((d) => {
        const list = shifts.filter((s) => DateTime.fromISO(s.scheduledStart).setZone(zone).hasSame(d, 'day'));
        const isToday = d.hasSame(today, 'day');
        return (
          <section key={d.toISODate()} aria-label={d.toFormat('cccc d LLLL')} className="flex min-w-0 flex-col gap-2 rounded-[12px] border border-line bg-surface-2/40 p-2">
            <h3 className={cn('flex items-baseline justify-between px-1 text-[13px] font-semibold text-fg', isToday && 'text-primary')}>
              <span>{d.toFormat('ccc d')}</span>
              {list.length ? <span className="text-[11px] font-normal text-fg-2">{list.length}</span> : null}
            </h3>
            {list.length ? (
              list.map((s) => <ShiftCard key={s.id} s={s} zone={zone} actions={actionsFor(s)} compact />)
            ) : (
              <p className="px-1 pb-1 text-[12px] text-fg-muted">No shifts</p>
            )}
          </section>
        );
      })}
    </div>
  );
};

const DayView = ({ shifts, dayStart, zone, actionsFor }: { shifts: OfmShiftSummary[]; dayStart: DateTime; zone: string; actionsFor: (s: OfmShiftSummary) => MenuItem[] }) => {
  const from = dayStart.toMillis();
  const span = dayStart.plus({ days: 1 }).toMillis() - from;
  const pct = (iso: string) => Math.min(100, Math.max(0, ((Date.parse(iso) - from) / span) * 100));
  return (
    <ul className="flex flex-col gap-2">
      {shifts.map((s) => {
        const left = pct(s.scheduledStart);
        const right = pct(s.scheduledEnd);
        return (
          <li key={s.id} className="grid grid-cols-1 gap-2 md:grid-cols-[320px_1fr] md:items-center">
            <ShiftCard s={s} zone={zone} actions={actionsFor(s)} />
            <div className="relative hidden h-6 rounded-[6px] bg-surface-2 md:block" aria-hidden>
              {[6, 12, 18].map((h) => (
                <span key={h} className="absolute top-0 h-full w-px bg-line" style={{ left: `${(h / 24) * 100}%` }} />
              ))}
              <span
                className={cn('absolute top-1 h-4 rounded-[4px]', s.state === 'active' ? 'bg-primary' : s.state === 'cancelled' || s.state === 'missed' ? 'bg-fg-muted' : 'bg-info')}
                style={{ left: `${left}%`, width: `${Math.max(1, right - left)}%` }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
};
