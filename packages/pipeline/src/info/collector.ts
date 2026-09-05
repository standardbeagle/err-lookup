import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import {
  GUIDES,
  guidesFor,
  validateInfoPageEntry,
  flattenZodError,
  INFO_PAGE_SCHEMA_VERSION,
  type InfoPageEntry,
} from "@errlookup/schema";
import type { Db } from "../db/client.js";
import { infoPages } from "../db/schema.js";
import type { ErrlookupConfig } from "../config/index.js";
import type { LlmProvider } from "../provider/types.js";
import { runProvider, watchdogBudgetMs } from "../provider/run.js";
import { withTimeout } from "../util/watchdog.js";
import { mapPool } from "../util/pool.js";
import { infoPagePrompt, type InfoPageDraft, type ClusterSample } from "./prompts.js";
import { sampleCluster, clusterEvidence } from "./research.js";
import { validateDraft, reviewPrompt, type DraftReview } from "./review.js";

/**
 * Info-page collector: turns clusters of related error records into
 * cross-repo background articles ("info pages").
 *
 * Where an error page documents one throw site, an info page covers the whole
 * family — the background a single-record summary cannot give: mechanism,
 * common causes distilled across every repo's documentation, remediation
 * themes, and link-outs to the failure-class guides.
 *
 * Clustering is plain SQL over the working DB: errors sharing an error code
 * form one family; errors without a code fall back to their error class. Only
 * clusters big enough to say something general about (>= minErrors records
 * across >= minRepos repos) qualify. `cluster_key` makes the run idempotent —
 * a scheduled run only writes pages for clusters that gained one since — and
 * `maxPages` bounds LLM spend per run so the page set grows gradually.
 */

export interface CollectOptions {
  /** New pages per run (bounds LLM spend; the schedule provides the volume). */
  maxPages?: number;
  /** A cluster qualifies with at least this many error records… */
  minErrors?: number;
  /** …spread across at least this many repos (one repo's quirk is not a family). */
  minRepos?: number;
  onLog?: (msg: string) => void;
}

export interface ClusterCandidate {
  /** "code:ECONNREFUSED", "class:TypeError", or "tag:connection-refused" — the idempotency key. */
  key: string;
  kind: "code" | "class" | "tag";
  value: string;
  errorCount: number;
  repoCount: number;
}

/**
 * Class/tag values too generic to write a family article about — the first
 * collector run spent its page on class:Error (3,783 records). Codes are
 * inherently specific and are not filtered.
 */
const GENERIC_FAMILIES = new Set([
  "error",
  "errors",
  "exception",
  "exceptions",
  "baseexception",
  "throwable",
  "runtimeerror",
  "runtimeexception",
  "failure",
  "failures",
  "unknown",
]);

function isGenericFamily(value: string): boolean {
  return GENERIC_FAMILIES.has(value.toLowerCase());
}

interface ClusterRow {
  key: string;
  value: string;
  n: number;
  r: number;
}

/** Qualifying clusters that do not have an info page yet, biggest first. */
export function findNewClusters(
  db: Db,
  opts: { minErrors: number; minRepos: number; limit: number }
): ClusterCandidate[] {
  const existing = new Set(
    db
      .select({ clusterKey: infoPages.clusterKey })
      .from(infoPages)
      .all()
      .map((r) => r.clusterKey)
  );

  const byCode = db.all<ClusterRow>(sql`
    SELECT 'code:' || error_code AS key, error_code AS value,
           count(*) AS n, count(DISTINCT repo) AS r
    FROM errors
    WHERE error_code IS NOT NULL AND error_code != ''
    GROUP BY error_code
    HAVING n >= ${opts.minErrors} AND r >= ${opts.minRepos}
  `);
  const byClass = db.all<ClusterRow>(sql`
    SELECT 'class:' || error_class AS key, error_class AS value,
           count(*) AS n, count(DISTINCT repo) AS r
    FROM errors
    WHERE (error_code IS NULL OR error_code = '') AND error_class IS NOT NULL AND error_class != ''
    GROUP BY error_class
    HAVING n >= ${opts.minErrors} AND r >= ${opts.minRepos}
  `);
  // Enrichment names each record's cross-library family in background_tag —
  // families that codes and classes cannot see (a "connection-refused" thrown
  // as plain Error). Tag clusters cut across the other two, so an error can
  // belong to both a code page and a tag page; the pages answer different
  // questions and the slugs cannot collide silently (clusterSlug suffixes).
  const byTag = db.all<ClusterRow>(sql`
    SELECT 'tag:' || background_tag AS key, background_tag AS value,
           count(*) AS n, count(DISTINCT repo) AS r
    FROM errors
    WHERE background_tag IS NOT NULL AND background_tag != ''
    GROUP BY background_tag
    HAVING n >= ${opts.minErrors} AND r >= ${opts.minRepos}
  `);

  return [
    ...byCode.map((c): ClusterCandidate => ({ ...rowToCandidate(c), kind: "code" })),
    ...byClass.map((c): ClusterCandidate => ({ ...rowToCandidate(c), kind: "class" })),
    ...byTag.map((c): ClusterCandidate => ({ ...rowToCandidate(c), kind: "tag" })),
  ]
    .filter((c) => !existing.has(c.key))
    .filter((c) => c.kind === "code" || !isGenericFamily(c.value))
    .sort((a, b) => b.errorCount - a.errorCount)
    .slice(0, opts.limit);
}

