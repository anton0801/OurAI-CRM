'use client';
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cn } from './cn';
import { Spinner } from './spinner';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-secondary';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
  loading?: boolean;
  icon?: ReactNode;
  iconRight?: ReactNode;
}

const variants: Record<ButtonVariant, string> = {
  primary: 'bg-primary text-on-primary hover:bg-primary-hover border border-transparent',
  secondary: 'bg-surface text-fg border border-line hover:bg-surface-2',
  ghost: 'bg-transparent text-fg border border-transparent hover:bg-surface-2',
  danger: 'bg-danger text-surface border border-transparent hover:opacity-90',
  'danger-secondary': 'bg-surface text-danger border border-line hover:bg-danger-soft',
};

/**
 * 36 px desktop / 44 px touch. While loading the button keeps its width and ignores repeated
 * clicks, so a double click never sends a second request.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading = false, icon, iconRight, className, children, disabled, onClick, type, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      aria-busy={loading || undefined}
      disabled={disabled}
      onClick={(e) => {
        if (loading) {
          e.preventDefault();
          return;
        }
        onClick?.(e);
      }}
      className={cn(
        'relative inline-flex shrink-0 select-none items-center justify-center gap-2 whitespace-nowrap rounded-[8px] font-semibold transition-colors duration-[120ms]',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--c-focus)]',
        'disabled:cursor-not-allowed disabled:opacity-50',
        size === 'md' ? 'h-11 px-[14px] text-[13px] leading-5 md:h-9' : 'h-9 px-3 text-[12px] leading-[18px] md:h-8',
        variants[variant],
        className,
      )}
      {...rest}
    >
      <span className={cn('inline-flex items-center gap-2', loading && 'invisible')}>
        {icon}
        {children}
        {iconRight}
      </span>
      {loading && (
        <span className="absolute inset-0 flex items-center justify-center">
          <Spinner size={16} />
        </span>
      )}
    </button>
  );
});
