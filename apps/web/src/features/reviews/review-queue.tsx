'use client';
import { ArrowSquareOut, CheckSquareOffset, DotsThree, FilmSlate, UserCircle } from '@phosphor-icons/react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { reviewEndpoints, type ReviewQueueRow } from '@castlane/api-contracts';
import { CONTENT_FORMATS, REVIEW_STATUSES } from '@castlane/domain';
import {
  Badge,
  Button,
  DataTable,
  EmptyState,
  IconButton,
  Input,
  Menu,
  MultiSelect,
  NoResults,
  PageHeader,
  Select,
  StatusBadge,
  Switch,
  TabPanel,
  Tabs,
  Toolbar,
  formatDateTime,
  type Column,
  type SelectionState,
} from '@castlane/ui';
import { EntitySelect } from '@/components/common/entity-select';
import { MemberSelect } from '@/components/common/pickers';
import { QueryState } from '@/components/common/query-state';
import { useDebounced } from '@/components/common/use-debounced';
import { useApiInfinite } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useUrlState } from '@/lib/url-state';
import { useWorkspace, useWsPath } from '@/lib/workspace-context';
import { Person } from '../content/format';
import '../content/labels';
import { AssignReviewerDialog, RequestChangesDialog, type ReviewTarget } from './review-dialogs';

type Filters =
  | 'scope'
  | 'q'
  | 'projectId'
  | 'format'
  | 'reviewerMembershipId'
  | 'waiting'
  | 'overdue'
  | 'status'
  | 'type'
  | 'sort';

const WAITING_OPTIONS = [
  { value: '24', label: 'Waiting over 24 hours' },
  { value: '48', label: 'Waiting over 2 days' },
  { value: '72', label: 'Waiting over 3 days' },
  { value: '168', label: 'Waiting over a week' },
];

const SORT_OPTIONS = [
  { value: 'waiting', label: 'Longest Waiting' },
  { value: 'due', label: 'Due Date' },
  { value: 'decided', label: 'Recently Decided' },
] as const;

export const formatWaiting = (hours: number) => {
  if (hours < 1) return 'under 1 h';
  if (hours < 48) return `${hours} h`;
  const d = Math.floor(hours / 24);
  const h = hours % 24;
  return h ? `${d} d ${h} h` : `${d} d`;
};

const toTarget = (r: ReviewQueueRow): ReviewTarget => ({
  id: r.id,
  rowVersion: r.rowVersion,
  versionId: r.versionId,
  versionNo: r.versionNo,
  title: r.title,
  projectId: r.project.id,
  reviewerMembershipId: r.reviewer?.membershipId ?? null,
});

/** 64×40 preview (restricted or missing media shows a neutral tile, never the file). */
const Thumb = ({ r }: { r: ReviewQueueRow }) =>
  r.thumbnailUrl ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={r.thumbnailUrl}
      alt=""
      width={64}
      height={40}
      loading="lazy"
      className="h-10 w-16 shrink-0 rounded-[6px] bg-surface-2 object-cover"
    />
  ) : (
    <span
      aria-hidden
      className="flex h-10 w-16 shrink-0 items-center justify-center rounded-[6px] bg-surface-2 text-fg-muted"
    >
      {r.targetType === 'character_version' ? <UserCircle size={18} /> : <FilmSlate size={18} />}
    </span>
  );

/**
 * S25 Review Queue: content versions and character profiles waiting for a decision. Approval only
 * happens inside one review (no bulk approve of media nobody looked at); bulk-open walks the
 * selected reviews one after another in Review Studio. Live events refresh rows in place.
 */
