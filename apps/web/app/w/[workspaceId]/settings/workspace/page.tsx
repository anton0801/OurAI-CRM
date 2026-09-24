import { Suspense } from 'react';
import { WorkspaceSettingsScreen } from '@/features/settings/workspace-settings';

export const metadata = { title: 'Workspace Settings' };

export default function WorkspaceSettingsPage() {
  return (
    <Suspense>
      <WorkspaceSettingsScreen />
    </Suspense>
  );
}
