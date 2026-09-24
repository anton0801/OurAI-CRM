'use client';
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cn } from './cn';
import { Tooltip } from './tooltip';

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  icon: ReactNode;
  tooltip?: boolean;
  variant?: 'ghost' | 'secondary';
}

/** 32×32 visual, 44×44 touch target, always has an accessible name and a keyboard-reachable tooltip. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, tooltip = true, variant = 'ghost', className, type, ...rest },
  ref,
) {
  const btn = (
    <button
      ref={ref}
      type={type ?? 'button'}
      aria-label={label}
      className={cn(
        'relative inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[8px] text-fg-2 transition-colors duration-[120ms] md:h-8 md:w-8',
        'hover:bg-surface-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--c-focus)]',
        'disabled:cursor-not-allowed disabled:opacity-50',
        variant === 'secondary' && 'border border-line bg-surface',
        className,
      )}
      {...rest}
    >
      {icon}
    </button>
  );
  return tooltip ? <Tooltip content={label}>{btn}</Tooltip> : btn;
});
