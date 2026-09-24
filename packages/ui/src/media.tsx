'use client';
import { EyeSlash, FileText, Play } from '@phosphor-icons/react';
import { useState } from 'react';
import { cn } from './cn';

/**
 * Media preview. `contain` by default; `cover` only for thumbnails. Restricted media shows a
 * neutral placeholder until the viewer (with permission) explicitly reveals it. Video never
 * autoplays and plays only after a click.
 */
export const MediaPreview = ({
  kind,
  src,
  posterSrc,
  alt,
  width,
  height,
  fit = 'contain',
  restricted = false,
  canReveal = false,
  className,
}: {
  kind: 'image' | 'video' | 'audio' | 'document' | 'other';
  src?: string | null;
  posterSrc?: string | null;
  alt: string;
  width?: number;
  height?: number;
  fit?: 'contain' | 'cover';
  restricted?: boolean;
  canReveal?: boolean;
  className?: string;
}) => {
  const [revealed, setRevealed] = useState(false);
  const [playing, setPlaying] = useState(false);
  const box = cn('relative flex items-center justify-center overflow-hidden rounded-[8px] bg-surface-2', className);
  const style = { width, height, maxWidth: '100%' };
  if (restricted && !revealed)
    return (
      <div className={box} style={style}>
        <div className="flex flex-col items-center gap-2 p-3 text-center text-[12px] text-fg-2">
          <EyeSlash size={20} aria-hidden />
          <span>Restricted media</span>
          {canReveal ? (
            <button type="button" className="rounded-[6px] border border-line bg-surface px-2 py-1 text-[12px] font-semibold text-fg hover:bg-surface-2" onClick={() => setRevealed(true)}>
              Reveal
            </button>
          ) : null}
        </div>
      </div>
    );
  if (!src && !posterSrc)
    return (
      <div className={box} style={style}>
        <div className="flex flex-col items-center gap-1 p-2 text-center text-[12px] text-fg-2">
          <FileText size={20} aria-hidden />
          <span>File Preview Unavailable</span>
        </div>
      </div>
    );
  if (kind === 'video') {
    if (!playing)
      return (
        <button type="button" className={cn(box, 'group')} style={style} onClick={() => setPlaying(true)} aria-label={`Play ${alt}`}>
          {posterSrc ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={posterSrc} alt="" className={cn('h-full w-full', fit === 'cover' ? 'object-cover' : 'object-contain')} />
          ) : null}
          <span className="absolute flex h-12 w-12 items-center justify-center rounded-full bg-black/60 text-white group-hover:bg-black/75">
            <Play size={22} weight="fill" aria-hidden />
          </span>
        </button>
      );
    return (
      <div className={box} style={style}>
        <video src={src ?? undefined} controls autoPlay className="h-full w-full object-contain" aria-label={alt} />
      </div>
    );
  }
  if (kind === 'audio')
    return (
      <div className={cn(box, 'p-3')} style={{ ...style, height: undefined }}>
        <audio src={src ?? undefined} controls className="w-full" aria-label={alt} />
      </div>
    );
  if (kind === 'image' || posterSrc)
    return (
      <div className={box} style={style}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={(kind === 'image' ? src : posterSrc) ?? undefined} alt={alt} loading="lazy" className={cn('h-full w-full', fit === 'cover' ? 'object-cover' : 'object-contain')} />
      </div>
    );
  return (
    <div className={box} style={style}>
      <div className="flex flex-col items-center gap-1 p-2 text-center text-[12px] text-fg-2">
        <FileText size={20} aria-hidden />
        <span>File Preview Unavailable</span>
      </div>
    </div>
  );
};
