import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";

/**
 * Bring the corpus into line with the decisions in `tag_decisions`.
 *
 * The classifier decides where each proposed name belongs; this is the pass
 * that makes the stored records say so. Keeping the two apart is what makes
 * the expensive half re-runnable: a decision is written once per distinct
 * proposal and never re-derived, so re-planning is pure SQL over a table of
 * roughly fifty thousand rows, and the plan can be read before anything is
 * rewritten.
 *
 * It is idempotent — a record already carrying its decided family produces no
 * merge — and it is the only writer of `errors.background_tag`.
 */

export interface TagMerge {
  /** The proposal as the enrichment model wrote it. */
  from: string;
  /** Family the record carries today; null when it was already unassigned. */
  current: string | null;
  /** Family the decision puts it in; null when nothing in the taxonomy fits. */
  to: string | null;
  errorCount: number;
}

/** An article whose cluster key names a proposal that is being folded away. */
export interface InfoPageMove {
  slug: string;
  from: string;
  to: string;
  /** Set when another article already covers the destination family. */
  conflictsWith?: string;
}

export interface BackfillPlan {
  merges: TagMerge[];
  /** Records that would change family. */
  recordsAffected: number;
  /** Records that would lose their family because no declared one fits. */
  recordsUnassigned: number;
  /** Distinct families carried by the records today, and after the plan runs. */
  familiesBefore: number;
  familiesAfter: number;
  /** Proposals with no decision yet — records the plan cannot speak for. */
  undecidedProposals: number;
  undecidedRecords: number;
  /**
   * Articles that must follow their family. Folding the records alone strands
   * them: the article keeps rendering while its cluster key names a family
   * with no records left, no error page links to it any more, and
   * findNewClusters stops recognising the destination as covered — which earns
   * it a second, duplicate article on the next collector run.
   */
  infoPageMoves: InfoPageMove[];
}

interface GroupRow {
  proposal: string;
  current: string | null;
  decided: string | null;
  hasDecision: number;
  n: number;
}

/**
 * What a backfill would do, read straight off the decisions.
 */
export function planTagBackfill(db: Db): BackfillPlan {
  const rows = db.all<GroupRow>(sql`
    SELECT e.background_tag_raw AS proposal,
           e.background_tag AS current,
           d.canonical AS decided,
           (d.proposal IS NOT NULL) AS hasDecision,
           count(*) AS n
    FROM errors e
    LEFT JOIN tag_decisions d ON d.proposal = e.background_tag_raw
    WHERE e.background_tag_raw IS NOT NULL AND e.background_tag_raw != ''
    GROUP BY e.background_tag_raw, e.background_tag
    ORDER BY n DESC
  `);

  const merges: TagMerge[] = [];
  const before = new Set<string>();
  const after = new Set<string>();
  let recordsAffected = 0;
  let recordsUnassigned = 0;
  let undecidedRecords = 0;
  const undecided = new Set<string>();

  for (const row of rows) {
    if (row.current) before.add(row.current);
    if (!row.hasDecision) {
      // No decision means no opinion. The records keep whatever they carry.
      undecided.add(row.proposal);
      undecidedRecords += row.n;
      if (row.current) after.add(row.current);
      continue;
    }
    if (row.decided) after.add(row.decided);
    if (row.decided === row.current) continue;
    merges.push({ from: row.proposal, current: row.current, to: row.decided, errorCount: row.n });
    recordsAffected += row.n;
    if (row.decided === null) recordsUnassigned += row.n;
  }

  merges.sort((a, b) => b.errorCount - a.errorCount || a.from.localeCompare(b.from));

  const pages = db.all<{ slug: string; cluster_key: string }>(sql`
    SELECT slug, cluster_key FROM info_pages WHERE cluster_key LIKE 'tag:%'
  `);
  const decisions = new Map(
    db
      .all<{ proposal: string; canonical: string | null }>(sql`SELECT proposal, canonical FROM tag_decisions`)
      .map((d) => [d.proposal, d.canonical])
  );
  const coveredBy = new Map(pages.map((p) => [p.cluster_key, p.slug]));
  const infoPageMoves: InfoPageMove[] = [];
  for (const p of pages) {
    const family = p.cluster_key.slice(4);
    if (!decisions.has(family)) continue;
    const to = decisions.get(family);
    // An article about a family that fits nothing in the taxonomy keeps its
    // key. Retiring it is an editorial call, and an unkeyed article would be
    // invisible to the collector's coverage check.
    if (!to || to === family) continue;
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
    recordsUnassigned,
    familiesBefore: before.size,
    familiesAfter: after.size,
    undecidedProposals: undecided.size,
    undecidedRecords,
    infoPageMoves,
  };
}

export interface BackfillResult {
  recordsRewritten: number;
  pagesMoved: number;
  /** Articles left alone because another article already covers the family. */
  conflicts: InfoPageMove[];
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
export function applyTagBackfill(db: Db, plan: BackfillPlan): BackfillResult {
  let recordsRewritten = 0;
  for (const m of plan.merges) {
    const res = db.run(
      sql`UPDATE errors SET background_tag = ${m.to} WHERE background_tag_raw = ${m.from}`
    );
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
