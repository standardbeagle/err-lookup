import type { APIRoute } from "astro";
import { sitemapIndexXml, xmlResponse } from "../data/sitemap.js";

// Conventional sitemap location — the path crawlers probe unprompted.
export const GET: APIRoute = () => xmlResponse(sitemapIndexXml());
