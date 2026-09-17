#!/usr/bin/env node
/**
 * Submit every site in configs/indexnow-sites.kdl to IndexNow.
 *
 * Runs scripts/indexnow-submit.mjs once per site, so each site gets the same
 * guards (key reachable, no off-host URLs) and its own per-host marker. One
 * failing site does not stop the others; the exit code is non-zero if any site
 * failed, so cron mail or a wrapper sees it.
 *
 * Run it with the pipeline's tsx — the shared KDL parser uses TypeScript syntax
 * that Node's built-in type stripping rejects:
 *   packages/pipeline/node_modules/.bin/tsx scripts/indexnow-sites.mjs
 *
 * Usage: indexnow-sites.mjs [--config path] [extra args passed to each run]
 *   e.g. indexnow-sites.mjs --dry-run
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { parseKdl } from "../packages/pipeline/src/config/kdl.ts";

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const ci = argv.indexOf("--config");
const configPath = ci >= 0 ? argv[ci + 1] : resolve(here, "..", "configs", "indexnow-sites.kdl");
const passthrough = ci >= 0 ? argv.filter((_, i) => i !== ci && i !== ci + 1) : argv;

const sites = parseKdl(readFileSync(configPath, "utf8"))
  .nodes.filter((n) => n.name === "site")
  .map((n) => {
    const base = String(n.values[0] ?? "");
    const key = n.children.find((c) => c.name === "key")?.values[0];
    if (!base || !key) throw new Error(`${configPath}: site node needs a URL argument and a key child (got ${base || "no URL"})`);
    return { base, key: String(key) };
  });

let failed = 0;
for (const { base, key } of sites) {
  console.log(`\n=== ${base} ${new Date().toISOString()}`);
  const r = spawnSync(
    process.execPath,
    [resolve(here, "indexnow-submit.mjs"), "--base", base, "--key", key, ...passthrough],
    { stdio: "inherit" }
  );
  if (r.status !== 0) {
    failed++;
    console.error(`=== ${base} FAILED (exit ${r.status})`);
  }
}
console.log(`\n${sites.length - failed}/${sites.length} sites ok`);
process.exit(failed ? 1 : 0);
