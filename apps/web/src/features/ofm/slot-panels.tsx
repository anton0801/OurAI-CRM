'use client';
import Link from 'next/link';
import { useState } from 'react';
import { ofmEndpoints as E, type OfmShiftSummary, type ProjectDetail } from '@castlane/api-contracts';
import { Badge, Button, EmptyState, Panel, formatDateTime } from '@castlane/ui';
import { QueryState } from '@/components/common/query-state';
import { useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useCan, useWorkspace, useWsPath } from '@/lib/workspace-context';
import { AccountChip, MemberChip, ShiftBadges, ShiftTimer, fmtNet, fmtRange } from './common';
import { AcknowledgeHandoverDialog } from './handover-dialogs';
import { OperationDetailDrawer, OperationRow } from './operation-dialogs';
import { SwapList } from './shift-dialogs';

const ShiftLine = ({ s }: { s: OfmShiftSummary }) => {
  const { user } = useWorkspace();
  const wsPath = useWsPath();
  return (
    <li className="flex flex-col gap-1 px-3 py-2 text-[13px] md:flex-row md:items-center md:justify-between">
      <Link href={wsPath(`/ofm/shifts/${s.id}`)} className="min-w-0 hover:underline">
        <span className="font-medium text-fg">{fmtRange(s.scheduledStart, s.scheduledEnd, user.timezone)}</span>
        <span className="block text-fg-2">
          {s.member.displayName} · {s.primaryAccount.label}
          {s.accounts.length > 1 ? ` +${s.accounts.length - 1}` : ''}
        </span>
      </Link>
      <span className="flex shrink-0 items-center gap-2">
        {s.state === 'ended' ? <span className="font-mono text-[12px] tabular-nums text-fg-2">{fmtNet(s.netSeconds)}</span> : null}
        <ShiftBadges shift={s} />
      </span>
    </li>
  );
};

const ShiftList = ({ items, empty }: { items: OfmShiftSummary[]; empty: string }) =>
  items.length ? (
    <ul className="flex flex-col divide-y divide-line rounded-[12px] border border-line">
      {items.map((s) => (
        <ShiftLine key={s.id} s={s} />
      ))}
    </ul>
  ) : (
    <p className="text-[13px] text-fg-2">{empty}</p>
  );

