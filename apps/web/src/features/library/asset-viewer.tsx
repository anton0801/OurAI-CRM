'use client';
import { DotsThree, DownloadSimple, PencilSimple } from '@phosphor-icons/react';
import Link from 'next/link';
import { useState } from 'react';
import { mediaEndpoints, projectEndpoints, type AssetDetail } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import {
  Badge,
  Banner,
  Button,
  ConfirmDialog,
  DataTable,
  DescriptionList,
  EmptyState,
  IconButton,
  Menu,
  PageHeader,
  Panel,
  StatusBadge,
  TabPanel,
  Tabs,
  Textarea,
  formatBytes,
  formatDateTime,
  humanize,
  toast,
  type Column,
  type MenuItem,
} from '@castlane/ui';
import { QueryState } from '@/components/common/query-state';
import { api } from '@/lib/api';
import { useApiInfinite, useApiMutation, useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useUrlState } from '@/lib/url-state';
import { useCan, useWorkspace, useWsPath } from '@/lib/workspace-context';
import { AssetEditDrawer } from './asset-edit-drawer';
import { AssetPreview } from './asset-preview';
import { LinkDialog } from './link-dialog';
import { effectiveStatus, formatDurationMs } from './library-utils';
import { DeleteVersionDialog, NewVersionDrawer } from './version-dialogs';
import './labels';

type Version = AssetDetail['versions'][number];
type Usage = AssetDetail['usage'][number];

const scanText = (v: Version) => (!v.scan ? (v.status === 'checking' ? 'Being scanned' : 'Not scanned') : v.scan.devBypass ? 'Not scanned (development)' : v.scan.clean ? `Scanned (${v.scan.engine})` : 'Threat found');

