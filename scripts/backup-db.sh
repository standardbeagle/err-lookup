#!/usr/bin/env bash
# Daily offsite backup of the working scan DB to Backblaze B2.
# The DB runs in WAL mode, so we take a consistent snapshot via `sqlite3 .backup`
# (a raw copy could tear across db/-wal). Snapshot is gzipped and uploaded to one
# fixed name, db/errlookup.db.gz: B2 keeps each day as a version of that file and
# the bucket lifecycle rule for db/ expires superseded versions (14 days), so
# this script does no pruning of its own.
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

mkdir -p "$LOG_DIR"
exec 9>"$LOG_DIR/backup.lock"
if ! flock -n 9; then
  echo "$(date -u +%FT%TZ) backup already running, exiting" >>"$LOG"
  exit 0
fi

# ntfy notifications, same routing as the publisher: failures go to
# ERRLOOKUP_ALERT_URL, one low-priority note per successful upload to
# ERRLOOKUP_UPDATE_URL. This job runs daily, so every failure alerts —
# the missing-credentials misconfiguration failed silently for 11 days.
ALERT_ENV="${ERRLOOKUP_ALERT_ENV:-$HOME/.config/errlookup/alert.env}"
[ -z "${ERRLOOKUP_ALERT_URL:-}" ] && [ -f "$ALERT_ENV" ] && . "$ALERT_ENV"

notify() { # $1 = url, $2 = priority, $3 = message
  [ -n "$1" ] || return 0
  curl -sf -m 20 -H "Title: errlookup backup" -H "Priority: $2" -d "$3" "$1" >/dev/null \
    || echo "$(date -u +%FT%TZ) notification delivery failed (webhook unreachable)" >>"$LOG"
}

fail() {
  echo "$(date -u +%FT%TZ) FAILED: $1" >>"$LOG"
  notify "${ERRLOOKUP_ALERT_URL:-}" default "db backup FAILED on $(hostname): $1"
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

rclone copyto "$snapshot.gz" "$REMOTE/errlookup.db.gz" || fail "rclone upload"

# Verify the stored object is the file we sent.
bytes=$(stat -c %s "$snapshot.gz")
remote_bytes=$(rclone lsf --format s "$REMOTE/errlookup.db.gz")
[ "$remote_bytes" = "$bytes" ] || fail "upload verification: b2 has ${remote_bytes:-nothing}, sent $bytes bytes"
echo "$(date -u +%FT%TZ) OK: errlookup.db.gz ($bytes bytes) → b2:$ERRLOOKUP_B2_BUCKET/db (snapshot $stamp)" >>"$LOG"
notify "${ERRLOOKUP_UPDATE_URL:-}" low "db backup OK on $(hostname): errlookup.db.gz snapshot $stamp ($bytes bytes) → b2"
