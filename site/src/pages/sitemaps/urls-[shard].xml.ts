import type { APIRoute } from "astro";
import { sitemapShards, urlsetXml, xmlResponse } from "../../data/sitemap.js";

// One file per permanent shard (pipeline exporter/sitemap-shards.ts). Shard
// numbers come from the dataset, so a number with no admitted repos left simply
// has no file — and no entry in the index pointing at one.
export function getStaticPaths() {
  return [...sitemapShards().keys()].map((shard) => ({
    params: { shard: String(shard) },
    props: { shard },
  }));
}

export const GET: APIRoute = ({ props }) => xmlResponse(urlsetXml(sitemapShards().get(props.shard as number) ?? []));