function rowToCandidate(c: ClusterRow): Omit<ClusterCandidate, "kind"> {
  return { key: c.key, value: c.value, errorCount: c.n, repoCount: c.r };
}

const SLUG_MAX = 60;

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, SLUG_MAX)
      .replace(/-+$/, "") || "cluster"
  );
}

/** Deterministic slug per cluster; kind-suffixed on the rare code/class collision. */
function clusterSlug(cluster: ClusterCandidate, taken: Set<string>): string | null {
  const base = slugify(cluster.value);
  for (const candidate of [base, `${base}-${cluster.kind}`]) {
    if (!taken.has(candidate)) return candidate;
  }
  return null;
}

export interface CollectResult {
  /** Slugs written this run. */
  created: string[];
  /** Qualifying clusters that still lack a page after this run. */
  remaining: number;
  failed: number;
}

export async function collectInfoPages(
  db: Db,
  providers: Record<string, LlmProvider>,
  cfg: ErrlookupConfig,
  opts: CollectOptions = {}
): Promise<CollectResult> {
  const { maxPages = 5, minErrors = 5, minRepos = 2, onLog } = opts;
  // Over-fetch by one page so `remaining` can report a non-empty backlog.
  const clusters = findNewClusters(db, { minErrors, minRepos, limit: maxPages + 1 });
  const batch = clusters.slice(0, maxPages);
  if (batch.length === 0) {
    onLog?.("info-collect: no new qualifying clusters");
    return { created: [], remaining: 0, failed: 0 };
  }
  onLog?.(
    `info-collect: ${batch.length} new clusters (${batch.map((c) => c.key).join(", ")})`
  );

  // Slugs are assigned up front, serially, so concurrent page generation can
  // never race two clusters onto one slug (code:FOO vs class:FOO).
  const taken = new Set(db.select({ slug: infoPages.slug }).from(infoPages).all().map((r) => r.slug));
  const slugByKey = new Map<string, string>();
  for (const c of batch) {
    const s = clusterSlug(c, taken);
    if (s === null) {
      onLog?.(`info-collect: ${c.key} skipped — slug space exhausted for "${c.value}"`);
      continue;
    }
    taken.add(s);
    slugByKey.set(c.key, s);
  }

  // The agent gets a scratch cwd — it only writes its JSON output file there.
  const cwd = mkdtempSync(join(tmpdir(), "errlookup-info-"));
  const budget = watchdogBudgetMs(cfg, "enrichment");
  let failed = 0;
  const created: string[] = [];
  try {
    await mapPool([...slugByKey.keys()], cfg.defaults.batchConcurrency, async (key) => {
      const cluster = batch.find((c) => c.key === key)!;
      try {
        const samples = sampleCluster(db, cluster);
        const evidence = clusterEvidence(db, cluster);

        const draft = await draftPage(cluster, samples, evidence, providers, cfg, cwd, budget, onLog);
        if (!draft) {
          failed++;
          return;
        }
        const reviewed = await reviewPage(cluster, samples, draft, providers, cfg, cwd, budget, onLog);
        if (!reviewed) {
          failed++;
          return;
        }

        const entry = draftToEntry(cluster, samples, reviewed, slugByKey.get(key)!);
        const v = validateInfoPageEntry(entry);
        if (!v.ok) {
          failed++;
          onLog?.(`info-collect: ${cluster.key} rejected — ${flattenZodError(v.error).slice(0, 3).join("; ")}`);
          return;
        }
        db.insert(infoPages)
          .values({
            slug: v.value.slug,
            clusterKey: v.value.clusterKey,
            title: v.value.title,
            summary: v.value.summary,
            background: v.value.background,
            commonCauses: v.value.commonCauses,
            fixes: v.value.fixes,
            guideSlugs: v.value.guideSlugs,
            errorIds: v.value.errorIds,
            errorCount: v.value.errorCount,
            repoCount: v.value.repoCount,
            generatedAt: v.value.generatedAt,
          })
          .run();
        created.push(v.value.slug);
        onLog?.(`info-collect: wrote /info/${v.value.slug}/ (${cluster.key}, ${cluster.errorCount} errors, ${cluster.repoCount} repos)`);
      } catch (err) {
        failed++;
        const msg = err instanceof Error ? err.message : String(err);
        onLog?.(`info-collect: ${cluster.key} failed: ${msg.slice(0, 300)}`);
      }
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }

  return { created, remaining: clusters.length - batch.length + failed, failed };
}

/**
 * Draft the article, then hold it to the deterministic checks. One repair
 * round: the issues are named in the retry prompt, because a model that is
 * told "background must be at least 2 paragraphs" fixes it, and a model told
 * "try again" rewrites the parts that were fine.
 */
async function draftPage(
  cluster: ClusterCandidate,
  samples: ClusterSample[],
  evidence: ReturnType<typeof clusterEvidence>,
  providers: Record<string, LlmProvider>,
  cfg: ErrlookupConfig,
  cwd: string,
  budget: number,
  onLog?: (msg: string) => void
): Promise<InfoPageDraft | null> {
  let issues: string[] = [];
  for (let round = 0; round < 2; round++) {
    const result = await withTimeout(
      runProvider(infoPagePrompt(cluster, samples, GUIDES, evidence, issues), { cwd }, providers, cfg, "enrichment"),
      budget
    );
    const draft = result.parsed as InfoPageDraft;
    issues = validateDraft(draft, cluster, samples);
    if (issues.length === 0) return draft;
    onLog?.(
      `info-collect: ${cluster.key} draft round ${round + 1} failed validation — ${issues.slice(0, 3).join("; ")}`
    );
  }
  onLog?.(`info-collect: ${cluster.key} abandoned — validation still failing after a repair round`);
  return null;
}

/**
 * Adversarial second opinion, routed to the review provider. An accepted
 * draft ships; a revision must clear the same deterministic checks before it
 * does, so the reviewer cannot introduce the shape problems it was fixing.
 */
async function reviewPage(
  cluster: ClusterCandidate,
  samples: ClusterSample[],
  draft: InfoPageDraft,
  providers: Record<string, LlmProvider>,
  cfg: ErrlookupConfig,
  cwd: string,
  budget: number,
  onLog?: (msg: string) => void
): Promise<InfoPageDraft | null> {
  const result = await withTimeout(
    runProvider(reviewPrompt(cluster, samples, draft), { cwd }, providers, cfg, "review"),
    budget
  );
  const review = result.parsed as DraftReview;
  if (review?.verdict === "accept") return draft;

  const issues = (review?.issues ?? []).map(String);
  if (!review?.revision) {
    onLog?.(
      `info-collect: ${cluster.key} rejected by review, no revision offered — ${issues.slice(0, 3).join("; ") || "no reason given"}`
    );
    return null;
  }
  const remaining = validateDraft(review.revision, cluster, samples);
  if (remaining.length > 0) {
    onLog?.(`info-collect: ${cluster.key} revision failed validation — ${remaining.slice(0, 3).join("; ")}`);
    return null;
  }
  onLog?.(`info-collect: ${cluster.key} revised by review — ${issues.slice(0, 2).join("; ")}`);
  return review.revision;
}

const MAX_ERROR_IDS = 50;

function draftToEntry(
  cluster: ClusterCandidate,
  samples: ClusterSample[],
  draft: InfoPageDraft,
  slug: string
): InfoPageEntry {
  const knownGuides = new Set(GUIDES.map((g) => g.slug));
  // Union of what the model chose (filtered to real guides) and what the
  // deterministic matcher finds for the family — same matcher the site uses.
  const guideSlugs = new Set((draft.guideSlugs ?? []).filter((s) => knownGuides.has(s)));
  const code = cluster.kind === "code" ? cluster.value : null;
  for (const s of samples) for (const g of guidesFor(code, s.message)) guideSlugs.add(g.slug);

  return {
    slug,
    clusterKey: cluster.key,
    title: String(draft.title ?? ""),
    summary: String(draft.summary ?? ""),
    background: String(draft.background ?? ""),
    commonCauses: (draft.commonCauses ?? []).map((c) => ({
      cause: String(c?.cause ?? ""),
      detail: String(c?.detail ?? ""),
    })),
    fixes: (draft.fixes ?? []).map(String),
    guideSlugs: [...guideSlugs].sort(),
    errorIds: samples.slice(0, MAX_ERROR_IDS).map((s) => s.id),
    errorCount: cluster.errorCount,
    repoCount: cluster.repoCount,
    generatedAt: new Date().toISOString(),
    schemaVersion: INFO_PAGE_SCHEMA_VERSION,
  };
}
