'use client';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type QueryKey, type UseQueryOptions } from '@tanstack/react-query';
import { useCallback, useRef } from 'react';
import type { AnyEndpoint, EndpointInput, EndpointResponse } from '@castlane/api-contracts';
import { isApiError, newIdempotencyKey, type ApiError, type CallOptions } from '@castlane/api-client';
import { toast } from '@castlane/ui';
import { api } from './api';

/** Query key: endpoint id + its input, so invalidation by endpoint id is straightforward. */
export const keyFor = <E extends AnyEndpoint>(ep: E, input?: EndpointInput<E>): QueryKey => [ep.id, input ?? {}];

export const useApiQuery = <E extends AnyEndpoint>(
  ep: E,
  input: EndpointInput<E>,
  opts: Omit<UseQueryOptions<EndpointResponse<E>, ApiError>, 'queryKey' | 'queryFn'> = {},
) =>
  useQuery<EndpointResponse<E>, ApiError>({
    queryKey: keyFor(ep, input),
    queryFn: ({ signal }) => api.call(ep, input, { signal }),
    retry: (count, err) => (isApiError(err) ? err.network && count < 2 : count < 2),
    ...opts,
  });

export interface MutationOptions<E extends AnyEndpoint> {
  onSuccess?: (data: EndpointResponse<E>, input: EndpointInput<E>) => void | Promise<void>;
  onError?: (error: ApiError) => void;
  /** Endpoint ids whose cached queries become stale after success. */
  invalidate?: string[];
  successMessage?: string | ((data: EndpointResponse<E>) => string);
  /** Suppress the default error toast (e.g. when errors are shown inline in a form). */
  silentErrors?: boolean;
}

/**
 * Mutation hook with safe retries: the same Idempotency-Key is reused until the operation
 * succeeds (or the input changes), so "Retry" after a lost response never duplicates records.
 */
export const useApiMutation = <E extends AnyEndpoint>(ep: E, opts: MutationOptions<E> = {}) => {
  const qc = useQueryClient();
  const keyRef = useRef<{ key: string; fingerprint: string } | null>(null);
  const m = useMutation<EndpointResponse<E>, ApiError, { input: EndpointInput<E>; options?: CallOptions }>({
    mutationFn: ({ input, options }) => {
      const fingerprint = JSON.stringify(input);
      if (!keyRef.current || keyRef.current.fingerprint !== fingerprint) keyRef.current = { key: newIdempotencyKey(), fingerprint };
      return api.call(ep, input, { ...options, idempotencyKey: options?.idempotencyKey ?? keyRef.current.key });
    },
    onSuccess: async (data, vars) => {
      keyRef.current = null;
      if (opts.invalidate?.length) await Promise.all(opts.invalidate.map((id) => qc.invalidateQueries({ queryKey: [id] })));
      const msg = typeof opts.successMessage === 'function' ? opts.successMessage(data) : opts.successMessage;
      if (msg) toast.success(msg);
      await opts.onSuccess?.(data, vars.input);
    },
    onError: (err) => {
      // Keep the key when the request may have reached the server; drop it for definite rejections.
      if (!err.network && err.status !== 409 && err.status < 500) keyRef.current = null;
      opts.onError?.(err);
      if (!opts.silentErrors) {
        if (err.network) toast.error('You are offline', 'Changes are not being saved. Retry when the connection is back.');
        else if (err.code !== 'VALIDATION_FAILED' && err.code !== 'VERSION_CONFLICT') toast.error(err.message);
      }
    },
  });
  const mutate = useCallback((input: EndpointInput<E>, options?: CallOptions) => m.mutateAsync({ input, options }), [m]);
  return { ...m, run: mutate };
};

/** Map server field errors onto a react-hook-form instance. */
export const applyFieldErrors = (
  err: unknown,
  setError: (name: never, e: { type: string; message: string }) => void,
): boolean => {
  if (!isApiError(err) || err.fieldErrors.length === 0) return false;
  for (const f of err.fieldErrors) setError(f.field.replace(/^body\./, '') as never, { type: f.code, message: f.message });
  return true;
};

/**
 * Cursor pagination ("Load More"). The query input must not contain `cursor`; it is managed here.
 * Items from all loaded pages are flattened.
 */
export const useApiInfinite = <E extends AnyEndpoint>(
  ep: E,
  input: EndpointInput<E>,
  opts: { enabled?: boolean } = {},
) => {
  const q = useInfiniteQuery<EndpointResponse<E>, ApiError>({
    queryKey: keyFor(ep, input),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => {
      const i = input as { query?: Record<string, unknown> };
      return api.call(ep, { ...(input as object), query: { ...(i.query ?? {}), cursor: pageParam } } as EndpointInput<E>, { signal });
    },
    getNextPageParam: (last) => ((last as { hasMore?: boolean; nextCursor?: string | null }).hasMore ? ((last as { nextCursor?: string | null }).nextCursor ?? undefined) : undefined),
    enabled: opts.enabled,
  });
  type Item = EndpointResponse<E> extends { items: (infer I)[] } ? I : never;
  const items = (q.data?.pages ?? []).flatMap((p) => (p as unknown as { items: Item[] }).items);
  return { ...q, items };
};
