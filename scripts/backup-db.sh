#!/usr/bin/env bash
# Daily offsite backup of the working scan DB to Backblaze B2.
# The DB runs in WAL mode, so we take a consistent snapshot via `sqlite3 .backup`
# (a raw copy could tear across db/-wal). Snapshot is gzipped, uploaded with a
# UTC-dated name, and uploads older than the retention window are pruned.
#
# Credentials: ~/.config/errlookup/backblaze.env (chmod 600), NOT in the repo:
#   B2_APPLICATION_KEY_ID=...
#   B2_APPLICATION_KEY=...
#   ERRLOOKUP_B2_BUCKET=...
set -u -o pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DB="$REPO_ROOT/packages/pipeline/data/errlookup.db"
LOG_DIR="${ERRLOOKUP_LOG_DIR:-$HOME/.local/state/errlookup}"
LOG="$LOG_DIR/backup.log"
ENV_FILE="${ERRLOOKUP_B2_ENV:-$HOME/.config/errlookup/backblaze.env}"
RETENTION_DAYS="${ERRLOOKUP_BACKUP_RETENTION_DAYS:-30}"

mkdir -p "$LOG_DIR"
exec 9>"$LOG_DIR/backup.lock"
if ! flock -n 9; then
  echo "$(date -u +%FT%TZ) backup already running, exiting" >>"$LOG"
  exit 0
fi

fail() {
  echo "$(date -u +%FT%TZ) FAILED: $1" >>"$LOG"
  exit 1
}

[ -f "$DB" ] || fail "db not found at $DB"
[ -f "$ENV_FILE" ] || fail "credentials file missing: $ENV_FILE"
perms=$(stat -c %a "$ENV_FILE")
[ "$perms" = "600" ] || fail "credentials file $ENV_FILE must be chmod 600 (is $perms)"

# shellcheck disable=SC1090
. "$ENV_FILE"
: "${B2_APPLICATION_KEY_ID:?missing in env file}" "${B2_APPLICATION_KEY:?missing in env file}" "${ERRLOOKUP_B2_BUCKET:?missing in env file}"

# rclone on-the-fly B2 backend, creds via env so they never hit the command line.
export RCLONE_B2_ACCOUNT="$B2_APPLICATION_KEY_ID"
export RCLONE_B2_KEY="$B2_APPLICATION_KEY"
REMOTE=":b2:$ERRLOOKUP_B2_BUCKET/db"

command -v rclone >/dev/null || fail "rclone not installed"

stamp=$(date -u +%Y%m%d-%H%M%S)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
snapshot="$tmp/errlookup-$stamp.db"

sqlite3 "$DB" ".backup '$snapshot'" || fail "sqlite .backup"
gzip "$snapshot" || fail "gzip"

rclone copyto "$snapshot.gz" "$REMOTE/errlookup-$stamp.db.gz" || fail "rclone upload"

# Verify the upload exists and prune expired snapshots.
rclone lsf "$REMOTE/errlookup-$stamp.db.gz" | grep -q . || fail "upload verification"
rclone delete --min-age "${RETENTION_DAYS}d" "$REMOTE" || fail "retention prune"

bytes=$(stat -c %s "$snapshot.gz")
echo "$(date -u +%FT%TZ) OK: errlookup-$stamp.db.gz ($bytes bytes) → b2:$ERRLOOKUP_B2_BUCKET/db, retention ${RETENTION_DAYS}d" >>"$LOG"
