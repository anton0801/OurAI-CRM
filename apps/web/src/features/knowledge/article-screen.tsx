'use client';
import { CheckCircle, DotsThree, PencilSimple } from '@phosphor-icons/react';
import Link from 'next/link';
import { useState } from 'react';
import { knowledgeEndpoints, mediaEndpoints, type ArticleDetail, type ArticleVersionSummary, type RichTextDocument } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import {
  Avatar,
  Badge,
  Banner,
  Button,
  ConfirmDialog,
  DataTable,
  Dialog,
  EmptyState,
  IconButton,
  Menu,
  PageHeader,
  Panel,
  Select,
  StatusBadge,
  TabPanel,
  Tabs,
  Textarea,
  formatBytes,
  formatDate,
  formatDateTime,
  toast,
  type Column,
  type MenuItem,
} from '@castlane/ui';
import { QueryState } from '@/components/common/query-state';
import { FileUploader } from '@/components/media/file-uploader';
import { api } from '@/lib/api';
import { useApiInfinite, useApiMutation, useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useUrlState } from '@/lib/url-state';
import { useWorkspace, useWsPath } from '@/lib/workspace-context';
import { AssignReadingDialog, CompareDialog, CreateTaskDialog, PublishDialog } from './article-dialogs';
import { ArticleEditor } from './article-editor';
import { RichTextView } from './rich-text-view';
import './labels';

/** Required reading state for the member, with the explicit Acknowledge Read action (T083). */
const ReadingBanner = ({ a }: { a: ArticleDetail }) => {
  const { workspace, user } = useWorkspace();
  const ack = useApiMutation(knowledgeEndpoints.acknowledge, { invalidate: ['knowledge.', 'myWork.'], successMessage: 'Reading acknowledged' });
  if (!a.published || a.status !== 'published') return null;
  const mine = a.myReading;
  if (a.acknowledgedCurrent && a.myAcknowledgement)
    return (
      <Banner tone="success">
        <span className="inline-flex items-center gap-2">
          <CheckCircle size={16} weight="fill" aria-hidden /> You acknowledged version {a.myAcknowledgement.versionNo} on {formatDateTime(a.myAcknowledgement.acknowledgedAt, user.timezone)}.
        </span>
      </Banner>
    );
  const pending = mine?.status === 'open' && mine.versionId === a.published.id;
  if (!pending && !a.permissions.acknowledge) return null;
  const earlier = a.myAcknowledgement && !a.acknowledgedCurrent;
  return (
    <Banner
      tone={pending ? (mine?.overdue ? 'warning' : 'info') : 'info'}
      action={
        a.permissions.acknowledge ? (
          <Button
            variant={pending ? 'primary' : 'secondary'}
            loading={ack.isPending}
            onClick={() => void ack.run({ params: { workspaceId: workspace.id, articleId: a.id }, body: { versionId: a.published!.id } })}
          >
            Acknowledge Read
          </Button>
        ) : undefined
      }
    >
      {pending ? (
        <>
          <strong className="font-semibold">Required reading{mine?.dueAt ? ` — acknowledge by ${formatDateTime(mine.dueAt, user.timezone)}` : ''}.</strong>{' '}
          {mine?.overdue ? 'The due date has passed. ' : ''}Opening the article does not count as read: confirm when you have read version {a.publishedVersionNo}.
        </>
      ) : earlier ? (
        <>You acknowledged version {a.myAcknowledgement!.versionNo}. Version {a.publishedVersionNo} is a minor revision; confirming again is optional.</>
      ) : (
        <>Confirm with Acknowledge Read when you have read this version.</>
      )}
    </Banner>
  );
};

