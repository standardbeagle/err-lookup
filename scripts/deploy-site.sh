#!/usr/bin/env bash
# Build the static site and deploy to Cloudflare Pages.
# Credentials: CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID, either already in the
# environment or in ~/.config/errlookup/cloudflare.env (chmod 600). Fails fast if absent.
set -eu -o pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CRED_FILE="${ERRLOOKUP_CF_ENV:-$HOME/.config/errlookup/cloudflare.env}"

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ] && [ -z "${CLOUDFLARE_API_KEY:-}" ] && [ -f "$CRED_FILE" ]; then
  # shellcheck disable=SC1090
  . "$CRED_FILE"
  export CLOUDFLARE_ACCOUNT_ID
  [ -n "${CLOUDFLARE_API_TOKEN:-}" ] && export CLOUDFLARE_API_TOKEN
  [ -n "${CLOUDFLARE_API_KEY:-}" ] && export CLOUDFLARE_API_KEY CLOUDFLARE_EMAIL
fi
# wrangler accepts either a scoped API token or the legacy Global API Key + email
if [ -z "${CLOUDFLARE_API_TOKEN:-}" ] && [ -z "${CLOUDFLARE_API_KEY:-}" ]; then
  echo "error: no Cloudflare credentials (CLOUDFLARE_API_TOKEN or CLOUDFLARE_API_KEY+CLOUDFLARE_EMAIL) in env or $CRED_FILE" >&2
  exit 1
fi
: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID not set and $CRED_FILE missing}"

cd "$REPO_ROOT"
pnpm --filter @errlookup/site build
# run from site so wrangler reads wrangler.toml (nodejs_compat flag);
# the API + on-demand pages ship inside dist/_worker.js built by Astro
cd "$REPO_ROOT/site"

# Content-loss guard. A Pages deploy replaces the whole asset set, so building
# against the 2-repo fixture in public/data (the checked-in default) publishes a
# 24-page site over the ~4,700-page production one and every error URL in the
# sitemaps starts 404ing. That happened on 2026-09-15; recovery was a rollback.
# The full corpus arrives from the export on the publisher host, so a build that
# small means the data is missing, not that the site shrank.
pages=$(find dist -name '*.html' | wc -l)
min="${ERRLOOKUP_MIN_PAGES:-1000}"
if [ "$pages" -lt "$min" ]; then
  echo "error: built $pages pages, below the $min floor — refusing to publish." >&2
  echo "       public/data holds the fixture export, not the full corpus." >&2
  echo "       Set ERRLOOKUP_MIN_PAGES to deploy a deliberately small build." >&2
  exit 1
fi
echo "content guard: $pages pages (floor $min)"

npx --yes wrangler@4 pages deploy dist \
  --project-name "${ERRLOOKUP_PAGES_PROJECT:-errlookup}" \
  --branch main \
  --commit-dirty=true

# Edge purge. The standardbeagle.com zone proxies the site and a zone Cache
# Rule holds every GET for 7 days (set 2026-10-13), so without this the new
# deployment stays invisible behind the old one for up to a week. Purge by
# hostname leaves the rest of the zone (the WordPress cache) alone. A failed
# purge fails the deploy: stale-for-a-week is not a state to continue from.
SITE_HOST="${ERRLOOKUP_SITE_HOST:-errors.standardbeagle.com}"
CF_ZONE="${ERRLOOKUP_CF_ZONE:-standardbeagle.com}"
if [ -n "${CLOUDFLARE_API_TOKEN:-}" ]; then
  CF_AUTH=(-H "Authorization: Bearer $CLOUDFLARE_API_TOKEN")
else
  CF_AUTH=(-H "X-Auth-Key: $CLOUDFLARE_API_KEY" -H "X-Auth-Email: $CLOUDFLARE_EMAIL")
fi
zone_id=$(curl -sSf "https://api.cloudflare.com/client/v4/zones?name=$CF_ZONE" "${CF_AUTH[@]}" \
  | python3 -c 'import sys,json; r=json.load(sys.stdin)["result"]; print(r[0]["id"] if r else "")')
if [ -z "$zone_id" ]; then
  echo "error: zone $CF_ZONE not visible to these credentials — cannot purge $SITE_HOST" >&2
  exit 1
fi
curl -sSf -X POST "https://api.cloudflare.com/client/v4/zones/$zone_id/purge_cache" "${CF_AUTH[@]}" \
  -H "Content-Type: application/json" --data "{\"hosts\":[\"$SITE_HOST\"]}" \
  | python3 -c 'import sys,json; r=json.load(sys.stdin); sys.exit(0 if r.get("success") else "purge failed: %s" % r.get("errors"))'
echo "edge purge: $SITE_HOST"

# Post-deploy smoke: a deploy that serves 500s is worse than no deploy, and
# the failure class this catches (immutable-headers 500 on the retired-slug
# redirect) was invisible to the analytics. Failure fails the deploy step and
# alerts; the previous deployment stays live only in the sense that the CDN
# still has it cached — the fix is a follow-up deploy, loudly demanded.
"$REPO_ROOT/scripts/smoke-site.sh" "${ERRLOOKUP_SMOKE_BASE:-https://errors.standardbeagle.com}"
