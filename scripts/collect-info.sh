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
# The pipeline resolves @errlookup/schema to its dist — a pull alone leaves
# that stale (install does not build workspace deps), so build it first.
pnpm --filter @errlookup/schema build >>"$LOG" 2>&1 || { echo "=== collect-info exit=1 (schema build failed) $(date -u +%FT%TZ)" >>"$LOG"; exit 1; }
RUN_OUT=$(mktemp)
pnpm --filter @errlookup/pipeline dev collect-info --max-pages "${ERRLOOKUP_INFO_MAX_PAGES:-5}" >"$RUN_OUT" 2>&1
status=$?
cat "$RUN_OUT" >>"$LOG"
echo "=== collect-info exit=$status $(date -u +%FT%TZ)" >>"$LOG"

# Every drafted article now passes deterministic validation and an adversarial
# review before it is written, and both gates fail closed. That is the right
# behaviour and also a way for this job to produce nothing, twice a day,
# without anyone noticing — the shape of failure this project has been bitten
# by before. A run that had clusters to write about and wrote none says so.
summary=$(grep -m1 "^collect-info done:" "$RUN_OUT" || true)
if [ "$status" -ne 0 ] || printf '%s' "$summary" | grep -q "0 pages written"; then
  ALERT_ENV="${ERRLOOKUP_ALERT_ENV:-$HOME/.config/errlookup/alert.env}"
  # shellcheck disable=SC1090
  [ -z "${ERRLOOKUP_ALERT_URL:-}" ] && [ -f "$ALERT_ENV" ] && . "$ALERT_ENV"
  if [ -n "${ERRLOOKUP_ALERT_URL:-}" ]; then
    reason=${summary:-$(grep -m1 -iE "error|failed" "$RUN_OUT" | head -c 200)}
    curl -sf -m 20 -H "Title: errlookup collect-info" \
      -d "collect-info wrote no pages on $(hostname) (exit=$status): ${reason:-see $LOG}" \
      "$ERRLOOKUP_ALERT_URL" >/dev/null \
      || echo "$(date -u +%FT%TZ) alert delivery failed (webhook unreachable)" >>"$LOG"
  fi
fi
rm -f "$RUN_OUT"
exit "$status"
