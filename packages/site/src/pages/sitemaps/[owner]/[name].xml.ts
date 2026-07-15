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
  const base = `https://errlookup.dev/${repo}`;
  const urls = [`${base}/`, ...errors.map((e) => `${base}/${e.slug}/`)];
  const body = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls.map((u) => `  <url><loc>${u}</loc><changefreq>weekly</changefreq></url>`),
    "</urlset>",
  ].join("\n");
  return new Response(body, { headers: { "content-type": "application/xml; charset=utf-8" } });
};
