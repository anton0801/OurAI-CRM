'use client';
import { DotsThree, Pause, Play, Plus, Stop } from '@phosphor-icons/react';
import { useState } from 'react';
import { ofmEndpoints as E, type OfmReportDetail, type OfmReportVersion, type OfmShiftDetail } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import {
  Badge,
  Banner,
  Button,
  ConfirmDialog,
  DateTimeInput,
  DescriptionList,
  Dialog,
  Field,
  IconButton,
  Input,
  Menu,
  PageHeader,
  Panel,
  Switch,
  Textarea,
  formatDateTime,
  formatMoney,
  toast,
  type MenuItem,
} from '@castlane/ui';
import { ConflictDialog } from '@/components/common/conflict';
import { useEditBase } from '@/lib/edit-base';
import { QueryState } from '@/components/common/query-state';
import { useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useWorkspace, useWsPath } from '@/lib/workspace-context';
import { AccountChip, MemberChip, OfmNav, ReasonDialog, ShiftBadges, ShiftTimer, TIME_ZONE_NOTE, errorMessage, fmtNet, fmtRange, fromLocalInput, runAction, toLocalInput, useOfmMutation } from './common';
import { AcknowledgeHandoverDialog, HandoverComposer, IncomingHandovers } from './handover-dialogs';
import { InteractionDialog, OperationDetailDrawer, OperationDrawer, OperationRow, SaleCandidateDrawer, SaleCandidateList } from './operation-dialogs';
import { CancelShiftDialog, ScheduleShiftDrawer, SwapList, SwapRequestDialog } from './shift-dialogs';

type Dlg = 'start' | 'end' | 'cancel' | 'edit' | 'swap' | 'early' | 'missed' | 'correct' | 'allocation' | 'operation' | 'sale' | 'interaction' | null;

