#!/usr/bin/env bash
# Render ops/systemd/* for this checkout and install them into
# /etc/systemd/system (sudo). Idempotent: shows the diff against what is
# installed, replaces only what changed, reloads systemd, enables the timer.
#
#   scripts/install-systemd.sh          # install/refresh
#   scripts/install-systemd.sh --diff   # show pending changes only
#
# The service's caps (MemoryMax, CPUQuota, TasksMax) live in the unit file in
# the repo; change them there and re-run this so every host and the watchdog
# relaunch (which goes through `systemctl start`) agree.
set -u -o pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$REPO_ROOT/ops/systemd"
DEST="${ERRLOOKUP_SYSTEMD_DIR:-/etc/systemd/system}"
RUN_USER="${ERRLOOKUP_RUN_USER:-$(id -un)}"
# Same PATH the crontab entries carry: node from nvm, lci from ~/.local/bin.
NODE_BIN="$(dirname "$(command -v node)")" || { echo "node not on PATH" >&2; exit 1; }
RUN_PATH="${ERRLOOKUP_RUN_PATH:-$NODE_BIN:$HOME/.local/bin:/usr/bin:/bin}"
diff_only=0; [ "${1:-}" = "--diff" ] && diff_only=1

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
changed=()
for unit in errlookup-scan.service errlookup-scan.timer; do
  sed -e "s|@REPO_ROOT@|$REPO_ROOT|g" -e "s|@USER@|$RUN_USER|g" -e "s|@PATH@|$RUN_PATH|g" \
    "$SRC/$unit" >"$tmp/$unit"
  grep -q '@[A-Z_]*@' "$tmp/$unit" && { echo "unsubstituted placeholder in $unit" >&2; exit 1; }
  if [ -f "$DEST/$unit" ] && cmp -s "$tmp/$unit" "$DEST/$unit"; then
    echo "$unit: unchanged"
    continue
  fi
  echo "$unit: $([ -f "$DEST/$unit" ] && echo changed || echo new)"
  diff -u "$DEST/$unit" "$tmp/$unit" 2>/dev/null || true
  changed+=("$unit")
done

[ ${#changed[@]} -eq 0 ] && { echo "nothing to install"; exit 0; }
[ $diff_only -eq 1 ] && exit 0

for unit in "${changed[@]}"; do
  # install(1) writes to a temp name and renames: systemd never sees a torn file.
  sudo install -m 0644 "$tmp/$unit" "$DEST/$unit" || exit 1
done
sudo systemctl daemon-reload || exit 1
sudo systemctl enable --now errlookup-scan.timer || exit 1
systemctl list-timers errlookup-scan.timer --no-pager
