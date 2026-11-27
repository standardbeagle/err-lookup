/**
 * Social-card paths. Cards are pre-rendered PNGs in public/og (see
 * scripts/gen-og-images.ts); anything without a specific card falls back to the
 * default. Kept next to the other data helpers so page templates never hand-
 * write a path that the generator does not actually produce.
 */
export const DEFAULT_OG = "/og/default.png";

export function blogOg(slug: string): string {
  return `/og/blog-${slug}.png`;
}

/** One card per repo, reused by that repo's error pages. */
export function repoOg(repoFullName: string): string {
  const [owner, name] = repoFullName.split("/");
  return `/og/repo-${owner}-${name}.png`;
}