export const ReviewQueue = () => {
  const { workspace, user } = useWorkspace();
  const wsPath = useWsPath();
  const router = useRouter();
  const { state, set, list } = useUrlState<Filters>({
    scope: 'assigned',
    sort: 'waiting',
    status: 'pending',
  });
  const [search, setSearch] = useState(state.q ?? '');
  const q = useDebounced(search, 250);
  const scope = state.scope === 'all' ? 'all' : 'assigned';
  const sort = (SORT_OPTIONS.some((o) => o.value === state.sort) ? state.sort : 'waiting') as
    'waiting' | 'due' | 'decided';
  // No status chosen means the server default: pending reviews.
  const statuses = list('status').filter((x): x is ReviewQueueRow['status'] =>
    (REVIEW_STATUSES as readonly string[]).includes(x),
  );
  const query = {
    scope,
    q: q.length >= 2 ? q : undefined,
    projectId: state.projectId,
    format: list('format') as NonNullable<ReviewQueueRow['format']>[],
    reviewerMembershipId: scope === 'all' ? state.reviewerMembershipId : undefined,
    waitingHoursMin: state.waiting ? Number(state.waiting) : undefined,
    overdue: state.overdue === '1' ? true : undefined,
    status: statuses.length ? statuses : undefined,
    targetType:
      state.type === 'content_version' || state.type === 'character_version' ? state.type : undefined,
    sort,
  } as const;
  const rows = useApiInfinite(reviewEndpoints.list, { params: { workspaceId: workspace.id }, query });
  const [selection, setSelection] = useState<SelectionState>({ ids: new Set(), allMatching: false });
  const [lastOpened, setLastOpened] = useState<string | null>(null);
  const [assignFor, setAssignFor] = useState<ReviewQueueRow | null>(null);
  const [missingFor, setMissingFor] = useState<ReviewQueueRow | null>(null);
  const filtered = !!(
    query.q ||
    query.projectId ||
    query.format.length ||
    query.reviewerMembershipId ||
    query.waitingHoursMin ||
    query.overdue ||
    query.targetType ||
    (statuses.length > 0 && statuses.join(',') !== 'pending')
  );
  const clearFilters = () => {
    setSearch('');
    set({
      q: null,
      projectId: null,
      format: null,
      reviewerMembershipId: null,
      waiting: null,
      overdue: null,
      type: null,
      status: null,
    });
  };

  const openable = useMemo(() => rows.items.filter((r) => r.targetType === 'content_version'), [rows.items]);
  const selectedOpenable = openable.filter((r) => selection.ids.has(r.id)).map((r) => r.id);
  const open = (r: ReviewQueueRow) => {
    setLastOpened(r.id);
    router.push(r.href);
  };
  const openSelected = () => {
    const [first, ...rest] = selectedOpenable;
    if (!first) return;
    router.push(`${wsPath(`/reviews/${first}`)}${rest.length ? `?queue=${[first, ...rest].join(',')}` : ''}`);
  };

  const columns: Column<ReviewQueueRow>[] = [
    {
      key: 'title',
      header: 'Review',
      sticky: true,
      minWidth: 320,
      cell: (r) => (
        <span className="flex items-center gap-3">
          <Thumb r={r} />
          <span className="flex min-w-0 flex-col">
            <Link
              href={r.href}
              onClick={(e) => e.stopPropagation()}
              className="truncate font-medium text-fg hover:underline"
            >
              {r.title}
            </Link>
            <span className="text-[12px] text-fg-2">
              {r.targetType === 'character_version'
                ? 'Character profile'
                : label('contentFormat', r.format ?? '')}{' '}
              · v{r.versionNo} · Round {r.roundNo}
              {r.stepKind === 'release_approval' ? ` · ${label('reviewStep', r.stepKind)}` : ''}
            </span>
          </span>
        </span>
      ),
    },
    { key: 'project', header: 'Project', minWidth: 150, cell: (r) => r.project.name },
    {
      key: 'author',
      header: 'Author',
      minWidth: 160,
      cell: (r) => <Person member={r.author} empty="Unknown" />,
    },
    {
      key: 'reviewer',
      header: 'Reviewer',
      minWidth: 160,
      cell: (r) => <Person member={r.reviewer} empty="Not assigned" />,
    },
    {
      key: 'submittedAt',
      header: 'Submitted',
      minWidth: 170,
      cell: (r) => (
        <span className="flex flex-col">
          <span>{formatDateTime(r.submittedAt, user.timezone)}</span>
          <span className="text-[12px] text-fg-2">
            {r.status === 'pending'
              ? `Waiting ${formatWaiting(r.waitingHours)}`
              : `Decided after ${formatWaiting(r.waitingHours)}`}
          </span>
        </span>
      ),
    },
    {
      key: 'dueAt',
      header: 'Due',
      minWidth: 160,
      cell: (r) =>
        r.dueAt ? (
          <span className="flex flex-wrap items-center gap-1.5">
            <span className={r.overdue ? 'font-medium text-warning' : undefined}>
              {formatDateTime(r.dueAt, user.timezone)}
            </span>
            {r.overdue ? <StatusBadge status="overdue" label="Overdue" /> : null}
          </span>
        ) : (
          <span className="text-fg-muted">No due date</span>
        ),
    },
    {
      key: 'blocking',
      header: 'Open Blockers',
      align: 'right',
      minWidth: 120,
      cell: (r) =>
        r.openBlocking ? (
          <Badge tone="danger">{r.openBlocking}</Badge>
        ) : (
          <span className="text-fg-muted">0</span>
        ),
    },
    {
      key: 'status',
      header: 'Status',
      minWidth: 150,
      hidden: statuses.length === 1 && statuses[0] === 'pending',
      cell: (r) => <StatusBadge status={r.status} label={label('reviewStatus', r.status)} />,
    },
    {
      key: 'actions',
      header: '',
      headerLabel: 'Actions',
      align: 'right',
      width: 56,
      cell: (r) => (
        <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
          <Menu
            label={`Actions for ${r.title}`}
            trigger={
              <IconButton
                label={`Actions for ${r.title}`}
                icon={<DotsThree size={16} weight="bold" />}
                variant="ghost"
              />
            }
            items={[
              {
                label: r.targetType === 'character_version' ? 'Open Character Profile' : 'Open Review',
                onSelect: () => open(r),
              },
              { label: 'Assign Reviewer', hidden: !r.permissions.assign, onSelect: () => setAssignFor(r) },
              {
                label: 'Request Missing Files',
                hidden: !(r.permissions.decide && r.targetType === 'content_version'),
                onSelect: () => setMissingFor(r),
              },
              {
                label: 'Open Content',
                hidden: r.targetType !== 'content_version',
                href: wsPath(`/content/${r.subjectId}`),
                separatorBefore: true,
              },
            ]}
          />
        </span>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Review Queue"
        description="Versions and character profiles waiting for a decision. Approve inside a review after looking at the exact version."
        actions={
          <Button icon={<ArrowSquareOut size={14} />} onClick={() => router.push(wsPath('/content'))}>
            Content Pipeline
          </Button>
        }
      />
      <Tabs
        label="Review queue scope"
        value={scope}
        onValueChange={(v) => {
          setSelection({ ids: new Set(), allMatching: false });
          set({ scope: v, reviewerMembershipId: null });
        }}
        items={[
          { value: 'assigned', label: 'Assigned to Me' },
          { value: 'all', label: 'All Permitted' },
        ]}
      >
        <TabPanel value={scope}>
          <div className="flex flex-col gap-4">
            <Toolbar>
              <div className="w-full sm:w-[220px]">
                <Input
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value);
                    set({ q: e.target.value || null });
                  }}
                  placeholder="Search reviews"
                  aria-label="Search reviews"
                />
              </div>
              <div className="w-full sm:w-[200px]">
                <EntitySelect
                  type="project"
                  aria-label="Project"
                  placeholder="Project"
                  value={state.projectId}
                  onChange={(v) => set({ projectId: v })}
                  clearable
                />
              </div>
              <div className="w-[160px]">
                <MultiSelect
                  aria-label="Format"
                  placeholder="Format"
                  value={list('format')}
                  onChange={(v) => set({ format: v.join(',') || null })}
                  options={CONTENT_FORMATS.map((f) => ({ value: f, label: label('contentFormat', f) }))}
                />
              </div>
              {scope === 'all' ? (
                <div className="w-[180px]">
                  <MemberSelect
                    aria-label="Reviewer"
                    placeholder="Reviewer"
                    value={state.reviewerMembershipId}
                    onChange={(v) => set({ reviewerMembershipId: v })}
                    clearable
                  />
                </div>
              ) : null}
              <div className="w-[200px]">
                <Select
                  aria-label="Waiting time"
                  placeholder="Any waiting time"
                  value={state.waiting ?? null}
                  onChange={(v) => set({ waiting: v })}
                  options={WAITING_OPTIONS}
                  clearable
                />
              </div>
              <div className="w-[170px]">
                <Select
                  aria-label="Type"
                  placeholder="All types"
                  value={state.type ?? null}
                  onChange={(v) => set({ type: v })}
                  clearable
                  options={[
                    { value: 'content_version', label: 'Content versions' },
                    { value: 'character_version', label: 'Character profiles' },
                  ]}
                />
              </div>
              <div className="w-[190px]">
                <MultiSelect
                  aria-label="Status"
                  placeholder="Pending"
                  value={statuses}
                  onChange={(v) => set({ status: v.join(',') || null })}
                  options={REVIEW_STATUSES.map((s) => ({ value: s, label: label('reviewStatus', s) }))}
                />
              </div>
              <Switch
                label="Overdue"
                checked={state.overdue === '1'}
                onCheckedChange={(v) => set({ overdue: v ? '1' : null })}
              />
              <div className="ml-auto w-[180px]">
                <Select
                  aria-label="Sort"
                  value={sort}
                  onChange={(v) => set({ sort: v ?? 'waiting' })}
                  options={SORT_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
                />
              </div>
            </Toolbar>
            <QueryState query={rows}>
              {rows.items.length === 0 && !rows.isFetching ? (
                filtered ? (
                  <NoResults onClear={clearFilters} />
                ) : (
                  <EmptyState
                    icon={<CheckSquareOffset size={28} />}
                    title={scope === 'assigned' ? 'Nothing waiting for your review' : 'No reviews waiting'}
                    description={
                      scope === 'assigned'
                        ? 'Versions submitted with you as reviewer appear here. Switch to All Permitted to see every review you can decide.'
                        : 'Versions appear here when someone submits them for review.'
                    }
                  />
                )
              ) : (
                <div className="flex flex-col gap-3">
                  {selection.ids.size > 0 ? (
                    <div
                      className="flex flex-wrap items-center gap-2 rounded-[8px] border border-line bg-surface-2 px-3 py-2 text-[13px]"
                      role="region"
                      aria-label="Selected reviews"
                    >
                      <span>{selection.ids.size} selected</span>
                      <Button
                        size="sm"
                        variant="primary"
                        disabled={selectedOpenable.length === 0}
                        onClick={openSelected}
                      >
                        Open Selected ({selectedOpenable.length})
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setSelection({ ids: new Set(), allMatching: false })}
                      >
                        Clear Selection
                      </Button>
                      <span className="text-[12px] text-fg-2">
                        Reviews open one after another; each is decided on its own.
                      </span>
                    </div>
                  ) : null}
                  <DataTable
                    caption="Review queue"
                    rows={rows.items}
                    columns={columns}
                    getRowId={(r) => r.id}
                    density={user.density}
                    onRowClick={open}
                    selectedRowId={lastOpened}
                    selection={selection}
                    onSelectionChange={(s) => setSelection({ ids: s.ids, allMatching: false })}
                    hasMore={rows.hasNextPage}
                    loadingMore={rows.isFetchingNextPage}
                    onLoadMore={() => void rows.fetchNextPage()}
                  />
                </div>
              )}
            </QueryState>
          </div>
        </TabPanel>
      </Tabs>
      {assignFor ? (
        <AssignReviewerDialog
          open={!!assignFor}
          onOpenChange={(o) => !o && setAssignFor(null)}
          review={toTarget(assignFor)}
        />
      ) : null}
      {missingFor ? (
        <RequestChangesDialog
          open={!!missingFor}
          onOpenChange={(o) => !o && setMissingFor(null)}
          review={toTarget(missingFor)}
          openComments={null}
          initialSummary="Files are missing from this version."
        />
      ) : null}
    </div>
  );
};

