'use client';
import { useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import type { ApiError } from '@castlane/api-client';
import { ErrorState, NotFoundState, PermissionDenied, Skeleton } from '@castlane/ui';

/**
 * Standard rendering of a query's non-success states (section 4.7): loading skeleton, 403 as
 * Permission Denied, 404 as Not Found (never revealing foreign objects), network/other errors
 * with Retry.
 */
export const QueryState = ({
  query,
  children,
  skeleton,
}: {
  query: { isLoading: boolean; error: ApiError | null; refetch: () => unknown; data?: unknown };
  children: ReactNode;
  skeleton?: ReactNode;
}) => {
  const router = useRouter();
  if (query.isLoading)
    return (
      <>
        {skeleton ?? (
          <div className="flex flex-col gap-3" role="status" aria-label="Loading">
            <Skeleton className="h-8 w-1/3" />
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-64 w-full" />
          </div>
        )}
      </>
    );
  if (query.error) {
    if (query.error.status === 403) return <PermissionDenied />;
    if (query.error.status === 404) return <NotFoundState onBack={() => router.back()} />;
    return <ErrorState description={query.error.network ? 'You appear to be offline.' : query.error.message} onRetry={() => void query.refetch()} />;
  }
  return <>{children}</>;
};
