import { describe, it, expect } from "vitest";
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
