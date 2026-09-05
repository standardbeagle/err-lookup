import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { ServerResponse, IncomingMessage } from "node:http";
import { CacheStore, versionDirName, type Manifest } from "../src/cache.js";
import { syncDataset } from "../src/sync.js";
import {
  toolSearchError,
  toolGetError,
  toolListRepos,
  toolRefreshDataset,
  type ToolContext,
} from "../src/tools.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const siteRoot = resolve(__dirname, "..", "..", "site");
const sitePublicData = resolve(siteRoot, "public", "data");
if (!existsSync(resolve(sitePublicData, "manifest.json"))) {
  execFileSync("pnpm", ["exec", "tsx", "scripts/seed-dataset.ts"], { cwd: siteRoot, stdio: "pipe" });
}

/** Requests the fake origin has served, for asserting network behaviour. */
let served: string[] = [];
/** Set to override the manifest body the origin returns. */
let manifestOverride: string | null = null;
/** Paths the origin should fail, to exercise partial-download recovery. */
let failPaths = new Set<string>();

let http: Server;
let baseUrl: string;
let tmpCache: string;

function etagOf(buf: Buffer | string): string {
  return `"${createHash("sha1").update(buf).digest("hex")}"`;
}

function startStaticServer(root: string): Promise<{ server: Server; port: number }> {
  return new Promise((res) => {
    const server = createServer((req: IncomingMessage, res2: ServerResponse) => {
      const raw = req.url ?? "";
      const url = raw.split("?")[0]!;
      served.push(raw);
      let rel = url;
      if (rel.startsWith("/data/")) rel = "/" + rel.slice("/data/".length);
      if (failPaths.has(rel)) {
        res2.writeHead(500);
        res2.end("boom");
        return;
      }
      try {
        const body: Buffer =
          rel === "/manifest.json" && manifestOverride !== null
            ? Buffer.from(manifestOverride)
            : readFileSync(join(root, rel));
        const tag = etagOf(body);
        if (req.headers["if-none-match"] === tag) {
          res2.writeHead(304, { etag: tag });
          res2.end();
          return;
        }
        res2.writeHead(200, { "content-type": "application/json", etag: tag });
        res2.end(body);
      } catch {
        res2.writeHead(404);
        res2.end("not found");
      }
    });
    server.listen(0, "127.0.0.1", () => {
      res({ server, port: (server.address() as { port: number }).port });
    });
  });
}

function makeCtx(
  overrides: Partial<{ baseUrl: string; cacheDir: string; offline: boolean; ttlSeconds: number }> = {}
): ToolContext {
  const ttlSeconds = overrides.ttlSeconds ?? 0;
  return {
    store: new CacheStore({
      baseUrl: overrides.baseUrl ?? baseUrl,
      cacheDir: overrides.cacheDir ?? mkdtempSync(join(tmpdir(), "mcp-cache-")),
      ttlSeconds,
      offline: overrides.offline ?? false,
    }),
    ttlSeconds,
  };
}

function readManifestFixture(): Manifest {
  return JSON.parse(readFileSync(join(sitePublicData, "manifest.json"), "utf8")) as Manifest;
}

beforeAll(async () => {
  const s = await startStaticServer(sitePublicData);
  http = s.server;
  baseUrl = `http://127.0.0.1:${s.port}`;
  tmpCache = mkdtempSync(join(tmpdir(), "mcp-shared-"));
}, 15000);

afterAll(async () => {
  await new Promise<void>((r) => http.close(() => r()));
  rmSync(tmpCache, { recursive: true, force: true });
});

