import { afterAll, beforeAll } from 'vitest';
import { createDatabase, setSharedDatabase, type DatabaseHandle } from '@castlane/database';
import { createLogger, createScanner, createStorage, loadConfig, resetConfigCache, setAppServices } from '@castlane/application';
import { systemClock } from '@castlane/domain';
import { adminQuery, DB_PREFIX, TEMPLATE_DB, urlFor } from './db';
import { testState } from './state';

// Fast password hashing in tests only.
process.env.ARGON2_MEMORY_KIB ??= '1024';
process.env.ARGON2_TIME_COST ??= '1';
(process.env as Record<string, string>).NODE_ENV = 'test';
process.env.APP_ORIGIN = 'http://localhost:3000';
process.env.SESSION_SECRET = 'test-session-secret-0123456789abcdefghij';
process.env.MFA_ENCRYPTION_KEY = 'test-mfa-key-0123456789abcdefghijklmnop';
process.env.MAIL_TRANSPORT = 'dev_sink';
process.env.STORAGE_DRIVER = 'filesystem';
process.env.LOG_LEVEL = 'error';

let handle: DatabaseHandle | undefined;

beforeAll(async () => {
  const name = `${DB_PREFIX}${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
  await adminQuery(`CREATE DATABASE "${name}" TEMPLATE "${TEMPLATE_DB}"`);
  process.env.DATABASE_URL = urlFor(name);
  process.env.STORAGE_FS_ROOT = `/tmp/castlane-test-storage/${name}`;
  resetConfigCache();
  handle = createDatabase(process.env.DATABASE_URL, { max: 8 });
  setSharedDatabase(handle);
  const config = loadConfig();
  setAppServices({
    db: handle.db,
    clock: systemClock,
    config,
    storage: createStorage(config),
    scanner: createScanner(config),
    logger: createLogger('error'),
  });
  testState.dbName = name;
  testState.handle = handle;
});

afterAll(async () => {
  await handle?.close();
  setSharedDatabase(undefined);
  setAppServices(undefined);
  if (testState.dbName) await adminQuery(`DROP DATABASE IF EXISTS "${testState.dbName}" WITH (FORCE)`);
});
