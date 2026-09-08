import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { LimitRecorder, readLimitSnapshot, recordedHeaders } from "../src/proxy/limits.js";
import { createProxyServer, listen } from "../src/proxy/server.js";
import { mapConfig, loadConfig, DEFAULT_CONFIG } from "../src/config/index.js";
import { parseKdl } from "../src/config/kdl.js";
import { proxyBaseUrl } from "../src/providers.js";
import { opencodeConfig } from "../src/provider/acp.js";
import type { ProviderConfig } from "../src/config/index.js";

const open: Server[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmpSnapshot(): string {
  const dir = mkdtempSync(join(tmpdir(), "errlookup-proxy-test-"));
  dirs.push(dir);
  return join(dir, "limits.json");
}

/** A stand-in upstream. `handler` sees the request the proxy actually sent. */
async function fakeUpstream(handler: (req: IncomingMessage, res: ServerResponse, body: string) => void): Promise<string> {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => handler(req, res, body));
  });
  open.push(server);
  const port = await listen(server, 0);
  return `http://127.0.0.1:${port}`;
}

async function startProxy(upstream: string, snapshotPath: string, extra: Partial<Parameters<typeof createProxyServer>[0]> = {}) {
  const recorder = new LimitRecorder(upstream, snapshotPath);
  const server = createProxyServer({ upstream, recorder, port: 0, ...extra });
  open.push(server);
  const port = await listen(server, 0);
  return { base: `http://127.0.0.1:${port}`, recorder };
}

