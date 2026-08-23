#!/usr/bin/env bash
# Ask the provider whether its window has reopened, and lift the drain's hold
# when it has.
#
# A spent window is recorded by the drain as provider-hold-until (see
# packages/pipeline/src/scan.ts), and the watchdog will not relaunch while that
# time is in the future. The stamp is only ever an estimate: z.ai states its
# reset in Beijing time with no zone marker, so the drain clamps it to the
# stated window length and can still be hours out either way. One cheap call
# settles it.
#
# Cron runs this at :23 past the hour — off the hour on purpose, since every
# other client on the plan retries exactly on it, and a probe that lands in
# that stampede answers "still limited" when the window is actually open.
#
# Costs one trivial provider call per hour, and only while a hold is in force.
set -u -o pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="${ERRLOOKUP_LOG_DIR:-$HOME/.local/state/errlookup}"
LOG="$LOG_DIR/watchdog.log"
HOLD_FILE="$LOG_DIR/provider-hold-until"
export ERRLOOKUP_CONFIG="${ERRLOOKUP_CONFIG:-$REPO_ROOT/configs/blitz-glm-k3.kdl}"

mkdir -p "$LOG_DIR"
[ -f "$HOLD_FILE" ] || exit 0

# A drain already running means the hold is stale in the only way that matters.
exec 9>>"$LOG_DIR/scan.lock"
if ! flock -n 9; then
  exit 0
fi
flock -u 9

cd "$REPO_ROOT"
if probe=$(pnpm --filter @errlookup/pipeline dev ping --timeout-ms 120000 2>&1); then
  rm -f "$HOLD_FILE"
  echo "$(date -u +%FT%TZ) provider answered — hold lifted, drain relaunching" >>"$LOG"
  # Start now rather than waiting for the watchdog's next quarter-hour: the
  # window is open and the queue is full.
  if systemctl cat errlookup-scan.service >/dev/null 2>&1; then
    sudo -n systemctl start --no-block errlookup-scan.service >>"$LOG" 2>&1 \
      || echo "$(date -u +%FT%TZ) systemctl start failed after probe" >>"$LOG"
  fi
  exit 0
fi

# Still shut. If the provider named a new reset, keep the hold honest.
reset=$(printf '%s' "$probe" | sed -n 's/.*quota still spent until \([0-9T:.Z-]*\).*/\1/p' | tail -1)
if [ -n "$reset" ]; then
  printf '%s\n' "$reset" >"$HOLD_FILE"
fi
echo "$(date -u +%FT%TZ) provider still limited${reset:+ until $reset}" >>"$LOG"
