import type { APIRoute } from "astro";
import { getPublishedRepoEntries, getRepoErrors } from "../../../data/load.js";
import { indexableSlugs, indexableLastmod } from "@errlookup/schema";

// Per-repo sitemap: /sitemaps/{owner}/{name}.xml (§6.2). Only repos the
// scheduled publisher has admitted get one — an unadmitted repo's pages are
// noindex and inviting a crawl to them would contradict the meta.
//
// analyzedAt rides along in props: the repo list is already in hand here, and
// looking it up again per render re-read and re-parsed repos.json + published
// .json once for each of ~1,400 repos.
export function getStaticPaths() {
  return getPublishedRepoEntries().map((r) => {
    const [owner, name] = r.repo.split("/");
    return { params: { owner, name }, props: { repo: r.repo, analyzedAt: r.analyzedAt } };
  });
}

export const GET: APIRoute = ({ props }) => {
  const repo = props.repo as string;
  const errors = getRepoErrors(repo);
  // Thin records and non-canonical pattern variants render noindex, so they
  // earn no sitemap line either (schema/indexing.ts) — the sitemap advertises
  // exactly the set we want judged.
  const indexable = indexableSlugs(errors);
  // The repo landing page changes when its records' content does, so it takes
  // the same rollup the sitemap index carries for this file — not analyzedAt,
  // which bumps on every re-analysis and would churn this document (and the
  // index entry above it) on scans that changed nothing. analyzedAt is the
  // fallback only when no record is indexable and there is no content signal.
  const repoLastmod = indexableLastmod(errors, indexable) ?? (props.analyzedAt as string);
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
