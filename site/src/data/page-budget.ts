/**
 * Per-page budgets, enforced against the built site.
 *
 * The site had a 50 KB weight rule (§6.2) that only ever covered error detail
 * pages, so nothing was watching the lists. On 2026-09-13 the built dist held
 * 2,090 HTML files totalling 129.7 MB: a healthy p50 of 18 KB, but 339 files
 * over 100 KB, 98 over 250 KB, and a worst page of 1.66 MB —
 * weaviate/weaviate's repo page, rendering all 5,976 of its errors with no
 * paging. That page is the first URL in its own sitemap, so it was also the
 * crawler's entry point to everything beneath it: ~6,000 internal links on one
 * oversized document, at exactly the moment we are trying to earn crawl budget
 * back.
 *
 * A budget nobody measures is a preference. These are checked at build time by
 * scripts/audit-dist.ts, which fails the build.
 */

/** Hard ceiling for any single HTML page. Over this fails the build. */
export const MAX_PAGE_BYTES = 250_000;

/** Advisory ceiling: reported, does not fail. p90 sat at 165 KB pre-paging. */
export const WARN_PAGE_BYTES = 100_000;

/**
 * Links on one page. A paged list carries its page of rows plus site chrome
 * and a pager; anything far above that is a list that forgot to paginate.
 * A 100-row error page lands near 150.
 */
export const MAX_PAGE_LINKS = 300;

export type Severity = "fail" | "warn";

export interface PageStat {
  /** Path relative to dist, e.g. "weaviate/weaviate/index.html". */
  path: string;
  bytes: number;
  links: number;
}

export interface Violation {
  path: string;
  severity: Severity;
  rule: string;
  actual: number;
  budget: number;
  /** What the reader should do about it, not just what tripped. */
  hint: string;
}

/**
 * Judge one page. Returns every rule it breaks, worst first — a 1.66 MB page
 * usually breaks the link budget too, and reporting only the first would hide
 * half the reason.
 */
export function checkPage(stat: PageStat): Violation[] {
  const out: Violation[] = [];
  if (stat.bytes > MAX_PAGE_BYTES) {
    out.push({
      path: stat.path,
      severity: "fail",
      rule: "page-bytes",
      actual: stat.bytes,
      budget: MAX_PAGE_BYTES,
      hint: "an unpaged list; paginate it (src/data/paging.ts)",
    });
  } else if (stat.bytes > WARN_PAGE_BYTES) {
    out.push({
      path: stat.path,
      severity: "warn",
      rule: "page-bytes",
      actual: stat.bytes,
      budget: WARN_PAGE_BYTES,
      hint: "heavy for a single page; check whether its list is paged",
    });
  }
  if (stat.links > MAX_PAGE_LINKS) {
    out.push({
      path: stat.path,
      severity: "fail",
      rule: "page-links",
      actual: stat.links,
      budget: MAX_PAGE_LINKS,
      hint: "too many links from one page; crawl equity splits across all of them",
    });
  }
  return out.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "fail" ? -1 : 1));
}

/** Count `href="..."` occurrences — what a crawler would follow from this page. */
export function countLinks(html: string): number {
  return (html.match(/<a\s[^>]*href=/gi) ?? []).length;
}

export interface AuditResult {
  checked: number;
  violations: Violation[];
  failures: number;
  warnings: number;
}

export function auditPages(stats: readonly PageStat[]): AuditResult {
  const violations = stats.flatMap(checkPage);
  return {
    checked: stats.length,
    violations: violations.sort((a, b) => b.actual / b.budget - a.actual / a.budget),
    failures: violations.filter((v) => v.severity === "fail").length,
    warnings: violations.filter((v) => v.severity === "warn").length,
  };
}

/** One line per violation, worst overrun first. */
export function formatAudit(result: AuditResult, limit = 15): string {
  if (result.violations.length === 0) return `page budget: ${result.checked} pages, all within budget`;
  const lines = result.violations
    .slice(0, limit)
    .map(
      (v) =>
        `  ${v.severity === "fail" ? "FAIL" : "warn"}  ${v.rule}  ${v.actual} > ${v.budget}  ${v.path}\n        ${v.hint}`
    );
  const more = result.violations.length > limit ? `\n  ... and ${result.violations.length - limit} more` : "";
  return (
    `page budget: ${result.checked} pages, ${result.failures} failing, ${result.warnings} warning\n` +
    lines.join("\n") +
    more
  );
}
