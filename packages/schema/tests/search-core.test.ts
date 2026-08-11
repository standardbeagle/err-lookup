import { describe, it, expect } from "vitest";
import {
  buildSearchIndex,
  shardedSearch,
  lookupById,
  tokenShard,
  TOKEN_SHARDS,
  type IndexError,
  type ShardJsonFetcher,
} from "../src/search-core.js";

function entry(overrides: Partial<IndexError> & { id: string; msg: string }): IndexError {
  return {
    repo: "axios/axios",
    slug: overrides.id,
    code: null,
    pattern: overrides.msg,
    type: "exception",
    cls: null,
    tags: [],
    sev: "error",
    ...overrides,
  };
}

const ENTRIES: IndexError[] = [
  entry({ id: "aa00000000000001", msg: "Request failed with status code", code: "ERR_BAD_RESPONSE" }),
  entry({ id: "bb00000000000002", msg: "timeout of {n} ms exceeded", code: "ECONNABORTED" }),
  entry({ id: "cc00000000000003", msg: "connect ECONNREFUSED at address", repo: "nodejs/node" }),
  entry({ id: "dd00000000000004", msg: "self signed certificate in certificate chain" }),
  entry({ id: "ee00000000000005", msg: "unexpected token in JSON at position" }),
];

/** Serve the built files back like the CDN would. */
function fetcherOver(files: { relPath: string; content: string }[]): ShardJsonFetcher & { fetches: string[] } {
  const byPath = new Map(files.map((f) => [f.relPath, f.content]));
  const fn = (async (relPath: string) => {
    fn.fetches.push(relPath);
    const c = byPath.get(relPath);
    return c === undefined ? null : JSON.parse(c);
  }) as ShardJsonFetcher & { fetches: string[] };
  fn.fetches = [];
  return fn;
}

describe("sharded search index", () => {
  it("round-trips: exact code tier", async () => {
    const fetchJson = fetcherOver(buildSearchIndex(ENTRIES));
    const hits = await shardedSearch("got ERR_BAD_RESPONSE from server", fetchJson);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.entry.id).toBe("aa00000000000001");
    expect(hits[0]!.matchType).toBe("exact-code");
    expect(hits[0]!.score).toBe(1);
  });

  it("round-trips: fuzzy tier ranks the right message first", async () => {
    const fetchJson = fetcherOver(buildSearchIndex(ENTRIES));
    const hits = await shardedSearch("self signed certificate in chain", fetchJson);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.entry.id).toBe("dd00000000000004");
    expect(hits[0]!.matchType).toBe("fuzzy");
    expect(hits[0]!.score).toBeGreaterThan(0.4);
  });

  it("repo filter restricts hits", async () => {
    const fetchJson = fetcherOver(buildSearchIndex(ENTRIES));
    const hits = await shardedSearch("connect ECONNREFUSED at address", fetchJson, { repo: "axios/axios" });
    expect(hits.every((h) => h.entry.repo === "axios/axios")).toBe(true);
    expect(hits.some((h) => h.entry.id === "cc00000000000003")).toBe(false);
  });

  it("query cost is O(query): only summary, hot files, query shards and hit chunks", async () => {
    const fetchJson = fetcherOver(buildSearchIndex(ENTRIES));
    await shardedSearch("timeout exceeded", fetchJson);
    // No fetch of every token shard — just the ones the query tokens hash to.
    const tokenFetches = fetchJson.fetches.filter((p) => p.startsWith("search/tokens/"));
    expect(tokenFetches.length).toBeLessThanOrEqual(2);
  });

  it("lookupById resolves through the id shards", async () => {
    const fetchJson = fetcherOver(buildSearchIndex(ENTRIES));
    const e = await lookupById("cc00000000000003", fetchJson);
    expect(e?.repo).toBe("nodejs/node");
    expect(await lookupById("0123456789abcdef", fetchJson)).toBeNull();
  });

  it("misses return empty, not errors", async () => {
    const fetchJson = fetcherOver(buildSearchIndex(ENTRIES));
    expect(await shardedSearch("völlig unrelated Zeichenkette", fetchJson)).toEqual([]);
    expect(await shardedSearch("", fetchJson)).toEqual([]);
  });

  it("empty dataset builds a servable index", async () => {
    const fetchJson = fetcherOver(buildSearchIndex([]));
    expect(await shardedSearch("anything", fetchJson)).toEqual([]);
  });

  it("token shards spread and stay in range", () => {
    const shards = new Set(["error", "timeout", "certificate", "connect", "token", "request"].map(tokenShard));
    expect([...shards].every((s) => s >= 0 && s < TOKEN_SHARDS)).toBe(true);
    expect(shards.size).toBeGreaterThan(1);
  });
});