/** My Work → My Shifts: the running shift with its server timer, next shifts, reports and handovers waiting. */
export const MyShiftsSection = () => {
  const { workspace, user } = useWorkspace();
  const wsPath = useWsPath();
  const q = useApiQuery(E.myShifts, { params: { workspaceId: workspace.id } }, { refetchInterval: 60_000 });
  const [ack, setAck] = useState<string | null>(null);
  const d = q.data;
  const active = useApiQuery(E.getShift, { params: { workspaceId: workspace.id, shiftId: d?.active?.id ?? '' } }, { enabled: !!d?.active, refetchInterval: 60_000 });
  return (
    <Panel title="My Shifts" actions={<Link className="text-[13px] font-medium text-primary hover:underline" href={wsPath('/ofm/shifts?view=list')}>Open Schedule</Link>}>
      <QueryState query={q}>
        {d ? (
          d.active || d.upcoming.length || d.reportsPending.length || d.handoversToAcknowledge.length || d.swapRequests.length ? (
            <div className="flex flex-col gap-4">
              {d.active ? (
                <Link href={wsPath(`/ofm/shifts/${d.active.id}`)} className="flex flex-wrap items-center justify-between gap-3 rounded-[12px] border border-primary p-3 hover:bg-surface-2">
                  <span className="min-w-0">
                    <span className="block text-[12px] font-[550] text-fg-2">{d.active.state === 'paused' ? 'On break' : 'Active shift'}</span>
                    <span className="block font-medium text-fg">{d.active.primaryAccount.label}</span>
                  </span>
                  {active.data ? (
                    <ShiftTimer actualStart={active.data.actualStart} actualEnd={active.data.actualEnd} breaks={active.data.breaks} serverNow={active.data.serverNow} running={active.data.state === 'active'} />
                  ) : null}
                </Link>
              ) : null}
              {d.handoversToAcknowledge.length ? (
                <section>
                  <h3 className="mb-1 text-[13px] font-semibold text-fg">Handovers to Acknowledge</h3>
                  <ul className="flex flex-col divide-y divide-line rounded-[12px] border border-line">
                    {d.handoversToAcknowledge.map((h) => (
                      <li key={h.id} className="flex flex-col gap-1 px-3 py-2 text-[13px] md:flex-row md:items-center md:justify-between">
                        <span className="min-w-0">
                          <span className="block font-medium text-fg">{h.account.label}</span>
                          <span className="block truncate text-fg-2">
                            From {h.fromShift.member.displayName} · {h.itemCounts.open} open item(s)
                          </span>
                        </span>
                        <Button size="sm" variant="primary" onClick={() => setAck(h.id)}>
                          Acknowledge
                        </Button>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
              {d.reportsPending.length ? (
                <section>
                  <h3 className="mb-1 text-[13px] font-semibold text-fg">Reports to Finish</h3>
                  <ShiftList items={d.reportsPending} empty="" />
                </section>
              ) : null}
              <section>
                <h3 className="mb-1 text-[13px] font-semibold text-fg">Upcoming</h3>
                <ShiftList items={d.upcoming} empty="No upcoming shifts." />
              </section>
              {d.swapRequests.length ? <SwapList swaps={d.swapRequests} /> : null}
              <p className="text-[12px] text-fg-2">Times in {user.timezone}.</p>
            </div>
          ) : (
            <p className="text-[13px] text-fg-2">No shifts, reports or handovers waiting for you.</p>
          )
        ) : null}
      </QueryState>
      {ack ? <AcknowledgeHandoverDialog handoverId={ack} onClose={() => setAck(null)} /> : null}
    </Panel>
  );
};

/** Account Detail → OFM: assignments, upcoming shifts and open operations of one account. */
export const AccountOfmTab = ({ accountId }: { accountId: string; projectId: string }) => {
  const { workspace, user } = useWorkspace();
  const can = useCan();
  const wsPath = useWsPath();
  const [now] = useState(() => new Date().toISOString());
  const assignments = useApiQuery(E.listAssignments, { params: { workspaceId: workspace.id }, query: { accountId, status: ['current', 'upcoming'], sort: 'validFrom', direction: 'asc', pageSize: 50 } });
  const shifts = useApiQuery(E.listShifts, { params: { workspaceId: workspace.id }, query: { accountId, from: now, pageSize: 20, direction: 'asc' } });
  const ops = useApiQuery(E.listOperations, { params: { workspaceId: workspace.id }, query: { accountId, status: ['open', 'in_progress', 'waiting'], sort: 'dueAt', direction: 'asc', pageSize: 20 } }, { enabled: can('operations.read') });
  const [openOp, setOpenOp] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-5">
      <Panel title="Assignments" actions={<Link className="text-[13px] font-medium text-primary hover:underline" href={wsPath(`/ofm/assignments?accountId=${accountId}`)}>Open Assignments</Link>}>
        <QueryState query={assignments}>
          {assignments.data?.items.length ? (
            <ul className="flex flex-col divide-y divide-line rounded-[12px] border border-line">
              {assignments.data.items.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-[13px]">
                  <MemberChip member={a.member} size={28} />
                  <span className="text-fg-2">
                    {a.coverageLane === 'custom' ? a.coverageLaneLabel : label('coverageLane', a.coverageLane)} · from {formatDateTime(a.validFrom, user.timezone)}
                    {a.validTo ? ` to ${formatDateTime(a.validTo, user.timezone)}` : ''}
                  </span>
                  <Badge>{label('assignmentStatus', a.status)}</Badge>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[13px] text-fg-2">No current OFM assignments on this account.</p>
          )}
        </QueryState>
      </Panel>
      <Panel title="Upcoming Shifts" actions={<Link className="text-[13px] font-medium text-primary hover:underline" href={wsPath(`/ofm/shifts?accountId=${accountId}`)}>Open Schedule</Link>}>
        <QueryState query={shifts}>
          <ShiftList items={shifts.data?.items ?? []} empty="No upcoming shifts on this account." />
        </QueryState>
      </Panel>
      {can('operations.read') ? (
        <Panel title="Open Operations" actions={<Link className="text-[13px] font-medium text-primary hover:underline" href={wsPath(`/ofm/operations?accountId=${accountId}`)}>Open Queue</Link>}>
          <QueryState query={ops}>
            {ops.data?.items.length ? (
              <ul className="flex flex-col divide-y divide-line rounded-[12px] border border-line">
                {ops.data.items.map((o) => (
                  <OperationRow key={o.id} op={o} onOpen={() => setOpenOp(o.id)} />
                ))}
              </ul>
            ) : (
              <p className="text-[13px] text-fg-2">No open operations.</p>
            )}
          </QueryState>
        </Panel>
      ) : null}
      {openOp ? <OperationDetailDrawer id={openOp} onClose={() => setOpenOp(null)} /> : null}
    </div>
  );
};

/** Member Workspace → Shifts: the member's recent and upcoming shifts with net time. */
export const MemberShiftsTab = ({ membershipId }: { membershipId: string }) => {
  const { workspace } = useWorkspace();
  const wsPath = useWsPath();
  const [range] = useState(() => ({ from: new Date(Date.now() - 30 * 86_400_000).toISOString(), to: new Date(Date.now() + 30 * 86_400_000).toISOString() }));
  const shifts = useApiQuery(E.listShifts, { params: { workspaceId: workspace.id }, query: { membershipId, from: range.from, to: range.to, pageSize: 200, direction: 'desc' } });
  const assignments = useApiQuery(E.listAssignments, { params: { workspaceId: workspace.id }, query: { membershipId, status: ['current', 'upcoming'], sort: 'validFrom', direction: 'desc', pageSize: 50 } });
  const items = shifts.data?.items ?? [];
  const ended = items.filter((s) => s.state === 'ended');
  const known = ended.filter((s) => s.netSeconds !== null);
  const netTotal = known.reduce((sum, s) => sum + (s.netSeconds ?? 0), 0);
  return (
    <div className="flex flex-col gap-5">
      <Panel title="OFM Assignments">
        <QueryState query={assignments}>
          {assignments.data?.items.length ? (
            <ul className="flex flex-wrap gap-2">
              {assignments.data.items.map((a) => (
                <li key={a.id}>
                  <Badge>
                    <AccountChip account={a.account} /> · {label('assignmentStatus', a.status)}
                  </Badge>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[13px] text-fg-2">No current OFM assignments.</p>
          )}
        </QueryState>
      </Panel>
      <Panel
        title="Shifts (±30 days)"
        description={ended.length ? `${ended.length} ended shift(s), net ${fmtNet(netTotal)}${known.length < ended.length ? ` (${ended.length - known.length} pending)` : ''}` : undefined}
        actions={<Link className="text-[13px] font-medium text-primary hover:underline" href={wsPath(`/ofm/shifts?view=list&membershipId=${membershipId}`)}>Open Schedule</Link>}
      >
        <QueryState query={shifts}>
          <ShiftList items={items} empty="No shifts in the last or next 30 days." />
        </QueryState>
      </Panel>
    </div>
  );
};

/** Project workspace → Operations (only for projects with OFM enabled). */
export const ProjectOperationsTab = ({ project }: { project: ProjectDetail }) => {
  const { workspace } = useWorkspace();
  const can = useCan();
  const wsPath = useWsPath();
  const [now] = useState(() => new Date().toISOString());
  const profile = useApiQuery(E.profiles, { params: { workspaceId: workspace.id }, query: { projectId: project.id } });
  const ops = useApiQuery(E.listOperations, { params: { workspaceId: workspace.id }, query: { projectId: project.id, status: ['open', 'in_progress', 'waiting'], sort: 'dueAt', direction: 'asc', pageSize: 30 } }, { enabled: can('operations.read') });
  const shifts = useApiQuery(E.listShifts, { params: { workspaceId: workspace.id }, query: { projectId: project.id, from: now, pageSize: 20, direction: 'asc' } });
  const [openOp, setOpenOp] = useState<string | null>(null);
  const p = profile.data?.[0];
  return (
    <div className="flex flex-col gap-5">
      <QueryState query={profile}>
        {p ? (
          <Panel title="OFM" actions={<Link className="text-[13px] font-medium text-primary hover:underline" href={wsPath(`/ofm?projectId=${project.id}`)}>Open Model Operations</Link>}>
            <div className="flex flex-col gap-3 text-[13px]">
              <p className="flex flex-wrap items-center gap-2 text-fg-2">
                Supervisor: <MemberChip member={p.supervisor} size={28} /> · {p.activeShifts} active shift(s) · {p.scheduledNext7Days} scheduled in 7 days
              </p>
              <ul className="flex flex-wrap gap-2">
                {p.accounts.map((a) => (
                  <li key={a.id}>
                    <Badge>
                      <AccountChip account={a} />
                    </Badge>
                  </li>
                ))}
              </ul>
            </div>
          </Panel>
        ) : (
          <EmptyState title="OFM is not set up for this model" description="Enable OFM on the project and add accounts to schedule shifts." />
        )}
      </QueryState>
      {can('operations.read') ? (
        <Panel title="Open Operations" actions={<Link className="text-[13px] font-medium text-primary hover:underline" href={wsPath(`/ofm/operations?projectId=${project.id}`)}>Open Queue</Link>}>
          <QueryState query={ops}>
            {ops.data?.items.length ? (
              <ul className="flex flex-col divide-y divide-line rounded-[12px] border border-line">
                {ops.data.items.map((o) => (
                  <OperationRow key={o.id} op={o} onOpen={() => setOpenOp(o.id)} />
                ))}
              </ul>
            ) : (
              <p className="text-[13px] text-fg-2">No open operations.</p>
            )}
          </QueryState>
        </Panel>
      ) : null}
      <Panel title="Upcoming Shifts" actions={<Link className="text-[13px] font-medium text-primary hover:underline" href={wsPath(`/ofm/shifts?projectId=${project.id}`)}>Open Schedule</Link>}>
        <QueryState query={shifts}>
          <ShiftList items={shifts.data?.items ?? []} empty="No upcoming shifts." />
        </QueryState>
      </Panel>
      {openOp ? <OperationDetailDrawer id={openOp} onClose={() => setOpenOp(null)} /> : null}
    </div>
  );
};

