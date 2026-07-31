import type { CacheStore, IndexError } from "./cache.js";
import { syncDataset, type SyncResult } from "./sync.js";
import { searchErrors, type SearchHit } from "./search.js";
import type { ErrorEntry } from "@errlookup/schema";
import { existsSync, readFileSync } from "node:fs";
import { siteErrorUrl } from "./base-url.js";

export interface ToolContext {
  store: CacheStore;
  lastSyncAt: number;
  ttlSeconds: number;
}

async function ensureFresh(ctx: ToolContext): Promise<SyncResult> {
  const now = Date.now();
  const ttlOk = now - ctx.lastSyncAt < ctx.ttlSeconds * 1000;
  return syncDataset(ctx.store, ttlOk);
}

function manifestVersion(ctx: ToolContext): string | null {
  return ctx.store.readManifest()?.datasetVersion ?? null;
}

export async function toolSearchError(
  ctx: ToolContext,
  args: { message: string; repo?: string; limit?: number }
): Promise<{ matches: SearchHit[]; datasetVersion: string | null; stale: boolean }> {
  await ensureFresh(ctx);
  const idx = ctx.store.readIndex();
  if (!idx) {
    throw new Error("No dataset cached and network unavailable. Run `refresh_dataset` while online.");
  }
  const matches = searchErrors(args.message, idx.errors, { repo: args.repo, limit: args.limit });
  return { matches, datasetVersion: idx.datasetVersion, stale: false };
}

/** Load a repo's full records from cache, fetching lazily if missing. */
async function loadRepoRecords(ctx: ToolContext, repo: string): Promise<ErrorEntry[]> {
  let cached = ctx.store.readRepo(repo);
  if (!cached) {
    const manifest = ctx.store.readManifest();
    if (!manifest) throw new Error("No manifest cached; refresh while online.");
    // Fetch the per-repo file lazily (no per-file sha in manifest; trust CDN).
    await ctx.store.fetchVerified(`/data/repos/${repo.split("/").join("/")}.json`, ctx.store.repoPath(repo));
    cached = ctx.store.readRepo(repo);
  }
  return (cached ?? []) as ErrorEntry[];
}

export async function toolGetError(
  ctx: ToolContext,
  args: { id?: string; repo?: string; slug?: string }
): Promise<{ markdown: string; url: string; datasetVersion: string | null }> {
  await ensureFresh(ctx);
  const idx = ctx.store.readIndex();
  if (!idx) throw new Error("No dataset cached and network unavailable.");

  let match: IndexError | undefined;
  if (args.id) {
    match = idx.errors.find((e) => e.id === args.id);
  } else if (args.repo && args.slug) {
    match = idx.errors.find((e) => e.repo === args.repo && e.slug === args.slug);
  }
  if (!match) throw new Error("Error not found in index.");
  const url = siteErrorUrl(match.repo, match.slug);

  const records = await loadRepoRecords(ctx, match.repo);
  const full = records.find((r) => r.id === match!.id);
  if (!full) throw new Error(`Record ${match.id} missing from repo file.`);
  return { markdown: renderMarkdown(full), url, datasetVersion: idx.datasetVersion };
}

export async function toolListRepos(ctx: ToolContext): Promise<{
  repos: { repo: string; description: string | null; errorCount: number }[];
  datasetVersion: string | null;
}> {
  await ensureFresh(ctx);
  // repos.json isn't cached by the index sync; fetch lazily.
  const reposPath = `${ctx.store.dir}/repos.json`;
  if (!existsSync(reposPath)) {
    try {
      await ctx.store.fetchVerified("/data/repos.json", reposPath);
    } catch {
      // offline — best effort
    }
  }
  let repos: { repo: string; description: string | null; errorCount: number }[] = [];
  try {
    repos = JSON.parse(readFileSync(reposPath, "utf8"));
  } catch {
    // fall back to deriving from the index
    const idx = ctx.store.readIndex();
    if (idx) {
      const byRepo = new Map<string, number>();
      for (const e of idx.errors) byRepo.set(e.repo, (byRepo.get(e.repo) ?? 0) + 1);
      repos = [...byRepo.entries()].map(([repo, errorCount]) => ({ repo, description: null, errorCount }));
    }
  }
  return { repos, datasetVersion: manifestVersion(ctx) };
}

export async function toolRefreshDataset(ctx: ToolContext): Promise<{ updated: boolean; datasetVersion: string | null; errors: number }> {
  // Force a network poll regardless of TTL.
  const r = await syncDataset(ctx.store, false);
  if (r.datasetVersion) ctx.lastSyncAt = Date.now();
  return { updated: r.updated, datasetVersion: r.datasetVersion, errors: r.errorCount };
}

/** Render an ErrorEntry as markdown for direct agent consumption (§7.2). */
export function renderMarkdown(e: ErrorEntry): string {
  const lines: string[] = [];
  lines.push(`# ${e.errorCode ?? e.errorMessage.slice(0, 80)}`);
  lines.push("");
  lines.push(`**Repo:** ${e.repo}`);
  lines.push(`**Message:** \`${e.errorMessage}\``);
  if (e.errorClass) lines.push(`**Class:** ${e.errorClass}`);
  lines.push(`**Severity:** ${e.severity}`);
  lines.push("");
  lines.push("## What it means");
  lines.push(e.documentation);
  lines.push("");
  if (e.solutions.length > 0) {
    lines.push("## Solutions");
    for (let i = 0; i < e.solutions.length; i++) lines.push(`${i + 1}. ${e.solutions[i]}`);
    lines.push("");
  }
  if (e.exampleFix) {
    lines.push("## Example fix");
    lines.push("```");
    lines.push(e.exampleFix);
    lines.push("```");
    lines.push("");
  }
  if (e.handlingStrategy || e.tryCatchPattern || e.preventionTips.length > 0) {
    lines.push("## Defensive pattern");
    if (e.handlingStrategy) lines.push(`Strategy: ${e.handlingStrategy}`);
    if (e.tryCatchPattern) {
      lines.push("```");
      lines.push(e.tryCatchPattern);
      lines.push("```");
    }
    if (e.preventionTips.length > 0) lines.push(`Prevention: ${e.preventionTips.join("; ")}`);
    lines.push("");
  }
  lines.push(`Source: ${e.githubUrl}`);
  lines.push(`Analyzed: ${e.repo}@${e.analyzedSha.slice(0, 10)} on ${e.analyzedAt.slice(0, 10)}`);
  return lines.join("\n");
}
