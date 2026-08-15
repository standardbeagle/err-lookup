/**
 * Traffic data points for Workers Analytics Engine (binding `TRAFFIC`).
 *
 * Pure helpers, kept out of middleware.ts so they are unit-testable without an
 * Astro runtime. One data point per worker-routed request; static-excluded
 * paths never enter the worker and are invisible here — that blind spot is
 * documented in scripts/report-top-pages.sh.
 */

export interface AnalyticsEngineDataset {
  writeDataPoint(point: { blobs?: (string | null)[]; doubles?: number[]; indexes?: (string | null)[] }): void;
}

/**
 * Coarse UA classes, most-specific first. The site's audience is mostly
 * crawlers (measured 2026-08-13: Googlebot 43%, GoogleOther 31%, AI bots ~8%),
 * so the classes separate the crawlers we care about instead of lumping them
 * into "bot".
 */
export function classifyUa(ua: string | null): string {
  if (!ua) return "unknown";
  if (/Googlebot/i.test(ua)) return "googlebot";
  if (/GoogleOther/i.test(ua)) return "google-other";
  if (/bingbot/i.test(ua)) return "bingbot";
  if (/GPTBot|OAI-SearchBot|ChatGPT-User|ClaudeBot|Claude-Web|anthropic|PerplexityBot|Amazonbot|CCBot|Bytespider|meta-externalagent|cohere|Applebot/i.test(ua)) {
    return "ai-bot";
  }
  if (/bot|crawler|spider|slurp|crawl/i.test(ua)) return "other-bot";
  return "human";
}

/** AE index values are capped at 96 bytes; blobs individually at ~5KB total. */
const INDEX_MAX = 96;
const BLOB_MAX = 256;

/**
 * Build the data point for one request. Layout (stable — queries depend on it):
 *   blob1 path, blob2 UA class, blob3 cache hit|miss|-, blob4 hostname
 *   double1 status
 *   index1 path (sampling key: per-path sampling keeps top-page counts honest)
 */
export function trafficDataPoint(
  url: URL,
  ua: string | null,
  status: number,
  cache: "hit" | "miss" | "-"
): { blobs: string[]; doubles: number[]; indexes: string[] } {
  const path = url.pathname.slice(0, BLOB_MAX);
  return {
    blobs: [path, classifyUa(ua), cache, url.hostname.slice(0, BLOB_MAX)],
    doubles: [status],
    indexes: [url.pathname.slice(0, INDEX_MAX)],
  };
}

/** Write one data point; never let analytics break a request. */
export function recordTraffic(
  dataset: AnalyticsEngineDataset | undefined,
  url: URL,
  ua: string | null,
  status: number,
  cache: "hit" | "miss" | "-"
): void {
  if (!dataset) return;
  try {
    dataset.writeDataPoint(trafficDataPoint(url, ua, status, cache));
  } catch {
    // analytics is best-effort by definition
  }
}
