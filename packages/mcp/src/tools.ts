import type { CacheStore, Manifest } from "./cache.js";
import { syncDataset, type SyncResult } from "./sync.js";
import {
  shardedSearch,
  lookupById,
  META_CHUNK,
  TOKEN_SHARDS,
  type IndexError,
  type ShardJsonFetcher,
  type SearchSummary,
  type ErrorEntry,
} from "@errlookup/schema";
import { siteErrorUrl } from "./base-url.js";

export interface ToolContext {
  store: CacheStore;
  ttlSeconds: number;
}

export interface SearchHit {
  id: string;
  repo: string;
  code: string | null;
  message: string;
  score: number;
  matchType: "exact-code" | "fuzzy";
  url: string;
}

/**
 * How far past the poll interval the cache may drift before a tool call waits
 * for the network instead of refreshing in the background. Without a hard
 * bound, a client that starts a fresh process per call would background a
 * refresh, exit, and never see a new dataset.
 */
const HARD_STALE_MULTIPLIER = 12;

/** The dataset version a tool call is pinned to, plus how it was obtained. */
interface ActiveDataset {
  version: string;
  fetch: ShardJsonFetcher;
  stale: boolean;
}

function noop(): void {
  /* background refresh failures surface on the next call as `stale` */
}

/**
 * Resolve the version this call reads, refreshing as needed.
 *
 * Inside the poll interval nothing touches the network. Past it, the refresh
 * runs in the background and this call answers from the version already
 * cached; past `HARD_STALE_MULTIPLIER` intervals the call waits for it. A call
 * with no cached version at all always waits.
 */
async function activeDataset(ctx: ToolContext): Promise<ActiveDataset> {
  const pointer = ctx.store.readPointer();
  const age = pointer ? Date.now() - pointer.checkedAt : Infinity;
  const ttlMs = ctx.ttlSeconds * 1000;

  let version = pointer?.datasetVersion ?? null;
  let stale = false;

  if (!pointer || age > ttlMs * HARD_STALE_MULTIPLIER) {
    const r = await syncDataset(ctx.store, false);
    version = r.datasetVersion;
    stale = r.stale;
  } else if (age > ttlMs) {
    void syncDataset(ctx.store, false).then(noop, noop);
  }

  if (!version) {
    throw new Error(
      "No dataset cached and the ErrLookup origin is unreachable. Run `refresh_dataset` while online."
    );
  }
  return { version, fetch: readerFor(ctx.store, version), stale };
}

/**
 * A fetcher pinned to one dataset version. Pinning matters: a background
 * refresh can make a new version live mid-call, and mixing shards across
 * versions would resolve entry indexes against the wrong metadata.
 */
function readerFor(store: CacheStore, version: string): ShardJsonFetcher {
  const manifest = store.readManifest(version);
  const expected = expectedByPath(manifest);
  return <T,>(relPath: string): Promise<T | null> =>
    store.fetchJson<T>(version, relPath, expected.get(relPath));
}

