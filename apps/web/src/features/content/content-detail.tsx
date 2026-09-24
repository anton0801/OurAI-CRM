'use client';
import {
  ArrowRight,
  ChartLineUp,
  CheckSquare,
  DotsThree,
  Megaphone,
  PencilSimple,
  Plus,
  Stack,
  UploadSimple,
} from '@phosphor-icons/react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import {
  archiveEndpoints,
  contentEndpoints,
  contentVersionEndpoints,
  mediaEndpoints,
  taskEndpoints,
  type ContentDetail,
  type EntityPreview,
  type TaskRow,
} from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { LIMITS } from '@castlane/domain';
import {
  Badge,
  Banner,
  Button,
  DataTable,
  DescriptionList,
  Dialog,
  EmptyState,
  Field,
  IconButton,
  Menu,
  PageHeader,
  Panel,
  Switch,
  TabPanel,
  Tabs,
  Textarea,
  Toolbar,
  formatDateTime,
  humanize,
  toast,
  type Column,
  type MenuItem,
} from '@castlane/ui';
import { CommentThread } from '@/components/comments/comment-thread';
import { QueryState } from '@/components/common/query-state';
import { CustomFieldsPanel } from '@/components/custom-fields/custom-fields-panel';
import { AssetThumb, FileUploader } from '@/components/media/file-uploader';
import { useApiInfinite, useApiMutation, useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { CONTENT_PANELS } from '@/lib/slots';
import { useUrlState } from '@/lib/url-state';
import { useCan, useWorkspace, useWsPath } from '@/lib/workspace-context';
import { DueText as TaskDue, PriorityBadge, TaskStatusBadge } from '../tasks/format';
import { TaskDrawer } from '../tasks/task-drawer';
import { TaskForm } from '../tasks/task-form';
import { ApplyTemplateDialog, DownloadApprovedDialog, DuplicateDialog, FlagDialog } from './content-dialogs';
import { ContentFlags, DueText, Person, StageBadge, VersionPointers } from './format';
import { CONTENT_BRIEF_FIELDS } from './labels';
import { FileMeta, FileViewer } from './media-viewer';
import { VersionsTab } from './versions-tab';
import '@/features/slots';

type Tab = 'brief' | 'tasks' | 'versions' | 'publications' | 'results' | 'activity';

const ACTIVITY_LABELS: Record<string, string> = {
  'content.created': 'Created',
  'content.updated': 'Brief or links edited',
  'content.stage_changed': 'Stage changed',
  'content.new_revision_started': 'New revision started',
  'content.version_created': 'Version started',
  'content.version_updated': 'Version notes or checklist edited',
  'content.version_file_added': 'File added to a version',
  'content.version_file_removed': 'File removed from a version',
  'content.version_submitted': 'Version submitted for review',
  'review.approved': 'Version approved',
  'review.step_approved': 'Review step approved',
  'review.changes_requested': 'Changes requested',
  'review.approval_revoked': 'Approval revoked',
  'review.reviewer_assigned': 'Reviewer assigned',
  'content.template_applied': 'Template applied',
  'content.duplicated': 'Duplicated as a new draft',
  'content.archived': 'Archived',
  'content.restored': 'Restored',
  'content.blocked_set': 'Blocked',
  'content.blocked_cleared': 'Unblocked',
  'content.paused_set': 'Paused',
  'content.paused_cleared': 'Resumed',
  'content.owner_transferred': 'Owner transferred',
  'content.reviewer_transferred': 'Reviewer transferred',
  'content.package_requested': 'Package exported',
  'comment.created': 'Comment added',
};

/** Main preview (S24: one preview up to 720×480) of the approved or latest version. */
const MainPreview = ({ c }: { c: ContentDetail }) => {
  const { workspace } = useWorkspace();
  const versionId = c.approvedVersion?.id ?? c.currentVersion?.id ?? c.draftVersion?.id ?? null;
  const v = useApiQuery(
    contentVersionEndpoints.get,
    { params: { workspaceId: workspace.id, contentId: c.id, versionId: versionId ?? '' } },
    { enabled: !!versionId },
  );
  if (!versionId) return <p className="text-[14px] text-fg-2">No version uploaded yet.</p>;
  const file =
    v.data?.files.find((f) => ['main_video', 'main_image', 'image_set', 'audio'].includes(f.slot)) ??
    v.data?.files[0];
  return (
    <QueryState query={v} skeleton={<div className="h-[240px] rounded-[12px] bg-surface-2" />}>
      {file ? (
        <div className="flex max-w-[720px] flex-col gap-2">
          <FileViewer file={file} compact caption={`${c.title}, version ${v.data?.versionNo}`} />
          <FileMeta file={file} />
          <p className="text-[12px] text-fg-2">
            Showing{' '}
            {c.approvedVersion?.id === versionId
              ? 'the approved'
              : v.data?.state === 'draft'
                ? 'the draft'
                : 'the latest'}{' '}
            version {v.data?.versionNo}.
          </p>
        </div>
      ) : (
        <p className="text-[14px] text-fg-2">This version has no files yet.</p>
      )}
    </QueryState>
  );
};

const Attachments = ({ c }: { c: ContentDetail }) => {
  const { workspace } = useWorkspace();
  const wsPath = useWsPath();
  const q = useApiQuery(mediaEndpoints.entityFiles, {
    params: { workspaceId: workspace.id, entityType: 'content_item', entityId: c.id },
  });
  return (
    <Panel title="Attachments" description="Briefing material and sources. Deliverables belong to versions.">
      <QueryState query={q}>
        {q.data?.length ? (
          <ul className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
            {q.data.map((a) => (
              <li key={a.linkId} className="flex items-center gap-3 rounded-[8px] border border-line p-2">
                {a.thumbnailUrl ? (
                  <AssetThumb
                    workspaceId={workspace.id}
                    assetId={a.id}
                    size={64}
                    className="h-12 w-12 shrink-0"
                  />
                ) : null}
                <Link
                  href={wsPath(`/library/assets/${a.id}`)}
                  className="min-w-0 flex-1 truncate text-[14px] text-fg hover:underline"
                >
                  {a.restrictedHidden ? 'Restricted media' : a.name}
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mb-3 text-[14px] text-fg-2">No attachments.</p>
        )}
      </QueryState>
      {c.permissions.edit ? (
        <FileUploader
          workspaceId={workspace.id}
          purpose="reference"
          projectId={c.project.id}
          target={{ entityType: 'content_item', entityId: c.id }}
          compact
          label="Attach Files"
          onUploaded={() => void q.refetch()}
        />
      ) : null}
    </Panel>
  );
};

const BriefTab = ({ c, onMove }: { c: ContentDetail; onMove: (to: string) => void }) => {
  const { user } = useWorkspace();
  const wsPath = useWsPath();
  const filled = CONTENT_BRIEF_FIELDS.filter((f) => c.brief[f.key]);
  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
      <div className="flex min-w-0 flex-col gap-4 xl:col-span-2">
        {c.nextStages.length && !c.archivedAt ? (
          <Panel title="Next step">
            <ul className="flex flex-col gap-3">
              {c.nextStages.map((n) => (
                <li key={n.stage} className="flex flex-col gap-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-[14px] font-semibold">
                      Move to {label('contentStage', n.stage)}
                    </span>
                    {c.allowedMoves.includes(n.stage) ? (
                      <Button
                        size="sm"
                        icon={<ArrowRight size={14} />}
                        disabled={n.missing.length > 0}
                        onClick={() => onMove(n.stage)}
                      >
                        Move to {label('contentStage', n.stage)}
                      </Button>
                    ) : null}
                  </div>
                  {n.missing.length ? (
                    <ul className="list-disc pl-6 text-[13px] text-fg-2">
                      {n.missing.map((m) => (
                        <li key={m.field}>{m.message}</li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-[13px] text-fg-2">All conditions are met.</p>
                  )}
                </li>
              ))}
            </ul>
          </Panel>
        ) : null}
        <Panel title="Brief">
          {filled.length === 0 ? (
            <p className="text-[14px] text-fg-2">
              The brief is empty.{' '}
              {c.permissions.edit ? 'Edit the content to add the summary, objective and script.' : ''}
            </p>
          ) : (
            <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {filled.map((f) => (
                <div key={f.key} className={f.long ? 'sm:col-span-2' : undefined}>
                  <dt className="text-[12px] font-[550] text-fg-2">{f.label}</dt>
                  <dd className="mt-0.5 whitespace-pre-wrap break-words text-[15px] leading-6 text-fg">
                    {c.brief[f.key]}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </Panel>
        <Panel title="Characters and References">
          <div className="flex flex-col gap-3">
            {c.characters.length ? (
              <ul className="flex flex-wrap gap-2">
                {c.characters.map((ch) => (
                  <li key={ch.versionId}>
                    <Link
                      href={wsPath(`/projects/${c.project.id}/characters/${ch.characterId}`)}
                      className="inline-flex items-center gap-1.5 rounded-[6px] border border-line px-2 py-1 text-[13px] hover:bg-surface-2"
                    >
                      {ch.name} · profile v{ch.versionNo}
                      {ch.isApproved ? (
                        <Badge tone="success">Approved</Badge>
                      ) : (
                        <Badge tone="warning">{humanize(ch.state)}</Badge>
                      )}
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[14px] text-fg-2">No characters linked.</p>
            )}
            {c.references.length || c.hiddenReferenceCount ? (
              <ul className="flex flex-wrap gap-2">
                {c.references.map((r) => (
                  <li key={r.id}>
                    <Link
                      href={wsPath(`/references?open=${r.id}`)}
                      className="inline-flex rounded-[6px] border border-line px-2 py-1 text-[13px] hover:bg-surface-2"
                    >
                      {r.title}
                    </Link>
                  </li>
                ))}
                {c.hiddenReferenceCount ? (
                  <li className="text-[13px] text-fg-2">{c.hiddenReferenceCount} more outside your access</li>
                ) : null}
              </ul>
            ) : (
              <p className="text-[14px] text-fg-2">No references linked.</p>
            )}
          </div>
        </Panel>
        <Attachments c={c} />
        <CustomFieldsPanel entityType="content_item" entityId={c.id} />
        <CommentThread parentType="content_item" parentId={c.id} title="Discussion" />
      </div>
      <div className="flex min-w-0 flex-col gap-4">
        <Panel title="Preview">
          <MainPreview c={c} />
        </Panel>
        <Panel title="Details">
          <DescriptionList
            columns={1}
            items={[
              { label: 'Owner', value: <Person member={c.owner} /> },
              { label: 'Reviewer', value: <Person member={c.reviewer} empty="Not set" /> },
              { label: 'Due', value: <DueText c={c} tz={user.timezone} /> },
              { label: 'Versions', value: <VersionPointers c={c} /> },
              {
                label: 'Review steps',
                value: c.reviewPolicy.steps.map((s) => label('reviewStep', s)).join(' → '),
              },
              { label: 'Language', value: c.language ?? '—' },
              { label: 'Tags', value: c.tags.length ? c.tags.join(', ') : '—' },
              {
                label: 'Planned Account',
                value: c.account ? (c.account.label ?? 'An account outside your access') : '—',
              },
              {
                label: 'Episode',
                value: c.episode ? (c.episode.label ?? 'An episode outside your access') : '—',
              },
              { label: 'Template', value: c.template ? `${c.template.name} v${c.template.versionNo}` : '—' },
              {
                label: 'Duplicated from',
                value: c.duplicatedFrom ? (
                  c.duplicatedFrom.title ? (
                    <Link className="hover:underline" href={wsPath(`/content/${c.duplicatedFrom.id}`)}>
                      {c.duplicatedFrom.title}
                    </Link>
                  ) : (
                    'Content outside your access'
                  )
                ) : null,
                hidden: !c.duplicatedFrom,
              },
              { label: 'Created', value: formatDateTime(c.createdAt, user.timezone) },
            ]}
          />
        </Panel>
        {c.flagHistory.length ? (
          <Panel title="Blocked and paused history">
            <ul className="flex flex-col gap-2 text-[13px]">
              {c.flagHistory.map((f) => (
                <li key={f.id}>
                  <span className="font-semibold">{f.flag === 'blocked' ? 'Blocked' : 'Paused'}</span>{' '}
                  {formatDateTime(f.startedAt, user.timezone)}
                  {f.endedAt ? ` – ${formatDateTime(f.endedAt, user.timezone)}` : ' – now'}: {f.reason}
                  {f.resolution ? <span className="text-fg-2"> · {f.resolution}</span> : null}
                </li>
              ))}
            </ul>
          </Panel>
        ) : null}
      </div>
    </div>
  );
};

const TasksTab = ({ c, onApplyTemplate }: { c: ContentDetail; onApplyTemplate: () => void }) => {
  const { workspace, user } = useWorkspace();
  const can = useCan();
  const { state, set } = useUrlState<'open' | 'create' | 'closed'>();
  const created = useRef<string | null>(null);
  const data = useApiInfinite(taskEndpoints.list, {
    params: { workspaceId: workspace.id },
    query: {
      contentItemId: c.id,
      includeClosed: state.closed === '1' ? true : undefined,
      sort: 'dueAt',
      direction: 'asc',
      pageSize: 50,
    },
  });
  const canCreate = can('tasks.create') && !c.archivedAt;
  const columns: Column<TaskRow>[] = [
    {
      key: 'title',
      header: 'Title',
      sticky: true,
      minWidth: 240,
      cell: (t) => <span className="font-medium text-fg">{t.title}</span>,
    },
    { key: 'assignee', header: 'Assignee', minWidth: 160, cell: (t) => <Person member={t.assignee} /> },
    { key: 'status', header: 'Status', minWidth: 120, cell: (t) => <TaskStatusBadge status={t.status} /> },
    {
      key: 'priority',
      header: 'Priority',
      minWidth: 100,
      cell: (t) => <PriorityBadge priority={t.priority} />,
    },
    {
      key: 'due',
      header: 'Due',
      minWidth: 160,
      cell: (t) => <TaskDue due={t.due} tz={user.timezone} overdue={t.overdue} compact />,
    },
  ];
  return (
    <div className="flex flex-col gap-4">
      <Toolbar>
        <Switch
          label="Show closed"
          checked={state.closed === '1'}
          onCheckedChange={(v) => set({ closed: v ? '1' : null })}
        />
        {canCreate ? (
          <div className="ml-auto flex flex-wrap gap-2">
            {c.permissions.applyTemplate ? (
              <Button icon={<Stack size={14} />} onClick={onApplyTemplate}>
                Apply Template
              </Button>
            ) : null}
            <Button variant="primary" icon={<Plus size={14} />} onClick={() => set({ create: '1' })}>
              New Task
            </Button>
          </div>
        ) : null}
      </Toolbar>
      <QueryState query={data}>
        {data.items.length === 0 && !data.isFetching ? (
          <EmptyState
            icon={<CheckSquare size={28} />}
            title="No open tasks for this content"
            description={
              c.permissions.applyTemplate
                ? 'Apply a content template to create the production tasks, or add tasks one by one.'
                : 'Tasks linked to this content appear here.'
            }
          />
        ) : (
          <DataTable
            caption="Content tasks"
            rows={data.items}
            columns={columns}
            getRowId={(t) => t.id}
            density={user.density}
            onRowClick={(t) => set({ open: t.id })}
            hasMore={data.hasNextPage}
            loadingMore={data.isFetchingNextPage}
            onLoadMore={() => void data.fetchNextPage()}
          />
        )}
      </QueryState>
      <TaskDrawer taskId={state.open} onClose={() => set({ open: null })} />
      <TaskForm
        open={state.create === '1'}
        defaults={{ projectId: c.project.id, contentItemId: c.id, accountId: c.account?.id ?? null }}
        onOpenChange={(o) => {
          if (o) return;
          const id = created.current;
          created.current = null;
          set(id ? { create: null, open: id } : { create: null });
        }}
        onSaved={(id) => (created.current = id)}
      />
    </div>
  );
};

const SlotTab = ({ c, tab }: { c: ContentDetail; tab: 'publications' | 'results' }) => {
  const can = useCan();
  const props = { contentId: c.id, projectId: c.project.id, tab };
  const panels = CONTENT_PANELS.items.filter((p) => !p.visible || p.visible(props, can));
  if (!panels.length)
    return tab === 'publications' ? (
      <EmptyState
        icon={<Megaphone size={28} />}
        title={
          c.publicationCount
            ? `${c.publicationCount} placement${c.publicationCount === 1 ? '' : 's'}`
            : 'No placements yet'
        }
        description="Placements are planned per account in the Calendar. Each placement keeps the exact version it used."
      />
    ) : (
      <EmptyState
        icon={<ChartLineUp size={28} />}
        title="No results yet"
        description="No data recorded for this period. Results are recorded per placement after publication."
      />
    );
  return (
    <div className="flex flex-col gap-4">
      {panels.map((p) => (
        <section key={p.key} aria-label={p.label}>
          <p.component {...props} />
        </section>
      ))}
    </div>
  );
};

const ActivityTab = ({ c }: { c: ContentDetail }) => {
  const { workspace, user } = useWorkspace();
  const q = useApiInfinite(contentEndpoints.activity, {
    params: { workspaceId: workspace.id, contentId: c.id },
    query: {},
  });
  return (
    <QueryState query={q}>
      {q.items.length === 0 ? (
        <EmptyState
          title="No activity yet"
          description="Stage changes, versions, decisions and assignments appear here."
        />
      ) : (
        <div className="flex flex-col gap-3">
          <ol className="flex flex-col divide-y divide-line rounded-[12px] border border-line bg-surface">
            {q.items.map((a) => (
              <li key={a.id} className="flex flex-col gap-1 px-4 py-3 text-[14px]">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-fg">
                    {ACTIVITY_LABELS[a.action] ?? humanize(a.action.split('.').pop() ?? a.action)}
                  </span>
                  <span className="text-[12px] text-fg-2">
                    {a.actorName ?? 'System'} · {formatDateTime(a.occurredAt, user.timezone)}
                  </span>
                </span>
                {a.changes
                  .filter((ch) => ch.field === 'stage')
                  .map((ch) => (
                    <span key={ch.field} className="text-[13px] text-fg-2">
                      {label('contentStage', String(ch.from ?? ''))} →{' '}
                      {label('contentStage', String(ch.to ?? ''))}
                    </span>
                  ))}
                {a.metadata && typeof a.metadata.versionNo === 'number' ? (
                  <span className="text-[13px] text-fg-2">Version {a.metadata.versionNo}</span>
                ) : null}
                {a.reason ? <span className="text-[13px] text-fg-2">{a.reason}</span> : null}
              </li>
            ))}
          </ol>
          {q.hasNextPage ? (
            <div className="flex justify-center">
              <Button onClick={() => void q.fetchNextPage()} loading={q.isFetchingNextPage}>
                Load More
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </QueryState>
  );
};

/** Archive Content with a preview of open obligations (scheduled placements block; pending reviews are cancelled). */
const ArchiveDialog = ({
  open,
  onOpenChange,
  c,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  c: ContentDetail;
}) => {
  const { workspace } = useWorkspace();
  const [preview, setPreview] = useState<EntityPreview | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const previewM = useApiMutation(archiveEndpoints.archivePreview, { silentErrors: true });
  const archive = useApiMutation(archiveEndpoints.archive, {
    invalidate: ['content.', 'archive.', 'reviews.'],
    silentErrors: true,
  });
  const item = preview?.items[0];
  const load = async () => {
    setError(null);
    try {
      setPreview(
        await previewM.run({
          params: { workspaceId: workspace.id },
          body: { targets: [{ entityType: 'content_item', entityId: c.id }] },
        }),
      );
    } catch (e) {
      setError(isApiError(e) ? e.message : 'The preview could not be loaded.');
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (o) void load();
        else {
          setPreview(null);
          setReason('');
        }
        onOpenChange(o);
      }}
      title="Archive Content?"
      description="Archived records remain available in historical reports."
      size="small"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="danger"
            disabled={!preview || item?.status !== 'ok'}
            loading={archive.isPending}
            onClick={async () => {
              setError(null);
              try {
                const r = await archive.run({
                  params: { workspaceId: workspace.id },
                  body: { previewToken: preview!.token, reason: reason.trim() || undefined },
                });
                if (r.failed.length) setError(r.failed[0]!.message);
                else {
                  toast.success('Content archived');
                  onOpenChange(false);
                }
              } catch (e) {
                setError(isApiError(e) ? e.message : 'The content could not be archived.');
              }
            }}
          >
            Archive Content
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-[14px]">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        {!preview && !error ? <p className="text-fg-2">Checking open obligations…</p> : null}
        {item?.message ? (
          <Banner tone={item.status === 'ok' ? 'info' : 'warning'}>{item.message}</Banner>
        ) : null}
        {item?.items.length ? (
          <ul className="flex flex-col gap-1">
            {item.items.map((i) => (
              <li key={i.kind} className="flex flex-wrap items-center gap-2">
                <Badge tone={i.blocking ? 'danger' : 'neutral'}>{i.count}</Badge> {i.label}
                {i.resolution ? <span className="text-[12px] text-fg-2">{i.resolution}</span> : null}
              </li>
            ))}
          </ul>
        ) : preview ? (
          <p className="text-fg-2">No open obligations.</p>
        ) : null}
        <Field label="Reason (optional)">
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={LIMITS.reasonMax} />
        </Field>
      </div>
    </Dialog>
  );
};

/** S24 Content Detail: brief, tasks, versions, placements, results and activity of one content item. */
export const ContentDetailScreen = ({ contentId }: { contentId: string }) => {
  const { workspace } = useWorkspace();
  const can = useCan();
  const wsPath = useWsPath();
  const router = useRouter();
  const { state, set } = useUrlState<'tab' | 'version' | 'action'>({ tab: 'brief' });
  const q = useApiQuery(contentEndpoints.get, { params: { workspaceId: workspace.id, contentId } });
  const move = useApiMutation(contentEndpoints.transition, {
    invalidate: ['content.', 'reviews.'],
    silentErrors: true,
  });
  const restoreM = useApiMutation(archiveEndpoints.restore, {
    invalidate: ['content.', 'archive.'],
    silentErrors: true,
  });
  const restorePreview = useApiMutation(archiveEndpoints.restorePreview, { silentErrors: true });
  const [dialog, setDialog] = useState<
    null | 'template' | 'duplicate' | 'blocked' | 'paused' | 'download' | 'archive' | 'revision'
  >(null);
  const [revisionReason, setRevisionReason] = useState('');
  // Deep link from other screens (e.g. Series Structure "Generate Production Tasks").
  const canApplyTemplate = !!q.data?.permissions.applyTemplate;
  useEffect(() => {
    if (state.action !== 'apply-template' || !q.data) return;
    if (canApplyTemplate) setDialog('template');
    set({ action: null });
  }, [state.action, q.data, canApplyTemplate, set]);

  const runMove = async (c: ContentDetail, to: string, reason?: string) => {
    try {
      const r = await move.run(
        {
          params: { workspaceId: workspace.id, contentId: c.id },
          body: { targetStage: to as ContentDetail['stage'], reason },
        },
        { ifMatch: c.rowVersion },
      );
      toast.success(`Moved to ${label('contentStage', to)}`);
      for (const w of r.warnings) toast.info(w);
      setDialog(null);
    } catch (e) {
      toast.error(
        isApiError(e)
          ? e.code === 'VERSION_CONFLICT'
            ? 'This record changed while you were editing it. It was reloaded; try again.'
            : e.message
          : 'The content could not be moved.',
      );
      if (isApiError(e) && e.code === 'VERSION_CONFLICT') void q.refetch();
    }
  };

  return (
    <QueryState query={q}>
      {q.data
        ? (() => {
            const c = q.data;
            const tab = (
              ['brief', 'tasks', 'versions', 'publications', 'results', 'activity'] as Tab[]
            ).includes(state.tab as Tab)
              ? (state.tab as Tab)
              : 'brief';
            const moves = c.allowedMoves.filter((s) => !(c.stage === 'approved' && s === 'production'));
            const menu: MenuItem[] = [
              ...moves.map((s) => ({
                label: `Move to ${label('contentStage', s)}`,
                onSelect: () => void runMove(c, s),
              })),
              {
                label: 'Start New Revision',
                hidden: !(c.stage === 'approved' && c.allowedMoves.includes('production')),
                onSelect: () => {
                  setRevisionReason('');
                  setDialog('revision');
                },
              },
              {
                label: c.blocked ? 'Unblock' : 'Mark as Blocked',
                hidden: !c.permissions.flag,
                separatorBefore: true,
                onSelect: () => setDialog('blocked'),
              },
              {
                label: c.paused ? 'Resume' : 'Pause',
                hidden: !c.permissions.flag,
                onSelect: () => setDialog('paused'),
              },
              {
                label: 'Apply Template',
                hidden: !c.permissions.applyTemplate,
                onSelect: () => setDialog('template'),
              },
              {
                label: 'Duplicate as New Draft',
                hidden: !c.permissions.duplicate,
                onSelect: () => setDialog('duplicate'),
              },
              {
                label: 'Download Approved',
                hidden: !c.approvedVersion || c.approvedVersion.revoked || !c.permissions.download,
                onSelect: () => setDialog('download'),
              },
              {
                label: 'Add Publication',
                hidden: !c.approvedVersion || c.approvedVersion.revoked || !can('publications.write'),
                href: wsPath(`/publications/new?contentId=${c.id}`),
              },
              {
                label: 'Open Review',
                hidden: !c.activeReview,
                href: c.activeReview ? wsPath(`/reviews/${c.activeReview.id}`) : undefined,
              },
              {
                label: 'Archive Content',
                destructive: true,
                separatorBefore: true,
                hidden: !c.permissions.archive || !!c.archivedAt,
                onSelect: () => setDialog('archive'),
              },
              {
                label: 'Restore Content',
                hidden: !c.permissions.archive || !c.archivedAt,
                onSelect: async () => {
                  try {
                    const p = await restorePreview.run({
                      params: { workspaceId: workspace.id },
                      body: { targets: [{ entityType: 'content_item', entityId: c.id, state: 'archived' }] },
                    });
                    if (p.items[0]?.status !== 'ok') {
                      toast.error(p.items[0]?.message ?? 'The content cannot be restored now.');
                      return;
                    }
                    await restoreM.run({
                      params: { workspaceId: workspace.id },
                      body: { previewToken: p.token },
                    });
                    toast.success('Content restored');
                  } catch (e) {
                    toast.error(isApiError(e) ? e.message : 'The content could not be restored.');
                  }
                },
              },
            ];
            const primary =
              c.activeReview && c.permissions.approve ? (
                <Button
                  variant="primary"
                  onClick={() => router.push(wsPath(`/reviews/${c.activeReview!.id}`))}
                >
                  Open Review
                </Button>
              ) : c.permissions.upload && ['ready', 'production', 'changes_requested'].includes(c.stage) ? (
                <Button
                  variant="primary"
                  icon={<UploadSimple size={14} />}
                  onClick={() => set({ tab: 'versions' })}
                >
                  {c.draftVersion ? 'Continue Version' : 'Upload Version'}
                </Button>
              ) : null;
            return (
              <div className="flex flex-col gap-5">
                <PageHeader
                  crumbs={[
                    { label: 'Content', href: wsPath('/content') },
                    { label: c.project.name, href: wsPath(`/projects/${c.project.id}`) },
                    { label: c.title },
                  ]}
                  title={c.title}
                  meta={
                    <>
                      <StageBadge stage={c.stage} />
                      <ContentFlags c={c} />
                      <Badge>{label('contentFormat', c.format)}</Badge>
                      <VersionPointers c={c} />
                    </>
                  }
                  actions={
                    <>
                      {primary}
                      {c.permissions.edit ? (
                        <Button
                          icon={<PencilSimple size={14} />}
                          onClick={() => router.push(wsPath(`/content/${c.id}/edit`))}
                        >
                          Edit
                        </Button>
                      ) : null}
                      {menu.some((m) => !m.hidden) ? (
                        <Menu
                          label="More content actions"
                          trigger={
                            <IconButton
                              label="More content actions"
                              icon={<DotsThree size={18} weight="bold" />}
                              variant="secondary"
                            />
                          }
                          items={menu}
                        />
                      ) : null}
                    </>
                  }
                />
                {c.archivedAt ? (
                  <Banner tone="info">Archived records remain available in historical reports.</Banner>
                ) : null}
                {c.stage === 'changes_requested' && c.permissions.upload ? (
                  <Banner tone="warning">
                    Changes were requested. Upload a new version with the fixes and submit it again; the
                    review history stays with the earlier version.
                  </Banner>
                ) : null}
                {c.newerVersionAwaitingReview ? (
                  <Banner tone="info">
                    A newer version is awaiting review. Existing placements keep using the approved version.
                  </Banner>
                ) : null}
                {c.needsConsistencyReview ? (
                  <Banner tone="warning">
                    A character profile changed after this content was made. Check the content for
                    consistency.
                  </Banner>
                ) : null}
                <Tabs
                  label="Content sections"
                  value={tab}
                  onValueChange={(v) => set({ tab: v, version: null })}
                  items={[
                    { value: 'brief', label: 'Brief' },
                    { value: 'tasks', label: 'Tasks', count: c.counts.openTasks },
                    { value: 'versions', label: 'Versions', count: c.counts.versions },
                    { value: 'publications', label: 'Publications', count: c.counts.publications },
                    { value: 'results', label: 'Results' },
                    { value: 'activity', label: 'Activity' },
                  ]}
                >
                  <TabPanel value="brief">
                    {tab === 'brief' ? <BriefTab c={c} onMove={(to) => void runMove(c, to)} /> : null}
                  </TabPanel>
                  <TabPanel value="tasks">
                    {tab === 'tasks' ? (
                      <TasksTab c={c} onApplyTemplate={() => setDialog('template')} />
                    ) : null}
                  </TabPanel>
                  <TabPanel value="versions">
                    {tab === 'versions' ? <VersionsTab content={c} /> : null}
                  </TabPanel>
                  <TabPanel value="publications">
                    {tab === 'publications' ? <SlotTab c={c} tab="publications" /> : null}
                  </TabPanel>
                  <TabPanel value="results">
                    {tab === 'results' ? <SlotTab c={c} tab="results" /> : null}
                  </TabPanel>
                  <TabPanel value="activity">{tab === 'activity' ? <ActivityTab c={c} /> : null}</TabPanel>
                </Tabs>
                <ApplyTemplateDialog
                  open={dialog === 'template'}
                  onOpenChange={(o) => setDialog(o ? 'template' : null)}
                  content={c}
                />
                <DuplicateDialog
                  open={dialog === 'duplicate'}
                  onOpenChange={(o) => setDialog(o ? 'duplicate' : null)}
                  content={c}
                />
                {dialog === 'blocked' || dialog === 'paused' ? (
                  <FlagDialog open onOpenChange={(o) => !o && setDialog(null)} content={c} flag={dialog} />
                ) : null}
                <DownloadApprovedDialog
                  open={dialog === 'download'}
                  onOpenChange={(o) => setDialog(o ? 'download' : null)}
                  content={c}
                />
                <ArchiveDialog
                  open={dialog === 'archive'}
                  onOpenChange={(o) => setDialog(o ? 'archive' : null)}
                  c={c}
                />
                <Dialog
                  open={dialog === 'revision'}
                  onOpenChange={(o) => !o && setDialog(null)}
                  title="Start a new revision?"
                  description="The approved version stays pinned for existing placements. The new version needs its own review."
                  size="small"
                  dirty={revisionReason.trim().length > 0}
                  footer={
                    <>
                      <Button onClick={() => setDialog(null)}>Cancel</Button>
                      <Button
                        variant="primary"
                        loading={move.isPending}
                        disabled={revisionReason.trim().length < 3}
                        onClick={() => void runMove(c, 'production', revisionReason.trim())}
                      >
                        Start New Revision
                      </Button>
                    </>
                  }
                >
                  <Field label="Reason" required>
                    <Textarea
                      value={revisionReason}
                      onChange={(e) => setRevisionReason(e.target.value)}
                      maxLength={LIMITS.reasonMax}
                    />
                  </Field>
                </Dialog>
              </div>
            );
          })()
        : null}
    </QueryState>
  );
};
