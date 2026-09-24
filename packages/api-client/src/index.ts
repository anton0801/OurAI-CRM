import {
  buildPath,
  type AnyEndpoint,
  type ApiEnvelope,
  type ApiErrorBody,
  type EndpointInput,
  type EndpointResponse,
} from '@castlane/api-contracts';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fieldErrors: { field: string; code: string; message: string }[];
  readonly retryable: boolean;
  readonly currentVersion?: number;
  readonly requestId?: string;
  readonly details?: Record<string, unknown>;
  readonly retryAfterSeconds?: number;
  /** True when the request never reached the server (offline / network failure). */
  readonly network: boolean;

  constructor(init: {
    status: number;
    code: string;
    message: string;
    fieldErrors?: ApiError['fieldErrors'];
    retryable?: boolean;
    currentVersion?: number;
    requestId?: string;
    details?: Record<string, unknown>;
    retryAfterSeconds?: number;
    network?: boolean;
  }) {
    super(init.message);
    this.name = 'ApiError';
    this.status = init.status;
    this.code = init.code;
    this.fieldErrors = init.fieldErrors ?? [];
    this.retryable = init.retryable ?? false;
    this.currentVersion = init.currentVersion;
    this.requestId = init.requestId;
    this.details = init.details;
    this.retryAfterSeconds = init.retryAfterSeconds;
    this.network = init.network ?? false;
  }

  get isConflict() {
    return this.code === 'VERSION_CONFLICT';
  }
}

export const isApiError = (e: unknown): e is ApiError => e instanceof ApiError;

export interface CallOptions {
  /** Reuse the same key when retrying the same logical operation. */
  idempotencyKey?: string;
  /** Row version the user edited (If-Match). */
  ifMatch?: number;
  signal?: AbortSignal;
}

export interface ApiClientOptions {
  baseUrl?: string;
  getCsrfToken: () => string | null | Promise<string | null>;
  onUnauthenticated?: (e: ApiError) => void;
  fetchImpl?: typeof fetch;
}

const encodeQuery = (query: Record<string, unknown> | undefined): string => {
  if (!query) return '';
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) {
      if (v.length) qs.set(k, v.map(String).join(','));
    } else if (typeof v === 'object') qs.set(k, JSON.stringify(v));
    else qs.set(k, String(v));
  }
  const s = qs.toString();
  return s ? `?${s}` : '';
};

export const newIdempotencyKey = (): string => globalThis.crypto.randomUUID();

export const createApiClient = (opts: ApiClientOptions) => {
  const base = opts.baseUrl ?? '/api/v1';
  const f = opts.fetchImpl ?? fetch;

  const request = async <E extends AnyEndpoint>(ep: E, input: EndpointInput<E>, o: CallOptions = {}): Promise<ApiEnvelope<EndpointResponse<E>>> => {
    const i = input as { params?: Record<string, unknown>; query?: Record<string, unknown>; body?: unknown };
    const url = `${base}${buildPath(ep.path, i.params)}${encodeQuery(i.query)}`;
    const headers: Record<string, string> = { accept: 'application/json' };
    const mutation = ep.method !== 'GET';
    if (mutation) {
      headers['content-type'] = 'application/json';
      const csrf = await opts.getCsrfToken();
      if (csrf) headers['x-csrf-token'] = csrf;
      if (ep.idempotent) headers['idempotency-key'] = o.idempotencyKey ?? newIdempotencyKey();
    }
    if (o.ifMatch !== undefined) headers['if-match'] = `"${o.ifMatch}"`;
    let res: Response;
    try {
      res = await f(url, {
        method: ep.method,
        headers,
        body: mutation ? JSON.stringify(i.body ?? {}) : undefined,
        credentials: 'same-origin',
        signal: o.signal,
        cache: 'no-store',
      });
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e;
      throw new ApiError({ status: 0, code: 'NETWORK', message: 'You appear to be offline. The change was not saved.', network: true, retryable: true });
    }
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const body = (json as ApiErrorBody | null)?.error;
      const err = new ApiError({
        status: res.status,
        code: body?.code ?? 'HTTP_ERROR',
        message: body?.message ?? `Request failed (${res.status}).`,
        fieldErrors: body?.fieldErrors,
        retryable: body?.retryable,
        currentVersion: body?.currentVersion,
        requestId: body?.requestId,
        details: body?.details,
        retryAfterSeconds: Number(res.headers.get('retry-after') ?? '') || undefined,
      });
      if (res.status === 401) opts.onUnauthenticated?.(err);
      throw err;
    }
    return json as ApiEnvelope<EndpointResponse<E>>;
  };

  return {
    request,
    call: async <E extends AnyEndpoint>(ep: E, input: EndpointInput<E>, o?: CallOptions): Promise<EndpointResponse<E>> =>
      (await request(ep, input, o)).data,
  };
};

export type ApiClient = ReturnType<typeof createApiClient>;
