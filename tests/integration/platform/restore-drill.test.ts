import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { and, desc, eq } from 'drizzle-orm';
import { ofmEndpoints as E } from '@castlane/api-contracts';
import { getAppServices } from '@castlane/application';
import { backupRuns, deletionTombstones } from '@castlane/database';
import { runQueuedJobs } from '../../support';
import { ADMIN_URL } from '../../support/db';
import { db, ofmSetup } from '../ofm/helpers';

/**
 * T158 (and T157 end to end): the real backup and restore-drill scripts run against this test
 * database — encrypted dump, checksum, restore into an isolated database, integrity and file
 * manifest checks, tombstone journal replay, result and duration recorded in backup_runs.
 */
const root = new URL('../../..', import.meta.url).pathname;
const work = mkdtempSync(join(tmpdir(), 'castlane-drill-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const run = (script: string, env: Record<string, string>) =>
  execFileSync('bash', [join(root, 'infra/backup', script)], { cwd: root, env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000 });

describe('backup and restore drill (T158)', () => {
  it('restores the latest encrypted dump into an isolated database, replays tombstones and records the measured result', async () => {
    const app = getAppServices();
    const databaseUrl = app.config.DATABASE_URL;
    const s = await ofmSetup();
    const contact = await s.owner.call(E.createContact, { params: s.p, body: { accountId: s.accountA, externalIdentifier: 'drill_probe', alias: 'Drill Probe', businessNotes: 'Private note' } });

    // Encrypted daily backup.
    execFileSync('age-keygen', ['-o', join(work, 'key.txt')], { stdio: 'ignore' });
    const recipient = execFileSync('age-keygen', ['-y', join(work, 'key.txt')], { encoding: 'utf8' }).trim();
    const backupOut = run('backup-db.sh', { DATABASE_URL: databaseUrl, BACKUP_DIR: join(work, 'dumps'), BACKUP_AGE_RECIPIENT: recipient });
    expect(backupOut).toMatch(/backup ok/);
    expect(readdirSync(join(work, 'dumps')).some((f) => f.endsWith('.dump.age'))).toBe(true);

    // After the backup a contact is erased: the dump still contains it; the journal records the erasure.
    await new Promise((r) => setTimeout(r, 1100));
    await s.owner.call(E.requestErasure, { params: { ...s.p, contactId: contact.id }, body: { reason: 'Data subject request' } });
    await runQueuedJobs(['ofm.contact_erasure']);
    await runQueuedJobs(['tombstones.journal']);
    expect(await db().select().from(deletionTombstones).where(eq(deletionTombstones.entityId, contact.id))).toHaveLength(1);

    const started = Date.now();
    const drillOut = run('restore-drill.sh', {
      DATABASE_URL: databaseUrl,
      DRILL_ADMIN_URL: ADMIN_URL,
      BACKUP_DIR: join(work, 'dumps'),
      BACKUP_AGE_IDENTITY: join(work, 'key.txt'),
      STORAGE_FS_ROOT: app.config.STORAGE_FS_ROOT,
      REPLAY_CMD: `${join(root, 'node_modules/.bin/tsx')} ${join(root, 'apps/worker/src/cli/replay-tombstones.ts')}`,
    });
    const elapsed = (Date.now() - started) / 1000;
    expect(drillOut).toMatch(/restore drill succeeded/);

    const [drill] = await db().select().from(backupRuns).where(and(eq(backupRuns.kind, 'restore_drill'))).orderBy(desc(backupRuns.startedAt)).limit(1);
    expect(drill).toMatchObject({ status: 'succeeded', reportedBy: 'restore-drill.sh' });
    expect(drill!.recoveredTimestamp).toBeTruthy();
    // RTO of the drill is measured and recorded.
    expect(drill!.durationSeconds).toBeGreaterThanOrEqual(0);
    expect(drill!.durationSeconds!).toBeLessThanOrEqual(Math.ceil(elapsed) + 1);
    const details = drill!.details as { counts: Record<string, number>; missingObjects: number; storageChecked: boolean; tombstonesToReplay: number; tombstonesReplayed: number };
    expect(details.counts.workspaces).toBeGreaterThanOrEqual(1);
    expect(details).toMatchObject({ missingObjects: 0, storageChecked: true });
    expect(details.tombstonesToReplay).toBeGreaterThanOrEqual(1);
    expect(details.tombstonesReplayed).toBeGreaterThanOrEqual(details.tombstonesToReplay);
    // The isolated copy is dropped afterwards.
    const left = execFileSync('psql', [ADMIN_URL, '-Atc', "SELECT count(*) FROM pg_database WHERE datname LIKE 'castlane_restore_drill_%' AND datname > to_char(now() - interval '5 minutes', '\"castlane_restore_drill_\"YYYYMMDDHH24MISS')"], { encoding: 'utf8' }).trim();
    expect(left).toBe('0');
  }, 240_000);
});
