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

export interface BackfillPlan {
  merges: TagMerge[];
  /** Records that would change tag. */
  recordsAffected: number;
  /** Families before and after, so the shape of the change is visible. */
  familiesBefore: number;
  familiesAfter: number;
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
  return {
    merges,
    recordsAffected,
    familiesBefore: vocabulary.length,
    familiesAfter: after.size,
  };
}

/**
 * Apply a plan. Returns the number of rows rewritten.
 *
 * `content_hash` deliberately moves with the tag: backgroundTag is part of
 * what a reader sees, and the exporter's lastmod is driven by that hash. A
 * silent tag change with a frozen hash would leave the sitemap claiming the
 * page never changed.
 */
export function applyTagBackfill(db: Db, plan: BackfillPlan): number {
  let rewritten = 0;
  for (const m of plan.merges) {
    const res = db.run(sql`UPDATE errors SET background_tag = ${m.to} WHERE background_tag = ${m.from}`);
    rewritten += Number(res.changes ?? 0);
  }
  return rewritten;
}
