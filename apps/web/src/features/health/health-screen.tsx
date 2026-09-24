'use client';
import { ArrowClockwise, ClockCounterClockwise, Plus } from '@phosphor-icons/react';
import { useState, type ReactNode } from 'react';
import { healthEndpoints, type EndpointResponse } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { JOB_POOLS, JOB_STATES, zonedDateTimeToUtc } from '@castlane/domain';
import {
  Badge,
  Banner,
  Button,
  DataTable,
  DateTimeInput,
  Dialog,
  Drawer,
  EmptyState,
  Field,
  Input,
  MultiSelect,
  PageHeader,
  PermissionDenied,
  RadioGroup,
  Select,
  StatusBadge,
  Tabs,
  Textarea,
  Toolbar,
  cn,
  formatBytes,
  formatDateTime,
  formatDuration,
  formatNumber,
  formatRelative,
  type Column,
} from '@castlane/ui';
import { QueryState } from '@/components/common/query-state';
import { useApiInfinite, useApiMutation, useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useUrlState } from '@/lib/url-state';
import { useCan, useWorkspace } from '@/lib/workspace-context';
import { IncidentDrawer, IncidentList } from './incidents';
import '../inbox/labels';

type Filters = 'tab' | 'open' | 'jobState' | 'pool' | 'mail';
type SystemHealth = EndpointResponse<typeof healthEndpoints.system>;
type JobRow = EndpointResponse<typeof healthEndpoints.jobs>['items'][number];
type MailRow = EndpointResponse<typeof healthEndpoints.mail>['items'][number];
type BackupRow = EndpointResponse<typeof healthEndpoints.backups>[number];

/** S71 Incidents & System Health: operational incidents for managers, technical health for administrators. */
export const HealthScreen = () => {
  const can = useCan();
  const { state, set } = useUrlState<Filters>();
  const incidents = can(['incidents.read', 'incidents.write']);
  const system = can('system.jobs.read');
  const backups = can('backups.status.read');
  const tabs = [
    { value: 'incidents', label: 'Incidents', hidden: !incidents },
    { value: 'system', label: 'System Health', hidden: !system },
    { value: 'jobs', label: 'Jobs', hidden: !system },
    { value: 'mail', label: 'Mail Delivery', hidden: !system },
    { value: 'backups', label: 'Backups', hidden: !backups },
  ];
  const visible = tabs.filter((t) => !t.hidden);
  const tab = visible.find((t) => t.value === state.tab)?.value ?? visible[0]?.value;
  if (!tab) return <PermissionDenied description="Incidents and system health are available to managers and administrators." />;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Incidents & Health" description="Operational incidents with owners and resolutions, plus the technical health of background jobs, mail, storage and backups." />
      <Tabs label="Health sections" value={tab} onValueChange={(v) => set({ tab: v === visible[0]?.value ? null : v, jobState: null, pool: null, mail: null })} items={tabs} />
      {tab === 'incidents' ? <IncidentList kind="operational" openId={state.open ?? null} onOpen={(id) => set({ open: id })} /> : null}
      {tab === 'system' ? <SystemTab openId={state.open ?? null} onOpen={(id) => set({ open: id })} onGo={(patch) => set(patch)} /> : null}
      {tab === 'jobs' ? <JobsTab /> : null}
      {tab === 'mail' ? <MailTab /> : null}
      {tab === 'backups' ? <BackupsTab /> : null}
      <IncidentDrawer incidentId={state.open ?? null} onClose={() => set({ open: null })} />
    </div>
  );
};

const Card = ({ title, tone = 'neutral', status, children, action }: { title: string; tone?: 'neutral' | 'success' | 'warning' | 'danger'; status: string; children: ReactNode; action?: ReactNode }) => (
  <section className="flex min-w-0 flex-col gap-2 rounded-[12px] border border-line bg-surface p-4">
    <div className="flex items-center justify-between gap-2">
      <h2 className="text-[14px] font-semibold text-fg">{title}</h2>
      <Badge tone={tone}>{status}</Badge>
    </div>
    <div className="flex flex-col gap-1 text-[13px] text-fg-2">{children}</div>
    {action ? <div className="mt-auto pt-1">{action}</div> : null}
  </section>
);