const Attachments = ({ a }: { a: ArticleDetail }) => {
  const { workspace } = useWorkspace();
  const wsPath = useWsPath();
  const [remove, setRemove] = useState<string | null>(null);
  const unlink = useApiMutation(mediaEndpoints.removeLink, { invalidate: ['knowledge.', 'assets.'], successMessage: 'Attachment link removed' });
  const download = async (assetId: string) => {
    try {
      const r = await api.call(mediaEndpoints.download, { params: { workspaceId: workspace.id, assetId }, body: {} });
      window.location.assign(r.url);
    } catch (e) {
      toast.error(isApiError(e) ? e.message : 'The download could not be started.');
    }
  };
  if (!a.attachments.length && !a.permissions.attach) return null;
  return (
    <Panel title="Attachments">
      <div className="flex flex-col gap-3">
        {a.attachments.length ? (
          <ul className="flex flex-col divide-y divide-line">
            {a.attachments.map((f) => (
              <li key={f.linkId} className="flex flex-wrap items-center gap-2 py-2">
                <Link href={wsPath(`/library/assets/${f.id}`)} className="min-w-0 flex-1 truncate text-[14px] text-fg hover:underline">
                  {f.name}
                </Link>
                <span className="text-[12px] text-fg-2">
                  {label('assetKind', f.kind)}
                  {f.currentVersion?.byteSize ? ` · ${formatBytes(f.currentVersion.byteSize)}` : ''}
                </span>
                {f.canDownload ? (
                  <Button size="sm" variant="ghost" onClick={() => void download(f.id)}>
                    Download
                  </Button>
                ) : null}
                {a.permissions.attach && !f.holding ? (
                  <Button size="sm" variant="ghost" onClick={() => setRemove(f.linkId)}>
                    Remove Attachment Link
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[13px] text-fg-2">No attachments.</p>
        )}
        {a.permissions.attach ? (
          <FileUploader compact workspaceId={workspace.id} purpose="document" target={{ entityType: 'article', entityId: a.id, role: 'attachment' }} label="Attach Files" checkDuplicates />
        ) : null}
      </div>
      <ConfirmDialog
        open={!!remove}
        onOpenChange={(o) => !o && setRemove(null)}
        title="Remove attachment link?"
        confirmLabel="Remove Attachment Link"
        destructive
        loading={unlink.isPending}
        body="The file stays in the Library; it is no longer attached to this article."
        onConfirm={async () => {
          if (!remove) return;
          await unlink.run({ params: { workspaceId: workspace.id, linkId: remove }, body: {} });
          setRemove(null);
        }}
      />
    </Panel>
  );
};

const VersionsPanel = ({ a, onCompare }: { a: ArticleDetail; onCompare: (from: string, to: string) => void }) => {
  const { workspace, user } = useWorkspace();
  const versions = useApiQuery(knowledgeEndpoints.versions, { params: { workspaceId: workspace.id, articleId: a.id } });
  const [view, setView] = useState<ArticleVersionSummary | null>(null);
  const [revertTo, setRevertTo] = useState<ArticleVersionSummary | null>(null);
  const detail = useApiQuery(knowledgeEndpoints.version, { params: { workspaceId: workspace.id, articleId: a.id, versionId: view?.id ?? '' } }, { enabled: !!view });
  const revert = useApiMutation(knowledgeEndpoints.revert, { invalidate: ['knowledge.'], successMessage: 'A new draft was started from the earlier version' });
  const list = versions.data ?? [];
  const columns: Column<ArticleVersionSummary>[] = [
    { key: 'no', header: 'Version', sticky: true, minWidth: 90, cell: (v) => <span className="font-mono">v{v.versionNo}</span> },
    { key: 'state', header: 'State', minWidth: 120, cell: (v) => <StatusBadge status={v.state} /> },
    { key: 'kind', header: 'Revision', minWidth: 130, cell: (v) => (v.revisionKind ? label('revisionKind', v.revisionKind) : <span className="text-fg-muted">—</span>) },
    { key: 'title', header: 'Title', minWidth: 200, cell: (v) => <span className="block max-w-[260px] truncate">{v.title}</span> },
    { key: 'note', header: 'Change note', minWidth: 200, cell: (v) => v.changeNote ?? <span className="text-fg-muted">—</span> },
    { key: 'published', header: 'Published', minWidth: 200, cell: (v) => (v.publishedAt ? `${formatDateTime(v.publishedAt, user.timezone)} · ${v.publishedBy?.displayName ?? 'Unknown member'}` : <span className="text-fg-muted">Not published</span>) },
    { key: 'words', header: 'Words', align: 'right', minWidth: 80, cell: (v) => v.wordCount },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      headerLabel: 'Actions',
      minWidth: 56,
      cell: (v) => {
        const idx = list.findIndex((x) => x.id === v.id);
        const prev = list[idx + 1];
        const items: MenuItem[] = [
          { label: 'View Version', onSelect: () => setView(v) },
          { label: 'Compare with Previous', onSelect: () => prev && onCompare(prev.id, v.id), hidden: !prev },
          { label: 'Revert to This Version', onSelect: () => setRevertTo(v), hidden: !a.permissions.edit || v.state === 'draft' },
        ];
        return <Menu label={`Actions for version ${v.versionNo}`} trigger={<IconButton label={`Actions for version ${v.versionNo}`} icon={<DotsThree size={16} weight="bold" />} />} items={items} />;
      },
    },
  ];
  return (
    <QueryState query={versions}>
      <div className="flex flex-col gap-3">
        {list.length > 1 ? (
          <div className="flex justify-end">
            <Button onClick={() => onCompare(list[1]!.id, list[0]!.id)}>Compare</Button>
          </div>
        ) : null}
        <DataTable caption="Versions" rows={list} columns={columns} getRowId={(v) => v.id} density={user.density} empty={<EmptyState title="No versions yet" />} />
      </div>
      <Dialog open={!!view} onOpenChange={(o) => !o && setView(null)} size="wide" title={view ? `Version ${view.versionNo}: ${view.title}` : ''} footer={<Button onClick={() => setView(null)}>Close</Button>}>
        <QueryState query={detail}>{detail.data ? <RichTextView doc={detail.data.body as RichTextDocument} /> : null}</QueryState>
      </Dialog>
      <ConfirmDialog
        open={!!revertTo}
        onOpenChange={(o) => !o && setRevertTo(null)}
        title={`Revert to version ${revertTo?.versionNo ?? ''}?`}
        confirmLabel="Start Draft from This Version"
        loading={revert.isPending}
        body={a.draft ? 'The current draft is replaced by the text of this version. Published versions stay unchanged.' : 'A new draft is created from this version. Published versions stay unchanged.'}
        onConfirm={async () => {
          if (!revertTo) return;
          await revert.run({ params: { workspaceId: workspace.id, articleId: a.id }, body: { versionId: revertTo.id } }, { ifMatch: a.rowVersion });
          setRevertTo(null);
        }}
      />
    </QueryState>
  );
};

const ReadingPanel = ({ a, onAssign }: { a: ArticleDetail; onAssign: () => void }) => {
  const { workspace, user } = useWorkspace();
  const [status, setStatus] = useState<string | null>('open');
  const rows = useApiInfinite(knowledgeEndpoints.readingStatus, {
    params: { workspaceId: workspace.id, articleId: a.id },
    query: { status: status ? [status as 'open'] : undefined },
  });
  const [cancel, setCancel] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const withdraw = useApiMutation(knowledgeEndpoints.cancelReading, { invalidate: ['knowledge.'], successMessage: 'Reading request withdrawn' });
  type Row = (typeof rows.items)[number];
  const columns: Column<Row>[] = [
    {
      key: 'member',
      header: 'Member',
      sticky: true,
      minWidth: 180,
      cell: (r) => (
        <span className="flex items-center gap-2">
          <Avatar name={r.member.displayName} src={r.member.avatarUrl} size={24} decorative />
          <span className="truncate">{r.member.displayName}</span>
        </span>
      ),
    },
    { key: 'version', header: 'Version', minWidth: 80, cell: (r) => `v${r.versionNo}` },
    { key: 'status', header: 'Status', minWidth: 150, cell: (r) => <StatusBadge status={r.overdue ? 'overdue' : r.status} label={r.overdue ? 'Overdue' : label('readingStatus', r.status)} /> },
    { key: 'due', header: 'Due', minWidth: 160, cell: (r) => (r.dueAt ? formatDateTime(r.dueAt, user.timezone) : <span className="text-fg-muted">No due date</span>) },
    { key: 'ack', header: 'Acknowledged', minWidth: 160, cell: (r) => (r.acknowledgedAt ? formatDateTime(r.acknowledgedAt, user.timezone) : <span className="text-fg-muted">—</span>) },
    { key: 'source', header: 'Asked via', minWidth: 120, cell: (r) => label('readingSource', r.source) },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      headerLabel: 'Actions',
      minWidth: 120,
      cell: (r) =>
        r.status === 'open' && a.permissions.assignReading ? (
          <Button size="sm" variant="ghost" onClick={() => setCancel(r.id)}>
            Withdraw
          </Button>
        ) : null,
    },
  ];
  return (
    <div className="flex flex-col gap-3">
      {a.readingSummary ? (
        <div className="flex flex-wrap gap-2">
          <Badge tone="info">To read: {a.readingSummary.open}</Badge>
          <Badge tone="warning">Overdue: {a.readingSummary.overdue}</Badge>
          <Badge tone="success">Acknowledged: {a.readingSummary.acknowledged}</Badge>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <div className="w-[200px]">
          <Select
            aria-label="Request status"
            value={status}
            onChange={setStatus}
            clearable
            placeholder="All requests"
            options={(['open', 'acknowledged', 'superseded', 'cancelled'] as const).map((s) => ({ value: s, label: label('readingStatus', s) }))}
          />
        </div>
        {a.permissions.assignReading ? (
          <Button variant="primary" className="ml-auto" onClick={onAssign}>
            Assign Reading
          </Button>
        ) : null}
      </div>
      <QueryState query={rows}>
        <DataTable
          caption="Reading requests"
          rows={rows.items}
          columns={columns}
          getRowId={(r) => r.id}
          density={user.density}
          hasMore={rows.hasNextPage}
          loadingMore={rows.isFetchingNextPage}
          onLoadMore={() => void rows.fetchNextPage()}
          empty={
            <EmptyState
              title={status ? 'No requests with this status' : 'Nobody has been asked to read this article yet'}
              action={a.permissions.assignReading ? <Button onClick={onAssign}>Assign Reading</Button> : undefined}
            />
          }
        />
      </QueryState>
      <ConfirmDialog
        open={!!cancel}
        onOpenChange={(o) => !o && setCancel(null)}
        title="Withdraw reading request?"
        confirmLabel="Withdraw Request"
        loading={withdraw.isPending}
        confirmDisabled={reason.trim().length < 3}
        body="The member is no longer asked to acknowledge this article. The history keeps the request."
        onConfirm={async () => {
          if (!cancel) return;
          await withdraw.run({ params: { workspaceId: workspace.id, assignmentId: cancel }, body: { reason: reason.trim() } });
          setCancel(null);
          setReason('');
        }}
      >
        <Textarea aria-label="Reason" placeholder="Reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} />
      </ConfirmDialog>
    </div>
  );
};

/** S39 Article Reader / Editor. */
export const ArticleScreen = ({ articleId }: { articleId: string }) => {
  const { workspace, user } = useWorkspace();
  const wsPath = useWsPath();
  const { state, set } = useUrlState<'tab'>({ tab: 'read' });
  const q = useApiQuery(knowledgeEndpoints.get, { params: { workspaceId: workspace.id, articleId } });
  const versions = useApiQuery(knowledgeEndpoints.versions, { params: { workspaceId: workspace.id, articleId } }, { enabled: q.isSuccess });
  const [publishOpen, setPublishOpen] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const [compare, setCompare] = useState<{ from: string; to: string } | null>(null);
  const [taskBlock, setTaskBlock] = useState<number | null>(null);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const preview = useApiQuery(knowledgeEndpoints.archivePreview, { params: { workspaceId: workspace.id, articleId } }, { enabled: archiveOpen });
  const archive = useApiMutation(knowledgeEndpoints.archive, { invalidate: ['knowledge.', 'myWork.'], successMessage: 'Article archived' });
  const restore = useApiMutation(knowledgeEndpoints.restore, { invalidate: ['knowledge.'], successMessage: 'Article restored' });
  const reviewed = useApiMutation(knowledgeEndpoints.markReviewed, { invalidate: ['knowledge.'], successMessage: 'Marked as reviewed' });
  const discard = useApiMutation(knowledgeEndpoints.discardDraft, { invalidate: ['knowledge.'], successMessage: 'Draft discarded' });

  return (
    <QueryState query={q}>
      {q.data
        ? (() => {
            const a = q.data;
            const tabs = [
              { value: 'read', label: 'Read' },
              { value: 'edit', label: a.draft ? 'Edit Draft' : 'Edit', hidden: !a.permissions.edit },
              { value: 'versions', label: 'Versions', count: a.versionCount },
              { value: 'reading', label: 'Reading', hidden: !a.permissions.viewReadingStatus || !a.publishedVersionNo },
            ];
            const visible = tabs.filter((t) => !t.hidden);
            const tab = visible.find((t) => t.value === state.tab)?.value ?? 'read';
            const menu: MenuItem[] = [
              { label: 'Assign Reading', onSelect: () => setAssignOpen(true), hidden: !a.permissions.assignReading },
              { label: 'Compare Versions', onSelect: () => setCompare({ from: versions.data?.[1]?.id ?? '', to: versions.data?.[0]?.id ?? '' }), hidden: (versions.data?.length ?? 0) < 2 },
              {
                label: 'Mark as Reviewed',
                description: 'Confirms the published text is still accurate.',
                onSelect: () => void reviewed.run({ params: { workspaceId: workspace.id, articleId: a.id }, body: {} }, { ifMatch: a.rowVersion }),
                hidden: !a.permissions.assignReading,
              },
              { label: 'Discard Draft', onSelect: () => setDiscardOpen(true), hidden: !a.permissions.edit || !a.draft || !a.published, separatorBefore: true },
              { label: 'Archive Article', destructive: true, onSelect: () => setArchiveOpen(true), hidden: !a.permissions.archive || a.status === 'archived' },
            ];
            return (
              <div className="flex flex-col gap-5">
                <PageHeader
                  crumbs={[{ label: 'Knowledge', href: wsPath('/knowledge') }, { label: a.category.name, href: wsPath(`/knowledge?category=${a.category.id}`) }, { label: a.title }]}
                  title={a.title}
                  meta={
                    <>
                      <StatusBadge status={a.status} label={label('articleStatus', a.status)} />
                      {a.publishedVersionNo ? <Badge>Version {a.publishedVersionNo}</Badge> : null}
                      {a.draft && a.published ? <Badge tone="info">Unpublished draft v{a.draft.versionNo}</Badge> : null}
                      {a.requiredReading ? <Badge tone="warning">Required reading</Badge> : null}
                      <Badge>{a.scope.type === 'workspace' ? 'Whole workspace' : `${label('articleScope', a.scope.type)}: ${a.scope.label ?? 'restricted'}`}</Badge>
                      <span className="flex items-center gap-1.5 text-[13px] text-fg-2">
                        <Avatar name={a.owner.displayName} src={a.owner.avatarUrl} size={24} decorative /> {a.owner.displayName}
                      </span>
                    </>
                  }
                  actions={
                    <>
                      {a.permissions.edit && tab !== 'edit' ? (
                        <Button icon={<PencilSimple size={14} />} onClick={() => set({ tab: 'edit' })}>
                          {a.draft ? 'Edit Draft' : 'Edit'}
                        </Button>
                      ) : null}
                      {a.permissions.publish ? (
                        <Button variant="primary" onClick={() => setPublishOpen(true)}>
                          Publish Version
                        </Button>
                      ) : null}
                      {a.status === 'archived' && a.permissions.archive ? (
                        <Button loading={restore.isPending} onClick={() => void restore.run({ params: { workspaceId: workspace.id, articleId: a.id }, body: {} }, { ifMatch: a.rowVersion })}>
                          Restore
                        </Button>
                      ) : null}
                      {menu.some((m) => !m.hidden) ? <Menu label="More actions" trigger={<IconButton label="More actions" icon={<DotsThree size={18} weight="bold" />} variant="secondary" />} items={menu} /> : null}
                    </>
                  }
                />
                {a.status === 'archived' ? <Banner tone="info">Archived records remain available in historical reports. Open reading requests were withdrawn; acknowledgements are kept.</Banner> : null}
                <Tabs label="Article sections" value={tab} onValueChange={(v) => set({ tab: v })} items={tabs}>
                  <TabPanel value="read">
                    <div className="flex flex-col gap-4">
                      <ReadingBanner a={a} />
                      {a.published ? (
                        <>
                          <p className="text-[12px] text-fg-2">
                            Version {a.publishedVersionNo}
                            {a.published.publishedAt ? ` · published ${formatDateTime(a.published.publishedAt, user.timezone)}` : ''}
                            {a.published.publishedBy ? ` by ${a.published.publishedBy.displayName}` : ''}
                            {a.lastReviewedAt ? ` · last reviewed ${formatDate(a.lastReviewedAt, user.timezone)}` : ''} · {a.category.name}
                          </p>
                          <article className="rounded-[12px] border border-line bg-surface p-4 md:p-6">
                            <RichTextView doc={a.published.body as RichTextDocument} onCreateTask={a.permissions.createTask ? (i) => setTaskBlock(i) : undefined} />
                          </article>
                        </>
                      ) : (
                        <EmptyState
                          title="Not published yet"
                          description={a.permissions.edit ? 'Readers see the article after the first version is published.' : 'This article has no published version.'}
                          action={a.permissions.edit ? <Button onClick={() => set({ tab: 'edit' })}>Open Draft</Button> : undefined}
                        />
                      )}
                      <Attachments a={a} />
                    </div>
                  </TabPanel>
                  {a.permissions.edit ? (
                    <TabPanel value="edit">
                      {tab === 'edit' ? <ArticleEditor key={a.id} article={a} canUpload={a.permissions.attach} /> : null}
                    </TabPanel>
                  ) : null}
                  <TabPanel value="versions">{tab === 'versions' ? <VersionsPanel a={a} onCompare={(from, to) => setCompare({ from, to })} /> : null}</TabPanel>
                  {a.permissions.viewReadingStatus ? <TabPanel value="reading">{tab === 'reading' ? <ReadingPanel a={a} onAssign={() => setAssignOpen(true)} /> : null}</TabPanel> : null}
                </Tabs>
                <PublishDialog open={publishOpen} onOpenChange={setPublishOpen} article={a} onPublished={() => set({ tab: 'read' })} />
                <AssignReadingDialog open={assignOpen} onOpenChange={setAssignOpen} article={a} />
                <CreateTaskDialog open={taskBlock !== null} onOpenChange={(o) => !o && setTaskBlock(null)} article={a} blockIndex={taskBlock} />
                <CompareDialog open={!!compare} onOpenChange={(o) => !o && setCompare(null)} article={a} versions={versions.data ?? []} initial={compare ?? undefined} />
                <ConfirmDialog
                  open={archiveOpen}
                  onOpenChange={setArchiveOpen}
                  title="Archive this article?"
                  destructive
                  confirmLabel="Archive Article"
                  loading={archive.isPending}
                  body="Archived records remain available in historical reports. The article leaves the Knowledge Base and search."
                  onConfirm={async () => {
                    await archive.run({ params: { workspaceId: workspace.id, articleId: a.id }, body: {} }, { ifMatch: a.rowVersion });
                    setArchiveOpen(false);
                  }}
                >
                  {preview.data?.items.length ? (
                    <ul className="flex flex-col gap-1 rounded-[8px] bg-surface-2 p-3 text-[13px] text-fg-2">
                      {preview.data.items.map((i) => (
                        <li key={i.kind}>
                          {i.label}: {i.count}
                          {i.resolution ? ` — ${i.resolution}` : ''}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </ConfirmDialog>
                <ConfirmDialog
                  open={discardOpen}
                  onOpenChange={setDiscardOpen}
                  title="Discard the draft?"
                  destructive
                  confirmLabel="Discard Draft"
                  loading={discard.isPending}
                  body="The unpublished changes are deleted. The published version stays unchanged."
                  onConfirm={async () => {
                    await discard.run({ params: { workspaceId: workspace.id, articleId: a.id }, body: {} }, { ifMatch: a.rowVersion });
                    setDiscardOpen(false);
                    set({ tab: 'read' });
                  }}
                />
              </div>
            );
          })()
        : null}
    </QueryState>
  );
};
