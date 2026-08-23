#!/usr/bin/env bash
# Re-run the verify phase over repos whose published records have gaps.
#
# Usage: reverify-debt.sh <repo-list.tsv> [PARALLEL]
#   repo-list.tsv  first column owner/repo (extra columns ignored, # comments ok)
#   PARALLEL       repos in flight, default 1
#
# Why this exists: verify fills the gaps the analysis phases left, and it fails
# whole batches when the provider is out of quota — silently, because the
# runner records the phase as success either way. The 2026-08-16..21 cohort
# published 25-52% of its records missing documentation or solutions for that
# reason. Gap counts come from the database, never from the logs.
#
# Safe to run beside a drain: it takes no scan lock and each repo is a normal
# `analyze --phases 5`, but it does spend the same provider budget, so the
# default is one at a time.
set -u -o pipefail

LIST="${1:?usage: reverify-debt.sh <repo-list.tsv> [PARALLEL]}"
PARALLEL="${2:-1}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="${ERRLOOKUP_LOG_DIR:-$HOME/.local/state/errlookup}"
LOG="$LOG_DIR/reverify-$(date -u +%Y%m%d-%H%M%S).log"
export ERRLOOKUP_CONFIG="${ERRLOOKUP_CONFIG:-$REPO_ROOT/configs/blitz-glm-k3.kdl}"

mkdir -p "$LOG_DIR"
cd "$REPO_ROOT"

# One flock for the whole sweep: two sweeps at once would double-spend the
# provider budget on the same repos.
exec 9>"$LOG_DIR/reverify.lock"
if ! flock -n 9; then
  echo "$(date -u +%FT%TZ) reverify already running" >>"$LOG"
  exit 0
fi

repos=$(grep -vE '^\s*(#|$)' "$LIST" | cut -f1)
total=$(echo "$repos" | wc -l)
echo "=== reverify start $(date -u +%FT%TZ) repos=$total parallel=$PARALLEL" >>"$LOG"

run_one() {
  local repo="$1"
  local started=$SECONDS
  # `reverify` runs the verify phase against the repo's PUBLISHED records.
  # NOT `analyze --phases 5`: an unlisted phase defaults to on, so that command
  # re-runs the whole pipeline at full cost — the recipe in
  # docs/verify-debt-2026-08-16.txt was wrong about what it did.
  if pnpm --filter @errlookup/pipeline dev reverify "$repo" >>"$LOG" 2>&1; then
    echo "$(date -u +%FT%TZ) OK   $repo ($((SECONDS - started))s)" >>"$LOG"
  else
    echo "$(date -u +%FT%TZ) FAIL $repo ($((SECONDS - started))s)" >>"$LOG"
  fi
}

pids=()
for repo in $repos; do
  run_one "$repo" &
  pids+=($!)
  while [ "$(jobs -rp | wc -l)" -ge "$PARALLEL" ]; do
    wait -n
  done
done
wait

ok=$(grep -c " OK   " "$LOG" || true)
fail=$(grep -c " FAIL " "$LOG" || true)
echo "=== reverify end $(date -u +%FT%TZ) ok=$ok failed=$fail log=$LOG" >>"$LOG"
echo "$LOG"
