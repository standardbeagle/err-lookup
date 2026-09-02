#!/usr/bin/env bash
# Scheduled scanner run — re-entrant per project (§11.1):
#   1. SEED (always, no lock): upsert the corpus into the work queue. New or
#      requeued repos become eligible immediately — an already-running drain
#      picks them up because its workers claim until the queue is empty.
#   2. DRAIN (flock-held, single scanner so the provider gate stays honest):
#      claim → ls-remote HEAD check (unchanged repos cost no clone) → analyze →
#      integrate per repo. Killing a drain loses nothing but unclaimed repos.
# Every repo integrates independently, so the hourly publisher ships each
# project as it completes — no monolithic end-of-batch export gate.
set -u -o pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="${ERRLOOKUP_LOG_DIR:-$HOME/.local/state/errlookup}"
LOCK_FILE="$LOG_DIR/scan.lock"
CORPUS="${ERRLOOKUP_CORPUS:-$REPO_ROOT/docs/blitz-corpus.txt}"
# GLM 5.3 Flash on every phase since 2026-08-28 (docs/model-comparison-2026-08-27-glm53-flash.md);
# the config filename is historical.
export ERRLOOKUP_CONFIG="${ERRLOOKUP_CONFIG:-$REPO_ROOT/configs/blitz-glm-k3.kdl}"

mkdir -p "$LOG_DIR"

cd "$REPO_ROOT"
pnpm --filter @errlookup/pipeline dev scan "$CORPUS" --seed-only >>"$LOG_DIR/scan.log" 2>&1

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "$(date -u +%FT%TZ) drain active — seeded only; active drain picks up the queue" >>"$LOG_DIR/scan.log"
  exit 0
fi

# Disk hygiene (§11.3): reap orphaned work dirs from killed runs, then refuse
# to start below the free-space floor — a full disk mid-batch corrupts nothing
# (atomic export) but wastes a night.
#
# Liveness-based, not age-based: the old 12h threshold left ~4.5GB of clones
# from a killed drain sitting for half a day (2026-08-29). We hold the drain
# flock, so no other drain owns anything here; a dir is live only if some
# process still has its cwd inside it (cron helpers mid-call). The 60-min
# mtime grace covers a helper between calls. errlookup-acp-home is the
# persistent agent-runtime cache (opencode's self-installed deps) — never
# swept.
dir_in_use() {
  local p target
  for p in /proc/[0-9]*; do
    target=$(readlink "$p/cwd" 2>/dev/null) || continue
    case "$target" in "$1"|"$1"/*) return 0 ;; esac
  done
  return 1
}
for d in /tmp/errlookup-*; do
  [ -e "$d" ] || continue
  case "$d" in
    # Persistent, never swept: the shared agent-runtime cache, the
    # mkdir-based large-repo mutex, and the machine-wide provider gate
    # (absent = free — deleting a HELD lock or slot would admit a second
    # large repo, or a phantom provider call, alongside the holder).
    */errlookup-acp-home|*/errlookup-large-repo.lock|*/errlookup-provider-gate) continue ;;
  esac
  [ -n "$(find "$d" -maxdepth 0 -mmin -60 2>/dev/null)" ] && continue
  dir_in_use "$d" && continue
  rm -rf "$d"
done
MIN_FREE_GB="${ERRLOOKUP_MIN_FREE_GB:-10}"
free_gb=$(df -BG --output=avail /tmp | tail -1 | tr -dc '0-9')
if [ "${free_gb:-0}" -lt "$MIN_FREE_GB" ]; then
  echo "$(date -u +%FT%TZ) ABORT: ${free_gb}GB free on /tmp < ${MIN_FREE_GB}GB floor" >>"$LOG_DIR/scan.log"
  exit 1
fi