/** Backup health is separate from restore verification: a backup is trusted only after a successful restore test. */
export const backupSummary = (b: SystemHealth['backup'], zone: string) => {
  const restore = b.lastRestoreTestAt ? `Last restore test: ${formatDateTime(b.lastRestoreTestAt, zone)}${b.lastRestoreResult === 'failed' ? ' (failed)' : ''}.` : 'No restore test recorded yet.';
  if (!b.lastSuccessAt) return { status: 'No Backup', tone: 'danger' as const, text: `No successful backup has been reported. ${restore}` };
  const done = `Backup completed ${formatDateTime(b.lastSuccessAt, zone)}.`;
  if (!b.healthy) return { status: 'Stale', tone: 'danger' as const, text: `${done} It is older than ${b.freshnessHours} hours. ${restore}` };
  if (!b.lastRestoreTestAt || b.lastRestoreResult !== 'succeeded') return { status: 'Restore Untested', tone: 'warning' as const, text: `${done} ${restore}` };
  return { status: 'Healthy', tone: 'success' as const, text: `${done} ${restore}` };
};

const SystemTab = ({ openId, onOpen, onGo }: { openId: string | null; onOpen: (id: string | null) => void; onGo: (patch: Partial<Record<Filters, string | null>>) => void }) => {
  const { workspace, user } = useWorkspace();
  const h = useApiQuery(healthEndpoints.system, { params: { workspaceId: workspace.id } }, { refetchInterval: 60_000 });
  const d = h.data;
  return (
    <div className="flex flex-col gap-6">
      <QueryState query={h}>
        {d ? (
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[12px] text-fg-2">Checked {formatRelative(d.asOf)} · refreshes every minute</p>
              <Button size="sm" variant="ghost" icon={<ArrowClockwise size={14} />} onClick={() => void h.refetch()} loading={h.isFetching}>
                Refresh
              </Button>
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {(() => {
                const b = backupSummary(d.backup, user.timezone);
                return (
                  <Card title="Backups" status={b.status} tone={b.tone} action={<Button size="sm" variant="ghost" onClick={() => onGo({ tab: 'backups' })}>View Backups</Button>}>
                    <p className="text-fg">{b.text}</p>
                    {d.backup.lastRunStatus === 'failed' ? <p className="text-danger">The most recent backup run failed.</p> : null}
                  </Card>
                );
              })()}
              <Card
                title="Background Jobs"
                status={d.deadLettered ? `${d.deadLettered} dead-lettered` : 'Running'}
                tone={d.deadLettered ? 'danger' : 'success'}
                action={
                  <Button size="sm" variant="ghost" onClick={() => onGo({ tab: 'jobs', jobState: d.deadLettered ? 'dead' : null })}>
                    {d.deadLettered ? 'Review Dead Jobs' : 'View Jobs'}
                  </Button>
                }
              >
                <QueueTable jobs={d.jobs} />
                <p>{d.oldestDueJobAt ? `Oldest waiting job due ${formatRelative(d.oldestDueJobAt)}.` : 'No jobs are waiting.'}</p>
              </Card>
              <Card title="Event Outbox" status={d.outbox.pending ? `${d.outbox.pending} pending` : 'Up to date'} tone={(d.outbox.lagSeconds ?? 0) > 300 ? 'warning' : 'success'}>
                <p>{d.outbox.lagSeconds !== null ? `Oldest unpublished event is ${formatDuration(d.outbox.lagSeconds)} old.` : 'All events are published; live updates are current.'}</p>
              </Card>
              <Card
                title="Mail Delivery"
                status={d.mail.failedLast24h ? `${d.mail.failedLast24h} failed` : 'Delivering'}
                tone={d.mail.failedLast24h ? 'warning' : 'success'}
                action={<Button size="sm" variant="ghost" onClick={() => onGo({ tab: 'mail', mail: d.mail.failedLast24h ? 'failed' : null })}>View Mail</Button>}
              >
                <p>
                  Transport: {d.mail.transport}. Last 24 hours: {formatNumber(d.mail.sentLast24h)} sent, {formatNumber(d.mail.failedLast24h)} failed.
                </p>
                {d.mail.lastFailureAt ? <p>Last failure {formatDateTime(d.mail.lastFailureAt, user.timezone)}.</p> : null}
              </Card>
              <Card title="File Storage" status={d.storage.ok ? 'Reachable' : 'Unreachable'} tone={!d.storage.ok ? 'danger' : Number(d.storage.usedPercent ?? 0) >= 90 ? 'warning' : 'success'}>
                <p>
                  {formatBytes(Number(d.storage.usedBytes))} used of {formatBytes(Number(d.storage.quotaBytes))}
                  {d.storage.usedPercent ? ` (${d.storage.usedPercent}%)` : ''}; {formatBytes(Number(d.storage.reservedBytes))} reserved by uploads in progress.
                </p>
                <p>
                  File scanning: {d.scanner.mode} — {d.scanner.ok ? 'working' : 'not responding; new uploads wait in quarantine'}.
                </p>
              </Card>
              <Card title="System Incidents" status={d.openSystemIncidents ? `${d.openSystemIncidents} open` : 'None open'} tone={d.openSystemIncidents ? 'warning' : 'success'}>
                <p>Raised automatically by health monitoring (every 5 minutes) when a check fails; each has a runbook.</p>
              </Card>
            </div>
          </div>
        ) : null}
      </QueryState>
      <section className="flex flex-col gap-3">
        <h2 className="text-[18px] font-[650] text-fg">System Incidents</h2>
        <IncidentList kind="system" openId={openId} onOpen={onOpen} />
      </section>
    </div>
  );
};

