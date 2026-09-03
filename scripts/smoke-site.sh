#!/usr/bin/env bash
# Post-deploy smoke tests: the handful of behaviors whose silent breakage has
# actually cost this site (a Response.redirect + immutable-headers bug served
# 500 instead of 301 for every retired-slug URL for days, invisible to the
# analytics because the crash sat above the traffic write — found 2026-09-03
# only because a Google-indexed URL stopped loading).
#
# Usage: smoke-site.sh [base-url]   (default https://errors.standardbeagle.com)
# Exit 1 on any failure; posts to ERRLOOKUP_ALERT_URL when set (alert.env is
# sourced like the scan script does). Each check retries briefly to absorb
# deploy propagation.
set -u -o pipefail

BASE="${1:-https://errors.standardbeagle.com}"
ALERT_ENV="${ERRLOOKUP_ALERT_ENV:-$HOME/.config/errlookup/alert.env}"
[ -z "${ERRLOOKUP_ALERT_URL:-}" ] && [ -f "$ALERT_ENV" ] && . "$ALERT_ENV"

failures=()

# expect <name> <want-status> <url> [substring]
expect() {
  local name="$1" want="$2" url="$3" substr="${4:-}"
  local tries=0 status body
  while :; do
    body=$(curl -sS --max-time 20 -w "\n%{http_code}" "$url" 2>/dev/null)
    status="${body##*$'\n'}"
    body="${body%$'\n'*}"
    if [ "$status" = "$want" ] && { [ -z "$substr" ] || printf %s "$body" | grep -qF "$substr"; }; then
      echo "ok   $name ($status)"
      return 0
    fi
    tries=$((tries + 1))
    [ "$tries" -ge 3 ] && break
    sleep 10
  done
  echo "FAIL $name: want $want${substr:+ + \"$substr\"}, got $status ($url)"
  failures+=("$name")
}

# expect_redirect <name> <url> <location-substring>
expect_redirect() {
  local name="$1" url="$2" locsub="$3"
  local tries=0 status loc
  while :; do
    read -r status loc < <(curl -sS -o /dev/null --max-time 20 -w "%{http_code} %{redirect_url}" "$url" 2>/dev/null)
    if [ "$status" = "301" ] && [[ "${loc:-}" == *"$locsub"* ]]; then
      echo "ok   $name (301 -> $loc)"
      return 0
    fi
    tries=$((tries + 1))
    [ "$tries" -ge 3 ] && break
    sleep 10
  done
  echo "FAIL $name: want 301 -> *$locsub*, got $status -> ${loc:-none} ($url)"
  failures+=("$name")
}

echo "=== smoke $BASE $(date -u +%FT%TZ)"

expect "home"           200 "$BASE/" "ErrLookup"
expect "robots"         200 "$BASE/robots.txt" "Sitemap:"
expect "sitemap-index"  200 "$BASE/sitemap-index.xml" "<sitemapindex"
expect "manifest"       200 "$BASE/data/manifest.json" "datasetVersion"
expect "published-list" 200 "$BASE/data/published.json" "["
expect "api-search"     200 "$BASE/api/search?q=timeout"

# A live error page + the retired-slug redirect, derived from the dataset so
# the checks survive corpus changes.
repo=$(curl -sS --max-time 20 "$BASE/data/published.json" | tr -d '[]"' | cut -d, -f1)
if [ -n "$repo" ]; then
  owner="${repo%%/*}" name="${repo##*/}"
  slug=$(curl -sS --max-time 20 "$BASE/data/repos/$owner/$name.json" | grep -o '"slug":"[^"]*"' | head -1 | cut -d'"' -f4)
  if [ -n "$slug" ]; then
    expect "error-page" 200 "$BASE/$repo/$slug/" "<h1"
  else
    echo "FAIL error-page: no slug found in $repo shard"; failures+=("error-page")
  fi
  expect_redirect "retired-slug-301" "$BASE/$repo/smoke-test-definitely-not-a-slug/" "/$repo/"
  expect "repo-sitemap" 200 "$BASE/sitemaps/$owner/$name.xml" "<urlset"
else
  echo "FAIL dataset: could not read a repo from published.json"; failures+=("dataset")
fi

expect "unknown-repo-404" 404 "$BASE/no-such-owner-smoke/no-such-repo/no-such-slug/"

if [ "${#failures[@]}" -gt 0 ]; then
  msg="site smoke FAILED (${#failures[@]}): ${failures[*]} — $BASE"
  echo "=== $msg"
  if [ -n "${ERRLOOKUP_ALERT_URL:-}" ]; then
    curl -sf -m 20 -H "Title: errlookup smoke" -H "Priority: high" -d "$msg" "$ERRLOOKUP_ALERT_URL" >/dev/null || true
  fi
  exit 1
fi
echo "=== smoke passed"