# Failure summary to ntfy (§11.3 alerting). A drain that ends having failed
# every repo it touched looks identical, from the outside, to one that had
# nothing to do: the run log is the only place the reason lives, and nobody
# reads it until something is visibly broken. On 2026-08-23 a spent z.ai
# window failed five repos an hour for five hours in silence.
#
# Sent once per run, and only when there is something to report. Reasons are
# clustered by their first clause, because a provider outage produces the same
# sentence a hundred times and the count is the interesting part.
summarize_failures() { # $1 = run log
  local log="$1"
  local failed reasons hold summary unresolved
  failed=$(grep -c "FAILED" "$log" 2>/dev/null || echo 0)
  hold=$(grep -o "provider window quota is spent until [0-9TZ:.-]*" "$log" 2>/dev/null | tail -1)
  # Data bugs: records neither the verify provider nor the escalation model
  # could document — they ship noindexed, and this count is how they surface.
  unresolved=$(grep -oE "[0-9]+ records UNRESOLVED" "$log" 2>/dev/null | awk '{s+=$1} END {print s+0}')
  [ "${failed:-0}" -gt 0 ] || [ -n "$hold" ] || [ "${unresolved:-0}" -gt 0 ] || return 0

  # "[repo] phase X: FAILED — <reason>" → the reason, counted. The stderr tail
  # is dropped (it is the same JSON fragment every time), timestamps and SHAs
  # are normalised so one outage clusters into one line, and the rest is cut
  # at 90 chars because the distinguishing part is always at the front.
  reasons=$(grep -oE "FAILED (—|:) .*" "$log" 2>/dev/null \
    | sed -E 's/^FAILED (—|:) //; s/; stderr.*//; s/[0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9:]+/<time>/g; s/[0-9a-f]{8,}/<sha>/g; s/^(.{0,90}).*/\1/' \
    | sort | uniq -c | sort -rn | head -5 \
    | sed 's/^ *//')

  summary="$(hostname): $(grep -c "^\[.*\] → " "$log" 2>/dev/null || echo 0) repos done, ${failed} failures"
  [ -n "$hold" ] && summary="$summary
$hold"
  [ "${unresolved:-0}" -gt 0 ] && summary="$summary
${unresolved} records unresolved after model escalation (data bugs — see UNRESOLVED lines)"
  [ -n "$reasons" ] && summary="$summary

top reasons:
$reasons"

  echo "$(date -u +%FT%TZ) failure summary: ${failed} failures" >>"$LOG_DIR/scan.log"
  if [ -n "${ERRLOOKUP_ALERT_URL:-}" ]; then
    curl -sf -m 20 -H "Title: errlookup drain" -H "Priority: default" \
      -d "$summary" "$ERRLOOKUP_ALERT_URL" >/dev/null \
      || echo "$(date -u +%FT%TZ) failure summary delivery failed (webhook unreachable)" >>"$LOG_DIR/scan.log"
  fi
}

ALERT_ENV="${ERRLOOKUP_ALERT_ENV:-$HOME/.config/errlookup/alert.env}"
[ -z "${ERRLOOKUP_ALERT_URL:-}" ] && [ -f "$ALERT_ENV" ] && . "$ALERT_ENV"

RUN_LOG="$LOG_DIR/scan-$(date -u +%Y%m%d-%H%M%S).log"
restart_wanted=0
{
  echo "=== scan run start $(date -u +%FT%TZ) corpus=$CORPUS code=$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  cd "$REPO_ROOT"
  pnpm --filter @errlookup/pipeline dev scan "$CORPUS"
  scan_exit=$?
  echo "=== scan exit=$scan_exit"
  # 75 = the drain hit its runtime budget with work still queued. It executes
  # the code it was started with, so a long drain silently pins production to
  # a stale deploy; ending the process is what picks up a new one. Export and
  # deploy are skipped on this path — the hourly publisher covers publishing,
  # and re-exporting the whole dataset between cycles would cost more than it
  # ships.
  if [ "$scan_exit" -eq 75 ]; then
    restart_wanted=1
    echo "=== restart requested (runtime budget); skipping export/deploy this cycle"
    echo "=== scan run end $(date -u +%FT%TZ)"
  fi
} >>"$RUN_LOG" 2>&1

summarize_failures "$RUN_LOG"

if [ "$restart_wanted" -eq 1 ]; then
  # Exit with the same code so the supervisor restarts us: the scan unit maps
  # 75 to a restart and re-runs its ExecStartPre pull, so the next drain
  # starts on whatever has been deployed since this one began. Dropping the
  # drain lock first keeps the successor from racing us for it.
  exec 9>&-
  ls -1t "$LOG_DIR"/scan-*.log 2>/dev/null | tail -n +31 | xargs -r rm --
  exit 75
fi

{
  # The drain runs under errlookup-scan.service (MemoryMax=8G); V8 sizes its
  # heap from the cgroup limit (~2G) and the exporter holds the whole dataset
  # in memory (2.8G RSS at 808 repos / 153k errors), so the export died with
  # "heap out of memory" at the end of every run while the uncapped cron
  # publisher succeeded. Give the exporter an explicit heap; the limit below
  # sits under the service cap with room for the DB mapping.
  NODE_OPTIONS=--max-old-space-size=6144 pnpm --filter @errlookup/pipeline dev export
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
