import type { APIRoute } from "astro";
import { BING_SITE_AUTH_TOKEN, bingSiteAuthXml } from "../data/webmaster.js";
import { xmlResponse } from "../data/sitemap.js";

// On demand, because this route's whole contract is its status code. Under the
// site's `output: "static"` a prerendered route becomes a file served with 200,
// so the unconfigured case shipped as `200 not configured` — which Bing would
// read as a verification file whose token does not match. Worker-routed, the
// 404 is real.
export const prerender = false;

// 404 until a token is configured. Serving an empty <user></user> would let
// Bing's check fail with "verified" plumbing in place, which is a worse state
// to debug than a plain missing file.
export const GET: APIRoute = () =>
  BING_SITE_AUTH_TOKEN
    ? xmlResponse(bingSiteAuthXml(BING_SITE_AUTH_TOKEN))
    : new Response("not configured", { status: 404 });
