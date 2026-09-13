import type { APIRoute } from "astro";
import {
  allSitemapUrls,
  sitemapShard,
  sitemapShardCount,
  urlsetXml,
  xmlResponse,
} from "../../data/sitemap.js";

// One shard per 50,000 URLs — the protocol's own per-file ceiling. Replaces
// the file-per-repo layout, which produced 1,658 children with a median of 49
// URLs each and cost Googlebot roughly a month of its 35-94 requests a day
// just to read the sitemaps. See data/sitemap.ts for the full reasoning.
export function getStaticPaths() {
  const total = sitemapShardCount(allSitemapUrls().length);
  return Array.from({ length: total }, (_, i) => ({
    params: { shard: String(i + 1) },
    props: { shard: i + 1 },
  }));
}

export const GET: APIRoute = ({ props }) =>
  xmlResponse(urlsetXml(sitemapShard(allSitemapUrls(), props.shard as number)));