const QueueTable = ({ jobs }: { jobs: SystemHealth['jobs'] }) => {
  const states = ['queued', 'running', 'failed', 'dead'] as const;
  const count = (pool: string, st: string) => jobs.find((j) => j.pool === pool && j.state === st)?.count ?? 0;
  return (
    <table className="w-full text-[12px]">
      <caption className="sr-only">Jobs by pool and state</caption>
      <thead>
        <tr className="text-fg-2">
          <th scope="col" className="py-1 text-left font-[550]">Pool</th>
          {states.map((s) => (
            <th key={s} scope="col" className="py-1 text-right font-[550]">
              {label('jobState', s)}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {JOB_POOLS.map((p) => (
          <tr key={p} className="border-t border-line">
            <th scope="row" className="py-1 text-left font-medium text-fg">{label('jobPool', p)}</th>
            {states.map((s) => (
              <td key={s} className={cn('py-1 text-right tabular-nums', s === 'dead' && count(p, s) ? 'font-semibold text-danger' : 'text-fg')}>
                {count(p, s)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
};

const JobsTab = () => {
  const { workspace, user } = useWorkspace();
  const can = useCan();
  const { state, set } = useUrlState<Filters>();
  const states = state.jobState ? state.jobState.split(',') : ['dead', 'failed'];
  const params = { workspaceId: workspace.id };
  const jobs = useApiInfinite(healthEndpoints.jobs, { params, query: { state: states as JobRow['state'][], pool: (state.pool as JobRow['pool']) || undefined } });
  const [action, setAction] = useState<{ job: JobRow; kind: 'retry' | 'cancel' } | null>(null);
  const columns: Column<JobRow>[] = [
    {
      key: 'type',
      header: 'Job',
      sticky: true,
      minWidth: 220,
      cell: (j) => (
        <span className="flex flex-col">
          <span className="font-mono text-[13px] text-fg">{j.type}</span>
          <span className="text-[12px] text-fg-2">{label('jobPool', j.pool)} pool</span>
        </span>
      ),
    },
    { key: 'state', header: 'State', minWidth: 130, cell: (j) => <StatusBadge status={j.state === 'dead' || j.state === 'failed' ? 'blocked' : j.state === 'succeeded' ? 'completed' : j.state === 'running' ? 'in_progress' : 'draft'} label={label('jobState', j.state)} /> },
    { key: 'attempts', header: 'Attempts', align: 'right', minWidth: 90, cell: (j) => `${j.attempts} / ${j.maxRetries + 1}` },
    {
      key: 'error',
      header: 'Last Error',
      minWidth: 260,
      cell: (j) =>
        j.lastErrorCode || j.lastErrorMessage ? (
          <span className="flex flex-col">
            {j.lastErrorCode ? <code className="font-mono text-[12px] text-danger">{j.lastErrorCode}</code> : null}
            {j.lastErrorMessage ? <span className="line-clamp-2 text-[12px] text-fg-2">{j.lastErrorMessage}</span> : null}
          </span>
        ) : (
          '—'
        ),
    },
    { key: 'runAt', header: 'Run At', minWidth: 160, cell: (j) => formatDateTime(j.runAt, user.timezone) },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      minWidth: 170,
      cell: (j) =>
        can('system.jobs.retry') ? (
          <span className="flex justify-end gap-1">
            {j.canRetry ? (
              <Button size="sm" icon={<ClockCounterClockwise size={14} />} onClick={() => setAction({ job: j, kind: 'retry' })}>
                Retry
              </Button>
            ) : null}
            {j.canCancel ? (
              <Button size="sm" variant="ghost" onClick={() => setAction({ job: j, kind: 'cancel' })}>
                Cancel
              </Button>
            ) : null}
          </span>
        ) : null,
    },
  ];
  return (
    <div className="flex flex-col gap-4">
      <Toolbar>
        <div className="w-full sm:w-[280px]">
          <MultiSelect aria-label="Job state" placeholder="Any state" value={states} onChange={(v) => set({ jobState: v.join(',') || null })} options={JOB_STATES.map((s) => ({ value: s, label: label('jobState', s) }))} />
        </div>
        <div className="w-full sm:w-[180px]">
          <Select aria-label="Pool" value={state.pool ?? null} onChange={(v) => set({ pool: v })} clearable placeholder="All pools" options={JOB_POOLS.map((p) => ({ value: p, label: label('jobPool', p) }))} />
        </div>
      </Toolbar>
      <p className="text-[12px] text-fg-2">Retry reuses the job’s operation key, so the work is never duplicated; the job checks permissions again when it runs.</p>
      <QueryState query={jobs}>
        <DataTable
          caption="Background jobs"
          rows={jobs.items}
          columns={columns}
          getRowId={(j) => j.id}
          density={user.density}
          hasMore={jobs.hasNextPage}
          loadingMore={jobs.isFetchingNextPage}
          onLoadMore={() => void jobs.fetchNextPage()}
          empty={<EmptyState title="No jobs in these states" description="Dead-lettered and failed jobs appear here with their error code." />}
        />
      </QueryState>
      {action ? <JobActionDialog job={action.job} kind={action.kind} onClose={() => setAction(null)} /> : null}
    </div>
  );
};

const JobActionDialog = ({ job, kind, onClose }: { job: JobRow; kind: 'retry' | 'cancel'; onClose: () => void }) => {
  const { workspace } = useWorkspace();
  const [reason, setReason] = useState('');
  const opts = { invalidate: ['health.jobs', 'health.system'], silentErrors: true };
  const retry = useApiMutation(healthEndpoints.retryJob, { ...opts, successMessage: 'Job queued again' });
  const cancel = useApiMutation(healthEndpoints.cancelJob, { ...opts, successMessage: 'Cancellation requested' });
  const m = kind === 'retry' ? retry : cancel;
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setError(null);
    try {
      await m.run({ params: { workspaceId: workspace.id, jobId: job.id }, body: { reason: reason.trim() || undefined } });
      onClose();
    } catch (e) {
      setError(isApiError(e) ? e.message : 'The action failed.');
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="small"
      title={kind === 'retry' ? 'Retry this job?' : 'Cancel this job?'}
      description={kind === 'retry' ? `${job.type} runs again with the same operation key.` : `${job.type} stops at its next safe point; partial output is discarded.`}
      footer={
        <>
          <Button onClick={onClose} disabled={m.isPending}>
            Back
          </Button>
          <Button variant={kind === 'retry' ? 'primary' : 'danger'} loading={m.isPending} onClick={() => void submit()}>
            {kind === 'retry' ? 'Retry Job' : 'Cancel Job'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <Field label="Reason" helper="Recorded in the audit log.">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
        </Field>
      </div>
    </Dialog>
  );
};

const MailTab = () => {
  const { workspace, user } = useWorkspace();
  const { state, set } = useUrlState<Filters>();
  const status = (state.mail as MailRow['status'] | undefined) ?? undefined;
  const mail = useApiInfinite(healthEndpoints.mail, { params: { workspaceId: workspace.id }, query: { status } });
  const columns: Column<MailRow>[] = [
    { key: 'subject', header: 'Subject', sticky: true, minWidth: 240, cell: (m) => <span className="flex flex-col"><span className="text-fg">{m.subject}</span><span className="text-[12px] text-fg-2">{m.template}</span></span> },
    { key: 'to', header: 'Recipient', minWidth: 200, cell: (m) => m.to },
    { key: 'status', header: 'Status', minWidth: 110, cell: (m) => <StatusBadge status={m.status === 'failed' ? 'blocked' : m.status === 'sent' ? 'completed' : 'draft'} label={label('mailStatus', m.status)} /> },
    { key: 'attempts', header: 'Attempts', align: 'right', minWidth: 90, cell: (m) => m.attempts },
    { key: 'error', header: 'Error', minWidth: 220, cell: (m) => (m.error ? <span className="line-clamp-2 text-[12px] text-danger">{m.error}</span> : '—') },
    { key: 'created', header: 'Queued', minWidth: 160, cell: (m) => formatDateTime(m.createdAt, user.timezone) },
    { key: 'sent', header: 'Sent', minWidth: 160, cell: (m) => (m.sentAt ? formatDateTime(m.sentAt, user.timezone) : '—') },
  ];
  return (
    <div className="flex flex-col gap-4">
      <Toolbar>
        <div className="w-full sm:w-[180px]">
          <Select aria-label="Delivery status" value={status ?? null} onChange={(v) => set({ mail: v })} clearable placeholder="Any status" options={(['queued', 'sent', 'failed'] as const).map((s) => ({ value: s, label: label('mailStatus', s) }))} />
        </div>
      </Toolbar>
      <p className="text-[12px] text-fg-2">Only subjects and delivery status are shown; message bodies are never stored here.</p>
      <QueryState query={mail}>
        <DataTable
          caption="Mail delivery"
          rows={mail.items}
          columns={columns}
          getRowId={(m) => m.id}
          density={user.density}
          hasMore={mail.hasNextPage}
          loadingMore={mail.isFetchingNextPage}
          onLoadMore={() => void mail.fetchNextPage()}
          empty={<EmptyState title="No mail in this view" description="Invitations, password resets, digests and alerts appear here with their delivery status." />}
        />
      </QueryState>
    </div>
  );
};

const BackupsTab = () => {
  const { workspace, user } = useWorkspace();
  const [kind, setKind] = useState<'all' | 'backup' | 'restore_drill'>('all');
  const [recording, setRecording] = useState(false);
  const runs = useApiQuery(healthEndpoints.backups, { params: { workspaceId: workspace.id }, query: { kind: kind === 'all' ? undefined : kind } });
  const columns: Column<BackupRow>[] = [
    { key: 'kind', header: 'Run', sticky: true, minWidth: 140, cell: (r) => (r.kind === 'backup' ? 'Backup' : 'Restore test') },
    { key: 'status', header: 'Status', minWidth: 120, cell: (r) => <StatusBadge status={r.status === 'failed' ? 'blocked' : r.status === 'succeeded' ? 'completed' : 'in_progress'} label={label('backupStatus', r.status)} /> },
    { key: 'started', header: 'Started', minWidth: 160, cell: (r) => formatDateTime(r.startedAt, user.timezone) },
    { key: 'duration', header: 'Duration', align: 'right', minWidth: 100, cell: (r) => (r.durationSeconds !== null ? formatDuration(r.durationSeconds) : '—') },
    { key: 'recovered', header: 'Recovered To', minWidth: 160, cell: (r) => (r.recoveredTimestamp ? formatDateTime(r.recoveredTimestamp, user.timezone) : '—') },
    {
      key: 'details',
      header: 'Details',
      minWidth: 240,
      cell: (r) => {
        const d = r.details as { missingObjects?: number; verifiedCounts?: string; notes?: string; sizeBytes?: number };
        const parts = [
          typeof d.missingObjects === 'number' ? `${d.missingObjects} missing object${d.missingObjects === 1 ? '' : 's'}` : null,
          d.verifiedCounts ? `Verified: ${d.verifiedCounts}` : null,
          typeof d.sizeBytes === 'number' ? formatBytes(d.sizeBytes) : null,
          d.notes ?? null,
        ].filter(Boolean);
        return parts.length ? <span className="line-clamp-2 text-[12px] text-fg-2">{parts.join(' · ')}</span> : '—';
      },
    },
    { key: 'by', header: 'Reported By', minWidth: 140, cell: (r) => r.reportedBy },
  ];
  return (
    <div className="flex flex-col gap-4">
      <Toolbar>
        <RadioGroup
          label="Run type"
          orientation="horizontal"
          value={kind}
          onValueChange={setKind}
          options={[
            { value: 'all', label: 'All' },
            { value: 'backup', label: 'Backups' },
            { value: 'restore_drill', label: 'Restore tests' },
          ]}
        />
        <Button className="ml-auto" variant="primary" icon={<Plus size={14} weight="bold" />} onClick={() => setRecording(true)}>
          Record Restore Test
        </Button>
      </Toolbar>
      <Banner tone="info">A backup counts as healthy only when it succeeded within the freshness window; it is proven only by a successful restore test. Record every restore drill here.</Banner>
      <QueryState query={runs}>
        <DataTable
          caption="Backup runs and restore tests"
          rows={runs.data ?? []}
          columns={columns}
          getRowId={(r) => r.id}
          density={user.density}
          empty={<EmptyState title="No runs reported" description="The backup tooling reports each run here. Restore tests are recorded by an administrator." />}
        />
      </QueryState>
      {recording ? <RestoreDrillDrawer onClose={() => setRecording(false)} /> : null}
    </div>
  );
};

const toUtcIso = (local: string, zone: string) => {
  const [d, t] = local.split('T');
  return d && t ? zonedDateTimeToUtc(d, t.slice(0, 5), zone).utc.toISOString() : null;
};

const RestoreDrillDrawer = ({ onClose }: { onClose: () => void }) => {
  const { workspace, user } = useWorkspace();
  const zone = user.timezone;
  const [status, setStatus] = useState<'succeeded' | 'failed'>('succeeded');
  const [startedAt, setStartedAt] = useState('');
  const [finishedAt, setFinishedAt] = useState('');
  const [recovered, setRecovered] = useState('');
  const [missing, setMissing] = useState('0');
  const [verified, setVerified] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const record = useApiMutation(healthEndpoints.recordRestoreDrill, { invalidate: ['health.backups', 'health.system'], silentErrors: true, successMessage: 'Restore test recorded' });
  const start = toUtcIso(startedAt, zone);
  const end = toUtcIso(finishedAt, zone);
  const orderError = start && end && end < start ? 'The finish time must be after the start time.' : null;
  const valid = !!start && !!end && !orderError && verified.trim().length > 0 && /^\d+$/.test(missing);
  const submit = async () => {
    if (!valid) return;
    setError(null);
    try {
      await record.run({
        params: { workspaceId: workspace.id },
        body: { status, startedAt: start!, finishedAt: end!, recoveredTimestamp: recovered ? toUtcIso(recovered, zone) : null, missingObjects: Number(missing), verifiedCounts: verified.trim(), notes: notes.trim() || undefined },
      });
      onClose();
    } catch (e) {
      setError(isApiError(e) ? (e.fieldErrors[0]?.message ?? e.message) : 'Could not record the restore test.');
    }
  };
  return (
    <Drawer
      open
      onOpenChange={(o) => !o && onClose()}
      title="Record Restore Test"
      description="Results of restoring a backup into an isolated environment."
      dirty={!!(startedAt || verified || notes)}
      footer={
        <>
          <Button onClick={onClose} disabled={record.isPending}>
            Cancel
          </Button>
          <Button variant="primary" loading={record.isPending} disabled={!valid} onClick={() => void submit()}>
            Record Result
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <RadioGroup
          label="Result"
          value={status}
          onValueChange={setStatus}
          options={[
            { value: 'succeeded', label: 'Restore succeeded', description: 'Data was restored and verified.' },
            { value: 'failed', label: 'Restore failed', description: 'The backup could not be restored or verification failed.' },
          ]}
        />
        <Field label="Started" required>
          <DateTimeInput timezone={zone} value={startedAt} onChange={(e) => setStartedAt(e.target.value)} />
        </Field>
        <Field label="Finished" required error={orderError ?? undefined}>
          <DateTimeInput timezone={zone} value={finishedAt} onChange={(e) => setFinishedAt(e.target.value)} />
        </Field>
        <Field label="Recovered To" helper="The latest moment whose data was present after the restore.">
          <DateTimeInput timezone={zone} value={recovered} onChange={(e) => setRecovered(e.target.value)} />
        </Field>
        <Field label="Missing Objects" required helper="Files referenced by the database but missing from storage.">
          <Input inputMode="numeric" value={missing} onChange={(e) => setMissing(e.target.value.replace(/[^\d]/g, ''))} />
        </Field>
        <Field label="Verified Counts" required helper="For example: projects 120/120, assets 5,410/5,410, audit events match.">
          <Textarea value={verified} onChange={(e) => setVerified(e.target.value)} rows={3} maxLength={2000} />
        </Field>
        <Field label="Notes">
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} maxLength={4000} />
        </Field>
      </div>
    </Drawer>
  );
};
