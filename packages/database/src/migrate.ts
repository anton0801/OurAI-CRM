import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { seedSystemCatalog } from './seed-system';

const here = dirname(fileURLToPath(import.meta.url));
/** Bundled deployments (worker image) point this at a folder containing `migrations/` and `sql/`. */
const root = process.env.CASTLANE_DB_ASSETS_DIR ?? join(here, '..');
export const MIGRATIONS_DIR = join(root, 'migrations');
const SQL_DIR = join(root, 'sql');

const runSqlDir = async (client: pg.PoolClient, dir: string) => {
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  } catch {
    return;
  }
  for (const f of files) await client.query(readFileSync(join(dir, f), 'utf8'));
};

/**
 * Apply extensions (pre), drizzle SQL migrations, idempotent post-migration SQL (triggers,
 * functions) and the system catalog seed. Safe to run repeatedly.
 */
export const runMigrations = async (url: string, log: (m: string) => void = () => {}): Promise<void> => {
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    const client = await pool.connect();
    try {
      await client.query(`SELECT pg_advisory_lock(727274)`);
      log('pre-migration SQL');
      await runSqlDir(client, join(SQL_DIR, 'pre'));
      log('drizzle migrations');
      await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_DIR });
      log('post-migration SQL');
      await runSqlDir(client, join(SQL_DIR, 'post'));
      log('system catalog');
      await seedSystemCatalog(client);
      await client.query(`SELECT pg_advisory_unlock(727274)`);
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
};
