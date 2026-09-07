import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { LimitRecorder } from "./limits.js";

/**
 * Headers that describe THIS hop and must not be forwarded to the next one
 * (RFC 9110 §7.6.1). `host` is rewritten rather than dropped; the rest would
 * make the upstream negotiate a connection it is not on.
 */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export interface ProxyOptions {
  /** Where calls really go, e.g. https://api.z.ai/api/coding/paas/v4 — path included. */
  upstream: string;
  recorder: LimitRecorder;
  port: number;
  /**
   * Loopback. The proxy forwards a credential it never sees the value of, so
   * anything that can reach it can spend the account's quota. Widening this
   * is a deliberate decision and belongs in the config, not in a default.
   */
  host?: string;
  /** Refuse a request body larger than this. Analysis prompts run to a few MB. */
  maxBodyBytes?: number;
  maxConnections?: number;
  /**
   * Ceiling on one upstream call. Sits ABOVE the provider's own timeoutMs
   * (600s) on purpose: the provider must stay the component that kills a slow
   * call, because it is the one that knows how to retry, split, and fall back.
   */
  upstreamTimeoutMs?: number;
}

export const DEFAULT_MAX_BODY_BYTES = 32 * 1024 * 1024;
export const DEFAULT_MAX_CONNECTIONS = 64;
export const DEFAULT_UPSTREAM_TIMEOUT_MS = 660_000;

/** Snapshot readout, so an operator can curl the proxy instead of finding the file. */
const LIMITS_PATH = "/__errlookup/limits";

/**
 * A recording forward proxy for the provider API.
 *
 * It exists because err-lookup never speaks HTTP to a model: every call is a
 * spawned CLI (`opencode acp`), and the response headers — `retry-after`, the
 * `x-ratelimit-*` family — die inside that subprocess. What reaches
 * provider/run.ts is prose, matched with regexes and, in the case of z.ai's
 * unzoned reset stamp, a guess about which timezone it meant.
 *
 * This stage is deliberately READ-ONLY: it forwards byte for byte and records
 * what came back. It does not throttle, retry, or hold. Nothing may depend on
 * its numbers until a drain has shown which headers the upstream actually
 * sends — see LimitSnapshot.headerNamesSeen.
 */
export function createProxyServer(opts: ProxyOptions): Server {
  const upstream = new URL(opts.upstream);
  const forward = upstream.protocol === "http:" ? httpRequest : httpsRequest;
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const upstreamTimeoutMs = opts.upstreamTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS;

  const server = createServer((req, res) => {
    if (req.url === LIMITS_PATH) {
      const body = `${JSON.stringify(opts.recorder.current(), null, 2)}\n`;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(body);
      return;
    }
    proxyOne(req, res);
  });

  server.maxConnections = opts.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
  // The request must arrive promptly; the RESPONSE may stream for many
  // minutes, which `timeout: 0` (node's default socket behaviour) allows.
  server.requestTimeout = 300_000;
  server.headersTimeout = 60_000;
  return server;

  function proxyOne(req: IncomingMessage, res: ServerResponse): void {
    const headers: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined || HOP_BY_HOP.has(name.toLowerCase())) continue;
      headers[name] = value;
    }
    // Rewritten, not forwarded: TLS SNI and the upstream's virtual hosting
    // both key off this, and the client sent us 127.0.0.1.
    headers.host = upstream.host;

    // The client's base URL is the proxy root, so its path is relative to the
    // upstream's own path prefix (/api/coding/paas/v4) and must be joined to it.
    const path = `${upstream.pathname.replace(/\/$/, "")}${req.url ?? "/"}`;

    const up = forward(
      {
        protocol: upstream.protocol,
        hostname: upstream.hostname,
        port: upstream.port || (upstream.protocol === "https:" ? 443 : 80),
        method: req.method,
        path,
        headers,
      },
      (upRes) => {
        opts.recorder.observe(upRes.statusCode ?? 0, upRes.headers);
        const out: Record<string, string | string[]> = {};
        for (const [name, value] of Object.entries(upRes.headers)) {
          if (value === undefined || HOP_BY_HOP.has(name.toLowerCase())) continue;
          out[name] = value;
        }
        res.writeHead(upRes.statusCode ?? 502, out);
        // Piped, never buffered: completions come back as an SSE stream, and
        // holding one until it ends would idle out the ACP watchdog that
        // treats silence as a stall.
        upRes.pipe(res);
        upRes.on("error", () => res.destroy());
      }
    );

    up.setTimeout(upstreamTimeoutMs, () => up.destroy(new Error("upstream timeout")));
    up.on("error", (e) => fail(res, 502, `upstream request failed: ${e.message}`));

    let seen = 0;
    req.on("data", (chunk: Buffer) => {
      seen += chunk.length;
      if (seen > maxBodyBytes) {
        // Both sides die: the upstream must not be left holding a truncated
        // body it will bill us for completing.
        up.destroy(new Error("request body over cap"));
        fail(res, 413, `request body exceeds ${maxBodyBytes} bytes`);
      }
    });
    req.on("error", () => up.destroy());
    res.on("close", () => {
      // The caller gave up (watchdog kill, drain shutdown). Nothing will read
      // the rest of the answer, so stop paying for it.
      if (!res.writableEnded) up.destroy();
    });
    req.pipe(up);
  }
}

function fail(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, { "content-type": "application/json" });
  // The message names the proxy's own failure only. An upstream error body is
  // forwarded verbatim above and never rewritten here, so provider/run.ts
  // still sees the exact prose its quota regexes match on.
  res.end(`${JSON.stringify({ error: { message, source: "errlookup-proxy" } })}\n`);
}

/** Bind and resolve once listening; the resolved port is the real one when 0 was asked for. */
export function listen(server: Server, port: number, host = "127.0.0.1"): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const addr = server.address();
      resolve(typeof addr === "object" && addr ? addr.port : port);
    });
  });
}
