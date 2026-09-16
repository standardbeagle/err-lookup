import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { bingSiteAuthXml } from "../src/data/webmaster.js";

describe("bingSiteAuthXml", () => {
  it("renders the document shape Bing's XML-file check expects", () => {
    expect(bingSiteAuthXml("ABC123")).toBe(
      '<?xml version="1.0"?>\n<users>\n  <user>ABC123</user>\n</users>\n'
    );
  });

  // Bing hands out an uppercase hex string; it is echoed verbatim rather than
  // normalised, because the check is an exact string comparison on their side.
  it("echoes the token verbatim", () => {
    expect(bingSiteAuthXml("0a1B2c3D")).toContain("<user>0a1B2c3D</user>");
  });
});

describe("BingSiteAuth route", () => {
  // The route's contract IS its status code, and `output: "static"` turns a
  // prerendered route into a file served with 200 — which shipped once, as
  // `200 not configured`. Bing would read that as a verification file whose
  // token does not match. Pin the opt-out.
  it("is on demand, so the unconfigured 404 is a real 404", async () => {
    const src = readFileSync(
      resolve(import.meta.dirname, "..", "src", "pages", "BingSiteAuth.xml.ts"),
      "utf8"
    );
    expect(src).toMatch(/export const prerender = false/);
  });
});
