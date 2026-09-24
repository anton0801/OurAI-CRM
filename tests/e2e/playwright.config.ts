import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';
import { E2E_BASE_URL, E2E_PORT, OWNER_STATE, serverEnv } from './support/env';

/**
 * End-to-end suite: real Next.js server + worker against an isolated database.
 *   pnpm test:e2e            (starts both servers; first run compiles pages on demand)
 *   E2E_REUSE_SERVER=1 …     (use servers already running on E2E_PORT with the same environment)
 * Chromium is pre-installed at /opt/pw-browsers in CI containers.
 *
 * Project order: first-run (bootstraps the Owner) → empty (asserts the untouched production
 * workspace, so it must run before anything creates data) → desktop and mobile.
 */
// Use a pre-installed Chromium when present (CI containers ship one at /opt/pw-browsers/chromium).
const chromium = process.env.PLAYWRIGHT_CHROMIUM_PATH ?? (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const reuse = process.env.E2E_REUSE_SERVER === '1';
const desktop = { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } };

export default defineConfig({
  testDir: './specs',
  outputDir: '../../test-results/e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { outputFolder: '../../playwright-report', open: 'never' }], ['json', { outputFile: '../../test-results/e2e/results.json' }]],
  globalSetup: './support/global-setup.ts',
  use: {
    baseURL: E2E_BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: { executablePath: chromium },
  },
  projects: [
    { name: 'first-run', testMatch: /first-run\.setup\.ts/, use: desktop },
    { name: 'empty', dependencies: ['first-run'], testMatch: /empty-workspace\.spec\.ts/, use: { ...desktop, storageState: OWNER_STATE } },
    {
      name: 'desktop',
      dependencies: ['empty'],
      testIgnore: /\.setup\.ts$|mobile|empty-workspace/,
      use: { ...desktop, storageState: OWNER_STATE },
    },
    {
      name: 'mobile',
      dependencies: ['empty'],
      testMatch: /mobile.*\.spec\.ts/,
      use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 }, storageState: OWNER_STATE },
    },
  ],
  webServer: [
    {
      command: `pnpm --filter @castlane/web exec next dev --port ${E2E_PORT}`,
      url: `${E2E_BASE_URL}/auth/sign-in`,
      env: serverEnv(),
      timeout: 240_000,
      reuseExistingServer: reuse,
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      command: 'pnpm --filter @castlane/worker exec tsx src/index.ts',
      wait: { stdout: /worker_starting/ },
      env: { ...serverEnv(), LOG_LEVEL: 'info' },
      timeout: 60_000,
      reuseExistingServer: reuse,
    },
  ],
});
