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
  bing.py crawl [days]          pages crawled by day + a cumulative snapshot (default 14)
  bing.py queries [limit]       top search queries, summed over Bing's window (default 25)
  bing.py pages [limit]         top pages, summed over Bing's window (default 25)
  bing.py quota                 URL submission quota left
  bing.py sitemaps              feeds Bing holds for the site: status, last crawl, URL count
  bing.py submit-sitemap [url]  (re)submit a sitemap; default is the site's sitemap index
  bing.py submit-url <url>      ask Bing to fetch one URL now (spends the daily quota)

Bing's per-URL "not in any sitemap" verdict reflects the last time Bing read
the shards, not the live files: on 2026-09-22 it said that of a URL present in
/sitemaps/urls-23.xml while `sitemaps` showed the index submitted on 09-16 and
last crawled on 09-19. `submit-sitemap` asks for a fresh read; check the feed
before assuming the site left a URL out.

Stats stay empty for a few days after a site is added: errors.standardbeagle.com
was imported from Search Console on 2026-09-16 and still returned [] on
2026-09-19 while older properties on the same key returned full history.

GetCrawlStats mixes two time bases in one row, and `crawl` splits them apart.
CrawledPages and Code4xx move from row to row. Code2xx, Code301, Code5xx,
AllOtherCodes and InIndex do not: they are one cumulative site-wide figure
stamped onto every daily row, and it refreshes lazily — standardbeagle.com read
2xx=77038 / 5xx=423 unchanged across 2026-09-18, -19 and -20 while CrawledPages
went 4,436 → 4,772 → 7,597. Printing them per day cost a session: `5xx=423` on
one row read as 423 server errors that day, when Analytics Engine had no 5xx at
all in 90 days and the real cause was the retired-slug 500s fixed in ac60875,
six weeks earlier. The remaining fields (CrawlErrors, BlockedByRobotsTxt,
DnsFailures, ConnectionTimeout, InLinks) are grouped with the snapshot because
they have not been observed to vary either — not because that is confirmed.

A property for a subdomain and one for its parent domain report nearly the same
crawl figures: on 2026-09-20 errors.standardbeagle.com read 2xx=76,388 /
inIndex=52,671 against standardbeagle.com's 77,038 / 53,167. The parent is
domain-wide and swallows the subdomain, so the delta is the parent's own
content. Do not read the parent's numbers as that site's alone.
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


def post(method: str, body: dict) -> None:
    """Write calls take a JSON body and the key in the query, and answer {"d": null}."""
    key = os.environ.get("BING_WEBMASTER_API_KEY")
    if not key:
        sys.stderr.write("BING_WEBMASTER_API_KEY not set — run under: devkey run bing-webmaster -- ...\n")
        raise SystemExit(2)
    req = urllib.request.Request(
        f"{API}/{method}?apikey={key}",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json; charset=utf-8"},
    )
    try:
        with urllib.request.urlopen(req, timeout=60):
            return
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
        # Only CrawledPages and Code4xx have been observed to move between rows;
        # see the module docstring. The rest repeats one cumulative site-wide
        # snapshot on every row, so print it once, after the daily series.
        for r in rows:
            print(f"  {day(r['Date'])}  crawled={r['CrawledPages']:6}  4xx={r['Code4xx']:4}")
        if rows:
            r = max(rows, key=lambda row: row["Date"])
            print(f"  cumulative snapshot — site-wide, NOT per-day, refreshes lazily (row {day(r['Date'])}):")
            print(f"    2xx={r['Code2xx']}  301={r['Code301']}  302={r['Code302']}  5xx={r['Code5xx']}  "
                  f"other={r['AllOtherCodes']}  inIndex={r.get('InIndex', '?')}")
            print(f"    crawlErrors={r['CrawlErrors']}  blockedByRobots={r['BlockedByRobotsTxt']}  "
                  f"dnsFailures={r['DnsFailures']}  timeouts={r['ConnectionTimeout']}  inLinks={r['InLinks']}")
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
    elif cmd == "sitemaps":
        feeds = call("GetFeeds", siteUrl=SITE)
        if not feeds:
            print("  no feeds — nothing has been submitted for this site")
        for f in feeds:
            crawled = day(f["LastCrawled"]) if f.get("LastCrawled") else "never"
            print(f"  {f['Type']:14} urls={f['UrlCount']:7}  submitted={day(f['Submitted'])}  "
                  f"lastCrawled={crawled}  status={f['Status']!r}  {f['Url']}")
    elif cmd == "submit-sitemap":
        feed = sys.argv[2] if len(sys.argv) > 2 else f"{SITE}sitemap-index.xml"
        post("SubmitFeed", {"siteUrl": SITE, "feedUrl": feed})
        print(f"  submitted {feed}")
    elif cmd == "submit-url":
        if len(sys.argv) < 3:
            print(__doc__)
            raise SystemExit(2)
        post("SubmitUrl", {"siteUrl": SITE, "url": sys.argv[2]})
        print(f"  submitted {sys.argv[2]}")
    else:
        print(__doc__)
        raise SystemExit(2)


if __name__ == "__main__":
    main()
