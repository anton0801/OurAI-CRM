'use client';
import Link from 'next/link';
import { Archive, ArrowCounterClockwise, Trash, WarningCircle } from '@phosphor-icons/react';
import { useEffect, useMemo, useState } from 'react';
import { archiveEndpoints, type ArchiveItem, type EntityPreview, type EntityRef } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import {
  Avatar,
  Badge,
  Banner,
  Button,
  DataTable,
  Dialog,
  EmptyState,
  Input,
  Menu,
  NoResults,
  PageHeader,
  RadioGroup,
  Select,
  StatusBadge,
  Tabs,
  Toolbar,
  formatDate,
  formatDateTime,
  toast,
  type Column,
  type SelectionState,
} from '@castlane/ui';
import { EntitySelect } from '@/components/common/entity-select';
import { QueryState } from '@/components/common/query-state';
import { useDebounced } from '@/components/common/use-debounced';
import { useApiInfinite, useApiMutation, useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useUrlState } from '@/lib/url-state';
import { useCan, useWorkspace } from '@/lib/workspace-context';
import { ReauthForm, isRecentAuthError } from './reauth';
import '../inbox/labels';

type Filters = 'tab' | 'type' | 'q' | 'project';
type View = 'archived' | 'trash';

const rowKey = (i: { entityType: string; entityId: string }) => `${i.entityType}:${i.entityId}`;
const EMPTY: SelectionState = { ids: new Set(), allMatching: false };
const INVALIDATE = ['archive.list'];