describe("recording proxy", () => {
  it("forwards method, joined path, headers and body, and returns the upstream response", async () => {
    let seen: { method?: string; url?: string; auth?: string | string[]; body?: string } = {};
    const upstream = await fakeUpstream((req, res, body) => {
      seen = { method: req.method, url: req.url, auth: req.headers.authorization, body };
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    });
    // The upstream carries a path prefix, exactly as z.ai's does.
    const { base } = await startProxy(`${upstream}/api/coding/paas/v4`, tmpSnapshot());

    const r = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: '{"model":"glm"}',
    });

    expect(r.status).toBe(200);
    expect(await r.text()).toBe('{"ok":true}');
    expect(seen.method).toBe("POST");
    // The client's base URL is the proxy root, so its path is relative to the
    // upstream's prefix and must arrive joined to it.
    expect(seen.url).toBe("/api/coding/paas/v4/chat/completions");
    expect(seen.body).toBe('{"model":"glm"}');
    // The credential is forwarded untouched; the proxy never reads its value.
    expect(seen.auth).toBe("Bearer test-token");
  });

  it("rewrites host to the upstream rather than forwarding 127.0.0.1", async () => {
    let host: string | undefined;
    const upstream = await fakeUpstream((req, res) => {
      host = req.headers.host;
      res.end("ok");
    });
    const upstreamPort = new URL(upstream).port;
    const { base } = await startProxy(upstream, tmpSnapshot());
    await fetch(`${base}/v1/models`);
    expect(host).toBe(`127.0.0.1:${upstreamPort}`);
  });

  it("records rate-limit headers and the names it has seen", async () => {
    const upstream = await fakeUpstream((req, res) => {
      res.writeHead(200, {
        "x-ratelimit-remaining-requests": "42",
        "x-ratelimit-reset-requests": "31s",
        "x-request-id": "req-1",
      });
      res.end("ok");
    });
    const snapshotPath = tmpSnapshot();
    const { base } = await startProxy(upstream, snapshotPath);
    await fetch(`${base}/chat/completions`, { method: "POST", body: "x" });

    const snap = readLimitSnapshot(snapshotPath);
    expect(snap?.requests).toBe(1);
    expect(snap?.statuses["200"]).toBe(1);
    expect(snap?.last?.headers["x-ratelimit-remaining-requests"]).toBe("42");
    expect(snap?.headerNamesSeen).toContain("x-ratelimit-reset-requests");
    // No throttling seen, so the field that survives the next request is null.
    expect(snap?.lastThrottled).toBeNull();
  });

  it("keeps the last 429 separately from the last response", async () => {
    let n = 0;
    const upstream = await fakeUpstream((req, res) => {
      n += 1;
      if (n === 1) {
        res.writeHead(429, { "retry-after": "17" });
        res.end("slow down");
      } else {
        res.writeHead(200);
        res.end("ok");
      }
    });
    const snapshotPath = tmpSnapshot();
    const { base } = await startProxy(upstream, snapshotPath);
    await fetch(`${base}/a`);
    await fetch(`${base}/b`);

    const snap = readLimitSnapshot(snapshotPath);
    expect(snap?.last?.status).toBe(200);
    // Without this the 429 — the whole reason the proxy exists — is erased by
    // the next successful call milliseconds later.
    expect(snap?.lastThrottled?.status).toBe(429);
    expect(snap?.lastThrottled?.headers["retry-after"]).toBe("17");
    expect(snap?.statuses).toEqual({ "429": 1, "200": 1 });
  });

  it("forwards an upstream error body verbatim so the quota regexes still match", async () => {
    const prose = "AI_APICallError: Rate limit reached for requests";
    const upstream = await fakeUpstream((req, res) => {
      res.writeHead(429, { "content-type": "text/plain" });
      res.end(prose);
    });
    const { base } = await startProxy(upstream, tmpSnapshot());
    const r = await fetch(`${base}/chat/completions`);
    expect(r.status).toBe(429);
    expect(await r.text()).toBe(prose);
  });

  it("streams the response instead of buffering it", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const upstream = await fakeUpstream((req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: first\n\n");
      void held.then(() => res.end("data: last\n\n"));
    });
    const { base } = await startProxy(upstream, tmpSnapshot());

    const r = await fetch(`${base}/chat/completions`);
    const reader = r.body!.getReader();
    // The first chunk must arrive while the upstream is still open. A buffering
    // proxy would deadlock here, and in production would starve the ACP idle
    // watchdog that reads silence as a stall.
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("first");
    release();
    await reader.cancel();
  });

  it("refuses a request body over the cap", async () => {
    const upstream = await fakeUpstream((req, res) => res.end("ok"));
    const { base } = await startProxy(upstream, tmpSnapshot(), { maxBodyBytes: 64 });
    const r = await fetch(`${base}/chat/completions`, { method: "POST", body: "x".repeat(4096) });
    expect(r.status).toBe(413);
  });

  it("answers 502 rather than hanging when the upstream is unreachable", async () => {
    // Port 1 is privileged and unbound: connect fails immediately.
    const { base } = await startProxy("http://127.0.0.1:1", tmpSnapshot());
    const r = await fetch(`${base}/chat/completions`);
    expect(r.status).toBe(502);
    expect(await r.json()).toMatchObject({ error: { source: "errlookup-proxy" } });
  });

  it("serves the snapshot on /__errlookup/limits without touching the upstream", async () => {
    let hits = 0;
    const upstream = await fakeUpstream((req, res) => {
      hits += 1;
      res.end("ok");
    });
    const { base } = await startProxy(upstream, tmpSnapshot());
    const r = await fetch(`${base}/__errlookup/limits`);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ requests: 0 });
    expect(hits).toBe(0);
  });
});

describe("tally across restarts", () => {
  it("resumes the tally on disk instead of starting empty", () => {
    const path = tmpSnapshot();
    const first = new LimitRecorder("https://up.example", path);
    first.observe(200, { "x-ratelimit-remaining": "5" });
    first.observe(429, { "retry-after": "3" });
    const since = first.current().since;

    // The proxy runs under Restart=always; a crash must not silently zero a
    // multi-day observation and make the next reading look healthy.
    const resumed = new LimitRecorder("https://up.example", path);
    expect(resumed.current().requests).toBe(2);
    expect(resumed.current().statuses).toEqual({ "200": 1, "429": 1 });
    expect(resumed.current().since).toBe(since);

    resumed.observe(200, { "x-ratelimit-remaining": "4" });
    expect(resumed.current().requests).toBe(3);
    // First-seen names must not be re-appended when the tally resumes.
    expect(resumed.current().headerNamesSeen).toEqual(["x-ratelimit-remaining", "retry-after"]);
  });

  it("discards a tally belonging to a different upstream", () => {
    const path = tmpSnapshot();
    new LimitRecorder("https://old.example", path).observe(429, {});
    // Those counts describe another account's limit.
    const moved = new LimitRecorder("https://new.example", path);
    expect(moved.current().requests).toBe(0);
    expect(moved.current().upstream).toBe("https://new.example");
  });

  it("reset() starts a new window", () => {
    const path = tmpSnapshot();
    const r = new LimitRecorder("https://up.example", path);
    r.observe(429, {});
    const before = r.current().since;
    r.reset(new Date(Date.parse(before) + 60_000));
    expect(r.current().requests).toBe(0);
    expect(r.current().since).not.toBe(before);
    expect(readLimitSnapshot(path)?.requests).toBe(0);
  });
});

