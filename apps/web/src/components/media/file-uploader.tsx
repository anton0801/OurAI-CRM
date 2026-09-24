'use client';
import { ArrowClockwise, CloudArrowUp, Pause, Play, X } from '@phosphor-icons/react';
import Link from 'next/link';
import { useRef, useState } from 'react';
import { mediaEndpoints } from '@castlane/api-contracts';
import { Badge, Button, cn, formatBytes, toast, type Tone } from '@castlane/ui';
import { api } from '@/lib/api';
import { useUpload, type UploadItem, type UploadOptions } from './use-upload';

const STATE_TEXT: Record<UploadItem['state'], string> = {
  queued: 'Queued',
  hashing: 'Preparing',
  duplicate: 'Already in the Library',
  uploading: 'Uploading',
  paused: 'Paused',
  completing: 'Uploaded',
  checking: 'Checking',
  processing: 'Processing',
  available: 'Available',
  failed: 'Upload failed',
  cancelled: 'Cancelled',
  rejected: 'Rejected',
};

const STATE_TONE: Record<UploadItem['state'], Tone> = {
  queued: 'neutral',
  hashing: 'neutral',
  duplicate: 'warning',
  uploading: 'info',
  paused: 'warning',
  completing: 'info',
  checking: 'info',
  processing: 'info',
  available: 'success',
  failed: 'danger',
  cancelled: 'neutral',
  rejected: 'danger',
};

const errorHint = (i: UploadItem) =>
  i.errorCode === 'QUOTA_EXCEEDED'
    ? 'The workspace storage quota is full. Existing files stay available; archive or delete files, or ask the Owner to raise the quota.'
    : i.errorCode === 'PAYLOAD_TOO_LARGE'
      ? i.error
      : i.error;

