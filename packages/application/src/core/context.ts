import type { AccessSnapshot } from '@castlane/authorization';
import type { Db, Tx } from '@castlane/database';
import type { Clock } from '@castlane/domain';
import type { MalwareScanner, StorageAdapter } from '@castlane/storage';
import type { AppConfig } from './config';

export type ChangeSource = 'ui' | 'api' | 'import' | 'automation' | 'system';

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

/** Process-wide services (constructed once in web and worker). */
export interface AppServices {
  db: Db;
  clock: Clock;
  config: AppConfig;
  storage: StorageAdapter;
  scanner: MalwareScanner;
  logger: Logger;
}

export interface Causation {
  rootEventId: string;
  parentEventId: string | null;
  depth: number;
}

/**
 * The authenticated principal. `system` actors (worker, bootstrap) carry an explicit access
 * snapshot too — automations run with the intersection of their owner's rights and rule scope.
 */
export interface Actor {
  kind: 'user' | 'system' | 'automation' | 'import';
  userId: string | null;
  membershipId: string | null;
  workspaceId: string;
  displayName: string;
  access: AccessSnapshot;
  sessionId?: string;
  /** Session MFA verification time (null when not verified). */
  mfaVerifiedAt?: Date | null;
  recentAuthAt?: Date | null;
  timezone: string;
}

export interface RequestInfo {
  requestId: string;
  source: ChangeSource;
  /** Parsed If-Match (row version) for commands on existing records. */
  expectedVersion?: number;
  idempotencyKey?: string;
  causation?: Causation;
  ipHash?: string | null;
}

/** Context for read use cases. */
export interface QueryContext {
  app: AppServices;
  actor: Actor;
  request: RequestInfo;
}

/** Context for write use cases: always inside a transaction. */
export interface CommandContext extends QueryContext {
  tx: Tx;
  /** Domain events emitted in this transaction (for response metadata / tests). */
  emitted: { id: string; type: string }[];
}

export const now = (ctx: { app: AppServices }): Date => ctx.app.clock.now();

/** The executor for reads: the open transaction inside commands (sees own writes), else the pool. */
export const dbOf = (ctx: QueryContext | CommandContext) => ('tx' in ctx ? ctx.tx : ctx.app.db);

/**
 * Run independent reads concurrently on the pool, but sequentially inside a transaction (a single
 * connection must never execute overlapping queries).
 */
export const all = async <T extends readonly (() => Promise<unknown>)[]>(
  ctx: QueryContext | CommandContext,
  fns: T,
): Promise<{ -readonly [K in keyof T]: Awaited<ReturnType<T[K]>> }> => {
  if ('tx' in ctx) {
    const out: unknown[] = [];
    for (const f of fns) out.push(await f());
    return out as never;
  }
  return (await Promise.all(fns.map((f) => f()))) as never;
};
