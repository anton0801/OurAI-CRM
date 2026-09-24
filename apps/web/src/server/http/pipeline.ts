import { ZodError, type z } from 'zod';
import { eq } from 'drizzle-orm';
import {
  AppError,
  isAppError,
  isUuid,
  type ErrorCode,
} from '@castlane/domain';
import {
  executeCommand,
  getAppServices,
  hmac,
  resolveSession,
  resolveWorkspaceActor,
  safeEqual,
  sha256,
  stableHash,
  userRequiresMfa,
  PRE_CSRF_COOKIE,
  SESSION_COOKIE,
  type AppServices,
  type CommandContext,
  type QueryContext,
  type SessionRow,
} from '@castlane/application';
import { users } from '@castlane/database';
import type { AnyEndpoint } from '@castlane/api-contracts';
import { consume } from './rate-limit';
import { matchRoute, type CookieToSet, type HttpInfo, type ResponseControl } from './router';

const MAX_JSON_BYTES = 1_048_576;

export const newRequestId = () => `req_${sha256(`${Date.now()}:${Math.random()}`).slice(0, 12)}`;

export const parseCookies = (header: string | null): Map<string, string> => {
  const out = new Map<string, string>();
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out.set(k, decodeURIComponent(v));
  }
  return out;
};

export const clientIpHash = (req: Request, app: AppServices): string | null => {
  const h = req.headers;
  const ip = app.config.TRUST_PROXY ? (h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? h.get('x-real-ip')) : h.get('x-real-ip');
  return ip ? hmac(app.config.SESSION_SECRET, `ip:${ip}`).slice(0, 24) : null;
};

export const serializeCookie = (c: CookieToSet, secure: boolean): string => {
  const parts = [`${c.name}=${encodeURIComponent(c.value)}`, 'Path=/', 'SameSite=Lax'];
  if (c.httpOnly !== false) parts.push('HttpOnly');
  if (secure) parts.push('Secure');
  if (c.expire) parts.push('Max-Age=0');
  else if (c.maxAgeSeconds) parts.push(`Max-Age=${c.maxAgeSeconds}`);
  return parts.join('; ');
};

/** CSRF token bound to the session (derived, never stored in plain form on the client beyond memory). */
export const sessionCsrfToken = (app: AppServices, session: SessionRow) => hmac(app.config.SESSION_SECRET, `csrf:${session.csrfSecret}`);

export const errorResponse = (
  e: unknown,
  requestId: string,
  app: AppServices | null,
  extraHeaders: Record<string, string> = {},
): Response => {
  let err: AppError;
  if (isAppError(e)) err = e;
  else if (e instanceof ZodError) {
    err = new AppError('VALIDATION_FAILED', 'Some fields need attention.', {
      fieldErrors: e.issues.map((i) => ({ field: i.path.join('.'), code: i.code.toUpperCase(), message: i.message })),
    });
  } else {
    app?.logger.error('unhandled_error', { requestId, error: e instanceof Error ? `${e.name}: ${e.message}` : 'unknown', stack: e instanceof Error ? e.stack?.split('\n').slice(0, 6).join(' | ') : undefined });
    err = new AppError('INTERNAL', 'Something went wrong. The problem was logged; try again.');
  }
  const headers: Record<string, string> = { 'content-type': 'application/json', 'cache-control': 'no-store', ...extraHeaders };
  if (err.retryAfterSeconds) headers['retry-after'] = String(err.retryAfterSeconds);
  return new Response(
    JSON.stringify({
      error: {
        code: err.code,
        message: err.message,
        fieldErrors: err.fieldErrors,
        retryable: err.retryable,
        currentVersion: err.currentVersion,
        requestId,
        details: err.details,
      },
    }),
    { status: err.httpStatus, headers },
  );
};

const queryObject = (url: URL, schema: z.ZodTypeAny): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const key of new Set(url.searchParams.keys())) {
    const all = url.searchParams.getAll(key);
    out[key] = all.length > 1 ? all : all[0];
  }
  void schema;
  return out;
};

