#!/usr/bin/env python3
"""Search Console client for the ErrLookup property.

Authenticates as the SEO service account with a self-signed JWT, which needs
only `cryptography` — google-auth and googleapiclient are not installed on
these machines and this is not worth a dependency.

The key file is referenced by PATH and never read into output. Its location is
deliberate and documented in dev-setup/config/devkey/registry.kdl: file creds
do not fit devkey's keyring model, so the path is the contract.

Usage:
  gsc.py sites                      list properties the service account can see
  gsc.py sitemaps                   submitted sitemaps, with last-download state
  gsc.py submit <sitemap-url>       (re)submit a sitemap
  gsc.py delete <sitemap-url>       remove a sitemap submission
  gsc.py sync-sitemaps              submit every sitemap the live index lists
                                    that Search Console does not have yet
  gsc.py analytics [days]           clicks/impressions by day (default 28)
  gsc.py inspect <page-url>         per-URL index status and coverage verdict
"""
import json
import os
import sys
import time
import urllib.parse
import urllib.request

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding

KEY_PATH = os.environ.get("GOOGLE_SA_KEY", os.path.expanduser("~/.config/google-sa/standardbeagle-seo.json"))
# Domain property, not URL-prefix: the account holds sc-domain:… and a
# https://…/ site string returns 403 "does not have sufficient permission".
SITE = os.environ.get("GSC_SITE", "sc-domain:errors.standardbeagle.com")
SCOPE = "https://www.googleapis.com/auth/webmasters"


def _b64(raw: bytes) -> str:
    import base64
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def access_token() -> str:
    """Self-signed JWT -> OAuth2 access token. The key never leaves this process."""
    with open(KEY_PATH) as fh:
        sa = json.load(fh)
    now = int(time.time())
    header = _b64(json.dumps({"alg": "RS256", "typ": "JWT"}).encode())
    claims = _b64(json.dumps({
        "iss": sa["client_email"],
        "scope": SCOPE,
        "aud": "https://oauth2.googleapis.com/token",
        "iat": now,
        "exp": now + 3600,
    }).encode())
    signing_input = f"{header}.{claims}".encode()
    key = serialization.load_pem_private_key(sa["private_key"].encode(), password=None)
    signature = key.sign(signing_input, padding.PKCS1v15(), hashes.SHA256())
    assertion = f"{header}.{claims}.{_b64(signature)}"

    body = urllib.parse.urlencode({
        "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
        "assertion": assertion,
    }).encode()
    req = urllib.request.Request("https://oauth2.googleapis.com/token", data=body)
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.load(resp)["access_token"]


def call(path: str, method: str = "GET", payload=None):
    req = urllib.request.Request(
        f"https://searchconsole.googleapis.com{path}",
        method=method,
        data=json.dumps(payload).encode() if payload is not None else None,
        headers={
            "Authorization": f"Bearer {access_token()}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = resp.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        # The body carries Google's reason ("User does not have sufficient
        # permission for site X") which is the whole diagnostic value.
        sys.stderr.write(f"HTTP {e.code}: {e.read().decode()[:600]}\n")
        raise SystemExit(1)


def main() -> None:
    cmd = sys.argv[1] if len(sys.argv) > 1 else "sites"
    enc = urllib.parse.quote(SITE, safe="")

    if cmd == "sites":
        for s in call("/webmasters/v3/sites").get("siteEntry", []):
            print(f"  {s['permissionLevel']:22} {s['siteUrl']}")
    elif cmd == "sitemaps":
        for s in call(f"/webmasters/v3/sites/{enc}/sitemaps").get("sitemap", []):
            counts = ", ".join(f"{c['type']}={c['submitted']}/{c.get('indexed', '?')}" for c in s.get("contents", []))
            print(f"  {s['path']}")
            print(f"      lastDownloaded={s.get('lastDownloaded', 'never')} pending={s.get('isPending')} "
                  f"errors={s.get('errors', 0)} warnings={s.get('warnings', 0)} {counts}")
    elif cmd == "submit":
        target = urllib.parse.quote(sys.argv[2], safe="")
        call(f"/webmasters/v3/sites/{enc}/sitemaps/{target}", method="PUT")
        print(f"  submitted {sys.argv[2]}")
    elif cmd == "delete":
        target = urllib.parse.quote(sys.argv[2], safe="")
        call(f"/webmasters/v3/sites/{enc}/sitemaps/{target}", method="DELETE")
        print(f"  deleted {sys.argv[2]}")
    elif cmd == "sync-sitemaps":
        # Sitemap shards are permanent and only ever appended (pipeline
        # exporter/sitemap-shards.ts), so a new file appears roughly daily as
        # the open shard fills. Submitting each file directly is what gets its
        # URLs associated with a sitemap; waiting for Google to rediscover it
        # through the index has not worked on this host.
        import re
        base = SITE.replace("sc-domain:", "https://")
        req = urllib.request.Request(f"{base}/sitemap-index.xml", headers={"User-Agent": "errlookup-gsc/1.0"})
        with urllib.request.urlopen(req, timeout=60) as resp:
            live = [f"{base}/sitemap-index.xml"] + re.findall(r"<loc>([^<]+)</loc>", resp.read().decode())
        have = {s["path"] for s in call(f"/webmasters/v3/sites/{enc}/sitemaps").get("sitemap", [])}
        missing = [u for u in live if u not in have]
        for u in missing:
            call(f"/webmasters/v3/sites/{enc}/sitemaps/{urllib.parse.quote(u, safe='')}", method="PUT")
            print(f"  submitted {u}")
        print(f"  {len(live)} live sitemaps, {len(missing)} newly submitted")
    elif cmd == "analytics":
        days = int(sys.argv[2]) if len(sys.argv) > 2 else 28
        import datetime
        end = datetime.date.today()
        start = end - datetime.timedelta(days=days)
        r = call(f"/webmasters/v3/sites/{enc}/searchAnalytics/query", "POST", {
            "startDate": str(start), "endDate": str(end),
            "dimensions": ["date"], "rowLimit": 1000,
        })
        rows = r.get("rows", [])
        if not rows:
            print("  no rows — the property has no search data in this window")
        for row in rows:
            print(f"  {row['keys'][0]}  clicks={row['clicks']:6.0f}  impressions={row['impressions']:8.0f}  "
                  f"ctr={row['ctr']*100:5.2f}%  pos={row['position']:5.1f}")
    elif cmd == "inspect":
        r = call("/v1/urlInspection/index:inspect", "POST",
                 {"inspectionUrl": sys.argv[2], "siteUrl": SITE})
        idx = r.get("inspectionResult", {}).get("indexStatusResult", {})
        for k in ("verdict", "coverageState", "robotsTxtState", "indexingState",
                  "googleCanonical", "userCanonical", "lastCrawlTime", "pageFetchState"):
            if k in idx:
                print(f"  {k}: {idx[k]}")
    else:
        print(__doc__)
        raise SystemExit(2)


if __name__ == "__main__":
    main()
