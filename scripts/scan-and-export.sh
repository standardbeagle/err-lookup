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
# GLM 5.2 bulk + K3 verify won the model comparison (docs/model-comparison-2026-07-31.md)
export ERRLOOKUP_CONFIG="${ERRLOOKUP_CONFIG:-$REPO_ROOT/configs/blitz-glm-k3.kdl}"

mkdir -p "$LOG_DIR"

cd "$REPO_ROOT"
pnpm --filter @errlookup/pipeline dev scan "$CORPUS" --seed-only >>"$LOG_DIR/scan.log" 2>&1

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "$(date -u +%FT%TZ) drain active — seeded only; active drain picks up the queue" >>"$LOG_DIR/scan.log"
  exit 0
fi

# Disk hygiene (§11.3): reap orphaned clone dirs from crashed runs, then
# refuse to start below the free-space floor — a full disk mid-batch corrupts
# nothing (atomic export) but wastes a night.
find /tmp -maxdepth 1 -name 'errlookup-*' -mmin +720 -exec rm -rf {} + 2>/dev/null
MIN_FREE_GB="${ERRLOOKUP_MIN_FREE_GB:-10}"
free_gb=$(df -BG --output=avail /tmp | tail -1 | tr -dc '0-9')
if [ "${free_gb:-0}" -lt "$MIN_FREE_GB" ]; then
  echo "$(date -u +%FT%TZ) ABORT: ${free_gb}GB free on /tmp < ${MIN_FREE_GB}GB floor" >>"$LOG_DIR/scan.log"
  exit 1
fi

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
