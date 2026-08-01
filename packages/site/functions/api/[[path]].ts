/**
 * Pages Functions API — a thin HTTP shell over the same tiered search the MCP
 * server uses (§7.3) and the same static dataset this deploy already serves.
 * Only /api/* invokes the function; static assets stay on the free path.
 *
 *   GET /api/search?q=<message>[&repo=owner/name][&limit=n]
 *   GET /api/errors/<id>
 *   GET /api/repos
 */
import { searchErrors } from "../../../mcp/src/search";
import type { IndexError } from "../../../mcp/src/cache";

interface Env {
  ASSETS: { fetch: (req: Request | string) => Promise<Response> };
}

interface IndexFile {
  datasetVersion: string;
  errors: IndexError[];
}

// Isolate-lifetime cache: reloaded only when the manifest's datasetVersion moves.
let cache: { version: string; index: IndexFile; byId: Map<string, IndexError> } | null = null;

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

async function assetJson<T>(env: Env, base: string, path: string): Promise<T | null> {
  const res = await env.ASSETS.fetch(new URL(path, base).href);
  if (!res.ok) return null;
  return (await res.json()) as T;
}

async function loadIndex(env: Env, base: string): Promise<typeof cache> {
  const manifest = await assetJson<{ datasetVersion: string }>(env, base, "/data/manifest.json");
  if (!manifest) return null;
  if (cache?.version === manifest.datasetVersion) return cache;
  const index = await assetJson<IndexFile>(env, base, "/data/index.json");
  if (!index) return null;
  cache = {
    version: manifest.datasetVersion,
    index,
    byId: new Map(index.errors.map((e) => [e.id, e])),
  };
  return cache;
}

export const onRequest = async (ctx: { request: Request; env: Env }): Promise<Response> => {
  const { request, env } = ctx;
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (request.method !== "GET") return json({ error: "method not allowed" }, 405);

  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, "");

  const loaded = await loadIndex(env, url.origin);
  if (!loaded) return json({ error: "dataset unavailable" }, 503, 0);

  if (path === "/api/search") {
    const q = url.searchParams.get("q") ?? url.searchParams.get("message");
    if (!q) return json({ error: "missing q parameter" }, 400, 0);
    const repo = url.searchParams.get("repo") ?? undefined;
    const limit = Math.min(Number.parseInt(url.searchParams.get("limit") ?? "5", 10) || 5, 25);
    const matches = searchErrors(q, loaded.index.errors, { repo, limit });
    return json({ matches, datasetVersion: loaded.version });
  }

  const errMatch = path.match(/^\/api\/errors\/([0-9a-f]{16})$/);
  if (errMatch) {
    const entry = loaded.byId.get(errMatch[1]!);
    if (!entry) return json({ error: "not found" }, 404);
    const [owner, name] = entry.repo.split("/");
    const records = await assetJson<unknown[]>(env, url.origin, `/data/repos/${owner}/${name}.json`);
    const full = records?.find((r) => (r as { id: string }).id === entry.id);
    if (!full) return json({ error: "record missing from repo file" }, 404);
    return json({ error: undefined, record: full, datasetVersion: loaded.version }, 200, 3600);
  }

  if (path === "/api/repos") {
    const repos = await assetJson<unknown[]>(env, url.origin, "/data/repos.json");
    return json({ repos: repos ?? [], datasetVersion: loaded.version }, 200, 300);
  }

  return json({ error: "unknown endpoint", endpoints: ["/api/search?q=", "/api/errors/:id", "/api/repos"] }, 404);
};
