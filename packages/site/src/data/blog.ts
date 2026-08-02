/**
 * Blog post index. Single source for the blog listing, the RSS feed, the
 * sitemap and the social-card generator — the sitemap previously kept its own
 * hand-written copy of these paths, which is exactly the kind of list that
 * stops matching reality the first time a post is added.
 */
export interface BlogPost {
  slug: string;
  title: string;
  description: string;
  /** ISO date (YYYY-MM-DD) the post was published. */
  date: string;
}

export const posts: BlogPost[] = [
  {
    slug: "how-the-scanner-works",
    title: "How the ErrLookup scanner works",
    description:
      "Deterministic candidate extraction, batched LLM analysis, and an adversarial verify pass: the pipeline that turns library source into an error knowledge base.",
    date: "2026-08-01",
  },
  {
    slug: "analyze-your-internal-repos",
    title: "Run ErrLookup on your own internal repositories",
    description:
      "The pipeline is a local CLI and the dataset is static files — analyze private code on your own hardware and serve the results from any internal host.",
    date: "2026-08-01",
  },
  {
    slug: "compiled-languages-error-lookup",
    title: "Why error lookup matters most for compiled languages",
    description:
      "When a Go binary or a JAR throws in production, the error string is often the only artifact you have — the source that raised it never shipped.",
    date: "2026-08-01",
  },
];

/** Newest first — the order both the blog index and the feed present. */
export function postsByDate(): BlogPost[] {
  return [...posts].sort((a, b) => b.date.localeCompare(a.date) || a.slug.localeCompare(b.slug));
}

export function blogPostHref(slug: string): string {
  return `/blog/${slug}/`;
}
