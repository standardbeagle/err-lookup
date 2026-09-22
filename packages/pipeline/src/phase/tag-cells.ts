import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { ruleFold } from "./tag-classify.js";
import { nameShape, messageMode, WEAK_MODES, type FailureMode, type ObjectClass } from "./tag-shape.js";

/**
 * Candidate families, built procedurally from the corpus.
 *
 * Every distinct proposed name is decomposed into (failure mode × object) and
 * the names are pooled by that pair, weighted by how many records carry them.
 * A cell is a candidate family: `absent × config` gathers missing-config-key,
 * missing-required-config-field, config-value-missing and the rest of their
 * spellings under one roof before any model is asked about them.
 *
 * A cell is split on its subject when one subject is heavy enough to be a
 * family by itself. `invalid × format` is far too broad to be one article;
 * `invalid × format:url` is exactly one.
 *
 * Names that do not parse, and cells too small to carry an article, are
 * reported as uncelled. Their records are not lost — the per-page classifier
 * places them against whatever set the proposal settles on — they just do not
 * get to propose a family of their own.
 */

/** A cell must carry this many records to be proposed as a family. */
export const CELL_MIN_ERRORS = 100;

/** A subject inside a cell becomes a cell of its own at this many records. */
export const SUBJECT_SPLIT_MIN_ERRORS = 400;

export interface CellMember {
  proposal: string;
  errorCount: number;
  repoCount: number;
}

export interface Cell {
  /** `mode×object`, or `mode×object:subject` when split out. */
  key: string;
  mode: FailureMode;
  object: ObjectClass;
  subject: string | null;
  errorCount: number;
  /** Every proposed name in the cell, heaviest first. */
  members: CellMember[];
  /** Current families the members fold onto by spelling, heaviest first. */
  incumbents: { family: string; errorCount: number }[];
  /** Background articles keyed to one of the members, with the member they are keyed to. */
  articles: { slug: string; proposal: string }[];
}

export interface CellBuild {
  cells: Cell[];
  /** Records whose proposal parses to no cell or to a cell below the floor. */
  uncelledErrors: number;
  totalErrors: number;
}

interface ProposalRow {
  proposal: string;
  n: number;
  r: number;
}

export function buildCells(db: Db, opts: { minErrors?: number; splitMin?: number } = {}): CellBuild {
  const minErrors = opts.minErrors ?? CELL_MIN_ERRORS;
  const splitMin = opts.splitMin ?? SUBJECT_SPLIT_MIN_ERRORS;
  const rows = db.all<ProposalRow>(sql`
    SELECT background_tag_raw AS proposal, count(*) AS n, count(DISTINCT repo) AS r
    FROM errors
    WHERE background_tag_raw IS NOT NULL AND background_tag_raw != ''
    GROUP BY background_tag_raw
  `);
  const articleByProposal = new Map(
    db
      .all<{ slug: string; cluster_key: string }>(sql`SELECT slug, cluster_key FROM info_pages WHERE cluster_key LIKE 'tag:%'`)
      .map((p) => [p.cluster_key.slice(4), p.slug])
  );

  const totalErrors = rows.reduce((s, r) => s + r.n, 0);

  // First pass: pool by (mode, object), remembering each member's subject.
  const pools = new Map<string, { mode: FailureMode; object: ObjectClass; members: (CellMember & { subject: string | null })[] }>();
  for (const row of rows) {
    const shape = nameShape(row.proposal);
    if (!shape.mode || !shape.object) continue;
    const key = `${shape.mode}×${shape.object}`;
    const pool = pools.get(key) ?? { mode: shape.mode, object: shape.object, members: [] };
    pool.members.push({ proposal: row.proposal, errorCount: row.n, repoCount: row.r, subject: shape.subject });
    pools.set(key, pool);
  }

  // Second pass: split heavy subjects out, then drop what is under the floor.
  const cells: Cell[] = [];
  for (const [key, pool] of pools) {
    const bySubject = new Map<string, number>();
    for (const m of pool.members) {
      if (m.subject) bySubject.set(m.subject, (bySubject.get(m.subject) ?? 0) + m.errorCount);
    }
    const poolTotal = pool.members.reduce((s, m) => s + m.errorCount, 0);
    // Splitting only means something when the rest of the pool is a family
    // too; a subject that IS the pool ("absent×config:config") stays whole.
    const splits = new Set(
      [...bySubject].filter(([, n]) => n >= splitMin && n < poolTotal * 0.8).map(([s]) => s)
    );
    const groups = new Map<string, typeof pool.members>();
    for (const m of pool.members) {
      const k = m.subject && splits.has(m.subject) ? `${key}:${m.subject}` : key;
      groups.set(k, [...(groups.get(k) ?? []), m]);
    }
    for (const [cellKey, members] of groups) {
      const errorCount = members.reduce((s, m) => s + m.errorCount, 0);
      if (errorCount < minErrors) continue;
      members.sort((a, b) => b.errorCount - a.errorCount || a.proposal.localeCompare(b.proposal));
      cells.push({
        key: cellKey,
        mode: pool.mode,
        object: pool.object,
        subject: cellKey.includes(":") ? cellKey.split(":")[1]! : null,
        errorCount,
        members: members.map(({ proposal, errorCount: n, repoCount }) => ({ proposal, errorCount: n, repoCount })),
        incumbents: incumbentsOf(members),
        articles: members.flatMap((m) => {
          const slug = articleByProposal.get(m.proposal);
          return slug ? [{ slug, proposal: m.proposal }] : [];
        }),
      });
    }
  }
  cells.sort((a, b) => b.errorCount - a.errorCount || a.key.localeCompare(b.key));
  const celled = cells.reduce((s, c) => s + c.errorCount, 0);
  return { cells, uncelledErrors: totalErrors - celled, totalErrors };
}

