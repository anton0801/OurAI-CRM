'use client';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useMemo } from 'react';

/**
 * Filters, sort, active tab and period live in the URL so deep links and Back work (section 4.6).
 * Values are strings; comma-separated for lists.
 */
export const useUrlState = <K extends string>(defaults: Partial<Record<K, string>> = {}) => {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const state = useMemo(() => {
    const out: Record<string, string | undefined> = { ...defaults };
    params.forEach((v, k) => (out[k] = v));
    return out as Partial<Record<K, string>>;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);
  const set = useCallback(
    (patch: Partial<Record<K, string | null | undefined>>, opts: { replace?: boolean } = {}) => {
      const next = new URLSearchParams(params.toString());
      for (const [k, v] of Object.entries(patch) as [string, string | null | undefined][]) {
        if (v === null || v === undefined || v === '' || v === (defaults as Record<string, string>)[k]) next.delete(k);
        else next.set(k, v);
      }
      const qs = next.toString();
      const url = `${pathname}${qs ? `?${qs}` : ''}`;
      if (opts.replace ?? true) router.replace(url, { scroll: false });
      else router.push(url, { scroll: false });
    },
    [params, pathname, router, defaults],
  );
  const list = useCallback((k: K) => (state[k] ? state[k]!.split(',').filter(Boolean) : []), [state]);
  return { state, set, list };
};
