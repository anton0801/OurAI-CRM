import { cn } from './cn';

export const Spinner = ({ size = 18, className, label }: { size?: number; className?: string; label?: string }) => (
  <svg
    className={cn('animate-spin motion-reduce:animate-none', className)}
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    role={label ? 'img' : undefined}
    aria-label={label}
    aria-hidden={label ? undefined : true}
  >
    <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
    <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
  </svg>
);