/** S43 Shift Workspace: server timer, breaks, handovers, operations, sale candidates and the report. */
export const ShiftWorkspace = ({ shiftId }: { shiftId: string }) => {
  const { workspace, user } = useWorkspace();
  const wsPath = useWsPath();
  const q = useApiQuery(E.getShift, { params: { workspaceId: workspace.id, shiftId } }, { refetchInterval: 60_000 });
  const [dlg, setDlg] = useState<Dlg>(null);
  const [openOp, setOpenOp] = useState<string | null>(null);
  const [saleOp, setSaleOp] = useState<string | undefined>(undefined);
  const [conflict, setConflict] = useState(false);
  const pause = useOfmMutation(E.pauseShift, { successMessage: 'Break started' });
  const resume = useOfmMutation(E.resumeShift, { successMessage: 'Break ended' });
  const s = q.data;
  const p = { workspaceId: workspace.id, shiftId };
  const onConflict = (e: unknown) => {
    if (isApiError(e) && e.code === 'VERSION_CONFLICT') setConflict(true);
  };

  const menu: MenuItem[] = s
    ? [
        { label: 'Edit Schedule', onSelect: () => setDlg('edit'), hidden: !s.permissions.editSchedule },
        { label: 'Request Swap', onSelect: () => setDlg('swap'), hidden: !s.permissions.requestSwap },
        { label: 'Allow Early Start', onSelect: () => setDlg('early'), hidden: !s.permissions.allowEarlyStart },
        { label: 'Correct Time', onSelect: () => setDlg('correct'), hidden: !s.permissions.correct },
        { label: 'Time Allocation', onSelect: () => setDlg('allocation'), hidden: !s.permissions.setTimeAllocation },
        { label: 'Mark Missed', onSelect: () => setDlg('missed'), hidden: !s.permissions.markMissed, separatorBefore: true },
        { label: 'Cancel Shift', destructive: true, onSelect: () => setDlg('cancel'), hidden: !s.permissions.cancel },
      ]
    : [];
  const early = s ? Date.parse(s.serverNow) < Date.parse(s.scheduledStart) - 15 * 60_000 && !s.earlyStartAllowed : false;

  return (
    <QueryState query={q}>
      {s ? (
        <div className="flex flex-col gap-5">
          <PageHeader
            crumbs={[{ label: 'OFM', href: wsPath('/ofm') }, { label: 'Shifts', href: wsPath('/ofm/shifts') }, { label: fmtRange(s.scheduledStart, s.scheduledEnd, user.timezone) }]}
            title={`${s.member.displayName} · ${s.primaryAccount.label}`}
            meta={<ShiftBadges shift={s} />}
            description={TIME_ZONE_NOTE}
            actions={
              <>
                {s.permissions.start ? (
                  <Button variant="primary" icon={<Play size={14} />} disabled={early} onClick={() => setDlg('start')}>
                    Start
                  </Button>
                ) : null}
                {s.permissions.pause ? (
                  <Button icon={<Pause size={14} />} loading={pause.isPending} onClick={() => void runAction(() => pause.run({ params: p, body: {} }, { ifMatch: s.rowVersion }).catch((e) => (onConflict(e), Promise.reject(e))))}>
                    Pause
                  </Button>
                ) : null}
                {s.permissions.resume && s.openBreakId ? (
                  <Button
                    variant="primary"
                    icon={<Play size={14} />}
                    loading={resume.isPending}
                    onClick={() => void runAction(() => resume.run({ params: p, body: { breakId: s.openBreakId! } }, { ifMatch: s.rowVersion }).catch((e) => (onConflict(e), Promise.reject(e))))}
                  >
                    Resume
                  </Button>
                ) : null}
                {s.permissions.end ? (
                  <Button variant="danger-secondary" icon={<Stop size={14} />} onClick={() => setDlg('end')}>
                    End
                  </Button>
                ) : null}
                {menu.some((m) => !m.hidden) ? <Menu label="Shift actions" trigger={<IconButton label="Shift actions" icon={<DotsThree size={18} weight="bold" />} />} items={menu} /> : null}
              </>
            }
          />
          <OfmNav />
          {s.permissions.start && early ? (
            <Banner tone="info">You can start 15 minutes before the scheduled start. A supervisor can allow an earlier start.</Banner>
          ) : null}
          {s.needsReview === 'forgotten_end' ? (
            <Banner tone="warning">The scheduled end passed and the shift was not ended. Castlane does not fill in an actual end; the member ends it or a supervisor corrects the time.</Banner>
          ) : s.needsReview === 'not_started' ? (
            <Banner tone="warning">The shift was not started. A supervisor can mark it Missed after the scheduled end.</Banner>
          ) : s.needsReview === 'actual_overlap' ? (
            <Banner tone="warning">Actual time overlaps another shift of this member. Review the times.</Banner>
          ) : null}
          {s.state === 'cancelled' && s.cancelReason ? <Banner tone="info">Cancelled: {s.cancelReason}</Banner> : null}
          {s.correctedAt ? (
            <Banner tone="info">
              Time corrected {formatDateTime(s.correctedAt, user.timezone)}: {s.correctionReason}. Compensation sources based on this shift were flagged for recalculation.
            </Banner>
          ) : null}

          <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
            <div className="flex min-w-0 flex-col gap-5">
              <Panel title="Time">
                <div className="flex flex-col gap-4">
                  <div className="flex flex-wrap items-end justify-between gap-3">
                    <div>
                      <p className="text-[12px] font-[550] text-fg-2">Net Time</p>
                      <ShiftTimer actualStart={s.actualStart} actualEnd={s.actualEnd} breaks={s.breaks} serverNow={s.serverNow} running={s.state === 'active'} />
                      {s.state === 'paused' ? <p className="text-[12px] text-warning">On break — the timer is paused.</p> : null}
                    </div>
                    {s.state === 'ended' ? <Badge tone={s.aborted ? 'warning' : 'neutral'}>{s.aborted ? 'Ended early (aborted)' : `Net ${fmtNet(s.netSeconds)}`}</Badge> : null}
                  </div>
                  <DescriptionList
                    items={[
                      { label: 'Scheduled', value: `${fmtRange(s.scheduledStart, s.scheduledEnd, s.timezone)} (${s.timezone})` },
                      { label: 'Your Time', value: fmtRange(s.scheduledStart, s.scheduledEnd, user.timezone), hidden: user.timezone === s.timezone },
                      { label: 'Actual Start', value: s.actualStart ? formatDateTime(s.actualStart, user.timezone) : 'Not started' },
                      { label: 'Actual End', value: s.actualEnd ? formatDateTime(s.actualEnd, user.timezone) : s.actualStart ? 'Pending' : '—' },
                      { label: 'Late', value: s.lateMinutes !== null ? (s.lateMinutes > 0 ? `${s.lateMinutes} min` : 'On time') : null, hidden: s.lateMinutes === null },
                      { label: 'Early Start', value: s.startOverrideReason ? `Allowed: ${s.startOverrideReason}` : null, hidden: !s.startOverrideReason },
                      { label: 'Started Without Handover', value: s.noHandoverReason, hidden: !s.noHandoverReason },
                      { label: 'End Note', value: s.endNote, hidden: !s.endNote },
                    ]}
                  />
                  {s.dst.offsetChanges ? (
                    <Banner tone="warning">
                      Daylight saving time changes during this shift: {s.dst.elapsedMinutes} minutes elapse while the clock shows {s.dst.wallClockMinutes}. Net time uses elapsed time.
                    </Banner>
                  ) : null}
                  <section>
                    <h3 className="mb-1 text-[13px] font-semibold text-fg">Breaks</h3>
                    {s.breaks.length ? (
                      <ul className="flex flex-col gap-1 text-[13px]">
                        {s.breaks.map((b) => (
                          <li key={b.id} className="flex flex-wrap justify-between gap-2">
                            <span>
                              {formatDateTime(b.startedAt, user.timezone)} – {b.endedAt ? formatDateTime(b.endedAt, user.timezone) : 'open'}
                            </span>
                            {b.reason ? <span className="text-fg-2">{b.reason}</span> : null}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-[13px] text-fg-2">No breaks.</p>
                    )}
                  </section>
                </div>
              </Panel>

              <Panel title="Previous Handover">
                <IncomingHandovers shift={s} />
              </Panel>

              {s.report ? (
                <Panel title="Shift Report" description={s.report.reviewer ? `Reviewer: ${s.report.reviewer.displayName}` : undefined}>
                  <ReportSection shift={s} report={s.report} />
                </Panel>
              ) : s.state === 'active' || s.state === 'paused' ? (
                <Panel title="Shift Report">
                  <p className="text-[13px] text-fg-2">The report draft opens when the shift ends.</p>
                </Panel>
              ) : null}

              {['active', 'paused', 'ended'].includes(s.state) ? (
                <Panel title="Handover to Next Shift">
                  <HandoverComposer shift={s} />
                </Panel>
              ) : null}

              <Panel
                title="Operations"
                actions={
                  s.permissions.addOperation ? (
                    <Button size="sm" icon={<Plus size={14} />} onClick={() => setDlg('operation')}>
                      Add Operation
                    </Button>
                  ) : undefined
                }
              >
                {s.operations.length ? (
                  <ul className="flex flex-col divide-y divide-line rounded-[12px] border border-line">
                    {s.operations.map((o) => (
                      <OperationRow key={o.id} op={o} onOpen={() => setOpenOp(o.id)} />
                    ))}
                  </ul>
                ) : (
                  <p className="text-[13px] text-fg-2">No operations linked to this shift or open on its accounts.</p>
                )}
              </Panel>

              {s.saleCandidates ? (
                <Panel
                  title="Sale Candidates"
                  description="Pending Verification until Finance confirms them. Never revenue by themselves."
                  actions={
                    s.permissions.registerSale ? (
                      <Button size="sm" icon={<Plus size={14} />} onClick={() => setDlg('sale')}>
                        Register Sale Candidate
                      </Button>
                    ) : undefined
                  }
                >
                  <SaleCandidateList items={s.saleCandidates} empty="No sale candidates registered for this shift." />
                </Panel>
              ) : null}
            </div>

            <div className="flex min-w-0 flex-col gap-5">
              <Panel title="Details">
                <div className="flex flex-col gap-4">
                  <DescriptionList
                    columns={1}
                    items={[
                      { label: 'Member', value: <MemberChip member={s.member} size={28} /> },
                      { label: 'Supervisor', value: <MemberChip member={s.supervisor} size={28} /> },
                      { label: 'Model', value: s.project.name },
                      { label: 'Member Time Zone', value: s.memberTimezone },
                    ]}
                  />
                  <section>
                    <h3 className="mb-1 text-[12px] font-[550] text-fg-2">Accounts</h3>
                    <ul className="flex flex-col gap-1.5 text-[13px]">
                      {s.accounts.map((a) => (
                        <li key={a.account.id} className="flex flex-wrap items-center justify-between gap-2">
                          <AccountChip account={a.account} />
                          <span className="flex items-center gap-1.5">
                            {a.isPrimary ? <Badge tone="primary">Primary</Badge> : null}
                            <Badge>{a.coverageLane === 'custom' ? (a.coverageLaneLabel ?? 'Custom') : label('coverageLane', a.coverageLane)}</Badge>
                            {a.timeAllocationShare ? <Badge tone="info">{a.timeAllocationShare} %</Badge> : null}
                          </span>
                        </li>
                      ))}
                    </ul>
                    {s.accounts.length > 1 && !s.accounts.some((a) => a.timeAllocationShare) ? (
                      <p className="mt-1 text-[12px] text-fg-2">No confirmed time allocation: per-account hours are not available, only the whole shift.</p>
                    ) : null}
                  </section>
                </div>
              </Panel>
              {s.tasks?.length ? (
                <Panel title="Tasks">
                  <ul className="flex flex-col gap-1.5 text-[13px]">
                    {s.tasks.map((t) => (
                      <li key={t.id} className="flex items-center justify-between gap-2">
                        <a className="min-w-0 truncate hover:underline" href={wsPath(`/tasks/${t.id}`)}>
                          {t.title}
                        </a>
                        <Badge>{label('taskStatus', t.status)}</Badge>
                      </li>
                    ))}
                  </ul>
                </Panel>
              ) : null}
              {s.interactionsCount !== undefined ? (
                <Panel
                  title="Interactions"
                  actions={
                    s.permissions.logInteraction ? (
                      <Button size="sm" onClick={() => setDlg('interaction')}>
                        Log Interaction
                      </Button>
                    ) : undefined
                  }
                >
                  <p className="text-[13px] text-fg-2">{s.interactionsCount} interaction(s) logged during this shift. Open a contact to read them.</p>
                </Panel>
              ) : null}
              {s.swapRequests.length ? <SwapList swaps={s.swapRequests} /> : null}
              {s.corrections.length ? (
                <Panel title="Time Corrections">
                  <ul className="flex flex-col gap-2 text-[13px]">
                    {s.corrections.map((c) => (
                      <li key={c.id}>
                        <p className="text-fg">{c.reason}</p>
                        <p className="text-[12px] text-fg-2">
                          {formatDateTime(c.createdAt, user.timezone)}
                          {c.by ? ` · ${c.by.displayName}` : ''}
                        </p>
                      </li>
                    ))}
                  </ul>
                </Panel>
              ) : null}
            </div>
          </div>

          {dlg === 'start' ? <StartDialog shift={s} onClose={() => setDlg(null)} /> : null}
          {dlg === 'end' ? <EndDialog shift={s} onClose={() => setDlg(null)} /> : null}
          {dlg === 'cancel' ? <CancelShiftDialog shift={s} open onOpenChange={(o) => !o && setDlg(null)} /> : null}
          {dlg === 'edit' ? <ScheduleShiftDrawer shift={s} onClose={() => setDlg(null)} /> : null}
          {dlg === 'swap' ? <SwapRequestDialog shift={s} onClose={() => setDlg(null)} /> : null}
          {dlg === 'early' ? <SimpleReasonCommand shift={s} kind="early" onClose={() => setDlg(null)} /> : null}
          {dlg === 'missed' ? <SimpleReasonCommand shift={s} kind="missed" onClose={() => setDlg(null)} /> : null}
          {dlg === 'correct' ? <CorrectTimeDialog shift={s} onClose={() => setDlg(null)} /> : null}
          {dlg === 'allocation' ? <AllocationDialog shift={s} onClose={() => setDlg(null)} /> : null}
          {dlg === 'operation' ? <OperationDrawer preset={{ accountId: s.primaryAccount.id, shiftId: s.id }} onClose={() => setDlg(null)} /> : null}
          {dlg === 'sale' || saleOp ? (
            <SaleCandidateDrawer
              preset={{ accountId: s.primaryAccount.id, shiftId: s.id, operationId: saleOp }}
              onClose={() => {
                setDlg(null);
                setSaleOp(undefined);
              }}
            />
          ) : null}
          {dlg === 'interaction' ? <InteractionDialog accountId={s.primaryAccount.id} shiftId={s.id} onClose={() => setDlg(null)} /> : null}
          {openOp ? <OperationDetailDrawer id={openOp} onClose={() => setOpenOp(null)} onRegisterSale={(op) => (setOpenOp(null), setSaleOp(op.id))} /> : null}
          <ConflictDialog open={conflict} onOpenChange={setConflict} onReload={() => (setConflict(false), void q.refetch())} />
        </div>
      ) : null}
    </QueryState>
  );
};

// ——— Start / End ———

const StartDialog = ({ shift, onClose }: { shift: OfmShiftDetail; onClose: () => void }) => {
  const { workspace } = useWorkspace();
  const start = useOfmMutation(E.startShift, { successMessage: 'Shift started', also: ['myWork.'] });
  const pending = shift.incomingHandovers.filter((h) => h.state === 'submitted');
  const acked = shift.incomingHandovers.find(
    (h) => h.state === 'acknowledged' && (h.toShift?.id === shift.id || h.recipient?.membershipId === shift.member.membershipId),
  );
  const [reason, setReason] = useState('');
  const [ackId, setAckId] = useState<string | null>(null);
  const [ackedNow, setAckedNow] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The version shown when the dialog opened (T162).
  const edit = useEditBase(shift);
  const stillPending = pending.filter((h) => h.id !== ackedNow);
  const run = async () => {
    setError(null);
    try {
      await start.run(
        {
          params: { workspaceId: workspace.id, shiftId: shift.id },
          body: { handoverAcknowledgementId: ackedNow ?? acked?.id, noHandoverReason: stillPending.length ? reason.trim() : undefined },
        },
        { ifMatch: edit.version },
      );
      onClose();
    } catch (e) {
      if (!edit.catchConflict(e)) setError(errorMessage(e, 'The shift could not be started.'));
    }
  };
  return (
    <>
      <Dialog
        open
        onOpenChange={(o) => !o && onClose()}
        size="small"
        title="Start shift"
        description="The server records the actual start. The timer keeps running if you close or refresh the page."
        footer={
          <>
            <Button onClick={onClose} disabled={start.isPending}>
              Cancel
            </Button>
            <Button variant="primary" loading={start.isPending} disabled={stillPending.length > 0 && reason.trim().length < 3} onClick={() => void run()}>
              {stillPending.length ? 'Start Without Acknowledgement' : 'Start'}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4 text-[14px]">
          {error ? <Banner tone="danger">{error}</Banner> : null}
          {stillPending.length ? (
            <>
              <Banner tone="warning">
                {stillPending.length === 1 ? 'A handover is waiting for you.' : `${stillPending.length} handovers are waiting for you.`} Acknowledge it before starting, or explain why you start without it — your
                supervisor is notified.
              </Banner>
              <div className="flex flex-wrap gap-2">
                {stillPending.map((h) => (
                  <Button key={h.id} variant="primary" onClick={() => setAckId(h.id)}>
                    Acknowledge Handover from {h.fromShift.member.displayName}
                  </Button>
                ))}
              </div>
              <Field label="Reason to start without acknowledgement" helper="At least 3 characters.">
                <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
              </Field>
            </>
          ) : acked || ackedNow ? (
            <p className="text-fg-2">The previous handover was acknowledged.</p>
          ) : (
            <p className="text-fg-2">No handover is waiting for this shift.</p>
          )}
        </div>
        {ackId ? <AcknowledgeHandoverDialog handoverId={ackId} onClose={() => setAckId(null)} onDone={(h) => setAckedNow(h.id)} /> : null}
      </Dialog>
      <ConflictDialog {...edit.conflictDialog} />
    </>
  );
};

const EndDialog = ({ shift, onClose }: { shift: OfmShiftDetail; onClose: () => void }) => {
  const { workspace } = useWorkspace();
  const end = useOfmMutation(E.endShift, { successMessage: 'Shift ended — the report draft is open', also: ['myWork.'] });
  const [note, setNote] = useState('');
  const [aborted, setAborted] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  // The version shown when the dialog opened (T162).
  const edit = useEditBase(shift);
  return (
    <>
      <Dialog
        open
        onOpenChange={(o) => !o && onClose()}
        size="small"
        title="End shift?"
        description={shift.state === 'paused' ? 'The open break closes at the same instant.' : 'The server records the actual end and opens the report draft.'}
        dirty={(note + reason).length > 0 && !end.isPending}
        footer={
          <>
            <Button onClick={onClose} disabled={end.isPending}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={end.isPending}
              disabled={aborted && reason.trim().length < 3}
              onClick={async () => {
                setError(null);
                try {
                  await end.run(
                    { params: { workspaceId: workspace.id, shiftId: shift.id }, body: { endNote: note.trim() || undefined, aborted, abortReason: aborted ? reason.trim() : undefined } },
                    { ifMatch: edit.version },
                  );
                  onClose();
                } catch (e) {
                  if (!edit.catchConflict(e)) setError(errorMessage(e));
                }
              }}
            >
              End Shift
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {error ? <Banner tone="danger">{error}</Banner> : null}
          <Field label="End Note">
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} />
          </Field>
          <Switch label="End early (abort)" description="Use when the shift stops before its planned end for a reason." checked={aborted} onCheckedChange={setAborted} />
          {aborted ? (
            <Field label="Reason" required helper="At least 3 characters.">
              <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} />
            </Field>
          ) : null}
        </div>
      </Dialog>
      <ConflictDialog {...edit.conflictDialog} />
    </>
  );
};

const SimpleReasonCommand = ({ shift, kind, onClose }: { shift: OfmShiftDetail; kind: 'early' | 'missed'; onClose: () => void }) => {
  const { workspace } = useWorkspace();
  const early = useOfmMutation(E.allowEarlyStart, { successMessage: 'Early start allowed' });
  const missed = useOfmMutation(E.markMissed, { successMessage: 'Shift marked Missed', also: ['myWork.'] });
  const params = { workspaceId: workspace.id, shiftId: shift.id };
  return (
    <ReasonDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={kind === 'early' ? 'Allow early start' : 'Mark shift missed?'}
      body={kind === 'early' ? 'The member may start more than 15 minutes before the scheduled start.' : 'Confirms that the shift did not take place. No time is recorded.'}
      confirmLabel={kind === 'early' ? 'Allow Early Start' : 'Mark Missed'}
      destructive={kind === 'missed'}
      record={shift}
      onConfirm={(reason, ifMatch) => (kind === 'early' ? early.run({ params, body: { reason } }, { ifMatch }) : missed.run({ params, body: { reason } }, { ifMatch }))}
    />
  );
};

const CorrectTimeDialog = ({ shift, onClose }: { shift: OfmShiftDetail; onClose: () => void }) => {
  const { workspace } = useWorkspace();
  const zone = shift.timezone;
  const [start, setStart] = useState(toLocalInput(shift.actualStart, zone));
  const [end, setEnd] = useState(toLocalInput(shift.actualEnd, zone));
  const [breaks, setBreaks] = useState(shift.breaks.map((b) => ({ id: b.id as string | undefined, start: toLocalInput(b.startedAt, zone), end: toLocalInput(b.endedAt, zone) })));
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  // The version shown when the dialog opened (T162).
  const edit = useEditBase(shift);
  const m = useOfmMutation(E.correctTime, { successMessage: 'Time corrected', also: ['myWork.', 'time.', 'finance.'] });
  const forcedEnd = (shift.state === 'active' || shift.state === 'paused') && !!end;
  const breaksValid = breaks.every((b) => b.start && b.end && b.end > b.start);
  return (
    <>
      <Dialog
        open
        onOpenChange={(o) => !o && onClose()}
        title="Correct time"
        description={`Times in the shift’s zone (${zone}). The change is audited and compensation based on this shift is flagged for recalculation.`}
        dirty
        footer={
          <>
            <Button onClick={onClose} disabled={m.isPending}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={m.isPending}
              disabled={reason.trim().length < 3 || !start || !breaksValid}
              onClick={async () => {
                setError(null);
                try {
                  await m.run(
                    {
                      params: { workspaceId: workspace.id, shiftId: shift.id },
                      body: {
                        actualStart: fromLocalInput(start, zone) ?? undefined,
                        actualEnd: end ? (fromLocalInput(end, zone) ?? undefined) : undefined,
                        breaks: breaks.map((b) => ({ id: b.id, startedAt: fromLocalInput(b.start, zone)!, endedAt: fromLocalInput(b.end, zone)! })),
                        reason: reason.trim(),
                      },
                    },
                    { ifMatch: edit.version },
                  );
                  onClose();
                } catch (e) {
                  if (!edit.catchConflict(e)) setError(errorMessage(e));
                }
              }}
            >
              Save Correction
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {error ? <Banner tone="danger">{error}</Banner> : null}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Actual Start" required>
              <DateTimeInput timezone={zone} value={start} onChange={(e) => setStart(e.target.value)} />
            </Field>
            <Field label="Actual End" helper={shift.actualEnd ? undefined : 'Leave empty to keep the shift running.'}>
              <DateTimeInput timezone={zone} value={end} onChange={(e) => setEnd(e.target.value)} />
            </Field>
          </div>
          {forcedEnd ? <Banner tone="warning">Setting an actual end on a running shift ends it (forced end).</Banner> : null}
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-[13px] font-[550] text-fg">Breaks</legend>
            {breaks.map((b, i) => (
              <div key={b.id ?? `new-${i}`} className="grid grid-cols-1 items-start gap-2 sm:grid-cols-[1fr_1fr_auto]">
                <DateTimeInput timezone={zone} aria-label={`Break ${i + 1} start`} value={b.start} onChange={(e) => setBreaks(breaks.map((x, n) => (n === i ? { ...x, start: e.target.value } : x)))} />
                <DateTimeInput timezone={zone} aria-label={`Break ${i + 1} end`} value={b.end} onChange={(e) => setBreaks(breaks.map((x, n) => (n === i ? { ...x, end: e.target.value } : x)))} />
                <Button size="sm" variant="ghost" onClick={() => setBreaks(breaks.filter((_, n) => n !== i))}>
                  Remove
                </Button>
              </div>
            ))}
            {!breaksValid ? <p className="text-[12px] text-danger">Every break needs a start and a later end.</p> : null}
            <div>
              <Button size="sm" icon={<Plus size={14} />} onClick={() => setBreaks([...breaks, { id: undefined, start: '', end: '' }])}>
                Add Break
              </Button>
            </div>
          </fieldset>
          <Field label="Reason" required helper="At least 3 characters. Shown in the shift history.">
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} />
          </Field>
        </div>
      </Dialog>
      <ConflictDialog {...edit.conflictDialog} />
    </>
  );
};

const AllocationDialog = ({ shift, onClose }: { shift: OfmShiftDetail; onClose: () => void }) => {
  const { workspace } = useWorkspace();
  const [shares, setShares] = useState<Record<string, string>>(Object.fromEntries(shift.accounts.map((a) => [a.account.id, a.timeAllocationShare ?? ''])));
  const [error, setError] = useState<string | null>(null);
  // The version shown when the dialog opened (T162).
  const edit = useEditBase(shift);
  const m = useOfmMutation(E.setTimeAllocation, { successMessage: 'Time allocation saved' });
  const total = Object.values(shares).reduce((s, v) => s + (Number(v) || 0), 0);
  const valid = Math.abs(total - 100) < 0.001 && Object.values(shares).every((v) => /^\d{1,3}(\.\d{1,2})?$/.test(v));
  const save = async (clear: boolean) => {
    setError(null);
    try {
      await m.run(
        { params: { workspaceId: workspace.id, shiftId: shift.id }, body: { shares: clear ? null : Object.entries(shares).map(([accountId, sharePercent]) => ({ accountId, sharePercent })) } },
        { ifMatch: edit.version },
      );
      onClose();
    } catch (e) {
      if (!edit.catchConflict(e)) setError(errorMessage(e));
    }
  };
  return (
    <>
      <Dialog
        open
        onOpenChange={(o) => !o && onClose()}
        size="small"
        title="Time allocation"
        description="Confirmed shares per account (sum exactly 100 %). The shift time itself is never multiplied by the number of accounts."
        footer={
          <>
            {shift.accounts.some((a) => a.timeAllocationShare) ? (
              <Button variant="ghost" onClick={() => void save(true)} disabled={m.isPending}>
                Clear Allocation
              </Button>
            ) : null}
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" disabled={!valid} loading={m.isPending} onClick={() => void save(false)}>
              Save
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {error ? <Banner tone="danger">{error}</Banner> : null}
          {shift.accounts.map((a) => (
            <Field key={a.account.id} label={a.account.label}>
              <Input inputMode="decimal" value={shares[a.account.id] ?? ''} onChange={(e) => setShares({ ...shares, [a.account.id]: e.target.value })} aria-label={`${a.account.label} share (percent)`} />
            </Field>
          ))}
          <p className={total === 100 ? 'text-[13px] text-fg-2' : 'text-[13px] text-danger'}>Total: {total.toFixed(2)} %</p>
        </div>
      </Dialog>
      <ConflictDialog {...edit.conflictDialog} />
    </>
  );
};

// ——— Report ———

const COUNT_FIELDS = [
  { key: 'conversationsHandled', label: 'Conversations Handled' },
  { key: 'followUpsCompleted', label: 'Follow-ups Completed' },
  { key: 'contentRequests', label: 'Content Requests' },
  { key: 'conversionEvents', label: 'Conversion Events' },
] as const;

const ReportSection = ({ shift, report }: { shift: OfmShiftDetail; report: OfmReportDetail }) => {
  const { workspace, user } = useWorkspace();
  const v = report.currentVersion;
  const [approving, setApproving] = useState(false);
  const [changes, setChanges] = useState(false);
  const approve = useOfmMutation(E.approveReport, { successMessage: 'Report approved' });
  const requestChanges = useOfmMutation(E.requestReportChanges, { successMessage: 'Changes requested' });
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge>{label('reportState', report.state)}</Badge>
        <span className="text-[13px] text-fg-2">
          Version {v.versionNo}
          {report.submittedAt ? ` · submitted ${formatDateTime(report.submittedAt, user.timezone)}` : ''}
          {report.approvedAt ? ` · approved ${formatDateTime(report.approvedAt, user.timezone)}` : ''}
        </span>
      </div>
      {report.state === 'changes_requested' ? (
        <Banner tone="warning">Changes requested: {report.versions.find((x) => x.state === 'changes_requested' && x.reviewSummary)?.reviewSummary ?? 'see the reviewer’s note.'}</Banner>
      ) : null}
      {shift.permissions.editReport ? <ReportEditor shift={shift} report={report} /> : <ReportVersionView version={v} shift={shift} />}
      {report.sales ? (
        <section className="rounded-[12px] border border-line p-3 text-[13px]">
          <h3 className="mb-1 font-semibold text-fg">Sales linked to this shift</h3>
          <p className="text-fg-2">
            Pending Verification: {report.sales.pendingVerification.count}
            {report.sales.pendingVerification.amounts?.length ? ` (${report.sales.pendingVerification.amounts.map((a) => formatMoney(a.amount, a.currency)).join(', ')})` : ''}
          </p>
          {report.sales.confirmed ? (
            <p className="text-fg-2">Confirmed in Finance: {report.sales.confirmed.length ? report.sales.confirmed.map((a) => formatMoney(a.amount, a.currency)).join(', ') : 'none'}</p>
          ) : null}
        </section>
      ) : null}
      {shift.permissions.approveReport ? (
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" onClick={() => setApproving(true)}>
            Approve Report
          </Button>
          <Button onClick={() => setChanges(true)}>Request Changes</Button>
        </div>
      ) : null}
      {report.versions.length > 1 ? (
        <section>
          <h3 className="mb-1 text-[13px] font-semibold text-fg">Version History</h3>
          <ul className="flex flex-col gap-1 text-[13px]">
            {report.versions.map((x) => (
              <li key={x.id} className="flex flex-wrap justify-between gap-2">
                <span>
                  Version {x.versionNo} · {label('reportVersionState', x.state)}
                  {x.reviewSummary ? ` — ${x.reviewSummary}` : ''}
                </span>
                <span className="text-fg-2">{formatDateTime(x.submittedAt ?? x.createdAt, user.timezone)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <ConfirmDialog
        open={approving}
        onOpenChange={setApproving}
        title="Approve report?"
        body="The submitted version is frozen. Approval never creates, posts or changes financial entries."
        confirmLabel="Approve Report"
        loading={approve.isPending}
        onConfirm={() =>
          void runAction(() => approve.run({ params: { workspaceId: workspace.id, reportId: report.id }, body: { versionId: v.id } }, { ifMatch: v.rowVersion })).then((ok) => ok && setApproving(false))
        }
      />
      <ReasonDialog
        open={changes}
        onOpenChange={setChanges}
        title="Request changes"
        body="The member revises the report in a new version; this version stays in history."
        confirmLabel="Request Changes"
        reasonLabel="Changes needed"
        record={v}
        onConfirm={(summary, ifMatch) => requestChanges.run({ params: { workspaceId: workspace.id, reportId: report.id }, body: { versionId: v.id, summary } }, { ifMatch })}
      />
    </div>
  );
};

const ReportVersionView = ({ version: v, shift }: { version: OfmReportVersion; shift: OfmShiftDetail }) => (
  <div className="flex flex-col gap-3 text-[14px] leading-[22px]">
    <DescriptionList
      columns={1}
      items={[
        { label: 'Summary', value: v.summary ? <span className="whitespace-pre-wrap">{v.summary}</span> : null },
        { label: 'Completed Work', value: v.completedWork ? <span className="whitespace-pre-wrap">{v.completedWork}</span> : null },
        { label: 'Issues', value: v.issues ? <span className="whitespace-pre-wrap">{v.issues}</span> : null },
        { label: 'Next Actions', value: v.nextActions ? <span className="whitespace-pre-wrap">{v.nextActions}</span> : null },
        ...v.accountSections.map((sec) => ({
          label: shift.accounts.find((a) => a.account.id === sec.accountId)?.account.label ?? 'Account',
          value: <span className="whitespace-pre-wrap">{sec.notes}</span>,
        })),
      ]}
    />
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      {COUNT_FIELDS.map((f) => (
        <div key={f.key}>
          <p className="text-[12px] text-fg-2">{f.label}</p>
          <p className="font-mono tabular-nums">{v.counts[f.key] ?? <span className="text-fg-muted">Not provided</span>}</p>
        </div>
      ))}
    </div>
    <p className="text-[12px] text-fg-2">Counts are Manual Report data entered by the member.</p>
    {v.sourceRefs.length ? (
      <ul className="list-disc pl-5 text-[13px]">
        {v.sourceRefs.map((r, i) => (
          <li key={i}>
            {r.label}
            {r.note ? ` — ${r.note}` : ''}
          </li>
        ))}
      </ul>
    ) : null}
    {v.noOpenItems ? <Badge tone="info">No Open Items</Badge> : null}
  </div>
);

const ReportEditor = ({ shift, report }: { shift: OfmShiftDetail; report: OfmReportDetail }) => {
  const { workspace } = useWorkspace();
  const v = report.currentVersion;
  const [summary, setSummary] = useState(v.summary);
  const [completed, setCompleted] = useState(v.completedWork ?? '');
  const [issues, setIssues] = useState(v.issues ?? '');
  const [next, setNext] = useState(v.nextActions ?? '');
  const [sections, setSections] = useState<Record<string, string>>(Object.fromEntries(v.accountSections.map((s) => [s.accountId, s.notes])));
  const [counts, setCounts] = useState<Record<string, string>>(Object.fromEntries(COUNT_FIELDS.map((f) => [f.key, v.counts[f.key] === null ? '' : String(v.counts[f.key])])));
  const [refs, setRefs] = useState(v.sourceRefs.map((r) => ({ label: r.label, note: r.note ?? '' })));
  const [noOpenItems, setNoOpenItems] = useState(v.noOpenItems);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const load = (x: OfmReportVersion) => {
    setSummary(x.summary);
    setCompleted(x.completedWork ?? '');
    setIssues(x.issues ?? '');
    setNext(x.nextActions ?? '');
    setSections(Object.fromEntries(x.accountSections.map((s) => [s.accountId, s.notes])));
    setCounts(Object.fromEntries(COUNT_FIELDS.map((f) => [f.key, x.counts[f.key] === null ? '' : String(x.counts[f.key])])));
    setRefs(x.sourceRefs.map((r) => ({ label: r.label, note: r.note ?? '' })));
    setNoOpenItems(x.noOpenItems);
    setDirty(false);
  };
  // The draft is saved against the version it was loaded at (T162); untouched, it follows the latest.
  const edit = useEditBase(v, { key: report.id, clean: !dirty, onReload: load });
  const save = useOfmMutation(E.saveReportDraft);
  const submit = useOfmMutation(E.submitReport, { also: ['myWork.'] });
  const handover = shift.outgoingHandover;
  const touch = <T,>(fn: (x: T) => void) => (x: T) => (fn(x), setDirty(true));

  const body = () => ({
    summary,
    completedWork: completed.trim() || null,
    issues: issues.trim() || null,
    nextActions: next.trim() || null,
    accountSections: Object.entries(sections)
      .filter(([, notes]) => notes.trim())
      .map(([accountId, notes]) => ({ accountId, notes })),
    counts: Object.fromEntries(COUNT_FIELDS.map((f) => [f.key, counts[f.key] === '' || counts[f.key] === undefined ? null : Number(counts[f.key])])) as OfmReportVersion['counts'],
    sourceRefs: refs.filter((r) => r.label.trim().length >= 2).map((r) => ({ label: r.label.trim(), note: r.note.trim() || undefined })),
    noOpenItems,
    handoverId: handover?.id ?? null,
  });
  const handleError = (e: unknown) => {
    if (edit.catchConflict(e)) return;
    if (isApiError(e) && e.fieldErrors.length) setFieldErrors(Object.fromEntries(e.fieldErrors.map((f) => [f.field.replace(/^body\./, ''), f.message])));
    setError(errorMessage(e, 'The report could not be saved.'));
  };
  const saveDraft = async () => {
    setError(null);
    setFieldErrors({});
    try {
      const saved = await save.run({ params: { workspaceId: workspace.id, reportId: report.id }, body: body() }, { ifMatch: edit.version });
      edit.rebase(saved.currentVersion);
      setDirty(false);
      return saved;
    } catch (e) {
      handleError(e);
      return null;
    }
  };
  const countsValid = COUNT_FIELDS.every((f) => !counts[f.key] || /^\d{1,7}$/.test(counts[f.key]!));
  return (
    <form
      className="flex flex-col gap-4"
      noValidate
      onSubmit={async (e) => {
        e.preventDefault();
        if (await saveDraft()) toast.success('Draft saved');
      }}
    >
      {error ? <Banner tone="danger">{error}</Banner> : null}
      <Field label="Summary" required error={fieldErrors.summary}>
        <Textarea value={summary} onChange={(e) => touch(setSummary)(e.target.value)} rows={4} maxLength={20000} />
      </Field>
      <Field label="Completed Work">
        <Textarea value={completed} onChange={(e) => touch(setCompleted)(e.target.value)} rows={3} maxLength={20000} />
      </Field>
      <Field label="Issues">
        <Textarea value={issues} onChange={(e) => touch(setIssues)(e.target.value)} rows={2} maxLength={20000} />
      </Field>
      <Field label="Next Actions">
        <Textarea value={next} onChange={(e) => touch(setNext)(e.target.value)} rows={2} maxLength={20000} />
      </Field>
      {shift.accounts.length > 1
        ? shift.accounts.map((a) => (
            <Field key={a.account.id} label={`Notes: ${a.account.label}`}>
              <Textarea value={sections[a.account.id] ?? ''} onChange={(e) => touch(setSections)({ ...sections, [a.account.id]: e.target.value })} rows={2} maxLength={20000} />
            </Field>
          ))
        : null}
      <fieldset>
        <legend className="mb-1 text-[13px] font-[550] text-fg">Counts (Manual Report)</legend>
        <p className="mb-2 text-[12px] text-fg-2">Leave empty when unknown — empty means Not Provided, not zero.</p>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {COUNT_FIELDS.map((f) => (
            <Field key={f.key} label={f.label} error={counts[f.key] && !/^\d{1,7}$/.test(counts[f.key]!) ? 'Whole number' : undefined}>
              <Input inputMode="numeric" value={counts[f.key] ?? ''} onChange={(e) => touch(setCounts)({ ...counts, [f.key]: e.target.value.trim() })} />
            </Field>
          ))}
        </div>
      </fieldset>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-[13px] font-[550] text-fg">Source References</legend>
        {refs.map((r, i) => (
          <div key={i} className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_auto]">
            <Input aria-label={`Source ${i + 1} label`} placeholder="e.g. Platform statement 12 May" value={r.label} onChange={(e) => touch(setRefs)(refs.map((x, n) => (n === i ? { ...x, label: e.target.value } : x)))} maxLength={200} />
            <Input aria-label={`Source ${i + 1} note`} placeholder="Note" value={r.note} onChange={(e) => touch(setRefs)(refs.map((x, n) => (n === i ? { ...x, note: e.target.value } : x)))} maxLength={2000} />
            <Button size="sm" variant="ghost" onClick={() => touch(setRefs)(refs.filter((_, n) => n !== i))}>
              Remove
            </Button>
          </div>
        ))}
        {refs.length < 30 ? (
          <div>
            <Button size="sm" icon={<Plus size={14} />} onClick={() => setRefs([...refs, { label: '', note: '' }])}>
              Add Source
            </Button>
          </div>
        ) : null}
      </fieldset>
      <div className="rounded-[12px] border border-line p-3">
        <p className="mb-2 text-[13px] text-fg-2">
          {handover ? `Handover: ${label('handoverState', handover.state)} with ${handover.itemCounts.open + handover.itemCounts.accepted + handover.itemCounts.resolved} item(s). A draft handover is submitted together with the report.` : 'No handover yet. Write one below, or confirm there is nothing to hand over.'}
        </p>
        <Switch label="No Open Items" description="Confirm explicitly that nothing needs to be handed over." checked={noOpenItems} onCheckedChange={touch(setNoOpenItems)} />
        {fieldErrors.noOpenItems ? <p className="mt-1 text-[12px] text-danger">{fieldErrors.noOpenItems}</p> : null}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" loading={save.isPending && !submit.isPending} disabled={!countsValid}>
          Save Draft
        </Button>
        <Button
          variant="primary"
          disabled={!summary.trim() || !countsValid}
          loading={submit.isPending}
          onClick={async () => {
            setError(null);
            setFieldErrors({});
            const saved = dirty ? await saveDraft() : report;
            if (!saved) return;
            try {
              await submit.run(
                { params: { workspaceId: workspace.id, shiftId: shift.id }, body: { reportVersionId: saved.currentVersion.id, handoverId: handover?.id ?? null, noOpenItems } },
                { ifMatch: saved.currentVersion.rowVersion },
              );
              toast.success('Report submitted for review');
            } catch (e) {
              handleError(e);
            }
          }}
        >
          Submit Report
        </Button>
      </div>
      <ConflictDialog {...edit.conflictDialog} />
    </form>
  );
};