describe("sync", () => {
  it("installs a version and makes it live", async () => {
    const ctx = makeCtx({ cacheDir: tmpCache });
    const r = await syncDataset(ctx.store, false);
    expect(r.updated).toBe(true);
    expect(r.datasetVersion).toBeTruthy();
    expect(r.errorCount).toBeGreaterThan(0);
    const pointer = ctx.store.readPointer()!;
    expect(pointer.datasetVersion).toBe(r.datasetVersion);
    expect(existsSync(ctx.store.filePath(pointer.datasetVersion, "manifest.json"))).toBe(true);
  });

  it("re-sync is a no-op when the dataset version is unchanged", async () => {
    const ctx = makeCtx();
    await syncDataset(ctx.store, false);
    const r2 = await syncDataset(ctx.store, false);
    expect(r2.updated).toBe(false);
    expect(r2.stale).toBe(false);
  });

  it("revalidates with If-None-Match and accepts a 304", async () => {
    const ctx = makeCtx();
    await syncDataset(ctx.store, false);
    served = [];
    const r = await syncDataset(ctx.store, true);
    expect(served.map((u) => u.split("?")[0])).toContain("/data/manifest.json");
    expect(r.updated).toBe(false);
    expect(r.stale).toBe(false);
  });

  it("does not touch the network inside the poll interval", async () => {
    const ctx = makeCtx({ ttlSeconds: 600 });
    await syncDataset(ctx.store, false);
    served = [];
    const r = await syncDataset(ctx.store, false);
    expect(served).toEqual([]);
    expect(r.datasetVersion).toBeTruthy();
  });

  it("a failed payload download does not wedge the cache at the new version", async () => {
    // Regression: the old flat cache wrote the new manifest before the payload.
    // When the payload failed, the manifest on disk already claimed the new
    // version, so every later sync compared equal and the data never updated.
    const ctx = makeCtx();
    await syncDataset(ctx.store, false);
    const first = ctx.store.readPointer()!.datasetVersion;

    const bumped = { ...readManifestFixture(), datasetVersion: "2099-01-01T00:00:00.000Z" };
    manifestOverride = JSON.stringify(bumped);
    failPaths = new Set(["/search/summary.json", "/search/norms.json"]);
    try {
      const r = await syncDataset(ctx.store, true);
      expect(r.updated).toBe(true);
      expect(r.datasetVersion).toBe("2099-01-01T00:00:00.000Z");
      // Shards are unavailable, so the search fails — but the failure is
      // transient, not a cache that can never move forward again.
      failPaths = new Set();
      const search = await toolSearchError(ctx, { message: "Request failed with status code 503" });
      expect(search.datasetVersion).toBe("2099-01-01T00:00:00.000Z");
      expect(search.matches.length).toBeGreaterThan(0);
    } finally {
      manifestOverride = null;
      failPaths = new Set();
    }
    expect(first).not.toBe("2099-01-01T00:00:00.000Z");
  });

  it("keeps the previous version directory and prunes older ones", async () => {
    const ctx = makeCtx();
    await syncDataset(ctx.store, false);
    const v1 = ctx.store.readPointer()!.datasetVersion;

    for (const v of ["2099-02-01T00:00:00.000Z", "2099-03-01T00:00:00.000Z"]) {
      manifestOverride = JSON.stringify({ ...readManifestFixture(), datasetVersion: v });
      await syncDataset(ctx.store, true);
    }
    manifestOverride = null;

    const dirs = readdirSync(join(ctx.store.dir, "v"));
    expect(dirs).toContain(versionDirName("2099-03-01T00:00:00.000Z"));
    expect(dirs).toContain(versionDirName("2099-02-01T00:00:00.000Z"));
    expect(dirs).not.toContain(versionDirName(v1));
  });

  it("offline never fetches and reports stale", async () => {
    const warm = makeCtx();
    await syncDataset(warm.store, false);
    served = [];
    const offline = makeCtx({ cacheDir: warm.store.dir, offline: true });
    const r = await syncDataset(offline.store, true);
    expect(served).toEqual([]);
    expect(r.stale).toBe(true);
    expect(r.datasetVersion).toBe(warm.store.readPointer()!.datasetVersion);
  });

  it("a manifest whose sha does not match is rejected for files the manifest covers", async () => {
    const ctx = makeCtx();
    await syncDataset(ctx.store, false);
    const version = ctx.store.readPointer()!.datasetVersion;
    const bad = await ctx.store.fetchJson(version, "search/summary.json", { sha256: "0".repeat(64) });
    expect(bad).toBeNull();
  });
});

