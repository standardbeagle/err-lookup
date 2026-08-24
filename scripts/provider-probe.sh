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
# When to probe comes out of the message itself. The hour z.ai states is in a
# zone it never names, but every zone offset in play is a whole number of
# hours, so the MINUTE is the same in all of them: "reset at ... 22:00:28"
# means the window reopens on the hour, whatever hour that turns out to be.
# The probe therefore runs at that minute plus one, every hour, until the
# provider answers — one minute after the window opens, and a minute clear of
# whatever else on the plan is retrying exactly on it.
#
# Cron calls this every minute; it exits in milliseconds unless a hold is in
# force AND the current minute is the one the message pointed at, so it costs
# one trivial provider call per hour, only while the drain is stopped.
set -u -o pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="${ERRLOOKUP_LOG_DIR:-$HOME/.local/state/errlookup}"
LOG="$LOG_DIR/watchdog.log"
HOLD_FILE="$LOG_DIR/provider-hold-until"
export ERRLOOKUP_CONFIG="${ERRLOOKUP_CONFIG:-$REPO_ROOT/configs/blitz-glm-k3.kdl}"

mkdir -p "$LOG_DIR"
[ -f "$HOLD_FILE" ] || exit 0

hold=$(tr -d '[:space:]' <"$HOLD_FILE")
# ISO 8601: 2026-08-23T22:00:28.000Z → 00
reset_minute=$(printf '%s' "$hold" | sed -nE 's/.*T[0-9]{2}:([0-9]{2}):.*/\1/p')
if [ -z "$reset_minute" ]; then
  echo "$(date -u +%FT%TZ) provider hold has no readable minute ($hold) — probing anyway" >>"$LOG"
else
  target=$(( (10#$reset_minute + 1) % 60 ))
  now_minute=$(( 10#$(date +%M) ))
  [ "$now_minute" -eq "$target" ] || exit 0
fi

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
