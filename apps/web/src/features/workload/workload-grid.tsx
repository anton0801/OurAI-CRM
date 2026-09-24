'use client';
import { CaretDown, CaretRight, DotsThree, Warning } from '@phosphor-icons/react';
import { Fragment, useState } from 'react';
import type { WorkloadMember } from '@castlane/api-contracts';
import { DateTime } from '@castlane/domain';
import { Avatar, Badge, IconButton, Menu, cn, type MenuItem } from '@castlane/ui';
import { label } from '@/lib/labels';
import { useCan, useWorkspace } from '@/lib/workspace-context';
import { DueText, TaskStatusBadge, formatMinutes } from '../tasks/format';
import { AllocationDialog, EstimateDialog, ReassignDialog } from './workload-dialogs';

type Task = WorkloadMember['tasks'][number];

const METHOD_TEXT: Record<Task['method'], string> = {
  even: 'Spread evenly',
  manual: 'Planned by day',
  deadline_day: 'On the deadline day',
  overdue: 'Overdue, counted today',
  unscheduled: 'No deadline',
  unestimated: 'Not estimated',
};

const hours = (m: number | null) => (m === null ? '?' : m % 60 ? (m / 60).toFixed(1) : String(m / 60));

/**
 * Members × days grid (S29): rows 56 px with 28 px avatars, day columns at least 80 px. Numbers are
 * planned hours / available hours; overload is spelled out, not only coloured.
 */
