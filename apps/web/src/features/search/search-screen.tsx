'use client';
import Link from 'next/link';
import { MagnifyingGlass } from '@phosphor-icons/react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { searchEndpoints } from '@castlane/api-contracts';
import type { ApiError } from '@castlane/api-client';
import { Badge, Button, EmptyState, Input, NoResults, PageHeader, StatusBadge, TableSkeleton, Toolbar, cn, humanize } from '@castlane/ui';
import { EntitySelect } from '@/components/common/entity-select';
import { MemberSelect } from '@/components/common/pickers';
import { QueryState } from '@/components/common/query-state';
import { useDebounced } from '@/components/common/use-debounced';
import { api } from '@/lib/api';
import { keyFor } from '@/lib/hooks';
import { useUrlState } from '@/lib/url-state';
import { useWorkspace } from '@/lib/workspace-context';

type Filters = 'q' | 'types' | 'projectId' | 'assignee' | 'status';

/**
 * S11 full search page: permission-aware results with type facets. Counts and snippets come from
 * the same scoped query, so hidden records never influence what is shown.
 */
export const SearchScreen = () => {
  const { workspace } = useWorkspace();
  const { state, set, list } = useUrlState<Filters>();
  const [text, setText] = useState(state.q ?? '');
  const q = useDebounced(text.trim(), 250);
  useEffect(() => {
    if ((state.q ?? '') !== q) set({ q: q || null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);
  const types = list('types');
  const input = {
    params: { workspaceId: workspace.id },
    query: { q, types: types.length ? types : undefined, projectId: state.projectId, assigneeMembershipId: state.assignee, status: state.status, pageSize: 20 },
  };
  const enabled = q.length >= 2;
  const results = useInfiniteQuery<Awaited<ReturnType<typeof api.call<typeof searchEndpoints.page>>>, ApiError>({
    queryKey: keyFor(searchEndpoints.page, input),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => api.call(searchEndpoints.page, { ...input, query: { ...input.query, cursor: pageParam as string | undefined } }, { signal }),
    getNextPageParam: (last) => (last.hasMore ? (last.nextCursor ?? undefined) : undefined),
    enabled,
  });
  const pages = results.data?.pages ?? [];
  const items = pages.flatMap((p) => p.results);
  const facets = pages[0]?.facets ?? [];
  const filtered = !!(types.length || state.projectId || state.assignee || state.status);
  const toggleType = (t: string) => set({ types: (types.includes(t) ? types.filter((x) => x !== t) : [...types, t]).join(',') || null });

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Search" description="Find records you have access to. Results, snippets and counts only include what you can open." />
      <Toolbar>
        <div className="relative w-full sm:w-[360px]">
          <MagnifyingGlass size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-2" aria-hidden />
          <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Search by name, text or exact ID" aria-label="Search" className="pl-9" autoFocus />
        </div>
        <div className="w-full sm:w-[220px]">
          <EntitySelect type="project" aria-label="Project" placeholder="Any project" clearable value={state.projectId ?? null} onChange={(v) => set({ projectId: v })} />
        </div>
        <div className="w-full sm:w-[200px]">
          <MemberSelect aria-describedby={undefined} placeholder="Any assignee" clearable value={state.assignee ?? null} onChange={(v) => set({ assignee: v })} />
        </div>
      </Toolbar>
      {facets.length ? (
        <div className="flex flex-wrap gap-2" role="group" aria-label="Result types">
          {facets.map((f) => {
            const active = types.includes(f.entityType);
            return (
              <button
                key={f.entityType}
                type="button"
                aria-pressed={active}
                onClick={() => toggleType(f.entityType)}
                className={cn('inline-flex h-8 items-center gap-2 rounded-[8px] border px-3 text-[13px]', active ? 'border-primary bg-selection text-fg' : 'border-line bg-surface text-fg-2 hover:bg-surface-2')}
              >
                {humanize(f.entityType)}
                <span className="rounded-[6px] bg-surface-2 px-1.5 text-[11px] text-fg-2">{f.count}</span>
              </button>
            );
          })}
        </div>
      ) : null}
      {!enabled ? (
        <EmptyState icon={<MagnifyingGlass size={28} />} title="Type at least two characters" description="Search looks through titles, handles and permitted text of projects, content, tasks, references, articles and more." />
      ) : (
        <QueryState query={{ isLoading: results.isLoading, error: results.error, refetch: results.refetch }} skeleton={<TableSkeleton rows={5} columns={2} />}>
          {items.length === 0 ? (
            filtered ? (
              <NoResults onClear={() => set({ types: null, projectId: null, assignee: null, status: null })} />
            ) : (
              <EmptyState icon={<MagnifyingGlass size={28} />} title="No accessible records match" description="Try another word, or check the spelling. Records you cannot access are never shown." />
            )
          ) : (
            <div className="flex flex-col gap-3">
              <ul className="divide-y divide-line overflow-hidden rounded-[12px] border border-line bg-surface">
                {items.map((r) => (
                  <li key={`${r.entityType}:${r.entityId}`}>
                    <Link href={r.href} className="flex items-start gap-3 px-4 py-3 hover:bg-surface-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--c-focus)]">
                      {r.thumbnailUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={r.thumbnailUrl} alt="" width={28} height={28} loading="lazy" className="mt-0.5 h-7 w-7 shrink-0 rounded-[6px] object-cover" />
                      ) : (
                        <span aria-hidden className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px] bg-surface-2 text-[11px] font-semibold text-fg-2">
                          {r.title.slice(0, 2).toUpperCase()}
                        </span>
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="font-medium text-fg">{r.title}</span>
                          <Badge>{humanize(r.entityType)}</Badge>
                          {r.status ? <StatusBadge status={r.status} /> : null}
                        </span>
                        {r.snippet ? <span className="mt-0.5 line-clamp-2 block text-[13px] text-fg-2">{r.snippet}</span> : null}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
              {results.hasNextPage ? (
                <div className="flex justify-center">
                  <Button onClick={() => void results.fetchNextPage()} loading={results.isFetchingNextPage}>
                    Load More
                  </Button>
                </div>
              ) : null}
            </div>
          )}
        </QueryState>
      )}
    </div>
  );
};
