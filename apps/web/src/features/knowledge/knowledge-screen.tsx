'use client';
import { Books, DotsThree, Plus } from '@phosphor-icons/react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { knowledgeEndpoints, ARTICLE_SCOPE_TYPES, type ArticleRow } from '@castlane/api-contracts';
import { ARTICLE_STATUSES } from '@castlane/domain';
import {
  Avatar,
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
  Toolbar,
  cn,
  formatDate,
  formatDateTime,
  type Column,
} from '@castlane/ui';
import { EntitySelect } from '@/components/common/entity-select';
import { MemberSelect } from '@/components/common/pickers';
import { QueryState } from '@/components/common/query-state';
import { useDebounced } from '@/components/common/use-debounced';
import { useApiInfinite, useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useUrlState } from '@/lib/url-state';
import { useCan, useWorkspace, useWsPath } from '@/lib/workspace-context';
import { CategoryDialog } from './category-dialog';
import './labels';

type Keys = 'q' | 'category' | 'status' | 'scope' | 'projectId' | 'owner' | 'required' | 'mine' | 'archived' | 'sort' | 'dir';

/** S38 Knowledge Base: categories, articles, required reading and search (permission-aware). */
export const KnowledgeScreen = () => {
  const { workspace, user } = useWorkspace();
  const can = useCan();
  const wsPath = useWsPath();
  const router = useRouter();
  const { state, set, list } = useUrlState<Keys>({ sort: 'updatedAt', dir: 'desc' });
  const [search, setSearch] = useState(state.q ?? '');
  const q = useDebounced(search, 250);
  const [categoriesOpen, setCategoriesOpen] = useState(false);
  const categories = useApiQuery(knowledgeEndpoints.listCategories, { params: { workspaceId: workspace.id }, query: {} });
  const query = {
    q: q.length >= 2 ? q : undefined,
    categoryId: state.category,
    status: list('status') as ArticleRow['status'][],
    scopeType: state.scope as ArticleRow['scope']['type'] | undefined,
    projectId: state.projectId,
    ownerMembershipId: state.owner,
    required: state.required === '1' ? true : undefined,
    myReading: state.mine === '1' ? ('open' as const) : undefined,
    includeArchived: state.archived === '1' ? true : undefined,
    sort: (state.sort ?? 'updatedAt') as 'updatedAt' | 'title',
    direction: (state.dir ?? 'desc') as 'asc' | 'desc',
  };
  const data = useApiInfinite(knowledgeEndpoints.list, { params: { workspaceId: workspace.id }, query });
  const filtered = !!(query.q || query.categoryId || query.status.length || query.scopeType || query.projectId || query.ownerMembershipId || query.required || query.myReading);
  const canWrite = categories.data?.canCreateArticles ?? false;
  const canManageCategories = categories.data?.canManage ?? false;
  const cats = categories.data?.items ?? [];
  const current = cats.find((c) => c.id === state.category);

  const columns: Column<ArticleRow>[] = [
    {
      key: 'title',
      header: 'Title',
      sortable: true,
      sticky: true,
      minWidth: 260,
      cell: (a) => (
        <span className="flex flex-col">
          <Link href={wsPath(`/knowledge/${a.id}`)} className="font-medium text-fg hover:underline" onClick={(e) => e.stopPropagation()}>
            {a.title}
          </Link>
          <span className="text-[12px] text-fg-2">
            {a.category.name}
            {a.category.archived ? ' (archived)' : ''}
          </span>
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      minWidth: 150,
      cell: (a) => (
        <span className="flex flex-wrap gap-1">
          <StatusBadge status={a.status} label={label('articleStatus', a.status)} />
          {a.hasDraft && a.status === 'published' ? <Badge tone="info">Draft</Badge> : null}
        </span>
      ),
    },
    { key: 'version', header: 'Version', align: 'right', minWidth: 80, cell: (a) => (a.publishedVersionNo ? `v${a.publishedVersionNo}` : '—') },
    {
      key: 'reading',
      header: 'Required Reading',
      minWidth: 160,
      cell: (a) =>
        a.myReading ? (
          <StatusBadge status={a.myReading.overdue ? 'overdue' : a.myReading.status} label={a.myReading.overdue ? 'Overdue for you' : a.myReading.status === 'open' ? 'To read' : 'Acknowledged'} />
        ) : a.requiredReading ? (
          <Badge tone="warning">Required</Badge>
        ) : (
          <span className="text-fg-muted">—</span>
        ),
    },
    { key: 'scope', header: 'Scope', minWidth: 160, cell: (a) => (a.scope.type === 'workspace' ? 'Whole workspace' : `${label('articleScope', a.scope.type)}: ${a.scope.label ?? 'restricted'}`) },
    {
      key: 'owner',
      header: 'Owner',
      minWidth: 160,
      cell: (a) => (
        <span className="flex items-center gap-2">
          <Avatar name={a.owner.displayName} src={a.owner.avatarUrl} size={24} decorative />
          <span className="truncate">{a.owner.displayName}</span>
        </span>
      ),
    },
    { key: 'reviewed', header: 'Last Reviewed', minWidth: 130, cell: (a) => (a.lastReviewedAt ? formatDate(a.lastReviewedAt, user.timezone) : <span className="text-fg-muted">Not reviewed</span>) },
    { key: 'updatedAt', header: 'Updated', sortable: true, minWidth: 160, cell: (a) => formatDateTime(a.updatedAt, user.timezone) },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      headerLabel: 'Actions',
      minWidth: 56,
      cell: (a) => (
        <span onClick={(e) => e.stopPropagation()}>
          <Menu
            label={`Actions for ${a.title}`}
            trigger={<IconButton label={`Actions for ${a.title}`} icon={<DotsThree size={16} weight="bold" />} />}
            items={[
              { label: 'Open', onSelect: () => router.push(wsPath(`/knowledge/${a.id}`)) },
              { label: 'Edit', onSelect: () => router.push(wsPath(`/knowledge/${a.id}?tab=edit`)), hidden: a.hasDraft === undefined || a.status === 'archived' },
              { label: 'Assign Reading', onSelect: () => router.push(wsPath(`/knowledge/${a.id}?tab=reading`)), hidden: a.hasDraft === undefined || a.status !== 'published' || !can('knowledge.publish') },
            ]}
          />
        </span>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Knowledge"
        description="Working regulations and instructions. Required reading is confirmed explicitly with Acknowledge Read."
        actions={
          <>
            {canWrite ? (
              <Button variant="primary" icon={<Plus size={14} weight="bold" />} onClick={() => router.push(wsPath('/knowledge/new'))}>
                New Article
              </Button>
            ) : null}
            {canManageCategories ? <Button onClick={() => setCategoriesOpen(true)}>Manage Categories</Button> : null}
          </>
        }
      />
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[220px_minmax(0,1fr)]">
        <aside className="min-w-0">
          <nav aria-label="Categories" className="flex flex-row gap-1 overflow-x-auto rounded-[12px] border border-line bg-surface p-2 lg:flex-col">
            <button
              type="button"
              aria-current={!state.category ? 'true' : undefined}
              onClick={() => set({ category: null })}
              className={cn('flex min-h-9 shrink-0 items-center justify-between gap-2 rounded-[8px] px-2 text-left text-[13px] font-medium text-fg', !state.category ? 'bg-selection' : 'hover:bg-surface-2')}
            >
              All articles
            </button>
            {cats.map((c) => (
              <button
                key={c.id}
                type="button"
                aria-current={state.category === c.id ? 'true' : undefined}
                onClick={() => set({ category: c.id })}
                className={cn('flex min-h-9 shrink-0 items-center justify-between gap-2 rounded-[8px] px-2 text-left text-[13px] text-fg', state.category === c.id ? 'bg-selection' : 'hover:bg-surface-2')}
              >
                <span className="truncate">{c.name}</span>
                <span className="font-mono text-[12px] tabular-nums text-fg-2">{c.articleCount}</span>
              </button>
            ))}
            {categories.data && !cats.length ? <p className="px-2 py-1 text-[12px] text-fg-2">No categories yet.</p> : null}
          </nav>
        </aside>
        <section className="flex min-w-0 flex-col gap-4" aria-label={current ? `Articles in ${current.name}` : 'Articles'}>
          <Toolbar>
            <div className="w-full sm:w-[240px]">
              <Input
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  set({ q: e.target.value || null });
                }}
                placeholder="Search titles and published text"
                aria-label="Search articles"
              />
            </div>
            <div className="w-[160px]">
              <MultiSelect aria-label="Status" placeholder="Status" value={list('status')} onChange={(v) => set({ status: v.join(',') || null })} options={ARTICLE_STATUSES.map((s) => ({ value: s, label: label('articleStatus', s) }))} />
            </div>
            <div className="w-[160px]">
              <Select aria-label="Scope" placeholder="Scope" clearable value={state.scope ?? null} onChange={(v) => set({ scope: v })} options={ARTICLE_SCOPE_TYPES.map((s) => ({ value: s, label: label('articleScope', s) }))} />
            </div>
            <div className="w-[170px]">
              <EntitySelect type="project" aria-label="Project" placeholder="Project" value={state.projectId ?? null} onChange={(v) => set({ projectId: v })} clearable />
            </div>
            <div className="w-[170px]">
              <MemberSelect aria-label="Owner" placeholder="Owner" value={state.owner ?? null} onChange={(v) => set({ owner: v })} clearable />
            </div>
            <div className="flex flex-wrap items-center gap-4 px-1">
              <Switch label="To read by me" checked={state.mine === '1'} onCheckedChange={(v) => set({ mine: v ? '1' : null })} />
              <Switch label="Required reading" checked={state.required === '1'} onCheckedChange={(v) => set({ required: v ? '1' : null })} />
              <Switch label="Show archived" checked={state.archived === '1'} onCheckedChange={(v) => set({ archived: v ? '1' : null })} />
            </div>
          </Toolbar>
          <QueryState query={data}>
            {data.items.length === 0 && !data.isFetching ? (
              filtered ? (
                <NoResults
                  onClear={() => {
                    setSearch('');
                    set({ q: null, category: null, status: null, scope: null, projectId: null, owner: null, required: null, mine: null });
                  }}
                />
              ) : (
                <EmptyState
                  icon={<Books size={28} />}
                  title="No articles yet"
                  description={
                    canWrite
                      ? cats.length
                        ? 'Write the first regulation or instruction. It stays a draft until you publish a version.'
                        : 'Create a category first, then write the first regulation or instruction.'
                      : 'Published articles for your projects and the whole workspace appear here. Ask a knowledge editor if you expect to see an article.'
                  }
                  action={
                    canWrite ? (
                      cats.length ? (
                        <Button variant="primary" onClick={() => router.push(wsPath('/knowledge/new'))}>
                          New Article
                        </Button>
                      ) : (
                        <Button variant="primary" onClick={() => setCategoriesOpen(true)}>
                          Manage Categories
                        </Button>
                      )
                    ) : undefined
                  }
                />
              )
            ) : (
              <DataTable
                caption="Articles"
                rows={data.items}
                columns={columns}
                getRowId={(a) => a.id}
                density={user.density}
                sort={{ key: query.sort, direction: query.direction }}
                onSortChange={(s) => set({ sort: s.key, dir: s.direction })}
                onRowClick={(a) => router.push(wsPath(`/knowledge/${a.id}`))}
                hasMore={data.hasNextPage}
                loadingMore={data.isFetchingNextPage}
                onLoadMore={() => void data.fetchNextPage()}
              />
            )}
          </QueryState>
        </section>
      </div>
      <CategoryDialog open={categoriesOpen} onOpenChange={setCategoriesOpen} />
    </div>
  );
};
