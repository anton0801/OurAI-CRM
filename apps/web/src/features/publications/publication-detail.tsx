'use client';
import { ArrowSquareOut, DotsThree, File, PencilSimple } from '@phosphor-icons/react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { mediaEndpoints, publicationEndpoints as P, type PublicationDetail } from '@castlane/api-contracts';
import { isSafeUrl } from '@castlane/domain';
import {
  Avatar,
  Badge,
  Banner,
  Button,
  ConfirmDialog,
  DataTable,
  DescriptionList,
  IconButton,
  Menu,
  PageHeader,
  Panel,
  StatusBadge,
  TabPanel,
  Tabs,
  Textarea,
  Field,
  formatBytes,
  formatDateTime,
  type MenuItem,
} from '@castlane/ui';
import { QueryState } from '@/components/common/query-state';
import { AssetThumb } from '@/components/media/file-uploader';
import { useApiInfinite, useApiMutation, useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useUrlState } from '@/lib/url-state';
import { useCan, useWorkspace, useWsPath } from '@/lib/workspace-context';
import { ExternalLink, PlatformLabel } from '@/features/accounts/platform';
import { PublicationBadges } from './format';
import { ARCHIVE_EXPLANATION, PUBLICATION_INVALIDATE, SCHEDULED_NOTE } from './labels';
import { AvailabilityDialog, CorrectDialog, MarkPublishedDialog, ReasonDialog, ScheduleDialog } from './publication-dialogs';
import { PublicationEditDrawer } from './publication-editor';

type DialogKind = 'schedule' | 'publish' | 'fail' | 'cancel' | 'correct' | 'availability' | 'edit' | 'archive' | null;

/** S32 Publication Detail: facts, plan history, checkpoints, approved files and every command of §12. */
export const PublicationDetailScreen = ({ publicationId }: { publicationId: string }) => {
  const { workspace } = useWorkspace();
  const q = useApiQuery(P.get, { params: { workspaceId: workspace.id, publicationId } });
  return <QueryState query={q}>{q.data ? <PublicationView p={q.data} /> : null}</QueryState>;
};

