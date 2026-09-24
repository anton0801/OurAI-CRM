'use client';
import { CalendarBlank, Plus } from '@phosphor-icons/react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { publicationEndpoints as P, type PublicationRow } from '@castlane/api-contracts';
import { PUBLICATION_STATUSES } from '@castlane/domain';
import { Avatar, Button, DataTable, EmptyState, MultiSelect, NoResults, Switch, Toolbar, type Column } from '@castlane/ui';
import { QueryState } from '@/components/common/query-state';
import { useApiInfinite } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useUrlState } from '@/lib/url-state';
import { useCan, useWorkspace, useWsPath } from '@/lib/workspace-context';
import { PlatformLabel } from '@/features/accounts/platform';
import { PublicationBadges, whenText } from './format';

export interface PublicationFilters {
  projectId?: string;
  accountId?: string;
  campaignId?: string;
  contentItemId?: string;
  episodeId?: string;
  dealId?: string;
  ownerMembershipId?: string;
}

/**
 * Placements table used by the account, project, campaign, content, episode and deal screens: the
 * same records as the calendar, filtered server-side (scope applied before paging).
 */
export const PublicationTable = ({
  filters,
  caption,
  emptyTitle = 'No publications yet',
  emptyText = 'Plan a placement of approved content on an account. Publishing happens on the platform; confirm it here afterwards.',
  newHref,
  hideProject,
  hideAccount,
  statusParam = 'pstatus',
}: {
  filters: PublicationFilters;
  caption: string;
  emptyTitle?: string;
  emptyText?: string;
  /** Where "New Publication" leads (with prefilled query), when the member may plan. */
  newHref?: string | null;
  hideProject?: boolean;
  hideAccount?: boolean;
  statusParam?: string;
}) => {
  const { workspace, user } = useWorkspace();
  const can = useCan();
  const wsPath = useWsPath();
  const router = useRouter();
  const { state, set, list } = useUrlState<string>();
  const status = list(statusParam) as PublicationRow['status'][];
  const archived = state[`${statusParam}_archived`] === '1';
  const q = useApiInfinite(P.list, { params: { workspaceId: workspace.id }, query: { ...filters, status, includeArchived: archived || undefined, sort: 'when', direction: 'desc', pageSize: 50 } });
  const filtered = status.length > 0;
  const columns: Column<PublicationRow>[] = [
    {
      key: 'title',
      header: 'Content',
      sticky: true,
      minWidth: 240,
      cell: (p) => (
        <span className="flex items-center gap-3">
          {p.thumbnailUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={p.thumbnailUrl} alt="" width={24} height={24} className="h-6 w-6 shrink-0 rounded-[6px] object-cover" loading="lazy" />
          ) : null}
          <Link href={wsPath(`/publications/${p.id}`)} className="font-medium text-fg hover:underline" onClick={(e) => e.stopPropagation()}>
            {p.title}
          </Link>
        </span>
      ),
    },
    {
      key: 'account',
      header: 'Account',
      minWidth: 180,
      hidden: hideAccount,
      cell: (p) => (
        <span className="flex items-center gap-2">
          <PlatformLabel platform={p.account.platform} iconOnly />
          <span className="truncate">{p.account.label}</span>
        </span>
      ),
    },
    { key: 'project', header: 'Project', minWidth: 140, hidden: hideProject, cell: (p) => p.project.name },
    { key: 'when', header: 'When', minWidth: 230, cell: (p) => <span className="text-[13px]">{whenText(p, user.timezone)}</span> },
    { key: 'status', header: 'Status', minWidth: 200, cell: (p) => <PublicationBadges p={p} compact /> },
    {
      key: 'owner',
      header: 'Owner',
      minWidth: 160,
      cell: (p) => (
        <span className="flex items-center gap-2">
          <Avatar name={p.owner.displayName} src={p.owner.avatarUrl} size={24} decorative />
          <span className="truncate">{p.owner.displayName}</span>
        </span>
      ),
    },
    { key: 'campaign', header: 'Campaign', minWidth: 140, hidden: !!filters.campaignId, cell: (p) => p.primaryCampaign?.name ?? <span className="text-fg-muted">—</span> },
  ];
  return (
    <div className="flex flex-col gap-3">
      <Toolbar>
        <div className="w-[200px]">
          <MultiSelect
            aria-label="Publication status"
            placeholder="Status"
            value={status}
            onChange={(v) => set({ [statusParam]: v.join(',') || null })}
            options={PUBLICATION_STATUSES.map((s) => ({ value: s, label: label('publicationStatus', s) }))}
          />
        </div>
        <Switch label="Show archived" checked={archived} onCheckedChange={(v) => set({ [`${statusParam}_archived`]: v ? '1' : null })} />
        <div className="ml-auto flex items-center gap-2">
          {can(['publications.read', 'tasks.read']) ? (
            <Button size="sm" variant="ghost" icon={<CalendarBlank size={14} />} onClick={() => router.push(wsPath(`/calendar${filters.projectId ? `?projectId=${filters.projectId}` : filters.accountId ? `?accountId=${filters.accountId}` : ''}`))}>
              Calendar
            </Button>
          ) : null}
          {newHref ? (
            <Button size="sm" variant="primary" icon={<Plus size={14} />} onClick={() => router.push(newHref)}>
              New Publication
            </Button>
          ) : null}
        </div>
      </Toolbar>
      <QueryState query={q}>
        {q.items.length === 0 && !q.isFetching ? (
          filtered ? (
            <NoResults onClear={() => set({ [statusParam]: null })} />
          ) : (
            <EmptyState
              icon={<CalendarBlank size={28} />}
              title={emptyTitle}
              description={emptyText}
              action={newHref ? <Button variant="primary" onClick={() => router.push(newHref)}>New Publication</Button> : undefined}
            />
          )
        ) : (
          <DataTable
            caption={caption}
            rows={q.items}
            columns={columns}
            getRowId={(p) => p.id}
            density={user.density}
            onRowClick={(p) => router.push(wsPath(`/publications/${p.id}`))}
            hasMore={q.hasNextPage}
            loadingMore={q.isFetchingNextPage}
            onLoadMore={() => void q.fetchNextPage()}
          />
        )}
      </QueryState>
    </div>
  );
};
