import { runMigrations } from '@castlane/database';
import { adminQuery, DB_PREFIX, TEMPLATE_DB, urlFor } from './db';

/**
 * Build one migrated template database per test run; every test file clones it
 * (CREATE DATABASE … TEMPLATE …) so files are fully isolated and fast.
 */
export default async function setup() {
  await adminQuery(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [TEMPLATE_DB]);
  await adminQuery(`DROP DATABASE IF EXISTS "${TEMPLATE_DB}"`);
  await adminQuery(`CREATE DATABASE "${TEMPLATE_DB}"`);
  await runMigrations(urlFor(TEMPLATE_DB));
  const stale = await adminQuery(`SELECT datname FROM pg_database WHERE starts_with(datname, $1)`, [DB_PREFIX]);
  for (const r of stale.rows as { datname: string }[]) await adminQuery(`DROP DATABASE IF EXISTS "${r.datname}" WITH (FORCE)`).catch(() => undefined);
  return async () => {
    const left = await adminQuery(`SELECT datname FROM pg_database WHERE starts_with(datname, $1)`, [DB_PREFIX]);
    for (const r of left.rows as { datname: string }[]) {
      await adminQuery(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid() AND usename = current_user`, [r.datname]).catch(() => undefined);
      await adminQuery(`DROP DATABASE IF EXISTS "${r.datname}" WITH (FORCE)`).catch((e: Error) => console.warn(`could not drop ${r.datname}: ${e.message}`));
    }
  };
}
