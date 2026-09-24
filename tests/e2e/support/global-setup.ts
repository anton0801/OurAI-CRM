import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import pg from 'pg';
import { runMigrations, createDatabase } from '@castlane/database';
import { bootstrapOwner } from '@castlane/application';
import { AUTH_DIR, E2E_ADMIN_URL, E2E_DB, E2E_STORAGE, OWNER_FILE, e2eDatabaseUrl } from './env';

const admin = async (sql: string) => {
  const c = new pg.Client({ connectionString: E2E_ADMIN_URL });
  await c.connect();
  try {
    await c.query(sql);
  } finally {
    await c.end();
  }
};

/**
 * Fresh database for every run: migrate, then create the first Owner exactly like production
 * (`bootstrap:owner` with a temporary password). The first spec performs F01 through the UI.
 */
export default async function globalSetup() {
  process.env.ARGON2_MEMORY_KIB ??= '4096';
  await admin(`DROP DATABASE IF EXISTS "${E2E_DB}" WITH (FORCE)`);
  await admin(`CREATE DATABASE "${E2E_DB}"`);
  await runMigrations(e2eDatabaseUrl());
  rmSync(E2E_STORAGE, { recursive: true, force: true });
  mkdirSync(E2E_STORAGE, { recursive: true });
  mkdirSync(AUTH_DIR, { recursive: true });
  const handle = createDatabase(e2eDatabaseUrl(), { max: 2 });
  try {
    const email = 'owner@castlane.test';
    const r = await bootstrapOwner(handle.db, { email, displayName: 'Olga Owner', at: new Date() });
    writeFileSync(OWNER_FILE, JSON.stringify({ email, temporaryPassword: r.temporaryPassword, password: 'Night shift studio 2026!', workspaceId: r.workspaceId }, null, 2));
  } finally {
    await handle.close();
  }
}
