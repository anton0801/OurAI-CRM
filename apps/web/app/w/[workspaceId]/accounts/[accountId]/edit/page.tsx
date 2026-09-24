'use client';
import { useParams } from 'next/navigation';
import { Suspense } from 'react';
import { accountEndpoints } from '@castlane/api-contracts';
import { QueryState } from '@/components/common/query-state';
import { AccountEditor } from '@/features/accounts/account-editor';
import { useApiQuery } from '@/lib/hooks';
import { useWorkspace } from '@/lib/workspace-context';

export default function EditAccountPage() {
  const { accountId } = useParams<{ accountId: string }>();
  const { workspace } = useWorkspace();
  const q = useApiQuery(accountEndpoints.get, { params: { workspaceId: workspace.id, accountId } }, { staleTime: Infinity, refetchOnWindowFocus: false });
  return (
    <QueryState query={q}>
      {q.data ? (
        <Suspense>
          <AccountEditor account={q.data} />
        </Suspense>
      ) : null}
    </QueryState>
  );
}
