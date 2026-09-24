'use client';
import { EyeSlash, File, FileAudio, FileVideo, FileZip, Image as ImageIcon, LinkSimple } from '@phosphor-icons/react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import type { AssetView } from '@castlane/api-contracts';
import { Badge, Checkbox, StatusBadge, cn, formatBytes } from '@castlane/ui';
import { label } from '@/lib/labels';
import { effectiveStatus } from './library-utils';

const KIND_ICON: Record<string, ReactNode> = {
  image: <ImageIcon size={28} aria-hidden />,
  video: <FileVideo size={28} aria-hidden />,
  audio: <FileAudio size={28} aria-hidden />,
  archive: <FileZip size={28} aria-hidden />,
  document: <File size={28} aria-hidden />,
  other: <File size={28} aria-hidden />,
  external_link: <LinkSimple size={28} aria-hidden />,
};

/**
 * Thumbnail box for a file: authorised derivative (cover-fit, 4:3), a neutral placeholder for
 * restricted media, an honest "External Link" tile, or the file type when no preview exists.
 */
export const AssetTile = ({ a, className, compact }: { a: AssetView; className?: string; compact?: boolean }) => {
  const box = cn('flex aspect-[4/3] w-full items-center justify-center overflow-hidden bg-surface-2 text-fg-2', className);
  const caption = (text: string) => (compact ? <span className="sr-only">{text}</span> : text);
  if (a.restrictedHidden)
    return (
      <span className={box}>
        <span className="flex flex-col items-center gap-1 text-[12px]">
          <EyeSlash size={compact ? 16 : 24} aria-hidden /> {caption('Restricted media')}
        </span>
      </span>
    );
  if (a.kind === 'external_link')
    return (
      <span className={box}>
        <span className="flex flex-col items-center gap-1 text-[12px]">
          <LinkSimple size={compact ? 16 : 28} aria-hidden />
          {caption('External Link')}
        </span>
      </span>
    );
  if (a.thumbnailUrl)
    return (
      <span className={box}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={a.thumbnailUrl} alt="" loading="lazy" className="h-full w-full object-cover" />
      </span>
    );
  return (
    <span className={box}>
      <span className={cn('flex flex-col items-center gap-1 text-[12px]', compact && '[&_svg]:h-4 [&_svg]:w-4')}>
        {KIND_ICON[a.kind] ?? KIND_ICON.other}
        {caption(label('assetKind', a.kind))}
      </span>
    </span>
  );
};

export const AssetCard = ({ a, href, selected, onSelectedChange, selectable }: { a: AssetView; href: string; selected: boolean; onSelectedChange: (v: boolean) => void; selectable: boolean }) => {
  const status = effectiveStatus(a);
  return (
    <div className={cn('group relative flex h-full flex-col overflow-hidden rounded-[12px] border bg-surface', selected ? 'border-primary' : 'border-line hover:border-fg-muted')}>
      {selectable ? (
        <div className="absolute left-2 top-2 z-[1] rounded-[6px] bg-surface/90 p-1">
          <Checkbox checked={selected} onCheckedChange={onSelectedChange} aria-label={`Select ${a.name}`} />
        </div>
      ) : null}
      <Link href={href} className="flex flex-1 flex-col focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--c-focus)]">
        <AssetTile a={a} />
        <span className="flex min-w-0 flex-col gap-1 p-3">
          <span className="truncate text-[13px] font-medium text-fg" title={a.name}>
            {a.name}
          </span>
          <span className="flex flex-wrap items-center gap-1.5 text-[12px] text-fg-2">
            <span>{label('assetKind', a.kind)}</span>
            {a.currentVersion?.byteSize ? <span>· {formatBytes(a.currentVersion.byteSize)}</span> : null}
            {a.currentVersion && a.currentVersion.versionNo > 1 ? <span>· v{a.currentVersion.versionNo}</span> : null}
          </span>
          <span className="flex flex-wrap gap-1">
            {status !== 'available' && status !== 'external' ? <StatusBadge status={status} label={label('assetStatus', status)} /> : null}
            {a.sensitivity === 'restricted' ? <Badge tone="warning">Restricted</Badge> : null}
            {a.archivedAt ? <Badge>Archived</Badge> : null}
          </span>
        </span>
      </Link>
    </div>
  );
};
