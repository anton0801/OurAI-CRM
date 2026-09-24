/** Isolated environment for the end-to-end suite (own database, storage folder, port and build dir). */
export const E2E_PORT = Number(process.env.E2E_PORT ?? 3100);
export const E2E_BASE_URL = `http://localhost:${E2E_PORT}`;
export const E2E_DB = process.env.E2E_DB ?? 'castlane_e2e';
export const E2E_ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://castlane:castlane@127.0.0.1:5432/postgres';
export const e2eDatabaseUrl = () => {
  const u = new URL(E2E_ADMIN_URL);
  u.pathname = `/${E2E_DB}`;
  return u.toString();
};
export const E2E_STORAGE = process.env.E2E_STORAGE ?? '/tmp/castlane-e2e-storage';
export const AUTH_DIR = new URL('../.auth/', import.meta.url).pathname;
export const OWNER_FILE = `${AUTH_DIR}owner.json`;
export const OWNER_STATE = `${AUTH_DIR}owner-state.json`;

export const serverEnv = (): Record<string, string> => ({
  NODE_ENV: 'development',
  APP_ORIGIN: E2E_BASE_URL,
  DATABASE_URL: e2eDatabaseUrl(),
  STORAGE_DRIVER: 'filesystem',
  STORAGE_FS_ROOT: E2E_STORAGE,
  MAIL_TRANSPORT: 'dev_sink',
  SCANNER_MODE: 'disabled-dev-only',
  NEXT_DIST_DIR: '.next-e2e',
  LOG_LEVEL: 'warn',
  NEXT_TELEMETRY_DISABLED: '1',
});
