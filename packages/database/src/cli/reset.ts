import pg from 'pg';
import { runMigrations } from '../migrate';

/** Development-only: drop and recreate the database named in DATABASE_URL, then migrate. */
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}
if (process.env.NODE_ENV === 'production' && process.env.CASTLANE_ALLOW_DANGEROUS_RESET !== 'yes') {
  console.error('Refusing to reset a production database.');
  process.exit(1);
}
const target = new URL(url);
const dbName = target.pathname.slice(1);
const admin = new URL(url);
admin.pathname = '/postgres';

const main = async () => {
  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  await client.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [dbName]);
  await client.query(`DROP DATABASE IF EXISTS "${dbName}"`);
  await client.query(`CREATE DATABASE "${dbName}"`);
  await client.end();
  await runMigrations(url, (m) => console.log(`[reset] ${m}`));
  console.log(`[reset] ${dbName} recreated`);
};
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
