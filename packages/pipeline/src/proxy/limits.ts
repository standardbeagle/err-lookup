import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Response headers the recorder keeps. An ALLOWLIST, not a blocklist: the
 * snapshot file is world-readable ops data, and a blocklist that forgets a
 * header name leaks whatever the provider decides to echo back. Nothing here
 * carries a credential — `authorization` and `x-api-key` travel on the
 * REQUEST anyway and are never inspected.
 */
function isRecordedHeader(name: string): boolean {
  const n = name.toLowerCase();
  return (
    n.startsWith("ratelimit-") || // IETF draft spelling
    n.startsWith("x-ratelimit-") || // OpenAI/Anthropic spelling
    n === "retry-after" ||
    n === "x-request-id" ||
    n === "date"
  );
}

export type HeaderBag = Record<string, string>;

export interface LimitObservation {
  at: string;
  status: number;
  headers: HeaderBag;
}

export interface LimitSnapshot {
  updatedAt: string;
  upstream: string;
  requests: number;
  /** Status code → count, so a 429 rate does not need log grepping. */
  statuses: Record<string, number>;
  /**
   * Every recorded header name seen at least once, in first-seen order. This
   * is the whole point of the read-only phase: nobody knows yet whether z.ai
   * sends rate-limit headers at all, or under which spelling. An empty list
   * after a drain is the answer that the header route is a dead end.
   */
  headerNamesSeen: string[];
  last: LimitObservation | null;
  /** The most recent 429 or 5xx, kept separately — the ordinary `last` overwrites it within milliseconds. */
  lastThrottled: LimitObservation | null;
}

function emptySnapshot(upstream: string): LimitSnapshot {
  return {
    updatedAt: new Date(0).toISOString(),
    upstream,
    requests: 0,
    statuses: {},
    headerNamesSeen: [],
    last: null,
    lastThrottled: null,
  };
}

export function defaultSnapshotPath(): string {
  return process.env.ERRLOOKUP_LIMITS_FILE || join(tmpdir(), "errlookup-provider-limits.json");
}

/** Pull the recorded headers out of a raw node header bag (values may be arrays). */
export function recordedHeaders(raw: Record<string, string | string[] | undefined>): HeaderBag {
  const out: HeaderBag = {};
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined || !isRecordedHeader(name)) continue;
    out[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

/**
 * Accumulates what the upstream said about our rate limit and publishes it as
 * one JSON file.
 *
 * A file rather than a socket because the readers are separate processes with
 * separate lifetimes — a drain, a reverify sweep, `errlookup status` — and
 * none of them should fail when the proxy is not running. Rename-on-write, so
 * a reader either sees the previous snapshot whole or the new one whole; there
 * is no torn read to guard against and therefore no lock.
 */
export class LimitRecorder {
  private snapshot: LimitSnapshot;
  private readonly seen = new Set<string>();

  constructor(
    readonly upstream: string,
    private readonly path = defaultSnapshotPath()
  ) {
    this.snapshot = emptySnapshot(upstream);
    mkdirSync(dirname(this.path), { recursive: true });
  }

  observe(status: number, raw: Record<string, string | string[] | undefined>, now = new Date()): void {
    const headers = recordedHeaders(raw);
    for (const name of Object.keys(headers)) {
      if (!this.seen.has(name)) {
        this.seen.add(name);
        this.snapshot.headerNamesSeen.push(name);
      }
    }
    const observation: LimitObservation = { at: now.toISOString(), status, headers };
    this.snapshot.updatedAt = observation.at;
    this.snapshot.requests += 1;
    this.snapshot.statuses[String(status)] = (this.snapshot.statuses[String(status)] ?? 0) + 1;
    this.snapshot.last = observation;
    if (status === 429 || status >= 500) this.snapshot.lastThrottled = observation;
    this.publish();
  }

  current(): LimitSnapshot {
    return structuredClone(this.snapshot);
  }

  private publish(): void {
    // pid in the temp name: two proxies pointed at one snapshot path would
    // otherwise rename over each other's half-written file.
    const tmp = `${this.path}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, `${JSON.stringify(this.snapshot, null, 2)}\n`);
      renameSync(tmp, this.path);
    } catch {
      // Recording is observational. A full disk must not fail the provider
      // call that is being observed — the drain's own disk-floor check owns
      // that failure, and reporting it twice would stop the run for a
      // diagnostic.
    }
  }
}

/** Read the published snapshot, or null when no proxy has written one. */
export function readLimitSnapshot(path = defaultSnapshotPath()): LimitSnapshot | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as LimitSnapshot;
  } catch {
    return null;
  }
}
