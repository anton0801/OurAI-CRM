import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './migrations',
  dbCredentials: { url: process.env.DATABASE_URL ?? 'postgres://castlane:castlane@127.0.0.1:5432/castlane_dev' },
  strict: true,
  verbose: false,
});
