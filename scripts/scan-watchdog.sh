#!/usr/bin/env bash
# Relaunch the corpus drain when none is running and claimable work remains.
#
# Drains die with their host (the production box is a WSL2 VM the Windows side
# restarts at will) and exit on the failure breaker; without a watchdog those
# deaths left a full queue idle for 10+ hours. Cron runs this every 15 minutes:
# it exits silently while a drain holds scan.lock, and otherwise relaunches
# scan-and-export.sh — at most once per ERRLOOKUP_WATCHDOG_MIN_GAP_S (default
# 3600) so a provider outage becomes one breaker trip per hour, not a thrash
# loop that burns the queue through failed attempts. The relaunch goes through
# errlookup-scan.service (ops/systemd/) so it runs under the same caps as the
# timer-started drain; the timer itself (Persistent=true) already covers a
# drain that died while a slot was missed.
set -u -o pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="${ERRLOOKUP_LOG_DIR:-$HOME/.local/state/errlookup}"
LOG="$LOG_DIR/watchdog.log"
DB="$REPO_ROOT/packages/pipeline/data/errlookup.db"
STAMP="$LOG_DIR/watchdog-last-launch"
MIN_GAP_S="${ERRLOOKUP_WATCHDOG_MIN_GAP_S:-3600}"

mkdir -p "$LOG_DIR"

# A held lock means a drain is alive — nothing to do. Open append-mode so the
# probe never truncates the file another process is flocking.
exec 9>>"$LOG_DIR/scan.lock"
if ! flock -n 9; then
  exit 0
fi
flock -u 9 # release immediately: scan-and-export takes the lock itself

[ -f "$DB" ] || exit 0
# `running` rows with no lock holder are orphans of a dead drain; the relaunch
# reclaims them, so they count as waiting work.
work=$(sqlite3 -readonly "$DB" "SELECT count(*) FROM queue WHERE status IN ('queued','running');" 2>/dev/null || echo 0)
[ "${work:-0}" -gt 0 ] || exit 0

now=$(date +%s)
last=$(stat -c %Y "$STAMP" 2>/dev/null || echo 0)
if [ $((now - last)) -lt "$MIN_GAP_S" ]; then
  exit 0
fi
touch "$STAMP"

echo "$(date -u +%FT%TZ) no drain holds scan.lock, $work rows waiting — relaunching" >>"$LOG"
ALERT_ENV="${ERRLOOKUP_ALERT_ENV:-$HOME/.config/errlookup/alert.env}"
[ -z "${ERRLOOKUP_UPDATE_URL:-}" ] && [ -f "$ALERT_ENV" ] && . "$ALERT_ENV"
if [ -n "${ERRLOOKUP_UPDATE_URL:-}" ]; then
  curl -sf -m 20 -H "Title: errlookup watchdog" -H "Priority: low" \
    -d "drain relaunched on $(hostname): $work queue rows were waiting" "$ERRLOOKUP_UPDATE_URL" >/dev/null \
    || echo "$(date -u +%FT%TZ) notification delivery failed (webhook unreachable)" >>"$LOG"
fi

# Relaunch through the unit so the drain gets the same caps (MemoryMax,
# CPUQuota, TasksMax, Nice) as a timer-started one. A bare nohup here put the
# relaunch in the user slice with no ceiling at all. --no-block: the oneshot
# unit stays active for the whole drain. Requires the unit to be installed
# (scripts/install-systemd.sh) and passwordless sudo for systemctl.
if ! systemctl cat errlookup-scan.service >/dev/null 2>&1; then
  echo "$(date -u +%FT%TZ) errlookup-scan.service not installed — run scripts/install-systemd.sh" >>"$LOG"
  exit 1
fi
sudo -n systemctl start --no-block errlookup-scan.service >>"$LOG" 2>&1 \
  || echo "$(date -u +%FT%TZ) systemctl start failed (exit $?)" >>"$LOG"
