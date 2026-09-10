import { canonicalSlugs, isThinRecord, THIN_DOC_CHARS, type ErrorEntry } from "@errlookup/schema";

/**
 * The questionable-page stream: every published record that is weak in a way
 * worth acting on, with the reason attached.
 *
 * The August crawl withdrawal was a judgement on the AVERAGE quality of what
 * we put in front of Google, and the corpus is far past the size where anyone
 * finds those pages by reading it. Counting them in a log line says the
 * backlog exists; this says which records, why, and in a shape a script can
 * filter — so a cleanup pass can be aimed instead of guessed at.
 *
 * Flags describe the record, not its fate: a page can be perfectly indexable
 * and still carry `opaque-slug`. What is NOT indexable is reported separately
 * as `indexable: false`, because that is the property the sitemap acts on.
 */
export type QualityFlag =
  /** Documentation under the verify bar AND no solutions: nothing to rank. */
  | "thin"
  /** Documentation under the bar, carried by its solutions. */
  | "short-doc"
  /** No solutions — the section readers come for. */
  | "no-solutions"
  /** Slug carries no keyword: the message had no ASCII to slug from. */
  | "generic-slug"
  /** Slug ends in a hex fragment because its derivation collided. */
  | "opaque-slug"
  /** Not the canonical carrier of its code/message group — a near-duplicate. */
  | "duplicate"
  /** No source region extracted, so the page shows no code. */
  | "no-source";

export interface QualityRow {
  repo: string;
  slug: string;
  /** The page as published, so a row can be fed straight to curl or review. */
  url: string;
  flags: QualityFlag[];
  indexable: boolean;
  docChars: number;
  solutions: number;
  /** When this record's content last changed — how stale the problem is. */
  contentChangedAt: string | null;
}

/** Where a published record is readable. Mirrors the site's own `SITE`. */
export const SITE_ORIGIN = "https://errors.standardbeagle.com";

const GENERIC_SLUG = /^(error|unknown-error)(-[0-9a-f]{6})?$/;
const HEX_SUFFIX = /-[0-9a-f]{6}$/;

/**
 * Flag one record. `canonical` is the repo's canonical slug set, passed in
 * because it is a per-repo grouping — computing it per record would make the
 * report quadratic in the size of the biggest repo (ruvnet/ruflo publishes
 * 1,303 pages).
 */
export function flagsFor(e: ErrorEntry, canonical: ReadonlySet<string>): QualityFlag[] {
  const flags: QualityFlag[] = [];
  if (isThinRecord(e)) flags.push("thin");
  else if (e.documentation.trim().length < THIN_DOC_CHARS) flags.push("short-doc");
  if (e.solutions.length === 0) flags.push("no-solutions");
  if (GENERIC_SLUG.test(e.slug)) flags.push("generic-slug");
  else if (HEX_SUFFIX.test(e.slug)) flags.push("opaque-slug");
  if (!canonical.has(e.slug)) flags.push("duplicate");
  if (e.sourceCode === null) flags.push("no-source");
  return flags;
}

/**
 * Every questionable record across the corpus, worst first (most flags, then
 * oldest content). Records with nothing wrong are omitted — this is a work
 * list, not a census.
 */
export function qualityRows(
  errorsByRepo: ReadonlyMap<string, ErrorEntry[]>,
  site: string = SITE_ORIGIN
): QualityRow[] {
  const rows: QualityRow[] = [];
  for (const [repo, records] of errorsByRepo) {
    const canonical = canonicalSlugs(records);
    for (const e of records) {
      const flags = flagsFor(e, canonical);
      if (flags.length === 0) continue;
      rows.push({
        repo,
        slug: e.slug,
        url: `${site}/${repo}/${e.slug}/`,
        flags,
        indexable: canonical.has(e.slug) && !isThinRecord(e),
        docChars: e.documentation.trim().length,
        solutions: e.solutions.length,
        contentChangedAt: e.contentChangedAt,
      });
    }
  }
  rows.sort(
    (a, b) =>
      b.flags.length - a.flags.length ||
      (a.contentChangedAt ?? "").localeCompare(b.contentChangedAt ?? "") ||
      a.url.localeCompare(b.url)
  );
  return rows;
}

/** Records carrying each flag, plus the totals a run summary reports. */
export function qualityCounts(rows: readonly QualityRow[]): {
  flagged: number;
  noindexed: number;
  byFlag: Record<QualityFlag, number>;
} {
  const byFlag = {
    thin: 0,
    "short-doc": 0,
    "no-solutions": 0,
    "generic-slug": 0,
    "opaque-slug": 0,
    duplicate: 0,
    "no-source": 0,
  } satisfies Record<QualityFlag, number>;
  let noindexed = 0;
  for (const r of rows) {
    for (const f of r.flags) byFlag[f]++;
    if (!r.indexable) noindexed++;
  }
  return { flagged: rows.length, noindexed, byFlag };
}

/** One-line summary for a scan/export log and the drain's ntfy note. */
export function qualitySummary(total: number, rows: readonly QualityRow[]): string {
  const { flagged, noindexed, byFlag } = qualityCounts(rows);
  const share = total > 0 ? ((flagged / total) * 100).toFixed(1) : "0.0";
  const parts = Object.entries(byFlag)
    .filter(([, n]) => n > 0)
    .sort(([, a], [, b]) => b - a)
    .map(([f, n]) => `${f}=${n}`);
  return `quality: ${flagged}/${total} records flagged (${share}%), ${noindexed} noindexed — ${
    parts.join(" ") || "none"
  }`;
}
