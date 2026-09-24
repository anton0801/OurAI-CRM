'use client';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { contentVersionEndpoints } from '@castlane/api-contracts';
import { QueryState } from '@/components/common/query-state';
import { useApiQuery } from '@/lib/hooks';
import { useWorkspace, useWsPath } from '@/lib/workspace-context';

/**
 * Version links (notifications, audit, search) resolve to the review of that version when one
 * exists, otherwise to the Versions tab of its content item. Access is checked by the resolve call.
 */
export const ContentVersionRedirect = ({ versionId }: { versionId: string }) => {
  const { workspace } = useWorkspace();
  const wsPath = useWsPath();
  const router = useRouter();
  const q = useApiQuery(contentVersionEndpoints.resolve, {
    params: { workspaceId: workspace.id, versionId },
  });
  useEffect(() => {
    if (!q.data) return;
    router.replace(
      q.data.reviewId
        ? wsPath(`/reviews/${q.data.reviewId}`)
        : wsPath(`/content/${q.data.contentId}?tab=versions&version=${versionId}`),
    );
  }, [q.data, router, wsPath, versionId]);
  return (
    <QueryState query={q}>
      <p className="text-[14px] text-fg-2" role="status">
        Opening version…
      </p>
    </QueryState>
  );
};
