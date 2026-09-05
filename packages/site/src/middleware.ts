import { defineMiddleware } from "astro:middleware";
import { recordTraffic, type AnalyticsEngineDataset } from "./analytics.js";

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
  runtime?: {
    ctx?: { waitUntil?: (p: Promise<unknown>) => void };
    env?: { TRAFFIC?: AnalyticsEngineDataset };
  };
}

function ttlOf(res: Response): number {
  if (res.status !== 200 || res.headers.has("set-cookie")) return 0;
  const cc = res.headers.get("cache-control") ?? "";
  if (/\bno-(store|cache)\b/.test(cc)) return 0;
  const edge = cc.match(/\bs-maxage=(\d+)/)?.[1] ?? cc.match(/\bmax-age=(\d+)/)?.[1];
  return edge ? Number.parseInt(edge, 10) : 0;
}

export const onRequest = defineMiddleware(async (context, next) => {
  // Prerendering runs this middleware too, with a synthetic request. There is
  // no visitor to log, no edge cache to consult, and reading the headers of
  // that request emits an Astro warning on every page — ~1,500 lines of noise
  // per build, which is how a warning that matters gets missed.
  if (context.isPrerendered) return next();

  // Canonical host: crawlers reached the production mirror via errlookup.pages.dev
  // links and burned duplicate renders there. Exact-host match keeps preview
  // deployments (<hash>.errlookup.pages.dev) reachable; static-excluded paths
  // never enter the worker, so only worker-routed pages redirect — page
  // canonicals cover the rest.
  const url = new URL(context.request.url);
  if (url.hostname === "errlookup.pages.dev") {
    return Response.redirect(`https://errors.standardbeagle.com${url.pathname}${url.search}`, 301);
  }

  const traffic = (context.locals as WaitUntilLocals).runtime?.env?.TRAFFIC;
  const ua = context.request.headers.get("user-agent");

  // Robust-logging contract: whatever escapes this middleware still gets an
  // AE row and a console.error (platform observability persists console +
  // the exception itself), THEN rethrows so the platform serves its 500. The
  // retired-slug 500s hid for a month precisely because the traffic write sat
  // below the crash — the failure path must log FIRST and fail second.
  try {
    const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default;
    if (!cache || context.request.method !== "GET") {
      const res = await next();
      recordTraffic(traffic, url, ua, res.status, "-");
      return res;
    }

    const key = context.request.url;
    const hit = await cache.match(key);
    if (hit) {
      const res = new Response(hit.body, hit);
      res.headers.set("x-errlookup-cache", "hit");
      recordTraffic(traffic, url, ua, res.status, "hit");
      return res;
    }

    const res = await next();
    // The edge cache is an optimization: a broken clone/put must never turn a
    // good response into a 500. Log and serve.
    try {
      if (ttlOf(res) > 0) {
        const put = cache.put(key, res.clone());
        const waitUntil = (context.locals as WaitUntilLocals).runtime?.ctx?.waitUntil;
        if (waitUntil) waitUntil(put);
        else await put;
      }
    } catch (e) {
      console.error("edge-cache put failed:", url.pathname, e);
    }
    // A route may return Response.redirect(), whose headers are IMMUTABLE in
    // workerd — rewrap to a mutable response before touching headers (the
    // 2026-09-03 retired-slug incident; Astro's own pipeline has the same
    // constraint, so routes must also use Astro.redirect()).
    const out = new Response(res.body, res);
    out.headers.set("x-errlookup-cache", "miss");
    recordTraffic(traffic, url, ua, out.status, "miss");
    return out;
  } catch (e) {
    recordTraffic(traffic, url, ua, 500, "-");
    console.error("middleware failure:", url.pathname, e);
    throw e;
  }
});
