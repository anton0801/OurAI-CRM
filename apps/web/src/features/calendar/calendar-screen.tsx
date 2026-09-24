'use client';
import { CalendarBlank, CaretLeft, CaretRight, DotsThree, Plus, Warning } from '@phosphor-icons/react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState, type DragEvent } from 'react';
import { calendarEndpoints as CAL, publicationEndpoints as P, type CalendarEvent } from '@castlane/api-contracts';
import { DateTime, PLATFORMS, PUBLICATION_STATUSES } from '@castlane/domain';
import { Button, EmptyState, IconButton, Menu, MultiSelect, PageHeader, Select, Skeleton, Toolbar, cn, type MenuItem } from '@castlane/ui';
import { EntitySelect } from '@/components/common/entity-select';
import { MemberSelect } from '@/components/common/pickers';
import { QueryState } from '@/components/common/query-state';
import { useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useUrlState } from '@/lib/url-state';
import { useCan, useWorkspace, useWsPath } from '@/lib/workspace-context';
import { timezones } from '@/features/tasks/format';
import { SCHEDULED_NOTE } from '@/features/publications/labels';
import { CorrectDialog, MarkPublishedDialog, ScheduleDialog } from '@/features/publications/publication-dialogs';
import { PlanView } from './plan-view';

type View = 'month' | 'week' | 'agenda' | 'plan';
const VIEWS: View[] = ['month', 'week', 'agenda', 'plan'];
const LAYERS = ['publications', 'tasks', 'milestones', 'shifts'] as const;
type Keys = 'view' | 'date' | 'tz' | 'layers' | 'projectId' | 'accountId' | 'platform' | 'status' | 'member';

const TYPE_LABEL: Record<CalendarEvent['type'], string> = { publication: 'Publication', task: 'Task due', milestone: 'Milestone', shift: 'Shift' };
const TYPE_CLASS: Record<CalendarEvent['type'], string> = {
  publication: 'border-l-primary',
  task: 'border-l-info',
  milestone: 'border-l-warning',
  shift: 'border-l-fg-muted',
};

/** Local calendar day of an event in the display zone (date-only events keep their own date). */
const dayOf = (e: CalendarEvent, tz: string) => e.date ?? (DateTime.fromISO(e.start!, { zone: tz }).toISODate() as string);
const timeOf = (e: CalendarEvent, tz: string) => (e.start && !e.date ? DateTime.fromISO(e.start, { zone: tz }).toFormat('HH:mm') : null);

const rangeFor = (view: View, anchor: string, tz: string) => {
  const a = DateTime.fromISO(anchor, { zone: tz }).startOf('day');
  if (view === 'month') {
    const first = a.startOf('month');
    const start = first.minus({ days: first.weekday - 1 });
    return { start, days: 42 };
  }
  if (view === 'week' || view === 'plan') return { start: a.minus({ days: a.weekday - 1 }), days: 7 };
  return { start: a, days: 30 };
};

