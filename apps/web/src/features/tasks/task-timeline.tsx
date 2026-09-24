'use client';
import { CaretLeft, CaretRight, LinkSimple } from '@phosphor-icons/react';
import { useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { TaskRow } from '@castlane/api-contracts';
import { DateTime } from '@castlane/domain';
import { Avatar, Button, Select, cn } from '@castlane/ui';
import { label } from '@/lib/labels';
import { RescheduleDialog } from './task-actions';

const DAY_WIDTH = 36;
const ROW_HEIGHT = 44;
const SPANS = [
  { value: '14', label: '2 weeks' },
  { value: '28', label: '4 weeks' },
  { value: '56', label: '8 weeks' },
];

interface Placed {
  task: TaskRow;
  /** Day offsets from the window start (may lie outside the window). */
  from: number;
  to: number;
  dueDay: string;
}

/**
 * S27 Timeline: tasks as bars from start to deadline on a day grid. Dragging a bar (or Shift+Arrow
 * on a focused bar) only PROPOSES a new deadline: the reschedule preview shows how dependent tasks
 * move, and nothing changes before Apply.
 */
export const TaskTimeline = ({
  items,
  tz,
  canEdit,
  showProject,
  onOpen,
  hasMore,
  loadingMore,
  onLoadMore,
}: {
  items: TaskRow[];
  tz: string;
  canEdit: boolean;
  showProject: boolean;
  onOpen: (id: string) => void;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}) => {
  const today = DateTime.now().setZone(tz).startOf('day');
  const [start, setStart] = useState(() => today.startOf('week').minus({ weeks: 1 }).toISODate()!);
  const [span, setSpan] = useState('28');
  const days = Number(span);
  const windowStart = DateTime.fromISO(start, { zone: tz });
  const dayList = useMemo(() => Array.from({ length: days }, (_, i) => windowStart.plus({ days: i })), [start, days, tz]); // eslint-disable-line react-hooks/exhaustive-deps
  const [moving, setMoving] = useState<{ task: TaskRow; dueDate: string } | null>(null);
  // The bar that proposed the move gets focus back when the dialog closes.
  const returnFocus = useRef<HTMLElement | null>(null);

  const offset = (d: DateTime) => Math.round(d.startOf('day').diff(windowStart, 'days').days);
  const placed: Placed[] = [];
  const undated: TaskRow[] = [];
  for (const t of items) {
    if (!t.due) {
      undated.push(t);
      continue;
    }
    const due = t.due.date ? DateTime.fromISO(t.due.date, { zone: tz }) : DateTime.fromISO(t.due.at).setZone(tz);
    const begin = t.startAt ? DateTime.fromISO(t.startAt).setZone(tz) : due;
    const from = offset(begin <= due ? begin : due);
    const to = offset(due);
    placed.push({ task: t, from, to, dueDay: due.toISODate()! });
  }
  const visible = placed.filter((p) => p.to >= 0 && p.from < days);
  const outside = placed.length - visible.length;

  const propose = (p: Placed, shiftDays: number) => {
    if (!canEdit || shiftDays === 0) return;
    const dueDate = DateTime.fromISO(p.dueDay, { zone: tz }).plus({ days: shiftDays }).toISODate()!;
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setMoving({ task: p.task, dueDate });
  };
  const rangeLabel = `${windowStart.toFormat('d LLL yyyy')} – ${windowStart.plus({ days: days - 1 }).toFormat('d LLL yyyy')}`;
  const gridWidth = days * DAY_WIDTH;

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" icon={<CaretLeft size={14} />} onClick={() => setStart(windowStart.minus({ days: Math.max(7, days / 2) }).toISODate()!)}>
          Earlier
        </Button>
        <Button size="sm" onClick={() => setStart(today.startOf('week').minus({ weeks: 1 }).toISODate()!)}>
          Today
        </Button>
        <Button size="sm" icon={<CaretRight size={14} />} onClick={() => setStart(windowStart.plus({ days: Math.max(7, days / 2) }).toISODate()!)}>
          Later
        </Button>
        <div className="w-[130px]">
          <Select aria-label="Timeline range" value={span} onChange={(v) => setSpan(v ?? '28')} options={SPANS} />
        </div>
        <span className="text-[13px] text-fg-2" aria-live="polite">
          {rangeLabel}
        </span>
        {canEdit ? <span className="ml-auto text-[12px] text-fg-muted">Drag a bar or press Shift+←/→ on it to propose a new deadline; the effect on dependent tasks is previewed first.</span> : null}
      </div>
      <div className="relative min-w-0 max-w-full overflow-auto rounded-[12px] border border-line bg-surface">
        <div role="table" aria-label={`Task timeline, ${rangeLabel}`} aria-rowcount={visible.length + 1} style={{ minWidth: 150 + gridWidth }}>
          <div role="row" className="sticky top-0 z-20 flex h-12 border-b border-line bg-surface">
            <div role="columnheader" className="sticky left-0 z-30 flex w-[150px] shrink-0 sm:w-[260px] items-end border-r border-line bg-surface px-3 pb-2 text-[12px] font-medium text-fg-2">
              Task
            </div>
            <div className="relative flex" style={{ width: gridWidth }}>
              {dayList.map((d) => {
                const isToday = d.hasSame(today, 'day');
                return (
                  <div
                    key={d.toISODate()}
                    role="columnheader"
                    aria-label={d.toFormat('cccc d LLLL')}
                    className={cn('flex shrink-0 flex-col items-center justify-end pb-1 text-[11px] tabular-nums', d.weekday >= 6 ? 'text-fg-muted' : 'text-fg-2', isToday && 'font-semibold text-primary')}
                    style={{ width: DAY_WIDTH }}
                  >
                    {d.day === 1 || d.hasSame(windowStart, 'day') ? <span className="text-[10px] uppercase">{d.toFormat('LLL')}</span> : null}
                    <span>{d.day}</span>
                  </div>
                );
              })}
            </div>
          </div>
          {visible.length === 0 ? (
            <div className="px-4 py-8 text-center text-[13px] text-fg-2">No task deadlines fall in this range. Use Earlier / Later to move the window.</div>
          ) : (
            visible.map((p) => <TimelineRow key={p.task.id} p={p} days={days} dayList={dayList} today={today} canEdit={canEdit} showProject={showProject} onOpen={onOpen} onPropose={propose} tz={tz} />)
          )}
        </div>
      </div>
      <p className="text-[12px] text-fg-2">
        {visible.length} on the timeline
        {outside ? ` · ${outside} with deadlines outside this range` : ''}
        {undated.length ? ` · ${undated.length} without a deadline (see the table)` : ''}
        {hasMore ? ' · more tasks match the filters' : ''}
      </p>
      {hasMore ? (
        <div>
          <Button size="sm" loading={loadingMore} onClick={onLoadMore}>
            Load More Tasks
          </Button>
        </div>
      ) : null}
      {moving ? (
        <RescheduleDialog
          open
          onOpenChange={(o) => {
            if (o) return;
            setMoving(null);
            requestAnimationFrame(() => returnFocus.current?.focus());
          }}
          task={moving.task}
          proposedDueDate={moving.dueDate}
        />
      ) : null}
    </div>
  );
};

