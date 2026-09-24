import { createApiClient, newIdempotencyKey, type ApiClient } from '@castlane/api-client';
import type { AnyEndpoint, EndpointInput, EndpointResponse } from '@castlane/api-contracts';
import { authEndpoints } from '@castlane/api-contracts';
import { SESSION_COOKIE } from '@castlane/application';
import { dispatch } from '@/server/http/pipeline';
import '@/server/handlers';

const ORIGIN = 'http://localhost:3000';

/**
 * In-process HTTP client: every call goes through the real API pipeline (routing, session,
 * CSRF, MFA gate, validation, idempotency, If-Match, error envelope) without a network server.
 */
export class TestClient {
  cookies = new Map<string, string>();
  csrf: string | null = null;
  readonly api: ApiClient;
  lastStatus = 0;
  lastHeaders: Headers | null = null;

  constructor(sessionToken?: string) {
    if (sessionToken) this.cookies.set(SESSION_COOKIE, sessionToken);
    this.api = createApiClient({
      baseUrl: '/api/v1',
      getCsrfToken: () => this.csrf,
      fetchImpl: this.fetch,
    });
  }

  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input), ORIGIN);
    const headers = new Headers(init.headers);
    headers.set('origin', ORIGIN);
    headers.set('x-real-ip', '127.0.0.1');
    if (this.cookies.size) headers.set('cookie', [...this.cookies].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; '));
    const req = new Request(url, { ...init, headers });
    const res = await dispatch(req, url.pathname.replace(/^\/api\/v1/, ''));
    this.lastStatus = res.status;
    this.lastHeaders = res.headers;
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split(';');
      const [k, v = ''] = pair!.split('=');
      if (attrs.some((a) => a.trim().toLowerCase() === 'max-age=0')) this.cookies.delete(k!.trim());
      else this.cookies.set(k!.trim(), decodeURIComponent(v));
    }
    return res;
  };

  /** Load the session CSRF token (or pre-session token) like the browser does. */
  async init(): Promise<this> {
    if (this.cookies.has(SESSION_COOKIE)) {
      const me = await this.api.call(authEndpoints.me, {});
      this.csrf = me.csrfToken;
    } else {
      const r = await this.api.call(authEndpoints.csrf, {});
      this.csrf = r.csrfToken;
    }
    return this;
  }

  call<E extends AnyEndpoint>(ep: E, input: EndpointInput<E>, opts: { idempotencyKey?: string; ifMatch?: number } = {}): Promise<EndpointResponse<E>> {
    return this.api.call(ep, input, { idempotencyKey: opts.idempotencyKey ?? (ep.idempotent ? newIdempotencyKey() : undefined), ifMatch: opts.ifMatch });
  }

  /** Call and capture the error instead of throwing (status + code assertions). */
  async attempt<E extends AnyEndpoint>(ep: E, input: EndpointInput<E>, opts: { idempotencyKey?: string; ifMatch?: number } = {}) {
    try {
      const data = await this.call(ep, input, opts);
      return { ok: true as const, status: this.lastStatus, data, code: null as string | null, error: null };
    } catch (e) {
      const err = e as { status: number; code: string; message: string; fieldErrors?: unknown };
      return { ok: false as const, status: err.status, data: null, code: err.code, error: err };
    }
  }

  /** Raw request (to test missing headers, CSRF, malformed input). */
  raw(method: string, path: string, init: { body?: unknown; headers?: Record<string, string> } = {}) {
    return this.fetch(`${ORIGIN}/api/v1${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(this.csrf ? { 'x-csrf-token': this.csrf } : {}), ...(init.headers ?? {}) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  }
}

export const clientFor = async (sessionToken?: string) => new TestClient(sessionToken).init();
