#!/usr/bin/env python3
"""Bing Webmaster Tools client for the ErrLookup site.

Bing is the crawler actually reading this corpus since Google withdrew in
August, so its crawl and traffic numbers are the ones worth watching.

The API key comes from devkey (`bing-webmaster`, env BING_WEBMASTER_API_KEY).
Bing takes it as a URL query parameter, so request URLs are never printed —
error output carries the status and Bing's message only.

Usage (always under devkey):
  devkey run bing-webmaster -- scripts/bing.py <command>

  bing.py sites                 sites the key's account holds
  bing.py traffic [days]        clicks/impressions by day (default 28)
  bing.py crawl [days]          pages crawled + status mix by day (default 14)
  bing.py queries [limit]       top search queries, summed over Bing's window (default 25)
  bing.py pages [limit]         top pages, summed over Bing's window (default 25)
  bing.py quota                 URL submission quota left

Stats stay empty for a few days after a site is added: errors.standardbeagle.com
was imported from Search Console on 2026-09-16 and still returned [] on
2026-09-19 while older properties on the same key returned full history.
"""
import datetime
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

SITE = os.environ.get("BING_SITE", "https://errors.standardbeagle.com/")
API = "https://ssl.bing.com/webmaster/api.svc/json"


def call(method: str, **params):
    key = os.environ.get("BING_WEBMASTER_API_KEY")
    if not key:
        sys.stderr.write("BING_WEBMASTER_API_KEY not set — run under: devkey run bing-webmaster -- ...\n")
        raise SystemExit(2)
    query = urllib.parse.urlencode({**params, "apikey": key})
    try:
        with urllib.request.urlopen(f"{API}/{method}?{query}", timeout=60) as resp:
            return json.load(resp)["d"]
    except urllib.error.HTTPError as e:
        sys.stderr.write(f"{method}: HTTP {e.code}: {e.read().decode()[:600]}\n")
        raise SystemExit(1)


def day(wcf_date: str) -> datetime.date:
    """Bing returns WCF dates: /Date(1789603200000)/ or /Date(1789603200000-0700)/."""
    ms = int(re.match(r"/Date\((-?\d+)", wcf_date).group(1))
    return datetime.datetime.fromtimestamp(ms / 1000, datetime.timezone.utc).date()


def recent(rows, days: int):
    cutoff = datetime.date.today() - datetime.timedelta(days=days)
    rows = sorted(rows, key=lambda r: r["Date"])
    return [r for r in rows if day(r["Date"]) >= cutoff]


def main() -> None:
    cmd = sys.argv[1] if len(sys.argv) > 1 else "sites"
    arg = int(sys.argv[2]) if len(sys.argv) > 2 else None

    if cmd == "sites":
        for s in call("GetUserSites"):
            print(f"  verified={s.get('IsVerified')}  {s['Url']}")
    elif cmd == "traffic":
        rows = recent(call("GetRankAndTrafficStats", siteUrl=SITE), arg or 28)
        if not rows:
            print("  no rows — Bing has no traffic data for this site in the window")
        for r in rows:
            print(f"  {day(r['Date'])}  clicks={r['Clicks']:6}  impressions={r['Impressions']:8}")
    elif cmd == "crawl":
        rows = recent(call("GetCrawlStats", siteUrl=SITE), arg or 14)
        if not rows:
            print("  no rows — Bing has no crawl data for this site in the window")
        for r in rows:
            print(f"  {day(r['Date'])}  crawled={r['CrawledPages']:6}  2xx={r['Code2xx']:6}  301={r['Code301']:5}  "
                  f"4xx={r['Code4xx']:4}  5xx={r['Code5xx']:4}  errors={r['CrawlErrors']:4}  "
                  f"inIndex={r.get('InIndex', '?')}")
    elif cmd in ("queries", "pages"):
        # One row per (query or page, week); `Query` holds the URL for pages.
        # Sum across weeks; position is impression-weighted.
        totals = {}
        for r in call("GetQueryStats" if cmd == "queries" else "GetPageStats", siteUrl=SITE):
            t = totals.setdefault(r["Query"], [0, 0, 0])
            t[0] += r["Clicks"]
            t[1] += r["Impressions"]
            t[2] += r["AvgImpressionPosition"] * r["Impressions"]
        if not totals:
            print(f"  no rows — Bing has no {cmd[:-1]} data for this site yet")
        for q, (clicks, imps, pos) in sorted(totals.items(), key=lambda kv: kv[1][1], reverse=True)[: arg or 25]:
            print(f"  clicks={clicks:5}  impressions={imps:7}  pos={pos / imps if imps else 0:5.1f}  {q}")
    elif cmd == "quota":
        q = call("GetUrlSubmissionQuota", siteUrl=SITE)
        print(f"  daily={q['DailyQuota']}  monthly={q['MonthlyQuota']}")
    else:
        print(__doc__)
        raise SystemExit(2)


if __name__ == "__main__":
    main()
