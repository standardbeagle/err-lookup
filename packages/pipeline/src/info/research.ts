import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { ClusterCandidate } from "./collector.js";
import type { ClusterSample, ClusterEvidence } from "./prompts.js";

/**
 * Evidence gathering for a background article.
 *
 * The first version took the 30 longest-documented records of a family, which
 * reliably returned one verbose repository's view of it — the article then
 * generalized from a single library while claiming to cover the family. What
 * makes an article about a *family* worth writing is the spread: which
 * libraries raise it, under which codes and classes, and where they disagree.
 * So the sample is stratified by repository first and depth second, and the
 * distribution ships alongside it as counted facts the model cannot invent.
 */

/** Records taken from any single repository, however well documented it is. */
const PER_REPO_CAP = 4;

function clusterWhere(cluster: ClusterCandidate) {
  return cluster.kind === "code"
    ? sql`error_code = ${cluster.value}`
    : cluster.kind === "class"
      ? sql`(error_code IS NULL OR error_code = '') AND error_class = ${cluster.value}`
      : sql`background_tag = ${cluster.value}`;
}

interface SampleRow {
  id: string;
  repo: string;
  error_message: string;
  error_code: string | null;
  error_class: string | null;
  documentation: string | null;
  trigger_scenarios: string | null;
  solutions: string | null;
  prevention_tips: string | null;
  rn: number;
}

/**
 * The family's best-documented records, spread across repositories.
 *
 * Rank within each repo first, then take rank 1 from every repo before rank 2
 * from any — a family in 30 libraries yields 30 different libraries' wording
 * rather than one library's ten longest entries.
 */
export function sampleCluster(db: Db, cluster: ClusterCandidate, limit = 30): ClusterSample[] {
  const rows = db.all<SampleRow>(sql`
    SELECT id, repo, error_message, error_code, error_class,
           documentation, trigger_scenarios, solutions, prevention_tips, rn
    FROM (
      SELECT *, ROW_NUMBER() OVER (
               PARTITION BY repo
               ORDER BY length(coalesce(documentation, '')) DESC, id ASC
             ) AS rn
      FROM errors WHERE ${clusterWhere(cluster)}
    )
    WHERE rn <= ${PER_REPO_CAP}
    ORDER BY rn ASC, length(coalesce(documentation, '')) DESC, id ASC
    LIMIT ${limit}
  `);
  return rows.map((r) => ({
    id: r.id,
    repo: r.repo,
    message: r.error_message.slice(0, 300),
    code: r.error_code,
    errorClass: r.error_class,
    documentation: (r.documentation ?? "").slice(0, 1200),
    triggerScenarios: (r.trigger_scenarios ?? "").slice(0, 600),
    solutions: (JSON.parse(r.solutions ?? "[]") as string[]).slice(0, 5),
    preventionTips: (JSON.parse(r.prevention_tips ?? "[]") as string[]).slice(0, 5),
  }));
}

interface CountRow {
  value: string | null;
  n: number;
}

/**
 * Counted facts about the family: who raises it, under what names, and how
 * the corpus says it should be handled. These are the claims an article most
 * wants to make ("mostly a Go/Rust concern", "usually surfaced as a
 * ValidationError") and exactly the claims a 30-record sample invites it to
 * guess at.
 */
export function clusterEvidence(db: Db, cluster: ClusterCandidate): ClusterEvidence {
  const where = clusterWhere(cluster);
  const top = (column: string, limit: number): CountRow[] =>
    db.all<CountRow>(sql`
      SELECT ${sql.raw(column)} AS value, count(*) AS n
      FROM errors WHERE ${where} AND ${sql.raw(column)} IS NOT NULL AND ${sql.raw(column)} != ''
      GROUP BY value ORDER BY n DESC, value ASC LIMIT ${limit}
    `);

  const repos = db.all<CountRow>(sql`
    SELECT repo AS value, count(*) AS n
    FROM errors WHERE ${where}
    GROUP BY repo ORDER BY n DESC, value ASC LIMIT 15
  `);
  const withoutSolutions = db.all<{ n: number }>(sql`
    SELECT count(*) AS n FROM errors
    WHERE ${where} AND (solutions IS NULL OR solutions = '[]')
  `)[0]?.n ?? 0;

  return {
    repos: repos.map((r) => ({ repo: r.value ?? "", errorCount: r.n })),
    codes: top("error_code", 10).map((r) => ({ value: r.value ?? "", errorCount: r.n })),
    classes: top("error_class", 10).map((r) => ({ value: r.value ?? "", errorCount: r.n })),
    handlingStrategies: top("handling_strategy", 6).map((r) => ({ value: r.value ?? "", errorCount: r.n })),
    severities: top("severity", 5).map((r) => ({ value: r.value ?? "", errorCount: r.n })),
    undocumentedCount: withoutSolutions,
  };
}
