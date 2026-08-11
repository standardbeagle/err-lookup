import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { RepoEntry } from "@errlookup/schema";
import { paginateRepos, sortRepos, totalRepoPages, repoPageHref, REPOS_PER_PAGE } from "../src/data/paging.js";

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

  beforeAll(() => {
    if (!existsSync(resolve(publicData, "manifest.json"))) {
      execFileSync("pnpm", ["exec", "tsx", "scripts/seed-dataset.ts"], { cwd: siteRoot });
    }
    repoCount = (JSON.parse(readFileSync(resolve(publicData, "repos.json"), "utf8")) as unknown[]).length;
    execFileSync("pnpm", ["exec", "astro", "build"], {
      cwd: siteRoot,
      stdio: "pipe",
      env: { ...process.env, ERRLOOKUP_REPOS_PER_PAGE: "1" },
    });
    home = readFileSync(resolve(dist, "index.html"), "utf8");
    pageTwo = readFileSync(resolve(dist, "repos", "2", "index.html"), "utf8");
  }, 90_000);

  afterAll(() => {
    // Leave dist matching the real page size for any later assertions.
    rmSync(dist, { recursive: true, force: true });
    execFileSync("pnpm", ["exec", "astro", "build"], { cwd: siteRoot, stdio: "pipe" });
  }, 90_000);

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
