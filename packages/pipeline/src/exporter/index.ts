import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import {
  mkdirSync,
  writeFileSync,
  renameSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { repositories, errors, infoPages, publishedRepos } from "../db/schema.js";
import {
  CURRENT_SCHEMA_VERSION,
  INFO_PAGE_SCHEMA_VERSION,
  validateErrorEntry,
  validateRepoEntry,
  validateInfoPageEntry,
  buildSearchIndex,
  type ErrorEntry,
  type RepoEntry,
  type IndexError,
  type InfoPageEntry,
  type InfoPageIndexEntry,
  type TagFamily,
} from "@errlookup/schema";

export interface ExportOptions {
  /** Target dir for the published dataset (default packages/site/public/data). */
  outDir?: string;
  /** Override the datasetVersion (defaults to now, monotonic). */
  datasetVersion?: string;
}


interface RepoIndex extends RepoEntry {}

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export function rowToErrorEntry(r: typeof errors.$inferSelect): ErrorEntry {
  return {
    id: r.id,
    repo: r.repo,
    slug: r.slug,
    errorCode: r.errorCode,
    errorMessage: r.errorMessage,
    messagePattern: r.messagePattern,
    errorType: r.errorType as ErrorEntry["errorType"],
    errorClass: r.errorClass,
    httpStatus: r.httpStatus,
    severity: r.severity as ErrorEntry["severity"],
    filePath: r.filePath,
    lineNumber: r.lineNumber,
    sourceCode: r.sourceCode,
    sourceCodeStart: r.sourceCodeStart,
    sourceCodeEnd: r.sourceCodeEnd,
    githubUrl: r.githubUrl,
    documentation: r.documentation ?? "",
    triggerScenarios: r.triggerScenarios ?? "",
    commonSituations: r.commonSituations ?? "",
    solutions: r.solutions ?? [],
    exampleFix: r.exampleFix,
    handlingStrategy: (r.handlingStrategy as ErrorEntry["handlingStrategy"]) ?? null,
    validationCode: r.validationCode,
    typeGuard: r.typeGuard,
    tryCatchPattern: r.tryCatchPattern,
    preventionTips: r.preventionTips ?? [],
    tags: r.tags ?? [],
    backgroundTag: r.backgroundTag ?? null,
    analyzedSha: r.analyzedSha,
    analyzedAt: r.analyzedAt,
    contentChangedAt: r.contentChangedAt ?? null,
    schemaVersion: CURRENT_SCHEMA_VERSION,
  };
}

function rowToRepoEntry(r: typeof repositories.$inferSelect): RepoEntry {
  return {
    repo: r.repo,
    description: r.description,
    language: r.language,
    stars: r.stars,
    sourceFiles: r.sourceFiles,
    defaultBranch: r.defaultBranch,
    analyzedSha: r.analyzedSha ?? "",
    analyzedAt: r.analyzedAt ?? "",
    errorCount: r.errorCount,
  };
}

/** Read all analyzed repos + their errors from the working DB. */
export function readDataset(db: Db): {
  repos: RepoEntry[];
  errorsByRepo: Map<string, ErrorEntry[]>;
} {
  const repoRows = db
    .select()
    .from(repositories)
    .where(eq(repositories.status, "analyzed"))
    .all()
    .filter((r) => r.analyzedSha !== null);
  const repos = repoRows.map(rowToRepoEntry);
  const errorsByRepo = new Map<string, ErrorEntry[]>();
  for (const repo of repos) {
    const rows = db.select().from(errors).where(eq(errors.repo, repo.repo)).all();
    errorsByRepo.set(repo.repo, rows.map(rowToErrorEntry));
  }
  return { repos, errorsByRepo };
}

function rowToInfoPageEntry(r: typeof infoPages.$inferSelect): InfoPageEntry {
  return {
    slug: r.slug,
    clusterKey: r.clusterKey,
    title: r.title,
    summary: r.summary,
    background: r.background,
    commonCauses: r.commonCauses,
    fixes: r.fixes,
    guideSlugs: r.guideSlugs,
    errorIds: r.errorIds,
    errorCount: r.errorCount,
    repoCount: r.repoCount,
    generatedAt: r.generatedAt,
    schemaVersion: INFO_PAGE_SCHEMA_VERSION,
  };
}

interface FileOut {
  relPath: string;
  content: string | Buffer;
}

/** Days between a repo's first export and its crawl-surface admission. */
function admissionDelayDays(): number {
  const n = Number(process.env.ERRLOOKUP_PUBLISH_DELAY_DAYS ?? 7);
  return Number.isFinite(n) && n >= 0 ? n : 7;
}

/**
 * Scheduled publishing: decide which repos the crawlable site advertises.
 * The dataset itself always ships whole — search, /api, and the MCP get every
 * analyzed repo immediately — but sitemaps, navigation, and page indexability
 * lag it by a fixed delay: a repo is admitted once its first export is
 * ERRLOOKUP_PUBLISH_DELAY_DAYS old (default 7). A delay, not a quota — site
 * admission tracks analysis pace exactly, just shifted, so the pipeline is
 * never throttled and the August pattern (a bulk drop of brand-new sections
 * that Google refused wholesale) cannot recur: by the time a crawler is
 * invited, the section has been live, verified, and serving search traffic
 * for a week.
 *
 * The ledger records each repo's first export. An empty ledger bootstraps by
 * grandfathering every analyzed repo — those pages are already live and
 * indexed; yanking them into noindex on feature arrival would be a mass
 * self-deindexing — by backdating their first export past the delay window.
 */
export function admitReposForSite(db: Db, analyzed: RepoEntry[], now = new Date()): Set<string> {
  const delayMs = admissionDelayDays() * 86_400_000;
  const cutoffIso = new Date(now.getTime() - delayMs).toISOString();
  const rows = db.select().from(publishedRepos).all();
  if (rows.length === 0) {
    if (analyzed.length > 0) {
      db.insert(publishedRepos)
        .values(analyzed.map((r) => ({ repo: r.repo, firstPublishedAt: cutoffIso })))
        .onConflictDoNothing()
        .run();
    }
    return new Set(analyzed.map((r) => r.repo));
  }
  const firstSeen = new Map(rows.map((r) => [r.repo, r.firstPublishedAt]));
  const nowIso = now.toISOString();
  for (const r of analyzed) {
    if (firstSeen.has(r.repo)) continue;
    db.insert(publishedRepos).values({ repo: r.repo, firstPublishedAt: nowIso }).onConflictDoNothing().run();
    firstSeen.set(r.repo, nowIso);
  }
  return new Set(
    analyzed.filter((r) => (firstSeen.get(r.repo) ?? nowIso) <= cutoffIso).map((r) => r.repo)
  );
}

/**
 * Build the full static dataset (§5). Validates every record against the zod
 * schema; invalid records are dropped (and counted in `rejected`) rather than
 * corrupting the dataset.
 */
export function buildDataset(
  db: Db,
  opts: ExportOptions = {}
): {
  files: FileOut[];
  manifest: object;
  counts: { repos: number; errors: number; rejected: number };
} {
  const { repos, errorsByRepo } = readDataset(db);
  const datasetVersion = opts.datasetVersion ?? new Date().toISOString();

  const validRepos: RepoEntry[] = [];
  let rejected = 0;
  for (const r of repos) {
    const v = validateRepoEntry(r);
    if (v.ok) validRepos.push(v.value);
    else rejected++;
  }

  // Scheduled publishing: published.json names the repos the crawlable site
  // advertises (sitemaps + indexable pages). Everything below still ships
  // every repo — this file gates crawl exposure, not data availability.
  const sitePublished = admitReposForSite(db, validRepos);
  const publishedJson = JSON.stringify(
    validRepos.map((r) => r.repo).filter((repo) => sitePublished.has(repo)).sort()
  );

  // No per-error files: Cloudflare Pages caps a deployment at 20k files and
  // one file per error blew past it at ~12k errors. Single records are served
  // by /api/errors/:id, which reads the per-repo file.
  const allErrors: ErrorEntry[] = [];
  const repoFiles: FileOut[] = [];
  for (const r of validRepos) {
    const rows = errorsByRepo.get(r.repo) ?? [];
    const valid: ErrorEntry[] = [];
    for (const e of rows) {
      const v = validateErrorEntry(e);
      if (v.ok) valid.push(v.value);
      else rejected++;
    }
    allErrors.push(...valid);
    const [owner, name] = r.repo.split("/");
    repoFiles.push({
      relPath: `repos/${owner}/${name}.json`,
      content: JSON.stringify(valid),
    });
  }

  // index.json — compact search index (§5.2)
  const indexErrors: IndexError[] = allErrors.map((e) => ({
    id: e.id,
    repo: e.repo,
    slug: e.slug,
    code: e.errorCode,
    msg: e.errorMessage,
    pattern: e.messagePattern,
    type: e.errorType,
    cls: e.errorClass,
    tags: e.tags,
    sev: e.severity,
  }));
  const indexJson = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    datasetVersion,
    errors: indexErrors,
  };

  const reposJson = validRepos;

  // Info pages (§ info-collector): one file per page + a compact hub index,
  // same validate-or-drop policy as error records.
  const validInfoPages: InfoPageEntry[] = [];
  for (const row of db.select().from(infoPages).all()) {
    const v = validateInfoPageEntry(rowToInfoPageEntry(row));
    if (v.ok) validInfoPages.push(v.value);
    else rejected++;
  }
  validInfoPages.sort((a, b) => b.errorCount - a.errorCount);
  const infoIndex: InfoPageIndexEntry[] = validInfoPages.map((p) => ({
    slug: p.slug,
    title: p.title,
    summary: p.summary,
    errorCount: p.errorCount,
    repoCount: p.repoCount,
    generatedAt: p.generatedAt,
  }));
  const infoFiles: FileOut[] = [
    { relPath: "info/index.json", content: JSON.stringify(infoIndex) },
    ...validInfoPages.map((p) => ({ relPath: `info/${p.slug}.json`, content: JSON.stringify(p) })),
  ];

  // tags.json — the published background-family vocabulary. Both a read API
  // (/api/tags) and the thing that makes cross-linking auditable: a family
  // with records and no infoSlug is a background article the corpus is asking
  // for, and the number of them is the coverage gap in one line.
  const tagsJson = buildTagsJson(allErrors, validInfoPages);
  const tagsStr = JSON.stringify(tagsJson);

  // manifest.json — MCP freshness poll target (§5.1)
  const indexStr = JSON.stringify(indexJson);
  // Gzipped: the raw index crossed Cloudflare Pages' 25 MiB per-file cap at
  // ~660 repos (38.4 MiB) and every deploy failed until the site froze. The
  // manifest advertises the real path + encoding; the MCP follows it and
  // gunzips. gzipSync writes no mtime, so equal input bytes → equal gz bytes
  // and the sha stays deterministic.
  const indexGz = gzipSync(indexStr);
  const reposStr = JSON.stringify(reposJson);
  // Sharded search index (§5.4): lets the site's API answer queries without
  // ever loading index.json — required once the corpus outgrows what a Pages
  // Function isolate can parse per request.
  const searchFiles = buildSearchIndex(indexErrors);
  const files: FileOut[] = [
    { relPath: "index.json.gz", content: indexGz },
    { relPath: "repos.json", content: reposStr },
    { relPath: "published.json", content: publishedJson },
    { relPath: "tags.json", content: tagsStr },
    ...repoFiles,
    ...searchFiles,
    ...infoFiles,
  ];

  const summaryStr = searchFiles.find((f) => f.relPath === "search/summary.json")!.content;
  const inventory: Record<string, { path: string; bytes: number; sha256: string; encoding?: string; rawBytes?: number; rawSha256?: string }> = {
    index: {
      path: "/data/index.json.gz",
      bytes: indexGz.byteLength,
      sha256: sha256(indexGz),
      encoding: "gzip",
      rawBytes: Buffer.byteLength(indexStr),
      rawSha256: sha256(indexStr),
    },
    repos: { path: "/data/repos.json", bytes: Buffer.byteLength(reposStr), sha256: sha256(reposStr) },
    published: { path: "/data/published.json", bytes: Buffer.byteLength(publishedJson), sha256: sha256(publishedJson) },
    tags: { path: "/data/tags.json", bytes: Buffer.byteLength(tagsStr), sha256: sha256(tagsStr) },
    searchSummary: {
      path: "/data/search/summary.json",
      bytes: Buffer.byteLength(summaryStr),
      sha256: sha256(summaryStr),
    },
  };

  const manifest = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    datasetVersion,
    counts: {
      repos: validRepos.length,
      errors: allErrors.length,
      infoPages: validInfoPages.length,
      sitePublishedRepos: sitePublished.size,
    },
    files: inventory,
  };
  files.unshift({ relPath: "manifest.json", content: JSON.stringify(manifest) });

  return { files, manifest, counts: { repos: validRepos.length, errors: allErrors.length, rejected } };
}

