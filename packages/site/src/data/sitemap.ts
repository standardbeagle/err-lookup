import { getPublishedRepoEntries } from "./load.js";

export const SITE = "https://errors.standardbeagle.com";

/**
 * The sitemap index: one child sitemap for the static pages, one per repo
 * (§6.2), which keeps each file well under the 50k-URL limit as the corpus grows.
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
  // Only admitted repos: the sitemap is the crawl invitation, and scheduled
  // publishing paces those invitations (see schema/indexing.ts).
  //
  // lastmod on every child entry: without it a crawler must refetch all ~1,400
  // child sitemaps to discover which one moved, and after the August crawl
  // withdrawal the budget is tens of requests a day. The value is the
  // exporter's rollup of the same indexable records the child sitemap lists
  // (RepoEntry.contentChangedAt), so index and child always agree. A dataset
  // published before the field existed carries none — fall back to analyzedAt,
  // which is stale-safe (never older than the content) and self-corrects on
  // the next export.
  for (const r of getPublishedRepoEntries()) {
    const [owner, name] = r.repo.split("/");
    const lastmod = r.contentChangedAt ?? r.analyzedAt;
    parts.push(
      `  <sitemap><loc>${SITE}/sitemaps/${owner}/${name}.xml</loc>${
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
