#!/usr/bin/env bash
# 6h publisher (§11.3 daily-publish cadence): export + deploy only when new
# analysis landed since the last publish. Safe alongside a running batch —
# export is an atomic WAL reader, deploys are atomic per Pages deployment.
# Own lock; skips silently when nothing changed. ~120 deploys/month worst case.
set -u -o pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="${ERRLOOKUP_LOG_DIR:-$HOME/.local/state/errlookup}"
STATE_FILE="$LOG_DIR/last-published-marker"
LOG="$LOG_DIR/publish.log"

mkdir -p "$LOG_DIR"
exec 9>"$LOG_DIR/publish.lock"
if ! flock -n 9; then
  echo "$(date -u +%FT%TZ) publisher already running, exiting" >>"$LOG"
  exit 0
fi

latest=$(cd "$REPO_ROOT/packages/pipeline" && node -e '
  const D = require("better-sqlite3");
  try {
    const d = new D("data/errlookup.db", { readonly: true, fileMustExist: true });
    const r = d.prepare("SELECT max(analyzed_at) m FROM repositories WHERE status IN (\x27analyzed\x27,\x27exported\x27)").get();
    console.log(r.m ?? "");
  } catch { /* no DB yet */ }
')
if [ -z "$latest" ]; then
  echo "$(date -u +%FT%TZ) no analyzed repos yet, nothing to publish" >>"$LOG"
  exit 0
fi

last=$(cat "$STATE_FILE" 2>/dev/null || echo "")
if [ "$latest" = "$last" ]; then
  echo "$(date -u +%FT%TZ) unchanged since last publish ($latest)" >>"$LOG"
  exit 0
fi

{
  echo "=== publish start $(date -u +%FT%TZ) (new analysis up to $latest)"
  cd "$REPO_ROOT"
  pnpm --filter @errlookup/pipeline dev export || exit 1
  "$REPO_ROOT/scripts/deploy-site.sh" || exit 1
  printf '%s' "$latest" > "$STATE_FILE"
  echo "=== publish done $(date -u +%FT%TZ)"
} >>"$LOG" 2>&1
