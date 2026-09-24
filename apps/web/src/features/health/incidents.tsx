'use client';
import Link from 'next/link';
import { Plus, Siren } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import { incidentEndpoints, type IncidentItem } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { INCIDENT_SEVERITIES, INCIDENT_STATES } from '@castlane/domain';
import {
  Avatar,
  Badge,
  Banner,
  Button,
  DataTable,
  DescriptionList,
  Dialog,
  Drawer,
  EmptyState,
  Field,
  Input,
  MultiSelect,
  NoResults,
  Select,
  StatusBadge,
  Textarea,
  Toolbar,
  formatDateTime,
  type Column,
} from '@castlane/ui';
import { ConflictDialog } from '@/components/common/conflict';
import { EntitySelect } from '@/components/common/entity-select';
import { MemberSelect } from '@/components/common/pickers';
import { QueryState } from '@/components/common/query-state';
import { useDebounced } from '@/components/common/use-debounced';
import { FileUploader } from '@/components/media/file-uploader';
import { useApiInfinite, useApiMutation, useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useCan, useWorkspace, useWsPath } from '@/lib/workspace-context';

type Kind = IncidentItem['kind'];
const INVALIDATE = ['incidents.list', 'incidents.get', 'health.system'];
const severityTone: Record<string, 'neutral' | 'info' | 'warning' | 'danger'> = { low: 'neutral', medium: 'info', high: 'warning', critical: 'danger' };

/** What to check first for each monitoring alert (shown on system incidents). */
export const RUNBOOKS: Record<string, string> = {
  'backup.stale':
    'No confirmed successful backup within the freshness window. Check the backup tool logs and storage credentials, run a backup manually and confirm it reports success. A backup is only trusted after a successful restore test.',
  'queue.stalled':
    'Jobs are due but not being picked up. Check that the worker process is running and connected to the database, then look for long-running jobs holding the queue.',
  'outbox.lag':
    'Domain events are waiting to be published. Check the worker and the outbox publisher; live updates and notifications are delayed until the backlog clears.',
  'jobs.dead':
    'Background jobs exhausted their retries. Open Jobs, read the error code, fix the cause and use Retry — retries reuse the same operation key and never duplicate work.',
  'storage.quota':
    'Workspace storage is close to its quota. Delete expired exports, purge the trash or raise the quota before uploads start failing.',
};

export const SeverityBadge = ({ severity }: { severity: string }) => <Badge tone={severityTone[severity] ?? 'neutral'}>{label('severity', severity)}</Badge>;

