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
  `~/.local/state/errlookup/last-indexnow-marker-<host>`, and posts them in batches of
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

## Other Standard Beagle properties

The submitter takes `--base` and `--key`, so it drives any host we can write a
file to. Sitemap discovery reads `robots.txt` first and follows nested sitemap
indexes, because no two of these sites lay theirs out the same way.

| host | key file | sitemap | status |
| --- | --- | --- | --- |
| errors.standardbeagle.com | `packages/site/public/` | `/sitemap-index.xml` | 313,881 URLs submitted |
| dev.standardbeagle.com | `standardbeagle.github.io` repo root | nested `/sitemap.xml` | 507 URLs submitted |
| curvatureofthemind.com | `andylbrummer/cotm-site` `astro-site/public/` | `/sitemap.xml` | 196 URLs submitted |
| standardbeagle.com | Nexcess WordPress root (via beagle-ab2) | `/sitemap_index.xml` | 281 URLs submitted |

```bash
scripts/indexnow-submit.mjs --base https://dev.standardbeagle.com --key <key> --all --max 0
```

**A fresh key 403s until IndexNow can see it.** Both new hosts returned
`403 key not valid` on the first submission with the key file already serving
200, byte-identical and `text/plain`, and then `200 accepted` on a retry a few
minutes later. This is propagation, not a key problem — do not go regenerating
keys or rewriting files when it happens. (An earlier note here blamed key-to-host
binding; that was wrong, and the retry disproved it.)

Keys are per host anyway, which costs nothing and keeps the properties
independent if one is ever handed to a client.

**curvatureofthemind.com's key lives in its source repo.** The site is built from
`andylbrummer/cotm-site` and rsynced to `prod2:/var/www/curvatureofthemind.com-astro`
by that repo's `scripts/scheduled-publish.sh` on beagle-ab. A key file dropped
straight into the web root was deleted by the next deploy about ten hours later,
which is how it ended up in `astro-site/public/`.

## Schedule

`scripts/indexnow-sites.mjs` submits every site in `configs/indexnow-sites.kdl`
daily from beagle-ab's crontab (06:23), with one per-host marker each under
`~/.local/state/errlookup/`, logging to `indexnow-sites.log` there. It runs under
the pipeline's tsx because the shared KDL parser uses TypeScript syntax Node's
type stripping rejects. errors.standardbeagle.com is not in that list; its
publisher submits after each deploy.

**standardbeagle.com is reached through beagle-ab2.** It is WordPress on Nexcess,
SSH user `a8277114_1@199.189.225.135`, and that account only holds beagle-ab2's
keys — connecting from any other machine is refused, which looks like a password
prompt but there is no password. The key file sits in
`/chroot/home/a8277114/d773d993a2.nxcli.io/html`, the directory both
`~/public_html` and `~/standardbeagle.com/html` resolve to. A plain file in the
WordPress root is outside anything core or plugin updates replace.

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
