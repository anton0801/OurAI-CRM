'use client';
import { useParams } from 'next/navigation';
import { projectEndpoints } from '@castlane/api-contracts';
import { QueryState } from '@/components/common/query-state';
import { ProjectEditor } from '@/features/projects/project-editor';
import { useApiQuery } from '@/lib/hooks';
import { useWorkspace } from '@/lib/workspace-context';

export default function EditProjectPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const { workspace } = useWorkspace();
  const q = useApiQuery(projectEndpoints.get, { params: { workspaceId: workspace.id, projectId } }, { staleTime: Infinity, refetchOnWindowFocus: false });
  return <QueryState query={q}>{q.data ? <ProjectEditor project={q.data} /> : null}</QueryState>;
}
