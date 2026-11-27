/** One row in a background-article list. Mirrors ArticleList's props. */
export interface ArticleEntry {
  href: string;
  title: string;
  summary: string;
  meta?: string;
}

/**
 * Guides and background articles are one thing to the reader — an explainer
 * for a class of errors. One index, ranked by documented occurrences; the
 * hand-written guides and the collector's articles just come from different
 * pipelines (articles grow twice a day as the collector runs).
 *
 * Extracted from the page when the index needed paging, so page 1 and the
 * continuation pages build the same list from the same ordering. Two copies
 * would drift and silently repeat or drop entries across a page boundary.
 */
export function troubleshootingEntries(
  guides: readonly { slug: string; title: string; description: string }[],
  guideHref: (slug: string) => string,
  guideErrors: (g: { slug: string }) => readonly unknown[],
  info: readonly { slug: string; title: string; summary: string; errorCount: number }[]
): ArticleEntry[] {
  return [
    ...guides.map((g) => ({
      href: guideHref(g.slug),
      title: g.title,
      summary: g.description,
      count: guideErrors(g).length,
    })),
    ...info.map((p) => ({
      href: `/info/${p.slug}/`,
      title: p.title,
      summary: p.summary,
      count: p.errorCount,
    })),
  ]
    .sort((a, b) => b.count - a.count || a.title.localeCompare(b.title))
    .map((e) => ({
      href: e.href,
      title: e.title,
      summary: e.summary,
      meta: e.count > 0 ? `(${e.count.toLocaleString()} documented occurrences)` : undefined,
    }));
}
