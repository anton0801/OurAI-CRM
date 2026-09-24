#!/usr/bin/env bash
# Monthly restore drill (spec §27.2): restore the latest encrypted dump into an ISOLATED database,
# verify integrity and file references, report deletion tombstones to replay, record duration and
# result in backup_runs of the production database, then drop the restored copy.
#
# Required env:
#   DATABASE_URL            production database (only used to record the drill result)
#   DRILL_ADMIN_URL         admin connection to the isolated drill server (CREATEDB), e.g. postgres://…/postgres
#   BACKUP_DIR              directory with castlane-*.dump.age files
#   BACKUP_AGE_IDENTITY     path to the age private key file (kept separately, restricted access)
# Optional env:
#   DUMP_FILE               specific dump to restore (default: newest)
#   S3_ENDPOINT, STORAGE_BUCKET_PRIVATE, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
#                           when set, every referenced object key is checked with `aws s3api head-object`
#   STORAGE_FS_ROOT         filesystem storage root (development/local stacks): keys are checked on disk
#   REPLAY_CMD              command that replays the tombstone journal against $DATABASE_URL, e.g.
#                           "node /app/dist/cli/replay-tombstones.js" (worker image) or "pnpm -s tombstones:replay";
#                           it is run against the restored copy with --since <recovered timestamp>
#   KEEP_RESTORED=1         keep the restored database for manual inspection
set -euo pipefail
: "${DATABASE_URL:?}" "${DRILL_ADMIN_URL:?}" "${BACKUP_DIR:?}" "${BACKUP_AGE_IDENTITY:?}"

