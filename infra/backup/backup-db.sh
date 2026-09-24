#!/usr/bin/env bash
# Daily encrypted logical backup of the Castlane database + record in backup_runs (shown in S71).
# Continuous WAL archiving / PITR is configured separately (docs/runbooks/backup-restore.md);
# this dump is the independent daily snapshot.
#
# Required env:
#   DATABASE_URL              connection string of the schema owner (read access to all tables)
#   BACKUP_DIR                destination directory (mounted, off-host replicated storage)
#   BACKUP_AGE_RECIPIENT      age public key (age1…) used to encrypt the dump
# Optional env:
#   BACKUP_RETENTION_DAYS     default 30
set -euo pipefail

: "${DATABASE_URL:?}" "${BACKUP_DIR:?}" "${BACKUP_AGE_RECIPIENT:?}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
command -v pg_dump >/dev/null && command -v age >/dev/null && command -v psql >/dev/null || { echo "pg_dump, psql and age are required" >&2; exit 2; }

RUN_ID="$(cat /proc/sys/kernel/random/uuid)"
STARTED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="${BACKUP_DIR%/}/castlane-${STAMP}.dump.age"
mkdir -p "$BACKUP_DIR"

record() { # status details_json
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c \
    "INSERT INTO backup_runs (id, kind, status, started_at, finished_at, duration_seconds, details, reported_by)
     VALUES ('$RUN_ID', 'backup', '$1', '$STARTED', now(), EXTRACT(EPOCH FROM now() - '$STARTED'::timestamptz)::int, '$2'::jsonb, 'backup-db.sh')
     ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, finished_at = EXCLUDED.finished_at,
       duration_seconds = EXCLUDED.duration_seconds, details = EXCLUDED.details;"
}

trap 'record failed "{\"error\":\"backup script failed\"}"; rm -f "$FILE.partial"' ERR

pg_dump --format=custom --no-owner --no-privileges "$DATABASE_URL" | age -r "$BACKUP_AGE_RECIPIENT" > "$FILE.partial"
mv "$FILE.partial" "$FILE"
SHA="$(sha256sum "$FILE" | cut -d' ' -f1)"
SIZE="$(stat -c %s "$FILE")"
echo "$SHA  $(basename "$FILE")" > "$FILE.sha256"
record succeeded "{\"file\":\"$(basename "$FILE")\",\"sha256\":\"$SHA\",\"bytes\":$SIZE}"

# Retention: delete dumps older than the retention window (the newest dump is always kept).
find "$BACKUP_DIR" -maxdepth 1 -name 'castlane-*.dump.age*' -mtime +"$RETENTION_DAYS" -print -delete | sed 's/^/pruned /' || true
echo "backup ok: $FILE ($SIZE bytes)"
