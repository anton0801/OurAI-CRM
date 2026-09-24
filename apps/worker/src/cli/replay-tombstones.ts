/**
 * Disaster restore step "replay tombstones" (spec §27.2, runbook backup-restore.md):
 *   pnpm tombstones:replay [--since <ISO recovery timestamp>] [--dry-run]
 * Reads the deletion journal from object storage and re-applies every purge/erasure that the
 * restored database does not contain yet. Run it while the application is still closed to users;
 * a second run changes nothing. Exits non-zero when an entry failed or has no handler.
 */
import { getAppServices, replayTombstones } from '@castlane/application';
import { getDatabase } from '@castlane/database';

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const main = async () => {
  const sinceRaw = arg('since');
  const since = sinceRaw ? new Date(sinceRaw) : undefined;
  if (since && Number.isNaN(since.getTime())) {
    console.error('Usage: replay-tombstones [--since <ISO timestamp>] [--dry-run]');
    process.exit(2);
  }
  const dryRun = process.argv.includes('--dry-run');
  const app = getAppServices();
  try {
    const r = await replayTombstones(app, { since, dryRun });
    console.log(JSON.stringify({ dryRun, since: since?.toISOString() ?? null, ...r }, null, 2));
    if (r.failed.length || r.unknown.length || r.unreadable.length) {
      console.error('Some tombstones were not applied. Keep the application closed and resolve them before reopening.');
      process.exitCode = 1;
    }
  } finally {
    await getDatabase().close();
  }
};

void main();