/** Incident list for one kind with filters, Log Incident and the detail drawer (`?open=`). */
export const IncidentList = ({ kind, openId, onOpen }: { kind: Kind; openId: string | null; onOpen: (id: string | null) => void }) => {
  const { workspace, user } = useWorkspace();
  const can = useCan();
  const [states, setStates] = useState<string[]>(['open', 'investigating']);
  const [severities, setSeverities] = useState<string[]>([]);
  const [q, setQ] = useState('');
  const debounced = useDebounced(q, 250);
  const [creating, setCreating] = useState(false);
  const list = useApiInfinite(incidentEndpoints.list, {
    params: { workspaceId: workspace.id },
    query: { kind, state: states as IncidentItem['state'][], severity: severities as IncidentItem['severity'][], q: debounced || undefined },
  });
  const canWrite = kind === 'system' ? can('system.jobs.retry') && can('incidents.write') : can('incidents.write');
  const filtered = !!(debounced || severities.length || states.join() !== 'open,investigating');

  const columns: Column<IncidentItem>[] = [
    {
      key: 'title',
      header: 'Incident',
      sticky: true,
      minWidth: 260,
      cell: (i) => (
        <span className="flex flex-col">
          <span className="font-medium text-fg">{i.title}</span>
          {i.alertKey ? <span className="font-mono text-[12px] text-fg-2">{i.alertKey}</span> : i.project ? <span className="text-[12px] text-fg-2">{i.project.name}</span> : null}
        </span>
      ),
    },
    { key: 'severity', header: 'Severity', minWidth: 110, cell: (i) => <SeverityBadge severity={i.severity} /> },
    { key: 'state', header: 'State', minWidth: 130, cell: (i) => <StatusBadge status={i.state === 'resolved' ? 'completed' : i.state === 'open' ? 'blocked' : 'in_progress'} label={label('incidentState', i.state)} /> },
    {
      key: 'owner',
      header: 'Owner',
      minWidth: 170,
      cell: (i) =>
        i.owner ? (
          <span className="flex items-center gap-2">
            <Avatar name={i.owner.displayName} src={i.owner.avatarUrl} size={24} decorative />
            {i.owner.displayName}
          </span>
        ) : (
          <span className="text-fg-2">Unassigned</span>
        ),
    },
    { key: 'created', header: 'Reported', minWidth: 160, cell: (i) => formatDateTime(i.createdAt, user.timezone) },
  ];

  return (
    <div className="flex flex-col gap-4">
      <Toolbar>
        <div className="w-full sm:w-[240px]">
          <Input type="search" aria-label="Search incidents" placeholder="Search incidents" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="w-full sm:w-[220px]">
          <MultiSelect aria-label="State" placeholder="Any state" value={states} onChange={setStates} options={INCIDENT_STATES.map((s) => ({ value: s, label: label('incidentState', s) }))} />
        </div>
        <div className="w-full sm:w-[200px]">
          <MultiSelect aria-label="Severity" placeholder="Any severity" value={severities} onChange={setSeverities} options={INCIDENT_SEVERITIES.map((s) => ({ value: s, label: label('severity', s) }))} />
        </div>
        {canWrite ? (
          <Button className="ml-auto" variant="primary" icon={<Plus size={14} weight="bold" />} onClick={() => setCreating(true)}>
            Log Incident
          </Button>
        ) : null}
      </Toolbar>
      <QueryState query={list}>
        <DataTable
          caption={kind === 'system' ? 'System incidents' : 'Operational incidents'}
          rows={list.items}
          columns={columns}
          getRowId={(i) => i.id}
          density={user.density}
          onRowClick={(i) => onOpen(i.id)}
          selectedRowId={openId}
          hasMore={list.hasNextPage}
          loadingMore={list.isFetchingNextPage}
          onLoadMore={() => void list.fetchNextPage()}
          empty={
            filtered ? (
              <NoResults
                onClear={() => {
                  setQ('');
                  setSeverities([]);
                  setStates(['open', 'investigating']);
                }}
              />
            ) : (
              <EmptyState
                icon={<Siren size={28} />}
                title="No open incidents"
                description={kind === 'system' ? 'Health monitoring raises system incidents automatically when checks fail.' : 'Log an incident when something goes wrong in operations so it gets an owner and a resolution.'}
              />
            )
          }
        />
      </QueryState>
      {creating ? <CreateIncidentDrawer kind={kind} onClose={(id) => { setCreating(false); if (id) onOpen(id); }} /> : null}
    </div>
  );
};