/** S31 Calendar: month / week / agenda over publications, task deadlines, milestones and shifts. */
export const CalendarScreen = ({ projectId: fixedProject, embedded }: { projectId?: string; embedded?: boolean }) => {
  const { workspace, user } = useWorkspace();
  const can = useCan();
  const wsPath = useWsPath();
  const router = useRouter();
  const { state, set, list } = useUrlState<Keys>();
  const tz = state.tz ?? user.timezone;
  const today = DateTime.now().setZone(tz).toISODate() as string;
  const anchor = state.date ?? today;
  // Phones default to Agenda (28.1) unless a view is chosen explicitly.
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    setNarrow(mq.matches);
    const on = () => setNarrow(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  const view: View = VIEWS.includes(state.view as View) ? (state.view as View) : narrow ? 'agenda' : 'month';
  const { start, days } = rangeFor(view, anchor, tz);
  const end = start.plus({ days });
  const projectId = fixedProject ?? state.projectId;
  const layers = list('layers').filter((l): l is (typeof LAYERS)[number] => (LAYERS as readonly string[]).includes(l));
  const q = useApiQuery(
    CAL.get,
    {
      params: { workspaceId: workspace.id },
      query: {
        from: start.toUTC().toISO()!,
        to: end.toUTC().toISO()!,
        layers: layers.length ? layers : undefined,
        projectId,
        accountId: state.accountId,
        platform: list('platform') as never,
        status: list('status') as never,
        memberId: state.member,
      },
    },
    { enabled: view !== 'plan' },
  );
  const [action, setAction] = useState<{ kind: 'schedule' | 'publish' | 'correct'; id: string; initialAt?: string | null } | null>(null);

  const shift = (dir: -1 | 1) => {
    const a = DateTime.fromISO(anchor, { zone: tz });
    const next = view === 'month' ? a.plus({ months: dir }) : view === 'agenda' ? a.plus({ days: 30 * dir }) : a.plus({ weeks: dir });
    set({ date: next.toISODate() });
  };
  const title = view === 'month' ? DateTime.fromISO(anchor, { zone: tz }).toFormat('LLLL yyyy') : `${start.toFormat('d LLL')} – ${end.minus({ days: 1 }).toFormat('d LLL yyyy')}`;
  const offsetText = (d: DateTime) => `UTC${d.toFormat('ZZ')}`;
  const dstChange = start.offset !== end.minus({ minutes: 1 }).offset;
  const zoneOptions = useMemo(() => {
    const top = [...new Set([user.timezone, workspace.timezone, 'UTC'])];
    return [...top, ...timezones().filter((z) => !top.includes(z))].map((z) => ({ value: z, label: z, description: z === user.timezone ? 'Your time zone' : z === workspace.timezone ? 'Workspace time zone' : undefined }));
  }, [user.timezone, workspace.timezone]);
  const filtered = !!(state.accountId || list('platform').length || list('status').length || state.member || layers.length || (!fixedProject && state.projectId));

  const onDropDay = (day: string, e: DragEvent) => {
    e.preventDefault();
    const key = e.dataTransfer.getData('text/plain');
    const ev = q.data?.events.find((x) => x.key === key);
    if (!ev || ev.type !== 'publication') return;
    const orig = DateTime.fromISO(ev.start!, { zone: tz });
    const moved = DateTime.fromISO(day, { zone: tz }).set({ hour: orig.hour, minute: orig.minute });
    if (moved.toISODate() === orig.toISODate()) return;
    // A published placement is never moved by dragging the plan: its date is a fact, changed only by a correction.
    if (ev.canReschedule) setAction({ kind: 'schedule', id: ev.entityId, initialAt: moved.toUTC().toISO() });
    else if (ev.canCorrect) setAction({ kind: 'correct', id: ev.entityId, initialAt: moved.toUTC().toISO() });
  };

  const eventsByDay = useMemo(() => {
    const m = new Map<string, CalendarEvent[]>();
    for (const e of q.data?.events ?? []) {
      const d = dayOf(e, tz);
      m.set(d, [...(m.get(d) ?? []), e]);
    }
    return m;
  }, [q.data, tz]);

  const header = (
    <PageHeader
      title="Calendar"
      description={`Publications, deadlines, milestones and shifts in ${tz} (${offsetText(DateTime.now().setZone(tz))}). ${SCHEDULED_NOTE}`}
      actions={
        can('publications.write') ? (
          <Button variant="primary" icon={<Plus size={14} weight="bold" />} onClick={() => router.push(wsPath(`/publications/new${state.accountId ? `?accountId=${state.accountId}` : ''}`))}>
            Create Publication
          </Button>
        ) : undefined
      }
    />
  );

  return (
    <div className="flex flex-col gap-4">
      {!embedded ? header : null}
      <Toolbar>
        <div className="flex items-center gap-1">
          <IconButton label="Previous period" icon={<CaretLeft size={16} />} onClick={() => shift(-1)} variant="secondary" />
          <Button size="sm" onClick={() => set({ date: null })}>
            Today
          </Button>
          <IconButton label="Next period" icon={<CaretRight size={16} />} onClick={() => shift(1)} variant="secondary" />
        </div>
        <h2 className="min-w-[160px] text-[16px] font-semibold text-fg" aria-live="polite">
          {title}
        </h2>
        <div className="flex items-center gap-1" role="group" aria-label="Calendar view">
          {VIEWS.map((v) => (
            <Button key={v} size="sm" variant={view === v ? 'secondary' : 'ghost'} aria-pressed={view === v} onClick={() => set({ view: v })}>
              {v === 'plan' ? 'Plan' : v[0]!.toUpperCase() + v.slice(1)}
            </Button>
          ))}
        </div>
        <div className="w-full sm:w-[220px]">
          <Select aria-label="Time zone" value={tz} onChange={(v) => set({ tz: v && v !== user.timezone ? v : null })} options={zoneOptions} searchable />
        </div>
      </Toolbar>
      {view !== 'plan' ? (
        <Toolbar>
          <div className="w-[190px]">
            <MultiSelect aria-label="Layers" placeholder="All layers" value={layers} onChange={(v) => set({ layers: v.join(',') || null })} options={LAYERS.filter((l) => q.data?.layers[l] !== false).map((l) => ({ value: l, label: label('calendarLayer', l) }))} />
          </div>
          {!fixedProject ? (
            <div className="w-[180px]">
              <EntitySelect type="project" aria-label="Project" placeholder="Project" value={state.projectId ?? null} onChange={(v) => set({ projectId: v })} clearable />
            </div>
          ) : null}
          <div className="w-[180px]">
            <EntitySelect type="account" aria-label="Account" placeholder="Account" value={state.accountId ?? null} onChange={(v) => set({ accountId: v })} clearable filters={projectId ? { projectId } : undefined} />
          </div>
          <div className="w-[150px]">
            <MultiSelect aria-label="Platform" placeholder="Platform" value={list('platform')} onChange={(v) => set({ platform: v.join(',') || null })} options={PLATFORMS.map((p) => ({ value: p, label: label('platform', p) }))} />
          </div>
          <div className="w-[160px]">
            <MultiSelect aria-label="Publication status" placeholder="Status" value={list('status')} onChange={(v) => set({ status: v.join(',') || null })} options={PUBLICATION_STATUSES.map((s) => ({ value: s, label: label('publicationStatus', s) }))} />
          </div>
          <div className="w-[170px]">
            <MemberSelect aria-label="Member" placeholder="Member" value={state.member} onChange={(v) => set({ member: v })} clearable />
          </div>
          {filtered ? (
            <Button size="sm" variant="ghost" onClick={() => set({ layers: null, projectId: fixedProject ? undefined : null, accountId: null, platform: null, status: null, member: null })}>
              Clear Filters
            </Button>
          ) : null}
        </Toolbar>
      ) : null}
      {dstChange && view !== 'plan' ? (
        <p className="text-[12px] text-fg-2">
          Clocks change in {tz} during this period ({offsetText(start)} → {offsetText(end.minus({ minutes: 1 }))}). Times are shown in local time; checkpoint windows are elapsed hours.
        </p>
      ) : null}
      {view === 'plan' ? (
        <PlanView weekStart={start.toISODate()!} projectId={projectId} accountId={state.accountId} tz={tz} />
      ) : (
        <QueryState
          query={q}
          skeleton={
            <div role="status" aria-label="Loading calendar" className="grid grid-cols-7 gap-1">
              {Array.from({ length: 14 }).map((_, i) => (
                <Skeleton key={i} className="h-24" />
              ))}
            </div>
          }
        >
          {q.data ? (
            <>
              {q.data.truncated ? <p className="text-[12px] text-warning">More events exist in this period than can be shown. Narrow the filters or the period.</p> : null}
              {view === 'agenda' ? (
                <Agenda start={start} days={days} tz={tz} byDay={eventsByDay} onAction={setAction} filtered={filtered} onClear={() => set({ layers: null, accountId: null, platform: null, status: null, member: null })} />
              ) : (
                <Grid start={start} days={days} tz={tz} today={today} month={view === 'month' ? DateTime.fromISO(anchor, { zone: tz }).month : null} byDay={eventsByDay} onDropDay={onDropDay} onAction={setAction} onMore={(iso) => set({ view: 'week', date: iso })} />
              )}
            </>
          ) : null}
        </QueryState>
      )}
      {action ? <ActionHost action={action} onClose={() => setAction(null)} /> : null}
    </div>
  );
};

/** Loads the placement and opens the dialog (keyboard path and drop path share it). */
const ActionHost = ({ action, onClose }: { action: { kind: 'schedule' | 'publish' | 'correct'; id: string; initialAt?: string | null }; onClose: () => void }) => {
  const { workspace } = useWorkspace();
  const q = useApiQuery(P.get, { params: { workspaceId: workspace.id, publicationId: action.id } });
  if (!q.data) return null;
  const common = { publication: q.data, open: true, onOpenChange: (o: boolean) => !o && onClose() };
  if (action.kind === 'publish') return <MarkPublishedDialog {...common} />;
  if (action.kind === 'correct') return <CorrectDialog {...common} initialAt={action.initialAt} />;
  return <ScheduleDialog {...common} initialAt={action.initialAt} />;
};

type OnAction = (a: { kind: 'schedule' | 'publish' | 'correct'; id: string; initialAt?: string | null }) => void;

const EventChip = ({ e, tz, onAction, dense }: { e: CalendarEvent; tz: string; onAction: OnAction; dense?: boolean }) => {
  const time = timeOf(e, tz);
  const draggable = e.type === 'publication' && (e.canReschedule || e.canCorrect);
  const items: MenuItem[] = [
    { label: 'Open', href: e.href },
    { label: e.status === 'draft' ? 'Schedule…' : 'Reschedule…', onSelect: () => onAction({ kind: 'schedule', id: e.entityId }), hidden: !e.canReschedule },
    { label: 'Mark Published…', onSelect: () => onAction({ kind: 'publish', id: e.entityId }), hidden: !(e.type === 'publication' && e.status === 'scheduled') },
    { label: 'Correct Publication…', onSelect: () => onAction({ kind: 'correct', id: e.entityId }), hidden: !e.canCorrect },
  ];
  return (
    <div
      draggable={draggable}
      onDragStart={(ev) => {
        ev.dataTransfer.setData('text/plain', e.key);
        ev.dataTransfer.effectAllowed = 'move';
      }}
      className={cn(
        'group flex min-w-0 items-start gap-1 rounded-[6px] border border-line border-l-[3px] bg-surface px-1.5 py-1 text-[12px] leading-[16px]',
        TYPE_CLASS[e.type],
        e.conflict && 'bg-warning-soft',
        draggable && 'cursor-grab',
      )}
    >
      <Link href={e.href} className="min-w-0 flex-1 focus-visible:outline-2 focus-visible:outline-[var(--c-focus)]">
        <span className="block truncate text-fg">
          {time ? <span className="font-mono tabular-nums">{time} </span> : null}
          <span className="sr-only">{TYPE_LABEL[e.type]}: </span>
          {e.title}
        </span>
        {!dense ? (
          <span className="block truncate text-fg-2">
            {TYPE_LABEL[e.type]} · {e.type === 'publication' ? label('publicationStatus', e.status) : e.status.replace(/_/g, ' ')}
            {e.account ? ` · ${e.account.label}` : ''}
          </span>
        ) : null}
        {e.conflict ? (
          <span className="flex items-center gap-1 text-warning">
            <Warning size={12} aria-hidden /> Within 15 min of another placement
          </span>
        ) : null}
        {e.awaitingConfirmation ? <span className="block text-warning">Awaiting confirmation</span> : null}
        {e.type !== 'publication' && e.overdue ? <span className="block text-warning">Overdue</span> : null}
      </Link>
      {items.some((i, idx) => idx > 0 && !i.hidden) ? (
        <Menu label={`Actions for ${e.title}`} trigger={<IconButton label={`Actions for ${e.title}`} icon={<DotsThree size={14} weight="bold" />} className="h-6 w-6 shrink-0" />} items={items} />
      ) : null}
    </div>
  );
};

const Grid = ({
  start,
  days,
  tz,
  today,
  month,
  byDay,
  onDropDay,
  onAction,
  onMore,
}: {
  start: DateTime;
  days: number;
  tz: string;
  today: string;
  month: number | null;
  byDay: Map<string, CalendarEvent[]>;
  onDropDay: (day: string, e: DragEvent) => void;
  onAction: OnAction;
  onMore: (day: string) => void;
}) => {
  const cells = Array.from({ length: days }, (_, i) => start.plus({ days: i }));
  const [over, setOver] = useState<string | null>(null);
  const weekdays = cells.slice(0, 7).map((d) => d.toFormat('ccc'));
  return (
    <div className="overflow-x-auto rounded-[12px] border border-line bg-surface">
      <div className="grid min-w-[720px] grid-cols-7" role="grid" aria-label="Calendar">
        {weekdays.map((w) => (
          <div key={w} role="columnheader" className="border-b border-line px-2 py-2 text-[12px] font-[550] text-fg-2">
            {w}
          </div>
        ))}
        {cells.map((d) => {
          const iso = d.toISODate()!;
          const events = byDay.get(iso) ?? [];
          const outside = month !== null && d.month !== month;
          const limit = month !== null ? 4 : 50;
          return (
            <div
              key={iso}
              role="gridcell"
              aria-label={`${d.toFormat('cccc d LLLL')}: ${events.length} event(s)`}
              onDragOver={(e) => {
                e.preventDefault();
                setOver(iso);
              }}
              onDragLeave={() => setOver((o) => (o === iso ? null : o))}
              onDrop={(e) => {
                setOver(null);
                onDropDay(iso, e);
              }}
              className={cn('flex min-h-[112px] flex-col gap-1 border-b border-r border-line p-1.5', outside && 'bg-surface-2', over === iso && 'bg-selection', month === null && 'min-h-[320px]')}
            >
              <span className={cn('self-start rounded-[6px] px-1 text-[12px]', iso === today ? 'bg-primary font-semibold text-on-primary' : outside ? 'text-fg-muted' : 'text-fg-2')}>
                {d.day}
                {iso === today ? <span className="sr-only"> (today)</span> : null}
              </span>
              {events.slice(0, limit).map((e) => (
                <EventChip key={e.key} e={e} tz={tz} onAction={onAction} dense={month !== null} />
              ))}
              {events.length > limit ? (
                <Button size="sm" variant="ghost" className="self-start" onClick={() => onMore(iso)} aria-label={`Show all ${events.length} events of ${d.toFormat('d LLLL')} in the week view`}>
                  +{events.length - limit} more
                </Button>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
};

const Agenda = ({
  start,
  days,
  tz,
  byDay,
  onAction,
  filtered,
  onClear,
}: {
  start: DateTime;
  days: number;
  tz: string;
  byDay: Map<string, CalendarEvent[]>;
  onAction: OnAction;
  filtered: boolean;
  onClear: () => void;
}) => {
  const list = Array.from({ length: days }, (_, i) => start.plus({ days: i })).filter((d) => byDay.has(d.toISODate()!));
  if (!list.length)
    return (
      <EmptyState
        icon={<CalendarBlank size={28} />}
        title="Nothing planned in this period"
        description={filtered ? 'No events match these filters.' : 'Scheduled publications, task deadlines, milestones and shifts appear here.'}
        action={filtered ? <Button onClick={onClear}>Clear Filters</Button> : undefined}
      />
    );
  return (
    <ol className="flex flex-col gap-4">
      {list.map((d) => (
        <li key={d.toISODate()}>
          <h3 className="mb-2 text-[13px] font-semibold text-fg">{d.toFormat('cccc d LLLL yyyy')}</h3>
          <ul className="flex flex-col gap-2">
            {(byDay.get(d.toISODate()!) ?? []).map((e) => (
              <li key={e.key}>
                <EventChip e={e} tz={tz} onAction={onAction} />
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ol>
  );
};
