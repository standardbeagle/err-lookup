import { sql } from "drizzle-orm";
import { buildTagIndex, resolveTag, type TagFamily } from "@errlookup/schema";
import type { Db } from "../db/client.js";
import { tagVocabulary } from "./tag-vocabulary.js";

/**
 * Fold the historical tag sprawl onto the canonical vocabulary.
 *
 * The prompt and the write boundary keep new records consistent, but they do
 * nothing for the 309,555 records already written under 55,568 names. This is
 * the one-shot pass that makes those records reachable from an article: pure
 * SQL, no model, and idempotent — running it twice changes nothing the second
 * time, because a canonical tag resolves to itself.
 */

export interface TagMerge {
  from: string;
  to: string;
  errorCount: number;
}

/** An article whose cluster key names a family that is being folded away. */
export interface InfoPageMove {
  slug: string;
  from: string;
  to: string;
  /** Set when another article already covers the destination family. */
  conflictsWith?: string;
}

export interface BackfillPlan {
  merges: TagMerge[];
  /** Records that would change tag. */
  recordsAffected: number;
  /** Families before and after, so the shape of the change is visible. */
  familiesBefore: number;
  familiesAfter: number;
  /**
   * Articles that must follow their family. Folding the records alone
   * strands them: the article keeps rendering while its cluster key names a
   * family with no records left, no error page links to it any more, and
   * findNewClusters stops recognising the destination as covered — which
   * earns it a second, duplicate article on the next collector run.
   */
  infoPageMoves: InfoPageMove[];
}

/**
 * What a backfill would do. The plan is computed against the same index the
 * write path uses, so applying it can never disagree with what a fresh
 * analysis would have written.
 */
export function planTagBackfill(db: Db, vocabulary: TagFamily[] = tagVocabulary(db)): BackfillPlan {
  const index = buildTagIndex(vocabulary);
  const merges: TagMerge[] = [];
  let recordsAffected = 0;
  const after = new Set<string>();

  for (const f of vocabulary) {
    // Same function the write path calls, so a plan can never propose
    // something a fresh analysis would not have written.
    const canonical = resolveTag(f.tag, index) ?? f.tag;
    after.add(canonical);
    if (canonical !== f.tag) {
      merges.push({ from: f.tag, to: canonical, errorCount: f.errorCount });
      recordsAffected += f.errorCount;
    }
  }

  merges.sort((a, b) => b.errorCount - a.errorCount || a.from.localeCompare(b.from));

  const pages = db.all<{ slug: string; cluster_key: string }>(sql`
    SELECT slug, cluster_key FROM info_pages WHERE cluster_key LIKE 'tag:%'
  `);
  const coveredBy = new Map(pages.map((p) => [p.cluster_key, p.slug]));
  const infoPageMoves: InfoPageMove[] = [];
  for (const p of pages) {
    // Resolved, not read off the merge list: an article stranded by an
    // earlier fold has no merge left to point at it, because its family no
    // longer has the records that would put it in the vocabulary. Asking the
    // resolver where its name belongs repairs that state as well as creating
    // it correctly.
    const to = resolveTag(p.cluster_key.slice(4), index);
    if (!to || to === p.cluster_key.slice(4)) continue;
    const destination = `tag:${to}`;
    const holder = coveredBy.get(destination);
    infoPageMoves.push({
      slug: p.slug,
      from: p.cluster_key,
      to: destination,
      ...(holder && holder !== p.slug ? { conflictsWith: holder } : {}),
    });
  }

  return {
    merges,
    recordsAffected,
    familiesBefore: vocabulary.length,
    familiesAfter: after.size,
    infoPageMoves,
  };
}

/**
 * Apply a plan. Returns the number of rows rewritten.
 *
 * `content_hash` is deliberately NOT recomputed, even though backgroundTag
 * feeds it. The error's own explanation, solutions and source are untouched;
 * what changes is which family article the page links to. Moving lastmod on
 * thousands of pages for that, while the host's crawl budget is still
 * suppressed, is the churn that cost trust in the first place — the link
 * appears on the next publish either way, and the sitemap keeps its word.
 */
export interface BackfillResult {
  recordsRewritten: number;
  pagesMoved: number;
  /** Articles left alone because another article already covers the family. */
  conflicts: InfoPageMove[];
}

export function applyTagBackfill(db: Db, plan: BackfillPlan): BackfillResult {
  let recordsRewritten = 0;
  for (const m of plan.merges) {
    const res = db.run(sql`UPDATE errors SET background_tag = ${m.to} WHERE background_tag = ${m.from}`);
    recordsRewritten += Number(res.changes ?? 0);
  }

  let pagesMoved = 0;
  const conflicts: InfoPageMove[] = [];
  for (const move of plan.infoPageMoves) {
    if (move.conflictsWith) {
      // Two articles now describe one family. Which one survives is an
      // editorial call about their content, not something a rename should
      // decide, so the loser keeps its old key and is reported.
      conflicts.push(move);
      continue;
    }
    db.run(sql`UPDATE info_pages SET cluster_key = ${move.to} WHERE slug = ${move.slug}`);
    pagesMoved++;
  }
  return { recordsRewritten, pagesMoved, conflicts };
}
