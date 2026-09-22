import { sql } from "drizzle-orm";
import { CANONICAL_FAMILIES, type TagFamily } from "@errlookup/schema";
import type { Db } from "../db/client.js";

/**
 * What the corpus currently says about the background families.
 *
 * The vocabulary used to be derived from the records — whatever names they
 * carried WAS the vocabulary — which is why it grew to 56,960 entries. The
 * list of permitted families now lives in `@errlookup/schema`'s taxonomy, and
 * this module only reports how the corpus fills it.
 */

interface VocabRow {
  tag: string;
  n: number;
  r: number;
  info_slug: string | null;
}

/** Families the records carry, largest first, with the article covering each. */
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

/**
 * The families an analysis prompt offers.
 *
 * Every declared family, not the corpus's most popular names: a name the
 * prompt suggests is one the classifier will fold for free, so suggesting the
 * whole taxonomy is what keeps the expensive half of the pipeline small. The
 * list is ordered as the taxonomy declares it, which groups it by domain and
 * reads better than a frequency ranking.
 */
export function promptFamilies(): string[] {
  return CANONICAL_FAMILIES.map((f) => f.tag);
}
