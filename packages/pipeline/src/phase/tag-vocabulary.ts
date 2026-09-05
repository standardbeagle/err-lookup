import { sql } from "drizzle-orm";
import { buildTagIndex, type TagFamily } from "@errlookup/schema";
import type { Db } from "../db/client.js";

/**
 * The background-family vocabulary, read straight off the corpus.
 *
 * Deriving it from `errors` rather than keeping a registry table means it
 * cannot drift from what the records actually say — a registry would need its
 * own reconciliation the first time a repo is re-analyzed and its tags change.
 */

/**
 * Families offered to the model in an analysis prompt. Enough to cover the
 * ground a batch is likely to land on, small enough that the list does not
 * crowd out the source regions the same prompt carries.
 */
export const PROMPT_FAMILY_LIMIT = 120;

/** A family must be this established before it is offered as a choice. */
export const PROMPT_FAMILY_MIN_ERRORS = 8;

interface VocabRow {
  tag: string;
  n: number;
  r: number;
  info_slug: string | null;
}

/** Families in the corpus, largest first. */
export function tagVocabulary(
  db: Db,
  opts: { minErrors?: number; limit?: number } = {}
): TagFamily[] {
  const minErrors = opts.minErrors ?? 1;
  const limit = opts.limit ?? 100_000;
  const rows = db.all<VocabRow>(sql`
    SELECT e.background_tag AS tag,
           count(*) AS n,
           count(DISTINCT e.repo) AS r,
           (SELECT p.slug FROM info_pages p WHERE p.cluster_key = 'tag:' || e.background_tag) AS info_slug
    FROM errors e
    WHERE e.background_tag IS NOT NULL AND e.background_tag != ''
    GROUP BY e.background_tag
    HAVING n >= ${minErrors}
    ORDER BY n DESC, tag ASC
    LIMIT ${limit}
  `);
  return rows.map((r) => ({ tag: r.tag, errorCount: r.n, repoCount: r.r, infoSlug: r.info_slug }));
}

/** Resolution index over the whole vocabulary — every family, however small. */
export function tagIndexFor(db: Db): Map<string, string> {
  return buildTagIndex(tagVocabulary(db));
}

/** The shortlist an analysis prompt offers, largest families first. */
export function promptFamilies(db: Db): string[] {
  return tagVocabulary(db, {
    minErrors: PROMPT_FAMILY_MIN_ERRORS,
    limit: PROMPT_FAMILY_LIMIT,
  }).map((f) => f.tag);
}
