import type { APIRoute } from "astro";
import { sitemapIndexXml, xmlResponse } from "../data/sitemap.js";

// Descriptive alias for /sitemap.xml. Already published in robots.txt and
// submitted to search consoles, so it must keep resolving to the same document.
export const GET: APIRoute = () => xmlResponse(sitemapIndexXml());
