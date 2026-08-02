import type { APIRoute } from "astro";
import { SITE } from "../data/sitemap.js";

export const GET: APIRoute = () =>
  new Response(
    `User-agent: *
Allow: /
Sitemap: ${SITE}/sitemap.xml
`,
    { headers: { "content-type": "text/plain; charset=utf-8" } }
  );