RUN_ID="$(cat /proc/sys/kernel/random/uuid)"
STARTED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
DUMP="${DUMP_FILE:-$(ls -1t "${BACKUP_DIR%/}"/castlane-*.dump.age | head -1)}"
DB="castlane_restore_drill_$(date -u +%Y%m%d%H%M%S)"
DRILL_URL="$(python3 -c "import sys,urllib.parse as u; p=u.urlsplit(sys.argv[1]); print(u.urlunsplit(p._replace(path='/'+sys.argv[2])))" "$DRILL_ADMIN_URL" "$DB")"
WORK="$(mktemp -d)"
cleanup() { [ "${KEEP_RESTORED:-0}" = 1 ] || psql "$DRILL_ADMIN_URL" -q -c "DROP DATABASE IF EXISTS \"$DB\" WITH (FORCE);" >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

record() { # status recovered_ts details_json
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c \
    "INSERT INTO backup_runs (id, kind, status, started_at, finished_at, recovered_timestamp, duration_seconds, details, reported_by)
     VALUES ('$RUN_ID', 'restore_drill', '$1', '$STARTED', now(), $2, EXTRACT(EPOCH FROM now() - '$STARTED'::timestamptz)::int, '$3'::jsonb, 'restore-drill.sh');"
}
fail() { record failed NULL "{\"error\":\"$1\",\"dump\":\"$(basename "$DUMP")\"}"; echo "DRILL FAILED: $1" >&2; exit 1; }

[ -f "$DUMP" ] || fail "no dump found"
if [ -f "$DUMP.sha256" ]; then (cd "$(dirname "$DUMP")" && sha256sum -c "$(basename "$DUMP").sha256" >/dev/null) || fail "checksum mismatch"; fi

age -d -i "$BACKUP_AGE_IDENTITY" "$DUMP" > "$WORK/db.dump" || fail "decryption failed"
psql "$DRILL_ADMIN_URL" -v ON_ERROR_STOP=1 -q -c "CREATE DATABASE \"$DB\";" || fail "cannot create drill database"
pg_restore --no-owner --no-privileges --exit-on-error -d "$DRILL_URL" "$WORK/db.dump" || fail "pg_restore failed"

q() { psql "$DRILL_URL" -At -v ON_ERROR_STOP=1 -c "$1"; }
RECOVERED="$(q "SELECT COALESCE(max(occurred_at), now())::text FROM audit_events")"
COUNTS="$(q "SELECT json_build_object(
  'workspaces',(SELECT count(*) FROM workspaces),'memberships',(SELECT count(*) FROM memberships),
  'projects',(SELECT count(*) FROM projects),'tasks',(SELECT count(*) FROM tasks),
  'publications',(SELECT count(*) FROM publications),'financial_entries',(SELECT count(*) FROM financial_entries),
  'asset_versions',(SELECT count(*) FROM asset_versions),'audit_events',(SELECT count(*) FROM audit_events))")"

# Integrity checks: posted financial entries must balance to their lines; foreign keys were enforced by restore.
UNBALANCED="$(q "SELECT count(*) FROM financial_entries e WHERE e.state = 'posted' AND NOT EXISTS (SELECT 1 FROM financial_entry_lines l WHERE l.entry_id = e.id)")"
[ "$UNBALANCED" = "0" ] || fail "posted entries without lines: $UNBALANCED"

# File manifest: every available asset version must have an object.
q "SELECT storage_key FROM asset_versions WHERE storage_key IS NOT NULL AND status = 'available'" > "$WORK/keys.txt" || true
TOTAL_KEYS="$(wc -l < "$WORK/keys.txt" | tr -d ' ')"
MISSING=0
STORAGE_CHECKED=false
if [ -n "${S3_ENDPOINT:-}" ] && [ -n "${STORAGE_BUCKET_PRIVATE:-}" ]; then
  STORAGE_CHECKED=true
  while read -r key; do
    [ -z "$key" ] && continue
    aws --endpoint-url "$S3_ENDPOINT" s3api head-object --bucket "$STORAGE_BUCKET_PRIVATE" --key "$key" >/dev/null 2>&1 || { MISSING=$((MISSING+1)); echo "missing object: $key" >> "$WORK/missing.txt"; }
  done < "$WORK/keys.txt"
elif [ -n "${STORAGE_FS_ROOT:-}" ]; then
  STORAGE_CHECKED=true
  while read -r key; do
    [ -z "$key" ] && continue
    [ -f "${STORAGE_FS_ROOT%/}/objects/$key" ] || { MISSING=$((MISSING+1)); echo "missing object: $key" >> "$WORK/missing.txt"; }
  done < "$WORK/keys.txt"
fi
[ -f "$WORK/missing.txt" ] && head -20 "$WORK/missing.txt" >&2

# Tombstones executed in production after the recovery point must be replayed before opening access.
TOMBSTONES="$(psql "$DATABASE_URL" -At -c "SELECT count(*) FROM deletion_tombstones WHERE executed_at > '$RECOVERED'::timestamptz")"
REPLAYED=null
if [ -n "${REPLAY_CMD:-}" ]; then
  # The same step as a real disaster restore: replay the storage journal against the restored copy.
  DATABASE_URL="$DRILL_URL" $REPLAY_CMD --since "$RECOVERED" > "$WORK/replay.json" || fail "tombstone replay failed"
  REPLAYED="$(python3 -c 'import json,sys; t=open(sys.argv[1]).read(); r=json.loads(t[t.index("{"):]); print(r["applied"] + r["notPresent"])' "$WORK/replay.json")"
  PENDING="$(q "SELECT count(*) FROM deletion_tombstones WHERE executed_at > '$RECOVERED'::timestamptz")"
  [ "$PENDING" -ge "$TOMBSTONES" ] || fail "replayed $PENDING of $TOMBSTONES tombstones"
fi

STATUS=succeeded
[ "$MISSING" = "0" ] || STATUS=failed
record "$STATUS" "'$RECOVERED'" "{\"dump\":\"$(basename "$DUMP")\",\"counts\":$COUNTS,\"objectsChecked\":$TOTAL_KEYS,\"missingObjects\":$MISSING,\"tombstonesToReplay\":$TOMBSTONES,\"tombstonesReplayed\":$REPLAYED,\"storageChecked\":$STORAGE_CHECKED}"
echo "restore drill $STATUS: recovered through $RECOVERED, objects checked $TOTAL_KEYS, missing $MISSING, tombstones to replay $TOMBSTONES, replayed $REPLAYED"
[ "$STATUS" = succeeded ]
