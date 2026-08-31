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
  // publishing paces those invitations (see data/indexing.ts).
  for (const r of getPublishedRepoEntries()) {
    const [owner, name] = r.repo.split("/");
    parts.push(`  <sitemap><loc>${SITE}/sitemaps/${owner}/${name}.xml</loc></sitemap>`);
  }
  parts.push("</sitemapindex>");
  return parts.join("\n");
}

export function xmlResponse(body: string): Response {
  return new Response(body, { headers: { "content-type": "application/xml; charset=utf-8" } });
}