describe("tools", () => {
  it("search tier 1 — exact code", async () => {
    const ctx = makeCtx();
    const r = await toolSearchError(ctx, { message: "Got an ERR_BAD_RESPONSE from the server" });
    expect(r.matches.length).toBeGreaterThan(0);
    expect(r.matches[0]!.matchType).toBe("exact-code");
    expect(r.matches[0]!.code).toBe("ERR_BAD_RESPONSE");
    expect(r.matches[0]!.score).toBe(1);
  });

  it("search tier 2 — token scoring finds the message", async () => {
    const ctx = makeCtx();
    const r = await toolSearchError(ctx, { message: "Request failed with status code 503 please help" });
    expect(r.matches.length).toBeGreaterThan(0);
    expect(r.matches.some((m) => /request failed with status code/i.test(m.message))).toBe(true);
  });

  it("search tier 3 — fuzzy lands on the timeout record", async () => {
    const ctx = makeCtx();
    const r = await toolSearchError(ctx, { message: "timeout of 5000ms exceeded while calling api" });
    expect(r.matches.some((m) => m.code === "ECONNABORTED" || /timeout/i.test(m.message))).toBe(true);
  });

  it("repo filter restricts matches", async () => {
    const ctx = makeCtx();
    const r = await toolSearchError(ctx, {
      message: "expected a function got object",
      repo: "sindresorhus/is",
    });
    expect(r.matches.every((m) => m.repo === "sindresorhus/is")).toBe(true);
  });

  it("pins the dataset version into every payload URL", async () => {
    // Dataset files are served max-age=86400 with a week of
    // stale-while-revalidate, so a shared path can hand back a shard from a
    // previous publish long after the manifest moved on.
    const ctx = makeCtx();
    await syncDataset(ctx.store, false);
    const version = ctx.store.readPointer()!.datasetVersion;
    served = [];
    await toolSearchError(ctx, { message: "Request failed with status code 503" });
    const payloads = served.filter((u) => u !== "/data/manifest.json");
    expect(payloads.length).toBeGreaterThan(0);
    for (const u of payloads) {
      expect(u, u).toContain(`?v=${encodeURIComponent(version)}`);
    }
    // The manifest itself cannot carry the version — it is what reveals it.
    expect(served.every((u) => !u.startsWith("/data/manifest.json?"))).toBe(true);
  });

  it("a search downloads only the shards it needs", async () => {
    const ctx = makeCtx();
    await syncDataset(ctx.store, false);
    served = [];
    await toolSearchError(ctx, { message: "Request failed with status code 503" });
    const paths = served.map((u) => u.split("?")[0]);
    const metaFetches = paths.filter((u) => u!.startsWith("/data/search/meta/"));
    const tokenFetches = paths.filter((u) => u!.startsWith("/data/search/tokens/"));
    expect(paths).not.toContain("/data/index.json.gz");
    expect(paths).not.toContain("/data/index.json");
    expect(tokenFetches.length).toBeGreaterThan(0);
    expect(tokenFetches.length).toBeLessThan(20);
    expect(metaFetches.length).toBeLessThan(20);
  });

  it("a repeat search inside the poll interval makes no requests at all", async () => {
    const ctx = makeCtx({ ttlSeconds: 600 });
    await toolSearchError(ctx, { message: "Request failed with status code 503" });
    served = [];
    const r = await toolSearchError(ctx, { message: "Request failed with status code 503" });
    expect(served).toEqual([]);
    expect(r.matches.length).toBeGreaterThan(0);
  });

  it("get_error returns markdown by id, and by repo+slug", async () => {
    const ctx = makeCtx();
    const found = await toolSearchError(ctx, { message: "Got an ERR_BAD_RESPONSE from the server" });
    const hit = found.matches[0]!;
    const byId = await toolGetError(ctx, { id: hit.id });
    expect(byId.markdown).toContain("## What it means");
    expect(byId.url).toContain("https://errors.standardbeagle.com/");
    const bySlug = await toolGetError(ctx, { repo: hit.repo, slug: byId.url.split("/").at(-2)! });
    expect(bySlug.markdown).toBe(byId.markdown);
  });

  it("list_repos returns the repo list", async () => {
    const ctx = makeCtx();
    const r = await toolListRepos(ctx);
    expect(r.repos.some((x) => x.repo === "axios/axios")).toBe(true);
  });

  it("refresh_dataset full=true prefetches every shard, and then offline still answers", async () => {
    const ctx = makeCtx();
    const r = await toolRefreshDataset(ctx, { full: true });
    expect(r.datasetVersion).toBeTruthy();
    expect(r.prefetched).toBeGreaterThan(0);

    const offline = makeCtx({ cacheDir: ctx.store.dir, offline: true, ttlSeconds: 0 });
    served = [];
    const search = await toolSearchError(offline, { message: "Request failed with status code 503" });
    expect(served).toEqual([]);
    expect(search.matches.length).toBeGreaterThan(0);
    expect(search.stale).toBe(true);
  }, 30000);

  it("no cache and no network is a clear error, not a crash", async () => {
    const ctx = makeCtx({ baseUrl: "http://127.0.0.1:1", cacheDir: mkdtempSync(join(tmpdir(), "mcp-empty-")) });
    await expect(toolSearchError(ctx, { message: "anything" })).rejects.toThrow(/refresh_dataset/);
  });
});

describe("built bundle", () => {
  it("dist/index.js starts and answers an MCP initialize (regression: double shebang)", async () => {
    const { spawn } = await import("node:child_process");
    const bin = resolve(__dirname, "..", "dist", "index.js");
    const child = spawn(process.execPath, [bin], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ERRLOOKUP_OFFLINE: "1", ERRLOOKUP_CACHE_DIR: "/tmp/errlookup-none" },
    });
    const line = await new Promise<string>((res, rej) => {
      const t = setTimeout(() => {
        child.kill();
        rej(new Error("no response from bundle in 10s"));
      }, 10_000);
      let buf = "";
      child.stdout.on("data", (d) => {
        buf += d.toString();
        const nl = buf.indexOf("\n");
        if (nl >= 0) {
          clearTimeout(t);
          child.kill();
          res(buf.slice(0, nl));
        }
      });
      child.on("exit", (c) => {
        if (c !== null && c !== 0) {
          clearTimeout(t);
          rej(new Error(`bundle exited ${c}`));
        }
      });
      child.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } },
        }) + "\n"
      );
    });
    const msg = JSON.parse(line);
    expect(msg.jsonrpc).toBe("2.0");
    expect(msg.result?.serverInfo?.name).toBeTruthy();
  }, 15000);
});
