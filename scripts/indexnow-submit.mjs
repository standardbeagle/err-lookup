#!/usr/bin/env node
/**
 * Submit changed URLs to IndexNow (Bing, Yandex, Seznam, Naver share one feed).
 *
 * Reads the LIVE sitemaps rather than dist/: the script runs after a successful
 * deploy, so the deployed sitemap is the only list that is certainly true, and
 * reading it over HTTP keeps this decoupled from whether a route prerenders.
 *
 * Which URLs: every advertised (URL, lastmod) pair the per-host ledger does
 * not hold yet — new pages, pages whose lastmod moved, and a capped run's
 * remainder — newest first. The ledger records only accepted batches; see
 * ledgerLine in packages/site/src/data/indexnow.ts for why it is not a date.
 *
 * Usage:
 *   indexnow-submit.mjs [--all] [--record-only] [--dry-run]
 *                       [--max N] [--base URL] [--key KEY]
 *
 *   --all          ignore the ledger and submit every advertised URL. For the
 *                  initial seed; paced in protocol-sized batches.
 *   --record-only  write every advertised URL into the ledger without
 *                  submitting — for URLs already sent by other means.
 *   --dry-run      resolve and count URLs, print the plan, submit nothing.
 *   --max N        ceiling on URLs submitted this run (default 10000, 0 = no
 *                  cap). The rest stay pending for the next run.
 *
 * Exit 0 on success or nothing-to-do; non-zero if any batch was rejected
 * (accepted batches are still recorded).
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { homedir } from "node:os";
import {
  INDEXNOW_KEY,
  INDEXNOW_ENDPOINT,
  INDEXNOW_MAX_URLS_PER_REQUEST,
  batchUrls,
  describeStatus,
  nextLedger,
  offHostUrls,
  pendingEntries,
} from "../packages/site/src/data/indexnow.ts";

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const BASE = (opt("--base", process.env.ERRLOOKUP_SITE || "https://errors.standardbeagle.com")).replace(/\/$/, "");
const ALL = flag("--all");
const RECORD_ONLY = flag("--record-only");
const DRY = flag("--dry-run");
const MAX = Number(opt("--max", process.env.ERRLOOKUP_INDEXNOW_MAX_URLS ?? "10000"));
// Each property carries its own key (configs/indexnow-sites.kdl), served from
// its own origin. A freshly published key answers 403 for a few minutes even
// while the file serves 200 — that is IndexNow catching up, so retry rather
// than rotating the key.
const KEY = opt("--key", process.env.ERRLOOKUP_INDEXNOW_KEY || INDEXNOW_KEY);
const LOG_DIR = process.env.ERRLOOKUP_LOG_DIR || resolve(homedir(), ".local/state/errlookup");
// One ledger per host: the scheduled run drives several sites from one state
// directory.
const LEDGER = resolve(LOG_DIR, `indexnow-sent-${new URL(BASE).hostname}.tsv`);
const UA = "errlookup-indexnow/1.0 (+https://errors.standardbeagle.com)";

const log = (...a) => console.log(...a);

async function getText(url) {
  const r = await fetch(url, { headers: { "user-agent": UA } });
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
  return r.text();
}

/**
 * Where this site publishes its sitemaps.
 *
 * robots.txt first, because it is the one place a site states this itself —
 * guessing paths gets it wrong across hosts (errlookup serves
 * /sitemap-index.xml, dev.standardbeagle.com a nested /sitemap.xml, WordPress
 * /sitemap_index.xml). The guesses are a fallback for a robots.txt that names
 * none.
 */
async function discoverSitemaps(base) {
  try {
    const robots = await getText(`${base}/robots.txt`);
    const declared = [...robots.matchAll(/^\s*Sitemap:\s*(\S+)\s*$/gim)].map((m) => m[1]);
    if (declared.length) return declared;
  } catch {
    // no robots.txt is not an error; fall through to the conventional paths
  }
  for (const guess of ["/sitemap-index.xml", "/sitemap_index.xml", "/sitemap.xml"]) {
    try {
      await getText(`${base}${guess}`);
      return [`${base}${guess}`];
    } catch {
      /* try the next */
    }
  }
  throw new Error(`no sitemap found for ${base} (robots.txt names none, and no conventional path answered)`);
}

/**
 * Every <url> entry reachable from `roots`, following <sitemapindex> children.
 *
 * Depth-bounded and visit-tracked: a sitemap index that lists itself, directly
 * or through a child, would otherwise fetch forever. Depth 3 covers
 * index -> project index -> shard, which is the deepest real nesting here.
 */