export const WorkloadGrid = ({
  members,
  from,
  period,
  today,
  manage,
  onOpenTask,
  defaultExpanded,
}: {
  members: WorkloadMember[];
  from: string;
  period: 'week' | 'month';
  today: string;
  manage: boolean;
  onOpenTask: (id: string) => void;
  defaultExpanded?: boolean;
}) => {
  const { user } = useWorkspace();
  const can = useCan();
  const [open, setOpen] = useState<Set<string>>(() => new Set(defaultExpanded ? members.map((m) => m.member.membershipId) : []));
  const [reassign, setReassign] = useState<Task | null>(null);
  const [estimate, setEstimate] = useState<Task | null>(null);
  const [plan, setPlan] = useState<Task | null>(null);
  const days = members[0]?.days.map((d) => d.date) ?? [];
  const toggle = (id: string) => setOpen((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });
  return (
    <>
      <div className="overflow-x-auto rounded-[12px] border border-line bg-surface">
        <table className="w-full border-collapse text-[13px]">
          <caption className="sr-only">Workload per member and day, planned hours over available hours</caption>
          <thead>
            <tr className="h-10 border-b border-line text-left text-[12px] text-fg-2">
              <th scope="col" className="sticky left-0 z-10 min-w-[240px] bg-surface px-3">
                Member
              </th>
              <th scope="col" className="min-w-[150px] px-3">
                Period
              </th>
              {days.map((d) => (
                <th key={d} scope="col" className={cn('min-w-[80px] px-2 text-center font-normal', d === today && 'font-semibold text-fg')}>
                  {DateTime.fromISO(d).toFormat(period === 'week' ? 'ccc d' : 'd')}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {members.map((m) => {
              const id = m.member.membershipId;
              const expanded = open.has(id);
              const over = (m.overloadMinutes ?? 0) > 0;
              return (
                <Fragment key={id}>
                  <tr className="h-14 border-b border-line">
                    <th scope="row" className="sticky left-0 z-10 bg-surface px-3 text-left font-normal">
                      <button type="button" onClick={() => toggle(id)} aria-expanded={expanded} className="flex w-full items-center gap-2 text-left focus-visible:outline-2 focus-visible:outline-[var(--c-focus)]">
                        {expanded ? <CaretDown size={14} aria-hidden /> : <CaretRight size={14} aria-hidden />}
                        <Avatar name={m.member.displayName} src={m.member.avatarUrl} size={28} decorative />
                        <span className="flex min-w-0 flex-col">
                          <span className="truncate font-medium text-fg">{m.member.displayName}</span>
                          <span className="text-[12px] text-fg-2">{m.tasks.length} open task{m.tasks.length === 1 ? '' : 's'}</span>
                        </span>
                      </button>
                    </th>
                    <td className="px-3">
                      <span className="flex flex-col gap-0.5 text-[12px]">
                        <span className="text-fg">
                          {formatMinutes(m.plannedMinutes)} planned / {m.availableMinutes === null ? 'capacity unknown' : `${formatMinutes(m.availableMinutes)} available`}
                        </span>
                        {over ? (
                          <span className="flex items-center gap-1 font-medium text-warning">
                            <Warning size={12} aria-hidden /> Overloaded by {formatMinutes(m.overloadMinutes)}
                          </span>
                        ) : null}
                        {m.unestimatedCount ? <span className="text-fg-2">+ {m.unestimatedCount} unestimated (unknown hours)</span> : null}
                        {m.capacityCoverage !== 'full' ? <span className="text-fg-2">{m.capacityCoverage === 'none' ? 'No confirmed capacity' : 'Capacity confirmed for part of the period'}</span> : null}
                      </span>
                    </td>
                    {m.days.map((d) => {
                      const dayOver = (d.overloadMinutes ?? 0) > 0;
                      return (
                        <td key={d.date} className={cn('px-2 text-center font-mono tabular-nums', d.absent && 'bg-surface-2', dayOver && 'text-warning')}>
                          {d.absent ? (
                            <span className="font-sans text-[12px] text-fg-2">Away</span>
                          ) : (
                            <span title={`${formatMinutes(d.plannedMinutes)} planned, ${d.availableMinutes === null ? 'capacity unknown' : `${formatMinutes(d.availableMinutes)} available`}`}>
                              {hours(d.plannedMinutes)}/{hours(d.availableMinutes)}
                              {dayOver ? <span className="sr-only"> overloaded</span> : null}
                            </span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                  {expanded ? (
                    <tr className="border-b border-line">
                      <td colSpan={days.length + 2} className="px-3 py-2">
                        {m.absences.length ? (
                          <p className="mb-2 flex flex-wrap gap-2 text-[12px] text-fg-2">
                            {m.absences.map((a) => (
                              <Badge key={a.id} tone={a.state === 'approved' ? 'info' : 'neutral'}>
                                {label('absenceCategory', a.category)} {a.startDate}–{a.endDate} · {label('absenceState', a.state)}
                              </Badge>
                            ))}
                          </p>
                        ) : null}
                        {m.tasks.length === 0 ? (
                          <p className="text-[13px] text-fg-2">No open tasks in this period.</p>
                        ) : (
                          <ul className="flex flex-col divide-y divide-line">
                            {m.tasks.map((t) => {
                              const items: MenuItem[] = [
                                { label: 'Open Task', onSelect: () => onOpenTask(t.id) },
                                { label: 'Reassign…', onSelect: () => setReassign(t), hidden: !can('tasks.assign') },
                                { label: 'Change Estimate…', onSelect: () => setEstimate(t), hidden: !can('tasks.edit') },
                                { label: 'Plan Days…', onSelect: () => setPlan(t), hidden: !manage || t.estimateMinutes === null },
                              ];
                              return (
                                <li key={t.id} className="flex flex-col gap-1 py-2 md:flex-row md:items-center md:justify-between">
                                  <span className="flex min-w-0 flex-col">
                                    <button type="button" className="truncate text-left font-medium text-fg hover:underline" onClick={() => onOpenTask(t.id)}>
                                      {t.title}
                                    </button>
                                    <span className="flex flex-wrap items-center gap-2 text-[12px] text-fg-2">
                                      <span>{t.project.name}</span>
                                      <TaskStatusBadge status={t.status} />
                                      {t.due ? <DueText due={t.due} tz={user.timezone} compact /> : <span>No deadline</span>}
                                    </span>
                                  </span>
                                  <span className="flex shrink-0 items-center gap-3 text-[12px]">
                                    <span className="text-fg-2">
                                      {t.estimateMinutes === null ? 'Not estimated' : `${formatMinutes(t.remainingMinutes)} left of ${formatMinutes(t.estimateMinutes)}`}
                                    </span>
                                    <span className="text-fg">{t.plannedInPeriod === null ? '—' : `${formatMinutes(t.plannedInPeriod)} here`}</span>
                                    <span className="text-fg-2">{METHOD_TEXT[t.method]}</span>
                                    <Menu label={`Actions for ${t.title}`} trigger={<IconButton label={`Actions for “${t.title}”`} icon={<DotsThree size={16} weight="bold" />} />} items={items} />
                                  </span>
                                </li>
                              );
                            })}
                          </ul>
                        )}
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <ReassignDialog task={reassign} from={from} period={period} onOpenChange={(o) => !o && setReassign(null)} />
      <EstimateDialog task={estimate} onOpenChange={(o) => !o && setEstimate(null)} />
      <AllocationDialog task={plan} days={days} onOpenChange={(o) => !o && setPlan(null)} />
    </>
  );
};