describe("recorded header allowlist", () => {
  it("keeps rate-limit headers and drops everything else", () => {
    const kept = recordedHeaders({
      "x-ratelimit-remaining-tokens": "900",
      "ratelimit-reset": "60",
      "retry-after": "3",
      "x-request-id": "abc",
      date: "Sun, 07 Sep 2026 00:00:00 GMT",
      // Not recorded: a snapshot file is ops data, and an allowlist is the
      // only version of this that cannot leak a header nobody anticipated.
      authorization: "Bearer secret",
      "set-cookie": "session=secret",
      "content-type": "application/json",
      "x-internal-account-id": "acct_123",
    });
    expect(Object.keys(kept).sort()).toEqual([
      "date",
      "ratelimit-reset",
      "retry-after",
      "x-ratelimit-remaining-tokens",
      "x-request-id",
    ]);
  });

  it("joins repeated header values", () => {
    expect(recordedHeaders({ "x-ratelimit-reset": ["1", "2"] })).toEqual({ "x-ratelimit-reset": "1, 2" });
  });
});

describe("proxy routing", () => {
  // Multi-line on purpose: the config parser only treats a bareword at the
  // START of a line as a node name, so a one-line block parses its children
  // as values and silently yields an empty provider.
  const cfgWith = (proxyBlock: string) =>
    mapConfig(
      parseKdl(
        [
          'provider "flash" {',
          '  command "opencode"',
          '  type "acp"',
          '  model "zai-coding-plan/glm-5.3-flash"',
          "}",
          'provider "other" {',
          '  command "opencode"',
          '  type "acp"',
          '  model "some-other-vendor/model-x"',
          "}",
          'provider "cli" {',
          '  command "codex"',
          "}",
          proxyBlock,
          "defaults {",
          '  primary "flash"',
          "}",
        ].join("\n")
      )
    );

  it("honours ERRLOOKUP_PROXY_ENABLED over the config file", () => {
    const path = join(mkdtempSync(join(tmpdir(), "errlookup-cfg-")), "c.kdl");
    dirs.push(dirname(path));
    writeFileSync(
      path,
      ["proxy {", "  enabled false", "}", "defaults {", '  primary "opencode"', "}"].join("\n")
    );
    try {
      process.env.ERRLOOKUP_PROXY_ENABLED = "1";
      expect(loadConfig(path).proxy.enabled).toBe(true);
      process.env.ERRLOOKUP_PROXY_ENABLED = "0";
      expect(loadConfig(path).proxy.enabled).toBe(false);
      delete process.env.ERRLOOKUP_PROXY_ENABLED;
      expect(loadConfig(path).proxy.enabled).toBe(false);
    } finally {
      delete process.env.ERRLOOKUP_PROXY_ENABLED;
    }
  });

  it("overrides the provider gate for one run, and refuses a bad value", () => {
    const path = join(mkdtempSync(join(tmpdir(), "errlookup-cfg-")), "c.kdl");
    dirs.push(dirname(path));
    writeFileSync(
      path,
      ["defaults {", '  primary "opencode"', "  provider-max-concurrent 10", "}"].join("\n")
    );
    try {
      expect(loadConfig(path).defaults.providerMaxConcurrent).toBe(10);
      process.env.ERRLOOKUP_PROVIDER_MAX_CONCURRENT = "4";
      expect(loadConfig(path).defaults.providerMaxConcurrent).toBe(4);
      // 0 is meaningful — it disables the gate — so it must survive the parse.
      process.env.ERRLOOKUP_PROVIDER_MAX_CONCURRENT = "0";
      expect(loadConfig(path).defaults.providerMaxConcurrent).toBe(0);
      // A typo in an experiment's launch line must not run the whole window
      // at the config's setting and be reported as the intended one.
      process.env.ERRLOOKUP_PROVIDER_MAX_CONCURRENT = "four";
      expect(() => loadConfig(path)).toThrow(/non-negative integer/);
    } finally {
      delete process.env.ERRLOOKUP_PROVIDER_MAX_CONCURRENT;
    }
  });

  it("is off unless a proxy node enables it", () => {
    expect(DEFAULT_CONFIG.proxy.enabled).toBe(false);
    const cfg = cfgWith("");
    expect(proxyBaseUrl(cfg, cfg.providers.flash)).toBeNull();
  });

  it("routes only the listed opencode provider ids", () => {
    const cfg = cfgWith(["proxy {", "  enabled true", "  port 9100", '  provider-ids "zai-coding-plan"', "}"].join("\n"));
    expect(proxyBaseUrl(cfg, cfg.providers.flash)).toBe("http://127.0.0.1:9100");
    // A different account behind a different endpoint: the proxy records one
    // upstream, so routing it there would send its calls to the wrong host.
    expect(proxyBaseUrl(cfg, cfg.providers.other)).toBeNull();
    // Spawned CLIs hold their own HTTP connection; no baseURL knob reaches them.
    expect(proxyBaseUrl(cfg, cfg.providers.cli)).toBeNull();
  });

  it("leaves an explicit base-url alone", () => {
    const cfg = mapConfig(
      parseKdl(
        [
          'provider "flash" {',
          '  command "opencode"',
          '  type "acp"',
          '  model "zai-coding-plan/glm-5.3-flash"',
          '  base-url "http://elsewhere:1234"',
          "}",
          "proxy {",
          "  enabled true",
          "}",
          "defaults {",
          '  primary "flash"',
          "}",
        ].join("\n")
      )
    );
    expect(cfg.providers.flash.baseUrl).toBe("http://elsewhere:1234");
    expect(proxyBaseUrl(cfg, cfg.providers.flash)).toBeNull();
  });
});

