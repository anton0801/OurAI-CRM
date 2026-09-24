'use client';
import { Tooltip as T } from 'radix-ui';
import type { ReactNode } from 'react';

export const TooltipProvider = ({ children }: { children: ReactNode }) => (
  <T.Provider delayDuration={400} skipDelayDuration={200}>
    {children}
  </T.Provider>
);

export const Tooltip = ({ content, children, side = 'top' }: { content: ReactNode; children: ReactNode; side?: 'top' | 'bottom' | 'left' | 'right' }) => (
  <T.Root>
    <T.Trigger asChild>{children}</T.Trigger>
    <T.Portal>
      <T.Content
        side={side}
        sideOffset={6}
        className="z-[70] max-w-[280px] rounded-[6px] bg-fg px-2 py-1 text-[12px] leading-[18px] text-surface shadow-[var(--shadow-overlay)]"
      >
        {content}
      </T.Content>
    </T.Portal>
  </T.Root>
);
