'use client';
import Link from 'next/link';
import { ArrowSquareOut, ClockCounterClockwise, Copy, Export, LockSimple, ShieldCheck } from '@phosphor-icons/react';
import { auditEndpoints, type AuditEventItem } from '@castlane/api-contracts';
import { CHANGE_SOURCES, endOfLocalDayUtc, startOfLocalDayUtc } from '@castlane/domain';
import {
  Avatar,
  Badge,
  Banner,
  Button,
  DataTable,
  DateInput,
  DescriptionList,
  Drawer,
  EmptyState,
  Field,
  Input,
  MultiSelect,
  NoResults,
  PageHeader,
  Select,
  Toolbar,
  formatDateTime,
  toast,
  type Column,
} from '@castlane/ui';
import { EntitySelect } from '@/components/common/entity-select';
import { MemberSelect } from '@/components/common/pickers';
import { QueryState } from '@/components/common/query-state';
import { useApiInfinite, useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useUrlState } from '@/lib/url-state';
import { useCan, useWorkspace, useWsPath } from '@/lib/workspace-context';
import '../inbox/labels';

type Filters = 'actor' | 'action' | 'entityType' | 'entityId' | 'project' | 'from' | 'to' | 'source' | 'event';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** "project.status_changed" → "Project · Status changed". */
export const actionLabel = (action: string) => {
  const [head, ...rest] = action.split('.');
  const words = (s: string) => s.replace(/[_-]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
  return rest.length ? `${label('entityType', head)} · ${words(rest.join(' '))}` : words(action);
};

const HIDDEN = '[hidden]';

const renderValue = (v: unknown) => {
  if (v === HIDDEN)
    return (
      <span className="inline-flex items-center gap-1 text-fg-2">
        <LockSimple size={12} aria-hidden /> Hidden
      </span>
    );
  if (v === undefined || v === null || v === '') return <span className="text-fg-muted">Empty</span>;
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'string' || typeof v === 'number') return <span className="break-words">{String(v)}</span>;
  return <code className="block max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-[6px] bg-surface-2 px-2 py-1 font-mono text-[12px]">{JSON.stringify(v, null, 2)}</code>;
};

