import type { APIRoute } from "astro";
import { getRepos } from "../data/load.js";

// Sitemap index → one sitemap per repo (§6.2). Keeps each sitemap small.
export const GET: APIRoute = () => {
  const repos = getRepos();
  const parts: string[] = ['<?xml version="1.0" encoding="UTF-8"?>', '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'];
  for (const r of repos) {
    const [owner, name] = r.repo.split("/");
    parts.push(`  <sitemap><loc>https://errlookup.dev/sitemaps/${owner}/${name}.xml</loc></sitemap>`);
  }
  parts.push("</sitemapindex>");
  return new Response(parts.join("\n"), {
    headers: { "content-type": "application/xml; charset=utf-8" },
  });
};
