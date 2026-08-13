import { defineMiddleware } from "astro:middleware";

/**
 * Read-through edge cache for on-demand routes (error pages, /api/*). No zone
 * fronts this site (the custom domain CNAMEs straight to errlookup.pages.dev),
 * so zone Cache Rules can't exist — the Cache API is the only edge cache
 * available. A hit returns before any render/search CPU is spent; the
 * invocation itself is billed either way, but CPU-ms is the metered resource
 * that was blowing the free-tier cap.
 *
 * TTL comes from each response's own Cache-Control (s-maxage, else max-age) —
 * the routes already declare their staleness policy against the hourly
 * publish. Only 200s without Set-Cookie are stored. Under `astro dev` and the
 * prerender build there is no `caches` global, so this is a pass-through.
 */

interface WaitUntilLocals {
  runtime?: { ctx?: { waitUntil?: (p: Promise<unknown>) => void } };
}

function ttlOf(res: Response): number {
  if (res.status !== 200 || res.headers.has("set-cookie")) return 0;
  const cc = res.headers.get("cache-control") ?? "";
  if (/\bno-(store|cache)\b/.test(cc)) return 0;
  const edge = cc.match(/\bs-maxage=(\d+)/)?.[1] ?? cc.match(/\bmax-age=(\d+)/)?.[1];
  return edge ? Number.parseInt(edge, 10) : 0;
}

export const onRequest = defineMiddleware(async (context, next) => {
  const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default;
  if (!cache || context.request.method !== "GET") return next();

  const key = context.request.url;
  const hit = await cache.match(key);
  if (hit) {
    const res = new Response(hit.body, hit);
    res.headers.set("x-errlookup-cache", "hit");
    return res;
  }

  const res = await next();
  if (ttlOf(res) > 0) {
    const put = cache.put(key, res.clone());
    const waitUntil = (context.locals as WaitUntilLocals).runtime?.ctx?.waitUntil;
    if (waitUntil) waitUntil(put);
    else await put;
  }
  res.headers.set("x-errlookup-cache", "miss");
  return res;
});
