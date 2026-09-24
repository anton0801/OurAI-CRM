'use client';
import { projectEndpoints, type ProjectDetail } from '@castlane/api-contracts';
import { Button, EmptyState, formatDateTime, humanize } from '@castlane/ui';
import { QueryState } from '@/components/common/query-state';
import { useApiInfinite } from '@/lib/hooks';
import { useWorkspace } from '@/lib/workspace-context';

const fmt = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? JSON.stringify(v) : String(v));

export const ProjectActivityTab = ({ project }: { project: ProjectDetail }) => {
  const { workspace, user } = useWorkspace();
  const q = useApiInfinite(projectEndpoints.activity, { params: { workspaceId: workspace.id, projectId: project.id }, query: {} });
  return (
    <QueryState query={q}>
      {q.items.length === 0 ? (
        <EmptyState title="No activity yet" />
      ) : (
        <div className="flex flex-col gap-3">
          <ol className="flex flex-col divide-y divide-line rounded-[12px] border border-line bg-surface">
            {q.items.map((e) => (
              <li key={e.id} className="flex flex-col gap-1 px-4 py-3">
                <p className="text-[14px] text-fg">
                  <span className="font-semibold">{e.actorName ?? 'System'}</span> · {humanize(e.action.replace(/\./g, '_'))}
                </p>
                {e.changes.length ? (
                  <ul className="text-[13px] text-fg-2">
                    {e.changes.map((c) => (
                      <li key={c.field}>
                        {humanize(c.field.replace(/([A-Z])/g, '_$1').toLowerCase())}: {fmt(c.from)} → {fmt(c.to)}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {e.reason ? <p className="text-[13px] text-fg-2">Reason: {e.reason}</p> : null}
                <p className="text-[12px] text-fg-muted">{formatDateTime(e.occurredAt, user.timezone)}</p>
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
