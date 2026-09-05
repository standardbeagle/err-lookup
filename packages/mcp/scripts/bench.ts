/**
 * Latency and byte budget for the MCP tools against a real dataset.
 *
 * Usage:
 *   pnpm --filter @standardbeagle/errlookup-mcp exec tsx scripts/bench.ts [baseUrl]
 *
 * Reports the two numbers that matter to a client: what one cold answer costs
 * over the network, and what a warm answer costs once the cache is populated.
 * The cache directory is a fresh temp dir per run, so "cold" means cold.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CacheStore, defaultCacheConfig } from "../src/cache.js";
import { toolSearchError, type ToolContext } from "../src/tools.js";

const QUERIES = [
  "Request failed with status code 503",
  "maximum call stack size exceeded",
  "ECONNREFUSED connect to 127.0.0.1:5432",
  "invalid hook call hooks can only be called inside the body of a function component",
  "cannot read properties of undefined reading map",
];

let bytes = 0;
let requests = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (...args: Parameters<typeof realFetch>) => {
  const res = await realFetch(...args);
  requests++;
  const buf = await res.arrayBuffer();
  bytes += buf.byteLength;
  return new Response(buf, { status: res.status, headers: res.headers });
}) as typeof realFetch;

function ctxFor(cacheDir: string, baseUrl: string): ToolContext {
  const cfg = { ...defaultCacheConfig(), baseUrl, cacheDir, ttlSeconds: 300, offline: false };
  return { store: new CacheStore(cfg), lastSyncAt: 0, ttlSeconds: cfg.ttlSeconds };
}

const baseUrl = process.argv[2] ?? "https://errors.standardbeagle.com";
const cacheDir = mkdtempSync(join(tmpdir(), "errlookup-bench-"));
const ctx = ctxFor(cacheDir, baseUrl);

try {
  const t0 = performance.now();
  const first = await toolSearchError(ctx, { message: QUERIES[0]!, limit: 5 });
  const coldMs = performance.now() - t0;
  const coldBytes = bytes;
  const coldRequests = requests;

  const warm: number[] = [];
  for (const q of QUERIES) {
    const t = performance.now();
    await toolSearchError(ctx, { message: q, limit: 5 });
    warm.push(performance.now() - t);
  }
  warm.sort((a, b) => a - b);

  // Same query again: no shard is new, so this is the pure in-process path.
  const bytesBeforeRepeat = bytes;
  const repeats: number[] = [];
  for (let i = 0; i < 5; i++) {
    const t = performance.now();
    await toolSearchError(ctx, { message: QUERIES[0]!, limit: 5 });
    repeats.push(performance.now() - t);
  }
  repeats.sort((a, b) => a - b);
  console.log(JSON.stringify({
    baseUrl,
    coldAnswer: {
      ms: Math.round(coldMs),
      networkBytes: coldBytes,
      networkRequests: coldRequests,
      matches: first.matches.length,
    },
    warmAnswers: {
      count: warm.length,
      medianMs: Math.round(warm[Math.floor(warm.length / 2)]!),
      maxMs: Math.round(warm.at(-1)!),
      networkBytesAfterCold: bytes - coldBytes,
      networkRequestsAfterCold: requests - coldRequests,
    },
    repeatedQuery: {
      medianMs: Math.round(repeats[Math.floor(repeats.length / 2)]! * 1000) / 1000,
      maxMs: Math.round(repeats.at(-1)! * 1000) / 1000,
      networkBytes: bytes - bytesBeforeRepeat,
    },
  }, null, 2));
} finally {
  rmSync(cacheDir, { recursive: true, force: true });
}
