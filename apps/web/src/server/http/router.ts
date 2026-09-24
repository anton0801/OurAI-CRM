import type { z } from 'zod';
import type { AnyEndpoint } from '@castlane/api-contracts';
import type { AppServices, CommandContext, QueryContext, SessionRow } from '@castlane/application';

export interface CookieToSet {
  name: string;
  value: string;
  maxAgeSeconds?: number;
  httpOnly?: boolean;
  expire?: boolean;
}

export interface ResponseControl {
  status?: number;
  headers: Record<string, string>;
  cookies: CookieToSet[];
  /** Raw non-JSON response (downloads, SSE). */
  raw?: Response;
}

export interface HttpInfo {
  requestId: string;
  method: string;
  url: URL;
  ipHash: string | null;
  userAgent: string | null;
  cookies: Map<string, string>;
  headers: Headers;
  request: Request;
}

export interface HandlerArgs<E extends AnyEndpoint> {
  endpoint: E;
  input: { params: z.output<E['params']>; query: z.output<E['query']>; body: z.output<E['body']> };
  http: HttpInfo;
  app: AppServices;
  session: SessionRow | null;
  /** Present for auth: 'workspace' endpoints. */
  ctx: QueryContext;
  /** Execute a write use case in one transaction with idempotency bookkeeping. */
  run: <T>(fn: (c: CommandContext) => Promise<T>) => Promise<T>;
  res: ResponseControl;
}

export type Handler<E extends AnyEndpoint> = (args: HandlerArgs<E>) => Promise<z.input<E['response']>>;

interface RouteEntry {
  endpoint: AnyEndpoint;
  handler: Handler<AnyEndpoint>;
  regex: RegExp;
  keys: string[];
}

const routes: RouteEntry[] = [];

const compile = (path: string) => {
  const keys: string[] = [];
  const pattern = path.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{(\w+)\}/g, (_m, key: string) => {
    keys.push(key);
    return '([^/]+)';
  });
  return { regex: new RegExp(`^${pattern}$`), keys };
};

/** Register a handler for an endpoint contract. Duplicate registrations are a programming error. */
export const route = <E extends AnyEndpoint>(endpoint: E, handler: Handler<E>): void => {
  const existing = routes.findIndex((r) => r.endpoint.id === endpoint.id);
  if (existing >= 0) {
    // Hot module reload re-runs handler modules in development: replace the stale registration.
    if (process.env.NODE_ENV === 'production') throw new Error(`Duplicate route ${endpoint.id}`);
    routes.splice(existing, 1);
  }
  const { regex, keys } = compile(endpoint.path);
  routes.push({ endpoint, handler: handler as unknown as Handler<AnyEndpoint>, regex, keys });
};

export const matchRoute = (method: string, path: string) => {
  let methodMismatch = false;
  for (const r of routes) {
    const m = r.regex.exec(path);
    if (!m) continue;
    if (r.endpoint.method !== method) {
      methodMismatch = true;
      continue;
    }
    const params: Record<string, string> = {};
    r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1]!)));
    return { entry: r, params };
  }
  return methodMismatch ? ('method_not_allowed' as const) : null;
};

export const registeredRoutes = () => routes.map((r) => r.endpoint);
