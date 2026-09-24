import pg from 'pg';

export const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://castlane:castlane@127.0.0.1:5432/postgres';
export const TEMPLATE_DB = process.env.TEST_TEMPLATE_DB ?? 'castlane_test_template';
/** Per-run prefix so parallel test runs on one server never drop each other's databases. */
export const DB_PREFIX = process.env.TEST_DB_PREFIX ?? 'ctest_';

export const urlFor = (db: string) => {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${db}`;
  return u.toString();
};

export const adminQuery = async (sql: string, params: unknown[] = []) => {
  const c = new pg.Client({ connectionString: ADMIN_URL });
  await c.connect();
  try {
    return await c.query(sql, params);
  } finally {
    await c.end();
  }
};
