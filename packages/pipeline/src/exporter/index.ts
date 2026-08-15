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
import { repositories, errors, infoPages } from "../db/schema.js";
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
    searchSummary: {
      path: "/data/search/summary.json",
      bytes: Buffer.byteLength(summaryStr),
      sha256: sha256(summaryStr),
    },
  };

  const manifest = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    datasetVersion,
    counts: { repos: validRepos.length, errors: allErrors.length, infoPages: validInfoPages.length },
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
