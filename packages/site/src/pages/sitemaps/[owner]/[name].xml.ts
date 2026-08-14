import type { APIRoute } from "astro";
import { getRepos, getRepoErrors } from "../../../data/load.js";

// Per-repo sitemap: /sitemaps/{owner}/{name}.xml (§6.2).
export function getStaticPaths() {
  return getRepos().map((r) => {
    const [owner, name] = r.repo.split("/");
    return { params: { owner, name }, props: { repo: r.repo } };
  });
}

export const GET: APIRoute = ({ props }) => {
  const repo = props.repo as string;
  const errors = getRepoErrors(repo);
  const repoLastmod = getRepos().find((r) => r.repo === repo)?.analyzedAt;
  const base = `https://errors.standardbeagle.com/${repo}`;
  // Real lastmod instead of changefreq=weekly: pages only change when their
  // repo is re-analyzed, and the blanket weekly hint had crawlers re-fetching
  // the whole long tail on a schedule — 74% of worker invocations were Google.
  const urls = [
    { loc: `${base}/`, lastmod: repoLastmod },
    ...errors.map((e) => ({ loc: `${base}/${e.slug}/`, lastmod: e.analyzedAt ?? repoLastmod })),
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
