import { readFileSync } from 'node:fs';
import { createApiClient, newIdempotencyKey, type ApiClient } from '@castlane/api-client';
import { authEndpoints, type AnyEndpoint, type EndpointInput, type EndpointResponse } from '@castlane/api-contracts';
import { E2E_BASE_URL, OWNER_STATE } from './env';

const SESSION_COOKIE = 'castlane_session';

/**
 * Test-data setup over the real HTTP API of the running e2e server — the same pipeline the
 * browser goes through: session cookie, session-bound CSRF token, same Origin, Idempotency-Key on
 * creates and If-Match on updates.
 */
export class E2EApi {
  private csrf: string | null = null;
  private readonly client: ApiClient;

  /** `cookieValue` is the session cookie exactly as the browser stores it. */
  constructor(private readonly cookieValue: string) {
    this.client = createApiClient({
      baseUrl: `${E2E_BASE_URL}/api/v1`,
      getCsrfToken: () => this.csrf,
      fetchImpl: (input, init = {}) => {
        const headers = new Headers(init.headers);
        headers.set('origin', E2E_BASE_URL);
        headers.set('cookie', `${SESSION_COOKIE}=${this.cookieValue}`);
        return fetch(input, { ...init, headers });
      },
    });
  }

  /** The Owner signed in by the first-run spec (its saved browser session). */
  static async owner(): Promise<E2EApi> {
    const state = JSON.parse(readFileSync(OWNER_STATE, 'utf8')) as { cookies: { name: string; value: string }[] };
    const cookie = state.cookies.find((c) => c.name === SESSION_COOKIE);
    if (!cookie) throw new Error('The Owner session is missing: run the first-run project first.');
    return new E2EApi(cookie.value).init();
  }

  /** A session token created on the server side (see support/members.ts). */
  static async forSessionToken(token: string): Promise<E2EApi> {
    return new E2EApi(encodeURIComponent(token)).init();
  }

  private async init(): Promise<this> {
    this.csrf = (await this.client.call(authEndpoints.me, {})).csrfToken;
    return this;
  }

  call<E extends AnyEndpoint>(ep: E, input: EndpointInput<E>, opts: { ifMatch?: number } = {}): Promise<EndpointResponse<E>> {
    return this.client.call(ep, input, { idempotencyKey: ep.idempotent ? newIdempotencyKey() : undefined, ifMatch: opts.ifMatch });
  }

  /** PUT one upload part to its signed storage URL (relative URLs resolve against the app origin). */
  async putPart(url: string, body: Buffer, headers: Record<string, string> = {}): Promise<string> {
    const res = await fetch(new URL(url, E2E_BASE_URL), { method: 'PUT', body: new Blob([new Uint8Array(body)]), headers: { ...headers, cookie: `${SESSION_COOKIE}=${this.cookieValue}` } });
    if (!res.ok) throw new Error(`Upload part failed (${res.status}).`);
    return res.headers.get('etag') ?? '';
  }
}

/** Poll until `check` returns a value (for asynchronous server work such as file verification). */
export const eventually = async <T>(check: () => Promise<T | null | undefined | false>, what: string, timeoutMs = 60_000): Promise<T> => {
  const until = Date.now() + timeoutMs;
  for (let delay = 250; ; delay = Math.min(delay * 2, 2000)) {
    const v = await check();
    if (v) return v;
    if (Date.now() > until) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((r) => setTimeout(r, delay));
  }
};
