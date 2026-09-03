import type { APIRoute } from "astro";
import { getPublishedRepoEntries, getRepoErrors } from "../../../data/load.js";
import { indexableSlugs } from "../../../data/indexing.js";

// Per-repo sitemap: /sitemaps/{owner}/{name}.xml (§6.2). Only repos the
// scheduled publisher has admitted get one — an unadmitted repo's pages are
// noindex and inviting a crawl to them would contradict the meta.
export function getStaticPaths() {
  return getPublishedRepoEntries().map((r) => {
    const [owner, name] = r.repo.split("/");
    return { params: { owner, name }, props: { repo: r.repo } };
  });
}

export const GET: APIRoute = ({ props }) => {
  const repo = props.repo as string;
  const errors = getRepoErrors(repo);
  // Thin records and non-canonical pattern variants render noindex, so they
  // earn no sitemap line either (data/indexing.ts) — the sitemap advertises
  // exactly the set we want judged.
  const indexable = indexableSlugs(errors);
  const repoLastmod = getPublishedRepoEntries().find((r) => r.repo === repo)?.analyzedAt;
  const base = `https://errors.standardbeagle.com/${repo}`;
  // Real lastmod instead of changefreq=weekly: pages only change when their
  // repo is re-analyzed, and the blanket weekly hint had crawlers re-fetching
  // the whole long tail on a schedule — 74% of worker invocations were Google.
  const urls = [
    { loc: `${base}/`, lastmod: repoLastmod },
    ...errors
      .filter((e) => indexable.has(e.slug))
      // contentChangedAt over analyzedAt: analyzedAt bumps on every
      // re-analysis even when the page is byte-identical, and lastmod churn
      // is what teaches a crawler to distrust the sitemap.
      .map((e) => ({ loc: `${base}/${e.slug}/`, lastmod: e.contentChangedAt ?? e.analyzedAt ?? repoLastmod })),
  ];
  const body = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls.map(
      (u) => `  <url><loc>${u.loc}</loc>${u.lastmod ? `<lastmod>${u.lastmod.slice(0, 10)}</lastmod>` : ""}</url>`
    ),
    "</urlset>",
  ].join("\n");
  return new Response(body, { headers: { "content-type": "application/xml; charset=utf-8" } });
};
