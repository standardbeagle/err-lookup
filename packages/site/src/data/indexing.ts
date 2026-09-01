import type { ErrorEntry } from "@errlookup/schema";

/**
 * Which error pages the site advertises to crawlers. Everything renders and
 * everything is searchable — this module only decides what earns a sitemap
 * line and an indexable page, because the average quality of the indexed set
 * is what drives Google's crawl demand (learned the hard way: the August bulk
 * publish put ~50k thin/near-duplicate pages in front of Google's admission
 * systems and the whole host's crawl was withdrawn on 2026-08-18).
 *
 * A page is index-worthy when its repo has been admitted by the scheduled
 * publisher (published.json) AND the record is the canonical carrier of its
 * message pattern AND it is not thin.
 */

/** Same bar the pipeline's verify phase uses for a documentation gap. */
export const THIN_DOC_CHARS = 200;

/**
 * Thin: nothing to rank — a stub documentation and no solutions. These are
 * overwhelmingly records from the Aug 12-26 provider quota storms; verify
 * heals them on rescan, and they graduate to indexable the moment it does.
 */
export function isThinRecord(e: Pick<ErrorEntry, "documentation" | "solutions">): boolean {
  return e.documentation.trim().length < THIN_DOC_CHARS && e.solutions.length === 0;
}

/**
 * One canonical page per duplicate group per repo — near-duplicates to a
 * crawler, 16.2% of the 2026-08-31 corpus. The group key is the error CODE
 * when the record has one, else the message pattern: two codes sharing one
 * message template are DIFFERENT errors deserving different pages
 * (FUNCTION_MSK_/FUNCTION_KAFKA_STARTING_POSITION_TIMESTAMP_INVALID in
 * serverless share a template verbatim, and the pattern-only rule noindexed
 * the MSK page — the very page a live Google result was showing). The richest
 * record carries the group (has solutions, then the longest documentation);
 * ties break on slug so the choice is stable across builds. Variants still
 * render and remain searchable, they just don't compete with their canonical
 * sibling in the index.
 */
export function canonicalSlugs(all: readonly ErrorEntry[]): Set<string> {
  const best = new Map<string, ErrorEntry>();
  for (const e of all) {
    const key = e.errorCode ? `c:${e.errorCode}` : `p:${e.messagePattern}`;
    const cur = best.get(key);
    if (!cur || richness(e) > richness(cur) || (richness(e) === richness(cur) && e.slug < cur.slug)) {
      best.set(key, e);
    }
  }
  return new Set([...best.values()].map((e) => e.slug));
}

function richness(e: ErrorEntry): number {
  return (e.solutions.length > 0 ? 1_000_000 : 0) + e.documentation.length;
}

/** Slugs in this repo's record set that earn a sitemap line + indexable page. */
export function indexableSlugs(all: readonly ErrorEntry[]): Set<string> {
  const canonical = canonicalSlugs(all);
  return new Set(all.filter((e) => canonical.has(e.slug) && !isThinRecord(e)).map((e) => e.slug));
}
