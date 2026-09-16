import type { APIRoute } from "astro";
import { BING_SITE_AUTH_TOKEN, bingSiteAuthXml } from "../data/webmaster.js";
import { xmlResponse } from "../data/sitemap.js";

// 404 until a token is configured. Serving an empty <user></user> would let
// Bing's check fail with "verified" plumbing in place, which is a worse state
// to debug than a plain missing file.
export const GET: APIRoute = () =>
  BING_SITE_AUTH_TOKEN
    ? xmlResponse(bingSiteAuthXml(BING_SITE_AUTH_TOKEN))
    : new Response("not configured", { status: 404 });
