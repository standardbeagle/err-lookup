#!/usr/bin/env bash
# Scheduled scanner run: analyze the starter corpus, then export the static dataset.
# Safe to run unattended: flock prevents overlap, pipeline resumes at first
# incomplete phase per repo (spec §4.5), failures are logged and non-fatal.
set -u -o pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="${ERRLOOKUP_LOG_DIR:-$HOME/.local/state/errlookup}"
LOCK_FILE="$LOG_DIR/scan.lock"
CORPUS="${ERRLOOKUP_CORPUS:-$REPO_ROOT/docs/starter-corpus.txt}"

mkdir -p "$LOG_DIR"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "$(date -u +%FT%TZ) previous run still active, exiting" >>"$LOG_DIR/scan.log"
  exit 0
fi

RUN_LOG="$LOG_DIR/scan-$(date -u +%Y%m%d-%H%M%S).log"
{
  echo "=== scan run start $(date -u +%FT%TZ) corpus=$CORPUS"
  cd "$REPO_ROOT"
  pnpm --filter @errlookup/pipeline dev batch "$CORPUS"
  batch_exit=$?
  echo "=== batch exit=$batch_exit"
  pnpm --filter @errlookup/pipeline dev export
  export_exit=$?
  echo "=== export exit=$export_exit"
  if [ -x "$REPO_ROOT/scripts/deploy-site.sh" ]; then
    "$REPO_ROOT/scripts/deploy-site.sh"
    echo "=== deploy exit=$?"
  else
    echo "=== deploy skipped: scripts/deploy-site.sh not present/executable"
  fi
  echo "=== scan run end $(date -u +%FT%TZ)"
} >>"$RUN_LOG" 2>&1

# keep the 30 most recent run logs
ls -1t "$LOG_DIR"/scan-*.log 2>/dev/null | tail -n +31 | xargs -r rm --
