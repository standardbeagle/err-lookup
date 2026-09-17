import { getPublishedRepoEntries, getRepoErrors, getSitemapShards } from "./load.js";
import { indexableSlugs, indexableLastmod } from "@errlookup/schema";
import { SITEMAP_MAX_URLS_PER_FILE } from "./paging.js";

export const SITE = "https://errors.standardbeagle.com";

export interface SitemapUrl {
  loc: string;
  lastmod: string | null;
}

/**
 * One repo's advertised URLs: its landing page, then its indexable error pages
 * in slug order so an unchanged repo renders byte-identical XML.
 *
 * Only admitted repos reach here: the sitemap is the crawl invitation, and
 * scheduled publishing paces those invitations (see schema/indexing.ts). Thin
 * records and non-canonical pattern variants render noindex, so they earn no
 * line either — the sitemap advertises exactly the set we want judged.
 */
function repoSitemapUrls(repo: string, analyzedAt: string): SitemapUrl[] {
  const errors = getRepoErrors(repo);
  const indexable = indexableSlugs(errors);
  // The landing page is dated by the same rollup as its records, not by
  // analyzedAt, which bumps on every re-analysis and would churn lastmod on
  // scans that changed nothing.
  const repoLastmod = indexableLastmod(errors, indexable) ?? analyzedAt;
  const urls: SitemapUrl[] = [{ loc: `${SITE}/${repo}/`, lastmod: repoLastmod }];
  for (const e of [...errors].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))) {
    if (!indexable.has(e.slug)) continue;
    urls.push({ loc: `${SITE}/${repo}/${e.slug}/`, lastmod: e.contentChangedAt ?? e.analyzedAt ?? repoLastmod });
  }
  return urls;
}

/**
 * Group repos' URLs into the shards the dataset assigned, shards in number
 * order, repos in the order given.
 *
 * Throws rather than guessing: a published repo with no shard means the dataset
 * and the site disagree about admission, and a shard past `maxPerFile` would be
 * rejected by every search engine as a whole file.
 */
export function groupSitemapShards(
  repos: readonly { repo: string; urls: readonly SitemapUrl[] }[],
  shardOf: ReadonlyMap<string, number>,
  maxPerFile: number = SITEMAP_MAX_URLS_PER_FILE
): Map<number, SitemapUrl[]> {
  const shards = new Map<number, SitemapUrl[]>();
  for (const { repo, urls } of repos) {
    const shard = shardOf.get(repo);
    if (shard === undefined) {
      throw new Error(`published repo ${repo} has no sitemap shard in sitemap-shards.json — re-run the export`);
    }
    const list = shards.get(shard) ?? [];
    list.push(...urls);
    shards.set(shard, list);
  }
  for (const [shard, list] of shards) {
    if (list.length > maxPerFile) {
      throw new Error(`sitemap shard ${shard} holds ${list.length} URLs, over the ${maxPerFile} protocol ceiling`);
    }
  }
  return new Map([...shards.entries()].sort(([a], [b]) => a - b));
}

let cachedShards: Map<number, SitemapUrl[]> | null = null;

/**
 * Every advertised URL, by permanent shard. Build-time only, and computed once
 * per build: the index and every shard page read it, and each call is a full
 * pass over the corpus.
 */
export function sitemapShards(): Map<number, SitemapUrl[]> {
  if (!cachedShards) {
    const repos = [...getPublishedRepoEntries()]
      .sort((a, b) => (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : 0))
      .map((r) => ({ repo: r.repo, urls: repoSitemapUrls(r.repo, r.analyzedAt) }));
    cachedShards = groupSitemapShards(repos, getSitemapShards());
  }
  return cachedShards;
}

export function sitemapShardPath(shard: number): string {
  return `/sitemaps/urls-${shard}.xml`;
}

/** Newest lastmod in a shard, so a crawler can skip one that has not moved. */
export function shardLastmod(urls: readonly SitemapUrl[]): string | null {
  return urls.reduce<string | null>(
    (max, u) => (u.lastmod !== null && (max === null || u.lastmod > max) ? u.lastmod : max),
    null
  );
}

export function urlsetXml(urls: readonly SitemapUrl[]): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls.map(
      (u) => `  <url><loc>${u.loc}</loc>${u.lastmod ? `<lastmod>${u.lastmod.slice(0, 10)}</lastmod>` : ""}</url>`
    ),
    "</urlset>",
  ].join("\n");
}

/**
 * The sitemap index: the static-pages sitemap plus one entry per permanent
 * shard.
 *
 * Packed, not one file per repo: Googlebot runs 35-94 requests a day on this
 * host since the August crawl withdrawal, and 1,658 per-repo children cost
 * roughly a month of that budget before a single page fetch. Permanent, not
 * re-sliced per build: Google keeps its view per file, and slices that moved
 * whenever a repo was added left Search Console holding copies that no longer
 * matched (see pipeline exporter/sitemap-shards.ts).
 *
 * Served at both /sitemap.xml and /sitemap-index.xml. Crawlers and SEO tools
 * probe the conventional /sitemap.xml without being told, and the descriptive
 * path is already published in robots.txt and submitted to search consoles, so
 * both need to keep resolving to the same document.
 */
export function sitemapIndexXml(): string {
  const parts = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    `  <sitemap><loc>${SITE}/sitemaps/pages.xml</loc></sitemap>`,
  ];
  for (const [shard, urls] of sitemapShards()) {
    const lastmod = shardLastmod(urls);
    parts.push(
      `  <sitemap><loc>${SITE}${sitemapShardPath(shard)}</loc>${
        lastmod ? `<lastmod>${lastmod.slice(0, 10)}</lastmod>` : ""
      }</sitemap>`
    );
  }
  parts.push("</sitemapindex>");
  return parts.join("\n");
}

export function xmlResponse(body: string): Response {
  return new Response(body, { headers: { "content-type": "application/xml; charset=utf-8" } });
}
