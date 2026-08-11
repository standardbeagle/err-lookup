import type { APIRoute } from "astro";
import { onRequest } from "../../server/api-handler.js";
import type { RuntimeLocals } from "../../data/runtime.js";

// The API previously lived in functions/api/[[path]].ts; the Cloudflare
// adapter's _worker.js supersedes the functions/ directory, so the same
// handler now mounts as an on-demand Astro route. Under `astro dev` there is
// no ASSETS binding — the dev server already serves public/, so a plain fetch
// reads the identical files.
export const prerender = false;

export const ALL: APIRoute = async (ctx) => {
  const locals = ctx.locals as RuntimeLocals;
  const env = locals.runtime?.env?.ASSETS
    ? (locals.runtime.env as { ASSETS: { fetch: (req: Request | string) => Promise<Response> } })
    : { ASSETS: { fetch: (req: Request | string) => fetch(req instanceof Request ? req : new Request(req)) } };
  return onRequest({ request: ctx.request, env });
};
