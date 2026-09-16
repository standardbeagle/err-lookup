# Search engine setup

Why this file exists: on 2026-08-18 Googlebot withdrew from this host and has
not come back. The numbers, from the Analytics Engine dataset `errlookup_traffic`:

| day | googlebot + google-other |
| --- | --- |
| 2026-08-17 | 26,965 |
| 2026-08-18 | 10,151 |
| 2026-08-19 | 535 |
| 2026-08-22 | 60 |
| 2026-09-15 | 25 |

Four weeks flat at 25-94 requests a day. At that rate the 313,486 URLs in the
sitemaps take roughly 21 years to read once.

Bingbot over the same period went the other way — 300-1,000/day through late
August, then 3,500-4,800/day from 2026-09-01, reaching 25,887 distinct paths in
the week to 2026-09-16. Google touched 286 in the same week.

So the crawler worth serving is Bing, and the two things below exist to serve it.

## IndexNow

[IndexNow](https://www.indexnow.org/documentation) is a push protocol: submit a
URL and the participating engines (Bing, Yandex, Seznam, Naver) fetch it instead
of waiting to rediscover it. Google does not participate.

Set up here:

- **Key** — `INDEXNOW_KEY` in `packages/site/src/data/indexnow.ts`, served as a
  static asset at `/<key>.txt`. The key is public by design: hosting it at that
  path IS the proof that we control the origin. `tests/indexnow.test.ts` pins the
  constant and the file together, because a rename on one side alone fails every
  submission with 403 and nothing else would notice.
- **Submitter** — `scripts/indexnow-submit.mjs`. Reads the live sitemap index,
  selects URLs whose `<lastmod>` is on or after the marker in
  `~/.local/state/errlookup/last-indexnow-marker`, and posts them in batches of
  10,000.
- **Schedule** — `scripts/publish-if-changed.sh` runs it after a successful
  deploy. It is non-fatal: the pages are already live, so a rejected submission
  must not mark the publish failed. The next run resubmits from the same marker.

Run it by hand:

```bash
scripts/indexnow-submit.mjs --dry-run          # resolve and count, send nothing
scripts/indexnow-submit.mjs                    # changed since the marker, max 10k
scripts/indexnow-submit.mjs --all --max 0      # every advertised URL, uncapped
scripts/indexnow-submit.mjs --since 2026-09-01 # explicit window
```

The script refuses to start if `/<key>.txt` is not readable over HTTP, and
refuses to send if any URL is off-host — IndexNow rejects an entire request for
one foreign URL, so one stray link would drop 9,999 good ones with it.

A first `--all --max 0` run submits about 32 batches with a one-second pause
between them. That is a deliberate one-off; the marker keeps subsequent runs to
the pages that actually changed.

## Bing Webmaster Tools

Not yet claimed. Without it there is no impressions, ranking, or index-coverage
signal from the crawler doing nearly all the work — `scripts/gsc.py` covers
Google only.

To claim it:

1. Sign in at <https://www.bing.com/webmasters> with the account that should own
   the property.
2. Choose **Import from Google Search Console** if that account can reach the
   GSC property — it verifies without touching the site. Otherwise add
   `errors.standardbeagle.com` manually and pick **XML file** verification.
3. For manual verification, take the token from the `BingSiteAuth.xml` Bing
   offers and set `BING_SITE_AUTH_TOKEN` in
   `packages/site/src/data/webmaster.ts`. The route at
   `src/pages/BingSiteAuth.xml.ts` serves it; it returns 404 while the token is
   empty, so that a half-configured property fails visibly instead of serving an
   empty `<user>` element that Bing rejects with the plumbing apparently in place.
4. Deploy, then press Verify.
5. Submit `https://errors.standardbeagle.com/sitemap-index.xml` under Sitemaps.

The token is committed rather than kept in the environment for the same reason
as the IndexNow key: it is public by design, and a build that silently lost it
would un-verify the property without failing anything.

## What is still Google-only

`scripts/gsc.py` (Search Console: sitemaps, search analytics, URL inspection)
measures Google. There is no equivalent wired up for Bing yet; Bing Webmaster
Tools has an API and claiming the property is the prerequisite for using it.
