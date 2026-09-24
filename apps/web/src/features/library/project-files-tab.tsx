'use client';
import { ImagesSquare } from '@phosphor-icons/react';
import Link from 'next/link';
import { useState } from 'react';
import { mediaEndpoints, type ProjectDetail } from '@castlane/api-contracts';
import { Button, EmptyState, Input, Toolbar } from '@castlane/ui';
import { QueryState } from '@/components/common/query-state';
import { useDebounced } from '@/components/common/use-debounced';
import { FileUploader } from '@/components/media/file-uploader';
import { useApiInfinite } from '@/lib/hooks';
import { useCan, useWorkspace, useWsPath } from '@/lib/workspace-context';
import { AssetCard } from './asset-card';
import './labels';

/** Project workspace tab "Files": the project's own Library files (same records as /library). */
export const ProjectFilesTab = ({ project }: { project: ProjectDetail }) => {
  const { workspace } = useWorkspace();
  const can = useCan();
  const wsPath = useWsPath();
  const [search, setSearch] = useState('');
  const q = useDebounced(search, 250);
  const [uploading, setUploading] = useState(false);
  const data = useApiInfinite(mediaEndpoints.list, { params: { workspaceId: workspace.id }, query: { projectId: project.id, q: q.length >= 2 ? q : undefined } });
  const canUpload = can('assets.upload') && project.status !== 'archived';
  return (
    <div className="flex flex-col gap-4">
      <Toolbar>
        <div className="w-full sm:w-[240px]">
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search files" aria-label="Search project files" />
        </div>
        <div className="ml-auto flex gap-2">
          <Link href={wsPath(`/library?projectId=${project.id}`)} className="inline-flex h-9 items-center rounded-[8px] border border-line bg-surface px-3 text-[13px] font-semibold text-fg hover:bg-surface-2">
            Open in Library
          </Link>
          {canUpload ? (
            <Button variant="primary" onClick={() => setUploading((v) => !v)} aria-expanded={uploading}>
              {uploading ? 'Hide Upload' : 'Upload Files'}
            </Button>
          ) : null}
        </div>
      </Toolbar>
      {uploading ? <FileUploader workspaceId={workspace.id} purpose="general" projectId={project.id} checkDuplicates onUploaded={() => void data.refetch()} /> : null}
      <QueryState query={data}>
        {data.items.length === 0 && !data.isFetching ? (
          q.length >= 2 ? (
            <EmptyState title="No files match this search" action={<Button onClick={() => setSearch('')}>Clear Search</Button>} />
          ) : (
            <EmptyState
              icon={<ImagesSquare size={28} />}
              title="No files for this project yet"
              description={canUpload ? 'Upload source files and versions for this project. They are checked before they become available.' : 'Files of this project appear here when they are uploaded.'}
              action={canUpload ? <Button variant="primary" onClick={() => setUploading(true)}>Upload Files</Button> : undefined}
            />
          )
        ) : (
          <div className="flex flex-col gap-3">
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
              {data.items.map((a) => (
                <li key={a.id}>
                  <AssetCard a={a} href={wsPath(`/library/assets/${a.id}`)} selectable={false} selected={false} onSelectedChange={() => undefined} />
                </li>
              ))}
            </ul>
            {data.hasNextPage ? (
              <div className="flex justify-center">
                <Button onClick={() => void data.fetchNextPage()} loading={data.isFetchingNextPage}>
                  Load More
                </Button>
              </div>
            ) : null}
          </div>
        )}
      </QueryState>
    </div>
  );
};
