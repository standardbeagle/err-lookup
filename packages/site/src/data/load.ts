import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ErrorEntry, RepoEntry } from "@errlookup/schema";

const siteRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

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

/** Related errors: same repo, sharing ≥1 tag, capped. */
export function relatedErrors(repo: string, slug: string, cap = 5): ErrorEntry[] {
  const all = getRepoErrors(repo);
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
