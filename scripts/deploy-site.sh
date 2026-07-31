#!/usr/bin/env bash
# Build the static site and deploy to Cloudflare Pages.
# Credentials: CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID, either already in the
# environment or in ~/.config/errlookup/cloudflare.env (chmod 600). Fails fast if absent.
set -eu -o pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CRED_FILE="${ERRLOOKUP_CF_ENV:-$HOME/.config/errlookup/cloudflare.env}"

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ] && [ -f "$CRED_FILE" ]; then
  # shellcheck disable=SC1090
  . "$CRED_FILE"
  export CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID
fi
: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN not set and $CRED_FILE missing}"
: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID not set and $CRED_FILE missing}"

cd "$REPO_ROOT"
pnpm --filter @errlookup/site build
npx --yes wrangler@4 pages deploy packages/site/dist \
  --project-name "${ERRLOOKUP_PAGES_PROJECT:-errlookup}" \
  --branch main \
  --commit-dirty=true
