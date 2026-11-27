import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { groupSitemapShards, type SitemapUrl } from "../src/data/sitemap.js";

const urls = (repo: string, n: number): SitemapUrl[] =>
  Array.from({ length: n }, (_, i) => ({ loc: `https://x/${repo}/${i}/`, lastmod: null }));

describe("groupSitemapShards", () => {
  it("puts each repo's URLs in the shard the dataset assigned, shards in number order", () => {
    const got = groupSitemapShards(
      [
        { repo: "b/b", urls: urls("b/b", 2) },
        { repo: "a/a", urls: urls("a/a", 1) },
      ],
      new Map([["a/a", 2], ["b/b", 1]]),
      10
    );
    expect([...got.keys()]).toEqual([1, 2]);
    expect(got.get(1)!.map((u) => u.loc)).toEqual(["https://x/b/b/0/", "https://x/b/b/1/"]);
    expect(got.get(2)!.map((u) => u.loc)).toEqual(["https://x/a/a/0/"]);
  });

  // A published repo without a shard means the dataset and the site disagree
  // about what is admitted. Silently dropping it would un-advertise live pages;
  // guessing a shard would bring back the file churn.
  it("fails the build when a published repo has no assigned shard", () => {
    expect(() => groupSitemapShards([{ repo: "a/a", urls: urls("a/a", 1) }], new Map(), 10)).toThrow(/a\/a/);
  });

  it("fails the build when a shard passes the protocol ceiling", () => {
    expect(() =>
      groupSitemapShards(
        [
          { repo: "a/a", urls: urls("a/a", 6) },
          { repo: "b/b", urls: urls("b/b", 6) },
        ],
        new Map([["a/a", 1], ["b/b", 1]]),
        10
      )
    ).toThrow(/shard 1/);
  });
});

describe("retired per-repo sitemap route", () => {
  // Shards replaced `/sitemaps/<owner>/<repo>.xml` on 2026-09-16, but crawlers
  // kept fetching the children from their own copy of the old index — ~2,600
  // 404s a day, flat for six days, because a 404 means "maybe later". Pin both
  // halves of the fix: 410 says stop, and `output: "static"` would turn a
  // prerendered route into a 200 file, which is how BingSiteAuth.xml once
  // shipped `200 not configured`.
  const src = readFileSync(
    resolve(import.meta.dirname, "..", "src", "pages", "sitemaps", "[owner]", "[repo].xml.ts"),
    "utf8"
  );

  it("is on demand, so the status code is the one the worker sends", () => {
    expect(src).toMatch(/export const prerender = false/);
  });

  it("answers 410 Gone, not 404", () => {
    expect(src).toMatch(/status:\s*410/);
  });
});
