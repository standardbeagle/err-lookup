import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import type { ServerResponse, IncomingMessage } from "node:http";
import { CacheStore } from "../src/cache.js";
import { syncDataset } from "../src/sync.js";
import { searchErrors } from "../src/search.js";
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
  execFileSync("node", ["scripts/seed-dataset.mjs"], { cwd: siteRoot, stdio: "pipe" });
}
void searchErrors;

let http: Server;
let baseUrl: string;

function startStaticServer(root: string): Promise<{ server: Server; port: number }> {
  return new Promise((res) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = (req.url ?? "").split("?")[0]!;
      // map /data/x → root/x  (root IS the data dir)
      let rel = url;
      if (rel.startsWith("/data/")) rel = "/" + rel.slice("/data/".length);
      if (rel === "/data") rel = "/";
      const filePath = join(root, rel);
      try {
        const buf = readFileSync(filePath);
        const ct = filePath.endsWith(".json") ? "application/json" : "text/plain";
        res.writeHead(200, { "content-type": ct });
        res.end(buf);
      } catch {
        res.writeHead(404);
        res.end("not found");
      }
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      res({ server, port });
    });
  });
}

let tmpCache: string;

function makeCtx(overrides: Partial<{ baseUrl: string; cacheDir: string; offline: boolean }> = {}): ToolContext {
  return {
    store: new CacheStore({
      baseUrl: overrides.baseUrl ?? baseUrl,
      cacheDir: overrides.cacheDir ?? tmpCache,
      ttlSeconds: 0,
      offline: overrides.offline ?? false,
    }),
    lastSyncAt: 0,
    ttlSeconds: 0,
  };
}

beforeAll(async () => {
  const s = await startStaticServer(sitePublicData);
  http = s.server;
  baseUrl = `http://127.0.0.1:${s.port}`;
  tmpCache = mkdtempSync(join(tmpdir(), "mcp-cache-"));
}, 15000);

afterAll(async () => {
  await new Promise<void>((r) => http.close(() => r()));
  rmSync(tmpCache, { recursive: true, force: true });
});