function incumbentsOf(members: CellMember[]): { family: string; errorCount: number }[] {
  const by = new Map<string, number>();
  for (const m of members) {
    const family = ruleFold(m.proposal);
    if (family) by.set(family, (by.get(family) ?? 0) + m.errorCount);
  }
  return [...by].map(([family, errorCount]) => ({ family, errorCount })).sort((a, b) => b.errorCount - a.errorCount);
}

/** One page of a cell, compacted for a prompt. */
export interface CellSample {
  repo: string;
  proposal: string;
  message: string;
  errorClass: string | null;
  httpStatus: number | null;
  documentation: string;
}

/** Facts about a cell counted over a wider sample than the prompt can show. */
export interface CellEvidence {
  /** Pages the counts below were taken over. */
  pages: number;
  /** Share of those whose message states the cell's own failure mode. */
  messageAgrees: number;
  /** Share whose message states some other specific mode — the cell's impurity. */
  messageDisagrees: number;
  classes: { value: string; count: number }[];
}

/** Members used for sampling. The heaviest names hold nearly all the weight. */
const SAMPLE_MEMBER_LIMIT = 200;

/**
 * Pages of a cell for a prompt, one per library, chosen at random so the
 * sample is weighted by where the records actually are.
 */
export function sampleCell(db: Db, cell: Cell, k: number): CellSample[] {
  const names = cell.members.slice(0, SAMPLE_MEMBER_LIMIT).map((m) => m.proposal);
  const rows = db.all<{
    repo: string;
    proposal: string;
    message: string;
    error_class: string | null;
    http_status: number | null;
    documentation: string | null;
  }>(sql`
    SELECT repo, proposal, message, error_class, http_status, documentation FROM (
      SELECT repo, background_tag_raw AS proposal, error_message AS message, error_class, http_status, documentation,
             row_number() OVER (PARTITION BY repo ORDER BY random()) AS rn
      FROM errors
      WHERE background_tag_raw IN (${sql.join(names.map((n) => sql`${n}`), sql`, `)})
    ) WHERE rn = 1
    ORDER BY random()
    LIMIT ${k}
  `);
  return rows.map((r) => ({
    repo: r.repo,
    proposal: r.proposal,
    message: r.message.slice(0, 240),
    errorClass: r.error_class,
    httpStatus: r.http_status,
    documentation: (r.documentation ?? "").slice(0, 240),
  }));
}

/** Count how the cell's messages read, over a sample wide enough to trust. */
export function cellEvidence(db: Db, cell: Cell, pages = 300): CellEvidence {
  const names = cell.members.slice(0, SAMPLE_MEMBER_LIMIT).map((m) => m.proposal);
  const rows = db.all<{ message: string; error_class: string | null }>(sql`
    SELECT error_message AS message, error_class FROM errors
    WHERE background_tag_raw IN (${sql.join(names.map((n) => sql`${n}`), sql`, `)})
    ORDER BY random()
    LIMIT ${pages}
  `);
  let agrees = 0;
  let disagrees = 0;
  const classes = new Map<string, number>();
  for (const r of rows) {
    const mode = messageMode(r.message);
    if (mode === cell.mode) agrees++;
    else if (mode && !WEAK_MODES.has(mode)) disagrees++;
    if (r.error_class) classes.set(r.error_class, (classes.get(r.error_class) ?? 0) + 1);
  }
  const n = Math.max(rows.length, 1);
  return {
    pages: rows.length,
    messageAgrees: agrees / n,
    messageDisagrees: disagrees / n,
    classes: [...classes]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 6),
  };
}