/** S37 Asset Viewer: preview, metadata, versions, usage links, download, activity. */
export const AssetViewer = ({ assetId }: { assetId: string }) => {
  const { workspace, user } = useWorkspace();
  const can = useCan();
  const wsPath = useWsPath();
  const { state, set } = useUrlState<'tab'>({ tab: 'versions' });
  const q = useApiQuery(mediaEndpoints.get, { params: { workspaceId: workspace.id, assetId } }, { refetchInterval: (query) => (query.state.data?.pendingVersion && ['uploading', 'checking', 'processing'].includes(query.state.data.pendingVersion.status) ? 4000 : false) });
  const [editOpen, setEditOpen] = useState(false);
  const [newVersionOpen, setNewVersionOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [deleteVersion, setDeleteVersion] = useState<string | null>(null);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archiveReason, setArchiveReason] = useState('');
  const [removeLink, setRemoveLink] = useState<Usage | null>(null);
  const [linkReason, setLinkReason] = useState('');
  const archivePreview = useApiQuery(mediaEndpoints.archivePreview, { params: { workspaceId: workspace.id, assetId } }, { enabled: archiveOpen });
  const archive = useApiMutation(mediaEndpoints.archive, { invalidate: ['assets.'], successMessage: 'File archived' });
  const restore = useApiMutation(mediaEndpoints.restore, { invalidate: ['assets.'], successMessage: 'File restored' });
  const unlink = useApiMutation(mediaEndpoints.removeLink, { invalidate: ['assets.'], successMessage: 'Link removed' });
  const activity = useApiInfinite(mediaEndpoints.activity, { params: { workspaceId: workspace.id, assetId }, query: {} }, { enabled: state.tab === 'activity' });

  const download = async (a: AssetDetail, versionId?: string) => {
    try {
      const r = await api.call(mediaEndpoints.download, { params: { workspaceId: workspace.id, assetId: a.id }, body: versionId ? { versionId } : {} });
      window.location.assign(r.url);
    } catch (e) {
      toast.error(isApiError(e) ? e.message : 'The download could not be started.');
    }
  };

  const setAsProjectCover = async (a: AssetDetail) => {
    if (!a.projectId) return;
    try {
      const p = await api.call(projectEndpoints.get, { params: { workspaceId: workspace.id, projectId: a.projectId } });
      await api.call(projectEndpoints.update, { params: { workspaceId: workspace.id, projectId: a.projectId }, body: { coverAssetId: a.id } }, { ifMatch: p.rowVersion });
      toast.success('Project cover updated');
    } catch (e) {
      toast.error(isApiError(e) ? e.message : 'The project cover could not be changed.');
    }
  };

  return (
    <QueryState query={q}>
      {q.data
        ? (() => {
            const a = q.data;
            const v = a.currentVersion;
            const status = effectiveStatus(a);
            const menu: MenuItem[] = [
              { label: 'Edit Details', icon: <PencilSimple size={14} />, onSelect: () => setEditOpen(true), hidden: !a.permissions.update },
              { label: 'Upload New Version', onSelect: () => setNewVersionOpen(true), hidden: !a.permissions.upload },
              { label: 'Link to Content', onSelect: () => setLinkOpen(true), hidden: !a.permissions.link },
              {
                label: 'Set as Project Cover',
                onSelect: () => void setAsProjectCover(a),
                hidden: a.kind !== 'image' || !a.projectId || !v || v.status !== 'available' || a.restrictedHidden || !can('projects.update'),
              },
              { label: 'Archive File', destructive: true, separatorBefore: true, onSelect: () => setArchiveOpen(true), hidden: !a.permissions.archive },
            ];
            const versionColumns: Column<Version>[] = [
              {
                key: 'no',
                header: 'Version',
                sticky: true,
                minWidth: 110,
                cell: (x) => (
                  <span className="flex items-center gap-2">
                    <span className="font-mono">v{x.versionNo}</span>
                    {x.isCurrent ? <Badge tone="primary">Current</Badge> : null}
                  </span>
                ),
              },
              { key: 'file', header: 'File', minWidth: 200, cell: (x) => <span className="block max-w-[260px] truncate" title={x.originalFilename}>{x.originalFilename}</span> },
              {
                key: 'status',
                header: 'Status',
                minWidth: 130,
                cell: (x) => (x.deletedAt ? <Badge>Deleted</Badge> : <StatusBadge status={x.status} label={label('assetStatus', x.status)} />),
              },
              { key: 'size', header: 'Size', align: 'right', minWidth: 90, cell: (x) => formatBytes(x.byteSize) },
              { key: 'by', header: 'Uploaded', minWidth: 200, cell: (x) => `${x.createdBy?.displayName ?? 'Unknown member'} · ${formatDateTime(x.createdAt, user.timezone)}` },
              { key: 'note', header: 'Note', minWidth: 160, cell: (x) => x.note ?? (x.rejectionReason ? <span className="text-danger">{x.rejectionReason}</span> : <span className="text-fg-muted">—</span>) },
              {
                key: 'actions',
                header: <span className="sr-only">Actions</span>,
                headerLabel: 'Actions',
                minWidth: 56,
                cell: (x) => {
                  const items: MenuItem[] = [
                    { label: 'Download This Version', onSelect: () => void download(a, x.id), hidden: !a.permissions.download || x.status !== 'available' || !!x.deletedAt },
                    { label: 'Delete Version', destructive: true, onSelect: () => setDeleteVersion(x.id), hidden: !a.permissions.deleteVersion || !!x.deletedAt || ['uploading', 'checking', 'processing'].includes(x.status) },
                  ];
                  return items.some((i) => !i.hidden) ? <Menu label={`Actions for version ${x.versionNo}`} trigger={<IconButton label={`Actions for version ${x.versionNo}`} icon={<DotsThree size={16} weight="bold" />} />} items={items} /> : null;
                },
              },
            ];
            return (
              <div className="flex flex-col gap-5">
                <PageHeader
                  crumbs={[
                    { label: 'Library', href: wsPath('/library') },
                    ...(a.folderPath ?? []).map((f) => ({ label: f.name, href: wsPath(`/library?folder=${f.id}`) })),
                    { label: a.name },
                  ]}
                  title={a.name}
                  meta={
                    <>
                      <Badge>{label('assetKind', a.kind)}</Badge>
                      {status !== 'external' ? <StatusBadge status={status} label={label('assetStatus', status)} /> : null}
                      {a.sensitivity === 'restricted' ? <Badge tone="warning">Restricted Media</Badge> : null}
                      {a.archivedAt ? <Badge>Archived</Badge> : null}
                    </>
                  }
                  actions={
                    <>
                      {a.permissions.download && v?.status === 'available' ? (
                        <Button variant="primary" icon={<DownloadSimple size={14} weight="bold" />} onClick={() => void download(a)}>
                          Download
                        </Button>
                      ) : null}
                      {a.permissions.restore ? (
                        <Button loading={restore.isPending} onClick={() => void restore.run({ params: { workspaceId: workspace.id, assetId: a.id }, body: {} }, { ifMatch: a.rowVersion })}>
                          Restore
                        </Button>
                      ) : null}
                      {menu.some((m) => !m.hidden) ? <Menu label="More actions" trigger={<IconButton label="More actions" icon={<DotsThree size={18} weight="bold" />} variant="secondary" />} items={menu} /> : null}
                    </>
                  }
                />
                {a.archivedAt ? <Banner tone="info">Archived records remain available in historical reports. This file is hidden from the Library.</Banner> : null}
                {a.pendingVersion && ['uploading', 'checking', 'processing'].includes(a.pendingVersion.status) ? (
                  <Banner tone="info">Your file is being checked and prepared for preview. (Version {a.pendingVersion.versionNo}: {label('assetStatus', a.pendingVersion.status)})</Banner>
                ) : null}
                {a.pendingVersion && ['rejected', 'failed'].includes(a.pendingVersion.status) ? (
                  <Banner tone="danger">
                    Version {a.pendingVersion.versionNo} was {a.pendingVersion.status === 'failed' ? 'not completed' : 'rejected'}: {a.pendingVersion.rejectionReason ?? 'no reason recorded'}.
                  </Banner>
                ) : null}
                <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                  <div className="min-w-0 lg:col-span-2">
                    <AssetPreview a={a} onDownload={() => void download(a)} />
                  </div>
                  <Panel title="Details">
                    <DescriptionList
                      columns={1}
                      items={[
                        { label: 'Name', value: a.name },
                        { label: 'Original filename', value: v?.originalFilename, hidden: !v },
                        { label: 'MIME type', value: v?.mime ? <span className="font-mono text-[13px]">{v.mime}</span> : null, hidden: !v },
                        { label: 'Size', value: v ? formatBytes(v.byteSize) : null, hidden: !v },
                        { label: 'Dimensions', value: v?.width && v.height ? `${v.width} × ${v.height} px` : null, hidden: !v?.width },
                        { label: 'Duration', value: formatDurationMs(v?.durationMs), hidden: !v?.durationMs },
                        { label: 'SHA-256', value: v?.checksumSha256 ? <span className="break-all font-mono text-[12px]">{v.checksumSha256}</span> : null, hidden: !v },
                        { label: 'Version', value: v ? `v${v.versionNo} of ${a.versions.filter((x) => !x.deletedAt).length}` : null, hidden: !v },
                        { label: 'Security check', value: v ? scanText(v) : null, hidden: !v },
                        { label: 'Link', value: a.externalUrl ? <span className="break-all">{a.externalUrl}</span> : null, hidden: a.kind !== 'external_link' },
                        { label: 'Owner', value: a.owner?.displayName },
                        { label: 'Project', value: a.projectName ?? (a.projectId ? 'Another project' : 'Workspace library') },
                        { label: 'Sensitivity', value: a.sensitivity === 'restricted' ? 'Restricted Media' : 'Normal' },
                        {
                          label: 'Retention',
                          value: a.retention
                            ? a.retention.heldByReferences
                              ? 'Kept: approved or published records reference this file.'
                              : `Deleted versions are purged after ${a.retention.trashDays} days.`
                            : null,
                        },
                        { label: 'Tags', value: a.tags.length ? a.tags.join(', ') : null },
                        { label: 'Description', value: a.description },
                        { label: 'Updated', value: formatDateTime(a.updatedAt, user.timezone) },
                      ]}
                    />
                  </Panel>
                </div>
                <Tabs
                  label="File sections"
                  value={state.tab ?? 'versions'}
                  onValueChange={(t) => set({ tab: t })}
                  items={[
                    { value: 'versions', label: 'Versions', count: a.versions.length, hidden: a.kind === 'external_link' },
                    { value: 'usage', label: 'Used In', count: a.usage.length + a.hiddenUsageCount },
                    { value: 'activity', label: 'Activity' },
                  ]}
                >
                  <TabPanel value="versions">
                    <div className="flex flex-col gap-3">
                      {a.permissions.upload ? (
                        <div className="flex justify-end">
                          <Button onClick={() => setNewVersionOpen(true)}>Upload New Version</Button>
                        </div>
                      ) : null}
                      <DataTable caption="Versions" rows={a.versions} columns={versionColumns} getRowId={(x) => x.id} density={user.density} empty={<EmptyState title="No versions yet" />} />
                    </div>
                  </TabPanel>
                  <TabPanel value="usage">
                    <div className="flex flex-col gap-3">
                      {a.permissions.link ? (
                        <div className="flex justify-end">
                          <Button onClick={() => setLinkOpen(true)}>Link to Content</Button>
                        </div>
                      ) : null}
                      {a.usage.length === 0 && a.hiddenUsageCount === 0 ? (
                        <EmptyState title="Not used anywhere yet" description="Link the file to content, a task or another record to show it there." />
                      ) : (
                        <ul className="divide-y divide-line rounded-[12px] border border-line bg-surface">
                          {a.usage.map((u) => (
                            <li key={u.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                              <span className="min-w-0 flex-1">
                                <span className="block text-[14px] text-fg">
                                  {u.href ? (
                                    <Link href={u.href} className="hover:underline">
                                      {u.label ?? label('entityType', u.entityType)}
                                    </Link>
                                  ) : (
                                    (u.label ?? label('entityType', u.entityType))
                                  )}
                                </span>
                                <span className="text-[12px] text-fg-2">
                                  {label('entityType', u.entityType)} · {label('linkRole', u.role)}
                                  {u.versionNo ? ` · pinned to v${u.versionNo}` : ' · current version'}
                                </span>
                              </span>
                              {u.holding ? <Badge tone="info" title="Approved or published records keep their exact file.">Held by record</Badge> : null}
                              {!u.holding && a.permissions.link ? (
                                <Button size="sm" variant="ghost" onClick={() => setRemoveLink(u)}>
                                  Remove Attachment Link
                                </Button>
                              ) : null}
                            </li>
                          ))}
                          {a.hiddenUsageCount ? <li className="px-4 py-3 text-[13px] text-fg-2">Also used in {a.hiddenUsageCount} place{a.hiddenUsageCount === 1 ? '' : 's'} you cannot access.</li> : null}
                        </ul>
                      )}
                    </div>
                  </TabPanel>
                  <TabPanel value="activity">
                    <QueryState query={activity}>
                      {activity.items.length === 0 ? (
                        <EmptyState title="No activity yet" />
                      ) : (
                        <div className="flex flex-col gap-3">
                          <ol className="flex flex-col divide-y divide-line rounded-[12px] border border-line bg-surface">
                            {activity.items.map((e) => (
                              <li key={e.id} className="flex flex-col gap-1 px-4 py-3">
                                <p className="text-[14px] text-fg">
                                  <span className="font-semibold">{e.actorName ?? 'System'}</span> · {humanize(e.action.replace(/\./g, '_'))}
                                </p>
                                {e.changes.length ? (
                                  <ul className="text-[13px] text-fg-2">
                                    {e.changes.map((c) => (
                                      <li key={c.field}>
                                        {humanize(c.field.replace(/([A-Z])/g, '_$1').toLowerCase())}: {String(c.from ?? '—')} → {String(c.to ?? '—')}
                                      </li>
                                    ))}
                                  </ul>
                                ) : null}
                                {e.reason ? <p className="text-[13px] text-fg-2">Reason: {e.reason}</p> : null}
                                <p className="text-[12px] text-fg-muted">{formatDateTime(e.occurredAt, user.timezone)}</p>
                              </li>
                            ))}
                          </ol>
                          {activity.hasNextPage ? (
                            <div className="flex justify-center">
                              <Button onClick={() => void activity.fetchNextPage()} loading={activity.isFetchingNextPage}>
                                Load More
                              </Button>
                            </div>
                          ) : null}
                        </div>
                      )}
                    </QueryState>
                  </TabPanel>
                </Tabs>

                <AssetEditDrawer open={editOpen} onOpenChange={setEditOpen} asset={a} />
                <NewVersionDrawer open={newVersionOpen} onOpenChange={setNewVersionOpen} asset={a} onUploaded={() => void q.refetch()} />
                <LinkDialog open={linkOpen} onOpenChange={setLinkOpen} assetId={a.id} assetName={a.name} versions={a.versions} />
                <DeleteVersionDialog open={!!deleteVersion} onOpenChange={(o) => !o && setDeleteVersion(null)} asset={a} versionId={deleteVersion} onArchive={() => setArchiveOpen(true)} />
                <ConfirmDialog
                  open={archiveOpen}
                  onOpenChange={setArchiveOpen}
                  title="Archive this file?"
                  destructive
                  confirmLabel="Archive File"
                  loading={archive.isPending}
                  body="Archived records remain available in historical reports. The file is hidden from the Library; records that use it keep working."
                  onConfirm={async () => {
                    await archive.run({ params: { workspaceId: workspace.id, assetId: a.id }, body: { reason: archiveReason.trim() || undefined } }, { ifMatch: a.rowVersion });
                    setArchiveOpen(false);
                    setArchiveReason('');
                  }}
                >
                  {archivePreview.data?.items.length ? (
                    <ul className="flex flex-col gap-1 rounded-[8px] bg-surface-2 p-3 text-[13px] text-fg-2">
                      {archivePreview.data.items.map((i) => (
                        <li key={i.kind}>
                          {i.label}: {i.count}
                          {i.resolution ? ` — ${i.resolution}` : ''}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  <Textarea aria-label="Reason (optional)" placeholder="Reason (optional)" value={archiveReason} onChange={(e) => setArchiveReason(e.target.value)} maxLength={500} />
                </ConfirmDialog>
                <ConfirmDialog
                  open={!!removeLink}
                  onOpenChange={(o) => !o && setRemoveLink(null)}
                  title="Remove attachment link?"
                  confirmLabel="Remove Attachment Link"
                  destructive
                  loading={unlink.isPending}
                  body={`The file stays in the Library; it is no longer shown on ${removeLink?.label ?? 'this record'}.`}
                  onConfirm={async () => {
                    if (!removeLink) return;
                    await unlink.run({ params: { workspaceId: workspace.id, linkId: removeLink.id }, body: { reason: linkReason.trim() || undefined } });
                    setRemoveLink(null);
                    setLinkReason('');
                  }}
                >
                  <Textarea aria-label="Reason (optional)" placeholder="Reason (optional)" value={linkReason} onChange={(e) => setLinkReason(e.target.value)} maxLength={500} />
                </ConfirmDialog>
              </div>
            );
          })()
        : null}
    </QueryState>
  );
};
