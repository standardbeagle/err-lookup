import type { APIRoute } from "astro";

// On demand, because this route's whole contract is its status code — same
// reason as BingSiteAuth.xml.ts. Under `output: "static"` there is nothing to
// prerender here anyway: the namespace is retired, so no path in it resolves.
export const prerender = false;

/**
 * The retired per-repo sitemaps: `/sitemaps/<owner>/<repo>.xml`.
 *
 * Until 2026-09-16 the index listed one sitemap per repo. Shards replaced them
 * (see data/sitemap.ts), and the index has been correct since — but crawlers
 * kept fetching the old children from their own copy of the previous index:
 * ~2,600 404s a day for the six days after the migration, flat, no decay. A
 * 404 means "not here, maybe later", so they retried indefinitely, spending
 * about a third of Bingbot's ~7,400 pages/day on files that will never exist.
 *
 * 410 is the one status that means "gone, stop asking". Unconditional: every
 * path under this namespace is retired, so there is nothing to look up and no
 * repo for which a per-repo sitemap will be valid again.
 */
export const GET: APIRoute = () =>
  new Response("This sitemap is retired. See /sitemap-index.xml.", {
    status: 410,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
