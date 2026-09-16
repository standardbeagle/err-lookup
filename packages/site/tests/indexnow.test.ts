import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  INDEXNOW_KEY,
  INDEXNOW_MAX_URLS_PER_REQUEST,
  batchUrls,
  buildPayload,
  describeStatus,
  keyLocation,
  offHostUrls,
} from "../src/data/indexnow.js";

const SITE = "https://errors.standardbeagle.com";

describe("IndexNow key file", () => {
  // The whole protocol rests on this pairing: IndexNow fetches /<key>.txt and
  // compares it to the key in the payload. A rename on one side and not the
  // other fails every submission with 403 and nothing else would catch it.
  it("is served from public/ under the key's own name and contains the key", () => {
    const path = resolve(import.meta.dirname, "..", "public", `${INDEXNOW_KEY}.txt`);
    expect(readFileSync(path, "utf8").trim()).toBe(INDEXNOW_KEY);
  });

  it("points keyLocation at the site root regardless of a trailing slash", () => {
    expect(keyLocation(SITE)).toBe(`${SITE}/${INDEXNOW_KEY}.txt`);
    expect(keyLocation(`${SITE}/`)).toBe(`${SITE}/${INDEXNOW_KEY}.txt`);
  });
});

describe("batchUrls", () => {
  it("splits at the protocol ceiling", () => {
    const urls = Array.from({ length: 25_000 }, (_, i) => `${SITE}/a/b/${i}/`);
    const batches = batchUrls(urls);
    expect(batches.map((b) => b.length)).toEqual([10_000, 10_000, 5_000]);
    expect(batches.flat()).toHaveLength(urls.length);
  });

  it("yields no batches for an empty list, so a no-change run sends nothing", () => {
    // An empty urlList is a 422, which would read as a publish failure on every
    // run that changed nothing.
    expect(batchUrls([])).toEqual([]);
  });

  it("honours a smaller batch size", () => {
    expect(batchUrls(["a", "b", "c"], 2)).toEqual([["a", "b"], ["c"]]);
  });
});

describe("buildPayload", () => {
  it("carries the bare hostname, the key, and its location", () => {
    const p = buildPayload(SITE, [`${SITE}/docker/cli/x/`]);
    expect(p).toEqual({
      host: "errors.standardbeagle.com",
      key: INDEXNOW_KEY,
      keyLocation: `${SITE}/${INDEXNOW_KEY}.txt`,
      urlList: [`${SITE}/docker/cli/x/`],
    });
  });

  it("copies the list so a later mutation cannot alter a sent payload", () => {
    const urls = [`${SITE}/a/b/c/`];
    const p = buildPayload(SITE, urls);
    urls.push(`${SITE}/d/e/f/`);
    expect(p.urlList).toHaveLength(1);
  });
});

describe("offHostUrls", () => {
  it("catches the off-host and malformed URLs that would 422 a whole batch", () => {
    const bad = offHostUrls(SITE, [
      `${SITE}/ok/page/x/`,
      "https://errlookup.pages.dev/mirror/page/x/",
      "https://example.com/",
      "not-a-url",
    ]);
    expect(bad).toEqual([
      "https://errlookup.pages.dev/mirror/page/x/",
      "https://example.com/",
      "not-a-url",
    ]);
  });

  it("passes a clean list", () => {
    expect(offHostUrls(SITE, [`${SITE}/a/b/c/`, `${SITE}/d/e/f/`])).toEqual([]);
  });
});

describe("describeStatus", () => {
  it("treats 202 as success — it is the normal answer to a freshly published key", () => {
    expect(describeStatus(200).ok).toBe(true);
    expect(describeStatus(202).ok).toBe(true);
  });

  it("reports the failures that need different fixes", () => {
    expect(describeStatus(403).ok).toBe(false);
    expect(describeStatus(403).meaning).toContain(INDEXNOW_KEY);
    expect(describeStatus(422).ok).toBe(false);
    expect(describeStatus(429).meaning).toContain("rate limited");
    expect(describeStatus(500).ok).toBe(false);
  });
});

describe("protocol constants", () => {
  it("pins the per-request ceiling the docs specify", () => {
    expect(INDEXNOW_MAX_URLS_PER_REQUEST).toBe(10_000);
  });
});
