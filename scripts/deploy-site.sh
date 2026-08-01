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
# run from packages/site so wrangler picks up ./functions (Pages Functions API)
cd "$REPO_ROOT/packages/site"
npx --yes wrangler@4 pages deploy dist \
  --project-name "${ERRLOOKUP_PAGES_PROJECT:-errlookup}" \
  --branch main \
  --commit-dirty=true
