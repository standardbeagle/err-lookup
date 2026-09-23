import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { CANONICAL_FAMILIES, CANONICAL_TAGS, normalizeTag, tagKey, type CanonicalFamily } from "@errlookup/schema";
import type { Db } from "../db/client.js";
import { pageTagDecisions } from "../db/schema.js";
import type { TypeSafeClient } from "../provider/typesafe.js";
import { mapPool } from "../util/pool.js";
import { contentFamily } from "./tag-shape.js";
import {
  classifyPagesFlat,
  rowToPage,
  pagesPerRequest,
  PAGES_PER_REQUEST,
  type Page,
  type PageDecision,
  type StateField,
} from "./tag-page.js";

/**
 * The production family pass: every page gets a decision against the
 * current taxonomy, by rule where a rule is precise and by the typed
 * classifier otherwise.
 *
 * Decisions are stored per page with the classifier's top choice and its
 * confidence (`page_tag_decisions`); what gets published is decided later,
 * by `publishedFamily`, against the gate below. The pass is resumable — a
 * page with a decision at the current taxonomy version is never asked about
 * again — and a changed taxonomy makes every page pending once more.
 *
 * The constants below are the reviewable surface of this file. They were
 * set from the ablation in docs/tag-consolidation-2026-09-22.md; re-measure
 * with scripts/tag-ablation.ts when the taxonomy or the pinned model moves.
 */

/** Sections of a page the classifier reads. */
export const CLASSIFY_STATE: readonly StateField[] = ["message", "signals", "documentation"];

/**
 * Minimum confidence to publish a model's choice. Below it the page carries
 * no family: a wrong family files the page under an article that does not
 * describe it, and nothing downstream ever questions it again.
 */
export const CONFIDENCE_THRESHOLD = 0.55;

/**
 * Whether a proposed name that folds by spelling onto a declared family
 * settles the page without a model call.
 */
export const TRUST_NAME_RULE = false;

/** Requests in flight. Jev allows 1,200 a minute; eight pages ride in each. */
export const CLASSIFY_CONCURRENCY = 8;

/** Pages read from the database per round of classification. */
const PAGE_CHUNK = PAGES_PER_REQUEST * CLASSIFY_CONCURRENCY * 8;

const CANONICAL_BY_KEY: Map<string, string> = new Map(CANONICAL_FAMILIES.map((f) => [tagKey(f.tag), f.tag]));

/**
 * The family a proposed name folds onto by spelling alone, or null when the
 * fold lands outside the taxonomy.
 */
export function ruleFold(proposal: string): string | null {
  const tag = normalizeTag(proposal);
  if (!tag) return null;
  if (CANONICAL_TAGS.has(tag)) return tag;
  const key = tagKey(tag);
  if (!key) return null;
  return CANONICAL_BY_KEY.get(key) ?? null;
}

/**
 * Identity of a taxonomy: a hash of its families and rubrics. A rubric edit
 * changes what the classifier would say, so it changes the version too.
 */
export function taxonomyVersion(families: readonly CanonicalFamily[] = CANONICAL_FAMILIES): string {
  const canonical = families.map((f) => [f.tag, f.criteria]);
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex").slice(0, 12);
}

/** A stored decision, as the publication rule needs it. */
export interface StoredDecision {
  choice: string | null;
  method: "rule-content" | "rule-name" | "model" | "manual";
  confidence: number | null;
}

/** The family a decision publishes: rules and hand decisions as made, model choices above the gate. */
export function publishedFamily(d: StoredDecision, gate = CONFIDENCE_THRESHOLD): string | null {
  if (d.choice === null) return null;
  if (d.method !== "model") return d.choice;
  return (d.confidence ?? 0) >= gate ? d.choice : null;
}

/** A rule that settles a page without a model, or null. */
export function ruleDecision(page: Page): { choice: string; method: "rule-content" | "rule-name" } | null {
  const byContent = contentFamily(page);
  if (byContent) return { choice: byContent.family, method: "rule-content" };
  if (TRUST_NAME_RULE && page.proposal) {
    const byName = ruleFold(page.proposal);
    if (byName) return { choice: byName, method: "rule-name" };
  }
  return null;
}

/**
 * Pages with no decision at this taxonomy version, in id order after `after`.
 * Keyset rather than offset, so reading the next chunk does not re-walk every
 * page decided so far.
 */
export function pendingPages(db: Db, version: string, limit: number, after = ""): Page[] {
  return db
    .all<Parameters<typeof rowToPage>[0]>(sql`
      SELECT e.id, e.repo, e.error_message, e.error_class, e.error_code, e.http_status, e.error_type,
             e.documentation, e.trigger_scenarios, e.common_situations, e.background_tag_raw
      FROM errors e
      LEFT JOIN page_tag_decisions d ON d.error_id = e.id AND d.taxonomy_version = ${version}
      WHERE d.error_id IS NULL AND e.id > ${after}
      ORDER BY e.id
      LIMIT ${limit}
    `)
    .map(rowToPage);
}

export function pendingCount(db: Db, version: string): number {
  return (
    db.all<{ n: number }>(sql`
      SELECT count(*) AS n FROM errors e
      LEFT JOIN page_tag_decisions d ON d.error_id = e.id AND d.taxonomy_version = ${version}
      WHERE d.error_id IS NULL
    `)[0]?.n ?? 0
  );
}

interface NewDecision {
  errorId: string;
  choice: string | null;
  method: StoredDecision["method"];
  confidence: number | null;
  runnerUp: string | null;
  model: string | null;
}

