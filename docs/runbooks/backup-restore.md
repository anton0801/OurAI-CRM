# Backups, restore drills and disaster recovery

Targets (operational, valid only once the infrastructure below is configured and drilled):
**RPO ≤ 15 min, RTO ≤ 4 h**.

## What is backed up
| Data | Mechanism | Retention |
|---|---|---|
| PostgreSQL | Continuous WAL archiving (`archive_command`, see compose) + base backups → point-in-time recovery. With a managed database use its PITR. | 30 days |
| PostgreSQL | Daily encrypted logical dump: `infra/backup/backup-db.sh` (pg_dump custom format, encrypted with `age`, checksum, recorded in `backup_runs`) | 30 days |
| Files | S3 bucket versioning + replication/backup policy of the storage provider (independent of DB snapshots). Objects are immutable per key; new versions use new keys. | ≥ 30 days of non-current versions |
| Keys | SESSION_SECRET, MFA_ENCRYPTION_KEY, PASSWORD_PEPPER, the `age` identity for dumps — stored separately with restricted access | as long as backups exist |

Base backups for self-hosted PostgreSQL (daily, e.g. cron on the DB host):
```
pg_basebackup -D /backups/base/$(date -u +%Y%m%dT%H%M%SZ) -Ft -z -X none -c fast
```
WAL segments land in the `walarchive` volume; replicate that volume off-host (object storage
with versioning) — a WAL archive on the same disk is not a backup.

## Monthly restore drill (automated)
Run `infra/backup/restore-drill.sh` against an **isolated** PostgreSQL server:
```
DATABASE_URL=… DRILL_ADMIN_URL=postgres://admin@drill-db/postgres BACKUP_DIR=/backups \
BACKUP_AGE_IDENTITY=/secure/castlane-backup.agekey \
S3_ENDPOINT=https://s3.… STORAGE_BUCKET_PRIVATE=castlane-private AWS_ACCESS_KEY_ID=… AWS_SECRET_ACCESS_KEY=… \
infra/backup/restore-drill.sh
```
Add `REPLAY_CMD="node /app/dist/cli/replay-tombstones.js"` (worker image) so the drill also replays
the deletion journal, exactly like a real disaster restore; with filesystem storage set
`STORAGE_FS_ROOT` instead of the S3 variables.
It verifies the checksum, decrypts, restores into a new database, runs integrity checks (posted
finance entries have lines, row counts), checks every available file version exists in storage,
counts deletion tombstones executed after the recovery point and replays them into the copy,
records duration / recovered timestamp / result in `backup_runs` (shown in **System Health** as *Restore Last Tested*, separate from
*Backup Last Success*) and drops the copy. A drill with missing objects is recorded as failed.
Then run smoke workflows against the restored copy if kept (`KEEP_RESTORED=1`): sign in with a
test account, open a project, play a video, open finance overview.

## Disaster recovery (production)
1. **Close mutations**: stop web and worker (or put the proxy in maintenance mode). Record an
   incident in S71 once the app is back; keep notes meanwhile.
2. **Choose the recovery point**: latest consistent time before the failure (PITR) or the newest
   verified dump.
3. **Restore the database** into a fresh instance: PITR (`restore_command` + `recovery_target_time`)
   or `pg_restore` of the dump. Run `migrate` with the same release as before the failure.
4. **Verify storage references**: `restore-drill.sh` logic, or query `asset_versions` for available
   keys and `head-object` them; restore missing objects from bucket versions.
5. **Replay tombstones and revocations** while the application is still closed:
   `node dist/cli/replay-tombstones.js --since <recovery point ISO time>` in the worker image
   (`pnpm tombstones:replay --since …` from a checkout; add `--dry-run` first to see the plan).
   Every purge and erasure writes a tombstone row and a write-once journal object in storage
   (`journal/tombstones/…`, identifiers only), so erasures executed after the recovery point are
   re-applied to the restored database (contacts pseudonymised again, purged projects deleted
   again); a second run changes nothing. The command exits non-zero if an entry failed — do not
   reopen until it is clean. Then re-run revocations (removed members, revoked sessions) recorded
   in the incident log after the recovery point. Keep the `journal/` prefix out of bucket lifecycle
   rules shorter than the backup retention.
6. **Invalidate sessions/tokens** per incident policy: `UPDATE sessions SET revoked_at = now() WHERE revoked_at IS NULL;`
   and rotate SESSION_SECRET if compromise is suspected (access-revocation.md).
7. **Consistency checks**: finance integrity (posted entries balanced, no duplicate source keys),
   job queue (`jobs` in running state are released by lease expiry), outbox (undispatched events
   are delivered again — consumers are idempotent, scheduled jobs use idempotency/source keys and
   never repeat financial actions).
8. **Operator review**, then start worker and web, watch System Health for 30 minutes, inform users
   about the recovery point (work after it must be re-entered).
