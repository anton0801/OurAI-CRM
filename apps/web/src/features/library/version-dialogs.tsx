'use client';
import { useEffect, useState } from 'react';
import { mediaEndpoints, type AssetDetail } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { Banner, Button, Dialog, Drawer, Field, Input, Textarea, formatBytes } from '@castlane/ui';
import { DropZone, UploadList } from '@/components/media/file-uploader';
import { useUpload } from '@/components/media/use-upload';
import { useApiMutation, useApiQuery } from '@/lib/hooks';
import { useUnsavedChangesGuard } from '@/lib/unsaved';
import { useWorkspace } from '@/lib/workspace-context';

/**
 * Delete Version with preview (§14, T080): versions held by approved content, published
 * placements, evidence or article versions cannot be deleted — the dialog offers Archive File.
 */
export const DeleteVersionDialog = ({
  open,
  onOpenChange,
  asset,
  versionId,
  onArchive,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  asset: AssetDetail;
  versionId: string | null;
  onArchive: () => void;
}) => {
  const { workspace } = useWorkspace();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setReason('');
      setError(null);
    }
  }, [open, versionId]);
  const preview = useApiQuery(mediaEndpoints.versionDeletePreview, { params: { workspaceId: workspace.id, assetId: asset.id, versionId: versionId ?? '' } }, { enabled: open && !!versionId });
  const del = useApiMutation(mediaEndpoints.deleteVersion, { invalidate: ['assets.'], silentErrors: true, successMessage: 'Version deleted' });
  const p = preview.data;
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="small"
      title={p ? `Delete version ${p.versionNo}?` : 'Delete version?'}
      description={p?.deletable ? `The file (${formatBytes(p.byteSize)}) stays recoverable for ${asset.retention?.trashDays ?? 30} days, then it is purged from storage.` : undefined}
      footer={
        p && !p.deletable ? (
          <>
            <Button onClick={() => onOpenChange(false)}>Close</Button>
            {asset.permissions.archive ? (
              <Button
                variant="danger"
                onClick={() => {
                  onOpenChange(false);
                  onArchive();
                }}
              >
                Archive File
              </Button>
            ) : null}
          </>
        ) : (
          <>
            <Button onClick={() => onOpenChange(false)} disabled={del.isPending}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={del.isPending}
              disabled={!p?.deletable || reason.trim().length < 3}
              onClick={async () => {
                if (!versionId) return;
                setError(null);
                try {
                  await del.run({ params: { workspaceId: workspace.id, assetId: asset.id, versionId }, body: { reason: reason.trim() } }, { ifMatch: asset.rowVersion });
                  onOpenChange(false);
                } catch (e) {
                  setError(isApiError(e) ? e.message : 'The version could not be deleted.');
                }
              }}
            >
              Delete Version
            </Button>
          </>
        )
      }
    >
      <div className="flex flex-col gap-3 text-[14px]">
        {preview.isLoading ? <p className="text-fg-2">Checking where this version is used…</p> : null}
        {preview.error ? <Banner tone="danger">{preview.error.message}</Banner> : null}
        {error ? <Banner tone="danger">{error}</Banner> : null}
        {p && p.items.length ? (
          <ul className="flex flex-col gap-1 rounded-[8px] bg-surface-2 p-3 text-[13px]">
            {p.items.map((i) => (
              <li key={i.kind} className={i.blocking ? 'text-danger' : 'text-fg-2'}>
                {i.blocking ? 'Keeps this version' : 'Note'}: {i.label}
                {i.count > 1 ? ` (${i.count})` : ''}
              </li>
            ))}
          </ul>
        ) : null}
        {p?.suggestion ? <p className="text-fg-2">{p.suggestion}</p> : null}
        {p?.deletable ? (
          <Field label="Reason" required>
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
          </Field>
        ) : null}
      </div>
    </Dialog>
  );
};

/** New Version (S37): the original stays immutable; a replacement is a new AssetVersion. */
export const NewVersionDrawer = ({ open, onOpenChange, asset, onUploaded }: { open: boolean; onOpenChange: (o: boolean) => void; asset: AssetDetail; onUploaded: () => void }) => {
  const { workspace } = useWorkspace();
  const [note, setNote] = useState('');
  const u = useUpload({ workspaceId: workspace.id, purpose: 'general', assetId: asset.id, note: note.trim() || undefined, onUploaded, concurrency: 1 });
  useUnsavedChangesGuard(u.active > 0);
  return (
    <Drawer open={open} onOpenChange={onOpenChange} title="Upload New Version" description={`Version ${(asset.versions[0]?.versionNo ?? 0) + 1} of “${asset.name}”`} dirty={u.active > 0}>
      <div className="flex flex-col gap-4">
        <Field label="Version note" helper="What changed compared to the previous version.">
          <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
        </Field>
        <DropZone onFiles={(files) => u.add(files.slice(0, 1))} multiple={false} label="Choose File" hint="The previous versions stay available in the history." />
        <UploadList u={u} workspaceId={workspace.id} />
      </div>
    </Drawer>
  );
};
