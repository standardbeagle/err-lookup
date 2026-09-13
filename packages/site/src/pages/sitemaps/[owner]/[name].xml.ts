import type { APIRoute } from "astro";
import { getPublishedRepoEntries, getRepoErrors } from "../../../data/load.js";
import { indexableSlugs, indexableLastmod } from "@errlookup/schema";
import { SITEMAP_URLS_PER_FILE, repoErrorPageHref } from "../../../data/paging.js";

// Per-repo sitemap, sharded: /sitemaps/{owner}/{name}.xml is shard 1 and
// /sitemaps/{owner}/{name}-{n}.xml the rest. Only repos the scheduled
// publisher has admitted get one — an unadmitted repo's pages are noindex and
// inviting a crawl to them would contradict the meta.
//
// Sharding exists for the same reason the repo page paginates: weaviate's
// sitemap carried 4,880 URLs in a single document. The protocol permits
// 50,000, but every shard is a re-fetch when any part of it changes.
export function getStaticPaths() {
  const out: {
    params: { owner: string; name: string };
    props: { repo: string; shard: number; analyzedAt: string };
  }[] = [];
  for (const r of getPublishedRepoEntries()) {
    const [owner, name] = r.repo.split("/");
    const urlCount = indexableSlugs(getRepoErrors(r.repo)).size + 1; // + the repo page
    const shards = Math.max(1, Math.ceil(urlCount / SITEMAP_URLS_PER_FILE));
    for (let s = 1; s <= shards; s++) {
      out.push({
        params: { owner: owner!, name: s === 1 ? name! : `${name}-${s}` },
        props: { repo: r.repo, shard: s, analyzedAt: r.analyzedAt },
      });
    }
  }
  return out;
}

export const GET: APIRoute = ({ props }) => {
  const repo = props.repo as string;
  const shard = props.shard as number;
  const errors = getRepoErrors(repo);
  // Thin records and non-canonical pattern variants render noindex, so they
  // earn no sitemap line either (schema/indexing.ts) — the sitemap advertises
  // exactly the set we want judged.
  const indexable = indexableSlugs(errors);
  // The repo landing page takes the same rollup the sitemap index carries for
  // this file, not analyzedAt, which bumps on every re-analysis and would
  // churn this document on scans that changed nothing.
  const repoLastmod = indexableLastmod(errors, indexable) ?? (props.analyzedAt as string);
  const base = `https://errors.standardbeagle.com/${repo}`;
  const all = [
    { loc: `${base}/`, lastmod: repoLastmod },
    ...errors
      .filter((e) => indexable.has(e.slug))
      // contentChangedAt over analyzedAt: analyzedAt bumps on every
      // re-analysis even when the page is byte-identical, and lastmod churn
      // is what teaches a crawler to distrust the sitemap.
      .map((e) => ({ loc: `${base}/${e.slug}/`, lastmod: e.contentChangedAt ?? e.analyzedAt ?? repoLastmod })),
  ];
  const start = (shard - 1) * SITEMAP_URLS_PER_FILE;
  const urls = all.slice(start, start + SITEMAP_URLS_PER_FILE);
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