/** My Work section "Reviewing" (S09): the member's pending reviews, oldest first. */
export const MyReviewsSection = () => {
  const { workspace, user } = useWorkspace();
  const wsPath = useWsPath();
  const q = useApiInfinite(reviewEndpoints.list, {
    params: { workspaceId: workspace.id },
    query: { scope: 'assigned', status: ['pending'], sort: 'waiting', pageSize: 10 },
  });
  return (
    <QueryState query={q}>
      {q.items.length === 0 ? (
        <EmptyState
          icon={<CheckSquareOffset size={24} />}
          title="Nothing to review"
          description="Versions and character profiles submitted with you as reviewer appear here."
        />
      ) : (
        <div className="flex flex-col gap-3">
          <ul className="flex flex-col divide-y divide-line rounded-[12px] border border-line bg-surface">
            {q.items.map((r) => (
              <li key={r.id} className="flex items-center gap-3 px-3 py-2.5">
                <Thumb r={r} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <Link href={r.href} className="truncate text-[14px] font-medium text-fg hover:underline">
                    {r.title}
                  </Link>
                  <span className="text-[12px] text-fg-2">
                    {r.project.name} · v{r.versionNo} · waiting {formatWaiting(r.waitingHours)}
                    {r.dueAt ? ` · due ${formatDateTime(r.dueAt, user.timezone)}` : ''}
                  </span>
                </span>
                {r.overdue ? <StatusBadge status="overdue" label="Overdue" /> : null}
                {r.openBlocking ? (
                  <Badge tone="danger">
                    {r.openBlocking} blocker{r.openBlocking === 1 ? '' : 's'}
                  </Badge>
                ) : null}
              </li>
            ))}
          </ul>
          <div className="flex justify-end">
            <Link
              href={wsPath('/reviews')}
              className="text-[13px] font-medium text-fg underline-offset-2 hover:underline"
            >
              Open Review Queue
            </Link>
          </div>
        </div>
      )}
    </QueryState>
  );
};
