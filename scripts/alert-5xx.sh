#!/usr/bin/env bash
# Hourly 5xx alarm over the TRAFFIC Analytics Engine dataset.
#
# Why this exists: Cloudflare Pages offers no configurable platform log
# persistence (probed 2026-09-03 — wrangler rejects [observability], the
# Pages API drops the key, the pages-worker script is unaddressable), so the
# middleware's own AE write is the durable record of server errors. It now
# runs on the failure path too (log first, fail second) — this script is the
# alarm on top: any 5xx in the last interval goes to ntfy. The retired-slug
# 500s sat unnoticed for a month; a single 500 is now a page-worthy event.
#
# Cron: hourly on beagle-ab. Credentials: ~/.config/errlookup/cloudflare.env.
set -u -o pipefail

CRED_FILE="${ERRLOOKUP_CF_ENV:-$HOME/.config/errlookup/cloudflare.env}"
ALERT_ENV="${ERRLOOKUP_ALERT_ENV:-$HOME/.config/errlookup/alert.env}"
WINDOW_MIN="${ERRLOOKUP_5XX_WINDOW_MIN:-70}"

# shellcheck disable=SC1090
. "$CRED_FILE"
[ -z "${ERRLOOKUP_ALERT_URL:-}" ] && [ -f "$ALERT_ENV" ] && . "$ALERT_ENV"

since=$(date -u -d "-${WINDOW_MIN} minutes" +"%Y-%m-%d %H:%M:%S")
rows=$(curl -sf -m 30 "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/analytics_engine/sql" \
  -H "X-Auth-Key: $CLOUDFLARE_API_KEY" -H "X-Auth-Email: $CLOUDFLARE_EMAIL" \
  -d "SELECT blob1 AS path, double1 AS status, SUM(_sample_interval) AS n
      FROM errlookup_traffic
      WHERE double1 >= 500 AND timestamp > toDateTime('$since')
      GROUP BY path, status ORDER BY n DESC LIMIT 10 FORMAT TabSeparated") || {
  echo "$(date -u +%FT%TZ) 5xx check: AE query failed" >&2
  exit 1
}

[ -z "$rows" ] && exit 0

total=$(printf '%s\n' "$rows" | awk -F'\t' '{s+=$3} END {print s+0}')
msg="$total server errors (5xx) in the last ${WINDOW_MIN}min on errors.standardbeagle.com
top paths:
$(printf '%s\n' "$rows" | head -5)"
echo "$(date -u +%FT%TZ) $msg"
if [ -n "${ERRLOOKUP_ALERT_URL:-}" ]; then
  curl -sf -m 20 -H "Title: errlookup 5xx" -H "Priority: high" -d "$msg" "$ERRLOOKUP_ALERT_URL" >/dev/null || true
fi
