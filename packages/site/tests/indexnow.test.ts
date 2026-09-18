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
  ledgerLine,
  nextLedger,
  offHostUrls,
  pendingEntries,
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

describe("submission ledger", () => {
  const e = (path: string, lastmod: string | null) => ({ loc: `${SITE}${path}`, lastmod });
  const ledger = (...entries: { loc: string; lastmod: string | null }[]) => new Set(entries.map(ledgerLine));

  it("records the path and the lastmod it was sent with", () => {
    expect(ledgerLine(e("/a/b/c/", "2026-09-18"))).toBe("/a/b/c/\t2026-09-18");
    expect(ledgerLine(e("/a/b/c/", null))).toBe("/a/b/c/\t");
  });

  it("does not resend a same-day URL that already went out", () => {
    // Sitemap lastmod is day-granular: the old date marker resent the whole
    // day's set on every publish that day.
    const sent = ledger(e("/x/y/1/", "2026-09-18"));
    const pending = pendingEntries([e("/x/y/1/", "2026-09-18"), e("/x/y/2/", "2026-09-18")], sent);
    expect(pending.map((p) => p.loc)).toEqual([`${SITE}/x/y/2/`]);
  });

  it("sends a newly admitted repo whose lastmods predate everything already sent", () => {
    // Repos join the sitemap days after export, carrying old lastmods; a date
    // marker skipped them all.
    const sent = ledger(e("/old/repo/1/", "2026-09-18"));
    const pending = pendingEntries([e("/old/repo/1/", "2026-09-18"), e("/new/repo/1/", "2026-09-09")], sent);
    expect(pending.map((p) => p.loc)).toEqual([`${SITE}/new/repo/1/`]);
  });

  it("resends a page whose lastmod moved", () => {
    const sent = ledger(e("/a/b/c/", "2026-09-10"));
    expect(pendingEntries([e("/a/b/c/", "2026-09-18")], sent)).toHaveLength(1);
  });

  it("orders newest first with undated entries last", () => {
    const pending = pendingEntries([e("/u/", null), e("/o/", "2026-09-01"), e("/n/", "2026-09-18")], new Set());
    expect(pending.map((p) => p.lastmod)).toEqual(["2026-09-18", "2026-09-01", null]);
  });

  it("keeps a capped run's remainder pending", () => {
    const all = [e("/1/", "2026-09-18"), e("/2/", "2026-09-17"), e("/3/", "2026-09-16")];
    const after = new Set(nextLedger(all, new Set(), all.slice(0, 1)));
    expect(pendingEntries(all, after).map((p) => p.loc)).toEqual([`${SITE}/2/`, `${SITE}/3/`]);
  });

  it("drops lines for pages no longer advertised or no longer at that lastmod", () => {
    const sent = ledger(e("/gone/", "2026-09-01"), e("/moved/", "2026-09-01"), e("/same/", "2026-09-01"));
    const now = [e("/moved/", "2026-09-18"), e("/same/", "2026-09-01")];
    expect(nextLedger(now, sent, [])).toEqual(["/same/\t2026-09-01"]);
  });
});