/**
 * Atomically publish the dataset (§5.3): write to `<outDir>.tmp/`, then rename
 * over `<outDir>`. Never publishes a partial dataset. Returns the manifest.
 */
export function publishDataset(
  db: Db,
  opts: ExportOptions = {}
): { manifest: object; counts: { repos: number; errors: number; rejected: number } } {
  const outDir = resolve(opts.outDir ?? defaultOutDir());
  const tmpDir = `${outDir}.tmp-${process.pid}`;

  // Build + validate into the temp dir first.
  const { files, manifest, counts } = buildDataset(db, opts);

  rmSync(tmpDir, { recursive: true, force: true });
  for (const f of files) {
    const abs = join(tmpDir, f.relPath);
    mkdirSync(dirname(abs), { recursive: true });
    if (typeof f.content === "string") writeFileSync(abs, f.content, "utf8");
    else writeFileSync(abs, f.content);
  }

  // Atomic swap: move current outDir aside, move tmp into place, remove old.
  const backup = `${outDir}.old-${process.pid}`;
  rmSync(backup, { recursive: true, force: true });
  if (existsSync(outDir)) renameSync(outDir, backup);
  renameSync(tmpDir, outDir);
  rmSync(backup, { recursive: true, force: true });

  return { manifest, counts };
}

