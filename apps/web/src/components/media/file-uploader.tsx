'use client';
import { CloudArrowUp, X } from '@phosphor-icons/react';
import { useRef, useState } from 'react';
import { Badge, Button, cn, formatBytes } from '@castlane/ui';
import { useUpload, type UploadOptions } from './use-upload';

const STATE_TEXT: Record<string, string> = {
  queued: 'Queued',
  uploading: 'Uploading',
  completing: 'Uploaded',
  checking: 'Checking',
  available: 'Available',
  failed: 'Upload failed',
  cancelled: 'Cancelled',
  rejected: 'Rejected',
};

/**
 * Drop zone + per-file progress list. Upload states are shown separately (Uploaded → Checking →
 * Processing → Available); a successful upload does not approve anything.
 */
export const FileUploader = ({
  accept,
  multiple = true,
  label = 'Upload files',
  hint,
  compact,
  ...opts
}: UploadOptions & { accept?: string; multiple?: boolean; label?: string; hint?: string; compact?: boolean }) => {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const u = useUpload(opts);
  return (
    <div className="flex flex-col gap-2">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          if (e.dataTransfer.files.length) u.add(multiple ? e.dataTransfer.files : [e.dataTransfer.files[0]!]);
        }}
        className={cn(
          'flex flex-col items-center justify-center gap-2 rounded-[12px] border border-dashed border-line bg-surface text-center',
          compact ? 'px-3 py-3' : 'px-6 py-6',
          over && 'border-primary bg-selection',
        )}
      >
        {!compact ? <CloudArrowUp size={24} className="text-fg-2" aria-hidden /> : null}
        <p className="text-[13px] text-fg-2">Drag files here, or</p>
        <Button size="sm" onClick={() => input.current?.click()}>
          {label}
        </Button>
        {hint ? <p className="text-[12px] text-fg-muted">{hint}</p> : null}
        <input
          ref={input}
          type="file"
          className="sr-only"
          accept={accept}
          multiple={multiple}
          aria-label={label}
          onChange={(e) => {
            if (e.target.files?.length) u.add(e.target.files);
            e.target.value = '';
          }}
        />
      </div>
      {u.items.length ? (
        <ul className="flex flex-col gap-1.5" aria-live="polite">
          {u.items.map((i) => (
            <li key={i.key} className="flex items-center gap-3 rounded-[8px] border border-line bg-surface px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] text-fg">{i.file.name}</p>
                <div className="mt-1 flex items-center gap-2 text-[12px] text-fg-2">
                  <span>{formatBytes(i.file.size)}</span>
                  {i.state === 'uploading' ? (
                    <span className="h-1 flex-1 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-valuenow={i.progress} aria-valuemin={0} aria-valuemax={100} aria-label={`Uploading ${i.file.name}`}>
                      <span className="block h-full bg-primary transition-[width]" style={{ width: `${i.progress}%` }} />
                    </span>
                  ) : null}
                  {i.error ? <span className="text-danger">{i.error}</span> : null}
                </div>
              </div>
              <Badge tone={i.state === 'available' ? 'success' : i.state === 'failed' || i.state === 'rejected' ? 'danger' : i.state === 'cancelled' ? 'neutral' : 'info'}>
                {STATE_TEXT[i.state]}
              </Badge>
              {i.state === 'failed' ? (
                <Button size="sm" variant="ghost" onClick={() => u.retry(i.key)}>
                  Retry Upload
                </Button>
              ) : null}
              {i.state === 'uploading' || i.state === 'failed' || i.state === 'queued' ? (
                <button type="button" aria-label={`Cancel upload of ${i.file.name}`} className="rounded p-1 text-fg-2 hover:text-fg" onClick={() => void u.cancel(i.key)}>
                  <X size={14} />
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
};

/** Authorised thumbnail (never a public object URL). */
export const AssetThumb = ({ workspaceId, assetId, size = 64, alt = '', className }: { workspaceId: string; assetId: string; size?: 64 | 128 | 256 | 320 | 640 | 1280; alt?: string; className?: string }) => (
  // eslint-disable-next-line @next/next/no-img-element
  <img src={`/api/v1/workspaces/${workspaceId}/assets/${assetId}/thumbnail?size=${size}`} alt={alt} loading="lazy" className={cn('rounded-[8px] bg-surface-2 object-cover', className)} />
);
