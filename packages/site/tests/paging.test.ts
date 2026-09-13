import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { RepoEntry } from "@errlookup/schema";
import { paginateRepos, sortRepos, totalRepoPages, repoPageHref, REPOS_PER_PAGE } from "../src/data/paging.js";
import { checkPage, countLinks } from "../src/data/page-budget.js";

function repos(n: number): RepoEntry[] {
  return Array.from({ length: n }, (_, i) => ({
    repo: `owner${String(i).padStart(3, "0")}/name`,
    description: null,
    language: "TypeScript",
    stars: 100 + i,
    sourceFiles: 500 + i,
    errorCount: n - i, // descending, so input order already matches the sort
    analyzedSha: "0".repeat(40),
    analyzedAt: "2026-08-01T00:00:00.000Z",
  })) as RepoEntry[];
}

describe("repo list paging", () => {
  it("puts page 1 on the home page and later pages on their own route", () => {
    expect(repoPageHref(1)).toBe("/");
    expect(repoPageHref(2)).toBe("/repos/2/");
    expect(repoPageHref(7)).toBe("/repos/7/");
  });

  it("counts pages including a short final page", () => {
    expect(totalRepoPages(0)).toBe(1); // an empty corpus still has a home page
    expect(totalRepoPages(1)).toBe(1);
    expect(totalRepoPages(REPOS_PER_PAGE)).toBe(1);
    expect(totalRepoPages(REPOS_PER_PAGE + 1)).toBe(2);
    expect(totalRepoPages(REPOS_PER_PAGE * 4 + 3)).toBe(5);
  });

  it("slices pages without dropping or repeating a repo", () => {
    const all = repos(112);
    const total = totalRepoPages(all.length);
    const seen: string[] = [];
    for (let p = 1; p <= total; p++) seen.push(...paginateRepos(all, p).repos.map((r) => r.repo));

    expect(seen).toHaveLength(all.length);
    expect(new Set(seen).size).toBe(all.length); // no repo on two pages
    expect(seen).toEqual(sortRepos(all).map((r) => r.repo)); // and none lost
  });

  it("wires prev/next only where a neighbour exists", () => {
    const all = repos(112); // 5 pages at 25/page
    expect(paginateRepos(all, 1).prev).toBeNull();
    expect(paginateRepos(all, 1).next).toBe("/repos/2/");
    expect(paginateRepos(all, 3).prev).toBe("/repos/2/");
    expect(paginateRepos(all, 3).next).toBe("/repos/4/");
    expect(paginateRepos(all, 5).next).toBeNull();
    expect(paginateRepos(all, 5).prev).toBe("/repos/4/");
    expect(paginateRepos(all, 2).prev).toBe("/"); // back to the home page
  });

  it("clamps out-of-range and malformed page numbers", () => {
    const all = repos(60); // 3 pages
    expect(paginateRepos(all, 0).page).toBe(1);
    expect(paginateRepos(all, -4).page).toBe(1);
    expect(paginateRepos(all, 99).page).toBe(3);
    expect(paginateRepos(all, Number.NaN).page).toBe(1);
  });

  it("orders by documented errors, breaking ties on name so builds are stable", () => {
    const tied = [
      { repo: "b/b", errorCount: 5 },
      { repo: "a/a", errorCount: 5 },
      { repo: "c/c", errorCount: 9 },
    ] as RepoEntry[];
    expect(sortRepos(tied).map((r) => r.repo)).toEqual(["c/c", "a/a", "b/b"]);
    // Pure: the caller's array is not reordered under it.
    expect(tied.map((r) => r.repo)).toEqual(["b/b", "a/a", "c/c"]);
  });

  it("keeps a repo on the same page when an unrelated repo's count changes", () => {
    // Page boundaries shifting on every scan would churn every crawled URL.
    const before = repos(112);
    const after = before.map((r) => (r.repo === "owner000/name" ? { ...r, errorCount: r.errorCount + 1 } : r));
    const pageOf = (list: RepoEntry[], repo: string) => {
      const total = totalRepoPages(list.length);
      for (let p = 1; p <= total; p++) if (paginateRepos(list, p).repos.some((r) => r.repo === repo)) return p;
      return -1;
    };
    expect(pageOf(after, "owner075/name")).toBe(pageOf(before, "owner075/name"));
  });
});

