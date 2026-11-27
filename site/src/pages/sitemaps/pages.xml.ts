import type { APIRoute } from "astro";
import { SITE, urlsetXml, xmlResponse, type SitemapUrl } from "../../data/sitemap.js";
import { allRepoPageHrefs } from "../../data/paging.js";
import { posts, blogPostHref } from "../../data/blog.js";
import { GUIDES, guideHref } from "../../data/guides.js";
import { getInfoIndex } from "../../data/load.js";

const STATIC_PAGES = ["/about/", "/request-crawl/", "/api-docs/", "/blog/", "/guides/", "/troubleshooting/", "/info/"];

// Static (non-repo) pages sitemap, referenced from the sitemap index.
// The repo-list pages are derived rather than listed: they grow with the corpus,
// and a hand-kept list would silently stop covering them at the next scan.
//
// Articles and posts carry the date they were written, so they get a lastmod;
// the hubs, the guides and the repo-list pages have no tracked change date and
// are listed undated — a made-up date teaches a crawler not to trust the file.
export const GET: APIRoute = () => {
  const undated = (p: string): SitemapUrl => ({ loc: `${SITE}${p}`, lastmod: null });
  const urls: SitemapUrl[] = [
    ...allRepoPageHrefs().map(undated),
    ...STATIC_PAGES.map(undated),
    ...posts.map((p) => ({ loc: `${SITE}${blogPostHref(p.slug)}`, lastmod: p.date })),
    ...GUIDES.map((g) => undated(guideHref(g.slug))),
    ...getInfoIndex().map((p) => ({ loc: `${SITE}/info/${p.slug}/`, lastmod: p.generatedAt })),
  ];
  return xmlResponse(urlsetXml(urls));
};
