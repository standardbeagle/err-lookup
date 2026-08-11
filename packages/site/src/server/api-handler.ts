/**
 * Pages Functions API — a thin HTTP shell over the sharded static search index
 * (§5.4) this deploy already serves. Only /api/* invokes the function; static
 * assets stay on the free path.
 *
 * The function never loads index.json: at corpus scale that file's parse alone
 * busts the per-request CPU budget and its object graph approaches the isolate
 * memory cap. Each query fetches one token shard per distinct query token plus
 * meta chunks for the top hits — O(query), not O(dataset).
 *
 *   GET /api/search?q=<message>[&repo=owner/name][&limit=n]
 *   GET /api/errors/<id>
 *   GET /api/repos
 */
import { shardedSearch, lookupById, type ShardJsonFetcher } from "../../../schema/src/search-core";
import { siteErrorUrl } from "../../../mcp/src/base-url";

interface Env {
  ASSETS: { fetch: (req: Request | string) => Promise<Response> };
}

// Isolate-lifetime cache for the small hot files (summary, codes, norms —
// together ~1% of the dataset), keyed on datasetVersion. Token shards and meta
// chunks are per-request: cheap, and caching them all would rebuild the
// monolith this design exists to avoid.
let hotCache: { version: string; files: Map<string, unknown> } | null = null;
const HOT_PATHS = new Set(["search/summary.json", "search/codes.json", "search/norms.json"]);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(body: unknown, status = 200, cacheSeconds = 60): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": `public, max-age=${cacheSeconds}`,
      ...CORS,
    },
  });
}

function fetcherFor(env: Env, base: string, version: string): ShardJsonFetcher {
  if (hotCache?.version !== version) hotCache = { version, files: new Map() };
  const hot = hotCache.files;
  return async <T>(relPath: string): Promise<T | null> => {
    if (HOT_PATHS.has(relPath) && hot.has(relPath)) return hot.get(relPath) as T;
    const res = await env.ASSETS.fetch(new URL(`/data/${relPath}`, base).href);
    if (!res.ok) return null;
    const body = (await res.json()) as T;
    if (HOT_PATHS.has(relPath)) hot.set(relPath, body);
    return body;
  };
}

async function assetJson<T>(env: Env, base: string, path: string): Promise<T | null> {
  const res = await env.ASSETS.fetch(new URL(path, base).href);
  if (!res.ok) return null;
  return (await res.json()) as T;
}

export const onRequest = async (ctx: { request: Request; env: Env }): Promise<Response> => {
  const { request, env } = ctx;
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (request.method !== "GET") return json({ error: "method not allowed" }, 405);

  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, "");

  const manifest = await assetJson<{ datasetVersion: string }>(env, url.origin, "/data/manifest.json");
  if (!manifest) return json({ error: "dataset unavailable" }, 503, 0);
  const fetchJson = fetcherFor(env, url.origin, manifest.datasetVersion);

  if (path === "/api/search") {
    const q = url.searchParams.get("q") ?? url.searchParams.get("message");
    if (!q) return json({ error: "missing q parameter" }, 400, 0);
    const repo = url.searchParams.get("repo") ?? undefined;
    const limit = Math.min(Number.parseInt(url.searchParams.get("limit") ?? "5", 10) || 5, 25);
    const found = await shardedSearch(q, fetchJson, { repo, limit });
    const matches = found.map((h) => ({
      id: h.entry.id,
      repo: h.entry.repo,
      code: h.entry.code,
      message: h.entry.msg,
      score: Math.round(h.score * 1000) / 1000,
      matchType: h.matchType,
      url: siteErrorUrl(h.entry.repo, h.entry.slug),
    }));
    return json({ matches, datasetVersion: manifest.datasetVersion });
  }

  const errMatch = path.match(/^\/api\/errors\/([0-9a-f]{16})$/);
  if (errMatch) {
    const entry = await lookupById(errMatch[1]!, fetchJson);
    if (!entry) return json({ error: "not found" }, 404);
    const [owner, name] = entry.repo.split("/");
    const records = await assetJson<unknown[]>(env, url.origin, `/data/repos/${owner}/${name}.json`);
    const full = records?.find((r) => (r as { id: string }).id === entry.id);
    if (!full) return json({ error: "record missing from repo file" }, 404);
    return json({ error: undefined, record: full, datasetVersion: manifest.datasetVersion }, 200, 3600);
  }

  if (path === "/api/repos") {
    const repos = await assetJson<unknown[]>(env, url.origin, "/data/repos.json");
    return json({ repos: repos ?? [], datasetVersion: manifest.datasetVersion }, 200, 300);
  }

  return json({ error: "unknown endpoint", endpoints: ["/api/search?q=", "/api/errors/:id", "/api/repos"] }, 404);
};
