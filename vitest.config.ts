import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const alias = { '@': fileURLToPath(new URL('./apps/web/src', import.meta.url)) };

export default defineConfig({
  resolve: { alias },
  test: {
    globalSetup: ['tests/support/global-setup.ts'],
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'unit',
          include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts', 'tests/security/**/*.test.ts'],
          environment: 'node',
          setupFiles: ['tests/support/setup-file.ts'],
          testTimeout: 60_000,
          hookTimeout: 120_000,
          pool: 'forks',
          maxWorkers: 3,
        },
      },
    ],
  },
});
