'use client';
import { Books } from '@phosphor-icons/react';
import Link from 'next/link';
import { knowledgeEndpoints } from '@castlane/api-contracts';
import { Badge, Button, EmptyState, StatusBadge, formatDateTime } from '@castlane/ui';
import { QueryState } from '@/components/common/query-state';
import { useApiInfinite } from '@/lib/hooks';
import { useWorkspace, useWsPath } from '@/lib/workspace-context';

/** My Work section "Required Reading": the member's own open acknowledgement requests. */
export const MyReadingSection = () => {
  const { workspace, user } = useWorkspace();
  const wsPath = useWsPath();
  const q = useApiInfinite(knowledgeEndpoints.myReading, { params: { workspaceId: workspace.id }, query: { status: 'open' } });
  return (
    <QueryState query={q}>
      {q.items.length === 0 ? (
        <EmptyState icon={<Books size={24} />} title="No required reading" description="Articles you are asked to read appear here until you acknowledge them." />
      ) : (
        <div className="flex flex-col gap-3">
          <ul className="flex flex-col divide-y divide-line rounded-[12px] border border-line bg-surface">
            {q.items.map((r) => (
              <li key={r.assignmentId} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <span className="min-w-0 flex-1">
                  <Link href={wsPath(`/knowledge/${r.articleId}`)} className="block truncate text-[14px] font-medium text-fg hover:underline">
                    {r.title}
                  </Link>
                  <span className="text-[12px] text-fg-2">
                    {r.categoryName} · version {r.versionNo}
                    {r.revisionKind === 'major' && r.versionNo > 1 ? ' · updated rules' : ''} · asked {formatDateTime(r.assignedAt, user.timezone)}
                  </span>
                </span>
                {r.dueAt ? <span className="text-[12px] text-fg-2">Due {formatDateTime(r.dueAt, user.timezone)}</span> : null}
                {r.overdue ? <StatusBadge status="overdue" label="Overdue" /> : <Badge tone="info">To read</Badge>}
                <Link href={wsPath(`/knowledge/${r.articleId}`)} className="inline-flex h-9 items-center rounded-[8px] border border-line bg-surface px-3 text-[13px] font-semibold text-fg hover:bg-surface-2">
                  Read
                </Link>
              </li>
            ))}
          </ul>
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
