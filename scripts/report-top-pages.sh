#!/bin/bash
# Top error pages by request count from the Analytics Engine dataset
# `errlookup_traffic` (written by packages/site/src/middleware.ts).
#
# Usage: report-top-pages.sh [DAYS] [LIMIT]
#   DAYS   lookback window, default 7 (AE retains ~90 days)
#   LIMIT  rows, default 25
#
# Output: TSV  path <TAB> requests <TAB> top UA class
# Feed the path column to `errlookup review` to run the quality-review pass on
# what people actually read.
#
# Blind spot: static-excluded paths never enter the worker, so they never write
# a data point. Error pages are worker-routed, which is what this report is for.
#
# Credentials: CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN (or
# CLOUDFLARE_API_KEY + CLOUDFLARE_EMAIL), from the environment or
# ~/.config/errlookup/cloudflare.env — same contract as deploy-site.sh.
set -euo pipefail

DAYS="${1:-7}"
LIMIT="${2:-25}"

CRED_FILE="${ERRLOOKUP_CF_ENV:-$HOME/.config/errlookup/cloudflare.env}"
if [ -z "${CLOUDFLARE_API_TOKEN:-}" ] && [ -z "${CLOUDFLARE_API_KEY:-}" ] && [ -f "$CRED_FILE" ]; then
  # shellcheck disable=SC1090
  . "$CRED_FILE"
fi
: "${CLOUDFLARE_ACCOUNT_ID:?no CLOUDFLARE_ACCOUNT_ID in env or $CRED_FILE}"

AUTH=()
if [ -n "${CLOUDFLARE_API_TOKEN:-}" ]; then
  AUTH=(-H "Authorization: Bearer $CLOUDFLARE_API_TOKEN")
else
  : "${CLOUDFLARE_EMAIL:?CLOUDFLARE_API_KEY needs CLOUDFLARE_EMAIL}"
  AUTH=(-H "X-Auth-Key: $CLOUDFLARE_API_KEY" -H "X-Auth-Email: $CLOUDFLARE_EMAIL")
fi

# blob1 path, blob2 UA class; _sample_interval weights sampled rows back to
# real counts. Error pages only: /<owner>/<repo>/<slug>/ (three segments).
QUERY="
SELECT
  blob1 AS path,
  SUM(_sample_interval) AS requests,
  topK(1)(blob2) AS top_ua
FROM errlookup_traffic
WHERE timestamp > NOW() - INTERVAL '${DAYS}' DAY
  AND blob1 LIKE '/%/%/%/'
GROUP BY path
ORDER BY requests DESC
LIMIT ${LIMIT}
FORMAT TabSeparated"

curl -sf "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/analytics_engine/sql" \
  "${AUTH[@]}" \
  --data "$QUERY"
