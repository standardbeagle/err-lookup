import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { withGoogleNoindex, GOOGLE_NOINDEX } from "../src/server/google-noindex.js";

const dist = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist");

describe("google-only noindex (docs/search-engine-setup.md: the 2026-08-18 freeze)", () => {
  it("the value pins the per-bot prefix: dropping it would noindex Bing too", () => {
    expect(GOOGLE_NOINDEX).toBe("googlebot: noindex, follow");
  });

  it("worker HTML responses carry the header; other content types pass through untouched", () => {
    const html = withGoogleNoindex(
      new Response("<html></html>", { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }),
    );
    expect(html.headers.get("x-robots-tag")).toBe(GOOGLE_NOINDEX);

    const xml = new Response("<urlset/>", { headers: { "content-type": "application/xml" } });
    expect(withGoogleNoindex(xml)).toBe(xml);

    const json = new Response("{}", { headers: { "content-type": "application/json" } });
    expect(withGoogleNoindex(json)).toBe(json);
  });

  it("prerendered pages carry the matching meta — they never enter the worker", () => {
    for (const page of ["index.html", "about/index.html", "guides/index.html", "404.html"]) {
      const html = readFileSync(resolve(dist, page), "utf8");
      expect(html, page).toContain('<meta name="googlebot" content="noindex, follow">');
    }
  });
});