const PublicationView = ({ p }: { p: PublicationDetail }) => {
  const { workspace, user } = useWorkspace();
  const wsPath = useWsPath();
  const router = useRouter();
  const can = useCan();
  const { state, set } = useUrlState<'tab'>({ tab: 'overview' });
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [archiveReason, setArchiveReason] = useState('');
  const archive = useApiMutation(P.archive, { invalidate: PUBLICATION_INVALIDATE, successMessage: 'Publication archived' });
  const acts = new Set(p.allowedActions);
  const perm = p.permissions;
  const primary: { label: string; kind: DialogKind; variant?: 'primary' }[] = [];
  if (acts.has('markPublished') && perm.confirm) primary.push({ label: 'Mark Published', kind: 'publish', variant: 'primary' });
  if (acts.has('schedule') && perm.schedule) primary.push({ label: 'Schedule', kind: 'schedule', variant: 'primary' });
  if (acts.has('retry') && perm.schedule) primary.push({ label: 'Retry Planning', kind: 'schedule', variant: 'primary' });
  if (acts.has('reschedule') && perm.schedule) primary.push({ label: 'Reschedule', kind: 'schedule' });
  if (acts.has('correct') && perm.correct) primary.push({ label: 'Correct Publication', kind: 'correct' });
  const menu: MenuItem[] = [
    { label: 'Edit', onSelect: () => setDialog('edit'), hidden: !perm.update },
    { label: 'Mark Failed', onSelect: () => setDialog('fail'), hidden: !(acts.has('fail') && perm.confirm) },
    { label: 'Cancel Publication', onSelect: () => setDialog('cancel'), hidden: !(acts.has('cancel') && perm.schedule), destructive: true },
    { label: 'Post Availability', onSelect: () => setDialog('availability'), hidden: !(acts.has('setAvailability') && perm.confirm) },
    { label: 'Add Metrics', href: wsPath(`/metrics/new?publicationId=${p.id}`), hidden: !perm.addMetrics, separatorBefore: true },
    { label: 'Archive', onSelect: () => setDialog('archive'), hidden: !perm.archive, separatorBefore: true },
  ];
  const moreItems: MenuItem[] = [...primary.slice(2).map((a) => ({ label: a.label, onSelect: () => setDialog(a.kind) })), ...menu];
  const tabs = [
    { value: 'overview', label: 'Overview' },
    { value: 'history', label: 'Plan & Corrections', count: p.planRevisions.length + p.corrections.length },
    { value: 'activity', label: 'Activity' },
  ];
  const active = tabs.some((t) => t.value === state.tab) ? state.tab! : 'overview';

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        crumbs={[
          { label: 'Calendar', href: wsPath('/calendar') },
          { label: p.account.label, href: wsPath(`/accounts/${p.account.id}?tab=publications`) },
          { label: p.title },
        ]}
        title={p.title}
        meta={
          <>
            <PublicationBadges p={p} />
            <span className="inline-flex items-center gap-1.5 text-[13px] text-fg-2">
              <PlatformLabel platform={p.account.platform} iconOnly />
              <Link href={wsPath(`/accounts/${p.account.id}`)} className="hover:underline">
                {p.account.label}
              </Link>
            </span>
            <Link href={wsPath(`/projects/${p.project.id}`)} className="text-[13px] text-fg-2 hover:underline">
              {p.project.name}
            </Link>
            <span className="flex items-center gap-1.5 text-[13px] text-fg-2">
              <Avatar name={p.owner.displayName} src={p.owner.avatarUrl} size={24} decorative /> {p.owner.displayName}
            </span>
          </>
        }
        actions={
          <>
            {isSafeUrl(p.account.url) ? (
              <a
                href={p.account.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex h-11 items-center gap-2 rounded-[8px] border border-line bg-surface px-[14px] text-[13px] font-semibold text-fg hover:bg-surface-2 md:h-9"
              >
                <ArrowSquareOut size={14} aria-hidden /> Open Account<span className="sr-only"> (opens in a new tab)</span>
              </a>
            ) : null}
            {primary.slice(0, 2).map((a) => (
              <Button key={a.label} variant={a.variant ?? 'secondary'} onClick={() => setDialog(a.kind)}>
                {a.label}
              </Button>
            ))}
            {perm.update && primary.length === 0 ? (
              <Button icon={<PencilSimple size={14} />} onClick={() => setDialog('edit')}>
                Edit
              </Button>
            ) : null}
            {moreItems.some((m) => !m.hidden) ? (
              <Menu label="More publication actions" trigger={<IconButton label="More publication actions" icon={<DotsThree size={18} weight="bold" />} variant="secondary" />} items={moreItems} />
            ) : null}
          </>
        }
      />
      {p.archivedAt ? <Banner tone="info">{ARCHIVE_EXPLANATION}</Banner> : null}
      {p.status === 'scheduled' ? <Banner tone={p.awaitingConfirmation ? 'warning' : 'info'}>{p.awaitingConfirmation ? `The planned time has passed. ${SCHEDULED_NOTE}` : SCHEDULED_NOTE}</Banner> : null}
      {p.status === 'draft' && !p.contentVersion?.approved ? <Banner tone="info">This draft has no approved version yet. It can be scheduled once the content is approved.</Banner> : null}
      {p.status === 'failed' && p.failureReason ? <Banner tone="danger">Failed: {p.failureReason}</Banner> : null}
      {p.status === 'cancelled' && p.cancelReason ? <Banner tone="info">Cancelled: {p.cancelReason}</Banner> : null}
      {p.availability !== 'available' ? (
        <Banner tone="warning">
          {label('publicationAvailability', p.availability)} since {formatDateTime(p.availabilityChangedAt, user.timezone)}: {p.availabilityReason}. Published facts and recorded metrics are kept.
        </Banner>
      ) : null}
      <Tabs label="Publication sections" value={active} onValueChange={(v) => set({ tab: v })} items={tabs}>
        <TabPanel value="overview">{active === 'overview' ? <Overview p={p} /> : null}</TabPanel>
        <TabPanel value="history">{active === 'history' ? <History p={p} /> : null}</TabPanel>
        <TabPanel value="activity">{active === 'activity' ? <Activity id={p.id} /> : null}</TabPanel>
      </Tabs>
      <ScheduleDialog publication={p} open={dialog === 'schedule'} onOpenChange={(o) => setDialog(o ? 'schedule' : null)} />
      <MarkPublishedDialog publication={p} open={dialog === 'publish'} onOpenChange={(o) => setDialog(o ? 'publish' : null)} />
      <ReasonDialog publication={p} kind="fail" open={dialog === 'fail'} onOpenChange={(o) => setDialog(o ? 'fail' : null)} />
      <ReasonDialog publication={p} kind="cancel" open={dialog === 'cancel'} onOpenChange={(o) => setDialog(o ? 'cancel' : null)} />
      <CorrectDialog publication={p} open={dialog === 'correct'} onOpenChange={(o) => setDialog(o ? 'correct' : null)} />
      <AvailabilityDialog publication={p} open={dialog === 'availability'} onOpenChange={(o) => setDialog(o ? 'availability' : null)} />
      <PublicationEditDrawer publication={p} open={dialog === 'edit'} onOpenChange={(o) => setDialog(o ? 'edit' : null)} />
      <ConfirmDialog
        open={dialog === 'archive'}
        onOpenChange={(o) => setDialog(o ? 'archive' : null)}
        title="Archive publication?"
        body={`${ARCHIVE_EXPLANATION} The placement disappears from active lists and the calendar.`}
        confirmLabel="Archive"
        loading={archive.isPending}
        onConfirm={async () => {
          try {
            await archive.run({ params: { workspaceId: workspace.id, publicationId: p.id }, body: { reason: archiveReason.trim() || undefined } }, { ifMatch: p.rowVersion });
            setDialog(null);
            router.refresh();
          } catch {
            /* error toast shown by the mutation */
          }
        }}
      >
        <Field label="Reason (optional)">
          <Textarea value={archiveReason} onChange={(e) => setArchiveReason(e.target.value)} rows={2} />
        </Field>
      </ConfirmDialog>
    </div>
  );
};