const TimelineRow = ({
  p,
  days,
  dayList,
  today,
  canEdit,
  showProject,
  onOpen,
  onPropose,
  tz,
}: {
  p: Placed;
  days: number;
  dayList: DateTime[];
  today: DateTime;
  canEdit: boolean;
  showProject: boolean;
  onOpen: (id: string) => void;
  onPropose: (p: Placed, shiftDays: number) => void;
  tz: string;
}) => {
  const t = p.task;
  const [drag, setDrag] = useState<{ x: number; shift: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const from = Math.max(0, p.from);
  const to = Math.min(days - 1, p.to);
  const shift = drag?.shift ?? 0;
  const left = (from + shift) * DAY_WIDTH + 2;
  const width = Math.max(1, to - from + 1) * DAY_WIDTH - 4;
  const closed = t.status === 'done' || t.status === 'cancelled';
  const due = DateTime.fromISO(p.dueDay, { zone: tz });
  const describe = [
    label('taskStatus', t.status),
    t.overdue ? 'Overdue' : null,
    t.blocked ? `Blocked: ${t.blocked.reason}` : null,
    t.startAt ? `Starts ${DateTime.fromISO(t.startAt).setZone(tz).toFormat('d LLL')}` : null,
    `Due ${due.toFormat('d LLL yyyy')}`,
    t.dependencies.openPredecessors ? `Waits for ${t.dependencies.openPredecessors} open task${t.dependencies.openPredecessors === 1 ? '' : 's'}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const onPointerDown = (e: PointerEvent<HTMLButtonElement>) => {
    if (!canEdit || closed || e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ x: e.clientX, shift: 0, moved: false });
  };
  const onPointerMove = (e: PointerEvent<HTMLButtonElement>) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    setDrag({ ...drag, shift: Math.round(dx / DAY_WIDTH), moved: drag.moved || Math.abs(dx) > 4 });
  };
  const onPointerUp = () => {
    if (!drag) return;
    suppressClick.current = drag.moved;
    const s = drag.shift;
    setDrag(null);
    if (s !== 0) onPropose(p, s);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (!e.shiftKey || closed) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      onPropose(p, e.key === 'ArrowRight' ? 1 : -1);
    }
  };

  return (
    <div role="row" className="flex border-b border-line last:border-b-0" style={{ height: ROW_HEIGHT }}>
      <div role="rowheader" className="sticky left-0 z-10 flex w-[150px] shrink-0 sm:w-[260px] items-center gap-2 border-r border-line bg-surface px-3">
        {t.assignee ? <Avatar name={t.assignee.displayName} src={t.assignee.avatarUrl} size={24} /> : <span className="h-6 w-6 shrink-0 rounded-full border border-dashed border-line" title="Unassigned" aria-label="Unassigned" role="img" />}
        <div className="flex min-w-0 flex-col">
          <button type="button" className="truncate text-left text-[13px] font-medium text-fg hover:underline" onClick={() => onOpen(t.id)}>
            {t.title}
          </button>
          {showProject ? <span className="truncate text-[11px] text-fg-2">{t.project.name}</span> : null}
        </div>
      </div>
      <div role="cell" className="relative" style={{ width: days * DAY_WIDTH }}>
        {dayList.map((d, i) =>
          d.weekday >= 6 || d.hasSame(today, 'day') ? (
            <div
              key={i}
              aria-hidden
              className={cn('absolute inset-y-0', d.hasSame(today, 'day') ? 'border-l-2 border-primary/60' : 'bg-surface-2/60')}
              style={{ left: i * DAY_WIDTH, width: d.hasSame(today, 'day') ? 0 : DAY_WIDTH }}
            />
          ) : null,
        )}
        <button
          type="button"
          aria-label={`${t.title}: ${describe}${canEdit && !closed ? '. Shift+Arrow keys propose a new deadline.' : ''}`}
          title={describe}
          className={cn(
            'absolute top-[9px] flex h-[26px] touch-none items-center gap-1 overflow-hidden rounded-[6px] border px-2 text-left text-[12px] font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--c-focus)]',
            closed
              ? 'border-line bg-surface-2 text-fg-2'
              : t.overdue
                ? 'border-danger bg-danger-soft text-danger'
                : t.blocked
                  ? 'border-warning bg-warning-soft text-warning'
                  : 'border-primary/40 bg-selection text-fg',
            canEdit && !closed && 'cursor-grab active:cursor-grabbing',
            drag?.moved && 'shadow-[var(--shadow-overlay)]',
          )}
          style={{ left, width }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => setDrag(null)}
          onKeyDown={onKeyDown}
          onClick={() => {
            if (suppressClick.current) {
              suppressClick.current = false;
              return;
            }
            onOpen(t.id);
          }}
        >
          {t.dependencies.openPredecessors ? <LinkSimple size={12} aria-hidden /> : null}
          <span className="truncate">{p.from < 0 ? '← ' : ''}{t.overdue ? 'Overdue · ' : t.blocked ? 'Blocked · ' : ''}{label('taskStatus', t.status)}</span>
        </button>
        {drag?.moved && shift !== 0 ? (
          <span className="pointer-events-none absolute -top-0.5 z-10 rounded bg-fg px-1 text-[11px] text-canvas" style={{ left: left + width + 4 }}>
            {shift > 0 ? '+' : ''}
            {shift} d → {due.plus({ days: shift }).toFormat('d LLL')}
          </span>
        ) : null}
      </div>
    </div>
  );
};