/** Per-file progress list: Uploading → Uploaded → Checking → Processing → Available are shown separately. */
export const UploadList = ({ u, workspaceId, target }: { u: ReturnType<typeof useUpload>; workspaceId: string; target?: UploadOptions['target'] }) => {
  if (!u.items.length) return null;
  const reuse = async (i: UploadItem) => {
    const d = i.duplicates?.[0];
    if (!d) return;
    if (!target) return;
    try {
      await api.call(mediaEndpoints.link, { params: { workspaceId, assetId: d.assetId }, body: { target } });
      u.dismiss(i.key);
      toast.success('The existing file was attached');
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  return (
    <ul className="flex flex-col gap-1.5" aria-live="polite" aria-label="Uploads">
      {u.items.map((i) => (
        <li key={i.key} className="flex flex-wrap items-center gap-3 rounded-[8px] border border-line bg-surface px-3 py-2">
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] text-fg">{i.file.name}</p>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-[12px] text-fg-2">
              <span>{formatBytes(i.file.size)}</span>
              {i.state === 'uploading' || i.state === 'paused' ? (
                <span
                  className="h-1 min-w-[80px] flex-1 overflow-hidden rounded-full bg-surface-2"
                  role="progressbar"
                  aria-valuenow={i.progress}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label={`Uploading ${i.file.name}`}
                >
                  <span className="block h-full bg-primary transition-[width]" style={{ width: `${i.progress}%` }} />
                </span>
              ) : null}
              {i.state === 'uploading' || i.state === 'paused' ? <span className="font-mono tabular-nums">{i.progress}%</span> : null}
              {i.state === 'checking' || i.state === 'processing' ? <span>Your file is being checked and prepared for preview.</span> : null}
              {i.state === 'duplicate' && i.duplicates?.[0] ? (
                <span>
                  An identical file exists:{' '}
                  <Link className="underline" href={`/w/${workspaceId}/library/assets/${i.duplicates[0].assetId}`}>
                    {i.duplicates[0].name}
                  </Link>{' '}
                  (version {i.duplicates[0].versionNo}).
                </span>
              ) : null}
              {i.error ? <span className="text-danger">{errorHint(i)}</span> : null}
            </div>
          </div>
          <Badge tone={STATE_TONE[i.state]}>{STATE_TEXT[i.state]}</Badge>
          <div className="flex items-center gap-1">
            {i.state === 'duplicate' ? (
              <>
                {target ? (
                  <Button size="sm" onClick={() => void reuse(i)}>
                    Use Existing
                  </Button>
                ) : null}
                <Button size="sm" variant="ghost" onClick={() => u.uploadAnyway(i.key)}>
                  Upload Anyway
                </Button>
              </>
            ) : null}
            {i.state === 'uploading' ? (
              <button type="button" aria-label={`Pause upload of ${i.file.name}`} className="rounded p-2 text-fg-2 hover:text-fg" onClick={() => u.pause(i.key)}>
                <Pause size={14} />
              </button>
            ) : null}
            {i.state === 'paused' ? (
              <button type="button" aria-label={`Resume upload of ${i.file.name}`} className="rounded p-2 text-fg-2 hover:text-fg" onClick={() => u.resume(i.key)}>
                <Play size={14} />
              </button>
            ) : null}
            {i.state === 'failed' && i.errorCode !== 'QUOTA_EXCEEDED' && i.errorCode !== 'SESSION_CLOSED' ? (
              <Button size="sm" variant="ghost" icon={<ArrowClockwise size={12} />} onClick={() => u.retry(i.key)}>
                Retry Upload
              </Button>
            ) : null}
            {['uploading', 'paused', 'failed', 'queued', 'hashing'].includes(i.state) ? (
              <button type="button" aria-label={`Cancel upload of ${i.file.name}`} className="rounded p-2 text-fg-2 hover:text-fg" onClick={() => void u.cancel(i.key)}>
                <X size={14} />
              </button>
            ) : null}
            {['available', 'cancelled', 'rejected', 'duplicate'].includes(i.state) ? (
              <button type="button" aria-label={`Remove ${i.file.name} from the list`} className="rounded p-2 text-fg-2 hover:text-fg" onClick={() => u.dismiss(i.key)}>
                <X size={14} />
              </button>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
};

/** Drop zone + per-file progress list. A successful upload does not approve anything. */
export const FileUploader = ({
  accept,
  multiple = true,
  label = 'Upload files',
  hint,
  compact,
  ...opts
}: UploadOptions & { accept?: string; multiple?: boolean; label?: string; hint?: string; compact?: boolean }) => {
  const u = useUpload(opts);
  return (
    <div className="flex flex-col gap-2">
      <DropZone accept={accept} multiple={multiple} label={label} hint={hint} compact={compact} onFiles={u.add} />
      <UploadList u={u} workspaceId={opts.workspaceId} target={opts.target} />
    </div>
  );
};

export const DropZone = ({
  accept,
  multiple = true,
  label = 'Upload files',
  hint,
  compact,
  onFiles,
  disabled,
}: {
  accept?: string;
  multiple?: boolean;
  label?: string;
  hint?: string;
  compact?: boolean;
  onFiles: (files: File[]) => void;
  disabled?: boolean;
}) => {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        if (disabled) return;
        const files = [...e.dataTransfer.files];
        if (files.length) onFiles(multiple ? files : files.slice(0, 1));
      }}
      className={cn(
        'flex flex-col items-center justify-center gap-2 rounded-[12px] border border-dashed border-line bg-surface text-center',
        compact ? 'px-3 py-3' : 'px-6 py-6',
        over && 'border-primary bg-selection',
      )}
    >
      {!compact ? <CloudArrowUp size={24} className="text-fg-2" aria-hidden /> : null}
      <p className="text-[13px] text-fg-2">Drag files here, or</p>
      <Button size="sm" onClick={() => input.current?.click()} disabled={disabled}>
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
        tabIndex={-1}
        onChange={(e) => {
          if (e.target.files?.length) onFiles([...e.target.files]);
          e.target.value = '';
        }}
      />
    </div>
  );
};

/** Authorised thumbnail (never a public object URL). */
export const AssetThumb = ({ workspaceId, assetId, size = 64, alt = '', className }: { workspaceId: string; assetId: string; size?: 64 | 128 | 256 | 320 | 640 | 1280; alt?: string; className?: string }) => (
  // eslint-disable-next-line @next/next/no-img-element
  <img src={`/api/v1/workspaces/${workspaceId}/assets/${assetId}/thumbnail?size=${size}`} alt={alt} loading="lazy" className={cn('rounded-[8px] bg-surface-2 object-cover', className)} />
);