async function sitemapEntries(roots, maxDepth = 3) {
  const entries = [];
  const seen = new Set();

  async function walk(url, depth) {
    if (depth > maxDepth || seen.has(url)) return;
    seen.add(url);
    let xml;
    try {
      xml = await getText(url);
    } catch (e) {
      // One unreachable child must not lose the sitemaps that did answer.
      console.error(`  warn: ${e.message}`);
      return;
    }
    // A <sitemapindex> nests; a <urlset> is a leaf. Test the root element
    // rather than the presence of <loc>, which both documents carry.
    if (/<sitemapindex[\s>]/i.test(xml)) {
      const children = [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)].map((m) => m[1]);
      for (const child of children) await walk(child, depth + 1);
      return;
    }
    for (const m of xml.matchAll(/<url>[\s\S]*?<loc>\s*([^<]+?)\s*<\/loc>(?:[\s\S]*?<lastmod>\s*([^<]+?)\s*<\/lastmod>)?[\s\S]*?<\/url>/g)) {
      entries.push({ loc: m[1], lastmod: m[2] ?? null });
    }
  }

  for (const r of roots) await walk(r, 0);
  return entries;
}

/** Ledger lines, or an empty set when this host has never submitted. */
function readLedger() {
  let text;
  try {
    text = readFileSync(LEDGER, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return new Set();
    throw e;
  }
  return new Set(text.split("\n").filter(Boolean));
}

/** Write-then-rename, so a crash mid-write cannot leave a truncated ledger. */
function writeLedger(lines) {
  mkdirSync(dirname(LEDGER), { recursive: true });
  const tmp = `${LEDGER}.tmp`;
  writeFileSync(tmp, lines.length ? `${lines.join("\n")}\n` : "");
  renameSync(tmp, LEDGER);
}

async function submit(urls) {
  const r = await fetch(INDEXNOW_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8", "user-agent": UA },
    body: JSON.stringify({
      host: new URL(BASE).hostname,
      key: KEY,
      keyLocation: `${BASE}/${KEY}.txt`,
      urlList: [...urls],
    }),
  });
  return { status: r.status, ...describeStatus(r.status, KEY) };
}

async function main() {
  // A key that is not reachable fails every batch with 403. One cheap GET up
  // front turns that into one clear message instead of N rejected batches.
  const keyUrl = `${BASE}/${KEY}.txt`;
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

  const roots = await discoverSitemaps(BASE);
  log(`sitemaps: ${roots.map((r) => r.replace(BASE, "")).join(", ")}`);
  const entries = await sitemapEntries(roots);
  log(`sitemap: ${entries.length} URLs advertised`);

  const bad = offHostUrls(BASE, entries.map((e) => e.loc));
  if (bad.length) {
    console.error(`error: ${bad.length} URLs are not on ${new URL(BASE).hostname}, e.g. ${bad[0]}`);
    console.error("       IndexNow rejects the whole request for one off-host URL; refusing to send.");
    process.exit(1);
  }

  const sent = readLedger();
  if (RECORD_ONLY) {
    const lines = nextLedger(entries, sent, entries);
    if (DRY) {
      log(`--record-only --dry-run: would record ${lines.length} URLs in ${LEDGER}`);
      return 0;
    }
    writeLedger(lines);
    log(`--record-only: recorded ${lines.length} URLs in ${LEDGER}, submitted nothing`);
    return 0;
  }
  let selected = pendingEntries(entries, ALL ? new Set() : sent);
  log(`${ALL ? "--all: every advertised URL" : `not yet sent at this lastmod (ledger ${sent.size})`}: ${selected.length}`);

  if (MAX > 0 && selected.length > MAX) {
    log(`capping at --max ${MAX} (${selected.length - MAX} stay pending for the next run)`);
    selected = selected.slice(0, MAX);
  }
  const urls = selected.map((e) => e.loc);

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
  let accepted = [];
  for (const [i, batch] of batches.entries()) {
    const r = await submit(batch);
    log(`  batch ${i + 1}/${batches.length} (${batch.length} URLs): ${r.status} ${r.meaning}`);
    // Batches are consecutive slices of `selected`, so batch i is this range.
    // concat, not push(...): a 10k-element spread is how the index export
    // blew the stack.
    const from = i * INDEXNOW_MAX_URLS_PER_REQUEST;
    if (r.ok) accepted = accepted.concat(selected.slice(from, from + batch.length));
    else failed++;
    // The protocol asks for restraint between bulk submissions; one second
    // between batches keeps a 32-batch seed well clear of the 429 threshold.
    if (i < batches.length - 1) await new Promise((res) => setTimeout(res, 1000));
  }

  // Record accepted batches even when another was rejected: the rejected
  // URLs stay pending, the accepted ones must not go out twice.
  const lines = nextLedger(entries, sent, accepted);
  writeLedger(lines);
  log(`ledger: ${lines.length} URLs recorded`);
  if (failed > 0) {
    console.error(`${failed} of ${batches.length} batches rejected`);
    return 1;
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
