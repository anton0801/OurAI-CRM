'use client';
import { createApiClient, type ApiClient } from '@castlane/api-client';

/**
 * Browser API client. The CSRF token is the session-bound token handed over by the workspace
 * layout (or /auth/me), or the pre-session double-submit token for sign-in pages. It lives in
 * memory only — never in localStorage.
 */
let csrfToken: string | null = null;
let preSessionPromise: Promise<string | null> | null = null;

export const setCsrfToken = (token: string | null) => {
  csrfToken = token;
};

const fetchPreSessionToken = async (): Promise<string | null> => {
  preSessionPromise ??= fetch('/api/v1/auth/csrf', { credentials: 'same-origin', cache: 'no-store' })
    .then((r) => r.json())
    .then((j: { data?: { csrfToken?: string } }) => j.data?.csrfToken ?? null)
    .catch(() => null)
    .finally(() => {
      preSessionPromise = null;
    });
  return preSessionPromise;
};

export const api: ApiClient = createApiClient({
  getCsrfToken: async () => csrfToken ?? (await fetchPreSessionToken()),
  onUnauthenticated: (e) => {
    if (typeof window === 'undefined') return;
    if (e.code === 'MFA_REQUIRED') {
      window.location.assign(`/auth/mfa?mode=session&returnTo=${encodeURIComponent(window.location.pathname + window.location.search)}`);
      return;
    }
    const path = window.location.pathname;
    if (!path.startsWith('/auth/')) {
      window.location.assign(`/auth/sign-in?expired=1&returnTo=${encodeURIComponent(path + window.location.search)}`);
    }
  },
});
