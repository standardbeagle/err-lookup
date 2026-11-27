/**
 * Walk the built site and enforce the per-page budgets. Runs as the last step
 * of `pnpm build`, so a page that outgrows its budget fails the build rather
 * than reaching a crawler.
 *
 * Reads dist/ (or ERRLOOKUP_OUT_DIR, so a test build can audit its own output).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { auditPages, countLinks, formatAudit, type PageStat } from "../src/data/page-budget.js";

const dist = resolve(process.env.ERRLOOKUP_OUT_DIR || "dist");

function htmlFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) htmlFiles(p, out);
    else if (entry.name.endsWith(".html")) out.push(p);
  }
  return out;
}

let files: string[];
try {
  files = htmlFiles(dist);
} catch {
  console.error(`audit-dist: no build at ${dist} — run astro build first`);
  process.exit(1);
}

const stats: PageStat[] = files.map((f) => {
  const html = readFileSync(f, "utf8");
  return { path: relative(dist, f), bytes: statSync(f).size, links: countLinks(html) };
});

const result = auditPages(stats);
console.log(formatAudit(result));

if (result.failures > 0) {
  console.error(
    `\naudit-dist: ${result.failures} page(s) over budget. An oversized list page is a crawl-budget\n` +
      `problem before it is a performance one — it is usually the entry point a sitemap advertises.`
  );
  process.exit(1);
}