/** Write one batch of decisions in one small transaction. */
export function storePageDecisions(db: Db, version: string, rows: NewDecision[]): void {
  if (rows.length === 0) return;
  const decidedAt = new Date().toISOString();
  db.transaction((tx) => {
    for (const r of rows) {
      const values = { ...r, taxonomyVersion: version, decidedAt };
      tx.insert(pageTagDecisions)
        .values(values)
        .onConflictDoUpdate({ target: pageTagDecisions.errorId, set: values })
        .run();
    }
  });
}

export interface ClassifyProgress {
  decided: number;
  pending: number;
}

export interface ClassifyResult {
  byRule: number;
  byModel: number;
  /** Model decisions below the gate or "none of these": pages that will publish no family. */
  unplaced: number;
  calls: number;
  inputTokens: number;
}

/**
 * Decide every pending page. A classification failure stops the run: every
 * batch already written is durable, so the rerun resumes where this one died,
 * and a run that skipped its failures would look complete while leaving
 * pages undecided.
 */
export async function classifyPendingPages(
  db: Db,
  client: TypeSafeClient,
  opts: { limit?: number; onProgress?: (p: ClassifyProgress) => void } = {}
): Promise<ClassifyResult> {
  const version = taxonomyVersion();
  const total = Math.min(pendingCount(db, version), opts.limit ?? Number.POSITIVE_INFINITY);
  const result: ClassifyResult = { byRule: 0, byModel: 0, unplaced: 0, calls: 0, inputTokens: 0 };
  const startCalls = client.calls;
  const startTokens = client.inputTokens;
  let decided = 0;
  let after = "";

  while (decided < total) {
    const chunk = pendingPages(db, version, Math.min(PAGE_CHUNK, total - decided), after);
    if (chunk.length === 0) break;
    after = chunk[chunk.length - 1]!.id;

    const forModel: Page[] = [];
    const ruled: NewDecision[] = [];
    for (const page of chunk) {
      const rule = ruleDecision(page);
      if (rule) ruled.push({ errorId: page.id, choice: rule.choice, method: rule.method, confidence: null, runnerUp: null, model: null });
      else forModel.push(page);
    }
    storePageDecisions(db, version, ruled);
    result.byRule += ruled.length;

    const perRequest = pagesPerRequest(CANONICAL_FAMILIES);
    const batches: Page[][] = [];
    for (let i = 0; i < forModel.length; i += perRequest) batches.push(forModel.slice(i, i + perRequest));
    await mapPool(batches, CLASSIFY_CONCURRENCY, async (batch) => {
      const decisions: PageDecision[] = await classifyPagesFlat(client, batch, CLASSIFY_STATE);
      storePageDecisions(
        db,
        version,
        decisions.map((d) => ({
          errorId: d.id,
          choice: d.choice,
          method: "model" as const,
          confidence: d.confidence,
          runnerUp: d.runnerUp,
          model: d.model,
        }))
      );
      result.byModel += decisions.length;
      result.unplaced += decisions.filter((d) => publishedFamily({ ...d, method: "model" }) === null).length;
    });

    decided += chunk.length;
    opts.onProgress?.({ decided, pending: total });
  }
  result.calls = client.calls - startCalls;
  result.inputTokens = client.inputTokens - startTokens;
  return result;
}

/**
 * Published families of already-decided pages, by record id. The write path
 * reads this so re-analysing a repo keeps the families its pages were given
 * instead of blanking them until the next classify run.
 */
export function pageFamiliesFor(db: Db, ids: readonly string[]): Map<string, string | null> {
  if (ids.length === 0) return new Map();
  const version = taxonomyVersion();
  const out = new Map<string, string | null>();
  for (let i = 0; i < ids.length; i += 500) {
    const slice = ids.slice(i, i + 500);
    const rows = db.all<{ error_id: string; choice: string | null; method: StoredDecision["method"]; confidence: number | null }>(sql`
      SELECT error_id, choice, method, confidence FROM page_tag_decisions
      WHERE taxonomy_version = ${version} AND error_id IN (${sql.join(slice.map((id) => sql`${id}`), sql`, `)})
    `);
    for (const r of rows) out.set(r.error_id, publishedFamily(r));
  }
  return out;
}

export interface UnplacedGroup {
  proposal: string | null;
  pages: number;
  repos: number;
  /** The classifier's most common top choice for these pages, below the gate. */
  nearest: string | null;
}

/**
 * Pages that publish no family, grouped by the name their enrichment model
 * proposed. This is the taxonomy's growth queue: a name with thousands of
 * unplaced pages behind it is the evidence for a new family, and a group
 * whose nearest choice is consistent says the gate or a rubric is the
 * problem rather than the taxonomy.
 */
export function unplacedPages(db: Db, limit = 40, gate = CONFIDENCE_THRESHOLD): UnplacedGroup[] {
  const version = taxonomyVersion();
  return db.all<UnplacedGroup>(sql`
    SELECT e.background_tag_raw AS proposal,
           count(*) AS pages,
           count(DISTINCT e.repo) AS repos,
           (SELECT d2.choice FROM page_tag_decisions d2 JOIN errors e2 ON e2.id = d2.error_id
            WHERE d2.taxonomy_version = ${version} AND e2.background_tag_raw IS e.background_tag_raw AND d2.choice IS NOT NULL
            GROUP BY d2.choice ORDER BY count(*) DESC LIMIT 1) AS nearest
    FROM page_tag_decisions d
    JOIN errors e ON e.id = d.error_id
    WHERE d.taxonomy_version = ${version}
      AND (d.choice IS NULL OR (d.method = 'model' AND coalesce(d.confidence, 0) < ${gate}))
    GROUP BY e.background_tag_raw
    ORDER BY pages DESC
    LIMIT ${limit}
  `);
}
