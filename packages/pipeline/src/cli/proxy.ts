import { resolve } from "node:path";
import { loadConfig } from "../config/index.js";
import { LimitRecorder, defaultSnapshotPath, readLimitSnapshot } from "../proxy/limits.js";
import { createProxyServer, listen } from "../proxy/server.js";

/**
 * `errlookup proxy` — run the recording proxy in the foreground until killed.
 *
 * Foreground because systemd is the supervisor here, the same as the drain:
 * a self-daemonising process would need its own pidfile, log rotation and
 * restart policy, all of which the unit already provides.
 */
export async function runProxy(argv: string[]): Promise<void> {
  const cfg = loadConfig();
  if (argv.includes("--limits")) {
    const snap = readLimitSnapshot(snapshotPath(cfg.proxy.snapshotPath));
    if (!snap) {
      console.error(`no snapshot at ${snapshotPath(cfg.proxy.snapshotPath)} — has the proxy run?`);
      process.exit(1);
    }
    console.log(JSON.stringify(snap, null, 2));
    return;
  }

  const recorder = new LimitRecorder(cfg.proxy.upstream, snapshotPath(cfg.proxy.snapshotPath));
  // --reset starts a new observation window. Without it a restart resumes the
  // tally, which is what a multi-day reading needs and what a fresh
  // measurement must not have.
  if (argv.includes("--reset")) recorder.reset();
  const server = createProxyServer({
    upstream: cfg.proxy.upstream,
    recorder,
    port: cfg.proxy.port,
    host: cfg.proxy.host,
    maxBodyBytes: cfg.proxy.maxBodyBytes,
    maxConnections: cfg.proxy.maxConnections,
  });
  const port = await listen(server, cfg.proxy.port, cfg.proxy.host);
  console.log(`errlookup proxy: http://${cfg.proxy.host}:${port} -> ${cfg.proxy.upstream}`);
  console.log(`limits: ${snapshotPath(cfg.proxy.snapshotPath)} (also GET /__errlookup/limits)`);
  console.log(`counting since ${recorder.current().since} (${recorder.current().requests} requests so far)`);
  if (!cfg.proxy.enabled) {
    // Running the proxy and routing to it are separate switches on purpose:
    // the recorder can be started and checked before any drain depends on it.
    console.log("note: proxy.enabled is false, so providers are NOT routed here yet");
  }

  await new Promise<void>((done) => {
    const stop = () => {
      // Existing calls finish: a completion in flight has already been paid
      // for, and killing it mid-stream costs the tokens for nothing.
      server.close(() => done());
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

function snapshotPath(configured: string): string {
  return configured ? resolve(configured) : defaultSnapshotPath();
}
