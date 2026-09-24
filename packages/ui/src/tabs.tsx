'use client';
import { Tabs as T } from 'radix-ui';
import type { ReactNode } from 'react';
import { cn } from './cn';

export interface TabItem {
  value: string;
  label: ReactNode;
  count?: number;
  hidden?: boolean;
}

/** 44 px tab bar; scrolls horizontally on narrow screens instead of wrapping. */
export const Tabs = ({
  value,
  onValueChange,
  items,
  children,
  className,
  label,
}: {
  value: string;
  onValueChange: (v: string) => void;
  items: TabItem[];
  children?: ReactNode;
  className?: string;
  label: string;
}) => (
  <T.Root value={value} onValueChange={onValueChange} className={className}>
    <T.List aria-label={label} className="flex h-11 items-stretch gap-1 overflow-x-auto border-b border-line [scrollbar-width:none]">
      {items
        .filter((i) => !i.hidden)
        .map((i) => (
          <T.Trigger
            key={i.value}
            value={i.value}
            className={cn(
              'relative inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap px-3 text-[13px] font-medium text-fg-2 hover:text-fg',
              'data-[state=active]:text-fg data-[state=active]:after:absolute data-[state=active]:after:inset-x-2 data-[state=active]:after:bottom-[-1px] data-[state=active]:after:h-[2px] data-[state=active]:after:rounded-full data-[state=active]:after:bg-primary',
              'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--c-focus)]',
            )}
          >
            {i.label}
            {typeof i.count === 'number' ? <span className="rounded-[6px] bg-surface-2 px-1.5 text-[11px] text-fg-2">{i.count}</span> : null}
          </T.Trigger>
        ))}
    </T.List>
    {children}
  </T.Root>
);

export const TabPanel = ({ value, children, className }: { value: string; children: ReactNode; className?: string }) => (
  <T.Content value={value} className={cn('pt-4 focus-visible:outline-none', className)}>
    {children}
  </T.Content>
);