const Overview = ({ p }: { p: PublicationDetail }) => {
  const { user } = useWorkspace();
  const wsPath = useWsPath();
  const can = useCan();
  const tz = user.timezone;
  const zoneNote = (iso: string | null) => (iso ? `${formatDateTime(iso, tz)} (${tz})${p.scheduleTimezone && p.scheduleTimezone !== tz ? ` · ${formatDateTime(iso, p.scheduleTimezone)} (${p.scheduleTimezone})` : ''}` : null);
  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
      <div className="flex min-w-0 flex-col gap-4 xl:col-span-2">
        <Panel title="Placement">
          <DescriptionList
            items={[
              { label: 'Content', value: p.title },
              { label: 'Version', value: p.contentVersion ? `Version ${p.contentVersion.versionNo}${p.contentVersion.approvalRevoked ? ' (approval revoked)' : p.contentVersion.approved ? ' (approved)' : ' (not approved)'}` : null },
              { label: 'Account', value: <ExternalLink href={p.account.url}>{p.account.label}</ExternalLink> },
              { label: 'Owner', value: p.owner.displayName },
              { label: p.status === 'draft' ? 'Tentative time' : 'Scheduled at', value: zoneNote(p.scheduledAt) },
              { label: 'First scheduled for', value: p.originalScheduledAt && p.originalScheduledAt !== p.scheduledAt ? zoneNote(p.originalScheduledAt) : null, hidden: !p.originalScheduledAt || p.originalScheduledAt === p.scheduledAt },
              { label: 'Actual published at', value: zoneNote(p.actualPublishedAt), hidden: !p.actualPublishedAt },
              { label: 'External post URL', value: p.externalPostUrl ? <ExternalLink href={p.externalPostUrl} /> : p.noUrlReason ? <span className="text-warning">URL Missing — {p.noUrlReason}</span> : null, hidden: p.status !== 'published' },
              { label: 'Confirmed by', value: p.confirmedBy?.displayName ?? null, hidden: !p.confirmedBy },
              { label: 'Primary campaign', value: p.primaryCampaign ? <Link href={wsPath(`/campaigns/${p.primaryCampaign.id}`)} className="text-primary hover:underline">{p.primaryCampaign.name}</Link> : null },
              { label: 'Descriptive tags', value: p.descriptiveTags.length ? <span className="flex flex-wrap gap-1">{p.descriptiveTags.map((t) => <Badge key={t}>{t}</Badge>)}</span> : null },
              { label: 'Call to action', value: p.cta },
              { label: 'Destination URL', value: p.destinationUrl ? <ExternalLink href={p.destinationUrl} /> : null },
              { label: 'Override reason', value: p.overrideReason, hidden: !p.overrideReason },
              { label: 'Source note', value: p.sourceNote, hidden: !p.sourceNote },
            ]}
          />
          <div className="mt-4">
            <h3 className="text-[12px] font-[550] text-fg-2">Caption{p.captionLimit ? ` · internal limit ${p.captionLimit} characters` : ''}</h3>
            {p.caption ? <p className="mt-1 whitespace-pre-wrap text-[15px] leading-6 text-fg">{p.caption}</p> : <p className="mt-1 text-[14px] text-fg-muted">No caption.</p>}
          </div>
        </Panel>
        <Panel title="Metric checkpoints" description="Created once when the post is confirmed; windows are elapsed time in UTC.">
          {p.checkpoints.length === 0 ? (
            <p className="text-[14px] text-fg-2">{p.status === 'published' ? 'No checkpoints.' : 'Checkpoints (24h and 7d) are created when the publication is marked published.'}</p>
          ) : (
            <DataTable
              caption="Metric checkpoints"
              rows={p.checkpoints}
              getRowId={(c) => c.id}
              density={user.density}
              columns={[
                { key: 'label', header: 'Checkpoint', sticky: true, minWidth: 110, cell: (c) => c.label },
                { key: 'expected', header: 'Expected', minWidth: 170, cell: (c) => formatDateTime(c.expectedAt, tz) },
                { key: 'window', header: 'Target window', minWidth: 260, cell: (c) => `${formatDateTime(c.windowStart, tz)} – ${formatDateTime(c.windowEnd, tz)}` },
                { key: 'state', header: 'State', minWidth: 120, cell: (c) => <StatusBadge status={c.state} label={label('checkpointState', c.state)} /> },
                { key: 'timing', header: 'Timing', minWidth: 120, cell: (c) => (c.timing ? <StatusBadge status={c.timing === 'on_time' ? 'completed' : 'late'} label={c.timing === 'on_time' ? 'On time' : 'Recorded outside the target window'} /> : <span className="text-fg-muted">—</span>) },
                { key: 'assignee', header: 'Assignee', minWidth: 150, cell: (c) => c.assignee?.displayName ?? <span className="text-fg-muted">Unassigned</span> },
              ]}
            />
          )}
          {p.checkpoints.length && can('metrics.read') ? (
            <p className="mt-3 text-[13px]">
              <Link className="text-primary hover:underline" href={wsPath(`/metrics?publicationId=${p.id}`)}>
                Open in Metrics Inbox
              </Link>
            </p>
          ) : null}
        </Panel>
      </div>
      <div className="flex min-w-0 flex-col gap-4">
        <FilesPanel id={p.id} />
        <Panel title="Linked work">
          <div className="flex flex-col gap-3 text-[14px]">
            {p.tasks.length ? (
              <ul className="flex flex-col gap-1">
                {p.tasks.map((t) => (
                  <li key={t.id} className="flex items-center justify-between gap-2">
                    <Link href={wsPath(`/tasks/${t.id}`)} className="truncate hover:underline">
                      {t.title}
                    </Link>
                    <StatusBadge status={t.status} label={label('taskStatus', t.status)} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-fg-2">No tasks are linked.</p>
            )}
            {p.trackingLinks.length ? (
              <div>
                <h3 className="text-[12px] font-[550] text-fg-2">Tracking links</h3>
                <ul className="mt-1 flex flex-col gap-1">
                  {p.trackingLinks.map((l) => (
                    <li key={l.id} className="min-w-0">
                      <Link href={wsPath(`/campaigns/${l.campaignId}?tab=links`)} className="hover:underline">
                        {l.label}
                      </Link>
                      <p className="break-all text-[12px] text-fg-2">{l.builtUrl}</p>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {p.experiments.length ? (
              <div>
                <h3 className="text-[12px] font-[550] text-fg-2">Experiments</h3>
                <ul className="mt-1 flex flex-col gap-1">
                  {p.experiments.map((e) => (
                    <li key={e.id}>
                      <Link href={wsPath(`/experiments/${e.id}`)} className="hover:underline">
                        {e.hypothesis}
                      </Link>
                      <span className="text-[12px] text-fg-2"> · {e.variantName} · {label('segment', e.segment)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </Panel>
      </div>
    </div>
  );
};

const FilesPanel = ({ id }: { id: string }) => {
  const { workspace } = useWorkspace();
  const wsPath = useWsPath();
  const q = useApiQuery(mediaEndpoints.entityFiles, { params: { workspaceId: workspace.id, entityType: 'publication', entityId: id } });
  return (
    <Panel title="Approved files" description="The files of the pinned version. Published placements hold their exact versions.">
      <QueryState query={q}>
        {q.data && q.data.length ? (
          <ul className="flex flex-col gap-2">
            {q.data.map((a) => (
              <li key={a.linkId} className="flex items-center gap-3 rounded-[8px] border border-line p-2">
                {a.thumbnailUrl ? (
                  <AssetThumb workspaceId={workspace.id} assetId={a.id} size={64} className="h-12 w-12 shrink-0" />
                ) : (
                  <span aria-hidden className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[8px] bg-surface-2 text-fg-2">
                    <File size={20} />
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <Link href={wsPath(`/library/assets/${a.id}`)} className="block truncate text-[14px] text-fg hover:underline">
                    {a.restrictedHidden ? 'Restricted media' : a.name}
                  </Link>
                  <p className="text-[12px] text-fg-2">
                    {a.currentVersion ? formatBytes(a.currentVersion.byteSize) : 'No stored version'}
                    {a.holding ? ' · held by this publication' : ''}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[14px] text-fg-2">No files are linked yet. Scheduling links the files of the approved version.</p>
        )}
      </QueryState>
    </Panel>
  );
};

const History = ({ p }: { p: PublicationDetail }) => {
  const { user } = useWorkspace();
  const tz = user.timezone;
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Panel title="Plan revisions" description="Every move of the planned time with its reason; the first promise stays visible.">
        {p.planRevisions.length === 0 ? (
          <p className="text-[14px] text-fg-2">Not scheduled yet.</p>
        ) : (
          <ol className="flex flex-col gap-3">
            {p.planRevisions.map((r) => (
              <li key={r.id} className="border-l-2 border-line pl-3">
                <p className="text-[14px] text-fg">
                  {r.fromScheduledAt ? `${formatDateTime(r.fromScheduledAt, tz)} → ` : ''}
                  {r.toScheduledAt ? formatDateTime(r.toScheduledAt, tz) : '—'} <span className="text-fg-2">({tz})</span>
                </p>
                <p className="text-[12px] text-fg-2">
                  {r.reason} · {r.actorName ?? 'Unknown'} · {formatDateTime(r.changedAt, tz)}
                </p>
              </li>
            ))}
          </ol>
        )}
      </Panel>
      <Panel title="Corrections" description="Historical corrections keep the previous values.">
        {p.corrections.length === 0 ? (
          <p className="text-[14px] text-fg-2">No corrections.</p>
        ) : (
          <ol className="flex flex-col gap-3">
            {p.corrections.map((c) => (
              <li key={c.id} className="border-l-2 border-line pl-3">
                <p className="text-[14px] text-fg">{c.reason}</p>
                <ul className="mt-1 text-[12px] text-fg-2">
                  {Object.keys(c.after).map((k) => (
                    <li key={k} className="break-all">
                      {k}: {String(c.before[k] ?? '—')} → {String(c.after[k] ?? '—')}
                    </li>
                  ))}
                </ul>
                <p className="text-[12px] text-fg-2">
                  {c.actorName ?? 'Unknown'} · {formatDateTime(c.createdAt, tz)}
                </p>
              </li>
            ))}
          </ol>
        )}
      </Panel>
    </div>
  );
};

const Activity = ({ id }: { id: string }) => {
  const { workspace, user } = useWorkspace();
  const q = useApiInfinite(P.activity, { params: { workspaceId: workspace.id, publicationId: id }, query: {} });
  return (
    <Panel title="Activity">
      <QueryState query={q}>
        {q.items.length === 0 ? (
          <p className="text-[14px] text-fg-2">No activity yet.</p>
        ) : (
          <ol className="flex flex-col gap-3">
            {q.items.map((a) => (
              <li key={a.id} className="text-[14px]">
                <p className="text-fg">
                  {a.actorName ?? 'System'} · {a.action.replace(/^publication\./, '').replace(/_/g, ' ')}
                </p>
                {a.reason ? <p className="text-[13px] text-fg-2">{a.reason}</p> : null}
                <p className="text-[12px] text-fg-muted">{formatDateTime(a.occurredAt, user.timezone)}</p>
              </li>
            ))}
          </ol>
        )}
        {q.hasNextPage ? (
          <div className="mt-3 flex justify-center">
            <Button onClick={() => void q.fetchNextPage()} loading={q.isFetchingNextPage}>
              Load More
            </Button>
          </div>
        ) : null}
      </QueryState>
    </Panel>
  );
};