describe("opencode config content", () => {
  const base: ProviderConfig = {
    command: "opencode",
    args: ["acp", "--pure"],
    timeoutMs: 1000,
    promptMode: "stdin",
    type: "acp",
    idleTimeoutMs: 0,
    model: "zai-coding-plan/glm-5.3-flash",
    modelOptions: null,
    promptDirective: null,
    baseUrl: null,
  };

  it("carries no provider block when neither baseURL nor model options are set", () => {
    expect(opencodeConfig(base).provider).toBeUndefined();
  });

  it("puts baseURL under the provider's constructor options", () => {
    const cfg = opencodeConfig({ ...base, baseUrl: "http://127.0.0.1:8919" });
    expect(cfg.provider).toEqual({
      "zai-coding-plan": { options: { baseURL: "http://127.0.0.1:8919" } },
    });
  });

  it("merges baseURL and model options into ONE provider block", () => {
    const cfg = opencodeConfig({
      ...base,
      baseUrl: "http://127.0.0.1:8919",
      modelOptions: { reasoningEffort: "high" },
    });
    // Two blocks for the same id would mean the second replaces the first, and
    // the run would silently lose its effort pin the moment the proxy is on.
    expect(cfg.provider).toEqual({
      "zai-coding-plan": {
        options: { baseURL: "http://127.0.0.1:8919" },
        models: { "glm-5.3-flash": { options: { reasoningEffort: "high" } } },
      },
    });
  });

  it("still pins model options when no proxy is routed", () => {
    const cfg = opencodeConfig({ ...base, modelOptions: { reasoningEffort: "low" } });
    expect(cfg.provider).toEqual({
      "zai-coding-plan": { models: { "glm-5.3-flash": { options: { reasoningEffort: "low" } } } },
    });
  });
});
