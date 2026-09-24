'use client';
import { ArrowSquareOut, DownloadSimple, EyeSlash, FileText, Play, SpeakerHigh } from '@phosphor-icons/react';
import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type KeyboardEvent } from 'react';
import { mediaEndpoints, type ContentVersionFile } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { Banner, Button, cn, formatBytes, toast } from '@castlane/ui';
import { api } from '@/lib/api';
import { label } from '@/lib/labels';
import { useWorkspace } from '@/lib/workspace-context';
import { formatMs } from './format';

export interface AnnotationMarker {
  id: string;
  index: number;
  pointX: string | null;
  pointY: string | null;
  timecodeMs: number | null;
  severity: 'note' | 'issue' | 'blocking';
  resolved: boolean;
}

export interface ViewerHandle {
  /** Current playback position of the video/audio (ms), or null. */
  currentTimeMs: () => number | null;
  seek: (ms: number) => void;
  focus: () => void;
}

/** Issue a short-lived authorised URL and download (attachment) or open (inline) the original. */
export const useFileActions = () => {
  const { workspace } = useWorkspace();
  const run = async (
    f: Pick<ContentVersionFile, 'assetId' | 'assetVersionId'>,
    disposition: 'attachment' | 'inline',
  ) => {
    try {
      const r = await api.call(mediaEndpoints.download, {
        params: { workspaceId: workspace.id, assetId: f.assetId },
        body: { versionId: f.assetVersionId, disposition },
      });
      if (disposition === 'inline') window.open(r.url, '_blank', 'noopener,noreferrer');
      else window.location.assign(r.url);
    } catch (e) {
      toast.error(isApiError(e) ? e.message : 'The file could not be opened.');
    }
  };
  return {
    download: (f: Pick<ContentVersionFile, 'assetId' | 'assetVersionId'>) => run(f, 'attachment'),
    open: (f: Pick<ContentVersionFile, 'assetId' | 'assetVersionId'>) => run(f, 'inline'),
  };
};

const SEVERITY_CLS: Record<AnnotationMarker['severity'], string> = {
  note: 'bg-surface text-fg border-line',
  issue: 'bg-warning-soft text-warning border-warning',
  blocking: 'bg-danger text-surface border-danger',
};

const clamp = (v: number) => Math.min(1, Math.max(0, v));

/**
 * One file of a version (S24/S26): images use the authorised 1280 px derivative with object-fit
 * contain; points are normalised to the image itself (not the letterbox). Video/audio stream only
 * after an explicit Play. Restricted media stays a neutral placeholder until revealed by an
 * entitled member. With `placing`, a point is pinned by click or by keyboard (arrow keys move the
 * marker, Enter pins it).
 */
export const FileViewer = forwardRef<
  ViewerHandle,
  {
    file: ContentVersionFile;
    markers?: AnnotationMarker[];
    activeMarkerId?: string | null;
    onSelectMarker?: (id: string) => void;
    placing?: boolean;
    pendingPoint?: { x: number; y: number } | null;
    onPlacePoint?: (p: { x: number; y: number }) => void;
    /** Escape while placing a point. */
    onCancelPlacing?: () => void;
    compact?: boolean;
    caption?: string;
  }
