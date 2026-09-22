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
  selects every URL whose (path, lastmod) pair is not yet in the ledger
  `~/.local/state/errlookup/indexnow-sent-<host>.tsv`, and posts them newest first
  in batches of 10,000. The ledger holds one `path<TAB>lastmod` line per URL
  IndexNow accepted. It replaced a "last submitted" date marker, which had three
  faults: it resent a whole day's URLs on every same-day publish (lastmod is
  day-granular), it skipped a capped run's remainder, and it never submitted
  newly admitted repos, because a repo joins the sitemap
  `ERRLOOKUP_PUBLISH_DELAY_DAYS` after export and so carries lastmods older than
  any marker.
- **Schedule** — `scripts/publish-if-changed.sh` runs it after a successful
  deploy. It is non-fatal: the pages are already live, so a rejected submission
  must not mark the publish failed. Rejected URLs stay out of the ledger, so the
  next run sends them again.

Run it by hand:

```bash
scripts/indexnow-submit.mjs --dry-run          # resolve and count, send nothing
scripts/indexnow-submit.mjs                    # not yet sent at this lastmod, max 10k
scripts/indexnow-submit.mjs --all --max 0      # every advertised URL, uncapped
scripts/indexnow-submit.mjs --record-only      # mark everything as sent, send nothing
```

The script refuses to start if `/<key>.txt` is not readable over HTTP, and
refuses to send if any URL is off-host — IndexNow rejects an entire request for
one foreign URL, so one stray link would drop 9,999 good ones with it.

A first `--all --max 0` run submits about 32 batches with a one-second pause
between them. That is a deliberate one-off; the ledger keeps subsequent runs to
the pages that are new or changed.

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
daily from beagle-ab's crontab (06:23), with one per-host ledger each under
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

Claimed on 2026-09-16 by **Import from Google Search Console**, so no
`BingSiteAuth.xml` token is in use and that route stays 404. The sitemap index
was submitted the same day; `scripts/bing.py sitemaps` shows it with its last
crawl date and URL count.

If the property ever has to be re-verified without GSC access: add
`errors.standardbeagle.com` manually, pick **XML file** verification, set the
offered token as `BING_SITE_AUTH_TOKEN` in `packages/site/src/data/webmaster.ts`,
deploy, then press Verify. The route at `src/pages/BingSiteAuth.xml.ts` returns
404 while the token is empty, so a half-configured property fails visibly
instead of serving an empty `<user>` element. The token is committed rather
than kept in the environment for the same reason as the IndexNow key: it is
public by design, and a build that silently lost it would un-verify the
property without failing anything.

**"URL is not in any sitemap" in Bing's URL inspection is Bing's copy, not the
site's.** On 2026-09-22 it said that of
`/ultraworkers/claw-code/old-string-not-found-in-file/`, which was in
`/sitemaps/urls-23.xml` and had been accepted by IndexNow on 2026-08-18; the
feed list showed the index last crawled on 2026-09-19. Check the URL against
the live shard first (`sitemap-shards.json` names the repo's shard), then
`bing.py submit-sitemap` to ask for a fresh read and `bing.py submit-url <url>`
to pull the one page. URL submission is 100 a day per property, not the 10,000
the UI advertises for the account.

## Measuring each engine

`scripts/gsc.py` (Search Console: sitemaps, search analytics, URL inspection)
measures Google. `scripts/bing.py` measures Bing: daily traffic, crawl status
mix, top queries and pages, submission quota. Its API key is the devkey entry
`bing-webmaster`, and Bing takes it as a URL parameter, so the script never
prints request URLs:

    devkey run bing-webmaster -- scripts/bing.py crawl

Bing builds stats for a new property slowly. errors.standardbeagle.com, imported
on 2026-09-16, still returned no rows on 2026-09-19, while standardbeagle.com
returned full history with the same key.

### Read the crawl row carefully

`GetCrawlStats` returns one row per day, but only `CrawledPages` and `Code4xx`
are daily numbers. `Code2xx`, `Code301`, `Code5xx`, `AllOtherCodes` and
`InIndex` are a single cumulative site-wide figure copied onto every row, and it
refreshes lazily: standardbeagle.com reported `2xx=77038` and `5xx=423`
unchanged on 2026-09-18, -19 and -20 while `CrawledPages` went 4,436 → 4,772 →
7,597. The same row also carried `Code2xx=76388` against `CrawledPages=7403`,
which cannot both describe one day.

`bing.py crawl` now prints the daily series first and the cumulative figures
once, labelled. Before it did, `5xx=423` on the 2026-09-20 row was read as 423
server errors that day. There were none: Analytics Engine held no response
above 499 anywhere in its 90-day window, the hourly `alert-5xx.sh` had never
fired, and 878 live URLs fetched as Bingbot all returned 200. The 423 are the
retired-slug 500s that `ac60875` fixed on 2026-09-03, still sitting in a
lifetime counter.

Treat a subdomain property and its parent as overlapping, not independent. On
2026-09-20 errors.standardbeagle.com read `2xx=76388` / `inIndex=52671` and
standardbeagle.com read `77038` / `53167`; the parent property is domain-wide,
so the difference is the parent's own content and the bulk belongs to the
subdomain.
