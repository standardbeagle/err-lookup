import type { APIRoute } from "astro";
import { SITE, xmlResponse } from "../data/sitemap.js";
import { postsByDate, blogPostHref } from "../data/blog.js";

/** RSS dates are RFC-822; the post index stores plain ISO calendar dates. */
function rfc822(isoDate: string): string {
  return new Date(`${isoDate}T00:00:00Z`).toUTCString();
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// RSS 2.0 feed for the blog. atom:link rel=self is required by feed validators
// and is what readers use to re-find the feed after a redirect.
export const GET: APIRoute = () => {
  const items = postsByDate().map((p) => {
    const url = `${SITE}${blogPostHref(p.slug)}`;
    return [
      "    <item>",
      `      <title>${escapeXml(p.title)}</title>`,
      `      <link>${url}</link>`,
      `      <guid isPermaLink="true">${url}</guid>`,
      `      <pubDate>${rfc822(p.date)}</pubDate>`,
      `      <description>${escapeXml(p.description)}</description>`,
      "    </item>",
    ].join("\n");
  });

  return xmlResponse(
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
      "  <channel>",
      "    <title>ErrLookup Blog</title>",
      `    <link>${SITE}/blog/</link>`,
      "    <description>Engineering notes on building and using a machine-consumable error knowledge base.</description>",
      "    <language>en</language>",
      `    <atom:link href="${SITE}/rss.xml" rel="self" type="application/rss+xml" />`,
      ...items,
      "  </channel>",
      "</rss>",
    ].join("\n")
  );
};
