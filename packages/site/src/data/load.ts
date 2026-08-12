import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import type { ErrorEntry, RepoEntry, InfoPageEntry, InfoPageIndexEntry } from "@errlookup/schema";

// Build-time only (prerendered routes and sitemaps). Resolved from cwd, not
// import.meta.url: under the Cloudflare adapter these modules prerender from
// inside dist/_worker.js/, which is nowhere near public/data. astro build and
// the test runners all execute with cwd at the site package root; the upward
// walk covers callers that start deeper.
function findSiteRoot(): string {
  let dir = process.cwd();
  for (;;) {
    if (existsSync(resolve(dir, "public", "data")) || existsSync(resolve(dir, "astro.config.mjs"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return process.cwd();
    dir = parent;
  }
}
const siteRoot = findSiteRoot();

function readJson<T>(rel: string): T {
  return JSON.parse(readFileSync(resolve(siteRoot, "public", "data", rel), "utf8")) as T;
}

export interface IndexError {
  id: string;
  repo: string;
  slug: string;
  code: string | null;
  msg: string;
  pattern: string;
  type: string;
  cls: string | null;
  tags: string[];
  sev: string;
}

export interface Manifest {
  schemaVersion: number;
  datasetVersion: string;
  counts: { repos: number; errors: number };
  files: Record<string, { path: string; bytes: number; sha256: string }>;
}

export function getManifest(): Manifest {
  return readJson<Manifest>("manifest.json");
}

export function getRepos(): RepoEntry[] {
  return readJson<RepoEntry[]>("repos.json");
}

export function getIndex(): { schemaVersion: number; datasetVersion: string; errors: IndexError[] } {
  return readJson("index.json");
}

/** Info-page hub rows. A dataset published before the collector first ran has
 *  no info/ directory — an empty hub is the correct rendering of that state,
 *  not a fallback. */
export function getInfoIndex(): InfoPageIndexEntry[] {
  const p = resolve(siteRoot, "public", "data", "info", "index.json");
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as InfoPageIndexEntry[]) : [];
}

export function getInfoPage(slug: string): InfoPageEntry {
  return readJson<InfoPageEntry>(`info/${slug}.json`);
}

/** Split "owner/name" into path segments. */
export function repoPaths(repo: string): { owner: string; name: string } {
  const [owner, name] = repo.split("/");
  return { owner: owner!, name: name! };
}

export function getRepoErrors(repo: string): ErrorEntry[] {
  const { owner, name } = repoPaths(repo);
  return readJson<ErrorEntry[]>(`repos/${owner}/${name}.json`);
}

export function findError(repo: string, slug: string): ErrorEntry | undefined {
  return getRepoErrors(repo).find((e) => e.slug === slug);
}

/** Build static-paths params for every error page (owner/name/slug). */
export function allErrorParams(): { owner: string; name: string; slug: string; repo: string }[] {
  const out: { owner: string; name: string; slug: string; repo: string }[] = [];
  for (const repo of getRepos().map((r) => r.repo)) {
    const { owner, name } = repoPaths(repo);
    for (const e of getRepoErrors(repo)) {
      out.push({ owner, name, slug: e.slug, repo });
    }
  }
  return out;
}

/** Related errors within an already-loaded record set: sharing ≥1 tag, capped. */
export function relatedFrom(all: ErrorEntry[], slug: string, cap = 5): ErrorEntry[] {
  const me = all.find((e) => e.slug === slug);
  if (!me) return [];
  return all
    .filter((e) => e.slug !== slug)
    .map((e) => ({ e, overlap: e.tags.filter((t) => me.tags.includes(t)).length }))
    .filter((x) => x.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap)
    .slice(0, cap)
    .map((x) => x.e);
}

/** Related errors: same repo, sharing ≥1 tag, capped. */
export function relatedErrors(repo: string, slug: string, cap = 5): ErrorEntry[] {
  return relatedFrom(getRepoErrors(repo), slug, cap);
}