/** Walk up from cwd to the pnpm workspace root (pnpm --filter runs set cwd to the package dir). */
function workspaceRoot(): string {
  let dir = process.cwd();
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return process.cwd();
    dir = parent;
  }
}

function defaultOutDir(): string {
  // §5: packages/site/public/data (from repo root). Created on first export.
  return resolve(workspaceRoot(), "packages", "site", "public", "data");
}

// re-export for tests / CLI
export { defaultOutDir as resolveDefaultOutDir };

/**
 * The background-family vocabulary as published: every family with its record
 * and repo counts, and the article covering it when one exists.
 *
 * Sorted by record count so the biggest uncovered family is the first row
 * without an infoSlug — the collector's backlog, readable without a database.
 */
export function buildTagsJson(
  errors: readonly ErrorEntry[],
  infoPages: readonly InfoPageEntry[]
): TagFamily[] {
  const slugByTag = new Map<string, string>();
  for (const p of infoPages) {
    if (p.clusterKey.startsWith("tag:")) slugByTag.set(p.clusterKey.slice(4), p.slug);
  }
  const counts = new Map<string, { errorCount: number; repos: Set<string> }>();
  for (const e of errors) {
    if (!e.backgroundTag) continue;
    const cur = counts.get(e.backgroundTag) ?? { errorCount: 0, repos: new Set<string>() };
    cur.errorCount++;
    cur.repos.add(e.repo);
    counts.set(e.backgroundTag, cur);
  }
  return [...counts.entries()]
    .map(([tag, c]): TagFamily => ({
      tag,
      errorCount: c.errorCount,
      repoCount: c.repos.size,
      infoSlug: slugByTag.get(tag) ?? null,
    }))
    .sort((a, b) => b.errorCount - a.errorCount || a.tag.localeCompare(b.tag));
}
