import type { APIRoute } from "astro";
import { SITE, xmlResponse } from "../../data/sitemap.js";
import { allRepoPageHrefs } from "../../data/paging.js";
import { posts, blogPostHref } from "../../data/blog.js";
import { GUIDES, guideHref } from "../../data/guides.js";

const STATIC_PAGES = ["/about/", "/request-crawl/", "/api-docs/", "/blog/", "/guides/"];

// Static (non-repo) pages sitemap, referenced from the sitemap index.
// The repo-list pages are derived rather than listed: they grow with the corpus,
// and a hand-kept list would silently stop covering them at the next scan.
export const GET: APIRoute = () => {
  const urls = [
    ...allRepoPageHrefs(),
    ...STATIC_PAGES,
    ...posts.map((p) => blogPostHref(p.slug)),
    ...GUIDES.map((g) => guideHref(g.slug)),
  ];
  return xmlResponse(
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
      ...urls.map((p) => `  <url><loc>${SITE}${p}</loc></url>`),
      "</urlset>",
    ].join("\n")
  );
};
