import type { APIRoute } from "astro";

const SITE = "https://errors.standardbeagle.com";
const STATIC_PAGES = [
  "/",
  "/about/",
  "/request-crawl/",
  "/api-docs/",
  "/blog/",
  "/blog/how-the-scanner-works/",
  "/blog/analyze-your-internal-repos/",
  "/blog/compiled-languages-error-lookup/",
];

// Static (non-repo) pages sitemap, referenced from the sitemap index.
export const GET: APIRoute = () => {
  const parts = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...STATIC_PAGES.map((p) => `  <url><loc>${SITE}${p}</loc></url>`),
    "</urlset>",
  ];
  return new Response(parts.join("\n"), {
    headers: { "content-type": "application/xml; charset=utf-8" },
  });
};
