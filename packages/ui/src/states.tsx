'use client';
import { FunnelSimple, LockSimple, MagnifyingGlass, WarningCircle, WifiSlash } from '@phosphor-icons/react';
import type { ReactNode } from 'react';
import { Button } from './button';
import { cn } from './cn';

/** Skeleton mirrors the final geometry; it never shows fake values or avatars. */
export const Skeleton = ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
  <span aria-hidden className={cn('block animate-pulse rounded-[6px] bg-surface-2 motion-reduce:animate-none', className)} style={style} />
);

export const TableSkeleton = ({ rows = 6, columns = 5 }: { rows?: number; columns?: number }) => (
  <div role="status" aria-label="Loading" className="overflow-hidden rounded-[12px] border border-line bg-surface">
    <div className="flex h-10 items-center gap-4 border-b border-line px-4">
      {Array.from({ length: columns }, (_, i) => (
        <Skeleton key={i} className="h-3 flex-1" />
      ))}
    </div>
    {Array.from({ length: rows }, (_, r) => (
      <div key={r} className="flex h-12 items-center gap-4 border-b border-line px-4 last:border-b-0">
        {Array.from({ length: columns }, (_, i) => (
          <Skeleton key={i} className="h-3 flex-1" style={{ opacity: 1 - i * 0.1 }} />
        ))}
      </div>
    ))}
  </div>
);

export const EmptyState = ({
  title,
  description,
  action,
  icon,
  className,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
  className?: string;
}) => (
  <div className={cn('flex flex-col items-center justify-center rounded-[12px] border border-dashed border-line bg-surface px-6 py-12 text-center', className)}>
    {icon ? <div className="mb-3 text-fg-2">{icon}</div> : null}
    <h2 className="text-[16px] font-semibold leading-6 text-fg">{title}</h2>
    {description ? <p className="mt-1 max-w-[480px] text-[14px] leading-[22px] text-fg-2">{description}</p> : null}
    {action ? <div className="mt-5 flex flex-wrap justify-center gap-2">{action}</div> : null}
  </div>
);

export const NoResults = ({ onClear }: { onClear?: () => void }) => (
  <EmptyState
    icon={<FunnelSimple size={28} />}
    title="No records match these filters"
    description="Change or clear the filters to see more."
    action={onClear ? <Button onClick={onClear}>Clear Filters</Button> : undefined}
  />
);

export const PermissionDenied = ({ description }: { description?: string }) => (
  <EmptyState
    icon={<LockSimple size={28} />}
    title="You don’t have access to this section"
    description={description ?? 'Your role does not include this permission. Ask a workspace administrator if you need access.'}
  />
);

export const NotFoundState = ({ onBack }: { onBack?: () => void }) => (
  <EmptyState
    icon={<MagnifyingGlass size={28} />}
    title="Not found"
    description="This item does not exist or you no longer have access to it."
    action={onBack ? <Button onClick={onBack}>Back</Button> : undefined}
  />
);

export const ErrorState = ({ title, description, onRetry }: { title?: string; description?: string; onRetry?: () => void }) => (
  <EmptyState
    icon={<WarningCircle size={28} />}
    title={title ?? 'This section could not be loaded'}
    description={description ?? 'Check your connection and try again.'}
    action={onRetry ? <Button onClick={onRetry}>Retry</Button> : undefined}
  />
);

export const OfflineNotice = () => (
  <div role="status" className="flex items-center justify-center gap-2 bg-warning-soft px-4 py-2 text-[13px] font-medium text-warning">
    <WifiSlash size={16} aria-hidden /> You are offline. Changes are not being saved.
  </div>
);

export const Banner = ({ tone = 'info', children, action, className }: { tone?: 'info' | 'warning' | 'danger' | 'success'; children: ReactNode; action?: ReactNode; className?: string }) => (
  <div
    role={tone === 'danger' ? 'alert' : 'status'}
    className={cn(
      'flex flex-wrap items-center justify-between gap-3 rounded-[12px] px-4 py-3 text-[13px] leading-5',
      tone === 'info' && 'bg-info-soft text-info',
      tone === 'warning' && 'bg-warning-soft text-warning',
      tone === 'danger' && 'bg-danger-soft text-danger',
      tone === 'success' && 'bg-selection text-primary',
      className,
    )}
  >
    <div className="min-w-0 flex-1">{children}</div>
    {action}
  </div>
);
