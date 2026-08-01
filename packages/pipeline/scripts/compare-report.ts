/**
 * Compare analysis quality across provider/model runs stored in separate DBs.
 *
 * usage: tsx scripts/compare-report.ts <label>=<dbPath> [<label>=<dbPath> ...] [--repo owner/name]
 *
 * Emits a markdown table of per-run metrics: record counts, phase wall times,
 * and quality proxies (doc length, solutions, defensive coverage). Read-only.
 */
import Database from "better-sqlite3";

interface RunMetrics {
  label: string;
  records: number;
  withCode: number;
  avgDocChars: number;
  shortDocs: number; // documentation < 100 chars
  avgSolutions: number;
  noSolutions: number;
  withExampleFix: number;
  withSource: number;
  withDefense: number;
  avgPreventionTips: number;
  avgTags: number;
  phaseMs: Record<string, number>;
}

function metricsFor(label: string, dbPath: string, repo?: string): RunMetrics {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  const where = repo ? `WHERE repo = ?` : "";
  const params = repo ? [repo] : [];
  const rows = db
    .prepare(
      `SELECT error_code, documentation, solutions, example_fix, source_code,
              handling_strategy, prevention_tips, tags
       FROM errors ${where}`
    )
    .all(...params) as {
    error_code: string | null;
    documentation: string;
    solutions: string;
    example_fix: string | null;
    source_code: string | null;
    handling_strategy: string | null;
    prevention_tips: string;
    tags: string;
  }[];

  const jobs = db
    .prepare(
      `SELECT phase, SUM(duration_ms) AS ms FROM job_history
       WHERE status = 'success' ${repo ? "AND repo = ?" : ""} GROUP BY phase`
    )
    .all(...params) as { phase: string; ms: number }[];
  db.close();

  const arr = (s: string): unknown[] => {
    try {
      const v = JSON.parse(s);
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  };

  const n = rows.length || 1;
  return {
    label,
    records: rows.length,
    withCode: rows.filter((r) => r.error_code).length,
    avgDocChars: Math.round(rows.reduce((a, r) => a + r.documentation.length, 0) / n),
    shortDocs: rows.filter((r) => r.documentation.length < 100).length,
    avgSolutions: +(rows.reduce((a, r) => a + arr(r.solutions).length, 0) / n).toFixed(1),
    noSolutions: rows.filter((r) => arr(r.solutions).length === 0).length,
    withExampleFix: rows.filter((r) => r.example_fix).length,
    withSource: rows.filter((r) => r.source_code).length,
    withDefense: rows.filter((r) => r.handling_strategy).length,
    avgPreventionTips: +(rows.reduce((a, r) => a + arr(r.prevention_tips).length, 0) / n).toFixed(1),
    avgTags: +(rows.reduce((a, r) => a + arr(r.tags).length, 0) / n).toFixed(1),
    phaseMs: Object.fromEntries(jobs.map((j) => [j.phase, j.ms])),
  };
}

const args = process.argv.slice(2);
const repoIdx = args.indexOf("--repo");
const repo = repoIdx >= 0 ? args[repoIdx + 1] : undefined;
const specs = args.filter((a, i) => a.includes("=") && i !== repoIdx + 1);
if (specs.length === 0) {
  console.error("usage: tsx scripts/compare-report.ts label=db.sqlite ... [--repo owner/name]");
  process.exit(1);
}

const runs = specs.map((s) => {
  const [label, ...rest] = s.split("=");
  return metricsFor(label!, rest.join("="), repo);
});

const pct = (x: number, total: number) => (total === 0 ? "–" : `${Math.round((100 * x) / total)}%`);
const min = (ms?: number) => (ms == null ? "–" : `${(ms / 60000).toFixed(1)}m`);

const metricRows: [string, (r: RunMetrics) => string][] = [
  ["records", (r) => String(r.records)],
  ["with errorCode", (r) => pct(r.withCode, r.records)],
  ["avg doc chars", (r) => String(r.avgDocChars)],
  ["short docs (<100ch)", (r) => pct(r.shortDocs, r.records)],
  ["avg solutions", (r) => String(r.avgSolutions)],
  ["no solutions", (r) => pct(r.noSolutions, r.records)],
  ["example fix", (r) => pct(r.withExampleFix, r.records)],
  ["source extracted", (r) => pct(r.withSource, r.records)],
  ["defense strategy", (r) => pct(r.withDefense, r.records)],
  ["avg prevention tips", (r) => String(r.avgPreventionTips)],
  ["avg tags", (r) => String(r.avgTags)],
  ["discovery time", (r) => min(r.phaseMs.discovery)],
  ["enrichment time", (r) => min(r.phaseMs.enrichment)],
  ["defense time", (r) => min(r.phaseMs.defense)],
  ["verify time", (r) => min(r.phaseMs.verify)],
];

console.log(`# Model comparison${repo ? ` — ${repo}` : ""}\n`);
console.log(`| metric | ${runs.map((r) => r.label).join(" | ")} |`);
console.log(`|---|${runs.map(() => "---").join("|")}|`);
for (const [name, fn] of metricRows) {
  console.log(`| ${name} | ${runs.map(fn).join(" | ")} |`);
}
