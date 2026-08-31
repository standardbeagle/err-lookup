import type { RepoEntry } from "@errlookup/schema";
import { getPublishedRepoEntries } from "./load.js";

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
