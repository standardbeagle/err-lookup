import type { APIRoute } from "astro";

export const GET: APIRoute = () =>
  new Response(
    `User-agent: *
Allow: /
Sitemap: https://errors.standardbeagle.com/sitemap-index.xml
`,
    { headers: { "content-type": "text/plain; charset=utf-8" } }
  );
