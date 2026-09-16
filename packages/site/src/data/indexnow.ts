/**
 * IndexNow submission payloads (https://www.indexnow.org/documentation).
 *
 * Why this exists: Googlebot withdrew from this host on 2026-08-18 and has not
 * come back — 26,965 requests on 2026-08-17, ~40/day ever since, which is 21
 * years to read the 313k URLs we advertise. Bingbot meanwhile stepped up to
 * 3,500-4,800/day and touched 25,887 distinct paths in the week to 2026-09-16.
 * IndexNow is the protocol Bing and Yandex actually listen to, so it pushes new
 * pages at the crawler that is reading them instead of waiting on a sitemap
 * re-fetch from one that is not.
 *
 * Pure helpers, kept out of the submit script so the batching and the payload
 * shape are unit-testable without a network.
 */

/**
 * The shared secret, which is deliberately public: IndexNow authenticates by
 * having the caller host this value at `/<key>.txt` on the same origin, so the
 * key IS the proof of control and there is nothing to hide. Committed rather
 * than configured because the key file's NAME derives from it — a key in the
 * environment and a file in `public/` would drift silently, and a mismatch
 * fails every submission with 403. `tests/indexnow.test.ts` pins them together.
 */
export const INDEXNOW_KEY = "47d405f30290ecb36a67b8cf74c87931";

/** One request may carry at most 10,000 URLs (protocol limit, not ours). */
export const INDEXNOW_MAX_URLS_PER_REQUEST = 10_000;

export const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";

export interface IndexNowPayload {
  host: string;
  key: string;
  keyLocation: string;
  urlList: string[];
}

/** Where the key file must be reachable for `host` to be accepted. */
export function keyLocation(site: string): string {
  return `${site.replace(/\/$/, "")}/${INDEXNOW_KEY}.txt`;
}

/**
 * Split a URL list into protocol-legal requests.
 *
 * An empty list yields no batches rather than one empty request: IndexNow
 * answers an empty `urlList` with 422, which would read as a failure in the
 * publisher log on every run that changed nothing.
 */
export function batchUrls(
  urls: readonly string[],
  size: number = INDEXNOW_MAX_URLS_PER_REQUEST
): string[][] {
  const batches: string[][] = [];
  for (let i = 0; i < urls.length; i += size) batches.push(urls.slice(i, i + size));
  return batches;
}

/**
 * Build one request body.
 *
 * Every URL must be on `host` — IndexNow rejects the WHOLE request with 422 if
 * any single URL is off-origin, so a stray absolute URL from another domain
 * would silently drop 9,999 good ones with it. Filtering is the caller's job;
 * `offHostUrls` is how the caller checks.
 */
export function buildPayload(site: string, urls: readonly string[]): IndexNowPayload {
  return {
    host: new URL(site).hostname,
    key: INDEXNOW_KEY,
    keyLocation: keyLocation(site),
    urlList: [...urls],
  };
}

/** URLs that would poison a request by not belonging to `site`'s host. */
export function offHostUrls(site: string, urls: readonly string[]): string[] {
  const host = new URL(site).hostname;
  return urls.filter((u) => {
    try {
      return new URL(u).hostname !== host;
    } catch {
      return true;
    }
  });
}

/**
 * How to read a response code. IndexNow returns 200 and 202 for success —
 * 202 means "accepted, key not validated yet", which is the NORMAL answer for
 * the first submission after a key is published and must not read as an error.
 */
export function describeStatus(status: number): { ok: boolean; meaning: string } {
  switch (status) {
    case 200:
      return { ok: true, meaning: "accepted" };
    case 202:
      return { ok: true, meaning: "accepted, key validation pending" };
    case 400:
      return { ok: false, meaning: "bad request (malformed payload)" };
    case 403:
      return { ok: false, meaning: `key not valid — is ${INDEXNOW_KEY}.txt served at the site root?` };
    case 422:
      return { ok: false, meaning: "URLs do not belong to the host, or the key does not match" };
    case 429:
      return { ok: false, meaning: "rate limited (too many submissions)" };
    default:
      return { ok: false, meaning: `unexpected status ${status}` };
  }
}
