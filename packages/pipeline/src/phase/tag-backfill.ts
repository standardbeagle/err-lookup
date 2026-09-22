import { sql } from "drizzle-orm";
import { CANONICAL_TAGS } from "@errlookup/schema";
import type { Db } from "../db/client.js";
import { CONFIDENCE_THRESHOLD, publishedFamily, taxonomyVersion, type StoredDecision } from "./tag-classify.js";

/**
 * Bring the corpus into line with the page decisions.
 *
 * The classifier decides; this is the pass that makes the stored records and
 * the articles say so. Keeping the two apart is what makes the expensive half
 * re-runnable and the cheap half re-tunable: a plan is pure SQL over the
 * decision table, evaluated against whatever gate is passed, and it can be
 * read in full before anything is rewritten.
 *
 * It is idempotent, and it is the only writer of `errors.background_tag`
 * besides the write path's carry-over of decisions already made.
 */

/** A family change shared by a group of pages. */
export interface FamilyTransition {
  from: string | null;
  to: string | null;
  pages: number;
}

/** An article whose family is not a declared one, and where its pages went. */
export interface InfoPageMove {
  slug: string;
  from: string;
  to: string;
  /** Share of the article's pages that land in `to`. */
  share: number;
  /** Set when another article already covers the destination family. */
  conflictsWith?: string;
}

/** An article left where it is, and why. */
export interface InfoPageHold {
  slug: string;
  family: string;
  reason: string;
}

export interface BackfillPlan {
  taxonomyVersion: string;
  gate: number;
  /** Pages whose published family would change, grouped by (from, to). */
  transitions: FamilyTransition[];
  recordsAffected: number;
  /** Pages that would publish no family where they published one before. */
  recordsUnassigned: number;
  familiesBefore: number;
  familiesAfter: number;
  /** Pages with no decision at this taxonomy version — the plan cannot speak for them. */
  undecided: number;
  infoPageMoves: InfoPageMove[];
  infoPageHolds: InfoPageHold[];
}

/**
 * An article follows its family when a clear majority of its pages land in
 * one place. Below that the article straddles several families, and moving
 * it would file most of its readers' errors under the wrong page.
 */
export const ARTICLE_MAJORITY = 0.5;

interface PageRow {
  current: string | null;
  proposal: string | null;
  choice: string | null;
  method: StoredDecision["method"] | null;
  confidence: number | null;
}

export function planTagBackfill(db: Db, gate = CONFIDENCE_THRESHOLD): BackfillPlan {
  const version = taxonomyVersion();
  const rows = db.all<PageRow>(sql`
    SELECT e.background_tag AS current, e.background_tag_raw AS proposal,
           d.choice, d.method, d.confidence
    FROM errors e
    LEFT JOIN page_tag_decisions d ON d.error_id = e.id AND d.taxonomy_version = ${version}
  `);

  const transitions = new Map<string, FamilyTransition>();
  const before = new Set<string>();
  const after = new Set<string>();
  let undecided = 0;
  let recordsUnassigned = 0;
  // proposal → where its pages publish now, for moving articles keyed to it.
  const landing = new Map<string, Map<string | null, number>>();

  for (const r of rows) {
    if (r.current) before.add(r.current);
    if (!r.method) {
      undecided++;
      if (r.current) after.add(r.current);
      continue;
    }
    const to = publishedFamily({ choice: r.choice, method: r.method, confidence: r.confidence }, gate);
    if (to) after.add(to);
    if (r.proposal) {
      const m = landing.get(r.proposal) ?? new Map<string | null, number>();
      m.set(to, (m.get(to) ?? 0) + 1);
      landing.set(r.proposal, m);
    }
    if (to === r.current) continue;
    const key = `${r.current ?? ""}\u0000${to ?? ""}`;
    const t = transitions.get(key) ?? { from: r.current, to, pages: 0 };
    t.pages++;
    transitions.set(key, t);
    if (to === null) recordsUnassigned++;
  }

  const sorted = [...transitions.values()].sort((a, b) => b.pages - a.pages);
  const { moves, holds } = planArticles(db, landing);
  return {
    taxonomyVersion: version,
    gate,
    transitions: sorted,
    recordsAffected: sorted.reduce((s, t) => s + t.pages, 0),
    recordsUnassigned,
    familiesBefore: before.size,
    familiesAfter: after.size,
    undecided,
    infoPageMoves: moves,
    infoPageHolds: holds,
  };
}

function planArticles(
  db: Db,
  landing: Map<string, Map<string | null, number>>
): { moves: InfoPageMove[]; holds: InfoPageHold[] } {
  const pages = db.all<{ slug: string; cluster_key: string }>(sql`
    SELECT slug, cluster_key FROM info_pages WHERE cluster_key LIKE 'tag:%' ORDER BY slug
  `);
  const coveredBy = new Map(pages.map((p) => [p.cluster_key, p.slug]));
  const moves: InfoPageMove[] = [];
  const holds: InfoPageHold[] = [];
  for (const p of pages) {
    const family = p.cluster_key.slice(4);
    // An article on a declared family is already where it belongs.
    if (CANONICAL_TAGS.has(family)) continue;
    const dist = landing.get(family);
    const total = dist ? [...dist.values()].reduce((s, n) => s + n, 0) : 0;
    const top = dist ? [...dist].filter(([f]) => f !== null).sort((a, b) => b[1] - a[1])[0] : undefined;
    if (!top || total === 0) {
      holds.push({ slug: p.slug, family, reason: "no decided pages carry its name" });
      continue;
    }
    const share = top[1] / total;
    if (share <= ARTICLE_MAJORITY) {
      holds.push({ slug: p.slug, family, reason: `pages split — the largest share, ${top[0]}, is ${(share * 100).toFixed(0)}%` });
      continue;
    }
    const destination = `tag:${top[0]}`;
    const holder = coveredBy.get(destination);
    moves.push({
      slug: p.slug,
      from: p.cluster_key,
      to: destination,
      share,
      ...(holder && holder !== p.slug ? { conflictsWith: holder } : {}),
    });
  }
  return { moves, holds };
}

export interface BackfillResult {
  recordsRewritten: number;
  pagesMoved: number;
  /** Articles left alone because another article already covers the family. */
  conflicts: InfoPageMove[];
}

/**
 * Apply the decisions at the plan's gate. Records are rewritten one id-prefix
 * slice at a time, each its own transaction, so the corpus is never locked
 * for one long write and a stop part-way leaves every slice either done or
 * untouched.
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
  for (const prefix of "0123456789abcdef") {
    const res = db.transaction((tx) =>
      tx.run(sql`
        UPDATE errors SET background_tag = pub.family
        FROM (
          SELECT d.error_id,
                 CASE
                   WHEN d.choice IS NULL THEN NULL
                   WHEN d.method != 'model' THEN d.choice
                   WHEN coalesce(d.confidence, 0) >= ${plan.gate} THEN d.choice
                   ELSE NULL
                 END AS family
          FROM page_tag_decisions d
          WHERE d.taxonomy_version = ${plan.taxonomyVersion} AND d.error_id LIKE ${`${prefix}%`}
        ) AS pub
        WHERE errors.id = pub.error_id AND errors.background_tag IS NOT pub.family
      `)
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