const CreateIncidentDrawer = ({ kind, onClose }: { kind: Kind; onClose: (createdId?: string) => void }) => {
  const { workspace } = useWorkspace();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [severity, setSeverity] = useState<IncidentItem['severity']>('medium');
  const [projectId, setProjectId] = useState<string | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [owner, setOwner] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const create = useApiMutation(incidentEndpoints.create, { invalidate: INVALIDATE, silentErrors: true, successMessage: 'Incident logged' });
  const dirty = !!(title || description);
  const submit = async () => {
    setError(null);
    try {
      const r = await create.run({
        params: { workspaceId: workspace.id },
        body: { kind, title: title.trim(), description: description.trim() || null, severity, projectId, accountId, ownerMembershipId: owner },
      });
      onClose(r.id);
    } catch (e) {
      setError(isApiError(e) ? (e.fieldErrors[0]?.message ?? e.message) : 'Could not log the incident.');
    }
  };
  return (
    <Drawer
      open
      onOpenChange={(o) => !o && onClose()}
      title="Log Incident"
      description="Record what happened; add evidence files after it is logged."
      dirty={dirty}
      footer={
        <>
          <Button onClick={() => onClose()} disabled={create.isPending}>
            Cancel
          </Button>
          <Button variant="primary" loading={create.isPending} disabled={title.trim().length < 3} onClick={() => void submit()}>
            Log Incident
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <Field label="Title" required helper="What went wrong, in one line.">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
        </Field>
        <Field label="Severity" required>
          <Select value={severity} onChange={(v) => v && setSeverity(v)} options={INCIDENT_SEVERITIES.map((s) => ({ value: s, label: label('severity', s) }))} />
        </Field>
        <Field label="Description">
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={5} maxLength={4000} />
        </Field>
        {kind === 'operational' ? (
          <>
            <Field label="Project" helper="People with access to the project can see the incident.">
              <EntitySelect type="project" value={projectId} onChange={setProjectId} clearable placeholder="No project" />
            </Field>
            <Field label="Account">
              <EntitySelect type="account" value={accountId} onChange={setAccountId} clearable placeholder="No account" filters={projectId ? { projectId } : undefined} />
            </Field>
          </>
        ) : null}
        <Field label="Owner" helper="The owner is notified.">
          <MemberSelect value={owner} onChange={setOwner} clearable placeholder="Unassigned" projectId={projectId ?? undefined} permission={kind === 'operational' ? 'incidents.write' : undefined} />
        </Field>
      </div>
    </Drawer>
  );
};

type Mode = null | 'resolve' | 'reopen' | 'edit';

/** Incident detail: acknowledge, assign owner, resolve with outcome and evidence, reopen. */
export const IncidentDrawer = ({ incidentId, onClose }: { incidentId: string | null; onClose: () => void }) => {
  const { workspace, user } = useWorkspace();
  const wsPath = useWsPath();
  const params = { workspaceId: workspace.id, incidentId: incidentId ?? '' };
  const q = useApiQuery(incidentEndpoints.get, { params }, { enabled: !!incidentId });
  const i = q.data;
  const [mode, setMode] = useState<Mode>(null);
  const [owner, setOwner] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setMode(null);
    setText('');
    setError(null);
  }, [incidentId]);
  useEffect(() => setOwner(i?.owner?.membershipId ?? null), [i?.owner?.membershipId]);
  const opts = { invalidate: INVALIDATE, silentErrors: true } as const;
  const acknowledge = useApiMutation(incidentEndpoints.acknowledge, { ...opts, successMessage: 'Incident acknowledged' });
  const assign = useApiMutation(incidentEndpoints.assign, { ...opts, successMessage: 'Owner updated' });
  const resolve = useApiMutation(incidentEndpoints.resolve, { ...opts, successMessage: 'Incident resolved' });
  const reopen = useApiMutation(incidentEndpoints.reopen, { ...opts, successMessage: 'Incident reopened' });
  const update = useApiMutation(incidentEndpoints.update, { ...opts, successMessage: 'Incident updated' });
  const busy = acknowledge.isPending || assign.isPending || resolve.isPending || reopen.isPending || update.isPending;
  const guard = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      setMode(null);
      setText('');
    } catch (e) {
      if (isApiError(e) && (e.code === 'VERSION_CONFLICT' || e.status === 412)) setConflict(true);
      else setError(isApiError(e) ? (e.fieldErrors[0]?.message ?? e.message) : 'The action failed.');
    }
  };
  const can = i?.permissions.update ?? false;
  const ifMatch = i?.rowVersion;

  return (
    <Drawer
      open={!!incidentId}
      onOpenChange={(o) => !o && onClose()}
      title={i?.title ?? 'Incident'}
      description={i ? `${label('incidentKind', i.kind)} incident · reported ${formatDateTime(i.createdAt, user.timezone)}` : undefined}
      width={760}
      footer={
        i && can && mode === null ? (
          <>
            {i.state === 'open' ? (
              <Button loading={acknowledge.isPending} onClick={() => void guard(() => acknowledge.run({ params }, { ifMatch }))}>
                Acknowledge
              </Button>
            ) : null}
            {i.state !== 'resolved' ? (
              <>
                <Button onClick={() => setMode('edit')}>Edit</Button>
                <Button variant="primary" onClick={() => setMode('resolve')}>
                  Resolve
                </Button>
              </>
            ) : (
              <Button onClick={() => setMode('reopen')}>Reopen</Button>
            )}
          </>
        ) : null
      }
    >
      <QueryState query={q}>
        {i ? (
          <div className="flex flex-col gap-5">
            {error ? <Banner tone="danger">{error}</Banner> : null}
            <div className="flex flex-wrap items-center gap-2">
              <SeverityBadge severity={i.severity} />
              <StatusBadge status={i.state === 'resolved' ? 'completed' : i.state === 'open' ? 'blocked' : 'in_progress'} label={label('incidentState', i.state)} />
            </div>
            {i.alertKey && RUNBOOKS[i.alertKey] ? (
              <Banner tone="info">
                <strong className="font-semibold">Runbook: </strong>
                {RUNBOOKS[i.alertKey]}
              </Banner>
            ) : null}
            <DescriptionList
              items={[
                { label: 'Project', value: i.project ? <Link className="text-primary hover:underline" href={wsPath(`/projects/${i.project.id}`)}>{i.project.name}</Link> : null, hidden: i.kind === 'system' },
                { label: 'Account', value: i.account?.label ?? null, hidden: i.kind === 'system' },
                { label: 'Acknowledged', value: i.acknowledgedAt ? formatDateTime(i.acknowledgedAt, user.timezone) : 'Not yet' },
                { label: 'Reported By', value: i.createdBy ?? 'Health monitoring' },
                { label: 'Resolved', value: i.resolvedAt ? formatDateTime(i.resolvedAt, user.timezone) : null },
                { label: 'Related Job', value: i.jobId ? <code className="font-mono text-[12px]">{i.jobId}</code> : null, hidden: !i.jobId },
              ]}
            />
            {i.description ? (
              <section className="flex flex-col gap-1">
                <h3 className="text-[14px] font-semibold text-fg">Description</h3>
                <p className="whitespace-pre-wrap text-[14px] text-fg">{i.description}</p>
              </section>
            ) : null}
            {i.resolution ? (
              <section className="flex flex-col gap-1">
                <h3 className="text-[14px] font-semibold text-fg">Resolution</h3>
                <p className="whitespace-pre-wrap text-[14px] text-fg">{i.resolution}</p>
              </section>
            ) : null}
            <section className="flex flex-col gap-2">
              <h3 className="text-[14px] font-semibold text-fg">Owner</h3>
              {can && i.state !== 'resolved' ? (
                <div className="flex flex-wrap items-end gap-2">
                  <div className="w-full sm:w-[280px]">
                    <MemberSelect aria-describedby={undefined} value={owner} onChange={setOwner} clearable placeholder="Unassigned" projectId={i.project?.id} permission={i.kind === 'operational' ? 'incidents.write' : undefined} />
                  </div>
                  <Button disabled={owner === (i.owner?.membershipId ?? null) || busy} loading={assign.isPending} onClick={() => void guard(() => assign.run({ params, body: { ownerMembershipId: owner } }, { ifMatch }))}>
                    Assign
                  </Button>
                </div>
              ) : (
                <p className="text-[14px] text-fg">{i.owner?.displayName ?? 'Unassigned'}</p>
              )}
            </section>
            <section className="flex flex-col gap-2">
              <h3 className="text-[14px] font-semibold text-fg">Evidence</h3>
              {i.evidence.length ? (
                <ul className="flex flex-wrap gap-3">
                  {i.evidence.map((e) => (
                    <li key={e.assetId} className="flex w-[128px] flex-col gap-1">
                      {e.thumbnailUrl ? <img src={e.thumbnailUrl} alt="" className="h-[96px] w-[128px] rounded-[8px] bg-surface-2 object-cover" /> : <span className="flex h-[96px] w-[128px] items-center justify-center rounded-[8px] bg-surface-2 text-[12px] text-fg-2">File</span>}
                      <Link href={wsPath(`/library/assets/${e.assetId}`)} className="truncate text-[12px] text-fg hover:underline">
                        {e.name}
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[13px] text-fg-2">No evidence attached.</p>
              )}
              {i.hiddenEvidenceCount > 0 ? <p className="text-[12px] text-fg-2">{i.hiddenEvidenceCount} more file{i.hiddenEvidenceCount === 1 ? ' is' : 's are'} attached that you cannot open.</p> : null}
              {can && i.state !== 'resolved' ? (
                <FileUploader compact workspaceId={workspace.id} purpose="evidence" projectId={i.project?.id ?? null} target={{ entityType: 'incident', entityId: i.id, role: 'evidence' }} label="Add Evidence" onUploaded={() => void q.refetch()} />
              ) : null}
            </section>
          </div>
        ) : null}
      </QueryState>
      {i && mode === 'resolve' ? (
        <Dialog
          open
          onOpenChange={(o) => !o && setMode(null)}
          title="Resolve incident"
          description="Describe the outcome and what was done. Evidence already attached stays with the incident."
          footer={
            <>
              <Button onClick={() => setMode(null)} disabled={busy}>
                Cancel
              </Button>
              <Button variant="primary" loading={resolve.isPending} disabled={text.trim().length < 3} onClick={() => void guard(() => resolve.run({ params, body: { resolution: text.trim() } }, { ifMatch }))}>
                Resolve
              </Button>
            </>
          }
        >
          <Field label="Resolution" required>
            <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={5} maxLength={4000} />
          </Field>
        </Dialog>
      ) : null}
      {i && mode === 'reopen' ? (
        <Dialog
          open
          onOpenChange={(o) => !o && setMode(null)}
          title="Reopen incident"
          footer={
            <>
              <Button onClick={() => setMode(null)} disabled={busy}>
                Cancel
              </Button>
              <Button variant="primary" loading={reopen.isPending} disabled={text.trim().length < 3} onClick={() => void guard(() => reopen.run({ params, body: { reason: text.trim() } }, { ifMatch }))}>
                Reopen
              </Button>
            </>
          }
        >
          <Field label="Reason" required>
            <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} maxLength={500} />
          </Field>
        </Dialog>
      ) : null}
      {i && mode === 'edit' ? <EditIncidentDialog incident={i} busy={update.isPending} onCancel={() => setMode(null)} onSave={(body) => guard(() => update.run({ params, body }, { ifMatch }))} /> : null}
      <ConflictDialog
        open={conflict}
        onOpenChange={setConflict}
        onReload={() => {
          setConflict(false);
          void q.refetch();
        }}
      />
    </Drawer>
  );
};

const EditIncidentDialog = ({
  incident,
  busy,
  onCancel,
  onSave,
}: {
  incident: IncidentItem;
  busy: boolean;
  onCancel: () => void;
  onSave: (body: { title: string; description: string | null; severity: IncidentItem['severity'] }) => Promise<void>;
}) => {
  const [title, setTitle] = useState(incident.title);
  const [description, setDescription] = useState(incident.description ?? '');
  const [severity, setSeverity] = useState(incident.severity);
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onCancel()}
      title="Edit incident"
      dirty={title !== incident.title || description !== (incident.description ?? '') || severity !== incident.severity}
      footer={
        <>
          <Button onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={title.trim().length < 3} onClick={() => void onSave({ title: title.trim(), description: description.trim() || null, severity })}>
            Save Changes
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Title" required>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
        </Field>
        <Field label="Severity" required>
          <Select value={severity} onChange={(v) => v && setSeverity(v)} options={INCIDENT_SEVERITIES.map((s) => ({ value: s, label: label('severity', s) }))} />
        </Field>
        <Field label="Description">
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={5} maxLength={4000} />
        </Field>
      </div>
    </Dialog>
  );
};
