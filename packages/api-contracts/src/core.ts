import { z } from 'zod';
import type { ErrorCode } from '@castlane/domain';

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/**
 * A single API operation. The server router, the typed client and the OpenAPI document are all
 * generated from these definitions — there is no second hand-written copy of shapes or enums.
 */
export interface Endpoint<
  P extends z.ZodTypeAny = z.ZodTypeAny,
  Q extends z.ZodTypeAny = z.ZodTypeAny,
  B extends z.ZodTypeAny = z.ZodTypeAny,
  R extends z.ZodTypeAny = z.ZodTypeAny,
> {
  id: string;
  method: HttpMethod;
  /** OpenAPI-style path relative to /api/v1, e.g. `/workspaces/{workspaceId}/projects/{projectId}`. */
  path: string;
  summary: string;
  tags: string[];
  /** public: no session; session: signed-in user; workspace: active membership in {workspaceId}. */
  auth: 'public' | 'session' | 'workspace';
  /** Primary permission (documentation + replay check). Object scope is enforced in the use case. */
  permission?: string;
  /** Requires Idempotency-Key (all creates, state commands, financial actions, uploads, imports). */
  idempotent?: boolean;
  /** Requires If-Match with the record's row version. */
  ifMatch?: boolean;
  /** Relax MFA enforcement (used by MFA setup and sign-out). */
  allowWithoutMfa?: boolean;
  params: P;
  query: Q;
  body: B;
  response: R;
  successStatus?: number;
  errors?: ErrorCode[];
  /** Separate rate-limit budget. */
  rateLimit?: 'read' | 'write' | 'expensive' | 'auth' | 'download' | 'none';
}

export type AnyEndpoint = Endpoint<z.ZodTypeAny, z.ZodTypeAny, z.ZodTypeAny, z.ZodTypeAny>;

const empty = z.object({}).strict();
export const emptySchema = empty;

export const endpoint = <
  P extends z.ZodTypeAny = typeof empty,
  Q extends z.ZodTypeAny = typeof empty,
  B extends z.ZodTypeAny = typeof empty,
  R extends z.ZodTypeAny = z.ZodTypeAny,
>(
  def: Omit<Endpoint<P, Q, B, R>, 'params' | 'query' | 'body'> & { params?: P; query?: Q; body?: B },
): Endpoint<P, Q, B, R> =>
  ({
    ...def,
    params: (def.params ?? empty) as P,
    query: (def.query ?? empty) as Q,
    body: (def.body ?? empty) as B,
  }) as Endpoint<P, Q, B, R>;

export type EndpointParams<E extends AnyEndpoint> = z.input<E['params']>;
export type EndpointQuery<E extends AnyEndpoint> = z.input<E['query']>;
export type EndpointBody<E extends AnyEndpoint> = z.input<E['body']>;
export type EndpointResponse<E extends AnyEndpoint> = z.output<E['response']>;

/** A part of the input is optional when it has no required keys (e.g. empty params or all-optional filters). */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
type Field<K extends string, T> = {} extends T ? { [P in K]?: T } : { [P in K]: T };

export type EndpointInput<E extends AnyEndpoint> = Field<'params', EndpointParams<E>> &
  Field<'query', EndpointQuery<E>> &
  Field<'body', EndpointBody<E>>;

export interface ApiEnvelope<T> {
  data: T;
  meta: { requestId: string; asOf: string; nextCursor?: string | null; hasMore?: boolean; replayed?: boolean };
}

export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    fieldErrors: { field: string; code: string; message: string }[];
    retryable: boolean;
    currentVersion?: number;
    requestId: string;
    details?: Record<string, unknown>;
  };
}

export const buildPath = (template: string, params: Record<string, unknown> = {}): string =>
  template.replace(/\{(\w+)\}/g, (_, k: string) => {
    const v = params[k];
    if (v === undefined || v === null) throw new Error(`Missing path parameter ${k}`);
    return encodeURIComponent(String(v));
  });