const parseIfMatch = (v: string | null): number | undefined => {
  if (!v) return undefined;
  const m = /^(?:W\/)?"?(\d+)"?$/.exec(v.trim());
  if (!m) throw new AppError('MALFORMED_REQUEST', 'If-Match must contain the record version.');
  return Number(m[1]);
};

const checkOrigin = (req: Request, app: AppServices) => {
  const origin = req.headers.get('origin');
  const expected = new URL(app.config.APP_ORIGIN).origin;
  if (origin) {
    if (origin !== expected) throw new AppError('CSRF_REJECTED', 'Cross-site request rejected.');
    return;
  }
  const site = req.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') throw new AppError('CSRF_REJECTED', 'Cross-site request rejected.');
  if (!site && app.config.isProduction) throw new AppError('CSRF_REJECTED', 'Missing request origin.');
};

/**
 * Handle one API request: route → rate limit → session → CSRF → MFA → workspace membership →
 * input validation → Idempotency-Key / If-Match → handler → envelope.
 */
export const dispatch = async (req: Request, path: string): Promise<Response> => {
  const requestId = newRequestId();
  let app: AppServices | null = null;
  const res: ResponseControl = { headers: {}, cookies: [] };
  try {
    app = getAppServices();
    const url = new URL(req.url);
    const method = req.method.toUpperCase();
    const match = matchRoute(method, path);
    if (match === 'method_not_allowed') throw new AppError('MALFORMED_REQUEST', 'Method not allowed for this path.');
    if (!match) throw new AppError('NOT_FOUND', 'Unknown API route.');
    const ep: AnyEndpoint = match.entry.endpoint;
    const cookies = parseCookies(req.headers.get('cookie'));
    const http: HttpInfo = {
      requestId,
      method,
      url,
      ipHash: clientIpHash(req, app),
      userAgent: req.headers.get('user-agent'),
      cookies,
      headers: req.headers,
      request: req,
    };
    const mutation = method !== 'GET' && method !== 'HEAD';
    const at = app.clock.now();

    // Session
    const token = cookies.get(SESSION_COOKIE);
    const session = token ? await resolveSession(app.db, token, at) : null;
    if (ep.auth !== 'public' && !session) {
      if (token) res.cookies.push({ name: SESSION_COOKIE, value: '', expire: true });
      throw new AppError('UNAUTHENTICATED', 'Your session has ended. Sign in again.');
    }

    // Rate limit (per member, or per IP hash for anonymous traffic)
    const budget = ep.rateLimit ?? (mutation ? 'write' : 'read');
    const wait = consume(session?.userId ?? http.ipHash ?? 'anon', budget);
    if (wait) throw new AppError('RATE_LIMITED', 'Too many requests. Try again shortly.', { retryAfterSeconds: wait, retryable: true });

    // CSRF: same-origin + token (session-bound, or double-submit cookie before sign-in)
    if (mutation) {
      checkOrigin(req, app);
      const header = req.headers.get('x-csrf-token') ?? '';
      if (session) {
        if (!safeEqual(header, sessionCsrfToken(app, session))) throw new AppError('CSRF_REJECTED', 'Security token missing or expired. Reload the page.');
      } else {
        const cookie = cookies.get(PRE_CSRF_COOKIE) ?? '';
        if (!cookie || !safeEqual(header, cookie)) throw new AppError('CSRF_REJECTED', 'Security token missing or expired. Reload the page.');
      }
    }

    // MFA and forced password change
    if (session && ep.auth !== 'public' && !ep.allowWithoutMfa) {
      if (!session.mfaVerifiedAt && (await userRequiresMfa(app.db, session.userId, at)))
        throw new AppError('MFA_REQUIRED', 'Set up two-factor authentication to continue.');
      const [u] = await app.db.select({ must: users.mustChangePassword, status: users.status }).from(users).where(eq(users.id, session.userId));
      if (!u || u.status !== 'active') throw new AppError('UNAUTHENTICATED', 'Your account is not active.');
      if (u.must) throw new AppError('FORBIDDEN', 'Change your temporary password to continue.', { details: { passwordChangeRequired: true } });
    }

    // Input
    const params = ep.params.parse(match.params);
    const query = ep.query.parse(queryObject(url, ep.query));
    let rawBody: unknown = {};
    if (mutation) {
      const len = Number(req.headers.get('content-length') ?? '0');
      if (len > MAX_JSON_BYTES) throw new AppError('PAYLOAD_TOO_LARGE', 'The request body is too large.');
      const text = await req.text();
      if (text.length > MAX_JSON_BYTES) throw new AppError('PAYLOAD_TOO_LARGE', 'The request body is too large.');
      if (text) {
        try {
          rawBody = JSON.parse(text);
        } catch {
          throw new AppError('MALFORMED_REQUEST', 'The request body is not valid JSON.');
        }
      }
    }
    const body = ep.body.parse(rawBody);

    const idemKey = req.headers.get('idempotency-key') ?? undefined;
    if (ep.idempotent) {
      if (!idemKey) throw new AppError('IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header is required for this operation.');
      if (!isUuid(idemKey)) throw new AppError('MALFORMED_REQUEST', 'Idempotency-Key must be a UUID.');
    }
    const expectedVersion = parseIfMatch(req.headers.get('if-match'));
    if (ep.ifMatch && expectedVersion === undefined)
      throw new AppError('PRECONDITION_REQUIRED', 'If-Match with the record version is required for this change.');

    // Workspace actor
    let ctx: QueryContext | null = null;
    if (ep.auth === 'workspace') {
      const workspaceId = (params as { workspaceId?: string }).workspaceId;
      if (!workspaceId || !session) throw new AppError('NOT_FOUND', 'Workspace was not found.');
      const actor = await resolveWorkspaceActor(app.db, session, workspaceId, at);
      if (!actor || actor.access.membershipStatus !== 'active') throw new AppError('NOT_FOUND', 'Workspace was not found.');
      ctx = {
        app,
        actor,
        request: { requestId, source: 'ui', expectedVersion, idempotencyKey: idemKey, ipHash: http.ipHash },
      };
    }

    const input = { params, query, body };
    const appRef = app;
    const run = async <T>(fn: (c: CommandContext) => Promise<T>): Promise<T> => {
      if (!ctx) throw new AppError('INTERNAL', 'Command requires a workspace context.');
      const result = await executeCommand(ctx, fn, {
        idempotency: idemKey && ep.idempotent
          ? { routeKey: ep.id, key: idemKey, requestHash: stableHash({ params, body }), replayPermission: ep.permission }
          : undefined,
      });
      if (result.replayed) res.headers['x-idempotent-replay'] = 'true';
      return result.body;
    };

    const data = await match.entry.handler({
      endpoint: ep,
      input,
      http,
      app: appRef,
      session,
      ctx: ctx as QueryContext,
      run,
      res,
    });
    if (res.raw) return withCookies(res.raw, res.cookies, app);

    const headers: Record<string, string> = { 'content-type': 'application/json', 'cache-control': 'no-store', ...res.headers };
    const rv = (data as { rowVersion?: unknown } | null)?.rowVersion;
    if (method === 'GET' && typeof rv === 'number') headers.etag = `"${rv}"`;
    const page = data as { nextCursor?: string | null; hasMore?: boolean } | null;
    const meta: Record<string, unknown> = { requestId, asOf: at.toISOString() };
    if (page && typeof page === 'object' && 'hasMore' in page) {
      meta.nextCursor = page.nextCursor ?? null;
      meta.hasMore = page.hasMore;
    }
    if (res.headers['x-idempotent-replay']) meta.replayed = true;
    const response = new Response(JSON.stringify({ data, meta }), {
      status: res.status ?? ep.successStatus ?? (method === 'POST' && ep.id.endsWith('.create') ? 201 : 200),
      headers,
    });
    return withCookies(response, res.cookies, app);
  } catch (e) {
    const response = errorResponse(e, requestId, app);
    return app ? withCookies(response, res.cookies, app) : response;
  }
};

const withCookies = (response: Response, cookies: CookieToSet[], app: AppServices): Response => {
  if (cookies.length === 0) return response;
  const secure = app.config.APP_ORIGIN.startsWith('https://');
  for (const c of cookies) response.headers.append('set-cookie', serializeCookie(c, secure));
  return response;
};

export type { ErrorCode };
