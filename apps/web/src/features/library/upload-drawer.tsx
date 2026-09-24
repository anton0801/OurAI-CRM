'use client';
import { useRef, useState } from 'react';
import { mediaEndpoints, type FolderView } from '@castlane/api-contracts';
import { Banner, Button, Drawer, Field, Select, formatBytes, formatDateTime } from '@castlane/ui';
import { EntitySelect } from '@/components/common/entity-select';
import { DropZone, UploadList } from '@/components/media/file-uploader';
import type { useUpload } from '@/components/media/use-upload';
import { useApiMutation, useApiQuery } from '@/lib/hooks';
import { useCan, useWorkspace } from '@/lib/workspace-context';

/**
 * Upload Manager (S37): multi-file, resumable uploads with progress, pause/resume/cancel, quota
 * errors and the separate Uploaded → Checking → Processing → Available states. Uploads keep
 * running when the drawer is closed; unfinished sessions can be resumed after a reload by
 * choosing the same file again (within 24 h).
 */
export const UploadDrawer = ({
  open,
  onOpenChange,
  u,
  folder,
  projectId,
  onProjectChange,
  sensitivity,
  onSensitivityChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  u: ReturnType<typeof useUpload>;
  folder: (FolderView & { path?: { id: string; name: string }[] }) | null;
  projectId: string | null;
  onProjectChange: (v: string | null) => void;
  sensitivity: 'normal' | 'restricted';
  onSensitivityChange: (v: 'normal' | 'restricted') => void;
}) => {
  const { workspace, user } = useWorkspace();
  const can = useCan();
  const usage = useApiQuery(mediaEndpoints.storageUsage, { params: { workspaceId: workspace.id } }, { enabled: open });
  const openSessions = useApiQuery(mediaEndpoints.listOpenUploads, { params: { workspaceId: workspace.id } }, { enabled: open });
  const abort = useApiMutation(mediaEndpoints.abortUpload, { invalidate: ['uploads.', 'assets.'], successMessage: 'Upload cancelled' });
  const picker = useRef<HTMLInputElement>(null);
  const [resuming, setResuming] = useState<{ uploadId: string; assetId: string | null; assetVersionId: string | null; filename: string; byteSize: number } | null>(null);
  const [resumeError, setResumeError] = useState<string | null>(null);
  const inList = new Set(u.items.map((i) => i.uploadId).filter(Boolean));
  const interrupted = (openSessions.data ?? []).filter((s) => !inList.has(s.uploadId));
  const full = usage.data?.full ?? false;
  const used = usage.data ? Number(usage.data.usedBytes) + Number(usage.data.reservedBytes) : null;
  const quota = usage.data ? Number(usage.data.quotaBytes) : null;

  return (
    <Drawer open={open} onOpenChange={onOpenChange} width={560} title="Upload Files" description={folder ? `To ${folder.name}` : 'To the Library root'}>
      <div className="flex flex-col gap-4">
        {full ? (
          <Banner tone="danger">The workspace storage quota is full. Existing files stay available; archive files or ask the Owner to raise the quota before uploading.</Banner>
        ) : null}
        {used !== null && quota !== null ? (
          <div className="flex flex-col gap-1">
            <div className="flex justify-between text-[12px] text-fg-2">
              <span>Storage used (incl. uploads in progress)</span>
              <span className="font-mono tabular-nums">
                {formatBytes(used)} of {formatBytes(quota)}
              </span>
            </div>
            <span className="h-1.5 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-label="Storage used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((used / Math.max(1, quota)) * 100)}>
              <span className="block h-full bg-primary" style={{ width: `${Math.min(100, (used / Math.max(1, quota)) * 100)}%` }} />
            </span>
          </div>
        ) : null}
        {!folder?.projectId ? (
          folder ? null : (
            <Field label="Project" helper="Files without a project belong to the workspace library (workspace-wide file access needed).">
              <EntitySelect type="project" value={projectId} onChange={(v) => onProjectChange(v)} clearable placeholder="Workspace library" />
            </Field>
          )
        ) : (
          <p className="text-[13px] text-fg-2">Files uploaded here belong to the project {folder.projectName ?? 'of this folder'}.</p>
        )}
        {can('assets.restricted.read') ? (
          <Field label="Sensitivity" helper="Restricted media is shown as a neutral placeholder and never appears in search or thumbnails.">
            <Select
              value={sensitivity}
              onChange={(v) => onSensitivityChange((v as 'normal' | 'restricted') ?? 'normal')}
              options={[
                { value: 'normal', label: 'Normal' },
                { value: 'restricted', label: 'Restricted Media' },
              ]}
            />
          </Field>
        ) : null}
        <DropZone onFiles={u.add} label="Choose Files" hint="Images up to 50 MB, video up to 5 GB, audio up to 500 MB, PDF up to 100 MB, ZIP up to 2 GB." disabled={full} />
        <p className="text-[12px] text-fg-2">A successful upload does not approve anything. Files become available after the checks finish.</p>
        <UploadList u={u} workspaceId={workspace.id} />
        {interrupted.length ? (
          <section className="flex flex-col gap-2" aria-label="Unfinished uploads">
            <h3 className="text-[14px] font-semibold text-fg">Unfinished uploads</h3>
            <p className="text-[12px] text-fg-2">Choose the same file again to continue where the upload stopped.</p>
            {resumeError ? <Banner tone="danger">{resumeError}</Banner> : null}
            <ul className="flex flex-col gap-1.5">
              {interrupted.map((s) => (
                <li key={s.uploadId} className="flex flex-wrap items-center gap-2 rounded-[8px] border border-line px-3 py-2 text-[13px]">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-fg">{s.filename}</span>
                    <span className="text-[12px] text-fg-2">
                      {formatBytes(s.byteSize)} · resumable until {formatDateTime(s.expiresAt, user.timezone)}
                    </span>
                  </span>
                  <Button
                    size="sm"
                    onClick={() => {
                      setResumeError(null);
                      setResuming(s);
                      picker.current?.click();
                    }}
                  >
                    Resume
                  </Button>
                  <Button size="sm" variant="ghost" loading={abort.isPending} onClick={() => void abort.run({ params: { workspaceId: workspace.id, uploadId: s.uploadId }, body: {} })}>
                    Cancel Upload
                  </Button>
                </li>
              ))}
            </ul>
            <input
              ref={picker}
              type="file"
              className="sr-only"
              tabIndex={-1}
              aria-label="Choose the file to resume"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (!f || !resuming) return;
                if (f.name !== resuming.filename || f.size !== resuming.byteSize) {
                  setResumeError(`Choose the same file: “${resuming.filename}” (${formatBytes(resuming.byteSize)}).`);
                  return;
                }
                u.resumeSession(resuming, f);
                setResuming(null);
              }}
            />
          </section>
        ) : null}
      </div>
    </Drawer>
  );
};
