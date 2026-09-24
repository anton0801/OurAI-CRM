'use client';
import { Play, Stop, Timer as TimerIcon, Warning } from '@phosphor-icons/react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { timeEndpoints } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { LIMITS } from '@castlane/domain';
import { Banner, Button, Dialog, Field, Panel, Textarea, DateTimeInput, toast } from '@castlane/ui';
import { useApiMutation, useApiQuery } from '@/lib/hooks';
import { useCan, useWorkspace, useWsPath } from '@/lib/workspace-context';
import { formatElapsed, fromLocalInput, toLocalInput } from '../tasks/format';

const INVALIDATE = ['time.', 'myWork.', 'tasks.get', 'workload.'];

export const useCurrentTimer = () => {
  const { workspace } = useWorkspace();
  const can = useCan();
  return useApiQuery(timeEndpoints.currentTimer, { params: { workspaceId: workspace.id } }, { enabled: can('time.write.own'), staleTime: 15_000 });
};

/** Elapsed time is only displayed by the browser; the interval itself lives on the server. */
const useElapsed = (startedAt: string | null | undefined) => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!startedAt) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [startedAt]);
  return startedAt ? Math.max(0, Math.floor((now - new Date(startedAt).getTime()) / 1000)) : 0;
};

/** Stop dialog: note, and — when the timer ran too long or was forgotten — the actual end with a reason. */
export const StopTimerDialog = ({ open, onOpenChange, timerId, startedAt }: { open: boolean; onOpenChange: (o: boolean) => void; timerId: string; startedAt: string }) => {
  const { workspace, user } = useWorkspace();
  const [note, setNote] = useState('');
  const [actual, setActual] = useState('');
  const [reason, setReason] = useState('');
  const [needsEnd, setNeedsEnd] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const elapsed = useElapsed(startedAt);
  const tooLong = elapsed > 24 * 3600;
  const stop = useApiMutation(timeEndpoints.stopTimer, { invalidate: INVALIDATE, silentErrors: true, successMessage: 'Timer stopped — time entry saved' });
  useEffect(() => {
    if (open) {
      setNote('');
      setReason('');
      setError(null);
      setNeedsEnd(tooLong);
      setActual(toLocalInput(new Date().toISOString(), user.timezone));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="small"
      title="Stop timer"
      description="Stopping creates one time entry. Repeating Stop never creates a second one."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Keep Running</Button>
          <Button
            variant="primary"
            loading={stop.isPending}
            disabled={needsEnd && (!actual || reason.trim().length < 3)}
            onClick={async () => {
              setError(null);
              try {
                await stop.run({
                  params: { workspaceId: workspace.id, timerId },
                  body: { note: note.trim() || undefined, ...(needsEnd ? { endedAt: fromLocalInput(actual, user.timezone)!, reason: reason.trim() } : {}) },
                });
                onOpenChange(false);
              } catch (e) {
                if (isApiError(e) && e.fieldErrors.some((f) => f.field === 'endedAt' || f.field === 'reason')) {
                  setNeedsEnd(true);
                  setError(e.fieldErrors[0]!.message);
                } else setError(isApiError(e) ? e.message : 'The timer could not be stopped.');
              }
            }}
          >
            Stop Timer
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="font-mono text-[24px] tabular-nums text-fg">{formatElapsed(elapsed)}</p>
        {error ? <Banner tone="danger">{error}</Banner> : null}
        {tooLong ? <Banner tone="warning">This timer has run for more than 24 hours. Enter when you actually stopped — nothing is filled in automatically.</Banner> : null}
        <Field label="Note">
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={LIMITS.noteMax} className="min-h-[72px]" />
        </Field>
        {needsEnd ? (
          <>
            <Field label="Actual end" required>
              <DateTimeInput value={actual} onChange={(e) => setActual(e.target.value)} timezone={user.timezone} />
            </Field>
            <Field label="Reason" required>
              <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={LIMITS.reasonMax} className="min-h-[72px]" />
            </Field>
          </>
        ) : (
          <Button size="sm" variant="ghost" className="self-start" onClick={() => setNeedsEnd(true)}>
            I stopped working earlier
          </Button>
        )}
      </div>
    </Dialog>
  );
};

/** Start/Stop control for one task (Task Detail, My Work rows). */
export const TaskTimerControl = ({ taskId, size = 'md' }: { taskId: string; size?: 'sm' | 'md' }) => {
  const { workspace } = useWorkspace();
  const current = useCurrentTimer();
  const [stopOpen, setStopOpen] = useState(false);
  const start = useApiMutation(timeEndpoints.startTimer, { invalidate: INVALIDATE, successMessage: 'Timer started', silentErrors: true });
  const timer = current.data?.timer ?? null;
  const elapsed = useElapsed(timer?.startedAt);
  if (timer && timer.task.id === taskId)
    return (
      <>
        <Button size={size} icon={<Stop size={14} weight="fill" />} onClick={() => setStopOpen(true)} aria-label={`Stop timer, ${formatElapsed(elapsed)} elapsed`}>
          Stop Timer <span className="font-mono tabular-nums">{formatElapsed(elapsed)}</span>
        </Button>
        <StopTimerDialog open={stopOpen} onOpenChange={setStopOpen} timerId={timer.id} startedAt={timer.startedAt} />
      </>
    );
  return (
    <Button
      size={size}
      icon={<Play size={14} weight="fill" />}
      loading={start.isPending}
      onClick={async () => {
        try {
          await start.run({ params: { workspaceId: workspace.id }, body: { taskId } });
        } catch (e) {
          toast.error(isApiError(e) ? e.message : 'The timer could not be started.', timer ? `A timer is running on “${timer.task.title ?? 'another task'}”. Stop it first.` : undefined);
        }
      }}
    >
      Start Timer
    </Button>
  );
};

/** The member's running timer, with elapsed time and Stop (My Work, Time). */
export const RunningTimerPanel = () => {
  const wsPath = useWsPath();
  const current = useCurrentTimer();
  const [stopOpen, setStopOpen] = useState(false);
  const timer = current.data?.timer ?? null;
  const elapsed = useElapsed(timer?.startedAt);
  if (!timer) return null;
  return (
    <Panel title="Running timer" actions={<TimerIcon size={18} className="text-primary" aria-hidden />}>
      <div className="flex flex-col gap-2">
        <Link href={wsPath(`/tasks/${timer.task.id}`)} className="font-medium text-fg hover:underline">
          {timer.task.title ?? 'Task'}
        </Link>
        <span className="text-[12px] text-fg-2">{timer.project.name}</span>
        <span className="font-mono text-[24px] tabular-nums text-fg" aria-live="off">
          {formatElapsed(elapsed)}
        </span>
        {timer.needsReview ? (
          <p className="flex items-center gap-1 text-[12px] text-warning">
            <Warning size={14} aria-hidden /> Running for more than 12 hours. Stop it with the actual end if you forgot it.
          </p>
        ) : null}
        <Button icon={<Stop size={14} weight="fill" />} onClick={() => setStopOpen(true)}>
          Stop Timer
        </Button>
      </div>
      <StopTimerDialog open={stopOpen} onOpenChange={setStopOpen} timerId={timer.id} startedAt={timer.startedAt} />
    </Panel>
  );
};
