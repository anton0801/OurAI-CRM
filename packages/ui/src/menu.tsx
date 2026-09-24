'use client';
import { DropdownMenu as M } from 'radix-ui';
import type { ReactNode } from 'react';
import { cn } from './cn';

export interface MenuItem {
  label: string;
  onSelect?: () => void;
  href?: string;
  icon?: ReactNode;
  destructive?: boolean;
  disabled?: boolean;
  hidden?: boolean;
  separatorBefore?: boolean;
  description?: string;
}

export const Menu = ({ trigger, items, align = 'end', label }: { trigger: ReactNode; items: MenuItem[]; align?: 'start' | 'end'; label?: string }) => (
  <M.Root modal={false}>
    <M.Trigger asChild>{trigger}</M.Trigger>
    <M.Portal>
      <M.Content
        align={align}
        sideOffset={4}
        collisionPadding={8}
        aria-label={label}
        className="z-[60] min-w-[200px] max-w-[320px] rounded-[8px] border border-line bg-surface p-1 shadow-[var(--shadow-overlay)]"
      >
        {items
          .filter((i) => !i.hidden)
          .map((i, idx) => (
            <div key={`${i.label}-${idx}`}>
              {i.separatorBefore && idx > 0 ? <M.Separator className="my-1 h-px bg-line" /> : null}
              <M.Item
                disabled={i.disabled}
                onSelect={() => {
                  if (i.href) window.location.assign(i.href);
                  i.onSelect?.();
                }}
                className={cn(
                  'flex cursor-pointer select-none items-start gap-2 rounded-[6px] px-2 py-1.5 text-[13px] leading-5 outline-none',
                  'data-[highlighted]:bg-surface-2 data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50',
                  i.destructive ? 'text-danger' : 'text-fg',
                )}
              >
                {i.icon ? <span className="mt-0.5 shrink-0">{i.icon}</span> : null}
                <span className="flex flex-col">
                  {i.label}
                  {i.description ? <span className="text-[12px] leading-[18px] text-fg-2">{i.description}</span> : null}
                </span>
              </M.Item>
            </div>
          ))}
      </M.Content>
    </M.Portal>
  </M.Root>
);