/** Manifest entries are keyed by published path; index them by dataset-relative path. */
function expectedByPath(manifest: Manifest | null): Map<string, { sha256: string; encoding?: string }> {
  const out = new Map<string, { sha256: string; encoding?: string }>();
  for (const f of Object.values(manifest?.files ?? {})) {
    out.set(f.path.replace(/^\/data\//, ""), { sha256: f.sha256, encoding: f.encoding });
  }
  return out;
}

export async function toolSearchError(
  ctx: ToolContext,
  args: { message: string; repo?: string; limit?: number }
): Promise<{ matches: SearchHit[]; datasetVersion: string; stale: boolean }> {
  const active = await activeDataset(ctx);
  const hits = await shardedSearch(args.message, active.fetch, { repo: args.repo, limit: args.limit });
  return {
    matches: hits.map((h) => toHit(h.entry, h.score, h.matchType)),
    datasetVersion: active.version,
    stale: active.stale,
  };
}

function toHit(e: IndexError, score: number, matchType: SearchHit["matchType"]): SearchHit {
  return {
    id: e.id,
    repo: e.repo,
    code: e.code,
    message: e.msg,
    score: Math.round(score * 1000) / 1000,
    matchType,
    url: siteErrorUrl(e.repo, e.slug),
  };
}

export async function toolGetError(
  ctx: ToolContext,
  args: { id?: string; repo?: string; slug?: string }
): Promise<{ markdown: string; url: string; datasetVersion: string }> {
  const active = await activeDataset(ctx);

  let repo = args.repo;
  let slug = args.slug;
  if (args.id) {
    const entry = await lookupById(args.id, active.fetch);
    if (!entry) throw new Error(`Error ${args.id} not found in dataset ${active.version}.`);
    repo = entry.repo;
    slug = entry.slug;
  }
  if (!repo || !slug) throw new Error("get_error needs either `id`, or both `repo` and `slug`.");

  const records = await active.fetch<ErrorEntry[]>(`repos/${repo}.json`);
  if (!records) throw new Error(`Records for ${repo} are not cached and the origin is unreachable.`);
  const full = records.find((r) => (args.id ? r.id === args.id : r.slug === slug));
  if (!full) throw new Error(`Record ${args.id ?? `${repo}/${slug}`} is not in the ${repo} file.`);

  return { markdown: renderMarkdown(full), url: siteErrorUrl(full.repo, full.slug), datasetVersion: active.version };
}

export async function toolListRepos(ctx: ToolContext): Promise<{
  repos: { repo: string; description: string | null; errorCount: number }[];
  datasetVersion: string;
}> {
  const active = await activeDataset(ctx);
  const repos = await active.fetch<{ repo: string; description: string | null; errorCount: number }[]>("repos.json");
  if (!repos) throw new Error("The repo list is not cached and the origin is unreachable.");
  return { repos, datasetVersion: active.version };
}

export async function toolRefreshDataset(
  ctx: ToolContext,
  args: { full?: boolean } = {}
): Promise<{ updated: boolean; datasetVersion: string | null; errors: number; prefetched: number | null }> {
  const r: SyncResult = await syncDataset(ctx.store, true);
  if (!args.full || !r.datasetVersion) {
    return { updated: r.updated, datasetVersion: r.datasetVersion, errors: r.errorCount, prefetched: null };
  }
  const prefetched = await prefetchAll(ctx, r.datasetVersion);
  return { updated: r.updated, datasetVersion: r.datasetVersion, errors: r.errorCount, prefetched };
}

/**
 * Download every file a query can need, so later lookups work with the network
 * gone. Lazy fetching is what makes a cold answer cheap; this is the opt-in for
 * clients that want the whole dataset on disk instead.
 */
async function prefetchAll(ctx: ToolContext, version: string): Promise<number> {
  const read = readerFor(ctx.store, version);
  const summary = await read<SearchSummary>("search/summary.json");
  if (!summary) return 0;

  const shardNames = Array.from({ length: TOKEN_SHARDS }, (_, i) => i.toString(16).padStart(2, "0"));
  const metaChunks = Math.max(1, Math.ceil(summary.entryCount / (summary.metaChunk || META_CHUNK)));
  const paths = [
    "search/codes.json",
    "search/norms.json",
    "repos.json",
    ...shardNames.map((n) => `search/tokens/${n}.json`),
    ...shardNames.map((n) => `search/ids/${n}.json`),
    ...Array.from({ length: metaChunks }, (_, k) => `search/meta/${k}.json`),
  ];

  let ok = 0;
  const CONCURRENCY = 8;
  for (let i = 0; i < paths.length; i += CONCURRENCY) {
    const batch = await Promise.all(paths.slice(i, i + CONCURRENCY).map((p) => read(p)));
    ok += batch.filter((r) => r !== null).length;
  }
  return ok;
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
