import type { ErrorEntry, RepoEntry } from "@errlookup/schema";
import { getPublishedRepoEntries } from "./load.js";

/**
 * One page of any list, plus the neighbours a crawler and a reader need.
 *
 * Every list on the site paginates through this, because an unpaged list is a
 * page whose weight is set by the corpus rather than by design — weaviate's
 * repo page reached 1.66 MB and ~6,000 links before this existed, and it is
 * the first URL in its own sitemap, so it was also the crawler's entry point
 * to everything beneath it.
 */
export interface Page<T> {
  items: T[];
  page: number;
  totalPages: number;
  prev: string | null;
  next: string | null;
}

/** Slice one page out of an already-ordered list. Clamps out-of-range pages. */
export function paginate<T>(
  items: readonly T[],
  page: number,
  perPage: number,
  href: (page: number) => string
): Page<T> {
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const current = Math.min(Math.max(Math.floor(page) || 1, 1), totalPages);
  const start = (current - 1) * perPage;
  return {
    items: items.slice(start, start + perPage),
    page: current,
    totalPages,
    prev: current > 1 ? href(current - 1) : null,
    next: current < totalPages ? href(current + 1) : null,
  };
}

/** Every page href for a list of `count` items, for sitemaps and nav. */
export function allPageHrefs(count: number, perPage: number, href: (page: number) => string): string[] {
  const total = Math.max(1, Math.ceil(count / perPage));
  return Array.from({ length: total }, (_, i) => href(i + 1));
}

/**
 * Entries per page of the background-article lists (the info hub and the
 * troubleshooting index). 183 info pages rendered as one list put both near
 * 170 KB — under the 250 KB failure bar but well over the 100 KB warning, and
 * they are the two lists a reader browses rather than searches.
 */
export const ARTICLES_PER_PAGE = Number(process.env.ERRLOOKUP_ARTICLES_PER_PAGE) || 50;

/**
 * Page 1 keeps the bare path; later pages sit under a static "page" segment.
 *
 * The segment is not decoration: /info/[slug]/ already owns that depth, so
 * /info/{n}/ would be a second dynamic route at the same level and an
 * ambiguous match. Both lists use the same shape so the pager does not have
 * to know which list it is rendering.
 */
export function articlePageHref(base: string, page: number): string {
  return page <= 1 ? `${base}/` : `${base}/page/${page}/`;
}

/**
 * Errors per page of a repo's error list. 100 keeps the heaviest page near
 * 40 KB against the §6.2 50 KB bar — measured at ~285 bytes of markup per row
 * on the pre-paging weaviate page.
 */
export const ERRORS_PER_PAGE = Number(process.env.ERRLOOKUP_ERRORS_PER_PAGE) || 100;

/**
 * Page 1 of a repo's errors is the repo page itself; later pages live under
 * the /repos/ listing namespace.
 *
 * NOT /{owner}/{repo}/{n}/ and NOT /{owner}/{repo}/page/{n}/: both collide
 * with real, frozen slugs. 950 published records have purely numeric slugs
 * (error codes — "404", "16", "32001") and three are literally named "page",
 * "pages" and "p", so either shape would shadow a live error page.
 */
export function repoErrorPageHref(repo: string, page: number): string {
  return page <= 1 ? `/${repo}/` : `/repos/${repo}/${page}/`;
}

/**
 * URLs per sitemap file. The protocol's own ceiling, used deliberately.
 *
 * This was 1,000 for one day, on the theory that a smaller file is a cheaper
 * re-fetch. That optimised the wrong resource: one file per repo produced
 * 1,658 children with a median of 49 URLs, against a Googlebot budget of
 * 35-94 requests a day. Fetch COUNT is what is rationed, not fetch size.
 */
export const SITEMAP_URLS_PER_FILE = Number(process.env.ERRLOOKUP_SITEMAP_URLS_PER_FILE) || 50000;

/** Errors in the order the repo page lists them: documented ones first. */
export function sortRepoErrors(errors: readonly ErrorEntry[]): ErrorEntry[] {
  return [...errors].sort(
    (a, b) => b.documentation.length - a.documentation.length || a.slug.localeCompare(b.slug)
  );
}

/**
 * Repos per page of the analyzed-repos list. The corpus is heading for 110+
 * repos, which is far past what belongs in one home-page table.
 *
 * Overridable at build time so the site test can drive real multi-page output
 * from the small fixture dataset instead of synthesising a 26-repo corpus.
 */
export const REPOS_PER_PAGE = Number(process.env.ERRLOOKUP_REPOS_PER_PAGE) || 25;

export interface RepoPage {
  repos: RepoEntry[];
  page: number;
  totalPages: number;
  /** Href of the previous page, or null on the first page. */
  prev: string | null;
  /** Href of the next page, or null on the last page. */
  next: string | null;
}

/** Page 1 lives at "/" (the home page); later pages get their own route. */
export function repoPageHref(page: number): string {
  return page <= 1 ? "/" : `/repos/${page}/`;
}

/**
 * Most-documented repos first — the list is a browsing aid, so the repos with
 * the most to look up lead. Ties break on name so the order is stable across
 * builds and page boundaries never shift under a crawler.
 */
export function sortRepos(repos: readonly RepoEntry[]): RepoEntry[] {
  return [...repos].sort((a, b) => b.errorCount - a.errorCount || a.repo.localeCompare(b.repo));
}

export function totalRepoPages(repoCount: number): number {
  return Math.max(1, Math.ceil(repoCount / REPOS_PER_PAGE));
}

/** Slice one page out of the sorted repo list. Clamps out-of-range pages. */
export function paginateRepos(repos: readonly RepoEntry[], page: number): RepoPage {
  const sorted = sortRepos(repos);
  const totalPages = totalRepoPages(sorted.length);
  const current = Math.min(Math.max(Math.floor(page) || 1, 1), totalPages);
  const start = (current - 1) * REPOS_PER_PAGE;
  return {
    repos: sorted.slice(start, start + REPOS_PER_PAGE),
    page: current,
    totalPages,
    prev: current > 1 ? repoPageHref(current - 1) : null,
    next: current < totalPages ? repoPageHref(current + 1) : null,
  };
}

export function getRepoPage(page: number): RepoPage {
  // Listing = crawl surface: only repos the scheduled publisher has admitted.
  // Unadmitted repos stay reachable through search and direct links.
  return paginateRepos(getPublishedRepoEntries(), page);
}

/** Every repo-list page href, for the sitemap. */
export function allRepoPageHrefs(): string[] {
  const total = totalRepoPages(getPublishedRepoEntries().length);
  return Array.from({ length: total }, (_, i) => repoPageHref(i + 1));
}