/** S70 Archive / Trash: archived records per type, trash with a grace period, restore preview and owner-only purge. */
export const ArchiveScreen = () => {
  const { workspace, user } = useWorkspace();
  const can = useCan();
  const { state, set } = useUrlState<Filters>();
  const view: View = state.tab === 'trash' ? 'trash' : 'archived';
  const params = { workspaceId: workspace.id };
  const [q, setQ] = useState(state.q ?? '');
  const debounced = useDebounced(q, 250);
  const types = useApiQuery(archiveEndpoints.types, { params }, { staleTime: 60_000 });
  const items = useApiInfinite(archiveEndpoints.list, { params, query: { state: view, entityType: state.type || undefined, q: debounced || undefined, projectId: state.project || undefined } });
  const [selection, setSelection] = useState<SelectionState>(EMPTY);
  const [restoreTargets, setRestoreTargets] = useState<EntityRef[] | null>(null);
  const [purgeTargets, setPurgeTargets] = useState<EntityRef[] | null>(null);
  const filtered = !!(state.type || debounced || state.project);

  const byKey = useMemo(() => new Map(items.items.map((i) => [rowKey(i), i])), [items.items]);
  const selected = [...selection.ids].map((k) => byKey.get(k)).filter((x): x is ArchiveItem => !!x);
  const toRefs = (list: ArchiveItem[]): EntityRef[] => list.map((i) => ({ entityType: i.entityType, entityId: i.entityId, state: i.state }));
  const changeView = (v: string) => {
    setSelection(EMPTY);
    set({ tab: v === 'trash' ? 'trash' : null });
  };
  const onSelectionChange = (s: SelectionState) => {
    if (s.allMatching) {
      // Actions work on at most 200 records at a time: select what is loaded and say so.
      const ids = new Set(items.items.slice(0, 200).map(rowKey));
      setSelection({ ids, allMatching: false });
      toast({ kind: 'info', title: `Selected ${ids.size} loaded record${ids.size === 1 ? '' : 's'}`, description: 'Load more rows to include others (up to 200 per action).' });
    } else setSelection(s);
  };
  const typeOptions = (types.data ?? []).filter((t) => t.listable && (view === 'archived' || t.trash)).map((t) => ({ value: t.entityType, label: t.label }));

  const columns: Column<ArchiveItem>[] = [
    {
      key: 'title',
      header: 'Record',
      sticky: true,
      minWidth: 240,
      cell: (i) => (
        <span className="flex items-center gap-3">
          {i.thumbnailUrl ? <img src={i.thumbnailUrl} alt="" className="h-8 w-8 shrink-0 rounded-[6px] object-cover" /> : null}
          <span className="flex min-w-0 flex-col">
            {i.href ? (
              <Link href={i.href} className="truncate font-medium text-fg hover:underline" onClick={(e) => e.stopPropagation()}>
                {i.title}
              </Link>
            ) : (
              <span className="truncate font-medium text-fg">{i.title}</span>
            )}
            <span className="text-[12px] text-fg-2">{i.typeLabel}</span>
          </span>
        </span>
      ),
    },
    {
      key: 'by',
      header: view === 'trash' ? 'Deleted By' : 'Archived By',
      minWidth: 170,
      cell: (i) =>
        i.by ? (
          <span className="flex items-center gap-2">
            <Avatar name={i.by.displayName} src={i.by.avatarUrl} size={24} decorative />
            {i.by.displayName}
          </span>
        ) : (
          <span className="text-fg-2">System</span>
        ),
    },
    { key: 'at', header: view === 'trash' ? 'Deleted' : 'Archived', minWidth: 160, cell: (i) => formatDateTime(i.at, user.timezone) },
    { key: 'reason', header: 'Reason', minWidth: 200, cell: (i) => <span className="line-clamp-2 text-fg-2">{i.reason ?? '—'}</span> },
    {
      key: 'purge',
      header: 'Deleted Permanently',
      minWidth: 170,
      hidden: view !== 'trash',
      cell: (i) => (i.purgeAfter ? <span title={formatDateTime(i.purgeAfter, user.timezone)}>After {formatDate(i.purgeAfter, user.timezone)}</span> : <Badge>Kept</Badge>),
    },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      minWidth: 130,
      cell: (i) => (
        <span className="flex justify-end gap-1">
          {i.canRestore ? (
            <Button size="sm" icon={<ArrowCounterClockwise size={14} />} onClick={() => setRestoreTargets(toRefs([i]))}>
              Restore
            </Button>
          ) : null}
          {i.canPurge ? (
            <Menu
              label={`More actions for ${i.title}`}
              trigger={
                <Button size="sm" variant="ghost">
                  More
                </Button>
              }
              items={[{ label: 'Permanently Delete', destructive: true, onSelect: () => setPurgeTargets(toRefs([i])) }]}
            />
          ) : null}
        </span>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Archive & Trash"
        description="Archived records keep their history and can be restored. Deleted drafts stay in the trash for 30 days before they are removed permanently. Finance records and audit history are never deleted."
      />
      <Tabs
        label="Archive views"
        value={view}
        onValueChange={changeView}
        items={[
          { value: 'archived', label: 'Archived' },
          { value: 'trash', label: 'Trash' },
        ]}
      />
      <Toolbar>
        <div className="w-full sm:w-[260px]">
          <Input type="search" aria-label="Search by name" placeholder="Search by name" value={q} onChange={(e) => {
            setQ(e.target.value);
            set({ q: e.target.value || null });
          }} />
        </div>
        <div className="w-full sm:w-[200px]">
          <Select aria-label="Record type" value={state.type ?? null} onChange={(v) => set({ type: v })} clearable placeholder="All types" options={typeOptions} />
        </div>
        <div className="w-full sm:w-[220px]">
          <EntitySelect type="project" aria-label="Project" value={state.project} onChange={(v) => set({ project: v })} clearable placeholder="Any project" filters={{ includeArchived: true }} />
        </div>
        {selected.length ? (
          <div className="ml-auto flex flex-wrap gap-2">
            {selected.some((i) => i.canRestore) ? (
              <Button icon={<ArrowCounterClockwise size={14} />} onClick={() => setRestoreTargets(toRefs(selected.filter((i) => i.canRestore)))}>
                Restore Selected
              </Button>
            ) : null}
            {view === 'trash' && can('trash.purge') && selected.some((i) => i.canPurge) ? (
              <Button variant="danger-secondary" icon={<Trash size={14} />} onClick={() => setPurgeTargets(toRefs(selected.filter((i) => i.canPurge)))}>
                Permanently Delete
              </Button>
            ) : null}
          </div>
        ) : null}
      </Toolbar>
      <QueryState query={items}>
        <DataTable
          caption={view === 'trash' ? 'Trash' : 'Archived records'}
          rows={items.items}
          columns={columns}
          getRowId={rowKey}
          density={user.density}
          selection={selection}
          onSelectionChange={onSelectionChange}
          hasMore={items.hasNextPage}
          loadingMore={items.isFetchingNextPage}
          onLoadMore={() => void items.fetchNextPage()}
          empty={
            filtered ? (
              <NoResults
                onClear={() => {
                  setQ('');
                  set({ type: null, q: null, project: null });
                }}
              />
            ) : view === 'trash' ? (
              <EmptyState icon={<Trash size={28} />} title="Trash is empty" description="Deleted drafts you can read appear here for 30 days. You can restore them until then." />
            ) : (
              <EmptyState icon={<Archive size={28} />} title="Nothing archived" description="Archived records you can read appear here with who archived them and why." />
            )
          }
        />
      </QueryState>
      {restoreTargets ? (
        <RestoreDialog
          targets={restoreTargets}
          onClose={(done) => {
            setRestoreTargets(null);
            if (done) setSelection(EMPTY);
          }}
        />
      ) : null}
      {purgeTargets ? (
        <PurgeDialog
          targets={purgeTargets}
          onClose={(done) => {
            setPurgeTargets(null);
            if (done) setSelection(EMPTY);
          }}
        />
      ) : null}
    </div>
  );
};

const previewStatusLabel: Record<string, string> = { ok: 'Ready', blocked: 'Blocked', forbidden: 'Not allowed', not_found: 'Not found', not_supported: 'Not supported' };
const previewStatusTone: Record<string, string> = { ok: 'active', blocked: 'blocked', forbidden: 'blocked', not_found: 'archived', not_supported: 'archived' };

const PreviewList = ({ preview, resolutions, onResolve }: { preview: EntityPreview; resolutions?: Record<string, Record<string, string>>; onResolve?: (key: string, field: string, value: string) => void }) => (
  <ul className="flex max-h-[360px] flex-col gap-2 overflow-y-auto">
    {preview.items.map((it) => {
      const key = rowKey(it);
      return (
        <li key={key} className="flex flex-col gap-2 rounded-[10px] border border-line p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-medium text-fg">{it.title}</span>
            <StatusBadge status={previewStatusTone[it.status] ?? it.status} label={previewStatusLabel[it.status] ?? it.status} />
          </div>
          {it.message ? <p className="text-[13px] text-fg-2">{it.message}</p> : null}
          {it.items.length ? (
            <ul className="flex flex-col gap-1 text-[13px]">
              {it.items.map((d) => (
                <li key={d.kind} className={d.blocking ? 'text-danger' : 'text-fg-2'}>
                  {d.blocking ? <WarningCircle size={12} className="mr-1 inline" aria-hidden /> : null}
                  {d.label}: {d.count}
                  {d.resolution ? ` — ${d.resolution}` : ''}
                </li>
              ))}
            </ul>
          ) : null}
          {onResolve
            ? it.collisions.map((c) => (
                <div key={c.field} className="flex flex-col gap-2 rounded-[8px] bg-surface-2 p-2">
                  <p className="text-[13px] text-fg">{c.message}</p>
                  <RadioGroup
                    label={`${it.title}: ${c.field}`}
                    value={resolutions?.[key]?.[c.field] ?? ''}
                    onValueChange={(v) => onResolve(key, c.field, v)}
                    options={c.options.map((o) => ({ value: o.value, label: o.label }))}
                  />
                </div>
              ))
            : null}
        </li>
      );
    })}
  </ul>
);

/** Restore preview: dependencies and unique collisions first; every collision needs an explicit choice. */
const RestoreDialog = ({ targets, onClose }: { targets: EntityRef[]; onClose: (done: boolean) => void }) => {
  const { workspace } = useWorkspace();
  const params = { workspaceId: workspace.id };
  const previewRun = useApiMutation(archiveEndpoints.restorePreview, { silentErrors: true });
  const restore = useApiMutation(archiveEndpoints.restore, { invalidate: INVALIDATE, silentErrors: true });
  const [data, setData] = useState<EntityPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resolutions, setResolutions] = useState<Record<string, Record<string, string>>>({});
  const [failed, setFailed] = useState<{ title: string; message: string }[]>([]);
  const load = async () => {
    setError(null);
    try {
      setData(await previewRun.run({ params, body: { targets } }));
    } catch (e) {
      setError(isApiError(e) ? e.message : 'Could not check these records.');
    }
  };
  useEffect(() => {
    if (!data) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);
  const unresolved = (data?.items ?? []).some((it) => it.status === 'ok' && it.collisions.some((c) => !resolutions[rowKey(it)]?.[c.field]));
  const submit = async () => {
    if (!data) return;
    setError(null);
    try {
      const r = await restore.run({ params, body: { previewToken: data.token, resolutions } });
      const titles = new Map(data.items.map((i) => [rowKey(i), i.title]));
      if (r.done.length) toast({ kind: 'success', title: `${r.done.length} record${r.done.length === 1 ? '' : 's'} restored` });
      if (r.failed.length) setFailed(r.failed.map((f) => ({ title: titles.get(rowKey(f)) ?? f.entityType, message: f.message })));
      else onClose(true);
    } catch (e) {
      if (isApiError(e) && (e.code === 'PREVIEW_EXPIRED' || e.code === 'PREVIEW_STALE' || e.status === 409)) {
        setError(`${e.message} The preview was refreshed; review it again.`);
        setData(null);
        setResolutions({});
        return;
      }
      setError(isApiError(e) ? e.message : 'Restore failed.');
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose(false)}
      title={`Restore ${targets.length === 1 ? 'record' : `${targets.length} records`}`}
      description="Restoring uses your current permissions. Nothing changes until you confirm."
      size="regular"
      footer={
        failed.length ? (
          <Button variant="primary" onClick={() => onClose(true)}>
            Close
          </Button>
        ) : (
          <>
            <Button onClick={() => onClose(false)} disabled={restore.isPending}>
              Cancel
            </Button>
            <Button variant="primary" loading={restore.isPending} disabled={!data || data.eligibleCount === 0 || unresolved} onClick={() => void submit()}>
              {data ? `Restore ${data.eligibleCount}` : 'Restore'}
            </Button>
          </>
        )
      }
    >
      <div className="flex flex-col gap-3">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        {failed.length ? (
          <Banner tone="warning">
            Some records were not restored:
            <ul className="mt-1 list-disc pl-5">
              {failed.map((f, i) => (
                <li key={i}>
                  {f.title}: {f.message}
                </li>
              ))}
            </ul>
          </Banner>
        ) : null}
        {!data ? (
          <p className="text-[13px] text-fg-2">{previewRun.isPending ? 'Checking dependencies and names…' : null}</p>
        ) : (
          <>
            {unresolved ? <Banner tone="warning">Another record now uses the same value. Choose how to restore each conflicting record.</Banner> : null}
            <PreviewList preview={data} resolutions={resolutions} onResolve={(key, field, value) => setResolutions((cur) => ({ ...cur, [key]: { ...(cur[key] ?? {}), [field]: value } }))} />
          </>
        )}
      </div>
    </Dialog>
  );
};

/** Permanent deletion: Owner only, eligible trash only, typed confirmation and recent authentication; runs as a job. */
const PurgeDialog = ({ targets, onClose }: { targets: EntityRef[]; onClose: (done: boolean) => void }) => {
  const { workspace } = useWorkspace();
  const params = { workspaceId: workspace.id };
  const previewRun = useApiMutation(archiveEndpoints.purgePreview, { silentErrors: true });
  const purge = useApiMutation(archiveEndpoints.purge, { invalidate: INVALIDATE, silentErrors: true });
  const [data, setData] = useState<EntityPreview | null>(null);
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [reauth, setReauth] = useState(false);
  const load = async () => {
    setError(null);
    try {
      setData(await previewRun.run({ params, body: { targets } }));
    } catch (e) {
      setError(isApiError(e) ? e.message : 'Could not check these records.');
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const phrase = data ? `DELETE ${data.eligibleCount}` : '';
  const submit = async () => {
    if (!data) return;
    setError(null);
    try {
      const r = await purge.run({ params, body: { previewToken: data.token, confirmation: typed.trim() } });
      toast({ kind: 'success', title: `Permanent deletion of ${r.count} record${r.count === 1 ? '' : 's'} started`, description: 'Records disappear from the trash when the job finishes.' });
      onClose(true);
    } catch (e) {
      if (isRecentAuthError(e)) setReauth(true);
      else setError(isApiError(e) ? e.message : 'Permanent deletion failed.');
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose(false)}
      title="Permanently delete from trash?"
      description="This cannot be undone. Finance records and audit history are never deleted."
      size="regular"
      footer={
        reauth ? null : (
          <>
            <Button onClick={() => onClose(false)} disabled={purge.isPending}>
              Cancel
            </Button>
            <Button variant="danger" loading={purge.isPending} disabled={!data || data.eligibleCount === 0 || typed.trim() !== phrase} onClick={() => void submit()}>
              Permanently Delete
            </Button>
          </>
        )
      }
    >
      <div className="flex flex-col gap-3">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        {data ? (
          <>
            <p className="text-[13px] text-fg">
              {data.eligibleCount} of {data.items.length} selected record{data.items.length === 1 ? '' : 's'} can be deleted permanently. Their files and links are removed; the audit history of the deletion is kept.
            </p>
            <PreviewList preview={data} />
            {reauth ? (
              <ReauthForm
                onCancel={() => setReauth(false)}
                onConfirmed={async () => {
                  setReauth(false);
                  await submit();
                }}
              />
            ) : data.eligibleCount > 0 ? (
              <label className="flex flex-col gap-1 text-[13px] text-fg">
                <span>
                  Type <code className="rounded bg-surface-2 px-1 font-mono">{phrase}</code> to confirm
                </span>
                <Input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />
              </label>
            ) : null}
          </>
        ) : (
          <p className="text-[13px] text-fg-2">{previewRun.isPending ? 'Checking what can be deleted…' : null}</p>
        )}
      </div>
    </Dialog>
  );
};
