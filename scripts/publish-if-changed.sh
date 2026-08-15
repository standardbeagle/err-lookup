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

read -r latest repo_count <<EOF2
$(cd "$REPO_ROOT/packages/pipeline" && node -e '
  const D = require("better-sqlite3");
  try {
    const d = new D("data/errlookup.db", { readonly: true, fileMustExist: true });
    const r = d.prepare("SELECT max(analyzed_at) m, count(*) n FROM repositories WHERE status IN (\x27analyzed\x27,\x27exported\x27)").get();
    // Info pages publish too: fold their newest created_at into the change
    // marker (space-free — the marker is one shell word). The table check
    // covers a DB from before migration 0004 ran.
    const hasInfo = d.prepare("SELECT 1 FROM sqlite_master WHERE type=\x27table\x27 AND name=\x27info_pages\x27").get();
    const info = hasInfo ? d.prepare("SELECT coalesce(max(created_at), \x27\x27) i FROM info_pages").get().i : "";
    console.log(`${r.m ?? ""}${info === "" ? "" : `+info${info}`} ${r.n ?? 0}`);
  } catch { /* no DB yet */ }
')
EOF2
if [ -z "$latest" ]; then
  echo "$(date -u +%FT%TZ) no analyzed repos yet, nothing to publish" >>"$LOG"
  exit 0
fi

last=$(cat "$STATE_FILE" 2>/dev/null || echo "")
if [ "$latest" = "$last" ]; then
  echo "$(date -u +%FT%TZ) unchanged since last publish ($latest)" >>"$LOG"
  exit 0
fi

# Cadence governor: past ERRLOOKUP_PUBLISH_SLOW_AT_REPOS analyzed repos
# (default 150), publish at most once every ERRLOOKUP_PUBLISH_SLOW_HOURS
# (default 4). Every publish is a full site build + deploy whose cost grows
# with the corpus; hourly made sense at 100 repos, not at 1,000. The cron
# stays hourly — this gate is what actually paces deploys.
SLOW_AT="${ERRLOOKUP_PUBLISH_SLOW_AT_REPOS:-150}"
SLOW_HOURS="${ERRLOOKUP_PUBLISH_SLOW_HOURS:-4}"
if [ "${repo_count:-0}" -ge "$SLOW_AT" ] && [ -f "$STATE_FILE" ]; then
  marker_age=$(( $(date +%s) - $(stat -c %Y "$STATE_FILE") ))
  if [ "$marker_age" -lt $(( SLOW_HOURS * 3600 )) ]; then
    echo "$(date -u +%FT%TZ) cadence governor: $repo_count repos >= $SLOW_AT, last publish ${marker_age}s ago < ${SLOW_HOURS}h — holding" >>"$LOG"
    exit 0
  fi
fi

# Build + deploy output goes to a per-run log (the Astro build alone prints
# ~17k page lines; appending it to publish.log grew that file to 198MB).
# publish.log keeps only one summary line per attempt.
RUN_LOG="$LOG_DIR/publish-$(date -u +%Y%m%d-%H%M%S).log"
(
  echo "=== publish start $(date -u +%FT%TZ) (new analysis up to $latest)"
  cd "$REPO_ROOT"
  # Export and the site build both resolve @errlookup/schema to its dist — a
  # pull alone leaves that stale (install does not build workspace deps).
  pnpm --filter @errlookup/schema build || exit 1
  pnpm --filter @errlookup/pipeline dev export || exit 1
  "$REPO_ROOT/scripts/deploy-site.sh" || exit 1
  printf '%s' "$latest" > "$STATE_FILE"
  echo "=== publish done $(date -u +%FT%TZ)"
) >>"$RUN_LOG" 2>&1
publish_exit=$?
echo "$(date -u +%FT%TZ) publish exit=$publish_exit (analysis up to $latest) log=$RUN_LOG" >>"$LOG"

# Failure-streak alerting: the index.json>25MiB breakage failed silently every
# hour for ~30h before anyone noticed. Track consecutive failures; at
# ERRLOOKUP_ALERT_AFTER (default 2) POST a plain-text alert to
# ERRLOOKUP_ALERT_URL (any webhook that accepts a text body — ntfy, Slack
# incoming hook), re-alert every 12 further failures, and send a recovery
# note when a streak >= threshold ends. URL comes from the environment or
# ~/.config/errlookup/alert.env; without one the streak still logs loudly.
STREAK_FILE="$LOG_DIR/publish-failure-streak"
ALERT_ENV="${ERRLOOKUP_ALERT_ENV:-$HOME/.config/errlookup/alert.env}"
[ -z "${ERRLOOKUP_ALERT_URL:-}" ] && [ -f "$ALERT_ENV" ] && . "$ALERT_ENV"
ALERT_AFTER="${ERRLOOKUP_ALERT_AFTER:-2}"

send_alert() { # $1 = message
  echo "$(date -u +%FT%TZ) ALERT: $1" >>"$LOG"
  if [ -n "${ERRLOOKUP_ALERT_URL:-}" ]; then
    curl -sf -m 20 -H "Title: errlookup publish" -d "$1" "$ERRLOOKUP_ALERT_URL" >/dev/null \
      || echo "$(date -u +%FT%TZ) alert delivery failed (webhook unreachable)" >>"$LOG"
  fi
}

streak=$(cat "$STREAK_FILE" 2>/dev/null || echo 0)
if [ "$publish_exit" -ne 0 ]; then
  streak=$(( streak + 1 ))
  printf '%s' "$streak" > "$STREAK_FILE"
  if [ "$streak" -eq "$ALERT_AFTER" ] || [ $(( streak % 12 )) -eq 0 ]; then
    err_line=$(grep -m1 -iE "ERROR|error:" "$RUN_LOG" | head -c 200)
    send_alert "publish failing on $(hostname): $streak consecutive failures. ${err_line:-see $RUN_LOG}"
  fi
else
  if [ "$streak" -ge "$ALERT_AFTER" ]; then
    send_alert "publish recovered on $(hostname) after $streak failures (dataset $latest)"
  fi
  printf '0' > "$STREAK_FILE"
fi

# keep the 10 most recent publish run logs
ls -1t "$LOG_DIR"/publish-*.log 2>/dev/null | tail -n +11 | xargs -r rm --
exit "$publish_exit"