>(function FileViewer(
  {
    file,
    markers = [],
    activeMarkerId,
    onSelectMarker,
    placing,
    pendingPoint,
    onPlacePoint,
    onCancelPlacing,
    compact,
    caption,
  },
  ref,
) {
  const { workspace } = useWorkspace();
  const [revealed, setRevealed] = useState(false);
  const [streamUrl, setStreamUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState({ x: 0.5, y: 0.5 });
  const media = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const actions = useFileActions();

  useEffect(() => {
    setStreamUrl(null);
    setRevealed(false);
    setError(null);
  }, [file.assetVersionId]);

  // Keyboard placement starts where the focus is: the image surface (T166).
  useEffect(() => {
    if (placing) surface.current?.focus();
  }, [placing]);

  useImperativeHandle(ref, () => ({
    currentTimeMs: () => (media.current ? Math.round(media.current.currentTime * 1000) : null),
    seek: (ms: number) => {
      if (media.current) {
        media.current.currentTime = ms / 1000;
        media.current.focus();
      }
    },
    focus: () => surface.current?.focus(),
  }));

  const box = cn(
    'relative flex w-full items-center justify-center overflow-hidden rounded-[12px] bg-surface-2',
    compact ? 'min-h-[160px]' : 'min-h-[240px] md:min-h-[420px]',
  );
  const hidden = file.restricted && !revealed;

  if (file.status !== 'available')
    return (
      <div className={box}>
        <p className="max-w-[420px] p-6 text-center text-[14px] text-fg-2">
          {file.status === 'rejected' || file.status === 'failed'
            ? `This file was rejected${file.rejectionReason ? `: ${file.rejectionReason}` : '.'}`
            : 'Your file is being checked and prepared for preview.'}
        </p>
      </div>
    );

  if (hidden)
    return (
      <div className={box}>
        <div className="flex flex-col items-center gap-2 p-6 text-center text-[13px] text-fg-2">
          <EyeSlash size={28} aria-hidden />
          <span>Restricted media</span>
          {file.canReveal ? (
            <Button size="sm" onClick={() => setRevealed(true)}>
              Reveal
            </Button>
          ) : null}
        </div>
      </div>
    );

  const thumb = file.restricted
    ? `/api/v1/workspaces/${workspace.id}/assets/${file.assetId}/thumbnail?size=1280&versionId=${file.assetVersionId}&reveal=true`
    : (file.thumbnailUrl ??
      `/api/v1/workspaces/${workspace.id}/assets/${file.assetId}/thumbnail?size=1280&versionId=${file.assetVersionId}`);

  if (file.kind === 'image' && file.previewAvailable) {
    const pointMarkers = markers.filter((m) => m.pointX !== null && m.pointY !== null);
    const place = (x: number, y: number) => onPlacePoint?.({ x: clamp(x), y: clamp(y) });
    const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
      if (!placing) return;
      const step = e.shiftKey ? 0.1 : 0.02;
      const moves: Record<string, [number, number]> = {
        ArrowLeft: [-step, 0],
        ArrowRight: [step, 0],
        ArrowUp: [0, -step],
        ArrowDown: [0, step],
      };
      const mv = moves[e.key];
      if (mv) {
        e.preventDefault();
        setCursor((c) => ({ x: clamp(c.x + mv[0]), y: clamp(c.y + mv[1]) }));
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        place(cursor.x, cursor.y);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onCancelPlacing?.();
      }
    };
    return (
      <figure className={cn(box, 'p-2')}>
        <div
          ref={surface}
          className={cn(
            'relative inline-block max-w-full',
            placing &&
              'cursor-crosshair focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--c-focus)]',
          )}
          tabIndex={placing ? 0 : -1}
          role={placing ? 'application' : undefined}
          aria-label={
            placing
              ? 'Image. Use the arrow keys to move the marker (Shift for larger steps), Enter to pin the point and Escape to cancel.'
              : undefined
          }
          onKeyDown={onKey}
          onClick={(e) => {
            if (!placing) return;
            const r = e.currentTarget.getBoundingClientRect();
            place((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={thumb}
            alt={caption ?? file.fileName}
            className={cn(
              'block h-auto max-w-full object-contain',
              compact ? 'max-h-[240px]' : 'max-h-[70vh]',
            )}
            draggable={false}
          />
          {pointMarkers.map((m) => (
            <button
              key={m.id}
              type="button"
              aria-label={`Comment ${m.index}${m.severity === 'blocking' ? ', blocker' : m.severity === 'issue' ? ', issue' : ''}${m.resolved ? ', resolved' : ''}`}
              aria-pressed={activeMarkerId === m.id}
              onClick={(e) => {
                e.stopPropagation();
                onSelectMarker?.(m.id);
              }}
              className={cn(
                'absolute flex h-7 min-w-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 px-1 text-[12px] font-semibold shadow',
                SEVERITY_CLS[m.severity],
                m.resolved && 'opacity-60',
                activeMarkerId === m.id && 'outline-2 outline-offset-2 outline-[var(--c-focus)]',
              )}
              style={{ left: `${Number(m.pointX) * 100}%`, top: `${Number(m.pointY) * 100}%` }}
            >
              {m.index}
            </button>
          ))}
          {placing ? (
            <span
              aria-hidden
              className="pointer-events-none absolute h-6 w-6 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-dashed border-primary bg-selection/40"
              style={{ left: `${cursor.x * 100}%`, top: `${cursor.y * 100}%` }}
            />
          ) : null}
          {pendingPoint ? (
            <span
              aria-hidden
              className="pointer-events-none absolute flex h-7 w-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 border-primary bg-primary text-[12px] font-semibold text-on-primary"
              style={{ left: `${pendingPoint.x * 100}%`, top: `${pendingPoint.y * 100}%` }}
            >
              +
            </span>
          ) : null}
        </div>
        {caption ? <figcaption className="sr-only">{caption}</figcaption> : null}
      </figure>
    );
  }

  if (file.kind === 'video' || file.kind === 'audio') {
    const loadStream = async () => {
      setLoading(true);
      setError(null);
      try {
        const r = await api.call(mediaEndpoints.download, {
          params: { workspaceId: workspace.id, assetId: file.assetId },
          body: { versionId: file.assetVersionId, disposition: 'inline' },
        });
        setStreamUrl(r.url);
      } catch (e) {
        setError(isApiError(e) ? e.message : 'The file could not be loaded.');
      } finally {
        setLoading(false);
      }
    };
    const timed = markers
      .filter((m) => m.timecodeMs !== null)
      .sort((a, b) => (a.timecodeMs ?? 0) - (b.timecodeMs ?? 0));
    return (
      <div className="flex flex-col gap-2">
        <div className={box}>
          {streamUrl ? (
            file.kind === 'video' ? (
              <video
                ref={media}
                src={streamUrl}
                controls
                className={cn('w-full object-contain', compact ? 'max-h-[240px]' : 'max-h-[70vh]')}
                aria-label={caption ?? file.fileName}
              />
            ) : (
              <audio
                ref={media}
                src={streamUrl}
                controls
                className="w-full max-w-[560px] p-4"
                aria-label={caption ?? file.fileName}
              />
            )
          ) : (
            <>
              {file.kind === 'video' && file.previewAvailable && !file.restricted ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={thumb} alt="" className="absolute inset-0 h-full w-full object-contain" />
              ) : null}
              <div className="relative flex flex-col items-center gap-2 rounded-[12px] bg-surface/90 p-4 text-center">
                {file.canDownload ? (
                  <Button
                    variant="primary"
                    loading={loading}
                    icon={
                      file.kind === 'video' ? <Play size={14} weight="fill" /> : <SpeakerHigh size={14} />
                    }
                    onClick={() => void loadStream()}
                  >
                    {file.kind === 'video' ? 'Play' : 'Play Audio'}
                  </Button>
                ) : (
                  <p className="max-w-[320px] text-[13px] text-fg-2">
                    Playback streams the original file and needs download access.
                  </p>
                )}
                {file.durationMs !== null ? (
                  <span className="text-[12px] text-fg-2">Duration {formatMs(file.durationMs)}</span>
                ) : (
                  <span className="text-[12px] text-fg-2">Duration unknown</span>
                )}
                {error ? <Banner tone="danger">{error}</Banner> : null}
              </div>
            </>
          )}
        </div>
        {timed.length ? (
          <ol className="flex flex-wrap gap-1.5" aria-label="Timecoded comments">
            {timed.map((m) => (
              <li key={m.id}>
                <button
                  type="button"
                  className={cn(
                    'rounded-[6px] border px-2 py-1 font-mono text-[12px]',
                    SEVERITY_CLS[m.severity],
                    m.resolved && 'opacity-60',
                    activeMarkerId === m.id && 'outline-2 outline-offset-2 outline-[var(--c-focus)]',
                  )}
                  onClick={() => {
                    if (media.current) media.current.currentTime = (m.timecodeMs ?? 0) / 1000;
                    onSelectMarker?.(m.id);
                  }}
                  aria-label={`Comment ${m.index} at ${formatMs(m.timecodeMs)}${streamUrl ? ', jump to this moment' : ''}`}
                >
                  #{m.index} {formatMs(m.timecodeMs)}
                </button>
              </li>
            ))}
          </ol>
        ) : null}
      </div>
    );
  }

  return (
    <div className={box}>
      <div className="flex flex-col items-center gap-2 p-6 text-center text-[13px] text-fg-2">
        <FileText size={28} aria-hidden />
        <span>File Preview Unavailable</span>
        <span className="text-[12px]">
          {file.fileName} · {formatBytes(file.byteSize)}
        </span>
        {file.canDownload ? (
          <div className="flex gap-2">
            <Button size="sm" icon={<DownloadSimple size={14} />} onClick={() => void actions.download(file)}>
              Download
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
});

/** File header line with slot, name, size and the Open Original / Download actions. */
export const FileMeta = ({ file }: { file: ContentVersionFile }) => {
  const actions = useFileActions();
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 text-[12px] text-fg-2">
      <span className="min-w-0 truncate">
        <span className="font-semibold text-fg">{label('contentSlot', file.slot)}</span> · {file.fileName}
        {file.byteSize !== null ? ` · ${formatBytes(file.byteSize)}` : ''}
        {file.width && file.height ? ` · ${file.width}×${file.height}` : ''}
        {file.durationMs !== null ? ` · ${formatMs(file.durationMs)}` : ''}
      </span>
      {file.canDownload && file.status === 'available' ? (
        <span className="flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            icon={<ArrowSquareOut size={14} />}
            onClick={() => void actions.open(file)}
          >
            Open Original
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon={<DownloadSimple size={14} />}
            onClick={() => void actions.download(file)}
          >
            Download
          </Button>
        </span>
      ) : null}
    </div>
  );
};