describe("MCP sync + search (§8.4)", () => {
  it("syncs manifest + index from the static server", async () => {
    const ctx = makeCtx();
    const r = await syncDataset(ctx.store, false);
    expect(r.updated).toBe(true);
    expect(r.datasetVersion).toBeTruthy();
    expect(r.errorCount).toBeGreaterThan(0);
    // index cached on disk
    expect(existsSync(join(tmpCache, "manifest.json"))).toBe(true);
    expect(existsSync(join(tmpCache, "index.json"))).toBe(true);
  });

  it("re-sync is a no-op when datasetVersion unchanged", async () => {
    const ctx = makeCtx();
    await syncDataset(ctx.store, false);
    const r2 = await syncDataset(ctx.store, false);
    expect(r2.updated).toBe(false);
  });

  it("search tier 1 — exact-code match", async () => {
    const ctx = makeCtx();
    await syncDataset(ctx.store, false);
    const r = await toolSearchError(ctx, { message: "Got an ERR_BAD_RESPONSE from the server" });
    expect(r.matches.length).toBeGreaterThan(0);
    expect(r.matches[0]!.matchType).toBe("exact-code");
    expect(r.matches[0]!.score).toBe(1.0);
    expect(r.matches[0]!.code).toBe("ERR_BAD_RESPONSE");
  });

  it("search tier 2 — pattern match", async () => {
    const ctx = makeCtx();
    await syncDataset(ctx.store, false);
    // No code token; but the message matches the derived pattern.
    const r = await toolSearchError(ctx, { message: "Request failed with status code 503 please help" });
    const code = r.matches.find((m) => m.matchType === "pattern");
    expect(code, JSON.stringify(r.matches)).toBeTruthy();
    expect(code!.score).toBe(0.9);
  });

  it("search tier 3 — fuzzy match", async () => {
    const ctx = makeCtx();
    await syncDataset(ctx.store, false);
    const r = await toolSearchError(ctx, { message: "timeout of 5000ms exceeded while calling api" });
    expect(r.matches.length).toBeGreaterThan(0);
    // Either pattern (timeout regex) or fuzzy; both acceptable as long as it lands on econnaborted.
    expect(r.matches.some((m) => m.code === "ECONNABORTED" || /timeout/i.test(m.message))).toBe(true);
  });

  it("repo filter restricts matches", async () => {
    const ctx = makeCtx();
    await syncDataset(ctx.store, false);
    const r = await toolSearchError(ctx, { message: "expected a function got object", repo: "sindresorhus/is" });
    expect(r.matches.every((m) => m.repo === "sindresorhus/is")).toBe(true);
  });

  it("get_error returns markdown documentation by id", async () => {
    const ctx = makeCtx();
    await syncDataset(ctx.store, false);
    const idx = ctx.store.readIndex()!;
    const id = idx.errors[0]!.id;
    const r = await toolGetError(ctx, { id });
    expect(r.markdown).toContain("## What it means");
    expect(r.url).toContain("https://errors.standardbeagle.com/");
  });

  it("list_repos returns the repo list", async () => {
    const ctx = makeCtx();
    await syncDataset(ctx.store, false);
    const r = await toolListRepos(ctx);
    expect(r.repos.length).toBeGreaterThan(0);
    expect(r.repos.some((x) => x.repo === "axios/axios")).toBe(true);
  });

  it("refresh_dataset forces a network poll", async () => {
    const ctx = makeCtx();
    const r = await toolRefreshDataset(ctx);
    expect(r.datasetVersion).toBeTruthy();
  });

  it("offline mode: serves from cache, reports stale", async () => {
    // Populate the shared cache online first.
    await syncDataset(makeCtx().store, false);
    // Dead baseUrl + same cache dir → network fails, cache serves, stale=true.
    const offline = makeCtx({ baseUrl: "http://127.0.0.1:1" });
    const r = await syncDataset(offline.store, false);
    expect(r.stale).toBe(true);
    expect(r.datasetVersion).toBeTruthy();
    const idx = offline.store.readIndex();
    expect(idx!.errors.length).toBeGreaterThan(0);
  });

  it("corrupt download (sha mismatch) rejected, old cache retained", async () => {
    // Populate a good cache first.
    const good = makeCtx({ cacheDir: mkdtempSync(join(tmpdir(), "mcp-corrupt-")) });
    await syncDataset(good.store, false);
    const goodIndex = good.store.readIndex()!;
    const goodVersion = good.store.readManifest()!.datasetVersion;

    // Stand up a second server that serves a TAMPERED index but a manifest
    // whose index sha256 matches the ORIGINAL (so verification must fail).
    const tamperedRoot = mkdtempSync(join(tmpdir(), "mcp-tamper-"));
    mkdirSync(join(tamperedRoot), { recursive: true });
    writeFileSync(join(tamperedRoot, "manifest.json"), readFileSync(join(tmpCache, "manifest.json")));
    const tamperedIndex = { ...goodIndex, errors: [] };
    writeFileSync(join(tamperedRoot, "index.json"), JSON.stringify(tamperedIndex));
    const s2 = await startStaticServer(tamperedRoot);
    try {
      const badBaseUrl = `http://127.0.0.1:${(s2.server.address() as { port: number }).port}`;
      const bad = new CacheStore({ baseUrl: badBaseUrl, cacheDir: good.store.dir, ttlSeconds: 0, offline: false });
      const r = await syncDataset(bad, false);
      // Verification fails → old cache retained, errors not emptied.
      const stillCached = bad.readIndex()!;
      expect(stillCached.errors.length).toBe(goodIndex.errors.length);
      expect(stillCached.datasetVersion).toBe(goodVersion);
      void r;
    } finally {
      await new Promise<void>((res) => s2.server.close(() => res()));
      rmSync(tamperedRoot, { recursive: true, force: true });
    }
  });
});