/** S69 Audit Log: immutable history within the viewer's audit scope; sensitive values masked by permission. */
export const AuditScreen = () => {
  const { workspace, user } = useWorkspace();
  const can = useCan();
  const wsPath = useWsPath();
  const { state, set, list } = useUrlState<Filters>();
  const params = { workspaceId: workspace.id };
  const zone = user.timezone;
  const entityIdValid = !state.entityId || UUID_RE.test(state.entityId);
  const query = {
    actorMembershipId: state.actor || undefined,
    action: state.action || undefined,
    entityType: state.entityType || undefined,
    entityId: state.entityId && entityIdValid ? state.entityId : undefined,
    projectId: state.project || undefined,
    from: state.from ? startOfLocalDayUtc(state.from, zone).toISOString() : undefined,
    to: state.to ? endOfLocalDayUtc(state.to, zone).toISOString() : undefined,
    source: list('source') as AuditEventItem['source'][],
  };
  const events = useApiInfinite(auditEndpoints.list, { params, query });
  const facets = useApiQuery(auditEndpoints.facets, { params }, { staleTime: 60_000 });
  const filtered = !!(state.actor || state.action || state.entityType || state.entityId || state.project || state.from || state.to || list('source').length);
  const clear = () => set({ actor: null, action: null, entityType: null, entityId: null, project: null, from: null, to: null, source: null });
  const history = !!(state.entityType && state.entityId && entityIdValid);

  const exportHref = () => {
    const prefill = new URLSearchParams();
    if (state.action) prefill.set('action', state.action);
    if (state.entityType) prefill.set('entityType', state.entityType);
    if (state.project) prefill.set('projectId', state.project);
    if (state.from) prefill.set('from', state.from);
    if (state.to) prefill.set('to', state.to);
    const qs = new URLSearchParams({ new: '1', dataset: 'audit_events' });
    if (prefill.toString()) qs.set('prefill', prefill.toString());
    return wsPath(`/exports?${qs.toString()}`);
  };

  const columns: Column<AuditEventItem>[] = [
    { key: 'time', header: 'Time', sticky: true, minWidth: 170, cell: (e) => <span className="tabular-nums">{formatDateTime(e.occurredAt, zone)}</span> },
    {
      key: 'actor',
      header: 'Actor',
      minWidth: 180,
      cell: (e) => (
        <span className="flex items-center gap-2">
          <Avatar name={e.actor.displayName} src={e.actor.avatarUrl} size={24} decorative />
          <span className="truncate">{e.actor.displayName}</span>
        </span>
      ),
    },
    {
      key: 'action',
      header: 'Action',
      minWidth: 220,
      cell: (e) => (
        <span className="flex flex-col">
          <span className="text-fg">{actionLabel(e.action)}</span>
          {e.changes.length ? <span className="text-[12px] text-fg-2">{e.changes.map((c) => label('field', c.field)).slice(0, 4).join(', ')}{e.changes.length > 4 ? '…' : ''}</span> : null}
        </span>
      ),
    },
    { key: 'object', header: 'Object', minWidth: 140, cell: (e) => (e.entityType ? label('entityType', e.entityType) : '—') },
    { key: 'source', header: 'Source', minWidth: 110, cell: (e) => label('changeSource', e.source) },
    {
      key: 'sensitivity',
      header: 'Sensitivity',
      minWidth: 120,
      cell: (e) =>
        e.sensitivity === 'normal' ? (
          <span className="text-fg-2">Normal</span>
        ) : (
          <Badge tone="warning" icon={e.masked ? <LockSimple size={12} aria-hidden /> : undefined}>
            {label('auditSensitivity', e.sensitivity)}
          </Badge>
        ),
    },
    { key: 'reason', header: 'Reason', minWidth: 200, cell: (e) => <span className="line-clamp-2 text-fg-2">{e.reason ?? '—'}</span> },
  ];

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Audit Log"
        crumbs={[{ label: 'Settings' }, { label: 'Audit Log' }]}
        description="Who changed what and when. Entries cannot be edited or deleted; values you are not allowed to see are hidden."
        actions={
          can('audit.export') && can('exports.create') ? (
            <Link href={exportHref()} className="inline-flex h-9 items-center gap-2 rounded-[8px] border border-line bg-surface px-3 text-[13px] font-semibold text-fg hover:bg-surface-2">
              <Export size={14} aria-hidden /> Export Permitted Events
            </Link>
          ) : undefined
        }
      />
      {history ? (
        <Banner
          tone="info"
          action={
            <Button size="sm" onClick={() => set({ entityType: null, entityId: null })}>
              Show All Events
            </Button>
          }
        >
          Showing the history of one {label('entityType', state.entityType).toLowerCase()} ({state.entityId?.slice(0, 8)}…), newest first.
        </Banner>
      ) : null}
      <Toolbar className="items-end">
        <Field label="Actor" className="w-full sm:w-[200px]">
          <MemberSelect value={state.actor} onChange={(v) => set({ actor: v })} clearable placeholder="Anyone" />
        </Field>
        <Field label="Action" className="w-full sm:w-[220px]">
          <Select
            value={state.action ?? null}
            onChange={(v) => set({ action: v })}
            clearable
            searchable
            placeholder="Any action"
            options={(facets.data?.actions ?? []).map((a) => ({ value: a, label: actionLabel(a), description: a }))}
          />
        </Field>
        <Field label="Object Type" className="w-full sm:w-[180px]">
          <Select value={state.entityType ?? null} onChange={(v) => set({ entityType: v })} clearable placeholder="Any type" options={(facets.data?.entityTypes ?? []).map((t) => ({ value: t, label: label('entityType', t) }))} />
        </Field>
        <Field label="Object ID" className="w-full sm:w-[200px]" error={entityIdValid ? undefined : 'Enter a full record ID.'}>
          <Input value={state.entityId ?? ''} onChange={(e) => set({ entityId: e.target.value.trim() || null })} placeholder="Record ID" spellCheck={false} />
        </Field>
        <Field label="Project" className="w-full sm:w-[200px]">
          <EntitySelect type="project" value={state.project} onChange={(v) => set({ project: v })} clearable placeholder="Any project" filters={{ includeArchived: true }} />
        </Field>
        <Field label="From" className="w-full sm:w-[150px]">
          <DateInput value={state.from ?? ''} max={state.to} onChange={(e) => set({ from: e.target.value || null })} />
        </Field>
        <Field label="To" className="w-full sm:w-[150px]">
          <DateInput value={state.to ?? ''} min={state.from} onChange={(e) => set({ to: e.target.value || null })} />
        </Field>
        <Field label="Source" className="w-full sm:w-[200px]">
          <MultiSelect value={list('source')} onChange={(v) => set({ source: v.join(',') || null })} placeholder="Any source" options={CHANGE_SOURCES.map((s) => ({ value: s, label: label('changeSource', s) }))} />
        </Field>
        {filtered ? (
          <Button variant="ghost" onClick={clear}>
            Clear Filters
          </Button>
        ) : null}
      </Toolbar>
      <p className="text-[12px] text-fg-2">Dates use your time zone ({zone}).</p>
      <QueryState query={events}>
        <DataTable
          caption="Audit events"
          rows={events.items}
          columns={columns}
          getRowId={(e) => e.id}
          density={user.density}
          onRowClick={(e) => set({ event: e.id })}
          selectedRowId={state.event ?? null}
          hasMore={events.hasNextPage}
          loadingMore={events.isFetchingNextPage}
          onLoadMore={() => void events.fetchNextPage()}
          empty={
            filtered ? (
              <NoResults onClear={clear} />
            ) : (
              <EmptyState icon={<ShieldCheck size={28} />} title="No audit events in your scope" description="Changes to records you are allowed to audit appear here as they happen." />
            )
          }
        />
      </QueryState>
      <AuditEventDrawer
        eventId={state.event ?? null}
        onClose={() => set({ event: null })}
        onHistory={(e) => set({ entityType: e.entityType, entityId: e.entityId, event: null, action: null, actor: null, project: null, from: null, to: null, source: null })}
      />
    </div>
  );
};

