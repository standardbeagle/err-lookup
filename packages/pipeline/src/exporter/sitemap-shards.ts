/**
 * Permanent sitemap shard assignment.
 *
 * Google keeps its view of a sitemap per file. When shards were consecutive
 * slices of every URL in database order, one repo appearing, disappearing or
 * reordering moved every URL after it into a different file — urls-1.xml
 * started with slint-ui/slint one build and drizzle-team/drizzle-orm the next.
 * Search Console then held a copy of each file that no longer matched, and
 * URL inspection reported most pages as unknown with no referring sitemap.
 *
 * So each repo gets its shard once, at site admission, and keeps it. New repos
 * (about 70 a day) only ever fill the highest shard; a closed shard changes
 * only when one of its own repos is rescanned. Sizes are measured when a repo
 * is assigned and never again — re-measuring would let a rescan shift the
 * boundaries this exists to pin.
 */

export interface ShardLedgerRow {
  repo: string;
  firstPublishedAt: string;
  sitemapShard: number | null;
}

/**
 * Shards for admitted repos that do not have one yet. Existing assignments are
 * never returned and never changed.
 *
 * `urlCount` is the number of sitemap URLs the repo contributes (its landing
 * page plus its indexable error pages). A shard is closed once adding the next
 * repo would push it past `target`; a repo larger than `target` still goes
 * whole into its own shard — splitting one repo across files would bring back
 * the churn. The protocol ceiling (50,000) is enforced by the site build.
 */
export function assignSitemapShards(
  ledger: readonly ShardLedgerRow[],
  admitted: ReadonlySet<string>,
  urlCount: (repo: string) => number,
  target: number
): Map<string, number> {
  let open = 1;
  for (const r of ledger) if (r.sitemapShard !== null && r.sitemapShard > open) open = r.sitemapShard;

  // Only repos still on the site take up room: a withdrawn repo keeps its
  // number but no longer puts URLs in that file.
  let openCount = 0;
  for (const r of ledger) {
    if (r.sitemapShard === open && admitted.has(r.repo)) openCount += urlCount(r.repo);
  }

  const pending = ledger
    .filter((r) => r.sitemapShard === null && admitted.has(r.repo))
    .sort((a, b) =>
      a.firstPublishedAt === b.firstPublishedAt
        ? a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : 0
        : a.firstPublishedAt < b.firstPublishedAt ? -1 : 1
    );

  const assigned = new Map<string, number>();
  for (const r of pending) {
    const n = urlCount(r.repo);
    if (openCount > 0 && openCount + n > target) {
      open++;
      openCount = 0;
    }
    assigned.set(r.repo, open);
    openCount += n;
  }
  return assigned;
}
