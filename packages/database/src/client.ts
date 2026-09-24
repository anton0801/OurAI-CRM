import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { PgTransaction } from 'drizzle-orm/pg-core';
import type { NodePgQueryResultHKT } from 'drizzle-orm/node-postgres';
import type { ExtractTablesWithRelations } from 'drizzle-orm';
import pg from 'pg';
import * as schema from './schema';

export type Schema = typeof schema;
export type Db = NodePgDatabase<Schema>;
export type Tx = PgTransaction<NodePgQueryResultHKT, Schema, ExtractTablesWithRelations<Schema>>;
/** Either the pool-backed database or an open transaction. */
export type DbOrTx = Db | Tx;

// BIGINT (int8) → BigInt is handled per-column by drizzle; keep numeric as string (exact decimals).
pg.types.setTypeParser(1700, (v) => v);

export interface DatabaseHandle {
  db: Db;
  pool: pg.Pool;
  close(): Promise<void>;
}

export const createDatabase = (url: string, opts: { max?: number; applicationName?: string } = {}): DatabaseHandle => {
  const pool = new pg.Pool({
    connectionString: url,
    max: opts.max ?? 10,
    application_name: opts.applicationName ?? 'castlane',
    idleTimeoutMillis: 30_000,
    statement_timeout: 30_000,
  });
  // An idle client can be terminated by the server (restart, failover, admin command). Without a
  // listener the 'error' event would crash the process; the pool discards the client and the next
  // query opens a fresh connection.
  pool.on('error', (err) => {
    process.stderr.write(`${JSON.stringify({ t: new Date().toISOString(), level: 'warn', msg: 'db_idle_client_error', errorCode: (err as { code?: string }).code ?? null })}\n`);
  });
  const db = drizzle(pool, { schema });
  return { db, pool, close: () => pool.end() };
};

let shared: DatabaseHandle | undefined;

/** Process-wide database handle built from DATABASE_URL (web and worker). */
export const getDatabase = (): DatabaseHandle => {
  if (!shared) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not configured');
    shared = createDatabase(url, {
      max: Number(process.env.DATABASE_POOL_MAX ?? 10),
      applicationName: process.env.CASTLANE_PROCESS ?? 'castlane',
    });
  }
  return shared;
};

export const setSharedDatabase = (handle: DatabaseHandle | undefined): void => {
  shared = handle;
};

const RETRYABLE_PG_CODES = new Set(['40001', '40P01']);

export const isRetryableTxError = (e: unknown): boolean => {
  const code = (e as { code?: string } | null)?.code ?? (e as { cause?: { code?: string } } | null)?.cause?.code;
  return typeof code === 'string' && RETRYABLE_PG_CODES.has(code);
};

export const pgErrorCode = (e: unknown): string | undefined =>
  (e as { code?: string } | null)?.code ?? (e as { cause?: { code?: string } } | null)?.cause?.code;

export const pgConstraint = (e: unknown): string | undefined =>
  (e as { constraint?: string } | null)?.constraint ?? (e as { cause?: { constraint?: string } } | null)?.cause?.constraint;

/**
 * Run a unit of work in a transaction and retry the whole transaction on serialization
 * failures / deadlocks (PostgreSQL 40001 / 40P01), as recommended by the PostgreSQL docs.
 */
export const withTransaction = async <T>(
  db: Db,
  fn: (tx: Tx) => Promise<T>,
  opts: { isolationLevel?: 'read committed' | 'repeatable read' | 'serializable'; retries?: number } = {},
): Promise<T> => {
  const retries = opts.retries ?? 3;
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.transaction(fn, { isolationLevel: opts.isolationLevel ?? 'read committed' });
    } catch (e) {
      if (attempt < retries && isRetryableTxError(e)) {
        await new Promise((r) => setTimeout(r, 20 * 2 ** attempt + Math.random() * 20));
        continue;
      }
      throw e;
    }
  }
};
