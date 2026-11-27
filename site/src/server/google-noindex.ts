/**
 * X-Robots-Tag value that removes the whole site from Google only.
 *
 * Googlebot withdrew from this host on 2026-08-18 and never returned
 * (docs/search-engine-setup.md); the property is an experiment and what little
 * Google still serves is not worth the site-level drag on standardbeagle.com.
 * The per-bot prefix keeps Bing indexing: Bingbot ignores a `googlebot:`
 * block and follows the (absent) unprefixed directives, i.e. indexes normally.
 *
 * Header, not robots.txt: a disallow would stop Googlebot fetching pages at
 * all, so it would never SEE the noindex and contentless URLs could stay in
 * the index indefinitely. Crawl stays open; every fetched HTML page carries
 * the removal instruction. Prerendered pages never enter the worker, so they
 * carry the equivalent <meta name="googlebot"> from Base.astro instead —
 * tests/google-noindex.test.ts pins both sides.
 */
export const GOOGLE_NOINDEX = "googlebot: noindex, follow";

/**
 * Return the response with the Google-only noindex header, unchanged when the
 * body is not HTML (sitemaps, robots.txt, API JSON must stay clean — a
 * noindexed sitemap is one Google reads worse, and the API is a contract).
 * Always rewraps HTML: route responses can carry immutable headers in workerd
 * (the 2026-09-03 retired-slug incident), so a set() on the original is not
 * safe.
 */
export function withGoogleNoindex(res: Response): Response {
  if (!(res.headers.get("content-type") ?? "").startsWith("text/html")) return res;
  const out = new Response(res.body, res);
  out.headers.set("x-robots-tag", GOOGLE_NOINDEX);
  return out;
}
