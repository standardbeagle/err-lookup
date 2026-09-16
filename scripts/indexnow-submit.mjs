#!/usr/bin/env node
/**
 * Submit changed URLs to IndexNow (Bing, Yandex, Seznam, Naver share one feed).
 *
 * Reads the LIVE sitemaps rather than dist/: the script runs after a successful
 * deploy, so the deployed sitemap is the only list that is certainly true, and
 * reading it over HTTP keeps this decoupled from whether a route prerenders.
 *
 * Which URLs: those whose <lastmod> is on or after the marker date (the last
 * successful submission), newest first. Sitemap lastmod is date-granular, so a
 * same-day rerun resubmits that day's URLs — harmless (IndexNow is idempotent)
 * and the safe direction to err in.
 *
 * Usage:
 *   indexnow-submit.mjs [--all] [--dry-run] [--since YYYY-MM-DD]
 *                       [--max N] [--base URL]
 *
 *   --all       ignore the marker and submit every advertised URL. For the
 *               initial seed; paced in protocol-sized batches.
 *   --dry-run   resolve and count URLs, print the plan, submit nothing.
 *   --max N     ceiling on URLs submitted this run (default 10000, 0 = no cap).
 *               Without --all this also bounds a first run that has no marker.
 *
 * Exit 0 on success or nothing-to-do; non-zero if any batch was rejected.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { homedir } from "node:os";
import {
  INDEXNOW_ENDPOINT,
  INDEXNOW_MAX_URLS_PER_REQUEST,
  batchUrls,
  buildPayload,
  describeStatus,
  keyLocation,
  offHostUrls,
} from "../packages/site/src/data/indexnow.ts";

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const BASE = (opt("--base", process.env.ERRLOOKUP_SITE || "https://errors.standardbeagle.com")).replace(/\/$/, "");
const ALL = flag("--all");
const DRY = flag("--dry-run");
const MAX = Number(opt("--max", process.env.ERRLOOKUP_INDEXNOW_MAX_URLS ?? "10000"));
const LOG_DIR = process.env.ERRLOOKUP_LOG_DIR || resolve(homedir(), ".local/state/errlookup");
const MARKER = resolve(LOG_DIR, "last-indexnow-marker");
const UA = "errlookup-indexnow/1.0 (+https://errors.standardbeagle.com)";

const log = (...a) => console.log(...a);

async function getText(url) {
  const r = await fetch(url, { headers: { "user-agent": UA } });
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
  return r.text();
}

/** Every <url> entry across every shard of the sitemap index. */
async function sitemapEntries(base) {
  const index = await getText(`${base}/sitemap-index.xml`);
  const shards = [...index.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  const entries = [];
  for (const shard of shards) {
    const xml = await getText(shard);
    for (const m of xml.matchAll(/<url>\s*<loc>([^<]+)<\/loc>(?:\s*<lastmod>([^<]+)<\/lastmod>)?/g)) {
      entries.push({ loc: m[1], lastmod: m[2] ?? null });
    }
  }
  return entries;
}

function readMarker() {
  try {
    return readFileSync(MARKER, "utf8").trim() || null;
  } catch {
    return null;
  }
}

function writeMarker(value) {
  mkdirSync(dirname(MARKER), { recursive: true });
  writeFileSync(MARKER, value);
}

async function submit(urls) {
  const r = await fetch(INDEXNOW_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8", "user-agent": UA },
    body: JSON.stringify(buildPayload(BASE, urls)),
  });
  return { status: r.status, ...describeStatus(r.status) };
}

async function main() {
  // A key that is not reachable fails every batch with 403. One cheap GET up
  // front turns that into one clear message instead of N rejected batches.
  const keyUrl = keyLocation(BASE);
  let keyOk = false;
  try {
    keyOk = (await getText(keyUrl)).trim().length > 0;
  } catch {
    keyOk = false;
  }
  if (!keyOk) {
    console.error(`error: key file not readable at ${keyUrl}`);
    console.error("       Deploy the site before submitting — IndexNow verifies the key over HTTP.");
    process.exit(1);
  }
  log(`key file: ${keyUrl} OK`);

  const entries = await sitemapEntries(BASE);
  log(`sitemap: ${entries.length} URLs advertised`);

  const since = opt("--since", ALL ? null : readMarker());
  let selected = entries;
  if (since) {
    selected = entries.filter((e) => e.lastmod !== null && e.lastmod >= since);
    log(`changed on/after ${since}: ${selected.length}`);
  } else if (ALL) {
    log("--all: submitting every advertised URL");
  } else {
    log("no marker yet: treating this as a first run");
  }

  // Newest first, so a capped run spends its budget on the freshest pages.
  selected = [...selected].sort((a, b) => (b.lastmod ?? "").localeCompare(a.lastmod ?? ""));

  const bad = offHostUrls(BASE, selected.map((e) => e.loc));
  if (bad.length) {
    console.error(`error: ${bad.length} URLs are not on ${new URL(BASE).hostname}, e.g. ${bad[0]}`);
    console.error("       IndexNow rejects the whole request for one off-host URL; refusing to send.");
    process.exit(1);
  }

  let urls = selected.map((e) => e.loc);
  if (MAX > 0 && urls.length > MAX) {
    log(`capping at --max ${MAX} (${urls.length - MAX} left for the next run)`);
    urls = urls.slice(0, MAX);
  }

  if (urls.length === 0) {
    log("nothing to submit");
    return 0;
  }

  const batches = batchUrls(urls, INDEXNOW_MAX_URLS_PER_REQUEST);
  log(`${urls.length} URLs in ${batches.length} batch(es) of <=${INDEXNOW_MAX_URLS_PER_REQUEST}`);
  if (DRY) {
    log("--dry-run: not submitting. First 5 URLs:");
    for (const u of urls.slice(0, 5)) log(`  ${u}`);
    return 0;
  }

  let failed = 0;
  for (const [i, batch] of batches.entries()) {
    const r = await submit(batch);
    log(`  batch ${i + 1}/${batches.length} (${batch.length} URLs): ${r.status} ${r.meaning}`);
    if (!r.ok) failed++;
    // The protocol asks for restraint between bulk submissions; one second
    // between batches keeps a 32-batch seed well clear of the 429 threshold.
    if (i < batches.length - 1) await new Promise((res) => setTimeout(res, 1000));
  }

  if (failed > 0) {
    console.error(`${failed} of ${batches.length} batches rejected`);
    return 1;
  }
  // Marker is the newest lastmod actually submitted, not today: a URL changed
  // after the export but before this run must still be picked up next time.
  const newest = selected[0]?.lastmod;
  if (newest) {
    writeMarker(newest);
    log(`marker: ${newest}`);
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`indexnow-submit failed: ${err.message}`);
    process.exit(1);
  }
);
