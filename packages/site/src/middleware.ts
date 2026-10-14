import { defineMiddleware } from "astro:middleware";
import { recordTraffic, type AnalyticsEngineDataset } from "./analytics.js";
import { withGoogleNoindex } from "./server/google-noindex.js";

/**
 * Request middleware for on-demand routes (error pages, /api/*): canonical-host
 * redirect, the Google-only noindex, and one Analytics Engine row per request.
 *
 * Edge caching lives in the standardbeagle.com zone, not here: since 2026-10-13
 * a zone Cache Rule holds every GET for 7 days and scripts/deploy-site.sh
 * purges the host on deploy. The Cache API read-through that used to sit here
 * served 2 hits in 2,570 worker requests once the zone cache fronted it — a
 * lookup and a put on every miss for nothing — so it was removed.
 */

interface RuntimeLocals {
  runtime?: {
    env?: { TRAFFIC?: AnalyticsEngineDataset };
  };
}

export const onRequest = defineMiddleware(async (context, next) => {
  // Prerendering runs this middleware too, with a synthetic request. There is
  // no visitor to log, and reading the headers of that request emits an Astro
  // warning on every page — ~1,500 lines of noise per build, which is how a
  // warning that matters gets missed.
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

  const traffic = (context.locals as RuntimeLocals).runtime?.env?.TRAFFIC;
  const ua = context.request.headers.get("user-agent");

  // Robust-logging contract: whatever escapes this middleware still gets an
  // AE row and a console.error (platform observability persists console +
  // the exception itself), THEN rethrows so the platform serves its 500. The
  // retired-slug 500s hid for a month precisely because the traffic write sat
  // below the crash — the failure path must log FIRST and fail second.
  try {
    // withGoogleNoindex rewraps HTML before setting its header, so route
    // responses with immutable headers (Response.redirect) stay safe here.
    const res = withGoogleNoindex(await next());
    recordTraffic(traffic, url, ua, res.status);
    return res;
  } catch (e) {
    recordTraffic(traffic, url, ua, 500);
    console.error("middleware failure:", url.pathname, e);
    throw e;
  }
});
