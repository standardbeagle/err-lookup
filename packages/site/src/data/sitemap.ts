import { getPublishedRepoEntries, getRepoErrors } from "./load.js";
import { indexableSlugs, indexableLastmod } from "@errlookup/schema";
import { SITEMAP_URLS_PER_FILE } from "./paging.js";

export const SITE = "https://errors.standardbeagle.com";

export interface SitemapUrl {
  loc: string;
  lastmod: string | null;
}

/**
 * Every URL the site advertises, in a stable order, grouped by repo so a
 * shard's contents stay put as the corpus grows.
 *
 * Only admitted repos: the sitemap is the crawl invitation, and scheduled
 * publishing paces those invitations (see schema/indexing.ts). Thin records
 * and non-canonical pattern variants render noindex, so they earn no line
 * either — the sitemap advertises exactly the set we want judged.
 */
export function allSitemapUrls(): SitemapUrl[] {
  const urls: SitemapUrl[] = [];
  for (const r of getPublishedRepoEntries()) {
    const errors = getRepoErrors(r.repo);
    const indexable = indexableSlugs(errors);
    // The repo landing page is dated by the same rollup as its records, not by
    // analyzedAt, which bumps on every re-analysis and would churn lastmod on
    // scans that changed nothing.
    const repoLastmod = indexableLastmod(errors, indexable) ?? r.analyzedAt;
    urls.push({ loc: `${SITE}/${r.repo}/`, lastmod: repoLastmod });
    for (const e of errors) {
      if (!indexable.has(e.slug)) continue;
      urls.push({
        loc: `${SITE}/${r.repo}/${e.slug}/`,
        lastmod: e.contentChangedAt ?? e.analyzedAt ?? repoLastmod,
      });
    }
  }
  return urls;
}

/** How many shards the corpus needs at the current per-file limit. */
export function sitemapShardCount(urlCount: number): number {
  return Math.max(1, Math.ceil(urlCount / SITEMAP_URLS_PER_FILE));
}

export function sitemapShardPath(shard: number): string {
  return `/sitemaps/urls-${shard}.xml`;
}

/** One shard's URLs. */
export function sitemapShard(urls: readonly SitemapUrl[], shard: number): SitemapUrl[] {
  const start = (shard - 1) * SITEMAP_URLS_PER_FILE;
  return urls.slice(start, start + SITEMAP_URLS_PER_FILE);
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
 * The sitemap index: the static-pages sitemap plus one shard per 50,000 URLs.
 *
 * Packed, not one file per repo. XML sitemaps have no pagination — a sitemap
 * index is the only grouping the protocol offers, and each file may carry
 * 50,000 URLs. One file per repo produced 1,658 children with a median of 49
 * URLs each, while Googlebot runs 35-94 requests a day on this host after the
 * August crawl withdrawal: roughly a month of its entire budget spent reading
 * sitemaps before fetching a single page. Search Console showed it from the
 * other side — 8 pages discovered through the index, while the same children
 * submitted by hand reported their real counts immediately.
 *
 * The same 286,029 URLs fit in six files. The trade is deliberate: a packed
 * shard changes whenever any repo inside it changes, so Google re-fetches more
 * bytes. Bytes are not the rationed resource here; requests are.
 *
 * Served at both /sitemap.xml and /sitemap-index.xml. Crawlers and SEO tools
 * probe the conventional /sitemap.xml without being told, and the descriptive
 * path is already published in robots.txt and submitted to search consoles, so
 * both need to keep resolving to the same document.
 */
export function sitemapIndexXml(): string {
  const urls = allSitemapUrls();
  const shards = sitemapShardCount(urls.length);
  const parts = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    `  <sitemap><loc>${SITE}/sitemaps/pages.xml</loc></sitemap>`,
  ];
  for (let s = 1; s <= shards; s++) {
    const lastmod = shardLastmod(sitemapShard(urls, s));
    parts.push(
      `  <sitemap><loc>${SITE}${sitemapShardPath(s)}</loc>${
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