const AuditEventDrawer = ({ eventId, onClose, onHistory }: { eventId: string | null; onClose: () => void; onHistory: (e: AuditEventItem) => void }) => {
  const { workspace, user } = useWorkspace();
  const ev = useApiQuery(auditEndpoints.get, { params: { workspaceId: workspace.id, eventId: eventId ?? '' } }, { enabled: !!eventId });
  const e = ev.data;
  const copy = async () => {
    if (!e) return;
    try {
      await navigator.clipboard.writeText(e.id);
      toast({ kind: 'success', title: 'Event ID copied' });
    } catch {
      toast({ kind: 'error', title: 'Could not copy. Select the ID and copy it manually.' });
    }
  };
  return (
    <Drawer
      open={!!eventId}
      onOpenChange={(o) => !o && onClose()}
      title={e ? actionLabel(e.action) : 'Audit event'}
      description={e ? formatDateTime(e.occurredAt, user.timezone) : undefined}
      width={760}
      footer={
        e ? (
          <>
            <Button icon={<Copy size={14} />} onClick={() => void copy()}>
              Copy Event ID
            </Button>
            {e.entityType && e.entityId ? (
              <Button icon={<ClockCounterClockwise size={14} />} onClick={() => onHistory(e)}>
                Object History
              </Button>
            ) : null}
            {e.href ? (
              <Link href={e.href} className="inline-flex h-9 items-center gap-2 rounded-[8px] bg-primary px-3 text-[13px] font-semibold text-on-primary hover:bg-primary-hover">
                <ArrowSquareOut size={14} aria-hidden /> Open Related Object
              </Link>
            ) : null}
          </>
        ) : null
      }
    >
      <QueryState query={ev}>
        {e ? (
          <div className="flex flex-col gap-5">
            {e.masked ? <Banner tone="warning">Some values are hidden because your role does not include access to {label('auditSensitivity', e.sensitivity).toLowerCase()} data.</Banner> : null}
            <DescriptionList
              items={[
                {
                  label: 'Actor',
                  value: (
                    <span className="flex items-center gap-2">
                      <Avatar name={e.actor.displayName} src={e.actor.avatarUrl} size={24} decorative />
                      {e.actor.displayName}
                      {e.actor.kind !== 'member' ? <Badge>{label('actorKind', e.actor.kind)}</Badge> : null}
                    </span>
                  ),
                },
                { label: 'Source', value: label('changeSource', e.source) },
                { label: 'Object', value: e.entityType ? `${label('entityType', e.entityType)}${e.entityId ? ` · ${e.entityId}` : ''}` : null },
                { label: 'Action', value: <code className="font-mono text-[12px]">{e.action}</code> },
                { label: 'Reason', value: e.reason },
                { label: 'Request ID', value: e.requestId ? <code className="font-mono text-[12px]">{e.requestId}</code> : null },
                { label: 'Event ID', value: <code className="font-mono text-[12px]">{e.id}</code> },
                { label: 'Sensitivity', value: label('auditSensitivity', e.sensitivity) },
              ]}
            />
            <section className="flex flex-col gap-2">
              <h3 className="text-[14px] font-semibold text-fg">Changes</h3>
              {e.changes.length === 0 ? (
                <p className="text-[13px] text-fg-2">This event recorded no field changes.</p>
              ) : (
                <div className="overflow-x-auto rounded-[10px] border border-line">
                  <table className="w-full min-w-[520px] text-left text-[13px]">
                    <caption className="sr-only">Field changes</caption>
                    <thead className="bg-surface-2 text-[12px] text-fg-2">
                      <tr>
                        <th scope="col" className="px-3 py-2 font-[550]">Field</th>
                        <th scope="col" className="px-3 py-2 font-[550]">Before</th>
                        <th scope="col" className="px-3 py-2 font-[550]">After</th>
                      </tr>
                    </thead>
                    <tbody>
                      {e.changes.map((c) => (
                        <tr key={c.field} className="border-t border-line align-top">
                          <th scope="row" className="px-3 py-2 font-medium text-fg">{label('field', c.field)}</th>
                          <td className="px-3 py-2 text-danger/90">{renderValue(c.from)}</td>
                          <td className="px-3 py-2 text-fg">{renderValue(c.to)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
            {e.metadata && Object.keys(e.metadata).length ? (
              <section className="flex flex-col gap-2">
                <h3 className="text-[14px] font-semibold text-fg">Details</h3>
                {renderValue(e.metadata)}
              </section>
            ) : null}
          </div>
        ) : null}
      </QueryState>
    </Drawer>
  );
};
