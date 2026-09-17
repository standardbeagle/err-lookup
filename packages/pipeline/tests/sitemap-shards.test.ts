import { describe, it, expect } from "vitest";
import { assignSitemapShards, type ShardLedgerRow } from "../src/exporter/sitemap-shards.js";

const row = (repo: string, firstPublishedAt: string, sitemapShard: number | null = null): ShardLedgerRow => ({
  repo,
  firstPublishedAt,
  sitemapShard,
});
const counts = (m: Record<string, number>) => (repo: string) => m[repo] ?? 1;

describe("assignSitemapShards", () => {
  it("fills shard 1 in admission order, then opens the next when the target would be exceeded", () => {
    const ledger = [row("c/c", "2026-09-02"), row("a/a", "2026-09-01"), row("b/b", "2026-09-01")];
    const got = assignSitemapShards(ledger, new Set(["a/a", "b/b", "c/c"]), counts({ "a/a": 6, "b/b": 3, "c/c": 5 }), 10);
    // a/a and b/b share a timestamp, so the repo name breaks the tie
    expect(Object.fromEntries(got)).toEqual({ "a/a": 1, "b/b": 1, "c/c": 2 });
  });

  // The whole point: Google keeps a per-file view of a sitemap, so a URL that
  // moves to another file loses its association. Rescans grow and shrink
  // repos; none of that may move an assigned repo.
  it("never moves a repo that already has a shard, however its size changed", () => {
    const ledger = [row("a/a", "2026-09-01", 1), row("b/b", "2026-09-01", 1), row("c/c", "2026-09-05")];
    const got = assignSitemapShards(ledger, new Set(["a/a", "b/b", "c/c"]), counts({ "a/a": 40, "b/b": 40, "c/c": 2 }), 10);
    expect(got.has("a/a")).toBe(false);
    expect(got.has("b/b")).toBe(false);
    // the open shard is already over target, so the newcomer opens shard 2
    expect(got.get("c/c")).toBe(2);
  });

  it("appends newcomers to the highest shard while it has room", () => {
    const ledger = [row("a/a", "2026-09-01", 1), row("b/b", "2026-09-02", 2), row("n/new", "2026-09-10")];
    const got = assignSitemapShards(ledger, new Set(["a/a", "b/b", "n/new"]), counts({ "a/a": 9, "b/b": 3, "n/new": 4 }), 10);
    expect(got.get("n/new")).toBe(2);
  });

  it("only assigns admitted repos — a repo still waiting out the publish delay gets no shard yet", () => {
    const ledger = [row("a/a", "2026-09-01"), row("w/waiting", "2026-09-16")];
    const got = assignSitemapShards(ledger, new Set(["a/a"]), counts({}), 10);
    expect([...got.keys()]).toEqual(["a/a"]);
  });

  it("puts a single oversized repo in its own shard rather than splitting it", () => {
    const ledger = [row("s/small", "2026-09-01"), row("h/huge", "2026-09-02"), row("t/tail", "2026-09-03")];
    const got = assignSitemapShards(ledger, new Set(["s/small", "h/huge", "t/tail"]), counts({ "s/small": 2, "h/huge": 25, "t/tail": 2 }), 10);
    expect(Object.fromEntries(got)).toEqual({ "s/small": 1, "h/huge": 2, "t/tail": 3 });
  });

  it("ignores unadmitted repos already holding a shard when measuring the open shard", () => {
    // w/withdrawn keeps its number (so it does not collide if re-admitted) but
    // no longer contributes URLs to shard 1.
    const ledger = [row("w/withdrawn", "2026-09-01", 1), row("n/new", "2026-09-10")];
    const got = assignSitemapShards(ledger, new Set(["n/new"]), counts({ "w/withdrawn": 9, "n/new": 4 }), 10);
    expect(got.get("n/new")).toBe(1);
  });

  it("is deterministic regardless of ledger row order", () => {
    const rows = [row("a/a", "2026-09-01"), row("b/b", "2026-09-01"), row("c/c", "2026-09-02"), row("d/d", "2026-09-02")];
    const admitted = new Set(rows.map((r) => r.repo));
    const sizes = counts({ "a/a": 4, "b/b": 4, "c/c": 4, "d/d": 4 });
    const forward = Object.fromEntries(assignSitemapShards(rows, admitted, sizes, 10));
    const reversed = Object.fromEntries(assignSitemapShards([...rows].reverse(), admitted, sizes, 10));
    expect(reversed).toEqual(forward);
  });
});