describe("page-budget rules", () => {
  it("fails an unpaged list and passes a paged one", () => {
    // weaviate/weaviate's repo page before paging: 1,696,840 bytes, ~6,000 links.
    const before = checkPage({ path: "weaviate/weaviate/index.html", bytes: 1_696_840, links: 5_977 });
    expect(before.map((v) => v.rule).sort()).toEqual(["page-bytes", "page-links"]);
    expect(before.every((v) => v.severity === "fail")).toBe(true);
    // After: one page of 100 rows.
    expect(checkPage({ path: "weaviate/weaviate/index.html", bytes: 35_517, links: 150 })).toEqual([]);
  });

  it("warns before it fails, so weight is visible while it is still cheap", () => {
    const warn = checkPage({ path: "info/index.html", bytes: 168_876, links: 200 });
    expect(warn).toHaveLength(1);
    expect(warn[0]!.severity).toBe("warn");
  });

  it("counts only anchors a crawler would follow", () => {
    expect(countLinks('<a href="/a/">x</a><a\n  href="/b/">y</a><link href="/c">')).toBe(2);
  });
});

/**
 * A static "page" segment carries the later pages of /info/ and
 * /troubleshooting/. /info/[slug]/ shares that depth, so an article slugged
 * "page" would shadow the route — pin the assumption rather than discover it.
 */
describe("paged routes do not shadow content slugs", () => {
  it("no info article is slugged like a pager segment", () => {
    const publicData = resolve(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
    const indexPath = resolve(publicData, "info", "index.json");
    if (!existsSync(indexPath)) return; // dataset predates the collector
    const slugs = (JSON.parse(readFileSync(indexPath, "utf8")) as { slug: string }[]).map((p) => p.slug);
    for (const reserved of ["page", "pages", "p"]) expect(slugs).not.toContain(reserved);
  });
});

/**
 * The paging rules above are pure, but the markup that carries them is not.
 * Build the real site with one repo per page so the fixture dataset produces
 * multiple pages, then assert against the emitted HTML.
 */
describe("rendered repo pager", () => {
  const siteRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const dist = resolve(siteRoot, "dist");
  const publicData = resolve(siteRoot, "public", "data");
  let home = "";
  let pageTwo = "";
  let repoCount = 0;

  // tests/global-setup.ts builds the site once for the whole suite, with one
  // repo, one error and one article per page so this deliberately tiny
  // fixture still produces multi-page output. Nothing to build here.
  beforeAll(() => {
    repoCount = (JSON.parse(readFileSync(resolve(publicData, "repos.json"), "utf8")) as unknown[]).length;
    home = readFileSync(resolve(dist, "index.html"), "utf8");
    pageTwo = readFileSync(resolve(dist, "repos", "2", "index.html"), "utf8");
  });

  it("generates a route per page beyond the first, and none for page 1", () => {
    expect(existsSync(resolve(dist, "repos", "2", "index.html"))).toBe(true);
    expect(existsSync(resolve(dist, "repos", String(repoCount), "index.html"))).toBe(true);
    expect(existsSync(resolve(dist, "repos", String(repoCount + 1)))).toBe(false);
    // Page 1 is the home page; a /repos/1/ would duplicate it.
    expect(existsSync(resolve(dist, "repos", "1"))).toBe(false);
  });

  it("shows only one page of repos on the home page", () => {
    const rows = [...home.matchAll(/<td><a href="\/([^"]+)\/">/g)].map((m) => m[1]!);
    expect(rows).toHaveLength(1);
  });

  it("renders a pager with the current page marked and the next page linked", () => {
    expect(home).toContain('aria-label="Analyzed repository pages"');
    expect(home).toContain('aria-current="page"');
    expect(home).toContain('rel="next" href="/repos/2/"');
  });

  it("links page 1 back to the home page rather than /repos/1/", () => {
    expect(pageTwo).toContain('rel="prev" href="/"');
    expect(pageTwo).not.toContain("/repos/1/");
  });

  it("lists every repo-list page in the sitemap", () => {
    const xml = readFileSync(resolve(dist, "sitemaps", "pages.xml"), "utf8");
    expect(xml).toContain("<loc>https://errors.standardbeagle.com/</loc>");
    for (let p = 2; p <= repoCount; p++) {
      expect(xml).toContain(`<loc>https://errors.standardbeagle.com/repos/${p}/</loc>`);
    }
  });
});
