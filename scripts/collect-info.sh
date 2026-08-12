#!/usr/bin/env bash
# Twice-daily info-page collector (cron): clusters related error records and
# writes background articles into the working DB. The hourly publisher ships
# them — its change gate watches info_pages alongside repositories, so a run
# that writes pages triggers the next publish without a scan having landed.
# Own lock; --max-pages bounds LLM spend per run, the schedule provides volume.
set -u -o pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="${ERRLOOKUP_LOG_DIR:-$HOME/.local/state/errlookup}"
LOG="$LOG_DIR/collect-info.log"
# Same routing as the scanner: GLM 5.2 writes the articles.
export ERRLOOKUP_CONFIG="${ERRLOOKUP_CONFIG:-$REPO_ROOT/configs/blitz-glm-k3.kdl}"

mkdir -p "$LOG_DIR"
exec 9>"$LOG_DIR/collect-info.lock"
if ! flock -n 9; then
  echo "$(date -u +%FT%TZ) collector already running, exiting" >>"$LOG"
  exit 0
fi

echo "=== collect-info start $(date -u +%FT%TZ)" >>"$LOG"
cd "$REPO_ROOT"
pnpm --filter @errlookup/pipeline dev collect-info --max-pages "${ERRLOOKUP_INFO_MAX_PAGES:-5}" >>"$LOG" 2>&1
status=$?
echo "=== collect-info exit=$status $(date -u +%FT%TZ)" >>"$LOG"
exit "$status"
