import { runMigrations } from '../migrate';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}
runMigrations(url, (m) => console.log(`[migrate] ${m}`))
  .then(() => console.log('[migrate] done'))
  .catch((e) => {
    console.error('[migrate] failed', e);
    process.exit(1);
  });
