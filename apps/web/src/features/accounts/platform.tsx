'use client';
import { ArrowSquareOut, Globe, InstagramLogo, TiktokLogo, XLogo, YoutubeLogo } from '@phosphor-icons/react';
import type { ReactNode } from 'react';
import { isSafeUrl } from '@castlane/domain';
import { cn } from '@castlane/ui';
import { label } from '@/lib/labels';
import './labels';

const ICONS: Record<string, ReactNode> = {
  instagram: <InstagramLogo size={16} aria-hidden />,
  tiktok: <TiktokLogo size={16} aria-hidden />,
  youtube: <YoutubeLogo size={16} aria-hidden />,
  x: <XLogo size={16} aria-hidden />,
};

/** Platform as a vector icon plus text (never a "connected" badge — accounts are links only). */
export const PlatformLabel = ({ platform, className, iconOnly }: { platform: string; className?: string; iconOnly?: boolean }) => (
  <span className={cn('inline-flex items-center gap-1.5 text-fg-2', className)}>
    {ICONS[platform] ?? <Globe size={16} aria-hidden />}
    <span className={iconOnly ? 'sr-only' : 'text-[13px]'}>{label('platform', platform)}</span>
  </span>
);

/**
 * Opens a user-entered URL safely in a new tab (http/https only, noopener/noreferrer). Anything
 * else is shown as plain text.
 */
export const ExternalLink = ({ href, children, className, showIcon = true }: { href: string | null | undefined; children?: ReactNode; className?: string; showIcon?: boolean }) => {
  if (!href) return null;
  if (!isSafeUrl(href)) return <span className={cn('break-all text-fg-2', className)}>{children ?? href}</span>;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={cn('inline-flex items-center gap-1 break-all text-primary hover:underline', className)}>
      {children ?? href}
      {showIcon ? <ArrowSquareOut size={12} aria-hidden className="shrink-0" /> : null}
      <span className="sr-only">(opens in a new tab)</span>
    </a>
  );
};

export const accountTitle = (a: { handle: string | null; displayName: string | null; canonicalUrl: string }) => (a.handle ? `@${a.handle}` : (a.displayName ?? a.canonicalUrl));
