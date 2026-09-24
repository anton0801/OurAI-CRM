import type { ReactNode } from 'react';
import { AppShell } from '@/components/shell/app-shell';
import { WorkspaceProvider } from '@/lib/workspace-context';
import { currentPath, requireWorkspaceSession } from '@/server/session';

export const dynamic = 'force-dynamic';

export default async function WorkspaceLayout({ children, params }: { children: ReactNode; params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const { value } = await requireWorkspaceSession(workspaceId, await currentPath());
  return (
    <WorkspaceProvider value={value}>
      <AppShell>{children}</AppShell>
    </WorkspaceProvider>
  );
}
